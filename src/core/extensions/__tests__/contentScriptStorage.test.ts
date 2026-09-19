// A fresh realm is the only honest check that the stringified prelude carries everything it needs.
// eslint-disable-next-line no-restricted-imports
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONTENT_SCRIPT_PRELUDE_FILE,
  MANAGED_KEY_PREFIX,
  RESERVED_KEY_PREFIX,
  SYNC_CHANNEL,
  SYNC_KEY_PREFIX,
  SYNC_OUTBOX_KEY,
  contentScriptPreludeSource,
  installContentScriptStorage,
  isReservedStorageKey
} from '../api/contentScriptStorage'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke at the patched globals
type Any = any
type Listener = (...args: unknown[]) => unknown
type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>

interface FakeNative {
  chrome: Any
  /** The engine's `local` items as they are on disk. */
  items: Record<string, unknown>
  /** `runtime.sendMessage` calls the prelude made, in order. */
  sent: unknown[]
  /** What the receiving end answers with; null means nobody is listening. */
  responder: ((message: Any) => unknown) | null
  /** Write to the engine's `local` as the answering shim would, firing the native events. */
  engineWrite(set: Record<string, unknown>, remove?: string[]): void
}

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.'

/**
 * A stand-in for Electron's native bindings in a content-script world: `storage.local` with the
 * engine's change events (fired for actual changes only, as Chromium does), no working `sync`
 * (absent, or answering with `runtime.lastError` when `syncError` is set), and `runtime` with
 * `sendMessage` / `lastError`.
 */
function fakeNative(options: { syncError?: string; nativeSync?: boolean } = {}): FakeNative {
  const items: Record<string, unknown> = {}
  const localListeners = new Set<Listener>()
  const storageListeners = new Set<Listener>()
  const runtime: Any = { id: 'a'.repeat(32), lastError: undefined }
  const later = (fn: () => void): void => {
    queueMicrotask(fn)
  }
  const fire = (changes: Changes): void => {
    if (Object.keys(changes).length === 0) return
    for (const fn of localListeners) fn(changes)
    for (const fn of storageListeners) fn(changes, 'local')
  }
  const write = (set: Record<string, unknown>, remove: string[] = []): void => {
    const changes: Changes = {}
    for (const key of remove) {
      if (!(key in items)) continue
      changes[key] = { oldValue: items[key] }
      delete items[key]
    }
    for (const key of Object.keys(set)) {
      const had = key in items
      if (had && JSON.stringify(items[key]) === JSON.stringify(set[key])) continue
      changes[key] = had ? { oldValue: items[key], newValue: set[key] } : { newValue: set[key] }
      items[key] = set[key]
    }
    fire(changes)
  }
  const event = (listeners: Set<Listener>): Any => ({
    addListener: (fn: Listener) => listeners.add(fn),
    removeListener: (fn: Listener) => listeners.delete(fn),
    hasListener: (fn: Listener) => listeners.has(fn)
  })
  const local: Any = {
    get(keys: Any, cb: Listener) {
      const out: Record<string, unknown> = {}
      if (keys === null || keys === undefined) Object.assign(out, items)
      else {
        const list =
          typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
        for (const key of list) {
          if (key in items) out[key] = items[key]
          else if (keys && typeof keys === 'object' && !Array.isArray(keys)) out[key] = keys[key]
        }
      }
      later(() => cb(out))
    },
    set(next: Record<string, unknown>, cb: Listener) {
      write(next)
      later(() => cb())
    },
    remove(keys: Any, cb: Listener) {
      write({}, typeof keys === 'string' ? [keys] : keys)
      later(() => cb())
    },
    clear(cb: Listener) {
      write({}, Object.keys(items))
      later(() => cb())
    },
    getBytesInUse(keys: Any, cb: Listener) {
      const list =
        keys === null || keys === undefined
          ? Object.keys(items)
          : typeof keys === 'string'
            ? [keys]
            : keys
      let total = 0
      for (const key of list) {
        if (key in items) total += key.length + JSON.stringify(items[key]).length
      }
      later(() => cb(total))
    },
    getKeys(cb: Listener) {
      later(() => cb(Object.keys(items)))
    },
    onChanged: event(localListeners)
  }
  const storage: Any = { local, onChanged: event(storageListeners) }
  if (options.syncError !== undefined || options.nativeSync) {
    const syncItems: Record<string, unknown> = {}
    // Callback or promise, as Chrome's binding.
    const answer = (cb: Listener | undefined, value: unknown): Promise<unknown> | undefined => {
      if (cb) {
        later(() => cb(value))
        return undefined
      }
      return Promise.resolve(value)
    }
    storage.sync = {
      get(_keys: Any, cb?: Listener) {
        if (options.syncError === undefined) return answer(cb, { ...syncItems })
        later(() => {
          runtime.lastError = { message: options.syncError }
          cb?.(undefined)
          runtime.lastError = undefined
        })
        return undefined
      },
      set(next: Record<string, unknown>, cb?: Listener) {
        Object.assign(syncItems, next)
        return answer(cb, undefined)
      },
      onChanged: event(new Set())
    }
  }
  const native: FakeNative = {
    chrome: { runtime, storage },
    items,
    sent: [],
    responder: null,
    engineWrite: write
  }
  runtime.sendMessage = (message: unknown, cb: Listener): void => {
    native.sent.push(message)
    later(() => {
      if (!native.responder) {
        runtime.lastError = { message: NO_RECEIVER }
        cb(undefined)
        runtime.lastError = undefined
        return
      }
      cb(native.responder(message))
    })
  }
  return native
}

