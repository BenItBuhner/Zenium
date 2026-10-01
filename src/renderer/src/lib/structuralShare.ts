/**
 * Structural sharing for the snapshots the core sends (`browserStore.ts`).
 *
 * Every `state` event carries the whole `UIState` as a fresh snapshot, so until now each one gave
 * every tab, space and list a new identity whether or not it had changed, and nothing below
 * the root could tell "the same" from "changed" by `===`: React.memo, useMemo's dependencies
 * and a selector's result all saw a new value every time, and the chrome re-rendered whole.
 * `shareUnchanged` walks the fresh snapshot against the one before it and hands back a tree
 * in which an unchanged tab is the very object it was. The snapshot's values are untouched –
 * only which object holds them.
 *
 * Copy-on-write, never in place: `next` is read-only here. On a host whose event bus is
 * in-process (Android: `InProcessEvents.send` hands one and the same payload to every
 * listener) the snapshot holds the core's own live objects – `tabs[id]` is the core's tab,
 * `containers`, `shortcuts`, `searchEngines` are the core's records – so a write into `next`
 * would put an older object back into a parent the core still owns and split its references
 * without a trace. The desktop's payload is a structured clone the bridge made for this
 * listener, but the walk cannot tell the two apart and treats both the same way. `prev` is
 * read-only for the same reason: on that host it is the core's objects too.
 */

/**
 * A tree with `next`'s values in which every subtree deep-equal to `prev`'s is `prev`'s object.
 * Each node comes out as one of three things: `prev`'s node where the two are deep-equal (same
 * keys in the same order, every value shared), `next`'s own node where none of its children
 * came out shared (nothing to substitute, so nothing to copy), or a shallow copy of `next`'s
 * node with the shared children substituted. Neither `next` nor `prev` is written.
 *
 * The root is never `prev`'s object – it is the one object a store compares to notice the
 * event at all – so a wholly unchanged snapshot still comes back as a fresh root holding
 * `prev`'s children, and a store set with it still tells its listeners.
 */
export function shareUnchanged<T extends object>(prev: T | null | undefined, next: T): T {
  if (!prev || prev === next) return next
  if (Array.isArray(next)) {
    if (!Array.isArray(prev)) return next
    const shared = shareItems(prev, next)
    return (shared === prev ? prev.slice() : shared) as T
  }
  if (!isPlainObject(next) || !isPlainObject(prev)) return next
  const shared = shareFields(prev, next)
  return (shared === prev ? shallowCopy(prev) : shared) as T
}

/**
 * `prev` when `next` is deep-equal to it, `next` when none of its children came out shared,
 * otherwise a shallow copy of `next` with the shared children substituted. Only plain objects
 * and arrays are walked; anything else is a leaf, the same only by `Object.is`.
 */
function share(prev: unknown, next: unknown): unknown {
  if (Object.is(prev, next)) return prev
  if (Array.isArray(next)) {
    return Array.isArray(prev) ? shareItems(prev, next) : next
  }
  if (!isPlainObject(next) || !isPlainObject(prev)) return next
  return shareFields(prev, next)
}

/**
 * Shares each item of `next` against `prev`'s. While every item so far came out `prev`'s (and
 * the lengths agree) nothing is copied – the whole array may yet be `prev`'s; at the first item
 * that is not, the items before it are known to be `prev`'s and go into the copy, which is made
 * only once some item actually differs from `next`'s own.
 */
function shareItems(prev: readonly unknown[], next: readonly unknown[]): unknown {
  let same = prev.length === next.length
  let copy: unknown[] | null = null
  for (let i = 0; i < next.length; i++) {
    const item = next[i]
    const shared = share(prev[i], item)
    if (same) {
      if (Object.is(shared, prev[i])) continue
      same = false
      for (let j = 0; j < i; j++) {
        if (Object.is(prev[j], next[j])) continue
        if (!copy) copy = next.slice()
        copy[j] = prev[j]
      }
    }
    if (!Object.is(shared, item)) {
      if (!copy) copy = next.slice()
      copy[i] = shared
    }
  }
  return same ? prev : (copy ?? next)
}

/**
 * Shares each field of `next` against `prev`'s, the same way: the two are the same only when
 * they hold the same keys in the same order and every value came out `prev`'s.
 */
function shareFields(prev: Record<string, unknown>, next: Record<string, unknown>): unknown {
  const keys = Object.keys(next)
  const prevKeys = Object.keys(prev)
  let same = keys.length === prevKeys.length
  let copy: Record<string, unknown> | null = null
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const value = next[key]
    const shared = share(prev[key], value)
    if (same) {
      if (prevKeys[i] === key && Object.is(shared, prev[key])) continue
      same = false
      for (let j = 0; j < i; j++) {
        const earlier = keys[j]
        if (Object.is(prev[earlier], next[earlier])) continue
        if (!copy) copy = shallowCopy(next)
        copy[earlier] = prev[earlier]
      }
    }
    if (!Object.is(shared, value)) {
      if (!copy) copy = shallowCopy(next)
      copy[key] = shared
    }
  }
  return same ? prev : (copy ?? next)
}

/** A shallow copy with the same prototype (a plain object's, or none). */
function shallowCopy(source: Record<string, unknown>): Record<string, unknown> {
  if (Object.getPrototypeOf(source) === null) {
    return Object.assign(Object.create(null) as Record<string, unknown>, source)
  }
  return { ...source }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
