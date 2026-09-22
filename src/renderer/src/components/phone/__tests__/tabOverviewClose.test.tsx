// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ClosedEntrySummary, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { BLANK_URL } from '@shared/url'

/*
 * Closing tabs from the phone overview (matrix TAB-05, TAB-06, TAB-22, TAB-23; v2 draft §9.23, §9.33,
 * §11.4): a card's X closes at once and departs, and the toast that follows the core's filing
 * offers Undo; the header's menu carries "Recently Closed" and "Close All Tabs"; Close all asks
 * first on a prompt sheet with a "Don't ask again" row bound to `settings.confirmCloseAll`, and
 * then departs every unpinned card through `tab.closeMany` – the core closing them one after
 * the other, each page's `beforeunload` heard in its turn (PUI-28) – with one toast for the
 * lot; the recently closed sheet lists the contract's entries and a tap restores one. On a host
 * with private tabs each pane closes its own (TAB-02, TAB-03): the regular pane its cards
 * through the same `tab.closeMany`, the private pane through `tab.closePrivate` from a menu of
 * that one row. Rendered for real in happy-dom with the sheets on the frame's dialog host, the
 * frame loop cranked by hand.
 */

const SPACE = 'space'
const NOW = 1_700_000_000_000

/** The core: every command is taken; the recently closed list is `closed`, newest first. */
let closed: ClosedEntrySummary[] = []
const changeListeners = new Set<() => void>()
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) => {
  if (name === 'session.recentlyClosed') return [...closed]
  return null
})
Object.assign(window, {
  zen: {
    invoke,
    on: (name: string, listener: () => void) => {
      if (name === 'session.recentlyClosedChanged') changeListeners.add(listener)
      return () => changeListeners.delete(listener)
    }
  }
})
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { TabOverview } = await import('../TabOverview')
const { cancelLift } = await import('../useCardLift')
const { clearDepartures, departStore } = await import('../departureStore')
const { EXIT_WAIT_MS } = await import('../Departures')
const { layoutAnimations } = await import('@renderer/lib/motion/flip')
const { FrameDialogHost } = await import('@renderer/lib/portals')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore, claimMessageCards, pickToastAction, uiStore } =
  await import('@renderer/lib/ui')
const { stageStore } = await import('@renderer/lib/gestures/stage')
const { CLOSE_SETTLE_MS } = await import('@renderer/lib/closeUndo')
const { resetOverviewPane } = await import('@renderer/lib/privateTabs')
const { PRIVATE_CONTAINER_ID } = await import('@shared/types')

// --- a profile ---------------------------------------------------------------------------------

function tab(id: string, url: string, patch: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: SPACE,
    containerId: 'default',
    url,
    title: id,
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: false,
    discarded: false,
    frozen: false,
    cpuThrottle: 1,
    zoom: 1,
    splitGroupId: null,
    createdAt: 0,
    lastActiveAt: 0,
    errorCode: null,
    bookmarked: false,
    readerable: false,
    blockedCount: 0,
    ...patch
  } as Tab
}

/** `tabs` in track order; the first is active. */
function stateOf(tabs: Tab[], settings: Partial<UIState['settings']> = {}): UIState {
  const space: Space = {
    id: SPACE,
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId: tabs[0]?.id ?? null,
    pinnedCollapsed: false
  }
  return {
    platform: 'android',
    capabilities: { windowControls: false },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [space],
    activeSpaceId: SPACE,
    folders: {},
    essentialTabIds: [],
    containers: [],
    settings: { ...DEFAULT_SETTINGS, pinnedCloseBehavior: 'unload', ...settings },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: [],
    recentlyClosed: [],
    closingTabIds: []
  } as unknown as UIState
}

const three = (settings: Partial<UIState['settings']> = {}): UIState =>
  stateOf(
    [
      tab('a', 'https://a.example/', { title: 'Alpha' }),
      tab('b', 'https://b.example/', { title: 'Beta' }),
      tab('c', 'https://c.example/', { title: 'Gamma' }),
      tab('p', 'https://pinned.example/', { title: 'Pinned', pinned: true })
    ],
    settings
  )

/** The entry the core files for `t`, closed at `closedAt`. */
function entry(t: Tab, closedAt: number): ClosedEntrySummary {
  return {
    id: `closed:${t.id}`,
    kind: 'tab',
    title: t.title,
    url: t.url,
    favicon: null,
    closedAt,
    tabCount: 1
  }
}

