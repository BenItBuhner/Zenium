import { describe, expect, it, vi } from 'vitest'
import { NEW_TAB_URL } from '../../shared/url'
import type { HostCapabilities, Platform as PlatformOs, Space } from '../../shared/types'
import type { AgentSession } from '../agent/service'
import { Browser } from '../browser'
import { createSpace, createTabRecord, userSpaceInstead } from '../model'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import type { PersistedWindow } from '../state'
import type { ZenWindow } from '../window'

function memoryIo(): StoreIO {
  const files: Record<string, string> = {}
  return {
    readSync: (name) => files[name] ?? null,
    write: async (name, text) => {
      files[name] = text
    },
    writeSync: (name, text) => {
      files[name] = text
    }
  }
}

function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

/** A host whose windows and views do nothing: the desktop (several windows) or a phone (one). */
function platformOf(opts: { windows: boolean; os?: PlatformOs }): Platform {
  const capabilities = stub<HostCapabilities>({
    windows: opts.windows,
    // The phone draws its own empty surface and has no new tab page to seed (`ensureFirstTab`).
    newTabPage: opts.windows,
    updates: false,
    agents: false
  })
  return {
    info: { os: opts.os ?? 'linux', version: '0.0.0' },
    capabilities,
    io: memoryIo(),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true
        })
    },
    views: stub<TabViewHost>({
      createView: () =>
        stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          hasDocument: () => false,
          getURL: () => '',
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          // The agent's detach disposes its page runtime through the view; a settled promise.
          executeJavaScript: () => Promise.resolve(undefined),
          executeIsolatedJavaScript: () => Promise.resolve(undefined)
        })
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    readabilitySource: () => null
  }
}

/** A browser over a profile that has been through onboarding; "Restore previous session" on. */
function fresh(opts: { windows?: boolean; os?: PlatformOs } = {}): Browser {
  const browser = new Browser(platformOf({ windows: opts.windows ?? true, os: opts.os }))
  browser.state.settings.onboardingDone = true
  return browser
}

const window = (
  id: string,
  spaceId: string,
  selection: string | null,
  lastUserSpaceId?: string | null
): PersistedWindow => ({
  id,
  bounds: { x: 0, y: 0, width: 1000, height: 700 },
  maximized: false,
  activeSpaceId: spaceId,
  lastUserSpaceId,
  selection: selection ? { [spaceId]: selection } : {},
  compact: false
})

/** A page tab in `space` (the model's first by default), as the last run would have left it. */
function seedTab(browser: Browser, url: string, space = browser.state.model.spaces[0]): string {
  const tab = createTabRecord({ spaceId: space.id, containerId: space.containerId, url })
  browser.state.model.tabs[tab.id] = tab
  space.tabIds.push(tab.id)
  space.activeTabId = tab.id
  return tab.id
}

/** The shared Agents space as the agent service leaves it: marked, empty. */
function agentsSpace(browser: Browser): Space {
  const first = browser.state.model.spaces[0]
  const space = createSpace('Agents', '', first.containerId)
  space.agent = { kind: 'shared' }
  browser.state.model.spaces.push(space)
  return space
}

const urls = (browser: Browser): string[] =>
  Object.values(browser.state.model.tabs).map((t) => t.url)
const activeUrl = (browser: Browser, win: ZenWindow): string | undefined =>
  browser.tabs.activeTabFor(win)?.url
const only = (browser: Browser): ZenWindow => {
  const win = browser.allWindows()[0]
  if (!win) throw new Error('no window')
  return win
}

/** A connected agent that made a space of its own with a group and `tabs` pages in it. */
function agentWith(
  browser: Browser,
  win: ZenWindow,
  tabs: string[]
): { session: AgentSession; space: Space; tabIds: string[] } {
  const session = browser.agents.create(
    { transport: 'http', token: null, remoteAddress: '127.0.0.1', userAgent: 'test' },
    'session_1'
  )
  const space = browser.agents.createOwnSpace(session, { name: 'Agent' })
  const group = browser.agents.groupIn(session, space.id)
  const tabIds = tabs.map(
    (url) =>
      browser.tabs.createTab(
        { url, spaceId: space.id, folderId: group.id, active: false, load: false },
        win
      ).id
  )
  return { session, space, tabIds }
}

