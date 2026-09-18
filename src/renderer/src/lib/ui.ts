import type {
  BookmarkNodeType,
  ExternalProtocolRequest,
  MenuDescriptor,
  OverlayKind,
  Rect,
  UIState,
  UrlbarOpenMode
} from '@shared/types'
import { cmd, onEvent, run } from './api'
import { afterKeyRelease } from './keyRelease'
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
  /**
   * Tab the URL bar edits (null → a new tab will be created on submit). In `new-tab` mode it is
   * the new tab page the bar floats over: what is typed navigates that tab.
   */
  tabId: string | null
  initialText: string | undefined
  /**
   * `initialText` was typed by the user (into the new tab page before the bar was up): the caret
   * goes after it instead of selecting it, so the next keystroke carries on rather than replaces.
   */
  typed?: boolean
  /** Anchor the bar to the top instead of floating when the user clicked the address pill. */
  attached: boolean
}

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'error'
}

/** A sidebar tab in the hand (see lib/drag.ts); the ghost and caret are placed imperatively. */
export interface DragState {
  tabId: string
  /** The drag began in another window (the core relays it); the tab may not be in this list. */
  remote: boolean
  title: string
  favicon: string | null
  /** The lifted row's size; the ghost is drawn at it. */
  width: number
  height: number
  /** An Essentials tile was lifted (the ghost is a tile, not a row). */
  tile: boolean
  /** The pointer let go: the ghost is settling into its slot or dissolving. */
  settling: boolean
}

