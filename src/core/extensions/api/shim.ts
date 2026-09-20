/**
 * The context side of Zenium's extension API layer: runs inside extension pages (popups,
 * options, MV2 background pages) and MV3 service workers and patches the `chrome` object in
 * place with the members the engine lacks or leaves inert. Calls travel to the host through the
 * `ShimHost` transport; the host pushes events back.
 *
 * `installExtensionApi` is deliberately one self-contained function with no free variables
 * besides globals: Electron stringifies it into the page's main world when context isolation
 * keeps the preload out (`contextBridge.executeInMainWorld`), and Android's WebView layer can
 * evaluate it verbatim. Everything it needs arrives through its two arguments.
 */
import type { ApiSpec, EventSpec, MethodSpec, NamespaceSpec, ParamSpec, ParamType } from './spec'
import type { StorageChanges, StorageItems } from './storage'

export type InvokeResult = { ok: true; value: unknown } | { ok: false; error: string }

/**
 * Which listeners of an event a host delivery is for, once the host matched the event's URL
 * against the listeners' `UrlFilter`s (`webNavigation`): the unfiltered ones, and the filtered
 * ones by the ids the shim gave them. Absent when every listener should receive it.
 */
export interface EventDelivery {
  unfiltered: boolean
  matched: number[]
}

export interface ShimHost {
  /** `frame` for documents, `worker` for the MV3 service worker. */
  kind: 'frame' | 'worker'
  /** Route an API call to the host; the envelope carries Chrome's error message on failure. */
  invoke(namespace: string, method: string, args: unknown[]): Promise<InvokeResult>
  /** Fire-and-forget notifications: `hello`, `listen`, `unlisten`, `storage-changed`. */
  notify(kind: string, payload: unknown): void
  /** Events pushed by the host, addressed by namespace and event name. */
  onEvent(
    listener: (namespace: string, event: string, args: unknown[], delivery?: EventDelivery) => void
  ): void
}

export interface ExtensionView {
  url: string
  /** `offscreen`: a document of `offscreen.createDocument` (the browser layer hosts it). */
  type: 'tab' | 'popup' | 'background' | 'options' | 'offscreen' | 'other'
  tabId?: number
  windowId?: number
  /** True for the view the call comes from. */
  self?: boolean
}

export interface ShimDiagnostics {
  installed: boolean
  browserAliased: boolean
  roots: number
  manifestVersion: 2 | 3
}

export interface ShimOptions {
  /**
   * The object whose `chrome` and `browser` properties are patched; `globalThis` by default. An
   * emulated engine that runs content scripts in the page's own world (no isolated world to
   * install into) hands over a private scope object here, so the page never sees `chrome.*`.
   */
  root?: object
  /**
   * Per-extension toggles the host knows at install time (`NamespaceSpec.toggle`): with
   * `userScripts` false, `chrome.userScripts` throws on access until the host pushes the change
   * (`__zen.toggles`). Absent: every toggled namespace is simply installed.
   */
  toggles?: Record<string, boolean>
  /**
   * The content-script storage prelude the extension's install directory carries (its file
   * name at the extension root, `CONTENT_SCRIPT_PRELUDE_FILE`), when it does. With it, this
   * context puts the prelude first in the `scripting` / `tabs.executeScript` injections it makes
   * into isolated worlds, mirrors the host's `storage.sync` and `storage.managed` into the
   * partition's native `local` under the prelude's reserved keys, and answers the prelude's
   * proxied writes. Absent: none of that, and the reserved keys are still kept out of sight.
   */
  storagePrelude?: string
  /**
   * API permissions the manifest declared that the host kept out of the manifest the engine
   * loaded (`core/extensions/withheldPermissions.ts`: the engine's own implementation would crash
   * the browser), by the list they were declared in. They count as declared here, so the
   * namespaces the browser layer answers in their place exist for this extension, and
   * `runtime.getManifest()` lists them again where the extension wrote them. Absent: nothing was
   * withheld (an emulated engine loads the manifest as declared).
   */
  withheld?: { required: string[]; optional: string[] }
}

/**
 * The engine's objects the shim patches in place (`globalThis`, `chrome`, its namespaces and
 * their native members). Nothing else is typed this way: values the shim builds or receives
 * from extensions are `unknown` and narrowed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the shim reflects over untyped globals
type Any = any

/** The parts of the manifest the shim reads; everything else is opaque. */
interface ManifestShape {
  manifest_version?: unknown
  background?: unknown
  permissions?: unknown
  optional_permissions?: unknown
}

/** A native `chrome.Event` the shim keeps registering listeners on (documents' storage events). */
interface NativeEvent {
  addListener(fn: Listener, ...rest: unknown[]): void
  removeListener(fn: Listener): void
}

type Listener = (...args: unknown[]) => unknown

/** Stand-in for another view's `window` (`extension.getViews`); see `viewStub`. */
interface ViewStub {
  location: URL | { href: string }
  closed: boolean
  close(): void
  focus(): void
  postMessage(): void
}

