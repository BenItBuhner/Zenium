const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * "just now", "5 minutes ago", "yesterday", "3 days ago", then a date. `now` is passed in so
 * rendering stays pure (the caller ticks it once a minute).
 */
export function relativeTime(timestamp: number, now: number): string {
  const delta = Math.max(0, now - timestamp)
  if (delta < MINUTE) return 'just now'
  if (delta < HOUR) {
    const m = Math.floor(delta / MINUTE)
    return m === 1 ? '1 minute ago' : `${m} minutes ago`
  }
  if (delta < DAY) {
    const h = Math.floor(delta / HOUR)
    return h === 1 ? '1 hour ago' : `${h} hours ago`
  }
  const d = Math.floor(delta / DAY)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d} days ago`
  return formatDate(timestamp)
}

/** "12 September 2026" in the user's locale, without the time. */
export function formatDate(timestamp: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(
    new Date(timestamp)
  )
}
