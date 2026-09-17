import { API_SCHEMA, namespaceGranted, type MemberStatus } from './apiSchema'
import { getMessage, type LocaleMessages } from './manifest'
import { extensionOrigin, extensionUrl } from './plan'

/**
 * The `chrome.*` object handed to extension code (content scripts, background page, popups and
 * options pages). Everything that needs the browser goes through one JSON transport to the host;
 * the shim owns the callback-or-promise calling convention, `runtime.lastError`, events, ports
 * and the message/response handshake, so hosts only route.
 *
 * Wire format (page → host), every message carries `token` and `ep` (endpoint id):
 *  hello        { ctx, ext, url, top }                           register this endpoint
 *  call         { id, ns, method, args }                         → reply
 *  msg          { id, target, data }                             runtime/tabs.sendMessage → reply
 *  msgReply     { id, handled, willRespond?, response? }         answer to a delivered message
 *  connect      { portId, name, target }                         runtime/tabs.connect
 *  portAccept   { portId, accept }                               answer to portConnect
 *  portMsg      { portId, data }
 *  portDisconnect { portId }
 *  listen       { ns, name, on }                                 first/last listener of an event
 *  ready        {}                                               extension page finished loading
 *  popupSize    { width, height }                                popup document size changed
 *  closePopup   {}
 *
 * Host → page: reply { id, ok, result | error }, deliver { id, data, sender }, event { ns, name,
 * args }, portConnect { portId, name, sender }, portAccept { portId, accept, error? }, portMsg,
 * portDisconnect { portId, error? }.
 */
export type ShimContextKind = 'content' | 'background' | 'popup' | 'options' | 'offscreen' | 'page'

export interface ShimConfig {
  id: string
  manifest: Record<string, unknown>
  manifestVersion: 2 | 3
  permissions: string[]
  messages: LocaleMessages | null
  uiLanguage: string
  context: ShimContextKind
  token: string
  endpointId: string
  /** Frame URL the endpoint runs in. */
  url: string
  isTopFrame: boolean
}

export interface ShimTransport {
  post(message: string): void
}

/**
 * Functions captured before the page's own scripts run, so a page that patches `JSON.stringify`
 * or `setTimeout` cannot break the bridge. Content scripts in the main world share prototypes
 * with the page; this is the part of the isolation the shim can still guarantee.
 */
export interface Primordials {
  stringify: (value: unknown) => string
  parse: (text: string) => unknown
  setTimeout: (callback: () => void, ms: number) => number
  queueMicrotask: (callback: () => void) => void
  error: (...args: unknown[]) => void
}

export function capturePrimordials(): Primordials {
  const g = globalThis as typeof globalThis & { queueMicrotask?: (cb: () => void) => void }
  const stringify = JSON.stringify
  const parse = JSON.parse
  const timeout = g.setTimeout
  const micro = g.queueMicrotask ?? ((cb: () => void) => void Promise.resolve().then(cb))
  const error = console.error
  return {
    stringify: (value) => stringify(value),
    parse: (text) => parse(text),
    setTimeout: (cb, ms) => timeout(cb, ms) as unknown as number,
    queueMicrotask: (cb) => micro(cb),
    error: (...args) => error(...args)
  }
}

type Listener = (...args: unknown[]) => unknown

export class ChromeEvent {
  private listeners: Listener[] = []

  constructor(
    private readonly namespace: string,
    private readonly name: string,
    private readonly onCountChange: (ns: string, name: string, on: boolean) => void
  ) {}

  addListener(listener: Listener): void {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    if (this.listeners.includes(listener)) return
    this.listeners.push(listener)
    if (this.listeners.length === 1) this.onCountChange(this.namespace, this.name, true)
  }

  removeListener(listener: Listener): void {
    const index = this.listeners.indexOf(listener)
    if (index === -1) return
    this.listeners.splice(index, 1)
    if (this.listeners.length === 0) this.onCountChange(this.namespace, this.name, false)
  }

  hasListener(listener: Listener): boolean {
    return this.listeners.includes(listener)
  }

  hasListeners(): boolean {
    return this.listeners.length > 0
  }

  /** Calls every listener, isolating their exceptions; returns their return values. */
  dispatch(...args: unknown[]): unknown[] {
    const results: unknown[] = []
    for (const listener of [...this.listeners]) {
      try {
        results.push(listener(...args))
      } catch (error) {
        results.push(undefined)
        reportListenerError(this.namespace, this.name, error)
      }
    }
    return results
  }
}

let reportListenerError: (ns: string, name: string, error: unknown) => void = () => undefined

