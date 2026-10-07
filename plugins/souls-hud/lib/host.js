/**
 * BuilderHUD — host half. Ships Souls Style.
 *
 * Renders a Dark Souls style HUD in the top-left of the DSH GUI:
 *
 *   - red   HP bar  ..... API balance (recharge wallet), `hpTargetCny` CNY = 100%
 *   - blue  FP bar  ..... granted / bonus wallet,          `fpTargetCny` CNY = 100%
 *   - green Stamina bar . context-window occupancy of the live session
 *
 * The host half owns the data (the browser half cannot reach `deepseekAccount`
 * or the session projections) and serves it over a handful of unauthenticated,
 * loopback-only routes next to one `webServer.tapIndex` injection that pulls the
 * stylesheet and the renderer into `index.html`.
 *
 * It also owns the two customization payloads the settings form writes:
 *
 *   - the medallion's **device** (whale / hammer / sword / sun / moon / a
 *     user-supplied SVG) and its **material** (bronze / iron / silver / gold,
 *     each with a light and a dark rendition), which are plain preferences;
 *   - the custom SVG itself, which is a *file* — `~/.dsh/souls-hud-device.svg`
 *     — so it survives a settings rewrite and cannot bloat the JSON. The host is
 *     the trust boundary for it: `/device.svg` refuses anything that is not a
 *     bounded, self-contained SVG (no script, no event handler, no external
 *     reference) before it is stored, and the renderer sanitizes again before
 *     inlining it.
 *
 * Deliberately imports nothing but Node built-ins, so it can be loaded from an
 * arbitrary absolute path by a profile's `cordis.patch.yml` without relying on
 * `@deepseek-ai/*` resolution from outside the installation.
 *
 * @module dsh-plugin-souls-hud
 */

import { holidayCoverage, holidayRefreshDue, indexHolidays, mergeHolidays, refreshHolidays } from './holidays.js'
import { DEFAULT_PEAK_WEEKDAYS, DEFAULT_PEAK_WINDOWS, migrateOffPeak, parseClock, tariffAt } from './tariff.js'
import { readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name. */
export const name = 'souls-hud'

/** Hard dependency: without the HTTP carrier there is nothing to serve. */
export const inject = ['webServer']

/** Route prefix; every served asset lives under it. */
const BASE = '/dsh-souls-hud'

/** Token-usage projection key registered by `@deepseek-ai/dsh-token-meter`. */
const PRESSURE_KEY = 'contextPressure'

/** Devices the medallion can be struck with. `custom` means the uploaded SVG. */
const DEVICES = ['whale', 'hammer', 'sword', 'sun', 'moon', 'wolf', 'custom']

/** Metals the medallion can be cast from; each has a light and a dark cut. */
const MATERIALS = ['bronze', 'iron', 'silver', 'gold']

/** Silhouettes the plate can be cut to: the covenant medal, or the octagon. */
const SHAPES = ['round', 'octagon']

/** Hard cap on a stored device SVG; the app's own manifest icon cap is 256 KiB. */
const DEVICE_LIMIT_BYTES = 64 * 1024

const DEFAULTS = {
  /** CNY amount mapped to 100% on the HP (topped-up) bar. */
  hpTargetCny: 100,
  /** CNY amount mapped to 100% on the FP (granted/bonus) bar. */
  fpTargetCny: 50,
  /** Browser poll interval, ms. */
  pollMs: 15000,
  /** Server-side cache for the Platform balance query, ms. */
  balanceCacheMs: 60000,
  /**
   * Fallback bar length in CSS px. Under `anchor: 'sidebar'` the renderer
   * measures the brand row instead and fits the bars to the space left of the
   * readouts, so all three always come out the same length.
   */
  barWidth: 96,
  /** Uniform HUD scale. */
  scale: 1,
  /**
   * `'sidebar'` sits in the left sidebar's brand row, beside the app's own
   * whale mark, and replaces the brand label. `'chat'` pins the cluster to the
   * top-left of the chat message area instead. Either follows the layout as the
   * sidebar expands, collapses or hides. `'frame'` uses the absolute offsets.
   */
  anchor: 'sidebar',
  /** Inset for the chat anchor, px. */
  gapX: 10,
  gapY: 10,
  /**
   * Absolute placement, used by `anchor: 'frame'` and as the fallback when
   * neither layout can be found.
   */
  offsetX: 20,
  offsetY: 40,
  /** Show the numeric readouts beside each bar. */
  showText: true,
  /**
   * The numeric readouts beside the bars: `'always'`, `'hover'` (only while the
   * cluster is under the pointer) or `'hidden'`. Supersedes `showText` and is
   * what the settings form writes.
   */
  numbers: 'always',
  /**
   * Which side of the context window the stamina bar shows: `'remaining'` (the
   * pool that is left, so all three bars mean "how much is left") or `'used'`.
   */
  staminaMode: 'remaining',
  /**
   * What sits inside the medallion's bezel. `whale` is BuilderHUD's own mark —
   * deliberately an original drawing, not the DeepSeek logo — and `custom` is
   * whatever the user uploaded.
   */
  device: 'whale',
  /**
   * The plate's silhouette. `round` is a Dark Souls III style covenant medal
   * (milled edge, recessed enamel field, symbol stamped in metal); `octagon` is
   * the cut-corner plate this plugin shipped first.
   */
  shape: 'round',
  /** The metal the medallion is cast from. */
  material: 'bronze',
  /**
   * Dim the cluster after this long without a change, ms. 0 disables — it is a
   * fixture of the sidebar, so it stays solid by default.
   */
  idleDimMs: 0,
  /** Below this percentage a bar is treated as critical (it pulses). */
  criticalPercent: 25,
  /**
   * **New** tokens per minute (uncached input + output) that fills the burn
   * gauge. Cache reads are excluded: they are the same context read again, and
   * they dwarf everything else — one 198M-token session was 196M of cache reads.
   */
  burnFullScaleTpm: 6000,
  /** Sliding window the burn rate is averaged over, ms. */
  burnWindowMs: 60000,
  /** How often the host samples the session's token totals, ms. 0 disables. */
  burnSampleMs: 3000,
  /**
   * Off-peak detection. The window is **UTC**, because that is how the pricing
   * windows are published; both ends are `HH:MM`, and a window that ends before
   * it starts wraps past midnight.
   */
  /**
   * Peak hours, UTC: 01:00–04:00 and 06:00–10:00 on working days. Off-peak is
   * everything else, at half the rate. Note the gap at 04:00–06:00 — that is
   * off-peak, which one "off-peak window" cannot express.
   */
  tariffPeakWindows: DEFAULT_PEAK_WINDOWS,
  /** Monday through Friday, in `Date.getUTCDay()` numbering. */
  tariffPeakWeekdays: DEFAULT_PEAK_WEEKDAYS,
  /** `cn` uses the Chinese calendar (bundled, refreshable); `custom` a list. */
  tariffHolidayMode: 'cn',
  tariffCustomHolidays: [],
  tariffCustomWorkdays: [],
  /**
   * Whether a 调休 make-up workday counts as a working day. Off by default: the
   * published rule is "Monday through Friday", so a 调休 Saturday is off-peak.
   */
  tariffMakeupWorkdays: false,
  /**
   * Keep the holiday calendar current without being asked. On by default: a
   * calendar that quietly goes out of date calls a holiday a working day, and
   * nobody should have to remember to press a button for the rule to be right.
   */
  tariffAutoRefresh: true,
  /** Show the peak/off-peak reading on the badge at all. */
  tariffEnabled: true,
  /** Identifier sent to the Platform balance API. */
  version: '0.1.7-rc.2',
  /** Locale sent to the Platform balance API. */
  locale: 'zh_CN',
}

/**
 * Read one of the shipped asset files next to this module.
 *
 * Read per request (not cached) so that editing the stylesheet or the renderer
 * and reloading the page is enough to see the change.
 * @param file - file name inside `lib/`.
 * @returns the file's UTF-8 text.
 */
function asset(file) {
  return readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
}

/**
 * The donation QR images, when the author has put any in.
 *
 * They are the author's own payment codes, so they live outside `lib/` in
 * `assets/support/` and only a conservative file-name pattern is ever read: the
 * route cannot be talked into serving anything else in the package, and a name is
 * rejected before it reaches the filesystem (no separator matches the pattern, so
 * there is no traversal to guard against a second time).
 */
const SUPPORT_FILE = /^[a-z0-9][a-z0-9._-]{0,63}\.(png|jpe?g|webp|svg)$/i
const SUPPORT_TYPE = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

/**
 * The directory the donation images are read from.
 *
 * `assets/support/` in the package; `DSH_SOULS_HUD_SUPPORT` moves it, which is
 * how the harness drives the route against a scratch directory instead of writing
 * test images into the package. Read per request, like the other overrides here.
 *
 * @returns the absolute directory path.
 */
function supportDir() {
  return process.env.DSH_SOULS_HUD_SUPPORT || fileURLToPath(new URL('../assets/support/', import.meta.url))
}

/**
 * The requested donation image's name, taken off a request URL.
 *
 * @param req - the Node request.
 * @returns the decoded file name, or `''` when the URL is not under the route.
 */
function supportName(req) {
  const raw = String(req.url ?? '').split('?')[0].split('#')[0]
  const prefix = `${BASE}/support/`
  if (!raw.startsWith(prefix)) return ''
  try {
    return decodeURIComponent(raw.slice(prefix.length))
  } catch {
    return ''
  }
}

/**
 * Answer one donation image, or a bare 404.
 *
 * @param res - the Node response.
 * @param name - the requested file name.
 */
function sendSupport(res, name) {
  if (!SUPPORT_FILE.test(name)) {
    res.statusCode = 404
    res.end()
    return
  }
  let body
  try {
    // The name is already validated to hold no separator, so this cannot leave the
    // directory — and it is the *only* reason that is true, which is why the check
    // above is not an optimisation.
    body = readFileSync(join(supportDir(), name))
  } catch {
    res.statusCode = 404
    res.end()
    return
  }
  const extension = name.split('.').pop().toLowerCase()
  res.statusCode = 200
  res.setHeader('content-type', SUPPORT_TYPE[extension] ?? 'application/octet-stream')
  // A payment code is replaced by editing a file in place, so it must never be
  // served stale — and this is a local page, where one extra request is free.
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', body.length)
  res.end(body)
}

/**
 * Send a complete JSON response.
 * @param res - the Node response.
 * @param status - HTTP status code.
 * @param body - JSON-serializable payload.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(text))
  res.end(text)
}

/**
 * Send a text asset that must never be served stale.
 * @param res - the Node response.
 * @param type - MIME type.
 * @param text - response body.
 */
function sendAsset(res, type, text) {
  res.statusCode = 200
  res.setHeader('content-type', `${type}; charset=utf-8`)
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(text))
  res.end(text)
}

