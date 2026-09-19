import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents, WebFrameMain } from 'electron'
import { PRIVATE_CONTAINER_ID, type Tab } from '../../../shared/types'
import {
  NO_RECEIVER_ERROR,
  PORT_CLOSED_ERROR,
  USER_SCRIPTS_CHANNELS,
  type WireExtensionPlan,
  type WorldDelivery,
  type WorldExecution
} from '../../../shared/userScripts'
import type { FrameContext, WorkerContext } from '../extensionApi/contexts'
import {
  CONNECT_ACCEPT_TIMEOUT_MS,
  UserScriptsApi,
  type DocumentIds,
  type InjectionResult
} from '../extensionApi/userScripts'
import type { ApiContext, ApiHost, LoadedExtension } from '../extensionApi/types'

vi.mock('electron', () => ({ webFrameMain: { fromId: () => null } }))

const TM = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'
const NO_PERMISSION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const root = mkdtempSync(join(tmpdir(), 'zen-us-'))
const tmPath = join(root, TM)
mkdirSync(join(tmPath, 'js'), { recursive: true })
writeFileSync(join(tmPath, 'js', 'content.js'), 'console.log("content")')
afterAll(() => rmSync(root, { recursive: true, force: true }))

interface Sent {
  context: FrameContext | WorkerContext
  namespace: string
  event: string
  args: unknown[]
}

interface Dispatched {
  extensionId: string
  namespace: string
  event: string
  args: unknown[]
}

/** A page frame: what the module reads of `WebFrameMain`, and what it sent to the frame. */
interface FakeFrame {
  frame: WebFrameMain
  sent: Array<{ channel: string; payload: unknown }>
  destroy(): void
}

let frameIds = 1

function fakeFrame(
  url: string,
  options: { parent?: WebFrameMain | null; origin?: string } = {}
): FakeFrame {
  const id = frameIds++
  const sent: Array<{ channel: string; payload: unknown }> = []
  let destroyed = false
  const parent = options.parent ?? null
  const frame = {
    url,
    origin: options.origin ?? new URL(url).origin,
    parent,
    frameTreeNodeId: id,
    processId: 7,
    routingId: id,
    framesInSubtree: [] as WebFrameMain[],
    isDestroyed: () => destroyed,
    send: (channel: string, payload: unknown) => {
      if (destroyed) throw new Error('Render frame was disposed')
      sent.push({ channel, payload })
    }
  } as unknown as WebFrameMain
  frame.framesInSubtree.push(frame)
  return {
    frame,
    sent,
    destroy() {
      destroyed = true
    }
  }
}

interface FakePage {
  wc: WebContents
  tab: Tab
  main: FakeFrame
  frames: FakeFrame[]
  sub(url: string): FakeFrame
}

let pageIds = 100

function fakePage(
  url: string,
  options: { containerId?: string; tabless?: boolean } = {}
): FakePage {
  const main = fakeFrame(url)
  const id = pageIds++
  const frames = [main]
  const wc = {
    id,
    isDestroyed: () => false,
    mainFrame: main.frame,
    on: () => undefined,
    once: () => undefined
  } as unknown as WebContents
  const tab = {
    id: `tab-${id}`,
    url,
    containerId: options.containerId ?? 'default'
  } as Tab
  return {
    wc,
    tab,
    main,
    frames,
    sub(subUrl: string) {
      const sub = fakeFrame(subUrl, { parent: main.frame })
      frames.push(sub)
      main.frame.framesInSubtree.push(sub.frame)
      return sub
    }
  }
}

interface World {
  api: UserScriptsApi
  sent: Sent[]
  dispatched: Dispatched[]
  /** What `dispatch` reports reaching, per event name. */
  reach: Map<string, number>
  listeners: Set<string>
  contexts: Map<string, FrameContext | WorkerContext>
  pages: Map<number, FakePage>
  stored: Map<string, unknown>
  allowPrivate: Set<string>
  access: (extensionId: string, url: string) => boolean
  fileAccess: Set<string>
  frame(extensionId: string, key?: string): FrameContext
  worker(extensionId: string, key?: string): WorkerContext
  ctx(context: FrameContext | WorkerContext): ApiContext
  page(page: FakePage): FakePage
  load(extensionId: string, allowed?: boolean): void
}

