import { describe, expect, it } from 'vitest'
import type { Tab } from '@shared/types'
import type { Browser } from '@core/browser'
import type { StoreIO } from '@core/platform'
import type { ZenWindow } from '@core/window'
import { newRecord, type ExtensionRecord } from '@core/extensions/registry'
import {
  AndroidExtensionRuntime,
  pickMessages,
  type ConfigureStats,
  type RuntimeBridge
} from '../extensionRuntime'

// ---------------------------------------------------------------------------
// A Kotlin side in memory: what ext/Extensions.kt answers, minus the WebViews
// ---------------------------------------------------------------------------

interface Sent {
  ep: string
  message: Record<string, unknown>
}

class FakeKotlin implements RuntimeBridge {
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

interface Harness {
  kt: FakeKotlin
  runtime: AndroidExtensionRuntime
  files: Map<string, string>
  tabs: Record<string, Tab>
  active: { id: string | null }
  clock: { now: number }
  timers: Array<{ fn: () => void; ms: number; at: number; cleared: boolean }>
  /** Run every timer due at or before `clock.now`. */
  tick: (ms: number) => void
  notifyState: () => void
  toasts: string[]
  /** Write the debounced JSON documents out now and parse one of them. */
  saved: (name: string) => Record<string, unknown>
}

function makeTab(id: string, url: string, containerId = 'default'): Tab {
  return {
    id,
    url,
    title: url,
    loading: false,
    containerId
  } as unknown as Tab
}

function harness(
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
  const listeners: Array<() => void> = []
  const toasts: string[] = []
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
    tabs: {
      tab: (id: string) => tabs[id],
      activeTabFor: () => (active.id ? tabs[active.id] : undefined),
      model: { tabs, spaces: [] },
      isPrivate: (tab: Tab) => tab.containerId === 'private',
      createTab: (opts: { url: string }) => {
        const id = `t${Object.keys(tabs).length + 1}`
        tabs[id] = makeTab(id, opts.url)
        return tabs[id]
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
    clock,
    timers,
    tick,
    notifyState: () => listeners.forEach((fn) => fn()),
    toasts,
    saved: (name) => {
      runtime.flushSync()
      return JSON.parse(files.get(name) ?? '{}') as Record<string, unknown>
    }
  }
}

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const ID2 = 'ponmlkjihgfedcbaponmlkjihgfedcba'
const PATH = `/data/user/0/app.zen.chromium/files/zen/extensions/${ID}/1.0.0`

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function record(
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
function hello(
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

function message(h: Harness, ep: string, message: Record<string, unknown>): void {
  h.runtime.onMessage({ ep, tabId: null, top: true, origin: '', message })
}

/** Let the runtime's pending promises run until `ready` holds (a bounded number of ticks). */
async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (ready()) return
    await Promise.resolve()
  }
  throw new Error('the runtime did not get there')
}

let callSeq = 0

/** A `chrome.<ns>.<method>(...args)` call from an endpoint; resolves with the reply. */
async function call(
  h: Harness,
  ep: string,
  ns: string,
  method: string,
  args: unknown[]
): Promise<Record<string, unknown>> {
  const id = ++callSeq
  message(h, ep, { t: 'call', id, ns, method, args })
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
    const reply = h.kt.to(ep).find((m) => m.t === 'reply' && m.id === id)
    if (reply) return reply
  }
  throw new Error(`no reply to ${ns}.${method}`)
}

function events(h: Harness, ep: string, key: string): Record<string, unknown>[] {
  const [ns, name] = key.split('.')
  return h.kt.to(ep).filter((m) => m.t === 'event' && m.ns === ns && m.name === name)
}

/** The background comes up: hello, listeners, ready. */
function backgroundUp(h: Harness, ep: string, listeners: string[] = []): void {
  hello(h, ep, 'background')
  for (const event of listeners) message(h, ep, { t: 'listen', event, on: true })
  message(h, ep, { t: 'ready' })
}

// ---------------------------------------------------------------------------

describe('AndroidExtensionRuntime: attaching records', () => {
  it('opens the manifest through Kotlin, plans one unit per world and starts the background', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    expect(h.kt.calledWith('ext.open')).toEqual([{ id: ID, path: PATH }])
    const configure = h.kt.calledWith('ext.configure')
    expect(configure).toHaveLength(1)
    expect(configure[0].id).toBe(ID)
    expect(configure[0].version).toBe('1.0.0')
    expect(configure[0].path).toBe(PATH)
    const units = configure[0].units as Array<Record<string, unknown>>
    expect(units.map((u) => [u.key, u.world, u.origins])).toEqual([
      ['isolated:https://example.com', `zenium-ext-${ID}`, ['https://example.com']]
    ])
    const config = JSON.parse(String(units[0].config)) as Record<string, unknown>
    expect((config.extension as Record<string, unknown>).isolation).toBe('world')
    const served = configure[0].served as Record<string, unknown>
    // The worker's page stands at the script's URL, where Chrome's `self.location` points.
    expect(served.backgroundUrl).toBe(`https://${ID}.ext.zenium.invalid/bg.js`)
    expect(String(served.backgroundHtml)).toContain('<script src="/bg.js"></script>')
    const late = JSON.parse(String(served.late)) as Record<string, unknown>
    expect(late.late).toBe(true)
    expect((late.extension as Record<string, unknown>).groups).toEqual([])
    expect(h.kt.calledWith('ext.background.start')).toEqual([{ id: ID }])
    expect(h.runtime.configureStats(ID)?.units[0].key).toBe('isolated:https://example.com')
  })

  it('falls back to the with-proxy in the main world on a WebView without isolated worlds', async () => {
    const h = harness({ isolatedWorlds: false })
    await h.runtime.attach(record(h))
    const units = h.kt.calledWith('ext.configure')[0].units as Array<Record<string, unknown>>
    expect(units[0].world).toBeNull()
    const config = JSON.parse(String(units[0].config)) as Record<string, unknown>
    expect((config.extension as Record<string, unknown>).isolation).toBe('with')
    expect(h.runtime.isolatedWorlds).toBe(false)
  })

  it('plans an extension beyond the tab world budget under the with-proxy, later ones too', async () => {
    // Two slots: the first extension takes both (content + USER_SCRIPT world), the second
    // would need one more and runs in the main world instead; a reconfigure of the first that
    // gives a world back does not disturb the second's plan.
    const h = harness({ worldSlots: 2 })
    const first = record(h, {}, manifest({ permissions: ['storage', 'userScripts', 'scripting'] }))
    await h.runtime.attach(first)
    await h.runtime.setRegistered(ID, [
      {
        id: 'us1',
        matches: ['https://example.com/*'],
        excludeMatches: [],
        includeGlobs: [],
        excludeGlobs: [],
        js: ['user.js'],
        css: [],
        runAt: 'document_idle',
        allFrames: false,
        matchAboutBlank: false,
        world: 'USER_SCRIPT',
        persistAcrossSessions: true,
        matchOriginAsFallback: false
      }
    ])
    const plansOfFirst = h.kt.calledWith('ext.configure')
    expect(plansOfFirst).toHaveLength(2)
    const worlds = (plansOfFirst[1].units as Array<Record<string, unknown>>).map((u) => u.world)
    expect(new Set(worlds).size).toBe(2)
    expect(worlds).toContain(`zenium-ext-${ID}-user`)
    const path2 = `/data/user/0/app.zen.chromium/files/zen/extensions/${ID2}/2.0.0`
    const second = record(h, { id: ID2, path: path2 }, manifest({ version: '2.0.0' }))
    await h.runtime.attach(second)
    const plan = h.kt.calledWith('ext.configure').find((c) => c.id === ID2)
    expect(plan).toBeDefined()
    const units = plan?.units as Array<Record<string, unknown>>
    expect(units).toHaveLength(1)
    expect(units[0].world).toBeNull()
    const config = JSON.parse(String(units[0].config)) as Record<string, unknown>
    expect((config.extension as Record<string, unknown>).isolation).toBe('with')
    expect(h.runtime.isolatedWorlds).toBe(true)
    // Detaching the first frees its worlds: the second is re-planned into a world when its
    // plan is next computed.
    await h.runtime.detach(ID)
    await h.runtime.setRegistered(ID2, [])
    await h.runtime.reconfigure({ ...second, pinned: true })
    const replanned = h.kt.calledWith('ext.configure').filter((c) => c.id === ID2)
    expect(replanned).toHaveLength(2)
    expect((replanned[1].units as Array<Record<string, unknown>>)[0].world).toBe(
      `zenium-ext-${ID2}`
    )
  })

  it('coalesces rule pushes: one ext.setRules in flight, one more for everything that arrived meanwhile', async () => {
    const h = harness()
    const dnr = manifest({
      permissions: ['declarativeNetRequest'],
      declarative_net_request: {
        rule_resources: [{ id: 'r1', enabled: true, path: 'rules.json' }]
      }
    })
    h.kt.holdRules = true
    const attaching = h.runtime.attach(record(h, {}, dnr))
    await until(() => h.kt.heldRules.length === 1)
    expect(h.kt.calledWith('ext.setRules')).toHaveLength(1)
    // Three rule changes while the push is out: they wait for one push after it.
    const changes = [
      h.runtime.setRules(ID, { dynamic: [], session: [], enabledRulesets: ['r1'] }),
      h.runtime.setRules(ID, { dynamic: [], session: [], enabledRulesets: [] }),
      h.runtime.setRules(ID, { dynamic: [], session: [], enabledRulesets: ['r1'] })
    ]
    expect(h.kt.calledWith('ext.setRules')).toHaveLength(1)
    h.kt.releaseRules()
    await until(() => h.kt.heldRules.length === 1)
    expect(h.kt.calledWith('ext.setRules')).toHaveLength(2)
    // The second push carries the state as it is now, not as it was when a change asked.
    expect(h.kt.calledWith('ext.setRules')[1].extensions).toEqual([
      { ext: ID, allowPrivate: false, paths: ['rules.json'], dynamic: [] }
    ])
    h.kt.releaseRules()
    await Promise.all([attaching, ...changes])
    expect(h.kt.calledWith('ext.setRules')).toHaveLength(2)
    // The line is clear: the next change pushes at once.
    h.kt.holdRules = false
    await h.runtime.setRules(ID, { dynamic: [], session: [], enabledRulesets: [] })
    expect(h.kt.calledWith('ext.setRules')).toHaveLength(3)
    expect(h.kt.calledWith('ext.setRules')[2].extensions).toEqual([
      { ext: ID, allowPrivate: false, paths: [], dynamic: [] }
    ])
  })

  it('a record toggle alone re-sends the configuration; the private toggle re-pushes a rule set', async () => {
    const h = harness()
    const dnr = manifest({
      permissions: ['declarativeNetRequest'],
      declarative_net_request: {
        rule_resources: [{ id: 'r1', enabled: true, path: 'rules.json' }]
      }
    })
    const rec = record(h, {}, dnr)
    await h.runtime.attach(rec)
    expect(h.kt.calledWith('ext.configure')).toHaveLength(1)
    expect(h.kt.calledWith('ext.configure')[0]).toMatchObject({
      allowFileAccess: false,
      allowPrivate: false
    })
    expect(h.kt.calledWith('ext.setRules')).toHaveLength(1)
    // The same record again: nothing changed, nothing sent.
    await h.runtime.reconfigure({ ...rec })
    expect(h.kt.calledWith('ext.configure')).toHaveLength(1)
    // File access: the plan is the same, the toggle travels.
    await h.runtime.reconfigure({ ...rec, allowFileAccess: true })
    expect(h.kt.calledWith('ext.configure')).toHaveLength(2)
    expect(h.kt.calledWith('ext.configure')[1]).toMatchObject({ allowFileAccess: true })
    expect(h.kt.calledWith('ext.setRules')).toHaveLength(1)
    // Private tabs: the toggle travels and the rules are pushed again with it.
    await h.runtime.reconfigure({ ...rec, allowFileAccess: true, allowPrivate: true })
    expect(h.kt.calledWith('ext.configure')).toHaveLength(3)
    expect(h.kt.calledWith('ext.configure')[2]).toMatchObject({ allowPrivate: true })
    expect(h.kt.calledWith('ext.setRules')).toHaveLength(2)
    expect(h.kt.calledWith('ext.setRules')[1].extensions).toEqual([
      { ext: ID, allowPrivate: true, paths: ['rules.json'], dynamic: [] }
    ])
  })

  it('does not send a plan that changed nothing, and re-plans when registered scripts change', async () => {
    const h = harness()
    const rec = record(h)
    await h.runtime.attach(rec)
    await h.runtime.reconfigure({ ...rec, pinned: true })
    expect(h.kt.calledWith('ext.configure')).toHaveLength(1)
    await h.runtime.setRegistered(ID, [
      {
        id: 'extra',
        matches: ['https://other.example/*'],
        excludeMatches: [],
        includeGlobs: [],
        excludeGlobs: [],
        js: ['extra.js'],
        css: [],
        runAt: 'document_idle',
        allFrames: false,
        matchAboutBlank: false,
        world: 'ISOLATED',
        persistAcrossSessions: true,
        matchOriginAsFallback: false
      }
    ])
    const plans = h.kt.calledWith('ext.configure')
    expect(plans).toHaveLength(2)
    const units = plans[1].units as Array<Record<string, unknown>>
    expect(units.map((u) => u.key)).toEqual([
      'isolated:https://example.com',
      'isolated:https://other.example'
    ])
    const saved = h.saved('extensions-runtime.json')
    expect((saved.registered as Record<string, unknown[]>)[ID]).toHaveLength(1)
  })

  it('fires runtime.onInstalled once per version when the background is ready, then onStartup', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1', ['runtime.onInstalled', 'runtime.onStartup'])
    expect(events(h, 'bg1', 'runtime.onInstalled').map((e) => e.args)).toEqual([
      [{ reason: 'install' }]
    ])
    expect(events(h, 'bg1', 'runtime.onStartup')).toHaveLength(1)
    // The same version again (a browser restart): no install event.
    await h.runtime.detach(ID)
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg2', ['runtime.onInstalled'])
    expect(events(h, 'bg2', 'runtime.onInstalled')).toHaveLength(0)
    // A new version: update with the previous one named.
    await h.runtime.detach(ID)
    const newer = manifest({ version: '1.1.0' })
    await h.runtime.attach(
      record(h, { path: `${PATH.slice(0, -5)}1.1.0`, version: '1.1.0' }, newer)
    )
    backgroundUp(h, 'bg3', ['runtime.onInstalled'])
    expect(events(h, 'bg3', 'runtime.onInstalled').map((e) => e.args)).toEqual([
      [{ reason: 'update', previousVersion: '1.0.0' }]
    ])
  })

