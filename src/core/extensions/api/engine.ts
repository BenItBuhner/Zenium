/**
 * The emulated engine: the part of `chrome.*` Chromium's extension system provides natively,
 * for hosts that have none. Zenium for Android runs extensions on the system WebView, so a
 * context (content script, background page, popup, options page) starts with no `chrome` at
 * all. `createEmulatedEngine` builds the engine half (`runtime` identity and messaging, ports,
 * `i18n`, the members `engineSpec.ts` marks `engine`), installs the shared shim over it
 * (`installExtensionApi` with the merged `engineApiSpec` table, exactly as the desktop installs
 * it over Electron's bindings) and speaks the host's JSON bridge for both.
 *
 * Wire format (context → host), every message carries `token` and `ep` (endpoint id):
 *  hello          { ctx, ext, url, top, world? }                  register this endpoint
 *  call           { id, ns, method, args }                        → reply
 *  msg            { id, target, data, userScript? }               runtime/tabs.sendMessage → reply
 *  msgReply       { id, handled, willRespond?, response?, listeners? }
 *  connect        { portId, name, target, userScript? }           runtime/tabs.connect
 *  portAccept     { portId, accept }                              answer to portConnect
 *  portMsg        { portId, data }
 *  portDisconnect { portId }
 *  listen         { event, on, filterId?, filters? }             first/last unfiltered listener of an event, or one filtered listener (its UrlFilters)
 *  ready          {}                                              extension page finished loading
 *  popupSize      { width, height }                               popup document size changed
 *  closePopup     {}
 *  proxyBody      { ticket, body }                                body (base64) of a ticketed CORS-proxied fetch (Android)
 *
 * Host → context: reply { id, ok, result | error }, deliver { id, data, sender, userScript? },
 * event { ns, name, args, delivery? } (`delivery` addresses filtered listeners), portConnect { portId, name, sender, userScript? }, portAccept
 * { portId, accept, error? }, portMsg { portId, data }, portDisconnect { portId, error? }.
 */
import { ENGINE_NOOPS, ENGINE_STUB_RESULTS, engineApiSpec, namespaceGranted } from './engineSpec'
import { getMessage, normalizeSubstitutions, type LocaleMessages } from './i18n'
import { redirectUrl } from './identity'
import {
  installExtensionApi,
  type EventDelivery,
  type InvokeResult,
  type ShimDiagnostics,
  type ShimHost
} from './shim'

/**
 * Where a context runs. `userScript` is the `USER_SCRIPT` world of `chrome.userScripts`: it
 * gets `runtime.sendMessage` / `connect` only, and its messages arrive at
 * `runtime.onUserScriptMessage` / `onUserScriptConnect`. `page` is an extension document opened
 * as a tab (an options page with `open_in_tab`, a changelog).
 */
export type EngineContextKind =
  'content' | 'userScript' | 'background' | 'popup' | 'options' | 'offscreen' | 'page'

export interface EngineConfig {
  id: string
  /** The extension's synthetic origin (`https://<id>.ext.zenium.invalid`), `runtime.getURL`'s base. */
  origin: string
  manifest: Record<string, unknown>
  manifestVersion: 2 | 3
  permissions: string[]
  messages: LocaleMessages | null
  uiLanguage: string
  context: EngineContextKind
  token: string
  endpointId: string
  /** Frame URL the endpoint runs in. */
  url: string
  isTopFrame: boolean
  /**
   * The endpoint runs in a real isolated world (content scripts on a WebView with world
   * injection). The host then routes `scripting.executeScript` through the world's own endpoint.
   */
  world?: boolean
}

export interface EngineTransport {
  post(message: string): void
}

export interface EngineOptions {
  /**
   * The object whose `chrome` and `browser` the engine defines and the shim patches;
   * `globalThis` by default. Content scripts without an isolated world hand over a private
   * scope object, so the page never sees `chrome`.
   */
  root?: object
}

/**
 * Functions captured before the page's own scripts run, so a page that patches `JSON.stringify`
 * or `setTimeout` cannot break the bridge. Content scripts in the page's world share prototypes
 * with the page; this is the part of the isolation the engine can still guarantee.
 */
