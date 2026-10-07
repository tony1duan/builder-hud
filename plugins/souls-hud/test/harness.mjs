/**
 * Offline harness for the BuilderHUD host half.
 *
 * Fakes the Cordis context and the host services the plugin reads, then drives
 * the registered routes so the data path can be verified without booting the
 * real app.
 *
 * Run: node plugins/souls-hud/test/harness.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name, inject, tariffAt, createBurnTracker } from '../lib/host.js'
import { holidayRefreshDue, inNoticeWindow, indexHolidays } from '../lib/holidays.js'

const BASE = '/dsh-souls-hud'

// The settings route persists to a file. Point it at a scratch path *before*
// anything mounts, so the tests never touch the real preferences — and point the
// legacy path at another scratch path, so the rename's compatibility read cannot
// pick up this machine's real `~/.dsh/dark-souls-hud.json` and leak into the
// expected defaults.
const SETTINGS_TMP = join(tmpdir(), `dsh-hud-harness-${process.pid}.json`)
const LEGACY_TMP = join(tmpdir(), `dsh-hud-harness-legacy-${process.pid}.json`)
const DEVICE_TMP = join(tmpdir(), `dsh-hud-harness-device-${process.pid}.svg`)
process.env.DSH_SOULS_HUD_SETTINGS = SETTINGS_TMP
process.env.DSH_SOULS_HUD_LEGACY_SETTINGS = LEGACY_TMP
process.env.DSH_SOULS_HUD_DEVICE = DEVICE_TMP
// The holiday refresh writes a cache beside the config; same idea, same reason.
const HOLIDAY_TMP = join(tmpdir(), `dsh-hud-harness-holidays-${process.pid}.json`)
process.env.DSH_SOULS_HUD_HOLIDAYS = HOLIDAY_TMP
rmSync(HOLIDAY_TMP, { force: true })
rmSync(SETTINGS_TMP, { force: true })
rmSync(LEGACY_TMP, { force: true })
rmSync(DEVICE_TMP, { force: true })

// The donation images are read from `assets/support/`. Point that at a scratch
// directory before anything mounts, so the route can be driven against a real file
// without a test image ever living in the package.
const SUPPORT_TMP = join(tmpdir(), `dsh-hud-harness-support-${process.pid}`)
/** A 1×1 PNG: small, valid, and recognisable by length. */
const SUPPORT_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)
process.env.DSH_SOULS_HUD_SUPPORT = SUPPORT_TMP
rmSync(SUPPORT_TMP, { recursive: true, force: true })
mkdirSync(SUPPORT_TMP, { recursive: true })
writeFileSync(join(SUPPORT_TMP, 'wechat.png'), SUPPORT_BYTES)

/** Minimal Node response double that records what was written. */
function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value
    },
    end(chunk) {
      this.body = chunk ?? ''
    },
  }
}

/**
 * Build one isolated plugin mounting.
 * @param config - plugin config.
 * @param overrides - service overrides keyed by service name.
 * @param sessionOverrides - fields merged onto the fake live session.
 * @returns the captured routes, taps and call counters.
 */
function mount(config, overrides = {}, sessionOverrides = {}) {
  const routes = new Map()
  const taps = []
  const calls = { balance: 0 }
  const session = {
    id: 'session-test',
    seq: 12,
    eventAt: (seq) => (seq === 11 ? { time: 1_700_000_000_000 } : undefined),
    requestContext: () => ({
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      contextWindow: 128000,
    }),
    ...sessionOverrides,
  }
  const services = {
    webServer: {
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },      tapIndex: (transform) => {
        taps.push(transform)
        return () => taps.splice(taps.indexOf(transform), 1)
      },
      // The real service applies every tap in registration order; the probe
      // route reads through this exact function.
      renderIndex: (html) => taps.reduce((accumulated, transform) => transform(accumulated), html),
    },
    agents: { roots: () => [{ id: 'session-test' }] },
    sessions: { get: (id) => (id === 'session-test' ? session : undefined), list: () => [session] },
    sessionProjections: {
      snapshot: () => ({
        asOfSeq: 11,
        values: {
          contextPressure: { projectedTokens: 73000, pressureTokens: 71000, contextWindow: 128000 },
        },
      }),
    },
    tokenMeter: { measure: () => ({ totalTokens: 999 }) },
    deepseekAccount: {
      getBalance: async () => {
        calls.balance += 1
        return {
          status: 'ready',
          value: [{ currency: 'CNY', balance: '18.75' }],
          bonusWallets: [{ currency: 'CNY', balance: '3.50' }],
        }
      },
    },
    ...overrides,
  }
  const ctx = {
    get: (key) => services[key],
    effect: (callback) => {
      callback()
    },
    logger: { info: () => {} },
  }
  apply(ctx, config)

  /**
   * Resolve a request pathname the way the real web server does.
   *
   * Copied from the app's dispatcher (`@deepseek-ai/dsh-host-webserver`): an exact
   * hit first, then longest-prefix-wins over the prefix table, where a prefix
   * matches its own path or anything under `path + "/"`. That last clause is the
   * whole point: a route registered as `/x/support/` never matches
   * `/x/support/wechat.png`, and calling the handler directly — as this suite used
   * to — cannot see that class of mistake at all. It cost a restart to find in the
   * real app.
   *
   * @param pathname - the request path, without a query string.
   * @returns the matching route, or `undefined`.
   */
  function match(pathname) {
    const direct = routes.get(pathname)
    if (direct !== undefined && direct.kind === 'exact') return direct
    let best
    for (const route of routes.values()) {
      if (route.kind === 'exact') continue
      if (pathname !== route.path && !pathname.startsWith(`${route.path}/`)) continue
      if (best === undefined || route.path.length > best.path.length) best = route
    }
    return best
  }

  /** Drive the state route and decode its JSON. */
  async function state(url) {
    const route = routes.get(`${BASE}/state.json`)
    assert.ok(route, 'state route must be registered')
    assert.equal(route.kind, 'exact')
    const res = makeRes()
    await route.handler({ method: 'GET', url }, res)
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'], /application\/json/)
    return JSON.parse(res.body)
  }

  return { routes, taps, calls, session, services, state, match }
}

assert.equal(name, 'souls-hud')

// --- the two pure functions behind the burn gauge and the tariff window -------
//
// Both are exported so they can be driven on a fake clock: the alternative is a
// suite whose result depends on what time of day (and which day) it runs.

/**
 * The bundled Chinese calendar, indexed the way the host indexes it. Loaded from
 * the shipped file rather than a fixture: the assertions above are about the *rule*,
 * and the rule is only worth anything if the data underneath it is real.
 */
const HOLIDAYS = indexHolidays(
  JSON.parse(readFileSync(new URL('../data/holidays-cn.json', import.meta.url), 'utf8')),
)

/** An epoch ms for a given UTC wall clock, so the cases read as times. */
function utc(year, month, day, hour, minute) {
  return Date.UTC(year, month - 1, day, hour, minute, 0)
}

/**
 * The published rule, on a fake clock.
 *
 * > Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday,
 * > excluding Chinese public holidays. All other hours are off-peak, including
 * > weekends and Chinese public holidays in full.
 *
 * The suite used to assert the *previous* shape (one off-peak window, 16:30–00:30)
 * because that was what the plugin shipped. What makes the new one worth testing
 * carefully is that it is two windows with a deliberate gap between them: 04:00–06:00
 * UTC on a Tuesday is off-peak, and no single off-peak window can express that.
 */
const TARIFF = {
  tariffPeakWindows: [
    { start: '01:00', end: '04:00' },
    { start: '06:00', end: '10:00' },
  ],
  tariffPeakWeekdays: [1, 2, 3, 4, 5],
}
// 2026-03-03 is a Tuesday, 2026-03-07 a Saturday, 2026-10-01 a Thursday.
const tue = (hour, minute) => utc(2026, 3, 3, hour, minute)

assert.equal(tariffAt(tue(1, 0), TARIFF).peak, true, 'the first window opens at 01:00 UTC')
assert.equal(tariffAt(tue(2, 30), TARIFF).peak, true, 'and 02:30 is inside it')
assert.equal(tariffAt(tue(4, 0), TARIFF).peak, false, '04:00 is the first off-peak minute')
assert.equal(tariffAt(tue(4, 0), TARIFF).reason, 'between-windows')
assert.equal(tariffAt(tue(5, 30), TARIFF).peak, false, 'the gap runs to 06:00')
assert.equal(tariffAt(tue(5, 30), TARIFF).reason, 'between-windows')
assert.equal(tariffAt(tue(6, 0), TARIFF).peak, true, 'the second window opens at 06:00 UTC')
assert.equal(tariffAt(tue(9, 59), TARIFF).peak, true, 'and closes at 10:00')
assert.equal(tariffAt(tue(10, 0), TARIFF).peak, false)
assert.equal(tariffAt(tue(10, 0), TARIFF).reason, 'outside-windows')
assert.equal(tariffAt(tue(0, 30), TARIFF).peak, false, 'the small hours before the first window are off-peak')
assert.equal(tariffAt(tue(22, 0), TARIFF).peak, false, 'and so is the evening')
assert.equal(tariffAt(tue(2, 30), TARIFF).window.text, '01:00–04:00', 'the reading names its window')
assert.equal(tariffAt(tue(7, 0), TARIFF).window.text, '06:00–10:00')

// Weekends are off-peak in full — including their peak hours.
const saturday = tariffAt(utc(2026, 3, 7, 2, 30), TARIFF)
assert.equal(saturday.peak, false, 'a Saturday inside a peak window is off-peak')
assert.equal(saturday.reason, 'weekend')
assert.equal(saturday.utcWeekday, 6)
assert.equal(tariffAt(utc(2026, 3, 8, 7, 0), TARIFF).peak, false, 'and so is a Sunday')

// Chinese public holidays are off-peak in full: 2026-10-01 is 国庆节, a Thursday.
const holiday = tariffAt(utc(2026, 10, 1, 7, 0), TARIFF, HOLIDAYS)
assert.equal(holiday.peak, false, 'the National Day holiday is off-peak in full')
assert.equal(holiday.reason, 'holiday')
assert.equal(holiday.holidayName, '国庆节')
assert.equal(holiday.holidayDate, '2026-10-01')
// 20:00Z on 2026-09-30 is already October in Shanghai, which is the whole reason
// the holiday key is a local date rather than a UTC one.
assert.equal(tariffAt(utc(2026, 9, 30, 20, 0), TARIFF, HOLIDAYS).peak, false, 'a Chinese evening is already the holiday')
assert.equal(tariffAt(utc(2026, 9, 30, 20, 0), TARIFF, HOLIDAYS).holidayDate, '2026-10-01')
// ...and the day after the holiday is a normal Thursday.
assert.equal(tariffAt(utc(2026, 10, 8, 2, 0), TARIFF, HOLIDAYS).peak, true, 'the Thursday after the holiday is peak again')

