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
import type { ApiSpec, MethodSpec, ParamSpec, ParamType } from './spec'
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
  type: 'tab' | 'popup' | 'background' | 'options' | 'other'
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

export function installExtensionApi(host: ShimHost, spec: ApiSpec): ShimDiagnostics {
  const g = globalThis as Any
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

  const manifest: ManifestShape = safely(() => chrome.runtime.getManifest()) ?? {}
  const manifestVersion: 2 | 3 = manifest.manifest_version === 2 ? 2 : 3
  const background = isObject(manifest.background) ? manifest.background : null
  const extensionUrl: string =
    safely(() => String(chrome.runtime.getURL(''))) ??
    (typeof g.location === 'object' && g.location
      ? `${g.location.protocol}//${g.location.host}/`
      : '')
  const ownUrl: string = typeof g.location === 'object' && g.location ? String(g.location.href) : ''
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

  function define(target: Any, key: string, value: unknown): void {
    try {
      Object.defineProperty(target, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: true
      })
    } catch {
      try {
        target[key] = value
      } catch {
        /* frozen */
      }
    }
  }

  function defineGetter(target: Any, key: string, get: () => unknown): void {
    try {
      Object.defineProperty(target, key, { get, configurable: true, enumerable: true })
    } catch {
      /* not configurable */
    }
  }

  /** The namespace object on a root, created when the engine has none. */
  function namespaceOn(root: Any, name: string): Any {
    let ns: Any
    try {
      ns = root[name]
    } catch {
      ns = undefined
    }
    if (!ns || typeof ns !== 'object') {
      ns = {}
      define(root, name, ns)
    }
    return ns
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
    const targets: Any[] = []
    for (const root of roots) {
      const runtime = safely(() => root.runtime)
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
            delete runtime.lastError
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
    options: { nativeDelivers: boolean; nativeHandles?: (args: unknown[]) => boolean }
  ): EventObject {
    const listeners = new Map<Listener, number | null>()
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
    const object: EventObject = {
      addListener(fn: unknown, ...rest: unknown[]): void {
        if (!isFunction(fn) || listeners.has(fn)) return
        if (record.nativeDelivers) safely(() => native?.addListener(fn, ...rest))
        const filters = urlFilters(fullName, rest[0])
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
        if (record.nativeDelivers) safely(() => native?.removeListener(fn))
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
    // Declarative-rule members exist on every chrome.Event; keep callers that probe them happy.
    define(object, 'addRules', () => undefined)
    define(object, 'getRules', (...raw: unknown[]) => {
      const cb = takeCallback(raw)
      if (cb) cb([])
    })
    define(object, 'removeRules', (...raw: unknown[]) => {
      const cb = takeCallback(raw)
      if (cb) cb()
    })
    record.object = object
    events.set(fullName, record)
    return object
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
  // Generic namespaces from the table
  // ---------------------------------------------------------------------------

  /**
   * A `types.ChromeSetting` (`privacy.network.webRTCIPHandlingPolicy`): `get` / `set` / `clear`
   * route to the namespace's methods with the setting's name first; `onChange` never fires here
   * (nothing changes these behind an extension's back that it could act on).
   */
  function chromeSetting(namespace: string, dotted: string): Record<string, unknown> {
    const setting: Record<string, unknown> = {}
    const routed = (name: string, params: ParamSpec[]): void => {
      const qualified = `${namespace}.${dotted}.${name}(${params
        .map((p) => `${p.optional ? 'optional ' : ''}${p.type} ${p.name}`)
        .join(', ')})`
      define(setting, name, function (...raw: unknown[]): unknown {
        const callback = takeCallback(raw)
        const args = normalizeArgs(qualified, raw, params)
        return settle(qualified, invoke(namespace, name, [dotted, ...args]), callback)
      })
    }
    routed('get', [{ name: 'details', type: 'object', optional: true }])
    routed('set', [{ name: 'details', type: 'object' }])
    routed('clear', [{ name: 'details', type: 'object', optional: true }])
    define(
      setting,
      'onChange',
      createEvent(`${namespace}.${dotted}.onChange`, undefined, { nativeDelivers: false })
    )
    return setting
  }

  for (const [namespace, nsSpec] of Object.entries(spec)) {
    if (nsSpec.manifestVersion && nsSpec.manifestVersion !== manifestVersion) continue
    const targets = roots.map((root) => namespaceOn(root, namespace))
    if (nsSpec.settings) {
      for (const [group, names] of Object.entries(nsSpec.settings)) {
        for (const name of names) {
          const setting = chromeSetting(namespace, `${group}.${name}`)
          for (const target of targets) define(namespaceOn(target, group), name, setting)
        }
      }
    } else {
      for (const [name, method] of Object.entries(nsSpec.methods)) {
        const fn = makeMethod(namespace, name, method)
        const keepNative = method.keepNative || Boolean(method.inert)
        for (const target of targets) {
          if (keepNative && typeof safely(() => target[name]) === 'function') continue
          define(target, name, fn)
        }
      }
    }
    for (const [name, eventSpec] of Object.entries(nsSpec.events)) {
      const fullName = `${namespace}.${name}`
      const primary = targets[0]
      const native = safely(() => primary[name])
      const keepNative = eventSpec.keepNative || Boolean(nsSpec.shape)
      if (keepNative && native && typeof native.addListener === 'function') continue
      const object = createEvent(fullName, native, {
        nativeDelivers: Boolean(eventSpec.nativeInFrames) && host.kind === 'frame'
      })
      for (const target of targets) define(target, name, object)
    }
    for (const [name, value] of Object.entries(nsSpec.constants ?? {})) {
      for (const target of targets) {
        if (safely(() => target[name]) === undefined) define(target, name, value)
      }
    }
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

  if (spec.tts) {
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

  function hostArea(storage: Any, areaName: string): Record<string, unknown> {
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

  function wrapNativeArea(area: Any, areaName: string): void {
    const nativeSet: unknown = safely(() => area.set)
    const nativeGet: unknown = safely(() => area.get)
    const nativeRemove: unknown = safely(() => area.remove)
    const nativeClear: unknown = safely(() => area.clear)
    if (!isFunction(nativeSet) || !isFunction(nativeGet)) return
    const read = async (keys: unknown): Promise<StorageItems> => {
      const items = await callNativeArea(area, nativeGet, [keys])
      return isObject(items) ? items : {}
    }
    const notify = (changes: StorageChanges): void => {
      if (Object.keys(changes).length > 0)
        host.notify('storage-changed', { area: areaName, changes })
    }
    define(area, 'set', function (...raw: unknown[]): unknown {
      const callback = takeCallback(raw)
      const items = raw[0]
      const work = (async (): Promise<void> => {
        if (!isObject(items)) throw signatureError(`storage.${areaName}.set(object items)`)
        const keys = Object.keys(items)
        const before = await read(keys)
        await callNativeArea(area, nativeSet, [items])
        const changes: StorageChanges = {}
        for (const key of keys) {
          const newValue = items[key]
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
          const list: string[] | null =
            typeof keys === 'string'
              ? [keys]
              : Array.isArray(keys)
                ? keys.filter((k): k is string => typeof k === 'string')
                : null
          if (!list) throw signatureError(`storage.${areaName}.remove(string|array keys)`)
          const before = await read(list)
          await callNativeArea(area, nativeRemove, [keys])
          const changes: StorageChanges = {}
          for (const key of list) {
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
          const before = await read(null)
          await callNativeArea(area, nativeClear, [])
          const changes: StorageChanges = {}
          for (const key of Object.keys(before)) changes[key] = { oldValue: before[key] }
          notify(changes)
        })()
        return settle(`storage.${areaName}.clear`, work, callback)
      })
    }
    const nativeEvent: NativeEvent | undefined = safely(() => area.onChanged)
    define(
      area,
      'onChanged',
      createEvent(`storage.${areaName}.onChanged`, nativeEvent, {
        nativeDelivers: host.kind === 'frame'
      })
    )
  }

  {
    const primaryStorage = namespaceOn(roots[0], 'storage')
    for (const areaName of ['local', 'session']) {
      const native = safely(() => primaryStorage[areaName])
      if (native && typeof native === 'object') wrapNativeArea(native, areaName)
      else hostArea(primaryStorage, areaName)
    }
    for (const areaName of ['sync', 'managed']) hostArea(primaryStorage, areaName)
    const nativeOnChanged = safely(() => primaryStorage.onChanged)
    define(
      primaryStorage,
      'onChanged',
      createEvent('storage.onChanged', nativeOnChanged, {
        nativeDelivers: host.kind === 'frame',
        // Documents get local/session changes from the engine; sync/managed only exist host-side.
        nativeHandles: (args) => args[1] === 'local' || args[1] === 'session'
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
          out.push(view.self || view.url === ownUrl ? g : viewStub(view))
        }
        return out
      })
      // The background page's `window` is only reachable from the background page itself: a
      // popup or options page has no JavaScript path to another document's global (Chrome's
      // binding gets it from the renderer's frame list), so it gets null and the extension falls
      // back to messaging, as it must under MV3 anyway.
      define(extension, 'getBackgroundPage', (): unknown => (isBackgroundPage ? g : null))
      if (!isFunction(safely(() => runtime.getBackgroundPage))) {
        define(runtime, 'getBackgroundPage', function (...raw: unknown[]): unknown {
          const callback = takeCallback(raw)
          const qualified = 'runtime.getBackgroundPage(optional function callback)'
          const work =
            manifestVersion === 2 && background !== null
              ? Promise.resolve(isBackgroundPage ? g : null)
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

  return { installed: true, browserAliased, roots: roots.length, manifestVersion }
}