export interface MessageSender {
  id: string
  url?: string
  origin?: string
  tab?: Record<string, unknown>
  frameId?: number
  documentId?: string
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export interface ChromeShim {
  chrome: Record<string, unknown>
  /** Feed a host → page message (already parsed). */
  receive(message: Record<string, unknown>): void
  /** Called by the bootstrap once (extension pages: after `load`). */
  ready(): void
}

interface Port {
  name: string
  sender?: MessageSender
  onMessage: ChromeEvent
  onDisconnect: ChromeEvent
  postMessage(message: unknown): void
  disconnect(): void
}

interface HostMessageBase {
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
}

const STORAGE_AREAS = ['local', 'sync', 'session', 'managed'] as const

export function createChromeShim(
  config: ShimConfig,
  transport: ShimTransport,
  primordials: Primordials
): ChromeShim {
  let seq = 0
  const pending = new Map<number, PendingCall>()
  const events = new Map<string, ChromeEvent>()
  const ports = new Map<string, { port: Port; connected: boolean; local: boolean }>()
  let lastError: { message: string } | undefined
  reportListenerError = (ns, name, error) =>
    primordials.error(`[Zenium] chrome.${ns}.${name} listener threw`, error)

  const post = (message: Record<string, unknown>): void => {
    message.token = config.token
    message.ep = config.endpointId
    try {
      transport.post(primordials.stringify(message))
    } catch (error) {
      primordials.error('[Zenium] extension bridge post failed', error)
    }
  }

  const eventFor = (ns: string, name: string): ChromeEvent => {
    const key = `${ns}.${name}`
    let event = events.get(key)
    if (!event) {
      event = new ChromeEvent(ns, name, (n, e, on) => post({ t: 'listen', ns: n, name: e, on }))
      events.set(key, event)
    }
    return event
  }

  const call = (ns: string, method: string, args: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      post({ t: 'call', id, ns, method, args })
    })

  /**
   * Chrome's calling convention: a trailing function is a callback (with `runtime.lastError`
   * set while it runs on failure); otherwise a Promise. Both are supported for every method.
   */
  const withCallback = (args: unknown[], run: (rest: unknown[]) => Promise<unknown>): unknown => {
    const last = args[args.length - 1]
    if (typeof last === 'function') {
      const callback = last as (...cbArgs: unknown[]) => void
      const rest = args.slice(0, -1)
      run(rest).then(
        (value) => {
          lastError = undefined
          callback(value)
        },
        (error: Error) => {
          lastError = { message: error.message }
          try {
            callback()
          } finally {
            lastError = undefined
          }
        }
      )
      return undefined
    }
    return run(args)
  }

  const notImplemented = (ns: string, method: string): Promise<never> =>
    Promise.reject(new Error(`chrome.${ns}.${method} is not implemented on Zenium for Android`))

  const methodImpl = (
    ns: string,
    method: string,
    status: MemberStatus
  ): ((...args: unknown[]) => unknown) => {
    if (status === 'stub') return (...args) => withCallback(args, () => notImplemented(ns, method))
    return (...args) => withCallback(args, (rest) => call(ns, method, rest))
  }

  const buildNamespace = (ns: string): Record<string, unknown> => {
    const schema = API_SCHEMA[ns]
    const out: Record<string, unknown> = {}
    for (const [method, status] of Object.entries(schema.methods)) {
      if (status === 'local') continue
      out[method] = methodImpl(ns, method, status)
    }
    for (const event of schema.events) out[event] = eventFor(ns, event)
    if (schema.constants) Object.assign(out, schema.constants)
    return out
  }

  // --- runtime -----------------------------------------------------------------------------------