  it('detach drops the endpoints and tells Kotlin; forget takes the persisted state and storage along', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1')
    hello(h, 'doc1.n.abcdefgh', 'content')
    expect(h.runtime.router.of(ID)).toHaveLength(2)
    await call(h, 'bg1', 'storage', 'set', ['local', { a: 1 }])
    expect(h.saved(`ext-storage-${ID}.json`).local).toEqual({ a: 1 })
    await h.runtime.forget(ID)
    expect(h.runtime.router.of(ID)).toHaveLength(0)
    expect(h.kt.calledWith('ext.detach')).toEqual([{ id: ID }])
    expect(h.kt.backgrounds.has(ID)).toBe(false)
    const saved = h.saved('extensions-runtime.json')
    expect(saved.installed).toEqual({})
    // No debounced write of the dropped storage document resurrects it.
    expect(h.files.has(`ext-storage-${ID}.json`)).toBe(false)
  })
})

describe('AndroidExtensionRuntime: the background lifecycle', () => {
  it('idles the worker out after the quiet time and wakes it for an event it listened for', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1', ['tabs.onCreated'])
    expect(h.kt.backgrounds.has(ID)).toBe(true)
    h.tick(30_000)
    expect(h.kt.calledWith('ext.background.stop')).toEqual([{ id: ID }])
    h.runtime.onGone(['bg1'])
    expect(h.runtime.background.state(ID)).toBe('stopped')
    // A tab appears: the persisted listener wakes the worker and the event waits for ready.
    h.tabs.t2 = makeTab('t2', 'https://two.example/')
    h.notifyState()
    expect(h.kt.calledWith('ext.background.start')).toHaveLength(2)
    expect(h.runtime.background.state(ID)).toBe('starting')
    backgroundUp(h, 'bg2', ['tabs.onCreated'])
    const created = events(h, 'bg2', 'tabs.onCreated')
    expect(created).toHaveLength(1)
    expect((created[0].args as Array<Record<string, unknown>>)[0].url).toBe('https://two.example/')
    expect(h.runtime.backgroundStats(ID)).toMatchObject({ starts: 2, idleStops: 1, queued: 1 })
  })

  it('remembers listeners across sessions so the first event of the next start wakes the worker', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1', ['tabs.onRemoved'])
    const saved = h.saved('extensions-runtime.json')
    expect((saved.listeners as Record<string, string[]>)[ID]).toEqual(['tabs.onRemoved'])
    // Next session, same files: the worker has not run yet, the tab closes anyway.
    const next = harness({ files: h.files })
    await next.runtime.attach(record(next))
    // Chrome starts the background after a browser start; let it idle out first.
    backgroundUp(next, 'bgA')
    next.tick(30_000)
    next.runtime.onGone(['bgA'])
    delete next.tabs.t1
    next.notifyState()
    expect(next.runtime.background.state(ID)).toBe('starting')
    backgroundUp(next, 'bgB', ['tabs.onRemoved'])
    expect(events(next, 'bgB', 'tabs.onRemoved')).toHaveLength(1)
  })

  it('drops an event a stopped worker never listened for instead of waking it', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1')
    h.tick(30_000)
    h.runtime.onGone(['bg1'])
    h.tabs.t2 = makeTab('t2', 'https://two.example/')
    h.notifyState()
    expect(h.kt.calledWith('ext.background.start')).toHaveLength(1)
    expect(h.runtime.backgroundStats(ID)).toMatchObject({ dropped: 1 })
  })

  it('a page posting to navigator.serviceWorker wakes the stopped worker; its ports are relayed both ways and closed with it', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1')
    h.tick(30_000)
    h.runtime.onGone(['bg1'])
    hello(h, 'pop1', 'popup', { url: `https://${ID}.ext.zenium.invalid/popup.html` })
    // A port handed to the worker with the first postMessage (Stylus's shape).
    message(h, 'pop1', { t: 'sw', op: 'post', data: { lock: '/bg.js' }, ports: ['pop1:1'] })
    expect(h.runtime.background.state(ID)).toBe('starting')
    backgroundUp(h, 'bg2')
    const arrived = h.kt.to('bg2').filter((m) => m.t === 'sw')
    expect(arrived).toEqual([
      {
        t: 'sw',
        op: 'message',
        from: 'pop1',
        url: `https://${ID}.ext.zenium.invalid/popup.html`,
        context: 'popup',
        focused: true,
        visible: true,
        data: { lock: '/bg.js' },
        ports: ['pop1:1'],
        ep: 'bg2'
      }
    ])
    // Traffic on the port follows it to the popup, and the popup's to the worker.
    message(h, 'bg2', { t: 'sw', op: 'port', port: 'pop1:1', data: { id: 1, res: 42 }, ports: [] })
    expect(h.kt.to('pop1').filter((m) => m.t === 'sw')).toEqual([
      { t: 'sw', op: 'port', port: 'pop1:1', data: { id: 1, res: 42 }, ports: [], ep: 'pop1' }
    ])
    message(h, 'pop1', { t: 'sw', op: 'port', port: 'pop1:1', data: { id: 2, args: [1] } })
    expect(h.kt.to('bg2').filter((m) => m.t === 'sw')).toHaveLength(2)
    // The worker lists its pages and posts to one, handing it a port of its own.
    message(h, 'bg2', { t: 'sw', op: 'clients', id: 9 })
    const listed = h.kt.to('bg2').find((m) => m.t === 'sw' && m.op === 'clients')
    expect(listed?.clients).toEqual([
      {
        id: 'pop1',
        url: `https://${ID}.ext.zenium.invalid/popup.html`,
        context: 'popup',
        focused: true,
        visible: true
      }
    ])
    message(h, 'bg2', { t: 'sw', op: 'post', to: 'pop1', data: { hi: 1 }, ports: ['bg2:1'] })
    expect(h.kt.to('pop1').filter((m) => m.t === 'sw' && m.op === 'message')).toEqual([
      { t: 'sw', op: 'message', data: { hi: 1 }, ports: ['bg2:1'], ep: 'pop1' }
    ])
    // A content script is no client and cannot post to the worker's pages.
    hello(h, 'doc1.n.abcdefgh', 'content')
    message(h, 'bg2', { t: 'sw', op: 'post', to: 'doc1.n.abcdefgh', data: 1, ports: [] })
    expect(h.kt.to('doc1.n.abcdefgh').filter((m) => m.t === 'sw')).toHaveLength(0)
    // The worker idles out: the popup hears that both ports are gone, and a message on one of
    // them does not start the worker again (its end died with it).
    h.tick(30_000)
    h.runtime.onGone(['bg2'])
    const closed = h.kt
      .to('pop1')
      .filter((m) => m.t === 'sw' && m.op === 'close')
      .map((m) => m.port)
    expect(closed.sort()).toEqual(['bg2:1', 'pop1:1'])
    message(h, 'pop1', { t: 'sw', op: 'port', port: 'pop1:1', data: 3 })
    expect(h.runtime.background.state(ID)).toBe('stopped')
  })

  it('a runtime.sendMessage from a content script wakes the stopped worker and is answered once it runs', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1')
    h.tick(30_000)
    h.runtime.onGone(['bg1'])
    hello(h, 'doc1.n.abcdefgh', 'content')
    message(h, 'doc1.n.abcdefgh', { t: 'msg', id: 7, target: {}, data: { type: 'ping' } })
    expect(h.runtime.background.state(ID)).toBe('starting')
    expect(h.kt.to('doc1.n.abcdefgh').filter((m) => m.t === 'reply')).toHaveLength(0)
    backgroundUp(h, 'bg2')
    const delivered = h.kt.to('bg2').filter((m) => m.t === 'deliver')
    expect(delivered).toHaveLength(1)
    expect(delivered[0].data).toEqual({ type: 'ping' })
    expect((delivered[0].sender as Record<string, unknown>).tab).toMatchObject({
      url: 'https://example.com/'
    })
    message(h, 'bg2', {
      t: 'msgReply',
      id: delivered[0].id,
      handled: true,
      response: { pong: true }
    })
    const reply = h.kt.to('doc1.n.abcdefgh').find((m) => m.t === 'reply')
    expect(reply).toMatchObject({ id: 7, ok: true, result: { pong: true } })
  })

  it('a gone from a page the runtime already replaced does not restart the new one', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1', ['tabs.onCreated'])
    h.tick(30_000)
    // Stopped, then woken before Kotlin reported the old page gone.
    h.tabs.t2 = makeTab('t2', 'https://two.example/')
    h.notifyState()
    expect(h.runtime.background.state(ID)).toBe('starting')
    hello(h, 'bg2', 'background')
    h.runtime.onGone(['bg1'])
    expect(h.runtime.background.state(ID)).toBe('starting')
    expect(h.kt.calledWith('ext.background.start')).toHaveLength(2)
  })

  it('an MV2 persistent page never idles out', async () => {
    const h = harness()
    const mv2 = manifest({
      manifest_version: 2,
      permissions: ['storage', 'https://example.com/*'],
      host_permissions: undefined,
      background: { scripts: ['bg.js'], persistent: true },
      action: undefined,
      browser_action: { default_popup: 'popup.html' }
    })
    await h.runtime.attach(record(h, {}, mv2))
    backgroundUp(h, 'bg1')
    h.tick(120_000)
    expect(h.kt.calledWith('ext.background.stop')).toHaveLength(0)
    expect(h.runtime.background.kind(ID)).toBe('persistent')
  })
})

