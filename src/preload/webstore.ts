import { contextBridge, ipcRenderer } from 'electron'
import {
  CHROME_BRAND,
  MANAGEMENT_MEMBERS,
  WEBSTORE_CHANNEL,
  WEBSTORE_EVENT_CHANNEL,
  WEBSTORE_PRIVATE_MEMBERS,
  isWebstorePage,
  type ManagementEvent,
  type WebstoreReply
} from '../core/extensions/webstorePrivate'

/**
 * Frame preload for every persistent session: on the Chrome Web Store (and nowhere else) it
 * gives the page the `chrome.webstorePrivate` and `chrome.management` members it drives its
 * install button with, and Chrome's brand in `navigator.userAgentData`. The page calls the
 * members Chrome-style (trailing callback, `chrome.runtime.lastError` during the callback); the
 * calls travel to the main process over one IPC channel and `ExtensionService` answers them.
 *
 * The bridge object lives in the isolated world; a small shim installed into the main world
 * turns its promises back into Chrome's callback protocol.
 */

const BRIDGE_KEY = '__zeniumWebstore'

type EventListener = (event: ManagementEvent, payload: unknown) => void

function install(): void {
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
      [...MANAGEMENT_MEMBERS],
      CHROME_BRAND,
      process.versions.chrome
    ]
  })
}

/**
 * Runs in the page's world (serialised, so it must not close over anything). Builds
 * `chrome.webstorePrivate` and `chrome.management` on whatever `chrome` object the page has,
 * and puts Chrome's brand into `navigator.userAgentData`: the page's scripts check the brands
 * the same way its server checks the client hints (see `withChromeBrand`) before they let the
 * install button work.
 */
function installShim(
  bridgeKey: string,
  privateMembers: string[],
  managementMembers: string[],
  chromeBrand: string,
  chromiumVersion: string
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
    if (brands.some((entry) => entry.brand === chromeBrand)) return brands
    const chromium = brands.findIndex((entry) => entry.brand === 'Chromium')
    const result = [...brands]
    result.splice(chromium >= 0 ? chromium + 1 : result.length, 0, {
      brand: chromeBrand,
      version: chromium >= 0 ? brands[chromium].version : version
    })
    return result
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

  const unimplemented = (api: string): ProxyHandler<Record<string, unknown>> => ({
    get(target: Record<string, unknown>, property: string | symbol): unknown {
      if (typeof property === 'string' && !(property in target))
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
    ['webstorePrivate', new Proxy(webstorePrivate, unimplemented('webstorePrivate'))],
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

/** The store's own frames, including the blank child frames it creates (they inherit its API). */
function isWebstoreFrame(): boolean {
  if (isWebstorePage(location.href)) return true
  if (location.href !== 'about:blank' || window.parent === window) return false
  try {
    return isWebstorePage(window.parent.location.href)
  } catch {
    return false
  }
}

if (isWebstoreFrame()) install()
