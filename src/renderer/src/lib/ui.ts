import type { LucideIcon } from 'lucide-react'
import type { PageViewport } from '@shared/capture'
import { isDockedInFrame } from '@shared/devtoolsDock'
import type { QrCodeRequest } from '@shared/qrScan'
import {
  INTERNAL_PAGES,
  pageForOverlayKind,
  pageOpensAsTab,
  type InternalPageId,
  type InternalPageQuery
} from '@shared/internalPages'
import type {
  BookmarkNodeType,
  ContentCover,
  ExtensionPromptRequest,
  ExternalProtocolRequest,
  LongCapture,
  LongCaptureCrop,
  MenuDescriptor,
  MenuItemDescriptor,
  NavigationDirection,
  OverlayKind,
  Rect,
  ScreenshotSaved,
  SharePanelAction,
  SharePanelRequest,
  UIState,
  UrlbarOpenMode,
  WebAppBanner,
  WebAppInstallPrompt
} from '@shared/types'
import { isEmptyTabUrl } from '@shared/url'
import { isInstallable } from '@shared/webApp'
import { TOAST_DURATION } from './motion/tokens'
import { isZoomed } from '@renderer/components/zoom/bubble'
import type { Anchor } from './anchor'
import type { PopoverAlignment } from './portals'
import { cmd, run } from './api'
import { browserStore } from './browserStore'
import { devtoolsDockOf } from './contentRadius'
import { isPhone, isTouchLayout, viewportStore, type FormFactor } from './formFactor'
import { afterKeyRelease } from './keyRelease'
import { onboardingCovers } from './onboarding'
import { searchChoiceCovers } from './searchChoice'
import { awaitingShow, coverStore, markCoverDrop } from './cover'
import { pageCovered, pageOffScreen, pageViewStore, type Hold } from './pageView'
import { crossReaderView } from './readerTransition'
import { activeTab } from './selectors'
import {
  QR_CODE_SEAM_GUARD_MS,
  SHARE_SEAM_GUARD_MS,
  shareSeamStep,
  type QrCodeSeam,
  type ShareSeam
} from './shareSeam'
import { createStore } from './store'
import { rememberThumbnail, thumbnailOf } from './thumbnails'

// The browser state mirrored from the main process lives in `browserStore.ts` (the layout reads
// it too); it is still reached from here.
export { browserStore, startBrowserSync, useBrowser } from './browserStore'

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
  /**
   * The bar re-opened over `tabId` with the draft the tab was left with (`UiState.urlbarDrafts`,
   * W8-F15): the field takes the draft's text as `initialText`, its selection and its keyword
   * chip, as Chrome's `OmniboxEditModel::RestoreState` and `OmniboxViewViews::OnTabChanged` put
   * the omnibox back the way the tab was left. `typed` is set with it: the text is user input in
   * progress, not the page's.
   */
  draft?: UrlbarTabDraft
}

/**
 * The keyword chip the bar's field is in (tab-to-search after `@ddg` or an engine's name,
 * omnibox-08 / -26): the engine by id and the text Backspace on the empty field brings back.
 * Saved with a tab's draft as Chrome's `OmniboxEditModel::State` carries `keyword_` and its
 * entry method (`GetStateForTabSwitch`).
 */
export interface UrlbarDraftKeyword {
  engineId: string
  typed: string
}

/**
 * The bar's field as it stands: its text as shown – an inline completion included, as Chrome's
 * `GetStateForTabSwitch` takes the display text ("switching tabs 'accepts' the temporary text
 * as the user text", `chrome/browser/ui/omnibox/omnibox_edit_model.cc`) – its selection with its
 * direction (`OmniboxViewViews::SaveStateToTab` keeps `GetSelectedRange()`), and the keyword chip
 * it is in. The mounted desktop bar lends it (`provideUrlbarField`); it is read at one moment
 * alone, when `urlbarFollowsActiveTab` leaves the tab the bar is bound to.
 */
export interface UrlbarFieldState {
  text: string
  selectionStart: number
  selectionEnd: number
  selectionDirection: 'forward' | 'backward' | 'none'
  keyword: UrlbarDraftKeyword | null
}

/**
 * A tab's draft – Chrome desktop's per-tab omnibox state, the second half of W8-F15's ruling
 * (keeping the tab but dropping its text on the same event was half the fix): the field as
 * `urlbarFollowsActiveTab` found it when it left the tab, and how the bar stood (`attached`).
 * Kept in `UiState.urlbarDrafts` by tab id – this window's renderer, in memory, never persisted
 * – from the leave until the tab is active again (the bar re-opens with the draft in place,
 * `openNewTabPageUrlbar`), the tab closes while away, or the tab is no longer an empty one
 * (navigated while away: what was typed was for a page that is gone) – `pruneUrlbarDrafts`.
 * A draft committed (a navigation) or dismissed (Escape) by the user while the bar is up never
 * reaches this store: only a leave writes it, and the bar's own close paths keep their rules
 * (`Urlbar.tsx`, `drafts`, under the same predicate). The desktop layout's alone
 * (`urlbarKeepsTabDrafts`): the phone and the tablet write none and read none back.
 */
export interface UrlbarTabDraft extends UrlbarFieldState {
  /** The bar was anchored to the top (`UrlbarState.attached`), not floating. */
  attached: boolean
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
  /**
   * Where the toast is seated (§9.33): `frame` for a toast drawn as a card on the content
   * frame's edge – every toast on a shell that shows the cards (the phone, the tablet, the
   * Android sidebar), and on the desktop's plain column a toast raised while a frame dialog
   * stood (`frameDialogsOpen`), which the dialog host's seat draws above the dialog and keeps
   * for the rest of its clock (lib/portals.tsx). Unset: the desktop sidebar's row.
   */
  seat?: 'frame'
}

/**
 * The preview card Take Screenshot leaves in the toast's slot (SH-07): the picture the host put
 * in the gallery, with the tab it is of (Capture more takes the whole page of that tab). It
 * lives by the toast's rules – one live card in the slot, §9.33's clock with an action, a
 * finger pauses it, a swipe or the close sends it off.
 */
export interface ScreenshotCard extends ScreenshotSaved {
  id: number
  tabId: string
  /** The editor's crop: the card offers no Capture more (the page was captured whole already). */
  long?: boolean
  leaving?: boolean
}

/**
 * The long-screenshot editor (SH-08): the sheet is up for `tabId`'s page with `capture`, the
 * page in its frame with the two handles; `busy` while Save or Share writes the crop. The sheet
 * mounts with the picture in hand (`openLongScreenshot` waits for the host's stitch first).
 */
