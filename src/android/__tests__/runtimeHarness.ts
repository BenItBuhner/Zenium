import type {
  Container,
  ExtensionInfo,
  SearchEngine,
  SearchEngineControl,
  Tab
} from '@shared/types'
import { RuleEngine } from '@core/blocking/engine'
import type { Browser } from '@core/browser'
import type { StoreIO } from '@core/platform'
import type { ZenWindow } from '@core/window'
import { newRecord, type ExtensionRecord } from '@core/extensions/registry'
import {
  AndroidExtensionRuntime,
  type ConfigureStats,
  type RuntimeBridge
} from '../extensionRuntime'

// ---------------------------------------------------------------------------
// A Kotlin side in memory: what ext/Extensions.kt answers, minus the WebViews
// ---------------------------------------------------------------------------

export interface Sent {
  ep: string
  message: Record<string, unknown>
}

/** One `identity.launchWebAuthFlow` sheet as the fake Kotlin holds it. */
export interface FakeAuthSheet {
  id: string
  url: string
  title: string
  shown: boolean
  closed: boolean
}

export class FakeKotlin implements RuntimeBridge {
  isolatedWorlds = true
  worldSlots = 16
  /** The fake WebView has the navigation listener (`navigation` view events carry webNavigation). */
  navigationListener = false
  readonly calls: Array<{ method: string; args: Record<string, unknown> }> = []
  /** Every message the runtime sent to an endpoint, decoded. */
  readonly sent: Sent[] = []
  readonly manifests = new Map<string, Record<string, unknown>>()
  readonly files = new Map<string, string>()
  /** Background pages Kotlin holds right now, by extension id. */
  readonly backgrounds = new Set<string>()
  /** When set, `ext.exec` is rejected with the message it returns for the given arguments. */
  failExec: ((args: Record<string, unknown>) => string | null) | null = null
  /** When set, what `ext.exec` answers (the script's value) for the given arguments. */
  execAnswer: ((args: Record<string, unknown>) => unknown) | null = null
  /** What the fake platform's classifier answers `ext.i18n.detectLanguage` (Kotlin's shape). */
  languageAnswer: (text: string) => unknown = () => ({ isReliable: false, languages: [] })
  /** The offscreen documents Kotlin holds right now (`ext.offscreen.*`): extension id → page URL. */
  readonly offscreens = new Map<string, string>()
  /** The cookie jars (`ext.cookies.*`), one per container, see `FakeJar`. */
  readonly jars = new Map<string, FakeJar>()
  /** Whether the fake WebView lists cookies with attributes (`GET_COOKIE_INFO`). */
  detailedCookies = true
  /** Whether the fake app may post notifications (`ext.notifications.allowed`). */
  notificationsAllowed = true
  /** The notifications Kotlin shows right now: `<extension id>/<notification id>` → what it was given. */
  readonly notifications = new Map<string, Record<string, unknown>>()
  /** The auth sheets Kotlin holds (`ext.auth.*`), by view id; `closed` ones stay for inspection. */
  readonly authSheets = new Map<number, FakeAuthSheet>()
  /** What `view.capture` answers: the encoded pixels, or null for a view that cannot be copied. */
  capture: ((args: Record<string, unknown>) => Record<string, unknown> | null) | null = (args) => ({
    data: 'AAAA',
    mimeType: `image/${String(args.format)}`,
    width: 2,
    height: 2
  })

  jar(container = 'default'): FakeJar {
    let jar = this.jars.get(container)
    if (!jar) {
      jar = new FakeJar()
      this.jars.set(container, jar)
    }
    return jar
  }

  call<T = void>(method: string, args?: unknown): Promise<T> {
    if (method === 'ext.exec' && this.failExec) {
      const rejection = this.failExec((args ?? {}) as Record<string, unknown>)
      if (rejection !== null) return Promise.reject(new Error(rejection))
    }
    const result = this.dispatch(method, (args ?? {}) as Record<string, unknown>) as T
    return Promise.resolve(result)
  }

  send(method: string, args?: unknown): void {
    this.dispatch(method, (args ?? {}) as Record<string, unknown>)
  }

