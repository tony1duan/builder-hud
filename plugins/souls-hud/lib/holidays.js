/**
 * Chinese statutory holidays, and the make-up workdays that go with them.
 *
 * The tariff rule names Chinese public holidays, so the plugin has to know them —
 * and knowing them is not as simple as a list of dates. A Chinese holiday calendar
 * has two kinds of day that both land on a date a naive weekday test gets wrong:
 *
 * - **公休 (off days)**: the holiday itself, which often runs across a weekend.
 * - **调休 (make-up workdays)**: a Saturday or Sunday the State Council declares a
 *   working day, to pay for a long holiday. DeepSeek's published rule is
 *   weekday-based, so these are *not* peak by default — but they are exactly the
 *   days a user means when they say "follow the Chinese working calendar", so the
 *   data carries them and a setting can honour them.
 *
 * The data comes from `holiday-cn` (MIT), which is generated daily from the
 * 国务院办公厅 announcements and pins the announcement URL per year. That file is
 * bundled so the plugin works offline; {@link refreshHolidays} pulls a newer one.
 *
 * Dates are **Asia/Shanghai calendar dates**: a holiday is a local day, so an
 * instant at 2026-09-30T20:00Z is already October 1st in China and is a holiday,
 * even though its UTC date still says September. The tariff windows themselves are
 * UTC, which is why the two zones are handled separately rather than assumed equal.
 *
 * Pure: no I/O beyond the injected reader, so the whole rule can be tested on a
 * fake clock and a fake calendar.
 */

/** Where the bundled data and any refresh come from. */
export const HOLIDAY_SOURCE = 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master'

/** The browser's own idea of China, for turning an instant into a local date. */
const CN_TIME_ZONE = 'Asia/Shanghai'

/**
 * The Shanghai calendar date of an instant, as `YYYY-MM-DD`.
 *
 * `Intl` with an explicit time zone, not `toISOString`: the UTC date is wrong for
 * every Chinese evening, which is exactly when holidays start.
 *
 * @param at - epoch ms, or a Date.
 * @returns the local date key.
 */
export function shanghaiDate(at) {
  const date = at instanceof Date ? at : new Date(Number(at))
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CN_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
  return parts
}

/**
 * The Chinese calendar day of an instant: its date and its weekday.
 *
 * The weekday comes from the *local* date rather than from `getUTCDay()`, because
 * "Monday to Friday" and "a Chinese public holiday" have to be judged in the same
 * calendar or they disagree about which day it is. Inside DeepSeek's published
 * windows the two happen to agree (01:00–10:00 UTC is 09:00–18:00 in China, the
 * same date), which is exactly why the difference is easy to miss and shows up
 * only once someone configures a window of their own.
 *
 * @param at - epoch ms.
 * @returns `{ date, year, month, day, weekday }` — weekday is `Date.getUTCDay()`
 *   numbering (0 = Sunday) applied to the Chinese date.
 */
export function chinaDay(at) {
  const date = shanghaiDate(at)
  const [year, month, day] = date.split('-').map(Number)
  return { date, year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() }
}

/**
 * Normalize the holiday payload into a lookup.
 *
 * Accepts the bundled shape and the upstream `holiday-cn` shape, because a refresh
 * writes what upstream sent and the two must not disagree about what a day means.
 *
 * @param payload - parsed JSON, either shape.
 * @returns `{ off: Map<date, name>, work: Map<date, name>, years, papers, generated, source }`.
 */
export function indexHolidays(payload) {
  const off = new Map()
  const work = new Map()
  const papers = []
  const years = []
  const data = payload && typeof payload === 'object' ? payload : {}
  const buckets = data.years
    ? Object.keys(data.years).map((year) => ({ year: Number(year), bucket: data.years[year] }))
    : [{ year: Number(data.year) || 0, bucket: data }]
  for (const { year, bucket } of buckets) {
    if (!bucket || !Array.isArray(bucket.days)) continue
    years.push(year)
    for (const paper of bucket.papers || []) if (!papers.includes(paper)) papers.push(paper)
    for (const day of bucket.days) {
      if (!day || typeof day.date !== 'string') continue
      const isOff = day.off !== undefined ? Boolean(day.off) : Boolean(day.isOffDay)
      const target = isOff ? off : work
      target.set(day.date, day.name || '')
    }
  }
  years.sort((a, b) => a - b)
  return {
    off,
    work,
    years,
    papers,
    generated: typeof data.generated === 'string' ? data.generated : null,
    /** When upstream was last *attempted*, successful or not. */
    checkedAt: typeof data.checkedAt === 'string' ? data.checkedAt : null,
    source: typeof data.source === 'string' ? data.source : HOLIDAY_SOURCE,
  }
}

