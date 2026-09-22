// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ClosedEntrySummary, Folder, Space, SyncDeviceTabs, Tab, UIState } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { BLANK_URL } from '@shared/url'

/*
 * The phone overview's tab search (matrix TAB-21; v2 §9.12, §11.4) and its reach (the #316
 * gate; TAB-02, §9.17, §9.27, §10.4): the header's magnifier opens a field pinned under the
 * header that narrows the pane's cards by title and address as it is typed – the dropped cards
 * departing in place, the New Tab card with them – with the count told to the status region; the
 * X, Escape and the system back clear a query and close an empty field. On the Tabs pane the query
 * reaches past the cards: this device's recently closed tabs and the other devices' open ones
 * list as rows under headings beneath the matching cards, each row leaving the overview on the
 * tab it brings up; a hidden device, a sync that is off and the Private pane are out of its
 * reach. The search is the card panes' – the Groups pane (TAB-16) has no magnifier – and a query
 * narrows what is shown, not what a group is: a group's close and count read the whole group.
 * Rendered for real in happy-dom with the sheets on the frame's dialog host, the frame loop
 * cranked by hand, the core stubbed.
 */

const SPACE = 'space'
const NOW = 1_700_000_000_000
const HOUR = 60 * 60 * 1000

// --- the core ----------------------------------------------------------------------------------

let closed: ClosedEntrySummary[] = []
let remote: SyncDeviceTabs[] = []
const changeListeners = new Set<() => void>()
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) => {
  if (name === 'session.recentlyClosed') return [...closed]
  if (name === 'sync.tabsFromDevices') return remote.map((d) => ({ ...d }))
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
const { layoutAnimations } = await import('@renderer/lib/motion/flip')
const { FrameDialogHost } = await import('@renderer/lib/portals')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore, claimMessageCards, uiStore } = await import('@renderer/lib/ui')
const { stageStore } = await import('@renderer/lib/gestures/stage')
const { pickOverviewPane, resetOverviewPane } = await import('@renderer/lib/privateTabs')
const { dispatchBackEvent, topBackSurface } = await import('@renderer/lib/back')
const { announcerStore, resetAnnouncer } = await import('@renderer/lib/announce')
const { hideDevice, showHiddenDevices } = await import('@renderer/lib/otherDevices')
const { remoteTabsStore } = await import('@renderer/lib/remoteTabs')

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

/**
 * The status' `remoteTabsVersion` of the test at hand: Settings › Sync's `useRemoteTabs` asks
 * the core once per version for the whole chrome, so every test starts at a version no test
 * before it has asked at (the shared store is emptied beside it).
 */
let version = 0

/** The engine's status: off, or on with Open tabs among what syncs unless `openTabs` says not. */
function sync(enabled: boolean, openTabs = true): UIState['sync'] {
  return {
    enabled,
    folder: enabled ? 'content://tree/Zenium' : null,
    folderName: enabled ? 'Zenium' : null,
    folderLost: false,
    deviceId: 'device-phone',
    deviceName: 'Pixel 8',
    scope: {
      spaces: true,
      folders: true,
      pinnedTabs: true,
      essentials: true,
      openTabs,
      containers: true,
      bookmarks: true,
      settings: true,
      shortcuts: true,
      boosts: true
    } as UIState['sync']['scope'],
    lastSyncAt: enabled ? NOW - 5 * 60_000 : null,
    lastError: null,
    syncing: false,
    devices: [],
    pendingMerge: false,
    remoteTabsVersion: version
  } as UIState['sync']
}

/** `tabs` in track order; the first is active. */
function stateOf(tabs: Tab[], patch: Partial<UIState> = {}): UIState {
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
    settings: { ...DEFAULT_SETTINGS, pinnedCloseBehavior: 'unload' },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: [],
    recentlyClosed: [],
    closingTabIds: [],
    sync: sync(false),
    ...patch
  } as unknown as UIState
}

