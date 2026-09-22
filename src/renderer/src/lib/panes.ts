import type { FocusPaneRequest, PaneId } from '@shared/types'
import { focusEdge } from '@shared/focusEdge'
import { run } from './api'
import { noteInput } from './lastInput'
import { closeUrlbar, uiStore } from './ui'

/**
 * Keyboard panes (design language v2 draft §9.22; Chrome's F6 rotation).
 *
 * The chrome is a handful of regions the keyboard walks with F6 and Shift+F6 – the tab strip, the
 * toolbar (its address bar), the bookmarks bar, an extension's side panel – and the page, in
 * Chrome's order (`BrowserView::GetAccessiblePanes`). Each region marks its root `data-pane`; a
 * region that is not on screen, or has nothing to focus, is skipped. The pure part ({@link
 * nextPane}) is the rotation; {@link focusPane} reads the document, moves the keyboard and asks the
 * core for the chrome's or the page's focus.
 */

/** The panes in F6 order; the page is last, so F6 from the page wraps to the tab strip (Chrome). */
export const PANE_ORDER: readonly PaneId[] = ['tabs', 'toolbar', 'bookmarks', 'sidepanel', 'page']

/**
 * Window event a pane move sends when the keyboard leaves the open URL bar: the bar closes
 * itself as on Escape (draft kept, extension omnibox session ended) and leaves the keyboard
 * where the move put it.
 */
export const URLBAR_LEAVE_EVENT = 'zen-urlbar-leave'

/**
 * Window event {@link pageTookKeyboard} sends the open URL bar when a page's view took the
 * keyboard the bar holds: the bar asks the chrome's keyboard back and focuses its field.
 */
export const URLBAR_KEYBOARD_EVENT = 'zen-urlbar-keyboard'

/**
 * The pane the keyboard moves to from `current` – forward (`next`, F6) or back (`prev`,
 * Shift+F6) – among the panes on screen (`shown`). The page is always shown, and is where the
 * keyboard counts as being when it is in no pane (`current` null, or a pane that is not shown):
 * F6 from anywhere outside the chrome's panes goes to the first pane, Shift+F6 to the last.
 */
export function nextPane(
  current: PaneId | null,
  shown: Iterable<PaneId>,
  move: 'next' | 'prev'
): PaneId {
  const visible = new Set<PaneId>(shown)
  visible.add('page')
  const order = PANE_ORDER.filter((pane) => visible.has(pane))
  const from = order.indexOf(current !== null && visible.has(current) ? current : 'page')
  const step = move === 'next' ? 1 : -1
  return order[(from + step + order.length) % order.length] ?? 'page'
}

/** The pane an element belongs to: the nearest `data-pane` root above it; null outside every pane. */
export function paneOf(element: Element | null): PaneId | null {
  const root = element?.closest<HTMLElement>('[data-pane]')
  const pane = root?.dataset.pane
  return pane && PANE_ORDER.includes(pane as PaneId) ? (pane as PaneId) : null
}

/** What the keyboard can land on: the same set the browser walks with Tab. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function onScreen(element: Element): boolean {
  return element.isConnected && element.getClientRects().length > 0
}

/**
 * The focusable controls of a pane root, in document order, leaving out what is hidden and what
 * belongs to a pane nested inside it (the single-toolbar layout's navigation row sits in the
 * sidebar: its buttons are the toolbar's, not the tab strip's).
 */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) =>
      onScreen(el) &&
      !el.closest('[aria-hidden="true"], [inert]') &&
      el.closest('[data-pane]') === root
  )
}

/**
 * The roots of `pane` on screen. The toolbar has two: the navigation row and, while it is open,
 * the URL bar over the page; the row comes first so a move into the toolbar lands on the address.
 */
function paneRoots(pane: PaneId, doc: Document = document): HTMLElement[] {
  const roots = [...doc.querySelectorAll<HTMLElement>(`[data-pane="${pane}"]`)].filter(onScreen)
  return roots.sort((a, b) => Number('zenNavRow' in b.dataset) - Number('zenNavRow' in a.dataset))
}

/**
 * The panes on screen with something to focus, in F6 order (`page` always). A collapsed sidebar
 * still shows its tab strip; a compact-mode sidebar that is hidden has no root in the document.
 */
