// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ArchivedTabSummary, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'

/*
 * The switcher's Inactive tabs (matrix TAB-20; v2 draft §9.3, §9.11, §9.17, §9.19, §9.23,
 * §9.24, §9.34, §10.3): the entry is the segment row's trailing control – an icon button with
 * the count badge, there only while the archive holds something and never on the private pane,
 * never a fourth segment – and opens the list sheet on the frame's dialog host: one row per
 * archived tab, most recently used first, with its close; a tap restores the tab and the
 * overview leaves on it; the footer's Restore all and Close all act on the whole list, Close
 * all asking first on a stacked prompt without an icon; the list follows the core's
 * `inactiveTabs.changed`, down to the empty sentence. Rendered for real in happy-dom, the frame
 * loop cranked by hand.
 */

const SPACE = 'space'
const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

/** The core: every command is taken; the archive is `archived`, most recently used first. */
let archived: ArchivedTabSummary[] = []
const changeListeners = new Set<() => void>()
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) => {
  if (name === 'inactiveTabs.list') return [...archived]
  return null
})
Object.assign(window, {
  zen: {
    invoke,
    on: (name: string, listener: () => void) => {
      if (name === 'inactiveTabs.changed') changeListeners.add(listener)
      return () => changeListeners.delete(listener)
    }
  }
})
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { TabOverview } = await import('../TabOverview')
const { cancelLift } = await import('../useCardLift')
const { clearDepartures } = await import('../departureStore')
const { layoutAnimations } = await import('@renderer/lib/motion/flip')
const { FrameDialogHost } = await import('@renderer/lib/portals')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore, claimMessageCards, uiStore } = await import('@renderer/lib/ui')
const { stageStore } = await import('@renderer/lib/gestures/stage')
const { resetOverviewPane } = await import('@renderer/lib/privateTabs')
const { COVERED_TIMEOUT_MS } = await import('@renderer/lib/pageView')
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

/** `tabs` in track order, the first active; `archivedTabCount` as the core's snapshot says. */
function stateOf(tabs: Tab[], archivedTabCount: number, patch: Partial<UIState> = {}): UIState {
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
    capabilities: { windowControls: false, inactiveTabs: true },
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
    archivedTabCount,
    sync: { enabled: false, scope: { openTabs: false } },
    ...patch
  } as unknown as UIState
}

const two = (archivedTabCount: number, patch: Partial<UIState> = {}): UIState =>
  stateOf(
    [
      tab('a', 'https://a.example/', { title: 'Alpha' }),
      tab('b', 'https://b.example/', { title: 'Beta' })
    ],
    archivedTabCount,
    patch
  )

/** An archived tab as the core lists it. */
function entry(
  id: string,
  title: string,
  url: string,
  lastActiveAt: number,
  archivedAt = NOW - DAY
): ArchivedTabSummary {
  return { id: `closed:${id}`, title, url, favicon: null, lastActiveAt, archivedAt }
}

/** The core's archive changed (`inactiveTabs.changed`) and now holds `entries`. */
function archiveNow(entries: ArchivedTabSummary[]): void {
  archived = entries
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

/** The async work between one step and the next: a list read, a commit. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

/** Run the springs out: a sheet lands or leaves, a picked row's action runs. */
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
  archived = []
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

afterEach(() => {
  act(() => cancelLift())
  act(() => clearDepartures())
  act(() => resetOverviewPane())
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

const entryButton = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="overview-inactive-tabs"]')
const buttonsByText = (text: string): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>('.zen-frame-dialogs button')].filter(
    (b) => b.textContent?.trim() === text
  )
/** A v2 button's tone: the accent-filled primary, the danger ink, or the plain secondary (§6). */
const tone = (b: HTMLElement): 'primary' | 'danger' | 'plain' =>
  b.hasAttribute('data-primary') ? 'primary' : b.hasAttribute('data-danger') ? 'danger' : 'plain'
/** The titles of the sheets up on the frame's dialog host, lowest first. */
const dialogTitles = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('.zen-frame-dialogs h2')].map(
    (h) => h.textContent?.trim() ?? ''
  )
const rows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('.zen-frame-dialogs .zen-phone-row')
]
const rowLabels = (): Array<string | null> =>
  rows().map((r) => r.querySelector('[role="button"]')?.getAttribute('aria-label') ?? null)
const of = (name: string): unknown[] =>
  invoke.mock.calls.filter(([n]) => n === name).map(([, args]) => args)
const time = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/**
 * Let a sheet that has just mounted come up: the chassis first waits for the page under it to
 * give way to its picture (`coverPageUnderSheet`, §11.5) – here, with no page view to report,
 * until that wait's timeout – and then rides its spring to its detent.
 */
async function present(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(COVERED_TIMEOUT_MS + 1)
  })
  await land()
}

