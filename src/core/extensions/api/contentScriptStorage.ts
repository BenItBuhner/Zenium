/**
 * The content-script storage prelude: `chrome.storage.sync` and `chrome.storage.managed` for an
 * extension's own content-script world, where Electron's native `storage` binding has `local`
 * only (`"sync" is not available in this instance of Chrome`).
 *
 * The store pipeline serialises `installContentScriptStorage` into a file in the extension's
 * install directory (`CONTENT_SCRIPT_PRELUDE_FILE`) and puts that file first in every
 * `content_scripts[].js` list of the manifest Electron loads; the shim does the same for
 * `scripting` injections. The prelude then runs before the extension's scripts, in their world,
 * with the same native `chrome.storage.local`, and installs `sync` and `managed` as a polyfill
 * over reserved keys of `local`:
 *
 *     __zenium_sync__/<key>       a `sync` item, mirrored from the host's `storage.sync`
 *     __zenium_managed__/<key>    a `managed` item (read-only policy values)
 *     __zenium_sync__             the mirror's bookkeeping (the host's sequence number)
 *     __zenium_sync_outbox__      writes made while no extension context could relay them
 *
 * Reads come from the mirror; writes go to the host through `runtime.sendMessage` on a reserved
 * channel the shim answers from the extension's worker or background page (the host commits,
 * fans `onChanged` out to pages and workers, and the answering shim writes the change into this
 * partition's `local` before it replies, so a read after a write sees it). `onChanged` for the
 * polyfilled areas derives from native `local.onChanged`, filtered to the reserved keys, and the
 * reserved keys are hidden from what the extension sees of `local`.
 *
 * The prelude also gives the world Chrome's `chrome.extension` (`inIncognitoContext`, and an MV2
 * extension's `getURL`), which Electron's content-script bindings leave out and extensions test
 * for to know they run inside an extension; that part needs no `storage` permission.
 *
 * Like the shim, the function is self-contained (no free variables besides globals): it is
 * stringified into the prelude file. The constants it spells out are exported below for the
 * shim's host side and the tests.
 */

/** File name of the prelude in an extension's install directory. */
export const CONTENT_SCRIPT_PRELUDE_FILE = 'zenium-storage-prelude.js'

/** Every reserved `chrome.storage.local` key of the layer starts with this. */
export const RESERVED_KEY_PREFIX = '__zenium_'
export const SYNC_KEY_PREFIX = '__zenium_sync__/'
export const MANAGED_KEY_PREFIX = '__zenium_managed__/'
export const SYNC_META_KEY = '__zenium_sync__'
export const SYNC_OUTBOX_KEY = '__zenium_sync_outbox__'
/** The `runtime.sendMessage` marker of a content script's proxied `sync` write. */
export const SYNC_CHANNEL = 'zenium:storage.sync'

export function isReservedStorageKey(key: string): boolean {
  return key.startsWith(RESERVED_KEY_PREFIX)
}

export interface ContentScriptStorageDiagnostics {
  installed: boolean
  reason?: 'no-storage' | 'already-installed' | 'not-configurable'
}