/** The core files `entries` (oldest first) and says the list changed. */
function file(...entries: ClosedEntrySummary[]): void {
  for (const e of entries) closed = [e, ...closed]
  for (const listener of changeListeners) listener()
}

const OPEN = { phase: 'open', progress: 1, heroTabId: null, target: 1 } as const
const AREA = { x: 0, y: 0, width: 220, height: 600 }

// --- a clock and a frame loop ------------------------------------------------------------------

/** A hand-cranked animation frame: `run(n)` advances the clock 16 ms a frame and runs the callbacks. */
class Frames {
  now = 0
  private queue = new Map<number, (now: number) => void>()
  private seq = 0

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++this.seq
      this.queue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue.delete(id)
    })
    vi.spyOn(performance, 'now').mockImplementation(() => this.now)
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) {
      this.now += 16
      const pending = [...this.queue.values()]
      this.queue.clear()
      for (const cb of pending) cb(this.now)
    }
  }
}

const frames = new Frames()
let root: Root | null = null
let host: HTMLElement | null = null
let sizes: Array<[string, PropertyDescriptor | undefined]> = []

/** The async work between one step and the next: a list read, the cover's wait, a commit. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

/** Run the springs out: a sheet lands, a picked row's action runs, the surface hears of it. */
async function land(): Promise<void> {
  await act(async () => {
    frames.run(150)
  })
  await settle()
}

function render(state: UIState): HTMLElement {
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  act(() =>
    root!.render(
      createElement(
        FrameDialogHost,
        null,
        createElement(TabOverview, { state, overview: OPEN, area: AREA, edge: 'bottom' })
      )
    )
  )
  return host!
}

/** The browser shows `state`: the store the chrome reads and the grid alike. */
function show(state: UIState): void {
  act(() => browserStore.set({ state }))
  render(state)
}

let releaseCards: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  })
  vi.setSystemTime(NOW)
  frames.install()
  closed = []
  invoke.mockClear()
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
  sizes = ['clientHeight', 'offsetHeight'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  ])
  // The layer is 800 px tall and a sheet's content 300 px: a sheet with room to stand.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-sheet-scroll') ? 300 : 800
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 300
  })
  uiStore.set({ toasts: [] })
  releaseCards = claimMessageCards()
  stageStore.set({ ...stageStore.get(), overview: OPEN })
})

afterEach(async () => {
  // A close this test issued and never filed settles now, so the app's one undo carries no
  // intent into the next test.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + 1)
  })
  act(() => cancelLift())
  act(() => clearDepartures())
  act(() => root?.unmount())
  layoutAnimations.release()
  root = null
  host?.remove()
  host = null
  releaseCards?.()
  releaseCards = null
  uiStore.set({ toasts: [] })
  browserStore.set({ state: null })
  stageStore.set({
    ...stageStore.get(),
    overview: { phase: 'closed', progress: 0, heroTabId: null, target: 0 }
  })
  for (const [name, descriptor] of sizes) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  frames.now = 0
})

// --- helpers -----------------------------------------------------------------------------------

const byLabel = (label: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!
const buttonByText = (text: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === text)
/** The rows of the sheet that is up: the menu's actions or the list's rows. */
const sheetRows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('.zen-sheet .zen-sheet-item')
]
const dialogTitle = (): string | undefined =>
  document.querySelector<HTMLElement>('.zen-frame-dialogs h2')?.textContent?.trim()
/**
 * The commands the grid sent the browser, in order; the list reads and the sheet chassis's own
 * page capture (`overlay.snapshot`, taken as a sheet comes up) left out.
 */
const CHASSIS = new Set(['session.recentlyClosed', 'overlay.snapshot'])
const commands = (): Array<[string, unknown]> =>
  invoke.mock.calls
    .filter(([name]) => !CHASSIS.has(name))
    .map(([name, args]) => [name, args] as [string, unknown])
const of = (name: string): unknown[] =>
  invoke.mock.calls.filter(([n]) => n === name).map(([, args]) => args)
const toasts = (): Array<[string, string | undefined, boolean]> =>
  uiStore.get().toasts.map((t) => [t.message, t.action?.label, Boolean(t.leaving)])