function world(): World {
  const sent: Sent[] = []
  const dispatched: Dispatched[] = []
  const reach = new Map<string, number>()
  const listeners = new Set<string>()
  const contexts = new Map<string, FrameContext | WorkerContext>()
  const pages = new Map<number, FakePage>()
  const stored = new Map<string, unknown>()
  const allowPrivate = new Set<string>()
  const loaded = new Map<string, LoadedExtension>()
  const state: World = {
    api: undefined as unknown as UserScriptsApi,
    sent,
    dispatched,
    reach,
    listeners,
    contexts,
    pages,
    stored,
    allowPrivate,
    access: (extensionId, url) =>
      extensionId !== OTHER || url.startsWith('https://allowed.example'),
    fileAccess: new Set(),
    frame(extensionId, key = `${extensionId}:frame`) {
      const context = {
        key,
        extensionId,
        frame: { isDestroyed: () => false },
        webContents: { isDestroyed: () => false }
      } as unknown as FrameContext
      contexts.set(key, context)
      return context
    },
    worker(extensionId, key = `${extensionId}:worker`) {
      const context = {
        key,
        extensionId,
        worker: { isDestroyed: () => false, scope: `chrome-extension://${extensionId}/` },
        running: true
      } as unknown as WorkerContext
      contexts.set(key, context)
      return context
    },
    ctx(context) {
      const sender =
        'worker' in context
          ? { kind: 'worker' as const, worker: context.worker, session: {} }
          : {
              kind: 'frame' as const,
              frame: { ...context.frame, url: `chrome-extension://${context.extensionId}/bg.html` },
              webContents: context.webContents
            }
      return {
        extensionId: context.extensionId,
        extension: loaded.get(context.extensionId),
        sender,
        tabId: null,
        window: undefined
      } as unknown as ApiContext
    },
    page(page) {
      pages.set(page.wc.id, page)
      return page
    },
    load(extensionId, allowed = true) {
      const extension = {
        id: extensionId,
        manifest: { manifest_version: 3 },
        path: extensionId === TM ? tmPath : join(root, extensionId),
        sessions: []
      } as unknown as LoadedExtension
      loaded.set(extensionId, extension)
      state.api.load(extension, allowed)
    }
  }
  const host = {
    grants: (extensionId: string) => ({
      permissions: extensionId === NO_PERMISSION ? ['storage'] : ['userScripts'],
      origins: []
    }),
    loaded: (extensionId: string) => loaded.get(extensionId),
    allLoaded: () => [...loaded.values()],
    hostAccess: (extensionId: string, url: string) => state.access(extensionId, url),
    canSeeTab: () => true,
    partitionsOf: (extensionId: string) =>
      loaded.has(extensionId)
        ? ['default', ...(allowPrivate.has(extensionId) ? [PRIVATE_CONTAINER_ID] : [])]
        : [],
    registry: {
      frameFor: (frame: unknown) =>
        [...contexts.values()].find((c) => 'frame' in c && c.frame === frame),
      workerFor: (worker: unknown) =>
        [...contexts.values()].find((c) => 'worker' in c && c.worker === worker),
      isLive: (context: FrameContext | WorkerContext) => contexts.get(context.key) === context,
      framesOf: (extensionId: string) =>
        [...contexts.values()].filter((c) => 'frame' in c && c.extensionId === extensionId),
      workersOf: (extensionId: string) =>
        [...contexts.values()].filter((c) => 'worker' in c && c.extensionId === extensionId),
      hasListener: (extensionId: string, namespace: string, event: string) =>
        listeners.has(`${extensionId}:${namespace}.${event}`),
      sendTo: (
        context: FrameContext | WorkerContext,
        namespace: string,
        event: string,
        args: unknown[]
      ) => {
        sent.push({ context, namespace, event, args })
      },
      dispatch: (extensionId: string, namespace: string, event: string, args: unknown[]) => {
        dispatched.push({ extensionId, namespace, event, args })
        return reach.get(`${namespace}.${event}`) ?? 1
      }
    },
    model: {
      zenTab: (tabId: number) => pages.get(tabId)?.tab,
      webContentsOf: (tab: Tab) => [...pages.values()].find((p) => p.tab === tab)?.wc,
      chromeTab: (tab: Tab) => ({ id: Number(tab.id.slice(4)), url: tab.url, active: true })
    },
    store: {
      userScripts: (extensionId: string) => stored.get(extensionId) ?? null,
      setUserScripts: (extensionId: string, value: unknown) => {
        stored.set(extensionId, value)
      }
    },
    browser: {
      extensions: {
        list: () =>
          [...loaded.keys()].map((id) => ({ id, allowFileAccess: state.fileAccess.has(id) }))
      }
    }
  } as unknown as ApiHost
  const documents: DocumentIds = {
    documentIdOf: (_wc, frame) => `DOC${frame.routingId}`,
    frameByDocumentId: (wc, documentId) =>
      wc.mainFrame.framesInSubtree.find((f) => `DOC${f.routingId}` === documentId) ?? null
  }
  state.api = new UserScriptsApi(host, documents)
  return state
}

// Async so a handler's synchronous throw (validation) surfaces as a rejection, as the host's
// `call` makes it for the shim.
async function call(
  w: World,
  context: FrameContext | WorkerContext,
  method: string,
  ...args: unknown[]
): Promise<unknown> {
  return w.api.handlers[method](w.ctx(context), ...args)
}

