import { contextBridge, ipcRenderer } from 'electron'
import type { StoreId } from '../core/extensions/store'
import {
  MANAGEMENT_MEMBERS,
  STORE_BRANDS,
  WEBSTORE_CHANNEL,
  WEBSTORE_EVENT_CHANNEL,
  WEBSTORE_PRIVATE_MEMBERS,
  WEBSTORE_PRIVATE_OPTIONAL_MEMBERS,
  storeForFrame,
  withEdgeToken,
  type ManagementEvent,
  type WebstoreReply
} from '../core/extensions/webstorePrivate'

/**
 * Frame preload for every persistent session: on the Chrome Web Store and Edge Add-ons (and
 * nowhere else) it gives the page the `chrome.webstorePrivate` and `chrome.management` members
 * it drives its install button with, and that store's browser brand in `navigator.userAgentData`
 * (plus Edge's user-agent string on Edge Add-ons). The page calls the members Chrome-style
 * (trailing callback, `chrome.runtime.lastError` during the callback); the calls travel to the
 * main process over one IPC channel and `ExtensionService` answers them.
 *
 * The bridge object lives in the isolated world; a small shim installed into the main world
 * turns its promises back into Chrome's callback protocol.
 *
 * Why the user agent is overridden here rather than with `webContents.setUserAgent`: this
 * preload runs per frame, gated on the same origin test as the API itself, so exactly the frames
 * that get `chrome.webstorePrivate` see Edge and nothing else does. `setUserAgent` is
 * per-WebContents: it would also apply to every other origin the tab loads (cross-origin
 * subframes, requests in flight while navigating in or out) and it would have to be switched on
 * a navigation event and restored on the next one, where Chromium reloads an in-flight
 * navigation whose entry overrides the UA. The request headers get the same identity from
 * `edgeStoreUserAgent` in `main/platform/requestHeaders.ts`, keyed on the same origin.
 */

const BRIDGE_KEY = '__zeniumWebstore'

type EventListener = (event: ManagementEvent, payload: unknown) => void

function install(store: StoreId): void {
  const listeners = new Set<EventListener>()
  ipcRenderer.on(
    WEBSTORE_EVENT_CHANNEL,
    (_event, name: ManagementEvent, payload: unknown): void => {
      for (const listener of listeners) listener(name, payload)
    }
  )
  contextBridge.exposeInMainWorld(BRIDGE_KEY, {
    call: (member: string, args: unknown[]): Promise<WebstoreReply> =>
      ipcRenderer.invoke(WEBSTORE_CHANNEL, member, args),
    onEvent: (listener: EventListener): void => {
      listeners.add(listener)
    }
  })
  contextBridge.executeInMainWorld({
    func: installShim,
    args: [
      BRIDGE_KEY,
      [...WEBSTORE_PRIVATE_MEMBERS],
      [...WEBSTORE_PRIVATE_OPTIONAL_MEMBERS],
      [...MANAGEMENT_MEMBERS],
      STORE_BRANDS[store],
      process.versions.chrome,
      store === 'edge-add-ons' ? withEdgeToken(navigator.userAgent, process.versions.chrome) : null
    ]
  })
}

/**
 * Runs in the page's world (serialised, so it must not close over anything). Builds
 * `chrome.webstorePrivate` and `chrome.management` on whatever `chrome` object the page has,
 * and puts the store's brand into `navigator.userAgentData`: the page's scripts check the brands
 * the same way the Chrome Web Store's server checks the client hints (see `withBrand`) before
 * they let the install button work. On Edge Add-ons `userAgent` is Edge's string and replaces
 * `navigator.userAgent` and `navigator.appVersion` too.
 */
