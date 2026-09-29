// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BookmarkNode, Space, Tab, UIState } from '@shared/types'
import { BOOKMARKS_BAR_ID } from '@shared/bookmarks'
import { NEW_TAB_URL } from '@shared/url'

/*
 * The tablet's bookmarks bar (NTP-34; Chrome 152's tablet bar, `BookmarkBarCoordinator` under
 * the toolbar): the desktop's `BookmarksBar` mounted by `TabletShell` at the head of the
 * content column beside the sidebar – the desktop's seat (App.tsx) – on the same setting
 * (`Settings.bookmarksBar`: Always, Only on new tab page, Never) read against the page's URL,
 * gone with the chrome in a page's fullscreen. The strip's overflow lists the chips that did
 * not fit in the same » panel the desktop's does – a popover, the tablet's 332 menu (§9.36),
 * never a sheet – and a folder chip opens its panel under a press. A chip lifts no link on the
 * tablet (`draggable` unset): a finger's hold is the menu, its drag the page's scroll.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

vi.mock('@renderer/components/sidebar/Sidebar', () => ({
  Sidebar: ({ compact }: { compact: boolean }) =>
    createElement('div', { 'data-sidebar-stub': compact ? 'rail' : 'expanded' })
}))
vi.mock('@renderer/components/tablet/TabletToolbar', () => ({
  TabletToolbar: ({ sidebarCollapsed }: { sidebarCollapsed: boolean }) =>
    createElement('div', { 'data-toolbar-stub': sidebarCollapsed ? 'collapsed' : 'open' })
}))
const stub = (name: string): (() => ReactElement) => {
  const Stub = (): ReactElement => createElement('div', { [`data-${name}-stub`]: '' })
  Stub.displayName = `${name}Stub`
  return Stub
}
vi.mock('@renderer/components/content/ContentArea', () => ({ ContentArea: stub('content') }))
vi.mock('@renderer/components/DragLayer', () => ({
  ChromeDropLayer: stub('drop'),
  DragLayer: stub('drag')
}))
vi.mock('@renderer/components/messages/MessageLayer', () => ({ MessageLayer: stub('messages') }))
vi.mock('@renderer/components/ModStyles', () => ({ ModStyles: () => null }))
vi.mock('@renderer/components/overlays/Onboarding', () => ({ Onboarding: stub('onboarding') }))
vi.mock('@renderer/components/phone/PhoneStage', () => ({ PhoneStage: stub('stage') }))
vi.mock('@renderer/components/phone/SpacesDrawer', () => ({ SpacesDrawer: stub('spaces') }))
vi.mock('@renderer/components/phone/useFullscreenReturn', () => ({
  useFullscreenReturn: () => undefined
}))
vi.mock('@renderer/components/TabDialogs', () => ({ TabDialogs: stub('dialogs') }))
vi.mock('@renderer/components/urlbar/Urlbar', () => ({ Urlbar: stub('urlbar') }))

const { TabletShell } = await import('../TabletShell')
const { BookmarksBar } = await import('../../bookmarks/BookmarksBar')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { holdChromeInert } = await import('@renderer/lib/portals')
const { browserStore, uiStore } = await import('@renderer/lib/ui')

// --- a profile, a window ------------------------------------------------------------------------

const SPACE = 'space'
const PAGE_URL = 'https://a.example/'

function tabAt(url: string): Tab {
  return {
    id: 'a',
    spaceId: SPACE,
    containerId: 'default',
    url,
    title: 'a',
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
    blockedCount: 0
  } as Tab
}

const node = (
  id: string,
  parentId: string,
  index: number,
  type: 'url' | 'folder',
  title: string
): BookmarkNode =>
  ({
    id,
    parentId,
    index,
    type,
    title,
    url: type === 'url' ? `https://${id}.example/` : undefined,
    dateAdded: 0
  }) as BookmarkNode

/** The bar: two pages, the Work folder (two pages inside), two pages more – five chips. */
const BOOKMARKS: BookmarkNode[] = [
  node(BOOKMARKS_BAR_ID, '0', 0, 'folder', 'Bookmarks bar'),
  node('docs', BOOKMARKS_BAR_ID, 0, 'url', 'Docs'),
  node('news', BOOKMARKS_BAR_ID, 1, 'url', 'News'),
  node('work', BOOKMARKS_BAR_ID, 2, 'folder', 'Work'),
  node('mail', BOOKMARKS_BAR_ID, 3, 'url', 'Mail'),
  node('wiki', BOOKMARKS_BAR_ID, 4, 'url', 'Wiki'),
  node('w1', 'work', 0, 'url', 'Tracker'),
  node('w2', 'work', 1, 'url', 'Board')
]