  calledWith(method: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args)
  }

  /** Replies and events the runtime sent to one endpoint. */
  to(ep: string): Record<string, unknown>[] {
    return this.sent.filter((s) => s.ep === ep).map((s) => s.message)
  }

  private dispatch(method: string, args: Record<string, unknown>): unknown {
    this.calls.push({ method, args })
    switch (method) {
      case 'ext.env':
        return {
          token: 'tok',
          uiLanguage: 'en-US',
          isolatedWorlds: this.isolatedWorlds,
          worldSlots: this.isolatedWorlds ? this.worldSlots : 0,
          navigationListener: this.navigationListener
        }
      case 'ext.open': {
        const manifest = this.manifests.get(String(args.path))
        if (!manifest) throw new Error(`no manifest under ${args.path}`)
        return { manifest: JSON.stringify(manifest), locales: {} }
      }
      case 'ext.configure': {
        const units = args.units as Array<{ key: string }>
        const stats: ConfigureStats = {
          units: units.map((u) => ({ key: u.key, chars: 100, cached: false })),
          ms: 1
        }
        return stats
      }
      case 'ext.detach':
        this.backgrounds.delete(String(args.id))
        this.offscreens.delete(String(args.id))
        return undefined
      case 'ext.expect':
        return undefined
      case 'ext.background.start':
        this.backgrounds.add(String(args.id))
        return undefined
      case 'ext.background.stop':
        this.backgrounds.delete(String(args.id))
        return undefined
      case 'ext.send':
        this.sent.push({
          ep: String(args.ep),
          message: JSON.parse(String(args.message)) as Record<string, unknown>
        })
        return undefined
      case 'ext.readFile':
        return this.files.get(`${args.id}/${args.path}`) ?? null
      case 'ext.i18n.detectLanguage':
        return this.languageAnswer(String(args.text))
      case 'ext.observeRequests':
      case 'ext.popup.open':
      case 'ext.popup.close':
        return undefined
      case 'ext.offscreen.open':
        this.offscreens.set(String(args.id), String(args.url))
        return undefined
      case 'ext.offscreen.close':
        this.offscreens.delete(String(args.id))
        return undefined
      case 'ext.auth.open':
        this.authSheets.set(Number(args.viewId), {
          id: String(args.id),
          url: String(args.url),
          title: String(args.title),
          shown: false,
          closed: false
        })
        return undefined
      case 'ext.auth.show': {
        const sheet = this.authSheets.get(Number(args.viewId))
        if (sheet && !sheet.closed) sheet.shown = true
        return undefined
      }
      case 'ext.auth.close': {
        const sheet = this.authSheets.get(Number(args.viewId))
        if (sheet) sheet.closed = true
        return undefined
      }
      case 'ext.cookies.read': {
        const jar = this.jar(String(args.container))
        return {
          cookies: this.detailedCookies
            ? jar.setCookieLines(String(args.url))
            : jar.pairs(String(args.url)),
          detailed: this.detailedCookies
        }
      }
      case 'ext.cookies.write':
        return this.jar(String(args.container)).set(String(args.url), String(args.cookie))
      case 'ext.exec':
        return this.execAnswer ? this.execAnswer(args) : { ran: true }
      case 'view.capture':
        return this.capture ? this.capture(args) : null
      case 'ext.notifications.show': {
        const notification = args.notification as Record<string, unknown>
        this.notifications.set(`${args.id}/${notification.notificationId}`, notification)
        return undefined
      }
      case 'ext.notifications.hide':
        this.notifications.delete(`${args.id}/${args.notificationId}`)
        return undefined
      case 'ext.notifications.forget':
        for (const key of [...this.notifications.keys()])
          if (key.startsWith(`${args.id}/`)) this.notifications.delete(key)
        return undefined
      case 'ext.notifications.allowed':
        return this.notificationsAllowed
      default:
        throw new Error(`no such bridge method ${method}`)
    }
  }
}

/** A stored cookie of the fake jar (what the WebView remembers about one). */
export interface FakeCookie {
  name: string
  value: string
  /** With a leading dot: a domain cookie; without: host-only. */
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  expires: number | null
  sameSite: string | null
}

/**
 * A cookie jar with `CookieManager`'s two readings: `getCookie`'s `name=value` pairs and
 * `getCookieInfo`'s `Set-Cookie` lines, both filtered by URL the way the WebView filters them
 * (host match, path prefix, `Secure` over https only). `set` parses a `Set-Cookie` line; an
 * expired one deletes.
 */
