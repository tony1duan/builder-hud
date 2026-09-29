/**
 * Which tariff window an instant falls in.
 *
 * DeepSeek publishes two prices: peak, and off-peak at **half** the peak rate.
 * The peak hours are stated in UTC and are the whole rule:
 *
 * > Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday,
 * > excluding Chinese public holidays. All other hours are off-peak, including
 * > weekends and Chinese public holidays in full.
 *
 * Three things about that are easy to get wrong, so they are handled explicitly
 * rather than inferred from a single "off-peak window":
 *
 * 1. **Two windows, with a gap.** 04:00–06:00 UTC on a Tuesday is *off-peak* — it
 *    is neither peak window. Modelling peak as the complement of one off-peak
 *    window cannot express that.
 * 2. **The weekday test and the holiday test are the same Chinese calendar day.**
 *    The *windows* are UTC — that is how they are published — but "Monday to
 *    Friday" and "a Chinese public holiday" only mean something in one calendar, so
 *    both are judged on the Asia/Shanghai date. 2026-09-30T20:00Z is already October
 *    1st in Shanghai and is a holiday, and a Sunday 17:00 UTC is already Monday
 *    morning there. Inside the published windows the two calendars agree, which is
 *    why this only bites once a window is configured by hand.
 *
 * And the whole rule is the user's to configure: prices change, holiday calendars
 * get published a year ahead, and a wrong badge is worse than an honest one. Every
 * reading therefore carries the rule it was computed from.
 *
 * Pure and exported, so the official rule can be asserted on a fake clock instead
 * of at whatever hour the suite happens to run.
 */

import { chinaDay, holidayAt } from './holidays.js'

/** DeepSeek's published peak windows, as `HH:MM` UTC. */
export const DEFAULT_PEAK_WINDOWS = [
  { start: '01:00', end: '04:00' },
  { start: '06:00', end: '10:00' },
]

/** Monday through Friday, `Date.getUTCDay()` numbering. */
export const DEFAULT_PEAK_WEEKDAYS = [1, 2, 3, 4, 5]

/** The bundled fallback when a configured clock is unreadable. */
const DEFAULT_WINDOW = { start: 1 * 60, end: 4 * 60 }

/**
 * Parse `HH:MM` into minutes past midnight UTC.
 *
 * @param text - the clock string.
 * @returns minutes, or null when it is not a readable clock.
 */
export function parseClock(text) {
  if (typeof text !== 'string') return null
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/**
 * The configured windows, resolved to minutes and made safe.
 *
 * A window whose end is not after its start wraps past midnight (22:00–02:00 is
 * legal and means what it says). Anything unreadable is dropped rather than
 * guessed at; when nothing survives, the published rule is used.
 *
 * @param config - the plugin config.
 * @returns `[{ start, end, text }]` in minutes, sorted by start.
 */
export function peakWindows(config = {}) {
  const configured = Array.isArray(config.tariffPeakWindows) ? config.tariffPeakWindows : null
  const source = configured || DEFAULT_PEAK_WINDOWS
  const windows = []
  for (const entry of source) {
    const start = parseClock(entry && entry.start)
    const end = parseClock(entry && entry.end)
    if (start === null || end === null || start === end) continue
    windows.push({ start, end, text: `${clockText(start)}–${clockText(end)}` })
  }
  if (windows.length === 0) {
    windows.push({ ...DEFAULT_WINDOW, text: '01:00–04:00' })
  }
  windows.sort((a, b) => a.start - b.start)
  return windows
}

/**
 * The configured peak weekdays.
 *
 * Nothing readable falls back to the published weekdays rather than to "no peak
 * days at all": a typo must not quietly make every hour off-peak, which would look
 * like the feature working. Saying "I do not care about pricing" is what
 * `tariffEnabled: false` is for.
 *
 * @param config - the plugin config.
 * @returns a sorted array of `Date.getUTCDay()` numbers.
 */
export function peakWeekdays(config = {}) {
  const configured = Array.isArray(config.tariffPeakWeekdays) ? config.tariffPeakWeekdays : null
  const source = configured || DEFAULT_PEAK_WEEKDAYS
  const days = []
  for (const day of source) {
    const value = Number(day)
    if (Number.isInteger(value) && value >= 0 && value <= 6 && !days.includes(value)) days.push(value)
  }
  if (days.length === 0) return [...DEFAULT_PEAK_WEEKDAYS]
  return days.sort((a, b) => a - b)
}

/**
 * The custom holiday and make-up-workday dates, as `YYYY-MM-DD` sets.
 *
 * @param config - the plugin config.
 * @returns `{ holidays: Set, workdays: Set }`.
 */
export function customDays(config = {}) {
  const read = (value) => {
    const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : []
    const set = new Set()
    for (const item of list) {
      const text = String(item).trim()
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) set.add(text)
    }
    return set
  }
  return {
    holidays: read(config.tariffCustomHolidays),
    workdays: read(config.tariffCustomWorkdays),
  }
}