/** Tap the entry and let the sheet read the archive and come up. */
async function openSheet(): Promise<void> {
  act(() => entryButton()!.click())
  await settle()
  await present()
}

/** Two archived tabs: one used earlier today, one yesterday, most recently used first. */
const archive = (): ArchivedTabSummary[] => [
  entry('x', 'X marks', 'https://www.x.example/path', NOW - 3 * 60 * 60 * 1000),
  entry('y', 'Why', 'https://y.example/', NOW - DAY)
]

// --- the entry ---------------------------------------------------------------------------------

describe('the segment row’s entry', () => {
  it('is not there while the archive is empty, as Chrome’s card is not', () => {
    show(two(0))
    expect(entryButton()).toBeNull()
    // The segment itself is untouched: the two panes, no fourth.
    expect(document.querySelectorAll('[role="tablist"] [role="tab"]')).toHaveLength(2)
  })

  it('is the segment row’s trailing icon button with the count badge (§9.3, §9.19), named for a reader and for the harness, not a segment (§9.34)', () => {
    show(two(3))
    const button = entryButton()!
    expect(button.getAttribute('aria-label')).toBe('Inactive tabs, 3')
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.classList.contains('zen-v2-icon-button')).toBe(true)
    expect(button.querySelector('.zen-v2-badge')?.textContent).toBe('3')
    // Beside the segment in one row, after it; the tablist still holds its two tabs.
    const tablist = document.querySelector<HTMLElement>('[role="tablist"]')!
    expect(button.parentElement).toBe(tablist.parentElement)
    expect(tablist.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(tablist.querySelectorAll('[role="tab"]')).toHaveLength(2)
    expect(button.getAttribute('role')).toBeNull()
  })

  it('has no place on the private pane: a private tab is never archived', () => {
    const state = two(3, {
      capabilities: {
        windowControls: false,
        inactiveTabs: true,
        privateTabs: true
      } as unknown as UIState['capabilities']
    })
    const priv = tab('p', 'https://one.example/', {
      title: 'One',
      containerId: PRIVATE_CONTAINER_ID
    })
    show({
      ...state,
      tabs: { ...state.tabs, p: priv },
      spaces: [{ ...state.spaces[0], tabIds: [...state.spaces[0].tabIds, 'p'] }]
    })
    expect(entryButton()).not.toBeNull()
    act(() => document.querySelector<HTMLElement>('[data-testid="overview-pane-private"]')!.click())
    expect(entryButton()).toBeNull()
    act(() => document.querySelector<HTMLElement>('[data-testid="overview-pane-tabs"]')!.click())
    expect(entryButton()).not.toBeNull()
  })
})

// --- the list ----------------------------------------------------------------------------------

