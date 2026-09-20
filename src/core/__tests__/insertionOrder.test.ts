import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { Browser } from '../browser'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import type { ZenWindow } from '../window'

/**
 * Insertion order (tabs-30): consecutive background opens from one page land in order after it
 * (an opener group), not reversed; closing the active tab returns to its opener when the user
 * never switched away from it since it opened, else to the neighbour (next, then previous).
 */

function memoryIo(): StoreIO {
  const files: Record<string, string> = {}
  return {
    readSync: (name) => files[name] ?? null,
    write: async (name, text) => void (files[name] = text),
    writeSync: (name, text) => void (files[name] = text)
  }
}

function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

function fakeView(): TabView {
  let url = ''
  const overrides: Partial<TabView> = {
    isDestroyed: () => false,
    isVisible: () => false,
    loadURL: (u) => void (url = u),
    getURL: () => url,
    getTitle: () => '',
    hasDocument: () => url !== '',
    canGoBack: () => false,
    canGoForward: () => false,
    getZoom: () => 1,
    isCurrentlyAudible: () => false,
    navigationEntries: () => ({ entries: [], index: -1 })
  }
  return new Proxy(overrides as TabView, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

interface Harness {
  browser: Browser
  win: ZenWindow
  /** Open a tab; a background open with an opener is the link-in-new-tab / window.open case. */
  open: (url: string, opts?: { active?: boolean; openerTabId?: string }) => Tab
  /** The ids of the window space's regular tabs, in strip order. */
  order: () => string[]
  /** The active tab's id in the window's space. */
  active: () => string | null
  /** Activate a tab the way the user does (a click / Ctrl+Tab): a real switch. */
  select: (tabId: string) => void
}

function harness(): Harness {
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '1.2.3' },
    capabilities: stub<HostCapabilities>({ windows: true, nativeMenus: true }),
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
    views: stub<TabViewHost>({ createView: () => fakeView() }),
    menus: { popup: () => undefined },
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
  const regular = (): Tab[] =>
    win
      .activeSpace()
      .tabIds.map((id) => browser.state.model.tabs[id])
      .filter((t): t is Tab => Boolean(t) && !t.pinned && !t.essential)
  return {
    browser,
    win,
    open: (url, opts = {}) =>
      browser.tabs.createTab(
        { url, active: opts.active ?? true, openerTabId: opts.openerTabId },
        win
      ),
    order: () => regular().map((t) => t.id),
    active: () => win.selectedTabIn(win.activeSpace()),
    select: (tabId) => browser.handleCommand(win, 'tab.activate', { tabId })
  }
}

/** Short labels for a readable order assertion: the opener O, its children by open order. */
function label(h: Harness, ids: Record<string, string>): string[] {
  const names = new Map(Object.entries(ids).map(([name, id]) => [id, name]))
  return h.order().map((id) => names.get(id) ?? id)
}

describe('opener group ordering (tabs-30)', () => {
  it('lands consecutive background opens from one opener in order after it, not reversed', () => {
    const h = harness()
    const opener = h.open('https://opener.test/')
    const a = h.open('https://a.test/', { active: false, openerTabId: opener.id })
    const b = h.open('https://b.test/', { active: false, openerTabId: opener.id })
    const c = h.open('https://c.test/', { active: false, openerTabId: opener.id })
    // Chrome: opener, A, B, C – not opener, C, B, A.
    expect(label(h, { O: opener.id, A: a.id, B: b.id, C: c.id })).toEqual(['O', 'A', 'B', 'C'])
  })

  it('keeps a child’s own opens with it inside the group', () => {
    const h = harness()
    const opener = h.open('https://opener.test/')
    const a = h.open('https://a.test/', { active: false, openerTabId: opener.id })
    // A opens its own child before the opener opens its second child.
    const a1 = h.open('https://a1.test/', { active: false, openerTabId: a.id })
    const b = h.open('https://b.test/', { active: false, openerTabId: opener.id })
    // A's child stays under A; B follows the group: opener, A, A1, B.
    expect(label(h, { O: opener.id, A: a.id, A1: a1.id, B: b.id })).toEqual(['O', 'A', 'A1', 'B'])
  })

  it('a tab opened with no opener still goes right after the current tab (unchanged)', () => {
    const h = harness()
    const first = h.open('https://first.test/')
    const opener = h.open('https://opener.test/')
    // A plain new tab next to the current one (the new-tab-position path), no grouping.
    const plain = h.browser.tabs.createTab(
      { url: 'https://plain.test/', active: false, afterTabId: opener.id },
      h.win
    )
    expect(label(h, { F: first.id, O: opener.id, P: plain.id })).toEqual(['F', 'O', 'P'])
  })
})

describe('opener activation on close (tabs-30)', () => {
  it('returns to the opener when the foreground child is closed without ever leaving it', () => {
    const h = harness()
    const opener = h.open('https://opener.test/')
    h.open('https://other.test/')
    h.select(opener.id)
    // A link opens a foreground child of the opener; the user closes it straight away.
    const child = h.open('https://child.test/', { active: true, openerTabId: opener.id })
    expect(h.active()).toBe(child.id)
    h.browser.tabs.closeTab(child.id, false, h.win)
    expect(h.active()).toBe(opener.id)
  })

  it('returns to the opener from a background child the user activated but never switched away from', () => {
    const h = harness()
    const opener = h.open('https://opener.test/')
    h.select(opener.id)
    const child = h.open('https://child.test/', { active: false, openerTabId: opener.id })
    // The user clicks the child, then closes it: they never switched away from it.
    h.select(child.id)
    expect(h.active()).toBe(child.id)
    h.browser.tabs.closeTab(child.id, false, h.win)
    expect(h.active()).toBe(opener.id)
  })

  it('goes to the neighbour, not the opener, once the user switched away from the child', () => {
    const h = harness()
    const opener = h.open('https://opener.test/')
    const other = h.open('https://other.test/')
    h.select(opener.id)
    const child = h.open('https://child.test/', { active: true, openerTabId: opener.id })
    // The user leaves the child for another tab, then comes back and closes it.
    h.select(other.id)
    h.select(child.id)
    h.browser.tabs.closeTab(child.id, false, h.win)
    // The opener link is broken: the neighbour rule stands (next, else previous).
    expect(h.active()).not.toBe(opener.id)
    expect(h.active()).toBe(other.id)
  })

  it('falls back to the neighbour when the opener is gone', () => {
    const h = harness()
    const opener = h.open('https://opener.test/')
    const other = h.open('https://other.test/')
    h.select(opener.id)
    const child = h.open('https://child.test/', { active: true, openerTabId: opener.id })
    h.browser.tabs.closeTab(opener.id, false, h.win)
    // The child is active again after its opener closed; closing it now has no opener to reach.
    h.select(child.id)
    h.browser.tabs.closeTab(child.id, false, h.win)
    expect(h.active()).toBe(other.id)
  })

  it('a tab with no opener closes to the neighbour as before', () => {
    const h = harness()
    const a = h.open('https://a.test/')
    const b = h.open('https://b.test/')
    const c = h.open('https://c.test/')
    h.select(b.id)
    h.browser.tabs.closeTab(b.id, false, h.win)
    // Next in order after B is C.
    expect(h.active()).toBe(c.id)
    void a
  })

  it('reversing the strip: closing the opener group’s children returns up the chain', () => {
    const h = harness()
    const opener = h.open('https://opener.test/')
    h.select(opener.id)
    // Two foreground children in a row, each the previous tab’s child.
    const a = h.open('https://a.test/', { active: true, openerTabId: opener.id })
    const b = h.open('https://b.test/', { active: true, openerTabId: a.id })
    expect(h.active()).toBe(b.id)
    h.browser.tabs.closeTab(b.id, false, h.win)
    expect(h.active()).toBe(a.id)
    h.browser.tabs.closeTab(a.id, false, h.win)
    expect(h.active()).toBe(opener.id)
  })
})
