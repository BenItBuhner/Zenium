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
import { getMessage, normalizeSubstitutions, predefinedMessages, type LocaleMessages } from './i18n'
import { captureIconWireEnv, compactIconDetails, type IconWireEnv } from './iconWire'
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
  'content' | 'userScript' | 'background' | 'popup' | 'options' | 'sidePanel' | 'offscreen' | 'page'

export interface EngineConfig {
  id: string
  /** The extension's synthetic origin (`https://<id>.ext.zenium.invalid`), `runtime.getURL`'s base. */
  origin: string
  manifest: Record<string, unknown>
  manifestVersion: 2 | 3
  /** The API permissions granted: the required ones and the optional ones granted so far. */
  permissions: string[]
  /**
   * The manifest's optional API permissions not granted yet. Their namespaces stay undefined
   * until a `permissions.request` grants one, and are defined then (in this context at once, in
   * the others on the host's `__zen.grants`), as Chrome's bindings do; `permissions.remove`
   * deletes them again. Absent or empty: the granted set is all there is.
   */
  optionalPermissions?: string[]
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
  /**
   * Chars a message envelope (`runtime.sendMessage`'s, `port.postMessage`'s, serialized) may
   * have; a longer one is refused in the sender's realm with Chrome's error for a message over
   * `kMaxMessageLength` (64 MB there, [MAX_MESSAGE_LENGTH] here by default). The host sets it
   * from its heap (`ext.env`'s `messageLimit`): a message the host would refuse never crosses.
   */
  maxMessageLength?: number
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
  /**
   * The drawing surfaces `action.setIcon`'s pixels are compacted with before they are posted
   * (`iconWire.ts`); the realm's own, captured at creation, by default. Tests hand in theirs.
   */
  iconWire?: IconWireEnv
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
  /**
   * A host call outside `chrome` (a bootstrap-level platform such as a page's Web Speech API):
   * `{ t: 'call', ns, method, args }`, answered like the shim's, and the host's events for
   * `ns` through [onHostEvent] once the bootstrap has asked for them with a `listen` post.
   */
  call(ns: string, method: string, args: unknown[]): Promise<unknown>
  onHostEvent(listener: (namespace: string, event: string, args: unknown[]) => void): void
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

/**
 * The host's `{ unfiltered, matched }` for an event some listeners filtered by URL, or nothing;
 * `url` when the host could not match this context's filters yet (the shim matches them).
 */
function eventDelivery(raw: unknown): EventDelivery | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const d = raw as { unfiltered?: unknown; matched?: unknown; url?: unknown }
  const delivery: EventDelivery = {
    unfiltered: d.unfiltered !== false,
    matched: Array.isArray(d.matched) ? d.matched.filter((m) => typeof m === 'number') : []
  }
  if (typeof d.url === 'string') delivery.url = d.url
  return delivery
}

const EXTENSION_ID = /^[a-p]{32}$/

/** Chrome's `runtime.lastError` for a native messaging host that does not exist. */
export const NATIVE_HOST_NOT_FOUND = 'Specified native messaging host not found.'

/** Chrome's error for a message over its maximum (`messaging_util::kMessageTooLongError`). */
export const MESSAGE_TOO_LONG = 'Message length exceeded maximum allowed length.'