const liveToast = (): { id: number; message: string } => {
  const t = uiStore.get().toasts.find((t) => !t.leaving)!
  return { id: t.id, message: t.message }
}

/** Open the header's menu and let it read the list and come up. */
async function openMenu(): Promise<void> {
  act(() => byLabel('More').click())
  await settle()
  await land()
}

/** Pick a row of the sheet that is up: the sheet leaves, then the row's action runs. */
async function pick(text: string): Promise<void> {
  const row = buttonByText(text)
  expect(row, text).toBeDefined()
  act(() => row!.click())
  await land()
}

// --- the header menu ---------------------------------------------------------------------------

describe('the header menu', () => {
  it('carries Recently Closed and Close All Tabs (Title Case, §9.1), counted; each is off with nothing to act on (§9.17)', async () => {
    show(three())
    closed = [entry(tab('x', 'https://x.example/', { title: 'X' }), NOW - 60_000)]
    // The button says it opens a menu, and whether that menu is up.
    expect(byLabel('More').getAttribute('aria-haspopup')).toBe('menu')
    expect(byLabel('More').getAttribute('aria-expanded')).toBe('false')
    await openMenu()
    expect(byLabel('More').getAttribute('aria-expanded')).toBe('true')
    const rows = sheetRows()
    expect(rows.map((r) => [r.textContent?.trim(), r.hasAttribute('disabled')])).toEqual([
      ['Select Tabs', false],
      ['Recently Closed (1)', false],
      ['Close All Tabs (3)', false]
    ])
    // Close all is the destructive row (§10.4).
    expect(rows[2].style.color).toContain('--zen-danger')
    // The sheet is a menu of the overview: nothing was closed by opening it.
    expect(commands()).toEqual([])
  })

  it('with no closed tabs and only pinned tabs both rows are off, their counts kept at zero (§9.17); a pinned card is still one to select', async () => {
    show(stateOf([tab('p', 'https://pinned.example/', { pinned: true })]))
    await openMenu()
    expect(sheetRows().map((r) => [r.textContent?.trim(), r.hasAttribute('disabled')])).toEqual([
      ['Select Tabs', false],
      ['Recently Closed (0)', true],
      ['Close All Tabs (0)', true]
    ])
  })
})

// --- Close all tabs (TAB-06) -------------------------------------------------------------------

describe('Close all tabs', () => {
  it('asks first on a prompt sheet; Cancel keeps every tab and the setting', async () => {
    show(three())
    await openMenu()
    await pick('Close All Tabs (3)')
    // The menu has gone and the question stands on the frame's dialog host (§9.23).
    expect(sheetRows()).toEqual([])
    expect(dialogTitle()).toBe('Close 3 tabs?')
    const checkbox = document.querySelector<HTMLInputElement>(
      '.zen-frame-dialogs input[type="checkbox"]'
    )!
    expect(checkbox.checked).toBe(false)
    // Cancel takes the focus as the sheet opens, so a stray Enter closes nothing.
    expect(document.activeElement).toBe(buttonByText('Cancel'))
    await pick('Cancel')
    expect(dialogTitle()).toBeUndefined()
    expect(commands()).toEqual([])
    expect(departStore.get().items).toEqual([])
  })

  it('Close all departs every unpinned card, closes them one after the other, and one toast offers to undo the lot', async () => {
    show(three())
    await openMenu()
    await pick('Close All Tabs (3)')
    await pick('Close all')
    // The question is gone; the cards depart where they stand – the pinned one stays. The core
    // closes the three in turn (`tab.closeMany`, PUI-28): a page that objects asks "Leave
    // site?" on its own tab; `space.closeUnpinned` would ask no page.
    expect(dialogTitle()).toBeUndefined()
    expect(departStore.get().items.map((i) => i.key)).toEqual(['a', 'b', 'c'])
    expect(commands()).toEqual([['tab.closeMany', { tabIds: ['a', 'b', 'c'] }]])
    // The setting is untouched: the row was not ticked.
    expect(of('settings.update')).toEqual([])
    // The core closes the three in order and files each; the one toast counts them.
    const state = three()
    file(entry(state.tabs.a, NOW), entry(state.tabs.b, NOW), entry(state.tabs.c, NOW))
    await settle()
    expect(toasts()).toEqual([['3 tabs closed', 'Undo', false]])
    // Undo restores newest first, so each lands at the index it left, and a – the tab the user
    // was on – is activated last.
    act(() => pickToastAction(liveToast().id))
    await settle()
    expect(of('session.restoreClosed')).toEqual([
      { id: 'closed:c' },
      { id: 'closed:b' },
      { id: 'closed:a' }
    ])
    expect(of('tab.activate')).toEqual([{ tabId: 'a' }])
  })

  it("Don't ask again turns the setting off with the close; with it off the menu's row closes at once", async () => {
    show(three())
    await openMenu()
    await pick('Close All Tabs (3)')
    const checkbox = document.querySelector<HTMLInputElement>(
      '.zen-frame-dialogs input[type="checkbox"]'
    )!
    act(() => checkbox.click())
    expect(checkbox.checked).toBe(true)
    await pick('Close all')
    expect(commands()).toEqual([
      ['settings.update', { confirmCloseAll: false }],
      ['tab.closeMany', { tabIds: ['a', 'b', 'c'] }]
    ])

    // The setting is off: the next Close all goes straight through, no question asked.
    invoke.mockClear()
    act(() => clearDepartures())
    show(three({ confirmCloseAll: false }))
    await openMenu()
    await pick('Close All Tabs (3)')
    expect(dialogTitle()).toBeUndefined()
    expect(commands()).toEqual([['tab.closeMany', { tabIds: ['a', 'b', 'c'] }]])
    expect(departStore.get().items.map((i) => i.key)).toEqual(['a', 'b', 'c'])
  })
})

