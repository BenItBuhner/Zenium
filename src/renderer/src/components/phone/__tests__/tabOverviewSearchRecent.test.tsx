// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ClosedEntrySummary, Space, SyncDeviceTabs, Tab, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { BLANK_URL } from '@shared/url'

/*
 * The phone overview's tab search (matrix TAB-21; v2 §9.12, §11.4) and its Recent pane (TAB-02;
 * §9.17, §9.29, §10.3): the header's magnifier opens a field pinned under the header that
 * narrows the pane's cards by title and address as it is typed – the dropped cards departing in
 * place, the New Tab card never – with the count told to the status region; the X, Escape and
 * the system back clear a query and close an empty field. The Recent segment lists this device's
 * recently closed tabs and the other devices' open ones per device, each row leaving the
 * overview on the tab it brings up, a device's heading held for Hide device, and the group's
 * empty states with the row to Settings › Sync. Rendered for real in happy-dom with the sheets on
 * the frame's dialog host, the frame loop cranked by hand, the core stubbed.
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
const { resetOverviewPane } = await import('@renderer/lib/privateTabs')
const { dispatchBackEvent, topBackSurface } = await import('@renderer/lib/back')
const { announcerStore, resetAnnouncer } = await import('@renderer/lib/announce')
const { showHiddenDevices, hiddenDevicesStore } = await import('@renderer/lib/recentPane')
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

/** Two devices: the laptop published two hours ago, the desktop three minutes ago. */
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
    tabs: [remoteTab('d-1', 'https://archive.org/', 'Internet Archive', NOW - 4 * 60_000)]
  }
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
const buttonByText = (text: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === text)
/** The cards in the grid's order (the New Tab card among them). */
const cellKeys = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-cell]')].map((el) =>
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
const segments = (): Array<[string, boolean]> =>
  [...document.querySelectorAll<HTMLElement>('[role="tab"]')].map((b) => [
    b.textContent?.trim() ?? '',
    b.getAttribute('aria-selected') === 'true'
  ])
const field = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>('#overview-search')
const sheetRows = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('.zen-sheet .zen-sheet-item')].map(
    (e) => e.textContent?.trim() ?? ''
  )
const sheetTitle = (): string | undefined =>
  document.querySelector<HTMLElement>('.zen-sheet .zen-sheet-title')?.textContent?.trim()
const of = (name: string): unknown[] =>
  invoke.mock.calls.filter(([n]) => n === name).map(([, args]) => args)
/** The list row whose title reads `title` (its host and time stand beside it). */
const rowByTitle = (title: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('.zen-v2-row')].find(
    (r) => r.querySelector('.zen-list-title')?.textContent?.trim() === title
  )!
/** The search's departures on the grid: the dropped cards, by tab. */
const filteredExits = (): string[] =>
  departStore
    .get()
    .items.filter((i) => i.kind === 'tab' && i.filtered)
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

/** Switch to the Recent pane and let it read its lists. */
async function openRecent(): Promise<void> {
  act(() => byTestId('overview-pane-recent')!.click())
  await settle()
}