export interface LongScreenshotEditor {
  id: number
  tabId: string
  capture: LongCapture
  busy: boolean
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
  /**
   * The box the rows live in: the sidebar's – the card sits flush against its inner edge (gap
   * 0) – or, with the tabs along the caption band (§9.37), the band's: the card hangs under it.
   */
  sidebar: Rect | null
  /** The rows' axis: `x` for the strip along the band (the card under it), the sidebar's otherwise. */
  axis?: 'x'
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

/** A term the core asked the chrome to define (the `define.show` event; CT-39's Define). */
export interface DefineRequest {
  tabId: string
  term: string
  /** The selection's box in CSS pixels of the page view; null when nothing anchors (the phone's toolbar). */
  rect: Rect | null
  /** Where the context menu's click landed (the same pixels), for a popover without a box. */
  at?: { x: number; y: number }
}

/**
 * The desktop's ambient install offer up (PWA-03, `lib/installOffer.ts`): the core's banner the
 * pill's "Install <app>?" popover opened for of its own accord. `retired` once the core has
 * taken the banner back (`webapp.bannerHide`) and the popover is leaving on its own.
 */
export interface InstallOffer {
  banner: WebAppBanner
  retired: boolean
}

export interface UiState {
  overlay: OverlayKind
  overlaySpaceId: string | null
  /** Folder the live-folder editor works on (null → create a new one). */
  overlayFolderId: string | null
  /** Settings section to open (e.g. `resources`), when the overlay was opened for one. */
  overlaySection: string | null
  /**
   * The control the overlay was opened from, when it hangs from one (§9.20: the Settings theme
   * row's Change… button places the picker under itself, end-aligned – #572's L8): its box and
   * the bar or column it stands in, plain data (`placedAnchor`, lib/anchor.ts), never the
   * element. Null for an overlay opened from a menu, a shortcut or the palette, which takes its
   * seat.
   */
  overlayAnchor: Omit<Anchor, 'element'> | null
  urlbar: UrlbarState
  /**
   * The drafts of tabs the New Tab palette was left from mid-typing, by tab id (W8-F15, Chrome's
   * per-tab omnibox state): written by `urlbarFollowsActiveTab` as it leaves a tab, taken back
   * into the field by `openNewTabPageUrlbar` when the tab is active again, pruned with the tabs.
   * In memory for this window alone; never persisted, never synced.
   */
  urlbarDrafts: Record<string, UrlbarTabDraft>
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
  /**
   * The picture of the developer toolbox docked in `snapshotTabId`'s box (§9.29), taken with
   * `snapshot` and laid under it – the whole box, the page's hole covered by the page's picture
   * – so a menu over a docked toolbox leaves the toolbox in view. Null with none docked there.
   */
  toolboxSnapshot: string | null
  /** At most one toast is live; a toast on its way out may still be alongside it. */
  toasts: Toast[]
  /** The screenshot preview card in the toast's slot (one live, one maybe on its way out). */
  screenshotCards: ScreenshotCard[]
  /** The long-screenshot editor sheet is up. */
  longScreenshot: LongScreenshotEditor | null
  /** Top message banners, newest first (it sits on top; the older ones are pushed down). */
  banners: Banner[]
  statusText: string
  drag: DragState | null
  /** The hidden sidebar (compact mode, fullscreen) is out over a picture of the page. */
  compactHover: boolean
  /** The hidden top toolbar (compact mode, fullscreen) is out over a picture of the page. */
  toolbarHover: boolean
  /**
   * The collapsed rail's flyout (tabs-03, `useRailFlyout`) is out over a picture of the page:
   * from the capture that stands in for the page until the fold back to the rail rests.
   */
  railFlyout: boolean
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
  /**
   * Chrome's "Change your password" leak warning (ID-31, `autofill/LeakWarning.tsx`) is up over
   * the page's picture: a frame dialog on a mouse, a sheet on a phone.
   */
  credentialLeakOpen: boolean
  /** A page's `alert` / `confirm` / `prompt` or "Leave site?" dialog is up (the page waits for it). */
  pageDialogOpen: boolean
  /**
   * The "Page unresponsive" prompt (tabs-45, `dialogs/UnresponsiveDialog.tsx`) is up over the
   * picture of a page whose renderer stopped answering: a frame dialog, so it dims.
   */
  unresponsivePromptOpen: boolean
  /**
   * "Hold ⌘Q to quit" (session-08) runs over a page whose renderer is hung, and the page's view
   * has given way to its picture for the hold (`lib/quitHoldCover.ts`; the chrome's twin of the
   * notice draws over the picture, no dim – the notice over a live page has no scrim either).
   */
  quitHoldCover: boolean
  /** A page's `getDisplayMedia` picker ("Choose what to share") is up (the page waits for it). */
  screenPickerOpen: boolean
  /**
   * A page's device chooser (`requestDevice()`: USB, serial, HID, Bluetooth) or the pairing
   * prompt over it is up (the page waits for it; `components/devices`).
   */
  deviceChooserOpen: boolean
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
   * The Memory Saver bubble (omnibox-40, Chrome's): a 320 popover under the pill's
   * site-information slot, opened by a click on the leaf the slot shows for a tab just woken
   * from sleep – "Memory Saver freed up N MB" and the Never unload this site row. Up for the
   * tab named; the leaf stays in the slot while it is (`lib/siteChips.ts`).
   */
  memorySaverBubble: { tabId: string } | null
  /**
   * Reader View's text preferences for a reader tab (CT-20): a popover under the pill's chip on
   * a mouse (`anchor` is the chip; null hangs it under the frame's top edge), the shared sheet
   * on a phone. Opened by the chip or the app menu's "Text Preferences…" (the reader document
   * carries no toolbar, v2 §10.1); the page beneath is a picture that is taken again after every
   * change. `anchor` and `bar` are what the desktop popover hangs from – the pill's chip, which
   * the reader tab never hides (§9.29), whether the chip or the menu asked – and the pill it
   * sits in (§9.20); both null when no chip is on screen (compact mode; the phone's sheet takes
   * none).
   */
  readerPreferences: {
    tabId: string
    anchor: Rect | null
    bar: Rect | null
  } | null
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
   * "Delete <folder>?" (the desktop sidebar's folder menu and editor bubble; TAB-16's desktop
   * half): a §9.23 frame dialog over the page, asked before a folder that holds tabs or saved
   * pages goes. `keyboard`: the folder's header had the keyboard, so Cancel hands it back there.
   */
  folderDeleteConfirm: { folderId: string; keyboard: boolean } | null
  /**
   * "Release <agent>'s groups?" (the folder menu's Release from <agent>…): a §9.23 frame dialog
   * over the page, asked before a disconnected agent's groups are handed back. `keyboard`: the
   * folder's header had the keyboard, so Cancel hands it back there.
   */
  agentReleaseConfirm: { claimId: string; folderId: string; keyboard: boolean } | null
  /**
   * "Delete search history?" (the desktop omnibox row menu's Delete Search History; §10.5's
   * bulk case, pr-434 ruling 3): a §9.23 destructive frame dialog over the open bar and the
   * page's picture, asked before every remembered search goes.
   */
  deleteSearchHistoryOpen: boolean
  /** A folder panel of the bookmarks bar hangs over the page. */
  barMenuOpen: boolean
  /** A permission prompt ("Allow example.com to use your camera?") is up over the page. */
  permissionPromptOpen: boolean
  /**
   * Phone layout: the quiet notification prompt (NOT-03) the pill's bell was tapped for, by
   * prompt id – its sheet is up while this names it; the bell alone stands for it otherwise.
   */
  quietPromptId: string | null
  /** The Delete browsing data dialog (or sheet) is up over the page or over Settings. */
  clearBrowsingDataOpen: boolean
  /** Chrome's Name window prompt (`windowName/NameWindowDialog`) is up over the page. */
  nameWindowOpen: boolean
  /**
   * Chrome's "Import bookmarks and settings" dialog is up over Settings (or the page); `source`
   * is the `ImportSource.id` it opens on (the first-run offer's pick), else the first browser.
   */
  importDialog: { source: string | null } | null
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
  /** The host's own share panel (Android below 14, SH-03) is up for a share (`components/share/SharePanelSheet.tsx`). */
  sharePanel: SharePanelRequest | null
  /**
   * The menu-to-panel seam (§9.38): the app menu holds its sheet for the panel's request
   * (`gathering`), then draws the panel in it (`hosting`); null otherwise (`lib/shareSeam.ts`).
   */
  shareSeam: ShareSeam | null
  /** Voice search: the listening sheet is up, for the search it will load (`lib/voiceSearch.ts`). */
  voice: VoicePrompt | null
  /** QR scanning: the scan sheet is up, for the payload it will load (`lib/qrScan.ts`). */
  qrScan: QrPrompt | null
  /** The QR code sheet is up with a link's code (SH-06; `lib/qrCode.ts`). */
  qrCode: QrCodePrompt | null
  /**
   * The panel-to-code seam (§9.38): the share panel holds its chassis for the code the host is
   * encoding (`encoding`), then draws the code sheet in it (`hosting`); null otherwise
   * (`lib/shareSeam.ts`).
   */
  qrCodeSeam: QrCodeSeam | null
  /** Phone layout: the sheet that rearranges the bar's controls is up. */
  barEditorOpen: boolean
  /** Phone layout: the app menu's Extensions sheet (one row per extension action) is up. */
  extensionsSheetOpen: boolean
  /**
   * Phone layout: the Send to your devices picker (`sendTab.open`, ID-27) is up for this tab –
   * one row per other device, a tap sends the tab's page to it.
   */
  sendTabSheet: { tabId: string } | null
  /**
   * Phone layout: a `FrameDialogHost` sheet holds the page under its cover, from before it
   * rises until it has left the screen (`coverPageUnderSheet`); the dialogs it hosts set their
   * own flags later and drop them sooner than the sheet's motion runs.
   */
  frameSheetOpen: boolean
  /** Phone layout: the Tabs button's quick menu is up, anchored to the button (window px). */
  tabsMenu: Rect | null
  /**
   * Phone layout: the Back (or Forward) button's hold has its history popup up, anchored to the
   * button (window px), listing the stack in `direction` (GN-08).
   */
  historyMenu: { anchor: Rect; direction: NavigationDirection } | null
  /** The downloads bubble (anchored under the toolbar button) is up. */
  downloadsOpen: boolean
  /** The default-browser promo (sheet or dialog) is up over a capture of the page. */
  defaultBrowserPrompt: boolean
  /**
   * The desktop's Web capture overlay (`components/capture/CaptureOverlay.tsx`) is up over the
   * page's picture for `tabId`: the §9.5 scrim with the marquee's cut-out, the toolbar, then the
   * result card. `viewport` is the page's geometry as the overlay opened (`page.viewport`), null
   * when the host had none – the marquee is off then and only the visible area and the full
   * page are offered. `seq` tells one opening from the next.
   */
  capture: { tabId: string; viewport: PageViewport | null; seq: number } | null
  /** "Add to Home screen": the install sheet (manifest) or the name-edit sheet, when open. */
  install: WebAppInstallPrompt | null
  /**
   * The desktop's install offer: the pill's popover up for the core's banner, with no prompt
   * asked for (`install` is the user's; the two never stand together – the prompt takes the
   * offer's place, `openInstallSheet`).
   */
  installOffer: InstallOffer | null
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
   * The term the core asked the chrome to define (CT-39's Define, from the mini menu or the
   * phone's selection toolbar): the definition popover (desktop) or sheet (phone) is up for it.
   * A request only, as `translateSelection`.
   */
  define: DefineRequest | null
  /**
   * The tab search popover (tabs-17, Ctrl+Shift+A) is up from the sidebar's top row. `keyboard`:
   * a chrome control had the focus when it opened, so the page does not take it back on close.
   * A request only, as `translateSelection`: the popover holds the capture and the keyboard
   * itself (`useFloatingChrome`). With `pick` it is the empty pane's picker instead
   * (`TabPickRequest`), hanging from the pane's button and holding no capture. With `from`
   * `'strip'` it was the horizontal strip's All tabs button (§9.37) that opened it, and the
   * popover hangs from that button, end-aligned under the band.
   */
  tabSearch: { keyboard: boolean; pick?: TabPickRequest; from?: 'strip' } | null
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
  /**
   * How many dialogs stand on the frame's dialog host right now (its registry, lib/portals.tsx
   * `FrameDialogHost frame`; a panel on its way out is not counted). What seats a toast on
   * the frame while one does (`Toast.seat`, §9.33): a toast a dialog's act raises has to rise
   * above the dialog with its Undo in reach, and the host's seat is where it does.
   */
  frameDialogsOpen: number
}

/** Where the content area is, in window coordinates (measured by the layout reporter). */
export const contentAreaStore = createStore<{ area: Rect | null }>({ area: null }, 'content-area')

/** Last pointer-down position – anchors renderer-hosted menus that come without coordinates. */
export const lastPointer = { x: 0, y: 0 }

/**
 * The chrome control the menu about to open hangs from – the toolbar's ⋯ for `app.menu` – set
 * by the opener (`openAppMenu`). The descriptor the core sends back carries a point alone (the
 * button's bottom start corner), and the tablet's popover menu anchors to the control's box
 * instead (v2 §9.20: flush under its bar, aligned by its half, the control lit while it is up,
 * its own press closing it). Read by the menu that shows next and matched against its point.
 */
export const menuAnchor: { element: HTMLElement | null } = { element: null }

export const uiStore = createStore<UiState>(
  {
    overlay: 'none',
    overlaySpaceId: null,
    overlayFolderId: null,
    overlaySection: null,
    overlayAnchor: null,
    urlbar: { open: false, mode: 'new-tab', tabId: null, initialText: undefined, attached: false },
    urlbarDrafts: {},
    findOpen: false,
    findTabId: null,
    findText: '',
    findRequest: null,
    zoomTabId: null,
    snapshot: null,
    snapshotTabId: null,
    toolboxSnapshot: null,
    toasts: [],
    screenshotCards: [],
    longScreenshot: null,
    banners: [],
    statusText: '',
    drag: null,
    compactHover: false,
    toolbarHover: false,
    railFlyout: false,
    renamingTabId: null,
    renamingFolderId: null,
    editingPinnedUrlTabId: null,
    iconPickerTabId: null,
    blockedPopupsPanel: null,
    securityPromptOpen: false,
    credentialLeakOpen: false,
    pageDialogOpen: false,
    unresponsivePromptOpen: false,
    quitHoldCover: false,
    screenPickerOpen: false,
    deviceChooserOpen: false,
    windowPromptOpen: false,
    starDialog: null,
    zoomBubble: null,
    memorySaverBubble: null,
    readerPreferences: null,
    bookmarkEdit: null,
    bookmarkAllTabs: null,
    newTabShortcutDialog: null,
    folderDeleteConfirm: null,
    agentReleaseConfirm: null,
    deleteSearchHistoryOpen: false,
    barMenuOpen: false,
    permissionPromptOpen: false,
    quietPromptId: null,
    clearBrowsingDataOpen: false,
    nameWindowOpen: false,
    importDialog: null,
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
    sharePanel: null,
    shareSeam: null,
    voice: null,
    qrScan: null,
    qrCode: null,
    qrCodeSeam: null,
    barEditorOpen: false,
    extensionsSheetOpen: false,
    sendTabSheet: null,
    frameSheetOpen: false,
    tabsMenu: null,
    historyMenu: null,
    downloadsOpen: false,
    defaultBrowserPrompt: false,
    capture: null,
    install: null,
    installOffer: null,
    mediaSheet: null,
    translateSelection: null,
    define: null,
    tabSearch: null,
    groupEditor: null,
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    barHidden: false,
    stageActive: false,
    hoverCard: HOVER_CARD_HIDDEN,
    extensionPopup: null,
    extensionPrompts: [],
    floatingChrome: 0,
    frameDialogCover: 0,
    frameDialogsOpen: 0
  },
  'ui'
)

// ---------------------------------------------------------------------------
// Messages: toasts at the bottom, banners at the top
// ---------------------------------------------------------------------------

/**
 * A plain toast is read in a glance (§9.33's 2.8 s, one number with the page-drawn twin:
 * `@shared/toastCard`, handed out by the motion tokens – `lib/motion/tokens.ts`, W8-M1 – and
 * re-exported here for the callers that read it from the store module); one with an action
 * needs time to be acted on.
 */
export { TOAST_DURATION }
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

/**
 * The surface that draws the core's banner claims so while mounted: the card in `banners` on
 * the phone and the tablet (`components/messages/MessageLayer`), the pill's "Install <app>?"
 * popover on the desktop (`components/install/InstallPopoverLayer`, the install banner's form
 * there – `lib/installOffer.ts`; the sidebar draws toasts alone). A banner raised with no claim
 * standing is undrawn – a card put in `banners` sits there unseen – and a caller that accounts
 * for a drawn card asks first (the install prompt's word to the core, `lib/installBanner.ts`
 * and `lib/installOffer.ts`).
 */
const bannerSurfaces = new Set<symbol>()

/** Say that banners are drawn from now on; call the return value when the surface unmounts. */
export function claimBannerSurface(): () => void {
  const token = Symbol('banner surface')
  bannerSurfaces.add(token)
  return () => {
    bannerSurfaces.delete(token)
  }
}

/** Whether a surface that draws `banners` is mounted right now. */
export function bannerSurfaceMounted(): boolean {
  return bannerSurfaces.size > 0
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
 * The seat a toast pushed now takes (`Toast.seat`): the frame's card on a shell that shows the
 * cards, and on the desktop's plain column while a dialog stands on the frame's host – the
 * toast is the dialog's act's reply, and it rises above the dialog in the host's seat (§9.33;
 * lib/portals.tsx). The host's count, not its way out: a toast raised after a dialog closed
 * (one raised by an act that closed the last dialog, once it has left) is the column's, as it
 * always was.
 */
function toastSeatNow(): Toast['seat'] {
  return onCards() || uiStore.get().frameDialogsOpen > 0 ? 'frame' : undefined
}

/**
 * Show a toast. On the cards one toast is live at a time: a new one sends the current one off
 * (the two pass each other), except that the same message again just restarts its clock, so a
 * key held down does not stack a column of identical toasts. The plain desktop column takes
 * every toast as it always did. Returns the toast's id (the live one's when its clock was
 * restarted), for a caller that will dismiss it early.
 */
export function pushToast(
  message: string,
  kind: ToastKind = 'info',
  opts: ToastOptions = {}
): number {
  const duration = opts.duration ?? (opts.action ? TOAST_ACTION_DURATION : TOAST_DURATION)
  if (onCards()) {
    const live = uiStore.get().toasts.find((t) => !t.leaving)
    if (live && live.message === message && live.kind === kind && !opts.action && !live.action) {
      armClock(live.id, duration, () => dismissToast(live.id))
      return live.id
    }
    if (live) dismissToast(live.id)
    // The slot is one card's: a screenshot's preview gives way to the toast as a toast would.
    for (const card of uiStore.get().screenshotCards)
      if (!card.leaving) dismissScreenshotCard(card.id)
  }
  const id = ++messageSeq
  const toast: Toast = { id, message, kind, duration, action: opts.action, icon: opts.icon }
  const seat = toastSeatNow()
  if (seat) toast.seat = seat
  uiStore.set((s) => ({ toasts: [...s.toasts, toast] }))
  armClock(id, duration, () => dismissToast(id))
  return id
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

// ---------------------------------------------------------------------------
// Screenshots: the preview card in the toast's slot (SH-07), the long-screenshot editor (SH-08)
// ---------------------------------------------------------------------------

/**
 * Take Screenshot saved a picture to the gallery: its preview card takes the toast's slot (one
 * live card there – the toast up gives way, as it would to a newer toast) on the clock a toast
 * with an action keeps (§9.33's 5 s), paused under a finger. `long` for the editor's crop, whose
 * card offers no Capture more of its own.
 */
export function showScreenshotCard(
  saved: ScreenshotSaved & { tabId: string; long?: boolean }
): void {
  for (const toast of uiStore.get().toasts) if (!toast.leaving) dismissToast(toast.id)
  for (const card of uiStore.get().screenshotCards)
    if (!card.leaving) dismissScreenshotCard(card.id)
  const id = ++messageSeq
  const card: ScreenshotCard = { ...saved, id }
  uiStore.set((s) => ({ screenshotCards: [...s.screenshotCards, card] }))
  armClock(id, TOAST_ACTION_DURATION, () => dismissScreenshotCard(id))
}

/** Send the card on its way (it animates off and forgets itself); without the cards it just goes. */
export function dismissScreenshotCard(id: number): void {
  disarmClock(id)
  const card = uiStore.get().screenshotCards.find((c) => c.id === id)
  if (!card || card.leaving) return
  if (!onCards()) {
    forgetScreenshotCard(id)
    return
  }
  uiStore.set((s) => ({
    screenshotCards: s.screenshotCards.map((c) => (c.id === id ? { ...c, leaving: true } : c))
  }))
  setTimeout(() => forgetScreenshotCard(id), EXIT_SWEEP_MS)
}

export function forgetScreenshotCard(id: number): void {
  disarmClock(id)
  if (!uiStore.get().screenshotCards.some((c) => c.id === id)) return
  uiStore.set((s) => ({ screenshotCards: s.screenshotCards.filter((c) => c.id !== id) }))
}

export function holdScreenshotCard(id: number, held: boolean): void {
  holdMessage(id, held, () => dismissScreenshotCard(id))
}

/**
 * The card's actions. Share puts the picture on the OS's sheet and Delete takes it out of the
 * gallery; both send the card off. The thumbnail opens the picture in the system's viewer and
 * leaves the card up (the user comes back to it). Capture more opens the editor on the tab's
 * whole page and sends the card off – the editor's own card follows its crop.
 */
export function pickScreenshotAction(
  id: number,
  action: 'share' | 'delete' | 'open' | 'more'
): void {
  const card = uiStore.get().screenshotCards.find((c) => c.id === id)
  if (!card || card.leaving) return
  switch (action) {
    case 'open':
      run('screenshot.open', { uri: card.uri })
      return
    case 'share':
      dismissScreenshotCard(id)
      run('screenshot.share', { uri: card.uri })
      return
    case 'delete':
      dismissScreenshotCard(id)
      void cmd('screenshot.delete', { uri: card.uri }).then((gone) => {
        if (gone) pushToast('Screenshot deleted')
      })
      return
    case 'more':
      dismissScreenshotCard(id)
      openLongScreenshot(card.tabId)
  }
}

let longScreenshotSeq = 0
/** The capture on its way for the editor, if one is (`openLongScreenshot`); the newest wins. */
let longScreenshotPending: number | null = null

/**
 * Open the long-screenshot editor on `tabId`'s page (SH-08): the host stitches the page first
 * (Chrome's ~10 screens at most) and the sheet comes up with the picture. The order is the
 * chassis's: the host copies the page from the window, and on Android the chrome lies under the
 * pages, so a sheet over the page has the page hidden – a sheet up while the page was being
 * stitched would have the host copy the sheet, or nothing (`PageCapture.kt`). Until the picture
 * is in, the page is what shows (it scrolls through its screens as the host copies them); a page
 * that could not be captured says so in a toast and no editor opens.
 */
export function openLongScreenshot(tabId: string): void {
  const id = ++longScreenshotSeq
  longScreenshotPending = id
  void cmd('screenshot.captureLong', { tabId })
    .catch(() => null)
    .then((capture) => {
      if (longScreenshotPending !== id) {
        // A newer request took over while the page was being stitched: the host's copy is not wanted.
        if (capture) run('screenshot.discardLong', { id: capture.id })
        return
      }
      longScreenshotPending = null
      if (!capture) {
        pushToast('Could not capture the page', 'error')
        return
      }
      const editor = uiStore.get().longScreenshot
      if (editor) run('screenshot.discardLong', { id: editor.capture.id })
      uiStore.set({ longScreenshot: { id, tabId, capture, busy: false } })
    })
}

/** Whether a long capture is on its way to the editor (tests and the preview host). */
export function longScreenshotCapturing(): boolean {
  return longScreenshotPending !== null
}

/** The editor went without a save: the host drops the page it holds. A capture still on its way is not wanted either. */
export function closeLongScreenshot(): void {
  longScreenshotPending = null
  const editor = uiStore.get().longScreenshot
  if (!editor) return
  run('screenshot.discardLong', { id: editor.capture.id })
  uiStore.set({ longScreenshot: null })
}

/**
 * Save the crop to the gallery (and put it on the OS's sheet, for Share): the editor goes and
 * the picture's card follows. A failed write leaves the editor up (the core toasts it).
 */
export async function saveLongScreenshot(crop: LongCaptureCrop, share: boolean): Promise<void> {
  const editor = uiStore.get().longScreenshot
  if (!editor || editor.busy) return
  uiStore.set({ longScreenshot: { ...editor, busy: true } })
  const saved = await cmd('screenshot.saveLong', { id: editor.capture.id, crop, share }).catch(
    () => null
  )
  const current = uiStore.get().longScreenshot
  if (!current || current.id !== editor.id) return
  if (!saved) {
    uiStore.set({ longScreenshot: { ...current, busy: false } })
    return
  }
  uiStore.set({ longScreenshot: null })
  showScreenshotCard({ ...saved, tabId: editor.tabId, long: true })
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

/**
 * Capture the active tab before a chrome overlay hides it. `fresh` captures a page whose view is
 * hidden already – a tab activated under chrome that keeps the page under its picture (the
 * rail's flyout), which would otherwise show only what it looked like the last time it was seen.
 */
export async function captureActiveTab(
  tabId: string | null,
  { fresh = false }: { fresh?: boolean } = {}
): Promise<void> {
  if (!tabId) {
    uiStore.set({ snapshot: null, snapshotTabId: null, toolboxSnapshot: null })
    return
  }
  if (snapshotHeld(tabId)) return
  const pending = captures.get(tabId)
  if (pending) return pending
  const capture = (async (): Promise<void> => {
    const args = fresh ? { tabId, fresh } : { tabId }
    // A toolbox docked in the tab's box (§9.29) is pictured with the page, the two asked for
    // together so the cover swaps in whole; the picture goes under the page's in `ContentArea`.
    const [data, toolbox] = await Promise.all([
      cmd('overlay.snapshot', args).catch(() => null),
      toolboxDockedIn(tabId) ? cmd('overlay.snapshotDevtools', args).catch(() => null) : null
    ])
    if (data) rememberThumbnail(tabId, data)
    // A page that is already hidden (behind the gesture stage) cannot be captured: show what it
    // looked like the last time it was.
    uiStore.set({
      snapshot: data ?? thumbnailOf(tabId),
      snapshotTabId: tabId,
      toolboxSnapshot: toolbox
    })
  })().finally(() => {
    captures.delete(tabId)
  })
  captures.set(tabId, capture)
  return capture
}

/** Whether `tabId`'s developer toolbox stands docked in its frame box (§9.29), by the tab's own reading. */
function toolboxDockedIn(tabId: string): boolean {
  const state = browserStore.get().state
  if (!state) return false
  const dock = devtoolsDockOf(state, tabId)
  return dock !== null && isDockedInFrame(dock)
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

/**
 * The page tab a request for the overlay `kind` opens instead, where the page is a tab
 * (`pageForOverlayKind`, `pageOpensAsTab`: the host has page tabs and this layout is one of the
 * page's): Settings with Shortcuts and Sync, its sections, on every such host; History, the
 * bookmarks manager and Downloads on the desktop and the tablet, whose phone panels and sheets
 * stay overlays. Null where `kind` is an overlay here. The overlay's `section` and `folderId`
 * become the page's: a Settings section, the manager's `folder` (`InternalPageQuery`).
 */
function pageForOverlay(
  kind: OverlayKind,
  folderId: string | null = null,
  section: string | null = null
): { id: InternalPageId; section: string | null; query?: InternalPageQuery } | null {
  const ref = pageForOverlayKind(kind)
  const state = browserStore.get().state
  if (!ref || !state) return null
  const page = INTERNAL_PAGES[ref.id as InternalPageId]
  if (!pageOpensAsTab(page, state.capabilities, viewportStore.get().formFactor)) return null
  return {
    id: page.id as InternalPageId,
    section: ref.section ?? section,
    query: page.id === 'bookmarks' && folderId ? { folder: folderId } : undefined
  }
}

/**
 * Whether `kind` opens as an overlay on this host and layout at all: false where it is a page's
 * overlay and the page is a tab here (`page.open`, `lib/pages.ts`), so nothing draws the
 * overlay over a page tab's host; the phone keeps its History, Bookmarks and Downloads panels.
 */
export function overlayAvailable(kind: OverlayKind): boolean {
  return pageForOverlay(kind) === null
}

export async function openOverlay(
  kind: OverlayKind,
  activeTabId: string | null,
  spaceId: string | null = null,
  folderId: string | null = null,
  section: string | null = null,
  {
    handedBack = false,
    anchor = null
  }: {
    /**
     * The overlay is a page tab's the class change closed, going back to its tab as the window
     * widens (`useStageContinuity`): the core re-opens it at the slot the tab had.
     */
    handedBack?: boolean
    /** The control the overlay hangs from, if one (`UiState.overlayAnchor`). */
    anchor?: Omit<Anchor, 'element'> | null
  } = {}
): Promise<void> {
  const page = pageForOverlay(kind, folderId, section)
  if (page) {
    // The page's tab, through the core's one route (a Settings section for Shortcuts / Sync).
    run('page.open', handedBack ? { ...page, handedBack } : page)
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
    overlaySection: section,
    overlayAnchor: anchor
  })
}

export function closeOverlay(): void {
  uiStore.set({
    overlay: 'none',
    overlaySpaceId: null,
    overlayFolderId: null,
    overlaySection: null,
    overlayAnchor: null
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
    !shareChooserUp() &&
    !ui.voice &&
    !ui.qrScan &&
    !ui.qrCode &&
    !ui.longScreenshot &&
    ui.extensionPrompts.length === 0 &&
    !ui.extensionPopup &&
    ui.floatingChrome === 0 &&
    !ui.barEditorOpen &&
    !ui.extensionsSheetOpen &&
    !ui.sendTabSheet &&
    !ui.tabsMenu &&
    !ui.historyMenu &&
    !ui.blockedPopupsPanel &&
    !ui.securityPromptOpen &&
    !ui.credentialLeakOpen &&
    !ui.permissionPromptOpen &&
    !ui.pageDialogOpen &&
    !ui.unresponsivePromptOpen &&
    !ui.screenPickerOpen &&
    !ui.deviceChooserOpen &&
    !ui.windowPromptOpen &&
    !ui.downloadsOpen &&
    !ui.defaultBrowserPrompt &&
    !ui.capture &&
    !ui.install &&
    !ui.installOffer &&
    !ui.clearBrowsingDataOpen &&
    !ui.nameWindowOpen &&
    !ui.importDialog &&
    !ui.printPreview &&
    !ui.autofillPrompt &&
    !ui.autofillEdit &&
    !ui.autofillPassphrase &&
    !ui.stageActive &&
    !ui.zoomBubble &&
    !ui.memorySaverBubble &&
    !ui.readerPreferences &&
    !ui.newTabShortcutDialog &&
    !ui.folderDeleteConfirm &&
    !ui.agentReleaseConfirm &&
    !ui.deleteSearchHistoryOpen &&
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
 * drawn the live page back in its place (`lib/pageView.ts`) and – on a host that answers
 * placements (Q1, `lib/cover.ts` `awaitingShow`) – answered the placement that brought it
 * back, so the frame between shows the page's picture and not the window behind it; the drop
 * then follows on its own, on the chrome's next frame after the host's word.
 */
export function invalidateSnapshot(): void {
  const ui = uiStore.get()
  if (
    ui.overlay === 'none' &&
    !ui.urlbar.open &&
    !ui.drag &&
    !ui.compactHover &&
    !ui.toolbarHover &&
    !ui.railFlyout &&
    !ui.drawerOpen &&
    !ui.menu &&
    !ui.siteInfoOpen &&
    !ui.externalProtocol &&
    !shareChooserUp() &&
    !ui.voice &&
    !ui.qrScan &&
    !ui.qrCode &&
    !ui.longScreenshot &&
    ui.extensionPrompts.length === 0 &&
    !ui.extensionPopup &&
    ui.floatingChrome === 0 &&
    !ui.barEditorOpen &&
    !ui.extensionsSheetOpen &&
    !ui.sendTabSheet &&
    !ui.frameSheetOpen &&
    !ui.tabsMenu &&
    !ui.historyMenu &&
    !ui.blockedPopupsPanel &&
    !ui.securityPromptOpen &&
    !ui.credentialLeakOpen &&
    !ui.permissionPromptOpen &&
    !ui.pageDialogOpen &&
    !ui.unresponsivePromptOpen &&
    !ui.quitHoldCover &&
    !ui.screenPickerOpen &&
    !ui.deviceChooserOpen &&
    !ui.windowPromptOpen &&
    !ui.downloadsOpen &&
    !ui.defaultBrowserPrompt &&
    !ui.capture &&
    !ui.install &&
    !ui.installOffer &&
    !ui.clearBrowsingDataOpen &&
    !ui.nameWindowOpen &&
    !ui.importDialog &&
    !ui.printPreview &&
    !ui.autofillPrompt &&
    !ui.stageActive &&
    !ui.zoomBubble &&
    !ui.memorySaverBubble &&
    !ui.readerPreferences &&
    ui.hoverCard.tabId === null &&
    !ui.newTabShortcutDialog &&
    !ui.folderDeleteConfirm &&
    !ui.agentReleaseConfirm &&
    !ui.deleteSearchHistoryOpen &&
    !bookmarkChromeOpen(ui) &&
    ui.frameDialogCover === 0
  ) {
    if (
      ui.snapshotTabId &&
      (pageOffScreen(pageViewStore.get(), ui.snapshotTabId) ||
        awaitingShow(coverStore.get(), ui.snapshotTabId))
    ) {
      snapshotStale = true
      return
    }
    snapshotStale = false
    if (ui.snapshotTabId && ui.snapshot) markCoverDrop(ui.snapshotTabId)
    uiStore.set({ snapshot: null, snapshotTabId: null, toolboxSnapshot: null })
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
  // The host's answer to the landing (Q1): the stale picture goes on it as on the drawn frame.
  coverStore.subscribe(() => {
    if (snapshotStale) invalidateSnapshot()
  })
}

/**
 * Whether the page views are hidden under the chrome right now – what `useLayoutReporter`
 * reports as `contentHidden`: a chrome overlay covers the content, a compact sidebar or the
 * toolbar is revealed over it, the collapsed rail's flyout is out over it (`useRailFlyout`), or
 * a frame dialog host keeps the page under its picture for a panel's way out
 * (`holdFrameDialogCover`).
 */
export function pageHidden(ui: UiState): boolean {
  return (
    overlayCoversContent(ui) ||
    ui.compactHover ||
    ui.toolbarHover ||
    ui.railFlyout ||
    ui.frameDialogCover > 0
  )
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
 * The install prompt – the phone's "Add to Home screen" sheet, the desktop's "Install <app>?"
 * popover under the pill's Install chip or its "Create shortcut" dialog (`InstallLayer`,
 * `InstallPopoverLayer`; the host's chrome mounts the one that is its surface) – stands over
 * the page's picture like a menu: the snapshot comes first. The desktop's offer popover, if up,
 * gives way to the prompt (the core took the offer's banner back as the install opened).
 */
export async function openInstallSheet(prompt: WebAppInstallPrompt): Promise<void> {
  await captureActiveTab(prompt.tabId)
  run('focus.chrome', undefined)
  uiStore.set({ install: prompt, installOffer: null, drawerOpen: false })
}

/**
 * Whether the install prompt takes the pill's popover: the desktop's form for an app with an
 * installable manifest (Chrome's, the Design Lead's ruling on W8-M3's item 3;
 * `install/InstallPopover.tsx`), a popover with no scrim, where a page without one takes the
 * "Create shortcut" frame dialog and the phone its sheet, each with a scrim of its own.
 */
export function installPromptIsPopover(prompt: WebAppInstallPrompt): boolean {
  return prompt.surface === 'desktop' && prompt.info !== null && isInstallable(prompt.info)
}

/**
 * Whether the pill's "Install <app>?" popover is up: for the core's offer (`installOffer`), or
 * for the prompt in its popover form (`installPromptIsPopover`). The one reading the popover's
 * layer and the content's dim share, so the page under the popover stays undimmed as under
 * every other popover (§9.5, §9.20).
 */
export function installPopoverUp(ui: Pick<UiState, 'install' | 'installOffer'>): boolean {
  return ui.installOffer !== null || (ui.install !== null && installPromptIsPopover(ui.install))
}

/**
 * The prompt's surface has left. Focus goes back to the page unless the caller keeps it in the
 * chrome (`keepFocus`: Escape on the desktop popover hands it to the chip it hung from, §9.22).
 */
export function closeInstallSheet(tabId: string, opts: { keepFocus?: boolean } = {}): void {
  if (uiStore.get().install?.tabId !== tabId) return
  uiStore.set({ install: null })
  invalidateSnapshot()
  if (!opts.keepFocus) returnFocusToPage()
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

/**
 * The first-run tour covers this window's chrome (lib/onboarding.ts `onboardingCovers`): the
 * URL bar and the new tab shortcut dialog do not open under it. The bar opened under the tour
 * used to focus its field once, on mount, and the tour's buttons took the keyboard from it: the
 * bar stood there after the tour with no caret. The tour's last click ends in a new tab whose
 * `newtab.opened` arrives after the state that puts the tour away, and that one opens the bar.
 * The phone's tour is its shell's own flow over its own bar, and is left as it is. The EEA's
 * search-engine choice screen standing on its own after the tour (W6-2, `searchChoiceCovers`)
 * holds the bar the same way; the core announces the fresh tab again once it is answered.
 */
export function onboardingUp(): boolean {
  const state = browserStore.get().state
  return state !== null && firstRunCovers(state)
}

/**
 * The first-run tour or the EEA's search-engine choice screen (W6-2, `searchChoiceCovers`)
 * stands over this window's whole chrome (`onboardingCovers`; not the phone's tour, which is
 * its shell's own flow over a first run that has no page to hide – the phone's choice screen
 * standing on its own after the tour (OMN-26, `PhoneSearchChoiceScreen`) counts, since it may
 * stand over a live page). What `onboardingUp` reads of the state, and one of the terms of the
 * layout report's `contentHidden` (`useLayoutReporter`): the pages' views composite ABOVE the
 * chrome, so a page left showing under the tour stands over it – the New Tab's view over the
 * tour's panel, since the window has had a tab from creation (#490) and the bar that used to
 * open under the tour, and hid the page under its cover, waits for the tour's end (#347).
 * Nothing is captured for these: the panel is opaque over the window, there is no picture to
 * wait for, and the views hide at once (`decideHidden`, nothing to wait for).
 */
export function firstRunCovers(
  state: Pick<UIState, 'settings' | 'window' | 'searchChoice'>
): boolean {
  return (!isPhone() && onboardingCovers(state)) || searchChoiceCovers(state)
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
 * Whether the core's `newtab.opened` opens the bar here. Without `text` it announces a new tab's
 * arrival (the boot's first tab, Ctrl+T, the sidebar's New Tab row – `Browser.revealFreshTab`,
 * `NewTabService.open`): the desktop's reveal is the bar in new-tab mode over the page. On the
 * touch layouts the served page comes up bare instead (NTP-35, Chrome's tablet new tab): the page
 * in view, its own field at rest, no bar over a cover and no keyboard rising unasked. Its bar
 * opens on the user's tap on the page's field – the page's `search` action, whose `text` is a
 * string ('' for the tap) – or on what the page's field received. The phone's chrome draws its
 * own page and never sends the announcement (`bootFirstTab.test.ts`).
 */
export function newTabRevealOpensUrlbar(text: string | undefined): boolean {
  return text !== undefined || !isTouchLayout()
}

/**
 * The URL bar over a new tab page: `new-tab` mode bound to that tab, so what is typed navigates
 * it instead of creating another. `text` is what the page's search box already received.
 *
 * A draft the tab was left with (`urlbarDrafts`, W8-F15) comes back into the field here – its
 * text, selection and keyword chip, the bar `attached` as it stood – the way Chrome's
 * `RestoreState` puts the omnibox back on the tab's return; the store's copy is spent on the
 * open (the field holds it now; a later leave saves it afresh). Keys the page's own field
 * received while the bar was on its way up (`text`) are typed into the draft at its selection,
 * as keys that race an open bar are spliced in at the caret (`zen-urlbar-type`). On the desktop
 * layout alone (`urlbarKeepsTabDrafts`): a touch layout reads no draft back – one a desktop
 * window left before it was narrowed stays where it is, unspent, for the window widened again.
 */
export function openNewTabPageUrlbar(
  tabId: string,
  text: string | undefined,
  attached: boolean
): void {
  if (onboardingUp()) return
  const ui = uiStore.get()
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
    uiStore.set((s) => {
      const { [tabId]: spent, ...urlbarDrafts } = s.urlbarDrafts
      const left: UrlbarTabDraft | undefined = urlbarKeepsTabDrafts() ? spent : undefined
      const draft = left && mine.text ? typedInto(left, mine.text) : left
      return {
        urlbar: {
          open: true,
          mode: 'new-tab',
          tabId,
          initialText: draft?.text ?? (mine.text || undefined),
          typed: draft !== undefined || Boolean(mine.text),
          attached: draft?.attached ?? attached,
          ...(draft ? { draft } : {})
        },
        urlbarDrafts: left ? urlbarDrafts : s.urlbarDrafts,
        drawerOpen: false
      }
    })
  })
}

/** `text` typed into the draft's field as it stands: it replaces the selection, the caret after it. */
function typedInto(draft: UrlbarTabDraft, text: string): UrlbarTabDraft {
  const start = Math.min(draft.selectionStart, draft.selectionEnd)
  const end = Math.max(draft.selectionStart, draft.selectionEnd)
  const value = draft.text.slice(0, start) + text + draft.text.slice(end)
  const caret = start + text.length
  return {
    ...draft,
    text: value,
    selectionStart: caret,
    selectionEnd: caret,
    selectionDirection: 'none'
  }
}

export interface UrlbarCloseOptions {
  keepKeyboard?: boolean
  /**
   * `dismiss`: the user put the bar away without submitting (Escape, the scrim, the back
   * gesture). A close without a reason follows a submit, a navigation or another surface taking
   * over. The phone new tab page's field morph runs the field back only on a dismissal.
   */
  reason?: 'dismiss'
}

const closeInterceptors: Array<(opts: UrlbarCloseOptions) => boolean> = []

/**
 * A surface that owns the bar's departure – the new tab page's field morph (lib/fakeboxMorph.ts),
 * which runs the omnibox's field back into the page and closes the bar itself once it has
 * landed; the pill's focus motion (lib/omniboxFocus.ts), which runs the field back into the pill
 * – takes a close over: `fn` returns true to hold the close (and calls `closeUrlbar` again when
 * it is done), false to let it happen now. Each is asked in turn until one holds; which one owns
 * the bar is theirs to know (the others answer false). Returns the release.
 */
export function interceptUrlbarClose(fn: (opts: UrlbarCloseOptions) => boolean): () => void {
  closeInterceptors.push(fn)
  return () => {
    const at = closeInterceptors.indexOf(fn)
    if (at >= 0) closeInterceptors.splice(at, 1)
  }
}

/**
 * Close the URL bar. The keyboard goes back to the page unless `keepKeyboard`: a pane shortcut
 * (F6 from the bar, lib/panes.ts) has already put it on another chrome control, and asking for
 * the page's focus as well would take it back off that control.
 */
export function closeUrlbar(opts: UrlbarCloseOptions = {}): void {
  typeahead = null
  if (!uiStore.get().urlbar.open) return
  if (closeInterceptors.some((held) => held(opts))) return
  uiStore.set((s) => ({ urlbar: { ...s.urlbar, open: false } }))
  invalidateSnapshot()
  if (!opts.keepKeyboard) returnFocusToPage()
}

/**
 * Whether a fresh empty tab comes up here with the new tab page's palette – the core's own test
 * before it sends `newtab.opened` (`NewTabService.enabled`): the host serves the page and the
 * setting has it on. Off (the phone, whose chrome draws its own page; the setting off) a fresh
 * tab gets the bar through `urlbar.toggle` instead, bound to no tab.
 */
function newTabPaletteOn(state: UIState): boolean {
  return state.capabilities.newTabPage && state.settings.newTab.enabled
}

let urlbarField: (() => UrlbarFieldState | null) | null = null

/** The tab `urlbarFollowsActiveTab` last saw in front: a change is a tab's arrival. */
let followedTabId: string | null = null

/**
 * Whether the bar keeps a draft that outlives it – the ONE predicate for both ways a draft does
 * (W8-F15's form-factor gate; W8-F17 put the second way under it): the desktop layout's
 * behaviour alone.
 *
 *  - Across a tab switch (W8-F15): the per-tab draft in `UiState.urlbarDrafts`, saved as the
 *    palette leaves the tab and restored on the tab's return. Chrome desktop's omnibox carries
 *    its state per tab (`OmniboxViewViews::SaveStateToTab` on the leave, `OnTabChanged` →
 *    `RestoreState` on the return); Chrome for Android drops the edit when the switcher changes
 *    tabs.
 *  - Across a dismissal (W8-F17): the bar's own `drafts` (`Urlbar.tsx`) – what was typed, kept
 *    through Escape, an outside press or the back gesture and restored on the bar's next open
 *    over the same page. Chrome desktop keeps the edit; Chrome for Android drops it on Escape.
 *
 * So the phone and the tablet – both Chrome Android's – save nothing and read nothing back
 * either way (§9.34: the same `Urlbar`, two behaviours). The layout is the renderer's
 * (`viewportStore`), not the platform's: a window narrowed to the phone layout on a laptop keeps
 * none while it stays so. The bar's input signal to the core (`urlbar.input`, `Urlbar.tsx`) is
 * not gated: a tab being typed into is not a fresh one on any layout.
 */
export function urlbarKeepsTabDrafts(
  formFactor: FormFactor = viewportStore.get().formFactor
): boolean {
  return formFactor === 'desktop'
}

/**
 * The mounted desktop bar lends its field to `urlbarFollowsActiveTab`: `read` answers the field
 * as it stands – text as shown, selection, keyword chip – or null before the input is in the
 * tree. One bar at a time (the palette is one instance per tab it is bound to); the release
 * forgets it. The phone's and the tablet's bars lend nothing (`urlbarKeepsTabDrafts`); their
 * drafts are discarded on every dismissal besides (`Urlbar.tsx`, `drafts` – the same predicate).
 */
export function provideUrlbarField(read: () => UrlbarFieldState | null): () => void {
  urlbarField = read
  return () => {
    if (urlbarField === read) urlbarField = null
  }
}

/**
 * The leaving tab's draft, saved as the palette leaves it (W8-F15; Chrome's
 * `OmniboxViewViews::SaveStateToTab` → `GetStateForTabSwitch`): the field as it stands, when it
 * holds text at all – over an empty tab the page's own text is nothing, so any text is the
 * user's – and the tab is still an empty one (a palette over a page that took the tab is not
 * worth a return). A field left empty writes nothing: a tab left with no draft restores no bar,
 * as it never had one to come back to. A bare keyword chip with no text is let go with the bar,
 * as the bar's own input signal (`urlbar.input`) counts text alone. The desktop layout's alone
 * (`urlbarKeepsTabDrafts`): on the phone and the tablet the leave writes nothing, whatever the
 * field holds.
 */
function saveUrlbarDraft(tabId: string, attached: boolean, state: UIState): void {
  if (!urlbarKeepsTabDrafts()) return
  const tab = state.tabs[tabId]
  const field = urlbarField?.()
  if (!tab || !isEmptyTabUrl(tab.url) || !field || !field.text.trim()) return
  uiStore.set((s) => ({ urlbarDrafts: { ...s.urlbarDrafts, [tabId]: { ...field, attached } } }))
}

/**
 * Drafts whose tab is gone (closed while away) or is no longer an empty one (navigated while
 * away – an extension's `tabs.update`, a session restore) go with it: the draft was for a page
 * that is not there any more.
 */
function pruneUrlbarDrafts(state: UIState): void {
  const { urlbarDrafts } = uiStore.get()
  const stale = Object.keys(urlbarDrafts).filter((id) => {
    const tab = state.tabs[id]
    return !tab || !isEmptyTabUrl(tab.url)
  })
  if (stale.length === 0) return
  uiStore.set((s) => {
    const kept = { ...s.urlbarDrafts }
    for (const id of stale) delete kept[id]
    return { urlbarDrafts: kept }
  })
}

/**
 * The bar in new-tab mode bound to a tab – the palette over a fresh New Tab
 * (`openNewTabPageUrlbar`) – follows the window's active tab. Its cover hides every page view
 * (`overlayCoversContent`), so a tab made active under it by anything but a press on the chrome
 * (an extension's `chrome.tabs.create({ active: true })`, a `tab.create` over the bridge, Ctrl+Tab
 * from the bar, a page's `window.open`) stood behind the palette with no live view on screen
 * until a key put the bar away. Now, the moment the active tab is not the one the bar is bound
 * to, the bar closes – without a reason: not a dismissal, so the bar's own close paths keep
 * nothing and the phone's field morph would not run back; the keyboard goes to the page as after
 * a submit – or, when the tab now active is itself an empty New Tab whose palette is the one to
 * show (Ctrl+T over the palette, a tab an extension made without an address), the palette
 * re-binds to it through `openNewTabPageUrlbar`: the bar stays up over the new tab, and the
 * core's own `newtab.opened` for that tab – sent after the state that made it active
 * (`NewTabService.open`) – finds it bound already. The bar over a split's empty pane is the
 * pane's own field and goes with the pane (`Urlbar.tsx`, `paneLive`); the bar bound to no tab
 * (`openUrlbar` in new-tab mode) belongs to the window and stays as it is.
 *
 * What the leaving tab's field held goes with the tab (W8-F15, the second half of its ruling:
 * Chrome's omnibox keeps its state per tab – `OmniboxViewViews::SaveStateToTab` on the leave,
 * `OnTabChanged` → `RestoreState` on the return): the draft is saved to `urlbarDrafts` before
 * the bar closes or re-binds, and when a tab with a draft is active again – the bar down, or
 * the palette re-binding to it from another tab – the palette re-opens over it with the draft
 * in place, through `openNewTabPageUrlbar`. A tab left with nothing typed restores nothing. The
 * return is the tab's arrival in front (`OnTabChanged`), not any later state the window sends:
 * a draft whose tab is in front under another bar waits for the tab's next activation. The
 * desktop layout's alone, the save and the restore both (`urlbarKeepsTabDrafts`): the phone's
 * and the tablet's palette follows the active tab as W5-F4 had it, and nothing more.
 */
export function urlbarFollowsActiveTab(): void {
  const state = browserStore.get().state
  if (!state) return
  const { urlbar, urlbarDrafts } = uiStore.get()
  const palette = urlbar.open && urlbar.mode === 'new-tab' && urlbar.tabId !== null && !urlbar.pane
  // Nothing to follow and no draft to mind: most of the window's state goes by untouched.
  if (!palette && Object.keys(urlbarDrafts).length === 0) return
  pruneUrlbarDrafts(state)
  const active = activeTab(state)
  const arrived = active !== null && active.id !== followedTabId
  followedTabId = active?.id ?? null
  if (!urlbar.open) {
    // The bar is down and the tab that just came in front was left mid-draft: the bar comes
    // back over it with the draft in place – on the desktop layout; a touch layout opens no bar
    // for a draft it would not read back.
    const draft = active && arrived ? uiStore.get().urlbarDrafts[active.id] : undefined
    if (active && draft && urlbarKeepsTabDrafts() && newTabPaletteOn(state)) {
      openNewTabPageUrlbar(active.id, undefined, draft.attached)
    }
    return
  }
  if (!palette || !urlbar.tabId) return
  if (active?.id === urlbar.tabId) return
  saveUrlbarDraft(urlbar.tabId, urlbar.attached, state)
  if (active && isEmptyTabUrl(active.url) && newTabPaletteOn(state)) {
    openNewTabPageUrlbar(active.id, undefined, urlbar.attached)
    return
  }
  closeUrlbar()
}

const urlbarFlags = globalThis as unknown as { __zenUrlbarFollowsWired?: boolean }
if (!urlbarFlags.__zenUrlbarFollowsWired) {
  urlbarFlags.__zenUrlbarFollowsWired = true
  browserStore.subscribe(urlbarFollowsActiveTab)
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

/**
 * Put the sheet away. Focus goes back to the page unless the caller keeps it in the chrome
 * (`keepFocus`: the pill's zoom chip that closed it keeps the keyboard, §9.22).
 */
export function closeZoom(opts: { keepFocus?: boolean } = {}): void {
  if (!uiStore.get().zoomTabId) return
  uiStore.set({ zoomTabId: null })
  if (!opts.keepFocus) returnFocusToPage()
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

/**
 * A menu the renderer draws (`menu.show`): the page behind it is captured first – it overlaps
 * the live view, which composites above the chrome – then the chrome takes the keyboard, as for
 * every popover of its own (a menu opened by Alt+F while the page had the keyboard must hear
 * its arrows), and `MenuSheet` mounts over the picture. The picture stays undimmed under a
 * menu: a popover on a mouse, a sheet with its own scrim on touch (`panelAloneOverContent`).
 */
export async function showMenu(menu: MenuDescriptor, activeTabId: string | null): Promise<void> {
  await captureActiveTab(activeTabId)
  run('focus.chrome', undefined)
  uiStore.set({ menu })
}

/**
 * How long a capture taken on a press outlives it when no tap follows: longer than any
 * `app.menu` round trip, so a slow open still finds it; short enough that a finger lifted
 * elsewhere leaves no stale picture behind (the next open captures afresh).
 */
export const MENU_PRESS_CAPTURE_TTL_MS = 2000

/**
 * The finger landed on the menu button (`press`, the bar item): capture the page now, before the
 * tap and `app.menu`'s round trip through the core, so `showMenu` finds the picture in flight or
 * in place and the sheet mounts without waiting on the host's PixelCopy and encode – on the
 * profile's emulator 530 to 860 ms of the click → sheet time (PERF-2, PR #269), on a phone the
 * better part of the wait between the tap and the first frame that moves. `captureActiveTab`
 * shares one capture per tab, so the open joins this one rather than starting a second. A press
 * that never becomes the tap leaves a capture nothing needs: it is dropped after
 * `MENU_PRESS_CAPTURE_TTL_MS`, if nothing has come to need it by then (`invalidateSnapshot`).
 */
export function prepareMenu(activeTabId: string | null): void {
  if (!activeTabId) return
  void captureActiveTab(activeTabId).then(() => {
    setTimeout(() => invalidateSnapshot(), MENU_PRESS_CAPTURE_TTL_MS)
  })
}

/**
 * Close the open menu without a pick. `keepKeyboard`: the keyboard stays in the chrome – a menu
 * the keyboard opened is closing onto the control that opened it (§9.22, Escape's way back), so
 * the page does not take the focus; otherwise the page gets it back as after any overlay.
 */
export function closeMenu(notifyHost = true, { keepKeyboard = false } = {}): void {
  const menu = uiStore.get().menu
  if (!menu) return
  releaseShareSeam()
  uiStore.set({ menu: null })
  if (localMenus.delete(menu.id)) {
    // Nothing to tell the host about a menu it never knew.
  } else if (notifyHost) run('menu.close', { menuId: menu.id })
  invalidateSnapshot()
  if (!keepKeyboard) returnFocusToPage()
}

/** The descriptor item `itemId` names, at any depth of `items`; undefined when none. */
function menuItemById(items: MenuItemDescriptor[], itemId: string): MenuItemDescriptor | undefined {
  for (const item of items) {
    if (item.id === itemId) return item
    const inner = item.submenu ? menuItemById(item.submenu, itemId) : undefined
    if (inner) return inner
  }
  return undefined
}

/**
 * Pick an item of the open menu. The page gets the focus back as after any overlay – except for an
 * item that says it keeps the keyboard (`keepsKeyboard`: Rename Group…, Rename Tab…), whose action
 * mounts a field of the chrome's own: the host's focus move would land on the page while that
 * field is mounting and blur it away before the user could type (the tablet's rename, nightly
 * `tablet-groups` §6), so for it the focus stays where the field is about to take it.
 */
export function pickMenuItem(itemId: string): void {
  const ui = uiStore.get()
  const menu = ui.menu
  if (!menu) return
  const item = menuItemById(menu.items, itemId)
  const local = localMenus.get(menu.id)
  localMenus.delete(menu.id)
  // Run the action once the sheet has been unpainted: hosts that snapshot the window for the
  // dimmed overlay preview (Android's PixelCopy) would otherwise capture the menu itself.
  const later = (action: () => void): void => {
    requestAnimationFrame(() => requestAnimationFrame(action))
  }
  const click = (): void => {
    if (local) local.get(itemId)?.()
    else run('menu.click', { menuId: menu.id, itemId })
  }
  // The Reader View row (the app menu's, the page menu's): where the crossing runs (MOT-36,
  // `lib/readerTransition.ts`) it begins on the sheet's own picture of the page, in this turn –
  // before the menu's clearing lets the page back – and the core's toggle runs inside it;
  // elsewhere `crossReaderView` is the click itself.
  const browser = browserStore.get().state
  const activeTabId = browser ? (activeTab(browser)?.id ?? null) : null
  const readerRow = !local && item?.action === 'page.readerMode' && activeTabId !== null
  if (readerRow) {
    void crossReaderView(activeTabId, {
      cross: () => later(click),
      picture: ui.snapshotTabId === activeTabId ? ui.snapshot : null
    })
  }
  uiStore.set({ menu: null })
  invalidateSnapshot()
  if (!item?.keepsKeyboard) returnFocusToPage()
  if (!readerRow) later(click)
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
// The QR code sheet (SH-06; `lib/qrCode.ts` runs the request)
// ---------------------------------------------------------------------------

/** The code sheet's request: the host's `qr.code` with the sheet's own id (each share is a new sheet). */
export interface QrCodePrompt extends QrCodeRequest {
  id: number
}

/**
 * Put the code sheet up over a capture of the page, as the scan sheet goes up: the share sheet
 * it came from (Android 14's, the system's) has left; the omnibox closes if it is open, the
 * sheet taking the frame.
 */
export async function openQrCodeSheet(prompt: QrCodePrompt): Promise<void> {
  await captureActiveTab(prompt.tabId)
  run('focus.chrome', undefined)
  uiStore.set({ qrCode: prompt, drawerOpen: false })
  if (uiStore.get().urlbar.open) closeUrlbar()
}

/**
 * The share panel's QR code chip was picked (§9.38's hand-off, `lib/shareSeam.ts`): the panel
 * stands, its cells inert, while the host encodes the link – the host hears the pick at once
 * and lets the share go – and the code that comes back takes the panel's chassis
 * (`hostQrCodeSheet`). A guard lets the panel leave should no code come.
 */
export function beginQrCodeSeam(panelId: string): void {
  if (uiStore.get().sharePanel?.id !== panelId || uiStore.get().qrCodeSeam) return
  uiStore.set({ qrCodeSeam: { phase: 'encoding', panelId } })
  run('share.panelAction', { id: panelId, kind: 'qr' })
  window.setTimeout(() => {
    const { qrCodeSeam, sharePanel } = uiStore.get()
    if (qrCodeSeam?.phase !== 'encoding' || qrCodeSeam.panelId !== panelId) return
    if (sharePanel?.id === panelId) endSharePanel(panelId, null)
    else uiStore.set({ qrCodeSeam: null })
  }, QR_CODE_SEAM_GUARD_MS)
}

/** The panel whose chassis stands waiting for the code (`beginQrCodeSeam`), if one does. */
export function qrCodeSeamPanel(): string | null {
  const { qrCodeSeam, sharePanel } = uiStore.get()
  return qrCodeSeam?.phase === 'encoding' && sharePanel?.id === qrCodeSeam.panelId
    ? qrCodeSeam.panelId
    : null
}

/**
 * The code arrived for a panel that stands for it: the panel's chassis draws the code sheet –
 * the page is covered under it already, so no capture and no focus move (`MenuSheet.tsx`,
 * `SharePanelSheet.tsx` read the seam).
 */
export function hostQrCodeSheet(prompt: QrCodePrompt, panelId: string): void {
  uiStore.set({
    qrCode: prompt,
    qrCodeSeam: { phase: 'hosting', panelId, promptId: prompt.id },
    drawerOpen: false
  })
}

/**
 * The code sheet's request is over (Download, Close, the back gesture): take it down. A code
 * the panel's chassis was drawing takes the panel's request down with it – the host heard the
 * pick already (`beginQrCodeSeam`), so no answer goes – and the menu's sheet, when that was the
 * chassis, closes with them.
 */
export function closeQrCodeSheet(id: number): void {
  const { qrCode, qrCodeSeam, sharePanel } = uiStore.get()
  if (qrCode?.id !== id) return
  uiStore.set({ qrCode: null })
  if (qrCodeSeam?.phase === 'hosting' && qrCodeSeam.promptId === id) {
    if (sharePanel?.id === qrCodeSeam.panelId) {
      endSharePanel(qrCodeSeam.panelId, null)
      return
    }
    uiStore.set({ qrCodeSeam: null })
  }
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

// ---------------------------------------------------------------------------
// The share chooser (MW-63): a share another app sent, offered to the installed apps
// ---------------------------------------------------------------------------

/**
 * The chooser is the core's to put up and take down: it rides the window's snapshot
 * (`UIState.shareChooser`; `components/share/ShareChooserSheet.tsx` draws it from there), so
 * the surface predicates read the browser state for it, not this store.
 */
function shareChooserUp(): boolean {
  return (browserStore.get().state?.shareChooser ?? null) !== null
}

/**
 * The chooser's pick – an installed app's id, or null for the house route – or its dismissal
 * (`cancel`), for the chooser the snapshot carries (an answer to one it no longer does is
 * nothing). The core routes or drops the share and clears the chooser from the snapshot; the
 * sheet leaves on that, and lets the page's picture and the focus go once it is down
 * (`ShareChooserSheet.tsx`, which also sees that a share is answered once).
 */
export function answerShareChooser(requestId: string, appId: string | null | 'cancel'): void {
  const current = browserStore.get().state?.shareChooser ?? null
  if (!current || current.requestId !== requestId) return
  if (appId === 'cancel') run('share.chooserCancel', { requestId })
  else run('share.chooserPick', { requestId, appId })
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
// The share panel (Android below 14; SH-03): the host holds the share, the chrome draws the sheet
// ---------------------------------------------------------------------------

/**
 * The host put a share up for the panel (`share.panel`): the sheet rises over a capture of the
 * page that is sharing. A newer share while one is up takes the sheet over (the host has let the
 * older one go already); the omnibox closes if it was the opener. The two marks split the open
 * for a reading of its cost (`ShareDemo`'s probe): the host's request in, and the sheet asked
 * for once the page's cover is captured.
 */
export async function openSharePanel(request: SharePanelRequest): Promise<void> {
  performance.mark('share.panel')
  // A code seam of an older panel – its chassis about to be this request's, or gone – ends here:
  // the code it was drawing goes with the panel it stood in.
  if (uiStore.get().qrCodeSeam) uiStore.set({ qrCodeSeam: null, qrCode: null })
  const state = uiStore.get()
  const step = shareSeamStep(state.shareSeam, {
    type: 'panel',
    request,
    menuId: state.menu?.id ?? null
  })
  if (step.effect === 'host') {
    // §9.38's hand-off: the menu that asked for the share still stands, the page covered under
    // it already; its chassis takes the request (`MenuSheet.tsx` draws the panel in it).
    performance.mark('share.panel.set')
    uiStore.set({ sharePanel: request, shareSeam: step.seam, drawerOpen: false })
    return
  }
  // A menu still waiting for a request that is not its own leaves as a pick would have had it. A
  // panel the menu was hosting goes in the same set as the seam: the host has let that share go
  // already (a newer share supersedes the older one on its side), and `SharePanelLayer` must not
  // find the older request standing on its own for the frame the page's cover takes to capture.
  if (state.shareSeam) {
    if (state.shareSeam.phase === 'hosting') uiStore.set({ shareSeam: null, sharePanel: null })
    else uiStore.set({ shareSeam: null })
    closeMenu(false)
  }
  await captureActiveTab(request.tabId)
  run('focus.chrome', undefined)
  performance.mark('share.panel.set')
  uiStore.set({ sharePanel: request, drawerOpen: false })
  if (uiStore.get().urlbar.open) closeUrlbar()
}

/**
 * The panel's answer – an app, More, a chip the host carries out or the chrome ran itself, or
 * the dismissal that is every other way out (a drag, the scrim, back): one answer per request,
 * the sheet taken down with it – the menu's sheet, when that is the chassis the panel is in.
 */
export function answerSharePanel(id: string, action: Omit<SharePanelAction, 'id'>): void {
  if (uiStore.get().sharePanel?.id !== id) return
  endSharePanel(id, action)
}

/**
 * The panel's request is over: the store lets it go, and the chassis with it – the menu's, when
 * that hosted the panel. `action` is the host's answer; none when the host heard it already (the
 * QR code chip's, `beginQrCodeSeam`). A code seam standing for this panel ends with it.
 */
function endSharePanel(id: string, action: Omit<SharePanelAction, 'id'> | null): void {
  const step = shareSeamStep(uiStore.get().shareSeam, { type: 'answered', panelId: id })
  uiStore.set({ sharePanel: null, shareSeam: step.seam, qrCodeSeam: null })
  if (action) run('share.panelAction', { id, ...action })
  if (step.effect === 'closeMenu') {
    closeMenu(false)
    return
  }
  invalidateSnapshot()
  returnFocusToPage()
}

/**
 * The app menu's Share row was picked on a host whose panel stands in for the system sheet
 * (`handsOverToSharePanel`): the menu stands, its rows inert, while the host gathers the panel's
 * row; the request that comes back takes the menu's chassis (`openSharePanel`). The pick itself
 * runs at once – the host gathers before the menu is let go (§9.38) – and a guard lets the menu
 * leave should no request come (`SHARE_SEAM_GUARD_MS`).
 */
export function beginShareSeam(menuId: string, itemId: string): void {
  const menu = uiStore.get().menu
  if (!menu || menu.id !== menuId || uiStore.get().shareSeam) return
  uiStore.set({ shareSeam: { phase: 'gathering', menuId, itemId } })
  run('menu.click', { menuId, itemId })
  window.setTimeout(() => {
    const step = shareSeamStep(uiStore.get().shareSeam, { type: 'guard', menuId })
    if (step.effect !== 'dismissMenu') return
    uiStore.set({ shareSeam: null })
    closeMenu(false)
  }, SHARE_SEAM_GUARD_MS)
}

/**
 * The menu's sheet goes (a drag, back, the scrim, the host hiding it) with the seam in it: a
 * panel it was hosting is dismissed with it – the host releases the share – and a request it
 * was still waiting for will rise on its own (`openSharePanel` finds no menu).
 */
function releaseShareSeam(): void {
  const { shareSeam, sharePanel, qrCodeSeam } = uiStore.get()
  if (!shareSeam) return
  uiStore.set({ shareSeam: null })
  if (shareSeam.phase === 'hosting' && sharePanel?.id === shareSeam.panelId) {
    // A panel handed to the code sheet was answered already (the host heard `qr`): the code
    // goes with the chassis and nothing more is said.
    const handedOff = qrCodeSeam?.panelId === sharePanel.id
    uiStore.set({
      sharePanel: null,
      qrCodeSeam: handedOff ? null : qrCodeSeam,
      qrCode: handedOff && qrCodeSeam.phase === 'hosting' ? null : uiStore.get().qrCode
    })
    if (!handedOff) run('share.panelAction', { id: sharePanel.id, kind: 'dismiss' })
  }
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
  /**
   * A checkable row (a sort order, a view): the sheet draws the check and carries the state in
   * the tree (`menuitemradio` / `menuitemcheckbox` with `aria-checked`, A11Y-01). Plain when absent.
   */
  type?: 'normal' | 'radio' | 'checkbox'
  checked?: boolean
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
        type: item.type ?? 'normal',
        label: item.label,
        enabled: item.enabled ?? true,
        checked: item.checked ?? false,
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
    ui.qrCode !== null ||
    ui.longScreenshot !== null ||
    ui.extensionPrompts.length > 0 ||
    ui.extensionPopup !== null ||
    ui.floatingChrome > 0 ||
    ui.barEditorOpen ||
    ui.frameSheetOpen ||
    ui.tabsMenu !== null ||
    ui.historyMenu !== null ||
    ui.blockedPopupsPanel !== null ||
    ui.securityPromptOpen ||
    ui.credentialLeakOpen ||
    ui.permissionPromptOpen ||
    ui.pageDialogOpen ||
    ui.unresponsivePromptOpen ||
    ui.quitHoldCover ||
    ui.screenPickerOpen ||
    ui.deviceChooserOpen ||
    ui.windowPromptOpen ||
    ui.downloadsOpen ||
    ui.defaultBrowserPrompt ||
    ui.capture !== null ||
    ui.install !== null ||
    ui.installOffer !== null ||
    ui.mediaSheet !== null ||
    ui.clearBrowsingDataOpen ||
    ui.nameWindowOpen ||
    ui.importDialog !== null ||
    ui.printPreview !== null ||
    ui.autofillPrompt !== null ||
    ui.stageActive ||
    ui.zoomBubble !== null ||
    ui.memorySaverBubble !== null ||
    ui.readerPreferences !== null ||
    ui.hoverCard.tabId !== null ||
    ui.newTabShortcutDialog !== null ||
    ui.folderDeleteConfirm !== null ||
    ui.agentReleaseConfirm !== null ||
    ui.deleteSearchHistoryOpen ||
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
  if (onboardingUp()) return
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
// The folder delete confirmation over the page (desktop)
// ---------------------------------------------------------------------------

/**
 * "Delete <folder>?" from the sidebar's folder menu or the group editor bubble (TAB-16's desktop
 * half): a frame dialog (design language v2 §9.23, §9.5) over the active page's picture; the
 * bubble it may have come from closes as it opens (§9.20). `keyboard` records that a chrome
 * control had the keyboard, so a Cancel hands it back to the folder's header rather than the
 * page (§9.22).
 */
export async function openFolderDeleteConfirm(
  folderId: string,
  activeTabId: string | null,
  keyboard: boolean
): Promise<void> {
  await captureActiveTab(activeTabId)
  run('focus.chrome', undefined)
  uiStore.set({ folderDeleteConfirm: { folderId, keyboard }, groupEditor: null })
}

/** Put the prompt away; `toChrome` keeps the keyboard in the chrome (Cancel from the keyboard). */
export function closeFolderDeleteConfirm(toChrome = false): void {
  if (!uiStore.get().folderDeleteConfirm) return
  uiStore.set({ folderDeleteConfirm: null })
  invalidateSnapshot()
  if (!toChrome) returnFocusToPage()
}

/** "Release <agent>'s groups?" over the page, as `openFolderDeleteConfirm` asks its question. */
export async function openAgentReleaseConfirm(
  claimId: string,
  folderId: string,
  activeTabId: string | null,
  keyboard: boolean
): Promise<void> {
  await captureActiveTab(activeTabId)
  run('focus.chrome', undefined)
  uiStore.set({ agentReleaseConfirm: { claimId, folderId, keyboard }, groupEditor: null })
}

/** Put the release prompt away; `toChrome` keeps the keyboard in the chrome. */
export function closeAgentReleaseConfirm(toChrome = false): void {
  if (!uiStore.get().agentReleaseConfirm) return
  uiStore.set({ agentReleaseConfirm: null })
  invalidateSnapshot()
  if (!toChrome) returnFocusToPage()
}

// ---------------------------------------------------------------------------
// The Delete Search History confirmation over the page (desktop)
// ---------------------------------------------------------------------------

/**
 * Window event the "Delete search history?" prompt sends as its Delete is answered: the open
 * URL bar takes the remembered searches' rows out of its list – the core has forgotten them
 * (`urlbar.clearSearchHistory`).
 */
export const URLBAR_SEARCHES_FORGOTTEN_EVENT = 'zen-urlbar-searches-forgotten'

/**
 * "Delete search history?" from a suggestion row's native menu (context-menus-115; §10.5's bulk
 * case, pr-434 ruling 3): a frame dialog (design language v2 §9.23, §9.5) over the open bar and
 * the active page's picture – the bar's own capture, already held – through TabDialogs'
 * `FrameDialogHost`. The bar stays up under it, inert with the frame while the prompt stands.
 */
export async function openDeleteSearchHistoryConfirm(activeTabId: string | null): Promise<void> {
  await captureActiveTab(activeTabId)
  run('focus.chrome', undefined)
  uiStore.set({ deleteSearchHistoryOpen: true })
}

/**
 * Put the prompt away. The keyboard stays in the chrome while the bar is up
 * (`returnFocusToPage` asks for the page's only once no chrome surface has it); the prompt's
 * own return (§9.5, one hop down) hands it to the bar's field.
 */
export function closeDeleteSearchHistoryConfirm(): void {
  if (!uiStore.get().deleteSearchHistoryOpen) return
  uiStore.set({ deleteSearchHistoryOpen: false })
  invalidateSnapshot()
  returnFocusToPage()
}

/**
 * The prompt's Delete: the core forgets every remembered search (`urlbar.clearSearchHistory`),
 * the open bar hears of it and drops their rows (`URLBAR_SEARCHES_FORGOTTEN_EVENT`), and the
 * prompt goes.
 */
export function confirmDeleteSearchHistory(): void {
  run('urlbar.clearSearchHistory', undefined)
  window.dispatchEvent(new CustomEvent(URLBAR_SEARCHES_FORGOTTEN_EVENT))
  closeDeleteSearchHistoryConfirm()
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

// ---------------------------------------------------------------------------
// Phone Send to your devices sheet (ID-27)
// ---------------------------------------------------------------------------

/**
 * Open the device picker for a tab's page (`sendTab.open` from the core: the menu's "Send to
 * Your Devices…" on a phone with several other devices). A frame-dialog sheet on the chassis,
 * like the Extensions sheet: it takes the page's cover itself as it rises.
 */
export function openSendTabSheet(tabId: string): void {
  uiStore.set({ sendTabSheet: { tabId }, drawerOpen: false })
}

/** The picker has left the screen (a device picked, its own dismissal, the back gesture). */
export function closeSendTabSheet(): void {
  if (!uiStore.get().sendTabSheet) return
  uiStore.set({ sendTabSheet: null })
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
 * The Back (or Forward) button's hold: the tab's history popup, anchored to the button (GN-08;
 * Chrome's `NavigationPopup` on its tablet toolbar's Back). It overhangs the content area like
 * the Tabs button's menu, so the page gives way to its snapshot while the popup is up.
 */
export async function openHistoryMenu(
  anchor: Rect,
  direction: NavigationDirection,
  activeTabId: string | null
): Promise<void> {
  if (uiStore.get().overlay === 'none') await captureActiveTab(activeTabId)
  run('focus.chrome', undefined)
  uiStore.set({ historyMenu: { anchor, direction } })
}

export function closeHistoryMenu(): void {
  if (!uiStore.get().historyMenu) return
  uiStore.set({ historyMenu: null })
  invalidateSnapshot()
  returnFocusToPage()
}

/**
 * Delete browsing data (`siteControls/ClearBrowsingDataDialog`): a dialog through the frame dialog
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
 * Chrome's Name window prompt (`windowName/NameWindowDialog`, shortcuts-menus-121): a §9.23
 * dialog through the frame dialog host over the page's picture, which has to exist first for
 * the scrim to dim; the keyboard goes to the chrome for its field.
 */
export async function openNameWindow(activeTabId: string | null): Promise<void> {
  if (uiStore.get().nameWindowOpen) return
  if (uiStore.get().overlay === 'none') await captureActiveTab(activeTabId)
  run('focus.chrome', undefined)
  uiStore.set({ nameWindowOpen: true })
}

/** The prompt is gone (answered or cancelled): the page's picture is dropped and the keyboard goes back. */
export function closeNameWindow(): void {
  if (!uiStore.get().nameWindowOpen) return
  uiStore.set({ nameWindowOpen: false })
  invalidateSnapshot()
  returnFocusToPage()
}

/**
 * Chrome's "Import bookmarks and settings" (`import/ImportDialog`, ID-23): a dialog through the
 * frame dialog host, over the Settings tab on its Import category where its rows live – or over
 * the page when a menu asks for it before Settings is up, whose snapshot then has to exist
 * first for the scrim to dim (a chrome page has none to take, and stays drawn under the dialog).
 * `source` preselects a browser profile (the first-run offer's pick). `lib/pages.ts`'s
 * `openImportSurface` brings Settings up first.
 */
export async function openImportDialog(
  activeTabId: string | null,
  source: string | null = null
): Promise<void> {
  if (uiStore.get().importDialog) return
  if (uiStore.get().overlay === 'none') await captureActiveTab(activeTabId)
  run('focus.chrome', undefined)
  uiStore.set({ importDialog: { source } })
}

export function closeImportDialog(): void {
  if (!uiStore.get().importDialog) return
  uiStore.set({ importDialog: null })
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
 * blocked pop-ups popover, an autofill prompt in its popover form, the pill's "Install <app>?"
 * popover (`installPopoverUp`), a menu the renderer draws,
 * the collapsed rail's flyout (`useRailFlyout` – the sidebar itself, §9.20's cascade beside
 * the rail), the compact sidebar's or the hidden toolbar's hover reveal (`compactHover`,
 * `toolbarHover`: chrome out over the page's picture, no dialog – #411 ruling 4), or a sign-in
 * or certificate dialog. The page behind them is captured all the same
 * (they overlap the live view), but panels and popovers draw no scrim (v2 §9.5, §9.20), so the
 * capture shows undimmed; dialogs dim it. A chassis sheet's scrim is its own one dim (§11.5),
 * so the same holds under the site-information sheet and the prompt sheet on a phone, and the
 * security prompt's dim is the frame dialog host's scrim alone (v2 §9.5, §11.5: one dim layer),
 * as is the leak warning's – a frame dialog on a mouse, a chassis sheet on a phone. The chrome
 * layer's popovers and menus (the translate selection popover, a menulist's list) count in
 * `floatingChrome` and are the extensions' counterpart's case
 * (`extensionChromeAloneOverContent`); a menulist's list opened from inside one of these panels
 * (the reader popover's font or theme menu, site information's) is floating chrome over a panel,
 * still no dialog, so `floatingChrome` is left out of the reduced check too and the page under
 * both stays undimmed.
 */
export function panelAloneOverContent(ui: UiState): boolean {
  const popover = ui.autofillPrompt === 'popover'
  const installPopover = installPopoverUp(ui)
  return (
    (ui.barMenuOpen ||
      ui.starDialog !== null ||
      ui.zoomBubble !== null ||
      ui.memorySaverBubble !== null ||
      ui.readerPreferences !== null ||
      ui.hoverCard.tabId !== null ||
      ui.downloadsOpen ||
      // Site information and the permission prompt are popovers on a mouse (no scrim, §9.5) and
      // chassis sheets on a phone, whose own scrim is the one dim over the page (§11.5).
      ui.siteInfoOpen ||
      ui.permissionPromptOpen ||
      ui.blockedPopupsPanel !== null ||
      ui.securityPromptOpen ||
      ui.credentialLeakOpen ||
      // A menu the renderer draws – the desktop's app menu under ⋯ (§6 "Menus": the page under
      // it undimmed), a host's context menu – is the `.zen-v2-menu` popover on a mouse and a
      // bottom sheet with its own scrim on touch: no dim of the frame's either way.
      ui.menu !== null ||
      // The rail's flyout stands over the page's picture as the sidebar stands beside the
      // page: no scrim (Edge's and Zen's hover reveals leave the page as it was). The flag is
      // `pageHidden`'s, not `overlayCoversContent`'s, so the reduced check below needs no
      // clearing of it.
      ui.railFlyout ||
      // The compact sidebar's edge reveal and the hidden toolbar's are hover reveals of chrome
      // the same way (#411 ruling 4, §9.20): chrome slid out over the page's picture, not a
      // dialog over the page, so neither takes §9.5's dim. `pageHidden`'s flags too, so the
      // reduced check needs no clearing of them either.
      ui.compactHover ||
      ui.toolbarHover ||
      // "Hold ⌘Q to quit" over a hung page's picture (session-08, `lib/quitHoldCover.ts`): the
      // chrome's twin of the notice, a status block with no scrim as the page-drawn one has
      // none – the page under the notice looks as it did.
      ui.quitHoldCover ||
      // The pill's "Install <app>?" popover – the core's offer or the user's prompt – is a
      // popover like the zoom bubble (the Design Lead's ruling on W8-M3's item 3: Chrome's
      // form, no scrim); the "Create shortcut" dialog the prompt's entry stands for on a page
      // without an installable manifest is a frame dialog, with the host's scrim for its one dim.
      installPopover ||
      popover) &&
    !overlayCoversContent({
      ...ui,
      barMenuOpen: false,
      starDialog: null,
      zoomBubble: null,
      memorySaverBubble: null,
      readerPreferences: null,
      hoverCard: HOVER_CARD_HIDDEN,
      downloadsOpen: false,
      siteInfoOpen: false,
      permissionPromptOpen: false,
      blockedPopupsPanel: null,
      securityPromptOpen: false,
      credentialLeakOpen: false,
      menu: null,
      floatingChrome: 0,
      quitHoldCover: false,
      install: installPopover ? null : ui.install,
      installOffer: null,
      autofillPrompt: popover ? null : ui.autofillPrompt
    })
  )
}

/**
 * Only a core menu is up over the page: the app menu or a context menu (`ui.menu`), alone or
 * over floating chrome that draws no dim of its own either (the tablet's sidebar drawer a tab
 * row's long-press menu opens over, whose scrim is the drawer's; a menulist's list), and
 * nothing else covering the content. Where the menu is a popover – the tablet's (v2 §9.36,
 * `TabletMenu`) – the page's capture under it stays undimmed as under every other popover (v2
 * §9.5, §9.20: panels and popovers draw no scrim). The phone's menu sheet has its own scrim, and
 * the desktop's `.zen-v2-menu` popover under ⋯ is undimmed the same way (§6 "Menus"), by way of
 * `panelAloneOverContent`, which counts a renderer-drawn menu among the anchored panels.
 */
export function menuAloneOverContent(ui: UiState): boolean {
  return ui.menu !== null && !overlayCoversContent({ ...ui, menu: null, floatingChrome: 0 })
}

// ---------------------------------------------------------------------------
// The zoom bubble over the page
// ---------------------------------------------------------------------------

/**
 * Whether the pill's zoom chip stands for the tab once its zoom is `factor`: the chip's own rule
 * (`isZoomed`, §9.29 – the page away from its default zoom, the site's exception counted as the
 * deviation it is), read against the change itself rather than the tab's zoom of the last push,
 * which the event may run ahead of.
 */
function zoomChipStandsAt(tabId: string, factor: number): boolean {
  const state = browserStore.get().state
  const tab = state?.tabs[tabId]
  if (!state || !tab) return false
  return isZoomed({ ...tab, zoom: factor }, state.settings.pageControls, state.pageEnvironment)
}

/**
 * A page was zoomed (`zoom.changed`): the bubble comes up for it over a picture of the page –
 * the live view gives way under chrome that overlaps it, as under the star bubble – and, while
 * it is up, takes a fresh picture at every step so the page is seen at its new zoom. The
 * keyboard is left where it is: a zoom step opens the bubble as feedback, not as a place to be.
 *
 * The bubble hangs from the pill's zoom chip (§9.20), which stands only while the page is away
 * from its default zoom (§9.29). A change that leaves no chip – a reset from anywhere (the
 * bubble's own Reset, Ctrl+0, the menus' and the context menu's), a step or the wheel landing on
 * the default – raises nothing and ends a bubble that stands, with its chip. Chrome's clocked
 * notice after such a change is not owed: the chip leaving the pill and the page resizing are the
 * feedback.
 */
export async function showZoomBubble(tabId: string, factor: number): Promise<void> {
  const bubbleFor = (id: string): UiState['zoomBubble'] => {
    const open = uiStore.get().zoomBubble
    return open && open.tabId === id ? open : null
  }
  if (!zoomChipStandsAt(tabId, factor)) {
    if (bubbleFor(tabId)) closeZoomBubble()
    return
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
// The Memory Saver bubble under the pill's leaf
// ---------------------------------------------------------------------------

/**
 * The pill's leaf was pressed (omnibox-40): the bubble opens under the slot over a picture of
 * the page – the live view gives way under chrome that overlaps it, as under the zoom bubble –
 * and the keyboard goes into it (§9.22: a surface the user opened).
 */
export async function openMemorySaverBubble(tabId: string): Promise<void> {
  await captureActiveTab(tabId)
  run('focus.chrome', undefined)
  uiStore.set({ memorySaverBubble: { tabId } })
}

/**
 * Put the bubble away. Focus goes back to the page unless the caller keeps it in the chrome
 * (`keepFocus`: Escape hands it to the slot the bubble hung from, §9.22).
 */
export function closeMemorySaverBubble(opts: { keepFocus?: boolean } = {}): void {
  if (!uiStore.get().memorySaverBubble) return
  uiStore.set({ memorySaverBubble: null })
  invalidateSnapshot()
  if (!opts.keepFocus) returnFocusToPage()
}

// ---------------------------------------------------------------------------
// Reader View's text preferences over the page
// ---------------------------------------------------------------------------

/** The pill's Text preferences chip: what the desktop popover hangs from (§9.20). */
export const READER_PREFS_CHIP = '[data-reader-prefs-chip]'

/** The chip while it is on screen (null in compact mode, whose row has no pill). */
export function readerPreferencesChip(): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(READER_PREFS_CHIP)
  return el && el.getClientRects().length > 0 ? el : null
}

/**
 * "Text Preferences…" for a reader tab (the pill's chip, the app menu): the surface comes up
 * over a picture of the page, as the zoom bubble does, and the keyboard goes into it. `pressed`
 * is the chip's box when the chip was pressed; `readerPreferencesAnchor` settles what the
 * popover hangs from either way. A second request for the tab whose surface is up leaves it as
 * it is (the chip's own press while it is up is the chrome layer's light dismiss).
 */
export async function openReaderPreferences(
  tabId: string,
  pressed: DOMRect | Rect | null = null
): Promise<void> {
  const open = uiStore.get().readerPreferences
  if (open && open.tabId === tabId) return
  await captureActiveTab(tabId)
  run('focus.chrome', undefined)
  uiStore.set({ readerPreferences: { tabId, ...readerPreferencesAnchor(pressed) } })
}

/**
 * Where the desktop popover hangs (§9.20: an anchored panel, its top on its bar's bottom edge,
 * start-aligned to its anchor, the anchor lit while it is up): from the pill's Text preferences
 * chip – the one pressed, or the one a request from the app menu finds on screen; the reader
 * tab never hides it (§9.29) – in the pill. No chip on screen (compact mode, a phone, whose
 * sheet takes no anchor) leaves both null.
 */
function readerPreferencesAnchor(
  pressed: DOMRect | Rect | null
): Pick<NonNullable<UiState['readerPreferences']>, 'anchor' | 'bar'> {
  const chipBox = pressed ?? readerPreferencesChip()?.getBoundingClientRect() ?? null
  if (!chipBox) return { anchor: null, bar: null }
  const pill = document.querySelector('.zen-pill')
  return {
    anchor: rectOf(chipBox),
    bar: pill ? rectOf(pill.getBoundingClientRect()) : null
  }
}

/** The four numbers of a box (a DOMRect carries more; only these are kept). */
function rectOf(box: DOMRect | Rect): Rect {
  return { x: box.x, y: box.y, width: box.width, height: box.height }
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
