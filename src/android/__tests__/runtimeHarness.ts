import type { ExtensionInfo, Tab } from '@shared/types'
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

export class FakeKotlin implements RuntimeBridge {
  isolatedWorlds = true
  worldSlots = 16
  /** Pending `ext.setRules` replies while `holdRules` is on (to observe coalescing). */
  holdRules = false
  readonly heldRules: Array<() => void> = []
  readonly calls: Array<{ method: string; args: Record<string, unknown> }> = []
  /** Every message the runtime sent to an endpoint, decoded. */
  readonly sent: Sent[] = []
  readonly manifests = new Map<string, Record<string, unknown>>()
  readonly files = new Map<string, string>()
  /** Background pages Kotlin holds right now, by extension id. */
  readonly backgrounds = new Set<string>()
  /** When set, `ext.exec` is rejected with the message it returns for the given arguments. */
  failExec: ((args: Record<string, unknown>) => string | null) | null = null

  call<T = void>(method: string, args?: unknown): Promise<T> {
    if (method === 'ext.exec' && this.failExec) {
      const rejection = this.failExec((args ?? {}) as Record<string, unknown>)
      if (rejection !== null) return Promise.reject(new Error(rejection))
    }
    const result = this.dispatch(method, (args ?? {}) as Record<string, unknown>) as T
    if (method === 'ext.setRules' && this.holdRules) {
      return new Promise<T>((resolve) => this.heldRules.push(() => resolve(result)))
    }
    return Promise.resolve(result)
  }

  /** Answer every held `ext.setRules`. */
  releaseRules(): void {
    const held = this.heldRules.splice(0)
    for (const release of held) release()
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
          worldSlots: this.isolatedWorlds ? this.worldSlots : 0
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
      case 'ext.setRules':
      case 'ext.observeRequests':
      case 'ext.popup.open':
      case 'ext.popup.close':
      case 'ext.cookies.set':
      case 'ext.authFlow':
        return undefined
      case 'ext.cookies.get':
        return null
      case 'ext.exec':
        return { ran: true }
      default:
        throw new Error(`no such bridge method ${method}`)
    }
  }
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
  options: { isolatedWorlds?: boolean; worldSlots?: number; files?: Map<string, string> } = {}
): Harness {
  const kt = new FakeKotlin()
  kt.isolatedWorlds = options.isolatedWorlds ?? true
  kt.worldSlots = options.worldSlots ?? 16
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
  const notifyState = (): void => listeners.forEach((fn) => fn())
  const win = {
    isPrivate: false,
    host: {
      contentSize: () => ({ width: 411, height: 800 }),
      isFocused: () => true,
      isFullScreen: () => false
    }
  } as unknown as ZenWindow
  const browser = {
    platform: { io },
    state: {
      subscribe: (fn: () => void) => {
        listeners.push(fn)
        return () => undefined
      },
      commitVolatile: () => undefined
    },
    toast: (message: string) => {
      toasts.push(message)
    },
    extensions: { list: () => infos },
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
    created,
    clock,
    timers,
    tick,
    notifyState,
    toasts,
    infos,
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
  ctx: 'content' | 'background' | 'popup' | 'page',
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
  const [ns, name] = key.split('.')
  return h.kt.to(ep).filter((m) => m.t === 'event' && m.ns === ns && m.name === name)
}

/** The background comes up: hello, listeners, ready. */
export function backgroundUp(h: Harness, ep: string, listeners: string[] = []): void {
  hello(h, ep, 'background')
  for (const event of listeners) message(h, ep, { t: 'listen', event, on: true })
  message(h, ep, { t: 'ready' })
}

// ---------------------------------------------------------------------------