describe('an empty agents’ space never stays the window’s active space (W7-F3)', () => {
  describe('at a restore', () => {
    it('a window left on the empty Agents space comes back on the user space it left, with its tab', () => {
      const browser = fresh()
      const user = browser.state.model.spaces[0]
      const a = seedTab(browser, 'https://example.com/a')
      const agents = agentsSpace(browser)
      browser.state.restoredWindows = [window('window_1', agents.id, null, user.id)]
      browser.start()
      const win = only(browser)
      expect(win.activeSpaceId).toBe(user.id)
      expect(browser.tabs.activeTabFor(win)?.id).toBe(a)
      // Nothing was seeded into the agents' space: the user's one tab is all there is.
      expect(urls(browser)).toEqual(['https://example.com/a'])
      expect(agents.tabIds).toEqual([])
      // Standing on a user space again, the window has nothing to go back to.
      expect(win.lastUserSpaceId).toBeNull()
    })

    it('the profile read at boot already moves the remembered window (ensureValid)', () => {
      const browser = fresh()
      const m = browser.state.model
      const user = m.spaces[0]
      seedTab(browser, 'https://example.com/a')
      const agents = agentsSpace(browser)
      m.activeSpaceId = agents.id
      browser.state.restoredWindows = [window('window_1', agents.id, null, user.id)]
      browser.state.repair()
      expect(browser.state.restoredWindows[0].activeSpaceId).toBe(user.id)
      expect(m.activeSpaceId).toBe(user.id)
    })

    it('the last user space wins over the first when it is remembered; the first stands in when it is not', () => {
      const browser = fresh()
      const m = browser.state.model
      const first = m.spaces[0]
      seedTab(browser, 'https://example.com/a')
      const second = createSpace('Work', '', first.containerId)
      m.spaces.push(second)
      seedTab(browser, 'https://example.com/b', second)
      const agents = agentsSpace(browser)
      browser.state.restoredWindows = [
        window('window_1', agents.id, null, second.id),
        window('window_2', agents.id, null)
      ]
      browser.start()
      const wins = browser.allWindows()
      expect(wins.find((w) => w.id === 'window_1')?.activeSpaceId).toBe(second.id)
      expect(wins.find((w) => w.id === 'window_2')?.activeSpaceId).toBe(first.id)
      expect(urls(browser).sort()).toEqual(['https://example.com/a', 'https://example.com/b'])
    })

    it('a remembered last user space that is gone, or an agent’s now, is dropped', () => {
      const browser = fresh()
      const m = browser.state.model
      const user = m.spaces[0]
      seedTab(browser, 'https://example.com/a')
      const agents = agentsSpace(browser)
      const own = createSpace('Agent', '', user.containerId)
      own.agent = { kind: 'own', name: 'Agent', createdAt: 1 }
      m.spaces.push(own)
      browser.state.restoredWindows = [
        window('window_1', agents.id, null, 'space_gone'),
        window('window_2', agents.id, null, own.id)
      ]
      browser.state.repair()
      for (const w of browser.state.restoredWindows) {
        expect(w.lastUserSpaceId).toBeNull()
        expect(w.activeSpaceId).toBe(user.id)
      }
    })

    it('an agents’ space that still has tabs is not left: the rule is for the empty one', () => {
      const browser = fresh()
      const user = browser.state.model.spaces[0]
      seedTab(browser, 'https://example.com/a')
      const agents = agentsSpace(browser)
      const t = seedTab(browser, 'https://agent.example/result', agents)
      browser.state.restoredWindows = [window('window_1', agents.id, t, user.id)]
      browser.start()
      const win = only(browser)
      expect(win.activeSpaceId).toBe(agents.id)
      expect(browser.tabs.activeTabFor(win)?.id).toBe(t)
      expect(win.lastUserSpaceId).toBe(user.id)
    })

    it('with no user space at all the window keeps its space and gets its tab there, as Chrome’s would', () => {
      const browser = fresh()
      const m = browser.state.model
      const agents = agentsSpace(browser)
      m.spaces = m.spaces.filter((s) => s === agents)
      m.activeSpaceId = agents.id
      browser.state.restoredWindows = [window('window_1', agents.id, null)]
      browser.start()
      const win = only(browser)
      expect(win.activeSpaceId).toBe(agents.id)
      expect(activeUrl(browser, win)).toBe(NEW_TAB_URL)
      expect(urls(browser)).toEqual([NEW_TAB_URL])
    })

    it('the phone (no new tab page) comes up on the user’s space through the model’s default', () => {
      const browser = fresh({ windows: false, os: 'android' })
      const m = browser.state.model
      const user = m.spaces[0]
      const a = seedTab(browser, 'https://example.com/a')
      const agents = agentsSpace(browser)
      m.activeSpaceId = agents.id
      browser.state.restoredWindows = [window('window_1', agents.id, null, user.id)]
      browser.state.repair()
      expect(m.activeSpaceId).toBe(user.id)
      browser.start()
      const win = only(browser)
      expect(win.activeSpaceId).toBe(user.id)
      expect(browser.tabs.activeTabFor(win)?.id).toBe(a)
      expect(urls(browser)).toEqual(['https://example.com/a'])
    })
  })

  describe('at the agent session’s end', () => {
    it('the window the agent brought onto its space goes back to the user’s once the space is empty', () => {
      const browser = fresh()
      browser.start()
      const win = only(browser)
      const user = browser.state.model.spaces[0]
      const boot = browser.tabs.activeTabFor(win)!
      const { session, space, tabIds } = agentWith(browser, win, ['https://agent.example/1'])
      // The agent takes the screen (`bringInFront` → `activateTab`): the user's space is remembered.
      browser.tabs.activateTab(tabIds[0], win)
      expect(win.activeSpaceId).toBe(space.id)
      expect(win.lastUserSpaceId).toBe(user.id)
      // `zen_session end` closing its groups: the space empties, the window comes back.
      browser.agents.endSession(session, true)
      expect(win.activeSpaceId).toBe(user.id)
      expect(browser.tabs.activeTabFor(win)?.id).toBe(boot.id)
      expect(space.tabIds).toEqual([])
      expect(urls(browser)).toEqual([NEW_TAB_URL])
      expect(win.lastUserSpaceId).toBeNull()
    })

    it('a session that leaves its tabs behind (orphaned) leaves the window where it is', () => {
      const browser = fresh()
      browser.start()
      const win = only(browser)
      const { session, space, tabIds } = agentWith(browser, win, ['https://agent.example/1'])
      browser.tabs.activateTab(tabIds[0], win)
      browser.agents.endSession(session, false)
      expect(win.activeSpaceId).toBe(space.id)
      expect(browser.tabs.activeTabFor(win)?.id).toBe(tabIds[0])
    })

    it('the record’s close (disconnect) after the agent closed its tabs itself brings the window back too', () => {
      const browser = fresh()
      browser.start()
      const win = only(browser)
      const user = browser.state.model.spaces[0]
      const { session, space, tabIds } = agentWith(browser, win, ['https://agent.example/1'])
      browser.tabs.activateTab(tabIds[0], win)
      browser.tabs.closeTab(tabIds[0], true, win)
      // Zen's empty space: the window stays until the session is over.
      expect(win.activeSpaceId).toBe(space.id)
      browser.agents.close(session.id)
      expect(win.activeSpaceId).toBe(user.id)
    })

    it('nothing moves while the browser quits: the windows are remembered as they stand', () => {
      const browser = fresh()
      browser.start()
      const win = only(browser)
      const { session, space, tabIds } = agentWith(browser, win, ['https://agent.example/1'])
      browser.tabs.activateTab(tabIds[0], win)
      browser.quitting = true
      browser.agents.endSession(session, true)
      expect(win.activeSpaceId).toBe(space.id)
    })
  })

  describe('the count the user is asked about', () => {
    it('N user tabs and M agents’ tabs count N for the quit prompt and the window’s close', () => {
      const browser = fresh()
      browser.start()
      const win = only(browser)
      browser.tabs.createTab({ url: 'https://example.com/b', active: false, load: false }, win)
      agentWith(browser, win, [
        'https://agent.example/1',
        'https://agent.example/2',
        'https://agent.example/3'
      ])
      expect(Object.keys(browser.state.model.tabs)).toHaveLength(5)
      expect(browser.tabs.openTabCount()).toBe(2)
      expect(browser.tabs.closingTabCount(win)).toBe(2)
    })

    it('the quit prompt asks with the user’s count; one seeded new tab page is one tab and asks nothing', async () => {
      const browser = fresh()
      browser.start()
      const win = only(browser)
      agentWith(browser, win, ['https://agent.example/1', 'https://agent.example/2'])
      expect(browser.state.settings.warnOnCloseWindow).toBe(true)
      // The boot's `zen://newtab` alone: no question, however many tabs the agent has.
      expect(browser.tabs.openTabCount()).toBe(1)
      browser.tabs.createTab({ url: 'https://example.com/b', active: false, load: false }, win)
      const ask = vi.spyOn(browser.windowPrompts, 'ask').mockResolvedValue(false)
      expect(await browser.requestQuit(win)).toBe(false)
      expect(ask).toHaveBeenCalledTimes(1)
      expect(ask.mock.calls[0][2]).toBe(2)
    })
  })

  describe('userSpaceInstead', () => {
    it('leaves a user space, a non-empty agents’ space and an unknown id alone', () => {
      const user = createSpace('Home', '', 'default')
      const agents = createSpace('Agents', '', 'default')
      agents.agent = { kind: 'shared' }
      const busy = createSpace('Agent', '', 'default')
      busy.agent = { kind: 'own', name: 'Agent', createdAt: 1 }
      busy.tabIds.push('tab_1')
      const spaces = [user, agents, busy]
      expect(userSpaceInstead(spaces, user.id, null)).toBe(user.id)
      expect(userSpaceInstead(spaces, busy.id, user.id)).toBe(busy.id)
      expect(userSpaceInstead(spaces, 'space_gone', user.id)).toBe('space_gone')
      expect(userSpaceInstead(spaces, agents.id, null)).toBe(user.id)
      expect(userSpaceInstead(spaces, agents.id, busy.id)).toBe(user.id)
      expect(userSpaceInstead([agents], agents.id, user.id)).toBe(agents.id)
    })
  })
})