describe('AndroidExtensionRuntime: chrome.storage on the shared helpers', () => {
  it('round-trips local items, persists them per extension and raises onChanged elsewhere', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1', ['storage.onChanged'])
    hello(h, 'doc1.n.abcdefgh', 'content')
    const set = await call(h, 'doc1.n.abcdefgh', 'storage', 'set', ['local', { a: 1, b: 'two' }])
    expect(set.ok).toBe(true)
    const get = await call(h, 'doc1.n.abcdefgh', 'storage', 'get', ['local', ['a', 'missing']])
    expect(get.result).toEqual({ a: 1 })
    const changed = events(h, 'bg1', 'storage.onChanged')
    expect(changed).toHaveLength(1)
    expect(changed[0].args).toEqual([{ a: { newValue: 1 }, b: { newValue: 'two' } }, 'local'])
    const doc = h.saved(`ext-storage-${ID}.json`)
    expect(doc.local).toEqual({ a: 1, b: 'two' })
    const bytes = await call(h, 'doc1.n.abcdefgh', 'storage', 'getBytesInUse', ['local', null])
    expect(bytes.result).toBe(Buffer.byteLength('a1b"two"'))
  })

  it('enforces the sync quota and keeps the session area from content scripts until allowed', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1')
    hello(h, 'doc1.n.abcdefgh', 'content')
    message(h, 'doc1.n.abcdefgh', { t: 'listen', event: 'storage.onChanged', on: true })
    const big = await call(h, 'bg1', 'storage', 'set', ['sync', { k: 'x'.repeat(9000) }])
    expect(big.ok).toBe(false)
    expect(String(big.error)).toContain('QUOTA_BYTES_PER_ITEM')
    const denied = await call(h, 'doc1.n.abcdefgh', 'storage', 'get', ['session', null])
    expect(denied.ok).toBe(false)
    // A session change is not announced to the content script while the area is closed to it.
    await call(h, 'bg1', 'storage', 'set', ['session', { early: true }])
    expect(events(h, 'doc1.n.abcdefgh', 'storage.onChanged')).toHaveLength(0)
    const level = await call(h, 'bg1', 'storage', 'setAccessLevel', [
      'session',
      { accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }
    ])
    expect(level.ok).toBe(true)
    await call(h, 'bg1', 'storage', 'set', ['session', { s: 1 }])
    const allowed = await call(h, 'doc1.n.abcdefgh', 'storage', 'get', ['session', null])
    expect(allowed.result).toEqual({ early: true, s: 1 })
    const heard = events(h, 'doc1.n.abcdefgh', 'storage.onChanged')
    expect(heard).toHaveLength(1)
    expect(heard[0].args).toEqual([{ s: { newValue: 1 } }, 'session'])
    // Session items never touch the disk.
    h.runtime.flushSync()
    expect(h.files.has(`ext-storage-${ID}.json`)).toBe(false)
  })

  it('chrome.extension reads the file-access and private toggles from the record', async () => {
    const h = harness()
    const rec = record(h, { allowFileAccess: true })
    await h.runtime.attach(rec)
    backgroundUp(h, 'bg1')
    const files = await call(h, 'bg1', 'extension', 'isAllowedFileSchemeAccess', [])
    expect(files.result).toBe(true)
    const incognito = await call(h, 'bg1', 'extension', 'isAllowedIncognitoAccess', [])
    expect(incognito.result).toBe(false)
    await h.runtime.reconfigure({ ...rec, allowPrivate: true })
    const allowed = await call(h, 'bg1', 'extension', 'isAllowedIncognitoAccess', [])
    expect(allowed.result).toBe(true)
  })

  it('managed is read-only and empty', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1')
    const get = await call(h, 'bg1', 'storage', 'get', ['managed', null])
    expect(get.result).toEqual({})
    const set = await call(h, 'bg1', 'storage', 'set', ['managed', { a: 1 }])
    expect(set.ok).toBe(false)
  })
})