export function installExtensionApi(
  host: ShimHost,
  spec: ApiSpec,
  options?: ShimOptions
): ShimDiagnostics {
  /** Where `chrome` and `browser` are installed (a private scope object under emulation). */
  const g: Any = options?.root ?? globalThis
  /** The real global: the document's `location`, and the `window` other views get. */
  const real: Any = globalThis
  /** How long an event pushed before any listener exists waits for one (worker start-up). */
  const PENDING_TTL = 10_000
  const MARK = '__zeniumExtensionApi'
  if (!g.chrome || typeof g.chrome !== 'object') {
    Object.defineProperty(g, 'chrome', { value: {}, writable: true, configurable: true })
  }
  const chrome: Any = g.chrome
  if (chrome[MARK]) {
    return { installed: false, browserAliased: g.browser === chrome, roots: 1, manifestVersion: 3 }
  }
  Object.defineProperty(chrome, MARK, { value: true, enumerable: false, configurable: true })

  // Chromium exposes a native `browser` global that is a distinct object from `chrome`; make
  // it the same object so extensions detecting it see the augmented API. When the property
  // cannot be redefined both objects are patched with the same implementations.
  const roots: Any[] = [chrome]
  let browserAliased = g.browser === chrome
  if (!browserAliased) {
    const nativeBrowser = g.browser
    try {
      Object.defineProperty(g, 'browser', {
        value: chrome,
        writable: true,
        configurable: true,
        enumerable: false
      })
    } catch {
      /* not configurable */
    }
    browserAliased = g.browser === chrome
    if (!browserAliased) {
      try {
        g.browser = chrome
        browserAliased = g.browser === chrome
      } catch {
        /* read-only */
      }
    }
    if (!browserAliased && nativeBrowser && typeof nativeBrowser === 'object') {
      roots.push(nativeBrowser)
    }
  }

  /** What the host withheld from the engine's manifest; empty lists when nothing was. */
  const withheld: { required: string[]; optional: string[] } = {
    required: Array.isArray(options?.withheld?.required)
      ? options.withheld.required.filter((p): p is string => typeof p === 'string')
      : [],
    optional: Array.isArray(options?.withheld?.optional)
      ? options.withheld.optional.filter((p): p is string => typeof p === 'string')
      : []
  }
  /** The engine's manifest with the withheld entries back in their lists: as declared. */
  function withDeclaredPermissions(engineManifest: unknown): unknown {
    if (withheld.required.length === 0 && withheld.optional.length === 0) return engineManifest
    if (!isObject(engineManifest)) return engineManifest
    const restored: Record<string, unknown> = { ...engineManifest }
    const restore = (key: string, entries: string[]): void => {
      if (entries.length === 0) return
      const current = Array.isArray(restored[key]) ? (restored[key] as unknown[]) : []
      restored[key] = current.concat(entries.filter((entry) => !current.includes(entry)))
    }
    restore('permissions', withheld.required)
    restore('optional_permissions', withheld.optional)
    return restored
  }
  const manifest: ManifestShape =
    (withDeclaredPermissions(safely(() => chrome.runtime.getManifest())) as
      ManifestShape | undefined) ?? {}
  const manifestVersion: 2 | 3 = manifest.manifest_version === 2 ? 2 : 3
  const background = isObject(manifest.background) ? manifest.background : null
  /**
   * Chrome grants a permission only to the manifest versions its feature allows (the same table
   * as `permissionVersionWarning` in `core/extensions/manifest.ts`, inlined since this function
   * has no imports): `webRequestBlocking` ends with MV2, the MV3 APIs never existed in MV2.
   */
  const availableHere = (p: string): boolean =>
    manifestVersion === 2
      ? !['scripting', 'offscreen', 'sidePanel', 'userScripts'].includes(p)
      : p !== 'webRequestBlocking'
  const permissions: string[] = Array.isArray(manifest.permissions)
    ? manifest.permissions.filter((p): p is string => typeof p === 'string').filter(availableHere)
    : []
  /** Required and optional permissions alike: an optional one may be granted at run time. */
  const declaredPermissions: string[] = permissions.concat(
    Array.isArray(manifest.optional_permissions)
      ? manifest.optional_permissions
          .filter((p): p is string => typeof p === 'string')
          .filter(availableHere)
      : []
  )
  const extensionUrl: string =
    safely(() => String(chrome.runtime.getURL(''))) ??
    (typeof real.location === 'object' && real.location
      ? `${real.location.protocol}//${real.location.host}/`
      : '')
  const ownUrl: string =
    typeof real.location === 'object' && real.location ? String(real.location.href) : ''
  const isBackgroundPage =
    host.kind === 'frame' &&
    manifestVersion === 2 &&
    background !== null &&
    (background.page
      ? ownUrl === extensionUrl + String(background.page).replace(/^\/+/, '')
      : ownUrl === extensionUrl + '_generated_background_page.html')

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

  // Typed accessors for the untyped values that arrive from extensions and from the host: the
  // reflective parts of the shim (patching the engine's objects) keep `Any`, new code narrows.
  function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }

  function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
    return typeof value === 'function'
  }

  function isMenuId(value: unknown): value is string | number {
    return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value))
  }

  function isNativeEvent(value: unknown): value is NativeEvent {
    return isObject(value) && isFunction(value.addListener) && isFunction(value.removeListener)
  }

  function define(target: object, key: string, value: unknown): void {
    try {
      Object.defineProperty(target, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: true
      })
    } catch {
      try {
        ;(target as Record<string, unknown>)[key] = value
      } catch {
        /* frozen */
      }
    }
  }

  function defineGetter(target: object, key: string, get: () => unknown): void {
    try {
      Object.defineProperty(target, key, { get, configurable: true, enumerable: true })
    } catch {
      /* not configurable */
    }
  }

  /** The namespace object on a root, created when the engine has none. */
  /**
   * The object at `name` under `root`, made when missing; a dotted name (`system.display`) is a
   * path of namespaces, each made the same way (`chrome.system` holds `display`).
   */
  function namespaceOn(root: Any, name: string): Any {
    let holder = root
    for (const part of name.split('.')) {
      let ns: Any
      try {
        ns = holder[part]
      } catch {
        ns = undefined
      }
      if (!ns || typeof ns !== 'object') {
        ns = {}
        define(holder, part, ns)
      }
      holder = ns
    }
    return holder
  }

  /** The value at a dotted path under `root`, or undefined anywhere along the way. */
  function memberAt(root: Any, name: string): unknown {
    let value: Any = root
    for (const part of name.split('.')) {
      if (!isObject(value)) return undefined
      value = value[part]
    }
    return value
  }

  function matchesType(value: unknown, type: ParamType): boolean {
    switch (type) {
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value)
      case 'number':
        return typeof value === 'number' && Number.isFinite(value)
      case 'string':
        return typeof value === 'string'
      case 'boolean':
        return typeof value === 'boolean'
      case 'object':
        return value !== null && typeof value === 'object' && !Array.isArray(value)
      case 'array':
        return Array.isArray(value)
      case 'any':
        return value !== undefined
    }
    return false
  }

  /** Chrome's signature matching: optional parameters are skipped when the argument does not fit. */
  function normalizeArgs(qualified: string, raw: unknown[], params: ParamSpec[]): unknown[] {
    const out: unknown[] = []
    let i = 0
    for (const param of params) {
      const types = Array.isArray(param.type) ? param.type : [param.type]
      const has = i < raw.length
      const value = raw[i]
      if (has && (value === null || value === undefined)) {
        if (!param.optional) throw signatureError(qualified)
        out.push(undefined)
        i += 1
        continue
      }
      if (has && types.some((t) => matchesType(value, t))) {
        out.push(value)
        i += 1
        continue
      }
      if (param.optional) {
        out.push(undefined)
        continue
      }
      throw signatureError(qualified)
    }
    return out
  }

  function signatureError(qualified: string): TypeError {
    return new TypeError(`Error in invocation of ${qualified}: No matching signature.`)
  }

  // runtime.lastError is defined only while an error callback runs, then deleted – the same
  // dance Chromium performs, so the engine's own bindings keep working alongside. A callback
  // that never reads it gets Chrome's "Unchecked runtime.lastError" console line.
  let lastErrorDepth = 0
  function withLastError(qualified: string, message: string, fn: () => void): void {
    const targets: object[] = []
    for (const root of roots) {
      const runtime: unknown = safely(() => root.runtime)
      if (runtime && typeof runtime === 'object') targets.push(runtime)
    }
    const error = { message }
    let checked = false
    for (const runtime of targets) {
      try {
        Object.defineProperty(runtime, 'lastError', {
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
        for (const runtime of targets) {
          try {
            Reflect.deleteProperty(runtime, 'lastError')
          } catch {
            /* not configurable */
          }
        }
        if (!checked) reportError(qualified, message)
      }
    }
  }

  function reportError(qualified: string, message: string): void {
    try {
      console.error(`Unchecked runtime.lastError: ${message} (${qualified})`)
    } catch {
      /* no console */
    }
  }

  /** Callback-or-promise: with a callback Chrome reports failures through runtime.lastError. */
  function settle(
    qualified: string,
    promise: Promise<unknown>,
    callback: ((...args: unknown[]) => void) | undefined
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
      (error) => {
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

  function takeCallback(raw: unknown[]): ((...args: unknown[]) => void) | undefined {
    if (raw.length > 0 && typeof raw[raw.length - 1] === 'function') {
      return raw.pop() as (...args: unknown[]) => void
    }
    return undefined
  }

  function invoke(namespace: string, method: string, args: unknown[]): Promise<unknown> {
    return host.invoke(namespace, method, args).then((result: unknown) => {
      if (isObject(result) && result.ok === true) return result.value
      const message =
        isObject(result) && typeof result.error === 'string' ? result.error : 'Unknown error'
      throw new Error(message)
    })
  }

  /** ImageData cannot cross process boundaries; ship its pixels instead. */
  function serializeIconDetails(details: unknown): unknown {
    if (!isObject(details)) return details
    const out: Record<string, unknown> = { ...details }
    const convert = (image: unknown): unknown => {
      if (isObject(image) && 'data' in image && 'width' in image) {
        return { width: image.width, height: image.height, data: image.data }
      }
      return image
    }
    const imageData = out.imageData
    if (isObject(imageData)) {
      if ('data' in imageData && 'width' in imageData) {
        out.imageData = convert(imageData)
      } else {
        const sizes: Record<string, unknown> = {}
        for (const key of Object.keys(imageData)) sizes[key] = convert(imageData[key])
        out.imageData = sizes
      }
    }
    // Chrome resolves icon paths against the calling context's URL (`../icons/x.png` from a
    // worker at `background/index.js`), not the extension root; only this side knows that URL.
    const resolve = (path: unknown): unknown => {
      if (typeof path !== 'string') return path
      try {
        return new URL(path, globalThis.location.href).href
      } catch {
        return path
      }
    }
    const path = out.path
    if (typeof path === 'string') {
      out.path = resolve(path)
    } else if (isObject(path)) {
      const sizes: Record<string, unknown> = {}
      for (const key of Object.keys(path)) sizes[key] = resolve(path[key])
      out.path = sizes
    }
    return out
  }

  let inertIds = 0
  /** A member that answers on this side (see `MethodSpec.inert`): no validation, no host call. */
  function makeInertMethod(
    qualified: string,
    inert: NonNullable<MethodSpec['inert']>
  ): (...raw: unknown[]) => unknown {
    return function (...raw: unknown[]): unknown {
      const callback = takeCallback(raw)
      if (inert.error !== undefined) {
        return settle(qualified, Promise.reject(new Error(inert.error)), callback)
      }
      let value = inert.value
      if (inert.id) {
        const first: unknown = raw[0]
        const own =
          typeof first === 'string'
            ? first
            : isObject(first) && (typeof first.id === 'string' || typeof first.id === 'number')
              ? first.id
              : undefined
        inertIds += 1
        value = own ?? (inert.id === 'number' ? inertIds : String(inertIds))
      }
      if (inert.sync) {
        if (callback) setTimeout(() => callback(), 0)
        return value
      }
      return settle(qualified, Promise.resolve(value), callback)
    }
  }

  function makeMethod(
    namespace: string,
    name: string,
    method: MethodSpec
  ): (...raw: unknown[]) => unknown {
    const qualified = `${namespace}.${name}(${method.params
      .map(
        (p) =>
          `${p.optional ? 'optional ' : ''}${Array.isArray(p.type) ? p.type.join('|') : p.type} ${p.name}`
      )
      .join(', ')})`
    if (method.inert) return makeInertMethod(qualified, method.inert)
    const routed = namespace === 'browserAction' ? 'action' : namespace
    return function (this: unknown, ...raw: unknown[]): unknown {
      const callback = takeCallback(raw)
      const args = normalizeArgs(qualified, raw, method.params)
      if (routed === 'action' && name === 'setIcon') args[0] = serializeIconDetails(args[0])
      return settle(qualified, invoke(routed, name, args), callback)
    }
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  interface EventObject {
    addListener(fn: unknown, ...rest: unknown[]): void
    removeListener(fn: unknown): void
    hasListener(fn: unknown): boolean
    hasListeners(): boolean
    dispatch(...args: unknown[]): unknown[]
  }

  /** Sees what the listeners of one delivery returned (events whose answer the host waits for). */
  type After = (results: unknown[]) => void

  interface EventRecord {
    object: EventObject
    /** Listener → the id of its URL filter set, null for an unfiltered listener. */
    listeners: Map<Listener, number | null>
    pending: Array<{ args: unknown[]; at: number; delivery?: EventDelivery; after?: After }>
    nativeDelivers: boolean
    /** With `nativeDelivers`: which host deliveries the engine already made (dropped here). */
    nativeHandles: (args: unknown[]) => boolean
  }

  const events = new Map<string, EventRecord>()
  let filterIds = 0

  /**
   * `addListener(fn, filters)`: `filters.url` is a list of `events.UrlFilter`s the host matches
   * before delivering (`webNavigation`). Only the shape is checked here; the host validates the
   * fields and ignores unknown ones, like Chrome.
   */
  function urlFilters(fullName: string, filters: unknown): unknown[] | null {
    if (filters === undefined || filters === null) return null
    if (!isObject(filters)) {
      throw new TypeError(
        `Error in invocation of ${fullName}.addListener(function callback, optional object filters): No matching signature.`
      )
    }
    const url = filters.url
    if (url === undefined) return null
    if (!Array.isArray(url) || !url.every(isObject)) {
      throw new TypeError(
        `Error in invocation of ${fullName}.addListener(function callback, optional object filters): Error at parameter 'filters': Error at property 'url': Expected array of UrlFilter objects.`
      )
    }
    return url
  }

  function callListener(fn: Listener, args: unknown[], results?: unknown[]): void {
    try {
      const result = fn(...args)
      if (results) results.push(result)
    } catch (error) {
      setTimeout(() => {
        throw error
      }, 0)
    }
  }

  /** Whether a delivery addressed by the host is for this listener. */
  function wants(filterId: number | null, delivery: EventDelivery | undefined): boolean {
    if (!delivery) return true
    return filterId === null ? delivery.unfiltered : delivery.matched.includes(filterId)
  }

  function createEvent(
    fullName: string,
    native: NativeEvent | undefined,
    options: {
      nativeDelivers: boolean
      nativeHandles?: (args: unknown[]) => boolean
      /**
       * With `nativeDelivers`: what a listener sees of the engine's delivery (`null` drops it).
       * The storage events use it to keep the mirror's reserved keys out of sight.
       */
      nativeMap?: (args: unknown[]) => unknown[] | null
      /** `EventSpec.filters`: the event takes URL filters; others ignore a second argument. */
      filters?: boolean
    }
  ): EventObject {
    const listeners = new Map<Listener, number | null>()
    /** The function registered on the engine's event for a listener (itself, or a mapping proxy). */
    const nativeProxies = new Map<Listener, Listener>()
    const record: EventRecord = {
      object: null as unknown as EventObject,
      listeners,
      pending: [],
      nativeDelivers: options.nativeDelivers && Boolean(native),
      nativeHandles: options.nativeHandles ?? (() => true)
    }
    const unfilteredCount = (): number => {
      let count = 0
      for (const id of listeners.values()) if (id === null) count += 1
      return count
    }
    const nativeProxy = (fn: Listener): Listener => {
      const map = options.nativeMap
      if (!map) return fn
      const proxy: Listener = (...args: unknown[]) => {
        const mapped = map(args)
        return mapped ? fn(...mapped) : undefined
      }
      nativeProxies.set(fn, proxy)
      return proxy
    }
    const object: EventObject = {
      addListener(fn: unknown, ...rest: unknown[]): void {
        if (!isFunction(fn) || listeners.has(fn)) return
        if (record.nativeDelivers) safely(() => native?.addListener(nativeProxy(fn), ...rest))
        const filters = options.filters ? urlFilters(fullName, rest[0]) : null
        if (filters) {
          filterIds += 1
          listeners.set(fn, filterIds)
          host.notify('listen', { event: fullName, filterId: filterIds, filters })
        } else {
          const first = unfilteredCount() === 0
          listeners.set(fn, null)
          if (first) host.notify('listen', { event: fullName })
        }
        if (record.pending.length > 0) {
          const now = Date.now()
          const queued = record.pending.splice(0)
          const filterId = listeners.get(fn) ?? null
          for (const item of queued) {
            if (now - item.at > PENDING_TTL) continue
            // A filtered listener registered after the host matched cannot be matched now; it
            // only receives deliveries the host addressed to everyone.
            if (!wants(filterId, item.delivery)) continue
            const results: unknown[] = []
            callListener(fn, item.args, results)
            item.after?.(results)
          }
        }
      },
      removeListener(fn: unknown): void {
        if (!isFunction(fn)) return
        if (record.nativeDelivers) {
          const proxy = nativeProxies.get(fn) ?? fn
          nativeProxies.delete(fn)
          safely(() => native?.removeListener(proxy))
        }
        if (!listeners.has(fn)) return
        const filterId = listeners.get(fn) ?? null
        listeners.delete(fn)
        if (filterId !== null) host.notify('unlisten', { event: fullName, filterId })
        else if (unfilteredCount() === 0) host.notify('unlisten', { event: fullName })
      },
      hasListener(fn: unknown): boolean {
        return isFunction(fn) && listeners.has(fn)
      },
      hasListeners(): boolean {
        return listeners.size > 0
      },
      dispatch(...args: unknown[]): unknown[] {
        const results: unknown[] = []
        for (const fn of [...listeners.keys()]) callListener(fn, args, results)
        return results
      }
    }
    defineRuleMembers(object)
    record.object = object
    events.set(fullName, record)
    return object
  }

  /** Declarative-rule members exist on every chrome.Event; keep callers that probe them happy. */
  function defineRuleMembers(object: EventObject): void {
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

  function deliver(
    fullName: string,
    args: unknown[],
    delivery?: EventDelivery,
    after?: After
  ): void {
    const record = events.get(fullName)
    if (!record) return
    // The engine already fired this one at our listeners; a second delivery would duplicate it.
    if (record.nativeDelivers && record.nativeHandles(args)) return
    if (record.listeners.size > 0) {
      const results: unknown[] = []
      for (const [fn, filterId] of [...record.listeners]) {
        if (wants(filterId, delivery)) callListener(fn, args, results)
      }
      after?.(results)
      return
    }
    const now = Date.now()
    record.pending = record.pending.filter((p) => now - p.at <= PENDING_TTL)
    if (record.pending.length < 50) {
      const item: EventRecord['pending'][number] = { args, at: now }
      if (delivery) item.delivery = delivery
      if (after) item.after = after
      record.pending.push(item)
    }
  }

  /**
   * `downloads.onDeterminingFilename(item, suggest)`: the host holds the file's placement until
   * this context answers once. A listener that returns true answers later through `suggest`;
   * otherwise the answer is whatever it passed synchronously, or nothing.
   */
  function determineFilename(args: unknown[]): void {
    const token = args[1]
    let answered = false
    const suggest = (suggestion?: unknown): void => {
      if (answered) return
      answered = true
      host.notify('downloads-determined', { token, suggestion: suggestion ?? null })
    }
    deliver('downloads.onDeterminingFilename', [args[0], suggest], undefined, (results) => {
      if (!results.includes(true)) suggest()
    })
  }

  /**
   * `omnibox.onInputChanged(text, suggest)`: the URL bar is waiting for `suggest(results)`; each
   * call answers the host for this change (the latest one wins), and functions cannot cross.
   */
  function omniboxInputChanged(args: unknown[]): void {
    const token = args[1]
    const suggest = (results?: unknown): void => {
      host.notify('omnibox-suggest', { token, results: Array.isArray(results) ? results : [] })
    }
    deliver('omnibox.onInputChanged', [args[0], suggest])
  }

  // ---------------------------------------------------------------------------
  // webRequest: events take a RequestFilter and extraInfoSpec; blocking listeners answer
  // ---------------------------------------------------------------------------

  interface WebRequestRegistration {
    /** The id the host addresses deliveries to (per context). */
    id: number
    blocking: boolean
    asyncBlocking: boolean
  }

  /** `webRequest.<event>` → listener → its registration with the host. */
  const webRequestListeners = new Map<string, Map<Listener, WebRequestRegistration>>()
  let webRequestIds = 0
  /**
   * Chrome allows blocking listeners to MV2 extensions holding `webRequestBlocking`, and
   * blocking `onAuthRequired` listeners to any extension holding `webRequestAuthProvider`.
   */
  const canBlockRequests = manifestVersion === 2 && permissions.includes('webRequestBlocking')
  const canBlockAuth = canBlockRequests || permissions.includes('webRequestAuthProvider')
  const BLOCKING_PERMISSION_ERROR =
    'You do not have permission to use blocking webRequest listeners. Be sure to declare the webRequestBlocking permission in your manifest.'

  /** The shape of a match pattern; the host compiles it and rejects what this lets through. */
  function looksLikeMatchPattern(pattern: string): boolean {
    if (pattern === '<all_urls>') return true
    return /^[a-z*][a-z0-9+.-]*:\/\/[^/]*\/.*$/i.test(pattern) || /^(data|urn):/.test(pattern)
  }

  function isThenable(value: unknown): value is PromiseLike<unknown> {
    return isObject(value) && isFunction(value.then)
  }

  /** The `RequestFilter` as it crosses to the host: the known fields, copied. */
  function requestFilterForWire(filter: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { urls: filter.urls }
    if (filter.types !== undefined) out.types = filter.types
    if (filter.tabId !== undefined) out.tabId = filter.tabId
    if (filter.windowId !== undefined) out.windowId = filter.windowId
    return out
  }

  /**
   * A blocking listener's answer as it crosses to the host: the `BlockingResponse` fields the
   * host applies, headers as plain `{ name, value, binaryValue }` items (an `ArrayBuffer`
   * `binaryValue` becomes its bytes).
   */
  function blockingResponseForWire(raw: unknown): unknown {
    if (!isObject(raw)) return undefined
    const out: Record<string, unknown> = {}
    if (raw.cancel === true) out.cancel = true
    if (typeof raw.redirectUrl === 'string') out.redirectUrl = raw.redirectUrl
    if (isObject(raw.authCredentials)) {
      const { username, password } = raw.authCredentials
      if (typeof username === 'string' && typeof password === 'string')
        out.authCredentials = { username, password }
    }
    for (const key of ['requestHeaders', 'responseHeaders']) {
      const list = raw[key]
      if (!Array.isArray(list)) continue
      out[key] = list.map((item: unknown): unknown => {
        if (!isObject(item)) return item
        const header: Record<string, unknown> = { name: item.name }
        if (typeof item.value === 'string') header.value = item.value
        const binary = item.binaryValue
        if (Array.isArray(binary)) header.binaryValue = [...binary]
        else if (binary instanceof ArrayBuffer) header.binaryValue = [...new Uint8Array(binary)]
        else if (ArrayBuffer.isView(binary)) {
          header.binaryValue = [
            ...new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength)
          ]
        }
        return header
      })
    }
    return out
  }

  function webRequestEvent(namespace: string, name: string, eventSpec: EventSpec): EventObject {
    const fullName = `${namespace}.${name}`
    const allowed = eventSpec.extraInfoSpec ?? []
    const listeners = new Map<Listener, WebRequestRegistration>()
    webRequestListeners.set(fullName, listeners)
    const signature = `${fullName}.addListener(function callback, webRequest.RequestFilter filter, optional array extraInfoSpec)`
    const fail = (detail: string): TypeError =>
      new TypeError(`Error in invocation of ${signature}: ${detail}`)
    const object: EventObject = {
      addListener(fn: unknown, filter?: unknown, extraInfoSpec?: unknown): void {
        if (!isFunction(fn)) throw fail('No matching signature.')
        if (listeners.has(fn)) return
        if (!isObject(filter)) throw fail('No matching signature.')
        if (!Array.isArray(filter.urls)) {
          throw fail(
            "Error at parameter 'filter': Error at property 'urls': Invalid type: expected array."
          )
        }
        for (const url of filter.urls) {
          if (typeof url !== 'string') {
            throw fail(
              "Error at parameter 'filter': Error at property 'urls': Invalid type: expected string."
            )
          }
          if (!looksLikeMatchPattern(url)) throw new Error(`'${url}' is not a valid URL pattern.`)
        }
        const spec: string[] = []
        if (extraInfoSpec !== undefined && extraInfoSpec !== null) {
          if (!Array.isArray(extraInfoSpec)) {
            throw fail("Error at parameter 'extraInfoSpec': Invalid type: expected array.")
          }
          extraInfoSpec.forEach((item: unknown, index: number) => {
            if (typeof item !== 'string' || !allowed.includes(item)) {
              throw fail(
                `Error at parameter 'extraInfoSpec': Error at index ${index}: Value must be one of ${allowed.join(', ')}.`
              )
            }
            if (!spec.includes(item)) spec.push(item)
          })
        }
        const blocking = spec.includes('blocking') || spec.includes('asyncBlocking')
        if (blocking && !(name === 'onAuthRequired' ? canBlockAuth : canBlockRequests)) {
          throw new Error(BLOCKING_PERMISSION_ERROR)
        }
        webRequestIds += 1
        const registration: WebRequestRegistration = {
          id: webRequestIds,
          blocking,
          asyncBlocking: spec.includes('asyncBlocking')
        }
        listeners.set(fn, registration)
        invoke('webRequest', 'addListener', [
          name,
          requestFilterForWire(filter),
          spec,
          registration.id
        ]).catch((error: unknown) => {
          if (listeners.get(fn) === registration) listeners.delete(fn)
          safely(() =>
            console.error(
              `${fullName}.addListener: ${error instanceof Error ? error.message : String(error)}`
            )
          )
        })
      },
      removeListener(fn: unknown): void {
        if (!isFunction(fn)) return
        const registration = listeners.get(fn)
        if (!registration) return
        listeners.delete(fn)
        invoke('webRequest', 'removeListener', [name, registration.id]).catch(() => undefined)
      },
      hasListener(fn: unknown): boolean {
        return isFunction(fn) && listeners.has(fn)
      },
      hasListeners(): boolean {
        return listeners.size > 0
      },
      dispatch(...args: unknown[]): unknown[] {
        const results: unknown[] = []
        for (const fn of [...listeners.keys()]) callListener(fn, args, results)
        return results
      }
    }
    defineRuleMembers(object)
    return object
  }

  /**
   * A delivery from the host: `args` is `[details, token]`, `delivery.matched` names the one
   * listener it is for. A blocking listener's return value (or, with `asyncBlocking`, what it
   * hands its callback; a promise either way) goes back under the token; a listener that is
   * gone, throws, or does not block answers with nothing so the request goes on unchanged.
   */
  function webRequestDeliver(event: string, args: unknown[], delivery?: EventDelivery): void {
    const listeners = webRequestListeners.get(`webRequest.${event}`)
    const details = args[0]
    const token = typeof args[1] === 'number' ? args[1] : null
    let answered = token === null
    const answer = (response: unknown): void => {
      if (answered) return
      answered = true
      host.notify('webRequest-answer', { token, response: blockingResponseForWire(response) })
    }
    let target: [Listener, WebRequestRegistration] | undefined
    if (listeners && delivery) {
      for (const entry of listeners) {
        if (delivery.matched.includes(entry[1].id)) {
          target = entry
          break
        }
      }
    }
    if (!target) {
      answer(undefined)
      return
    }
    const [fn, registration] = target
    if (!registration.blocking || token === null) {
      callListener(fn, [details])
      return
    }
    try {
      const result = registration.asyncBlocking ? fn(details, answer) : fn(details)
      if (isThenable(result)) {
        result.then(answer, (error: unknown) => {
          answer(undefined)
          setTimeout(() => {
            throw error
          }, 0)
        })
      } else if (!registration.asyncBlocking || result !== undefined) answer(result)
    } catch (error) {
      answer(undefined)
      setTimeout(() => {
        throw error
      }, 0)
    }
  }

  // ---------------------------------------------------------------------------
  // Settings namespaces (`privacy`): objects of `types.ChromeSetting`s
  // ---------------------------------------------------------------------------

  /**
   * A `types.ChromeSetting`: `get` / `set` / `clear` route as `<namespace>.<method>(object,
   * setting, details)` (or `(setting, details)` for a setting that is a member of the namespace
   * itself, `object` null) and `onChange` is an event the host fires under the setting's full
   * name.
   */
  function chromeSetting(namespace: string, object: string | null, setting: string): object {
    const result: Record<string, unknown> = {}
    const path = object === null ? [setting] : [object, setting]
    for (const method of ['get', 'set', 'clear']) {
      const qualified = `types.ChromeSetting.${method}(object details, optional function callback)`
      define(result, method, function (...raw: unknown[]): unknown {
        const callback = takeCallback(raw)
        const [details] = normalizeArgs(qualified, raw, [{ name: 'details', type: 'object' }])
        return settle(qualified, invoke(namespace, method, [...path, details]), callback)
      })
    }
    define(
      result,
      'onChange',
      createEvent(`${namespace}.${path.join('.')}.onChange`, undefined, {
        nativeDelivers: false
      })
    )
    return result
  }

  /**
   * A `contentSettings.ContentSetting`: `get` / `set` / `clear` take details and route as
   * `<namespace>.<method>(type, details)`; `getResourceIdentifiers` takes only the callback.
   * No event: Chrome's has none.
   */
  function contentSetting(namespace: string, type: string): object {
    const result: Record<string, unknown> = {}
    for (const method of ['get', 'set', 'clear']) {
      const qualified = `contentSettings.ContentSetting.${method}(object details, optional function callback)`
      define(result, method, function (...raw: unknown[]): unknown {
        const callback = takeCallback(raw)
        const [details] = normalizeArgs(qualified, raw, [{ name: 'details', type: 'object' }])
        return settle(qualified, invoke(namespace, method, [type, details]), callback)
      })
    }
    const identifiers =
      'contentSettings.ContentSetting.getResourceIdentifiers(optional function callback)'
    define(result, 'getResourceIdentifiers', function (...raw: unknown[]): unknown {
      const callback = takeCallback(raw)
      normalizeArgs(identifiers, raw, [])
      return settle(identifiers, invoke(namespace, 'getResourceIdentifiers', [type]), callback)
    })
    return result
  }

  // ---------------------------------------------------------------------------
  // userScripts: the worlds' messaging arrives on runtime.onUserScriptMessage / onUserScriptConnect
  // ---------------------------------------------------------------------------

  const hasUserScripts = declaredPermissions.includes('userScripts')
  // The notification kinds of `shared/userScripts.ts` (`USER_SCRIPTS_SHIM`), spelled out: this
  // function is serialised into the extension's world and can reach no module binding.
  const US_ANSWER = 'userScripts-answer'
  const US_PORT = 'userScripts-port'
  const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.'
  const PORT_CLOSED = 'The message port closed before a response was received.'

  /** An event of this side only (a `Port`'s): listeners, nothing registered with the host. */
  function localEvent(): EventObject {
    const listeners = new Set<Listener>()
    const object: EventObject = {
      addListener(fn: unknown): void {
        if (isFunction(fn)) listeners.add(fn)
      },
      removeListener(fn: unknown): void {
        if (isFunction(fn)) listeners.delete(fn)
      },
      hasListener(fn: unknown): boolean {
        return isFunction(fn) && listeners.has(fn)
      },
      hasListeners(): boolean {
        return listeners.size > 0
      },
      dispatch(...args: unknown[]): unknown[] {
        const results: unknown[] = []
        for (const fn of [...listeners]) callListener(fn, args, results)
        return results
      }
    }
    defineRuleMembers(object)
    return object
  }

  /**
   * `runtime.onUserScriptMessage(message, sender, sendResponse)`: a world's `runtime.sendMessage`,
   * delivered under a token. The channel stays open for a listener that returns true (or a
   * promise, which answers with its value); otherwise it closes when the listeners return, and
   * the world hears that no response came.
   */
  function userScriptMessage(args: unknown[]): void {
    const [message, sender, token] = args
    let answered = false
    const sendResponse = (result?: unknown): void => {
      if (answered) return
      answered = true
      host.notify(US_ANSWER, { token, responded: true, result })
    }
    const close = (): void => {
      if (answered) return
      answered = true
      host.notify(US_ANSWER, { token, responded: false })
    }
    deliver(
      'runtime.onUserScriptMessage',
      [message, sender, sendResponse],
      undefined,
      (results) => {
        let waiting = false
        for (const result of results) {
          if (result === true) waiting = true
          else if (isThenable(result)) {
            waiting = true
            result.then(sendResponse, (error: unknown) => {
              close()
              setTimeout(() => {
                throw error
              }, 0)
            })
          }
        }
        if (!waiting) close()
      }
    )
  }

  interface UserScriptPort {
    port: Any
    connected: boolean
    onMessage: EventObject
    onDisconnect: EventObject
  }

  /** The ports of user-script worlds this context accepted, by the host's port id. */
  const userScriptPorts = new Map<string, UserScriptPort>()

  function makeUserScriptPort(portId: string, name: string, sender: unknown): UserScriptPort {
    const record: UserScriptPort = {
      port: null,
      connected: true,
      onMessage: localEvent(),
      onDisconnect: localEvent()
    }
    const port: Any = {
      name,
      sender,
      onMessage: record.onMessage,
      onDisconnect: record.onDisconnect,
      postMessage(message: unknown): void {
        if (!record.connected) throw new Error('Attempting to use a disconnected port object')
        if (message === undefined) {
          throw new TypeError(
            'Error in invocation of runtime.Port.postMessage(any message): No matching signature.'
          )
        }
        host.notify(US_PORT, { kind: 'message', portId, message })
      },
      disconnect(): void {
        if (!record.connected) return
        record.connected = false
        userScriptPorts.delete(portId)
        host.notify(US_PORT, { kind: 'disconnect', portId })
      }
    }
    record.port = port
    return record
  }

  /**
   * `runtime.onUserScriptConnect(port)`: a world's `runtime.connect`. The host learns that this
   * context holds an end of the port once listeners took it (`accept`; a message posted before
   * that counts as one too).
   */
  function userScriptConnect(args: unknown[]): void {
    const info = args[0]
    if (!isObject(info) || typeof info.portId !== 'string') return
    const portId = info.portId
    const record = makeUserScriptPort(portId, String(info.name ?? ''), info.sender)
    userScriptPorts.set(portId, record)
    deliver('runtime.onUserScriptConnect', [record.port], undefined, () => {
      if (record.connected) host.notify(US_PORT, { kind: 'accept', portId })
    })
  }

  /** `__zen.us-port`: the world's side of a port this context accepted. */
  function userScriptPortEvent(wire: unknown): void {
    if (!isObject(wire) || typeof wire.portId !== 'string') return
    const record = userScriptPorts.get(wire.portId)
    if (!record) return
    if (wire.kind === 'message') {
      record.onMessage.dispatch(wire.message, record.port)
      return
    }
    if (wire.kind !== 'disconnect') return
    userScriptPorts.delete(wire.portId)
    record.connected = false
    const fire = (): void => {
      record.onDisconnect.dispatch(record.port)
    }
    if (typeof wire.error === 'string') withLastError('runtime.Port.onDisconnect', wire.error, fire)
    else fire()
  }

  type EngineOutcome = { kind: 'response'; value: unknown } | { kind: 'error'; message: string }
  interface HostedOutcome {
    handled: boolean
    responded: boolean
    result?: unknown
  }

  /**
   * `tabs.sendMessage` for an extension holding `userScripts`: the engine delivers to the tab's
   * content scripts, the host to its user-script worlds; the first response wins, as in Chrome.
   * With no response from either, the error says whether anyone listened at all.
   */
  function combineTabMessage(
    engine: Promise<EngineOutcome>,
    hosted: Promise<HostedOutcome>
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false
      let engineDone: EngineOutcome | null = null
      let hostedDone: HostedOutcome | null = null
      const finish = (): void => {
        if (settled || !engineDone || !hostedDone) return
        settled = true
        if (
          engineDone.kind === 'error' &&
          engineDone.message !== NO_RECEIVER &&
          engineDone.message !== PORT_CLOSED
        ) {
          reject(new Error(engineDone.message))
          return
        }
        const listened =
          (engineDone.kind === 'error' && engineDone.message === PORT_CLOSED) || hostedDone.handled
        reject(new Error(listened ? PORT_CLOSED : NO_RECEIVER))
      }
      engine.then((outcome) => {
        if (settled) return
        if (outcome.kind === 'response') {
          settled = true
          resolve(outcome.value)
          return
        }
        engineDone = outcome
        finish()
      })
      hosted.then((outcome) => {
        if (settled) return
        if (outcome.responded) {
          settled = true
          resolve(outcome.result)
          return
        }
        hostedDone = outcome
        finish()
      })
    })
  }

  function wrapTabsSendMessage(tabs: Any): void {
    const native: unknown = safely(() => tabs.sendMessage)
    if (!isFunction(native)) return
    const qualified =
      'tabs.sendMessage(integer tabId, any message, optional object options, optional function callback)'
    define(tabs, 'sendMessage', function (...raw: unknown[]): unknown {
      const callback = takeCallback(raw)
      const [tabId, message, options] = raw
      if (!matchesType(tabId, 'integer') || raw.length < 2) throw signatureError(qualified)
      if (options !== undefined && options !== null && !isObject(options)) {
        throw signatureError(qualified)
      }
      const engine = new Promise<EngineOutcome>((resolve) => {
        const done = (response: unknown): void => {
          const error: unknown = safely(() => chrome.runtime.lastError)
          if (error) {
            resolve({
              kind: 'error',
              message: String(isObject(error) && error.message ? error.message : error)
            })
          } else resolve({ kind: 'response', value: response })
        }
        try {
          if (options === undefined || options === null) native.call(tabs, tabId, message, done)
          else native.call(tabs, tabId, message, options, done)
        } catch (error) {
          resolve({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error)
          })
        }
      })
      const hosted = invoke('userScripts', 'sendMessage', [tabId, message, options ?? null]).then(
        (value: unknown): HostedOutcome =>
          isObject(value)
            ? {
                handled: value.handled === true,
                responded: value.responded === true,
                result: value.result
              }
            : { handled: false, responded: false },
        (): HostedOutcome => ({ handled: false, responded: false })
      )
      return settle(qualified, combineTabMessage(engine, hosted), callback)
    })
  }

  // ---------------------------------------------------------------------------
  // Generic namespaces from the table
  // ---------------------------------------------------------------------------

  /** Permission-gated namespaces exist for extensions declaring one (or when the engine made one). */
  function namespaceAllowed(namespace: string, nsSpec: NamespaceSpec): boolean {
    if (!nsSpec.permissions) return true
    if (nsSpec.permissions.some((p) => declaredPermissions.includes(p))) return true
    return isObject(safely(() => memberAt(roots[0], namespace)))
  }

  /** Permission-gated events (`runtime.onUserScriptMessage`) exist for extensions declaring one. */
  function eventAllowed(eventSpec: EventSpec): boolean {
    if (!eventSpec.permissions) return true
    return eventSpec.permissions.some((p) => declaredPermissions.includes(p))
  }

  /** The toggles the host gave; a toggled namespace is installed only while its toggle is on. */
  const toggles: Record<string, boolean> | undefined = options?.toggles
  /** Toggled namespaces waiting for their toggle: reading `chrome.<name>` throws meanwhile. */
  const toggledOff = new Map<string, NamespaceSpec>()
  const installedNamespaces = new Set<string>()

  function toggleOn(nsSpec: NamespaceSpec): boolean {
    return !nsSpec.toggle || !toggles || toggles[nsSpec.toggle.key] === true
  }

  function defineToggledOff(namespace: string, nsSpec: NamespaceSpec): void {
    const message = nsSpec.toggle?.error ?? `chrome.${namespace} is not available.`
    toggledOff.set(namespace, nsSpec)
    installedNamespaces.delete(namespace)
    for (const root of roots) {
      defineGetter(root, namespace, () => {
        throw new Error(message)
      })
    }
  }

  /** The host flipped toggles (`__zen.toggles`): install what came on, take away what went off. */
  function applyToggles(next: Record<string, unknown>): void {
    if (!toggles) return
    for (const [key, value] of Object.entries(next)) {
      if (typeof value !== 'boolean') continue
      toggles[key] = value
      for (const [namespace, nsSpec] of Object.entries(spec)) {
        if (nsSpec.toggle?.key !== key) continue
        if (nsSpec.manifestVersion && nsSpec.manifestVersion !== manifestVersion) continue
        if (!namespaceAllowed(namespace, nsSpec)) continue
        if (value && toggledOff.has(namespace)) {
          toggledOff.delete(namespace)
          for (const root of roots) safely(() => Reflect.deleteProperty(root, namespace))
          installNamespace(namespace, nsSpec)
        } else if (!value && installedNamespaces.has(namespace)) {
          defineToggledOff(namespace, nsSpec)
        }
      }
    }
  }

  function installNamespace(namespace: string, nsSpec: NamespaceSpec): void {
    installedNamespaces.add(namespace)
    const targets = roots.map((root) => namespaceOn(root, namespace))
    for (const [name, method] of Object.entries(nsSpec.methods)) {
      const fn = makeMethod(namespace, name, method)
      const keepNative = method.keepNative || Boolean(method.inert)
      for (const target of targets) {
        if (keepNative && typeof safely(() => target[name]) === 'function') continue
        define(target, name, fn)
      }
    }
    for (const [name, eventSpec] of Object.entries(nsSpec.events)) {
      if (!eventAllowed(eventSpec)) continue
      if (nsSpec.eventStyle === 'webRequest') {
        // The engine's event objects never fire (see the spec); replaced, native or not.
        const object = webRequestEvent(namespace, name, eventSpec)
        for (const target of targets) define(target, name, object)
        continue
      }
      const fullName = `${namespace}.${name}`
      const primary = targets[0]
      const native = safely(() => primary[name])
      const keepNative = eventSpec.keepNative || Boolean(nsSpec.shape)
      if (keepNative && native && typeof native.addListener === 'function') continue
      const object = createEvent(fullName, native, {
        nativeDelivers: Boolean(eventSpec.nativeInFrames) && host.kind === 'frame',
        filters: eventSpec.filters === true
      })
      for (const target of targets) define(target, name, object)
    }
    for (const [object, settings] of Object.entries(nsSpec.settings ?? {})) {
      const holders = targets.map((target) => namespaceOn(target, object))
      for (const setting of settings) {
        const value = chromeSetting(namespace, object, setting)
        for (const holder of holders) define(holder, setting, value)
      }
    }
    for (const setting of nsSpec.ownSettings ?? []) {
      const value = chromeSetting(namespace, null, setting)
      for (const target of targets) define(target, setting, value)
    }
    for (const type of nsSpec.contentSettings ?? []) {
      const value = contentSetting(namespace, type)
      for (const target of targets) define(target, type, value)
    }
    for (const [name, value] of Object.entries(nsSpec.constants ?? {})) {
      for (const target of targets) {
        if (safely(() => target[name]) === undefined) define(target, name, value)
      }
    }
  }

  for (const [namespace, nsSpec] of Object.entries(spec)) {
    if (nsSpec.manifestVersion && nsSpec.manifestVersion !== manifestVersion) continue
    if (!namespaceAllowed(namespace, nsSpec)) continue
    if (!toggleOn(nsSpec)) {
      defineToggledOff(namespace, nsSpec)
      continue
    }
    installNamespace(namespace, nsSpec)
  }

  // The engine's `tabs.sendMessage` never reaches the user-script worlds: for an extension that
  // can have some, the call also goes to the host (whatever the toggle says; without worlds the
  // host has nothing to deliver to).
  if (hasUserScripts && spec.userScripts) {
    for (const root of roots) wrapTabsSendMessage(namespaceOn(root, 'tabs'))
  }

  // ---------------------------------------------------------------------------
  // contextMenus: `create` returns its id synchronously, `onclick` stays on this side
  // ---------------------------------------------------------------------------

  /** `onclick` handlers by item id (functions cannot cross to the host). */
  const menuClickHandlers = new Map<string, Listener>()
  let generatedMenuIds = 0
  const menuKey = (id: string | number): string => (typeof id === 'number' ? `n:${id}` : `s:${id}`)
  const menuQualified = 'contextMenus.create(object createProperties, optional function callback)'

  /** Strip `onclick` for the wire (a flag tells the host one was given) and remember it here. */
  function menuProperties(
    props: Record<string, unknown>,
    id: string | number | null
  ): Record<string, unknown> {
    const sent: Record<string, unknown> = { ...props }
    const onclick = props.onclick
    if (isFunction(onclick)) {
      sent.onclick = true
      if (id !== null) menuClickHandlers.set(menuKey(id), onclick)
    } else {
      delete sent.onclick
    }
    return sent
  }

  if (spec.contextMenus) {
    for (const root of roots) {
      const menus = namespaceOn(root, 'contextMenus')
      define(menus, 'create', function (...raw: unknown[]): unknown {
        const callback = takeCallback(raw)
        const props = raw[0]
        if (!isObject(props)) throw signatureError(menuQualified)
        let id: string | number
        if (isMenuId(props.id)) {
          id = props.id
        } else {
          generatedMenuIds += 1
          id = generatedMenuIds
        }
        const sent = menuProperties(props, id)
        const work = invoke('contextMenus', 'create', [sent, id]).then(
          () => undefined,
          (error: unknown) => {
            menuClickHandlers.delete(menuKey(id))
            throw error
          }
        )
        // Chrome reports failures through runtime.lastError (unchecked when no callback is given).
        settle(menuQualified, work, callback ?? (() => undefined))
        return id
      })
      define(menus, 'update', function (...raw: unknown[]): unknown {
        const callback = takeCallback(raw)
        const qualified =
          'contextMenus.update(integer|string id, object updateProperties, optional function callback)'
        const [id, props] = normalizeArgs(qualified, raw, [
          { name: 'id', type: ['integer', 'string'] },
          { name: 'updateProperties', type: 'object' }
        ])
        const sent = isObject(props) && isMenuId(id) ? menuProperties(props, id) : props
        return settle(qualified, invoke('contextMenus', 'update', [id, sent]), callback)
      })
      define(menus, 'remove', function (...raw: unknown[]): unknown {
        const callback = takeCallback(raw)
        const qualified =
          'contextMenus.remove(integer|string menuItemId, optional function callback)'
        const [id] = normalizeArgs(qualified, raw, [
          { name: 'menuItemId', type: ['integer', 'string'] }
        ])
        if (isMenuId(id)) menuClickHandlers.delete(menuKey(id))
        return settle(qualified, invoke('contextMenus', 'remove', [id]), callback)
      })
      define(menus, 'removeAll', function (...raw: unknown[]): unknown {
        const callback = takeCallback(raw)
        menuClickHandlers.clear()
        return settle(
          'contextMenus.removeAll(optional function callback)',
          invoke('contextMenus', 'removeAll', []),
          callback
        )
      })
    }
  }

  // ---------------------------------------------------------------------------
  // tts: `speak`'s `onEvent` stays on this side, keyed by a token the host echoes back
  // ---------------------------------------------------------------------------

  if (spec.tts && namespaceAllowed('tts', spec.tts)) {
    const ttsHandlers = new Map<string, Listener>()
    const ttsPrefix = Math.random().toString(36).slice(2)
    let ttsTokens = 0
    let ttsRelay: EventObject | null = null
    const ttsQualified =
      'tts.speak(string utterance, optional object options, optional function callback)'
    /** The hidden `tts.onEvent` listener: registered with the host on the first `onEvent`. */
    const relayEvents = (): void => {
      if (ttsRelay) return
      ttsRelay = createEvent('tts.onEvent', undefined, { nativeDelivers: false })
      ttsRelay.addListener((token: unknown, event: unknown) => {
        if (typeof token !== 'string') return
        const handler = ttsHandlers.get(token)
        if (!handler) return
        if (isObject(event) && event.isFinalEvent === true) ttsHandlers.delete(token)
        callListener(handler, [event])
      })
    }
    for (const root of roots) {
      const tts = namespaceOn(root, 'tts')
      define(tts, 'speak', function (...raw: unknown[]): unknown {
        const callback = takeCallback(raw)
        const [utterance, options] = normalizeArgs(ttsQualified, raw, [
          { name: 'utterance', type: 'string' },
          { name: 'options', type: 'object', optional: true }
        ])
        let token: string | null = null
        let sent: unknown = options
        if (isObject(options)) {
          const { onEvent, ...rest } = options
          sent = rest
          if (isFunction(onEvent)) {
            ttsTokens += 1
            token = `${ttsPrefix}:${ttsTokens}`
            ttsHandlers.set(token, onEvent)
            relayEvents()
          }
        }
        const work = invoke('tts', 'speak', [utterance, sent, token]).then(
          () => undefined,
          (error: unknown) => {
            if (token) ttsHandlers.delete(token)
            throw error
          }
        )
        return settle(ttsQualified, work, callback)
      })
    }
  }

  // ---------------------------------------------------------------------------
  // identity: `getRedirectURL` returns synchronously in Chrome (extensions splice it straight
  // into an authorization URL), so it is computed here from the extension's own id
  // ---------------------------------------------------------------------------

  if (spec.identity && namespaceAllowed('identity', spec.identity)) {
    const ownId: string =
      safely(() => String(chrome.runtime.id)) ??
      /^chrome-extension:\/\/([^/]+)\//.exec(extensionUrl)?.[1] ??
      ''
    for (const root of roots) {
      define(namespaceOn(root, 'identity'), 'getRedirectURL', function (path?: unknown): string {
        if (path !== undefined && path !== null && typeof path !== 'string') {
          throw new TypeError(
            "Error in invocation of identity.getRedirectURL(optional string path): Error at parameter 'path': Invalid type: expected string."
          )
        }
        const suffix = typeof path === 'string' ? path.replace(/^\/+/, '') : ''
        return `https://${ownId}.chromiumapp.org/${suffix}`
      })
    }
  }

  // ---------------------------------------------------------------------------
  // tabCapture: the stream reaches the extension through this document's own getUserMedia
  // (Chrome's binding does the same); the host turns the id it answered into the engine's for
  // the document that consumes it, and hears how the consuming call went
  // ---------------------------------------------------------------------------

  if (spec.tabCapture && namespaceAllowed('tabCapture', spec.tabCapture)) {
    const captureQualified = 'tabCapture.capture(object options, function callback)'
    const SOURCE = 'chromeMediaSource'
    const SOURCE_ID = 'chromeMediaSourceId'
    /** The constraint sets of one track kind: `mandatory` and the `optional` list. */
    const constraintSets = (track: unknown): unknown[] => {
      if (!isObject(track)) return []
      const sets: unknown[] = [track.mandatory]
      if (Array.isArray(track.optional)) sets.push(...track.optional)
      return sets
    }
    /** The stream ids `constraints` names under `chromeMediaSource: "tab"`. */
    const tabSourceIds = (constraints: unknown): string[] => {
      if (!isObject(constraints)) return []
      const ids: string[] = []
      for (const kind of ['audio', 'video']) {
        for (const set of constraintSets(constraints[kind])) {
          if (!isObject(set) || set[SOURCE] !== 'tab') continue
          const id = set[SOURCE_ID]
          if (typeof id === 'string' && !ids.includes(id)) ids.push(id)
        }
      }
      return ids
    }
    /** The same constraints, each named tab stream id mapped through `resolve`. */
    const withResolvedIds = (constraints: unknown, resolve: (id: string) => string): unknown => {
      if (!isObject(constraints)) return constraints
      const out: Record<string, unknown> = { ...constraints }
      const mapped = (set: unknown): unknown =>
        isObject(set) && set[SOURCE] === 'tab' && typeof set[SOURCE_ID] === 'string'
          ? { ...set, [SOURCE_ID]: resolve(set[SOURCE_ID]) }
          : set
      for (const kind of ['audio', 'video']) {
        const track = constraints[kind]
        if (!isObject(track)) continue
        const next: Record<string, unknown> = { ...track }
        if (track.mandatory !== undefined) next.mandatory = mapped(track.mandatory)
        if (Array.isArray(track.optional)) next.optional = track.optional.map(mapped)
        out[kind] = next
      }
      return out
    }
    const reportState = (ids: string[], state: string): void => {
      for (const id of ids) {
        void invoke('tabCapture', 'streamState', [id, state]).catch(() => undefined)
      }
    }
    /** The stream's end: its tracks ended, or it went inactive (every track stopped). */
    const watchStream = (stream: Any, onEnded: () => void): void => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        onEnded()
      }
      const tracks: unknown = safely(() => stream.getTracks())
      if (Array.isArray(tracks)) {
        let live = tracks.length
        for (const track of tracks) {
          safely(() =>
            track.addEventListener('ended', () => {
              live -= 1
              if (live <= 0) finish()
            })
          )
        }
      }
      safely(() => stream.addEventListener('inactive', finish))
    }
    /** Chromium words a tab stream the engine cannot start as an `InvalidStateError`. */
    const invalidState = (error: unknown): unknown => {
      const message = error instanceof Error ? error.message : String(error)
      const DomException: Any = safely(() => real.DOMException)
      return typeof DomException === 'function'
        ? new DomException(message, 'InvalidStateError')
        : error
    }
    /**
     * A `getUserMedia` naming tab stream ids: the host registers each with the engine for this
     * document and answers the engine's id, which goes in the id's place; the call's outcome
     * is reported back as the capture's state.
     */
    const capturingUserMedia = (
      native: (constraints: unknown) => Promise<Any>,
      constraints: unknown
    ): Promise<Any> => {
      const ids = tabSourceIds(constraints)
      if (ids.length === 0) return native(constraints)
      return Promise.all(
        ids.map((id) =>
          invoke('tabCapture', 'resolveStreamId', [id]).then(
            (engineId: unknown): [string, string] => [
              id,
              typeof engineId === 'string' ? engineId : id
            ]
          )
        )
      ).then(
        (pairs) => {
          const map = new Map<string, string>(pairs)
          const resolved = withResolvedIds(constraints, (id) => map.get(id) ?? id)
          return native(resolved).then(
            (stream: Any) => {
              reportState(ids, 'active')
              watchStream(stream, () => reportState(ids, 'stopped'))
              return stream
            },
            (error: unknown) => {
              reportState(ids, 'error')
              throw error
            }
          )
        },
        (error: unknown) => {
          throw invalidState(error)
        }
      )
    }
    /** This document's `getUserMedia`, patched; null in a context without one (a worker). */
    let userMedia: ((constraints: unknown) => Promise<Any>) | null = null
    if (host.kind === 'frame') {
      const nav: Any = safely(() => real.navigator)
      const devices: Any = nav ? safely(() => nav.mediaDevices) : undefined
      const nativeGum: unknown = devices ? safely(() => devices.getUserMedia) : undefined
      if (devices && isFunction(nativeGum)) {
        const callNative = (constraints: unknown): Promise<Any> => {
          try {
            return Promise.resolve(nativeGum.call(devices, constraints))
          } catch (error) {
            return Promise.reject(error)
          }
        }
        userMedia = (constraints) => capturingUserMedia(callNative, constraints)
        define(devices, 'getUserMedia', function (constraints: unknown): Promise<Any> {
          return capturingUserMedia(callNative, constraints)
        })
      }
      // The callback forms Chrome's own binding used (`navigator.webkitGetUserMedia`).
      for (const name of ['webkitGetUserMedia', 'getUserMedia']) {
        const legacy: unknown = nav ? safely(() => nav[name]) : undefined
        if (!isFunction(legacy)) continue
        define(
          nav,
          name,
          function (constraints: unknown, onSuccess: unknown, onError: unknown): void {
            const native = (c: unknown): Promise<Any> =>
              new Promise((resolve, reject) => {
                try {
                  legacy.call(nav, c, resolve, reject)
                } catch (error) {
                  reject(error)
                }
              })
            capturingUserMedia(native, constraints).then(
              (stream: Any) => {
                if (isFunction(onSuccess)) onSuccess(stream)
              },
              (error: unknown) => {
                if (isFunction(onError)) onError(error)
              }
            )
          }
        )
      }
    }
    for (const root of roots) {
      const tabCapture = namespaceOn(root, 'tabCapture')
      if (host.kind !== 'frame') {
        // Chrome keeps `capture` out of service workers (`disallow_for_service_workers`): a
        // worker has no `getUserMedia` to hand the stream to; `getMediaStreamId` is its way.
        safely(() => Reflect.deleteProperty(tabCapture, 'capture'))
        continue
      }
      define(tabCapture, 'capture', function (...raw: unknown[]): unknown {
        const callback = takeCallback(raw)
        const [options] = normalizeArgs(captureQualified, raw, [
          { name: 'options', type: 'object' }
        ])
        // The host answers the options with the source constraints added, as Chrome's
        // `TabCaptureCaptureFunction` does; the stream comes from this document's getUserMedia.
        const work = invoke('tabCapture', 'capture', [options]).then((answer: unknown) => {
          const constraints: Record<string, unknown> = {}
          if (isObject(answer)) {
            if (answer.audioConstraints) constraints.audio = answer.audioConstraints
            if (answer.videoConstraints) constraints.video = answer.videoConstraints
          }
          if (!userMedia) throw new Error('getUserMedia is not available in this document.')
          return userMedia(constraints)
        })
        if (!callback) return work
        work.then(
          (stream: unknown) => callListener(callback, [stream]),
          (error: unknown) => {
            // Chrome's binding: the callback gets null and `runtime.lastError` the message.
            const message = error instanceof Error ? error.message : String(error)
            withLastError(captureQualified, message, () => callListener(callback, [null]))
          }
        )
        return undefined
      })
    }
  }

  // ---------------------------------------------------------------------------
  // desktopCapture: `chooseDesktopMedia` answers its request id synchronously, the picker's
  // choice through the callback; `cancelChooseDesktopMedia` withdraws a pending callback
  // ---------------------------------------------------------------------------

  if (spec.desktopCapture && namespaceAllowed('desktopCapture', spec.desktopCapture)) {
    const chooseQualified =
      'desktopCapture.chooseDesktopMedia(array sources, optional tabs.Tab targetTab, function callback)'
    const pendingChoices = new Map<number, Listener>()
    let choiceIds = 0
    for (const root of roots) {
      const desktopCapture = namespaceOn(root, 'desktopCapture')
      define(desktopCapture, 'chooseDesktopMedia', function (...raw: unknown[]): number {
        const callback = takeCallback(raw)
        if (!callback) throw signatureError(chooseQualified)
        const [sources, targetTab] = normalizeArgs(chooseQualified, raw, [
          { name: 'sources', type: 'array' },
          { name: 'targetTab', type: 'object', optional: true }
        ])
        choiceIds += 1
        const id = choiceIds
        pendingChoices.set(id, callback)
        const answer = (args: unknown[], error?: string): void => {
          const pending = pendingChoices.get(id)
          if (!pending) return
          pendingChoices.delete(id)
          if (error === undefined) callListener(pending, args)
          else withLastError(chooseQualified, error, () => callListener(pending, args))
        }
        invoke('desktopCapture', 'chooseDesktopMedia', [sources, targetTab]).then(
          (result: unknown) => {
            const streamId =
              isObject(result) && typeof result.streamId === 'string' ? result.streamId : ''
            const options =
              isObject(result) && isObject(result.options)
                ? result.options
                : { canRequestAudioTrack: false }
            answer([streamId, options])
          },
          (error: unknown) => answer([], error instanceof Error ? error.message : String(error))
        )
        return id
      })
      define(desktopCapture, 'cancelChooseDesktopMedia', function (id: unknown): void {
        if (typeof id !== 'number' || !pendingChoices.has(id)) return
        pendingChoices.delete(id)
        void invoke('desktopCapture', 'cancelChooseDesktopMedia', [id]).catch(() => undefined)
      })
    }
  }

  /** A click on an item created with `onclick`: Chrome calls that handler besides `onClicked`. */
  function menuClicked(args: unknown[]): void {
    const info = args[0]
    if (!isObject(info) || !isMenuId(info.menuItemId)) return
    const handler = menuClickHandlers.get(menuKey(info.menuItemId))
    if (handler) callListener(handler, args)
  }

  // ---------------------------------------------------------------------------
  // storage: host-backed sync/managed, native local/session with change notifications
  // ---------------------------------------------------------------------------

  const SYNC_CONSTANTS = {
    QUOTA_BYTES: 102400,
    QUOTA_BYTES_PER_ITEM: 8192,
    MAX_ITEMS: 512,
    MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
    MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
    MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1000000
  }

  /** The engine's callback-style area method, awaited; `runtime.lastError` becomes the rejection. */
  function callNativeArea(
    area: object,
    method: (...args: unknown[]) => unknown,
    args: unknown[]
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      try {
        method.call(area, ...args, (result: unknown) => {
          const error: unknown = safely(() => chrome.runtime.lastError)
          if (error) {
            reject(new Error(String(isObject(error) && error.message ? error.message : error)))
          } else resolve(result)
        })
      } catch (error) {
        reject(error)
      }
    })
  }

  function sameJson(a: unknown, b: unknown): boolean {
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch {
      return false
    }
  }

  function hostArea(storage: object, areaName: string): Record<string, unknown> {
    const area: Record<string, unknown> = {}
    const qualifiedFor = (name: string): string => `storage.${areaName}.${name}`
    const routed = (name: string, params: ParamSpec[]): void => {
      define(area, name, function (...raw: unknown[]): unknown {
        const callback = takeCallback(raw)
        const args = normalizeArgs(qualifiedFor(name), raw, params)
        return settle(qualifiedFor(name), invoke('storage', name, [areaName, ...args]), callback)
      })
    }
    routed('get', [{ name: 'keys', type: ['string', 'array', 'object'], optional: true }])
    routed('set', [{ name: 'items', type: 'object' }])
    routed('remove', [{ name: 'keys', type: ['string', 'array'] }])
    routed('clear', [])
    routed('getBytesInUse', [{ name: 'keys', type: ['string', 'array'], optional: true }])
    routed('getKeys', [])
    routed('setAccessLevel', [{ name: 'accessOptions', type: 'object' }])
    if (areaName === 'sync') for (const [k, v] of Object.entries(SYNC_CONSTANTS)) define(area, k, v)
    if (areaName === 'local') define(area, 'QUOTA_BYTES', 10485760)
    if (areaName === 'session') define(area, 'QUOTA_BYTES', 10485760)
    define(
      area,
      'onChanged',
      createEvent(`storage.${areaName}.onChanged`, undefined, { nativeDelivers: false })
    )
    define(storage, areaName, area)
    return area
  }

  // The content-script storage prelude (`contentScriptStorage.ts`) keeps `sync` and `managed`
  // for content scripts under these reserved keys of native `local`; spelled out again here
  // because the shim is stringified. The extension never sees them through `local`.
  const RESERVED_KEY_PREFIX = '__zenium_'
  const SYNC_KEY_PREFIX = '__zenium_sync__/'
  const MANAGED_KEY_PREFIX = '__zenium_managed__/'
  const SYNC_OUTBOX_KEY = '__zenium_sync_outbox__'
  const SYNC_CHANNEL = 'zenium:storage.sync'

  function isReservedKey(key: unknown): boolean {
    return typeof key === 'string' && key.startsWith(RESERVED_KEY_PREFIX)
  }

  function withoutReserved(items: StorageItems): StorageItems {
    const out: StorageItems = {}
    for (const key of Object.keys(items)) if (!isReservedKey(key)) out[key] = items[key]
    return out
  }

  /** Native storage changes with the reserved keys taken out; null when nothing is left. */
  function visibleChanges(changes: unknown): StorageChanges | null {
    if (!isObject(changes)) return null
    const out: StorageChanges = {}
    let any = false
    for (const key of Object.keys(changes)) {
      if (isReservedKey(key)) continue
      out[key] = changes[key] as StorageChanges[string]
      any = true
    }
    return any ? out : null
  }

  /** Chrome's byte count of items: key length plus the length of the value's JSON. */
  function bytesOfItems(items: StorageItems): number {
    let total = 0
    for (const key of Object.keys(items)) {
      let length = 0
      try {
        const text = JSON.stringify(items[key])
        length = text === undefined ? 0 : text.length
      } catch {
        /* not serialisable */
      }
      total += key.length + length
    }
    return total
  }

  /** The engine's `local`, as captured before the extension-facing wrappers replace its members. */
  interface NativeLocal {
    area: Record<string, unknown>
    get: (...args: unknown[]) => unknown
    set: (...args: unknown[]) => unknown
    remove: ((...args: unknown[]) => unknown) | undefined
    getKeys: ((...args: unknown[]) => unknown) | undefined
  }

  /**
   * The engine's `local` / `session` with change notifications for the host (workers never get
   * the engine's events) and, for `local`, the mirror's reserved keys kept out of `get`, `set`,
   * `remove`, `clear`, `getBytesInUse`, `getKeys` and the change events.
   */
  function wrapNativeArea(
    area: Record<string, unknown>,
    areaName: string,
    hidden: boolean
  ): NativeLocal | null {
    const nativeSet = safely(() => area.set)
    const nativeGet = safely(() => area.get)
    const nativeRemove = safely(() => area.remove)
    const nativeClear = safely(() => area.clear)
    const nativeBytes = safely(() => area.getBytesInUse)
    const nativeKeys = safely(() => area.getKeys)
    if (!isFunction(nativeSet) || !isFunction(nativeGet)) return null
    const read = async (keys: unknown): Promise<StorageItems> => {
      const items = await callNativeArea(area, nativeGet, [keys])
      return isObject(items) ? items : {}
    }
    const notify = (changes: StorageChanges): void => {
      if (Object.keys(changes).length > 0)
        host.notify('storage-changed', { area: areaName, changes })
    }
    const keyList = (keys: unknown): string[] | null =>
      typeof keys === 'string'
        ? [keys]
        : Array.isArray(keys)
          ? keys.filter((k): k is string => typeof k === 'string')
          : null
    if (hidden) {
      define(area, 'get', function (...raw: unknown[]): unknown {
        const callback = takeCallback(raw)
        const keys = raw[0]
        const work = (async (): Promise<StorageItems> => {
          let request: unknown = keys
          if (typeof keys === 'string') {
            if (isReservedKey(keys)) return {}
          } else if (Array.isArray(keys)) {
            request = keys.filter((k) => !isReservedKey(k))
          } else if (isObject(keys)) {
            request = withoutReserved(keys)
          }
          return withoutReserved(await read(request))
        })()
        return settle(`storage.${areaName}.get`, work, callback)
      })
    }
    define(area, 'set', function (...raw: unknown[]): unknown {
      const callback = takeCallback(raw)
      const items = raw[0]
      const work = (async (): Promise<void> => {
        if (!isObject(items)) throw signatureError(`storage.${areaName}.set(object items)`)
        const allowed = hidden ? withoutReserved(items) : items
        const keys = Object.keys(allowed)
        if (keys.length === 0 && Object.keys(items).length > 0) return
        const before = await read(keys)
        await callNativeArea(area, nativeSet, [allowed])
        const changes: StorageChanges = {}
        for (const key of keys) {
          const newValue = allowed[key]
          if (newValue === undefined) continue
          const had = Object.prototype.hasOwnProperty.call(before, key)
          if (had && sameJson(before[key], newValue)) continue
          changes[key] = had ? { oldValue: before[key], newValue } : { newValue }
        }
        notify(changes)
      })()
      return settle(`storage.${areaName}.set`, work, callback)
    })
    if (isFunction(nativeRemove)) {
      define(area, 'remove', function (...raw: unknown[]): unknown {
        const callback = takeCallback(raw)
        const keys = raw[0]
        const work = (async (): Promise<void> => {
          const list = keyList(keys)
          if (!list) throw signatureError(`storage.${areaName}.remove(string|array keys)`)
          const allowed = hidden ? list.filter((k) => !isReservedKey(k)) : list
          if (allowed.length === 0) return
          const before = await read(allowed)
          await callNativeArea(area, nativeRemove, [hidden ? allowed : keys])
          const changes: StorageChanges = {}
          for (const key of allowed) {
            if (Object.prototype.hasOwnProperty.call(before, key))
              changes[key] = { oldValue: before[key] }
          }
          notify(changes)
        })()
        return settle(`storage.${areaName}.remove`, work, callback)
      })
    }
    if (isFunction(nativeClear)) {
      define(area, 'clear', function (...raw: unknown[]): unknown {
        const callback = takeCallback(raw)
        const work = (async (): Promise<void> => {
          const before = hidden ? withoutReserved(await read(null)) : await read(null)
          if (hidden && isFunction(nativeRemove)) {
            const keys = Object.keys(before)
            if (keys.length > 0) await callNativeArea(area, nativeRemove, [keys])
          } else {
            await callNativeArea(area, nativeClear, [])
          }
          const changes: StorageChanges = {}
          for (const key of Object.keys(before)) changes[key] = { oldValue: before[key] }
          notify(changes)
        })()
        return settle(`storage.${areaName}.clear`, work, callback)
      })
    }
    if (hidden && isFunction(nativeBytes)) {
      define(area, 'getBytesInUse', function (...raw: unknown[]): unknown {
        const callback = takeCallback(raw)
        const keys = raw[0]
        const work =
          keys === null || keys === undefined
            ? read(null).then((items) => bytesOfItems(withoutReserved(items)))
            : callNativeArea(area, nativeBytes, [
                (keyList(keys) ?? []).filter((k) => !isReservedKey(k))
              ])
        return settle(`storage.${areaName}.getBytesInUse`, work, callback)
      })
    }
    if (hidden && isFunction(nativeKeys)) {
      define(area, 'getKeys', function (...raw: unknown[]): unknown {
        const callback = takeCallback(raw)
        const work = callNativeArea(area, nativeKeys, []).then((keys) =>
          Array.isArray(keys) ? keys.filter((k) => !isReservedKey(k)) : []
        )
        return settle(`storage.${areaName}.getKeys`, work, callback)
      })
    }
    const onChanged = safely(() => area.onChanged)
    define(
      area,
      'onChanged',
      createEvent(
        `storage.${areaName}.onChanged`,
        isNativeEvent(onChanged) ? onChanged : undefined,
        {
          nativeDelivers: host.kind === 'frame',
          nativeMap: hidden
            ? (args) => {
                const changes = visibleChanges(args[0])
                return changes ? [changes] : null
              }
            : undefined
        }
      )
    )
    return {
      area,
      get: nativeGet,
      set: nativeSet,
      remove: isFunction(nativeRemove) ? nativeRemove : undefined,
      getKeys: isFunction(nativeKeys) ? nativeKeys : undefined
    }
  }

  let nativeLocal: NativeLocal | null = null
  {
    const primaryStorage = namespaceOn(roots[0], 'storage')
    for (const areaName of ['local', 'session']) {
      const native = safely(() => primaryStorage[areaName])
      if (native && typeof native === 'object') {
        const wrapped = wrapNativeArea(native, areaName, areaName === 'local')
        if (areaName === 'local') nativeLocal = wrapped
      } else hostArea(primaryStorage, areaName)
    }
    for (const areaName of ['sync', 'managed']) hostArea(primaryStorage, areaName)
    const nativeOnChanged = safely(() => primaryStorage.onChanged)
    define(
      primaryStorage,
      'onChanged',
      createEvent('storage.onChanged', nativeOnChanged, {
        nativeDelivers: host.kind === 'frame',
        // Documents get local/session changes from the engine; sync/managed only exist host-side.
        nativeHandles: (args) => args[1] === 'local' || args[1] === 'session',
        nativeMap: (args) => {
          if (args[1] !== 'local') return args
          const changes = visibleChanges(args[0])
          return changes ? [changes, 'local'] : null
        }
      })
    )
    define(primaryStorage, 'AccessLevel', {
      TRUSTED_CONTEXTS: 'TRUSTED_CONTEXTS',
      TRUSTED_AND_UNTRUSTED_CONTEXTS: 'TRUSTED_AND_UNTRUSTED_CONTEXTS'
    })
    for (const root of roots.slice(1)) {
      const other = namespaceOn(root, 'storage')
      for (const key of ['local', 'session', 'sync', 'managed', 'onChanged', 'AccessLevel'])
        define(other, key, primaryStorage[key])
    }
  }

  // ---------------------------------------------------------------------------
  // The content scripts' side of sync/managed: the mirror in this partition's `local`, the
  // channel their writes arrive on, and the prelude first in every injection
  // ---------------------------------------------------------------------------

  const storagePrelude: string | null =
    typeof options?.storagePrelude === 'string' && options.storagePrelude.length > 0
      ? options.storagePrelude
      : null

  interface MirrorPayload {
    seq: number
    sync?: StorageChanges
    managed?: StorageChanges
  }

  function mirrorPayload(value: unknown): MirrorPayload | null {
    if (!isObject(value) || typeof value.seq !== 'number') return null
    const payload: MirrorPayload = { seq: value.seq }
    if (isObject(value.sync)) payload.sync = value.sync as StorageChanges
    if (isObject(value.managed)) payload.managed = value.managed as StorageChanges
    return payload
  }

  /**
   * The mirror: the host's `storage.sync` and `storage.managed` of this extension, kept under
   * the reserved keys of this partition's native `local`, where the prelude reads them. One
   * context per partition writes it (the host addresses the worker or background page first);
   * every write here goes through one promise chain, so the host's changes land in order. A
   * change whose sequence number skips one means a missed delivery: the snapshot is taken again.
   */
  function createMirror(local: NativeLocal): {
    start(): Promise<void>
    apply(payload: unknown): Promise<void>
  } {
    let chain: Promise<void> = Promise.resolve()
    let appliedSeq = -1
    const enqueue = (work: () => Promise<void>): Promise<void> => {
      chain = chain.then(work, work).catch(() => undefined)
      return chain
    }
    const call = (
      method: ((...args: unknown[]) => unknown) | undefined,
      args: unknown[]
    ): Promise<unknown> =>
      method ? callNativeArea(local.area, method, args) : Promise.resolve(undefined)
    const mirrored = (key: string): boolean =>
      key.startsWith(SYNC_KEY_PREFIX) || key.startsWith(MANAGED_KEY_PREFIX)

    async function mirroredKeys(): Promise<string[]> {
      if (local.getKeys) {
        const keys = await call(local.getKeys, [])
        return Array.isArray(keys)
          ? keys.filter((k): k is string => typeof k === 'string' && mirrored(k))
          : []
      }
      const all = await call(local.get, [null])
      return isObject(all) ? Object.keys(all).filter(mirrored) : []
    }

    async function write(set: StorageItems, remove: string[]): Promise<void> {
      if (remove.length > 0) await call(local.remove, [remove])
      if (Object.keys(set).length > 0) await call(local.set, [set])
    }

    /** Writes made by the prelude while no context could relay them go to the host first. */
    async function flushOutbox(): Promise<void> {
      const stored = await call(local.get, [SYNC_OUTBOX_KEY])
      const queue =
        isObject(stored) && Array.isArray(stored[SYNC_OUTBOX_KEY]) ? stored[SYNC_OUTBOX_KEY] : []
      if (queue.length === 0) return
      for (const item of queue) {
        if (!isObject(item) || typeof item.op !== 'string') continue
        const args = Array.isArray(item.args) ? item.args : []
        await invoke('storage', 'syncWrite', [item.op, args]).catch(() => undefined)
      }
      await call(local.remove, [SYNC_OUTBOX_KEY])
    }

    async function reconcile(): Promise<void> {
      await flushOutbox()
      const snapshot = await invoke('storage', 'syncMirror', [])
      if (!isObject(snapshot)) return
      const desired: StorageItems = {}
      const sync = isObject(snapshot.sync) ? snapshot.sync : {}
      const managed = isObject(snapshot.managed) ? snapshot.managed : {}
      for (const key of Object.keys(sync)) desired[SYNC_KEY_PREFIX + key] = sync[key]
      for (const key of Object.keys(managed)) desired[MANAGED_KEY_PREFIX + key] = managed[key]
      const existing = await mirroredKeys()
      const stale = existing.filter((k) => !Object.prototype.hasOwnProperty.call(desired, k))
      const wanted = Object.keys(desired)
      const current = wanted.length > 0 ? await call(local.get, [wanted]) : {}
      const set: StorageItems = {}
      for (const key of wanted) {
        if (!isObject(current) || !Object.prototype.hasOwnProperty.call(current, key)) {
          set[key] = desired[key]
        } else if (!sameJson(current[key], desired[key])) set[key] = desired[key]
      }
      await write(set, stale)
      if (typeof snapshot.seq === 'number') appliedSeq = snapshot.seq
    }

    async function applyChanges(payload: MirrorPayload): Promise<void> {
      const set: StorageItems = {}
      const remove: string[] = []
      const areas: Array<[string, StorageChanges | undefined]> = [
        [SYNC_KEY_PREFIX, payload.sync],
        [MANAGED_KEY_PREFIX, payload.managed]
      ]
      for (const [prefix, changes] of areas) {
        if (!changes) continue
        for (const key of Object.keys(changes)) {
          const change = changes[key]
          if (isObject(change) && change.newValue !== undefined) set[prefix + key] = change.newValue
          else remove.push(prefix + key)
        }
      }
      await write(set, remove)
      appliedSeq = payload.seq
    }

    return {
      start: () => enqueue(reconcile),
      apply: (value) =>
        enqueue(async () => {
          const payload = mirrorPayload(value)
          if (!payload || payload.seq <= appliedSeq) return
          if (appliedSeq >= 0 && payload.seq > appliedSeq + 1) {
            await reconcile()
            return
          }
          await applyChanges(payload)
        })
    }
  }

  const mirror = storagePrelude && nativeLocal ? createMirror(nativeLocal) : null

  function isSyncChannelMessage(message: unknown): message is Record<string, unknown> {
    return isObject(message) && message.__zenium === SYNC_CHANNEL
  }

  /**
   * `runtime.onMessage`: the prelude's proxied writes never reach the extension's listeners, and
   * the extension's worker or background page (every document when it has neither) answers
   * them after the host committed and this partition's mirror carries the change, so the
   * content script's read after its write sees it.
   */
  function wrapRuntimeOnMessage(event: NativeEvent, answers: boolean): void {
    const proxies = new WeakMap<Listener, Listener>()
    const nativeAdd = event.addListener
    const nativeRemove = event.removeListener
    const nativeHas: unknown = safely(
      () => (event as unknown as Record<string, unknown>).hasListener
    )
    define(event, 'addListener', function (fn: unknown, ...rest: unknown[]): void {
      if (!isFunction(fn)) return
      let proxy = proxies.get(fn)
      if (!proxy) {
        proxy = (message: unknown, ...args: unknown[]) =>
          isSyncChannelMessage(message) ? undefined : fn(message, ...args)
        proxies.set(fn, proxy)
      }
      nativeAdd.call(event, proxy, ...rest)
    })
    define(event, 'removeListener', function (fn: unknown): void {
      if (!isFunction(fn)) return
      const proxy = proxies.get(fn)
      if (proxy) nativeRemove.call(event, proxy)
    })
    if (isFunction(nativeHas)) {
      define(event, 'hasListener', function (fn: unknown): boolean {
        if (!isFunction(fn)) return false
        const proxy = proxies.get(fn)
        return proxy ? Boolean(nativeHas.call(event, proxy)) : false
      })
    }
    if (!answers || !mirror) return
    const answer = (message: unknown, _sender: unknown, sendResponse: unknown): unknown => {
      if (!isSyncChannelMessage(message) || !isFunction(sendResponse)) return undefined
      const op = typeof message.op === 'string' ? message.op : ''
      const args = Array.isArray(message.args) ? message.args : []
      invoke('storage', 'syncWrite', [op, args]).then(
        async (result) => {
          await mirror.apply(result)
          sendResponse({ __zenium: SYNC_CHANNEL, ok: true })
        },
        (error: unknown) => {
          sendResponse({
            __zenium: SYNC_CHANNEL,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      )
      return true
    }
    nativeAdd.call(event, answer)
  }

  if (mirror) {
    const answers = host.kind === 'worker' || isBackgroundPage || background === null
    const seen = new Set<object>()
    for (const root of roots) {
      const event: unknown = safely(() => root.runtime?.onMessage)
      if (!isNativeEvent(event) || seen.has(event)) continue
      seen.add(event)
      wrapRuntimeOnMessage(event, answers)
    }
    void mirror.start()
  }

  /** A `files` list with the prelude first (unchanged when it already leads). */
  function withPreludeFirst(files: unknown[]): unknown[] {
    return files[0] === storagePrelude ? files : [storagePrelude, ...files]
  }

  function wantsPrelude(entry: Record<string, unknown>, listKey: string): boolean {
    if (entry.world === 'MAIN') return false
    const list = entry[listKey]
    return Array.isArray(list) && list.some((item) => typeof item === 'string')
  }

  /** A native method awaited through its callback; `runtime.lastError` becomes the rejection. */
  function callNativeMethod(
    target: object,
    method: (...args: unknown[]) => unknown,
    args: unknown[]
  ): Promise<unknown> {
    return callNativeArea(target, method, args)
  }

  /**
   * `scripting`: registrations and file injections into isolated worlds get the prelude first
   * (what `getRegisteredContentScripts` returns has it taken out again); a function injection
   * that mentions `storage` runs after a separate injection of the prelude file.
   */
  function wrapScripting(scripting: Record<string, unknown>): void {
    const withLists = (scripts: unknown): unknown =>
      Array.isArray(scripts)
        ? scripts.map((entry: unknown) =>
            isObject(entry) && wantsPrelude(entry, 'js')
              ? { ...entry, js: withPreludeFirst(entry.js as unknown[]) }
              : entry
          )
        : scripts
    for (const name of ['registerContentScripts', 'updateContentScripts']) {
      const native = safely(() => scripting[name])
      if (!isFunction(native)) continue
      define(scripting, name, function (...raw: unknown[]): unknown {
        if (raw.length > 0) raw[0] = withLists(raw[0])
        return native.apply(scripting, raw)
      })
    }
    const nativeGet = safely(() => scripting.getRegisteredContentScripts)
    if (isFunction(nativeGet)) {
      const strip = (scripts: unknown): unknown =>
        Array.isArray(scripts)
          ? scripts.map((entry: unknown) =>
              isObject(entry) && Array.isArray(entry.js)
                ? { ...entry, js: entry.js.filter((file) => file !== storagePrelude) }
                : entry
            )
          : scripts
      define(scripting, 'getRegisteredContentScripts', function (...raw: unknown[]): unknown {
        const callback = takeCallback(raw)
        const work = callNativeMethod(scripting, nativeGet, raw).then(strip)
        return settle(
          'scripting.getRegisteredContentScripts(optional object filter, optional function callback)',
          work,
          callback
        )
      })
    }
    const nativeExecute = safely(() => scripting.executeScript)
    if (isFunction(nativeExecute)) {
      const qualified = 'scripting.executeScript(object injection, optional function callback)'
      define(scripting, 'executeScript', function (...raw: unknown[]): unknown {
        const injection = raw[0]
        if (!isObject(injection) || injection.world === 'MAIN') {
          return nativeExecute.apply(scripting, raw)
        }
        if (wantsPrelude(injection, 'files')) {
          raw[0] = { ...injection, files: withPreludeFirst(injection.files as unknown[]) }
          return nativeExecute.apply(scripting, raw)
        }
        const func = injection.func ?? injection.function
        if (!isFunction(func) || !/\bstorage\b/.test(String(func))) {
          return nativeExecute.apply(scripting, raw)
        }
        const callback = takeCallback(raw)
        const first: Record<string, unknown> = { target: injection.target, files: [storagePrelude] }
        if (injection.world !== undefined) first.world = injection.world
        if (injection.injectImmediately !== undefined)
          first.injectImmediately = injection.injectImmediately
        const work = callNativeMethod(scripting, nativeExecute, [first]).then(() =>
          callNativeMethod(scripting, nativeExecute, [injection])
        )
        return settle(qualified, work, callback)
      })
    }
  }

  /**
   * MV2 `tabs.executeScript`: a file injection, or code that mentions `storage`, runs after a
   * separate injection of the prelude into the same frames (`allFrames`, `frameId`, `runAt` and
   * the rest of the details carry over).
   */
  function wrapTabsExecuteScript(tabs: Record<string, unknown>): void {
    const native = safely(() => tabs.executeScript)
    if (!isFunction(native)) return
    const qualified =
      'tabs.executeScript(optional integer tabId, object details, optional function callback)'
    define(tabs, 'executeScript', function (...raw: unknown[]): unknown {
      const callback = takeCallback(raw)
      const detailsAt = raw.length >= 2 ? 1 : 0
      const details = raw[detailsAt]
      const wants =
        isObject(details) &&
        (typeof details.file === 'string' ||
          (typeof details.code === 'string' && /\bstorage\b/.test(details.code)))
      if (!wants) return native.apply(tabs, callback ? [...raw, callback] : raw)
      const prelude: Record<string, unknown> = { ...(details as Record<string, unknown>) }
      delete prelude.code
      prelude.file = storagePrelude
      const before = raw.slice(0, detailsAt)
      const work = callNativeMethod(tabs, native, [...before, prelude]).then(() =>
        callNativeMethod(tabs, native, [...before, details])
      )
      return settle(qualified, work, callback)
    })
  }

  if (storagePrelude) {
    for (const root of roots) {
      const scripting: unknown = safely(() => root.scripting)
      if (isObject(scripting)) wrapScripting(scripting)
      const tabs: unknown = safely(() => root.tabs)
      if (manifestVersion === 2 && isObject(tabs)) wrapTabsExecuteScript(tabs)
    }
  }

  // ---------------------------------------------------------------------------
  // extension (legacy): aliases onto runtime plus the view registry
  // ---------------------------------------------------------------------------

  let views: ExtensionView[] = []
  function viewStub(view: ExtensionView): ViewStub {
    let url: URL | { href: string }
    try {
      url = new URL(view.url)
    } catch {
      url = { href: view.url }
    }
    return {
      location: url,
      closed: false,
      close: () => undefined,
      focus: () => undefined,
      postMessage: () => undefined
    }
  }

  for (const root of roots) {
    const extension = namespaceOn(root, 'extension')
    const runtime = namespaceOn(root, 'runtime')
    // The manifest the extension reads is the one it wrote, withheld permissions included.
    if (withheld.required.length > 0 || withheld.optional.length > 0) {
      const nativeGetManifest = safely(() => runtime.getManifest)
      if (isFunction(nativeGetManifest)) {
        define(runtime, 'getManifest', (): unknown =>
          withDeclaredPermissions(nativeGetManifest.call(runtime))
        )
      }
    }
    if (typeof safely(() => extension.getURL) !== 'function') {
      define(extension, 'getURL', (path: string) => runtime.getURL(path))
    }
    if (safely(() => extension.inIncognitoContext) === undefined) {
      define(extension, 'inIncognitoContext', false)
    }
    defineGetter(extension, 'lastError', () => safely(() => runtime.lastError))
    if (typeof safely(() => extension.sendRequest) !== 'function') {
      define(extension, 'sendRequest', (...args: unknown[]) => runtime.sendMessage(...args))
    }
    if (safely(() => extension.onRequest) === undefined) {
      defineGetter(extension, 'onRequest', () => runtime.onMessage)
    }
    if (safely(() => extension.onRequestExternal) === undefined) {
      defineGetter(extension, 'onRequestExternal', () => runtime.onMessageExternal)
    }
    if (host.kind === 'frame') {
      define(extension, 'getViews', (fetchProperties?: unknown): unknown[] => {
        const out: unknown[] = []
        for (const view of views) {
          if (isObject(fetchProperties)) {
            if (fetchProperties.type && fetchProperties.type !== view.type) continue
            if (fetchProperties.tabId !== undefined && fetchProperties.tabId !== view.tabId)
              continue
            if (
              fetchProperties.windowId !== undefined &&
              fetchProperties.windowId !== view.windowId
            )
              continue
          }
          out.push(view.self || view.url === ownUrl ? real : viewStub(view))
        }
        return out
      })
      // The background page's `window` is only reachable from the background page itself: a
      // popup or options page has no JavaScript path to another document's global (Chrome's
      // binding gets it from the renderer's frame list), so it gets null and the extension falls
      // back to messaging, as it must under MV3 anyway.
      define(extension, 'getBackgroundPage', (): unknown => (isBackgroundPage ? real : null))
      if (!isFunction(safely(() => runtime.getBackgroundPage))) {
        define(runtime, 'getBackgroundPage', function (...raw: unknown[]): unknown {
          const callback = takeCallback(raw)
          const qualified = 'runtime.getBackgroundPage(optional function callback)'
          const work =
            manifestVersion === 2 && background !== null
              ? Promise.resolve(isBackgroundPage ? real : null)
              : Promise.reject(new Error('You do not have a background page.'))
          return settle(qualified, work, callback)
        })
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Event delivery from the host
  // ---------------------------------------------------------------------------

  host.onEvent((namespace, event, args, delivery) => {
    if (namespace === '__zen') {
      if (event === 'views' && Array.isArray(args[0])) views = args[0] as ExtensionView[]
      else if (event === 'toggles' && isObject(args[0])) applyToggles(args[0])
      else if (event === 'us-port') userScriptPortEvent(args[0])
      else if (event === 'sync-mirror' && mirror) void mirror.apply(args[0])
      return
    }
    // A `webRequest` event installed in its own style (registered with the host by listener):
    // the delivery names the one listener it is for. A spec without the style has generic
    // events, delivered below like any other.
    if (namespace === 'webRequest' && webRequestListeners.has(`webRequest.${event}`)) {
      webRequestDeliver(event, args, delivery)
      return
    }
    if (namespace === 'runtime' && event === 'onUserScriptMessage') {
      userScriptMessage(args)
      return
    }
    if (namespace === 'runtime' && event === 'onUserScriptConnect') {
      userScriptConnect(args)
      return
    }
    if (namespace === 'contextMenus' && event === 'onClicked') menuClicked(args)
    if (namespace === 'downloads' && event === 'onDeterminingFilename') {
      determineFilename(args)
      return
    }
    if (namespace === 'omnibox' && event === 'onInputChanged') {
      omniboxInputChanged(args)
      return
    }
    const names =
      namespace === 'action'
        ? [`action.${event}`, `browserAction.${event}`]
        : [`${namespace}.${event}`]
    for (const name of names) deliver(name, args, delivery)
  })

  host.notify('hello', {
    kind: host.kind,
    url: ownUrl,
    manifestVersion,
    isBackgroundPage,
    browserAliased
  })
  // Every context keeps the mirror of its partition; a worker that registered this before it
  // stopped is woken for the next change, as for any event it listens to.
  if (mirror) host.notify('listen', { event: '__zen.sync-mirror' })

  return { installed: true, browserAliased, roots: roots.length, manifestVersion }
}