/** Five pages – two on Wikipedia, one on GitHub by its address alone – and a blank tab. */
const pages = (): Tab[] => [
  tab('ex', 'https://example.com/', { title: 'Example Domain' }),
  tab('coffee', 'https://en.wikipedia.org/wiki/Coffee', { title: 'Coffee - Wikipedia' }),
  tab('pulls', 'https://github.com/BenItBuhner/Zenium/pulls', {
    title: 'Pull requests · BenItBuhner/Zenium'
  }),
  tab('tea', 'https://en.wikipedia.org/wiki/Tea', { title: 'Tea – Wikipédia' }),
  tab('hn', 'https://news.ycombinator.com/', { title: 'Hacker News' }),
  tab('blank', BLANK_URL)
]

/** A tab group of the space (its card on the grid), and two pages in it beside a loose one. */
const research: Folder = {
  id: 'research',
  spaceId: SPACE,
  name: 'Research',
  icon: '📚',
  collapsed: false,
  color: 'blue'
}
const grouped = (): UIState =>
  stateOf(
    [
      tab('m1', 'https://en.wikipedia.org/wiki/Coffee', {
        title: 'Coffee - Wikipedia',
        folderId: research.id
      }),
      tab('m2', 'https://github.com/BenItBuhner/Zenium', {
        title: 'Zenium',
        folderId: research.id
      }),
      tab('a', 'https://a.example/', { title: 'A' })
    ],
    { folders: { [research.id]: research } }
  )

/** A private tab (the Android host's private session), and the state on a host that has them. */
const privateTab = (id: string, url: string, patch: Partial<Tab> = {}): Tab =>
  tab(id, url, { ...patch, containerId: PRIVATE_CONTAINER_ID })
const withPrivate = (state: UIState): UIState => ({
  ...state,
  capabilities: { ...state.capabilities, privateTabs: true }
})

/**
 * A PRIVATE group (#318's `isPrivateGroup`: private tabs alone live in it, nothing saved) beside
 * a loose private tab and the regular pages: what the Tabs pane's search must never list – not
 * the tabs, not the group's name – whatever the query matches on the private side.
 */
const vault: Folder = {
  id: 'vault',
  spaceId: SPACE,
  name: 'Vault',
  icon: '🔒',
  collapsed: false,
  color: 'red'
}
const withPrivateGroup = (): UIState =>
  withPrivate(
    stateOf(
      [
        ...pages(),
        privateTab('p1', 'https://secret.example/notes', { title: 'Secret Notes' }),
        privateTab('p2', 'https://vault.example/keys', { title: 'Keys', folderId: vault.id })
      ],
      { folders: { [vault.id]: vault } }
    )
  )

/** The entry the core files for a closed page. */
function entry(id: string, title: string, url: string, closedAt: number): ClosedEntrySummary {
  return { id, kind: 'tab', title, url, favicon: null, closedAt, tabCount: 1 }
}

const remoteTab = (
  tabId: string,
  url: string,
  title: string,
  lastActive: number
): SyncDeviceTabs['tabs'][number] => ({
  tabId,
  windowId: null,
  url,
  title,
  favicon: null,
  lastActive
})

/**
 * Two devices: the laptop published two hours ago, the desktop three minutes ago. "wiki" finds
 * one tab of the desktop's; "zenium" one of the laptop's; "archive" the desktop's other.
 */
const devices = (): SyncDeviceTabs[] => [
  {
    deviceId: 'device-laptop',
    deviceName: 'Work laptop',
    updatedAt: NOW - 2 * HOUR,
    tabs: [
      remoteTab('l-2', 'https://developer.mozilla.org/docs/Web', 'Web | MDN', NOW - 3 * HOUR),
      remoteTab('l-1', 'https://github.com/BenItBuhner/Zenium', 'Zenium', NOW - 2 * HOUR)
    ]
  },
  {
    deviceId: 'device-desktop',
    deviceName: 'Home desktop',
    updatedAt: NOW - 3 * 60_000,
    tabs: [
      remoteTab('d-1', 'https://archive.org/', 'Internet Archive', NOW - 4 * 60_000),
      remoteTab(
        'd-2',
        'https://en.wikipedia.org/wiki/Web_browser',
        'Web browser - Wikipedia',
        NOW - 50 * 60_000
      )
    ]
  }
]

