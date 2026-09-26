import { DEFAULT_AGENT_SETTINGS } from '../../../shared/defaults'
import type { AgentSettings, Folder, Space, Tab } from '../../../shared/types'
import type { Browser } from '../../browser'
import {
  type Model,
  createSpace,
  createTabRecord,
  deleteFolder as deleteFolderInModel,
  emptyModel,
  folderOpened,
  getSpace,
  insertTabIntoSpace,
  removeTabFromLists,
  sectionIndexOf
} from '../../model'
import type { AgentInputEvent, AgentTransport, TabView } from '../../platform'
import type { ZenWindow } from '../../window'
import type { ToolResult } from '../protocol'
import { AgentService, type AgentSession } from '../service'
import { FakePage } from './fakePage'

/**
 * A browser for the multi-agent tests: the real model helpers over an in-memory model, a tab
 * manager that does what the real one does to the model (create, close, move, group, activate,
 * switch spaces – without views, loads or windows), one synced window, and fake pages behind the
 * tabs so the page tools can snapshot them. The real `AgentService` runs on top, so sessions,
 * ownership, the queue, notices, the lease and every tool are the code under test.
 */

export interface FakeWindow extends ZenWindow {
  /** Tab activations in order (what the user would have seen come in front). */
  activations: string[]
}

export interface Gate {
  /** Let the held call go on. */
  release(): void
}

export interface FakeBrowser {
  browser: Browser
  service: AgentService
  model: Model
  win: FakeWindow
  /** The user's own space, the one the window shows at the start. */
  userSpace: Space
  /** Fake pages by tab id, made when a tab is first loaded. */
  pages: Map<string, FakePage>
  /** Real input the pages received, by tab id. */
  input: Map<string, AgentInputEvent[]>
  /** Every `setAgentDriven` a page's view heard, by tab id, in order. */
  agentDriven: Map<string, boolean[]>
  /** What the user does from the chrome. */
  user: {
    openTab(url: string, opts?: { essential?: boolean; pinned?: boolean; folderId?: string }): Tab
    closeTab(tabId: string): void
    moveToFolder(tabId: string, folderId: string | null): void
    deleteFolder(folderId: string, unpack: boolean): void
    activate(tabId: string): void
  }
  /** Hold the next page evaluation on the tab until released (to freeze a tool call mid-way). */
  hold(tabId: string): Gate
  /** A connected, approved session. */
  connect(name: string, opts?: { mode?: 'foreground' | 'background' }): Promise<AgentSession>
  /** A tool call through the service (queue, notices and all), as the protocol would make it. */
  call(session: AgentSession, name: string, args?: Record<string, unknown>): Promise<ToolResult>
  /** The tab id a `browser_tabs new` / `browser_navigate` result names. */
  openedTab(result: ToolResult): string
  /** The group id a `zen_groups create` result names. */
  createdGroup(result: ToolResult): string
  /**
   * The browser restarted on this one's state: the model as `state.json` holds it (a JSON round
   * trip – spaces and folders travel whole, as `State.persisted()` writes them), a fresh
   * `AgentService` over it with nothing in memory (no sessions, views or pages), and its
   * `start()` run as the boot does. `stop()` the result when the test is done with it.
   */
  restart(): FakeBrowser
  /** End the service (the sweeper, the server): what the real browser does on quit. */
  stop(): Promise<void>
  /** How many times the service asked the state to persist (`state.commit()`). */
  readonly commits: number
}

export interface FakeBrowserOptions {
  /** A model to run on – a restart's persisted state – instead of a fresh one with `Work`. */
  model?: Model
}