// 调休: a make-up workday is a weekend day the State Council calls a working day.
// The published rule is weekday-based, so this is off by default and on request.
const makeup = utc(2026, 9, 20, 7, 0)
assert.equal(tariffAt(makeup, TARIFF, HOLIDAYS).makeup, true, '2026-09-20 is a make-up workday')
assert.equal(tariffAt(makeup, TARIFF, HOLIDAYS).peak, false, 'and is off-peak unless asked otherwise')
assert.equal(tariffAt(makeup, TARIFF, HOLIDAYS).reason, 'weekend')
assert.equal(tariffAt(makeup, { ...TARIFF, tariffMakeupWorkdays: true }, HOLIDAYS).peak, true,
  'with the setting on, a make-up workday is a working day')

// Custom calendars, and turning the calendar off entirely.
assert.equal(tariffAt(tue(2, 30), { ...TARIFF, tariffHolidayMode: 'custom', tariffCustomHolidays: ['2026-03-03'] }).peak, false,
  'a custom holiday makes a weekday off-peak')
assert.equal(tariffAt(tue(2, 30), { ...TARIFF, tariffHolidayMode: 'none' }, HOLIDAYS).peak, true,
  'with holidays off, only the weekday and the windows matter')
assert.equal(tariffAt(utc(2026, 10, 1, 7, 0), { ...TARIFF, tariffHolidayMode: 'none' }, HOLIDAYS).peak, true,
  'and a holiday becomes an ordinary weekday')

// A custom window set is what makes the rule the user's: DeepSeek can change the
// hours without this plugin needing a release.
const shifted = { tariffPeakWindows: [{ start: '12:00', end: '14:00' }], tariffPeakWeekdays: [0, 6] }
assert.equal(tariffAt(tue(13, 0), shifted).peak, false, 'a Tuesday is not a peak weekday in this rule')
assert.equal(tariffAt(utc(2026, 3, 7, 13, 0), shifted).peak, true, 'but a Saturday is')
assert.equal(tariffAt(utc(2026, 3, 7, 15, 0), shifted).peak, false)
// Junk falls back to the published rule rather than to "always peak" or "never".
assert.equal(tariffAt(tue(2, 30), { tariffPeakWindows: [{ start: 'nonsense', end: '99:99' }] }).peak, true,
  'an unreadable window falls back to the published one')
assert.equal(tariffAt(tue(2, 30), { tariffPeakWeekdays: [] }).peak, true,
  'an empty weekday list falls back to the published weekdays, not to never-peak')
// A window that wraps past midnight is legal and means what it says.
assert.equal(tariffAt(tue(23, 30), { tariffPeakWindows: [{ start: '22:00', end: '02:00' }] }).peak, true)
assert.equal(tariffAt(tue(1, 0), { tariffPeakWindows: [{ start: '22:00', end: '02:00' }] }).peak, true)
assert.equal(tariffAt(tue(3, 0), { tariffPeakWindows: [{ start: '22:00', end: '02:00' }] }).peak, false)

// The next change, which the form shows: from inside the first window it is that
// window's end, and from the gap it is the second window's start.
assert.equal(tariffAt(tue(2, 30), TARIFF).nextChangeAt, tue(4, 0), 'the next change is the window end')
assert.equal(tariffAt(tue(4, 30), TARIFF).nextChangeAt, tue(6, 0), 'and from the gap, the next window')
assert.equal(tariffAt(tue(10, 30), TARIFF).nextChangeAt, utc(2026, 3, 4, 1, 0), 'after the last window, tomorrow')
assert.equal(tariffAt(utc(2026, 3, 7, 12, 0), TARIFF).nextChangeAt, utc(2026, 3, 9, 1, 0), 'a weekend skips to Monday')
assert.equal(tariffAt(tue(2, 30), TARIFF).nextChangePeak, false, 'and which way it flips')

// The old shape is carried over instead of silently replaced: its off-peak window
// (16:30–00:30) is the same rule read the other way round.
const migrated = { offPeakUtcStart: '16:30', offPeakUtcEnd: '00:30' }
assert.equal(tariffAt(tue(2, 0), migrated).peak, true, 'a legacy off-peak config still computes the same tariff')
assert.equal(tariffAt(tue(17, 0), migrated).peak, false)

// The switch that hides the reading, and what every reading carries.
assert.equal(tariffAt(tue(2, 0), { tariffEnabled: false }).enabled, false)
assert.equal(tariffAt(tue(2, 0), TARIFF).half, true, 'off-peak is half price, and the reading says so')
assert.equal(tariffAt(tue(2, 0), TARIFF).utcClock, '02:00')

// The calendar itself: it has to parse, cover this year and next, and carry both
// kinds of day, or every holiday assertion above would pass for the wrong reason.
assert.ok(HOLIDAYS.years.includes(2026) && HOLIDAYS.years.includes(2027), 'the calendar covers this year and next')
assert.ok(HOLIDAYS.off.size > 80, 'and carries the off days')
assert.ok(HOLIDAYS.work.size > 15, 'and the make-up workdays')
assert.ok(HOLIDAYS.papers.length > 0, 'with the announcement it was generated from')
for (const [date, name] of HOLIDAYS.off) {
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(date), `a holiday date must be a date: ${date}`)
  assert.ok(typeof name === 'string' && name.length > 0, `a holiday must be named: ${date}`)
}

// --- the burn meter -----------------------------------------------------------
//
// Three series, and the distinction is the whole point: "new" tokens are what was
// processed afresh, cache reads are the same context read again. Counting cache
// reads made one real session (196M of its 198M ledger) look like 186M
// tokens/minute, which pegs any gauge at maximum.

const counters = (newTokens, outputTokens, cacheTokens) => ({
  newTokens,
  outputTokens,
  cacheTokens,
  totalTokens: newTokens + cacheTokens,
})

// It refuses to invent a rate: one sample is not a measurement.
const meter = createBurnTracker({ windowMs: 60000 })
assert.equal(meter.reading(1000).available, false, 'no samples means no reading')
assert.equal(meter.reading(1000).reason, 'no-samples')
meter.sample(counters(1000, 100, 0), 1000)
assert.equal(meter.reading(1000).available, false, 'one sample is not a rate')
meter.sample(counters(1000, 100, 0), 5000)
assert.equal(meter.reading(5000).available, false, 'too short a span is still not a rate')
assert.equal(meter.reading(5000).reason, 'warming-up')

// 6000 new tokens over 30s is 12000/min; 1500 of them generated.
meter.sample(counters(7000, 250, 900000), 31000)
const reading = meter.reading(31000)
assert.equal(reading.available, true)
assert.equal(reading.tokensPerMin, 12000, `rate ${reading.tokensPerMin}`)
assert.equal(reading.outputTokensPerMin, 300)
assert.equal(reading.cacheTokensPerMin, 1800000, 'cache reads are reported, not hidden')
assert.equal(reading.newTokens, 7000)
assert.equal(reading.totalTokens, 907000)
assert.equal(reading.samples, 3)

// Only the window counts: an old sample must fall out of it, and a long quiet
// stretch reads as the zero it earned rather than as the old rate.
meter.sample(counters(7000, 250, 900000), 200000)
assert.equal(meter.reading(200000).tokensPerMin, 0, 'a long quiet stretch reads as zero')

// Cache reads must not move the gauge: they are the same context read again.
const cacheOnly = createBurnTracker({ windowMs: 60000 })
cacheOnly.sample(counters(100, 10, 0), 0)
cacheOnly.sample(counters(150, 20, 0), 20000)
cacheOnly.sample(counters(200, 30, 5_000_000), 40000)
const cacheReading = cacheOnly.reading(40000)
// 100 new tokens over 40s is 150/min — the 5M cache read moves nothing.
assert.equal(cacheReading.tokensPerMin, 150, 'a 5M cache read must not become a 7.5M/min rate')
assert.equal(cacheReading.cacheTokensPerMin, 7500000, 'but it is still reported')

// A ledger that steps backwards (a different session, a restore) starts over
// instead of reporting a negative rate.
const reset = createBurnTracker({ windowMs: 60000 })
reset.sample(counters(100000, 1000, 0), 0)
reset.sample(counters(50, 10, 0), 30000)
reset.sample(counters(150, 30, 0), 60000)
const afterReset = reset.reading(60000)
assert.ok(afterReset.tokensPerMin >= 0, `negative rate ${afterReset.tokensPerMin}`)
assert.equal(afterReset.newTokens, 150)

assert.deepEqual(inject, ['webServer'])

// --- what a fresh install draws ---------------------------------------------
//
// The defaults are a promise to whoever installs this: the whale, because that is
// what the card artwork shows and what this project drew, and a red bar that scales
// to ¥100 so a topped-up wallet reads as a fraction of a recharge rather than a
// fraction of nothing. Read through the host's own `/config` route rather than from a
// literal in the source, so a change anywhere along the chain is caught.

{
  const fresh = await mount({})
  const config = (await fresh.state()).config
  assert.equal(config.device, 'whale', 'a fresh install draws the whale, not another device')
  assert.equal(config.shape, 'round', 'on the covenant medal, not the octagon')
  assert.equal(config.material, 'bronze', 'cast in bronze')
  assert.equal(config.hpTargetCny, 100, 'the red bar scales to ¥100')
  assert.equal(config.fpTargetCny, 50, 'and the blue bar to ¥50')
}

// --- happy path -------------------------------------------------------------

const primary = mount({ hpTargetCny: 50, fpTargetCny: 50, balanceCacheMs: 60000 })
const state = await primary.state()

assert.equal(state.balance.available, true)
assert.equal(state.balance.currency, 'CNY')
assert.equal(state.balance.recharge, 18.75)
assert.equal(state.balance.bonus, 3.5)
assert.ok(Math.abs(state.balance.hpRatio - 0.375) < 1e-9, `hpRatio ${state.balance.hpRatio}`)
assert.ok(Math.abs(state.balance.fpRatio - 0.07) < 1e-9, `fpRatio ${state.balance.fpRatio}`)

