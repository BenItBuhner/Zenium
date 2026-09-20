import type { LucideIcon } from 'lucide-react'
import type {
  BookmarkNodeType,
  ContentCover,
  DefaultBrowserRequestSource,
  ExtensionPromptRequest,
  ExternalProtocolRequest,
  MenuDescriptor,
  OverlayKind,
  Rect,
  UIState,
  UrlbarOpenMode,
  WebAppInstallPrompt
} from '@shared/types'
import { TOAST_SHOW_MS } from '@shared/toastCard'
import type { Anchor } from './anchor'
import type { PopoverAlignment } from './portals'
import { cmd, onEvent, run } from './api'
import { afterKeyRelease } from './keyRelease'
import { pageCovered, pageOffScreen, pageViewStore, type Hold } from './pageView'
import { activeTab } from './selectors'
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
  /**
   * The bar is the empty pane's field (split-04): `tabId` is the blank tab of the split on
   * screen, whose pane the chrome draws itself (no view is placed there), so the bar floats in
   * that pane and the other panes stay live – it covers no page and hides none.
   */
  pane?: boolean
}

/**
 * The tab search popover in its pick mode (split-04): "Choose a tab for this pane", hanging
 * from the empty pane's button, placed inside that pane – the popover may not overhang the
 * live panes beside it – and putting the chosen tab in the pane (`split.pickTab`).
 */
export interface TabPickRequest {
  /** The blank tab shown in the pane to fill. */
  paneTabId: string
  /** The split the pane belongs to; the popover leaves with it. */
  groupId: string
  /** The pane's box, in window coordinates: the popover's viewport. */
  pane: Rect
}

export type ToastKind = 'info' | 'error'

/** The one thing a message offers to do ("Undo", "Open", "Install"). */
export interface MessageAction {
  label: string
  onPick: () => void
}

export interface Toast {
  id: number
  message: string
  kind: ToastKind
  action?: MessageAction
  /** A leading glyph for the message – the star that just filled (the phone's Saved to Bookmarks). */
  icon?: 'star'
  /** How long the toast stays before it goes on its own (ms). */
  duration: number
  /** Set once the toast is on its way out: the card animates off and then forgets itself. */
  leaving?: boolean
}

/** An extension popup the renderer is framing (the document itself is main's WebContentsView). */
export interface ExtensionPopupState {
  id: string
  /**
   * The toolbar button it hangs from, in window coordinates, with the bar it sits in: its box,
   * not the element (the chrome layer's popover registry holds that, lib/extensions/popup.ts).
   */
  anchor: Omit<Anchor, 'element'>
  /**
   * The puzzle panel's alignment when the popup was opened from one of its rows: the frame
   * keeps it while it fits (§9.20's continuity clause). Absent for a popup from a pinned button.
   */
  alignment?: PopoverAlignment
  /** The document's preferred size once it reported one. */
  content: { width: number; height: number } | null
  /** The frame is up: the size arrived, or the wait for it ran out. */
  shown: boolean
}

export type BannerDismissReason = 'swipe' | 'close' | 'timeout' | 'action' | 'replaced' | 'program'

/**
 * A message that drops in under the toolbar and stays until dealt with: install prompts, the
 * default-browser offer, a blocked popup. Newer banners push the older ones down.
 */
export interface Banner {
  id: number
  title: string
  detail?: string
  /** A Lucide glyph leading the title. */
  icon?: LucideIcon
  action?: MessageAction
  /** Banners of one `key` do not pile up: showing another replaces the one on screen. */
  key?: string
  /** Auto-dismiss after this long (ms); null stays until dismissed. */
  duration: number | null
  onDismiss?: (reason: BannerDismissReason) => void
  leaving?: boolean
}