export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * What the last opening of the find bar asked of it: `text` for the field (the tab's last
 * query, the page's selection; '' keeps what is typed) and, for F3 / Ctrl+G, the match to step
 * to. `seq` tells one request from the next, so Ctrl+F on an open bar re-selects the query.
 */
export interface FindRequest {
  seq: number
  text: string
  again: 'next' | 'prev' | null
}

/** The tab hover card (see lib/hoverCard.ts): the row it is up for, and where that row is. */
export interface HoverCardState {
  tabId: string | null
  /** The row's box, viewport coordinates: the card is start-aligned with it. */
  anchor: Rect | null
  /** The sidebar's box: the card sits flush against its edge (gap 0). */
  sidebar: Rect | null
  /** What put it up: the pointer resting on the row, or keyboard focus landing on it. */
  by: 'pointer' | 'focus' | null
}

export const HOVER_CARD_HIDDEN: HoverCardState = {
  tabId: null,
  anchor: null,
  sidebar: null,
  by: null
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
  /** The query in the find bar's field (kept here so the bar survives a remount, e.g. into HTML fullscreen). */
  findText: string
  findRequest: FindRequest | null
  /** Data URL of the active tab, shown dimmed behind overlays. */
  snapshot: string | null
  snapshotTabId: string | null
  toasts: Toast[]
  statusText: string
  drag: DragState | null
  /** The hidden sidebar (compact mode, fullscreen) is out over a picture of the page. */
  compactHover: boolean
  /** The hidden top toolbar (compact mode, fullscreen) is out over a picture of the page. */
  toolbarHover: boolean
  renamingTabId: string | null
  renamingFolderId: string | null
  /** Tab whose pinned URL is being edited in the small prompt. */
  editingPinnedUrlTabId: string | null
  /** Tab whose icon picker is open. */
  iconPickerTabId: string | null
  /** An HTTP sign-in or certificate dialog is up over the page (the page waits for it). */
  securityPromptOpen: boolean
  /** A page's `alert` / `confirm` / `prompt` or "Leave site?" dialog is up (the page waits for it). */
  pageDialogOpen: boolean
  /** A window-modal question ("Close N tabs?", "Quit Zenium?") is up over the whole window. */
  windowPromptOpen: boolean
  /**
   * The star bubble (Ctrl+D): the tab that was starred, its bookmark, and where the star it
   * hangs from and the address pill around it were when it opened (null when the pill is not
   * on screen).
   */
  starDialog: {
    tabId: string
    nodeId: string
    created: boolean
    anchor: Rect | null
    pill: Rect | null
  } | null
  /**
   * The zoom bubble (Chrome's): up for the tab whose page was just zoomed, or opened from the
   * pill's zoom chip. `factor` is the page's zoom as the last change reported it; `seq` counts
   * the changes so the bubble restarts its clock on each; `source` says how it opened – a zoom
   * step puts it away by itself, the chip keeps it until the user does.
   */
  zoomBubble: { tabId: string; factor: number; seq: number; source: 'auto' | 'chip' } | null
  /** A bookmark the manager should edit, or create (`id: null`) inside `parentId`. */
  bookmarkEdit: { id: string | null; parentId: string; type: BookmarkNodeType } | null
  /** "Bookmark all tabs": the pages to file and the folder name Chrome would suggest. */
  bookmarkAllTabs: { tabIds: string[]; defaultTitle: string } | null
  /**
   * The new tab page's add (`id` null) or edit shortcut dialog, up over the page in `tabId`
   * (a frame dialog; the page gives way to its picture while it is open).
   */
  newTabShortcutDialog: { tabId: string; id: string | null; title: string; url: string } | null
  /** A folder panel of the bookmarks bar hangs over the page. */
  barMenuOpen: boolean
  /** A permission prompt ("Allow example.com to use your camera?") is up over the page. */
  permissionPromptOpen: boolean
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
  /** Phone layout: the sheet that rearranges the bar's controls is up. */
  barEditorOpen: boolean
  /** Phone layout: the Tabs button's quick menu is up, anchored to the button (window px). */
  tabsMenu: Rect | null
  /** Safe-area insets of the host window (status bar, gesture bar, IME). */
  insets: Insets
  /**
   * Phone layout: the gesture stage (tab-switch cards, the tab overview) stands in for the live
   * page, which must be hidden underneath it.
   */
  stageActive: boolean
  /** The tab hover card, up beside the sidebar over the page (hidden: `tabId` null). */
  hoverCard: HoverCardState
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
    findText: '',
    findRequest: null,
    snapshot: null,
    snapshotTabId: null,
    toasts: [],
    statusText: '',
    drag: null,
    compactHover: false,
    toolbarHover: false,
    renamingTabId: null,
    renamingFolderId: null,
    editingPinnedUrlTabId: null,
    iconPickerTabId: null,
    securityPromptOpen: false,
    pageDialogOpen: false,
    windowPromptOpen: false,
    starDialog: null,
    zoomBubble: null,
    bookmarkEdit: null,
    bookmarkAllTabs: null,
    newTabShortcutDialog: null,
    barMenuOpen: false,
    permissionPromptOpen: false,
    selectedTabIds: [],
    selectionAnchorId: null,
    glanceActive: false,
    glanceReady: false,
    spaceSlideDirection: 0,
    drawerOpen: false,
    menu: null,
    siteInfoOpen: false,
    externalProtocol: null,
    barEditorOpen: false,
    tabsMenu: null,
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    stageActive: false,
    hoverCard: HOVER_CARD_HIDDEN
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

/** Some chrome surface (an overlay, the URL bar, a menu, a sheet, the stage) has the keyboard. */
export function chromeNeedsKeyboard(): boolean {
  const ui = uiStore.get()
  return !(
    ui.overlay === 'none' &&
    !ui.urlbar.open &&
    !ui.findOpen &&
    !ui.drawerOpen &&
    !ui.menu &&
    !ui.siteInfoOpen &&
    !ui.externalProtocol &&
    !ui.barEditorOpen &&
    !ui.tabsMenu &&
    !ui.securityPromptOpen &&
    !ui.permissionPromptOpen &&
    !ui.pageDialogOpen &&
    !ui.windowPromptOpen &&
    !ui.stageActive &&
    !ui.zoomBubble &&
    !ui.newTabShortcutDialog &&
    !bookmarkChromeOpen(ui)
  )
}

/** Once no chrome UI needs the keyboard, hand focus back to the active page. */
export function returnFocusToPage(): void {
  if (!chromeNeedsKeyboard()) run('focus.content', undefined)
}

/** Drop the cached snapshot once nothing needs it, so the next overlay gets a fresh capture. */
export function invalidateSnapshot(): void {
  const ui = uiStore.get()
  if (
    ui.overlay === 'none' &&
    !ui.urlbar.open &&
    !ui.drag &&
    !ui.compactHover &&
    !ui.toolbarHover &&
    !ui.drawerOpen &&
    !ui.menu &&
    !ui.siteInfoOpen &&
    !ui.externalProtocol &&
    !ui.barEditorOpen &&
    !ui.tabsMenu &&
    !ui.securityPromptOpen &&
    !ui.permissionPromptOpen &&
    !ui.pageDialogOpen &&
    !ui.windowPromptOpen &&
    !ui.stageActive &&
    !ui.zoomBubble &&
    ui.hoverCard.tabId === null &&
    !ui.newTabShortcutDialog &&
    !bookmarkChromeOpen(ui)
  ) {
    uiStore.set({ snapshot: null, snapshotTabId: null })
  }
}

// ---------------------------------------------------------------------------
// Bookmark chrome over the page: the star bubble, the bar's panels, the dialogs
// ---------------------------------------------------------------------------

type BookmarkChrome = Pick<
  UiState,
  'starDialog' | 'bookmarkEdit' | 'bookmarkAllTabs' | 'barMenuOpen'
>

/** Whether any of it is up. The manager owns its own edit dialog while it is open. */
export function bookmarkChromeOpen(ui: UiState): boolean {
  return (
    ui.starDialog !== null ||
    ui.bookmarkAllTabs !== null ||
    ui.barMenuOpen ||
    (ui.bookmarkEdit !== null && ui.overlay === 'none')
  )
}

/**
 * Like a menu: the page behind is captured first, then the chrome takes the keyboard. One
 * popover at a time (design-language-v2-draft §9.20): the star bubble and a bar panel replace
 * each other rather than stacking.
 */
export async function openBookmarkChrome(
  patch: Partial<BookmarkChrome>,
  activeTabId: string | null
): Promise<void> {
  await captureActiveTab(activeTabId)
  run('focus.chrome', undefined)
  const exclusive: Partial<BookmarkChrome> = {}
  if (patch.starDialog) exclusive.barMenuOpen = false
  if (patch.barMenuOpen) exclusive.starDialog = null
  uiStore.set({ ...exclusive, ...patch })
}

/**
 * Put bookmark chrome away. Focus goes back to the page unless the caller keeps it in the
 * chrome (`keepFocus`: Escape hands it to the anchor the popover hung from, §9.22).
 */
export function closeBookmarkChrome(
  patch: Partial<BookmarkChrome>,
  opts: { keepFocus?: boolean } = {}
): void {
  uiStore.set(patch)
  invalidateSnapshot()
  if (!opts.keepFocus) returnFocusToPage()
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

/**
 * Keys typed into the new tab page while its URL bar is still on its way up (the snapshot of the
 * page is taken first). They are appended here and land in the field as its initial text, so
 * nothing typed between Ctrl+T and the first paint of the bar is lost.
 */
let typeahead: { tabId: string; text: string } | null = null

/**
 * The URL bar over a new tab page: `new-tab` mode bound to that tab, so what is typed navigates
 * it instead of creating another. `text` is what the page's search box already received.
 */
export function openNewTabPageUrlbar(
  tabId: string,
  text: string | undefined,
  attached: boolean
): void {
  const ui = uiStore.get()
  if (ui.overlay === 'onboarding') return
  if (ui.urlbar.open && ui.urlbar.mode === 'new-tab' && ui.urlbar.tabId === tabId) {
    if (text) window.dispatchEvent(new CustomEvent<string>('zen-urlbar-type', { detail: text }))
    return
  }
  if (typeahead && typeahead.tabId === tabId) {
    typeahead.text += text ?? ''
    return
  }
  const mine = { tabId, text: text ?? '' }
  typeahead = mine
  void captureActiveTab(tabId).then(() => {
    if (typeahead !== mine) return
    typeahead = null
    run('focus.chrome', undefined)
    uiStore.set({
      urlbar: {
        open: true,
        mode: 'new-tab',
        tabId,
        initialText: mine.text || undefined,
        typed: Boolean(mine.text),
        attached
      },
      drawerOpen: false
    })
  })
}

export function closeUrlbar(): void {
  typeahead = null
  if (!uiStore.get().urlbar.open) return
  uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: false } }))
  invalidateSnapshot()
  returnFocusToPage()
}