describe('AndroidExtensionRuntime: chrome.alarms on the shared scheduler', () => {
  it('schedules, fires onAlarm through the wake policy, repeats periodic alarms and persists them', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1', ['alarms.onAlarm'])
    const created = await call(h, 'bg1', 'alarms', 'create', [
      'tick',
      { delayInMinutes: 1, periodInMinutes: 2 }
    ])
    expect(created.ok).toBe(true)
    const all = await call(h, 'bg1', 'alarms', 'getAll', [])
    expect((all.result as Array<Record<string, unknown>>).map((a) => a.name)).toEqual(['tick'])
    const saved = h.saved('extensions-runtime.json')
    expect((saved.alarms as Record<string, unknown[]>)[ID]).toHaveLength(1)
    // Let the worker idle out; the alarm must wake it.
    h.tick(30_000)
    h.runtime.onGone(['bg1'])
    h.tick(30_000)
    expect(h.runtime.background.state(ID)).toBe('starting')
    backgroundUp(h, 'bg2', ['alarms.onAlarm'])
    const fired = events(h, 'bg2', 'alarms.onAlarm')
    expect(fired).toHaveLength(1)
    expect((fired[0].args as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: 'tick',
      periodInMinutes: 2
    })
    const next = await call(h, 'bg2', 'alarms', 'get', ['tick'])
    expect((next.result as Record<string, unknown>).scheduledTime).toBe(h.clock.now + 2 * 60_000)
    const cleared = await call(h, 'bg2', 'alarms', 'clear', ['tick'])
    expect(cleared.result).toBe(true)
    expect(h.timers.filter((t) => !t.cleared && t.at > h.clock.now)).toHaveLength(1)
  })
})