/**
 * Sum every wallet of one currency.
 * @param wallets - `AccountWallet[]` or anything else.
 * @param currency - currency code to keep.
 * @returns the summed decimal balance, or `undefined` when that currency is absent.
 */
function sumWallets(wallets, currency) {
  if (!Array.isArray(wallets)) return undefined
  let seen = false
  let total = 0
  for (const wallet of wallets) {
    if (!wallet || wallet.currency !== currency) continue
    const value = Number(wallet.balance)
    if (!Number.isFinite(value)) continue
    seen = true
    total += value
  }
  return seen ? total : undefined
}

/**
 * Pick the currency the account actually reports, preferring CNY.
 * @param wallets - `AccountWallet[]`.
 * @returns the chosen currency code.
 */
function pickCurrency(wallets) {
  const list = Array.isArray(wallets) ? wallets : []
  if (list.some((wallet) => wallet && wallet.currency === 'CNY')) return 'CNY'
  const first = list.find((wallet) => wallet && typeof wallet.currency === 'string')
  return first ? first.currency : 'CNY'
}

/**
 * Clamp a 0..1 fraction.
 * @param value - candidate fraction.
 * @returns the clamped fraction.
 */
function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * Time of a session's newest event, used to guess which session the user is
 * looking at (the GUI keeps one root session in front).
 * @param session - live `Session`.
 * @returns epoch ms, or 0 when unknown.
 */
function lastEventTime(session) {
  try {
    const tail = Number(session.seq)
    if (!Number.isFinite(tail) || tail <= 0) return 0
    return session.eventAt(tail - 1)?.time ?? 0
  } catch {
    return 0
  }
}

/**
 * The session the browser says it is showing, from `/state.json?session=…`.
 *
 * Session *selection* lives in the browser, not in the host: the client half
 * reads it from the app's own `uiSession` service and the renderer sends it with
 * every poll. Without it the host has to guess, and its guess — newest root
 * session by last event — never changes when the user switches sessions, which
 * left the stamina bar describing whatever session was last active instead of
 * the one on screen.
 * @param req - the Node request.
 * @returns the requested session id, or undefined when absent or blank.
 */
function requestedSessionId(req) {
  try {
    const url = new URL(String(req.url ?? ''), 'http://localhost')
    const id = url.searchParams.get('session')
    return id !== null && id.trim() !== '' ? id.trim() : undefined
  } catch {
    return undefined
  }
}

/** Elements that can execute, navigate or fetch — never part of a badge. */
const DEVICE_FORBIDDEN_ELEMENT =
  /<\s*(script|foreignObject|iframe|object|embed|image|feImage|animate|animateTransform|animateMotion|set|link|meta|base|style)\b/i
/** Inline event handlers. */
const DEVICE_EVENT_ATTRIBUTE = /\son[a-z]+\s*=/i
/** Anything but an in-document fragment reference. */
const DEVICE_EXTERNAL_REFERENCE = /(?:href|xlink:href)\s*=\s*["']\s*(?!#)[^"']*["']/i
/** Script-ish URL schemes. */
const DEVICE_SCRIPT_URL = /(?:javascript|vbscript|data)\s*:/i

/**
 * The one gate every stored device SVG has to pass.
 *
 * The settings form normalizes an upload before it is sent, but the file on disk
 * is the trust boundary: it can be edited by hand, and the renderer inlines it
 * into the app's own document. So this refuses anything that is not a bounded,
 * self-contained SVG rather than trying to repair it — it is the last check
 * between an uploaded file and `innerHTML`.
 *
 * @param text - the candidate SVG document.
 * @returns `{ ok: true, svg }` with the storable text, or `{ ok: false, reason }`.
 */