// ---------------------------------------------------------------------------
// Find in page
// ---------------------------------------------------------------------------

let findSeq = 0

/**
 * Show the find bar for `tabId` (or hand a request to the open one): `text` goes into the field
 * when there is any, `again` steps to the next or previous match at once. A bar open for another
 * tab moves over, its query left behind.
 */
export function openFindBar(tabId: string, text = '', again: 'next' | 'prev' | null = null): void {
  const ui = uiStore.get()
  const moving = ui.findOpen && ui.findTabId !== tabId
  if (moving && ui.findTabId) run('find.stop', { tabId: ui.findTabId, keepSelection: true })
  uiStore.set({
    findOpen: true,
    findTabId: tabId,
    findText: text || (moving ? '' : ui.findText),
    findRequest: { seq: ++findSeq, text, again }
  })
}

/**
 * Esc, the X, Back: the bar goes, the active match stays selected and the page has the keyboard.
 * Closed by a key (`release: 'afterKey'`), the page gets the keyboard once that key is up: a
 * page in HTML fullscreen leaves it on any Escape event the engine hands it, the release too.
 */
export function closeFindBar(release: 'now' | 'afterKey' = 'now'): void {
  const ui = uiStore.get()
  if (!ui.findOpen) return
  if (ui.findTabId) run('find.stop', { tabId: ui.findTabId, keepSelection: true })
  uiStore.set({ findOpen: false, findTabId: null, findRequest: null })
  if (release === 'afterKey') afterKeyRelease(returnFocusToPage)
  else returnFocusToPage()
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
    ui.barEditorOpen ||
    ui.tabsMenu !== null ||
    ui.securityPromptOpen ||
    ui.permissionPromptOpen ||
    ui.pageDialogOpen ||
    ui.windowPromptOpen ||
    ui.stageActive ||
    ui.zoomBubble !== null ||
    ui.hoverCard.tabId !== null ||
    ui.newTabShortcutDialog !== null ||
    bookmarkChromeOpen(ui)
  )
}