export class FakeJar {
  readonly cookies: FakeCookie[] = []

  set(url: string, line: string): boolean {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    const parts = line.split(';').map((p) => p.trim())
    const first = parts.shift() ?? ''
    const eq = first.indexOf('=')
    const cookie: FakeCookie = {
      name: eq === -1 ? '' : first.slice(0, eq),
      value: eq === -1 ? first : first.slice(eq + 1),
      domain: host,
      path: defaultPathOf(u.pathname),
      secure: false,
      httpOnly: false,
      expires: null,
      sameSite: null
    }
    for (const part of parts) {
      const at = part.indexOf('=')
      const key = (at === -1 ? part : part.slice(0, at)).toLowerCase()
      const value = at === -1 ? '' : part.slice(at + 1)
      if (key === 'domain' && value) {
        const domain = value.replace(/^\./, '').toLowerCase()
        if (host !== domain && !host.endsWith(`.${domain}`)) return false
        cookie.domain = `.${domain}`
      } else if (key === 'path' && value.startsWith('/')) cookie.path = value
      else if (key === 'secure') cookie.secure = true
      else if (key === 'httponly') cookie.httpOnly = true
      else if (key === 'expires') cookie.expires = Date.parse(value)
      else if (key === 'max-age') cookie.expires = Date.now() + Number(value) * 1000
      else if (key === 'samesite') cookie.sameSite = value
    }
    if (cookie.secure && u.protocol !== 'https:') return false
    const index = this.cookies.findIndex(
      (c) => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path
    )
    if (index >= 0) this.cookies.splice(index, 1)
    if (cookie.expires !== null && cookie.expires <= Date.now()) return true
    this.cookies.push(cookie)
    return true
  }