/** The Recent pane's headings and rows, in order, as a reader would meet them. */
const recentTexts = (): string[] =>
  [
    ...byTestId('overview-recent')!.querySelectorAll<HTMLElement>('.zen-v2-heading, .zen-v2-row')
  ].map((el) =>
    el.classList.contains('zen-v2-heading')
      ? `# ${el.textContent?.trim()}`
      : (el.querySelector('.zen-list-title')?.textContent?.trim() ?? el.textContent?.trim() ?? '')
  )

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

  it('narrows the grid by title and address as typed, case and diacritics folded; the dropped cards depart in place, the New Tab card stays', () => {
    show(stateOf(pages()))
    act(() => byTestId('overview-search-toggle')!.click())

    type('WIKI')
    expect(cellKeys()).toEqual(['coffee', 'tea', 'new-tab'])
    expect(filteredExits()).toEqual(['blank', 'ex', 'hn', 'pulls'])
    expect(departStore.get().hidden.has('new-tab')).toBe(false)

    // The address alone: "git" is in no title.
    type('git')
    expect(cellKeys()).toEqual(['pulls', 'new-tab'])
    // Diacritics fold both ways: "wikipedia" finds "Wikipédia".
    type('wikipedia')
    expect(cellKeys()).toEqual(['coffee', 'tea', 'new-tab'])
    type('Wikipédia')
    expect(cellKeys()).toEqual(['coffee', 'tea', 'new-tab'])
  })

  it('a card the query dropped has its exit released once the grid no longer holds it', () => {
    show(stateOf(pages()))
    act(() => byTestId('overview-search-toggle')!.click())
    type('coffee')
    // The exits of the dropped cards run from the commit that unmounted them.
    for (const key of ['ex', 'pulls', 'tea', 'hn', 'blank'])
      expect(departStore.get().released.has(key), key).toBe(true)
    // A shorter query lets them back: the exits are dropped, the cards are drawn again.
    type('')
    expect(filteredExits()).toEqual([])
    expect(cellKeys()).toEqual(['ex', 'coffee', 'pulls', 'tea', 'hn', 'blank', 'new-tab'])
  })

  it('says nothing is found over the New Tab card, and tells the count once the typing pauses', () => {
    show(stateOf(pages()))
    act(() => byTestId('overview-search-toggle')!.click())
    type('zzz')
    expect(cellKeys()).toEqual(['new-tab'])
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
    expect(cellKeys()).toEqual(['tea', 'new-tab'])
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
    expect(cellKeys()).toEqual(['hn', 'new-tab'])
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

  it('leaves the field behind on the Recent pane and comes back empty', async () => {
    show(stateOf(pages()))
    act(() => byTestId('overview-search-toggle')!.click())
    type('wiki')
    await openRecent()
    expect(field()).toBeNull()
    expect(headerButtons()).toEqual(['Spaces'])
    act(() => byTestId('overview-pane-tabs')!.click())
    await settle()
    expect(field()).toBeNull()
    expect(cellKeys()).toHaveLength(7)
  })
})

// --- (B) the Recent pane -----------------------------------------------------------------------