// ---------------------------------------------------------------------------
// The new tab page's shortcut dialog over the page
// ---------------------------------------------------------------------------

/**
 * `newtab.shortcutDialog`: the page in `tabId` asked for its add or edit shortcut dialog. Like
 * every chrome dialog over a page, the page is captured first and then gives way to its picture
 * under the frame's scrim; the chrome takes the keyboard for the dialog's fields.
 */
export async function openNewTabShortcutDialog(
  request: NonNullable<UiState['newTabShortcutDialog']>
): Promise<void> {
  if (uiStore.get().overlay === 'onboarding') return
  await captureActiveTab(request.tabId)
  run('focus.chrome', undefined)
  uiStore.set({ newTabShortcutDialog: request })
}

export function closeNewTabShortcutDialog(): void {
  if (!uiStore.get().newTabShortcutDialog) return
  uiStore.set({ newTabShortcutDialog: null })
  invalidateSnapshot()
  returnFocusToPage()
}

// ---------------------------------------------------------------------------
// Phone bar editor
// ---------------------------------------------------------------------------

/** Open the sheet that rearranges the phone bar's controls (from Settings or a hold on the bar). */
export async function openBarEditor(activeTabId: string | null): Promise<void> {
  if (uiStore.get().barEditorOpen) return
  // The sheet recedes the page behind it like every other, so the snapshot must exist first;
  // over an overlay (Settings) it already does.
  if (uiStore.get().overlay === 'none') await captureActiveTab(activeTabId)
  run('focus.chrome', undefined)
  uiStore.set({ barEditorOpen: true })
}

