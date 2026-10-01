/**
 * Structural sharing for the snapshots the main process sends (`browserStore.ts`).
 *
 * Every `state` event carries the whole `UIState` as a fresh copy, so until now each one gave
 * every tab, space and list a new identity whether or not it had changed, and nothing below
 * the root could tell "the same" from "changed" by `===`: React.memo, useMemo's dependencies
 * and a selector's result all saw a new value every time, and the chrome re-rendered whole.
 * `shareUnchanged` walks the fresh snapshot against the one before it and puts the previous
 * node back wherever the new one is deep-equal to it, so an unchanged tab is the very object
 * it was. The snapshot's values are untouched – only which object holds them.
 */

/**
 * `next` with every child subtree that is deep-equal to `prev`'s replaced by `prev`'s. The
 * root stays `next` itself (it is the one object a store compares to notice the event at all),
 * so a store set with it still tells its listeners; below the root, an unchanged plain object or
 * array is `prev`'s. `next` is rewritten in place: the caller owns it (it is the copy the IPC
 * bridge made for this listener alone).
 */
export function shareUnchanged<T extends object>(prev: T | null | undefined, next: T): T {
  if (!prev || prev === next) return next
  if (Array.isArray(next)) {
    if (Array.isArray(prev)) shareItems(prev, next)
    return next
  }
  if (isPlainObject(next) && isPlainObject(prev)) shareFields(prev, next)
  return next
}

/**
 * `prev` when `next` is deep-equal to it (same keys in the same order, every value shared),
 * `next` otherwise with its own unchanged children shared. Only plain objects and arrays are
 * walked; anything else is a leaf, the same only by `Object.is`.
 */
function share(prev: unknown, next: unknown): unknown {
  if (Object.is(prev, next)) return prev
  if (Array.isArray(next)) {
    if (!Array.isArray(prev) || prev.length !== next.length) return next
    return shareItems(prev, next) ? prev : next
  }
  if (!isPlainObject(next) || !isPlainObject(prev)) return next
  return shareFields(prev, next) ? prev : next
}

/** Shares each item of `next` against `prev`'s; true when every item came out `prev`'s. */
function shareItems(prev: readonly unknown[], next: unknown[]): boolean {
  let same = prev.length === next.length
  for (let i = 0; i < next.length; i++) {
    const shared = share(prev[i], next[i])
    if (same && !Object.is(shared, prev[i])) same = false
    next[i] = shared
  }
  return same
}

/**
 * Shares each field of `next` against `prev`'s; true when the two hold the same keys in the
 * same order and every value came out `prev`'s.
 */
function shareFields(prev: Record<string, unknown>, next: Record<string, unknown>): boolean {
  const keys = Object.keys(next)
  const prevKeys = Object.keys(prev)
  let same = keys.length === prevKeys.length
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    if (same && prevKeys[i] !== key) same = false
    const shared = share(prev[key], next[key])
    if (same && !Object.is(shared, prev[key])) same = false
    next[key] = shared
  }
  return same
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