export interface BannerOptions {
  title: string
  detail?: string
  icon?: LucideIcon
  action?: MessageAction
  key?: string
  duration?: number | null
  onDismiss?: (reason: BannerDismissReason) => void
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

/** What the bookmark editor is asked to do: edit a node, or create one inside `parentId`. */
export interface BookmarkEditRequest {
  id: string | null
  parentId: string
  type: BookmarkNodeType
}

/** A selection the core asked the chrome to translate (the `translate.selection` event). */
export interface TranslateSelectionRequest {
  tabId: string
  text: string
  /** Where the user asked, in CSS pixels of the page view; null when unknown. */
  x: number | null
  y: number | null
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
  /** The page zoom sheet is docked under this tab's page (hosts with page controls). */
  zoomTabId: string | null
  /** Data URL of the active tab, shown dimmed behind overlays. */
  snapshot: string | null
  snapshotTabId: string | null
  /** At most one toast is live; a toast on its way out may still be alongside it. */
  toasts: Toast[]
  /** Top message banners, newest first (it sits on top; the older ones are pushed down). */
  banners: Banner[]
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
  /**
   * The list of pop-ups the blocker refused for a tab, anchored under the address pill's
   * indicator (window coordinates) or, without an anchor, as a sheet.
   */
  blockedPopupsPanel: { tabId: string; anchor: Rect | null } | null
  /** An HTTP sign-in or certificate dialog is up over the page (the page waits for it). */
  securityPromptOpen: boolean
  /** A page's `alert` / `confirm` / `prompt` or "Leave site?" dialog is up (the page waits for it). */
  pageDialogOpen: boolean
  /** A page's `getDisplayMedia` picker ("Choose what to share") is up (the page waits for it). */
  screenPickerOpen: boolean
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
  /**
   * Reader View's text preferences for a reader tab (CT-20): a popover under the pill's chip on
   * a mouse (`anchor` is the chip; null hangs it under the frame's top edge), the shared sheet
   * on a phone. Opened by the chip, the app menu's "Text Preferences…" or the reader page's own
   * toolbar; the page beneath is a picture that is taken again after every change.
   */
  readerPreferences: { tabId: string; anchor: Rect | null } | null
  /**
   * A bookmark the manager should edit, or create (`id: null`) inside `parentId`; on phones the
   * editor sheet (the `bookmark.edit` event, the star toast's Edit).
   */
  bookmarkEdit: BookmarkEditRequest | null
  /** "Bookmark all tabs": the pages to file and the folder name Chrome would suggest. */
  bookmarkAllTabs: { tabIds: string[]; defaultTitle: string } | null
  /**
   * The new tab page's add (`id` null) or edit shortcut dialog, up over the page in `tabId`
   * (a frame dialog; the page gives way to its picture while it is open).
   */
  newTabShortcutDialog: { tabId: string; id: string | null; title: string; url: string } | null
  /**
   * The site-information confirmation on a mouse ("Clear site data?", "Clear cookies?"): a frame
   * dialog over the page in `tabId`, opened from the popover, which closes when it does (§9.20).
   */
  siteDataConfirm: { tabId: string; kind: 'cookies' | 'data'; site: string; count: number } | null
  /** A folder panel of the bookmarks bar hangs over the page. */
  barMenuOpen: boolean
  /** A permission prompt ("Allow example.com to use your camera?") is up over the page. */
  permissionPromptOpen: boolean
  /** The Clear browsing data dialog (or sheet) is up over the page or over Settings. */
  clearBrowsingDataOpen: boolean
  /**
   * Zenium's print preview (`zen://print`, `print/PrintPreviewDialog`): a frame dialog over the
   * page in `tabId`, which it renders to a PDF and shows, with Chrome's options beside it.
   */
  printPreview: { tabId: string } | null
  /**
   * An autofill prompt (save / update a login, save an address or card, pick a passkey account)
   * is up over the page, and how: a popover under the URL bar (no scrim), a sheet, or a dialog.
   */
  autofillPrompt: 'popover' | 'sheet' | 'dialog' | null
  /** The id of a save prompt put away behind the key chip in the pill; the chip brings it back. */
  autofillPromptCollapsed: string | null
  /**
   * The id of a save prompt the chip brought back by hand: that one takes the focus as any
   * popover the user opened, where the prompt the page raised takes none (v2 §9.22's notice rule).
   */
  autofillPromptByHand: string | null
  /** Settings > Autofill is editing an address or a card (`id: null` adds one). */
  autofillEdit: { kind: 'address' | 'card'; id: string | null } | null
  /**
   * A re-authenticated autofill command wants the vault passphrase (`lib/autofill.ts`
   * `withPassphrase`): the dialog asking for it is up, with the refused attempt's error.
   */
  autofillPassphrase: {
    title: string
    description: string
    error: string | null
    busy: boolean
  } | null
  /** Zen's multi-select: tabs picked with Ctrl / Shift+click (acted on together). */
  selectedTabIds: string[]
  /** Last plainly clicked / toggled tab – the anchor for Shift+click ranges. */
  selectionAnchorId: string | null
  /**
   * The tab strip's one tab stop (lib/tabStrip.ts): the strip item – a row, a tile, a folder or
   * pinned header – the keyboard is on, `tab:<id>` and the like; null when the keyboard is
   * elsewhere, and the active row is the stop.
   */
  stripFocus: string | null
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
  /** Voice search: the listening sheet is up, for the search it will load (`lib/voiceSearch.ts`). */
  voice: VoicePrompt | null
  /** QR scanning: the scan sheet is up, for the payload it will load (`lib/qrScan.ts`). */
  qrScan: QrPrompt | null
  /** Phone layout: the sheet that rearranges the bar's controls is up. */
  barEditorOpen: boolean
  /** Phone layout: the app menu's Extensions sheet (one row per extension action) is up. */
  extensionsSheetOpen: boolean
  /**
   * Phone layout: a `FrameDialogHost` sheet holds the page under its cover, from before it
   * rises until it has left the screen (`coverPageUnderSheet`); the dialogs it hosts set their
   * own flags later and drop them sooner than the sheet's motion runs.
   */
  frameSheetOpen: boolean
  /** Phone layout: the Tabs button's quick menu is up, anchored to the button (window px). */
  tabsMenu: Rect | null
  /** The downloads bubble (anchored under the toolbar button) is up. */
  downloadsOpen: boolean
  /** The default-browser promo (sheet or dialog) is up over a capture of the page. */
  defaultBrowserPrompt: boolean
  /**
   * The desktop's default-browser prompt has been asked for – "Make default" on the strip – and
   * says what the OS will do before the hand-off (`DefaultBrowserPrompt.tsx`): where it was
   * asked from, or null. `defaultBrowserPrompt` goes true once it is up over the page's picture.
   */
  defaultBrowserAsk: DefaultBrowserRequestSource | null
  /** "Add to Home screen": the install sheet (manifest) or the name-edit sheet, when open. */
  install: WebAppInstallPrompt | null
  /**
   * Phone layout: the media sheet (the in-app player for the tab whose media the OS controls
   * show, MW-16) is up, opened from the pill's Now playing chip; the tab it opened on.
   */
  mediaSheet: string | null
  /**
   * The selection the core asked the chrome to translate: the selection popover (desktop) or
   * sheet (phone) is up for it. A request only – the surface holds the page's capture and the
   * keyboard itself while it is up (`useFloatingChrome`, counted in `floatingChrome`).
   */
  translateSelection: TranslateSelectionRequest | null
  /**
   * The tab search popover (tabs-17, Ctrl+Shift+A) is up from the sidebar's top row. `keyboard`:
   * a chrome control had the focus when it opened, so the page does not take it back on close.
   * A request only, as `translateSelection`: the popover holds the capture and the keyboard
   * itself (`useFloatingChrome`). With `pick` it is the empty pane's picker instead
   * (`TabPickRequest`), hanging from the pane's button and holding no capture.
   */
  tabSearch: { keyboard: boolean; pick?: TabPickRequest } | null
  /**
   * The group editor bubble (tabs-13) is up beside a folder's header row in the sidebar.
   * `keyboard`: the header had the focus when it opened (Space or Enter, the folder menu from
   * the keyboard), so Escape hands the keyboard back to it. A request only, as `tabSearch`.
   */
  groupEditor: { folderId: string; keyboard: boolean } | null
  /** Safe-area insets of the host window (status bar, gesture bar, IME). */
  insets: Insets
  /**
   * Phone layout: the bar has hidden on scroll and is at rest off its edge (`lib/barHide.ts`);
   * the content column gives the page its band. False the moment the bar starts back.
   */
  barHidden: boolean
  /**
   * Phone layout: the gesture stage (tab-switch cards, the tab overview) stands in for the live
   * page, which must be hidden underneath it.
   */
  stageActive: boolean
  /** The tab hover card, up beside the sidebar over the page (hidden: `tabId` null). */
  hoverCard: HoverCardState
  /** The open extension popup's frame, or null. */
  extensionPopup: ExtensionPopupState | null
  /** Install and permission prompts waiting for an answer, oldest first; the first is shown. */
  extensionPrompts: ExtensionPromptRequest[]
  /**
   * Renderer-hosted popovers that can overhang the content frame (the extensions panel, local
   * menus), counted while up. The page's view composites above the chrome, so while one is up
   * the view is hidden and the frame shows its capture, as for the main-process menus.
   */
  floatingChrome: number
  /**
   * Frame dialog hosts keeping the page under its picture (lib/portals.tsx,
   * `holdFrameDialogCover`): a host holds from the moment some overlay covers the page while it
   * has a dialog until that dialog's panel has finished its way out, so the view stays hidden
   * and the capture stays for the exit that the dialog's own flag (`pageDialogOpen`,
   * `starDialog`, …) no longer covers. Counted, one per host. Not in `overlayCoversContent`:
   * the hold only ever outlasts a cover some flag there began, and nothing that reads the flags
   * to tell panels from dialogs (`panelAloneOverContent`) should change its answer for it.
   */
  frameDialogCover: number
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
    zoomTabId: null,
    snapshot: null,
    snapshotTabId: null,
    toasts: [],
    banners: [],
    statusText: '',
    drag: null,
    compactHover: false,
    toolbarHover: false,
    renamingTabId: null,
    renamingFolderId: null,
    editingPinnedUrlTabId: null,
    iconPickerTabId: null,
    blockedPopupsPanel: null,
    securityPromptOpen: false,
    pageDialogOpen: false,
    screenPickerOpen: false,
    windowPromptOpen: false,
    starDialog: null,
    zoomBubble: null,
    readerPreferences: null,
    bookmarkEdit: null,
    bookmarkAllTabs: null,
    newTabShortcutDialog: null,
    siteDataConfirm: null,
    barMenuOpen: false,
    permissionPromptOpen: false,
    clearBrowsingDataOpen: false,
    printPreview: null,
    autofillPrompt: null,
    autofillPromptCollapsed: null,
    autofillPromptByHand: null,
    autofillEdit: null,
    autofillPassphrase: null,
    selectedTabIds: [],
    selectionAnchorId: null,
    stripFocus: null,
    glanceActive: false,
    glanceReady: false,
    spaceSlideDirection: 0,
    drawerOpen: false,
    menu: null,
    siteInfoOpen: false,
    externalProtocol: null,
    voice: null,
    qrScan: null,
    barEditorOpen: false,
    extensionsSheetOpen: false,
    frameSheetOpen: false,
    tabsMenu: null,
    downloadsOpen: false,
    defaultBrowserPrompt: false,
    defaultBrowserAsk: null,
    install: null,
    mediaSheet: null,
    translateSelection: null,
    tabSearch: null,
    groupEditor: null,
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    barHidden: false,
    stageActive: false,
    hoverCard: HOVER_CARD_HIDDEN,
    extensionPopup: null,
    extensionPrompts: [],
    floatingChrome: 0,
    frameDialogCover: 0
  },
  'ui'
)