export function closeBarEditor(): void {
  if (!uiStore.get().barEditorOpen) return
  uiStore.set({ barEditorOpen: false })
  invalidateSnapshot()
  returnFocusToPage()
}

/**
 * The Tabs button's quick menu. It overhangs the content area, where the page view is drawn
 * above the chrome, so the page gives way to its snapshot while the menu is up, as it does for
 * the sheets.
 */
export async function openTabsMenu(anchor: Rect, activeTabId: string | null): Promise<void> {
  if (uiStore.get().overlay === 'none') await captureActiveTab(activeTabId)
  run('focus.chrome', undefined)
  uiStore.set({ tabsMenu: anchor })
}

export function closeTabsMenu(): void {
  if (!uiStore.get().tabsMenu) return
  uiStore.set({ tabsMenu: null })
  invalidateSnapshot()
  returnFocusToPage()
}

/**
 * Only anchored panels are up: a bar panel, the star bubble, the zoom bubble, the tab hover
 * card. The page behind them is captured all the same (they overlap the live view), but panels
 * draw no scrim, so the capture shows undimmed; dialogs dim it.
 */
export function panelAloneOverContent(ui: UiState): boolean {
  return (
    (ui.barMenuOpen ||
      ui.starDialog !== null ||
      ui.zoomBubble !== null ||
      ui.hoverCard.tabId !== null) &&
    !overlayCoversContent({
      ...ui,
      barMenuOpen: false,
      starDialog: null,
      zoomBubble: null,
      hoverCard: HOVER_CARD_HIDDEN
    })
  )
}

// ---------------------------------------------------------------------------
// The zoom bubble over the page
// ---------------------------------------------------------------------------

/**
 * A page was zoomed (`zoom.changed`): the bubble comes up for it over a picture of the page –
 * the live view gives way under chrome that overlaps it, as under the star bubble – and, while
 * it is up, takes a fresh picture at every step so the page is seen at its new zoom. The
 * keyboard is left where it is: a zoom step opens the bubble as feedback, not as a place to be.
 */
export async function showZoomBubble(tabId: string, factor: number): Promise<void> {
  const bubbleFor = (id: string): UiState['zoomBubble'] => {
    const open = uiStore.get().zoomBubble
    return open && open.tabId === id ? open : null
  }
  if (!bubbleFor(tabId)) {
    await captureActiveTab(tabId)
    // Two quick steps race here: the first to come back opens the bubble, the second finds it
    // open and, like any later step, takes a fresh picture (the first one may predate it).
    if (!bubbleFor(tabId)) {
      uiStore.set({ zoomBubble: { tabId, factor, seq: 0, source: 'auto' } })
      return
    }
  }
  const open = bubbleFor(tabId)
  if (open) uiStore.set({ zoomBubble: { ...open, factor, seq: open.seq + 1 } })
  await refreshSnapshot(tabId)
}

/** The pill's zoom chip was pressed: the bubble opens and stays, and the keyboard goes into it. */
export async function openZoomBubble(tabId: string, factor: number): Promise<void> {
  await captureActiveTab(tabId)
  run('focus.chrome', undefined)
  uiStore.set({ zoomBubble: { tabId, factor, seq: 0, source: 'chip' } })
}

/**
 * Put the bubble away. Focus goes back to the page unless the caller keeps it in the chrome
 * (`keepFocus`: Escape hands it to the chip the bubble hung from, §9.22).
 */
export function closeZoomBubble(opts: { keepFocus?: boolean } = {}): void {
  if (!uiStore.get().zoomBubble) return
  uiStore.set({ zoomBubble: null })
  invalidateSnapshot()
  if (!opts.keepFocus) returnFocusToPage()
}

/** The page changed under the chrome (a zoom step): its picture is taken again. */
async function refreshSnapshot(tabId: string): Promise<void> {
  const data = await cmd('overlay.snapshot', { tabId, fresh: true }).catch(() => null)
  if (!data || uiStore.get().snapshotTabId !== tabId) return
  rememberThumbnail(tabId, data)
  uiStore.set({ snapshot: data })
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
