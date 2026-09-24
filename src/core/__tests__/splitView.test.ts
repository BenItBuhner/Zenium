import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { Browser } from '../browser'
import { applicationMenu } from '../menuBar'
import type {
  MenuHost,
  MenuItemTemplate,
  PageContextParams,
  PageFlags,
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'
import type { ZenWindow } from '../window'

/*
 * The split view's active pane and the ways into a split (split-06, split-01, split-04): the pane
 * the user is in is the active tab, the menus open a split where Chrome's and Edge's users look,
 * and an empty pane takes a tab picked from the window's others.
 */

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

interface Harness {
  browser: Browser
  win: ZenWindow
  /** The events the core wired for a tab's page: the test plays the view's reports through them. */
  eventsOf: (tabId: string) => TabViewEvents
  /** The names of the events sent to the window's chrome, in order, with their payloads. */
  sent: { name: string; payload: unknown }[]
  /** The last template handed to the host's menu popup. */
  shown: () => MenuItemTemplate[]
  /** Every set of page flags the core pushed into a page, in order. */
  flags: { tabId: string; flags: PageFlags }[]
  /** The pages the core gave the keyboard to (`TabView.focus`), in order. */
  focused: string[]
  open: (url: string) => Tab
  activeId: () => string | undefined
}

function harness(): Harness {
  const events = new Map<string, TabViewEvents>()
  const sent: { name: string; payload: unknown }[] = []
  const flags: { tabId: string; flags: PageFlags }[] = []
  const focused: string[] = []
  let last: MenuItemTemplate[] = []
  const menus: MenuHost = {
    popup: (items) => {
      last = items
    }
  }
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '1.2.3' },
    capabilities: stub<HostCapabilities>({ windows: true }),
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
          isVisible: () => true,
          send: (name, payload) => void sent.push({ name, payload })
        })
    },
    views: stub<TabViewHost>({
      createView: (tab, tabEvents) => {
        events.set(tab.id, tabEvents)
        let url = ''
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          loadURL: (u) => {
            url = u
          },
          getURL: () => url,
          getTitle: () => '',
          hasDocument: () => url !== '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          isCurrentlyAudible: () => false,
          sendPageFlags: (next) => void flags.push({ tabId: tab.id, flags: next }),
          focus: () => void focused.push(tab.id),
          executeJavaScript: () => Promise.resolve(undefined)
        })
      }
    }),
    menus,
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  return {
    browser,
    win,
    sent,
    flags,
    focused,
    shown: () => last,
    eventsOf: (tabId) => {
      const e = events.get(tabId)
      if (!e) throw new Error(`no page for ${tabId}`)
      return e
    },
    open: (url) => browser.tabs.createTab({ url, active: true }, win),
    activeId: () => browser.tabs.activeTabFor(win)?.id
  }
}