  matching(url: string): FakeCookie[] {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    const path = u.pathname || '/'
    return this.cookies.filter((c) => {
      const hostOk = c.domain.startsWith('.')
        ? host === c.domain.slice(1) || host.endsWith(c.domain)
        : host === c.domain
      if (!hostOk) return false
      if (c.secure && u.protocol !== 'https:') return false
      return path === c.path || path.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`)
    })
  }

  pairs(url: string): string[] {
    return this.matching(url).map((c) => `${c.name}=${c.value}`)
  }

  setCookieLines(url: string): string[] {
    return this.matching(url).map((c) => {
      const parts = [`${c.name}=${c.value}`]
      if (c.domain.startsWith('.')) parts.push(`Domain=${c.domain}`)
      parts.push(`Path=${c.path}`)
      if (c.expires !== null) parts.push(`Expires=${new Date(c.expires).toUTCString()}`)
      if (c.secure) parts.push('Secure')
      if (c.httpOnly) parts.push('HttpOnly')
      if (c.sameSite) parts.push(`SameSite=${c.sameSite}`)
      return parts.join('; ')
    })
  }
}

function defaultPathOf(pathname: string): string {
  const last = pathname.lastIndexOf('/')
  return last <= 0 ? '/' : pathname.slice(0, last)
}

// ---------------------------------------------------------------------------
// A browser core in miniature: tabs, the state subscription, the one window
// ---------------------------------------------------------------------------

export interface Harness {
  kt: FakeKotlin
  runtime: AndroidExtensionRuntime
  files: Map<string, string>
  tabs: Record<string, Tab>
  active: { id: string | null }
  /** The core's request-blocking engine the declarativeNetRequest sink feeds (`browser.blocking.engine`). */
  engine: RuleEngine
  /** The user's containers in the model (`state.model.containers`); private is not one. */
  containers: Container[]
  /** Every `tabs.createTab` the runtime made, in order: the new tab's id and whether it was activated. */
  created: Array<{ id: string; active: boolean }>
  clock: { now: number }
  timers: Array<{ fn: () => void; ms: number; at: number; cleared: boolean }>
  /** Run every timer due at or before `clock.now`. */
  tick: (ms: number) => void
  notifyState: () => void
  toasts: string[]
  /** What `browser.extensions.list()` answers (the store's view: icons for the menus). */
  infos: ExtensionInfo[]
  /**
   * The PDF viewer's documents (`browser.pdf.documentUrl`): a viewer tab's address
   * (`zen://pdf?id=…`) → the URL of the PDF it shows, which the tab reads as to extensions.
   */
  pdfDocuments: Map<string, string>
  /**
   * What the runtime told the search model (`state.setExtensionSearch`), every call in order:
   * the attached extensions' engines and the control of the default.
   */
  search: Array<{ engines: SearchEngine[]; control: SearchEngineControl | null }>
  /** Write the debounced JSON documents out now and parse one of them. */
  saved: (name: string) => Record<string, unknown>
}

export function makeTab(id: string, url: string, containerId = 'default'): Tab {
  return {
    id,
    url,
    title: url,
    loading: false,
    containerId
  } as unknown as Tab
}

export function harness(
  options: {
    isolatedWorlds?: boolean
    worldSlots?: number
    files?: Map<string, string>
    navigationListener?: boolean
  } = {}
): Harness {
  const kt = new FakeKotlin()
  kt.isolatedWorlds = options.isolatedWorlds ?? true
  kt.worldSlots = options.worldSlots ?? 16
  kt.navigationListener = options.navigationListener ?? false
  const files = options.files ?? new Map<string, string>()
  const io: StoreIO = {
    readSync: (name) => files.get(name) ?? null,
    write: async (name, text) => {
      files.set(name, text)
    },
    writeSync: (name, text) => {
      files.set(name, text)
    },
    remove: async (name) => {
      files.delete(name)
    }
  }
  const tabs: Record<string, Tab> = { t1: makeTab('t1', 'https://example.com/') }
  const active = { id: 't1' as string | null }
  const created: Harness['created'] = []
  const listeners: Array<() => void> = []
  const toasts: string[] = []
  const infos: ExtensionInfo[] = []
  const engine = new RuleEngine()
  const containers: Container[] = []
  const notifyState = (): void => listeners.forEach((fn) => fn())
  const win = {
    isPrivate: false,
    host: {
      contentSize: () => ({ width: 411, height: 800 }),
      isFocused: () => true,
      isFullScreen: () => false
    }
  } as unknown as ZenWindow
  const pdfDocuments = new Map<string, string>()
  const search: Harness['search'] = []
  const browser = {
    platform: { io },
    state: {
      model: { containers },
      subscribe: (fn: () => void) => {
        listeners.push(fn)
        return () => undefined
      },
      commitVolatile: () => undefined,
      setExtensionSearch: (engines: SearchEngine[], control: SearchEngineControl | null) => {
        search.push({ engines, control })
      }
    },
    toast: (message: string) => {
      toasts.push(message)
    },
    extensions: { list: () => infos },
    pdf: { documentUrl: (url: string) => pdfDocuments.get(url) ?? null },
    tabs: {
      tab: (id: string) => tabs[id],
      activeTabFor: () => (active.id ? tabs[active.id] : undefined),
      model: { tabs, spaces: [] },
      isPrivate: (tab: Tab) => tab.containerId === 'private',
      createTab: (opts: { url: string; active?: boolean }) => {
        const id = `t${created.length + 2}`
        tabs[id] = makeTab(id, opts.url)
        const activate = opts.active !== false
        if (activate) active.id = id
        created.push({ id, active: activate })
        notifyState()
        return tabs[id]
      },
      activateTab: (id: string) => {
        active.id = id
        notifyState()
      },
      closeTab: (id: string) => {
        delete tabs[id]
        if (active.id === id) active.id = 't1'
        notifyState()
      }
    }
  } as unknown as Browser
  const clock = { now: 1_700_000_000_000 }
  const timers: Harness['timers'] = []
  const runtime = new AndroidExtensionRuntime(kt, browser, () => win, {
    idleMs: 30_000,
    now: () => clock.now,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms, at: clock.now + ms, cleared: false })
      return timers.length - 1
    },
    clearTimeout: (handle) => {
      const timer = timers[handle as number]
      if (timer) timer.cleared = true
    }
  })
  // As in the Browser constructor: `createExtensions` (this runtime) runs before the blocking
  // service exists, so the engine is attached afterwards and must be read lazily.
  ;(browser as unknown as { blocking: { engine: RuleEngine } }).blocking = { engine }
  const tick = (ms: number): void => {
    clock.now += ms
    for (;;) {
      const due = timers
        .filter((t) => !t.cleared && t.at <= clock.now)
        .sort((a, b) => a.at - b.at)[0]
      if (!due) return
      due.cleared = true
      due.fn()
    }
  }
  return {
    kt,
    runtime,
    files,
    tabs,
    active,
    engine,
    containers,
    created,
    clock,
    timers,
    tick,
    notifyState,
    toasts,
    infos,
    pdfDocuments,
    search,
    saved: (name) => {
      runtime.flushSync()
      return JSON.parse(files.get(name) ?? '{}') as Record<string, unknown>
    }
  }
}