// Context: projectedTokens 73000 / 128000 = 57.03% -> 57.
assert.equal(state.context.available, true)
assert.equal(state.context.used, 73000)
assert.equal(state.context.total, 128000)
assert.equal(state.context.percent, 57)
assert.ok(Math.abs(state.context.ratio - 73000 / 128000) < 1e-9)
// The stamina bar reads as what is LEFT, so the host must publish both sides
// of the same measurement and they must agree.
assert.equal(state.context.freePercent, 43, 'free side is the complement of occupancy')
assert.equal(state.context.percent + state.context.freePercent, 100)
assert.ok(Math.abs(state.context.freeRatio - (1 - 73000 / 128000)) < 1e-9)
assert.ok(
  Math.abs(state.context.ratio + state.context.freeRatio - 1) < 1e-9,
  'occupancy and free must sum to the whole window',
)
assert.equal(state.context.model, 'deepseek-flash')

// The balance read is cached: a second poll must not hit the service again.
await primary.state()
assert.equal(primary.calls.balance, 1, 'balance must be cached inside the TTL window')

// --- over-target balance clamps --------------------------------------------

const rich = mount({ hpTargetCny: 50, fpTargetCny: 50 }, {
  deepseekAccount: {
    getBalance: async () => ({
      status: 'ready',
      value: [{ currency: 'CNY', balance: '91.00' }],
      bonusWallets: [{ currency: 'CNY', balance: '0' }],
    }),
  },
})
const richState = await rich.state()
assert.equal(richState.balance.recharge, 91)
assert.equal(richState.balance.hpRatio, 1, 'over-target balance clamps to 100%')
assert.equal(richState.balance.fpRatio, 0)

// --- the two caps are independent -------------------------------------------
//
// The point of separate caps: the same money must read differently against each
// bar's own scale, so neither bar can silently adopt the other's.

const splitCaps = mount({ hpTargetCny: 10, fpTargetCny: 100 }, {
  deepseekAccount: {
    getBalance: async () => ({
      status: 'ready',
      value: [{ currency: 'CNY', balance: '25' }],
      bonusWallets: [{ currency: 'CNY', balance: '25' }],
    }),
  },
})
const split = await splitCaps.state()
assert.equal(split.balance.recharge, 25)
assert.equal(split.balance.bonus, 25)
assert.equal(split.balance.hpRatio, 1, '¥25 against a ¥10 cap fills the red bar')
assert.ok(
  Math.abs(split.balance.fpRatio - 0.25) < 1e-9,
  `the same ¥25 against a ¥100 cap is a quarter, got ${split.balance.fpRatio}`,
)

// --- degradation paths ------------------------------------------------------

const signedOut = mount({}, { deepseekAccount: { getBalance: async () => null } })
assert.equal((await signedOut.state()).balance.reason, 'signed-out')

const failed = mount({}, {
  deepseekAccount: {
    getBalance: async () => ({ status: 'failed' }),
  },
})
assert.equal((await failed.state()).balance.reason, 'query-failed')

const throwing = mount({}, {
  deepseekAccount: {
    getBalance: async () => {
      throw new Error('socket hang up')
    },
  },
})
const threwState = await throwing.state()
assert.equal(threwState.balance.available, false)
assert.equal(threwState.balance.reason, 'query-threw')

const noAccount = mount({}, { deepseekAccount: undefined })
assert.equal((await noAccount.state()).balance.reason, 'account-service-unavailable')

// Unknown context must render unavailable, never 0%.
const noWindow = mount(
  {},
  {
    sessionProjections: { snapshot: () => ({ asOfSeq: 0, values: {} }) },
    tokenMeter: { measure: () => ({ totalTokens: 0 }) },
  },
  { requestContext: () => ({ provider: 'x', model: 'y' }) },
)
assert.equal((await noWindow.state()).context.available, false)
assert.equal((await noWindow.state()).context.percent, null)
assert.equal((await noWindow.state()).context.freePercent, null)
assert.equal((await noWindow.state()).context.freeRatio, 0)

// No live session at all.
const noSession = mount({}, {
  agents: { roots: () => [] },
  sessions: { get: () => undefined, list: () => [] },
})
assert.equal((await noSession.state()).context.reason, 'no-session')

// A context-only window with a meter fallback still resolves.
const meterOnly = mount({}, {
  sessionProjections: { snapshot: () => ({ asOfSeq: 0, values: {} }) },
  tokenMeter: { measure: () => ({ totalTokens: 64000 }) },
})
const meterState = await meterOnly.state()
assert.equal(meterState.context.available, true)
assert.equal(meterState.context.used, 64000)
assert.equal(meterState.context.percent, 50)

// --- the browser, not the host, decides which session the bar describes ------
//
// Regression test for "switching sessions does not move the stamina bar": the
// host's own guess is the newest root session, so here the host would pick
// `session-other` — and it must lose to the session the browser names.

const shownSession = {
  id: 'session-test',
  seq: 3,
  eventAt: (seq) => (seq === 2 ? { time: 1_700_000_000_000 } : undefined),
  requestContext: () => ({
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    contextWindow: 128000,
  }),
}
const otherSession = {
  id: 'session-other',
  seq: 40,
  eventAt: () => ({ time: 1_800_000_000_000 }),
  requestContext: () => ({
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    contextWindow: 64000,
  }),
}
const switching = mount({ hpTargetCny: 50, fpTargetCny: 50 }, {
  agents: { roots: () => [{ id: 'session-other' }] },
  sessions: {
    get: (id) =>
      id === 'session-test' ? shownSession : id === 'session-other' ? otherSession : undefined,
    list: () => [otherSession],
  },
  sessionProjections: {
    snapshot: (session) => ({
      asOfSeq: 1,
      values: {
        contextPressure:
          session.id === 'session-other'
            ? { projectedTokens: 48000, pressureTokens: 48000, contextWindow: 64000 }
            : { projectedTokens: 64000, pressureTokens: 64000, contextWindow: 128000 },
      },
    }),
  },
})

// No hint from the browser: the host still guesses, and says that it guessed.
const guessed = await switching.state()
assert.equal(guessed.session.id, 'session-other')
assert.equal(guessed.session.requested, null)
assert.equal(guessed.session.source, 'host-guess')
assert.equal(guessed.context.percent, 75)

// The named session wins, even though the host's guess points elsewhere.
const named = await switching.state('/dsh-souls-hud/state.json?session=session-test')
assert.equal(named.session.id, 'session-test')
assert.equal(named.session.requested, 'session-test')
assert.equal(named.session.source, 'browser')
assert.equal(named.context.available, true)
assert.equal(named.context.used, 64000)
assert.equal(named.context.total, 128000)
assert.equal(named.context.percent, 50, 'the named session must supply the numbers')
assert.equal(named.context.freePercent, 50)

// A named session that is not live is an honest blank, not somebody else's
// numbers: reporting another session's context would be exactly the bug.
const ghost = await switching.state('/dsh-souls-hud/state.json?session=ghost')
assert.equal(ghost.session.id, null)
assert.equal(ghost.session.source, 'requested-not-live')
assert.equal(ghost.context.available, false)
assert.equal(ghost.context.reason, 'no-session')

// A blank or malformed query is "no hint", not "the session named ''".
const blank = await switching.state('/dsh-souls-hud/state.json?session=')
assert.equal(blank.session.source, 'host-guess')
assert.equal(blank.session.id, 'session-other')

// --- the burn meter follows the browser's hint, and nothing else -------------
//
// Regression for a bug that made the gauge permanently "warming up": the route
// treated *every* request as the browser's word on which session is on screen, so
// a bare poll (a `curl`, a monitor, a page that has not reported yet) erased the
// hint. The meter then fell back to the host's guess, whose idea of "the newest
// session" moves between samples — and every move restarted the measurement
// window, so a rate that needs a stable baseline never appeared.