// ---------------------------------------------------------------------------
// Messages: toasts at the bottom, banners at the top
// ---------------------------------------------------------------------------

/** A plain toast is read in a glance (§9.33's 2.8 s, one number with the page-drawn twin: `@shared/toastCard`); one with an action needs time to be acted on. */
export const TOAST_DURATION = TOAST_SHOW_MS
export const TOAST_ACTION_DURATION = 5000
/** Banners beyond this many push the oldest out. */
export const MAX_BANNERS = 3
/**
 * A card animates itself off and then forgets itself; should none report (the card unmounted
 * mid-exit) the message is swept out after the exit would have ended anyway.
 */
const EXIT_SWEEP_MS = 800

export interface ToastOptions {
  action?: MessageAction
  icon?: Toast['icon']
  duration?: number
}

/**
 * The shells that show messages on the animated cards (`components/messages`: the phone shell,
 * the Android sidebar) claim so while mounted. On the cards one toast is live at a time, a
 * repeat restarts its clock, and a dismissed message animates off before it is forgotten.
 * Without a claim the desktop sidebar's plain column of toasts keeps the semantics it always
 * had: every toast joins the column, lives its full time and simply goes. The desktop program
 * moves desktop over by mounting the cards, which is the claim.
 */
const cardHosts = new Set<symbol>()

/** Say that messages are shown on the cards from now on; call the return value when they stop. */
export function claimMessageCards(): () => void {
  const token = Symbol('message cards')
  cardHosts.add(token)
  return () => {
    cardHosts.delete(token)
  }
}

function onCards(): boolean {
  return cardHosts.size > 0
}

let messageSeq = 0
/** Per-message auto-dismiss clocks: the timer, and the time left when a finger held it. */
const clocks = new Map<number, { timer: ReturnType<typeof setTimeout>; due: number }>()

function armClock(id: number, ms: number, fire: () => void): void {
  disarmClock(id)
  clocks.set(id, { timer: setTimeout(fire, ms), due: Date.now() + ms })
}

function disarmClock(id: number): number | null {
  const clock = clocks.get(id)
  if (!clock) return null
  clearTimeout(clock.timer)
  clocks.delete(id)
  return Math.max(0, clock.due - Date.now())
}

/**
 * Show a toast. On the cards one toast is live at a time: a new one sends the current one off
 * (the two pass each other), except that the same message again just restarts its clock, so a
 * key held down does not stack a column of identical toasts. The plain desktop column takes
 * every toast as it always did.
 */
export function pushToast(
  message: string,
  kind: ToastKind = 'info',
  opts: ToastOptions = {}
): void {
  const duration = opts.duration ?? (opts.action ? TOAST_ACTION_DURATION : TOAST_DURATION)
  if (onCards()) {
    const live = uiStore.get().toasts.find((t) => !t.leaving)
    if (live && live.message === message && live.kind === kind && !opts.action && !live.action) {
      armClock(live.id, duration, () => dismissToast(live.id))
      return
    }
    if (live) dismissToast(live.id)
  }
  const id = ++messageSeq
  const toast: Toast = { id, message, kind, duration, action: opts.action, icon: opts.icon }
  uiStore.set((s) => ({ toasts: [...s.toasts, toast] }))
  armClock(id, duration, () => dismissToast(id))
}

/**
 * Send a toast on its way: its card slides off and calls `forgetToast` when it is gone; a plain
 * toast (no card to move it) just goes.
 */
export function dismissToast(id: number): void {
  disarmClock(id)
  const toast = uiStore.get().toasts.find((t) => t.id === id)
  if (!toast || toast.leaving) return
  if (!onCards()) {
    forgetToast(id)
    return
  }
  uiStore.set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }))
  setTimeout(() => forgetToast(id), EXIT_SWEEP_MS)
}

