import { describe, expect, it } from 'vitest'
import type {
  HostCapabilities,
  Platform as PlatformOs,
  Tab,
  TabMoveResult
} from '../../shared/types'
import { Browser } from '../browser'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import type { ZenWindow } from '../window'

/*
 * The keyboard's tab move (tabs-34; Chrome's Ctrl+Shift+PgUp / PgDn): `tab.moveBackward` and
 * `tab.moveForward` move a tab one row along the strip in the order it is drawn – the pinned
 * rows, each group's rows, the loose rows – landing as a drag past that row would: swapping
 * with a row of its own run, crossing a group's boundary one row at a time (into the group
 * beside it, out of its own to the row beside it), never out of the pinned rows, never an
 * Essentials tile. From the chrome with the keyboard on a strip row (`strip.focus`) that row
 * moves rather than the active tab, and the chrome hears where it landed (`tab.moved`) once it
 * holds the state that draws it there.
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
  /** The events sent to the window's chrome, in order. */
  sent: Array<{ name: string; payload: unknown }>
  /** Open a regular tab named `name` at the end of the space (in `folderId`, when given). */
  open: (name: string, folderId?: string) => string
  /** A new group of the space, by name. */
  group: (name: string) => string
  /** The space's tabs in the model's order, by name. */
  order: () => string[]
  /** The tab named `name`. */
  tab: (name: string) => Tab
  /** `moveTabBy` on the tab named `name`, by the name-to-id map. */
  move: (name: string, direction: -1 | 1) => TabMoveResult | null
}

function harness(): Harness {
  const sent: Harness['sent'] = []
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '1.2.3' },
    capabilities: stub<HostCapabilities>({ windows: true, newTabPage: false, pageTabs: false }),
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
      createView: () =>
        stub<TabView>({ isDestroyed: () => false, isVisible: () => false, getZoom: () => 1 })
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
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  const space = win.activeSpace()
  const names = new Map<string, string>()
  const idOf = (name: string): string => {
    const id = names.get(name)
    if (!id) throw new Error(`no tab named ${name}`)
    return id
  }
  // The window opens with a tab of its own; the tests' tabs are the only ones in the space.
  const initial = [...space.tabIds]
  const h: Harness = {
    browser,
    win,
    sent,
    open: (name, folderId) => {
      const tab = browser.tabs.createTab(
        { url: `https://${name}.test/`, active: true, folderId, index: Number.MAX_SAFE_INTEGER },
        win
      )
      names.set(name, tab.id)
      if (initial.length) {
        for (const id of initial.splice(0)) browser.tabs.closeTab(id, false, win)
      }
      return tab.id
    },
    group: (name) =>
      browser.handleCommand(win, 'folder.create', {
        spaceId: space.id,
        name,
        icon: '📁',
        rename: false
      }) as string,
    order: () =>
      space.tabIds.map((id) => [...names].find(([, tabId]) => tabId === id)?.[0] ?? `?${id}`),
    tab: (name) => browser.tabs.tab(idOf(name)) as Tab,
    move: (name, direction) => browser.tabs.moveTabBy(idOf(name), direction, win)
  }
  return h
}

/** The deferred state broadcast has gone out (and with it what `afterBroadcast` queued). */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

const CTRL_SHIFT_PGDN = {
  type: 'keyDown' as const,
  key: 'PageDown',
  control: true,
  shift: true,
  alt: false,
  meta: false,
  isAutoRepeat: false
}

describe('moveTabBy along the loose rows', () => {
  it('swaps the tab with the row beside it and says its place among the loose tabs', () => {
    const h = harness()
    h.open('a')
    h.open('b')
    h.open('c')
    expect(h.order()).toEqual(['a', 'b', 'c'])
    expect(h.move('b', 1)).toEqual({
      tabId: h.tab('b').id,
      position: 3,
      count: 3,
      from: null,
      to: null,
      focused: false
    })
    expect(h.order()).toEqual(['a', 'c', 'b'])
    expect(h.move('b', -1)).toMatchObject({ position: 2, count: 3 })
    expect(h.order()).toEqual(['a', 'b', 'c'])
  })

  it('moves nothing past the ends of the strip', () => {
    const h = harness()
    h.open('a')
    h.open('b')
    expect(h.move('a', -1)).toBeNull()
    expect(h.move('b', 1)).toBeNull()
    expect(h.order()).toEqual(['a', 'b'])
  })

  it('keeps a pinned tab among the pinned rows, as Chrome does', () => {
    const h = harness()
    h.open('p1')
    h.open('p2')
    h.open('a')
    h.browser.tabs.togglePin(h.tab('p1').id, h.win)
    h.browser.tabs.togglePin(h.tab('p2').id, h.win)
    expect(h.order()).toEqual(['p1', 'p2', 'a'])
    expect(h.move('p1', 1)).toMatchObject({ position: 2, count: 2, from: null, to: null })
    expect(h.order()).toEqual(['p2', 'p1', 'a'])
    expect(h.tab('p1').pinned).toBe(true)
    // The last pinned row is the end of its run: the loose rows are not its to enter.
    expect(h.move('p1', 1)).toBeNull()
    expect(h.move('p2', -1)).toBeNull()
    // Nor is a loose tab's way up into the pinned rows.
    expect(h.move('a', -1)).toBeNull()
    expect(h.order()).toEqual(['p2', 'p1', 'a'])
  })

  it('leaves an Essentials tile where it is', () => {
    const h = harness()
    h.open('e')
    h.open('a')
    h.browser.tabs.moveTab(h.tab('e').id, { section: 'essential', index: 0 }, h.win)
    expect(h.tab('e').essential).toBe(true)
    expect(h.move('e', 1)).toBeNull()
    expect(h.move('e', -1)).toBeNull()
  })
})