/**
 * What the calendar says about one instant.
 *
 * @param holidays - an {@link indexHolidays} result, or null when holidays are off.
 * @param at - epoch ms.
 * @param useMakeupWorkdays - whether 调休 workdays count as working days.
 * @returns `{ date, holiday, name, makeup, working }` — `holiday` true means the
 *   calendar says the day is off, `makeup` true means it says the day is a
 *   make-up workday.
 */
export function holidayAt(holidays, at, useMakeupWorkdays = false) {
  const date = shanghaiDate(at)
  if (!holidays) return { date, holiday: false, name: '', makeup: false, working: false }
  const offName = holidays.off.get(date)
  const workName = holidays.work.get(date)
  return {
    date,
    holiday: offName !== undefined,
    name: offName !== undefined ? offName : '',
    makeup: workName !== undefined,
    working: Boolean(useMakeupWorkdays) && workName !== undefined,
  }
}

/**
 * The years the bundled data covers, and whether they still cover "now".
 *
 * A stale calendar is worse than none: it would call a holiday a working day. The
 * settings page shows this rather than deciding silently.
 *
 * @param holidays - an {@link indexHolidays} result.
 * @param at - epoch ms.
 * @returns `{ current, next, covered, stale }`.
 */
export function holidayCoverage(holidays, at) {
  const year = new Date(Number(at)).getUTCFullYear()
  const years = holidays ? holidays.years : []
  return {
    current: year,
    next: year + 1,
    covered: years.includes(year),
    stale: !years.includes(year) || !years.includes(year + 1),
  }
}

/**
 * The ordinary cadence: a month.
 *
 * The State Council publishes the following year's arrangement — holidays *and*
 * make-up workdays — in **late October to early November**: the 2024 arrangement
 * in [October 2023](https://www.gov.cn/zhengce/content/202310/content_6911527.htm),
 * the 2025 one in
 * [November 2024](http://big5.www.gov.cn/gate/big5/www.gov.cn/zhengce/content/202411/content_6986382.htm),
 * and the 2026 one in
 * [November 2025](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm).
 * So the lead time is about two months, and a month-long cadence is comfortably
 * shorter than it: the plugin learns about a new arrangement well before the year
 * it governs, at a cost of about twelve requests a year.
 */
export const HOLIDAY_AUTO_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The cadence while the next year's notice is due — the same two-month lead, used
 * as a season rather than a fixed number: somewhere in here the announcement lands,
 * and a week is short enough to pick it up promptly without polling.
 */
export const HOLIDAY_NOTICE_MS = 7 * 24 * 60 * 60 * 1000

/** The window the annual notice lands in, month/day, inclusive. */
export const HOLIDAY_NOTICE_FROM = { month: 10, day: 15 }
export const HOLIDAY_NOTICE_TO = { month: 11, day: 30 }

/** Wait this long after a failed attempt before trying again. */
export const HOLIDAY_RETRY_MS = 24 * 60 * 60 * 1000

/** ...and this long when the *current* year is missing, which is urgent. */
export const HOLIDAY_RETRY_URGENT_MS = 6 * 60 * 60 * 1000

/**
 * Whether the annual notice is due about now.
 *
 * @param at - epoch ms.
 * @returns true inside the window the State Council publishes in.
 */
export function inNoticeWindow(at) {
  const date = new Date(Number(at))
  const month = date.getUTCMonth() + 1
  const day = date.getUTCDate()
  const after = month > HOLIDAY_NOTICE_FROM.month || (month === HOLIDAY_NOTICE_FROM.month && day >= HOLIDAY_NOTICE_FROM.day)
  const before = month < HOLIDAY_NOTICE_TO.month || (month === HOLIDAY_NOTICE_TO.month && day <= HOLIDAY_NOTICE_TO.day)
  return after && before
}

/**
 * Whether it is time to look upstream again.
 *
 * Nobody should have to press a button for this, and nobody should see it hammering
 * either. Three things make a calendar worth re-fetching:
 *
 * - **The current year is missing.** That is the only real emergency: the rule
 *   cannot answer "is today a holiday", so it is retried every few hours until it
 *   can.
 * - **The next year is missing *and* the notice is due.** Not before: from January
 *   the following year's arrangement legitimately does not exist yet, and treating
 *   that as urgent would poll all year for something published in November. While
 *   the notice is outstanding in that window the cadence drops to a week, so a newly
 *   published arrangement is picked up promptly; once it is in hand, back to normal.
 * - **It has simply aged**, which is the ordinary case: once a month, comfortably
 *   inside the ~two-month lead the State Council gives.
 *
 * Failures back off instead of hammering, and never lose the calendar already held.
 *
 * @param options - `{ checkedAt, generatedAt, years, now, autoMs, noticeMs, retryMs }`.
 * @returns `{ due, reason, nextDueAt, urgent }`.
 */