export const ID = 'abcdefghijklmnopabcdefghijklmnop'
export const ID2 = 'ponmlkjihgfedcbaponmlkjihgfedcba'
export const PATH = `/data/user/0/app.zen.chromium/files/zen/extensions/${ID}/1.0.0`

export function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifest_version: 3,
    name: 'Runtime test',
    version: '1.0.0',
    permissions: ['storage', 'alarms', 'scripting', 'tabs'],
    host_permissions: ['https://example.com/*'],
    background: { service_worker: 'bg.js' },
    content_scripts: [
      { matches: ['https://example.com/*'], js: ['cs.js'], run_at: 'document_start' }
    ],
    action: { default_popup: 'popup.html' },
    ...overrides
  }
}

export function record(
  h: Harness,
  overrides: Partial<ExtensionRecord> = {},
  m = manifest()
): ExtensionRecord {
  h.kt.manifests.set(overrides.path ?? PATH, m)
  return {
    ...newRecord({ id: ID, source: 'crx', path: PATH, manifest: m, now: h.clock.now }),
    ...overrides
  }
}

/** A frame or page says hello and becomes an endpoint. */
export function hello(
  h: Harness,
  ep: string,
  ctx: 'content' | 'background' | 'popup' | 'offscreen' | 'page',
  extra: { tabId?: string | null; top?: boolean; url?: string } = {}
): void {
  const url =
    extra.url ??
    (ctx === 'content' ? 'https://example.com/' : `https://${ID}.ext.zenium.invalid/bg.html`)
  h.runtime.onMessage({
    ep,
    tabId: extra.tabId ?? (ctx === 'content' ? 't1' : null),
    top: extra.top ?? true,
    origin: new URL(url).origin,
    message: { t: 'hello', ext: ID, ctx, url, world: ctx === 'content' }
  })
}

export function message(h: Harness, ep: string, message: Record<string, unknown>): void {
  h.runtime.onMessage({ ep, tabId: null, top: true, origin: '', message })
}

/** Let the runtime's pending promises run until `ready` holds (a bounded number of ticks). */
export async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (ready()) return
    await Promise.resolve()
  }
  throw new Error('the runtime did not get there')
}

let callSeq = 0

/** The next `call` id; for tests that send a call and read its reply later. */
export function nextCallId(): number {
  return ++callSeq
}

/** A `chrome.<ns>.<method>(...args)` call from an endpoint; resolves with the reply. */
export async function call(
  h: Harness,
  ep: string,
  ns: string,
  method: string,
  args: unknown[]
): Promise<Record<string, unknown>> {
  const id = nextCallId()
  message(h, ep, { t: 'call', id, ns, method, args })
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
    const reply = h.kt.to(ep).find((m) => m.t === 'reply' && m.id === id)
    if (reply) return reply
  }
  throw new Error(`no reply to ${ns}.${method}`)
}

export function events(h: Harness, ep: string, key: string): Record<string, unknown>[] {
  // The event name follows the last dot: `storage.local.onChanged` is `onChanged` of the
  // `storage.local` namespace, as the shim spells an area's own event.
  const dot = key.lastIndexOf('.')
  const ns = key.slice(0, dot)
  const name = key.slice(dot + 1)
  return h.kt.to(ep).filter((m) => m.t === 'event' && m.ns === ns && m.name === name)
}

/** The background comes up: hello, listeners, ready. */
export function backgroundUp(h: Harness, ep: string, listeners: string[] = []): void {
  hello(h, ep, 'background')
  for (const event of listeners) message(h, ep, { t: 'listen', event, on: true })
  message(h, ep, { t: 'ready' })
}

// ---------------------------------------------------------------------------