export interface Primordials {
  stringify: (value: unknown) => string
  parse: (text: string) => unknown
  setTimeout: (callback: () => void, ms: number) => number
  queueMicrotask: (callback: () => void) => void
  error: (...args: unknown[]) => void
  /** Notices that are not failures (a member the engine deliberately does nothing for). */
  warn: (...args: unknown[]) => void
}

export function capturePrimordials(): Primordials {
  const g = globalThis as typeof globalThis & { queueMicrotask?: (cb: () => void) => void }
  const stringify = JSON.stringify
  const parse = JSON.parse
  const timeout = g.setTimeout
  const micro = g.queueMicrotask ?? ((cb: () => void) => void Promise.resolve().then(cb))
  const error = console.error
  const warn = console.warn
  return {
    stringify: (value) => stringify(value),
    parse: (text) => parse(text),
    setTimeout: (cb, ms) => timeout(cb, ms) as unknown as number,
    queueMicrotask: (cb) => micro(cb),
    error: (...args) => error(...args),
    warn: (...args) => warn(...args)
  }
}

type Listener = (...args: unknown[]) => unknown

/** A `chrome.Event` the engine owns (messaging events and port events). */
export interface EngineEvent {
  addListener(listener: Listener): void
  removeListener(listener: Listener): void
  hasListener(listener: Listener): boolean
  hasListeners(): boolean
  /** Calls every listener, isolating their exceptions; returns their return values. */
  dispatch(...args: unknown[]): unknown[]
}

export interface MessageSender {
  id: string
  url?: string
  origin?: string
  tab?: Record<string, unknown>
  frameId?: number
  documentId?: string
  documentLifecycle?: 'prerender' | 'active' | 'cached' | 'pending_deletion'
}

export interface EmulatedEngine {
  /** The `chrome` object of this context (also `browser`). */
  chrome: Record<string, unknown>
  /** Feed a host → context message (already parsed). */
  receive(message: Record<string, unknown>): void
  /** Called by the bootstrap once (extension pages: after `load`). */
  ready(): void
  /** Send a bootstrap-level message (`popupSize`, `closePopup`); `token` and `ep` are stamped. */
  post(message: Record<string, unknown>): void
  diagnostics: ShimDiagnostics | null
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface Port {
  name: string
  sender?: MessageSender
  onMessage: EngineEvent
  onDisconnect: EngineEvent
  postMessage(message: unknown): void
  disconnect(): void
}

interface HostMessage {
  t: string
  id?: number
  ok?: boolean
  result?: unknown
  error?: string
  data?: unknown
  sender?: MessageSender
  ns?: string
  name?: string
  args?: unknown[]
  portId?: string
  accept?: boolean
  userScript?: boolean
  delivery?: unknown
}

/** The host's `{ unfiltered, matched }` for an event some listeners filtered by URL, or nothing. */
function eventDelivery(raw: unknown): EventDelivery | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const d = raw as { unfiltered?: unknown; matched?: unknown }
  return {
    unfiltered: d.unfiltered !== false,
    matched: Array.isArray(d.matched) ? d.matched.filter((m) => typeof m === 'number') : []
  }
}

const EXTENSION_ID = /^[a-p]{32}$/

/** Chrome's `runtime.lastError` for a native messaging host that does not exist. */
export const NATIVE_HOST_NOT_FOUND = 'Specified native messaging host not found.'