/** Two tabs closed here: one on Wikipedia two minutes ago, an RFC three hours ago. */
const closedTabs = (): ClosedEntrySummary[] => [
  entry('c2', 'Damping - Wikipedia', 'https://en.wikipedia.org/wiki/Damping', NOW - 2 * 60_000),
  entry('c1', 'RFC 1149', 'https://www.rfc-editor.org/rfc/rfc1149.html', NOW - 3 * HOUR)
]

const OPEN = { phase: 'open', progress: 1, heroTabId: null, target: 1 } as const
const AREA = { x: 0, y: 0, width: 220, height: 600 }

// --- a clock and a frame loop ------------------------------------------------------------------

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

/** The async work between one step and the next: a list read, a command's answer, a commit. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

/** Run the springs out: a sheet lands, a picked row's action runs. */
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
  remote = []
  version += 10
  remoteTabsStore.set({ version: -1, devices: [] })
  invoke.mockClear()
  resetAnnouncer()
  announcerStore.set({ text: '', seq: 0 })
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
  sizes = ['clientHeight', 'offsetHeight'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  ])
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

afterEach(() => {
  act(() => cancelLift())
  act(() => clearDepartures())
  act(() => root?.unmount())
  layoutAnimations.release()
  root = null
  host?.remove()
  host = null
  releaseCards?.()
  releaseCards = null
  uiStore.set({ toasts: [], overlay: 'none', overlayFolderId: null })
  browserStore.set({ state: null })
  stageStore.set({
    ...stageStore.get(),
    overview: { phase: 'closed', progress: 0, heroTabId: null, target: 0 }
  })
  act(() => resetOverviewPane())
  act(() => showHiddenDevices())
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

const byLabel = (label: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
/** The cards in the grid's order (the New Tab card among them). */
const cellKeys = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-cell]')].map((el) =>
    el.getAttribute('data-cell')!
  )
/** The cards of one pane's grid (the other pane's may still be fading out beside it). */
const cellsOn = (pane: 'tabs' | 'private'): string[] =>
  [...document.querySelectorAll<HTMLElement>(`[data-pane="${pane}"] [data-cell]`)].map((el) =>
    el.getAttribute('data-cell')!
  )
/** The overview's header row (the cards' title rows are not it). */
const header = (): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('header')].find(
    (h) => !h.classList.contains('zen-overview-card-header')
  )!
const headerButtons = (): string[] =>
  [...header().querySelectorAll<HTMLElement>('button')].map(
    (b) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? ''
  )
const field = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>('#overview-search')
const sheetRows = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('.zen-sheet .zen-sheet-item')].map(
    (e) => e.textContent?.trim() ?? ''
  )
const of = (name: string): unknown[] =>
  invoke.mock.calls.filter(([n]) => n === name).map(([, args]) => args)
/** The list row whose title reads `title` (its host and time stand beside it). */
const rowByTitle = (title: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('.zen-v2-row')].find(
    (r) => r.querySelector('.zen-list-title')?.textContent?.trim() === title
  )!
/** The search's reach under the grid: its headings and rows in order, as a reader meets them. */
const reachTexts = (): string[] =>
  [
    ...(byTestId('overview-search-reach')?.querySelectorAll<HTMLElement>(
      '.zen-v2-heading, .zen-v2-row'
    ) ?? [])
  ].map((el) =>
    el.classList.contains('zen-v2-heading')
      ? `# ${el.textContent?.trim()}`
      : (el.querySelector('.zen-list-title')?.textContent?.trim() ?? el.textContent?.trim() ?? '')
  )
/** The search's departures on the grid: the dropped cards by tab, and the New Tab card's. */
const filteredExits = (): string[] =>
  departStore
    .get()
    .items.filter((i) => i.kind === 'new-tab' || (i.kind === 'tab' && i.filtered))
    .map((i) => i.key)
    .sort()