describe('AndroidExtensionRuntime: tab and navigation events', () => {
  it('turns view events into webNavigation and tabs.onUpdated for listening pages', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1', ['webNavigation.onCommitted', 'tabs.onUpdated', 'tabs.onActivated'])
    h.tabs.t1.loading = true
    h.runtime.onViewEvent('t1', 'navigated', {
      url: 'https://example.com/next',
      title: '',
      inPage: false,
      canGoBack: true,
      canGoForward: false
    })
    const committed = events(h, 'bg1', 'webNavigation.onCommitted')
    expect(committed).toHaveLength(1)
    expect((committed[0].args as Array<Record<string, unknown>>)[0]).toMatchObject({
      url: 'https://example.com/next',
      frameId: 0,
      transitionType: 'link'
    })
    const updated = events(h, 'bg1', 'tabs.onUpdated')
    expect(updated).toHaveLength(1)
    expect((updated[0].args as unknown[])[1]).toEqual({
      status: 'loading',
      url: 'https://example.com/next'
    })
    h.tabs.t2 = makeTab('t2', 'https://two.example/')
    h.active.id = 't2'
    h.notifyState()
    const activated = events(h, 'bg1', 'tabs.onActivated')
    expect(activated).toHaveLength(1)
    expect((activated[0].args as Array<Record<string, unknown>>)[0]).toEqual({
      tabId: h.runtime.api.tabs.chromeIdFor('t2'),
      windowId: 1
    })
  })

  it('keeps private tabs from an extension not allowed in them: no events, unknown to tabs.*', async () => {
    const h = harness()
    const rec = record(h)
    await h.runtime.attach(rec)
    backgroundUp(h, 'bg1', [
      'tabs.onCreated',
      'tabs.onUpdated',
      'tabs.onActivated',
      'tabs.onRemoved',
      'webNavigation.onCommitted',
      'webRequest.onBeforeRequest'
    ])
    h.tabs.p1 = makeTab('p1', 'https://secret.example/', 'private')
    h.active.id = 'p1'
    h.notifyState()
    expect(events(h, 'bg1', 'tabs.onCreated')).toHaveLength(0)
    expect(events(h, 'bg1', 'tabs.onActivated')).toHaveLength(0)
    h.runtime.onViewEvent('p1', 'navigated', {
      url: 'https://secret.example/page',
      title: '',
      inPage: false,
      canGoBack: true,
      canGoForward: false
    })
    expect(events(h, 'bg1', 'webNavigation.onCommitted')).toHaveLength(0)
    expect(events(h, 'bg1', 'tabs.onUpdated')).toHaveLength(0)
    h.runtime.onRequest({
      tabId: 'p1',
      url: 'https://secret.example/asset.js',
      type: 'script',
      method: 'GET',
      initiator: 'https://secret.example',
      decision: 'allow',
      micros: 1
    })
    expect(events(h, 'bg1', 'webRequest.onBeforeRequest')).toHaveLength(0)
    // The tabs API: the query does not list it, get does not know it, the window has one tab.
    const privateId = h.runtime.api.tabs.chromeIdFor('p1')
    const query = await call(h, 'bg1', 'tabs', 'query', [{}])
    expect((query.result as Array<Record<string, unknown>>).map((t) => t.id)).toEqual([
      h.runtime.api.tabs.chromeIdFor('t1')
    ])
    const active = await call(h, 'bg1', 'tabs', 'query', [{ active: true }])
    expect(active.result).toEqual([])
    const get = await call(h, 'bg1', 'tabs', 'get', [privateId])
    expect(String(get.error)).toContain(`No tab with id: ${privateId}`)
    const win = await call(h, 'bg1', 'windows', 'getCurrent', [])
    expect((win.result as { tabs: unknown[] }).tabs).toHaveLength(1)
    const inject = await call(h, 'bg1', 'scripting', 'executeScript', [
      { target: { tabId: privateId }, funcSource: '() => 1' }
    ])
    expect(String(inject.error)).toContain('No tab with id')
    expect(h.kt.calledWith('ext.exec')).toHaveLength(0)
    // Closed while unseen: no onRemoved either, though the tab is gone from the model by then.
    delete h.tabs.p1
    h.active.id = 't1'
    h.notifyState()
    expect(events(h, 'bg1', 'tabs.onRemoved')).toHaveLength(0)
    expect(events(h, 'bg1', 'tabs.onActivated')).toHaveLength(1)
    // Allowed in private tabs: the same extension sees the next one.
    await h.runtime.reconfigure({ ...rec, allowPrivate: true })
    h.tabs.p2 = makeTab('p2', 'https://secret.example/two', 'private')
    h.notifyState()
    expect(events(h, 'bg1', 'tabs.onCreated')).toHaveLength(1)
    const seen = await call(h, 'bg1', 'tabs', 'get', [h.runtime.api.tabs.chromeIdFor('p2')])
    expect(seen.result).toMatchObject({ incognito: true, url: 'https://secret.example/two' })
    delete h.tabs.p2
    h.notifyState()
    expect(events(h, 'bg1', 'tabs.onRemoved')).toHaveLength(1)
  })

  it('a navigation event landing after the new document said hello leaves its endpoints answering; Kotlin says which are gone', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    // The commit callback is posted from Kotlin and often lands after the new document's
    // bootstrap has said hello: the endpoint that hello registered must survive it.
    hello(h, 'doc2.n.abcdefgh', 'content', { url: 'https://example.com/other' })
    expect(h.runtime.router.of(ID, 'content')).toHaveLength(1)
    h.runtime.onViewEvent('t1', 'navigated', {
      url: 'https://example.com/other',
      title: '',
      inPage: false,
      canGoBack: true,
      canGoForward: false
    })
    expect(h.runtime.router.of(ID, 'content')).toHaveLength(1)
    const set = await call(h, 'doc2.n.abcdefgh', 'storage', 'set', ['local', { k: 1 }])
    expect(set.ok).toBe(true)
    // The previous document's endpoint goes when Kotlin reports it (ext.gone), not before.
    h.runtime.onGone(['doc2.n.abcdefgh'])
    expect(h.runtime.router.of(ID, 'content')).toHaveLength(0)
  })
})

