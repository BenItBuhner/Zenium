/**
 * Calendar-day keys (`YYYY-MM-DD`) for grouping timestamps by local day. Shared by the history
 * model (grouping) and the history page (headings), so both agree on where a day ends.
 */

/** Local calendar day of a timestamp as `YYYY-MM-DD` (in `timeZone`, default the host's). */
export function dayKeyOf(ms: number, timeZone?: string): string {
  const date = new Date(ms)
  if (!timeZone) {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** Local midnight of a day key, in milliseconds (the day key is always local time here). */
export function dayStart(dayKey: string): number {
  const [y, m, d] = dayKey.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1).getTime()
}

/** "Today", "Yesterday", or the full date, for a day heading. */
export function dayLabel(dayKey: string, nowMs: number, locale?: string): string {
  const today = dayKeyOf(nowMs)
  if (dayKey === today) return 'Today'
  if (dayKey === dayKeyOf(nowMs - 86_400_000)) return 'Yesterday'
  const start = dayStart(dayKey)
  if (!Number.isFinite(start)) return dayKey
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: dayKey.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric'
  }).format(new Date(start))
}
