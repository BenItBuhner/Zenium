// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Space, Tab, UIState } from '@shared/types'

/*
 * The tablet drawer's frames (PERF-5's `tablet-drawer-open` reading): `tabletDrawerStore`'s
 * `progress` moves per frame of the spring or of the system back gesture, and the shell reads
 * the store for WHETHER the drawer is up only, so a frame renders nothing – not the toolbar, not
 * the docked rail, not the whole sidebar inside the drawer (the tab rows) – and the drawer writes
 * the panel's `transform` and the scrim's `opacity` to its two elements from the store, its first
 * pose in the commit before the paint. Rendered for real in happy-dom through `TabletShell` in a
 * window too narrow for a docked expanded sidebar, the children that carry no part of it stubbed,
 * the sidebar and the toolbar counting their renders, the store ticked by hand.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Object.assign(window, { zen: { invoke: vi.fn(async () => null), on: () => () => undefined } })

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

/** The sidebar counts its renders by where it stands: the docked rail's or the drawer's. */
const sidebarRenders: string[] = []
vi.mock('@renderer/components/sidebar/Sidebar', () => ({
  Sidebar: ({ compact }: { compact: boolean }) => {
    sidebarRenders.push(compact ? 'docked' : 'drawer')
    return createElement('div', { 'data-sidebar-stub': compact ? 'rail' : 'expanded' })
  }
}))
let toolbarRenders = 0
vi.mock('@renderer/components/tablet/TabletToolbar', () => ({
  TabletToolbar: () => {
    toolbarRenders++
    return createElement('div', { 'data-toolbar-stub': '' })
  }
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
const { TABLET_DRAWER_BELOW, tabletDrawerShift, tabletDrawerStore } =
  await import('../tabletChrome')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { uiStore } = await import('@renderer/lib/ui')

// --- a profile, a window ------------------------------------------------------------------------

const SPACE = 'space'
const TAB: Tab = {
  id: 'a',
  spaceId: SPACE,
  containerId: 'default',
  url: 'https://a.example/',
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

function stateOf(side: 'left' | 'right'): UIState {
  const space: Space = {
    id: SPACE,
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: [TAB.id],
    activeTabId: TAB.id,
    pinnedCollapsed: false
  }
  return {
    platform: 'android',
    capabilities: { windowControls: false },
    tabs: { [TAB.id]: TAB },
    spaces: [space],
    activeSpaceId: SPACE,
    folders: {},
    essentialTabIds: [],
    containers: [],
    settings: {
      colorScheme: 'light',
      sidebarSide: side,
      sidebarExpanded: true,
      phoneBarPosition: 'bottom',
      pinnedCloseBehavior: 'unload',
      containerSpecificEssentials: false,
      onboardingDone: true
    },
    window: { kind: 'normal', chrome: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    mods: [],
    boosts: [],
    extensions: [],
    bookmarks: [],
    closingTabIds: [],
    permissionRules: [],
    sync: { enabled: false, scope: { openTabs: false } }
  } as unknown as UIState
}

let root: Root | null = null
let host: HTMLDivElement | null = null

function mount(side: 'left' | 'right' = 'left'): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root!.render(
      createElement(TabletShell, { state: stateOf(side), ui: uiStore.get(), isDark: false })
    )
  })
}

const panel = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('.zen-tablet-drawer-panel')
const scrim = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('.zen-tablet-drawer .zen-overview-scrim')
const tick = (patch: Parameters<typeof tabletDrawerStore.set>[0]): void => {
  act(() => tabletDrawerStore.set(patch))
}

beforeEach(() => {
  // A split-screen half: the rail docked, the expanded sidebar a drawer over the page.
  viewportStore.set({
    formFactor: 'tablet',
    width: TABLET_DRAWER_BELOW - 120,
    height: 900,
    coarse: true,
    hover: false
  })
  tabletDrawerStore.set({ phase: 'closed', progress: 0 })
  sidebarRenders.length = 0
  toolbarRenders = 0
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  tabletDrawerStore.set({ phase: 'closed', progress: 0 })
})

describe('the tablet drawer’s frames', () => {
  it('writes the panel’s transform and the scrim’s opacity from the store, rendering nothing per frame', () => {
    mount()
    expect(panel()).toBeNull()
    expect(sidebarRenders).toEqual(['docked'])
    expect(toolbarRenders).toBe(1)

    // The open: the capture is in, the drawer mounts off screen – its first pose in the commit.
    // The shell's ONE render for the drawer's arrival takes the docked rail with it; that is
    // the open's render, not a frame's.
    tick({ phase: 'dragging', progress: 0 })
    expect(panel()).not.toBeNull()
    expect(panel()!.style.transform).toBe('translateX(-100%)')
    expect(scrim()!.style.opacity).toBe('0')
    expect(sidebarRenders).toEqual(['docked', 'docked', 'drawer'])
    expect(toolbarRenders).toBe(2)
    const rendersAtMount = sidebarRenders.slice()
    const toolbarAtMount = toolbarRenders

    // The spring's frames: every one lands on the two elements, none reaches React.
    tick({ phase: 'settling' })
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      tick({ progress: p })
      expect(panel()!.style.transform).toBe(tabletDrawerShift(p, 'left'))
      expect(scrim()!.style.opacity).toBe(String(p))
    }
    expect(panel()!.style.transform).toBe('translateX(0%)')
    expect(sidebarRenders).toEqual(rendersAtMount)
    expect(toolbarRenders).toBe(toolbarAtMount)

    // At rest, open: the phase moves and the shell still has nothing to redraw.
    tick({ phase: 'open', progress: 1 })
    expect(sidebarRenders).toEqual(rendersAtMount)
    expect(toolbarRenders).toBe(toolbarAtMount)

    // The back gesture's frames (`dragging`, the progress falling) and the close's spring.
    tick({ phase: 'dragging', progress: 0.6 })
    expect(panel()!.style.transform).toBe(tabletDrawerShift(0.6, 'left'))
    expect(scrim()!.style.opacity).toBe('0.6')
    tick({ phase: 'settling' })
    tick({ progress: 0.25 })
    expect(panel()!.style.transform).toBe('translateX(-75%)')
    expect(scrim()!.style.opacity).toBe('0.25')
    expect(sidebarRenders).toEqual(rendersAtMount)
    expect(toolbarRenders).toBe(toolbarAtMount)

    // Closed: the drawer goes – the shell's one render for its leaving, the rail with it.
    tick({ phase: 'closed', progress: 0 })
    expect(panel()).toBeNull()
    expect(sidebarRenders).toEqual([...rendersAtMount, 'docked'])
    expect(toolbarRenders).toBe(toolbarAtMount + 1)
  })

  it('slides the panel in from the right edge when the sidebar is on the right', () => {
    mount('right')
    tick({ phase: 'dragging', progress: 0 })
    expect(panel()!.style.transform).toBe('translateX(100%)')
    tick({ phase: 'settling' })
    tick({ progress: 0.5 })
    expect(panel()!.style.transform).toBe('translateX(50%)')
    expect(scrim()!.style.opacity).toBe('0.5')
  })

  it('re-poses the panel when the sidebar changes side under an open drawer', () => {
    mount('left')
    tick({ phase: 'dragging', progress: 0 })
    tick({ phase: 'settling' })
    tick({ progress: 0.5 })
    expect(panel()!.style.transform).toBe('translateX(-50%)')
    act(() => {
      root!.render(
        createElement(TabletShell, { state: stateOf('right'), ui: uiStore.get(), isDark: false })
      )
    })
    expect(panel()!.dataset.side).toBe('right')
    expect(panel()!.style.transform).toBe('translateX(50%)')
    tick({ progress: 0.75 })
    expect(panel()!.style.transform).toBe('translateX(25%)')
  })

  it('names the panel’s pose per progress and side', () => {
    expect(tabletDrawerShift(0, 'left')).toBe('translateX(-100%)')
    expect(tabletDrawerShift(0.5, 'left')).toBe('translateX(-50%)')
    expect(tabletDrawerShift(1, 'left')).toBe('translateX(0%)')
    expect(tabletDrawerShift(0, 'right')).toBe('translateX(100%)')
    expect(tabletDrawerShift(0.75, 'right')).toBe('translateX(25%)')
  })
})