function stateOf({
  url = PAGE_URL,
  bookmarksBar = 'always',
  htmlFullscreenTabId = null
}: {
  url?: string
  bookmarksBar?: 'always' | 'newtab' | 'never'
  htmlFullscreenTabId?: string | null
} = {}): UIState {
  const tab = tabAt(url)
  const space: Space = {
    id: SPACE,
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: [tab.id],
    activeTabId: tab.id,
    pinnedCollapsed: false
  }
  return {
    platform: 'android',
    capabilities: { windowControls: false },
    tabs: { [tab.id]: tab },
    spaces: [space],
    activeSpaceId: SPACE,
    folders: {},
    splitGroups: {},
    essentialTabIds: [],
    foreignTabIds: [],
    containers: [],
    settings: {
      colorScheme: 'light',
      sidebarSide: 'left',
      sidebarExpanded: true,
      phoneBarPosition: 'bottom',
      pinnedCloseBehavior: 'unload',
      containerSpecificEssentials: false,
      onboardingDone: true,
      bookmarksBar
    },
    window: { kind: 'normal', chrome: 'normal', fullscreen: false, htmlFullscreenTabId },
    mods: [],
    boosts: [],
    extensions: [],
    bookmarks: BOOKMARKS,
    closingTabIds: [],
    permissionRules: [],
    sync: { enabled: false, scope: { openTabs: false } }
  } as unknown as UIState
}

let root: Root | null = null
let host: HTMLDivElement | null = null

/**
 * The window's class. Set after the browser store: the store's change recomputes the viewport
 * from the document's window (`lib/formFactor.ts`), which would put happy-dom's 1024 × 768 mouse
 * window in the desktop's place.
 */
function layout(formFactor: 'tablet' | 'desktop'): void {
  act(() => {
    viewportStore.set({
      formFactor,
      width: 1280,
      height: 800,
      coarse: formFactor === 'tablet',
      hover: formFactor === 'desktop'
    })
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mountShell(state: UIState): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => browserStore.set({ state }))
  layout('tablet')
  act(() => {
    root!.render(createElement(TabletShell, { state, ui: uiStore.get(), isDark: false }))
  })
  await flush()
}

/** The desktop's own mount of the bar, for the one claim that compares the two. */
async function mountDesktopBar(state: UIState): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => browserStore.set({ state }))
  layout('desktop')
  act(() => {
    root!.render(createElement(BookmarksBar, { state, tab: state.tabs.a as Tab }))
  })
  await flush()
}

/**
 * happy-dom lays nothing out: the strip is `stripWidth` wide and every chip 100 wide on a 104
 * pitch, so the bar's measure (`clientWidth`, `offsetLeft + offsetWidth`) finds the first chip
 * that does not fit.
 */
let stripWidth = 10_000
const layOut = (): void => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-bm-strip') ? stripWidth : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-bm-chip') ? 100 : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.hasAttribute('data-bm-chip')) return 0
      const strip = this.closest('.zen-bm-strip')
      const chips = strip ? [...strip.querySelectorAll('[data-bm-chip]')] : []
      return chips.indexOf(this) * 104
    }
  })
}

