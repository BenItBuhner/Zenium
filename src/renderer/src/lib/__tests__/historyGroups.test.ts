import { describe, expect, it } from 'vitest'
import { dayKey, dayLabel, daysBetween, groupByDay, timeOrDay, visitTime } from '../historyGroups'

// 2026-09-17T12:00:00Z, a Thursday.
const NOON_UTC = Date.UTC(2026, 8, 17, 12)
const HOUR = 3_600_000
const DAY = 24 * HOUR

describe('dayKey', () => {
  it('names the calendar day in the given zone', () => {
    expect(dayKey(NOON_UTC, 'UTC')).toBe('2026-09-17')
  })

  it('splits visits either side of local midnight into different days', () => {
    // 23:30 and 00:30 Berlin time (UTC+2 in September).
    const before = Date.UTC(2026, 8, 16, 21, 30)
    const after = Date.UTC(2026, 8, 16, 22, 30)
    expect(dayKey(before, 'Europe/Berlin')).toBe('2026-09-16')
    expect(dayKey(after, 'Europe/Berlin')).toBe('2026-09-17')
    // The same instants are one UTC day.
    expect(dayKey(before, 'UTC')).toBe(dayKey(after, 'UTC'))
  })

  it('follows the zone west of Greenwich too', () => {
    const lateEvening = Date.UTC(2026, 8, 17, 3) // 20:00 the day before in Los Angeles
    expect(dayKey(lateEvening, 'America/Los_Angeles')).toBe('2026-09-16')
    expect(dayKey(lateEvening, 'UTC')).toBe('2026-09-17')
  })
})

describe('daysBetween', () => {
  it('counts calendar days, across month and year ends', () => {
    expect(daysBetween('2026-09-17', '2026-09-17')).toBe(0)
    expect(daysBetween('2026-09-16', '2026-09-17')).toBe(1)
    expect(daysBetween('2026-08-31', '2026-09-01')).toBe(1)
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1)
    expect(daysBetween('2026-09-17', '2026-09-10')).toBe(-7)
  })
})

describe('dayLabel', () => {
  const today = '2026-09-17'

  it('says Today and Yesterday', () => {
    expect(dayLabel('2026-09-17', today, 'en-US')).toBe('Today')
    expect(dayLabel('2026-09-16', today, 'en-US')).toBe('Yesterday')
  })

  it('uses the weekday for the rest of the past week', () => {
    expect(dayLabel('2026-09-15', today, 'en-US')).toBe('Tuesday')
    expect(dayLabel('2026-09-11', today, 'en-US')).toBe('Friday')
  })

  it('switches to a date a week out, adding the year once it differs', () => {
    expect(dayLabel('2026-09-10', today, 'en-US')).toBe('Thursday, September 10')
    expect(dayLabel('2025-12-31', today, 'en-US')).toBe('Wednesday, December 31, 2025')
  })

  it('speaks the locale', () => {
    expect(dayLabel('2026-09-15', today, 'de-DE')).toBe('Dienstag')
    expect(dayLabel('2026-09-10', today, 'de-DE')).toBe('Donnerstag, 10. September')
  })

  it('never labels a day in the future as a weekday of last week', () => {
    expect(dayLabel('2026-09-20', today, 'en-US')).toBe('Sunday, September 20')
  })
})

describe('groupByDay', () => {
  const visit = (id: string, visitTime: number): { id: string; visitTime: number } => ({
    id,
    visitTime
  })

  it('buckets newest first, with newest visits first inside a day', () => {
    const now = NOON_UTC
    const groups = groupByDay(
      [
        visit('a', now - 2 * HOUR),
        visit('b', now - DAY),
        visit('c', now - 1 * HOUR),
        visit('d', now - 3 * DAY),
        visit('e', now - DAY - HOUR)
      ],
      now,
      { timeZone: 'UTC', locale: 'en-US' }
    )
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Monday'])
    expect(groups[0].items.map((v) => v.id)).toEqual(['c', 'a'])
    expect(groups[1].items.map((v) => v.id)).toEqual(['b', 'e'])
    expect(groups[2].items.map((v) => v.id)).toEqual(['d'])
  })

  it('buckets by the zone, not by 24-hour windows from now', () => {
    // Now: 00:30 Berlin (22:30Z on the 16th). A visit at 23:45 Berlin is "Yesterday" even
    // though it is 45 minutes old.
    const now = Date.UTC(2026, 8, 16, 22, 30)
    const groups = groupByDay([visit('a', now - 45 * 60_000), visit('b', now - 5 * 60_000)], now, {
      timeZone: 'Europe/Berlin',
      locale: 'en-US'
    })
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday'])
    expect(groups[0].items.map((v) => v.id)).toEqual(['b'])
    expect(groups[1].items.map((v) => v.id)).toEqual(['a'])
  })

  it('keeps the input order for equal timestamps and handles nothing', () => {
    expect(groupByDay([], NOON_UTC, { timeZone: 'UTC' })).toEqual([])
    const groups = groupByDay([visit('x', NOON_UTC), visit('y', NOON_UTC)], NOON_UTC, {
      timeZone: 'UTC'
    })
    expect(groups[0].items.map((v) => v.id)).toEqual(['x', 'y'])
  })
})

describe('visitTime', () => {
  it('formats the wall-clock time in the zone and locale', () => {
    const t = Date.UTC(2026, 8, 17, 7, 5)
    expect(visitTime(t, { timeZone: 'UTC', locale: 'en-GB' })).toMatch(/^0?7:05$/)
    expect(visitTime(t, { timeZone: 'Europe/Berlin', locale: 'de-DE' })).toMatch(/^0?9:05$/)
    expect(visitTime(t, { timeZone: 'America/New_York', locale: 'en-US' })).toMatch(/3:05\sAM/)
  })
})

describe('timeOrDay', () => {
  const options = { timeZone: 'UTC', locale: 'en-GB' }

  it('gives the time of day for today and the day heading for anything earlier', () => {
    expect(timeOrDay(NOON_UTC - 5 * HOUR, NOON_UTC, options)).toMatch(/^0?7:00$/)
    expect(timeOrDay(NOON_UTC - DAY, NOON_UTC, options)).toBe('Yesterday')
    expect(timeOrDay(NOON_UTC - 3 * DAY, NOON_UTC, options)).toBe('Monday')
    expect(timeOrDay(NOON_UTC - 10 * DAY, NOON_UTC, options)).toBe(
      dayLabel('2026-09-07', '2026-09-17', 'en-GB')
    )
  })

  it('judges today by the zone: an hour ago across midnight is yesterday', () => {
    const justAfterMidnight = Date.UTC(2026, 8, 17, 0, 30)
    expect(timeOrDay(justAfterMidnight - HOUR, justAfterMidnight, options)).toBe('Yesterday')
  })
})