function installShim(
  bridgeKey: string,
  privateMembers: string[],
  optionalMembers: string[],
  managementMembers: string[],
  storeBrand: string,
  chromiumVersion: string,
  userAgent: string | null
): void {
  type Reply = { value?: unknown; error?: string }
  type Callback = (...args: unknown[]) => void
  interface Bridge {
    call(member: string, args: unknown[]): Promise<Reply>
    onEvent(listener: (event: string, payload: unknown) => void): void
  }
  interface Brand {
    brand: string
    version: string
  }
  interface UaData {
    brands: Brand[]
    mobile: boolean
    platform: string
    getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>>
    toJSON(): unknown
  }
  const scope = globalThis as unknown as Record<string, unknown>
  const bridge = scope[bridgeKey] as Bridge

  const withBrand = (brands: Brand[], version: string): Brand[] => {
    if (brands.some((entry) => entry.brand === storeBrand)) return brands
    const chromium = brands.findIndex((entry) => entry.brand === 'Chromium')
    const result = [...brands]
    result.splice(chromium >= 0 ? chromium + 1 : result.length, 0, {
      brand: storeBrand,
      version: chromium >= 0 ? brands[chromium].version : version
    })
    return result
  }
  if (userAgent !== null) {
    const expose = (name: string, value: string): void => {
      Object.defineProperty(Navigator.prototype, name, {
        configurable: true,
        enumerable: true,
        get: () => value
      })
    }
    expose('userAgent', userAgent)
    expose('appVersion', userAgent.replace(/^Mozilla\//, ''))
  }
  const native = (navigator as Navigator & { userAgentData?: UaData }).userAgentData
  if (native) {
    const brands = withBrand(native.brands, chromiumVersion.split('.')[0])
    const data: UaData = {
      get brands(): Brand[] {
        return brands
      },
      get mobile(): boolean {
        return native.mobile
      },
      get platform(): string {
        return native.platform
      },
      async getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>> {
        const values = await native.getHighEntropyValues(hints)
        values.brands = brands
        if (Array.isArray(values.fullVersionList))
          values.fullVersionList = withBrand(values.fullVersionList as Brand[], chromiumVersion)
        return values
      },
      toJSON(): unknown {
        return { brands, mobile: native.mobile, platform: native.platform }
      }
    }
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      configurable: true,
      enumerable: true,
      get: () => data
    })
  }

  // Electron's own `chrome` object on this origin carries Chromium's native `webstorePrivate`
  // and `management` bindings; the native `webstorePrivate` functions crash Electron's main
  // process (its browser side has no host for them), so the page must never reach them.
  const nativeChrome = (
    scope.chrome && typeof scope.chrome === 'object' ? scope.chrome : (scope.chrome = {})
  ) as Record<string, unknown>
  const runtime = (nativeChrome.runtime ??= {}) as Record<string, unknown>

  const settle = (reply: Reply, callback: Callback | undefined): void => {
    if (reply.error) runtime.lastError = { message: reply.error }
    try {
      if (callback) callback(...(reply.value === undefined ? [] : [reply.value]))
    } finally {
      if (reply.error) delete runtime.lastError
    }
  }

  const method =
    (name: string) =>
    (...args: unknown[]): unknown => {
      const callback =
        typeof args[args.length - 1] === 'function' ? (args.pop() as Callback) : undefined
      const promise = bridge.call(name, args).then((reply) => {
        settle(reply, callback)
        if (reply.error && !callback) throw new Error(reply.error)
        return reply.value
      })
      if (!callback) return promise
      promise.catch(() => undefined)
      return undefined
    }

  // Members the page probes for and has a fallback without (`optional`) stay silent.
  const unimplemented = (
    api: string,
    optional: string[] = []
  ): ProxyHandler<Record<string, unknown>> => ({
    get(target: Record<string, unknown>, property: string | symbol): unknown {
      if (typeof property === 'string' && !(property in target) && !optional.includes(property))
        console.warn(`Zenium: chrome.${api}.${property} is not implemented`)
      return target[property as string]
    }
  })

  const webstorePrivate: Record<string, unknown> = {}
  for (const name of privateMembers) webstorePrivate[name] = method(`webstorePrivate.${name}`)

  const events = new Map<string, Set<Callback>>()
  const event = (name: string): Record<string, unknown> => {
    const set = new Set<Callback>()
    events.set(name, set)
    return {
      addListener: (listener: Callback): void => {
        set.add(listener)
      },
      removeListener: (listener: Callback): void => {
        set.delete(listener)
      },
      hasListener: (listener: Callback): boolean => set.has(listener),
      hasListeners: (): boolean => set.size > 0
    }
  }
  const management: Record<string, unknown> = {}
  // Keep the native enums (ExtensionType, LaunchType, ...); functions and events are ours.
  const nativeManagement = nativeChrome.management
  if (nativeManagement && typeof nativeManagement === 'object')
    for (const [key, value] of Object.entries(nativeManagement))
      if (value && typeof value === 'object' && !('addListener' in value)) management[key] = value
  for (const name of managementMembers) management[name] = method(`management.${name}`)
  for (const name of ['onInstalled', 'onUninstalled', 'onEnabled', 'onDisabled'])
    management[name] = event(name)

  // Whenever an extension loads, Chromium re-installs its lazy API accessors on whatever object
  // `window.chrome` is, which would put the native bindings back in front of ours. V8 refuses
  // to install them on a Proxy (`SetLazyDataProperty` returns false) and Chromium then only logs
  // "Failed to create API on Chrome object.", so the page's `chrome` is a Proxy that serves our
  // two namespaces itself and everything else from Electron's object.
  const ours = new Map<string | symbol, unknown>([
    [
      'webstorePrivate',
      new Proxy(webstorePrivate, unimplemented('webstorePrivate', optionalMembers))
    ],
    ['management', new Proxy(management, unimplemented('management'))]
  ])
  const chrome = new Proxy(nativeChrome, {
    get: (target, property) =>
      ours.has(property) ? ours.get(property) : Reflect.get(target, property),
    has: (target, property) => ours.has(property) || Reflect.has(target, property),
    set: (target, property, value) => ours.has(property) || Reflect.set(target, property, value),
    defineProperty: (target, property, descriptor) =>
      ours.has(property) || Reflect.defineProperty(target, property, descriptor),
    deleteProperty: (target, property) =>
      ours.has(property) || Reflect.deleteProperty(target, property),
    ownKeys: (target) => [...new Set([...Reflect.ownKeys(target), ...ours.keys()])],
    getOwnPropertyDescriptor: (target, property) =>
      ours.has(property)
        ? { value: ours.get(property), writable: true, enumerable: true, configurable: true }
        : Reflect.getOwnPropertyDescriptor(target, property)
  })
  Object.defineProperty(scope, 'chrome', {
    value: chrome,
    writable: true,
    enumerable: true,
    configurable: true
  })

  bridge.onEvent((name, payload) => {
    for (const listener of events.get(name) ?? []) {
      try {
        listener(payload)
      } catch (error) {
        console.error(error)
      }
    }
  })
}

/** The store this frame belongs to: its own page's, or for a blank child frame the parent's. */
function frameStore(): StoreId | null {
  let parentUrl: string | null = null
  if (window.parent !== window) {
    try {
      parentUrl = window.parent.location.href
    } catch {
      parentUrl = null
    }
  }
  return storeForFrame(location.href, parentUrl)
}

const store = frameStore()
if (store) install(store)