// --- Recently closed (TAB-22, TAB-23) ----------------------------------------------------------

describe('Recently closed', () => {
  it('lists the contract’s tab entries newest first – title, host, when – and a tap restores one; the overview leaves on the tab that comes back', async () => {
    show(three())
    const yesterday = NOW - 24 * 60 * 60 * 1000
    closed = [
      entry(tab('x', 'https://www.x.example/path', { title: 'X marks' }), NOW - 5 * 60_000),
      entry(tab('y', 'https://y.example/', { title: 'Why' }), yesterday),
      {
        id: 'closed:w',
        kind: 'window',
        title: '2 tabs',
        url: null,
        favicon: null,
        closedAt: NOW,
        tabCount: 2
      }
    ]
    await openMenu()
    await pick('Recently Closed (2)')
    expect(dialogTitle()).toBe('Recently closed')
    const rows = [...document.querySelectorAll<HTMLElement>('.zen-frame-dialogs .zen-phone-row')]
    // Tab entries only, the list's order kept; a row is its title, then host and time (§9.13).
    const labels = rows.map((r) => r.querySelector('[role="button"]')?.getAttribute('aria-label'))
    expect(labels).toEqual([
      `X marks, x.example · ${new Date(NOW - 5 * 60_000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`,
      'Why, y.example · Yesterday'
    ])
    // A tap: the sheet leaves, then the core restores the entry into its place.
    act(() => rows[0].querySelector<HTMLElement>('[role="button"]')!.click())
    await land()
    expect(of('session.restoreClosed')).toEqual([{ id: 'closed:x' }])
    expect(dialogTitle()).toBeUndefined()
    // The browser shows the restored tab as a new record: the overview leaves on it.
    const restored = tab('x2', 'https://www.x.example/path', { title: 'X marks' })
    const state = three()
    act(() =>
      browserStore.set({
        state: {
          ...state,
          tabs: { ...state.tabs, x2: restored },
          spaces: [
            { ...state.spaces[0], tabIds: [...state.spaces[0].tabIds, 'x2'], activeTabId: 'x2' }
          ]
        }
      })
    )
    await settle()
    expect(stageStore.get().overview.heroTabId).toBe('x2')
  })

  it('the list follows the core while the sheet is up: an entry restored elsewhere leaves its row', async () => {
    show(three())
    const x = tab('x', 'https://x.example/', { title: 'X' })
    const y = tab('y', 'https://y.example/', { title: 'Y' })
    closed = [entry(x, NOW), entry(y, NOW - 1000)]
    await openMenu()
    await pick('Recently Closed (2)')
    expect(document.querySelectorAll('.zen-frame-dialogs .zen-phone-row')).toHaveLength(2)
    closed = [entry(y, NOW - 1000)]
    act(() => {
      for (const listener of changeListeners) listener()
    })
    await settle()
    expect(
      [...document.querySelectorAll<HTMLElement>('.zen-frame-dialogs .zen-phone-row')].map((r) =>
        r.querySelector('[role="button"]')?.getAttribute('aria-label')
      )
    ).toEqual([expect.stringMatching(/^Y, y\.example/)])
  })
})

