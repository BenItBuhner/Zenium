import type { Rect, SelectionMenuActionId, SelectionMenuState } from '../shared/types'
import type { Browser } from './browser'
import type { PageMessage } from './platform'
import type { ZenWindow } from './window'

/**
 * The mini menu over a text selection (CT-39; Edge's mini menu, Chrome for Android's selection
 * menu): the model the chrome draws the pill from.
 *
 * The page script reports the settled selection and its going (`shared/selectionScript.ts`:
 * text, box, whether a text field's); this turns a report into `UIState.selectionMenu` – the
 * tab, the text, the box and the chips the page context menu's own selection actions give it
 * (`Menus.selectionMenuActions`, the one list) – and clears it when the selection collapses, the
 * page navigates, the tab leaves the screen or is closed, the window loses the keyboard, or a
 * chip ran (Edge's menu goes with its action). One model at a time (a selection is one place),
 * for the tab on screen in its window: a background page's selection shows nothing.
 *
 * Desktop hosts with `capabilities.selectionMenu`; a report reaching a host without it costs
 * one check and is dropped (the phone's page script never posts one: its system toolbar is its
 * selection menu). A frame's report (`frameId` other than the top document's 0) is dropped too:
 * its box is the frame's, not the page's.
 */

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
 * trimmed again – the page did, but a page is not trusted), `rect` four finite numbers or null,
 * `isEditable` a boolean (false when missing). Null for anything else.
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

  constructor(private readonly browser: Browser) {}

  /** Whether this host shows the mini menu (`capabilities.selectionMenu`). */
  get available(): boolean {
    return this.browser.state.capabilities.selectionMenu === true
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
   * went) clears it. Anything malformed is dropped.
   */
  onSelection(tabId: string, message: Pick<PageMessage, 'selection' | 'frameId'>): void {
    if (!this.available) return
    const report = parseSelectionReport(message.selection)
    if (!report) return
    if ((message.frameId ?? 0) !== 0) return
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
    return this.browser.menus.runSelectionMenuAction(tabId, id, current.text, current.rect)
  }

  /** `selectionMenu.dismiss`: the chrome took the menu down (Escape, a click on the chrome). */
  dismiss(tabId: string): void {
    this.clear(tabId)
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
    this.state = next
    this.browser.state.commit()
  }

  private clear(tabId?: string): void {
    if (!this.state) return
    if (tabId !== undefined && this.state.tabId !== tabId) return
    this.state = null
    this.browser.state.commit()
  }
}