/** The extension's worker as the shim makes it: commits to the mirror, then answers. */
function answeringShim(native: FakeNative): void {
  native.responder = (message: Any) => {
    if (message.op === 'set') {
      const set: Record<string, unknown> = {}
      for (const key of Object.keys(message.args[0])) {
        set[SYNC_KEY_PREFIX + key] = message.args[0][key]
      }
      native.engineWrite(set)
    } else if (message.op === 'remove') {
      const keys: string[] = Array.isArray(message.args[0]) ? message.args[0] : [message.args[0]]
      native.engineWrite(
        {},
        keys.map((key) => SYNC_KEY_PREFIX + key)
      )
    } else if (message.op === 'clear') {
      native.engineWrite(
        {},
        Object.keys(native.items).filter((key) => key.startsWith(SYNC_KEY_PREFIX))
      )
    }
    return { __zenium: SYNC_CHANNEL, ok: true }
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('installContentScriptStorage', () => {
  let native: FakeNative
  let root: Any

  beforeEach(() => {
    native = fakeNative()
    root = { chrome: native.chrome }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('installs sync and managed over the engine local, once, adding no globals', () => {
    const before = Object.keys(root)
    expect(installContentScriptStorage(root)).toEqual({ installed: true })
    expect(Object.keys(root)).toEqual(before)
    const sync = native.chrome.storage.sync
    expect(typeof sync.get).toBe('function')
    expect(sync.QUOTA_BYTES).toBe(102400)
    expect(sync.QUOTA_BYTES_PER_ITEM).toBe(8192)
    expect(sync.MAX_ITEMS).toBe(512)
    expect(sync.MAX_WRITE_OPERATIONS_PER_HOUR).toBe(1800)
    expect(sync.MAX_WRITE_OPERATIONS_PER_MINUTE).toBe(120)
    expect(typeof native.chrome.storage.managed.get).toBe('function')
    expect(Object.keys(native.chrome.storage)).toEqual(['local', 'onChanged', 'sync', 'managed'])
    // A second content script in the same frame finds it there.
    expect(installContentScriptStorage(root)).toEqual({
      installed: false,
      reason: 'already-installed'
    })
    expect(native.chrome.storage.sync).toBe(sync)
  })

  it('does nothing without a storage binding', () => {
    expect(installContentScriptStorage({})).toEqual({ installed: false, reason: 'no-storage' })
    expect(installContentScriptStorage({ chrome: { storage: {} } })).toEqual({
      installed: false,
      reason: 'no-storage'
    })
  })

  it('reads sync and managed from the reserved keys of local', async () => {
    native.items[`${SYNC_KEY_PREFIX}theme`] = 'dark'
    native.items[`${SYNC_KEY_PREFIX}size`] = 3
    native.items[`${MANAGED_KEY_PREFIX}policy`] = { locked: true }
    native.items.plain = 'kept'
    installContentScriptStorage(root)
    const { sync, managed } = native.chrome.storage
    await expect(sync.get(null)).resolves.toEqual({ theme: 'dark', size: 3 })
    await expect(sync.get('theme')).resolves.toEqual({ theme: 'dark' })
    await expect(sync.get(['theme', 'missing'])).resolves.toEqual({ theme: 'dark' })
    await expect(sync.get({ theme: 'light', missing: 'default' })).resolves.toEqual({
      theme: 'dark',
      missing: 'default'
    })
    await expect(sync.getKeys()).resolves.toEqual(['theme', 'size'])
    await expect(sync.getBytesInUse(null)).resolves.toBe('theme'.length + 6 + 'size'.length + 1)
    await expect(sync.getBytesInUse('theme')).resolves.toBe('theme'.length + 6)
    await expect(managed.get(null)).resolves.toEqual({ policy: { locked: true } })
    await expect(managed.get('policy')).resolves.toEqual({ policy: { locked: true } })
    await expect(sync.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })).resolves.toBeUndefined()
    // Callback style works too.
    const cb = vi.fn()
    sync.get('theme', cb)
    await flush()
    expect(cb).toHaveBeenCalledWith({ theme: 'dark' })
  })

  it('sends writes to the extension over the reserved channel and reads them back', async () => {
    installContentScriptStorage(root)
    answeringShim(native)
    const { sync } = native.chrome.storage
    await sync.set({ theme: 'dark', nested: { a: [1, 2] }, dropped: undefined, fn: () => 1 })
    expect(native.sent).toEqual([
      { __zenium: SYNC_CHANNEL, op: 'set', args: [{ theme: 'dark', nested: { a: [1, 2] } }] }
    ])
    expect(native.items).toEqual({
      [`${SYNC_KEY_PREFIX}theme`]: 'dark',
      [`${SYNC_KEY_PREFIX}nested`]: { a: [1, 2] }
    })
    await expect(sync.get(null)).resolves.toEqual({ theme: 'dark', nested: { a: [1, 2] } })
    await sync.remove('theme')
    expect(native.sent[1]).toEqual({ __zenium: SYNC_CHANNEL, op: 'remove', args: ['theme'] })
    await expect(sync.get(null)).resolves.toEqual({ nested: { a: [1, 2] } })
    await sync.clear()
    expect(native.sent[2]).toEqual({ __zenium: SYNC_CHANNEL, op: 'clear', args: [] })
    await expect(sync.get(null)).resolves.toEqual({})
    expect(native.items[SYNC_OUTBOX_KEY]).toBeUndefined()
  })

  it('reports the host refusal of a write through the promise and runtime.lastError', async () => {
    installContentScriptStorage(root)
    native.responder = () => ({ __zenium: SYNC_CHANNEL, ok: false, error: 'QUOTA_BYTES exceeded' })
    const { sync } = native.chrome.storage
    await expect(sync.set({ big: 'x' })).rejects.toThrow('QUOTA_BYTES exceeded')
    let seen: unknown = null
    sync.set({ big: 'x' }, () => {
      seen = native.chrome.runtime.lastError
    })
    await flush()
    expect(seen).toEqual({ message: 'QUOTA_BYTES exceeded' })
    expect(native.chrome.runtime.lastError).toBeUndefined()
  })

  it('applies a write to the mirror and keeps it in the outbox when nothing answers', async () => {
    installContentScriptStorage(root)
    const { sync } = native.chrome.storage
    await sync.set({ theme: 'dark' })
    await sync.remove('gone')
    expect(native.items[`${SYNC_KEY_PREFIX}theme`]).toBe('dark')
    expect(native.items[SYNC_OUTBOX_KEY]).toEqual([
      { op: 'set', args: [{ theme: 'dark' }] },
      { op: 'remove', args: ['gone'] }
    ])
    await expect(sync.get('theme')).resolves.toEqual({ theme: 'dark' })
    // The outbox is not a sync item and not a local item the extension can see.
    await expect(sync.get(null)).resolves.toEqual({ theme: 'dark' })
    await expect(native.chrome.storage.local.get(null)).resolves.toEqual({})
  })

  it('refuses writes to managed', async () => {
    installContentScriptStorage(root)
    const { managed } = native.chrome.storage
    await expect(managed.set({ a: 1 })).rejects.toThrow('This is a read-only store.')
    await expect(managed.remove('a')).rejects.toThrow('This is a read-only store.')
    await expect(managed.clear()).rejects.toThrow('This is a read-only store.')
    expect(native.sent).toEqual([])
  })

  it('throws the binding TypeError for a bad signature', () => {
    installContentScriptStorage(root)
    const { sync } = native.chrome.storage
    expect(() => sync.set('not an object')).toThrow(TypeError)
    expect(() => sync.set('not an object')).toThrow(
      'Error in invocation of storage.sync.set(object items): No matching signature.'
    )
    expect(() => sync.remove(null)).toThrow(TypeError)
    expect(() => sync.get(42)).toThrow(TypeError)
    expect(() => native.chrome.storage.local.get(42)).toThrow(TypeError)
  })

  it('derives sync.onChanged and storage.onChanged from the engine local events', async () => {
    installContentScriptStorage(root)
    answeringShim(native)
    const { sync, managed, local, onChanged } = native.chrome.storage
    const onSync = vi.fn()
    const onManaged = vi.fn()
    const onLocal = vi.fn()
    const onAny = vi.fn()
    sync.onChanged.addListener(onSync)
    managed.onChanged.addListener(onManaged)
    local.onChanged.addListener(onLocal)
    onChanged.addListener(onAny)
    expect(sync.onChanged.hasListener(onSync)).toBe(true)
    expect(local.onChanged.hasListener(onLocal)).toBe(true)
    expect(onChanged.hasListener(onAny)).toBe(true)

    await sync.set({ theme: 'dark' })
    expect(onSync).toHaveBeenCalledTimes(1)
    expect(onSync).toHaveBeenCalledWith({ theme: { newValue: 'dark' } })
    expect(onLocal).not.toHaveBeenCalled()
    expect(onAny).toHaveBeenCalledTimes(1)
    expect(onAny).toHaveBeenCalledWith({ theme: { newValue: 'dark' } }, 'sync')

    // The host pushed a managed value and a sync change from another context into the mirror.
    native.engineWrite({ [`${MANAGED_KEY_PREFIX}policy`]: 1, [`${SYNC_KEY_PREFIX}theme`]: 'light' })
    expect(onManaged).toHaveBeenCalledWith({ policy: { newValue: 1 } })
    expect(onSync).toHaveBeenLastCalledWith({ theme: { oldValue: 'dark', newValue: 'light' } })
    expect(onAny).toHaveBeenCalledWith({ policy: { newValue: 1 } }, 'managed')
    expect(onAny).toHaveBeenCalledWith({ theme: { oldValue: 'dark', newValue: 'light' } }, 'sync')

    // A plain local write reaches local listeners as such, and nothing else.
    onAny.mockClear()
    await local.set({ plain: 1, [`${SYNC_KEY_PREFIX}smuggled`]: 2 })
    expect(onLocal).toHaveBeenCalledTimes(1)
    expect(onLocal).toHaveBeenCalledWith({ plain: { newValue: 1 } })
    expect(onAny).toHaveBeenCalledTimes(1)
    expect(onAny).toHaveBeenCalledWith({ plain: { newValue: 1 } }, 'local')
    expect(native.items[`${SYNC_KEY_PREFIX}smuggled`]).toBeUndefined()

    sync.onChanged.removeListener(onSync)
    local.onChanged.removeListener(onLocal)
    onChanged.removeListener(onAny)
    expect(sync.onChanged.hasListener(onSync)).toBe(false)
    expect(local.onChanged.hasListener(onLocal)).toBe(false)
    expect(onChanged.hasListener(onAny)).toBe(false)
    await sync.set({ theme: 'blue' })
    expect(onSync).toHaveBeenCalledTimes(2)
    expect(onAny).toHaveBeenCalledTimes(1)
  })

  it('keeps the reserved keys out of what the extension sees of local', async () => {
    native.items[`${SYNC_KEY_PREFIX}theme`] = 'dark'
    native.items[SYNC_OUTBOX_KEY] = []
    native.items.plain = 'kept'
    native.items.other = 2
    installContentScriptStorage(root)
    const { local } = native.chrome.storage
    await expect(local.get(null)).resolves.toEqual({ plain: 'kept', other: 2 })
    await expect(local.get(`${SYNC_KEY_PREFIX}theme`)).resolves.toEqual({})
    await expect(local.get([`${SYNC_KEY_PREFIX}theme`, 'plain'])).resolves.toEqual({
      plain: 'kept'
    })
    await expect(local.get({ [`${SYNC_KEY_PREFIX}theme`]: 'x', other: 0 })).resolves.toEqual({
      other: 2
    })
    await expect(local.getKeys()).resolves.toEqual(['plain', 'other'])
    await expect(local.getBytesInUse(null)).resolves.toBe(
      'plain'.length + '"kept"'.length + 'other'.length + 1
    )
    await expect(local.getBytesInUse([`${SYNC_KEY_PREFIX}theme`, 'other'])).resolves.toBe(
      'other'.length + 1
    )
    await local.remove([`${SYNC_KEY_PREFIX}theme`, 'other'])
    expect(native.items[`${SYNC_KEY_PREFIX}theme`]).toBe('dark')
    expect(native.items.other).toBeUndefined()
    await local.clear()
    expect(Object.keys(native.items).sort()).toEqual([`${SYNC_KEY_PREFIX}theme`, SYNC_OUTBOX_KEY])
    await expect(native.chrome.storage.sync.get(null)).resolves.toEqual({ theme: 'dark' })
  })

  it('leaves a working native sync alone and forwards to it', async () => {
    native = fakeNative({ nativeSync: true })
    root = { chrome: native.chrome }
    const nativeSync = native.chrome.storage.sync
    const nativeGet = vi.spyOn(nativeSync, 'get')
    expect(installContentScriptStorage(root)).toEqual({ installed: true })
    const sync = native.chrome.storage.sync
    await sync.set({ theme: 'dark' })
    await expect(sync.get(null)).resolves.toEqual({ theme: 'dark' })
    expect(nativeGet).toHaveBeenCalled()
    expect(native.sent).toEqual([])
    expect(native.items).toEqual({})
    // Listeners registered on the polyfill's event went to the native one.
    const onSync = vi.fn()
    sync.onChanged.addListener(onSync)
    expect(nativeSync.onChanged.hasListener(onSync)).toBe(true)
  })

  it('polyfills when the native sync answers with the engine error', async () => {
    native = fakeNative({ syncError: '"sync" is not available in this instance of Chrome' })
    root = { chrome: native.chrome }
    installContentScriptStorage(root)
    answeringShim(native)
    const { sync } = native.chrome.storage
    await sync.set({ theme: 'dark' })
    expect(native.sent).toHaveLength(1)
    expect(native.items[`${SYNC_KEY_PREFIX}theme`]).toBe('dark')
    await expect(sync.get('theme')).resolves.toEqual({ theme: 'dark' })
  })

  it('serves the browser global when it has a storage of its own', async () => {
    const browser: Any = { storage: { local: native.chrome.storage.local } }
    root = { chrome: native.chrome, browser }
    installContentScriptStorage(root)
    expect(browser.storage.sync).toBe(native.chrome.storage.sync)
    expect(browser.storage.managed).toBe(native.chrome.storage.managed)
    native.items[`${SYNC_KEY_PREFIX}theme`] = 'dark'
    await expect(browser.storage.local.get(null)).resolves.toEqual({})
  })
})

describe('contentScriptPreludeSource', () => {
  it('is a self-contained script that installs into a fresh world', async () => {
    const native = fakeNative()
    const source = contentScriptPreludeSource()
    expect(source.startsWith('// Zenium content-script storage prelude ')).toBe(true)
    expect(contentScriptPreludeSource()).toBe(source)
    const sandbox: Any = {
      chrome: native.chrome,
      setTimeout,
      clearTimeout,
      console,
      queueMicrotask
    }
    const before = Object.keys(sandbox)
    runInNewContext(source, sandbox)
    expect(Object.keys(sandbox)).toEqual(before)
    expect(typeof native.chrome.storage.sync.get).toBe('function')
    answeringShim(native)
    await native.chrome.storage.sync.set({ theme: 'dark' })
    await expect(native.chrome.storage.sync.get(null)).resolves.toEqual({ theme: 'dark' })
    // Nothing the prelude needs lives outside itself: the source names none of the module's exports.
    expect(source).not.toContain('CONTENT_SCRIPT_PRELUDE_FILE')
    expect(source).not.toContain('preludeDigest')
  })

  it('names the reserved keys the shim and the store pipeline agree on', () => {
    expect(CONTENT_SCRIPT_PRELUDE_FILE).toBe('zenium-storage-prelude.js')
    expect(SYNC_KEY_PREFIX.startsWith(RESERVED_KEY_PREFIX)).toBe(true)
    expect(MANAGED_KEY_PREFIX.startsWith(RESERVED_KEY_PREFIX)).toBe(true)
    expect(SYNC_OUTBOX_KEY.startsWith(RESERVED_KEY_PREFIX)).toBe(true)
    expect(isReservedStorageKey(`${SYNC_KEY_PREFIX}x`)).toBe(true)
    expect(isReservedStorageKey('__zenium')).toBe(false)
    expect(isReservedStorageKey('theme')).toBe(false)
    const source = contentScriptPreludeSource()
    for (const literal of [SYNC_KEY_PREFIX, MANAGED_KEY_PREFIX, SYNC_OUTBOX_KEY, SYNC_CHANNEL]) {
      expect(source).toContain(JSON.stringify(literal))
    }
  })
})
