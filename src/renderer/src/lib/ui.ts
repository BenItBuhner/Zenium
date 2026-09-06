import type { OverlayKind, UIState, UrlbarOpenMode } from '@shared/types'
import { cmd, onEvent, run } from './api'
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

export interface UiState {
  overlay: OverlayKind
  overlaySpaceId: string | null
  /** Folder the live-folder editor works on (null → create a new one). */
  overlayFolderId: string | null
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
  /** The glance parent has been captured and the card is animating in / shown. */
  glanceActive: boolean
  /** The card animation finished – the glance view may be placed. */
  glanceReady: boolean
  spaceSlideDirection: 1 | -1 | 0
}

export const uiStore = createStore<UiState>(
  {
    overlay: 'none',
    overlaySpaceId: null,
    overlayFolderId: null,
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
    glanceActive: false,
    glanceReady: false,
    spaceSlideDirection: 0
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
  spaceId: string | null = null,
  folderId: string | null = null
): Promise<void> {
  await captureActiveTab(activeTabId)
  run('focus.chrome', undefined)
  uiStore.set({ overlay: kind, overlaySpaceId: spaceId, overlayFolderId: folderId })
}

export function closeOverlay(): void {
  uiStore.set({ overlay: 'none', overlaySpaceId: null, overlayFolderId: null })
  invalidateSnapshot()
  returnFocusToPage()
}

/** Once no chrome UI needs the keyboard, hand focus back to the active page. */
export function returnFocusToPage(): void {
  const ui = uiStore.get()
  if (ui.overlay === 'none' && !ui.urlbar.open && !ui.findOpen) run('focus.content', undefined)
}

/** Drop the cached snapshot once nothing needs it, so the next overlay gets a fresh capture. */
export function invalidateSnapshot(): void {
  const ui = uiStore.get()
  if (ui.overlay === 'none' && !ui.urlbar.open && !ui.drag && !ui.compactHover) {
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
    }
  })
}

export function closeUrlbar(): void {
  if (!uiStore.get().urlbar.open) return
  uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: false } }))
  invalidateSnapshot()
  returnFocusToPage()
}

/** True when a chrome overlay covers the content area (tab views must be hidden). */
export function overlayCoversContent(ui: UiState): boolean {
  return ui.overlay !== 'none' || ui.urlbar.open || ui.drag !== null
}
