import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installExtensionApi,
  type EventDelivery,
  type InvokeResult,
  type ShimHost
} from '../api/shim'
import { API_SPEC } from '../api/spec'
import {
  CONTENT_SCRIPT_PRELUDE_FILE,
  MANAGED_KEY_PREFIX,
  SYNC_CHANNEL,
  SYNC_KEY_PREFIX,
  SYNC_OUTBOX_KEY
} from '../api/contentScriptStorage'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke at the patched globals
type Any = any
type Listener = (...args: unknown[]) => unknown
type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>

interface FakeHost extends ShimHost {
  calls: Array<{ namespace: string; method: string; args: unknown[] }>
  notifications: Array<{ kind: string; payload: unknown }>
  push(namespace: string, event: string, ...args: unknown[]): void
  respond: (namespace: string, method: string, args: unknown[]) => InvokeResult
}

function fakeHost(kind: 'frame' | 'worker' = 'worker'): FakeHost {
  let listener:
    ((namespace: string, event: string, args: unknown[], delivery?: EventDelivery) => void) | null =
    null
  const host: FakeHost = {
    kind,
    calls: [],
    notifications: [],
    respond: () => ({ ok: true, value: undefined }),
    invoke(namespace, method, args) {
      host.calls.push({ namespace, method, args })
      return Promise.resolve(host.respond(namespace, method, args))
    },
    notify(kind, payload) {
      host.notifications.push({ kind, payload })
    },
    onEvent(fn) {
      listener = fn
    },
    push(namespace, event, ...args) {
      listener?.(namespace, event, args)
    }
  }
  return host
}

interface NativeEvent {
  addListener: Listener
  removeListener: Listener
  hasListener: Listener
  dispatch: (...args: unknown[]) => unknown[]
  listeners: Set<Listener>
}

function nativeEvent(): NativeEvent {
  const listeners = new Set<Listener>()
  return {
    listeners,
    addListener: (fn: unknown) => {
      listeners.add(fn as Listener)
    },
    removeListener: (fn: unknown) => {
      listeners.delete(fn as Listener)
    },
    hasListener: (fn: unknown) => listeners.has(fn as Listener),
    dispatch: (...args) => [...listeners].map((fn) => fn(...args))
  }
}

interface Natives {
  chrome: Any
  local: Record<string, unknown>
  localChanged: NativeEvent
  storageChanged: NativeEvent
  onMessage: NativeEvent
  scripting: Record<string, ReturnType<typeof vi.fn>>
  tabs: { executeScript: ReturnType<typeof vi.fn> }
}

