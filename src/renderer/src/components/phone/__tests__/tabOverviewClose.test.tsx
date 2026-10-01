// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ClosedEntrySummary, Folder, Space, Tab, UIState } from '@shared/types'
import type { OverviewChromeCommand } from '@shared/overviewMenu'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { TOUCH_GROUP_DEFAULT_NAME } from '@shared/groupNames'
import { BLANK_URL } from '@shared/url'

/*
 * Closing tabs from the phone overview (matrix TAB-05, TAB-06, TAB-22, TAB-23; v2 draft §9.23, §9.33,
 * §11.4; tab overview cleanup spec §3, §4): a card's X closes at once and departs, and the toast
 * that follows the core's filing offers Undo. The overview draws no ⋯ of its own (§1): the
 * BAR's ⋯ opens the overview's menu through the core while the overview stands, its rows the
 * core's template (`src/core/__tests__/overviewMenuTemplate.test.ts` pins them), and a picked
 * row of the chrome's comes back as one `overview.command` – which is what this file drives.
 * "Close All Tabs" asks first on a prompt sheet with a "Don't ask again" row bound to
 * `settings.confirmCloseAll`, and then departs every unpinned card through `tab.closeMany` –
 * the core closing them one after the other, each page's `beforeunload` heard in its turn
 * (PUI-28) – with one toast for the lot; "Recently Closed" lists the contract's entries and a
 * tap restores one. On a host with private tabs each VIEW closes its own (TAB-02, TAB-03): the
 * regular view its cards through the same `tab.closeMany`, the private view through
 * `tab.closePrivate`. A group's ⋯ sheet closes it with the one Undo and deletes it after an
 * ask, never both (TAB-16 / TAB-13, the Design Lead's option C); the saved card's hold sheet
 * deletes a saved group. Rendered for real in happy-dom with the sheets on the frame's dialog
 * host, the frame loop cranked by hand.
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
const { pickOverviewPane, resetOverviewPane } = await import('@renderer/lib/privateTabs')
const { dispatchOverviewCommand, overviewCommandListeners } =
  await import('@renderer/lib/overviewCommands')
const { overviewMenuRequest } = await import('@renderer/lib/overviewMenuRequest')
const { dispatchBackEvent, topBackSurface } = await import('@renderer/lib/back')
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
    closingTabIds: [],
    // Sync off: the tab search's reach has no other devices to look through (TAB-21).
    sync: { enabled: false, scope: { openTabs: false } }
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

const CLOSED = { phase: 'closed', progress: 0, heroTabId: null, target: 0 } as const

function render(state: UIState, overview: typeof OPEN | typeof CLOSED = OPEN): HTMLElement {
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
        createElement(TabOverview, { state, overview, area: AREA, edge: 'bottom' })
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

/**
 * A row of the bar's ⋯ menu picked (§4): the core's `overview.command` reaches the overview
 * (`useMainEvents` → `dispatchOverviewCommand`), which reads a list or opens a sheet, and the
 * sheet comes up.
 */