describe('the Recent pane (TAB-02)', () => {
  it('is the segment between Tabs and Private, retitles the header, and lists the recently closed tabs newest first', async () => {
    closed = [
      entry('c2', 'Damping - Wikipedia', 'https://en.wikipedia.org/wiki/Damping', NOW - 2 * 60_000),
      entry('c1', 'RFC 1149', 'https://www.rfc-editor.org/rfc/rfc1149.html', NOW - 3 * HOUR)
    ]
    const state = stateOf(pages())
    show({ ...state, capabilities: { ...state.capabilities, privateTabs: true } })
    expect(segments()).toEqual([
      ['Tabs', true],
      ['Recent', false],
      ['Private', false]
    ])
    await openRecent()
    expect(segments()).toEqual([
      ['Tabs', false],
      ['Recent', true],
      ['Private', false]
    ])
    expect(header().textContent).toContain('Recent')
    expect(headerButtons()).toEqual(['Spaces'])
    expect(byTestId('overview-count')).toBeNull()
    expect(recentTexts()).toEqual([
      '# Recently closed',
      'Damping - Wikipedia',
      'RFC 1149',
      '# From your other devices',
      'Turn on sync to see tabs from your other devices',
      'Turn on sync'
    ])
  })

  it('a closed tab picked is restored and the overview leaves on the tab that appears', async () => {
    closed = [entry('c1', 'Damping - Wikipedia', 'https://en.wikipedia.org/wiki/Damping', NOW)]
    const state = stateOf(pages())
    show(state)
    await openRecent()
    act(() => rowByTitle('Damping - Wikipedia').click())
    expect(of('session.restoreClosed')).toEqual([{ id: 'c1' }])
    // The browser shows the restored tab: the overview leaves on it.
    const restored = tab('back', 'https://en.wikipedia.org/wiki/Damping', { title: 'Damping' })
    act(() => browserStore.set({ state: stateOf([...pages(), restored]) }))
    await settle()
    expect(stageStore.get().overview.heroTabId).toBe('back')
    expect(stageStore.get().overview.target).toBe(0)
  })

  it('lists the other devices by their last publish, tabs by last activity, and opens a tab in a new tab of this space', async () => {
    remote = devices()
    show(stateOf(pages(), { sync: sync(true) }))
    await openRecent()
    expect(of('sync.tabsFromDevices')).toHaveLength(1)
    expect(recentTexts()).toEqual([
      '# Recently closed',
      'Tabs you close appear here',
      '# From your other devices',
      '# Home desktopLast active 3 min ago',
      'Internet Archive',
      '# Work laptopLast active 2 h ago',
      'Zenium',
      'Web | MDN'
    ])
    const headings = [...document.querySelectorAll<HTMLElement>('.zen-recent-device-button')]
    expect(headings.map((h) => h.getAttribute('aria-label'))).toEqual([
      'Home desktop, Last active 3 min ago',
      'Work laptop, Last active 2 h ago'
    ])
    const row = rowByTitle('Internet Archive')
    expect(row.textContent).toContain('archive.org')
    act(() => row.click())
    expect(of('tab.create')).toEqual([
      { url: 'https://archive.org/', spaceId: SPACE, active: true }
    ])
  })

  it('a tab this device already holds under the same id comes to the front instead of opening twice', async () => {
    // The Open tabs scope carries the tab records too (ID-10): the laptop's `hn` is this
    // device's `hn`.
    remote = [
      {
        deviceId: 'device-laptop',
        deviceName: 'Work laptop',
        updatedAt: NOW - 2 * HOUR,
        tabs: [remoteTab('hn', 'https://news.ycombinator.com/', 'Hacker News', NOW - HOUR)]
      }
    ]
    show(stateOf(pages(), { sync: sync(true) }))
    await openRecent()
    act(() => rowByTitle('Hacker News').click())
    expect(of('tab.activate')).toEqual([{ tabId: 'hn' }])
    expect(of('tab.create')).toEqual([])
  })

  it("a device's heading held offers Hide device; hidden, it leaves the list with a row to show it again", async () => {
    remote = devices()
    show(stateOf(pages(), { sync: sync(true) }))
    await openRecent()
    const laptop = document.querySelector<HTMLElement>(
      '[data-device-id="device-laptop"] .zen-recent-device-button'
    )!
    expect(laptop.getAttribute('aria-haspopup')).toBe('menu')
    act(() => {
      laptop.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      )
    })
    await settle()
    await land()
    expect(sheetTitle()).toBe('Work laptop')
    expect(sheetRows()).toEqual(['Hide device'])
    act(() => buttonByText('Hide device')!.click())
    await land()
    expect(hiddenDevicesStore.get().hidden.has('device-laptop')).toBe(true)
    expect(recentTexts()).toEqual([
      '# Recently closed',
      'Tabs you close appear here',
      '# From your other devices',
      '# Home desktopLast active 3 min ago',
      'Internet Archive',
      'Show 1 hidden device'
    ])
    act(() => byTestId('overview-recent-show-hidden')!.click())
    expect(hiddenDevicesStore.get().hidden.size).toBe(0)
    expect(recentTexts()).toContain('# Work laptopLast active 2 h ago')
  })

  it('with sync off the group says so and its row opens Settings › Sync; with Open tabs off it says that instead', async () => {
    show(stateOf(pages(), { sync: sync(false) }))
    await openRecent()
    expect(byTestId('overview-recent-sync-off')?.textContent).toBe(
      'Turn on sync to see tabs from your other devices'
    )
    expect(of('sync.tabsFromDevices')).toEqual([])
    act(() => buttonByText('Turn on sync')!.click())
    expect(of('page.open')).toEqual([{ id: 'settings', section: 'sync' }])

    act(() => browserStore.set({ state: stateOf(pages(), { sync: sync(true, false) }) }))
    render(stateOf(pages(), { sync: sync(true, false) }))
    await settle()
    expect(byTestId('overview-recent-tabs-off')?.textContent).toBe(
      'Turn on Open tabs in What you sync to see them'
    )
    expect(buttonByText('Sync settings')).toBeDefined()
    expect(of('sync.tabsFromDevices')).toEqual([])
  })

  it('with sync on and no other device the group has its own sentence', async () => {
    remote = []
    show(stateOf(pages(), { sync: sync(true) }))
    await openRecent()
    expect(byTestId('overview-recent-no-devices')?.textContent).toBe(
      'No open tabs on your other devices yet'
    )
  })

  it('reads the lists again when the core says they changed', async () => {
    remote = devices()
    show(stateOf(pages(), { sync: sync(true) }))
    await openRecent()
    expect(of('sync.tabsFromDevices')).toHaveLength(1)
    // Another device published: the status' version moves, the pane asks once more.
    const moved = { ...sync(true), remoteTabsVersion: version + 1 }
    act(() => browserStore.set({ state: stateOf(pages(), { sync: moved }) }))
    render(stateOf(pages(), { sync: moved }))
    await settle()
    expect(of('sync.tabsFromDevices')).toHaveLength(2)
    // A tab closed here: the core's event, the list read again.
    closed = [entry('c1', 'Hacker News', 'https://news.ycombinator.com/', NOW)]
    act(() => {
      for (const listener of changeListeners) listener()
    })
    await settle()
    expect(recentTexts()).toContain('Hacker News')
  })
})