/** The toast's card is off screen: drop it. */
export function forgetToast(id: number): void {
  disarmClock(id)
  if (!uiStore.get().toasts.some((t) => t.id === id)) return
  uiStore.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

/** A finger on the toast (or a pointer over it) stops its clock; letting go restarts what was left. */
export function holdToast(id: number, held: boolean): void {
  holdMessage(id, held, () => dismissToast(id))
}

/** Run the toast's action and send it off. */
export function pickToastAction(id: number): void {
  const toast = uiStore.get().toasts.find((t) => t.id === id)
  if (!toast || toast.leaving) return
  dismissToast(id)
  toast.action?.onPick()
}

/** Show a banner under the toolbar; returns its id for `dismissBanner`. */
export function showBanner(opts: BannerOptions): number {
  const id = ++messageSeq
  const banner: Banner = {
    id,
    title: opts.title,
    detail: opts.detail,
    icon: opts.icon,
    action: opts.action,
    key: opts.key,
    duration: opts.duration ?? null,
    onDismiss: opts.onDismiss
  }
  const live = uiStore.get().banners.filter((b) => !b.leaving)
  if (opts.key) for (const b of live) if (b.key === opts.key) dismissBanner(b.id, 'replaced')
  const staying = live.filter((b) => !(opts.key && b.key === opts.key))
  for (const b of staying.slice(MAX_BANNERS - 1)) dismissBanner(b.id, 'replaced')
  uiStore.set((s) => ({ banners: [banner, ...s.banners] }))
  if (banner.duration !== null) armClock(id, banner.duration, () => dismissBanner(id, 'timeout'))
  return id
}

/** Send a banner off; its `onDismiss` hears why, once. */
export function dismissBanner(id: number, reason: BannerDismissReason = 'program'): void {
  disarmClock(id)
  const banner = uiStore.get().banners.find((b) => b.id === id)
  if (!banner || banner.leaving) return
  if (onCards()) {
    uiStore.set((s) => ({
      banners: s.banners.map((b) => (b.id === id ? { ...b, leaving: true } : b))
    }))
    setTimeout(() => forgetBanner(id), EXIT_SWEEP_MS)
  } else {
    forgetBanner(id)
  }
  banner.onDismiss?.(reason)
}

export function forgetBanner(id: number): void {
  disarmClock(id)
  if (!uiStore.get().banners.some((b) => b.id === id)) return
  uiStore.set((s) => ({ banners: s.banners.filter((b) => b.id !== id) }))
}

export function holdBanner(id: number, held: boolean): void {
  holdMessage(id, held, () => dismissBanner(id, 'timeout'))
}

export function pickBannerAction(id: number): void {
  const banner = uiStore.get().banners.find((b) => b.id === id)
  if (!banner || banner.leaving) return
  dismissBanner(id, 'action')
  banner.action?.onPick()
}

const heldRemaining = new Map<number, number>()

function holdMessage(id: number, held: boolean, fire: () => void): void {
  if (held) {
    const left = disarmClock(id)
    if (left !== null) heldRemaining.set(id, left)
    return
  }
  const left = heldRemaining.get(id)
  heldRemaining.delete(id)
  // A message that was let go gets at least a moment before it leaves.
  if (left !== undefined) armClock(id, Math.max(left, 1000), fire)
}

/**
 * The cover band: the strips of the content area that the message cards cover, in CSS px from
 * its top and bottom edges. The layout reporter folds them into every view's placement so the
 * host clips the page out of them and hands their touches to the chrome (`ViewPlacement.cover`).
 * Not the page cover of `lib/cover.ts`, which is the picture that stands in for a hidden page.
 */
export const coverBandStore = createStore<ContentCover>({ top: 0, bottom: 0 }, 'cover-band')

/** Captures in flight, per tab: a sheet and the dialog it hosts asking together pay for one. */
const captures = new Map<string, Promise<void>>()

/** Capture the active tab before a chrome overlay hides it. */
export async function captureActiveTab(tabId: string | null): Promise<void> {
  if (!tabId) {
    uiStore.set({ snapshot: null, snapshotTabId: null })
    return
  }
  if (snapshotHeld(tabId)) return
  const pending = captures.get(tabId)
  if (pending) return pending
  const capture = (async (): Promise<void> => {
    const data = await cmd('overlay.snapshot', { tabId }).catch(() => null)
    if (data) rememberThumbnail(tabId, data)
    // A page that is already hidden (behind the gesture stage) cannot be captured: show what it
    // looked like the last time it was.
    uiStore.set({ snapshot: data ?? thumbnailOf(tabId), snapshotTabId: tabId })
  })().finally(() => {
    captures.delete(tabId)
  })
  captures.set(tabId, capture)
  return capture
}

/**
 * `tabId`'s capture is already in place, held by whatever chrome is over the content:
 * `captureActiveTab` would return at once, and a surface that opens out of that chrome can go
 * up in the same turn, before the chrome's release looks for something still needing it.
 */
export function snapshotHeld(tabId: string | null): boolean {
  const ui = uiStore.get()
  return tabId !== null && ui.snapshotTabId === tabId && ui.snapshot !== null
}

/** The overlays that are sections of the Settings page: a tab on a host with page tabs. */
const SETTINGS_OVERLAYS: ReadonlySet<OverlayKind> = new Set(['settings', 'shortcuts', 'sync'])

/**
 * Whether `kind` opens as an overlay on this host at all. Settings (with Shortcuts and Sync, its
 * sections) is a tab wherever the host has page tabs (`page.open`, `lib/pages.ts`): the overlay
 * is the desktop's until its program adopts the tab, and nothing may draw it over a phone.
 */
export function overlayAvailable(kind: OverlayKind): boolean {
  if (!SETTINGS_OVERLAYS.has(kind)) return true
  return !browserStore.get().state?.capabilities.pageTabs
}

export async function openOverlay(
  kind: OverlayKind,
  activeTabId: string | null,
  spaceId: string | null = null,
  folderId: string | null = null,
  section: string | null = null
): Promise<void> {
  if (!overlayAvailable(kind)) {
    // The Settings page's tab, through the core's one route (a section for Shortcuts / Sync).
    run('page.open', {
      id: 'settings',
      section: kind === 'settings' ? section : kind
    })
    return
  }
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
    !ui.voice &&
    !ui.qrScan &&
    ui.extensionPrompts.length === 0 &&
    !ui.extensionPopup &&
    ui.floatingChrome === 0 &&
    !ui.barEditorOpen &&
    !ui.extensionsSheetOpen &&
    !ui.tabsMenu &&
    !ui.blockedPopupsPanel &&
    !ui.securityPromptOpen &&
    !ui.permissionPromptOpen &&
    !ui.pageDialogOpen &&
    !ui.screenPickerOpen &&
    !ui.windowPromptOpen &&
    !ui.downloadsOpen &&
    !ui.defaultBrowserPrompt &&
    !ui.install &&
    !ui.clearBrowsingDataOpen &&
    !ui.printPreview &&
    !ui.autofillPrompt &&
    !ui.autofillEdit &&
    !ui.autofillPassphrase &&
    !ui.stageActive &&
    !ui.zoomBubble &&
    !ui.readerPreferences &&
    !ui.newTabShortcutDialog &&
    !ui.siteDataConfirm &&
    !bookmarkChromeOpen(ui)
  )
}

