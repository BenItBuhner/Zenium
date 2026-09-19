/**
 * Day bucketing for the phone history list: pure functions over visit timestamps. Days are
 * calendar days in a time zone (the device's by default), never 24-hour windows, so a visit at
 * 23:55 and one at 00:05 land in different groups and "Yesterday" flips at local midnight.
 * Everything takes `now` as an argument – nothing in here reads the clock.
 */

export interface DayGroup<T> {
  /** Local calendar day, `YYYY-MM-DD`. */
  dayKey: string
  /** "Today", "Yesterday", a weekday for the rest of the week, then a date. */
  label: string
  /** Newest first. */
  items: T[]
}

export interface DayGroupOptions {
  /** IANA zone; the device's zone when omitted. */
  timeZone?: string
  /** BCP 47 tag for weekday and date names; the device's language when omitted. */
  locale?: string
}

const DAY_MS = 86_400_000

const keyFormatters = new Map<string, Intl.DateTimeFormat>()

/** `YYYY-MM-DD` of the calendar day `ms` falls on in `timeZone`. */
export function dayKey(ms: number, timeZone?: string): string {
  const cacheKey = timeZone ?? ''
  let format = keyFormatters.get(cacheKey)
  if (!format) {
    // en-CA writes dates as 2026-09-17, which is exactly the key we want.
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
    keyFormatters.set(cacheKey, format)
  }
  return format.format(ms)
}

/** Noon UTC of the calendar day a key names – a `Date` that formats to that day in UTC. */
function dateOfKey(key: string): Date {
  const [y = 1970, m = 1, d = 1] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12))
}

/** Whole calendar days from `from` to `to` (positive when `to` is later). */
export function daysBetween(fromKey: string, toKey: string): number {
  return Math.round((dateOfKey(toKey).getTime() - dateOfKey(fromKey).getTime()) / DAY_MS)
}

/**
 * The heading of a day relative to today: "Today", "Yesterday", the weekday for the five days
 * before that, then the date (with the year once it is not this year's). Sentence case, in the
 * user's language.
 */
export function dayLabel(key: string, todayKey: string, locale?: string): string {
  const age = daysBetween(key, todayKey)
  if (age === 0) return 'Today'
  if (age === 1) return 'Yesterday'
  const date = dateOfKey(key)
  if (age > 1 && age < 7) {
    return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(date)
  }
  const sameYear = key.slice(0, 4) === todayKey.slice(0, 4)
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: sameYear ? undefined : 'numeric',
    timeZone: 'UTC'
  }).format(date)
}

/** The time of day a visit happened, e.g. "09:41" or "9:41 AM" depending on the locale. */
export function visitTime(ms: number, options: DayGroupOptions = {}): string {
  return new Intl.DateTimeFormat(options.locale, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: options.timeZone
  }).format(ms)
}

/**
 * When something happened, for a row outside the day groups (a recently closed tab): the time
 * of day when it was today, the day's heading ("Yesterday", the weekday, the date) otherwise.
 */
export function timeOrDay(ms: number, now: number, options: DayGroupOptions = {}): string {
  const day = dayKey(ms, options.timeZone)
  const today = dayKey(now, options.timeZone)
  return day === today ? visitTime(ms, options) : dayLabel(day, today, options.locale)
}

/**
 * Bucket visits by calendar day, newest day first and newest visit first within a day. Ties in
 * `visitTime` keep their input order.
 */
export function groupByDay<T extends { visitTime: number }>(
  items: readonly T[],
  now: number,
  options: DayGroupOptions = {}
): DayGroup<T>[] {
  const todayKey = dayKey(now, options.timeZone)
  const sorted = [...items].sort((a, b) => b.visitTime - a.visitTime)
  const groups: DayGroup<T>[] = []
  let current: DayGroup<T> | null = null
  for (const item of sorted) {
    const key = dayKey(item.visitTime, options.timeZone)
    if (!current || current.dayKey !== key) {
      current = { dayKey: key, label: dayLabel(key, todayKey, options.locale), items: [] }
      groups.push(current)
    }
    current.items.push(item)
  }
  return groups
}