/** Type `text` into the search field as a keyboard would, one committed value. */
function type(text: string): void {
  const input = field()!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** The system back, committed. */
function back(): void {
  act(() => {
    dispatchBackEvent('start', { edge: 'left' })
    dispatchBackEvent('commit')
  })
}

/** Open the search from the header's magnifier, type `text`, and let the reach read its lists. */
async function search(text: string): Promise<void> {
  if (!field()) act(() => byTestId('overview-search-toggle')!.click())
  type(text)
  await settle()
}

// --- (A) the tab search ------------------------------------------------------------------------

describe('the tab search (TAB-21)', () => {
  it('opens from the header magnifier, takes focus only then, and the overview opens without it', () => {
    show(stateOf(pages()))
    expect(field()).toBeNull()
    expect(headerButtons()).toEqual(['Search tabs', 'Spaces', 'More'])
    const toggle = byTestId('overview-search-toggle')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).not.toBe(field())

    act(() => toggle.click())
    expect(field()).not.toBeNull()
    expect(document.activeElement).toBe(field())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-controls')).toBe('overview-search')
    expect(field()!.placeholder).toBe('Title or address')
    // Nothing is filtered yet: every card and the New Tab card.
    expect(cellKeys()).toEqual(['ex', 'coffee', 'pulls', 'tea', 'hn', 'blank', 'new-tab'])
  })

  it('narrows the grid by title and address as typed, case and diacritics folded; the dropped cards depart in place and the New Tab card with them (§9.34)', () => {
    show(stateOf(pages()))
    act(() => byTestId('overview-search-toggle')!.click())

    type('WIKI')
    expect(cellKeys()).toEqual(['coffee', 'tea'])
    // The New Tab card is no match: it leaves with the cards that are not, as its own exit
    // (its face, no tab behind it), and hides no tab.
    expect(filteredExits()).toEqual(['blank', 'ex', 'hn', 'new-tab', 'pulls'])
    expect(departStore.get().items.find((i) => i.key === 'new-tab')).toMatchObject({
      kind: 'new-tab',
      isPrivate: false
    })
    expect(departStore.get().hidden.has('new-tab')).toBe(false)

    // The address alone: "git" is in no title.
    type('git')
    expect(cellKeys()).toEqual(['pulls'])
    // Diacritics fold both ways: "wikipedia" finds "Wikipédia".
    type('wikipedia')
    expect(cellKeys()).toEqual(['coffee', 'tea'])
    type('Wikipédia')
    expect(cellKeys()).toEqual(['coffee', 'tea'])
  })

  it('a card the query dropped has its exit released once the grid no longer holds it', () => {
    show(stateOf(pages()))
    act(() => byTestId('overview-search-toggle')!.click())
    type('coffee')
    // The exits of the dropped cards run from the commit that unmounted them, the New Tab
    // card's among them.
    for (const key of ['ex', 'pulls', 'tea', 'hn', 'blank', 'new-tab'])
      expect(departStore.get().released.has(key), key).toBe(true)
    // A shorter query lets them back: the exits are dropped, the cards are drawn again, the
    // New Tab card last as before.
    type('')
    expect(filteredExits()).toEqual([])
    expect(cellKeys()).toEqual(['ex', 'coffee', 'pulls', 'tea', 'hn', 'blank', 'new-tab'])
  })

  it('says nothing is found where the grid was, and tells the count once the typing pauses', () => {
    show(stateOf(pages()))
    act(() => byTestId('overview-search-toggle')!.click())
    type('zzz')
    expect(cellKeys()).toEqual([])
    expect(byTestId('overview-search-empty')?.textContent).toBe('No tabs found')
    expect(announcerStore.get().text).toBe('')
    act(() => vi.advanceTimersByTime(600))
    expect(announcerStore.get().text).toBe('No tabs found')

    type('wiki')
    expect(byTestId('overview-search-empty')).toBeNull()
    act(() => vi.advanceTimersByTime(600))
    expect(announcerStore.get().text).toBe('2 tabs found')
    type('git')
    act(() => vi.advanceTimersByTime(600))
    expect(announcerStore.get().text).toBe('1 tab found')
  })

  it('the X clears a query and keeps the field; on an empty field it closes the search', () => {
    show(stateOf(pages()))
    act(() => byTestId('overview-search-toggle')!.click())
    type('wiki')
    const clear = byTestId('overview-search-clear')!
    expect(clear.getAttribute('aria-label')).toBe('Clear search')
    act(() => clear.click())
    expect(field()!.value).toBe('')
    expect(document.activeElement).toBe(field())
    expect(cellKeys()).toHaveLength(7)
    expect(byTestId('overview-search-clear')!.getAttribute('aria-label')).toBe('Close search')
    act(() => byTestId('overview-search-clear')!.click())
    expect(field()).toBeNull()
    expect(byTestId('overview-search-toggle')!.getAttribute('aria-expanded')).toBe('false')
  })

  it('the system back clears the query first and closes the field second; with the field closed the overview is next', () => {
    show(stateOf(pages()))
    expect(topBackSurface()?.name).not.toBe('overview-search')
    act(() => byTestId('overview-search-toggle')!.click())
    expect(topBackSurface()?.name).toBe('overview-search')
    type('tea')
    expect(cellKeys()).toEqual(['tea'])
    back()
    expect(field()).not.toBeNull()
    expect(field()!.value).toBe('')
    expect(cellKeys()).toHaveLength(7)
    back()
    expect(field()).toBeNull()
    expect(topBackSurface()?.name).not.toBe('overview-search')
  })

  it('Escape does what back does', () => {
    show(stateOf(pages()))
    act(() => byTestId('overview-search-toggle')!.click())
    type('hacker')
    expect(cellKeys()).toEqual(['hn'])
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(field()!.value).toBe('')
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(field()).toBeNull()
  })

  it('the header menu counts the pane, not the query', async () => {
    show(stateOf(pages()))
    act(() => byTestId('overview-search-toggle')!.click())
    type('wiki')
    act(() => byLabel('More')!.click())
    await settle()
    await land()
    // Five pages and a blank tab are open whatever the query shows.
    expect(sheetRows()).toContain('Close All Tabs (6)')
  })

  it("is the card panes' alone: the Groups pane has no magnifier, and picking it closes an open search", async () => {
    show(stateOf(pages()))
    act(() => byTestId('overview-search-toggle')!.click())
    type('wiki')
    expect(cellsOn('tabs')).toEqual(['coffee', 'tea'])
    act(() => byTestId('overview-pane-groups')!.click())
    await settle()
    expect(field()).toBeNull()
    expect(headerButtons()).toEqual(['Spaces', 'More'])
    // Back on the Tabs pane the magnifier is back and the grid whole: the query did not keep.
    act(() => byTestId('overview-pane-tabs')!.click())
    await settle()
    expect(headerButtons()).toEqual(['Search tabs', 'Spaces', 'More'])
    expect(field()).toBeNull()
    expect(cellsOn('tabs')).toEqual(['ex', 'coffee', 'pulls', 'tea', 'hn', 'blank', 'new-tab'])
  })

  it("reads a group whole under a query: the one card of it shown closes its tab alone, and the group's sheet counts every member", async () => {
    show(grouped())
    act(() => byTestId('overview-search-toggle')!.click())
    type('wiki')
    // The group's card stays for its one match; the other member and the loose page left.
    expect(cellKeys()).toEqual(['group:research', 'm1'])
    act(() => byLabel('Close Coffee - Wikipedia')!.click())
    // One tab closes, not the group: the group is whole only when every live member goes.
    expect(of('tab.close')).toEqual([{ tabId: 'm1' }])
    expect(of('folder.close')).toEqual([])

    // The group's own sheet counts the pane's members, as its Close Group closes them.
    const header = document.querySelector<HTMLElement>('[aria-label^="Research, tab group"]')!
    act(() => {
      header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    await settle()
    await land()
    expect(sheetRows()).toContain('Close Group (2 Tabs)')
  })

  it('keeps the field and its query across the segment: the Private pane is narrowed by the same words', async () => {
    show(withPrivate(stateOf([...pages(), privateTab('p1', 'https://one.example/')])))
    act(() => byTestId('overview-search-toggle')!.click())
    type('wiki')
    expect(cellsOn('tabs')).toEqual(['coffee', 'tea'])
    act(() => byTestId('overview-pane-private')!.click())
    await settle()
    expect(field()!.value).toBe('wiki')
    // The private pane's New Private Tab card is off the grid under the query as well.
    expect(cellsOn('private')).toEqual([])
    expect(byTestId('overview-search-empty')?.textContent).toBe('No tabs found')
    type('example')
    expect(cellsOn('private')).toEqual(['p1'])
    type('')
    expect(cellsOn('private')).toEqual(['p1', 'new-tab'])
  })

  it("never lists the private side on the Tabs pane – not a private tab, not a private group's name – and lists private tabs alone on the Private pane", async () => {
    show(withPrivateGroup())
    // Nothing private is drawn on the Tabs pane before a query, the group's name included.
    expect(cellsOn('tabs')).toEqual(['ex', 'coffee', 'pulls', 'tea', 'hn', 'blank', 'new-tab'])
    expect(document.body.textContent).not.toContain('Vault')
    act(() => byTestId('overview-search-toggle')!.click())

    // A query only a private tab matches: the grid empties, the sentence stands, the count says
    // none – the private tab is no part of what is found – and the private tab's title is
    // nowhere in the DOM; the exits are the regular cards' and the New Tab card's alone.
    type('secret')
    expect(cellsOn('tabs')).toEqual([])
    expect(byTestId('overview-search-empty')?.textContent).toBe('No tabs found')
    expect(document.body.textContent).not.toContain('Secret Notes')
    expect(filteredExits()).toEqual(['blank', 'coffee', 'ex', 'hn', 'new-tab', 'pulls', 'tea'])
    act(() => vi.advanceTimersByTime(600))
    expect(announcerStore.get().text).toBe('No tabs found')

    // A query the private group's member matches by address: no card, no group frame, and the
    // group's name – the Private pane's, which no regular surface shows – is nowhere either.
    type('vault')
    expect(cellsOn('tabs')).toEqual([])
    expect(cellKeys()).not.toContain('group:vault')
    expect(document.querySelector('[aria-label^="Vault, tab group"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Vault')
    expect(document.body.textContent).not.toContain('Keys')
    expect(byTestId('overview-search-empty')?.textContent).toBe('No tabs found')

    // The Private pane under the same words: the group's member as a loose card (the private
    // pane groups nothing), then the other private tab, then both – and never a regular page,
    // though `example` is in a regular page's title and in every address here.
    act(() => byTestId('overview-pane-private')!.click())
    await settle()
    expect(field()!.value).toBe('vault')
    expect(cellsOn('private')).toEqual(['p2'])
    expect(cellKeys()).not.toContain('group:vault')
    type('secret')
    expect(cellsOn('private')).toEqual(['p1'])
    type('example')
    expect(cellsOn('private')).toEqual(['p1', 'p2'])
    expect(cellsOn('private')).not.toContain('ex')
    act(() => vi.advanceTimersByTime(600))
    expect(announcerStore.get().text).toBe('2 tabs found')
  })
})

// --- (B) the search's reach ------------------------------------------------------------------------

describe("the search's reach (TAB-21 over TAB-02's lists)", () => {
  it("lists the recently closed and the other devices' matches as rows under headings beneath the cards, and counts them with the cards", async () => {
    closed = closedTabs()
    remote = devices()
    show(stateOf(pages(), { sync: sync(true) }))
    act(() => byTestId('overview-search-toggle')!.click())
    await settle()
    // The lists are not asked for until a query needs them.
    expect(of('sync.tabsFromDevices')).toEqual([])
    expect(byTestId('overview-search-reach')).toBeNull()

    await search('wiki')
    expect(of('sync.tabsFromDevices')).toHaveLength(1)
    expect(cellKeys()).toEqual(['coffee', 'tea'])
    expect(reachTexts()).toEqual([
      '# Recently closed',
      'Damping - Wikipedia',
      '# From your other devices',
      'Web browser - Wikipedia'
    ])
    // A closed row reads its host and when it closed; a device's row its host and the device.
    expect(rowByTitle('Damping - Wikipedia').textContent).toContain('wikipedia.org')
    expect(rowByTitle('Web browser - Wikipedia').textContent).toContain(
      'wikipedia.org · Home desktop'
    )
    // Two cards, one closed tab and one tab elsewhere: four found.
    act(() => vi.advanceTimersByTime(600))
    expect(announcerStore.get().text).toBe('4 tabs found')

    // A heading stands only over rows: "zenium" is on the laptop and on a card, closed nowhere.
    await search('zenium')
    expect(cellKeys()).toEqual(['pulls'])
    expect(reachTexts()).toEqual(['# From your other devices', 'Zenium'])
    // The address counts as it does for the cards: the RFC's is rfc-editor.org.
    await search('rfc-editor')
    expect(cellKeys()).toEqual([])
    expect(reachTexts()).toEqual(['# Recently closed', 'RFC 1149'])
  })

  it("a query no card answers shows the grid's sentence over the lists' rows (§9.34), naming the open tabs since the rows are tabs too; one nothing answers shows the sentence alone", async () => {
    closed = closedTabs()
    remote = devices()
    show(stateOf(pages(), { sync: sync(true) }))
    await search('damping')
    expect(cellKeys()).toEqual([])
    const sentence = byTestId('overview-search-empty')!
    expect(sentence.textContent).toBe('No open tabs found')
    expect(reachTexts()).toEqual(['# Recently closed', 'Damping - Wikipedia'])
    // The sentence stands where the grid was, the lists beneath it.
    expect(
      sentence.compareDocumentPosition(byTestId('overview-search-reach')!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    // The count told is of everything found: the one closed tab.
    act(() => vi.advanceTimersByTime(600))
    expect(announcerStore.get().text).toBe('1 tab found')

    await search('zzz')
    expect(byTestId('overview-search-empty')?.textContent).toBe('No tabs found')
    expect(byTestId('overview-search-reach')).toBeNull()
    act(() => vi.advanceTimersByTime(600))
    expect(announcerStore.get().text).toBe('No tabs found')
  })

  it('a recently closed row restores the tab and the overview leaves on the tab that appears', async () => {
    closed = closedTabs()
    show(stateOf(pages()))
    await search('damping')
    act(() => rowByTitle('Damping - Wikipedia').click())
    expect(of('session.restoreClosed')).toEqual([{ id: 'c2' }])
    const restored = tab('back', 'https://en.wikipedia.org/wiki/Damping', { title: 'Damping' })
    act(() => browserStore.set({ state: stateOf([...pages(), restored]) }))
    await settle()
    expect(stageStore.get().overview.heroTabId).toBe('back')
    expect(stageStore.get().overview.target).toBe(0)
  })

  it("another device's row opens the tab in a new tab of this space and the overview leaves on it", async () => {
    remote = devices()
    show(stateOf(pages(), { sync: sync(true) }))
    await search('archive')
    expect(reachTexts()).toEqual(['# From your other devices', 'Internet Archive'])
    act(() => rowByTitle('Internet Archive').click())
    expect(of('tab.create')).toEqual([
      { url: 'https://archive.org/', spaceId: SPACE, active: true }
    ])
    // The browser shows the new tab in front: the overview leaves on it.
    const opened = tab('opened', 'https://archive.org/', { title: 'Internet Archive' })
    act(() => browserStore.set({ state: stateOf([opened, ...pages()]) }))
    await settle()
    expect(stageStore.get().overview.heroTabId).toBe('opened')
    expect(stageStore.get().overview.target).toBe(0)
  })

  it('a tab this device already holds under the same id comes to the front instead of opening twice (ID-10)', async () => {
    // The Open tabs scope carries the tab records too: the laptop's `hn` is this device's `hn`.
    remote = [
      {
        deviceId: 'device-laptop',
        deviceName: 'Work laptop',
        updatedAt: NOW - 2 * HOUR,
        tabs: [remoteTab('hn', 'https://news.ycombinator.com/', 'Hacker News', NOW - HOUR)]
      }
    ]
    show(stateOf(pages(), { sync: sync(true) }))
    await search('hacker')
    expect(cellKeys()).toEqual(['hn'])
    act(() => rowByTitle('Hacker News').click())
    expect(of('tab.activate')).toEqual([{ tabId: 'hn' }])
    expect(of('tab.create')).toEqual([])
  })

  it("reaches no device's tabs with sync off or Open tabs out of its scope, and not a hidden device's", async () => {
    remote = devices()
    show(stateOf(pages(), { sync: sync(false) }))
    await search('wiki')
    expect(of('sync.tabsFromDevices')).toEqual([])
    expect(byTestId('overview-search-reach')).toBeNull()
    act(() => vi.advanceTimersByTime(600))
    expect(announcerStore.get().text).toBe('2 tabs found')

    act(() => browserStore.set({ state: stateOf(pages(), { sync: sync(true, false) }) }))
    render(stateOf(pages(), { sync: sync(true, false) }))
    await settle()
    expect(of('sync.tabsFromDevices')).toEqual([])
    expect(byTestId('overview-search-reach')).toBeNull()

    act(() => browserStore.set({ state: stateOf(pages(), { sync: sync(true) }) }))
    render(stateOf(pages(), { sync: sync(true) }))
    await settle()
    expect(reachTexts()).toEqual(['# From your other devices', 'Web browser - Wikipedia'])
    // The History page's hidden device is hidden here too, until it is shown again there.
    act(() => hideDevice('device-desktop'))
    expect(byTestId('overview-search-reach')).toBeNull()
    act(() => showHiddenDevices())
    expect(reachTexts()).toEqual(['# From your other devices', 'Web browser - Wikipedia'])
  })

  it("reaches nothing from the Private pane: a private tab is never filed, and the other devices' pages are not private", async () => {
    closed = closedTabs()
    remote = devices()
    show(
      withPrivate(
        stateOf([...pages(), privateTab('p1', 'https://en.wikipedia.org/wiki/Privacy')], {
          sync: sync(true)
        })
      )
    )
    act(() => pickOverviewPane('private'))
    await settle()
    await search('wiki')
    expect(cellsOn('private')).toEqual(['p1'])
    expect(byTestId('overview-search-reach')).toBeNull()
    expect(of('sync.tabsFromDevices')).toEqual([])
    act(() => vi.advanceTimersByTime(600))
    expect(announcerStore.get().text).toBe('1 tab found')
  })

  it('reads the lists again when the core says they changed', async () => {
    remote = devices()
    show(stateOf(pages(), { sync: sync(true) }))
    await search('archive')
    expect(of('sync.tabsFromDevices')).toHaveLength(1)
    // Another device published: the status' version moves, the reach asks once more.
    const moved = { ...sync(true), remoteTabsVersion: version + 1 }
    act(() => browserStore.set({ state: stateOf(pages(), { sync: moved }) }))
    render(stateOf(pages(), { sync: moved }))
    await settle()
    expect(of('sync.tabsFromDevices')).toHaveLength(2)
    // A tab closed here: the core's event, the list read again, the row among the results.
    closed = [entry('c1', 'Internet Archive Blog', 'https://blog.archive.org/', NOW)]
    act(() => {
      for (const listener of changeListeners) listener()
    })
    await settle()
    expect(reachTexts()).toEqual([
      '# Recently closed',
      'Internet Archive Blog',
      '# From your other devices',
      'Internet Archive'
    ])
  })
})