/** Once no chrome UI needs the keyboard, hand focus back to the active page. */
export function returnFocusToPage(): void {
  if (!chromeNeedsKeyboard()) run('focus.content', undefined)
}

/** A snapshot nothing needs any more, kept only until the host draws the page back. */
let snapshotStale = false

/**
 * Drop the cached snapshot once nothing needs it, so the next overlay gets a fresh capture.
 * Where the chrome lies under the pages the picture stays a little longer: until the host has
 * drawn the live page back in its place (`lib/pageView.ts`), so the frame between shows the
 * page's picture and not the window behind it; the drop then follows on its own.
 */
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
    !ui.voice &&
    !ui.qrScan &&
    ui.extensionPrompts.length === 0 &&
    !ui.extensionPopup &&
    ui.floatingChrome === 0 &&
    !ui.barEditorOpen &&
    !ui.extensionsSheetOpen &&
    !ui.frameSheetOpen &&
    !ui.tabsMenu &&
    !ui.blockedPopupsPanel &&
    !ui.securityPromptOpen &&
    !ui.permissionPromptOpen &&
    !ui.pageDialogOpen &&
    !ui.screenPickerOpen &&
    !ui.windowPromptOpen &&
    !ui.downloadsOpen &&
    !ui.defaultBrowserPrompt &&
    !ui.install &&
    !ui.clearBrowsingDataOpen &&
    !ui.printPreview &&
    !ui.autofillPrompt &&
    !ui.stageActive &&
    !ui.zoomBubble &&
    !ui.readerPreferences &&
    ui.hoverCard.tabId === null &&
    !ui.newTabShortcutDialog &&
    !ui.siteDataConfirm &&
    !bookmarkChromeOpen(ui) &&
    ui.frameDialogCover === 0
  ) {
    if (ui.snapshotTabId && pageOffScreen(pageViewStore.get(), ui.snapshotTabId)) {
      snapshotStale = true
      return
    }
    snapshotStale = false
    uiStore.set({ snapshot: null, snapshotTabId: null })
  }
}

/**
 * Wait for the active page's live view to be off the screen before a sheet comes up over its
 * picture (`pageCovered`): resolves at once when no chrome surface is covering the page – then
 * nothing is going to take the view down – or where the swap needs no timing.
 */
export function activePageCovered(): Hold {
  const state = browserStore.get().state
  const ui = uiStore.get()
  if (!state || !overlayCoversContent(ui)) return { promise: Promise.resolve(), cancel: () => {} }
  return pageCovered(activeTab(state)?.id ?? null, state.platform)
}

export interface SheetCover {
  /** Resolves once the live page is off the screen under the sheet's cover; never rejects. */
  promise: Promise<void>
  /** The sheet has left the screen (or never came up): let the page back. */
  release(): void
}

/** Sheets holding the page under their cover (`coverPageUnderSheet`) right now. */
let sheetCovers = 0

/**
 * A chassis sheet that mounts before anything covers the page – `FrameDialogHost` on a phone,
 * whose dialogs capture the page and set their own flag only after they are up, and drop it
 * the moment they go – takes the cover itself, in the order every other surface keeps: the live
 * page is captured first, then `frameSheetOpen` asks the host to hide the page views (the
 * layout reporter hides them once the picture is painted, `lib/cover.ts`), and the promise
 * resolves once they are down (`pageCovered`), so the recede never starts on a page about to
 * be swapped. `release` drops the flag: call it once the sheet has left the screen, so the page
 * comes back at the transform it left at, and the picture goes once the host has drawn it.
 */
export function coverPageUnderSheet(): SheetCover {
  const state = browserStore.get().state
  const tabId = state ? (activeTab(state)?.id ?? null) : null
  let live = true
  let taken = false
  let hold: Hold | null = null
  const promise = captureActiveTab(tabId).then(() => {
    if (!live) return
    taken = true
    sheetCovers++
    if (!uiStore.get().frameSheetOpen) uiStore.set({ frameSheetOpen: true })
    // No session yet (or no page in it): nothing to wait for.
    if (!state) return
    hold = pageCovered(tabId, state.platform)
    return hold.promise
  })
  return {
    promise,
    release() {
      if (!live) return
      live = false
      hold?.cancel()
      if (!taken) return
      taken = false
      if (--sheetCovers > 0) return
      uiStore.set({ frameSheetOpen: false })
      invalidateSnapshot()
    }
  }
}

const snapshotFlags = globalThis as unknown as { __zenSnapshotWired?: boolean }
if (!snapshotFlags.__zenSnapshotWired) {
  snapshotFlags.__zenSnapshotWired = true
  pageViewStore.subscribe(() => {
    if (snapshotStale) invalidateSnapshot()
  })
}

/**
 * Whether the page views are hidden under the chrome right now – what `useLayoutReporter`
 * reports as `contentHidden`: a chrome overlay covers the content, a compact sidebar or the
 * toolbar is revealed over it, or a frame dialog host keeps the page under its picture for a
 * panel's way out (`holdFrameDialogCover`).
 */
export function pageHidden(ui: UiState): boolean {
  return overlayCoversContent(ui) || ui.compactHover || ui.toolbarHover || ui.frameDialogCover > 0
}

/**
 * Keep the page under its picture for a frame dialog host (lib/portals.tsx) until the returned
 * release runs – from the moment a chrome overlay covers the page while the host has a dialog,
 * to the end of the last panel's way out. The dialogs' own flags (`pageDialogOpen`,
 * `windowPromptOpen`, `bookmarkAllTabs`, …) hide the page and keep its capture only while they
 * are set, and clear as the dialog closes – for some the flag is the dialog's very state,
 * cleared before its panel has left – so the host holds from the open: nothing is captured or
 * hidden here (over a page that shows live the host holds nothing, since hiding the page then
 * would show a blank frame for the way out); the count only outlasts a cover some flag began,
 * keeping the view hidden (`useLayoutReporter`) and the capture (`invalidateSnapshot`) until
 * the release, which drops the capture if nothing else needs it. Focus is not touched: the
 * dialogs hand it to the page through the core as they close, and the core gives it once the
 * page shows again.
 */