  const isExtensionId = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-p]{32}$/.test(value)

  const sendMessage = (target: Record<string, unknown>, data: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      post({ t: 'msg', id, target, data })
    })

  const parseSendMessageArgs = (
    args: unknown[]
  ): { extensionId: string | null; message: unknown; options: unknown; callback: unknown } => {
    const rest = [...args]
    let callback: unknown
    if (typeof rest[rest.length - 1] === 'function') callback = rest.pop()
    let extensionId: string | null = null
    if (rest.length >= 2 && (isExtensionId(rest[0]) || rest[0] === null || rest[0] === undefined)) {
      extensionId = (rest.shift() as string | null | undefined) ?? null
    }
    const message = rest.shift()
    const options = rest.shift()
    return { extensionId, message, options, callback }
  }

  const finishWithCallback = (promise: Promise<unknown>, callback: unknown): unknown => {
    if (typeof callback !== 'function') return promise
    withCallback([callback], () => promise)
    return undefined
  }

  const createPort = (
    portId: string,
    name: string,
    sender: MessageSender | undefined,
    local: boolean
  ): Port => {
    const onMessage = new ChromeEvent('runtime', 'Port.onMessage', () => undefined)
    const onDisconnect = new ChromeEvent('runtime', 'Port.onDisconnect', () => undefined)
    const port: Port = {
      name,
      sender,
      onMessage,
      onDisconnect,
      postMessage: (message: unknown) => {
        const entry = ports.get(portId)
        if (!entry || !entry.connected)
          throw new Error('Attempting to use a disconnected port object')
        post({ t: 'portMsg', portId, data: message === undefined ? null : message })
      },
      disconnect: () => {
        const entry = ports.get(portId)
        if (!entry || !entry.connected) return
        entry.connected = false
        ports.delete(portId)
        post({ t: 'portDisconnect', portId })
      }
    }
    ports.set(portId, { port, connected: true, local })
    return port
  }

  const connect = (target: Record<string, unknown>, connectInfo: unknown): Port => {
    const info = (connectInfo ?? {}) as { name?: string }
    const portId = `${config.endpointId}:${++seq}`
    const port = createPort(portId, info.name ?? '', undefined, true)
    post({ t: 'connect', portId, name: port.name, target })
    return port
  }

  const runtime = buildNamespace('runtime')
  Object.assign(runtime, {
    id: config.id,
    getURL: (path: string) => extensionUrl(config.id, String(path ?? '')),
    getManifest: () => config.manifest,
    getPlatformInfo: (...args: unknown[]) =>
      withCallback(args, async () => ({ os: 'android', arch: 'arm64', nacl_arch: 'arm' })),
    sendMessage: (...args: unknown[]) => {
      const { extensionId, message, options, callback } = parseSendMessageArgs(args)
      return finishWithCallback(
        sendMessage({ extensionId, options: options ?? null }, message),
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
    }
  })
  Object.defineProperty(runtime, 'lastError', {
    get: () => lastError,
    enumerable: true,
    configurable: true
  })

  // --- storage -----------------------------------------------------------------------------------

  const normaliseKeys = (
    keys: unknown
  ): { list: string[] | null; defaults: Record<string, unknown> | null } => {
    if (keys === null || keys === undefined) return { list: null, defaults: null }
    if (typeof keys === 'string') return { list: [keys], defaults: null }
    if (Array.isArray(keys))
      return { list: keys.filter((k): k is string => typeof k === 'string'), defaults: null }
    if (typeof keys === 'object') {
      const defaults = keys as Record<string, unknown>
      return { list: Object.keys(defaults), defaults }
    }
    throw new TypeError('storage keys must be a string, an array of strings, an object or null')
  }

  const storageArea = (area: (typeof STORAGE_AREAS)[number]): Record<string, unknown> => {
    const quota =
      area === 'sync'
        ? {
            QUOTA_BYTES: 102400,
            QUOTA_BYTES_PER_ITEM: 8192,
            MAX_ITEMS: 512,
            MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
            MAX_WRITE_OPERATIONS_PER_MINUTE: 120
          }
        : { QUOTA_BYTES: 10485760 }
    const readOnly = area === 'managed'
    const write =
      (op: string, payload: unknown) =>
      (...args: unknown[]) =>
        withCallback(args, () =>
          readOnly
            ? Promise.reject(new Error('This is a read-only store.'))
            : call('storage', op, [area, payload ?? args[0]])
        )
    return {
      ...quota,
      get: (...args: unknown[]) =>
        withCallback(args, async (rest) => {
          const { list, defaults } = normaliseKeys(rest[0])
          const found = (await call('storage', 'get', [area, list])) as Record<string, unknown>
          if (!defaults) return found
          const merged: Record<string, unknown> = { ...defaults }
          for (const [k, v] of Object.entries(found)) merged[k] = v
          return merged
        }),
      getKeys: (...args: unknown[]) => withCallback(args, () => call('storage', 'getKeys', [area])),
      getBytesInUse: (...args: unknown[]) =>
        withCallback(args, (rest) =>
          call('storage', 'getBytesInUse', [area, normaliseKeys(rest[0]).list])
        ),
      set: (...args: unknown[]) => write('set', args[0])(...args.slice(1)),
      remove: (...args: unknown[]) =>
        write('remove', normaliseKeys(args[0]).list)(...args.slice(1)),
      clear: (...args: unknown[]) => write('clear', null)(...args),
      setAccessLevel: (...args: unknown[]) => withCallback(args, async () => undefined),
      onChanged: eventFor('storage', `${area}.onChanged`)
    }
  }

  const storage: Record<string, unknown> = { onChanged: eventFor('storage', 'onChanged') }
  for (const area of STORAGE_AREAS) storage[area] = storageArea(area)
  storage.AccessLevel = {
    TRUSTED_CONTEXTS: 'TRUSTED_CONTEXTS',
    TRUSTED_AND_UNTRUSTED_CONTEXTS: 'TRUSTED_AND_UNTRUSTED_CONTEXTS'
  }

  // --- i18n / extension --------------------------------------------------------------------------

  const i18n = buildNamespace('i18n')
  Object.assign(i18n, {
    getMessage: (name: string, substitutions?: unknown) =>
      getMessage(
        config.messages,
        String(name),
        Array.isArray(substitutions)
          ? substitutions.map(String)
          : substitutions === undefined
            ? []
            : [String(substitutions)]
      ),
    getUILanguage: () => config.uiLanguage,
    getAcceptLanguages: (...args: unknown[]) => withCallback(args, async () => [config.uiLanguage])
  })

  const extension = buildNamespace('extension')
  Object.assign(extension, {
    getURL: runtime.getURL,
    inIncognitoContext: false,
    isAllowedIncognitoAccess: (...args: unknown[]) => withCallback(args, async () => true),
    isAllowedFileSchemeAccess: (...args: unknown[]) => withCallback(args, async () => false)
  })

  // --- tabs (message helpers are special-cased, the rest is generic) ----------------------------

  const chrome: Record<string, unknown> = { runtime, storage, i18n, extension }
  const granted = (ns: string): boolean =>
    namespaceGranted(ns, config.permissions, config.manifestVersion)
  const contentScript = config.context === 'content'
  for (const ns of Object.keys(API_SCHEMA)) {
    if (ns in chrome) continue
    if (contentScript && !API_SCHEMA[ns].contentScript) continue
    if (!granted(ns)) continue
    chrome[ns] = buildNamespace(ns)
  }
  if (chrome.tabs) {
    Object.assign(chrome.tabs as Record<string, unknown>, {
      sendMessage: (...args: unknown[]) => {
        const rest = [...args]
        const tabId = rest.shift()
        let callback: unknown
        if (typeof rest[rest.length - 1] === 'function') callback = rest.pop()
        const [message, options] = rest
        return finishWithCallback(
          sendMessage({ tabId, options: options ?? null }, message),
          callback
        )
      },
      connect: (tabId: unknown, connectInfo?: unknown) => connect({ tabId }, connectInfo),
      // MV2 `tabs.executeScript([tabId], details)`: the tab id is optional and defaults to the active tab.
      executeScript: (...args: unknown[]) =>
        withCallback(args, (rest) => {
          const [tabId, details] =
            typeof rest[0] === 'object' && rest[0] !== null ? [null, rest[0]] : rest
          return call('tabs', 'executeScript', [tabId ?? null, details ?? {}])
        }),
      insertCSS: (...args: unknown[]) =>
        withCallback(args, (rest) => {
          const [tabId, details] =
            typeof rest[0] === 'object' && rest[0] !== null ? [null, rest[0]] : rest
          return call('tabs', 'insertCSS', [tabId ?? null, details ?? {}])
        })
    })
  }
  if (chrome.scripting) {
    // `func` cannot cross the JSON transport: send its source, the host wraps it with `args`.
    const scripting = chrome.scripting as Record<string, unknown>
    scripting.executeScript = (...args: unknown[]) =>
      withCallback(args, (rest) => {
        const injection = { ...((rest[0] ?? {}) as Record<string, unknown>) }
        const fn = injection.func ?? injection.function
        if (typeof fn === 'function') {
          injection.funcSource = (fn as () => void).toString()
          delete injection.func
          delete injection.function
        }
        return call('scripting', 'executeScript', [injection])
      })
  }
  if (chrome.action)
    (chrome.action as Record<string, unknown>).getUserSettings = (...args: unknown[]) =>
      withCallback(args, async () => ({ isOnToolbar: true }))
  if (chrome.webRequest)
    (chrome.webRequest as Record<string, unknown>).handlerBehaviorChanged = (...args: unknown[]) =>
      withCallback(args, async () => undefined)
  if (chrome.declarativeNetRequest) {
    const dnr = chrome.declarativeNetRequest as Record<string, unknown>
    dnr.isRegexSupported = (...args: unknown[]) =>
      withCallback(args, async () => ({ isSupported: true }))
    dnr.getAvailableStaticRuleCount = (...args: unknown[]) => withCallback(args, async () => 300000)
  }
  if (chrome.notifications)
    (chrome.notifications as Record<string, unknown>).getPermissionLevel = (...args: unknown[]) =>
      withCallback(args, async () => 'granted')
  if (chrome.cookies)
    (chrome.cookies as Record<string, unknown>).getAllCookieStores = (...args: unknown[]) =>
      withCallback(args, async () => [{ id: '0', tabIds: [] }])
  if (chrome.idle) (chrome.idle as Record<string, unknown>).setDetectionInterval = () => undefined
  if (chrome.identity)
    (chrome.identity as Record<string, unknown>).getRedirectURL = (path?: string) =>
      `${extensionOrigin(config.id)}/_zenium/identity/${path ?? ''}`
  if (chrome.dom)
    (chrome.dom as Record<string, unknown>).openOrClosedShadowRoot = (element: Element) =>
      element.shadowRoot
  if (chrome.privacy) {
    // Chrome exposes ChromeSettings objects; extensions mostly probe `websites.hyperlinkAuditingEnabled`.
    const setting = (): Record<string, unknown> => ({
      get: (...args: unknown[]) =>
        withCallback(args, async () => ({ value: false, levelOfControl: 'not_controllable' })),
      set: (...args: unknown[]) => withCallback(args, async () => undefined),
      clear: (...args: unknown[]) => withCallback(args, async () => undefined),
      onChange: eventFor('privacy', 'onChange')
    })
    Object.assign(chrome.privacy as Record<string, unknown>, {
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
    })
  }
  if (chrome.system)
    Object.assign(chrome.system as Record<string, unknown>, {
      cpu: {
        getInfo: (...args: unknown[]) =>
          withCallback(args, () => notImplemented('system.cpu', 'getInfo'))
      },
      memory: {
        getInfo: (...args: unknown[]) =>
          withCallback(args, () => notImplemented('system.memory', 'getInfo'))
      },
      display: {
        getInfo: (...args: unknown[]) =>
          withCallback(args, () => notImplemented('system.display', 'getInfo'))
      }
    })

  // --- host → page -------------------------------------------------------------------------------

  const deliverMessage = (id: number, data: unknown, sender: MessageSender): void => {
    const event = events.get('runtime.onMessage')
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
    const wantsAsync = results.some((r) => r === true)
    if (wantsAsync) {
      asyncResponse = true
      post({ t: 'msgReply', id, handled: true, willRespond: true })
    } else {
      post({ t: 'msgReply', id, handled: false, listeners: true })
    }
  }

  const receive = (raw: Record<string, unknown>): void => {
    const message = raw as unknown as HostMessageBase
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
        deliverMessage(Number(message.id), message.data, message.sender ?? { id: config.id })
        return
      case 'event': {
        const ns = String(message.ns)
        const name = String(message.name)
        const event = events.get(`${ns}.${name}`)
        if (event) event.dispatch(...(message.args ?? []))
        if (ns === 'storage' && name === 'onChanged') {
          // `storage.<area>.onChanged(changes)` mirrors the area-level event.
          const [changes, area] = message.args ?? []
          events.get(`storage.${String(area)}.onChanged`)?.dispatch(changes)
        }
        return
      }
      case 'portConnect': {
        const portId = String(message.portId)
        const event = events.get('runtime.onConnect')
        if (!event || !event.hasListeners()) {
          post({ t: 'portAccept', portId, accept: false })
          return
        }
        const port = createPort(portId, String(message.name ?? ''), message.sender, false)
        post({ t: 'portAccept', portId, accept: true })
        event.dispatch(port)
        return
      }
      case 'portAccept': {
        const portId = String(message.portId)
        if (message.accept) return
        const entry = ports.get(portId)
        if (!entry) return
        entry.connected = false
        ports.delete(portId)
        lastError = {
          message: message.error ?? 'Could not establish connection. Receiving end does not exist.'
        }
        try {
          entry.port.onDisconnect.dispatch(entry.port)
        } finally {
          lastError = undefined
        }
        return
      }
      case 'portMsg': {
        const entry = ports.get(String(message.portId))
        if (entry && entry.connected) entry.port.onMessage.dispatch(message.data, entry.port)
        return
      }
      case 'portDisconnect': {
        const portId = String(message.portId)
        const entry = ports.get(portId)
        if (!entry) return
        entry.connected = false
        ports.delete(portId)
        if (message.error) lastError = { message: message.error }
        try {
          entry.port.onDisconnect.dispatch(entry.port)
        } finally {
          lastError = undefined
        }
        return
      }
    }
  }

  post({ t: 'hello', ctx: config.context, ext: config.id, url: config.url, top: config.isTopFrame })

  return {
    chrome,
    receive,
    ready: () => post({ t: 'ready' })
  }
}