const hinted = mount(
  { hpTargetCny: 50, fpTargetCny: 50 },
  {
    agents: { roots: () => [{ id: 'session-other' }] },
    sessions: {
      get: (id) => (id === 'session-test' ? shownSession : id === 'session-other' ? otherSession : undefined),
      list: () => [otherSession],
    },
    sessionProjections: {
      snapshot: (session) => ({
        asOfSeq: 1,
        values: {
          // Cumulatives, as the `tokenUsage` projection reports them.
          tokenUsage:
            session.id === 'session-other'
              ? { uncachedInputTokens: 999000, outputTokens: 999, cacheReadTokens: 0, cacheWriteTokens: 0 }
              : { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
          contextPressure: { projectedTokens: 1000, pressureTokens: 1000, contextWindow: 128000 },
        },
      }),
    },
  },
)

// The browser names a session: the meter measures *that* one, not the host's guess.
const hintedState = await hinted.state('/dsh-souls-hud/state.json?session=session-test')
assert.equal(hintedState.session.source, 'browser')
assert.equal(hintedState.burn.totalTokens, 110, 'the browser-named session is what gets measured')

// A bare poll must not erase that hint, even though the host would guess another
// session (and one with a wildly different ledger).
const bare = await hinted.state()
assert.equal(bare.session.source, 'host-guess', 'a bare poll still answers with the host guess')
assert.equal(
  bare.burn.totalTokens,
  110,
  'a bare poll must keep measuring the session the browser named, not restart on the host guess',
)
assert.equal(bare.burn.samples, 1, 'and it must not have started a new window')

// Naming a different session *is* a change, and starts a fresh window.
const switched = await hinted.state('/dsh-souls-hud/state.json?session=session-other')
assert.equal(switched.burn.totalTokens, 999999, 'a new session is measured from its own ledger')
assert.equal(switched.burn.samples, 1, 'and starts its window over')
assert.equal(switched.burn.available, false, 'so it has no rate until it has a baseline')

// --- assets, injection, config ---------------------------------------------

const assets = mount({ hpTargetCny: 50, fpTargetCny: 50 })
for (const asset of ['hud.js', 'hud.css']) {
  const route = assets.routes.get(`${BASE}/${asset}`)
  assert.ok(route, `${asset} route must be registered`)
  const res = makeRes()
  route.handler({ method: 'GET' }, res)
  assert.equal(res.statusCode, 200)
  assert.ok(res.body.length > 200, `${asset} must serve a body`)
  assert.equal(res.headers['cache-control'], 'no-store')
}
assert.match(
  (() => {
    const res = makeRes()
    assets.routes.get(`${BASE}/hud.js`).handler({}, res)
    return res.headers['content-type']
  })(),
  /javascript/,
)

// The donation images: one file type served, everything else refused before the
// filesystem is touched. The scratch directory is set at the top of this file
// (`DSH_SOULS_HUD_SUPPORT`), so the real `assets/support/` stays untouched.
//
// Requests go through `match()`, not through a route fetched by path: the path a
// route was registered under and the path a request actually has are two different
// things, and the real server is the one that decides. Registering the prefix as
// `/dsh-souls-hud/support/` (with a trailing slash) served nothing at all in the
// app while every assertion here still passed.
{
  const route = assets.match(`${BASE}/support/wechat.png`)
  assert.ok(route, 'the support route must match a request for one of its files')
  assert.equal(route.kind, 'prefix', 'a prefix route, because the file list belongs to the client half')
  assert.equal(assets.routes.has(`${BASE}/support/`), false, 'the prefix must be registered without a trailing slash')

  const png = makeRes()
  route.handler({ method: 'GET', url: `${BASE}/support/wechat.png` }, png)
  assert.equal(png.statusCode, 200, 'a configured image must be served')
  assert.equal(png.headers['content-type'], 'image/png')
  assert.equal(png.headers['cache-control'], 'no-store', 'a payment code must never be served stale')
  assert.equal(png.body.length, SUPPORT_BYTES.length, 'the whole file, byte for byte')

  for (const url of [
    `${BASE}/support/alipay.png`,            // configured but not on disk
    `${BASE}/support/wechat.txt`,            // not an image
    `${BASE}/support/wechat.png/../secret`,  // a path, not a name
    `${BASE}/support/..%2Fsettings.json`,    // the same, encoded
    `${BASE}/support/`,                      // nothing at all
  ]) {
    const res = makeRes()
    route.handler({ method: 'GET', url }, res)
    assert.equal(res.statusCode, 404, `${url} must not be served`)
  }

  const posted = makeRes()
  route.handler({ method: 'POST', url: `${BASE}/support/wechat.png` }, posted)
  assert.equal(posted.statusCode, 405, 'the route is read-only')
}

const methodRoute = assets.routes.get(`${BASE}/state.json`)
const methodRes = makeRes()
await methodRoute.handler({ method: 'POST' }, methodRes)
assert.equal(methodRes.statusCode, 405)

// The health probe must read the real render pipeline, not our own tap list.
const healthRoute = assets.routes.get(`${BASE}/health`)
assert.ok(healthRoute, 'health route must be registered')
const healthRes = makeRes()
healthRoute.handler({ method: 'GET' }, healthRes)
assert.equal(healthRes.statusCode, 200)
const health = JSON.parse(healthRes.body)
assert.equal(health.ok, true)
assert.equal(health.injection.script, true, 'renderIndex must emit the renderer script')
assert.equal(health.injection.style, true, 'renderIndex must emit the stylesheet')

assert.equal(assets.taps.length, 1, 'exactly one index tap')
const html = assets.taps[0]('<html><body><div id="root"></div></body></html>')
assert.ok(html.includes(`${BASE}/hud.js`), 'renderer must be injected')
assert.ok(html.includes(`${BASE}/hud.css`), 'stylesheet must be injected')
assert.ok(html.indexOf('hud.js') < html.indexOf('</body>'), 'injection must precede </body>')
assert.ok(html.includes('<div id="root">'), 'the existing body must survive')
assert.equal(assets.taps[0](html), html, 'the tap must be idempotent')

// A literal `</body>` inside an inline script must not capture the injection.
const tricky =
  '<html><head><script>var s = "</body>";</script></head><body><div id="root"></div></body></html>'
const trickyOut = assets.taps[0](tricky)
assert.ok(trickyOut.includes(`${BASE}/hud.js`), 'renderer must still be injected')
assert.ok(
  trickyOut.lastIndexOf(`${BASE}/hud.js`) < trickyOut.lastIndexOf('</body>'),
  'injection must land at the real end of the document',
)
assert.ok(
  trickyOut.indexOf('var s = "</body>"') > -1,
  'the inline script must be left untouched',
)
// A document with no body close tag still gets the tags.
assert.ok(assets.taps[0]('<html><head></head></html>').includes(`${BASE}/hud.js`))

const config = (await assets.state()).config
assert.equal(config.barWidth, 96)
assert.equal(config.scale, 1)
assert.equal(config.showText, true)
assert.equal(config.pollMs, 15000)
assert.equal(config.anchor, 'sidebar', 'the cluster sits in the sidebar brand row by default')
assert.equal(config.gapX, 10)
assert.equal(config.gapY, 10)
assert.equal(config.offsetX, 20)
assert.equal(config.device, 'whale', 'the built-in whale is the default device')
assert.equal(config.material, 'bronze', 'bronze is the default metal')
assert.equal(config.shape, 'round', 'the covenant-medal silhouette is the default shape')
assert.equal(config.burnFullScaleTpm, 6000, 'the burn gauge has a full scale, in new tokens/min')
// The published rule travels to the form, so the form cannot disagree with it.
assert.deepEqual(
  config.tariffPeakWindows,
  [{ start: '01:00', end: '04:00' }, { start: '06:00', end: '10:00' }],
  'the published peak windows are the default',
)
assert.deepEqual(config.tariffPeakWeekdays, [1, 2, 3, 4, 5], 'Monday through Friday')
assert.equal(config.tariffHolidayMode, 'cn', 'Chinese public holidays are excluded by default')
assert.equal(config.tariffMakeupWorkdays, false, 'and a 调休 workday is not peak unless asked')
assert.equal(config.tariffEnabled, true)
assert.equal(config.holidays.covered, true, 'the bundle covers the current year')
assert.equal(config.holidays.stale, false, 'and the next one, so it is not stale')
assert.ok(config.holidays.years.length >= 4)
assert.ok(config.holidays.source.includes('holiday-cn'), 'the calendar names its source')

// Every `/state.json` carries a burn and a tariff reading for the badge to draw,
// even before the meter has enough history to divide by.
const burnState = (await assets.state()).burn
assert.equal(burnState.available, false, 'a fresh host has no rate yet')
assert.equal(burnState.ratio, 0, 'and the gauge starts empty')
assert.equal(burnState.fullScaleTpm, 6000)
const tariffState = (await assets.state()).tariff
assert.equal(typeof tariffState.peak, 'boolean', 'the tariff window is always answered')
assert.equal(typeof tariffState.utcClock, 'string')
assert.equal(tariffState.enabled, true)
assert.deepEqual(config.customDevice, { present: false }, 'nothing uploaded yet')

// The device/material/shape round trip: what is in the profile patch has to
// survive, and anything unknown has to fall back rather than reach the renderer.
const cast = mount({ device: 'moon', material: 'silver', shape: 'octagon' })
assert.equal((await cast.state()).config.device, 'moon')
assert.equal((await cast.state()).config.material, 'silver')
assert.equal((await cast.state()).config.shape, 'octagon')
const bogus = mount({ device: 'nonsense', material: 'mithril', shape: 'hexagon' })
assert.equal((await bogus.state()).config.device, 'whale')
assert.equal((await bogus.state()).config.material, 'bronze')
assert.equal((await bogus.state()).config.shape, 'round')

// A device id that no longer exists has to fall back, not break: `spear` was a
// built-in once, so a settings file (or a profile patch) that still names it must
// land on the default rather than painting an empty field.
assert.equal((await mount({ device: 'spear' }).state()).config.device, 'whale',
  'a removed device id falls back to the default')

// Every motif the docs promise has to be a real device id, both in the host's
// allow-list and in the renderer's motif table. (The served assets are read later
// in this file, so this reads its own copy.)
const rendererSource = readFileSync(new URL('../lib/hud.js', import.meta.url), 'utf8')
for (const device of ['whale', 'hammer', 'sword', 'sun', 'moon', 'wolf']) {
  assert.equal((await mount({ device }).state()).config.device, device)
  assert.ok(
    rendererSource.includes(`${device}: function`),
    `the renderer is missing the ${device} motif`,
  )
}

// `anchor: frame` and `anchor: chat` must survive the round trip; anything
// else falls back to the sidebar default.
const framed = mount({ anchor: 'frame', offsetX: 200, offsetY: 40 })
const framedConfig = (await framed.state()).config
assert.equal(framedConfig.anchor, 'frame')
assert.equal(framedConfig.offsetX, 200)
assert.equal(framedConfig.offsetY, 40)
assert.equal((await mount({ anchor: 'chat' }).state()).config.anchor, 'chat')
assert.equal((await mount({ anchor: 'nonsense' }).state()).config.anchor, 'sidebar')

// --- the served browser assets must be valid -------------------------------

const hudJs = readFileSync(new URL('../lib/hud.js', import.meta.url), 'utf8')
const hudCss = readFileSync(new URL('../lib/hud.css', import.meta.url), 'utf8')
new Function(hudJs)
assert.ok(hudCss.includes('#dsh-souls-hud'), 'stylesheet targets the HUD root')
assert.ok(hudCss.includes('pointer-events: none'), 'the HUD must be click-through')
assert.ok(hudJs.includes('/state.json'), 'renderer must poll the state route')

// --- no animation escapes `prefers-reduced-motion` ---------------------------
//
// The reduced-motion block is a list of selectors maintained by hand, and nothing
// about forgetting one is visible to whoever forgets it: the animation simply keeps
// running for the people who asked it not to. So every selector that turns an
// animation *on* is read out of the stylesheet and looked for in that block — which
// is what makes the block a rule rather than a habit.
{
  // Comments first: a brace inside one would be read as a rule.
  const css = hudCss.replace(/\/\*[\s\S]*?\*\//g, '')
  const reduced = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)
  assert.ok(reduced, 'hud.css must carry a prefers-reduced-motion block')

  /** Selectors the block silences, the way the block itself is written. */
  const silenced = new Set()
  for (const rule of reduced[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(^|[;\s])animation\s*:\s*none/.test(rule[2])) continue
    for (const selector of rule[1].split(',')) silenced.add(selector.trim().replace(/\s+/g, ' '))
  }

  /** Selectors that set an animation outside that block. */
  const outside = css.replace(/@media[^{]*\{[\s\S]*?\n\}/g, '')
  const animated = []
  for (const rule of outside.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const animation = /(^|[;\s])animation\s*:\s*([^;]+)/.exec(rule[2])
    if (animation === null || /^\s*none/.test(animation[2])) continue
    for (const selector of rule[1].split(',')) {
      const trimmed = selector.trim().replace(/\s+/g, ' ')
      if (trimmed !== '') animated.push(trimmed)
    }
  }

  assert.ok(animated.length > 0, 'hud.css must animate something, or this check proves nothing')
  for (const selector of animated) {
    assert.ok(silenced.has(selector), `hud.css animates "${selector}" even when the user asks for less motion`)
  }
}

// --- the settings text is globalized, and the two dictionaries agree ---------
//
// The settings form's copy lives in `lib/client.js` as one table with a `zh` and
// an `en` column, registered into the app's locale namespace. Nothing else can
// catch a key that was added to one column only — the app falls back to English
// and the gap is invisible — so it is checked here, by reading the literal out
// of the bundle and comparing the two key sets.

const clientJs = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const hostJs = readFileSync(new URL('../lib/host.js', import.meta.url), 'utf8')
/** Take one `var NAME = <literal>;` object out of a source file. */
function objectLiteral(source, declaration) {
  const start = source.indexOf(declaration)
  if (start === -1) throw new Error(`harness: ${declaration} not found`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return new Function(`return ${source.slice(source.indexOf('{', start), i + 1)}`)()
    }
  }
  throw new Error(`harness: ${declaration} is not balanced`)
}
const dict = objectLiteral(clientJs, 'var DICT = ')
assert.deepEqual(
  Object.keys(dict.zh).sort(),
  Object.keys(dict.en).sort(),
  'the zh and en settings dictionaries must carry exactly the same keys',
)
assert.ok(Object.keys(dict.zh).length > 40, 'the dictionary must cover the whole form')
assert.ok(
  clientJs.includes('"souls-hud"'),
  'the client half must own a locale namespace to register its dictionary under',
)
// The renderer's own floor has to agree with the client half's seat, or the HUD
// would say one thing before a client half mounts and another after.
for (const key of ['row.balanceTitle', 'row.contextTitle', 'balance.signedOut', 'balance.unavailable', 'context.noSession']) {
  assert.ok(dict.zh[key] !== undefined && dict.en[key] !== undefined, `dictionary is missing ${key}`)
  assert.ok(hudJs.includes(`"${key}"`), `the renderer's fallback table is missing ${key}`)
}

// --- the tip jar is a tip jar, and it is configured in one place ---------------
//
// The plugin's answer to "how do I pay for this" is "you don't". The support
// section exists to say that, so these assertions keep the two halves honest: an
// advertised channel has to be renderable before it can be shown, a link has to be
// a real https page rather than a placeholder that looks live, and the settings
// form has to read *this* configuration rather than growing a second copy.
//
// `package.json`'s `funding` field is checked only once an address is filled in:
// npm reads that field, so an address that is configured but not declared is a
// channel nobody can find from the registry.

const support = objectLiteral(clientJs, 'var SUPPORT = ')
assert.ok(Array.isArray(support.channels) && support.channels.length > 0, 'SUPPORT.channels must be a list')
const supportIds = support.channels.map((channel) => channel.id)
assert.deepEqual(
  [...supportIds].sort(),
  [...new Set(supportIds)].sort(),
  'support channel ids must be unique (they are dictionary keys)',
)
for (const channel of support.channels) {
  assert.ok(
    dict.zh[`support.${channel.id}`] && dict.en[`support.${channel.id}`],
    `no dictionary label for the support channel ${channel.id}`,
  )
  if (channel.kind === 'link') {
    assert.ok(
      channel.url === '' || /^https:\/\//.test(channel.url),
      `support channel ${channel.id} must be empty or an https page`,
    )
  } else if (channel.kind === 'qr') {
    assert.ok(
      channel.file === '' || /^[a-z0-9][a-z0-9._-]{0,63}\.(png|jpe?g|webp|svg)$/i.test(channel.file),
      `support channel ${channel.id} has a file name the host route cannot serve`,
    )
    // A payment code is app-specific — the WeChat 赞赏码 cannot be read by Alipay or
    // by the camera app — so every QR channel has to carry the line that names the
    // app in both languages, or the caption would claim "scan to tip" and the
    // supporter would try the wrong scanner.
    assert.ok(
      dict.zh[`support.${channel.id}.scan`] && dict.en[`support.${channel.id}.scan`],
      `no "which app reads it" line for the QR channel ${channel.id}`,
    )
  } else {
    throw new Error(`harness: support channel ${channel.id} has an unknown kind ${channel.kind}`)
  }
}
for (const key of ['section.support', 'support.qrHint']) {
  assert.ok(dict.zh[key] && dict.en[key], `the dictionary must carry ${key} for the support section`)
}
// The panel is the heading and the buttons. It used to carry a second sentence
// explaining that a tip buys nothing, which only repeated the heading — in two
// languages, on the page where the buttons are the only thing to do. A deny-list on
// purpose, like the favicon rule: bringing the sentence back is a decision to take
// deliberately, not a key to re-add quietly.
for (const key of ['section.supportHint', 'support.thanks']) {
  assert.ok(!dict.zh[key] && !dict.en[key], `the support panel is heading-only: ${key} must not come back`)
}
assert.ok(clientJs.includes('SUPPORT.channels'), 'the settings form must read the one support configuration')
assert.ok(
  clientJs.includes('rel: "noreferrer noopener"'),
  'a support link must open with rel="noreferrer noopener"',
)
assert.ok(hostJs.includes('`${BASE}/support/`'), 'the host must serve the donation images under /support/')
assert.ok(
  hostJs.includes('SUPPORT_FILE') && !/sendSupport\(res, name\)[\s\S]{0,200}join\(/.test(hostJs),
  'the donation route must validate the name instead of joining it onto a path',
)

// A configured QR channel has to point at a file that is actually there: the form
// renders the route's answer as an image, and a 404 would show as a broken picture
// on the settings page — the one failure of this feature a user would see.
for (const channel of support.channels) {
  if (channel.kind !== 'qr' || !channel.file) continue
  assert.ok(
    existsSync(new URL(`../assets/support/${channel.file}`, import.meta.url)),
    `the configured QR image ${channel.file} must exist in assets/support/`,
  )
}

// A configured *link* channel has to be findable, and npm is where people look: the
// manifest's `funding` field is read by npm itself. A QR code has no URL to declare,
// which is exactly why it is checked on disk above instead.
const configuredLinks = support.channels.filter((channel) => channel.kind === 'link' && channel.url)
if (configuredLinks.length > 0) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const declared = JSON.stringify(pkg.funding ?? '')
  for (const channel of configuredLinks) {
    assert.ok(
      declared.includes(channel.url),
      `package.json must declare funding for ${channel.id} (${channel.url}) now that it is configured`,
    )
  }
}

// --- the published tarball must carry what the manifest claims -----------------
//
// `files` decides what npm ships, and a path that no longer exists is dropped
// silently: the package installs, then fails at runtime because the renderer or the
// holiday data is not in it. Every entry is checked here, and the five that the
// plugin cannot work without are named so that a rename cannot quietly empty the
// package while the manifest still looks right.

{
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'the manifest must declare what it ships')
  for (const entry of pkg.files) {
    assert.ok(
      existsSync(new URL(`../${entry}`, import.meta.url)),
      `package.json files lists ${entry}, which does not exist`,
    )
  }
  // The row's artwork, which the Plugins page reads from the manifest: a declared
  // icon that is not in the tarball is a broken image on every install.
  assert.ok(typeof pkg.icon === 'string' && pkg.icon !== '', 'the manifest must name an icon')
  assert.ok(
    existsSync(new URL(`../${pkg.icon.replace(/^\.\//, '')}`, import.meta.url)),
    `the manifest icon ${pkg.icon} does not exist`,
  )
  for (const required of ['lib/host.js', 'lib/client.js', 'lib/hud.js', 'lib/hud.css', 'data/holidays-cn.json']) {
    assert.ok(
      new URL('../' + required, import.meta.url) && existsSync(new URL(`../${required}`, import.meta.url)),
      `${required} must exist: the package is broken without it`,
    )
  }
}