const SCRIPT = {
  id: 'a',
  matches: ['https://*.example/*'],
  js: [{ code: 'window.__a = 1' }],
  runAt: 'document_start'
}

async function plan(w: World, page: FakePage, frame = page.main): Promise<WireExtensionPlan[]> {
  return w.api.plan(page.wc, frame.frame, { url: frame.frame.url })
}

describe('UserScriptsApi registrations', () => {
  it('needs the permission and the toggle, with Chrome error texts', async () => {
    const w = world()
    w.load(NO_PERMISSION)
    w.load(TM, false)
    const none = w.worker(NO_PERMISSION)
    await expect(call(w, none, 'register', [SCRIPT])).rejects.toThrow(
      "The 'userScripts' permission is required."
    )
    const tm = w.worker(TM)
    await expect(call(w, tm, 'register', [SCRIPT])).rejects.toThrow(
      "'userScripts.register' is not available."
    )
    await expect(call(w, tm, 'getScripts')).rejects.toThrow(
      "'userScripts.getScripts' is not available."
    )
    expect(w.api.togglesFor(TM)).toEqual({ userScripts: false })
    w.api.setAllowed(TM, true)
    await expect(call(w, tm, 'register', [SCRIPT])).resolves.toBeUndefined()
    expect(w.api.togglesFor(TM)).toEqual({ userScripts: true })
  })

  it('validates, fills defaults, persists and reads back', async () => {
    const w = world()
    w.load(TM)
    const tm = w.worker(TM)
    await call(w, tm, 'register', [
      SCRIPT,
      { id: 'b', matches: ['<all_urls>'], js: [{ file: 'js/content.js' }] }
    ])
    await expect(call(w, tm, 'register', [SCRIPT])).rejects.toThrow("Duplicate script ID 'a'")
    await expect(
      call(w, tm, 'register', [{ id: 'c', matches: ['<all_urls>'], js: [{ file: 'nope.js' }] }])
    ).rejects.toThrow("Could not load javascript 'nope.js' for script.")
    await expect(
      call(w, tm, 'register', [
        { id: 'd', matches: ['<all_urls>'], js: [{ file: '../escape.js' }] }
      ])
    ).rejects.toThrow("Could not load javascript '../escape.js' for script.")
    const scripts = (await call(w, tm, 'getScripts')) as unknown[]
    expect(scripts).toEqual([
      {
        id: 'a',
        matches: ['https://*.example/*'],
        allFrames: false,
        runAt: 'document_start',
        world: 'USER_SCRIPT',
        js: [{ code: 'window.__a = 1' }]
      },
      {
        id: 'b',
        matches: ['<all_urls>'],
        allFrames: false,
        runAt: 'document_idle',
        world: 'USER_SCRIPT',
        js: [{ file: 'js/content.js' }]
      }
    ])
    expect(await call(w, tm, 'getScripts', { ids: ['b'] })).toHaveLength(1)
    expect(w.stored.get(TM)).toEqual({ version: 1, scripts, worlds: [] })

    // A new host (a restart) reads the persisted state back.
    const again = world()
    again.stored.set(TM, w.stored.get(TM))
    again.load(TM)
    expect(again.api.scriptsOf(TM).map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('updates, unregisters by id and configures worlds', async () => {
    const w = world()
    w.load(TM)
    const tm = w.worker(TM)
    await call(w, tm, 'register', [SCRIPT])
    await call(w, tm, 'update', [{ id: 'a', runAt: 'document_end', world: 'MAIN' }])
    expect(w.api.scriptsOf(TM)[0]).toMatchObject({ runAt: 'document_end', world: 'MAIN' })
    await expect(call(w, tm, 'update', [{ id: 'zz' }])).rejects.toThrow(
      "Nonexistent script ID 'zz'"
    )
    await expect(call(w, tm, 'unregister', { ids: ['zz'] })).rejects.toThrow(
      "Nonexistent script ID 'zz'"
    )
    await call(w, tm, 'configureWorld', { csp: "script-src 'self' 'unsafe-eval'", messaging: true })
    await call(w, tm, 'configureWorld', { worldId: 'w2', messaging: false })
    expect(await call(w, tm, 'getWorldConfigurations')).toEqual([
      { csp: "script-src 'self' 'unsafe-eval'", messaging: true },
      { worldId: 'w2', messaging: false }
    ])
    await call(w, tm, 'resetWorldConfiguration')
    expect(await call(w, tm, 'getWorldConfigurations')).toEqual([
      { worldId: 'w2', messaging: false }
    ])
    await expect(call(w, tm, 'resetWorldConfiguration', '_x')).rejects.toThrow(
      "World IDs beginning with '_' are reserved."
    )
    await call(w, tm, 'unregister', { ids: ['a'] })
    expect(w.api.scriptsOf(TM)).toEqual([])
    await call(w, tm, 'register', [SCRIPT])
    await call(w, tm, 'unregister')
    expect(w.api.scriptsOf(TM)).toEqual([])
  })

  it('forgets an uninstalled extension in the store', async () => {
    const w = world()
    w.load(TM)
    await call(w, w.worker(TM), 'register', [SCRIPT])
    w.api.uninstalled(TM)
    expect(w.stored.get(TM)).toBeNull()
    expect(w.api.scriptsOf(TM)).toEqual([])
  })
})

describe('UserScriptsApi plan', () => {
  it('plans the matching worlds of enabled extensions with code resolved', async () => {
    const w = world()
    w.load(TM)
    const tm = w.worker(TM)
    await call(w, tm, 'register', [
      SCRIPT,
      { id: 'f', matches: ['<all_urls>'], js: [{ file: 'js/content.js' }], allFrames: true },
      { id: 'm', matches: ['<all_urls>'], js: [{ code: 'main()' }], world: 'MAIN' },
      { id: 'w2', matches: ['<all_urls>'], js: [{ code: 'two()' }], worldId: 'second' }
    ])
    await call(w, tm, 'configureWorld', { messaging: true })
    const page = w.page(fakePage('https://page.example/'))
    const plans = await plan(w, page)
    expect(plans).toEqual([
      {
        extensionId: TM,
        incognito: false,
        worlds: [
          {
            world: 'USER_SCRIPT',
            worldId: null,
            csp: "script-src 'self'; object-src 'self'",
            messaging: true,
            scripts: [
              { id: 'a', runAt: 'document_start', code: ['window.__a = 1'] },
              {
                id: 'f',
                runAt: 'document_idle',
                code: [
                  `console.log("content")\n//# sourceURL=chrome-extension://${TM}/js/content.js`
                ]
              }
            ]
          },
          {
            world: 'MAIN',
            worldId: null,
            csp: null,
            messaging: false,
            scripts: [{ id: 'm', runAt: 'document_idle', code: ['main()'] }]
          },
          {
            world: 'USER_SCRIPT',
            worldId: 'second',
            csp: "script-src 'self'; object-src 'self'",
            messaging: false,
            scripts: [{ id: 'w2', runAt: 'document_idle', code: ['two()'] }]
          }
        ]
      }
    ])
    expect(w.api.worldFrameCount(TM)).toBe(1)
    // A sub-frame gets the `allFrames` scripts only.
    const sub = page.sub('https://sub.example/frame')
    const subPlans = await plan(w, page, sub)
    expect(subPlans[0].worlds.map((world) => world.scripts.map((s) => s.id))).toEqual([['f']])
    expect(w.api.worldFrameCount(TM)).toBe(2)
  })

  it('plans nothing outside a tab, without the toggle, host access, the session, or a web URL', async () => {
    const w = world()
    w.load(TM)
    w.load(OTHER)
    await call(w, w.worker(TM), 'register', [
      { id: 'x', matches: ['<all_urls>'], js: [{ code: '1' }] }
    ])
    await call(w, w.worker(OTHER), 'register', [
      { id: 'y', matches: ['<all_urls>'], js: [{ code: '2' }] }
    ])
    const page = w.page(fakePage('https://page.example/'))
    expect((await plan(w, page)).map((p) => p.extensionId)).toEqual([TM])
    const allowed = w.page(fakePage('https://allowed.example/'))
    expect((await plan(w, allowed)).map((p) => p.extensionId)).toEqual([TM, OTHER])
    // Not a tab page.
    const tabless = fakePage('https://page.example/')
    expect(await plan(w, tabless)).toEqual([])
    // Toggle off.
    w.api.setAllowed(TM, false)
    expect(await plan(w, page)).toEqual([])
    w.api.setAllowed(TM, true)
    // A private window's tab: only an extension allowed there.
    const priv = w.page(fakePage('https://page.example/', { containerId: PRIVATE_CONTAINER_ID }))
    expect(await plan(w, priv)).toEqual([])
    w.allowPrivate.add(TM)
    expect(await plan(w, priv)).toMatchObject([{ extensionId: TM, incognito: true }])
    // Non-web documents, and file: without the file-access toggle.
    expect(await plan(w, w.page(fakePage('about:blank')))).toEqual([])
    expect(await plan(w, w.page(fakePage(`chrome-extension://${TM}/options.html`)))).toEqual([])
    const file = w.page(fakePage('file:///home/u/page.html'))
    expect(await plan(w, file)).toEqual([])
    w.fileAccess.add(TM)
    expect(await plan(w, file)).toHaveLength(1)
  })
})

describe('UserScriptsApi world messaging', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function ready(): Promise<{ w: World; page: FakePage; bg: WorkerContext }> {
    const w = world()
    w.load(TM)
    const bg = w.worker(TM)
    await call(w, bg, 'register', [{ id: 'x', matches: ['<all_urls>'], js: [{ code: '1' }] }])
    await call(w, bg, 'configureWorld', { messaging: true })
    const page = w.page(fakePage('https://page.example/'))
    await plan(w, page)
    return { w, page, bg }
  }

  it('refuses a world the frame does not hold, a silent world, or an extension without listeners', async () => {
    const { w, page, bg } = await ready()
    const stranger = w.page(fakePage('https://other.example/'))
    await expect(
      w.api.worldMessage(stranger.wc, stranger.main.frame, {
        extensionId: TM,
        worldId: null,
        message: 1
      })
    ).resolves.toEqual({ error: NO_RECEIVER_ERROR })
    await expect(
      w.api.worldMessage(page.wc, page.main.frame, {
        extensionId: TM,
        worldId: 'quiet',
        message: 1
      })
    ).resolves.toEqual({ error: NO_RECEIVER_ERROR })
    await expect(
      w.api.worldMessage(page.wc, page.main.frame, { extensionId: TM, worldId: null, message: 1 })
    ).resolves.toEqual({ error: NO_RECEIVER_ERROR })
    expect(w.dispatched).toEqual([])
    w.listeners.add(`${TM}:runtime.onUserScriptMessage`)
    w.reach.set('runtime.onUserScriptMessage', 0)
    await expect(
      w.api.worldMessage(page.wc, page.main.frame, { extensionId: TM, worldId: null, message: 1 })
    ).resolves.toEqual({ error: NO_RECEIVER_ERROR })
    expect(w.dispatched).toHaveLength(1)
    void bg
  })

  it('delivers runtime.onUserScriptMessage with the sender and takes the first response', async () => {
    const { w, page, bg } = await ready()
    w.listeners.add(`${TM}:runtime.onUserScriptMessage`)
    w.reach.set('runtime.onUserScriptMessage', 2)
    const promise = w.api.worldMessage(page.wc, page.main.frame, {
      extensionId: TM,
      worldId: null,
      message: { cmd: 'GetInjected' }
    })
    expect(w.dispatched).toHaveLength(1)
    const [message, sender, token] = w.dispatched[0].args
    expect(message).toEqual({ cmd: 'GetInjected' })
    expect(sender).toEqual({
      id: TM,
      url: 'https://page.example/',
      origin: 'https://page.example',
      frameId: 0,
      documentId: `DOC${page.main.frame.routingId}`,
      documentLifecycle: 'active',
      tab: { id: page.wc.id, url: 'https://page.example/', active: true }
    })
    // The popup closes its channel, the worker answers.
    w.api.answerMessage(w.ctx(bg), { token, responded: false })
    w.api.answerMessage(w.ctx(w.frame(OTHER)), { token, responded: true, result: 'spoof' })
    w.api.answerMessage(w.ctx(bg), { token, responded: true, result: { ok: true } })
    await expect(promise).resolves.toEqual({ result: { ok: true } })
  })

  it('reports the port closed when every context lets the channel close, or on timeout', async () => {
    const { w, page, bg } = await ready()
    w.listeners.add(`${TM}:runtime.onUserScriptMessage`)
    w.reach.set('runtime.onUserScriptMessage', 2)
    const first = w.api.worldMessage(page.wc, page.main.frame, {
      extensionId: TM,
      worldId: null,
      message: 1
    })
    const token = w.dispatched[0].args[2]
    w.api.answerMessage(w.ctx(bg), { token, responded: false })
    w.api.answerMessage(w.ctx(bg), { token, responded: false })
    await expect(first).resolves.toEqual({ error: PORT_CLOSED_ERROR })
    const second = w.api.worldMessage(page.wc, page.main.frame, {
      extensionId: TM,
      worldId: null,
      message: 2
    })
    vi.advanceTimersByTime(5 * 60_000)
    await expect(second).resolves.toEqual({ error: PORT_CLOSED_ERROR })
    // An unload answers what is still waiting.
    const third = w.api.worldMessage(page.wc, page.main.frame, {
      extensionId: TM,
      worldId: null,
      message: 3
    })
    w.api.unload(TM)
    await expect(third).resolves.toEqual({ error: PORT_CLOSED_ERROR })
  })

  it('runs a port between the world and the accepting contexts', async () => {
    const { w, page, bg } = await ready()
    const frame = page.main.frame
    // No onUserScriptConnect listener: the world's port disconnects with Chrome's error.
    w.api.worldPort(page.wc, frame, {
      kind: 'connect',
      portId: '1:1',
      extensionId: TM,
      worldId: null,
      name: 'p'
    })
    expect(page.main.sent).toEqual([
      {
        channel: USER_SCRIPTS_CHANNELS.port,
        payload: { kind: 'disconnect', portId: '1:1', error: NO_RECEIVER_ERROR }
      }
    ])
    page.main.sent.length = 0
    w.listeners.add(`${TM}:runtime.onUserScriptConnect`)
    w.api.worldPort(page.wc, frame, {
      kind: 'connect',
      portId: '1:2',
      extensionId: TM,
      worldId: null,
      name: 'p'
    })
    expect(w.dispatched).toHaveLength(1)
    const info = w.dispatched[0].args[0] as {
      portId: string
      name: string
      sender: { frameId: number }
    }
    expect(info.name).toBe('p')
    expect(info.sender.frameId).toBe(0)
    expect(w.api.openPorts).toBe(1)
    // Posted before anyone accepted: buffered, then flushed to the acceptor.
    w.api.worldPort(page.wc, frame, { kind: 'message', portId: '1:2', message: 'early' })
    expect(w.sent).toEqual([])
    w.api.shimPort(w.ctx(bg), { kind: 'accept', portId: info.portId })
    expect(w.sent).toEqual([
      {
        context: bg,
        namespace: '__zen',
        event: 'us-port',
        args: [{ kind: 'message', portId: info.portId, message: 'early' }]
      }
    ])
    w.sent.length = 0
    // Both ways.
    w.api.worldPort(page.wc, frame, { kind: 'message', portId: '1:2', message: 'up' })
    expect(w.sent.map((s) => s.args[0])).toEqual([
      { kind: 'message', portId: info.portId, message: 'up' }
    ])
    w.api.shimPort(w.ctx(bg), { kind: 'message', portId: info.portId, message: 'down' })
    expect(page.main.sent).toEqual([
      {
        channel: USER_SCRIPTS_CHANNELS.port,
        payload: { kind: 'message', portId: '1:2', message: 'down' }
      }
    ])
    // A stranger context cannot speak on it.
    page.main.sent.length = 0
    w.api.shimPort(w.ctx(w.frame(OTHER)), {
      kind: 'message',
      portId: info.portId,
      message: 'spoof'
    })
    expect(page.main.sent).toEqual([])
    // The extension disconnects: the world hears it, the port is gone.
    w.api.shimPort(w.ctx(bg), { kind: 'disconnect', portId: info.portId })
    expect(page.main.sent).toEqual([
      { channel: USER_SCRIPTS_CHANNELS.port, payload: { kind: 'disconnect', portId: '1:2' } }
    ])
    expect(w.api.openPorts).toBe(0)
    // The world disconnects: the accepting context hears it.
    w.sent.length = 0
    w.api.worldPort(page.wc, frame, {
      kind: 'connect',
      portId: '1:3',
      extensionId: TM,
      worldId: null,
      name: 'q'
    })
    const second = (w.dispatched[1].args[0] as { portId: string }).portId
    w.api.shimPort(w.ctx(bg), { kind: 'accept', portId: second })
    w.api.worldPort(page.wc, frame, { kind: 'disconnect', portId: '1:3' })
    expect(w.sent.map((s) => s.args[0])).toEqual([{ kind: 'disconnect', portId: second }])
    expect(w.api.openPorts).toBe(0)
  })

  it('refuses a port nobody accepts in time, and closes ports with the extension', async () => {
    const { w, page, bg } = await ready()
    const frame = page.main.frame
    w.listeners.add(`${TM}:runtime.onUserScriptConnect`)
    w.api.worldPort(page.wc, frame, {
      kind: 'connect',
      portId: '1:1',
      extensionId: TM,
      worldId: null,
      name: ''
    })
    vi.advanceTimersByTime(CONNECT_ACCEPT_TIMEOUT_MS)
    expect(page.main.sent).toEqual([
      {
        channel: USER_SCRIPTS_CHANNELS.port,
        payload: { kind: 'disconnect', portId: '1:1', error: NO_RECEIVER_ERROR }
      }
    ])
    page.main.sent.length = 0
    w.api.worldPort(page.wc, frame, {
      kind: 'connect',
      portId: '1:2',
      extensionId: TM,
      worldId: null,
      name: ''
    })
    const portId = (w.dispatched[1].args[0] as { portId: string }).portId
    w.api.shimPort(w.ctx(bg), { kind: 'accept', portId })
    w.api.unload(TM)
    expect(page.main.sent).toEqual([
      { channel: USER_SCRIPTS_CHANNELS.port, payload: { kind: 'disconnect', portId: '1:2' } }
    ])
    expect(w.api.openPorts).toBe(0)
  })
})

describe('UserScriptsApi deliveries and execute', () => {
  async function ready(): Promise<{ w: World; page: FakePage; bg: WorkerContext }> {
    const w = world()
    w.load(TM)
    const bg = w.worker(TM)
    await call(w, bg, 'register', [
      { id: 'x', matches: ['<all_urls>'], js: [{ code: '1' }], allFrames: true }
    ])
    const page = w.page(fakePage('https://page.example/'))
    await plan(w, page)
    return { w, page, bg }
  }

  function lastDelivery(frame: FakeFrame): WorldDelivery {
    const entry = frame.sent.filter((s) => s.channel === USER_SCRIPTS_CHANNELS.deliver).at(-1)
    return entry?.payload as WorldDelivery
  }

  it('delivers tabs.sendMessage to the frames holding worlds and takes the first response', async () => {
    const { w, page, bg } = await ready()
    // A tab without worlds of the extension: nothing to deliver to.
    const empty = w.page(fakePage('https://empty.example/'))
    await expect(call(w, bg, 'sendMessage', empty.wc.id, 'hi', null)).resolves.toEqual({
      handled: false,
      responded: false
    })
    const sub = page.sub('https://sub.example/')
    await plan(w, page, sub)
    const promise = call(
      w,
      bg,
      'sendMessage',
      page.wc.id,
      { cmd: 'ping' },
      null
    ) as Promise<unknown>
    const top = lastDelivery(page.main)
    const inner = lastDelivery(sub)
    expect(top).toEqual({
      token: expect.any(Number),
      extensionId: TM,
      message: { cmd: 'ping' },
      sender: { id: TM, url: `chrome-extension://${TM}/`, origin: `chrome-extension://${TM}` }
    })
    expect(inner.token).not.toBe(top.token)
    // An answer from the wrong frame is ignored; the sub-frame responds first.
    w.api.answer(page.wc, page.main.frame, {
      token: inner.token,
      handled: true,
      responded: true,
      result: 'spoof'
    })
    w.api.answer(page.wc, sub.frame, {
      token: inner.token,
      handled: true,
      responded: true,
      result: 'from-sub'
    })
    await expect(promise).resolves.toEqual({ handled: true, responded: true, result: 'from-sub' })
    w.api.answer(page.wc, page.main.frame, { token: top.token, handled: false, responded: false })
    expect(w.api.pendingAnswers).toBe(0)
  })

  it('reports whether anyone listened when nobody responds, and follows frame options', async () => {
    const { w, page, bg } = await ready()
    const sub = page.sub('https://sub.example/')
    await plan(w, page, sub)
    const all = call(w, bg, 'sendMessage', page.wc.id, 'hi', null) as Promise<unknown>
    w.api.answer(page.wc, page.main.frame, {
      token: lastDelivery(page.main).token,
      handled: false,
      responded: false
    })
    w.api.answer(page.wc, sub.frame, {
      token: lastDelivery(sub).token,
      handled: true,
      responded: false
    })
    await expect(all).resolves.toEqual({ handled: true, responded: false })
    page.main.sent.length = 0
    sub.sent.length = 0
    const onlySub = call(w, bg, 'sendMessage', page.wc.id, 'hi', {
      frameId: sub.frame.frameTreeNodeId
    }) as Promise<unknown>
    expect(page.main.sent).toEqual([])
    w.api.answer(page.wc, sub.frame, {
      token: lastDelivery(sub).token,
      handled: true,
      responded: true,
      result: 1
    })
    await expect(onlySub).resolves.toEqual({ handled: true, responded: true, result: 1 })
    sub.sent.length = 0
    const byDocument = call(w, bg, 'sendMessage', page.wc.id, 'hi', {
      documentId: `DOC${page.main.frame.routingId}`
    }) as Promise<unknown>
    expect(sub.sent).toEqual([])
    w.api.answer(page.wc, page.main.frame, {
      token: lastDelivery(page.main).token,
      handled: true,
      responded: true,
      result: 2
    })
    await expect(byDocument).resolves.toEqual({ handled: true, responded: true, result: 2 })
  })

  it('resolves what a navigated or destroyed frame owed as not handled', async () => {
    const { w, page, bg } = await ready()
    const sub = page.sub('https://sub.example/')
    await plan(w, page, sub)
    const promise = call(w, bg, 'sendMessage', page.wc.id, 'hi', null) as Promise<unknown>
    expect(w.api.pendingAnswers).toBe(2)
    w.api.frameNavigated(page.wc, `7:${sub.frame.routingId}`, false)
    expect(w.api.pendingAnswers).toBe(1)
    expect(w.api.worldFrameCount(TM)).toBe(1)
    page.main.destroy()
    w.api.frameNavigated(page.wc, '0:0', true)
    await expect(promise).resolves.toEqual({ handled: false, responded: false })
    expect(w.api.worldFrameCount(TM)).toBe(0)
    // A frame that cannot be reached counts as gone at once.
    await expect(call(w, bg, 'sendMessage', page.wc.id, 'hi', null)).resolves.toEqual({
      handled: false,
      responded: false
    })
  })

  it('executes in the target frames and reports a result per frame', async () => {
    const { w, page, bg } = await ready()
    await call(w, bg, 'configureWorld', { csp: "script-src 'unsafe-eval'", messaging: true })
    const sub = page.sub('https://sub.example/')
    await expect(
      call(w, bg, 'execute', { js: [{ code: '1' }], target: { tabId: 999 } })
    ).rejects.toThrow('No tab with id: 999.')
    await expect(
      call(w, bg, 'execute', { js: [{ code: '1' }], target: { tabId: page.wc.id, frameIds: [42] } })
    ).rejects.toThrow(`No frame with id 42 in tab with id ${page.wc.id}.`)
    const promise = call(w, bg, 'execute', {
      js: [{ code: 'a()' }, { file: 'js/content.js' }],
      target: { tabId: page.wc.id, allFrames: true },
      injectImmediately: true
    }) as Promise<InjectionResult[]>
    const top = page.main.sent.at(-1)?.payload as WorldExecution
    const inner = sub.sent.at(-1)?.payload as WorldExecution
    expect(top).toEqual({
      token: expect.any(Number),
      extensionId: TM,
      world: 'USER_SCRIPT',
      worldId: null,
      csp: "script-src 'unsafe-eval'",
      messaging: true,
      incognito: false,
      code: ['a()', `console.log("content")\n//# sourceURL=chrome-extension://${TM}/js/content.js`],
      injectImmediately: true
    })
    w.api.answer(page.wc, page.main.frame, { token: top.token, result: 'top' })
    w.api.answer(page.wc, sub.frame, {
      token: inner.token,
      error: 'ReferenceError: a is not defined'
    })
    await expect(promise).resolves.toEqual([
      { frameId: 0, documentId: `DOC${page.main.frame.routingId}`, result: 'top' },
      {
        frameId: sub.frame.frameTreeNodeId,
        documentId: `DOC${sub.frame.routingId}`,
        error: 'ReferenceError: a is not defined'
      }
    ])
    // The executing frame holds a world now: the world may message the extension.
    expect(w.api.worldFrameCount(TM)).toBe(2)
    // MAIN world, by document id, idle timing.
    const main = call(w, bg, 'execute', {
      js: [{ code: 'm()' }],
      world: 'MAIN',
      target: { tabId: page.wc.id, documentIds: [`DOC${sub.frame.routingId}`] }
    }) as Promise<InjectionResult[]>
    const execution = sub.sent.at(-1)?.payload as WorldExecution
    expect(execution).toMatchObject({
      world: 'MAIN',
      csp: null,
      messaging: false,
      injectImmediately: false,
      code: ['m()']
    })
    w.api.answer(page.wc, sub.frame, { token: execution.token, result: undefined })
    await expect(main).resolves.toEqual([
      { frameId: sub.frame.frameTreeNodeId, documentId: `DOC${sub.frame.routingId}` }
    ])
  })

  it('needs host access to the frame and the toggle, and reports a frame that went away', async () => {
    const { w, page, bg } = await ready()
    w.access = (id, url) => id !== TM || !url.startsWith('https://sub.')
    const sub = page.sub('https://sub.example/')
    await expect(
      call(w, bg, 'execute', {
        js: [{ code: '1' }],
        target: { tabId: page.wc.id, frameIds: [sub.frame.frameTreeNodeId] }
      })
    ).rejects.toThrow(
      'Cannot access contents of url "https://sub.example/". Extension manifest must request permission to access this host.'
    )
    const promise = call(w, bg, 'execute', {
      js: [{ code: '1' }],
      target: { tabId: page.wc.id }
    }) as Promise<InjectionResult[]>
    w.api.frameNavigated(page.wc, `7:${page.main.frame.routingId}`, true)
    await expect(promise).resolves.toEqual([
      {
        frameId: 0,
        documentId: `DOC${page.main.frame.routingId}`,
        error: 'Frame with ID 0 was removed.'
      }
    ])
    w.api.setAllowed(TM, false)
    await expect(
      call(w, bg, 'execute', { js: [{ code: '1' }], target: { tabId: page.wc.id } })
    ).rejects.toThrow("'userScripts.execute' is not available.")
  })

  it('tells every context of the extension when the toggle flips', async () => {
    const { w, bg } = await ready()
    const popup = w.frame(TM)
    w.frame(OTHER)
    w.api.setAllowed(TM, false)
    expect(w.sent).toEqual([
      { context: popup, namespace: '__zen', event: 'toggles', args: [{ userScripts: false }] },
      { context: bg, namespace: '__zen', event: 'toggles', args: [{ userScripts: false }] }
    ])
    expect(w.api.isAllowed(TM)).toBe(false)
  })
})