const isExtensionId = (value: unknown): value is string =>
  typeof value === 'string' && EXTENSION_ID.test(value)

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export function createEmulatedEngine(
  config: EngineConfig,
  transport: EngineTransport,
  primordials: Primordials,
  options: EngineOptions = {}
): EmulatedEngine {
  const root = (options.root ?? globalThis) as Record<string, unknown>
  let seq = 0
  const pending = new Map<number, PendingCall>()
  const ports = new Map<string, { port: Port; connected: boolean }>()
  const userScript = config.context === 'userScript'

  const rethrow = (error: unknown): void => {
    primordials.setTimeout(() => {
      throw error
    }, 0)
  }

  const post = (message: Record<string, unknown>): void => {
    message.token = config.token
    message.ep = config.endpointId
    try {
      transport.post(primordials.stringify(message))
    } catch (error) {
      primordials.error('[Zenium] extension bridge post failed', error)
    }
  }

  const call = (ns: string, method: string, args: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      post({ t: 'call', id, ns, method, args })
    })

  // --- events ------------------------------------------------------------------------------------

  const events = new Map<string, EngineEvent>()

  function createEvent(fullName: string, notifyHost: boolean): EngineEvent {
    const listeners: Listener[] = []
    const event: EngineEvent = {
      addListener: (listener) => {
        if (typeof listener !== 'function') throw new TypeError('listener must be a function')
        if (listeners.includes(listener)) return
        listeners.push(listener)
        if (listeners.length === 1 && notifyHost) post({ t: 'listen', event: fullName, on: true })
      },
      removeListener: (listener) => {
        const index = listeners.indexOf(listener)
        if (index === -1) return
        listeners.splice(index, 1)
        if (listeners.length === 0 && notifyHost) post({ t: 'listen', event: fullName, on: false })
      },
      hasListener: (listener) => listeners.includes(listener),
      hasListeners: () => listeners.length > 0,
      dispatch: (...args) => {
        const results: unknown[] = []
        for (const listener of [...listeners]) {
          try {
            results.push(listener(...args))
          } catch (error) {
            results.push(undefined)
            primordials.error(`[Zenium] chrome.${fullName} listener threw`, error)
          }
        }
        return results
      }
    }
    // Declarative-rule members exist on every chrome.Event; keep callers that probe them happy.
    Object.assign(event, {
      addRules: () => undefined,
      getRules: (...raw: unknown[]) => {
        const cb = takeCallback(raw)
        if (cb) cb([])
      },
      removeRules: (...raw: unknown[]) => {
        const cb = takeCallback(raw)
        if (cb) cb()
      }
    })
    events.set(fullName, event)
    return event
  }

  // --- calling convention ------------------------------------------------------------------------

  const runtime: Record<string, unknown> = {}

  // runtime.lastError exists only while an error callback runs, then is deleted: the same dance
  // the shim performs, so the two never see each other's value.
  let lastErrorDepth = 0
  function withLastError(message: string, fn: () => void): void {
    const error = { message }
    try {
      Object.defineProperty(runtime, 'lastError', {
        get: () => error,
        configurable: true,
        enumerable: true
      })
    } catch {
      /* not configurable */
    }
    lastErrorDepth += 1
    try {
      fn()
    } finally {
      lastErrorDepth -= 1
      if (lastErrorDepth === 0) {
        try {
          delete runtime.lastError
        } catch {
          /* not configurable */
        }
      }
    }
  }

  function takeCallback(raw: unknown[]): Listener | undefined {
    if (raw.length > 0 && typeof raw[raw.length - 1] === 'function') {
      return raw.pop() as Listener
    }
    return undefined
  }

  /** Callback-or-promise: with a callback, failures surface through runtime.lastError. */
  function settle(
    promise: Promise<unknown>,
    callback: Listener | undefined
  ): Promise<unknown> | undefined {
    if (!callback) return promise
    promise.then(
      (value) => {
        try {
          if (value === undefined) callback()
          else callback(value)
        } catch (error) {
          rethrow(error)
        }
      },
      (error: unknown) => {
        withLastError(errorMessage(error), () => {
          try {
            callback()
          } catch (thrown) {
            rethrow(thrown)
          }
        })
      }
    )
    return undefined
  }

  const notImplemented = (qualified: string): Promise<never> =>
    Promise.reject(new Error(`chrome.${qualified} is not implemented on Zenium for Android`))

  // --- messaging ---------------------------------------------------------------------------------

  type MessageTarget = { extensionId?: string | null; tabId?: unknown; options?: unknown }

  const sendMessage = (target: MessageTarget, data: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      post({
        t: 'msg',
        id,
        target,
        data: data === undefined ? null : data,
        ...(userScript ? { userScript: true } : {})
      })
    })

  /** `runtime.sendMessage([extensionId], message, [options], [callback])`. */
  const parseSendMessageArgs = (
    args: unknown[]
  ): { extensionId: string | null; message: unknown; options: unknown; callback?: Listener } => {
    const rest = [...args]
    const callback = takeCallback(rest)
    let extensionId: string | null = null
    if (rest.length >= 2 && (isExtensionId(rest[0]) || rest[0] === null || rest[0] === undefined)) {
      extensionId = (rest.shift() as string | null | undefined) ?? null
    }
    const message = rest.shift()
    const options = rest.shift()
    return { extensionId, message, options, callback }
  }

  /** A port; `local` ones (a native port that never reached a host) have no host side to tell. */
  const createPort = (
    portId: string,
    name: string,
    sender: MessageSender | undefined,
    local = false
  ): Port => {
    const port: Port = {
      name,
      sender,
      onMessage: createEvent(`Port.onMessage:${portId}`, false),
      onDisconnect: createEvent(`Port.onDisconnect:${portId}`, false),
      postMessage: (message: unknown) => {
        const entry = ports.get(portId)
        if (!entry || !entry.connected)
          throw new Error('Attempting to use a disconnected port object')
        if (!local) post({ t: 'portMsg', portId, data: message === undefined ? null : message })
      },
      disconnect: () => {
        const entry = ports.get(portId)
        if (!entry || !entry.connected) return
        entry.connected = false
        ports.delete(portId)
        events.delete(`Port.onMessage:${portId}`)
        events.delete(`Port.onDisconnect:${portId}`)
        if (!local) post({ t: 'portDisconnect', portId })
      }
    }
    ports.set(portId, { port, connected: true })
    return port
  }

  const connect = (target: MessageTarget, connectInfo: unknown): Port => {
    const info = (connectInfo ?? {}) as { name?: unknown }
    const portId = `${config.endpointId}:${++seq}`
    const port = createPort(portId, info.name === undefined ? '' : String(info.name), undefined)
    post({
      t: 'connect',
      portId,
      name: port.name,
      target,
      ...(userScript ? { userScript: true } : {})
    })
    return port
  }

  const closePort = (portId: string, error: string | undefined): void => {
    const entry = ports.get(portId)
    if (!entry) return
    entry.connected = false
    ports.delete(portId)
    const fire = (): void => {
      entry.port.onDisconnect.dispatch(entry.port)
      events.delete(`Port.onMessage:${portId}`)
      events.delete(`Port.onDisconnect:${portId}`)
    }
    if (error) withLastError(error, fire)
    else fire()
  }

  /**
   * `runtime.connectNative` is synchronous in Chrome: a Port at once, and when no native
   * messaging host of that name answers, `onDisconnect` a moment later with `lastError`
   * "Specified native messaging host not found.". The phone has no native messaging hosts, so
   * every native port ends that way; an extension that probes for its desktop companion this way
   * (1Password) reads the disconnect as "no desktop app" and carries on. A routed rejection in
   * its place handed back a Promise, and `port.onMessage.addListener` threw on it.
   */
  const connectNative = (...args: unknown[]): Port => {
    if (typeof args[0] !== 'string')
      throw new TypeError(
        'Error in invocation of runtime.connectNative(string application): No matching signature.'
      )
    const portId = `${config.endpointId}:native:${++seq}`
    const port = createPort(portId, '', undefined, true)
    primordials.setTimeout(() => closePort(portId, NATIVE_HOST_NOT_FOUND), 0)
    return port
  }

  // --- runtime -----------------------------------------------------------------------------------

  const getURL = (path: unknown): string =>
    `${config.origin}/${String(path ?? '').replace(/^\/+/, '')}`

  Object.assign(runtime, {
    id: config.id,
    sendMessage: (...args: unknown[]) => {
      const { extensionId, message, options, callback } = parseSendMessageArgs(args)
      return settle(sendMessage({ extensionId, options: options ?? null }, message), callback)
    },
    connect: (...args: unknown[]) => {
      const rest = [...args]
      let extensionId: string | null = null
      if (rest.length >= 1 && (isExtensionId(rest[0]) || (rest.length === 2 && rest[0] === null))) {
        extensionId = (rest.shift() as string | null) ?? null
      }
      return connect({ extensionId }, rest[0])
    }
  })

  if (!userScript) {
    Object.assign(runtime, {
      getURL,
      // Chrome defines it only with the `nativeMessaging` permission.
      ...(config.permissions.includes('nativeMessaging') ? { connectNative } : {}),
      getManifest: () => config.manifest,
      getPlatformInfo: (...args: unknown[]) =>
        settle(
          Promise.resolve({ os: 'android', arch: 'arm64', nacl_arch: 'arm' }),
          takeCallback(args)
        ),
      onMessage: createEvent('runtime.onMessage', true),
      onMessageExternal: createEvent('runtime.onMessageExternal', true),
      onConnect: createEvent('runtime.onConnect', true),
      onConnectExternal: createEvent('runtime.onConnectExternal', true),
      onUserScriptMessage: createEvent('runtime.onUserScriptMessage', true),
      onUserScriptConnect: createEvent('runtime.onUserScriptConnect', true)
    })
  }

  const chrome: Record<string, unknown> = { runtime }

  // --- engine members the table marks `engine` -------------------------------------------------

  const granted = (ns: string): boolean =>
    namespaceGranted(ns, config.permissions, config.manifestVersion)
  const contentScript = config.context === 'content'

  if (!userScript) {
    chrome.i18n = {
      getMessage: (name: unknown, substitutions?: unknown) =>
        getMessage(config.messages, String(name), normalizeSubstitutions(substitutions)),
      getUILanguage: () => config.uiLanguage,
      getAcceptLanguages: (...args: unknown[]) =>
        settle(Promise.resolve([config.uiLanguage]), takeCallback(args))
    }
    chrome.dom = {
      openOrClosedShadowRoot: (element: unknown) =>
        element && typeof element === 'object'
          ? ((element as { shadowRoot?: unknown }).shadowRoot ?? null)
          : null
    }
  }

  if (!userScript && !contentScript) {
    chrome.tabs = {
      sendMessage: (...args: unknown[]) => {
        const rest = [...args]
        const tabId = rest.shift()
        const callback = takeCallback(rest)
        const [message, options] = rest
        return settle(sendMessage({ tabId, options: options ?? null }, message), callback)
      },
      connect: (tabId: unknown, connectInfo?: unknown) => connect({ tabId }, connectInfo)
    }
    if (granted('scripting')) {
      chrome.scripting = {
        // `func` cannot cross the JSON transport: send its source, the host wraps it with `args`.
        executeScript: (...args: unknown[]) => {
          const callback = takeCallback(args)
          const injection = { ...((args[0] ?? {}) as Record<string, unknown>) }
          const fn = injection.func ?? injection.function
          if (typeof fn === 'function') {
            injection.funcSource = (fn as () => void).toString()
            delete injection.func
            delete injection.function
          }
          return settle(call('scripting', 'executeScript', [injection]), callback)
        }
      }
    }
    // contextMenus is the shim's: `create` answers its id synchronously and the wire carries
    // `[properties, id]` (functions such as `onclick` stay on this side).
    if (granted('idle')) chrome.idle = { setDetectionInterval: () => undefined }
    // Chrome's redirect host (`https://<id>.chromiumapp.org/`), which OAuth providers have
    // registered; the emulated origin only serves the extension's files. The host ends
    // `launchWebAuthFlow` on the way back there.
    if (granted('identity'))
      chrome.identity = { getRedirectURL: (path?: unknown) => redirectUrl(config.id, path) }
    if (granted('privacy')) {
      // Chrome exposes ChromeSettings objects; extensions mostly probe `websites.hyperlinkAuditingEnabled`.
      const setting = (): Record<string, unknown> => ({
        get: (...args: unknown[]) =>
          settle(
            Promise.resolve({ value: false, levelOfControl: 'not_controllable' }),
            takeCallback(args)
          ),
        set: (...args: unknown[]) => settle(Promise.resolve(undefined), takeCallback(args)),
        clear: (...args: unknown[]) => settle(Promise.resolve(undefined), takeCallback(args)),
        onChange: createEvent('privacy.onChange', false)
      })
      chrome.privacy = {
        network: { networkPredictionEnabled: setting(), webRTCIPHandlingPolicy: setting() },
        services: {
          alternateErrorPagesEnabled: setting(),
          autofillEnabled: setting(),
          passwordSavingEnabled: setting(),
          safeBrowsingEnabled: setting(),
          searchSuggestEnabled: setting(),
          spellingServiceEnabled: setting(),
          translationServiceEnabled: setting()
        },
        websites: {
          thirdPartyCookiesAllowed: setting(),
          hyperlinkAuditingEnabled: setting(),
          referrersEnabled: setting(),
          doNotTrackEnabled: setting(),
          topicsEnabled: setting(),
          fledgeEnabled: setting(),
          adMeasurementEnabled: setting()
        }
      }
    }
    chrome.system = {
      cpu: {
        getInfo: (...args: unknown[]) =>
          settle(notImplemented('system.cpu.getInfo'), takeCallback(args))
      },
      memory: {
        getInfo: (...args: unknown[]) =>
          settle(notImplemented('system.memory.getInfo'), takeCallback(args))
      },
      display: {
        getInfo: (...args: unknown[]) =>
          settle(notImplemented('system.display.getInfo'), takeCallback(args))
      }
    }
  }

  // --- the shim over the engine ------------------------------------------------------------------

  const hostEventListeners: Array<
    (namespace: string, event: string, args: unknown[], delivery?: EventDelivery) => void
  > = []
  const warned = new Set<string>()

  const shimHost: ShimHost = {
    kind: 'frame',
    invoke: (ns, method, args): Promise<InvokeResult> => {
      const key = `${ns}.${method}`
      if (ENGINE_NOOPS.has(key)) {
        if (!warned.has(key)) {
          warned.add(key)
          primordials.warn(`[Zenium] chrome.${key} is a no-op on Zenium for Android`)
        }
        return Promise.resolve({ ok: true, value: undefined })
      }
      if (Object.prototype.hasOwnProperty.call(ENGINE_STUB_RESULTS, key)) {
        const stub = ENGINE_STUB_RESULTS[key]
        return Promise.resolve({ ok: true, value: primordials.parse(primordials.stringify(stub)) })
      }
      return call(ns, method, args).then(
        (value) => ({ ok: true, value }) as InvokeResult,
        (error: unknown) => ({ ok: false, error: errorMessage(error) }) as InvokeResult
      )
    },
    notify: (kind, payload) => {
      // `hello` went out from the engine before the shim ran; storage areas are host-backed, so
      // `storage-changed` never happens here. Listener bookkeeping is what the host wants.
      if (kind !== 'listen' && kind !== 'unlisten') return
      const p = (payload ?? {}) as { event?: unknown; filterId?: unknown; filters?: unknown }
      if (typeof p.event !== 'string') return
      const message: Record<string, unknown> = {
        t: 'listen',
        event: p.event,
        on: kind === 'listen'
      }
      if (typeof p.filterId === 'number') {
        message.filterId = p.filterId
        if (kind === 'listen') message.filters = Array.isArray(p.filters) ? p.filters : []
      }
      post(message)
    },
    onEvent: (listener) => {
      hostEventListeners.push(listener)
    }
  }

  Object.defineProperty(root, 'chrome', { value: chrome, writable: true, configurable: true })
  let diagnostics: ShimDiagnostics | null = null
  if (!userScript) {
    diagnostics = installExtensionApi(
      shimHost,
      engineApiSpec({
        permissions: config.permissions,
        manifestVersion: config.manifestVersion,
        context: contentScript ? 'content' : 'page'
      }),
      { root }
    )
    // The shim always builds `storage`; Chrome only exposes it with the permission.
    if (!granted('storage')) delete chrome.storage
  } else {
    Object.defineProperty(root, 'browser', { value: chrome, writable: true, configurable: true })
  }

  // --- host → context ----------------------------------------------------------------------------

  const deliverMessage = (
    id: number,
    data: unknown,
    sender: MessageSender,
    viaUserScript: boolean
  ): void => {
    const event = events.get(viaUserScript ? 'runtime.onUserScriptMessage' : 'runtime.onMessage')
    if (!event || !event.hasListeners()) {
      post({ t: 'msgReply', id, handled: false, listeners: false })
      return
    }
    let responded = false
    let response: unknown
    let asyncResponse = false
    const sendResponse = (value?: unknown): void => {
      if (responded) return
      responded = true
      response = value === undefined ? null : value
      if (asyncResponse) post({ t: 'msgReply', id, handled: true, response })
    }
    const results = event.dispatch(data, sender, sendResponse)
    if (responded) {
      post({ t: 'msgReply', id, handled: true, response })
      return
    }
    // `return true` keeps the channel open; a returned promise answers with its value.
    const thenable = results.find(
      (r): r is PromiseLike<unknown> =>
        Boolean(r) && typeof (r as PromiseLike<unknown>).then === 'function'
    )
    if (results.some((r) => r === true) || thenable) {
      asyncResponse = true
      post({ t: 'msgReply', id, handled: true, willRespond: true })
      if (thenable)
        thenable.then(
          (value) => sendResponse(value),
          (error: unknown) => {
            primordials.error('[Zenium] runtime.onMessage listener rejected', error)
            sendResponse(undefined)
          }
        )
    } else {
      post({ t: 'msgReply', id, handled: false, listeners: true })
    }
  }

  const receive = (raw: Record<string, unknown>): void => {
    const message = raw as unknown as HostMessage
    switch (message.t) {
      case 'reply': {
        const id = Number(message.id)
        const entry = pending.get(id)
        if (!entry) return
        pending.delete(id)
        if (message.ok) entry.resolve(message.result)
        else entry.reject(new Error(message.error ?? 'Unknown error'))
        return
      }
      case 'deliver':
        deliverMessage(
          Number(message.id),
          message.data,
          message.sender ?? { id: config.id },
          message.userScript === true
        )
        return
      case 'event': {
        const ns = String(message.ns)
        const name = String(message.name)
        const args = Array.isArray(message.args) ? message.args : []
        const delivery = eventDelivery(message.delivery)
        for (const listener of hostEventListeners) listener(ns, name, args, delivery)
        if (ns === 'storage' && name === 'onChanged') {
          // `storage.<area>.onChanged(changes)` mirrors the area-level event.
          const [changes, area] = args
          for (const listener of hostEventListeners)
            listener('storage', `${String(area)}.onChanged`, [changes])
        }
        return
      }
      case 'portConnect': {
        const portId = String(message.portId)
        const event = events.get(
          message.userScript ? 'runtime.onUserScriptConnect' : 'runtime.onConnect'
        )
        if (!event || !event.hasListeners()) {
          post({ t: 'portAccept', portId, accept: false })
          return
        }
        const port = createPort(portId, String(message.name ?? ''), message.sender)
        post({ t: 'portAccept', portId, accept: true })
        event.dispatch(port)
        return
      }
      case 'portAccept':
        if (message.accept) return
        closePort(
          String(message.portId),
          message.error ?? 'Could not establish connection. Receiving end does not exist.'
        )
        return
      case 'portMsg': {
        const entry = ports.get(String(message.portId))
        if (entry && entry.connected) entry.port.onMessage.dispatch(message.data, entry.port)
        return
      }
      case 'portDisconnect':
        closePort(String(message.portId), message.error)
        return
    }
  }

  post({
    t: 'hello',
    ctx: config.context,
    ext: config.id,
    url: config.url,
    top: config.isTopFrame,
    ...(config.world ? { world: true } : {})
  })

  return {
    chrome,
    receive,
    ready: () => post({ t: 'ready' }),
    post,
    diagnostics
  }
}