// --- the retired DeepSeek mark must not come back ------------------------------
//
// The first cut of the badge stamped the app's own favicon path into the medallion
// — a trademark in a place its owner never put it, and inside an open-source
// package it would imply an endorsement that does not exist. The README promises a
// guard that fails if it returns; this is that guard.
//
// It checks both directions on purpose. The official path must be *absent* — the
// three fragments below are taken from the app's own `favicon.svg`, and they were
// verified present in the app bundle and absent here — and the whale this project
// drew must be *present*, so a quiet regression on either side fails the suite
// rather than shipping.

const OFFICIAL_MARK = [
  'M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798',
  '49.3237 10.2959 48.8354 10.0479Z',
  '33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z',
]
/** The head of this project's own whale, which the badge draws by default. */
const OWN_WHALE = 'M32.4 315.2C-1.97882 215.09'
const SHIPPED_SOURCES = [
  'lib/hud.js',
  'lib/hud.css',
  'preview/preview.html',
  'preview/cells.html',
  'assets/devices/whale.svg',
]
for (const file of SHIPPED_SOURCES) {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  for (const fragment of OFFICIAL_MARK) {
    assert.ok(
      !text.includes(fragment),
      `${file} carries the app's own favicon path: that mark is theirs, not ours`,
    )
  }
  assert.ok(
    !/favicon/i.test(text),
    `${file} mentions favicon — the official mark must not be shipped in any form`,
  )
}
for (const file of ['lib/hud.js', 'assets/devices/whale.svg']) {
  assert.ok(
    readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').includes(OWN_WHALE),
    `${file} must ship this project's own whale drawing`,
  )
}

// --- the motif's colour is the material, by construction ---------------------
//
// The rule the badge has to satisfy: whatever is stamped into the medal is the
// same metal as the medal. That is not enforced by two lists agreeing — the
// device stops are *defined as* metal stops, in two rules that cover both cuts.
// A future edit that reintroduces literal device colours fails here.

