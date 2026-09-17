import type {
  ExternalProtocolRequest,
  MenuDescriptor,
  OverlayKind,
  Rect,
  UIState,
  UrlbarOpenMode
} from '@shared/types'
import { cmd, onEvent, run } from './api'
import { createStore } from './store'
import { rememberThumbnail, thumbnailOf } from './thumbnails'

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
  /** Folder the live-folder editor works on (null → create a new one). */
  overlayFolderId: string | null
  /** Settings section to open (e.g. `resources`), when the overlay was opened for one. */
  overlaySection: string | null
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
  /** Tab whose pinned URL is being edited in the small prompt. */
  editingPinnedUrlTabId: string | null
  /** Tab whose icon picker is open. */
  iconPickerTabId: string | null
  /** Zen's multi-select: tabs picked with Ctrl / Shift+click (acted on together). */
  selectedTabIds: string[]
  /** Last plainly clicked / toggled tab – the anchor for Shift+click ranges. */
  selectionAnchorId: string | null
  /** The glance parent has been captured and the card is animating in / shown. */
  glanceActive: boolean
  /** The card animation finished – the glance view may be placed. */
  glanceReady: boolean
  spaceSlideDirection: 1 | -1 | 0
  /** Phone layout: the sidebar drawer is open over the content. */
  drawerOpen: boolean
  /** A renderer-hosted context menu (hosts without native menus). */
  menu: MenuDescriptor | null
  /** The site-information sheet (connection, cookies, storage, permissions) is up. */
  siteInfoOpen: boolean
  /** A page wants to open another app: the external-protocol confirm sheet is up for it. */
  externalProtocol: ExternalProtocolRequest | null
  /** Safe-area insets of the host window (status bar, gesture bar, IME). */
  insets: Insets
  /**
   * Phone layout: the gesture stage (tab-switch cards, the tab overview) stands in for the live
   * page, which must be hidden underneath it.
   */
  stageActive: boolean
}

/** Where the content area is, in window coordinates (measured by the layout reporter). */
export const contentAreaStore = createStore<{ area: Rect | null }>({ area: null }, 'content-area')

/** Last pointer-down position – anchors renderer-hosted menus that come without coordinates. */
export const lastPointer = { x: 0, y: 0 }

export const uiStore = createStore<UiState>(
  {
    overlay: 'none',
    overlaySpaceId: null,
    overlayFolderId: null,
    overlaySection: null,
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
    editingPinnedUrlTabId: null,
    iconPickerTabId: null,
    selectedTabIds: [],
    selectionAnchorId: null,
    glanceActive: false,
    glanceReady: false,
    spaceSlideDirection: 0,
    drawerOpen: false,
    menu: null,
    siteInfoOpen: false,
    externalProtocol: null,
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    stageActive: false
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
  if (data) rememberThumbnail(tabId, data)
  // A page that is already hidden (behind the gesture stage) cannot be captured: show what it
  // looked like the last time it was.
  uiStore.set({ snapshot: data ?? thumbnailOf(tabId), snapshotTabId: tabId })
}

export async function openOverlay(
  kind: OverlayKind,
  activeTabId: string | null,
  spaceId: string | null = null,
  folderId: string | null = null,
  section: string | null = null
): Promise<void> {
  await captureActiveTab(activeTabId)
  // Overlays render over the content area; a phone drawer would sit on top of them.
  uiStore.set({ drawerOpen: false })
  run('focus.chrome', undefined)
  uiStore.set({
    overlay: kind,
    overlaySpaceId: spaceId,
    overlayFolderId: folderId,
    overlaySection: section
  })
}

export function closeOverlay(): void {
  uiStore.set({
    overlay: 'none',
    overlaySpaceId: null,
    overlayFolderId: null,
    overlaySection: null
  })
  invalidateSnapshot()
  returnFocusToPage()
}

/** Once no chrome UI needs the keyboard, hand focus back to the active page. */
export function returnFocusToPage(): void {
  const ui = uiStore.get()
  if (
    ui.overlay === 'none' &&
    !ui.urlbar.open &&
    !ui.findOpen &&
    !ui.drawerOpen &&
    !ui.menu &&
    !ui.siteInfoOpen &&
    !ui.externalProtocol &&
    !ui.stageActive
  )
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
    !ui.menu &&
    !ui.siteInfoOpen &&
    !ui.externalProtocol &&
    !ui.stageActive
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
  invalidateSnapshot()
  returnFocusToPage()
  // Run the action once the sheet has been unpainted: hosts that snapshot the window for the
  // dimmed overlay preview (Android's PixelCopy) would otherwise capture the menu itself.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => run('menu.click', { menuId: menu.id, itemId }))
  )
}

