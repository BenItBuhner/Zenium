import type { MenuDescriptor, OverlayKind, UIState, UrlbarOpenMode } from '@shared/types'
import { cmd, onEvent, run } from './api'
import { activeTab } from './selectors'
import { createStore } from './store'

// ---------------------------------------------------------------------------
// Browser state mirrored from the main process
// ---------------------------------------------------------------------------

export const browserStore = createStore<{ state: UIState | null }>({ state: null }, 'browser')

export function useBrowser(): UIState {
  const state = browserStore.use((s) => s.state)
  if (!state) throw new Error('Browser state not loaded')
  return state
}

export function startBrowserSync(): void {
  const flags = globalThis as unknown as { __zenSyncStarted?: boolean }
  if (flags.__zenSyncStarted) return
  flags.__zenSyncStarted = true
  onEvent('state', (state) => browserStore.set({ state }))
  void cmd('app.getState', undefined).then((state) => browserStore.set({ state }))
}

// ---------------------------------------------------------------------------
// Renderer-local UI state
// ---------------------------------------------------------------------------

export interface UrlbarState {
  open: boolean
  mode: UrlbarOpenMode
  /** Tab the URL bar edits (null → a new tab will be created on submit). */
  tabId: string | null
  initialText: string | undefined
  /** Anchor the bar to the top instead of floating when the user clicked the address pill. */
  attached: boolean
}

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'error'
}

export interface DragState {
  tabId: string
  x: number
  y: number
}

export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

export interface UiState {
  overlay: OverlayKind
  overlaySpaceId: string | null
  urlbar: UrlbarState
  findOpen: boolean
  findTabId: string | null
  /** Data URL of the active tab, shown dimmed behind overlays. */
  snapshot: string | null
  snapshotTabId: string | null
  toasts: Toast[]
  statusText: string
  drag: DragState | null
  compactHover: boolean
  renamingTabId: string | null
  renamingFolderId: string | null
  /** The glance parent has been captured and the card is animating in / shown. */
  glanceActive: boolean
  /** The card animation finished – the glance view may be placed. */
  glanceReady: boolean
  spaceSlideDirection: 1 | -1 | 0
  /** Phone layout: the sidebar drawer is open over the content. */
  drawerOpen: boolean
  /** A renderer-hosted context menu (hosts without native menus). */
  menu: MenuDescriptor | null
  /** Safe-area insets of the host window (status bar, gesture bar, IME). */
  insets: Insets
}

/** Last pointer-down position – anchors renderer-hosted menus that come without coordinates. */
export const lastPointer = { x: 0, y: 0 }

export const uiStore = createStore<UiState>(
  {
    overlay: 'none',
    overlaySpaceId: null,
    urlbar: { open: false, mode: 'new-tab', tabId: null, initialText: undefined, attached: false },
    findOpen: false,
    findTabId: null,
    snapshot: null,
    snapshotTabId: null,
    toasts: [],
    statusText: '',
    drag: null,
    compactHover: false,
    renamingTabId: null,
    renamingFolderId: null,
    glanceActive: false,
    glanceReady: false,
    spaceSlideDirection: 0,
    drawerOpen: false,
    menu: null,
    insets: { top: 0, right: 0, bottom: 0, left: 0 }
  },
  'ui'
)

let toastSeq = 0
export function pushToast(message: string, kind: 'info' | 'error' = 'info'): void {
  const id = ++toastSeq
  uiStore.set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }))
  setTimeout(() => uiStore.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 2800)
}

/** Capture the active tab before a chrome overlay hides it. */
export async function captureActiveTab(tabId: string | null): Promise<void> {
  if (!tabId) {
    uiStore.set({ snapshot: null, snapshotTabId: null })
    return
  }
  if (uiStore.get().snapshotTabId === tabId && uiStore.get().snapshot) return
  const data = await cmd('overlay.snapshot', { tabId }).catch(() => null)
  uiStore.set({ snapshot: data, snapshotTabId: tabId })
}

export async function openOverlay(
  kind: OverlayKind,
  activeTabId: string | null,
  spaceId: string | null = null
): Promise<void> {
  await captureActiveTab(activeTabId)
  run('focus.chrome', undefined)
  uiStore.set({ overlay: kind, overlaySpaceId: spaceId, drawerOpen: false })
}