export function shownPanes(doc: Document = document): PaneId[] {
  return PANE_ORDER.filter(
    (pane) => pane === 'page' || paneRoots(pane, doc).some((root) => focusablesIn(root).length > 0)
  )
}

/**
 * Where the keyboard lands in `pane`: the tab strip's active row (else its first row, else its
 * New Tab button), the toolbar's address (the first control when the collapsed sidebar shows no
 * pill), the bookmarks bar's roving chip, the side panel's first control. Null for the page and
 * for a pane that is not on screen.
 */
export function paneTarget(pane: PaneId, doc: Document = document): HTMLElement | null {
  if (pane === 'page') return null
  for (const root of paneRoots(pane, doc)) {
    const controls = focusablesIn(root)
    if (controls.length === 0) continue
    const prefer = (selector: string): HTMLElement | null =>
      controls.find((el) => el.matches(selector)) ?? null
    switch (pane) {
      case 'tabs':
        return (
          prefer('[data-tab-scroller][data-active="true"] [data-tab-id][data-active="true"]') ??
          prefer('[data-tab-id][data-active="true"]') ??
          prefer('[data-tab-scroller][data-active="true"] [data-tab-id]') ??
          controls[0] ??
          null
        )
      case 'toolbar':
        return prefer('[role="group"][aria-label="Address"] > button') ?? controls[0] ?? null
      case 'bookmarks':
        return prefer('[tabindex="0"]') ?? controls[0] ?? null
      default:
        return controls[0] ?? null
    }
  }
  return null
}

/**
 * The pane the keyboard is in now: the page when the core says the key came from a page's view
 * (`from`), or the chrome document knows it does not hold the keyboard; else the pane of the
 * focused element (null outside every pane). The core's word is needed: with the keyboard in a
 * sibling page view the chrome document still reports `hasFocus()` and keeps its `activeElement`.
 */
export function currentPane(
  doc: Document = document,
  from: 'chrome' | 'page' = 'chrome'
): PaneId | null {
  if (from === 'page' || !doc.hasFocus()) return 'page'
  return paneOf(doc.activeElement)
}

/**
 * A hardware keyboard's Tab ran past the page's last tabbable (Shift+Tab past its first) and the
 * host handed the chrome the keyboard (A11Y-09's remainder, the phone's `FocusHandoff.kt`): the
 * focus lands on the chrome's first control forward, its last backward – the document's own
 * order, `@shared/focusEdge`, less what is `inert` or hidden from the tree (a bar that is away).
 * The Tab was the keyboard's, so it is the last input (`data-input`): the landing draws the
 * shared ring, as the same Tab pressed inside the chrome would. The control landed on, or null
 * in a chrome with nothing to land on (the keyboard then rests on the document).
 */
export function pageHandedKeyboard(
  direction: 'forward' | 'backward',
  doc: Document = document
): HTMLElement | null {
  noteInput('keyboard', doc.documentElement)
  return focusEdge(direction === 'forward' ? 'first' : 'last', doc)
}

/**
 * A page's view took the keyboard: the chrome's focused control, if any, is stale – it would
 * keep its focus ring while the user types in the page, and count as the keyboard's place for
 * the next F6 – so it is blurred. Returns whether anything was let go.
 */
export function releaseChromeFocus(doc: Document = document): boolean {
  const active = doc.activeElement
  if (!(active instanceof HTMLElement) || active === doc.body) return false
  active.blur()
  return true
}

/**
 * A page's view took the keyboard (`focus.page`, the view of tab `tabId`). The chrome's focused
 * control is let go ({@link releaseChromeFocus}) – except the open URL bar's field. The rule: a
 * chrome field the user is typing in is never blurred by a page taking the keyboard. The bar is
 * the one such field, because it is a surface over the page: while it is up the page beneath
 * lies hidden under its snapshot and cannot be pressed, so a page taking the keyboard is never
 * the user leaving the field. It is the new tab's own view taking the keyboard as it is shown –
 * a race with the bar's mount that a slow machine loses: the blur landing after the field's
 * focus left the bar standing with no caret, and what was typed went nowhere (#342 met it in
 * CI). So the field is not blurred, and the bar is told to take the keyboard back – the
 * chrome's focus and its field's ({@link URLBAR_KEYBOARD_EVENT}) – so the caret is there
 * whichever came first. The find bar and a Settings field are not the bar's case: the page
 * beside them is live, a view taking the keyboard there is the user's press, and the blur is
 * what keeps their focus ring honest. The empty split pane's bar (`urlbar.pane`) sits beside
 * live panes the same way: a sibling page taking the keyboard is the user's press and the field
 * is let go as any control; the pane's own blank page taking it is the race. Returns what was
 * done: `kept` (the bar's), `released` (a control was blurred), `none`.
 */
