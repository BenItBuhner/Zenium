import type {
  Rect,
  SelectionMenuAction,
  SelectionMenuActionId,
  SelectionMenuState
} from '../shared/types'
import type { Browser } from './browser'
import { anchorInChrome } from './credentials/fill'
import type { PageMessage } from './platform'
import type { ZenWindow } from './window'

/**
 * The mini menu over a text selection (CT-39; Edge's mini menu, Chrome for Android's selection
 * menu): the model the chrome draws the pill from, and where the pill stands.
 *
 * The page script reports the settled selection and its going (`shared/selectionScript.ts`:
 * text, box, whether a text field's); this turns a report into `UIState.selectionMenu` – the
 * tab, the text, the box and the chips the page context menu's own selection actions give it
 * (`Menus.selectionMenuActions`, the one list) – and clears it when the selection collapses, the
 * page navigates, the tab leaves the screen or is closed, the window loses the keyboard, or a
 * chip ran (Edge's menu goes with its action). One model at a time (a selection is one place),
 * for the tab on screen in its window: a background page's selection shows nothing.
 *
 * The pill is drawn by the window's popup surface (`ZenWindow.setPopupSurface`, the document
 * the autofill picker shares, `PopupSurface`): a second chrome document floated over the page
 * without taking the keyboard, so the page keeps its selection and its typing while the menu
 * stands – the chrome's own document would have to cover the page to draw over it. This
 * service places the surface over the selection's box (`placeMiniMenuSurface`: above it, below
 * when the room above is short, inside the page view) at the size the pill's document reports
 * (`selectionMenu.surfaceSize`; an estimate until it has), follows the view through a layout,
 * and takes the surface down with the model.
 *
 * Desktop hosts with `capabilities.selectionMenu`, and the setting on (`Settings.
 * showSelectionMenu`, Edge's "Show mini menu when selecting text"); a report reaching a host
 * without it – or with the setting off – costs one check and is dropped (the phone's page script
 * never posts one: its system toolbar is its selection menu). A frame's report (`frameId` other
 * than the top document's 0) is dropped too: its box is the frame's, not the page's.
 */

// ---------------------------------------------------------------------------
// Where the pill stands
// ---------------------------------------------------------------------------

/** The pill's size in window CSS pixels, as its document measured it or as estimated. */
export interface MiniMenuSize {
  width: number
  height: number
}

/**
 * §9.20's floating toolbar: 32 controls with 6 of padding, 44 tall inside its hairlines – the
 * box 46. What the surface opens at before the pill's document has measured itself.
 */
export const MINI_MENU_HEIGHT = 46
/** Transparent margin around the pill inside the popup surface, where its shadow draws (the picker's). */
export const MINI_MENU_SURFACE_PAD = 8
/** The gap between the selection's box and the pill (§9.20's popover gap). */
export const MINI_MENU_GAP = 8
/** How close the pill may come to the page view's edges (§9.20's 8 margin). */
export const MINI_MENU_MARGIN = 8
/** The pill's 6 of padding each side and its two hairlines. */
const MINI_MENU_SIDES = 6 * 2 + 2
/** The 8 between chips (`.zen-mini-menu`'s gap). */
const MINI_MENU_CHIP_GAP = 8
/** A chip is a `.zen-v2-button` with a glyph: its 96 floor, or the glyph, its 8 gap, the label and 16 each side. */
const MINI_MENU_CHIP_MIN = 96
const MINI_MENU_CHIP_FIXED = 16 + 8 + 16 * 2
/** About one character of the 13 px label. */
const MINI_MENU_CHAR = 7

/**
 * How big the pill comes out for `actions` before its document has measured itself: one chip
 * per action at the button primitive's floor or its glyph-and-label width, the gaps between
 * them and the pill's sides. The surface opens at this size and follows the document's
 * `selectionMenu.surfaceSize` report afterwards.
 */
export function estimateMiniMenuSize(actions: readonly SelectionMenuAction[]): MiniMenuSize {
  const chips = actions.map((action) =>
    Math.max(MINI_MENU_CHIP_MIN, MINI_MENU_CHIP_FIXED + action.title.length * MINI_MENU_CHAR)
  )
  const width =
    MINI_MENU_SIDES +
    chips.reduce((sum, chip) => sum + chip, 0) +
    Math.max(0, chips.length - 1) * MINI_MENU_CHIP_GAP
  return { width, height: MINI_MENU_HEIGHT }
}

/**
 * Where the popup surface that carries the pill goes, in window CSS pixels: the pill centred
 * over the selection's box and `MINI_MENU_GAP` above it (Edge's mini menu stands above the
 * selection), below it when the room above is short, and held inside the page view by
 * `MINI_MENU_MARGIN` on every side – a selection at the view's edge gets the pill beside it,
 * never over the chrome; a view too short for either side gets it clamped over the box. The
 * surface adds `MINI_MENU_SURFACE_PAD` all around for the pill's shadow. Pure; `anchor` is
 * `anchorInChrome`'s rect (the box in window pixels, clipped to `view`).
 */