/**
 * The engine's objects the prelude patches in place (`chrome`, `chrome.storage`, its areas and
 * their native members). Values that come from extensions are `unknown` and narrowed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the prelude reflects over untyped globals
type Any = any

export function installContentScriptStorage(root?: object): ContentScriptStorageDiagnostics {
  const g: Any = root ?? globalThis
  const MARK = '__zeniumContentScriptStorage'
  const RESERVED = '__zenium_'
  const SYNC_PREFIX = '__zenium_sync__/'
  const MANAGED_PREFIX = '__zenium_managed__/'
  const OUTBOX = '__zenium_sync_outbox__'
  const CHANNEL = 'zenium:storage.sync'
  const READ_ONLY = 'This is a read-only store.'
  const PROBE_TIMEOUT = 1000
  const OUTBOX_LIMIT = 200
  const SYNC_CONSTANTS: Record<string, number> = {
    QUOTA_BYTES: 102400,
    QUOTA_BYTES_PER_ITEM: 8192,
    MAX_ITEMS: 512,
    MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
    MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
    MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1000000
  }

  type Listener = (...args: unknown[]) => unknown
  type Items = Record<string, unknown>
  type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>
  type Callback = (...args: unknown[]) => void

  const chrome: Any = g.chrome
  if (!chrome || typeof chrome !== 'object') return { installed: false, reason: 'no-storage' }
  const runtime: Any = safely(() => chrome.runtime)
  // Chrome's content scripts have `chrome.extension` with `inIncognitoContext` (an MV2 one its
  // `getURL` too); the engine's isolated world carries no `extension` binding, and extensions
  // test `typeof chrome.extension === 'object'` to know they run inside an extension at all
  // (Klarna's content script falls through to `tabs.getCurrent` otherwise). Before the storage
  // layer, which needs the `storage` permission: this needs none.
  installExtensionNamespace()
  const storage: Any = safely(() => chrome.storage)
  const local: Any = storage && typeof storage === 'object' ? safely(() => storage.local) : null
  if (
    !local ||
    typeof local !== 'object' ||
    typeof local.get !== 'function' ||
    typeof local.set !== 'function'
  ) {
    return { installed: false, reason: 'no-storage' }
  }
  if (storage[MARK]) return { installed: false, reason: 'already-installed' }

  function installExtensionNamespace(): void {
    if (safely(() => chrome.extension) !== undefined) return
    const extension: Record<string, unknown> = {
      // The shim's value for every context: extensions never run in a private window here.
      inIncognitoContext: false
    }
    const manifest: unknown = runtime ? safely(() => runtime.getManifest()) : undefined
    const manifestVersion =
      manifest && typeof manifest === 'object'
        ? (manifest as Record<string, unknown>).manifest_version
        : undefined
    if (manifestVersion === 2 && runtime && typeof runtime.getURL === 'function') {
      extension.getURL = (path: unknown): unknown => runtime.getURL(path)
    }
    define(chrome, 'extension', extension)
    const browser: unknown = safely(() => g.browser)
    if (
      browser &&
      typeof browser === 'object' &&
      browser !== chrome &&
      safely(() => (browser as Record<string, unknown>).extension) === undefined
    ) {
      define(browser, 'extension', extension)
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function safely<T>(fn: () => T): T | undefined {
    try {
      return fn()
    } catch {
      return undefined
    }
  }

  function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }

  function isFunction(value: unknown): value is Listener {
    return typeof value === 'function'
  }

  function hasOwn(target: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(target, key)
  }

  function isReserved(key: string): boolean {
    return key.startsWith(RESERVED)
  }

  function define(target: object, key: string, value: unknown): boolean {
    try {
      Object.defineProperty(target, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: true
      })
      return true
    } catch {
      try {
        ;(target as Record<string, unknown>)[key] = value
        return (target as Record<string, unknown>)[key] === value
      } catch {
        return false
      }
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

  /** Chrome measures an item as the key length plus the length of its JSON serialisation. */
  function bytesOf(items: Items): number {
    let total = 0
    for (const key of Object.keys(items)) total += key.length + jsonLength(items[key])
    return total
  }

  /** Values as Chrome stores them: JSON round-tripped (functions and undefined disappear). */
  function normalizeItems(items: Record<string, unknown>): Items {
    const out: Items = {}
    for (const key of Object.keys(items)) {
      const value = items[key]
      if (value === undefined || typeof value === 'function' || typeof value === 'symbol') continue
      try {
        out[key] = JSON.parse(JSON.stringify(value))
      } catch {
        /* not serialisable: dropped, as Chrome drops it */
      }
    }
    return out
  }

  function takeCallback(raw: unknown[]): Callback | undefined {
    if (raw.length > 0 && typeof raw[raw.length - 1] === 'function') {
      return raw.pop() as Callback
    }
    return undefined
  }

  function signatureError(qualified: string): TypeError {
    return new TypeError(`Error in invocation of ${qualified}: No matching signature.`)
  }

  // runtime.lastError exists only while an error callback runs, then goes away – what Chrome's
  // binding does, so the native members keep working alongside.
  let lastErrorDepth = 0
  function withLastError(qualified: string, message: string, fn: () => void): void {
    const target: unknown = runtime
    const error = { message }
    let checked = false
    if (target && typeof target === 'object') {
      try {
        Object.defineProperty(target, 'lastError', {
          get: () => {
            checked = true
            return error
          },
          configurable: true,
          enumerable: true
        })
      } catch {
        /* not configurable */
      }
    }
    lastErrorDepth += 1
    try {
      fn()
    } finally {
      lastErrorDepth -= 1
      if (lastErrorDepth === 0) {
        if (target && typeof target === 'object')
          safely(() => Reflect.deleteProperty(target, 'lastError'))
        if (!checked)
          safely(() => console.error(`Unchecked runtime.lastError: ${message} (${qualified})`))
      }
    }
  }

  /** Callback-or-promise: with a callback, failures are reported through runtime.lastError. */
  function settle(
    qualified: string,
    promise: Promise<unknown>,
    callback: Callback | undefined
  ): Promise<unknown> | undefined {
    if (!callback) return promise
    promise.then(
      (value) => {
        try {
          if (value === undefined) callback()
          else callback(value)
        } catch (error) {
          setTimeout(() => {
            throw error
          }, 0)
        }
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        withLastError(qualified, message, () => {
          try {
            callback()
          } catch (thrown) {
            setTimeout(() => {
              throw thrown
            }, 0)
          }
        })
      }
    )
    return undefined
  }

  // ---------------------------------------------------------------------------
  // The native `local` area, captured before it is wrapped
  // ---------------------------------------------------------------------------

  const nativeGet: Listener = local.get
  const nativeSet: Listener = local.set
  const nativeRemove: Listener | undefined = isFunction(local.remove) ? local.remove : undefined
  const nativeClear: Listener | undefined = isFunction(local.clear) ? local.clear : undefined
  const nativeBytes: Listener | undefined = isFunction(local.getBytesInUse)
    ? local.getBytesInUse
    : undefined
  const nativeKeys: Listener | undefined = isFunction(local.getKeys) ? local.getKeys : undefined

  /** The engine's callback-style method, awaited; `runtime.lastError` becomes the rejection. */
  function callNative(method: Listener | undefined, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!method) {
        reject(new Error('storage.local is not available.'))
        return
      }
      try {
        method.call(local, ...args, (result: unknown) => {
          const error: unknown = runtime ? safely(() => runtime.lastError) : undefined
          if (error) {
            reject(new Error(String(isObject(error) && error.message ? error.message : error)))
          } else resolve(result)
        })
      } catch (error) {
        reject(error)
      }
    })
  }

  async function readLocal(keys: unknown): Promise<Items> {
    const items = await callNative(nativeGet, [keys])
    return isObject(items) ? items : {}
  }

  function stripReserved(items: Items): Items {
    const out: Items = {}
    for (const key of Object.keys(items)) if (!isReserved(key)) out[key] = items[key]
    return out
  }

  // ---------------------------------------------------------------------------
  // Feature detection: a working native `sync` is left alone
  // ---------------------------------------------------------------------------

  const nativeSync: Any = safely(() => storage.sync)
  const nativeManaged: Any = safely(() => storage.managed)
  let mode: 'probing' | 'native' | 'polyfill' = 'probing'
  const probe: Promise<void> = new Promise((resolve) => {
    let settled = false
    const done = (native: boolean): void => {
      if (settled) return
      settled = true
      mode = native ? 'native' : 'polyfill'
      resolve()
    }
    if (!nativeSync || typeof nativeSync !== 'object' || !isFunction(nativeSync.get)) {
      done(false)
      return
    }
    try {
      nativeSync.get.call(nativeSync, null, () => {
        const error: unknown = runtime ? safely(() => runtime.lastError) : undefined
        done(!error)
      })
      setTimeout(() => done(false), PROBE_TIMEOUT)
    } catch {
      done(false)
    }
  })

  // ---------------------------------------------------------------------------
  // Events derived from native `local.onChanged`
  // ---------------------------------------------------------------------------

  interface EventObject {
    addListener(fn: unknown): void
    removeListener(fn: unknown): void
    hasListener(fn: unknown): boolean
    hasListeners(): boolean
    dispatch(...args: unknown[]): void
  }

  function isNativeEvent(
    value: unknown
  ): value is { addListener: Listener; removeListener: Listener } {
    return isObject(value) && isFunction(value.addListener) && isFunction(value.removeListener)
  }

  function defineRuleMembers(object: object): void {
    define(object, 'addRules', () => undefined)
    define(object, 'getRules', (...raw: unknown[]) => {
      const cb = takeCallback(raw)
      if (cb) cb([])
    })
    define(object, 'removeRules', (...raw: unknown[]) => {
      const cb = takeCallback(raw)
      if (cb) cb()
    })
  }

  /** An area's `onChanged`: this side's listeners, or the native event's once `mode` is native. */
  function areaEvent(native: unknown): EventObject {
    const listeners = new Set<Listener>()
    const forwarded = new Set<Listener>()
    const forward = (): void => {
      if (mode !== 'native' || !isNativeEvent(native)) return
      for (const fn of listeners) {
        listeners.delete(fn)
        forwarded.add(fn)
        safely(() => native.addListener(fn))
      }
    }
    void probe.then(forward)
    const object: EventObject = {
      addListener(fn: unknown): void {
        if (!isFunction(fn)) return
        if (mode === 'native' && isNativeEvent(native)) {
          forwarded.add(fn)
          safely(() => native.addListener(fn))
          return
        }
        listeners.add(fn)
      },
      removeListener(fn: unknown): void {
        if (!isFunction(fn)) return
        listeners.delete(fn)
        if (forwarded.delete(fn) && isNativeEvent(native)) safely(() => native.removeListener(fn))
      },
      hasListener(fn: unknown): boolean {
        return isFunction(fn) && (listeners.has(fn) || forwarded.has(fn))
      },
      hasListeners(): boolean {
        return listeners.size > 0 || forwarded.size > 0
      },
      dispatch(...args: unknown[]): void {
        for (const fn of [...listeners]) {
          try {
            fn(...args)
          } catch (error) {
            setTimeout(() => {
              throw error
            }, 0)
          }
        }
      }
    }
    defineRuleMembers(object)
    return object
  }

  const syncChanged = areaEvent(
    nativeSync && typeof nativeSync === 'object' ? nativeSync.onChanged : undefined
  )
  const managedChanged = areaEvent(
    nativeManaged && typeof nativeManaged === 'object' ? nativeManaged.onChanged : undefined
  )

  /** Native `local` changes split into what the extension sees of local, sync and managed. */
  function splitChanges(changes: Changes): { plain: Changes; sync: Changes; managed: Changes } {
    const plain: Changes = {}
    const sync: Changes = {}
    const managed: Changes = {}
    for (const key of Object.keys(changes)) {
      if (key.startsWith(SYNC_PREFIX)) sync[key.slice(SYNC_PREFIX.length)] = changes[key]
      else if (key.startsWith(MANAGED_PREFIX))
        managed[key.slice(MANAGED_PREFIX.length)] = changes[key]
      else if (!isReserved(key)) plain[key] = changes[key]
    }
    return { plain, sync, managed }
  }

  function hasKeys(record: object): boolean {
    return Object.keys(record).length > 0
  }

  // The source of every derived event: `local.onChanged` when the engine has the per-area event,
  // else `storage.onChanged` filtered to the local area. Registered before the wrappers below
  // take over `addListener`.
  const nativeLocalChanged: unknown = safely(() => local.onChanged)
  const nativeStorageChanged: unknown = safely(() => storage.onChanged)
  const route = (changes: unknown): void => {
    if (!isObject(changes) || mode === 'native') return
    const split = splitChanges(changes as Changes)
    if (hasKeys(split.sync)) syncChanged.dispatch(split.sync)
    if (hasKeys(split.managed)) managedChanged.dispatch(split.managed)
  }
  if (isNativeEvent(nativeLocalChanged)) {
    safely(() => nativeLocalChanged.addListener((changes: unknown) => route(changes)))
  } else if (isNativeEvent(nativeStorageChanged)) {
    safely(() =>
      nativeStorageChanged.addListener((changes: unknown, area: unknown) => {
        if (area === 'local') route(changes)
      })
    )
  }

  // ---------------------------------------------------------------------------
  // The transport for writes: the extension's own worker or background page, over
  // `runtime.sendMessage`; the mirror in this partition when no context can answer
  // ---------------------------------------------------------------------------

  type Reply = { ok: true } | { ok: false; error: string }

  /** Null when nothing answered on the channel (no receiver, or not the shim). */
  function send(op: string, args: unknown[]): Promise<Reply | null> {
    return new Promise((resolve) => {
      if (!runtime || !isFunction(runtime.sendMessage)) {
        resolve(null)
        return
      }
      try {
        runtime.sendMessage({ __zenium: CHANNEL, op, args }, (response: unknown) => {
          const error: unknown = safely(() => runtime.lastError)
          if (error || !isObject(response) || response.__zenium !== CHANNEL) {
            resolve(null)
            return
          }
          if (response.ok === true) resolve({ ok: true })
          else resolve({ ok: false, error: String(response.error ?? 'Unknown error') })
        })
      } catch {
        resolve(null)
      }
    })
  }

  async function applyLocally(op: string, args: unknown[]): Promise<void> {
    if (op === 'set' && isObject(args[0])) {
      const items: Items = {}
      for (const key of Object.keys(args[0])) items[SYNC_PREFIX + key] = args[0][key]
      if (hasKeys(items)) await callNative(nativeSet, [items])
      return
    }
    if (op === 'remove') {
      const list = typeof args[0] === 'string' ? [args[0]] : Array.isArray(args[0]) ? args[0] : []
      const keys = list
        .filter((k): k is string => typeof k === 'string')
        .map((k) => SYNC_PREFIX + k)
      if (keys.length > 0) await callNative(nativeRemove, [keys])
      return
    }
    if (op === 'clear') {
      const all = await readLocal(null)
      const keys = Object.keys(all).filter((k) => k.startsWith(SYNC_PREFIX))
      if (keys.length > 0) await callNative(nativeRemove, [keys])
    }
  }

  /** No context could relay the write: apply it to the mirror and keep it for the next one. */
  async function fallback(op: string, args: unknown[]): Promise<void> {
    await applyLocally(op, args)
    const stored = await readLocal(OUTBOX)
    const queue: unknown[] = Array.isArray(stored[OUTBOX]) ? [...stored[OUTBOX]] : []
    queue.push({ op, args })
    if (queue.length > OUTBOX_LIMIT) queue.splice(0, queue.length - OUTBOX_LIMIT)
    await callNative(nativeSet, [{ [OUTBOX]: queue }])
  }

  async function write(op: string, args: unknown[]): Promise<void> {
    const reply = await send(op, args)
    if (reply === null) {
      await fallback(op, args)
      return
    }
    if (!reply.ok) throw new Error(reply.error)
  }

  // ---------------------------------------------------------------------------
  // The polyfilled areas
  // ---------------------------------------------------------------------------

  function keysOf(items: Items, prefix: string): Items {
    const out: Items = {}
    for (const key of Object.keys(items)) {
      if (key.startsWith(prefix)) out[key.slice(prefix.length)] = items[key]
    }
    return out
  }

  async function readArea(prefix: string, keys: unknown): Promise<Items> {
    if (keys === null || keys === undefined) return keysOf(await readLocal(null), prefix)
    const list: string[] =
      typeof keys === 'string'
        ? [keys]
        : Array.isArray(keys)
          ? keys.filter((k): k is string => typeof k === 'string')
          : Object.keys(keys as Items)
    const items = await readLocal(list.map((k) => prefix + k))
    const out: Items = {}
    for (const key of list) {
      if (hasOwn(items, prefix + key)) out[key] = items[prefix + key]
      else if (isObject(keys) && hasOwn(keys, key)) out[key] = keys[key]
    }
    return out
  }

  function validKeys(keys: unknown, allowObject: boolean): boolean {
    if (keys === null || keys === undefined || typeof keys === 'string') return true
    if (Array.isArray(keys)) return keys.every((k) => typeof k === 'string')
    return allowObject && isObject(keys)
  }

  function polyfillArea(areaName: string, prefix: string, native: Any, writable: boolean): object {
    const area: Record<string, unknown> = {}
    const qualified = (name: string, params: string): string =>
      `storage.${areaName}.${name}(${params})`

    /** Dispatch on `mode`: the native area once it proved to work, the polyfill otherwise. */
    function method(name: string, impl: (raw: unknown[]) => unknown): void {
      define(area, name, function (...raw: unknown[]): unknown {
        if (mode === 'native' && native && isFunction(native[name])) {
          return native[name](...raw)
        }
        if (mode === 'polyfill') return impl(raw)
        const hasCallback = raw.length > 0 && typeof raw[raw.length - 1] === 'function'
        const later = probe.then(() =>
          mode === 'native' && native && isFunction(native[name]) ? native[name](...raw) : impl(raw)
        )
        if (hasCallback) {
          later.catch(() => undefined)
          return undefined
        }
        return later
      })
    }

    method('get', (raw) => {
      const callback = takeCallback(raw)
      const keys = raw[0]
      const signature = qualified('get', 'optional string|array|object keys')
      if (!validKeys(keys, true)) throw signatureError(signature)
      return settle(signature, readArea(prefix, keys), callback)
    })
    method('set', (raw) => {
      const callback = takeCallback(raw)
      const items = raw[0]
      const signature = qualified('set', 'object items')
      if (!isObject(items)) throw signatureError(signature)
      const work = writable
        ? write('set', [normalizeItems(items)])
        : Promise.reject(new Error(READ_ONLY))
      return settle(signature, work, callback)
    })
    method('remove', (raw) => {
      const callback = takeCallback(raw)
      const keys = raw[0]
      const signature = qualified('remove', 'string|array keys')
      if (keys === null || keys === undefined || !validKeys(keys, false)) {
        throw signatureError(signature)
      }
      const work = writable ? write('remove', [keys]) : Promise.reject(new Error(READ_ONLY))
      return settle(signature, work, callback)
    })
    method('clear', (raw) => {
      const callback = takeCallback(raw)
      const work = writable ? write('clear', []) : Promise.reject(new Error(READ_ONLY))
      return settle(qualified('clear', ''), work, callback)
    })
    method('getBytesInUse', (raw) => {
      const callback = takeCallback(raw)
      const keys = raw[0]
      const signature = qualified('getBytesInUse', 'optional string|array keys')
      if (!validKeys(keys, false)) throw signatureError(signature)
      const work = readArea(prefix, keys).then((items) => bytesOf(items))
      return settle(signature, work, callback)
    })
    method('getKeys', (raw) => {
      const callback = takeCallback(raw)
      const work = readArea(prefix, null).then((items) => Object.keys(items))
      return settle(qualified('getKeys', ''), work, callback)
    })
    method('setAccessLevel', (raw) => {
      const callback = takeCallback(raw)
      const signature = qualified('setAccessLevel', 'object accessOptions')
      if (!isObject(raw[0])) throw signatureError(signature)
      return settle(signature, Promise.resolve(undefined), callback)
    })
    if (areaName === 'sync') {
      for (const key of Object.keys(SYNC_CONSTANTS)) define(area, key, SYNC_CONSTANTS[key])
    }
    define(area, 'onChanged', areaName === 'sync' ? syncChanged : managedChanged)
    return area
  }

  const syncArea = polyfillArea('sync', SYNC_PREFIX, nativeSync, true)
  const managedArea = polyfillArea('managed', MANAGED_PREFIX, nativeManaged, false)
  if (!define(storage, 'sync', syncArea)) return { installed: false, reason: 'not-configurable' }
  define(storage, 'managed', managedArea)
  Object.defineProperty(storage, MARK, { value: true, enumerable: false, configurable: true })

  // ---------------------------------------------------------------------------
  // What the extension sees of `local`: never the reserved keys
  // ---------------------------------------------------------------------------

  function wrapLocal(area: Any): void {
    define(area, 'get', function (...raw: unknown[]): unknown {
      const callback = takeCallback(raw)
      const keys = raw[0]
      if (!validKeys(keys, true))
        throw signatureError('storage.local.get(optional string|array|object keys)')
      const work = (async (): Promise<Items> => {
        let request: unknown = keys
        if (typeof keys === 'string') {
          if (isReserved(keys)) return {}
        } else if (Array.isArray(keys)) {
          request = keys.filter((k) => typeof k === 'string' && !isReserved(k))
        } else if (isObject(keys)) {
          const filtered: Items = {}
          for (const key of Object.keys(keys)) if (!isReserved(key)) filtered[key] = keys[key]
          request = filtered
        }
        return stripReserved(await readLocal(request))
      })()
      return settle('storage.local.get', work, callback)
    })
    define(area, 'set', function (...raw: unknown[]): unknown {
      const callback = takeCallback(raw)
      const items = raw[0]
      if (!isObject(items)) throw signatureError('storage.local.set(object items)')
      const allowed = stripReserved(items)
      const work =
        hasKeys(allowed) || !hasKeys(items) ? callNative(nativeSet, [allowed]) : Promise.resolve()
      return settle(
        'storage.local.set',
        work.then(() => undefined),
        callback
      )
    })
    if (nativeRemove) {
      define(area, 'remove', function (...raw: unknown[]): unknown {
        const callback = takeCallback(raw)
        const keys = raw[0]
        if (keys === null || keys === undefined || !validKeys(keys, false)) {
          throw signatureError('storage.local.remove(string|array keys)')
        }
        const list = (typeof keys === 'string' ? [keys] : (keys as string[])).filter(
          (k) => !isReserved(k)
        )
        const work = list.length > 0 ? callNative(nativeRemove, [list]) : Promise.resolve()
        return settle(
          'storage.local.remove',
          work.then(() => undefined),
          callback
        )
      })
    }
    if (nativeClear && nativeRemove) {
      define(area, 'clear', function (...raw: unknown[]): unknown {
        const callback = takeCallback(raw)
        const work = (async (): Promise<void> => {
          const keys = Object.keys(await readLocal(null)).filter((k) => !isReserved(k))
          if (keys.length > 0) await callNative(nativeRemove, [keys])
        })()
        return settle('storage.local.clear', work, callback)
      })
    }
    if (nativeBytes) {
      define(area, 'getBytesInUse', function (...raw: unknown[]): unknown {
        const callback = takeCallback(raw)
        const keys = raw[0]
        if (!validKeys(keys, false)) {
          throw signatureError('storage.local.getBytesInUse(optional string|array keys)')
        }
        const work =
          keys === null || keys === undefined
            ? readLocal(null).then((items) => bytesOf(stripReserved(items)))
            : callNative(nativeBytes, [
                (typeof keys === 'string' ? [keys] : (keys as string[])).filter(
                  (k) => !isReserved(k)
                )
              ])
        return settle('storage.local.getBytesInUse', work, callback)
      })
    }
    if (nativeKeys) {
      define(area, 'getKeys', function (...raw: unknown[]): unknown {
        const callback = takeCallback(raw)
        const work = callNative(nativeKeys, []).then((keys) =>
          Array.isArray(keys) ? keys.filter((k) => typeof k === 'string' && !isReserved(k)) : []
        )
        return settle('storage.local.getKeys', work, callback)
      })
    }
    const onChanged: unknown = safely(() => area.onChanged)
    if (isNativeEvent(onChanged)) {
      wrapNativeEvent(onChanged, (fn) => (changes: unknown) => {
        if (!isObject(changes)) return fn(changes)
        const plain = splitChanges(changes as Changes).plain
        return hasKeys(plain) ? fn(plain) : undefined
      })
    }
  }

  /**
   * Listeners the extension registers on a native event get wrapped (`removeListener` and
   * `hasListener` follow the mapping) so the reserved keys never reach them.
   */
  function wrapNativeEvent(
    event: { addListener: Listener; removeListener: Listener },
    wrap: (fn: Listener) => Listener
  ): void {
    const wrapped = new WeakMap<Listener, Listener>()
    const nativeAdd: Listener = event.addListener
    const nativeRemoveListener: Listener = event.removeListener
    const nativeHas: unknown = safely(() => (event as Record<string, unknown>).hasListener)
    define(event, 'addListener', function (fn: unknown, ...rest: unknown[]): void {
      if (!isFunction(fn)) return
      let proxy = wrapped.get(fn)
      if (!proxy) {
        proxy = wrap(fn)
        wrapped.set(fn, proxy)
      }
      nativeAdd.call(event, proxy, ...rest)
    })
    define(event, 'removeListener', function (fn: unknown): void {
      if (!isFunction(fn)) return
      const proxy = wrapped.get(fn)
      if (proxy) nativeRemoveListener.call(event, proxy)
    })
    if (isFunction(nativeHas)) {
      define(event, 'hasListener', function (fn: unknown): boolean {
        if (!isFunction(fn)) return false
        const proxy = wrapped.get(fn)
        return proxy ? Boolean(nativeHas.call(event, proxy)) : false
      })
    }
  }

  /** `storage.onChanged(changes, areaName)`: local changes filtered, mirror changes re-aimed. */
  function wrapStorageChanged(event: { addListener: Listener; removeListener: Listener }): void {
    wrapNativeEvent(event, (fn) => (changes: unknown, areaName: unknown) => {
      if (areaName !== 'local' || !isObject(changes)) return fn(changes, areaName)
      const split = splitChanges(changes as Changes)
      if (hasKeys(split.plain)) fn(split.plain, 'local')
      if (mode !== 'native') {
        if (hasKeys(split.sync)) fn(split.sync, 'sync')
        if (hasKeys(split.managed)) fn(split.managed, 'managed')
      }
      return undefined
    })
  }

  wrapLocal(local)
  if (isNativeEvent(nativeStorageChanged)) wrapStorageChanged(nativeStorageChanged)

  // Chromium's `browser` global is a distinct object whose `storage` may or may not be `chrome`'s.
  const browser: Any = safely(() => g.browser)
  const otherStorage: Any =
    browser && typeof browser === 'object' ? safely(() => browser.storage) : null
  if (otherStorage && typeof otherStorage === 'object' && otherStorage !== storage) {
    define(otherStorage, 'sync', syncArea)
    define(otherStorage, 'managed', managedArea)
    const otherLocal: unknown = safely(() => otherStorage.local)
    if (otherLocal && typeof otherLocal === 'object' && otherLocal !== local) wrapLocal(otherLocal)
    const otherChanged: unknown = safely(() => otherStorage.onChanged)
    if (isNativeEvent(otherChanged) && otherChanged !== nativeStorageChanged)
      wrapStorageChanged(otherChanged)
  }

  return { installed: true }
}

/**
 * The prelude file's content: the function above, stringified, invoked once. The header line
 * lets a host tell a stale file from the current one without parsing it.
 */
export function contentScriptPreludeSource(): string {
  const body = installContentScriptStorage.toString()
  return `// Zenium content-script storage prelude ${preludeDigest(body)}\n;(${body})();\n`
}

/** A short FNV-1a digest of the prelude body, for the header line. */
function preludeDigest(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