const bar = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="toolbar"][aria-label="Bookmarks bar"]')
/** The strip's chips in order (the Reading list control is a chip of its own, off the strip). */
const chips = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('.zen-bm-strip .zen-bm-chip[data-bm-chip]')
]
const overflow = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('.zen-bm-overflow')
const panels = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-bar-panel]')]
const panelRows = (panel: HTMLElement): string[] =>
  [...panel.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
    (r) => r.textContent?.trim() ?? ''
  )

async function press(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * A finger's tap as Chromium delivers it: the pointer's enter, down, up and leave in one task,
 * the `click` in a later one – the browser's tap gesture, not the release (a mouse's click is
 * dispatched with its release, inside the press the layer's light dismiss swallows). The click
 * is the pointer's: a `PointerEvent` with `pointerType 'touch'` and `detail 1`, which is how the
 * layer tells the press's own click from a keyboard's (`pointerType ''`, `detail 0`) while it
 * waits for it (W8-F20, §9.20).
 */
async function tap(el: Element): Promise<PointerEvent> {
  const pointer = (type: string, init: PointerEventInit = {}): PointerEvent =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerType: 'touch',
      pointerId: 7,
      isPrimary: true,
      ...init
    })
  await act(async () => {
    el.dispatchEvent(pointer('pointerover'))
    el.dispatchEvent(pointer('pointerenter', { bubbles: false }))
    el.dispatchEvent(pointer('pointerdown'))
    el.dispatchEvent(pointer('pointerup'))
    el.dispatchEvent(pointer('pointerout'))
    el.dispatchEvent(pointer('pointerleave', { bubbles: false }))
  })
  await act(async () => {
    await tick()
  })
  const click = pointer('click', { detail: 1 })
  await act(async () => {
    el.dispatchEvent(click)
  })
  await flush()
  await act(async () => {
    await tick()
  })
  return click
}

/**
 * A mouse's press as Chromium delivers it: down, up and the `click` in one task – the click
 * comes with the release, inside the press the layer's light dismiss swallows.
 */
async function mousePress(el: Element): Promise<PointerEvent> {
  const pointer = (type: string, init: PointerEventInit = {}): PointerEvent =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerType: 'mouse',
      pointerId: 1,
      isPrimary: true,
      button: 0,
      ...init
    })
  const click = pointer('click', { detail: 1 })
  await act(async () => {
    el.dispatchEvent(pointer('pointerdown'))
    el.dispatchEvent(pointer('pointerup'))
    el.dispatchEvent(click)
  })
  await flush()
  await act(async () => {
    await tick()
  })
  return click
}

beforeEach(() => {
  stripWidth = 10_000
  layOut()
  uiStore.set({ barMenuOpen: false, starDialog: null })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  document.getElementById('zen-chrome-layer')?.replaceChildren()
  uiStore.set({ barMenuOpen: false })
  vi.clearAllMocks()
})