function scrubDeviceSvg(text) {
  const svgText = typeof text === 'string' ? text.trim() : ''
  if (svgText === '') return { ok: false, reason: 'empty' }
  if (Buffer.byteLength(svgText) > DEVICE_LIMIT_BYTES) return { ok: false, reason: 'too-large' }
  if (!/<svg[\s>]/i.test(svgText) || !/<\/svg\s*>/i.test(svgText)) {
    return { ok: false, reason: 'not-an-svg' }
  }
  if (DEVICE_FORBIDDEN_ELEMENT.test(svgText)) return { ok: false, reason: 'forbidden-element' }
  if (DEVICE_EVENT_ATTRIBUTE.test(svgText)) return { ok: false, reason: 'event-handler' }
  // Scheme before address: a `javascript:` in an `href` is better reported as a
  // script URL than as a generic external reference.
  if (DEVICE_SCRIPT_URL.test(svgText)) return { ok: false, reason: 'script-url' }
  if (DEVICE_EXTERNAL_REFERENCE.test(svgText)) return { ok: false, reason: 'external-reference' }
  if (!/viewBox\s*=/i.test(svgText)) return { ok: false, reason: 'no-viewbox' }
  const svg = /xmlns\s*=/.test(svgText)
    ? svgText
    : svgText.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  return { ok: true, svg }
}

/**
 * Parse an `HH:MM` UTC clock time into minutes past midnight.
 * @param value - the text to parse.
 * @param fallback - minutes to use when it is not a clock time.
 * @returns minutes past midnight.
 */
function utcMinutes(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (match === null) return fallback
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return fallback
  return hours * 60 + minutes
}

/**
 * The tariff rule lives in `tariff.js`, where it is pure and testable on a fake
 * clock. This re-export keeps it reachable through the host module.
 */
export { tariffAt }

/**
 * A list of `YYYY-MM-DD` dates, de-duplicated and sorted.
 *
 * An empty list is a real answer — it is how the form clears a custom calendar —
 * so this returns `[]` rather than `undefined` for "nothing usable".
 *
 * @param value - an array, or a whitespace/comma separated string.
 * @returns the dates.
 */
function dateList(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : []
  const dates = [
    ...new Set(
      list
        .map((item) => String(item).trim())
        .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item)),
    ),
  ]
  return dates.sort()
}

/**
 * The Chinese holiday calendar: bundled at build time, optionally refreshed from
 * upstream, and cached beside the config so a refresh survives a restart.
 *
 * Indexed once and re-indexed on a refresh. The tariff rule is pure and takes the
 * index as an argument, so nothing here reaches into the rule.
 */
/**
 * Where a refreshed calendar is cached. Read per use rather than at import: the
 * test harness points it at a scratch file, and a module-scope read would have
 * happened before it could.
 * @returns the absolute path.
 */
function holidayCachePath() {
  return process.env.DSH_SOULS_HUD_HOLIDAYS || join(homedir(), '.dsh', 'souls-hud-holidays.json')
}

/**
 * Read and index the calendar: the bundled years, with any cached refresh laid over.
 * @returns `{ payload, index }`.
 */
function loadHolidays() {
  let bundled
  try {
    bundled = JSON.parse(readFileSync(new URL('../data/holidays-cn.json', import.meta.url), 'utf8'))
  } catch {
    bundled = { years: {} }
  }
  let cached = null
  try {
    cached = JSON.parse(readFileSync(holidayCachePath(), 'utf8'))
  } catch {
    cached = null
  }
  const payload =
    cached && cached.years ? mergeHolidays(bundled, cached, Date.parse(cached.generated) || Date.now()) : bundled
  return { payload, index: indexHolidays(payload) }
}

let holidays = loadHolidays()

/** When upstream was last attempted, and what happened. Module scope: one calendar. */
let holidayAttempt = { at: 0, error: null, ok: false }

/**
 * A sliding-window token-rate meter.
 *
 * The projection it is fed (`tokenUsage`) is *cumulative* for a session, so a
 * rate is a difference between two samples divided by the time between them. It
 * tracks three series, because one number here would be a lie:
 *
 *   - **new** tokens (uncached input + output) are what the model actually
 *     processed and wrote this time. This is what the gauge draws;
 *   - **output** tokens are generation alone, the "how fast is it writing" side;
 *   - **cache** tokens (read + write) dominate the raw total — in one real long
 *     session, 196M of a 198M ledger — but they are the *same* context being read
 *     again, proportional to how big the context is rather than to how hard the
 *     model is working. Counting them makes every gauge peg at maximum.
 *
 * It reports `available: false` until two samples span enough time to divide by,
 * because a rate divided by a few hundred milliseconds is noise dressed up as a
 * measurement, and the gauge would flicker.
 *
 * A session switch is *not* this object's business; the caller resets it, because
 * only the caller can see that the ledger it is reading belongs to somebody else.
 *
 * @param options - `{ windowMs }`.
 * @returns `{ sample, reading, reset }`.
 */
export function createBurnTracker(options = {}) {
  const windowMs = Math.max(3000, Number(options.windowMs) || 60000)
  /** @type {{ at: number, newTokens: number, outputTokens: number, cacheTokens: number, totalTokens: number }[]} */
  let history = []

  /**
   * Trim the history to the window, keeping exactly one sample from *before* it.
   *
   * That older baseline matters: without it, a session that goes quiet drops to a
   * single sample and the reading becomes "unavailable" — so an idle agent would
   * report "measuring…" forever instead of the honest zero it has earned. With
   * it, the rate is averaged over the quiet stretch and decays to zero.
   */
  function trim(now) {
    while (history.length > 2 && now - history[1].at > windowMs) history.shift()
  }

  /** One series' mean rate over the retained window, in units per minute. */
  function perMinute(key) {
    const oldest = history[0]
    const newest = history[history.length - 1]
    const span = newest.at - oldest.at
    if (span <= 0) return null
    return Math.max(0, Math.round(((newest[key] - oldest[key]) / span) * 60000))
  }

  return {
    /**
     * Record one cumulative reading.
     * @param counters - `{ newTokens, outputTokens, cacheTokens, totalTokens }`.
     * @param at - epoch ms.
     */
    sample(counters, at) {
      const next = {
        at,
        newTokens: Math.max(0, Number(counters?.newTokens) || 0),
        outputTokens: Math.max(0, Number(counters?.outputTokens) || 0),
        cacheTokens: Math.max(0, Number(counters?.cacheTokens) || 0),
        totalTokens: Math.max(0, Number(counters?.totalTokens) || 0),
      }
      const last = history[history.length - 1]
      // A ledger that stepped backwards is not this session's ledger any more
      // (a fork, a restore, a stale cell): start a window rather than report a
      // negative rate.
      if (last !== undefined && (next.newTokens < last.newTokens || next.totalTokens < last.totalTokens)) {
        history = []
      }
      history.push(next)
      trim(at)
    },

    /**
     * The current rate over the window.
     * @param at - epoch ms.
     * @returns the reading; `available` is false until two samples span it.
     */
    reading(at) {
      trim(at)
      const newest = history[history.length - 1]
      const oldest = history[0]
      if (newest === undefined) {
        return { available: false, reason: 'no-samples', samples: 0, windowMs }
      }
      const span = newest.at - oldest.at
      // Under a third of the window the divisor is mostly timing noise.
      const usable = history.length >= 2 && span >= Math.min(windowMs / 3, 15000)
      if (!usable) {
        return {
          available: false,
          reason: 'warming-up',
          samples: history.length,
          spanMs: span,
          windowMs,
          totalTokens: newest.totalTokens,
          newTokens: newest.newTokens,
          outputTokens: newest.outputTokens,
          cacheTokens: newest.cacheTokens,
        }
      }
      return {
        available: true,
        tokensPerMin: perMinute('newTokens'),
        outputTokensPerMin: perMinute('outputTokens'),
        cacheTokensPerMin: perMinute('cacheTokens'),
        /** Cumulative for the session, so the form can show the whole picture. */
        totalTokens: newest.totalTokens,
        newTokens: newest.newTokens,
        outputTokens: newest.outputTokens,
        cacheTokens: newest.cacheTokens,
        samples: history.length,
        spanMs: span,
        windowMs,
      }
    },

    /** Forget everything (used when the session on screen changes). */
    reset() {
      history = []
    },
  }
}