// --- one card (TAB-05) -------------------------------------------------------------------------

describe('closing one card', () => {
  it('by X: the card departs, the close goes at once, and the toast that follows the filing undoes it', async () => {
    show(three())
    const close = document.querySelector<HTMLElement>('[data-cell="b"] [aria-label^="Close "]')!
    act(() => close.click())
    // Immediate: the command is out and the card is on its way; no toast until the core files it.
    expect(commands()).toEqual([['tab.close', { tabId: 'b' }]])
    expect(departStore.get().items.map((i) => i.key)).toEqual(['b'])
    expect(toasts()).toEqual([])
    file(entry(three().tabs.b, NOW))
    await settle()
    expect(toasts()).toEqual([['Closed Beta', 'Undo', false]])
    act(() => pickToastAction(liveToast().id))
    await settle()
    expect(of('session.restoreClosed')).toEqual([{ id: 'closed:b' }])
    // The user was on a and stays there: the core activates a restored tab, the chrome undoes that.
    expect(of('tab.activate')).toEqual([{ tabId: 'a' }])
  })

  it('a close in flight (its page asking "Leave site?") holds its card in place; Cancel puts the card back with no exit, Leave lets the exit run (PUI-28)', async () => {
    // The core lists the tab in `closingTabIds` from the close until its page's unload check
    // is through – a page that objects asking "Leave site?" (on Android as the host's own
    // sheet, which the chrome never sees) for as long as the user takes.
    const asking = (state: UIState, tabId: string): UIState => ({
      ...state,
      closingTabIds: [tabId]
    })
    show(three())
    const close = document.querySelector<HTMLElement>('[data-cell="b"] [aria-label^="Close "]')!
    act(() => close.click())
    expect(commands()).toEqual([['tab.close', { tabId: 'b' }]])
    expect(departStore.get().items.map((i) => i.key)).toEqual(['b'])
    // The page objects: the core asks on the tab, and the exit that would run 900 ms after a
    // close the browser never showed waits with it – well past its wait, the card still stands.
    show(asking(three(), 'b'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXIT_WAIT_MS * 3)
    })
    expect(departStore.get().items.map((i) => i.key)).toEqual(['b'])
    expect([...departStore.get().released]).toEqual([])
    // Cancel: the question goes, the tab stays. After the same wait the card is back as it
    // was – the departure gone without its exit ever being released.
    show(three())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXIT_WAIT_MS + 1)
    })
    expect(departStore.get().items).toEqual([])
    expect([...departStore.get().released]).toEqual([])
    expect(toasts()).toEqual([])

    // Leave: the question goes and the tab with it; the exit runs on the commit that shows the gap.
    act(() => close.click())
    show(asking(three(), 'b'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXIT_WAIT_MS * 2)
    })
    expect(departStore.get().items.map((i) => i.key)).toEqual(['b'])
    const left = three()
    delete (left.tabs as Record<string, Tab>).b
    left.spaces[0].tabIds = left.spaces[0].tabIds.filter((id) => id !== 'b')
    show(left)
    expect([...departStore.get().released]).toEqual(['b'])
  })

  it('a blank tab never visited closes with no toast: there is nothing to bring back', async () => {
    show(stateOf([tab('a', 'https://a.example/'), tab('blank', BLANK_URL)]))
    const close = document.querySelector<HTMLElement>('[data-cell="blank"] [aria-label^="Close "]')!
    act(() => close.click())
    expect(commands()).toEqual([['tab.close', { tabId: 'blank' }]])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(toasts()).toEqual([])
    expect(of('session.recentlyClosed')).toEqual([])
  })
})

// --- the two panes of a host with private tabs (TAB-02, TAB-03) --------------------------------