export function holdFrameDialogCover(): () => void {
  let live = true
  let taken = false
  let unsubscribe: (() => void) | null = null
  const take = (): void => {
    if (taken || !overlayCoversContent(uiStore.get())) return
    taken = true
    unsubscribe?.()
    unsubscribe = null
    uiStore.set((s) => ({ frameDialogCover: s.frameDialogCover + 1 }))
  }
  take()
  if (!taken) unsubscribe = uiStore.subscribe(take)
  return () => {
    if (!live) return
    live = false
    unsubscribe?.()
    unsubscribe = null
    if (!taken) return
    uiStore.set((s) => ({ frameDialogCover: Math.max(0, s.frameDialogCover - 1) }))
    invalidateSnapshot()
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
export function bookmarkChromeOpen(ui: BookmarkChrome & Pick<UiState, 'overlay'>): boolean {
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

/**
 * The install prompt – the phone's "Add to Home screen" sheet, the desktop's "Install app" /
 * "Create shortcut" dialog (`InstallLayer`, `InstallDialogLayer`; the host's chrome mounts the
 * one that is its surface) – dims the page behind it like a menu: the snapshot comes first.
 */
export async function openInstallSheet(prompt: WebAppInstallPrompt): Promise<void> {
  await captureActiveTab(prompt.tabId)
  run('focus.chrome', undefined)
  uiStore.set({ install: prompt, drawerOpen: false })
}

export function closeInstallSheet(tabId: string): void {
  if (uiStore.get().install?.tabId !== tabId) return
  uiStore.set({ install: null })
  invalidateSnapshot()
  returnFocusToPage()
}

/**
 * The media sheet (phone): the in-app player for `tabId`'s media, over a capture of the page
 * like every sheet in the frame's host. Opened from the pill's Now playing chip. The picture is
 * the active tab's – the tab on screen, which the media's tab need not be (the chip shows on
 * whichever pill is up) – so the recede holds what the user sees and `snapshotTabId` names the
 * view the host hides; the sheet's content stays the media's tab.
 */
export async function openMediaSheet(tabId: string, activeTabId: string | null): Promise<void> {
  await captureActiveTab(activeTabId)
  run('focus.chrome', undefined)
  uiStore.set({ mediaSheet: tabId, drawerOpen: false })
}

export function closeMediaSheet(): void {
  if (uiStore.get().mediaSheet === null) return
  uiStore.set({ mediaSheet: null })
  invalidateSnapshot()
  returnFocusToPage()
}

export async function openUrlbar(
  mode: UrlbarOpenMode,
  activeTabId: string | null,
  opts: { text?: string; attached?: boolean; pane?: boolean } = {}
): Promise<void> {
  // The empty pane's bar covers no page (`UrlbarState.pane`): there is nothing to capture, and
  // the panes beside it stay live.
  if (!opts.pane) await captureActiveTab(activeTabId)
  run('focus.chrome', undefined)
  uiStore.set({
    urlbar: {
      open: true,
      mode,
      tabId: mode === 'new-tab' ? null : activeTabId,
      initialText: opts.text,
      attached: Boolean(opts.attached),
      pane: Boolean(opts.pane) && mode !== 'new-tab'
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

/**
 * Close the URL bar. The keyboard goes back to the page unless `keepKeyboard`: a pane shortcut
 * (F6 from the bar, lib/panes.ts) has already put it on another chrome control, and asking for
 * the page's focus as well would take it back off that control.
 */
export function closeUrlbar(opts: { keepKeyboard?: boolean } = {}): void {
  typeahead = null
  if (!uiStore.get().urlbar.open) return
  uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: false } }))
  invalidateSnapshot()
  if (!opts.keepKeyboard) returnFocusToPage()
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
  // The find bar and the zoom sheet share the frame's bottom edge: one at a time.
  uiStore.set({
    findOpen: true,
    findTabId: tabId,
    findText: text || (moving ? '' : ui.findText),
    findRequest: { seq: ++findSeq, text, again },
    zoomTabId: null
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
// The page zoom sheet (docked under the page, which stays live)
// ---------------------------------------------------------------------------

/** "Zoom…" in the menu: the sheet takes the frame's bottom edge, so the find bar gives it up. */
export function openZoom(tabId: string): void {
  const ui = uiStore.get()
  if (ui.findOpen && ui.findTabId) run('find.stop', { tabId: ui.findTabId, keepSelection: true })
  uiStore.set({ zoomTabId: tabId, findOpen: false, findTabId: null, findRequest: null })
}

export function closeZoom(): void {
  if (!uiStore.get().zoomTabId) return
  uiStore.set({ zoomTabId: null })
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
  if (localMenus.delete(menu.id)) {
    // Nothing to tell the host about a menu it never knew.
  } else if (notifyHost) run('menu.close', { menuId: menu.id })
  invalidateSnapshot()
  returnFocusToPage()
}

export function pickMenuItem(itemId: string): void {
  const menu = uiStore.get().menu
  if (!menu) return
  uiStore.set({ menu: null })
  invalidateSnapshot()
  returnFocusToPage()
  const local = localMenus.get(menu.id)
  localMenus.delete(menu.id)
  // Run the action once the sheet has been unpainted: hosts that snapshot the window for the
  // dimmed overlay preview (Android's PixelCopy) would otherwise capture the menu itself.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (local) local.get(itemId)?.()
      else run('menu.click', { menuId: menu.id, itemId })
    })
  )
}

// ---------------------------------------------------------------------------
// Voice search (the listening sheet; `lib/voiceSearch.ts` runs the session)
// ---------------------------------------------------------------------------

/** The listening sheet's request: one per start, and where the transcript goes. */
export interface VoicePrompt {
  /** Each start is a new sheet (Try again restarts the recogniser inside the same one). */
  id: number
  /** The tab the search or address loads in (null: there is none, a new tab opens). */
  tabId: string | null
  /** Load the result in a new tab rather than `tabId` (the bar was in new-tab mode). */
  newTab: boolean
}

/**
 * Put the listening sheet up over a capture of the page (the sheet dims it like a menu). The
 * omnibox closes if it was the opener: the sheet takes the frame from it, the capture it held
 * carrying over.
 */
export async function openVoiceSheet(prompt: VoicePrompt): Promise<void> {
  await captureActiveTab(prompt.tabId)
  run('focus.chrome', undefined)
  uiStore.set({ voice: prompt, drawerOpen: false })
  if (uiStore.get().urlbar.open) closeUrlbar()
}

/** The sheet's request is over (a result submitted, Cancel, an error toasted): take it down. */
export function closeVoiceSheet(id: number): void {
  if (uiStore.get().voice?.id !== id) return
  uiStore.set({ voice: null })
  invalidateSnapshot()
  returnFocusToPage()
}

// ---------------------------------------------------------------------------
// QR scanning (the scan sheet; `lib/qrScan.ts` runs the session)
// ---------------------------------------------------------------------------

/** The scan sheet's request: one per start, and where the decoded payload goes. */
export interface QrPrompt {
  /** Each start is a new sheet. */
  id: number
  /** The tab the address or search loads in (null: there is none, a new tab opens). */
  tabId: string | null
  /** Load the result in a new tab rather than `tabId` (the bar was in new-tab mode). */
  newTab: boolean
}

/**
 * Put the scan sheet up over a capture of the page (the sheet dims it like a menu). The omnibox
 * closes if it was the opener: the sheet takes the frame from it, the capture it held carrying
 * over.
 */
export async function openQrSheet(prompt: QrPrompt): Promise<void> {
  await captureActiveTab(prompt.tabId)
  run('focus.chrome', undefined)
  uiStore.set({ qrScan: prompt, drawerOpen: false })
  if (uiStore.get().urlbar.open) closeUrlbar()
}

/** The sheet's request is over (a payload submitted, Cancel, an error toasted): take it down. */
export function closeQrSheet(id: number): void {
  if (uiStore.get().qrScan?.id !== id) return
  uiStore.set({ qrScan: null })
  invalidateSnapshot()
  returnFocusToPage()
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

// ---------------------------------------------------------------------------
// Renderer-built menus: the same descriptor and sheet as the host's menus, with the actions
// living here (a bookmark row's menu needs nothing the core does not already expose as commands).
// ---------------------------------------------------------------------------

export interface LocalMenuItem {
  label: string
  onSelect: () => void
  enabled?: boolean
  /** A destructive row, drawn in the danger ink. */
  danger?: boolean
}

/** A group break; the sheet separates groups by spacing. */
export const MENU_GAP = 'gap' as const

const localMenus = new Map<string, Map<string, () => void>>()
let localMenuSeq = 0

export interface LocalMenuOptions {
  /** The sheet's title: the row's own name rather than the source's generic one. */
  title?: string
  /** Where a mouse-driven popover anchors. */
  anchor?: { x: number; y: number }
}

export async function showLocalMenu(
  source: MenuDescriptor['source'],
  items: ReadonlyArray<LocalMenuItem | typeof MENU_GAP>,
  activeTabId: string | null,
  options: LocalMenuOptions = {}
): Promise<void> {
  const id = `local_${++localMenuSeq}`
  const handlers = new Map<string, () => void>()
  const descriptor: MenuDescriptor = {
    id,
    source,
    title: options.title,
    x: options.anchor?.x ?? null,
    y: options.anchor?.y ?? null,
    items: items.map((item, index) => {
      const itemId = `${id}_${index}`
      if (item === MENU_GAP)
        return {
          id: itemId,
          type: 'separator',
          label: '',
          enabled: true,
          checked: false,
          submenu: null
        }
      handlers.set(itemId, item.onSelect)
      return {
        id: itemId,
        type: 'normal',
        label: item.label,
        enabled: item.enabled ?? true,
        checked: false,
        submenu: null,
        danger: item.danger
      }
    })
  }
  const open = uiStore.get().menu
  if (open) closeMenu()
  localMenus.set(id, handlers)
  await showMenu(descriptor, activeTabId)
}

/**
 * True when a chrome overlay covers the content area (tab views must be hidden). The URL bar
 * floating in an empty split pane is the exception (`UrlbarState.pane`): it lies over the
 * chrome's own pane and the pages beside it stay live.
 */
export function overlayCoversContent(ui: UiState): boolean {
  return (
    ui.overlay !== 'none' ||
    (ui.urlbar.open && !ui.urlbar.pane) ||
    ui.drag !== null ||
    ui.drawerOpen ||
    ui.menu !== null ||
    ui.siteInfoOpen ||
    ui.externalProtocol !== null ||
    ui.voice !== null ||
    ui.qrScan !== null ||
    ui.extensionPrompts.length > 0 ||
    ui.extensionPopup !== null ||
    ui.floatingChrome > 0 ||
    ui.barEditorOpen ||
    ui.frameSheetOpen ||
    ui.tabsMenu !== null ||
    ui.blockedPopupsPanel !== null ||
    ui.securityPromptOpen ||
    ui.permissionPromptOpen ||
    ui.pageDialogOpen ||
    ui.screenPickerOpen ||
    ui.windowPromptOpen ||
    ui.downloadsOpen ||
    ui.defaultBrowserPrompt ||
    ui.install !== null ||
    ui.mediaSheet !== null ||
    ui.clearBrowsingDataOpen ||
    ui.printPreview !== null ||
    ui.autofillPrompt !== null ||
    ui.stageActive ||
    ui.zoomBubble !== null ||
    ui.readerPreferences !== null ||
    ui.hoverCard.tabId !== null ||
    ui.newTabShortcutDialog !== null ||
    ui.siteDataConfirm !== null ||
    // The star bubble and the bookmark editor are sheets over the page (design review of #38, item 1).
    bookmarkChromeOpen(ui)
  )
}

/**
 * Hold the content frame for a renderer-hosted popover: the page is captured, then the view is
 * hidden behind the capture until `release`. `ready` resolves once the capture is in place (false
 * when released first), so the popover can hold its first paint until the view no longer covers
 * it. On release the page gets keyboard focus back only if it had it (v2 draft §9.22): a popover
 * opened from a focused chrome control (`pageHadFocus` false) leaves focus in the chrome, on the
 * control it returned to.
 */
export function holdFloatingChrome(
  activeTabId: string | null,
  { pageHadFocus = true }: { pageHadFocus?: boolean } = {}
): {
  ready: Promise<boolean>
  release: () => void
} {
  let held = false
  let released = false
  const ready = captureActiveTab(activeTabId).then(() => {
    if (released) return false
    held = true
    uiStore.set((s) => ({ floatingChrome: s.floatingChrome + 1 }))
    return true
  })
  return {
    ready,
    release: () => {
      released = true
      if (!held) return
      held = false
      uiStore.set((s) => ({ floatingChrome: Math.max(0, s.floatingChrome - 1) }))
      invalidateSnapshot()
      if (pageHadFocus) returnFocusToPage()
    }
  }
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
// The site-information confirmation over the page (desktop)
// ---------------------------------------------------------------------------

/**
 * "Clear site data?" or "Clear cookies?" from the site-information popover: a frame dialog
 * (design language v2 §9.23, §9.5). The page is captured first and gives way to its picture
 * under the frame's scrim; the popover it came from closes as the dialog opens (§9.20).
 */
export async function openSiteDataConfirm(
  request: NonNullable<UiState['siteDataConfirm']>
): Promise<void> {
  await captureActiveTab(request.tabId)
  run('focus.chrome', undefined)
  uiStore.set({ siteDataConfirm: request })
}

export function closeSiteDataConfirm(): void {
  if (!uiStore.get().siteDataConfirm) return
  uiStore.set({ siteDataConfirm: null })
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

// ---------------------------------------------------------------------------
// Phone Extensions sheet
// ---------------------------------------------------------------------------

/**
 * Open the app menu's Extensions sheet (`extensions.open` from the core; the phone's entry to
 * the extensions' actions). The sheet is a frame-dialog sheet on the chassis, which captures
 * the page and takes its cover itself as it comes up (`coverPageUnderSheet`), so nothing is
 * captured here; the flag holds the keyboard and the capture while it is up.
 */
export function openExtensionsSheet(): void {
  if (uiStore.get().extensionsSheetOpen) return
  uiStore.set({ extensionsSheetOpen: true, drawerOpen: false })
}

/** The sheet has left the screen (its own dismissal, a row that opened something, the back gesture). */
export function closeExtensionsSheet(): void {
  if (!uiStore.get().extensionsSheetOpen) return
  uiStore.set({ extensionsSheetOpen: false })
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
 * Clear browsing data (`siteControls/ClearBrowsingDataDialog`): a dialog through the frame dialog
 * host on a mouse, a sheet on a phone, over whatever is up – Settings, where its row lives, or
 * the page, whose snapshot then has to exist first for the scrim to dim.
 */
export async function openClearBrowsingData(activeTabId: string | null): Promise<void> {
  if (uiStore.get().clearBrowsingDataOpen) return
  if (uiStore.get().overlay === 'none') await captureActiveTab(activeTabId)
  run('focus.chrome', undefined)
  uiStore.set({ clearBrowsingDataOpen: true })
}

export function closeClearBrowsingData(): void {
  if (!uiStore.get().clearBrowsingDataOpen) return
  uiStore.set({ clearBrowsingDataOpen: false })
  invalidateSnapshot()
  returnFocusToPage()
}

/**
 * The print preview (`print/PrintPreviewDialog`, the `overlay.open` event with kind `print`
 * from `core/print.ts`): a dialog through the frame dialog host over the page it prints, whose
 * snapshot has to exist first for the scrim to dim. Ctrl+P on an open preview leaves it as it
 * is, as Chrome's does.
 */
export async function openPrintPreview(tabId: string): Promise<void> {
  if (uiStore.get().printPreview) return
  await captureActiveTab(tabId)
  run('focus.chrome', undefined)
  uiStore.set({ printPreview: { tabId } })
}

/** The preview closed – Cancel, Escape, the scrim, a finished Print or Save, the tab going. */
export function closePrintPreview(): void {
  const open = uiStore.get().printPreview
  if (!open) return
  uiStore.set({ printPreview: null })
  run('print.close', { tabId: open.tabId })
  invalidateSnapshot()
  returnFocusToPage()
}

/**
 * Only anchored panels or a security prompt are up: a bar panel, the star bubble, the zoom
 * bubble, the tab hover card, the downloads bubble, site information, a permission prompt, the
 * blocked pop-ups popover, an autofill prompt in its popover form, or a sign-in or certificate
 * dialog. The page behind them is captured all the same (they overlap the live view), but panels
 * and popovers draw no scrim (v2 §9.5, §9.20), so the capture shows undimmed; dialogs dim it. A
 * chassis sheet's scrim is its own one dim (§11.5), so the same holds under the site-information
 * sheet and the prompt sheet on a phone, and the security prompt's dim is the frame dialog host's
 * scrim alone (v2 §9.5, §11.5: one dim layer). The chrome layer's popovers and menus (the
 * translate selection popover, a menulist's list) count in `floatingChrome` and are the
 * extensions' counterpart's case
 * (`extensionChromeAloneOverContent`); a menulist's list opened from inside one of these panels
 * (the reader popover's font or theme menu, site information's) is floating chrome over a panel,
 * still no dialog, so `floatingChrome` is left out of the reduced check too and the page under
 * both stays undimmed.
 */
export function panelAloneOverContent(ui: UiState): boolean {
  const popover = ui.autofillPrompt === 'popover'
  return (
    (ui.barMenuOpen ||
      ui.starDialog !== null ||
      ui.zoomBubble !== null ||
      ui.readerPreferences !== null ||
      ui.hoverCard.tabId !== null ||
      ui.downloadsOpen ||
      // Site information and the permission prompt are popovers on a mouse (no scrim, §9.5) and
      // chassis sheets on a phone, whose own scrim is the one dim over the page (§11.5).
      ui.siteInfoOpen ||
      ui.permissionPromptOpen ||
      ui.blockedPopupsPanel !== null ||
      ui.securityPromptOpen ||
      popover) &&
    !overlayCoversContent({
      ...ui,
      barMenuOpen: false,
      starDialog: null,
      zoomBubble: null,
      readerPreferences: null,
      hoverCard: HOVER_CARD_HIDDEN,
      downloadsOpen: false,
      siteInfoOpen: false,
      permissionPromptOpen: false,
      blockedPopupsPanel: null,
      securityPromptOpen: false,
      floatingChrome: 0,
      autofillPrompt: popover ? null : ui.autofillPrompt
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

// ---------------------------------------------------------------------------
// Reader View's text preferences over the page
// ---------------------------------------------------------------------------

/**
 * "Text Preferences…" for a reader tab (the pill's chip, the app menu, the page's toolbar): the
 * surface comes up over a picture of the page, as the zoom bubble does, and the keyboard goes
 * into it. `anchor` is the chip it hangs from on a mouse; without one the popover hangs under
 * the frame's top edge. A second request for the tab whose surface is up puts it away (the
 * chip's toggle).
 */
export async function openReaderPreferences(
  tabId: string,
  anchor: DOMRect | Rect | null = null
): Promise<void> {
  const open = uiStore.get().readerPreferences
  if (open && open.tabId === tabId) return
  await captureActiveTab(tabId)
  run('focus.chrome', undefined)
  uiStore.set({
    readerPreferences: {
      tabId,
      anchor: anchor
        ? { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height }
        : null
    }
  })
}

/**
 * Put the surface away. Focus goes back to the page unless the caller keeps it in the chrome
 * (`keepFocus`: Escape hands it to the chip the popover hung from, §9.22).
 */
export function closeReaderPreferences(opts: { keepFocus?: boolean } = {}): void {
  if (!uiStore.get().readerPreferences) return
  uiStore.set({ readerPreferences: null })
  invalidateSnapshot()
  if (!opts.keepFocus) returnFocusToPage()
}

/**
 * A preference changed while the surface is up: the reader page has taken it, so its picture
 * is taken again after the page's next paint (the push and the repaint are asynchronous; the
 * wait covers a frame or two on a phone's WebView).
 */
export function readerPreferencesChanged(tabId: string): void {
  window.setTimeout(() => {
    if (uiStore.get().readerPreferences?.tabId !== tabId) return
    void refreshSnapshot(tabId)
  }, READER_REPAINT_MS)
}

const READER_REPAINT_MS = 160

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