assert.ok(
  hudCss.includes('--dsh-sh-device-0: var(--dsh-sh-metal-1)'),
  'the light cut must define the device stops as metal stops',
)
assert.ok(
  hudCss.includes('--dsh-sh-device-0: var(--dsh-sh-metal-0)'),
  'the dark cut must define the device stops as metal stops',
)
assert.ok(
  !/--dsh-sh-device-[0-3]:\s*#/.test(hudCss),
  'no literal colour may be assigned to a device stop: the motif is the material',
)
assert.ok(
  !/--dsh-sh-ink:\s*#/.test(hudCss),
  'the ink fallback is a metal stop too, not a literal',
)

// Iron has to be tellable from silver.
//
// Both are cool greys, and iron used to be silver one shade darker — at badge
// size that reads as "silver, in shadow". Iron now carries a blue cast, and this
// asserts the *relationship* rather than four hex values, so the palette can be
// retuned freely as long as the two stay apart.

/** The light cut's ramp for one material, straight out of the stylesheet. */
function lightRamp(material) {
  const start = hudCss.indexOf(`.dsh-sh__mark[data-material="${material}"] {`)
  assert.ok(start !== -1, `${material} has a light cut`)
  const block = hudCss.slice(start, hudCss.indexOf('}', start))
  return [0, 1, 2, 3, 4].map((step) => {
    const found = new RegExp(`--dsh-sh-metal-${step}:\\s*(#[0-9a-f]{6})`, 'i').exec(block)
    assert.ok(found, `${material} declares metal-${step}`)
    return found[1].toLowerCase()
  })
}

/** How blue a hex reads: blue minus red. */
function blueness(hex) {
  return parseInt(hex.slice(5, 7), 16) - parseInt(hex.slice(1, 3), 16)
}

/** Perceived lightness, near enough for "which of these two is brighter". */
function lightness(hex) {
  const channel = (at) => parseInt(hex.slice(at, at + 2), 16) / 255
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

const ironRamp = lightRamp('iron')
const silverRamp = lightRamp('silver')
// metal-1..3 is the body of the ramp; metal-0 is the highlight, where both are
// nearly white and a hue difference would be meaningless.
for (const step of [1, 2, 3]) {
  assert.ok(
    blueness(ironRamp[step]) - blueness(silverRamp[step]) >= 12,
    `iron's metal-${step} must read measurably bluer than silver's ` +
      `(${blueness(ironRamp[step])} vs ${blueness(silverRamp[step])})`,
  )
}
assert.ok(
  lightness(silverRamp[1]) - lightness(ironRamp[1]) >= 0.08,
  'silver must stay the brighter of the two, or the blue cast is doing all the work',
)
assert.ok(
  lightness(silverRamp[0]) > 0.95,
  'silver keeps a near-white highlight — that is what makes it silver',
)

// A crack is a gap, so the ink it is drawn in has to be *dark*.
//
// It used to be a translucent bronze: on a dark field that reads as a highlight,
// and the fractures looked like scratches catching the light rather than breaks in
// the casting. When the heat is on, the fire is drawn *over* these paths.
const crackInks = [...hudCss.matchAll(/--dsh-sh-crack:\s*rgba?\(([^)]+)\)/g)].map((match) =>
  match[1].split(',').map(Number),
)
assert.ok(crackInks.length >= 8, `every material and cut needs a crack ink (found ${crackInks.length})`)
for (const ink of crackInks) {
  const [r, g, b] = ink
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  assert.ok(luma < 0.35, `a crack ink must be dark, not a highlight: rgb(${ink.slice(0, 3)})`)
}