describe('on a host with private tabs', () => {
  const privateTab = (id: string, url: string, patch: Partial<Tab> = {}): Tab =>
    tab(id, url, { containerId: PRIVATE_CONTAINER_ID, ...patch })
  /** The Android host: private tabs live in the space's track beside the regular ones. */
  const withPrivate = (state: UIState): UIState => ({
    ...state,
    capabilities: { ...state.capabilities, privateTabs: true }
  })
  /**
   * Two regular tabs, a pinned one and two private tabs in the one space; Alpha is in view. The
   * ids are this block's own: the app's undo remembers the entries it has claimed by id while
   * the list holds them, and `closed:a` from the tests above would still be its.
   */
  const mixed = (): UIState =>
    withPrivate(
      stateOf([
        tab('r1', 'https://a.example/', { title: 'Alpha' }),
        privateTab('p1', 'https://one.example/', { title: 'One' }),
        tab('r2', 'https://b.example/', { title: 'Beta' }),
        tab('pin', 'https://pinned.example/', { title: 'Pinned', pinned: true }),
        privateTab('p2', 'https://two.example/', { title: 'Two' })
      ])
    )
  const segment = (pane: 'tabs' | 'private'): HTMLElement =>
    document.querySelector<HTMLElement>(`[data-testid="overview-pane-${pane}"]`)!
  const sheetTitle = (): string | undefined =>
    document.querySelector<HTMLElement>('.zen-sheet .zen-sheet-title')?.textContent?.trim()

  afterEach(() => {
    act(() => resetOverviewPane())
  })

  it("the regular pane's Close All closes the space's regular tabs in turn and leaves the private session be", async () => {
    show(mixed())
    closed = [entry(tab('x', 'https://x.example/', { title: 'X' }), NOW - 60_000)]
    await openMenu()
    expect(sheetTitle()).toBe('Work')
    expect(sheetRows().map((r) => r.textContent?.trim())).toEqual([
      'Select Tabs',
      'Recently Closed (1)',
      'Close All Tabs (2)'
    ])
    await pick('Close All Tabs (2)')
    expect(dialogTitle()).toBe('Close 2 tabs?')
    await pick('Close all')
    // The regular cards depart, named one by one; not `space.closeUnpinned`, which would take
    // One and Two too.
    expect(departStore.get().items.map((i) => i.key)).toEqual(['r1', 'r2'])
    expect(commands()).toEqual([['tab.closeMany', { tabIds: ['r1', 'r2'] }]])
    // One toast for the two once the core files them, with Undo.
    const state = mixed()
    file(entry(state.tabs.r1, NOW), entry(state.tabs.r2, NOW))
    await settle()
    expect(toasts()).toEqual([['2 tabs closed', 'Undo', false]])
  })

  it("the private pane's menu is Select Tabs and Close Private Tabs, its question names the private tabs and says there is no undo, and the close is the core's tab.closePrivate with no toast", async () => {
    show(mixed())
    closed = [entry(tab('x', 'https://x.example/', { title: 'X' }), NOW - 60_000)]
    act(() => segment('private').click())
    await openMenu()
    expect(sheetTitle()).toBe('Private')
    const rows = sheetRows()
    expect(rows.map((r) => [r.textContent?.trim(), r.hasAttribute('disabled')])).toEqual([
      ['Select Tabs', false],
      ['Close Private Tabs (2)', false]
    ])
    expect(rows[1].style.color).toContain('--zen-danger')
    // No recently closed row: none was read for it either.
    expect(of('session.recentlyClosed')).toEqual([])
    await pick('Close Private Tabs (2)')
    expect(dialogTitle()).toBe('Close 2 private tabs?')
    expect(document.querySelector('.zen-frame-dialogs')!.textContent).toContain(
      'the private session ends; its history, cookies and site data go with it. There is no undo.'
    )
    await pick('Close all')
    expect(departStore.get().items.map((i) => i.key)).toEqual(['p1', 'p2'])
    expect(commands()).toEqual([['tab.closePrivate', undefined]])
    // A private tab is never filed: no toast, and no list read to look for one.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + 1)
    })
    expect(toasts()).toEqual([])
    expect(of('session.recentlyClosed')).toEqual([])
  })

  it('with no private tab open the rows stay, greyed, the count at zero (§9.17)', async () => {
    show(withPrivate(stateOf([tab('a', 'https://a.example/')])))
    act(() => segment('private').click())
    await openMenu()
    expect(sheetRows().map((r) => [r.textContent?.trim(), r.hasAttribute('disabled')])).toEqual([
      ['Select Tabs', true],
      ['Close Private Tabs (0)', true]
    ])
  })
})