/** Chrome's `kMaxMessageLength`, 64 MB, as the default when the host names no limit. */
export const MAX_MESSAGE_LENGTH = 64 * 1024 * 1024

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

  /** [message] stamped for the host and serialized; undefined (logged) when it cannot be. */
  const serialize = (message: Record<string, unknown>): string | undefined => {
    message.token = config.token
    message.ep = config.endpointId
    try {
      return primordials.stringify(message)
    } catch (error) {
      primordials.error('[Zenium] extension bridge post failed', error)
      return undefined
    }
  }

  const deliver = (text: string): void => {
    try {
      transport.post(text)
    } catch (error) {
      primordials.error('[Zenium] extension bridge post failed', error)
    }
  }

  const post = (message: Record<string, unknown>): void => {
    const text = serialize(message)
    if (text !== undefined) deliver(text)
  }

  const maxMessageLength = config.maxMessageLength ?? MAX_MESSAGE_LENGTH

  /**
   * Posts a messaging envelope after Chrome's `kMaxMessageLength` check, made here in the
   * sender's realm on the serialized text: over the limit nothing is posted and the caller gets
   * `tooLong()` thrown, as Chrome throws from `runtime.sendMessage` and `port.postMessage`. The
   * limit is the host's, so a message its bridge would refuse on raw length (the phone's heap,
   * not Chrome's 64 MB) stops in the realm that built it: a popup broadcasting its whole store
   * to its pages on every change hears the error in place of a dead process.
   */
  const postMeasured = (message: Record<string, unknown>, tooLong: () => Error): void => {
    const text = serialize(message)
    if (text === undefined) return
    if (text.length > maxMessageLength) throw tooLong()
    deliver(text)
  }

  const call = (ns: string, method: string, args: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      post({ t: 'call', id, ns, method, args })
    })

  /**
   * `action.setIcon`'s `imageData` compacted for the text bridge before the call is posted:
   * the shim hands over the `ImageData`'s bytes as they are, which `stringify` would write
   * member by member (0.3 M chars for a 96 px icon, sixty times a second from an extension
   * that animates its icon – the host's heap, compat round 11b). `iconWire.ts` scales them to
   * the slot the chrome draws and writes them as base64; the host reads that form.
   */
  const iconWire = options.iconWire ?? captureIconWireEnv()
  const forWire = (ns: string, method: string, args: unknown[]): unknown[] => {
    if (ns !== 'action' || method !== 'setIcon' || args.length === 0) return args
    return [compactIconDetails(args[0], iconWire), ...args.slice(1)]
  }

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

  // --- messaging ---------------------------------------------------------------------------------

  type MessageTarget = { extensionId?: string | null; tabId?: unknown; options?: unknown }

  /**
   * `callback`: the sender passed one, so a port every listener let close without a response is
   * reported to it as an error, as Chrome reports it ("The message port closed before a response
   * was received."); the promise form resolves with undefined there.
   */
  const sendMessage = (
    target: MessageTarget,
    data: unknown,
    callback: boolean
  ): Promise<unknown> => {
    const id = ++seq
    const reply = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject })
    })
    try {
      // Chrome throws the oversized-message TypeError from `sendMessage` itself, synchronously,
      // before any promise or callback is in play.
      postMeasured(
        {
          t: 'msg',
          id,
          target,
          data: data === undefined ? null : data,
          ...(callback ? { callback: true } : {}),
          ...(userScript ? { userScript: true } : {})
        },
        () => new TypeError(MESSAGE_TOO_LONG)
      )
    } catch (error) {
      pending.delete(id)
      throw error
    }
    return reply
  }

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
        if (!local)
          postMeasured(
            { t: 'portMsg', portId, data: message === undefined ? null : message },
            () => new Error(MESSAGE_TOO_LONG)
          )
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

  // What every context has, a `USER_SCRIPT` world with `messaging` on included: Chrome gives
  // user-script worlds the identity bits and messaging both ways – `sendMessage` / `connect` to
  // the extension (its `onUserScriptMessage` / `onUserScriptConnect`) and `onMessage` /
  // `onConnect` for what the extension sends the tab (`shared/userScriptWorld.ts` is the
  // desktop's copy of this surface). Tampermonkey's content.js runs in that world and adds its
  // `runtime.onMessage` listener unguarded.
  Object.assign(runtime, {
    id: config.id,
    getURL,
    getPlatformInfo: (...args: unknown[]) =>
      settle(
        Promise.resolve({ os: 'android', arch: 'arm64', nacl_arch: 'arm' }),
        takeCallback(args)
      ),
    sendMessage: (...args: unknown[]) => {
      const { extensionId, message, options, callback } = parseSendMessageArgs(args)
      return settle(
        sendMessage({ extensionId, options: options ?? null }, message, callback !== undefined),
        callback
      )
    },
    connect: (...args: unknown[]) => {
      const rest = [...args]
      let extensionId: string | null = null
      if (rest.length >= 1 && (isExtensionId(rest[0]) || (rest.length === 2 && rest[0] === null))) {
        extensionId = (rest.shift() as string | null) ?? null
      }
      return connect({ extensionId }, rest[0])
    },
    onMessage: createEvent('runtime.onMessage', true),
    onConnect: createEvent('runtime.onConnect', true)
  })

  if (!userScript) {
    Object.assign(runtime, {
      // Chrome defines it only with the `nativeMessaging` permission.
      ...(config.permissions.includes('nativeMessaging') ? { connectNative } : {}),
      getManifest: () => config.manifest,
      onMessageExternal: createEvent('runtime.onMessageExternal', true),
      onConnectExternal: createEvent('runtime.onConnectExternal', true),
      onUserScriptMessage: createEvent('runtime.onUserScriptMessage', true),
      onUserScriptConnect: createEvent('runtime.onUserScriptConnect', true)
    })
  }

  const chrome: Record<string, unknown> = { runtime }
  // The world's `chrome.extension` is the incognito flag alone (the shim's default for a content
  // script, which has no private-tab notion here either).
  if (userScript) chrome.extension = { inIncognitoContext: false }

  // --- engine members the table marks `engine` -------------------------------------------------

  const granted = (ns: string): boolean =>
    namespaceGranted(ns, config.permissions, config.manifestVersion)
  const contentScript = config.context === 'content'

  if (!userScript) {
    // The predefined messages answer as in Chrome: `@@extension_id` (the id, what a script
    // builds its resource URLs from), `@@ui_locale`, the `@@bidi_*` four.
    const predefined = predefinedMessages(config.uiLanguage, config.id)
    chrome.i18n = {
      getMessage: (name: unknown, substitutions?: unknown) =>
        predefined[String(name).toLowerCase()] ??
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
        return settle(
          sendMessage({ tabId, options: options ?? null }, message, callback !== undefined),
          callback
        )
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
    // `system.display`, `system.storage`, `system.cpu` and `system.memory` are the table's, for
    // the extensions that declared them (`engineSpec.ts`); the host answers each. The holder
    // `chrome.system` is the table's too, made once one of those permissions is held, as Chrome
    // defines it (Coinbase Wallet's worker feature-detects `chrome.system?.cpu?.getInfo` before
    // it reads the CPU load; run 35787391495 had every extension's holder carry a rejecting `cpu`).
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
      return call(ns, method, forWire(ns, method, args)).then(
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
    // The table carries every declared permission's namespace, the optional ones among them;
    // the shim defines those whose permission is granted and follows the grants from there
    // (`ShimOptions.granted`), so `permissions.request` defines a namespace and `remove` deletes
    // it, as in Chrome. Without optional permissions the granted set is the declared set.
    const optional = (config.optionalPermissions ?? []).filter(
      (p) => !config.permissions.includes(p)
    )
    diagnostics = installExtensionApi(
      shimHost,
      engineApiSpec({
        permissions:
          optional.length > 0 ? [...config.permissions, ...optional] : config.permissions,
        manifestVersion: config.manifestVersion,
        context: contentScript ? 'content' : 'page'
      }),
      optional.length > 0 ? { root, granted: config.permissions } : { root }
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
    call,
    onHostEvent: (listener) => {
      hostEventListeners.push(listener)
    },
    diagnostics
  }
}