describe("moveTabBy across a group's boundary", () => {
  it("takes the group's last tab out to the loose row beside it, one row down", () => {
    const h = harness()
    const g = h.group('Research')
    h.open('g1', g)
    h.open('g2', g)
    h.open('a')
    h.open('b')
    // Drawn: Research › g1, g2; then a, b.
    expect(h.move('g2', 1)).toEqual({
      tabId: h.tab('g2').id,
      position: 1,
      count: 3,
      from: { folderId: g, name: 'Research' },
      to: null,
      focused: false
    })
    expect(h.tab('g2').folderId).toBeNull()
    expect(h.order()).toEqual(['g1', 'g2', 'a', 'b'])
    // And back up: into the group at its tail.
    expect(h.move('g2', -1)).toEqual({
      tabId: h.tab('g2').id,
      position: 2,
      count: 2,
      from: null,
      to: { folderId: g, name: 'Research' },
      focused: false
    })
    expect(h.tab('g2').folderId).toBe(g)
    expect(h.order()).toEqual(['g1', 'g2', 'a', 'b'])
  })

  it('takes the first loose tab up into the last group, at its tail, unfolding a collapsed one', () => {
    const h = harness()
    const g = h.group('Trip')
    h.open('g1', g)
    h.open('a')
    h.open('b')
    h.browser.updateFolder(g, { collapsed: true })
    expect(h.move('a', -1)).toMatchObject({
      position: 2,
      count: 2,
      from: null,
      to: { folderId: g, name: 'Trip' }
    })
    expect(h.tab('a').folderId).toBe(g)
    expect(h.browser.state.model.folders[g].collapsed).toBe(false)
    expect(h.order()).toEqual(['g1', 'a', 'b'])
    // The group's first row is the top of the regular rows: nothing above it.
    expect(h.move('g1', -1)).toBeNull()
  })

  it("crosses from one group's tail to the next group's head, and back", () => {
    const h = harness()
    const g = h.group('G')
    const k = h.group('K')
    h.open('g1', g)
    h.open('g2', g)
    h.open('k1', k)
    h.open('k2', k)
    expect(h.move('g2', 1)).toMatchObject({
      position: 1,
      count: 3,
      from: { folderId: g, name: 'G' },
      to: { folderId: k, name: 'K' }
    })
    expect(h.tab('g2').folderId).toBe(k)
    expect(h.order()).toEqual(['g1', 'g2', 'k1', 'k2'])
    expect(h.move('g2', -1)).toMatchObject({
      position: 2,
      count: 2,
      from: { folderId: k, name: 'K' },
      to: { folderId: g, name: 'G' }
    })
    expect(h.tab('g2').folderId).toBe(g)
    // Within the group the tabs swap.
    expect(h.move('g2', -1)).toMatchObject({ position: 1, count: 2, from: { folderId: g } })
    expect(h.order()).toEqual(['g2', 'g1', 'k1', 'k2'])
  })

  it("orders the rows as the strip draws them: the groups' tabs first, then the loose ones", () => {
    const h = harness()
    h.open('a')
    const g = h.group('G')
    h.open('g1', g)
    // In the model the loose tab is first; the strip draws the group's row above it.
    expect(h.order()).toEqual(['a', 'g1'])
    expect(h.move('g1', 1)).toMatchObject({ position: 1, count: 2, to: null })
    expect(h.tab('g1').folderId).toBeNull()
    expect(h.order()).toEqual(['g1', 'a'])
  })
})