/** `HH:MM` for minutes past midnight. */
function clockText(minutes) {
  const wrapped = ((minutes % 1440) + 1440) % 1440
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`
}

/** Whether `minutes` falls inside a window, honouring a window that wraps. */
function inWindow(minutes, window) {
  return window.end > window.start
    ? minutes >= window.start && minutes < window.end
    : minutes >= window.start || minutes < window.end
}

/**
 * The tariff for one instant, without the next-change search.
 *
 * @param at - epoch ms.
 * @param config - the plugin config.
 * @param holidays - an `indexHolidays` result, or null.
 * @returns the core reading.
 */
function reading(at, config, holidays) {
  const moment = new Date(Number.isFinite(at) ? at : Date.now())
  const minutes = moment.getUTCHours() * 60 + moment.getUTCMinutes()
  // The window test is UTC (that is how the windows are published); the day — and
  // therefore the weekday and the holiday — is the Chinese one.
  const day = chinaDay(Number.isFinite(at) ? at : Date.now())
  const weekday = day.weekday
  const windows = peakWindows(config)
  const weekdays = peakWeekdays(config)
  const mode = config.tariffHolidayMode === 'custom' ? 'custom' : config.tariffHolidayMode === 'none' ? 'none' : 'cn'
  const makeup = config.tariffMakeupWorkdays === true
  const custom = customDays(config)

  const calendar =
    mode === 'none'
      ? { date: day.date, holiday: false, name: '', makeup: false, working: false }
      : mode === 'custom'
        ? (() => {
            const date = day.date
            return {
              date,
              holiday: custom.holidays.has(date),
              name: '',
              makeup: custom.workdays.has(date),
              working: makeup && custom.workdays.has(date),
            }
          })()
        : holidayAt(holidays, at, makeup)

  const window = windows.find((candidate) => inWindow(minutes, candidate)) || null
  const isWorkday = weekdays.includes(weekday)
  // A make-up workday is a working day *only* when the setting says so; the
  // published rule is weekday-based, so by default a 调休 Saturday is off-peak.
  const working = isWorkday || calendar.working

  let peak = false
  let reason
  if (!working) {
    reason = calendar.holiday ? 'holiday' : weekday === 0 || weekday === 6 ? 'weekend' : 'off-day'
  } else if (calendar.holiday) {
    reason = 'holiday'
  } else if (window) {
    peak = true
    reason = 'peak-window'
  } else {
    // Between two windows is not "outside the peak window" in the sense of a single
    // complement: 04:00–06:00 UTC is a deliberate off-peak gap in the middle of the
    // morning, and saying so is the difference between a rule and a guess.
    const before = windows.filter((candidate) => candidate.start > minutes).length > 0
    const after = windows.filter((candidate) => candidate.end <= minutes).length > 0
    reason = before && after ? 'between-windows' : 'outside-windows'
  }

  return {
    enabled: config.tariffEnabled !== false,
    peak,
    reason,
    windows,
    weekdays,
    window: peak ? { start: window.start, end: window.end, text: window.text } : null,
    utcMinutes: minutes,
    utcClock: clockText(minutes),
    /** The weekday the rule used: the Chinese one, not the UTC one. */
    weekday,
    utcWeekday: moment.getUTCDay(),
    day: day.date,
    utcDate: moment.toISOString().slice(0, 10),
    holidayMode: mode,
    holidayDate: calendar.date,
    holidayName: calendar.name,
    holiday: calendar.holiday,
    makeup: calendar.makeup,
    half: true,
  }
}

/**
 * The tariff for one instant, with when it next changes.
 *
 * The next change is found by evaluating the same rule at each candidate boundary
 * over the next eight days — window ends, window starts, and midnight UTC — rather
 * than by walking minute by minute. Eight days because a Chinese holiday can hand
 * back a whole week of off-peak at once.
 *
 * @param at - epoch ms.
 * @param config - the plugin config.
 * @param holidays - an `indexHolidays` result, or null.
 * @returns the tariff reading.
 */
export function tariffAt(at, config = {}, holidays = null) {
  const now = Number.isFinite(at) ? at : Date.now()
  const base = reading(now, config, holidays)
  const windows = base.windows
  const candidates = []
  for (let day = 0; day <= 8; day += 1) {
    const midnight = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate() + day,
    )
    candidates.push(midnight)
    for (const window of windows) {
      candidates.push(midnight + window.start * 60000)
      candidates.push(midnight + window.end * 60000)
    }
  }
  const next = candidates
    .filter((candidate) => candidate > now)
    .sort((a, b) => a - b)
    .find((candidate) => reading(candidate, config, holidays).peak !== base.peak)
  return {
    ...base,
    nextChangeAt: next === undefined ? null : next,
    nextChangePeak: next === undefined ? null : !base.peak,
    nextChangeInMs: next === undefined ? null : next - now,
  }
}

/**
 * The equivalent peak windows for a legacy off-peak configuration.
 *
 * The plugin used to describe one off-peak window (16:30–00:30 UTC) and a weekend
 * rule. That is the same rule read the other way round, so a configuration written
 * by the old version can be carried over instead of silently replaced.
 *
 * @param config - the plugin config, possibly carrying the old keys.
 * @returns peak windows, or null when there is nothing to migrate.
 */
export function migrateOffPeak(config = {}) {
  if (Array.isArray(config.tariffPeakWindows)) return null
  const start = parseClock(config.offPeakUtcStart)
  const end = parseClock(config.offPeakUtcEnd)
  if (start === null || end === null) return null
  // The complement of the off-peak window is the peak window.
  return [{ start: clockText(end), end: clockText(start) }]
}