export function closeOverlay(): void {
  uiStore.set({ overlay: 'none', overlaySpaceId: null })
  invalidateSnapshot()
  returnFocusToPage()
}

/** Once no chrome UI needs the keyboard, hand focus back to the active page. */
export function returnFocusToPage(): void {
  const ui = uiStore.get()
  if (ui.overlay === 'none' && !ui.urlbar.open && !ui.findOpen && !ui.drawerOpen && !ui.menu)
    run('focus.content', undefined)
}

/** Drop the cached snapshot once nothing needs it, so the next overlay gets a fresh capture. */
export function invalidateSnapshot(): void {
  const ui = uiStore.get()
  if (
    ui.overlay === 'none' &&
    !ui.urlbar.open &&
    !ui.drag &&
    !ui.compactHover &&
    !ui.drawerOpen &&
    !ui.menu
  ) {
    uiStore.set({ snapshot: null, snapshotTabId: null })
  }
}

export async function openUrlbar(
  mode: UrlbarOpenMode,
  activeTabId: string | null,
  opts: { text?: string; attached?: boolean } = {}
): Promise<void> {
  await captureActiveTab(activeTabId)
  run('focus.chrome', undefined)
  uiStore.set({
    urlbar: {
      open: true,
      mode,
      tabId: mode === 'new-tab' ? null : activeTabId,
      initialText: opts.text,
      attached: Boolean(opts.attached)
    },
    drawerOpen: false
  })
}

export function closeUrlbar(): void {
  if (!uiStore.get().urlbar.open) return
  uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: false } }))
  invalidateSnapshot()
  returnFocusToPage()
}

// ---------------------------------------------------------------------------
// Phone drawer & renderer-hosted menus
// ---------------------------------------------------------------------------

export async function openDrawer(activeTabId: string | null): Promise<void> {
  if (uiStore.get().drawerOpen) return
  await captureActiveTab(activeTabId)
  run('focus.chrome', undefined)
  uiStore.set({ drawerOpen: true })
}

export function closeDrawer(): void {
  if (!uiStore.get().drawerOpen) return
  uiStore.set({ drawerOpen: false })
  invalidateSnapshot()
  returnFocusToPage()
}

export async function showMenu(menu: MenuDescriptor, activeTabId: string | null): Promise<void> {
  // Page menus dim the page behind them like every other overlay; the snapshot must exist first.
  await captureActiveTab(activeTabId)
  uiStore.set({ menu })
}

export function closeMenu(notifyHost = true): void {
  const menu = uiStore.get().menu
  if (!menu) return
  uiStore.set({ menu: null })
  if (notifyHost) run('menu.close', { menuId: menu.id })
  invalidateSnapshot()
  returnFocusToPage()
}

export function pickMenuItem(itemId: string): void {
  const menu = uiStore.get().menu
  if (!menu) return
  uiStore.set({ menu: null })
  run('menu.click', { menuId: menu.id, itemId })
  invalidateSnapshot()
  returnFocusToPage()
}

/** True when a chrome overlay covers the content area (tab views must be hidden). */
export function overlayCoversContent(ui: UiState): boolean {
  return (
    ui.overlay !== 'none' || ui.urlbar.open || ui.drag !== null || ui.drawerOpen || ui.menu !== null
  )
}

/**
 * Hardware / gesture back (mobile hosts). Closes the topmost piece of chrome UI, then navigates
 * the active tab back. Returns false when nothing was left to do (the host may background the app).
 */
export function handleSystemBack(): boolean {
  const ui = uiStore.get()
  const state = browserStore.get().state
  if (ui.menu) {
    closeMenu()
    return true
  }
  if (ui.urlbar.open) {
    closeUrlbar()
    return true
  }
  if (ui.overlay !== 'none' && ui.overlay !== 'onboarding') {
    closeOverlay()
    return true
  }
  if (ui.drawerOpen) {
    closeDrawer()
    return true
  }
  if (state?.glance) {
    run('glance.close', undefined)
    return true
  }
  if (ui.findOpen && ui.findTabId) {
    run('find.stop', { tabId: ui.findTabId, keepSelection: true })
    uiStore.set({ findOpen: false, findTabId: null })
    returnFocusToPage()
    return true
  }
  const tab = state ? activeTab(state) : null
  if (tab?.canGoBack) {
    run('tab.back', { tabId: tab.id })
    return true
  }
  return false
}