// A dark app must not turn the preview's light cells dark.
//
// The settings board draws both cuts at once, so each cell has to *state* its cut:
// an ancestor test (`[data-ds-dark-theme]`) says what the app is, not what the cell
// is, and every dark rule that draws the medal therefore has to step aside for a
// cell that says `data-cut="light"`.
const darkMedalRules = [...hudCss.matchAll(/\[data-ds-dark-theme\][^{}]*\.dsh-sh__mark[^{}]*\{/g)].map((match) => match[0])
assert.ok(darkMedalRules.length >= 8, `the dark cut has several rules to guard (found ${darkMedalRules.length})`)
for (const rule of darkMedalRules) {
  assert.ok(
    rule.includes(':not([data-cut="light"])'),
    `a dark rule that draws the medal must step aside for a light cell: ${rule.trim().slice(0, 80)}`,
  )
}
// ...and the cells must carry it.
assert.ok(rendererSource.includes('" data-cut="'), 'the preview cells state their cut')

// A click on the floating badge must reach the badge.
//
// `setPointerCapture` on pointerdown retargets the pointerup to the cluster root,
// and the click is then delivered to the nearest common ancestor — the root, not
// the badge — so the badge's own handler never ran while floating. The capture has
// to stay in the *move* handler, where the drag actually starts.
const pointerDown = rendererSource.slice(
  rendererSource.indexOf('node.addEventListener("pointerdown"'),
  rendererSource.indexOf('node.addEventListener("pointermove"'),
)
assert.ok(pointerDown.length > 0, 'the drag binds a pointerdown handler')
assert.ok(
  // The call, not the word: the handler's own comment names the trap it avoids.
  !pointerDown.includes('setPointerCapture('),
  'a pointerdown must not capture the pointer: it steals the badge\'s own click',
)
assert.ok(
  rendererSource.slice(rendererSource.indexOf('node.addEventListener("pointermove"')).includes('setPointerCapture'),
  'the drag captures once it is a drag',
)
// The drag must move the cluster *itself*, not ask the tick to do it.
//
// `positionFloat()` is the periodic tick's function and deliberately returns early
// while a drag is in progress, so calling it from the move handler meant the cluster
// followed the pointer only at release — the reported "it jumps when I let go". The
// drag has to apply its own position (`applyFloat`).
const pointerMove = rendererSource.slice(
  rendererSource.indexOf('node.addEventListener("pointermove"'),
  rendererSource.indexOf('var end = function (event)'),
)
assert.ok(pointerMove.includes('applyFloat('), 'the drag must apply its own position')
assert.ok(
  !pointerMove.includes('positionFloat('),
  'the drag must not call the tick\'s positionFloat(): it stands aside while dragging',
)

// ...and the cluster must not be hidden from assistive technology while its badge
// is a focusable control.
assert.ok(
  !/root\.setAttribute\("aria-hidden"/.test(rendererSource),
  'the cluster must not set aria-hidden on itself: its badge is a button',
)

// The badge opens a *bundle* view, named by the bundle's package.
//
// `pluginNavigation.openBundle` is `selectPanel('plugins')` plus
// `setView({ kind: "package", name })`, and the app's documentation describes it as
// opening bundle details, with row pages identified by "the bundle package and row
// id". This asserts the two manifest facts the choice rests on — that this row ships
// inside a bundle, and that the bundle is the thing the profile installs — rather
// than leaving it to memory. (The component carries the browser half, which is why
// its page exists at all; the bundle is what names it.)
const bundleManifest = JSON.parse(readFileSync(new URL('../../builder-hud/package.json', import.meta.url), 'utf8'))
const componentManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(bundleManifest.dsh?.client, undefined, 'the bundle must not claim a browser half')
assert.equal(bundleManifest.dsh?.bundle?.patch, './cordis.patch.yml', 'it is a bundle, with a patch')
assert.equal(componentManifest.dsh?.client?.platform, 'web', 'the component is the one with the browser half')
const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.ok(
  clientSource.includes('var NAV_TARGET = "dsh-plugin-builder-hud"'),
  'and the badge names the bundle whose page carries this row',
)
assert.ok(
  clientSource.includes('trial: function'),
  'a candidate name can be tried from the console without a rebuild',
)

// The field is the **material's**, and no motif may tint it.
//
// A covenant-coloured enamel used to override the field per device (amber sun,
// blue moon, green wolf). It looked good and was wrong: picking a
// *figure* silently repainted the badge's *background*, which is the material's
// job. If it ever comes back it comes back as its own setting, so this asserts
// the shape of the contract rather than merely deleting the rules.
for (const device of ['whale', 'hammer', 'sword', 'sun', 'moon', 'wolf', 'custom']) {
  assert.ok(
    !hudCss.includes(`.dsh-sh__mark[data-device="${device}"]`),
    `the ${device} device must not paint a field of its own — the material owns it`,
  )
}
// The dark cut is keyed off any *ancestor* carrying the attribute, not `<body>`
// alone: the settings form's preview puts that attribute on a wrapper so a dark
// cell can sit inside a light page. The material blocks are what must carry it —
// and each one has to step aside for a cell that states the light cut, or a dark
// app would turn all four preview cells dark.
for (const material of ['bronze', 'iron', 'silver', 'gold']) {
  assert.ok(
    hudCss.includes(
      `[data-ds-dark-theme] .dsh-sh__mark:not([data-cut="light"])[data-material="${material}"]`,
    ),
    `the ${material} dark cut must be reachable from a preview cell`,
  )
}

// --- every test file has to parse -------------------------------------------
//
// The suites build their pages as template literals, so a stray backtick or a
// `\\s` in a comment is a *parse error in the test file*, not a caught failure —
// and the only symptom is a stack trace that says nothing about which edit did
// it. This has cost four debugging rounds; `--check` costs milliseconds.
for (const file of ['harness.mjs', 'upload.mjs', 'preview.mjs', 'devices.mjs', 'form.mjs']) {
  const checked = spawnSync(process.execPath, ['--check', new URL(file, import.meta.url).pathname], {
    encoding: 'utf8',
  })
  assert.equal(checked.status, 0, `${file} must parse:\n${checked.stderr}`)
}

console.log('souls-hud harness: all assertions passed')

// --- the settings route the Plugins page form talks to ----------------------
//
// Verified through the real handler: what the form reads, what it writes, what
// the write does to the effective configuration, and what is refused.

const configRoute = assets.routes.get(`${BASE}/config`)
assert.ok(configRoute, 'the settings route must be registered')

/** A request stub that replays a JSON body the way Node's IncomingMessage does. */
function makePost(body) {
  const listeners = { data: [], end: [] }
  return {
    method: 'POST',
    on(event, fn) {
      if (listeners[event]) listeners[event].push(fn)
      return this
    },
    replay() {
      if (body !== undefined) for (const fn of listeners.data) fn(Buffer.from(body))
      for (const fn of listeners.end) fn()
    },
  }
}

/** Drive the settings route and decode its JSON, replaying a body if given. */
async function callConfig(method, body) {
  const res = makeRes()
  const req = method === 'POST' ? makePost(body) : { method: 'GET' }
  configRoute.handler(req, res)
  req.replay?.()
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null }
}

const initial = await callConfig('GET')
assert.equal(initial.status, 200)
assert.equal(initial.json.config.numbers, 'always', 'readouts default to always on')
assert.equal(initial.json.config.staminaMode, 'remaining', 'stamina defaults to the free side')
assert.equal(initial.json.config.hpTargetCny, 50, 'the HP cap defaults to ¥50')
assert.equal(initial.json.config.fpTargetCny, 50, 'the FP cap defaults to ¥50')
assert.deepEqual(initial.json.overrides, {}, 'nothing saved yet')

// The two caps are separate settings: each bar is scaled by its own.
const written = await callConfig(
  'POST',
  JSON.stringify({ numbers: 'hover', hpTargetCny: 20, fpTargetCny: 80, staminaMode: 'used' }),
)
assert.equal(written.status, 200)
assert.deepEqual(written.json.refused, [], 'valid keys are accepted')
assert.equal(written.json.overrides.numbers, 'hover')
assert.equal(written.json.overrides.hpTargetCny, 20)
assert.equal(written.json.overrides.fpTargetCny, 80)

// The write must reach the configuration the renderer actually receives.
const afterWrite = (await assets.state()).config
assert.equal(afterWrite.numbers, 'hover', 'the saved preference is what the renderer gets')
assert.equal(afterWrite.staminaMode, 'used')
assert.equal(afterWrite.hpTargetCny, 20)
assert.equal(afterWrite.fpTargetCny, 80)

// And each wallet bar must be scaled by its own cap.
const capped = await assets.state()
// A bar saturates at its cap, so the ratio is the clamped share.
assert.ok(
  Math.abs(capped.balance.hpRatio - Math.min(1, capped.balance.recharge / 20)) < 1e-9,
  'the HP bar is scaled by the HP cap',
)
assert.ok(
  Math.abs(capped.balance.fpRatio - Math.min(1, capped.balance.bonus / 80)) < 1e-9,
  'the FP bar is scaled by the FP cap',
)

// Junk is refused rather than stored, and the good values survive it.
const refused = await callConfig(
  'POST',
  JSON.stringify({ numbers: 'sometimes', hpTargetCny: -5, fpTargetCny: 0, evil: 1 }),
)
assert.equal(refused.status, 200)
assert.deepEqual(refused.json.refused.sort(), ['evil', 'fpTargetCny', 'hpTargetCny', 'numbers'])
assert.equal(refused.json.config.numbers, 'hover', 'a refused write leaves the rest alone')
assert.equal(refused.json.config.hpTargetCny, 20)

const badJson = await (async () => {
  const res = makeRes()
  const req = makePost('{not json')
  configRoute.handler(req, res)
  req.replay()
  await new Promise((resolve) => setTimeout(resolve, 0))
  return res.statusCode
})()
assert.equal(badJson, 400, 'malformed JSON is a client error, not a crash')

// --- the burn/tariff settings, through the same route ------------------------

const burnWrite = await callConfig(
  'POST',
  JSON.stringify({
    burnFullScaleTpm: 5000,
    tariffPeakWindows: [{ start: '09:00', end: '12:00' }],
    tariffPeakWeekdays: [0, 6],
    tariffHolidayMode: 'custom',
    tariffCustomHolidays: ['2026-05-01', 'not-a-date'],
    tariffCustomWorkdays: '2026-05-09 2026-05-10',
    tariffMakeupWorkdays: true,
    tariffEnabled: false,
  }),
)
assert.deepEqual(burnWrite.json.refused, [], 'the tariff keys are accepted')
assert.equal(burnWrite.json.overrides.burnFullScaleTpm, 5000)
assert.deepEqual(burnWrite.json.overrides.tariffPeakWindows, [{ start: '09:00', end: '12:00' }])
assert.deepEqual(burnWrite.json.overrides.tariffCustomHolidays, ['2026-05-01'], 'junk dates are dropped')
assert.deepEqual(burnWrite.json.overrides.tariffCustomWorkdays, ['2026-05-09', '2026-05-10'])
const burnAfter = (await assets.state()).config
assert.equal(burnAfter.burnFullScaleTpm, 5000)
assert.deepEqual(burnAfter.tariffPeakWindows, [{ start: '09:00', end: '12:00' }])
assert.deepEqual(burnAfter.tariffPeakWeekdays, [0, 6])
assert.equal(burnAfter.tariffHolidayMode, 'custom')
assert.equal(burnAfter.tariffMakeupWorkdays, true)
assert.equal(burnAfter.tariffEnabled, false)
// ...and the reading is computed from the *saved* rule rather than the published
// one. Only the rule is asserted here: `peak` depends on what time the suite runs,
// which is exactly what the pure cases above pin down on a fake clock.
const tariffAfter = (await assets.state()).tariff
assert.equal(tariffAfter.enabled, false, 'the badge reading can be switched off')
assert.deepEqual(tariffAfter.windows.map((window) => window.text), ['09:00–12:00'])
assert.deepEqual(tariffAfter.weekdays, [0, 6])
assert.equal(tariffAfter.holidayMode, 'custom')

// Junk is refused here too: a bad clock, a negative scale, a non-boolean, and a
// window set with no readable window left in it.
const burnRefused = await callConfig(
  'POST',
  JSON.stringify({
    tariffPeakWindows: [{ start: '25:00', end: 'noon' }],
    tariffPeakWeekdays: [9],
    tariffHolidayMode: 'sometimes',
    tariffMakeupWorkdays: 'yes',
    burnFullScaleTpm: -1,
  }),
)
assert.deepEqual(burnRefused.json.refused.sort(), [
  'burnFullScaleTpm', 'tariffHolidayMode', 'tariffMakeupWorkdays', 'tariffPeakWeekdays', 'tariffPeakWindows',
])
assert.equal(burnRefused.json.config.burnFullScaleTpm, 5000, 'a refused write leaves the rest alone')

// --- the holiday calendar, through its own route ------------------------------

// The due decision, before any of it touches the network.
//
// The cadence is the feature: the State Council publishes the following year's
// arrangement in late October to early November, so a month is comfortably inside
// that lead and a week is used while the notice is due. What must *not* happen is
// polling all year for a notice that is not out yet — which is what the first
// version of this did, by treating "next year missing" as urgent from January.
const now = Date.parse('2026-09-28T12:00:00Z')
const fresh = { years: [2025, 2026, 2027], checkedAt: '2026-09-20T00:00:00Z', generatedAt: '2026-09-20', now }
assert.equal(holidayRefreshDue(fresh).due, false, 'a calendar fetched last week is left alone')
assert.equal(holidayRefreshDue(fresh).reason, 'fresh')
// A month old: look again. This is the ordinary case, and it is why the button is
// a fallback rather than the mechanism.
const aged = { years: [2025, 2026, 2027], checkedAt: '2026-08-01T00:00:00Z', generatedAt: '2026-08-01', now }
assert.equal(holidayRefreshDue(aged).due, true, 'a calendar fetched a month ago is refreshed')
assert.equal(holidayRefreshDue(aged).reason, 'aged')
// A bundle built recently counts as fresh even with nothing ever fetched.
assert.equal(holidayRefreshDue({ years: [2025, 2026, 2027], generatedAt: '2026-09-25', now }).due, false,
  'the bundled calendar is fresh on its own')
assert.equal(holidayRefreshDue({ years: [2025, 2026, 2027], generatedAt: '2026-09-25', now }).notice, false,
  'September is outside the notice window')

// January, with next year's arrangement not published yet: normal, and quiet.
// (This is the case the naive rule got wrong — it polled every six hours from
// January to November for a notice that does not exist until the autumn.)
const january = Date.parse('2027-01-05T00:00:00Z')
const covering = { years: [2026, 2027], checkedAt: '2027-01-02T00:00:00Z', generatedAt: '2027-01-02', now: january }
assert.equal(holidayRefreshDue(covering).due, false, 'January does not chase next years notice')
assert.equal(holidayRefreshDue(covering).reason, 'fresh')

// ...but once the notice is due, the cadence tightens to a week and the missing
// year is worth chasing.
const november = Date.parse('2026-11-10T00:00:00Z')
const waiting = { years: [2025, 2026], checkedAt: '2026-11-08T00:00:00Z', generatedAt: '2026-10-01', now: november }
assert.equal(holidayRefreshDue(waiting).notice, true, 'November is inside the notice window')
assert.equal(holidayRefreshDue(waiting).due, true, 'and a missing next year is chased then')
assert.equal(holidayRefreshDue(waiting).reason, 'notice-window')
assert.equal(holidayRefreshDue({ ...waiting, checkedAt: '2026-11-06T00:00:00Z' }).due, true,
  'the window uses the weekly cadence, not the monthly one')
assert.equal(
  holidayRefreshDue({
    years: [2025, 2026, 2027],
    checkedAt: '2026-11-06T00:00:00Z',
    generatedAt: '2026-11-06',
    now: november,
  }).due,
  false,
  'and once the next year is in hand, back to the monthly cadence',
)
// ...which the same case fails without: this data is 40 days old.
assert.equal(
  holidayRefreshDue({ ...waiting, years: [2025, 2026, 2027], checkedAt: '2026-11-06T00:00:00Z' }).due,
  true,
  'stale data is refreshed even with the notice in hand',
)
// October 15 is the start of the window, October 14 is not.
assert.equal(holidayRefreshDue({ ...waiting, now: Date.parse('2026-10-14T12:00:00Z') }).notice, false)
assert.equal(holidayRefreshDue({ ...waiting, now: Date.parse('2026-10-15T00:00:00Z') }).notice, true)
assert.equal(holidayRefreshDue({ ...waiting, now: Date.parse('2026-11-30T23:00:00Z') }).notice, true)
assert.equal(holidayRefreshDue({ ...waiting, now: Date.parse('2026-12-01T00:00:00Z') }).notice, false)

// Missing the year we are *in* is the one emergency: the rule cannot answer "is
// today a holiday" at all.
const emergency = { years: [2025], checkedAt: '2026-09-28T06:00:00Z', generatedAt: '2026-09-28', now }
assert.equal(holidayRefreshDue(emergency).due, true, 'a calendar with no current year is refreshed')
assert.equal(holidayRefreshDue(emergency).urgent, true)
assert.equal(holidayRefreshDue(emergency).reason, 'missing-year')
assert.equal(holidayRefreshDue({ years: [], now }).reason, 'no-calendar')
// It is retried every few hours rather than every tick...
assert.equal(holidayRefreshDue({ ...emergency, checkedAt: '2026-09-28T11:00:00Z' }).due, false, 'a recent attempt waits')
assert.equal(holidayRefreshDue({ ...emergency, checkedAt: '2026-09-28T11:00:00Z' }).reason, 'retry-wait')

// A failed ordinary attempt waits a day rather than hammering, and a day-old
// calendar is not re-fetched at all.
const justTried = { years: [2025, 2026, 2027], checkedAt: '2026-09-28T02:00:00Z', generatedAt: '2026-08-01', now }
assert.equal(holidayRefreshDue(justTried).due, false, 'a recent failure backs off')
assert.equal(holidayRefreshDue(justTried).reason, 'retry-wait')
assert.equal(holidayRefreshDue({ ...justTried, checkedAt: '2026-09-26T00:00:00Z' }).due, true,
  'and tries again the next day')

// The route table is captured by `mount`; find the one we are testing.
const holidayRoute = assets.routes.get(`${BASE}/holidays.json`)
assert.ok(holidayRoute, 'the holiday route is registered')
const readHolidays = async (method, body) => {
  const res = makeRes()
  const req = method === 'POST' ? makePost(body) : { method: method, on: () => {} }
  await holidayRoute.handler(req, res)
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null }
}