describe('the active pane of a split (split-06)', () => {
  it('goes to the pane whose page took the keyboard, and the omnibox with it', () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    h.browser.tabs.createSplit([a.id, b.id], 'vertical', h.win)
    expect(h.activeId()).toBe(b.id)
    h.eventsOf(a.id).onFocused?.()
    expect(h.activeId()).toBe(a.id)
    // The chrome's address pill follows the active tab: the state it is sent names a's tab.
    const state = h.browser.state.snapshot(h.win)
    expect(state.spaces.find((s) => s.id === h.win.activeSpaceId)?.activeTabId).toBe(a.id)
  })

  it('goes to the pane a press or a key landed in', () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    h.browser.tabs.createSplit([a.id, b.id], 'horizontal', h.win)
    h.eventsOf(a.id).onUserActivation()
    expect(h.activeId()).toBe(a.id)
    h.eventsOf(b.id).onUserActivation()
    expect(h.activeId()).toBe(b.id)
    // The active pane's own input changes nothing.
    h.eventsOf(b.id).onUserActivation()
    h.eventsOf(b.id).onFocused?.()
    expect(h.activeId()).toBe(b.id)
  })

  it('is not traded with a page outside the shown split', () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    const c = h.open('https://c.example/')
    const d = h.open('https://d.example/')
    h.browser.tabs.createSplit([a.id, b.id], 'vertical', h.win)
    h.browser.tabs.createSplit([c.id, d.id], 'vertical', h.win)
    h.browser.tabs.activateTab(b.id, h.win)
    expect(h.activeId()).toBe(b.id)
    // A pane of another split, or a tab of no split, reporting focus leaves the active tab alone.
    h.eventsOf(c.id).onFocused?.()
    h.eventsOf(d.id).onUserActivation()
    expect(h.activeId()).toBe(b.id)
    const e = h.open('https://e.example/')
    h.browser.tabs.activateTab(b.id, h.win)
    h.eventsOf(e.id).onFocused?.()
    expect(h.activeId()).toBe(b.id)
  })

  it('moves along the split on the pane chords and around its end; outside a split they do nothing', () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    const c = h.open('https://c.example/')
    h.browser.tabs.createSplit([a.id, b.id, c.id], 'grid', h.win)
    h.browser.tabs.activateTab(a.id, h.win)
    h.browser.actions.run('split.nextPane', { sourceTabId: null, win: h.win })
    expect(h.activeId()).toBe(b.id)
    h.browser.actions.run('split.nextPane', { sourceTabId: null, win: h.win })
    h.browser.actions.run('split.nextPane', { sourceTabId: null, win: h.win })
    expect(h.activeId()).toBe(a.id)
    h.browser.actions.run('split.prevPane', { sourceTabId: null, win: h.win })
    expect(h.activeId()).toBe(c.id)
    const lone = h.open('https://lone.example/')
    h.browser.actions.run('split.nextPane', { sourceTabId: null, win: h.win })
    expect(h.activeId()).toBe(lone.id)
  })
})

/** Labels in order, separators as `-`. */
const labels = (items: MenuItemTemplate[]): string[] =>
  items.map((item) => (item.type === 'separator' ? '-' : (item.label ?? '')))

function submenu(items: MenuItemTemplate[], label: string): MenuItemTemplate[] {
  const item = items.find((i) => i.label === label)
  if (!item?.submenu) throw new Error(`no submenu "${label}"`)
  return item.submenu
}

function click(items: MenuItemTemplate[], label: string): void {
  const item = items.find((i) => i.label === label)
  if (!item?.click) throw new Error(`no clickable item "${label}"`)
  item.click()
}