// ---------------------------------------------------------------------------
// External protocols (a page wants to open another app)
// ---------------------------------------------------------------------------

/** Requests the core withdrew before their sheet was up (the page capture was still in flight). */
const withdrawnRequests = new Set<string>()

/** The core asked: put the confirm sheet up over a capture of the page that asked. */
export async function showExternalProtocol(
  request: ExternalProtocolRequest,
  activeTabId: string | null
): Promise<void> {
  await captureActiveTab(activeTabId)
  if (withdrawnRequests.delete(request.requestId)) return
  uiStore.set({ externalProtocol: request })
}

/**
 * The sheet's answer, or its dismissal (`allow` false): one answer per request; the sheet is
 * taken down either way.
 */
export function answerExternalProtocol(requestId: string, allow: boolean, always: boolean): void {
  const current = uiStore.get().externalProtocol
  if (!current || current.requestId !== requestId) return
  uiStore.set({ externalProtocol: null })
  run('externalProtocol.respond', { requestId, allow, always })
  invalidateSnapshot()
  returnFocusToPage()
}

/** The core withdrew the question (its tab closed, a newer one took over). */
export function cancelExternalProtocol(requestId: string): void {
  if (uiStore.get().externalProtocol?.requestId !== requestId) {
    withdrawnRequests.add(requestId)
    return
  }
  uiStore.set({ externalProtocol: null })
  invalidateSnapshot()
  returnFocusToPage()
}

/** True when a chrome overlay covers the content area (tab views must be hidden). */
export function overlayCoversContent(ui: UiState): boolean {
  return (
    ui.overlay !== 'none' ||
    ui.urlbar.open ||
    ui.drag !== null ||
    ui.drawerOpen ||
    ui.menu !== null ||
    ui.siteInfoOpen ||
    ui.externalProtocol !== null ||
    ui.stageActive
  )
}

// The system back gesture (registry of dismissable surfaces, legacy chain) lives in `back.ts`.

// ---------------------------------------------------------------------------
// Multi-select (Ctrl+click toggles, Shift+click extends from the anchor)
// ---------------------------------------------------------------------------

/** Sidebar order of the tabs currently rendered (essentials, pinned, folders, regular). */
function renderedTabOrder(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-tab-id]')]
    .map((el) => el.dataset.tabId ?? '')
    .filter(Boolean)
}

export function toggleTabSelection(tabId: string, activeTabId: string | null): void {
  const ui = uiStore.get()
  const base = ui.selectedTabIds.length ? ui.selectedTabIds : activeTabId ? [activeTabId] : []
  const next = base.includes(tabId) ? base.filter((id) => id !== tabId) : [...base, tabId]
  uiStore.set({ selectedTabIds: next.length > 1 ? next : [], selectionAnchorId: tabId })
}

export function selectTabRange(tabId: string, activeTabId: string | null): void {
  const ui = uiStore.get()
  const anchor = ui.selectionAnchorId ?? activeTabId ?? tabId
  const order = renderedTabOrder()
  const a = order.indexOf(anchor)
  const b = order.indexOf(tabId)
  if (a === -1 || b === -1) {
    toggleTabSelection(tabId, activeTabId)
    return
  }
  const [from, to] = a < b ? [a, b] : [b, a]
  const range = order.slice(from, to + 1)
  const merged = [...new Set([...ui.selectedTabIds, ...range])]
  uiStore.set({ selectedTabIds: merged.length > 1 ? merged : [], selectionAnchorId: anchor })
}

export function clearTabSelection(): void {
  if (uiStore.get().selectedTabIds.length)
    uiStore.set({ selectedTabIds: [], selectionAnchorId: null })
}
