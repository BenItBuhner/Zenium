// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ClosedEntrySummary, Folder, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { MOBILE_BOOKMARKS_ID } from '@shared/bookmarks'
import { BLANK_URL } from '@shared/url'

/*
 * The phone overview's select-tabs mode (matrix TAB-08, TAB-35, SH-12; v2 §9.6, §9.29, §9.30,
 * §9.33): on from the header menu's "Select Tabs" or a card's hold sheet (with that card picked),
 * the cards are checkboxes, the header REPLACES its row with Android's contextual bar – the ×
 * (Done), the live count, Select all / Deselect all – and a bottom action strip holds Close,
 * Group, Bookmark and Share, each off when nothing among the picks is its. Done, back and every
 * action end the mode. Rendered for real in happy-dom with the sheets on the frame's dialog
 * host, the frame loop cranked by hand, the core stubbed.
 */

const SPACE = 'space'
const GROUP = 'g'
const NEW_GROUP = 'g2'
const NOW = 1_700_000_000_000

/**
 * The core: every command is taken; a group made is `NEW_GROUP`; the bookmarks folder made from
 * tabs is `BOOKMARK_FOLDER`, titled as asked.
 */
const BOOKMARK_FOLDER = 'bm-folder'
let closed: ClosedEntrySummary[] = []
const changeListeners = new Set<() => void>()
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name, args) => {
  if (name === 'session.recentlyClosed') return [...closed]
  if (name === 'folder.create') return NEW_GROUP
  if (name === 'bookmark.createFromTabs')
    return { id: BOOKMARK_FOLDER, title: (args as { title: string }).title }
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
const { activeLiftPointer, cancelLift, liftStore } = await import('../useCardLift')
const { clearDepartures, departStore } = await import('../departureStore')
const { layoutAnimations } = await import('@renderer/lib/motion/flip')
const { FrameDialogHost } = await import('@renderer/lib/portals')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore, claimMessageCards, pickToastAction, uiStore } =
  await import('@renderer/lib/ui')
const { stageStore } = await import('@renderer/lib/gestures/stage')
const { CLOSE_SETTLE_MS } = await import('@renderer/lib/closeUndo')
const { resetOverviewPane } = await import('@renderer/lib/privateTabs')
const { dispatchBackEvent, topBackSurface } = await import('@renderer/lib/back')
const { bookmarkFolderTitle } = await import('@renderer/lib/overviewSelection')
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

const research: Folder = {
  id: GROUP,
  spaceId: SPACE,
  name: 'Research',
  icon: '📚',
  collapsed: false,
  color: 'blue'
}