/** The deferred state broadcast has gone out (and with it what `afterBroadcast` queued). */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('the empty pane (split-04)', () => {
  it('Ctrl+Shift+* with one tab opens an empty pane beside it; the URL bar follows the state that holds the split (BUG-040)', async () => {
    const h = harness()
    const a = h.open('https://a.example/')
    h.sent.length = 0
    h.browser.actions.run('split.newEmpty', { sourceTabId: null, win: h.win })
    const group = Object.values(h.browser.state.model.splitGroups)[0]
    expect(group).toBeDefined()
    expect(group!.tabIds[0]).toBe(a.id)
    expect(group!.tabIds).toHaveLength(2)
    const blank = h.browser.tabs.tab(group!.tabIds[1])
    expect(blank?.url).toBe('zen://blank')
    expect(h.activeId()).toBe(blank?.id)
    // The bar's request waits for the broadcast: the window must hold the split for the bar to
    // open as the pane's field rather than over the whole frame.
    expect(h.sent.some((e) => e.name === 'urlbar.toggle')).toBe(false)
    await tick()
    expect(h.sent.some((e) => e.name === 'urlbar.toggle')).toBe(true)
  })

  it('a chosen tab takes the empty pane over and the blank tab closes', () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    h.browser.tabs.activateTab(a.id, h.win)
    h.browser.tabs.newEmptySplit(h.win)
    const group = Object.values(h.browser.state.model.splitGroups)[0]!
    const blank = group.tabIds[1]
    expect(h.browser.handleCommand(h.win, 'split.pickTab', { paneTabId: blank, tabId: b.id })).toBe(
      true
    )
    expect(h.browser.state.model.splitGroups[group.id]?.tabIds).toEqual([a.id, b.id])
    expect(h.browser.tabs.tab(blank)).toBeUndefined()
    expect(h.browser.tabs.tab(b.id)?.splitGroupId).toBe(group.id)
    expect(h.activeId()).toBe(b.id)
    // Nothing the user made was closed: the blank tab leaves no "Recently closed" entry.
    expect(h.browser.state.snapshot(h.win).recentlyClosed).toHaveLength(0)
  })

  it('picks nothing for a pane that is not empty, a tab already in the split, or the pane itself', () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    const c = h.open('https://c.example/')
    h.browser.tabs.activateTab(a.id, h.win)
    h.browser.tabs.newEmptySplit(h.win)
    const group = Object.values(h.browser.state.model.splitGroups)[0]!
    const blank = group.tabIds[1]
    const pick = (paneTabId: string, tabId: string): boolean =>
      h.browser.handleCommand(h.win, 'split.pickTab', { paneTabId, tabId }) as boolean
    expect(pick(a.id, b.id)).toBe(false)
    expect(pick(blank, a.id)).toBe(false)
    expect(pick(blank, blank)).toBe(false)
    expect(h.browser.state.model.splitGroups[group.id]?.tabIds).toEqual([a.id, blank])
    expect(pick(blank, c.id)).toBe(true)
    expect(h.browser.state.model.splitGroups[group.id]?.tabIds).toEqual([a.id, c.id])
    expect(h.browser.tabs.tab(b.id)?.splitGroupId).toBeNull()
  })
})

describe('the ways into a split (split-01)', () => {
  it('the app menu has a Split View submenu under More Tools (§6: Firefox\u2019s groups, the rest in submenus): the layouts in the chords\u2019 order, then Unsplit View and New Empty Split View, each on its action', () => {
    const h = harness()
    h.open('https://a.example/')
    h.browser.handleCommand(h.win, 'app.menu', {})
    const items = submenu(submenu(h.shown(), 'More Tools'), 'Split View')
    expect(labels(items)).toEqual([
      'Grid',
      'Vertical',
      'Horizontal',
      '-',
      'Swap Panes',
      'Unsplit View',
      'New Empty Split View'
    ])
    expect(items.map((i) => i.action)).toEqual([
      'split.grid',
      'split.vertical',
      'split.horizontal',
      undefined,
      'split.swap',
      'split.unsplit',
      'split.newEmpty'
    ])
    // The chord shows after each layout: the menu mirrors Ctrl+Alt+G / V / H.
    expect(items.slice(0, 3).map((i) => i.accelerator)).toEqual([
      'Ctrl+Alt+G',
      'Ctrl+Alt+V',
      'Ctrl+Alt+H'
    ])
    // Out of a split no layout is checked and there is nothing to swap or unsplit.
    expect(items.slice(0, 3).every((i) => i.type === 'checkbox' && i.checked === false)).toBe(true)
    expect(items[4].enabled).toBe(false)
    expect(items[5].enabled).toBe(false)
  })

  it('a layout item splits the active tab with the one below it; in a split the layout is checked and another turns it', () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    h.browser.tabs.activateTab(a.id, h.win)
    h.browser.handleCommand(h.win, 'app.menu', {})
    click(submenu(submenu(h.shown(), 'More Tools'), 'Split View'), 'Vertical')
    const group = Object.values(h.browser.state.model.splitGroups)[0]
    expect(group?.layout).toBe('vertical')
    expect(group?.tabIds).toEqual([a.id, b.id])

    h.browser.handleCommand(h.win, 'app.menu', {})
    let items = submenu(submenu(h.shown(), 'More Tools'), 'Split View')
    expect(items.find((i) => i.label === 'Vertical')?.checked).toBe(true)
    expect(items.find((i) => i.label === 'Grid')?.checked).toBe(false)
    expect(items.find((i) => i.label === 'Unsplit View')?.enabled).toBe(true)
    click(items, 'Grid')
    expect(h.browser.state.model.splitGroups[group!.id]?.layout).toBe('grid')

    h.browser.handleCommand(h.win, 'app.menu', {})
    items = submenu(submenu(h.shown(), 'More Tools'), 'Split View')
    click(items, 'Unsplit View')
    expect(Object.keys(h.browser.state.model.splitGroups)).toHaveLength(0)
    expect(h.browser.tabs.tab(a.id)?.splitGroupId).toBeNull()
  })

  it('the macOS View menu carries the same submenu', () => {
    const h = harness()
    h.open('https://a.example/')
    const view = submenu(applicationMenu(h.browser), 'View')
    expect(labels(submenu(view, 'Split View'))).toEqual([
      'Grid',
      'Vertical',
      'Horizontal',
      '-',
      'Swap Panes',
      'Unsplit View',
      'New Empty Split View'
    ])
  })

  it('the tab row menu keeps Split with Current Tab', () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: a.id })
    expect(labels(h.shown())).toContain('Split with Current Tab')
    click(h.shown(), 'Split with Current Tab')
    const group = Object.values(h.browser.state.model.splitGroups)[0]
    expect(group?.tabIds.sort()).toEqual([a.id, b.id].sort())
  })
})