export function pageTookKeyboard(
  tabId: string,
  doc: Document = document
): 'kept' | 'released' | 'none' {
  const { urlbar } = uiStore.get()
  if (urlbar.open && (!urlbar.pane || urlbar.tabId === tabId)) {
    doc.defaultView?.dispatchEvent(new CustomEvent(URLBAR_KEYBOARD_EVENT))
    return 'kept'
  }
  return releaseChromeFocus(doc) ? 'released' : 'none'
}

/**
 * Where Tab out of the open URL bar lands (omnibox-50, Chrome's Tab past the popup's last row):
 * the toolbar control after the address (`next`) or before it (`prev`), in the navigation row,
 * not the bar's own root; the row's first or last control when the address is not in it. Null
 * with no toolbar row on screen.
 */
export function toolbarControlBesideAddress(
  move: 'next' | 'prev',
  doc: Document = document
): HTMLElement | null {
  const row = paneRoots('toolbar', doc).find((root) => 'zenNavRow' in root.dataset)
  if (!row) return null
  const controls = focusablesIn(row)
  if (controls.length === 0) return null
  const inAddress = (el: HTMLElement): boolean =>
    el.closest('[role="group"][aria-label="Address"]') !== null
  if (move === 'next') {
    const last = controls.map(inAddress).lastIndexOf(true)
    return controls[last + 1] ?? controls[0] ?? null
  }
  const first = controls.findIndex(inAddress)
  return (first > 0 ? controls[first - 1] : controls[controls.length - 1]) ?? null
}

/** The first control of `pane` on screen (Shift+Alt+T: the toolbar's back button when enabled). */
export function paneFirstControl(pane: PaneId, doc: Document = document): HTMLElement | null {
  for (const root of paneRoots(pane, doc)) {
    const [first] = focusablesIn(root)
    if (first) return first
  }
  return null
}

/**
 * Move the keyboard as a pane shortcut asked. Into a chrome pane: the chrome takes the keyboard
 * (`focus.chrome`) and the pane's target is focused; into the page: the active view takes it
 * (`focus.content`). Leaving the toolbar puts its URL bar away. A named pane that is not on
 * screen leaves the keyboard where it is (Chrome's Shift+Alt+B with the bar hidden does nothing).
 */
export function focusPane(request: FocusPaneRequest, doc: Document = document): PaneId | null {
  const from = currentPane(doc, 'move' in request ? request.from : 'chrome')
  let to: PaneId
  let target: HTMLElement | null
  if ('move' in request) {
    to = nextPane(from, shownPanes(doc), request.move)
    target = paneTarget(to, doc)
  } else {
    to = request.pane
    target = to === 'toolbar' ? paneFirstControl(to, doc) : paneTarget(to, doc)
    if (!target) return null
  }
  const leavesUrlbar = from === 'toolbar' && to !== 'toolbar' && uiStore.get().urlbar.open
  if (to === 'page') {
    if (leavesUrlbar) leaveUrlbar(doc)
    // The keyboard leaves the chrome for the page: nothing of the chrome keeps a focus ring.
    if (doc.activeElement instanceof HTMLElement) doc.activeElement.blur()
    run('focus.content', undefined)
    return to
  }
  if (!target) return null
  run('focus.chrome', undefined)
  target.focus()
  // After the target has the keyboard: the bar closing must not ask for the page's focus, which
  // would arrive later and take the keyboard back off the target.
  if (leavesUrlbar) leaveUrlbar(doc)
  return to
}

/** Close the open URL bar as the bar itself does on Escape; directly when no bar is listening. */
function leaveUrlbar(doc: Document): void {
  doc.defaultView?.dispatchEvent(new CustomEvent(URLBAR_LEAVE_EVENT))
  if (uiStore.get().urlbar.open) closeUrlbar({ keepKeyboard: true })
}