export function textOf(result: ToolResult): string {
  return (result.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text ?? ''
}

function pageFor(tab: Tab): FakePage {
  const origin = /^https?:\/\/[^/]+/.exec(tab.url)?.[0] ?? 'about:blank'
  return new FakePage([
    {
      id: 0,
      parentId: null,
      url: tab.url,
      origin,
      name: '',
      title: tab.title,
      elements: [
        {
          id: 'h1',
          tag: 'h1',
          role: 'heading',
          name: tab.title,
          box: { x: 20, y: 20, width: 400, height: 40 }
        },
        {
          id: 'go',
          tag: 'button',
          role: 'button',
          name: 'Go',
          box: { x: 20, y: 100, width: 100, height: 40 }
        }
      ]
    }
  ])
}

export function fakeBrowser(
  settings: Partial<AgentSettings> = {},
  options: FakeBrowserOptions = {}
): FakeBrowser {
  const model =
    options.model ?? emptyModel([{ id: 'default', name: 'Default', color: '#888' } as never])
  let userSpace = getSpace(model, model.activeSpaceId)
  if (!userSpace) {
    userSpace = model.spaces[0] ?? createSpace('Work', '💼')
    if (!model.spaces.includes(userSpace)) model.spaces.push(userSpace)
    model.activeSpaceId = userSpace.id
  }
  const pages = new Map<string, FakePage>()
  const views = new Map<string, TabView>()
  const input = new Map<string, AgentInputEvent[]>()
  const agentDriven = new Map<string, boolean[]>()
  const gates = new Map<string, Promise<void>>()
  let commits = 0
  const transport: AgentTransport = {
    start: async (options) => ({ port: options.port, lanAddresses: [] }),
    stop: async () => undefined
  }

  const win: FakeWindow = {
    id: 'win_1',
    kind: 'synced',
    activeSpaceId: userSpace.id,
    localSpace: null,
    contentHidden: false,
    activations: [],
    activeSpace: () => getSpace(model, win.activeSpaceId) ?? userSpace,
    selectedTabIn: (space: Space) => space.activeTabId,
    viewRect: () => ({ x: 0, y: 80, width: 1000, height: 800 })
  } as unknown as FakeWindow

  const tabOf = (id: string | null | undefined): Tab | undefined =>
    id ? model.tabs[id] : undefined

  const makeView = (tab: Tab): TabView => {
    const page = pages.get(tab.id) ?? pageFor(tab)
    pages.set(tab.id, page)
    const events: AgentInputEvent[] = []
    input.set(tab.id, events)
    const driven: boolean[] = []
    agentDriven.set(tab.id, driven)
    const view = {
      executeJavaScript: async (code: string, frameId?: number) => {
        const gate = gates.get(tab.id)
        if (gate) {
          gates.delete(tab.id)
          await gate
        }
        return (pages.get(tab.id) ?? page).eval(frameId ?? 0, code)
      },
      frames: () => (pages.get(tab.id) ?? page).frames() ?? undefined,
      sendInput: async (e: AgentInputEvent) => {
        events.push(e)
      },
      hasPainted: async () => true,
      isVisible: () => win.activeSpace().activeTabId === tab.id,
      getURL: () => tab.url,
      isDestroyed: () => !model.tabs[tab.id],
      canGoBack: () => false,
      canGoForward: () => false,
      focus: () => undefined,
      setBackgroundThrottling: () => undefined,
      setAgentDriven: (on: boolean) => {
        driven.push(on)
      },
      snapshot: async () => null
    } as unknown as TabView
    return view
  }

  const ensureLoaded = (tabId: string): TabView | undefined => {
    const tab = tabOf(tabId)
    if (!tab) return undefined
    let view = views.get(tabId)
    if (!view) {
      view = makeView(tab)
      views.set(tabId, view)
    }
    tab.discarded = false
    return view
  }

  const activateTab = (tabId: string): void => {
    const tab = tabOf(tabId)
    if (!tab) return
    const space = tab.essential ? win.activeSpace() : getSpace(model, tab.spaceId)
    if (!space) return
    if (!tab.essential) win.activeSpaceId = space.id
    space.activeTabId = tabId
    tab.lastActiveAt = Date.now()
    win.activations.push(tabId)
    ensureLoaded(tabId)
  }

  const closeTab = (tabId: string): void => {
    const tab = tabOf(tabId)
    if (!tab) return
    const space = getSpace(model, tab.spaceId)
    const wasActive = space?.activeTabId === tabId
    removeTabFromLists(model, tabId)
    delete model.tabs[tabId]
    views.delete(tabId)
    if (space && wasActive) space.activeTabId = space.tabIds[space.tabIds.length - 1] ?? null
    // TAB-16: a group whose last tab closes is kept as a saved group.
    if (tab.folderId) {
      const folder = model.folders[tab.folderId]
      const left = Object.values(model.tabs).some((t) => t.folderId === tab.folderId)
      if (folder && !left) folder.savedTabs = [{ url: tab.url, title: tab.title, favicon: null }]
    }
    browser.agents.onTabRemoved(tabId)
  }

  const createTab = (
    opts: {
      url?: string
      spaceId?: string
      active?: boolean
      essential?: boolean
      pinned?: boolean
      afterTabId?: string
      folderId?: string | null
      load?: boolean
    },
    w: ZenWindow = win
  ): Tab => {
    const space = (opts.spaceId ? getSpace(model, opts.spaceId) : undefined) ?? w.activeSpace()
    const essential = Boolean(opts.essential)
    const url = opts.url ?? 'about:blank'
    const tab = createTabRecord({
      spaceId: essential ? null : space.id,
      containerId: 'default',
      url,
      title: url === 'about:blank' ? 'New tab' : `Page ${url.replace(/^https?:\/\//, '')}`,
      pinned: Boolean(opts.pinned) && !essential,
      essential,
      folderId: opts.folderId ?? null,
      discarded: true
    })
    model.tabs[tab.id] = tab
    if (essential) model.essentialTabIds.push(tab.id)
    else {
      const after = tabOf(opts.afterTabId)
      const index =
        after && after.spaceId === space.id && after.pinned === tab.pinned
          ? sectionIndexOf(model, after) + 1
          : undefined
      insertTabIntoSpace(model, space, tab, index)
    }
    folderOpened(model, tab.folderId, tab.createdAt)
    if (opts.active !== false) activateTab(tab.id)
    return tab
  }

  const moveTab = (
    tabId: string,
    target: { spaceId?: string; section: string; index: number }
  ): void => {
    const tab = tabOf(tabId)
    if (!tab || tab.essential) return
    const space = getSpace(model, target.spaceId ?? tab.spaceId)
    if (!space) return
    for (const sp of model.spaces) sp.tabIds = sp.tabIds.filter((id) => id !== tabId)
    tab.pinned = target.section === 'pinned'
    insertTabIntoSpace(model, space, tab, target.index)
  }

  const moveToFolder = (tabId: string, folderId: string | null): void => {
    const tab = tabOf(tabId)
    if (!tab || tab.essential || tab.pinned) return
    if (folderId && !model.folders[folderId]) return
    tab.folderId = folderId
    if (folderId) folderOpened(model, folderId, Date.now())
  }

  const deleteFolder = (folderId: string, unpack: boolean): void => {
    const closed = deleteFolderInModel(model, folderId, unpack)
    for (const id of closed) closeTab(id)
  }

  const browser = {
    platform: {
      io: {
        readSync: () => null,
        write: async () => undefined,
        writeSync: () => undefined
      },
      info: { version: '0.0.0-test' },
      createAgentTransport: () => transport,
      dialogs: { confirm: async () => false },
      readabilitySource: () => null
    },
    state: {
      model,
      settings: {
        agents: { ...DEFAULT_AGENT_SETTINGS, enabled: true, approveNewAgents: false, ...settings }
      },
      commit: () => {
        commits += 1
      },
      commitVolatile: () => undefined,
      defaultSearchEngine: () => ({
        id: 'test',
        name: 'Test',
        searchUrl: 'https://search.example/?q=%s',
        suggestUrl: null
      })
    },
    tabs: {
      tab: tabOf,
      view: (id: string) => views.get(id),
      activeTabFor: (w: ZenWindow) => tabOf(w.activeSpace().activeTabId),
      windowFor: () => win,
      ensureLoaded,
      isPrivate: () => false,
      createTab,
      activateTab: (id: string) => activateTab(id),
      switchSpace: (spaceId: string) => {
        if (getSpace(model, spaceId)) win.activeSpaceId = spaceId
      },
      closeTab: (id: string) => closeTab(id),
      navigate: (id: string, url: string) => {
        const tab = tabOf(id)
        if (!tab) return
        tab.url = url
        tab.title = `Page ${url.replace(/^https?:\/\//, '')}`
        pages.set(id, pageFor(tab))
        ensureLoaded(id)
      },
      goBack: () => undefined,
      goForward: () => undefined,
      reload: () => undefined,
      moveTab: (id: string, target: { spaceId?: string; section: string; index: number }) =>
        moveTab(id, target),
      moveToFolder
    },
    focusedWindow: () => win,
    allWindows: () => [win],
    createWindow: () => win,
    toast: () => undefined,
    updateFolder: (folderId: string, patch: Partial<Folder>) => {
      const folder = model.folders[folderId]
      if (folder) Object.assign(folder, patch)
    },
    deleteFolder,
    governor: { thaw: async () => undefined },
    history: { search: () => [] },
    handleCommand: () => undefined
  } as unknown as Browser & { agents: AgentService }

  const service = new AgentService(browser)
  browser.agents = service
  // Loads are instantaneous here: the fake pages are ready as soon as a view exists.
  service.waitForLoad = async () => true

  const user: FakeBrowser['user'] = {
    openTab: (url, opts = {}) =>
      createTab({ url, spaceId: userSpace.id, active: true, load: false, ...opts }),
    closeTab,
    moveToFolder,
    deleteFolder,
    activate: activateTab
  }

  const connect: FakeBrowser['connect'] = async (name, opts = {}) => {
    const session = service.create({
      transport: 'http',
      token: service.serverStatus().token,
      remoteAddress: '127.0.0.1',
      userAgent: 'test'
    })
    await service.onInitialize(session, { name, version: '1.0' })
    if (opts.mode) session.mode = opts.mode
    return session
  }

  return {
    browser,
    service,
    model,
    win,
    userSpace,
    pages,
    input,
    agentDriven,
    user,
    hold: (tabId) => {
      let release = (): void => undefined
      gates.set(
        tabId,
        new Promise<void>((resolve) => {
          release = resolve
        })
      )
      return { release: () => release() }
    },
    connect,
    call: (session, name, args = {}) => service.callTool(session, name, args),
    openedTab: (result) => {
      const m = /Opened tab (tab_[\w-]+)/.exec(textOf(result))
      if (!m) throw new Error(`no tab opened: ${textOf(result)}`)
      return m[1]
    },
    createdGroup: (result) => {
      const m = /Created group (folder_[\w-]+)/.exec(textOf(result))
      if (!m) throw new Error(`no group created: ${textOf(result)}`)
      return m[1]
    },
    restart: () => {
      const persisted = JSON.parse(JSON.stringify(model)) as Model
      // Local (blank / private window) spaces never survive a restart; nor do live views.
      persisted.localSpaces = {}
      for (const t of Object.values(persisted.tabs)) t.discarded = true
      const next = fakeBrowser(settings, { model: persisted })
      next.service.start()
      return next
    },
    stop: () => service.stop(),
    get commits() {
      return commits
    }
  }
}