describe('the split view drag and drop switch (split-12)', () => {
  it('is on by default, turns off and on again, and reads anything but false as on', () => {
    const h = harness()
    expect(h.browser.state.settings.splitEdgeZones).toBe(true)
    h.browser.handleCommand(h.win, 'settings.update', { splitEdgeZones: false })
    expect(h.browser.state.settings.splitEdgeZones).toBe(false)
    expect(h.browser.state.snapshot(h.win).settings.splitEdgeZones).toBe(false)
    h.browser.handleCommand(h.win, 'settings.update', {
      splitEdgeZones: 'yes' as unknown as boolean
    })
    expect(h.browser.state.settings.splitEdgeZones).toBe(true)
  })
})

describe('Swap Panes (split-07)', () => {
  const groupOf = (h: Harness): { tabIds: string[]; sizes: number[] } => {
    const group = Object.values(h.browser.state.model.splitGroups)[0]
    if (!group) throw new Error('no split')
    return { tabIds: group.tabIds, sizes: group.sizes }
  }

  it('reverses a two-pane split from the command, each tab keeping its size, the active pane staying active', () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    h.browser.tabs.createSplit([a.id, b.id], 'vertical', h.win)
    const id = Object.keys(h.browser.state.model.splitGroups)[0]
    h.browser.tabs.resizeSplit(id, [0.7, 0.3])
    h.browser.tabs.activateTab(a.id, h.win)
    h.browser.actions.run('split.swap', { sourceTabId: null, win: h.win })
    expect(groupOf(h).tabIds).toEqual([b.id, a.id])
    expect(groupOf(h).sizes.map((s) => Math.round(s * 10))).toEqual([3, 7])
    expect(h.activeId()).toBe(a.id)
    // The command names a pane: the same swap from b's row.
    h.browser.handleCommand(h.win, 'split.swap', { tabId: b.id })
    expect(groupOf(h).tabIds).toEqual([a.id, b.id])
    expect(groupOf(h).sizes.map((s) => Math.round(s * 10))).toEqual([7, 3])
  })

  it('in a grid a pane trades with the one after it, the last with the one before it', () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    const c = h.open('https://c.example/')
    h.browser.tabs.createSplit([a.id, b.id, c.id], 'grid', h.win)
    h.browser.handleCommand(h.win, 'split.swap', { tabId: b.id })
    expect(groupOf(h).tabIds).toEqual([a.id, c.id, b.id])
    h.browser.handleCommand(h.win, 'split.swap', { tabId: b.id })
    expect(groupOf(h).tabIds).toEqual([a.id, b.id, c.id])
  })

  it('does nothing outside a split, and for a tab that is not there', () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    const before = h.browser.state.snapshot(h.win)
    h.browser.actions.run('split.swap', { sourceTabId: null, win: h.win })
    h.browser.handleCommand(h.win, 'split.swap', { tabId: 'nowhere' })
    expect(Object.keys(h.browser.state.model.splitGroups)).toHaveLength(0)
    expect(h.browser.state.snapshot(h.win).tabs).toEqual(before.tabs)
    h.browser.tabs.createSplit([a.id, b.id], 'vertical', h.win)
    const lone = h.open('https://lone.example/')
    h.browser.handleCommand(h.win, 'split.swap', { tabId: lone.id })
    expect(groupOf(h).tabIds).toEqual([a.id, b.id])
  })

  it('is a row of the tab row’s menu beside Un-split Tab, for a tab of a split only', () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: a.id })
    expect(labels(h.shown())).not.toContain('Swap Panes')
    h.browser.tabs.createSplit([a.id, b.id], 'vertical', h.win)
    h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: a.id })
    const items = labels(h.shown())
    expect(items.indexOf('Swap Panes')).toBe(items.indexOf('Un-split Tab') - 1)
    click(h.shown(), 'Swap Panes')
    expect(groupOf(h).tabIds).toEqual([b.id, a.id])
  })

  it('is the first row of the pane header’s menu, with the link rule and Un-split Tab; a tab outside a split has no menu', () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    h.browser.handleCommand(h.win, 'split.paneMenu', { tabId: a.id, x: 10, y: 20 })
    expect(h.shown()).toEqual([])
    h.browser.tabs.createSplit([a.id, b.id], 'vertical', h.win)
    h.browser.handleCommand(h.win, 'split.paneMenu', { tabId: b.id, x: 10, y: 20 })
    expect(labels(h.shown())).toEqual([
      'Swap Panes',
      '-',
      'Open Links from Left Pane in Right Pane',
      '-',
      'Un-split Tab'
    ])
    const rule = h.shown().find((i) => i.label === 'Open Links from Left Pane in Right Pane')!
    expect(rule.type).toBe('checkbox')
    expect(rule.checked).toBe(false)
    expect(rule.enabled).toBe(true)
    click(h.shown(), 'Swap Panes')
    expect(groupOf(h).tabIds).toEqual([b.id, a.id])
    // The checkbox writes the one setting, and reads it back.
    click(h.shown(), 'Open Links from Left Pane in Right Pane')
    expect(h.browser.state.settings.splitLinksToRight).toBe(true)
    h.browser.handleCommand(h.win, 'split.paneMenu', { tabId: b.id })
    expect(
      h.shown().find((i) => i.label === 'Open Links from Left Pane in Right Pane')?.checked
    ).toBe(true)
    // A stacked split has no left and right: the row is greyed.
    h.browser.tabs.setSplitLayout(Object.keys(h.browser.state.model.splitGroups)[0], 'horizontal')
    h.browser.handleCommand(h.win, 'split.paneMenu', { tabId: b.id })
    expect(
      h.shown().find((i) => i.label === 'Open Links from Left Pane in Right Pane')?.enabled
    ).toBe(false)
    click(h.shown(), 'Un-split Tab')
    expect(Object.keys(h.browser.state.model.splitGroups)).toHaveLength(0)
  })
})