describe('AndroidExtensionRuntime: scripting into frames', () => {
  it('names a subframe to the host by its document id, and all frames on allFrames', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1')
    hello(h, 'docA.1', 'content')
    hello(h, 'docB.1', 'content', { top: false, url: 'https://frame.example/inner' })
    const tabId = h.runtime.api.tabs.chromeIdFor('t1')
    const frames = await call(h, 'bg1', 'webNavigation', 'getAllFrames', [{ tabId }])
    expect((frames.result as Array<{ frameId: number }>).map((f) => f.frameId)).toEqual([0, 1])
    // The main frame alone by default: no document named.
    const top = await call(h, 'bg1', 'scripting', 'executeScript', [
      { target: { tabId }, funcSource: '() => 1' }
    ])
    expect(top.result).toEqual([{ frameId: 0, documentId: '', result: { ran: true } }])
    expect(h.kt.calledWith('ext.exec').map((a) => a.doc)).toEqual([null])
    // One subframe: its document; the result carries its frame id.
    h.kt.files.set(`${ID}/api.js`, 'self.api = 1')
    const inner = await call(h, 'bg1', 'scripting', 'executeScript', [
      { target: { tabId, frameIds: [1] }, files: ['api.js'] }
    ])
    expect(inner.error).toBeUndefined()
    expect(inner.result).toEqual([{ frameId: 1, documentId: '', result: { ran: true } }])
    expect(h.kt.calledWith('ext.exec').at(-1)).toMatchObject({ doc: 'docB', ext: ID, tabId: 't1' })
    // Every frame the extension has a script in.
    const all = await call(h, 'bg1', 'scripting', 'insertCSS', [
      { target: { tabId, allFrames: true }, css: 'body{margin:0}' }
    ])
    expect(all.error).toBeUndefined()
    expect(
      h.kt
        .calledWith('ext.exec')
        .slice(-2)
        .map((a) => [a.kind, a.doc])
    ).toEqual([
      ['css', null],
      ['css', 'docB']
    ])
    // A frame the tab does not have: Chrome's error, nothing sent to the host.
    const before = h.kt.calledWith('ext.exec').length
    const missing = await call(h, 'bg1', 'scripting', 'executeScript', [
      { target: { tabId, frameIds: [7] }, funcSource: '() => 1' }
    ])
    expect(String(missing.error)).toBe(`No frame with id 7 in tab ${tabId}.`)
    expect(h.kt.calledWith('ext.exec')).toHaveLength(before)
    // A subframe the host cannot reach is left out under allFrames, and fails a named target.
    h.kt.failExec = (args) =>
      args.doc === 'docB' ? 'This WebView cannot run a script in a subframe' : null
    const swept = await call(h, 'bg1', 'scripting', 'executeScript', [
      { target: { tabId, allFrames: true }, funcSource: '() => 1' }
    ])
    expect(swept.error).toBeUndefined()
    expect(swept.result).toEqual([{ frameId: 0, documentId: '', result: { ran: true } }])
    const named = await call(h, 'bg1', 'scripting', 'executeScript', [
      { target: { tabId, frameIds: [1] }, funcSource: '() => 1' }
    ])
    expect(String(named.error)).toContain('cannot run a script in a subframe')
    h.kt.failExec = null
    // The frame's document went away with a navigation: the id no longer resolves.
    h.runtime.onGone(['docB.1'])
    const gone = await call(h, 'bg1', 'scripting', 'executeScript', [
      { target: { tabId, frameIds: [1] }, funcSource: '() => 1' }
    ])
    expect(String(gone.error)).toContain('No frame with id 1')
  })
})