describe('the tablet’s bookmarks bar (NTP-34; Chrome 152’s tablet bar, §9.36)', () => {
  it('mounts the desktop’s bar at the head of the content column, beside the sidebar under the toolbar, with the setting on', async () => {
    await mountShell(stateOf({ bookmarksBar: 'always' }))
    const el = bar()
    expect(el).not.toBeNull()
    // The desktop's seat (App.tsx): the first thing in the content column, the page's box after
    // it; the sidebar column stands beside the column in the row under the toolbar. The bar
    // sits in the shell's own chrome mark (#678's per-piece marks), a `contents` wrapper with no
    // box of its own, so the bar is the column's first flex item and the content box the next.
    const mark = el!.parentElement!
    expect(mark.hasAttribute('data-shell-chrome')).toBe(true)
    expect(mark.className).toBe('contents')
    const column = mark.parentElement!
    expect(column.tagName).toBe('MAIN')
    expect(mark.previousElementSibling).toBeNull()
    expect(mark.nextElementSibling?.querySelector('[data-content-stub]')).not.toBeNull()
    // Not in the content box: the box's message frame and its dialog host lie below the bar.
    expect(mark.nextElementSibling?.contains(el)).toBe(false)
    const row = column.parentElement!
    expect(row.querySelector('.zen-tablet-sidebar [data-sidebar-stub]')).not.toBeNull()
    expect(row.previousElementSibling?.matches('[data-toolbar-stub]')).toBe(true)
    // A window surface and a chrome root of its own too (`WINDOW_CHROME_ROOTS`, lib/portals.tsx).
    expect(el!.getAttribute('data-surface')).toBe('window')
    expect(chips().map((c) => c.getAttribute('data-bm-id'))).toEqual([
      'docs',
      'news',
      'work',
      'mail',
      'wiki'
    ])
  })

  it('goes inert with the chrome while a sheet or a frame dialog holds it, and comes back with the release', async () => {
    await mountShell(stateOf({ bookmarksBar: 'always' }))
    const el = bar()!
    const mark = el.parentElement!
    // The hold every BottomSheet and the frame dialog host take (§9.5, §9.22): the shell's
    // pieces go inert – the bar's mark with the sidebar column, the content area and the
    // message frame – so no press, focus or shortcut reaches a chip under a standing dialog.
    const release = holdChromeInert()
    expect(mark.hasAttribute('inert')).toBe(true)
    expect(el.closest('[inert]')).not.toBeNull()
    expect(host!.querySelector('.zen-tablet-sidebar')?.hasAttribute('inert')).toBe(true)
    release()
    expect(mark.hasAttribute('inert')).toBe(false)
    expect(el.closest('[inert]')).toBeNull()
  })

  it('reads the setting against the page: Only on new tab page shows it on the new tab page alone', async () => {
    await mountShell(stateOf({ bookmarksBar: 'newtab', url: PAGE_URL }))
    expect(bar()).toBeNull()
    act(() => root?.unmount())
    root = null
    host?.remove()
    await mountShell(stateOf({ bookmarksBar: 'newtab', url: NEW_TAB_URL }))
    expect(bar()).not.toBeNull()
  })

  it('shows nothing on Never, and goes with the chrome in a page’s fullscreen', async () => {
    await mountShell(stateOf({ bookmarksBar: 'never' }))
    expect(bar()).toBeNull()
    act(() => root?.unmount())
    root = null
    host?.remove()
    await mountShell(stateOf({ bookmarksBar: 'always', htmlFullscreenTabId: 'a' }))
    expect(bar()).toBeNull()
    expect(document.querySelector('[data-testid="chrome-root"]')).toBeNull()
  })

  it('lists the chips that do not fit in the » panel – the desktop’s popover, the tablet’s menu, no sheet', async () => {
    // Room for two chips (two pitches and a little): the third is the first that does not fit.
    stripWidth = 2 * 104 + 40
    await mountShell(stateOf({ bookmarksBar: 'always' }))
    expect(chips().map((c) => c.getAttribute('data-overflow'))).toEqual([
      'false',
      'false',
      'true',
      'true',
      'true'
    ])
    const more = overflow()
    expect(more).not.toBeNull()
    expect(more!.getAttribute('aria-label')).toBe('3 more bookmarks')
    expect(more!.getAttribute('aria-haspopup')).toBe('menu')
    // The row's own button: the tablet's 40 box comes from the toolbar-button rule (main.css).
    expect(more!.classList.contains('zen-toolbar-button')).toBe(true)

    await press(more!)
    expect(more!.getAttribute('aria-expanded')).toBe('true')
    expect(uiStore.get().barMenuOpen).toBe(true)
    const [panel] = panels()
    expect(panel).toBeDefined()
    expect(panel.getAttribute('role')).toBe('menu')
    expect(panel.classList.contains('zen-v2-menu')).toBe(true)
    expect(panel.classList.contains('zen-bm-panel')).toBe(true)
    expect(panelRows(panel)).toEqual(['Work', 'Mail', 'Wiki'])
    expect(document.querySelector('[data-sheet-layer] [role="dialog"]')).toBeNull()
  })

  it('opens a folder chip’s panel under a press and closes it under the next', async () => {
    await mountShell(stateOf({ bookmarksBar: 'always' }))
    const work = chips().find((c) => c.getAttribute('data-bm-id') === 'work')!
    expect(work.getAttribute('aria-haspopup')).toBe('menu')
    await press(work)
    expect(work.getAttribute('aria-expanded')).toBe('true')
    expect(panels().map((p) => p.getAttribute('aria-label'))).toEqual(['Work'])
    expect(panelRows(panels()[0])).toEqual(['Tracker', 'Board'])
    await press(work)
    expect(panels()).toEqual([])
    expect(work.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes a panel under a finger’s tap on its own anchor without reopening it from that tap’s late click, and reopens it under the next tap', async () => {
    // Room for two chips: the » stands in for the rest.
    stripWidth = 2 * 104 + 40
    await mountShell(stateOf({ bookmarksBar: 'always' }))
    const more = overflow()!
    await tap(more)
    expect(panels().length).toBe(1)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    // The second tap: its press closes the panel (§9.20, reason `anchor`) and its click, a task
    // later, is that press's own – the layer swallows it on the window (W8-F20), so the bar never
    // sees it: the panel stays closed and the chrome flag down.
    const spent = await tap(more)
    expect(panels()).toEqual([])
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(uiStore.get().barMenuOpen).toBe(false)
    expect(spent.defaultPrevented).toBe(true)
    // A third tap is a new press: it reopens.
    await tap(more)
    expect(panels().length).toBe(1)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    await tap(more)
    expect(panels()).toEqual([])

    // A folder chip's panel the same way, on a strip that shows every chip.
    act(() => root?.unmount())
    root = null
    host?.remove()
    stripWidth = 10_000
    await mountShell(stateOf({ bookmarksBar: 'always' }))
    const work = chips().find((c) => c.getAttribute('data-bm-id') === 'work')!
    await tap(work)
    expect(panels().map((p) => p.getAttribute('aria-label'))).toEqual(['Work'])
    await tap(work)
    expect(panels()).toEqual([])
    expect(work.getAttribute('aria-expanded')).toBe('false')
    await tap(work)
    expect(panels().map((p) => p.getAttribute('aria-label'))).toEqual(['Work'])
  })

  it('closes and stays closed on the desktop too: a finger’s tap is the same press on every layout, and a mouse’s press closes as it always did', async () => {
    // The layer's light dismiss (§9.20) is one module for every host: a touch tap's late click
    // is the press's own on the desktop with a touch screen as on the tablet – no guard of the
    // bar's, no layout gate (W8-F20). A mouse's click comes with its release and is swallowed
    // with it, as before.
    await mountDesktopBar(stateOf({ bookmarksBar: 'always' }))
    const work = chips().find((c) => c.getAttribute('data-bm-id') === 'work')!
    await tap(work)
    expect(panels().map((p) => p.getAttribute('aria-label'))).toEqual(['Work'])
    const spent = await tap(work)
    expect(panels()).toEqual([])
    expect(spent.defaultPrevented).toBe(true)
    await tap(work)
    expect(panels().map((p) => p.getAttribute('aria-label'))).toEqual(['Work'])
    // The mouse: its press on the open panel's own chip closes it and the click with the
    // release is swallowed; the next press reopens.
    const mouse = await mousePress(work)
    expect(panels()).toEqual([])
    expect(mouse.defaultPrevented).toBe(true)
    await mousePress(work)
    expect(panels().map((p) => p.getAttribute('aria-label'))).toEqual(['Work'])
    await mousePress(work)
    expect(panels()).toEqual([])
  })

  it('lifts no link from a chip on the tablet, where the desktop’s chip does', async () => {
    await mountShell(stateOf({ bookmarksBar: 'always' }))
    for (const chip of chips()) expect(chip.hasAttribute('draggable')).toBe(false)
    act(() => root?.unmount())
    root = null
    host?.remove()
    await mountDesktopBar(stateOf({ bookmarksBar: 'always' }))
    const pages = chips().filter((c) => c.getAttribute('data-bm-chip') === 'url')
    expect(pages.length).toBe(4)
    for (const chip of pages) expect(chip.getAttribute('draggable')).toBe('true')
  })
})
