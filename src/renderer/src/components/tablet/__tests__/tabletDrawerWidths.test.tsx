// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Space, Tab, UIState } from '@shared/types'

/*
 * The tablet sidebar's two modes by the window's width (§9.36: "below 720 dp the sidebar is a
 * drawer under the toolbar at 240 over the page's scrim"), pinned at the widths a Samsung DeX
 * freeform window was held at in the OS-12 resize strip (#494's design gate, the check on (c)):
 * at 725 the expanded sidebar is the docked column beside the page; at 650 the rail is docked
 * and the expanded sidebar is the drawer, closed until the toggle opens it over the scrim; the
 * line is 720 itself (a column) against 719 (a drawer). The class follows the width live: a
 * window dragged from 650 to 725 with the drawer up drops the drawer for the column without
 * motion, and back to 650 takes the column to the rail. In the WebView a CSS px is a dp, so the
 * store's width is the rule's number.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Object.assign(window, { zen: { invoke: vi.fn(async () => null), on: () => () => undefined } })

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
const { TABLET_DRAWER_BELOW, tabletDrawerLayout, tabletDrawerStore } =
  await import('../tabletChrome')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { uiStore } = await import('@renderer/lib/ui')

// --- a profile, a window ------------------------------------------------------------------------

const SPACE = 'space'
const TAB = {
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

function stateOf(): UIState {
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
      sidebarSide: 'left',
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

/** The window at this width: a landscape freeform window 760 tall, as the strip's were. */
function windowAt(width: number): void {
  act(() => {
    viewportStore.set({ formFactor: 'tablet', width, height: 760, coarse: true, hover: false })
  })
}

function mount(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root!.render(createElement(TabletShell, { state: stateOf(), ui: uiStore.get(), isDark: false }))
  })
}

const sidebarMode = (): string | null =>
  document.querySelector('[data-testid="chrome-root"]')?.getAttribute('data-sidebar') ?? null
const dockedSidebar = (): string | null =>
  document
    .querySelector('.zen-tablet-sidebar [data-sidebar-stub]')
    ?.getAttribute('data-sidebar-stub') ?? null
const drawer = (): HTMLElement | null => document.querySelector<HTMLElement>('.zen-tablet-drawer')
const panel = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('.zen-tablet-drawer-panel')
const toggleSays = (): string | null =>
  document.querySelector('[data-toolbar-stub]')?.getAttribute('data-toolbar-stub') ?? null

beforeEach(() => {
  tabletDrawerStore.set({ phase: 'closed', progress: 0 })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  tabletDrawerStore.set({ phase: 'closed', progress: 0 })
})

describe('the tablet sidebar by the window’s width (§9.36’s 720 line, the DeX strip’s widths)', () => {
  it('docks the expanded sidebar as a column at 725 – above the line, no drawer', () => {
    expect(tabletDrawerLayout(725)).toBe(false)
    windowAt(725)
    mount()
    expect(sidebarMode()).toBe('expanded')
    expect(dockedSidebar()).toBe('expanded')
    expect(drawer()).toBeNull()
    expect(toggleSays()).toBe('open')
  })

  it('docks the rail at 650 and makes the expanded sidebar a drawer: closed at rest, over the scrim when opened', () => {
    expect(tabletDrawerLayout(650)).toBe(true)
    windowAt(650)
    mount()
    expect(sidebarMode()).toBe('rail')
    expect(dockedSidebar()).toBe('rail')
    expect(drawer()).toBeNull()
    expect(toggleSays()).toBe('collapsed')

    // The toggle's open (the capture in, the spring run): the expanded sidebar in the drawer
    // panel over the page's scrim, under the toolbar, the rail still docked beside it.
    act(() => tabletDrawerStore.set({ phase: 'dragging', progress: 0 }))
    act(() => tabletDrawerStore.set({ phase: 'open', progress: 1 }))
    expect(drawer()).not.toBeNull()
    expect(panel()).not.toBeNull()
    expect(panel()!.getAttribute('role')).toBe('dialog')
    expect(panel()!.getAttribute('aria-label')).toBe('Sidebar')
    expect(panel()!.style.transform).toBe('translateX(0%)')
    expect(panel()!.querySelector('[data-sidebar-stub]')?.getAttribute('data-sidebar-stub')).toBe(
      'expanded'
    )
    expect(drawer()!.querySelector('.zen-overview-scrim')).not.toBeNull()
    expect(dockedSidebar()).toBe('rail')
    expect(toggleSays()).toBe('open')
  })

  it('draws the line at 720: the column on it, the drawer under it', () => {
    expect(TABLET_DRAWER_BELOW).toBe(720)
    windowAt(720)
    mount()
    expect(sidebarMode()).toBe('expanded')
    windowAt(719)
    expect(sidebarMode()).toBe('rail')
  })

  it('follows a live resize: the drawer up at 650 gives way to the column at 725 without motion, and the column goes to the rail on the way back', () => {
    windowAt(650)
    mount()
    act(() => tabletDrawerStore.set({ phase: 'dragging', progress: 0 }))
    act(() => tabletDrawerStore.set({ phase: 'open', progress: 1 }))
    expect(panel()).not.toBeNull()

    windowAt(725)
    expect(sidebarMode()).toBe('expanded')
    expect(drawer()).toBeNull()
    expect(tabletDrawerStore.get().phase).toBe('closed')

    windowAt(650)
    expect(sidebarMode()).toBe('rail')
    expect(drawer()).toBeNull()
  })
})