describe('links from the left pane open in the right pane (split-13)', () => {
  const linkFlags = (h: Harness): { tabId: string; linksToSplitPane: boolean }[] =>
    h.flags.map((f) => ({ tabId: f.tabId, linksToSplitPane: f.flags.linksToSplitPane }))

  it('is off by default and reads anything but true as off', () => {
    const h = harness()
    expect(h.browser.state.settings.splitLinksToRight).toBe(false)
    h.browser.handleCommand(h.win, 'settings.update', { splitLinksToRight: true })
    expect(h.browser.state.snapshot(h.win).settings.splitLinksToRight).toBe(true)
    h.browser.handleCommand(h.win, 'settings.update', {
      splitLinksToRight: 'yes' as unknown as boolean
    })
    expect(h.browser.state.settings.splitLinksToRight).toBe(false)
  })

  it('tells the left pane’s page alone, and only in a side-by-side split, once the rule is on', async () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    h.browser.tabs.sendPageFlags(a.id)
    h.browser.tabs.sendPageFlags(b.id)
    expect(linkFlags(h)).toEqual([
      { tabId: a.id, linksToSplitPane: false },
      { tabId: b.id, linksToSplitPane: false }
    ])
    h.flags.length = 0
    h.browser.tabs.createSplit([a.id, b.id], 'vertical', h.win)
    h.browser.handleCommand(h.win, 'settings.update', { splitLinksToRight: true })
    expect(linkFlags(h)).toEqual([
      { tabId: a.id, linksToSplitPane: true },
      { tabId: b.id, linksToSplitPane: false }
    ])
    await tick()
    h.flags.length = 0
    // Stacked, there is no left and right; side by side again, there is. The layout's turn is
    // the split's, and reaches the one page whose answer changed after the broadcast.
    const id = Object.keys(h.browser.state.model.splitGroups)[0]
    h.browser.tabs.setSplitLayout(id, 'horizontal')
    await tick()
    expect(linkFlags(h)).toEqual([{ tabId: a.id, linksToSplitPane: false }])
    h.flags.length = 0
    h.browser.tabs.setSplitLayout(id, 'grid')
    await tick()
    expect(linkFlags(h)).toEqual([{ tabId: a.id, linksToSplitPane: true }])
  })

  it('follows a swap: after the broadcast the pages whose answer changed hear it, the others are not written to', async () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    const lone = h.open('https://lone.example/')
    for (const t of [a, b, lone]) h.browser.tabs.sendPageFlags(t.id)
    h.browser.tabs.createSplit([a.id, b.id], 'vertical', h.win)
    h.browser.handleCommand(h.win, 'settings.update', { splitLinksToRight: true })
    await tick()
    h.flags.length = 0
    h.browser.handleCommand(h.win, 'split.swap', { tabId: a.id })
    await tick()
    expect(linkFlags(h).sort((x, y) => x.tabId.localeCompare(y.tabId))).toEqual(
      [
        { tabId: a.id, linksToSplitPane: false },
        { tabId: b.id, linksToSplitPane: true }
      ].sort((x, y) => x.tabId.localeCompare(y.tabId))
    )
    h.flags.length = 0
    // Un-split: the left pane's page hears the rule is gone; nothing else is touched.
    h.browser.tabs.unsplit(undefined, b.id, h.win)
    await tick()
    expect(linkFlags(h)).toEqual([{ tabId: b.id, linksToSplitPane: false }])
  })

  it('a link clicked in the left pane loads in the right pane, the left pane staying active: the load’s keyboard grabs are handed back to the left pane until the right’s document is ready (§9.35)', async () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    h.browser.tabs.createSplit([a.id, b.id], 'vertical', h.win)
    h.browser.handleCommand(h.win, 'settings.update', { splitLinksToRight: true })
    h.browser.tabs.activateTab(a.id, h.win)
    h.browser.handlePageMessage(a.id, { type: 'split-link', url: 'https://a.example/story' })
    expect(h.browser.tabs.tab(b.id)?.url).toBe('https://a.example/story')
    expect(h.browser.tabs.tab(a.id)?.url).toBe('https://a.example/')
    expect(h.activeId()).toBe(a.id)
    // Chromium gives the right pane's new document the keyboard as it commits – twice on the
    // desktop host, both before `dom-ready`. Neither grab activates the right pane, and each is
    // handed back to the left pane a tick later (asked for inside the grab it would not move).
    h.eventsOf(b.id).onFocused?.()
    expect(h.activeId()).toBe(a.id)
    expect(h.focused).toEqual([])
    await tick()
    expect(h.focused).toEqual([a.id])
    h.eventsOf(b.id).onFocused?.()
    await tick()
    expect(h.focused).toEqual([a.id, a.id])
    expect(h.activeId()).toBe(a.id)
    // The chrome never heard the right pane take the keyboard: the pill keeps the left's address.
    expect(h.sent.filter((s) => s.name === 'focus.page')).toEqual([])
    // The document is ready: the load's grabs are over, and a later grab is the user's own click
    // in the right pane, which activates it as ever.
    h.eventsOf(b.id).onDomReady()
    h.eventsOf(b.id).onFocused?.()
    await tick()
    expect(h.activeId()).toBe(b.id)
    expect(h.focused).toEqual([a.id, a.id])
  })

  it('the hand-back yields to the user: their own press in the right pane mid-load activates it, and a right pane they activated through its header keeps the keyboard', async () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    h.browser.tabs.createSplit([a.id, b.id], 'vertical', h.win)
    h.browser.handleCommand(h.win, 'settings.update', { splitLinksToRight: true })
    h.browser.tabs.activateTab(a.id, h.win)
    h.browser.handlePageMessage(a.id, { type: 'split-link', url: 'https://a.example/story' })
    // A trusted press in the right pane while it loads: the user moved there.
    h.eventsOf(b.id).onUserActivation()
    expect(h.activeId()).toBe(b.id)
    h.eventsOf(b.id).onFocused?.()
    await tick()
    expect(h.focused).toEqual([])
    // A second routed link, then the right pane activated from the chrome (its header): the
    // load's grab is an ordinary one now – nothing is handed back.
    h.browser.tabs.activateTab(a.id, h.win)
    h.browser.handlePageMessage(a.id, { type: 'split-link', url: 'https://a.example/next' })
    h.browser.tabs.activateTab(b.id, h.win)
    h.eventsOf(b.id).onFocused?.()
    await tick()
    expect(h.focused).toEqual([])
    expect(h.activeId()).toBe(b.id)
    // Un-split before the grab lands: no longer panes of one split, the grab is the page's own.
    h.browser.tabs.activateTab(a.id, h.win)
    h.browser.handlePageMessage(a.id, { type: 'split-link', url: 'https://a.example/last' })
    h.browser.tabs.unsplit(undefined, a.id, h.win)
    h.eventsOf(b.id).onFocused?.()
    await tick()
    expect(h.focused).toEqual([])
  })

  it('a click the page had already given up loads where it was clicked when the rule no longer holds', () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    h.browser.tabs.createSplit([a.id, b.id], 'vertical', h.win)
    h.browser.handleCommand(h.win, 'settings.update', { splitLinksToRight: true })
    // The split dissolved before the message landed.
    h.browser.tabs.unsplit(undefined, a.id, h.win)
    h.browser.handlePageMessage(a.id, { type: 'split-link', url: 'https://a.example/story' })
    expect(h.browser.tabs.tab(a.id)?.url).toBe('https://a.example/story')
    expect(h.browser.tabs.tab(b.id)?.url).toBe('https://b.example/')
    // From the right pane the rule never applied: the link is the pane's own.
    h.browser.tabs.createSplit([a.id, b.id], 'vertical', h.win)
    h.browser.handlePageMessage(b.id, { type: 'split-link', url: 'https://b.example/next' })
    expect(h.browser.tabs.tab(b.id)?.url).toBe('https://b.example/next')
    expect(h.browser.tabs.tab(a.id)?.url).toBe('https://a.example/story')
  })
})

