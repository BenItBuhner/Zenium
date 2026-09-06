import { useSyncExternalStore } from 'react'

/** Minimal external store with selector support (no extra dependency). */
export interface Store<T> {
  get: () => T
  set: (patch: Partial<T> | ((prev: T) => Partial<T>)) => void
  subscribe: (listener: () => void) => () => void
  use: <S = T>(selector?: (state: T) => S) => S
}

/**
 * Create a store, or reuse the instance registered under `hmrKey` when Vite hot-reloads the
 * defining module (otherwise components would keep subscriptions to a stale store).
 */
export function createStore<T extends object>(initial: T, hmrKey?: string): Store<T> {
  const registry = ((
    globalThis as unknown as { __zenStores?: Record<string, Store<object>> }
  ).__zenStores ??= {})
  if (hmrKey && registry[hmrKey]) return registry[hmrKey] as Store<T>
  const store = buildStore(initial)
  if (hmrKey) registry[hmrKey] = store as Store<object>
  return store
}

function buildStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()
  const get = (): T => state
  const set: Store<T>['set'] = (patch) => {
    const next = typeof patch === 'function' ? patch(state) : patch
    let changed = false
    for (const key of Object.keys(next) as Array<keyof T>) {
      if (!Object.is(state[key], next[key])) {
        changed = true
        break
      }
    }
    if (!changed) return
    state = { ...state, ...next }
    for (const l of listeners) l()
  }
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const identity = (s: T): T => s
  function use<S = T>(selector?: (state: T) => S): S {
    const select = (selector ?? (identity as unknown as (state: T) => S)) as (state: T) => S
    return useSyncExternalStore(
      subscribe,
      () => select(state),
      () => select(state)
    )
  }
  return { get, set, subscribe, use }
}