/** The engine's bindings of an extension context: a `local` with change events, inert `scripting`. */
function installNativeGlobals(manifestVersion: 2 | 3 = 3): Natives {
  const g = globalThis as Any
  const manifest: Record<string, unknown> = {
    manifest_version: manifestVersion,
    name: 'Probe',
    version: '1.0',
    background: manifestVersion === 3 ? { service_worker: 'sw.js' } : { page: 'bg.html' }
  }
  const localChanged = nativeEvent()
  const storageChanged = nativeEvent()
  const local: Record<string, unknown> = {}
  const later = (fn: () => void): void => {
    queueMicrotask(fn)
  }
  const write = (set: Record<string, unknown>, remove: string[]): void => {
    const changes: Changes = {}
    for (const key of remove) {
      if (!(key in local)) continue
      changes[key] = { oldValue: local[key] }
      delete local[key]
    }
    for (const key of Object.keys(set)) {
      const had = key in local
      if (had && JSON.stringify(local[key]) === JSON.stringify(set[key])) continue
      changes[key] = had ? { oldValue: local[key], newValue: set[key] } : { newValue: set[key] }
      local[key] = set[key]
    }
    if (Object.keys(changes).length === 0) return
    localChanged.dispatch(changes)
    storageChanged.dispatch(changes, 'local')
  }
  const area: Any = {
    get(keys: Any, cb: Listener) {
      const out: Record<string, unknown> = {}
      if (keys === null || keys === undefined) Object.assign(out, local)
      else {
        const list =
          typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
        for (const key of list) if (key in local) out[key] = local[key]
      }
      later(() => cb(out))
    },
    set(next: Record<string, unknown>, cb: Listener) {
      write(next, [])
      later(() => cb())
    },
    remove(keys: Any, cb: Listener) {
      write({}, typeof keys === 'string' ? [keys] : keys)
      later(() => cb())
    },
    clear(cb: Listener) {
      write({}, Object.keys(local))
      later(() => cb())
    },
    getBytesInUse(keys: Any, cb: Listener) {
      const list = keys === null ? Object.keys(local) : typeof keys === 'string' ? [keys] : keys
      let total = 0
      for (const key of list)
        if (key in local) total += key.length + JSON.stringify(local[key]).length
      later(() => cb(total))
    },
    getKeys(cb: Listener) {
      later(() => cb(Object.keys(local)))
    },
    onChanged: localChanged
  }
  const answered = (value?: unknown): ReturnType<typeof vi.fn> =>
    vi.fn((...raw: unknown[]) => {
      const cb = raw[raw.length - 1]
      if (typeof cb === 'function') {
        later(() => (cb as Listener)(value))
        return undefined
      }
      return Promise.resolve(value)
    })
  const scripting = {
    registerContentScripts: answered(),
    updateContentScripts: answered(),
    unregisterContentScripts: answered(),
    getRegisteredContentScripts: answered([]),
    executeScript: answered([{ frameId: 0, result: null }])
  }
  const tabs = { executeScript: answered([null]) }
  const onMessage = nativeEvent()
  const chrome: Any = {
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      getManifest: () => manifest,
      getURL: (path: string) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}`,
      sendMessage: vi.fn(),
      onMessage,
      onInstalled: nativeEvent(),
      onStartup: nativeEvent()
    },
    storage: {
      local: area,
      session: { ...area, onChanged: nativeEvent() },
      onChanged: storageChanged
    },
    scripting: { ...scripting },
    tabs: { ...tabs, query: vi.fn(), onUpdated: nativeEvent() }
  }
  Object.defineProperty(g, 'chrome', { value: chrome, configurable: true, writable: true })
  // The engine's own functions, kept apart from the members the shim replaces on `chrome`.
  return { chrome, local, localChanged, storageChanged, onMessage, scripting, tabs }
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

const PRELUDE = CONTENT_SCRIPT_PRELUDE_FILE
const TARGET = { tabId: 3 }

/** A host whose `storage.sync` holds `items`, answering the mirror snapshot and proxied writes. */
function syncHost(host: FakeHost, items: Record<string, unknown>, managed = {}): { seq: number } {
  const state = { seq: 3 }
  host.respond = (namespace, method, args) => {
    if (namespace !== 'storage') return { ok: true, value: undefined }
    if (method === 'syncMirror')
      return { ok: true, value: { seq: state.seq, sync: { ...items }, managed } }
    if (method === 'syncWrite') {
      const [op, list] = args as [string, unknown[]]
      const changes: Changes = {}
      if (op === 'set') {
        const next = list[0] as Record<string, unknown>
        for (const key of Object.keys(next)) {
          if (key in items) changes[key] = { oldValue: items[key], newValue: next[key] }
          else changes[key] = { newValue: next[key] }
          items[key] = next[key]
        }
      } else if (op === 'remove') {
        for (const key of Array.isArray(list[0]) ? list[0] : [list[0]]) {
          if (!(key in items)) continue
          changes[key] = { oldValue: items[key] }
          delete items[key]
        }
      } else if (op === 'clear') {
        for (const key of Object.keys(items)) {
          changes[key] = { oldValue: items[key] }
          delete items[key]
        }
      }
      if (Object.keys(changes).length === 0) return { ok: true, value: { seq: state.seq } }
      state.seq += 1
      return { ok: true, value: { seq: state.seq, sync: changes } }
    }
    return { ok: true, value: undefined }
  }
  return state
}

describe('the shim without a storage prelude', () => {
  const g = globalThis as Any
  let natives: Natives
  let host: FakeHost

  beforeEach(() => {
    natives = installNativeGlobals()
    host = fakeHost()
  })

  afterEach(() => {
    delete g.chrome
    delete g.browser
    vi.restoreAllMocks()
  })

  it('leaves scripting, runtime.onMessage and the mirror alone', async () => {
    const nativeAdd = natives.onMessage.addListener
    installExtensionApi(host, API_SPEC)
    await flush()
    expect(host.calls.filter((c) => c.namespace === 'storage')).toEqual([])
    expect(host.notifications.map((n) => n.kind)).not.toContain('listen')
    expect(g.chrome.runtime.onMessage.addListener).toBe(nativeAdd)
    const scripts = [{ id: 'a', js: ['a.js'], matches: ['<all_urls>'] }]
    await g.chrome.scripting.registerContentScripts(scripts)
    expect(natives.scripting.registerContentScripts).toHaveBeenCalledWith(scripts)
    await g.chrome.scripting.executeScript({ target: TARGET, files: ['x.js'] })
    expect(natives.scripting.executeScript).toHaveBeenCalledWith({
      target: TARGET,
      files: ['x.js']
    })
  })

  it('still keeps the reserved keys out of what the extension sees of local', async () => {
    natives.local[`${SYNC_KEY_PREFIX}theme`] = 'dark'
    natives.local[SYNC_OUTBOX_KEY] = []
    natives.local.plain = 1
    installExtensionApi(host, API_SPEC)
    const { local } = g.chrome.storage
    await expect(local.get(null)).resolves.toEqual({ plain: 1 })
    await expect(local.get([`${SYNC_KEY_PREFIX}theme`, 'plain'])).resolves.toEqual({ plain: 1 })
    await expect(local.getKeys()).resolves.toEqual(['plain'])
    await expect(local.getBytesInUse(null)).resolves.toBe('plain'.length + 1)
    await local.set({ [`${SYNC_KEY_PREFIX}theme`]: 'light', other: 2 })
    expect(natives.local[`${SYNC_KEY_PREFIX}theme`]).toBe('dark')
    await local.remove([`${SYNC_KEY_PREFIX}theme`, 'other'])
    expect(natives.local[`${SYNC_KEY_PREFIX}theme`]).toBe('dark')
    expect(natives.local.other).toBeUndefined()
    await local.clear()
    expect(Object.keys(natives.local).sort()).toEqual([`${SYNC_KEY_PREFIX}theme`, SYNC_OUTBOX_KEY])
  })

  it('filters the reserved keys out of the engine change events a document gets', () => {
    natives = installNativeGlobals()
    host = fakeHost('frame')
    installExtensionApi(host, API_SPEC)
    const onAny = vi.fn()
    const onLocal = vi.fn()
    g.chrome.storage.onChanged.addListener(onAny)
    g.chrome.storage.local.onChanged.addListener(onLocal)
    natives.storageChanged.dispatch({ [`${SYNC_KEY_PREFIX}theme`]: { newValue: 'dark' } }, 'local')
    natives.localChanged.dispatch({ [`${SYNC_KEY_PREFIX}theme`]: { newValue: 'dark' } })
    expect(onAny).not.toHaveBeenCalled()
    expect(onLocal).not.toHaveBeenCalled()
    natives.storageChanged.dispatch(
      { [`${SYNC_KEY_PREFIX}theme`]: { newValue: 'dark' }, plain: { newValue: 1 } },
      'local'
    )
    natives.localChanged.dispatch({
      [`${SYNC_KEY_PREFIX}theme`]: { newValue: 'x' },
      plain: { newValue: 1 }
    })
    expect(onAny).toHaveBeenCalledWith({ plain: { newValue: 1 } }, 'local')
    expect(onLocal).toHaveBeenCalledWith({ plain: { newValue: 1 } })
    g.chrome.storage.onChanged.removeListener(onAny)
    g.chrome.storage.local.onChanged.removeListener(onLocal)
    expect(natives.storageChanged.listeners.size).toBe(0)
    expect(natives.localChanged.listeners.size).toBe(0)
  })
})

describe('the shim with a storage prelude', () => {
  const g = globalThis as Any
  let natives: Natives
  let host: FakeHost

  beforeEach(() => {
    natives = installNativeGlobals()
    host = fakeHost()
  })

  afterEach(() => {
    delete g.chrome
    delete g.browser
    vi.restoreAllMocks()
  })

  it('takes the host snapshot into the partition mirror and listens for changes', async () => {
    natives.local[`${SYNC_KEY_PREFIX}stale`] = 'gone'
    natives.local[`${SYNC_KEY_PREFIX}theme`] = 'old'
    natives.local.plain = 1
    syncHost(host, { theme: 'dark', size: 2 }, { policy: true })
    installExtensionApi(host, API_SPEC, { storagePrelude: PRELUDE })
    await flush()
    expect(host.calls.filter((c) => c.namespace === 'storage').map((c) => c.method)).toEqual([
      'syncMirror'
    ])
    expect(natives.local).toEqual({
      plain: 1,
      [`${SYNC_KEY_PREFIX}theme`]: 'dark',
      [`${SYNC_KEY_PREFIX}size`]: 2,
      [`${MANAGED_KEY_PREFIX}policy`]: true
    })
    const hello = host.notifications.findIndex((n) => n.kind === 'hello')
    const listen = host.notifications.findIndex(
      (n) => n.kind === 'listen' && (n.payload as Any).event === '__zen.sync-mirror'
    )
    expect(hello).toBeGreaterThanOrEqual(0)
    expect(listen).toBeGreaterThan(hello)
    // What the extension sees of local is unchanged by the mirror.
    await expect(g.chrome.storage.local.get(null)).resolves.toEqual({ plain: 1 })
  })

  it('applies the host changes in sequence and takes the snapshot again after a gap', async () => {
    const state = syncHost(host, { theme: 'dark' })
    installExtensionApi(host, API_SPEC, { storagePrelude: PRELUDE })
    await flush()
    host.push('__zen', 'sync-mirror', {
      seq: 4,
      sync: { theme: { oldValue: 'dark', newValue: 'light' }, added: { newValue: [1] } }
    })
    await flush()
    expect(natives.local).toEqual({
      [`${SYNC_KEY_PREFIX}theme`]: 'light',
      [`${SYNC_KEY_PREFIX}added`]: [1]
    })
    // Already applied, or older: ignored.
    host.push('__zen', 'sync-mirror', { seq: 4, sync: { theme: { newValue: 'again' } } })
    host.push('__zen', 'sync-mirror', { seq: 2, sync: { theme: { newValue: 'older' } } })
    await flush()
    expect(natives.local[`${SYNC_KEY_PREFIX}theme`]).toBe('light')
    host.push('__zen', 'sync-mirror', { seq: 5, sync: { added: { oldValue: [1] } } })
    await flush()
    expect(natives.local[`${SYNC_KEY_PREFIX}added`]).toBeUndefined()
    // A skipped number means a missed delivery: the snapshot wins.
    state.seq = 7
    host.push('__zen', 'sync-mirror', { seq: 7, sync: { theme: { newValue: 'skipped' } } })
    await flush()
    expect(host.calls.filter((c) => c.method === 'syncMirror')).toHaveLength(2)
    expect(natives.local).toEqual({ [`${SYNC_KEY_PREFIX}theme`]: 'dark' })
    host.push('__zen', 'sync-mirror', { seq: 8, managed: { policy: { newValue: 1 } } })
    await flush()
    expect(natives.local[`${MANAGED_KEY_PREFIX}policy`]).toBe(1)
  })

  it('answers the prelude writes on the channel, after the mirror has them, hiding them from the extension', async () => {
    const items: Record<string, unknown> = { theme: 'dark' }
    syncHost(host, items)
    installExtensionApi(host, API_SPEC, { storagePrelude: PRELUDE })
    await flush()
    const extensionListener = vi.fn(() => 'handled')
    g.chrome.runtime.onMessage.addListener(extensionListener)
    expect(g.chrome.runtime.onMessage.hasListener(extensionListener)).toBe(true)
    expect(natives.onMessage.listeners.has(extensionListener)).toBe(false)
    // The shim's answer and the extension's proxy.
    expect(natives.onMessage.listeners.size).toBe(2)

    const sendResponse = vi.fn()
    const results = natives.onMessage.dispatch(
      { __zenium: SYNC_CHANNEL, op: 'set', args: [{ theme: 'light', size: 3 }] },
      { id: g.chrome.runtime.id },
      sendResponse
    )
    expect(extensionListener).not.toHaveBeenCalled()
    expect(results).toContain(true)
    await flush()
    expect(host.calls.filter((c) => c.method === 'syncWrite')).toEqual([
      { namespace: 'storage', method: 'syncWrite', args: ['set', [{ theme: 'light', size: 3 }]] }
    ])
    expect(sendResponse).toHaveBeenCalledWith({ __zenium: SYNC_CHANNEL, ok: true })
    expect(natives.local).toEqual({
      [`${SYNC_KEY_PREFIX}theme`]: 'light',
      [`${SYNC_KEY_PREFIX}size`]: 3
    })
    expect(items).toEqual({ theme: 'light', size: 3 })

    const refused = vi.fn()
    host.respond = () => ({ ok: false, error: 'QUOTA_BYTES quota exceeded' })
    natives.onMessage.dispatch(
      { __zenium: SYNC_CHANNEL, op: 'set', args: [{ big: 1 }] },
      {},
      refused
    )
    await flush()
    expect(refused).toHaveBeenCalledWith({
      __zenium: SYNC_CHANNEL,
      ok: false,
      error: 'QUOTA_BYTES quota exceeded'
    })

    // Other messages reach the extension unchanged, with its answer kept.
    const sender = { tab: { id: 1 } }
    const plain = natives.onMessage.dispatch({ hello: 1 }, sender, sendResponse)
    expect(extensionListener).toHaveBeenCalledWith({ hello: 1 }, sender, sendResponse)
    expect(plain).toContain('handled')
    g.chrome.runtime.onMessage.removeListener(extensionListener)
    expect(g.chrome.runtime.onMessage.hasListener(extensionListener)).toBe(false)
    expect(natives.onMessage.listeners.size).toBe(1)
  })

  it('does not answer from a document that is not the background when the extension has one', async () => {
    natives = installNativeGlobals()
    host = fakeHost('frame')
    syncHost(host, {})
    installExtensionApi(host, API_SPEC, { storagePrelude: PRELUDE })
    await flush()
    expect(natives.onMessage.listeners.size).toBe(0)
    const fn = vi.fn()
    g.chrome.runtime.onMessage.addListener(fn)
    expect(natives.onMessage.listeners.size).toBe(1)
    natives.onMessage.dispatch({ __zenium: SYNC_CHANNEL, op: 'clear', args: [] }, {}, vi.fn())
    expect(fn).not.toHaveBeenCalled()
    expect(host.calls.filter((c) => c.method === 'syncWrite')).toEqual([])
  })

  it('puts the prelude first in scripting registrations and file injections into isolated worlds', async () => {
    syncHost(host, {})
    installExtensionApi(host, API_SPEC, { storagePrelude: PRELUDE })
    const scripts = [
      { id: 'a', js: ['a.js', 'b.js'], matches: ['<all_urls>'] },
      { id: 'main', js: ['m.js'], world: 'MAIN', matches: ['<all_urls>'] },
      { id: 'css', css: ['c.css'], matches: ['<all_urls>'] },
      { id: 'led', js: [PRELUDE, 'x.js'], matches: ['<all_urls>'] }
    ]
    await g.chrome.scripting.registerContentScripts(scripts)
    expect(natives.scripting.registerContentScripts).toHaveBeenCalledWith([
      { id: 'a', js: [PRELUDE, 'a.js', 'b.js'], matches: ['<all_urls>'] },
      scripts[1],
      scripts[2],
      scripts[3]
    ])
    // The caller's array is not mutated.
    expect(scripts[0].js).toEqual(['a.js', 'b.js'])
    await g.chrome.scripting.updateContentScripts([{ id: 'a', js: ['c.js'] }])
    expect(natives.scripting.updateContentScripts).toHaveBeenCalledWith([
      { id: 'a', js: [PRELUDE, 'c.js'] }
    ])
    natives.scripting.getRegisteredContentScripts.mockImplementation((...raw: unknown[]) => {
      const value = [
        { id: 'a', js: [PRELUDE, 'a.js'] },
        { id: 'css', css: ['c.css'] }
      ]
      const cb = raw[raw.length - 1]
      if (typeof cb === 'function') {
        queueMicrotask(() => (cb as Listener)(value))
        return undefined
      }
      return Promise.resolve(value)
    })
    await expect(g.chrome.scripting.getRegisteredContentScripts()).resolves.toEqual([
      { id: 'a', js: ['a.js'] },
      { id: 'css', css: ['c.css'] }
    ])
    const cb = vi.fn()
    g.chrome.scripting.getRegisteredContentScripts({ ids: ['a'] }, cb)
    await flush()
    expect(cb).toHaveBeenCalledWith([
      { id: 'a', js: ['a.js'] },
      { id: 'css', css: ['c.css'] }
    ])

    await g.chrome.scripting.executeScript({ target: TARGET, files: ['x.js'] })
    expect(natives.scripting.executeScript).toHaveBeenLastCalledWith({
      target: TARGET,
      files: [PRELUDE, 'x.js']
    })
    await g.chrome.scripting.executeScript({ target: TARGET, files: ['x.js'], world: 'MAIN' })
    expect(natives.scripting.executeScript).toHaveBeenLastCalledWith({
      target: TARGET,
      files: ['x.js'],
      world: 'MAIN'
    })
  })

  it('injects the prelude before a function injection that mentions storage', async () => {
    syncHost(host, {})
    installExtensionApi(host, API_SPEC, { storagePrelude: PRELUDE })
    const reads = (): unknown => (globalThis as Any).chrome.storage.sync.get(null)
    const plain = (): string => document.title
    const result = await g.chrome.scripting.executeScript({
      target: TARGET,
      func: reads,
      args: [1],
      injectImmediately: true
    })
    expect(result).toEqual([{ frameId: 0, result: null }])
    const calls = natives.scripting.executeScript.mock.calls.map((c: unknown[]) => c[0])
    expect(calls).toEqual([
      { target: TARGET, files: [PRELUDE], injectImmediately: true },
      { target: TARGET, func: reads, args: [1], injectImmediately: true }
    ])
    natives.scripting.executeScript.mockClear()
    await g.chrome.scripting.executeScript({ target: TARGET, func: plain })
    expect(natives.scripting.executeScript).toHaveBeenCalledTimes(1)
    expect(natives.scripting.executeScript).toHaveBeenCalledWith({ target: TARGET, func: plain })
    natives.scripting.executeScript.mockClear()
    const cb = vi.fn()
    g.chrome.scripting.executeScript({ target: TARGET, func: reads }, cb)
    await flush()
    expect(natives.scripting.executeScript).toHaveBeenCalledTimes(2)
    expect(cb).toHaveBeenCalledWith([{ frameId: 0, result: null }])
  })

  it('injects the prelude before MV2 tabs.executeScript files and storage code', async () => {
    natives = installNativeGlobals(2)
    host = fakeHost('frame')
    syncHost(host, {})
    installExtensionApi(host, API_SPEC, { storagePrelude: PRELUDE })
    const native = natives.tabs.executeScript
    await g.chrome.tabs.executeScript(7, { file: 'x.js', allFrames: true, runAt: 'document_end' })
    expect(native.mock.calls.map((c: unknown[]) => c.slice(0, 2))).toEqual([
      [7, { file: PRELUDE, allFrames: true, runAt: 'document_end' }],
      [7, { file: 'x.js', allFrames: true, runAt: 'document_end' }]
    ])
    native.mockClear()
    const cb = vi.fn()
    g.chrome.tabs.executeScript({ code: 'chrome.storage.sync.get(null, console.log)' }, cb)
    await flush()
    expect(native.mock.calls.map((c: unknown[]) => c.slice(0, 1))).toEqual([
      [{ file: PRELUDE }],
      [{ code: 'chrome.storage.sync.get(null, console.log)' }]
    ])
    expect(cb).toHaveBeenCalledWith([null])
    native.mockClear()
    await g.chrome.tabs.executeScript(7, { code: 'document.title' })
    expect(native).toHaveBeenCalledTimes(1)
    expect(native.mock.calls[0].slice(0, 2)).toEqual([7, { code: 'document.title' }])
  })

  it('flushes the outbox a content script left before taking the snapshot', async () => {
    natives.local[SYNC_OUTBOX_KEY] = [
      { op: 'set', args: [{ theme: 'offline' }] },
      { op: 'remove', args: ['gone'] }
    ]
    natives.local[`${SYNC_KEY_PREFIX}theme`] = 'offline'
    const items: Record<string, unknown> = { theme: 'dark', gone: 1 }
    syncHost(host, items)
    installExtensionApi(host, API_SPEC, { storagePrelude: PRELUDE })
    await flush()
    expect(host.calls.filter((c) => c.namespace === 'storage').map((c) => c.method)).toEqual([
      'syncWrite',
      'syncWrite',
      'syncMirror'
    ])
    expect(items).toEqual({ theme: 'offline' })
    expect(natives.local).toEqual({ [`${SYNC_KEY_PREFIX}theme`]: 'offline' })
  })
})