async function command(name: OverviewChromeCommand): Promise<void> {
  act(() => dispatchOverviewCommand(name))
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

// --- the ⋯ menu is the bar's (§1, §4) ----------------------------------------------------------

describe("the ⋯ menu is the bar's", () => {
  it('the overview draws no ⋯, no segment row and no search toggle; it tells the bar which view it shows and listens for the menu’s commands while it stands', async () => {
    show(three())
    // One header row (§1): the title, nothing trailing it.
    expect(document.querySelector('[aria-label="More"]')).toBeNull()
    expect(document.querySelector('[aria-label="Search tabs"]')).toBeNull()
    expect(document.querySelector('[data-testid="overview-pane-tabs"]')).toBeNull()
    expect(
      document.querySelector('[data-testid="overview-title"]')?.getAttribute('data-view')
    ).toBe('tabs')
    // The overview is one named landmark while it stands – "Tab overview", said once on entry
    // and the harness's word for the overview's presence (`awaitOverview`) – and no other
    // region of the chrome's shares the name.
    const regions = [...document.querySelectorAll('[role="region"]')]
    expect(regions.map((el) => el.getAttribute('aria-label'))).toEqual(['Tab overview'])
    expect(regions[0]!.classList.contains('zen-overview')).toBe(true)
    // The bar's ⋯ asks the core for the overview's menu with this view (the rows – Select Tabs,
    // Recently Closed (N), Close All Tabs (N), … – are the core's template).
    expect(overviewMenuRequest()).toEqual({ overview: { view: 'tabs' } })
    expect(overviewCommandListeners()).toBe(1)
    // Nothing was closed by any of this.
    expect(commands()).toEqual([])
  })

  it('Select Tabs enters the selection mode, and the menu’s word on the selection counts every card – a pinned one too', async () => {
    show(stateOf([tab('p', 'https://pinned.example/', { pinned: true })]))
    await command('select-tabs')
    expect(overviewMenuRequest()).toEqual({
      overview: { view: 'tabs', selection: { selected: 0, total: 1 } }
    })
    expect(commands()).toEqual([])
  })

  it('once the overview has left nothing listens for a command, and the bar’s ⋯ is the app menu’s again', async () => {
    show(three())
    expect(overviewCommandListeners()).toBe(1)
    act(() => stageStore.set({ ...stageStore.get(), overview: CLOSED }))
    render(three(), CLOSED)
    await settle()
    expect(overviewCommandListeners()).toBe(0)
    expect(overviewMenuRequest()).toEqual({})
  })
})

// --- Close all tabs (TAB-06) -------------------------------------------------------------------

describe('Close all tabs', () => {
  it('asks first on a prompt sheet; Cancel keeps every tab and the setting', async () => {
    show(three())
    await command('close-all')
    // The question stands on the frame's dialog host (§9.23); no sheet of the overview's is up.
    expect(sheetRows()).toEqual([])
    expect(dialogTitle()).toBe('Close 3 tabs?')
    const checkbox = document.querySelector<HTMLInputElement>(
      '.zen-frame-dialogs input[type="checkbox"]'
    )!
    expect(checkbox.checked).toBe(false)
    // The checkbox row takes the focus as the sheet opens (§9.22: a sheet whose first control
    // is a checkbox opens on it; Cancel first is the named failure), so a stray Enter closes
    // nothing.
    expect(document.activeElement).toBe(checkbox)
    await pick('Cancel')
    expect(dialogTitle()).toBeUndefined()
    expect(commands()).toEqual([])
    expect(departStore.get().items).toEqual([])
  })

  it('Close all departs every unpinned card, closes them one after the other, and one toast offers to undo the lot', async () => {
    show(three())
    await command('close-all')
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
    await command('close-all')
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
    await command('close-all')
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
    await command('recently-closed')
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
    await command('recently-closed')
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

// --- the two views of a host with private tabs (TAB-02, TAB-03; §3) ----------------------------

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
  /** The view the header names (§3): the space's title, or the private view's mask heading. */
  const view = (): string | null =>
    document
      .querySelector<HTMLElement>('[data-testid="overview-title"]')
      ?.getAttribute('data-view') ?? null
  /** The tab cards on the grid, in order (the group and New Tab cells left out). */
  const cells = (): string[] =>
    [...document.querySelectorAll<HTMLElement>('[data-cell]')]
      .map((el) => el.dataset.cell!)
      .filter((id) => !id.includes(':') && id !== 'new-tab')

  afterEach(() => {
    act(() => resetOverviewPane())
  })

  it("the regular view's Close All closes the space's regular tabs in turn and leaves the private session be", async () => {
    show(mixed())
    closed = [entry(tab('x', 'https://x.example/', { title: 'X' }), NOW - 60_000)]
    // The regular view: the regular cards alone (private never mixes into the grid, §3), and
    // the bar's ⋯ asks for the regular view's rows (Close All Tabs (2), the core's count).
    expect(view()).toBe('tabs')
    expect(cells()).toEqual(['pin', 'r1', 'r2'])
    expect(overviewMenuRequest()).toEqual({ overview: { view: 'tabs' } })
    await command('close-all')
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

  it("the ⋯ menu's Private Tabs (N) switches to the private view – the mask heading, the private cards alone – whose Close All asks in the private tabs' words, says there is no undo, and closes through the core's tab.closePrivate with no toast", async () => {
    show(mixed())
    closed = [entry(tab('x', 'https://x.example/', { title: 'X' }), NOW - 60_000)]
    await command('switch-view')
    expect(view()).toBe('private')
    expect(cells()).toEqual(['p1', 'p2'])
    // The bar's ⋯ now asks for the private view's rows (Tabs (N) back, Close Private Tabs (2)).
    expect(overviewMenuRequest()).toEqual({ overview: { view: 'private' } })
    // Nothing read the recently closed list: the menu's counts are the core's own.
    expect(of('session.recentlyClosed')).toEqual([])
    await command('close-all')
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

  it('with no private tab open there is no private view to pick (§4): the pick reads as the regular view, whose rows the ⋯ menu is asked for', async () => {
    show(withPrivate(stateOf([tab('a', 'https://a.example/')])))
    act(() => pickOverviewPane('private'))
    await settle()
    expect(view()).toBe('tabs')
    expect(cells()).toEqual(['a'])
    expect(document.querySelector('[data-testid="overview-private-empty"]')).toBeNull()
    expect(buttonByText('New private tab')).toBeUndefined()
    // The menu is the regular view's: no "Private Tabs (N)" row while none is open is the
    // template's to grey or drop; the chrome's word is the view that stands.
    expect(overviewMenuRequest()).toEqual({ overview: { view: 'tabs' } })
  })

  it('from the private view the ⋯ menu’s Tabs (N) switches back, and the system back from a picked private view returns to the regular view (§3)', async () => {
    show(mixed())
    expect(topBackSurface()?.name).not.toBe('overview-private-view')
    await command('switch-view')
    expect(view()).toBe('private')
    // The system back is the private view's while it stands (§3), above the overview's own.
    expect(topBackSurface()?.name).toBe('overview-private-view')
    act(() => {
      dispatchBackEvent('commit')
    })
    await settle()
    expect(view()).toBe('tabs')
    expect(cells()).toEqual(['pin', 'r1', 'r2'])
    expect(topBackSurface()?.name).not.toBe('overview-private-view')
    // And the menu's row takes it back and forth.
    await command('switch-view')
    expect(view()).toBe('private')
    await command('switch-view')
    expect(view()).toBe('tabs')
  })
})

// --- a group's Close Group and Delete Group (TAB-16 / TAB-13; §2) ------------------------------

describe('the group card’s ⋯ sheet and the saved card’s hold sheet: Undo for Close Group, an ask for Delete Group, never both (TAB-16 / TAB-13, option C)', () => {
  const GROUP = 'folder_research'
  const research = (patch: Partial<Folder> = {}): Folder =>
    ({
      id: GROUP,
      spaceId: SPACE,
      name: 'Research',
      icon: '📁',
      collapsed: false,
      color: 'blue',
      ...patch
    }) as Folder
  /**
   * Research holds Alpha and Beta; Gamma is loose and in view. The members' ids carry `tag`, one
   * per test: the app's undo remembers the entries it has claimed by id until a list read finds
   * them gone, and this harness's list starts each test empty without a read (see the private
   * block's note).
   */
  const grouped = (folder = research(), tag = 'r'): UIState => ({
    ...stateOf([
      tab('loose', 'https://c.example/', { title: 'Gamma' }),
      tab(`${tag}a`, 'https://a.example/', { title: 'Alpha', folderId: GROUP }),
      tab(`${tag}b`, 'https://b.example/', { title: 'Beta', folderId: GROUP })
    ]),
    folders: { [GROUP]: folder }
  })
  /** The core files the group's two members (`tag`'s), oldest first. */
  const fileMembers = (tag: string): void => {
    const state = grouped(research(), tag)
    file(entry(state.tabs[`${tag}a`]!, NOW), entry(state.tabs[`${tag}b`]!, NOW))
  }
  /** Research SAVED: no live member, its two pages kept (`Folder.savedTabs`). */
  const savedResearch = (): UIState => ({
    ...stateOf([tab('loose', 'https://c.example/', { title: 'Gamma' })]),
    folders: {
      [GROUP]: research({
        savedTabs: [
          { url: 'https://a.example/', title: 'Alpha' },
          { url: 'https://b.example/', title: 'Beta' }
        ]
      })
    }
  })
  const dialogText = (): string =>
    document.querySelector<HTMLElement>('.zen-frame-dialogs')?.textContent ?? ''
  /** Open the group card's ⋯ sheet (`Group options`, the open card's header) and let it come up. */
  async function groupMenu(): Promise<void> {
    act(() => byLabel('Group options').click())
    await settle()
    await land()
  }
  /** Hold the saved card (a right click is the hold, for the mouse) and let its sheet come up. */
  async function savedMenu(): Promise<void> {
    const card = document.querySelector<HTMLElement>('[data-testid="saved-group-card"]')!
    act(() => {
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    await settle()
    await land()
  }
  /** The prompt's Delete: the sheet leaves, then the deletion runs. */
  async function confirmDelete(): Promise<void> {
    const button = document.querySelector<HTMLElement>(
      '[data-testid="overview-delete-group-confirm"]'
    )
    expect(button).not.toBeNull()
    act(() => button!.click())
    await land()
  }
  /** The wait a close's toast would need at the longest, and then some: nothing comes of it here. */
  async function settleClose(): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + 1)
    })
  }

  it('Close Group (N Tabs) asks nothing: the core’s folder.close at once, then the one toast, "<Name> tab group closed and saved" with Undo, which brings the tabs back into the group', async () => {
    show(grouped())
    await groupMenu()
    // The group's rows (§2): Rename, New Tab in Group, Ungroup, Close Group (N), Delete Group.
    expect(sheetRows().map((r) => r.textContent?.trim())).toEqual([
      'Rename',
      'New Tab in Group',
      'Ungroup',
      'Close Group (2 Tabs)',
      'Delete Group'
    ])
    // Delete Group, the one danger row, stands last after the one hairline (the cleanup spec §4).
    const seps = document.querySelectorAll('.zen-sheet .zen-sheet-sep')
    expect(seps).toHaveLength(1)
    expect(seps[0]!.nextElementSibling?.textContent?.trim()).toBe('Delete Group')
    await pick('Close Group (2 Tabs)')
    // No prompt (§9.23: the ask is Delete's alone); the group stays, saved with the pages.
    expect(dialogTitle()).toBeUndefined()
    expect(commands()).toEqual([['folder.close', { folderId: GROUP }]])
    expect(toasts()).toEqual([])
    // The core files the two members as it closes them: the toast in the group's words – not
    // "2 tabs closed" – with Undo.
    fileMembers('r')
    await settle()
    expect(toasts()).toEqual([['Research tab group closed and saved', 'Undo', false]])
    // Undo restores newest first – the core puts each back into the group, whose record the
    // saved group kept, and the group re-opens – then the tab the user was on is activated.
    act(() => pickToastAction(liveToast().id))
    await settle()
    expect(of('session.restoreClosed')).toEqual([{ id: 'closed:rb' }, { id: 'closed:ra' }])
    expect(of('tab.activate')).toEqual([{ tabId: 'loose' }])
    expect(of('folder.delete')).toEqual([])
  })

  it('a group still wearing the default name closes to "Tab group closed and saved" – not called by it (the Lead’s addendum)', async () => {
    show(grouped(research({ name: TOUCH_GROUP_DEFAULT_NAME }), 'n'))
    await groupMenu()
    await pick('Close Group (2 Tabs)')
    expect(commands()).toEqual([['folder.close', { folderId: GROUP }]])
    fileMembers('n')
    await settle()
    expect(toasts()).toEqual([['Tab group closed and saved', 'Undo', false]])
  })

  it('Delete Group asks first – "Its N tabs close with it; Recently Closed keeps their pages." – and Cancel keeps the group', async () => {
    show(grouped())
    await groupMenu()
    await pick('Delete Group')
    // The ⋯ sheet has gone and the question stands on the frame's dialog host (§9.23), in the
    // one source's words (`folderDeleteWords`): no promise of an Undo.
    expect(sheetRows()).toEqual([])
    expect(dialogTitle()).toBe('Delete Research?')
    expect(dialogText()).toContain('Its 2 tabs close with it; Recently Closed keeps their pages.')
    expect(dialogText()).not.toContain('Undo')
    expect(commands()).toEqual([])
    await pick('Cancel')
    expect(dialogTitle()).toBeUndefined()
    expect(commands()).toEqual([])
    expect(toasts()).toEqual([])
  })

  it('Delete runs the core’s folder.delete at once, and no toast follows the closes it files – the ask was the guard, there is no Undo after it', async () => {
    show(grouped(research(), 'd'))
    await groupMenu()
    await pick('Delete Group')
    await confirmDelete()
    expect(dialogTitle()).toBeUndefined()
    // The record goes with its tabs (`unpack: false`): not `folder.close`, which would keep it
    // saved.
    expect(commands()).toEqual([['folder.delete', { folderId: GROUP, unpack: false }]])
    // The core files the two as it closes them: no intent claims them, so no toast – now, nor
    // once a close's settle wait would have run out.
    fileMembers('d')
    await settle()
    expect(toasts()).toEqual([])
    await settleClose()
    expect(toasts()).toEqual([])
    expect(of('session.restoreClosed')).toEqual([])
    expect(commands()).toEqual([['folder.delete', { folderId: GROUP, unpack: false }]])
  })

  it('a saved group’s Delete asks in the pages’ words – "Its N saved pages are forgotten with it. There is no undo." – and Delete drops the record, no toast', async () => {
    show(savedResearch())
    // The saved card stands at the grid's end, before New Tab (§2); its hold sheet is Open,
    // Rename, Delete Group.
    const order = [...document.querySelectorAll<HTMLElement>('[data-cell]')].map(
      (el) => el.dataset.cell
    )
    expect(order).toEqual(['loose', `saved:${GROUP}`, 'new-tab'])
    await savedMenu()
    expect(sheetRows().map((r) => r.textContent?.trim())).toEqual([
      'Open (2 Tabs)',
      'Rename',
      'Delete Group'
    ])
    await pick('Delete Group')
    expect(dialogTitle()).toBe('Delete Research?')
    expect(dialogText()).toContain('Its 2 saved pages are forgotten with it. There is no undo.')
    await confirmDelete()
    expect(commands()).toEqual([['folder.delete', { folderId: GROUP, unpack: false }]])
    await settleClose()
    expect(toasts()).toEqual([])
    expect(of('session.recentlyClosed')).toEqual([])
  })
})