export function placeMiniMenuSurface(anchor: Rect, view: Rect, size: MiniMenuSize): Rect {
  const pad = MINI_MENU_SURFACE_PAD
  const width = Math.ceil(size.width)
  const height = Math.ceil(size.height)
  const minLeft = view.x + MINI_MENU_MARGIN
  const maxLeft = view.x + view.width - MINI_MENU_MARGIN - width
  const centred = anchor.x + anchor.width / 2 - width / 2
  const left = Math.max(minLeft, Math.min(maxLeft, centred))
  const minTop = view.y + MINI_MENU_MARGIN
  const maxTop = view.y + view.height - MINI_MENU_MARGIN - height
  const above = anchor.y - MINI_MENU_GAP - height
  const below = anchor.y + anchor.height + MINI_MENU_GAP
  let top: number
  if (above >= minTop) top = above
  else if (below <= maxTop) top = below
  else top = Math.max(minTop, Math.min(maxTop, above))
  return {
    x: Math.round(left - pad),
    y: Math.round(top - pad),
    width: width + pad * 2,
    height: height + pad * 2
  }
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** The most characters a report is taken with (the page script's own cap; a longer one is a forgery). */
export const SELECTION_MENU_MAX_CHARS = 1000

/** A `selection` report as the page posted it, checked field by field. */
export interface SelectionReport {
  text: string
  rect: Rect | null
  isEditable: boolean
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * The report out of the page's message: `text` a string within the cap (whitespace folded and
 * trimmed again – the page did, but a page is not trusted), `rect` four finite numbers or null –
 * `x` and `y` may be negative, a box scrolled partly off the viewport's top or left is placed
 * from where it is – `isEditable` a boolean (false when missing; the chrome reads it to keep the
 * menu off a text field's selection). Null for anything else.
 */
export function parseSelectionReport(raw: unknown): SelectionReport | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (typeof record.text !== 'string') return null
  const text = record.text.replace(/\s+/g, ' ').trim()
  if (text.length > SELECTION_MENU_MAX_CHARS) return null
  let rect: Rect | null = null
  if (record.rect !== null && record.rect !== undefined) {
    if (typeof record.rect !== 'object') return null
    const box = record.rect as Record<string, unknown>
    if (!finite(box.x) || !finite(box.y) || !finite(box.width) || !finite(box.height)) return null
    if (box.width < 0 || box.height < 0) return null
    rect = { x: box.x, y: box.y, width: box.width, height: box.height }
  }
  return { text, rect, isEditable: record.isEditable === true }
}

export class SelectionMenuService {
  private state: SelectionMenuState | null = null
  /** The window whose popup surface carries the pill, while one does. */
  private surfaceWindow: ZenWindow | null = null
  /**
   * The pill's size as its document measured it (`selectionMenu.surfaceSize`); null until it
   * has, and again when the chips change (a different pill measures anew).
   */
  private measured: MiniMenuSize | null = null

  constructor(private readonly browser: Browser) {}

  /**
   * Whether this host shows the mini menu: `capabilities.selectionMenu`, and the setting on
   * (`Settings.showSelectionMenu`; absent reads as on).
   */
  get available(): boolean {
    const { capabilities, settings } = this.browser.state
    return capabilities.selectionMenu === true && settings.showSelectionMenu !== false
  }

  /**
   * `UIState.selectionMenu` for `win`: the settled selection with its chips when its tab is on
   * screen in that window (the active tab, or a pane of its split), null otherwise – another
   * window's selection is not this window's menu.
   */
  uiState(win: ZenWindow): SelectionMenuState | null {
    const current = this.state
    if (!current) return null
    return this.browser.tabs.visibleTabIds(win).includes(current.tabId) ? current : null
  }

  /**
   * The page of `tabId` reported its selection (`PageMessage` `selection`): a non-empty report
   * from the top document of the tab on screen becomes the model; an empty one (the selection
   * went) clears it. Anything malformed is dropped, and so is a report the host did not place:
   * the host stamps `frameId` from the sender frame, and only the top document's `0` will do –
   * a missing stamp is not the top document's.
   */
  onSelection(tabId: string, message: Pick<PageMessage, 'selection' | 'frameId'>): void {
    if (!this.available) return
    const report = parseSelectionReport(message.selection)
    if (!report) return
    if (message.frameId !== 0) return
    if (!report.text) {
      this.clear(tabId)
      return
    }
    const { tabs } = this.browser
    if (!tabs.tab(tabId)) return
    // On screen somewhere: the active tab of a window, or a pane of its split. A background
    // page's selection (a script's, or one left behind) shows nothing.
    if (tabs.windowsShowing(tabId).length === 0) return
    const actions = this.browser.menus.selectionMenuActions(tabId, report.text, report.rect)
    if (actions.length === 0) {
      this.clear(tabId)
      return
    }
    this.set({
      tabId,
      text: report.text,
      rect: report.rect,
      isEditable: report.isEditable,
      actions
    })
  }

  /**
   * `selectionMenu.run`: the chip `id` was pressed for `tabId`'s selection. Runs the action on
   * the text the model holds (the page's report, not the caller's) and clears the model – the
   * menu goes with its action, as Edge's does. False when the model is another tab's or gone.
   */
  run(tabId: string, id: SelectionMenuActionId): boolean {
    const current = this.state
    if (!current || current.tabId !== tabId) return false
    if (!current.actions.some((action) => action.id === id)) return false
    this.clear(tabId)
    // The press took the keyboard into the pill's document: the page has it back before the
    // action runs – Copy copies the page's selection, Listen reads it – and an action that
    // opens chrome of its own (Define, Translate, Search's new tab) takes it from there.
    this.browser.tabs.windowFor(tabId).focusContent()
    return this.browser.menus.runSelectionMenuAction(tabId, id, current.text, current.rect)
  }

  /**
   * `selectionMenu.dismiss`: the pill's document took the menu down (Escape while it held the
   * keyboard). The page has the keyboard back; its selection stands.
   */
  dismiss(tabId: string): void {
    const current = this.state
    if (!current || current.tabId !== tabId) return
    this.clear(tabId)
    this.browser.tabs.windowFor(tabId).focusContent()
  }

  /**
   * `selectionMenu.surfaceSize`: the pill's document measured the size its content wants (window
   * CSS pixels, the pill's box without the surface's shadow margin); the surface follows. A
   * report for another tab's pill, or a nonsensical one, is dropped.
   */
  surfaceSize(tabId: string, width: number, height: number): void {
    const current = this.state
    if (!current || current.tabId !== tabId) return
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return
    if (this.measured && this.measured.width === width && this.measured.height === height) return
    this.measured = { width, height }
    this.placeSurface()
  }

  /**
   * The chrome laid `win`'s page out again (a resize, a sidebar, an overlay): the pill follows
   * the view's new place, and goes down while the chrome covers the page (the model stands, so
   * the pill comes back with the page).
   */
  onLayout(win: ZenWindow): void {
    const current = this.state
    if (!current) return
    if (this.browser.tabs.windowFor(current.tabId) !== win) return
    this.placeSurface()
  }

  /** The setting changed: turned off, a standing menu goes (the next report is dropped). */
  onSettingsChanged(): void {
    if (!this.available) this.clear()
  }

  /** The tab's document changed (not a same-document move): its selection is gone with it. */
  onNavigated(tabId: string, inPage: boolean): void {
    if (!inPage) this.clear(tabId)
  }

  onTabGone(tabId: string): void {
    this.clear(tabId)
  }

  /** The tabs on screen changed (a tab activated, a split changed): a model for a tab no longer shown goes. */
  onVisibleTabsChanged(): void {
    const current = this.state
    if (!current) return
    if (this.browser.tabs.windowsShowing(current.tabId).length === 0) this.clear(current.tabId)
  }

  /** The window lost the keyboard (another app, another window): the menu goes, as Edge's does. */
  onWindowBlur(win: ZenWindow): void {
    const current = this.state
    if (!current) return
    if (this.browser.tabs.windowFor(current.tabId) === win) this.clear(current.tabId)
  }

  private set(next: SelectionMenuState): void {
    const previous = this.state
    // The same chips measure the same: the last measurement places the next pill exactly. Other
    // chips (Define came or went with the words) start from the estimate until they measure.
    if (previous && !sameChips(previous.actions, next.actions)) this.measured = null
    this.state = next
    this.placeSurface()
    this.browser.state.commit()
  }

  private clear(tabId?: string): void {
    if (!this.state) return
    if (tabId !== undefined && this.state.tabId !== tabId) return
    this.state = null
    this.dropSurface()
    this.browser.state.commit()
  }

  /**
   * Put the popup surface over the selection's box on the window that owns the page – at the
   * measured size, or the estimate until the pill's document has reported one – or take it down
   * while the page is covered, scrolled away from the box, or shown by a host without a surface.
   */
  private placeSurface(): void {
    const current = this.state
    if (!current || !current.rect) {
      this.dropSurface()
      return
    }
    const { tabs } = this.browser
    const win = tabs.windowFor(current.tabId)
    const view = win.hasPopupSurface ? win.viewRect(current.tabId) : null
    if (!view) {
      this.dropSurface()
      return
    }
    const anchor = anchorInChrome(current.rect, view, tabs.tab(current.tabId)?.zoom ?? 1)
    // The box lies outside the view (the selection scrolled off): nothing to hang the pill from.
    if (anchor.width <= 0 || anchor.height <= 0) {
      this.dropSurface()
      return
    }
    if (this.surfaceWindow && this.surfaceWindow !== win) this.dropSurface()
    const size = this.measured ?? estimateMiniMenuSize(current.actions)
    win.setPopupSurface(placeMiniMenuSurface(anchor, view, size), 'selectionMenu')
    this.surfaceWindow = win
  }

  private dropSurface(): void {
    this.surfaceWindow?.setPopupSurface(null, 'selectionMenu')
    this.surfaceWindow = null
  }
}

function sameChips(a: readonly SelectionMenuAction[], b: readonly SelectionMenuAction[]): boolean {
  return (
    a.length === b.length && a.every((chip, i) => chip.id === b[i].id && chip.title === b[i].title)
  )
}