/**
 * Wire the HUD into the running host.
 * @param ctx - the plugin's Cordis context.
 * @param config - resolved plugin config (see {@link DEFAULTS}).
 */
export function apply(ctx, config) {
  let cfg = { ...DEFAULTS, ...(config ?? {}) }

  /**
   * Persisted user preferences, as written by the settings form in the Plugins
   * page. Kept in the user's own dsh directory rather than in the profile patch,
   * so the plugin can save a preference without rewriting YAML the app owns.
   */
  const SETTINGS_FILE =
    process.env.DSH_SOULS_HUD_SETTINGS || join(homedir(), '.dsh', 'souls-hud.json')

  /**
   * The settings files this plugin wrote under its previous names, newest first.
   * Read as a courtesy so an existing user keeps their caps across a rename;
   * never written.
   */
  const LEGACY_SETTINGS_FILES = (
    process.env.DSH_SOULS_HUD_LEGACY_SETTINGS
      ? [process.env.DSH_SOULS_HUD_LEGACY_SETTINGS]
      : [
          join(homedir(), '.dsh', 'builder-hud.json'),
          join(homedir(), '.dsh', 'dark-souls-hud.json'),
        ]
  )

  /** The uploaded medallion device, kept as a file of its own. */
  const DEVICE_FILE =
    process.env.DSH_SOULS_HUD_DEVICE || join(homedir(), '.dsh', 'souls-hud-device.svg')

  /**
   * Coerce a CNY bar cap: a positive amount, rounded to fen, capped at ¥100000.
   * @param value - the client-supplied value.
   * @returns the clean amount, or undefined when it is not a usable cap.
   */
  function cnyTarget(value) {
    const amount = Number(value)
    if (!Number.isFinite(amount) || amount <= 0) return undefined
    return Math.min(100000, Math.round(amount * 100) / 100)
  }

  /**
   * The keys a settings write may carry, each with its own coercion. Anything
   * else is refused rather than stored, so the file cannot accumulate junk.
   */
  const SETTING_RULES = {
    hpTargetCny: cnyTarget,
    fpTargetCny: cnyTarget,
    numbers(value) {
      return value === 'always' || value === 'hover' || value === 'hidden' ? value : undefined
    },
    staminaMode(value) {
      return value === 'remaining' || value === 'used' ? value : undefined
    },
    device(value) {
      return DEVICES.includes(value) ? value : undefined
    },
    shape(value) {
      return SHAPES.includes(value) ? value : undefined
    },
    burnFullScaleTpm(value) {
      const amount = Number(value)
      if (!Number.isFinite(amount) || amount <= 0) return undefined
      return Math.min(10000000, Math.round(amount))
    },
    tariffPeakWindows(value) {
      if (!Array.isArray(value)) return undefined
      const windows = []
      for (const entry of value.slice(0, 4)) {
        const start = entry && parseClock(entry.start)
        const end = entry && parseClock(entry.end)
        if (start === null || end === null || start === end) continue
        windows.push({ start: String(entry.start).trim(), end: String(entry.end).trim() })
      }
      return windows.length > 0 ? windows : undefined
    },
    tariffPeakWeekdays(value) {
      if (!Array.isArray(value)) return undefined
      const days = [...new Set(value.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
      return days.length > 0 ? days.sort((a, b) => a - b) : undefined
    },
    tariffHolidayMode(value) {
      return value === 'cn' || value === 'custom' || value === 'none' ? value : undefined
    },
    tariffCustomHolidays(value) {
      return dateList(value)
    },
    tariffCustomWorkdays(value) {
      return dateList(value)
    },
    tariffMakeupWorkdays(value) {
      return typeof value === 'boolean' ? value : undefined
    },
    tariffAutoRefresh(value) {
      return typeof value === 'boolean' ? value : undefined
    },
    tariffEnabled(value) {
      return typeof value === 'boolean' ? value : undefined
    },
    material(value) {
      return MATERIALS.includes(value) ? value : undefined
    },
  }

  /**
   * Read one JSON object, or `{}` for anything unreadable.
   * @param file - absolute path.
   * @returns the parsed object.
   */
  function readJsonObject(file) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  /** The user's saved preferences; an unreadable file simply means none. */
  function readOverrides() {
    const own = readJsonObject(SETTINGS_FILE)
    if (Object.keys(own).length > 0) return own
    // Nothing saved under the current name yet: adopt the newest pre-rename file
    // that has something in it.
    for (const file of LEGACY_SETTINGS_FILES) {
      const legacy = readJsonObject(file)
      if (Object.keys(legacy).length > 0) return legacy
    }
    return {}
  }

  /**
   * Recompute the effective configuration: defaults, then the profile or bundle
   * patch, then the user's saved preferences — the newest intent wins.
   */
  function refreshCfg() {
    cfg = { ...DEFAULTS, ...(config ?? {}), ...readOverrides() }
  }

  /** Merge a partial settings write, persist it, and report what was refused. */
  function saveOverrides(patch) {
    const next = { ...readOverrides() }
    const refused = []
    for (const key of Object.keys(patch ?? {})) {
      const rule = SETTING_RULES[key]
      const clean = rule === undefined ? undefined : rule(patch[key])
      if (clean === undefined) {
        refused.push(key)
        continue
      }
      next[key] = clean
    }
    const tmp = SETTINGS_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
    renameSync(tmp, SETTINGS_FILE)
    refreshCfg()
    // The bars are scaled by the cap, and the balance behind them is cached for
    // a minute. Without this a saved cap would look like it did nothing.
    balanceCache.value = null
    balanceCache.at = 0
    return { overrides: next, refused }
  }

  /** What is known about the uploaded device without reading its bytes. */
  function customDeviceInfo() {
    try {
      const info = statSync(DEVICE_FILE)
      if (!info.isFile()) return { present: false }
      return { present: true, bytes: info.size, updatedAt: Math.round(info.mtimeMs) }
    } catch {
      return { present: false }
    }
  }

  const web = ctx.get('webServer')
  if (!web) return

  /** Last successful balance read, kept for the cache and as a stale fallback. */
  let balanceCache = { at: 0, value: null }

  /** Last self-report posted by the browser renderer, or null if it never ran. */
  let lastReport = null

  /** Token-rate meter for the session the browser last named. */
  const burn = createBurnTracker({ windowMs: cfg.burnWindowMs })
  /** The session the meter is currently measuring, so a switch can reset it. */
  let lastBurnSessionId = null
  /**
   * The session the browser last said it was showing, and `null` until it says.
   *
   * Only requests that carry `?session=` may change this. Treating a bare poll as
   * "no session" made the burn meter fall back to the host's guess, whose idea of
   * "the newest session" moves — so every `curl` of the state route restarted the
   * measurement window and the gauge never left "warming up".
   */
  let lastShownSessionId = null
  /** When the meter last took a sample, so a poll and the timer cannot double up. */
  let lastBurnSampleAt = 0

  /**
   * Resolve the live session the HUD should describe when the browser has not
   * named one — the blank-session hero, or a client half that never reported.
   * @returns the newest root session, or undefined.
   */
  function currentSession() {
    const agents = ctx.get('agents')
    const sessions = ctx.get('sessions')
    if (!sessions || typeof sessions.get !== 'function') return undefined
    const roots = agents && typeof agents.roots === 'function' ? agents.roots() : []
    let best
    let bestTime = -1
    for (const agent of roots) {
      const session = sessions.get(agent.id)
      if (!session) continue
      const time = lastEventTime(session)
      if (time > bestTime) {
        bestTime = time
        best = session
      }
    }
    if (best) return best
    // Fallback: no live root agent (headless or freshly booted) — take any session.
    const all = typeof sessions.list === 'function' ? sessions.list() : []
    return Array.isArray(all) && all.length > 0 ? all[all.length - 1] : undefined
  }

  /**
   * Read the Platform wallet balances.
   * @returns a HUD-ready balance block.
   */
  async function readBalance() {
    const account = ctx.get('deepseekAccount')
    if (!account || typeof account.getBalance !== 'function') {
      return { available: false, reason: 'account-service-unavailable' }
    }
    const now = Date.now()
    if (balanceCache.value && now - balanceCache.at < cfg.balanceCacheMs) {
      return { ...balanceCache.value, cached: true }
    }
    const metadata = {
      version: String(cfg.version),
      locale: String(cfg.locale),
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    }
    try {
      const details = await account.getBalance(metadata)
      if (!details) {
        return { available: false, reason: 'signed-out' }
      }
      if (details.status !== 'ready') {
        return { available: false, reason: 'query-failed' }
      }
      const currency = pickCurrency(details.value)
      const recharge = sumWallets(details.value, currency) ?? 0
      const bonus = sumWallets(details.bonusWallets, currency) ?? 0
      // Each bar has its own cap: the two wallets are spent in different ways, so
      // "topped up" and "granted" do not deserve the same 100% mark.
      const hpTarget = cnyTarget(cfg.hpTargetCny) ?? DEFAULTS.hpTargetCny
      const fpTarget = cnyTarget(cfg.fpTargetCny) ?? DEFAULTS.fpTargetCny
      const value = {
        available: true,
        currency,
        recharge,
        bonus,
        target: hpTarget,
        fpTarget,
        hpRatio: clamp01(recharge / hpTarget),
        fpRatio: clamp01(bonus / fpTarget),
        at: now,
      }
      balanceCache = { at: now, value }
      return value
    } catch (error) {
      if (balanceCache.value) {
        return { ...balanceCache.value, cached: true, stale: true, error: String(error?.message ?? error) }
      }
      return { available: false, reason: 'query-threw', error: String(error?.message ?? error) }
    }
  }

  /**
   * Read context-window occupancy for one session.
   * @param session - live `Session`.
   * @returns a HUD-ready context block.
   */
  function readContext(session) {
    if (!session) return { available: false, reason: 'no-session' }
    let used
    let total
    const projections = ctx.get('sessionProjections')
    if (projections && typeof projections.snapshot === 'function') {
      try {
        const snapshot = projections.snapshot(session, [PRESSURE_KEY])
        const pressure = snapshot?.values?.[PRESSURE_KEY]
        if (pressure) {
          used = pressure.projectedTokens ?? pressure.pressureTokens
          total = pressure.contextWindow
        }
      } catch {
        // Projection unavailable for this log shape — fall through to the meter.
      }
    }
    if (!Number.isFinite(used) || !Number.isFinite(total)) {
      const meter = ctx.get('tokenMeter')
      if (meter && typeof meter.measure === 'function') {
        try {
          const measurement = meter.measure(session)
          if (!Number.isFinite(used)) used = measurement.totalTokens
        } catch {
          // keep whatever we have
        }
      }
      if (!Number.isFinite(total)) {
        try {
          total = session.requestContext()?.contextWindow
        } catch {
          // keep whatever we have
        }
      }
    }
    let model
    let provider
    try {
      const request = session.requestContext()
      model = request?.model
      provider = request?.provider
    } catch {
      // optional metadata only
    }
    const known = Number.isFinite(used) && Number.isFinite(total) && total > 0
    const occupancyPercent = known ? Math.min(100, Math.round((used / total) * 100)) : null
    return {
      available: known,
      used: known ? used : null,
      total: known ? total : null,
      /** Occupancy: how much of the window is spent. */
      percent: occupancyPercent,
      ratio: known ? clamp01(used / total) : 0,
      /**
       * The same measurement seen from the other side. The HUD's stamina bar is
       * a pool of stamina, so it has to read as what is LEFT: a full bar means
       * the whole context window is still available, which matches the HP bar's
       * "balance remaining" instead of fighting it.
       */
      freePercent: known ? 100 - occupancyPercent : null,
      freeRatio: known ? clamp01(1 - used / total) : 0,
      model: model ?? null,
      provider: provider ?? null,
      reason: known ? undefined : 'context-unknown',
    }
  }

  /**
   * Read the session's cumulative token totals.
   *
   * `tokenUsage` is the projection `@deepseek-ai/dsh-token-meter` keeps: four
   * buckets of *ledger* totals for the session, which only ever grow (a
   * compaction rewrites the context, not the bill). That monotonicity is what
   * makes a difference over time a rate.
   *
   * @param session - live `Session`.
   * @returns the counters, or null when the projection is not there.
   */
  function readTokenTotals(session) {
    if (!session) return null
    const projections = ctx.get('sessionProjections')
    if (!projections || typeof projections.snapshot !== 'function') return null
    try {
      const snapshot = projections.snapshot(session, ['tokenUsage'])
      const usage = snapshot?.values?.tokenUsage
      if (!usage) return null
      const uncached = Number(usage.uncachedInputTokens) || 0
      const output = Number(usage.outputTokens) || 0
      const cache = (Number(usage.cacheReadTokens) || 0) + (Number(usage.cacheWriteTokens) || 0)
      return {
        /**
         * The tokens that were actually processed afresh: input that missed the
         * cache plus everything generated. Cache reads are deliberately not
         * "new" — they are the same context read again, and counting them made
         * one real session look like 186M tokens/minute.
         */
        newTokens: uncached + output,
        outputTokens: output,
        cacheTokens: cache,
        totalTokens: uncached + output + cache,
      }
    } catch {
      return null
    }
  }

  /**
   * Resolve the session the badge describes and record one token sample.
   *
   * Called both on the sampler's own timer (so the rate is responsive without
   * waiting for a 15s poll) and on every `/state.json`, so the first poll after
   * a mount already has a reading to hand.
   *
   * @param at - epoch ms of the sample.
   * @returns whether a sample was taken.
   */
  function sampleBurn(at) {
    // The browser's hint is only a hint: without one (a `curl`, a monitor, a
    // page that has not reported yet) the meter keeps measuring the session the
    // browser last named rather than falling back to the host's guess, which
    // would flip between sessions and restart the window on every foreign poll.
    const hint = lastShownSessionId
    const sessions = ctx.get('sessions')
    const session =
      hint !== null && sessions && typeof sessions.get === 'function'
        ? sessions.get(hint)
        : currentSession()
    // Compare the *resolved* session, not the hint: a hint that names a session
    // which is not live resolves to nothing, and that is a change too. This runs
    // before the debounce below, because a different session's reading is wrong
    // the moment it changes — and the debounce is cleared so the new session's
    // first sample is not swallowed.
    const sessionId = session?.id ?? null
    if (sessionId !== lastBurnSessionId) {
      burn.reset()
      lastBurnSessionId = sessionId
      lastBurnSampleAt = 0
    }
    if (at - lastBurnSampleAt < 250) return false
    const counters = readTokenTotals(session)
    if (!counters) return false
    lastBurnSampleAt = at
    burn.sample(counters, at)
    return true
  }

  /** The burn and tariff blocks `/state.json` carries. */
  function burnState(at) {
    const reading = burn.reading(at)
    const fullScale = Math.max(1, Number(cfg.burnFullScaleTpm) || DEFAULTS.burnFullScaleTpm)
    const ratio = reading.available ? clamp01(reading.tokensPerMin / fullScale) : 0
    return {
      ...reading,
      /** 0 idle … 4 roaring; the ratio is what the gauge draws. */
      level: ratio === 0 ? 0 : Math.max(1, Math.ceil(ratio * 4)),
      ratio,
      fullScaleTpm: fullScale,
      /** What the rate is made of, so the number in the form is explainable. */
      metric: 'new-tokens-per-minute',
    }
  }

  /**
   * The tariff rule in effect, with a configuration written by an older version
   * carried over.
   *
   * The old shape described the *off-peak* window (16:30–00:30 UTC) and a weekend
   * rule; that is the same rule read the other way round, so the complement is used
   * as the peak window rather than silently replacing what the user had.
   */
  function tariffConfig() {
    const migrated = migrateOffPeak(cfg)
    return {
      ...cfg,
      tariffPeakWindows: migrated || cfg.tariffPeakWindows,
      tariffPeakWeekdays: cfg.tariffPeakWeekdays,
    }
  }

  /**
   * Refresh the calendar if it is due, and say what happened.
   *
   * Called on a timer rather than by a person. It never throws and never blocks
   * anything: a failure leaves the existing calendar in place and is reported in
   * the status, because the tariff rule must keep working offline.
   *
   * @param options - `{ force, reason }`.
   * @returns `{ ok, fetched, reason, status }`.
   */
  async function refreshCalendarIfDue(options = {}) {
    const status = holidayStatus()
    const now = Date.now()
    const due = holidayRefreshDue({
      checkedAt: status.checkedAt || (holidayAttempt.at ? new Date(holidayAttempt.at).toISOString() : null),
      generatedAt: status.generated,
      years: status.years,
      now,
    })
    if (!options.force && !due.due) return { ok: false, fetched: [], reason: due.reason, status }
    holidayAttempt = { at: now, error: null, ok: false }
    const result = await refreshHolidays({ at: now })
    if (result.fetched.length === 0) {
      const error = result.failed.map((item) => `${item.year}: ${item.error}`).join(', ') || 'no years fetched'
      holidayAttempt = { at: now, error, ok: false }
      // A failed attempt still moves `checkedAt`, so the retry waits instead of
      // hammering — and the calendar itself is untouched.
      const merged = mergeHolidays(holidays.payload, { years: {} }, now, { ok: false })
      holidays = { payload: merged, index: indexHolidays(merged) }
      return { ok: false, fetched: [], reason: 'upstream-unreachable', status: holidayStatus() }
    }
    const merged = mergeHolidays(holidays.payload, result.payload, now)
    try {
      writeFileSync(holidayCachePath(), JSON.stringify(merged, null, 2) + '\n')
    } catch {
      // A cache that cannot be written still leaves this process refreshed.
    }
    holidays = { payload: merged, index: indexHolidays(merged) }
    holidayAttempt = { at: now, error: null, ok: true }
    return { ok: true, fetched: result.fetched, reason: options.reason || 'manual', status: holidayStatus() }
  }

  /** What the holiday calendar covers, for the form to show and act on. */
  function holidayStatus() {
    const index = holidays.index
    const coverage = holidayCoverage(index, Date.now())
    return {
      source: index.source,
      generated: index.generated,
      years: index.years,
      papers: index.papers,
      offDays: index.off.size,
      workdays: index.work.size,
      // What the freshness is judged on: the last upstream attempt, or — before
      // there has ever been one — when the bundled data was built. "Never looked"
      // is not a useful thing to print when the bundle itself has a date.
      checkedAt: holidayAttempt.at
        ? new Date(holidayAttempt.at).toISOString()
        : index.checkedAt || index.generated,
      current: coverage.current,
      covered: coverage.covered,
      stale: coverage.stale,
      /** Whether the plugin keeps this data current by itself. */
      auto: cfg.tariffAutoRefresh !== false,
      lastError: holidayAttempt.error,
      nextDueAt: holidayRefreshDue({
        // What the freshness is judged on: the last upstream attempt, or — before
      // there has ever been one — when the bundled data was built. "Never looked"
      // is not a useful thing to print when the bundle itself has a date.
      checkedAt: holidayAttempt.at
        ? new Date(holidayAttempt.at).toISOString()
        : index.checkedAt || index.generated,
        generatedAt: index.generated,
        years: index.years,
        now: Date.now(),
      }).nextDueAt,
    }
  }

  /** Serialize the client-facing HUD configuration. */
  function clientConfig() {
    return {
      // The settings form shows and edits these, so they travel with the rest.
      hpTargetCny: cnyTarget(cfg.hpTargetCny) ?? DEFAULTS.hpTargetCny,
      fpTargetCny: cnyTarget(cfg.fpTargetCny) ?? DEFAULTS.fpTargetCny,
      pollMs: Math.max(1000, Number(cfg.pollMs) || DEFAULTS.pollMs),
      barWidth: Math.max(80, Number(cfg.barWidth) || DEFAULTS.barWidth),
      scale: Number(cfg.scale) || 1,
      anchor:
        cfg.anchor === 'frame' || cfg.anchor === 'chat' ? cfg.anchor : 'sidebar',
      gapX: Number.isFinite(Number(cfg.gapX)) ? Number(cfg.gapX) : DEFAULTS.gapX,
      gapY: Number.isFinite(Number(cfg.gapY)) ? Number(cfg.gapY) : DEFAULTS.gapY,
      offsetX: Number.isFinite(Number(cfg.offsetX)) ? Number(cfg.offsetX) : DEFAULTS.offsetX,
      offsetY: Number.isFinite(Number(cfg.offsetY)) ? Number(cfg.offsetY) : DEFAULTS.offsetY,
      showText: cfg.showText !== false,
      numbers:
        cfg.numbers === 'hover' || cfg.numbers === 'hidden' ? cfg.numbers : 'always',
      staminaMode: cfg.staminaMode === 'used' ? 'used' : 'remaining',
      // Customization: what the medallion is struck with, from what metal, and
      // cut to which silhouette.
      device: DEVICES.includes(cfg.device) ? cfg.device : DEFAULTS.device,
      material: MATERIALS.includes(cfg.material) ? cfg.material : DEFAULTS.material,
      shape: SHAPES.includes(cfg.shape) ? cfg.shape : DEFAULTS.shape,
      // The burn gauge's full scale is the one number the user has to calibrate:
      // it is a rate, and what counts as "busy" depends on how they work.
      burnFullScaleTpm: Math.max(1, Number(cfg.burnFullScaleTpm) || DEFAULTS.burnFullScaleTpm),
      burnWindowMs: Math.max(3000, Number(cfg.burnWindowMs) || DEFAULTS.burnWindowMs),
      // The form shows and edits the tariff rule, so the *rule* travels too; the
      // per-instant reading depends on the clock and lives in state.
      tariffPeakWindows: tariffConfig().tariffPeakWindows,
      tariffPeakWeekdays: tariffConfig().tariffPeakWeekdays,
      tariffHolidayMode: tariffConfig().tariffHolidayMode,
      tariffCustomHolidays: tariffConfig().tariffCustomHolidays,
      tariffCustomWorkdays: tariffConfig().tariffCustomWorkdays,
      tariffMakeupWorkdays: cfg.tariffMakeupWorkdays === true,
      tariffAutoRefresh: cfg.tariffAutoRefresh !== false,
      tariffEnabled: cfg.tariffEnabled !== false,
      /** Where the holiday calendar came from, and whether it still covers "now". */
      holidays: holidayStatus(),
      // Whether an uploaded device exists at all — the form's upload field and
      // the renderer's `custom` fallback both need to know.
      customDevice: customDeviceInfo(),
      idleDimMs: Math.max(0, Number(cfg.idleDimMs) || 0),
      criticalPercent: Number(cfg.criticalPercent) || DEFAULTS.criticalPercent,
    }
  }

  /**
   * Sample the session's token ledger on a short timer.
   *
   * The data route is 15 seconds apart, which is too coarse for "how fast is it
   * burning *now*": the gauge would step rather than move. So the host keeps its
   * own 3-second sampler — it is one projection read, and the projection is a
   * fold that is already maintained incrementally.
   *
   * The timer is `unref`'d where the runtime allows it, so a host half mounted
   * inside a test or a short-lived process cannot keep Node alive on its own.
   */
  ctx.effect(() => {
    const every = Math.max(0, Number(cfg.burnSampleMs) || 0)
    if (every === 0) return () => {}
    const timer = setInterval(() => {
      try {
        refreshCfg()
        sampleBurn(Date.now())
      } catch {
        // A sampling failure must never take the HUD down with it.
      }
    }, every)
    if (timer && typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  })

  // --- routes -----------------------------------------------------------------

  ctx.effect(() =>
    web.register({
      kind: 'exact',
      path: `${BASE}/state.json`,
      handler: async (req, res) => {
        refreshCfg()
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        // The browser knows which session is on screen; the host does not. When
        // it names one, that is the answer — never a guess at a different
        // session, because a wrong lookup is worse here than an honest blank.
        const requested = requestedSessionId(req)
        const live = requested === undefined ? undefined : ctx.get('sessions')?.get(requested)
        const session = requested === undefined ? currentSession() : live
        const now = Date.now()
        // The browser is the only side that knows which session is on screen, so
        // it names it on every poll and the sampler follows that name.
        // Only a request that *names* a session may change the hint; a bare poll
        // must not erase what the browser last said.
        if (requested !== undefined) lastShownSessionId = requested
        sampleBurn(now)
        const [balance] = await Promise.all([readBalance()])
        sendJson(res, 200, {
          ok: true,
          now,
          balance,
          context: readContext(session),
          session: {
            id: session?.id ?? null,
            requested: requested ?? null,
            source: requested === undefined ? 'host-guess' : live ? 'browser' : 'requested-not-live',
          },
          burn: burnState(now),
          tariff: tariffAt(now, cfg),
          config: clientConfig(),
        })
      },
    }),
  )

  ctx.effect(() =>
    web.register({
      kind: 'exact',
      path: `${BASE}/hud.js`,
      handler: (_req, res) => sendAsset(res, 'text/javascript', asset('hud.js')),
    }),
  )

  ctx.effect(() =>
    web.register({
      kind: 'exact',
      path: `${BASE}/hud.css`,
      handler: (_req, res) => sendAsset(res, 'text/css', asset('hud.css')),
    }),
  )

  /**
   * The donation QR codes, if the author shipped any.
   *
   * A `prefix` route rather than one `exact` route per file, because which files
   * exist is the *client* half's configuration (`SUPPORT.channels[].file`) and the
   * host has no business keeping a second copy of that list. A missing file is a
   * 404, which is what an unconfigured channel asks for anyway.
   *
   * **No trailing slash.** The server matches a prefix route with
   * `pathname === prefix || pathname.startsWith(prefix + '/')`, so a prefix
   * declared as `/x/support/` can only ever match `/x/support//…` — which no
   * request has. That trailing slash meant a 404 for every image until it was
   * found; `test/harness.mjs` now resolves routes through a copy of that matcher
   * instead of calling the handler directly, which is the check that would have
   * caught it.
   */
  ctx.effect(() =>
    web.register({
      kind: 'prefix',
      path: `${BASE}/support`,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405
          res.end()
          return
        }
        sendSupport(res, supportName(req))
      },
    }),
  )

  /**
   * The Chinese holiday calendar: read it, or refresh it from upstream.
   *
   * `POST` is deliberate — it is the only route that reaches the network, and it
   * only runs when the settings page asks. A refresh that cannot reach upstream
   * leaves the calendar alone and says why, because replacing a good calendar with
   * an empty one would silently make every holiday a working day.
   */
  ctx.effect(() =>
    web.register({
      kind: 'exact',
      path: `${BASE}/holidays.json`,
      handler: async (req, res) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
          sendJson(res, 200, { ok: true, status: holidayStatus(), years: holidays.payload.years })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, reason: 'method-not-allowed' })
          return
        }
        const result = await refreshCalendarIfDue({ force: true, reason: 'manual' })
        sendJson(res, 200, result)
      },
    }),
  )

  /**
   * The uploaded device: read it, replace it, or remove it.
   *
   * `GET` is what the renderer fetches when `device: 'custom'` (404 means "no
   * custom device", which is not an error — it falls back to the built-in mark).
   * `POST` accepts `{ svg }` or a raw `image/svg+xml` body so `curl -T` works,
   * runs it past {@link scrubDeviceSvg} and stores it atomically. `DELETE`
   * removes it and leaves the preference alone; the form switches the setting
   * back to a built-in device itself.
   */
  ctx.effect(() =>
    web.register({
      kind: 'exact',
      path: `${BASE}/device.svg`,
      handler: (req, res) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
          try {
            sendAsset(res, 'image/svg+xml', readFileSync(DEVICE_FILE, 'utf8'))
          } catch {
            sendJson(res, 404, { ok: false, reason: 'no-custom-device' })
          }
          return
        }
        if (req.method === 'DELETE') {
          try {
            rmSync(DEVICE_FILE, { force: true })
          } catch {
            // removing an absent file is the same outcome as removing one
          }
          sendJson(res, 200, { ok: true, customDevice: customDeviceInfo() })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        let body = ''
        let tooLarge = false
        req.on('data', (chunk) => {
          if (body.length > DEVICE_LIMIT_BYTES * 4) {
            tooLarge = true
            return
          }
          body += chunk
        })
        req.on('end', () => {
          if (tooLarge) {
            sendJson(res, 413, { ok: false, reason: 'too-large' })
            return
          }
          let candidate = body
          const trimmed = body.trim()
          if (trimmed.startsWith('{')) {
            try {
              const parsed = JSON.parse(trimmed)
              candidate = typeof parsed?.svg === 'string' ? parsed.svg : ''
            } catch {
              sendJson(res, 400, { ok: false, reason: 'invalid-json' })
              return
            }
          }
          const scrubbed = scrubDeviceSvg(candidate)
          if (!scrubbed.ok) {
            sendJson(res, 400, { ok: false, reason: scrubbed.reason })
            return
          }
          const tmp = DEVICE_FILE + '.tmp'
          try {
            writeFileSync(tmp, scrubbed.svg)
            renameSync(tmp, DEVICE_FILE)
          } catch (error) {
            sendJson(res, 500, { ok: false, reason: 'write-failed', error: String(error?.message ?? error) })
            return
          }
          sendJson(res, 200, {
            ok: true,
            bytes: Buffer.byteLength(scrubbed.svg),
            customDevice: customDeviceInfo(),
          })
        })
      },
    }),
  )

  /**
   * Self-check: prove the running host really renders our tags into index.html.
   * `webServer.renderIndex` is the exact function the SPA fallback calls, so a
   * probe through it is the same pipeline the browser gets. Leaks nothing.
   */
  ctx.effect(() =>
    web.register({
      kind: 'exact',
      path: `${BASE}/health`,
      handler: (_req, res) => {
        let rendered = ''
        let error
        try {
          rendered = web.renderIndex('<html><head></head><body></body></html>')
        } catch (caught) {
          error = String(caught?.message ?? caught)
        }
        sendJson(res, 200, {
          ok: error === undefined,
          plugin: name,
          error,
          injection: {
            script: rendered.includes(`${BASE}/hud.js`),
            style: rendered.includes(`${BASE}/hud.css`),
          },
          // What the browser last told us about its own DOM. `null` means the
          // renderer has never reported, which is itself the answer to "did the
          // injected script actually execute?".
          client: lastReport,
        })
      },
    }),
  )

  /**
   * Receive the renderer's self-report. The browser half sends its resolved
   * position, the rect it actually occupies, and what sits on top at that
   * point — the three things I cannot see from the host.
   */
  ctx.effect(() =>
    web.register({
      kind: 'exact',
      path: `${BASE}/beacon`,
      handler: (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false })
          return
        }
        let body = ''
        req.on('data', (chunk) => {
          if (body.length < 8192) body += chunk
        })
        req.on('end', () => {
          let parsed
          try {
            parsed = JSON.parse(body)
          } catch {
            parsed = { unparsed: body.slice(0, 400) }
          }
          lastReport = { receivedAt: Date.now(), ...parsed }
          sendJson(res, 200, { ok: true })
        })
      },
    }),
  )

  /**
   * The settings form's read/write endpoint.
   *
   * `GET` answers both the effective configuration and the user's own saved
   * preferences, so the form can show what is set and what is default. `POST`
   * merges a partial write into those preferences.
   */
  ctx.effect(() =>
    web.register({
      kind: 'exact',
      path: `${BASE}/config`,
      handler: (req, res) => {
        if (req.method === 'GET') {
          refreshCfg()
          sendJson(res, 200, { config: clientConfig(), overrides: readOverrides() })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false })
          return
        }
        let body = ''
        req.on('data', (chunk) => {
          if (body.length < 8192) body += chunk
        })
        req.on('end', () => {
          let parsed
          try {
            parsed = JSON.parse(body)
          } catch {
            sendJson(res, 400, { ok: false, reason: 'invalid-json' })
            return
          }
          const saved = saveOverrides(parsed)
          sendJson(res, 200, { ok: true, config: clientConfig(), ...saved })
        })
      },
    }),
  )

  /**
   * Keep the calendar current on its own.
   *
   * An hourly tick, plus a check shortly after start. The decision is pure
   * (`holidayRefreshDue`) and the tick is cheap: almost every hour it decides
   * "fresh" and does nothing at all. It only reaches the network when the calendar
   * has aged past a month, or when it no longer covers the current and next year —
   * and a failed attempt waits six hours before trying again, so an offline machine
   * neither hammers the network nor loses the calendar it has.
   */
  ctx.effect(() => {
    const check = () => {
      if (cfg.tariffAutoRefresh === false) return
      refreshCalendarIfDue({ reason: 'auto' }).catch(() => {});
    };
    const startup = setTimeout(check, 15000);
    const tick = setInterval(check, 60 * 60 * 1000);
    // `unref`: this is housekeeping, not work. A pending timer that keeps the host
    // process alive would make every shutdown wait an hour — and it hung the test
    // harness, which is how it was noticed.
    if (typeof startup.unref === 'function') startup.unref();
    if (typeof tick.unref === 'function') tick.unref();
    return () => {
      clearTimeout(startup);
      clearInterval(tick);
    };
  });

  // --- index injection --------------------------------------------------------

  ctx.effect(() =>
    web.tapIndex((html) => {
      const tags =
        `<link rel="stylesheet" href="${BASE}/hud.css">` +
        `<script defer src="${BASE}/hud.js"></script>`
      if (html.includes(`${BASE}/hud.js`)) return html
      // Target the LAST `</body>`: an inline script or a template in the head
      // could contain that literal, and landing inside it would silently break
      // the injection.
      const matches = [...html.matchAll(/<\/body\s*>/gi)]
      const closing = matches.length > 0 ? matches[matches.length - 1].index : -1
      if (closing === -1) return `${html}${tags}`
      return `${html.slice(0, closing)}${tags}${html.slice(closing)}`
    }),
  )

  ctx.logger?.info?.('souls-hud: serving the HUD under %s', BASE)
}