describe('AndroidExtensionRuntime: popups and options', () => {
  it('opens the manifest popup as a sheet, or raises action.onClicked when there is none', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    backgroundUp(h, 'bg1', ['action.onClicked'])
    h.runtime.openPopup(ID)
    expect(h.kt.calledWith('ext.popup.open')).toEqual([
      { id: ID, url: `https://${ID}.ext.zenium.invalid/popup.html`, context: 'popup' }
    ])
    h.runtime.closePopup()
    expect(h.kt.calledWith('ext.popup.close')).toHaveLength(1)
    await call(h, 'bg1', 'action', 'setPopup', [{ popup: '' }])
    h.runtime.openPopup(ID)
    expect(h.kt.calledWith('ext.popup.open')).toHaveLength(1)
    const clicked = events(h, 'bg1', 'action.onClicked')
    expect(clicked).toHaveLength(1)
    expect((clicked[0].args as Array<Record<string, unknown>>)[0]).toMatchObject({
      url: 'https://example.com/'
    })
    expect(h.runtime.popupFor(ID)).toBeNull()
  })

  it('options pages open as a sheet, or as a tab when the manifest asks for one', async () => {
    const h = harness()
    await h.runtime.attach(record(h, {}, manifest({ options_ui: { page: 'options.html' } })))
    h.runtime.openOptions(ID)
    expect(h.kt.calledWith('ext.popup.open')).toEqual([
      { id: ID, url: `https://${ID}.ext.zenium.invalid/options.html`, context: 'options' }
    ])
    const inTab = harness()
    await inTab.runtime.attach(
      record(inTab, {}, manifest({ options_ui: { page: 'options.html', open_in_tab: true } }))
    )
    inTab.runtime.openOptions(ID)
    expect(inTab.kt.calledWith('ext.popup.open')).toHaveLength(0)
    expect(Object.values(inTab.tabs).map((t) => t.url)).toContain(
      `https://${ID}.ext.zenium.invalid/options.html`
    )
  })
})

describe('pickMessages', () => {
  it('prefers the UI locale, then its language, then the manifest default', () => {
    const locales = {
      en: JSON.stringify({ name: { message: 'English' } }),
      de_DE: JSON.stringify({ name: { message: 'Deutsch (DE)' } }),
      de: JSON.stringify({ name: { message: 'Deutsch' } })
    }
    expect(pickMessages(locales, 'de-DE', 'en')?.name.message).toBe('Deutsch (DE)')
    expect(pickMessages(locales, 'de-AT', 'en')?.name.message).toBe('Deutsch')
    expect(pickMessages(locales, 'fr-FR', 'en')?.name.message).toBe('English')
    expect(pickMessages({}, 'fr-FR', 'en')).toBeNull()
  })
})