describe('the split rows of the link menu and the tab row’s menu (context-menus-24, -92)', () => {
  const linkParams = (url: string): PageContextParams => ({
    x: 120,
    y: 240,
    linkURL: 'https://link.example/next',
    srcURL: '',
    mediaType: 'none',
    selectionText: '',
    isEditable: false,
    misspelledWord: '',
    dictionarySuggestions: [],
    pageURL: url,
    frameURL: '',
    frameId: 0,
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canDelete: false,
      canSelectAll: false
    }
  })
  const linkMenu = (h: Harness, tab: Tab): MenuItemTemplate[] => {
    h.eventsOf(tab.id).onContextMenu(linkParams(tab.url))
    return h.shown()
  }
  const find = (items: MenuItemTemplate[], label: string): MenuItemTemplate => {
    const item = items.find((i) => i.label === label)
    if (!item) throw new Error(`no row "${label}"`)
    return item
  }
  const groupOf = (h: Harness): string[] =>
    Object.values(h.browser.state.model.splitGroups)[0]?.tabIds ?? []

  it('Open Link in Split View is greyed once the page’s split is full, and opens the link as a pane until then', () => {
    const h = harness()
    const a = h.open('https://a.example/')
    expect(find(linkMenu(h, a), 'Open Link in Split View').enabled).toBe(true)
    click(linkMenu(h, a), 'Open Link in Split View')
    expect(groupOf(h)).toHaveLength(2)
    expect(h.browser.tabs.tab(groupOf(h)[1])?.url).toBe('https://link.example/next')
    click(linkMenu(h, a), 'Open Link in Split View')
    click(linkMenu(h, a), 'Open Link in Split View')
    expect(groupOf(h)).toHaveLength(4)
    expect(find(linkMenu(h, a), 'Open Link in Split View').enabled).toBe(false)
  })

  it('is greyed on a page that cannot be split, and is not offered on the phone', () => {
    const h = harness()
    // A chrome page is the chrome's own (no page menu comes from it): its rule reads greyed.
    const settings = h.open('zen://settings')
    expect(h.browser.pages.splittable(settings)).toBe(false)
    expect(h.browser.tabs.canSplitLink(settings)).toBe(false)
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    h.browser.handleCommand(h.win, 'window.formFactor', { formFactor: 'phone' })
    expect(labels(linkMenu(h, a))).not.toContain('Open Link in Split View')
    h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: a.id })
    expect(labels(h.shown())).not.toContain('Split with Current Tab')
    expect(labels(h.shown())).not.toContain('Add Tab to Split View')
    h.browser.tabs.createSplit([a.id, b.id], 'vertical', h.win)
    h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: a.id })
    expect(labels(h.shown())).not.toContain('Un-split Tab')
  })

  it('Add Tab to Split View is offered while a split is on screen, after Split with Current Tab, and joins the tab as the last pane, shown', () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    const c = h.open('https://c.example/')
    h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: c.id })
    expect(labels(h.shown())).not.toContain('Add Tab to Split View')
    h.browser.tabs.createSplit([a.id, b.id], 'vertical', h.win)
    h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: c.id })
    const rows = labels(h.shown())
    expect(rows.indexOf('Add Tab to Split View')).toBe(rows.indexOf('Split with Current Tab') + 1)
    expect(find(h.shown(), 'Add Tab to Split View').enabled).toBe(true)
    click(h.shown(), 'Add Tab to Split View')
    expect(groupOf(h)).toEqual([a.id, b.id, c.id])
    expect(h.activeId()).toBe(c.id)
  })

  it('is greyed for a pane of the split, for a page that cannot be split, and once the split is full', () => {
    const h = harness()
    const a = h.open('https://a.example/')
    const b = h.open('https://b.example/')
    const settings = h.open('zen://settings')
    h.browser.tabs.createSplit([a.id, b.id], 'vertical', h.win)
    h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: a.id })
    expect(find(h.shown(), 'Add Tab to Split View').enabled).toBe(false)
    expect(labels(h.shown())).toContain('Un-split Tab')
    h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: settings.id })
    expect(find(h.shown(), 'Add Tab to Split View').enabled).toBe(false)
    const c = h.open('https://c.example/')
    const d = h.open('https://d.example/')
    const e = h.open('https://e.example/')
    h.browser.tabs.activateTab(a.id, h.win)
    for (const t of [c, d]) {
      h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: t.id })
      click(h.shown(), 'Add Tab to Split View')
    }
    expect(groupOf(h)).toEqual([a.id, b.id, c.id, d.id])
    h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: e.id })
    expect(find(h.shown(), 'Add Tab to Split View').enabled).toBe(false)
    expect(h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: e.id })).toBeUndefined()
  })
})