/** `tabs` in track order; the first is active. */
function stateOf(
  tabs: Tab[],
  folders: Folder[] = [],
  settings: Partial<UIState['settings']> = {}
): UIState {
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
    folders: Object.fromEntries(folders.map((f) => [f.id, f])),
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

/** Three pages, a pinned page and a blank tab, loose; Alpha is in view. */
const five = (): UIState =>
  stateOf([
    tab('a', 'https://a.example/', { title: 'Alpha' }),
    tab('b', 'https://b.example/', { title: 'Beta' }),
    tab('c', 'https://c.example/', { title: 'Gamma' }),
    tab('p', 'https://pinned.example/', { title: 'Pinned', pinned: true }),
    tab('blank', BLANK_URL)
  ])

/** Two loose pages and a group of two. */
const grouped = (): UIState =>
  stateOf(
    [
      tab('a', 'https://a.example/', { title: 'Alpha' }),
      tab('b', 'https://b.example/', { title: 'Beta' }),
      tab('m1', 'https://m1.example/', { title: 'Member one', folderId: GROUP }),
      tab('m2', 'https://m2.example/', { title: 'Member two', folderId: GROUP })
    ],
    [research]
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

/** The async work between one step and the next: a list read, a command's answer, a commit. */
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
  uiStore.set({ toasts: [], overlay: 'none', overlayFolderId: null })
  browserStore.set({ state: null })
  stageStore.set({
    ...stageStore.get(),
    overview: { phase: 'closed', progress: 0, heroTabId: null, target: 0 }
  })
  act(() => resetOverviewPane())
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
const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const buttonByText = (text: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === text)
/** The rows of the sheet that is up. */
const sheetRows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('.zen-sheet .zen-sheet-item')
]
const sheetTitle = (): string | undefined =>
  document.querySelector<HTMLElement>('.zen-sheet .zen-sheet-title')?.textContent?.trim()
/**
 * The commands the grid sent the browser, in order; the list reads, the cards' picture reads
 * and the sheet chassis's own page capture (`overlay.snapshot`) left out.
 */
const CHASSIS = new Set(['session.recentlyClosed', 'overlay.snapshot', 'thumbnail.load'])
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

/** The card of tab `id`: the checkbox in the mode, the button out of it. */
const card = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-cell="${id}"] > [role]`)!
/** The cards that are checkboxes, with their state, in the grid's order. */
const checkboxes = (): Array<[string, boolean]> =>
  [...document.querySelectorAll<HTMLElement>('[data-cell] > [role="checkbox"]')].map((el) => [
    el.closest('[data-cell]')!.getAttribute('data-cell')!,
    el.getAttribute('aria-checked') === 'true'
  ])
/** The overview's header row (the cards' title rows are not it). */
const header = (): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('header')].find(
    (h) => !h.classList.contains('zen-overview-card-header')
  )!
const headerButtons = (): string[] =>
  [...header().querySelectorAll<HTMLElement>('button')].map(
    (b) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? ''
  )
const countTitle = (): HTMLElement | null => byTestId('overview-selected-count')
/** The action strip's buttons: id, name and whether it is off. */
const actions = (): Array<[string, string, boolean]> =>
  [...document.querySelectorAll<HTMLElement>('.zen-overview-action')].map((b) => [
    b.getAttribute('data-testid')!.replace('overview-action-', ''),
    b.getAttribute('aria-label')!,
    b.hasAttribute('disabled')
  ])
const action = (id: string): HTMLElement => byTestId(`overview-action-${id}`)!

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

/** Enter the mode from the header's menu. */
async function enter(): Promise<void> {
  await openMenu()
  await pick('Select Tabs')
}

// --- a finger ----------------------------------------------------------------------------------

const POINTER = 7

function pointer(type: string, target: EventTarget, x: number, y: number): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        pointerId: POINTER,
        clientX: x,
        clientY: y,
        button: 0,
        bubbles: true,
        cancelable: true,
        pointerType: 'touch',
        isPrimary: true
      })
    )
  })
}

/**
 * A tap on the card `id`: the touch down and up, then the click the browser fires for them (the
 * card's lift hears the touch and lets the click through; a click alone would be read as the
 * tail of a lift that went before).
 */
function tapCard(id: string): void {
  const el = card(id)
  pointer('pointerdown', el, 50, 50)
  pointer('pointerup', el, 50, 50)
  act(() => el.click())
}

/** Hold the card `id` until it comes off the grid, then let go in place: its hold sheet opens. */
async function holdCard(id: string): Promise<void> {
  const button = card(id)
  pointer('pointerdown', button, 50, 50)
  act(() => vi.advanceTimersByTime(400))
  expect(liftStore.get()).toMatchObject({ tabId: id, phase: 'lifted' })
  expect(activeLiftPointer()).toBe(POINTER)
  pointer('pointerup', button, 50, 50)
  act(() => vi.advanceTimersByTime(300))
  await land()
}

// --- entering and leaving ----------------------------------------------------------------------

describe('entering the mode', () => {
  it("from the header menu's first row: the cards become checkboxes, none checked; the header row is replaced by ×, 'Select tabs' and Select all; the strip is up with every action off (§9.6, §9.30)", async () => {
    show(five())
    // Before: the overview's own header row, cards as buttons, no strip.
    expect(headerButtons()).toEqual(['Spaces', 'More'])
    expect(checkboxes()).toEqual([])
    expect(byTestId('overview-actions')).toBeNull()
    await enter()
    // The cards on show – the pinned one too, the blank tab too – are checkboxes, unchecked.
    expect(checkboxes()).toEqual([
      ['p', false],
      ['a', false],
      ['b', false],
      ['c', false],
      ['blank', false]
    ])
    // ONE header row, its content swapped: the × (Done) leading, the count as the title, Select
    // all trailing; the space's name, the count and the two icon buttons are gone from it.
    const rows = [...document.querySelectorAll('header')].filter(
      (h) => !h.classList.contains('zen-overview-card-header')
    )
    expect(rows).toHaveLength(1)
    expect(headerButtons()).toEqual(['Done', 'Select all'])
    expect(header().textContent).not.toContain('Work')
    expect(byTestId('overview-count')).toBeNull()
    expect(countTitle()?.textContent).toBe('Select tabs')
    expect(countTitle()?.getAttribute('aria-live')).toBe('polite')
    // The action strip, every action named and off: nothing is picked.
    expect(actions()).toEqual([
      ['close', 'Close 0 tabs', true],
      ['group', 'Group 0 tabs', true],
      ['bookmark', 'Bookmark 0 tabs', true],
      ['share', 'Share 0 tabs', true]
    ])
    // The New Tab card takes no pick meanwhile.
    expect(byTestId('overview-new-tab')?.hasAttribute('disabled')).toBe(true)
    // Nothing was asked of the core by entering.
    expect(commands()).toEqual([])
  })

  it("from a card's hold sheet: the mode opens with that card picked and counted", async () => {
    show(five())
    await holdCard('b')
    // The hold sheet leads with the mode's row (a menu item: Title Case, §9.1).
    expect(sheetRows().map((r) => r.textContent?.trim())).toEqual([
      'Select Tabs',
      'New Group',
      'Close Other Tabs (3)',
      'Close Tab'
    ])
    await pick('Select Tabs')
    expect(checkboxes()).toEqual([
      ['p', false],
      ['a', false],
      ['b', true],
      ['c', false],
      ['blank', false]
    ])
    expect(countTitle()?.textContent).toBe('1 selected')
    expect(card('b').hasAttribute('data-selected')).toBe(true)
    expect(actions()).toEqual([
      ['close', 'Close 1 tab', false],
      ['group', 'Group 1 tab', false],
      ['bookmark', 'Bookmark 1 tab', false],
      ['share', 'Share 1 tab', false]
    ])
  })

  it('a tap toggles a card and the count follows; Done ends the mode with every card in its place and the header row back', async () => {
    show(five())
    await enter()
    tapCard('a')
    tapCard('c')
    expect(
      checkboxes()
        .filter(([, on]) => on)
        .map(([id]) => id)
    ).toEqual(['a', 'c'])
    expect(countTitle()?.textContent).toBe('2 selected')
    tapCard('a')
    expect(
      checkboxes()
        .filter(([, on]) => on)
        .map(([id]) => id)
    ).toEqual(['c'])
    expect(countTitle()?.textContent).toBe('1 selected')
    // Unticking the last card keeps the mode up at "Select tabs" (Chrome's Edit mode).
    tapCard('c')
    expect(countTitle()?.textContent).toBe('Select tabs')
    expect(checkboxes()).toHaveLength(5)
    // A tap on a card while selecting never opened it.
    expect(stageStore.get().overview.phase).toBe('open')
    // Done: the cards are buttons again, in the same cells, the header row is the overview's.
    act(() => byTestId('overview-select-done')!.click())
    expect(checkboxes()).toEqual([])
    expect(
      [...document.querySelectorAll('[data-cell]')].map((c) => c.getAttribute('data-cell'))
    ).toEqual(['p', 'a', 'b', 'c', 'blank', 'new-tab'])
    expect(headerButtons()).toEqual(['Spaces', 'More'])
    expect(byTestId('overview-count')?.textContent).toBe('5 tabs')
    expect(commands()).toEqual([])
  })

  it('Select all picks every card on show and reads Deselect all; Deselect all keeps the mode at none', async () => {
    show(five())
    await enter()
    expect(byTestId('overview-select-all')?.textContent).toBe('Select all')
    act(() => byTestId('overview-select-all')!.click())
    expect(checkboxes().every(([, on]) => on)).toBe(true)
    expect(countTitle()?.textContent).toBe('5 selected')
    expect(byTestId('overview-select-all')?.textContent).toBe('Deselect all')
    // The pinned pick and the blank tab count for Close, not for Group (pinned) or the pages'
    // actions (blank): the names say what each acts on, the number the picker's title and the
    // toast will say.
    expect(actions()).toEqual([
      ['close', 'Close 5 tabs', false],
      ['group', 'Group 4 tabs', false],
      ['bookmark', 'Bookmark 4 tabs', false],
      ['share', 'Share 4 tabs', false]
    ])
    act(() => byTestId('overview-select-all')!.click())
    expect(checkboxes().some(([, on]) => on)).toBe(false)
    expect(countTitle()?.textContent).toBe('Select tabs')
    expect(byTestId('overview-select-all')?.textContent).toBe('Select all')
  })

  it('the mode is a back surface: the system back ends it and leaves the overview up', async () => {
    show(five())
    expect(topBackSurface()?.name).not.toBe('overview-selection')
    await enter()
    tapCard('a')
    expect(topBackSurface()?.name).toBe('overview-selection')
    act(() => {
      dispatchBackEvent('commit')
    })
    expect(checkboxes()).toEqual([])
    expect(headerButtons()).toEqual(['Spaces', 'More'])
    expect(stageStore.get().overview.phase).toBe('open')
    expect(topBackSurface()?.name).not.toBe('overview-selection')
  })

  it('the picked card takes the selected mark and the check in its title row; the close is gone while the mode is on', async () => {
    show(five())
    // Out of the mode: a close per card, no check.
    expect(document.querySelector('[data-cell="a"] [aria-label^="Close "]')).not.toBeNull()
    await enter()
    tapCard('a')
    const a = card('a')
    expect(a.getAttribute('role')).toBe('checkbox')
    expect(a.getAttribute('aria-checked')).toBe('true')
    expect(a.hasAttribute('data-selected')).toBe(true)
    expect(card('b').hasAttribute('data-selected')).toBe(false)
    // The check is the card's own presentational box, one per card, and no close is drawn.
    expect(a.querySelectorAll(':scope > .zen-overview-card-check')).toHaveLength(1)
    expect(a.querySelector('.zen-overview-card-check')?.getAttribute('aria-hidden')).toBe('true')
    expect(document.querySelector('[data-cell="a"] [aria-label^="Close "]')).toBeNull()
    // The title row keeps the close's slot clear for the check.
    expect(a.querySelector('.zen-overview-card-close-space')).not.toBeNull()
  })
})

// --- the actions -------------------------------------------------------------------------------

describe('the action strip', () => {
  it('each action is off when nothing among the picks is its: a pinned pick alone leaves Group off, a blank tab alone leaves Bookmark and Share off, Close takes any (§9.30)', async () => {
    show(five())
    await enter()
    // An action that is off names the nothing it has: "Group 0 tabs" for the pinned pick alone.
    tapCard('p')
    expect(actions()).toEqual([
      ['close', 'Close 1 tab', false],
      ['group', 'Group 0 tabs', true],
      ['bookmark', 'Bookmark 1 tab', false],
      ['share', 'Share 1 tab', false]
    ])
    tapCard('p')
    tapCard('blank')
    expect(actions()).toEqual([
      ['close', 'Close 1 tab', false],
      ['group', 'Group 1 tab', false],
      ['bookmark', 'Bookmark 0 tabs', true],
      ['share', 'Share 0 tabs', true]
    ])
  })

  it('Close departs every picked card at once, closes them in turn, ends the mode, and one toast undoes the lot', async () => {
    show(five())
    await enter()
    tapCard('a')
    tapCard('c')
    act(() => action('close').click())
    // Immediate: the mode is off, the two cards are on their way, the close is out – one ask
    // for the two, the core closing them one after the other so a page that objects asks
    // "Leave site?" on its own tab (`tab.closeMany`, PUI-28).
    expect(checkboxes()).toEqual([])
    expect(departStore.get().items.map((i) => i.key)).toEqual(['a', 'c'])
    expect(commands()).toEqual([['tab.closeMany', { tabIds: ['a', 'c'] }]])
    expect(toasts()).toEqual([])
    // The core files them; ONE toast counts them and Undo restores newest first.
    const state = five()
    file(entry(state.tabs.a, NOW), entry(state.tabs.c, NOW))
    await settle()
    expect(toasts()).toEqual([['2 tabs closed', 'Undo', false]])
    act(() => pickToastAction(liveToast().id))
    await settle()
    expect(of('session.restoreClosed')).toEqual([{ id: 'closed:c' }, { id: 'closed:a' }])
    // The user was on a, which came back: it is activated again.
    expect(of('tab.activate')).toEqual([{ tabId: 'a' }])
  })

  it('Group opens the picker – "New group" first (sentence case), then the groups with their counts – titled with the count; New group makes a group and moves the picks in', async () => {
    show(grouped())
    await enter()
    tapCard('a')
    tapCard('b')
    act(() => action('group').click())
    await land()
    expect(sheetTitle()).toBe('Group 2 tabs')
    expect(sheetRows().map((r) => r.textContent?.trim())).toEqual([
      'New group',
      'Add to Research (2)'
    ])
    await pick('New group')
    expect(checkboxes()).toEqual([])
    expect(of('folder.create')).toEqual([expect.objectContaining({ spaceId: SPACE, rename: true })])
    expect(of('tab.moveToFolder')).toEqual([
      { tabId: 'a', folderId: NEW_GROUP },
      { tabId: 'b', folderId: NEW_GROUP }
    ])
  })

  it('an existing group takes the picks; a pinned pick is left out of the move', async () => {
    show(grouped())
    await enter()
    tapCard('a')
    act(() => action('group').click())
    await land()
    await pick('Add to Research (2)')
    expect(of('folder.create')).toEqual([])
    expect(of('tab.moveToFolder')).toEqual([{ tabId: 'a', folderId: GROUP }])
  })

  it('Group leaves the pinned picks where they are: the groupable ones alone move', async () => {
    show(five())
    await enter()
    tapCard('p')
    tapCard('a')
    // Two picks, one groupable: the name and the picker's title say the one.
    expect(action('close').getAttribute('aria-label')).toBe('Close 2 tabs')
    expect(action('group').getAttribute('aria-label')).toBe('Group 1 tab')
    act(() => action('group').click())
    await land()
    // No group yet: the picker is "New group" alone, titled with the groupable count.
    expect(sheetTitle()).toBe('Group 1 tab')
    expect(sheetRows().map((r) => r.textContent?.trim())).toEqual(['New group'])
    await pick('New group')
    expect(of('tab.moveToFolder')).toEqual([{ tabId: 'a', folderId: NEW_GROUP }])
  })

  it("Bookmark files the picked pages – not the blank tab – in one dated folder under the phone's Mobile bookmarks, quietly, and its own toast offers Open", async () => {
    show(five())
    await enter()
    act(() => byTestId('overview-select-all')!.click())
    act(() => action('bookmark').click())
    await settle()
    expect(checkboxes()).toEqual([])
    const title = bookmarkFolderTitle(new Date(NOW))
    expect(title).toMatch(/^Tabs from /)
    expect(of('bookmark.createFromTabs')).toEqual([
      { tabIds: ['p', 'a', 'b', 'c'], title, parentId: MOBILE_BOOKMARKS_ID, quiet: true }
    ])
    expect(toasts()).toEqual([[`Bookmarked 4 tabs in “${title}”`, 'Open', false]])
    // Open: the overview leaves and the Bookmarks panel opens at the folder.
    act(() => pickToastAction(liveToast().id))
    await settle()
    expect(stageStore.get().overview.phase).not.toBe('open')
    expect(uiStore.get().overlay).toBe('bookmarks')
    expect(uiStore.get().overlayFolderId).toBe(BOOKMARK_FOLDER)
  })

  it('Share hands the picked pages to the system sheet as a text list, titles over addresses, and ends the mode', async () => {
    show(five())
    await enter()
    tapCard('a')
    tapCard('blank')
    tapCard('c')
    act(() => action('share').click())
    expect(checkboxes()).toEqual([])
    expect(of('app.share')).toEqual([
      {
        title: '2 tabs',
        text: 'Alpha\nhttps://a.example/\n\nGamma\nhttps://c.example/'
      }
    ])
  })
})

// --- the grid changing under the mode ----------------------------------------------------------

describe('the grid under the mode', () => {
  it('a pick whose tab the core closed elsewhere leaves the picks; the mode stays on', async () => {
    show(five())
    await enter()
    tapCard('a')
    tapCard('b')
    expect(countTitle()?.textContent).toBe('2 selected')
    const state = five()
    const without = { ...state.tabs }
    delete without.b
    show({
      ...state,
      tabs: without,
      spaces: [{ ...state.spaces[0], tabIds: ['a', 'c', 'p', 'blank'] }]
    })
    expect(countTitle()?.textContent).toBe('1 selected')
    expect(checkboxes()).toEqual([
      ['p', false],
      ['a', true],
      ['c', false],
      ['blank', false]
    ])
  })

  it('the private pane has the mode without Group: its pages share and bookmark', async () => {
    const state = stateOf([
      tab('r', 'https://r.example/', { title: 'Regular' }),
      tab('p1', 'https://one.example/', { title: 'One', containerId: PRIVATE_CONTAINER_ID }),
      tab('p2', 'https://two.example/', { title: 'Two', containerId: PRIVATE_CONTAINER_ID })
    ])
    show({ ...state, capabilities: { ...state.capabilities, privateTabs: true } })
    act(() => byTestId('overview-pane-private')!.click())
    await openMenu()
    expect(sheetTitle()).toBe('Private')
    await pick('Select Tabs')
    expect(checkboxes()).toEqual([
      ['p1', false],
      ['p2', false]
    ])
    act(() => byTestId('overview-select-all')!.click())
    expect(actions()).toEqual([
      ['close', 'Close 2 tabs', false],
      ['bookmark', 'Bookmark 2 tabs', false],
      ['share', 'Share 2 tabs', false]
    ])
    act(() => action('share').click())
    expect(of('app.share')).toEqual([
      {
        title: '2 tabs',
        text: 'One\nhttps://one.example/\n\nTwo\nhttps://two.example/'
      }
    ])
  })

  it('a pane switch ends the mode: the other pane comes up out of it', async () => {
    const state = stateOf([
      tab('r', 'https://r.example/', { title: 'Regular' }),
      tab('p1', 'https://one.example/', { title: 'One', containerId: PRIVATE_CONTAINER_ID })
    ])
    show({ ...state, capabilities: { ...state.capabilities, privateTabs: true } })
    await enter()
    tapCard('r')
    expect(countTitle()?.textContent).toBe('1 selected')
    act(() => byTestId('overview-pane-private')!.click())
    await land()
    expect(countTitle()).toBeNull()
    expect(headerButtons()).toEqual(['Spaces', 'More'])
  })
})
