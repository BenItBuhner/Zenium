/**
 * `chrome.storage` semantics the browser layer implements itself: Chrome's `sync` quotas, the
 * byte accounting behind `getBytesInUse`, and the `{ oldValue, newValue }` change records that
 * `storage.onChanged` reports. Pure functions over plain JSON objects.
 */

export type StorageItems = Record<string, unknown>

export interface StorageChange {
  oldValue?: unknown
  newValue?: unknown
}

export type StorageChanges = Record<string, StorageChange>

export type StorageArea = 'local' | 'sync' | 'session' | 'managed'

/** `chrome.storage.sync` limits. */
export const SYNC_QUOTA = {
  QUOTA_BYTES: 102400,
  QUOTA_BYTES_PER_ITEM: 8192,
  MAX_ITEMS: 512,
  MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
  MAX_WRITE_OPERATIONS_PER_MINUTE: 120
} as const

/** `chrome.storage.local` limit (only reported, never enforced by Chrome with `unlimitedStorage`). */
export const LOCAL_QUOTA_BYTES = 10485760

/** `chrome.storage.session` limit. */
export const SESSION_QUOTA_BYTES = 10485760

/** Chrome measures an item as the key length plus the length of its JSON serialisation. */
export function itemBytes(key: string, value: unknown): number {
  return key.length + jsonLength(value)
}

export function bytesInUse(items: StorageItems, keys?: string | string[] | null): number {
  const wanted =
    keys === undefined || keys === null
      ? Object.keys(items)
      : typeof keys === 'string'
        ? [keys]
        : keys
  let total = 0
  for (const key of wanted) {
    if (Object.prototype.hasOwnProperty.call(items, key)) total += itemBytes(key, items[key])
  }
  return total
}

export interface StorageSetResult {
  next: StorageItems
  changes: StorageChanges
  /** Chrome's error message when a quota was exceeded (nothing is written then). */
  error: string | null
}

/**
 * Apply a `set` to `items` under `sync` quotas. Values are JSON round-tripped the way Chrome
 * stores them (functions and undefined disappear, dates become strings).
 */
export function applySet(
  items: StorageItems,
  updates: StorageItems,
  quota: { QUOTA_BYTES: number; QUOTA_BYTES_PER_ITEM: number; MAX_ITEMS: number } | null
): StorageSetResult {
  const next: StorageItems = { ...items }
  const changes: StorageChanges = {}
  for (const [key, raw] of Object.entries(updates)) {
    const value = normalize(raw)
    if (value === undefined) continue
    if (quota && itemBytes(key, value) > quota.QUOTA_BYTES_PER_ITEM) {
      return { next: items, changes: {}, error: 'QUOTA_BYTES_PER_ITEM quota exceeded' }
    }
    if (!sameJson(items[key], value) || !Object.prototype.hasOwnProperty.call(items, key)) {
      changes[key] = Object.prototype.hasOwnProperty.call(items, key)
        ? { oldValue: items[key], newValue: value }
        : { newValue: value }
    }
    next[key] = value
  }
  if (quota) {
    if (Object.keys(next).length > quota.MAX_ITEMS) {
      return { next: items, changes: {}, error: 'MAX_ITEMS quota exceeded' }
    }
    if (bytesInUse(next) > quota.QUOTA_BYTES) {
      return { next: items, changes: {}, error: 'QUOTA_BYTES quota exceeded' }
    }
  }
  return { next, changes, error: null }
}

export function applyRemove(
  items: StorageItems,
  keys: string | string[]
): { next: StorageItems; changes: StorageChanges } {
  const list = typeof keys === 'string' ? [keys] : keys
  const next: StorageItems = { ...items }
  const changes: StorageChanges = {}
  for (const key of list) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) continue
    changes[key] = { oldValue: next[key] }
    delete next[key]
  }
  return { next, changes }
}

export function applyClear(items: StorageItems): { next: StorageItems; changes: StorageChanges } {
  const changes: StorageChanges = {}
  for (const [key, value] of Object.entries(items)) changes[key] = { oldValue: value }
  return { next: {}, changes }
}

/** `storage.get` argument forms: null/undefined (everything), a key, keys, or defaults. */
export function selectItems(
  items: StorageItems,
  keys: null | undefined | string | string[] | StorageItems
): StorageItems {
  if (keys === null || keys === undefined) return { ...items }
  if (typeof keys === 'string') {
    return Object.prototype.hasOwnProperty.call(items, keys) ? { [keys]: items[keys] } : {}
  }
  if (Array.isArray(keys)) {
    const out: StorageItems = {}
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(items, key)) out[key] = items[key]
    }
    return out
  }
  const out: StorageItems = {}
  for (const [key, fallback] of Object.entries(keys)) {
    out[key] = Object.prototype.hasOwnProperty.call(items, key) ? items[key] : fallback
  }
  return out
}

/** Change records between two snapshots of an area (what `onChanged` reports). */
export function diffItems(before: StorageItems, after: StorageItems): StorageChanges {
  const changes: StorageChanges = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const had = Object.prototype.hasOwnProperty.call(before, key)
    const has = Object.prototype.hasOwnProperty.call(after, key)
    if (had && has && sameJson(before[key], after[key])) continue
    const change: StorageChange = {}
    if (had) change.oldValue = before[key]
    if (has) change.newValue = after[key]
    changes[key] = change
  }
  return changes
}

function normalize(value: unknown): unknown {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol')
    return undefined
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return undefined
  }
}

function jsonLength(value: unknown): number {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? 0 : text.length
  } catch {
    return 0
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