export function holidayRefreshDue(options = {}) {
  const now = Number(options.now) || Date.now()
  const autoMs = Number(options.autoMs) || HOLIDAY_AUTO_MS
  const noticeMs = Number(options.noticeMs) || HOLIDAY_NOTICE_MS
  const retryMs = Number(options.retryMs) || HOLIDAY_RETRY_MS
  const urgentRetryMs = Number(options.urgentRetryMs) || HOLIDAY_RETRY_URGENT_MS
  const date = new Date(now)
  const year = date.getUTCFullYear()
  const years = Array.isArray(options.years) ? options.years : []
  const hasCurrent = years.includes(year)
  const hasNext = years.includes(year + 1)
  const notice = inNoticeWindow(now)
  const checkedAt = Date.parse(options.checkedAt || '') || 0
  const generatedAt = Date.parse(options.generatedAt || '') || 0
  // How old the *data* is, which is what the interval is about. Deliberately not
  // the attempt time: a failed fetch must not make a two-month-old calendar look
  // fresh, which would push the next try out by the whole interval. When there has
  // never been a fetch, the bundle's build date stands in — it is what the data is.
  const stamp = generatedAt || checkedAt
  const since = stamp === 0 ? Infinity : now - stamp
  // ...and the attempt time only governs the backoff.
  const sinceAttempt = checkedAt === 0 ? Infinity : now - checkedAt
  // The weekly cadence is for *chasing the notice*, not for polling all autumn: once
  // the following year is in hand there is nothing to chase, and the ordinary
  // monthly interval applies.
  const interval = !hasNext && notice ? noticeMs : autoMs
  const backoff = hasCurrent ? retryMs : urgentRetryMs

  // Missing the year we are *in* outranks everything.
  const urgent = !hasCurrent
  const dueToNotice = !hasNext && notice
  const dueToAge = since >= interval
  const wanted = urgent || dueToNotice || dueToAge
  const blocked = wanted && sinceAttempt < backoff
  const reason = blocked
    ? 'retry-wait'
    : urgent
      ? years.length === 0
        ? 'no-calendar'
        : 'missing-year'
      : dueToNotice
        ? 'notice-window'
        : dueToAge
          ? 'aged'
          : 'fresh'
  return {
    due: wanted && !blocked,
    urgent,
    notice,
    reason,
    nextDueAt: blocked ? checkedAt + backoff : wanted ? now : stamp + interval,
  }
}

/**
 * Fetch the current and next year from upstream and merge them over the bundled
 * data.
 *
 * Two years rather than one: the calendars are published in the autumn for the
 * *following* year, so in December a single-year fetch would have nothing for the
 * January that is about to matter.
 *
 * @param options - `{ at, fetchImpl, years }`.
 * @returns the merged payload in the bundled shape, plus what was fetched.
 */
export async function refreshHolidays(options = {}) {
  const at = Number(options.at) || Date.now()
  const doFetch = options.fetchImpl || ((...args) => fetch(...args))
  const year = new Date(at).getUTCFullYear()
  const wanted = options.years || [year, year + 1]
  const fetched = []
  const failed = []
  const merged = { years: {} }
  for (const target of wanted) {
    try {
      const response = await doFetch(`${HOLIDAY_SOURCE}/${target}.json`)
      if (!response || !response.ok) throw new Error(`HTTP ${response ? response.status : 'no response'}`)
      const payload = await response.json()
      const indexed = indexHolidays(payload)
      if (indexed.years.length === 0 || indexed.off.size === 0) throw new Error('no days')
      merged.years[target] = {
        papers: indexed.papers,
        days: [
          ...[...indexed.off].map(([date, name]) => ({ date, name, off: true })),
          ...[...indexed.work].map(([date, name]) => ({ date, name, off: false })),
        ].sort((a, b) => (a.date < b.date ? -1 : 1)),
      }
      fetched.push(target)
    } catch (error) {
      failed.push({ year: target, error: String((error && error.message) || error) })
    }
  }
  return { payload: merged, fetched, failed }
}

/**
 * Merge a refresh over the bundled data.
 *
 * The bundled years stay unless upstream replaced them: a refresh that only got one
 * year must not throw away the other.
 *
 * @param bundled - the bundled payload.
 * @param refreshed - the payload from {@link refreshHolidays}.
 * @param at - epoch ms, stamped as the generated date.
 * @returns a new payload.
 */
export function mergeHolidays(bundled, refreshed, at = Date.now(), options = {}) {
  const base = bundled && bundled.years ? bundled.years : {}
  const extra = refreshed && refreshed.years ? refreshed.years : {}
  const stamp = new Date(Number(at)).toISOString()
  return {
    source: HOLIDAY_SOURCE,
    note: bundled && bundled.note ? bundled.note : '',
    license: bundled && bundled.license ? bundled.license : 'MIT',
    // `checkedAt` is every attempt, `generated` only a good one: the first drives
    // the retry backoff, the second says how old the data itself is.
    checkedAt: stamp,
    generated:
      options.ok === false && bundled && bundled.generated
        ? bundled.generated
        : stamp.slice(0, 10),
    years: { ...base, ...extra },
  }
}
