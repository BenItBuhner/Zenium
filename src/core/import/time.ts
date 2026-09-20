/**
 * The epochs other browsers stamp their data with, all brought to milliseconds since 1970.
 * Anything that does not parse, is zero or lands outside a plausible window (before 1990 or
 * more than a day into the future of `now`) comes back as `undefined`, so callers fall back to
 * "now" the way Chrome's importer does for missing dates.
 */

/** Microseconds between 1601-01-01 (Chrome's / Windows' epoch) and 1970-01-01. */
const WEBKIT_EPOCH_OFFSET_US = 11_644_473_600_000_000
/** Seconds between 1970-01-01 and 2001-01-01 (Core Data / Safari's epoch). */
const CORE_DATA_EPOCH_OFFSET_S = 978_307_200

const MIN_PLAUSIBLE_MS = Date.UTC(1990, 0, 1)

function plausible(ms: number, now: number): number | undefined {
  if (!Number.isFinite(ms)) return undefined
  if (ms < MIN_PLAUSIBLE_MS || ms > now + 86_400_000) return undefined
  return Math.round(ms)
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Chrome and Edge: microseconds since 1601 (`date_added`, `last_visit_time`, `date_created`). */
export function webkitToEpochMs(value: unknown, now: number = Date.now()): number | undefined {
  const us = toNumber(value)
  if (us === null || us <= 0) return undefined
  return plausible((us - WEBKIT_EPOCH_OFFSET_US) / 1000, now)
}

/** Firefox: PRTime, microseconds since 1970 (`dateAdded`, `visit_date`). */
export function prTimeToEpochMs(value: unknown, now: number = Date.now()): number | undefined {
  const us = toNumber(value)
  if (us === null || us <= 0) return undefined
  return plausible(us / 1000, now)
}

/** Safari: seconds since 2001 as a real (`visit_time`, `DateAdded`). */
export function coreDataToEpochMs(value: unknown, now: number = Date.now()): number | undefined {
  const s = toNumber(value)
  if (s === null || s <= 0) return undefined
  return plausible((s + CORE_DATA_EPOCH_OFFSET_S) * 1000, now)
}