describe('moveTabBy on a pane of a split', () => {
  it('passes the row beside the split and leaves the split, as a segment dragged out does', () => {
    const h = harness()
    h.open('a')
    h.open('p1')
    h.open('p2')
    h.open('b')
    h.browser.tabs.createSplit([h.tab('p1').id, h.tab('p2').id], 'vertical', h.win)
    expect(h.tab('p1').splitGroupId).toBeTruthy()
    // Rows: a, [p1 p2], b. Down from the split's row: past b.
    expect(h.move('p2', 1)).toMatchObject({ position: 4, count: 4 })
    expect(h.order()).toEqual(['a', 'p1', 'b', 'p2'])
    expect(h.tab('p2').splitGroupId ?? null).toBeNull()
  })

  it('treats panes drawn in different lists as the plain rows they are', () => {
    const h = harness()
    const g = h.group('G')
    h.open('p1', g)
    h.open('a')
    h.open('p2')
    h.browser.tabs.createSplit([h.tab('p1').id, h.tab('p2').id], 'vertical', h.win)
    // Drawn: G › p1; then a, p2 – each pane a row of its own list. Up from p2: past a.
    expect(h.move('p2', -1)).toMatchObject({ position: 1, count: 2, from: null, to: null })
    expect(h.order()).toEqual(['p1', 'p2', 'a'])
    expect(h.tab('p2').folderId ?? null).toBeNull()
  })

  it("passes the row above from the split's own row, whichever pane holds the keyboard", () => {
    const h = harness()
    h.open('a')
    h.open('p1')
    h.open('p2')
    h.browser.tabs.createSplit([h.tab('p1').id, h.tab('p2').id], 'vertical', h.win)
    // Rows: a, [p1 p2]. Up from the second pane: past a, out of the split.
    expect(h.move('p2', -1)).toMatchObject({ position: 1, count: 3 })
    expect(h.order()).toEqual(['p2', 'a', 'p1'])
    expect(h.tab('p2').splitGroupId ?? null).toBeNull()
  })
})

describe('the move actions', () => {
  it('move the focused strip row from the chrome and tell the chrome where it landed', async () => {
    const h = harness()
    h.open('a')
    h.open('b')
    h.open('c')
    h.browser.handleCommand(h.win, 'strip.focus', { tabId: h.tab('a').id })
    expect(h.win.stripFocusTabId).toBe(h.tab('a').id)
    await tick()
    h.sent.length = 0
    h.browser.actions.run('tab.moveForward', { sourceTabId: null, win: h.win })
    expect(h.order()).toEqual(['b', 'a', 'c'])
    // The word follows the state that draws the row where it now stands.
    expect(h.sent.map((e) => e.name)).not.toContain('tab.moved')
    await tick()
    const names = h.sent.map((e) => e.name)
    expect(names.indexOf('tab.moved')).toBeGreaterThan(names.indexOf('state'))
    expect(h.sent.find((e) => e.name === 'tab.moved')?.payload).toEqual({
      tabId: h.tab('a').id,
      position: 2,
      count: 3,
      from: null,
      to: null,
      focused: true
    })
  })

  it('move the active tab from a page, and from the chrome with the keyboard off the rows', async () => {
    const h = harness()
    h.open('a')
    h.open('b')
    h.open('c')
    h.browser.handleCommand(h.win, 'strip.focus', { tabId: h.tab('a').id })
    // From the page: the active tab (c), whatever row the strip's keyboard was on.
    h.browser.actions.run('tab.moveBackward', { sourceTabId: h.tab('c').id, win: h.win })
    expect(h.order()).toEqual(['a', 'c', 'b'])
    await tick()
    expect(h.sent.find((e) => e.name === 'tab.moved')?.payload).toMatchObject({
      tabId: h.tab('c').id,
      position: 2,
      count: 3,
      focused: false
    })
    // The keyboard left the rows (a header, a tile, the page): the active tab again.
    h.browser.handleCommand(h.win, 'strip.focus', { tabId: null })
    expect(h.win.stripFocusTabId).toBeNull()
    h.browser.actions.run('tab.moveBackward', { sourceTabId: null, win: h.win })
    expect(h.order()).toEqual(['c', 'a', 'b'])
  })

  it('say nothing when nothing moved', async () => {
    const h = harness()
    h.open('a')
    h.open('b')
    await tick()
    h.sent.length = 0
    h.browser.actions.run('tab.moveForward', { sourceTabId: null, win: h.win })
    await tick()
    expect(h.order()).toEqual(['a', 'b'])
    expect(h.sent.map((e) => e.name)).not.toContain('tab.moved')
  })

  it('are Ctrl+Shift+PgDn in the chrome, taken by the shortcut table', () => {
    const h = harness()
    h.open('a')
    h.open('b')
    h.browser.handleCommand(h.win, 'strip.focus', { tabId: h.tab('a').id })
    expect(h.browser.keys.handle(CTRL_SHIFT_PGDN, null, h.win)).toBe(true)
    expect(h.order()).toEqual(['b', 'a'])
    expect(h.browser.keys.handle({ ...CTRL_SHIFT_PGDN, key: 'PageUp' }, null, h.win)).toBe(true)
    expect(h.order()).toEqual(['a', 'b'])
  })
})