const holidayGet = await readHolidays('GET')
assert.equal(holidayGet.status, 200)
assert.equal(holidayGet.json.ok, true)
assert.equal(holidayGet.json.status.auto, true, 'the calendar keeps itself current by default')
assert.ok(holidayGet.json.status.checkedAt, 'and says how fresh it is, bundle date included')
assert.ok(holidayGet.json.status.years.includes(2026), 'the bundled calendar is readable over the route')
assert.ok(holidayGet.json.years['2026'].days.length > 30, 'and carries its days')
assert.ok(holidayGet.json.status.source.includes('holiday-cn'), 'and names its source')

// The refresh reaches upstream. `globalThis.fetch` is stubbed rather than the
// network being called: a test that depends on GitHub being up is a test that
// fails for reasons that have nothing to do with this plugin.
const realFetch = globalThis.fetch
let fetchedUrls = []
globalThis.fetch = async (url) => {
  fetchedUrls.push(String(url))
  const year = /(\d{4})\.json$/.exec(String(url))[1]
  return {
    ok: true,
    status: 200,
    json: async () => ({
      year: Number(year),
      papers: [`https://www.gov.cn/${year}`],
      days: [
        { name: '测试节', date: `${year}-01-02`, isOffDay: true },
        { name: '调休', date: `${year}-01-04`, isOffDay: false },
      ],
    }),
  }
}
const refreshed = await readHolidays('POST', JSON.stringify({}))
globalThis.fetch = realFetch
assert.equal(refreshed.status, 200)
assert.equal(refreshed.json.ok, true)
assert.equal(refreshed.json.reason, 'manual')
assert.deepEqual(refreshed.json.fetched, [2026, 2027], 'the current and next year are fetched')
assert.ok(fetchedUrls.every((url) => url.startsWith('https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/')),
  'from the documented source')
assert.ok(refreshed.json.status.years.includes(2026) && refreshed.json.status.years.includes(2027))
assert.ok(readFileSync(HOLIDAY_TMP, 'utf8').includes('测试节'), 'the refresh is cached for the next run')

// Upstream being unreachable keeps the calendar rather than emptying it: an empty
// calendar would quietly make every holiday a working day.
globalThis.fetch = async () => {
  throw new Error('offline')
}
const offline = await readHolidays('POST', JSON.stringify({}))
globalThis.fetch = realFetch
assert.equal(offline.json.ok, false)
assert.equal(offline.json.reason, 'upstream-unreachable')
assert.equal(offline.json.status.years.includes(2026), true, 'the existing calendar survives a failed refresh')
// ...and the failure is remembered, so the automatic check waits rather than
// retrying in a loop while the machine is offline.
assert.ok(offline.json.status.lastError, 'the failure is reported')
assert.equal(
  holidayRefreshDue({
    checkedAt: offline.json.status.checkedAt,
    generatedAt: offline.json.status.generated,
    years: offline.json.status.years,
    now: Date.parse(offline.json.status.checkedAt) + 60 * 1000,
  }).reason,
  'fresh',
  'a moment after a failed attempt, the auto check does nothing',
)

// --- the badge settings, through the same route ------------------------------

assert.equal(initial.json.config.device, 'whale')
assert.equal(initial.json.config.material, 'bronze')

const badge = await callConfig('POST', JSON.stringify({ device: 'moon', material: 'gold', shape: 'octagon' }))
assert.equal(badge.status, 200)
assert.deepEqual(badge.json.refused, [])
assert.equal(badge.json.overrides.device, 'moon')
assert.equal(badge.json.overrides.material, 'gold')
assert.equal(badge.json.overrides.shape, 'octagon')
const afterBadge = (await assets.state()).config
assert.equal(afterBadge.device, 'moon', 'the saved device reaches the renderer')
assert.equal(afterBadge.material, 'gold', 'the saved metal reaches the renderer')
assert.equal(afterBadge.shape, 'octagon', 'the saved silhouette reaches the renderer')

const badBadge = await callConfig('POST', JSON.stringify({ device: 'halberd', material: 'mithril', shape: 'hexagon' }))
assert.deepEqual(badBadge.json.refused.sort(), ['device', 'material', 'shape'])
assert.equal(badBadge.json.config.device, 'moon', 'a refused device leaves the rest alone')

// --- the uploaded device ------------------------------------------------------
//
// The file is the trust boundary: the renderer inlines what is here into the
// app's own document, and this route is the only gate it passes. So the tests
// drive the real handler — a good upload, every category of refusal, a 404 when
// there is nothing stored, and a delete that really removes it.

const deviceRoute = assets.routes.get(`${BASE}/device.svg`)
assert.ok(deviceRoute, 'the device route must be registered')

/** Drive the device route with a verb and an optional body. */
async function callDevice(method, body) {
  const res = makeRes()
  const req = method === 'POST' || method === 'PUT' ? makePost(body) : { method }
  await deviceRoute.handler(req, res)
  req.replay?.()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const isJson = String(res.headers['content-type'] || '').includes('application/json')
  return { status: res.statusCode, body: res.body, json: isJson && res.body ? JSON.parse(res.body) : null }
}

// Nothing uploaded: a 404, which the renderer reads as "fall back to the mark"
// rather than as an error.
const noDevice = await callDevice('GET')
assert.equal(noDevice.status, 404)
assert.equal(noDevice.json.reason, 'no-custom-device')

const goodSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<path fill="currentColor" d="M4 4h24v24H4z"/></svg>'
const stored = await callDevice('POST', JSON.stringify({ svg: goodSvg }))
assert.equal(stored.status, 200, `a valid SVG must be stored: ${stored.body}`)
assert.equal(stored.json.ok, true)
assert.equal(stored.json.customDevice.present, true)
assert.ok(stored.json.customDevice.bytes > 0)

// A raw `image/svg+xml` body works too, so `curl -T` is a usable interface.
const raw = await callDevice('POST', goodSvg)
assert.equal(raw.status, 200)
assert.equal(raw.json.ok, true)

// It is served back, with the xmlns added when the upload forgot it.
const roundTrip = await callDevice('GET')
assert.equal(roundTrip.status, 200)
assert.ok(roundTrip.body.includes('M4 4h24v24H4z'))
assert.ok(roundTrip.body.includes('xmlns="http://www.w3.org/2000/svg"'))

// `/state.json` has to advertise it, or the form cannot offer the custom device.
assert.deepEqual((await assets.state()).config.customDevice.present, true)

// Every refusal. These are the reasons the form turns into a sentence, so they
// are part of the contract, not implementation detail.
const refusals = [
  ['empty', JSON.stringify({ svg: '' })],
  ['not-an-svg', JSON.stringify({ svg: '<div>nope</div>' })],
  ['no-viewbox', JSON.stringify({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>' })],
  ['forbidden-element', JSON.stringify({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><script>alert(1)</script></svg>' })],
  ['event-handler', JSON.stringify({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4" onload="alert(1)"></svg>' })],
  ['external-reference', JSON.stringify({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><use href="https://example.com/x.svg#a"/></svg>' })],
  ['script-url', JSON.stringify({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><a href="javascript:alert(1)">x</a></svg>' })],
  ['too-large', JSON.stringify({ svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4">${'x'.repeat(70000)}</svg>` })],
]
for (const [reason, body] of refusals) {
  const answer = await callDevice('POST', body)
  assert.equal(answer.status, 400, `${reason} must be a client error`)
  assert.equal(answer.json.reason, reason, `refusal reason for ${reason}`)
}
const notJson = await callDevice('POST', '{not json')
assert.equal(notJson.status, 400)
assert.equal(notJson.json.reason, 'invalid-json')

// A refused write must not have disturbed the stored file.
assert.ok((await callDevice('GET')).body.includes('M4 4h24v24H4z'))

// Delete really removes it, and deleting twice is not an error.
const deleted = await callDevice('DELETE')
assert.equal(deleted.status, 200)
assert.equal(deleted.json.customDevice.present, false)
assert.equal((await callDevice('GET')).status, 404)
assert.equal((await callDevice('DELETE')).status, 200)

// --- the rename keeps the old settings file readable --------------------------
//
// A user who had the plugin under its previous name must not silently lose the
// caps they set. The new file wins as soon as anything is written to it.

rmSync(SETTINGS_TMP, { force: true })
writeFileSync(LEGACY_TMP, JSON.stringify({ hpTargetCny: 12.5, material: 'gold' }))
const legacy = mount({})
const legacyConfig = (await legacy.state()).config
assert.equal(legacyConfig.hpTargetCny, 12.5, 'the pre-rename settings file is still read')
assert.equal(legacyConfig.material, 'gold')
rmSync(LEGACY_TMP, { force: true })

console.log('souls-hud settings: all assertions passed')

rmSync(SETTINGS_TMP, { force: true })
rmSync(LEGACY_TMP, { force: true })
rmSync(DEVICE_TMP, { force: true })