describe('the Inactive tabs sheet', () => {
  it('reads the archive as it opens and lists one row per tab – title, host, when last used (§10.3) – with the two whole-list actions as footer peers (§9.11)', async () => {
    show(two(2))
    archived = archive()
    await openSheet()
    expect(of('inactiveTabs.list')).toHaveLength(1)
    expect(entryButton()!.getAttribute('aria-expanded')).toBe('true')
    expect(dialogTitles()).toEqual(['Inactive tabs'])
    expect(rowLabels()).toEqual([
      `X marks, x.example · ${time(NOW - 3 * 60 * 60 * 1000)}`,
      'Why, y.example · Yesterday'
    ])
    // Each row's close is its trailing 44 control, named for the tab.
    expect(rows()[0].querySelector('.zen-list-trailing button')?.getAttribute('aria-label')).toBe(
      'Close X marks'
    )
    // Both plain secondaries (§9.11): nothing here destroys the user's data – a closed inactive
    // tab's page stays in History – so neither carries the danger ink (§6, §10.5) nor is
    // recommended over the other.
    const footer = document.querySelector<HTMLElement>('.zen-frame-dialogs .zen-sheet-footer')!
    const actions = [...footer.querySelectorAll<HTMLElement>('button')]
    expect(actions.map((b) => b.textContent?.trim())).toEqual(['Restore all', 'Close all'])
    expect(actions.map((b) => tone(b))).toEqual(['plain', 'plain'])
  })

  it('a tap restores the tab – the sheet leaves first – and the overview leaves on the tab that comes back', async () => {
    show(two(2))
    archived = archive()
    await openSheet()
    act(() => rows()[0].querySelector<HTMLElement>('[role="button"]')!.click())
    await land()
    expect(of('inactiveTabs.restore')).toEqual([{ id: 'closed:x' }])
    expect(dialogTitles()).toEqual([])
    // The browser shows the restored tab as a new record at the start of the space: the
    // overview leaves on it.
    const state = two(1)
    const restored = tab('x2', 'https://www.x.example/path', { title: 'X marks' })
    act(() =>
      browserStore.set({
        state: {
          ...state,
          tabs: { ...state.tabs, x2: restored },
          spaces: [
            { ...state.spaces[0], tabIds: ['x2', ...state.spaces[0].tabIds], activeTabId: 'x2' }
          ]
        }
      })
    )
    await settle()
    expect(stageStore.get().overview.heroTabId).toBe('x2')
  })

  it('a row’s close is the core’s inactiveTabs.close, and the list follows the core: the row leaves when the archive says so', async () => {
    show(two(2))
    archived = archive()
    await openSheet()
    act(() => rows()[0].querySelector<HTMLElement>('.zen-list-trailing button')!.click())
    await settle()
    expect(of('inactiveTabs.close')).toEqual([{ id: 'closed:x' }])
    // The sheet stays; the core files the change and says so.
    expect(dialogTitles()).toEqual(['Inactive tabs'])
    act(() => archiveNow([archive()[1]]))
    await settle()
    expect(rowLabels()).toEqual(['Why, y.example · Yesterday'])
  })

  it('Restore all brings every tab back once the sheet is gone', async () => {
    show(two(2))
    archived = archive()
    await openSheet()
    act(() => buttonsByText('Restore all')[0].click())
    await land()
    expect(of('inactiveTabs.restoreAll')).toHaveLength(1)
    expect(dialogTitles()).toEqual([])
  })

  it('Close all asks first on a stacked prompt (§9.23, §9.24) in Chrome’s words and with no icon; Cancel keeps the list', async () => {
    show(two(2))
    archived = archive()
    await openSheet()
    act(() => buttonsByText('Close all')[0].click())
    await present()
    expect(dialogTitles()).toEqual(['Inactive tabs', 'Close 2 inactive tabs?'])
    const prompt = [...document.querySelectorAll<HTMLElement>('.zen-frame-dialogs h2')].at(-1)!
    // A confirmation of the user's own command carries no icon (§9.23).
    expect(prompt.querySelector('svg')).toBeNull()
    expect(prompt.closest('.zen-sheet-title-block')?.querySelector('p')?.textContent).toBe(
      'You can always get them back in History'
    )
    // The list sheet recedes under the question and is inert while it stands.
    const sheets = [...document.querySelectorAll<HTMLElement>('.zen-frame-dialogs .zen-sheet')]
    expect(sheets).toHaveLength(2)
    expect(sheets.map((s) => s.hasAttribute('data-recessed'))).toEqual([true, false])
    // The prompt's footer: Cancel first, the verb last as the primary – a recoverable command
    // the app may recommend (§6 withholds the recommendation only where the loss is real);
    // no danger ink, since History keeps the pages.
    const promptFooter = [
      ...document.querySelectorAll<HTMLElement>('.zen-frame-dialogs .zen-sheet-footer')
    ].at(-1)!
    const promptActions = [...promptFooter.querySelectorAll<HTMLElement>('button')]
    expect(promptActions.map((b) => b.textContent?.trim())).toEqual(['Cancel', 'Close all'])
    expect(promptActions.map((b) => tone(b))).toEqual(['plain', 'primary'])
    const confirm = buttonsByText('Close all').filter((b) => !b.closest('[inert]'))
    expect(confirm).toHaveLength(1)
    expect(confirm[0]).toBe(promptActions[1])
    act(() => buttonsByText('Cancel')[0].click())
    await land()
    expect(of('inactiveTabs.closeAll')).toEqual([])
    expect(dialogTitles()).toEqual(['Inactive tabs'])
    expect(rowLabels()).toHaveLength(2)
  })

  it('Close all confirmed: the question leaves, then the list, and only then do the tabs go', async () => {
    show(two(2))
    archived = archive()
    await openSheet()
    act(() => buttonsByText('Close all')[0].click())
    await present()
    const confirm = buttonsByText('Close all').filter((b) => !b.closest('[inert]'))[0]
    act(() => confirm.click())
    // The question rides down first; the tabs are still there.
    await act(async () => {
      frames.run(3)
    })
    expect(of('inactiveTabs.closeAll')).toEqual([])
    await land()
    await land()
    expect(of('inactiveTabs.closeAll')).toHaveLength(1)
    expect(dialogTitles()).toEqual([])
  })

  it('emptied while up, it says where the threshold stands (§9.17) and drops its footer', async () => {
    show(two(1))
    archived = [archive()[1]]
    await openSheet()
    act(() => archiveNow([]))
    await settle()
    expect(rows()).toHaveLength(0)
    expect(document.querySelector('.zen-frame-dialogs .zen-phone-empty p')?.textContent).toBe(
      "Tabs you haven't used for 21 days will appear here"
    )
    expect(document.querySelector('.zen-frame-dialogs .zen-sheet-footer button')).toBeNull()
  })
})
