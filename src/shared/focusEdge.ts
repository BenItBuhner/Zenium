/**
 * Where a hardware keyboard's Tab lands as it enters a document from outside it (A11Y-09's
 * remainder, page-to-chrome Tab traversal on the phone): the document's first tabbable control
 * for a Tab, its last for a Shift+Tab. The Android host hands the focus between a page's WebView
 * and the chrome's when Tab runs past a document's end (`FocusHandoff.kt`); the document it
 * lands in reads its own order here – the chrome from the host's `focus.fromPage` event, a page
 * from the `focus` message its page script receives – because the WebView gives a document the
 * focus without placing it (`setNeedInitialFocus` off) or on its first node only.
 *
 * The order is sequential focus navigation's as far as a script can read it: what Tab reaches
 * – links, form controls, frames, `summary`, media with controls, anything with a `tabindex`
 * or editable – less what it skips: a negative `tabindex`, a disabled control, `input
 * type=hidden`, an element with no box on screen (`display: none`, a closed `details`) or
 * hidden, and what lies under `inert` or `aria-hidden` (Tab reaches an `aria-hidden` control in
 * a browser; landing on one from outside is what a screen reader's user would not expect, and
 * the chrome's own hidden-bar rule). A positive `tabindex` goes first, ascending, then the rest
 * in document order. A radio group counts every button, where the browser stops at its checked
 * one; shadow roots and other frames' documents are not opened (a frame element stands for its
 * document).
 */

export type FocusEdge = 'first' | 'last'

/** Browser → page message: land the focus on the document's first or last tabbable (Tab into the page). */
export interface FocusEdgeHostMessage {
  type: 'focus'
  edge: FocusEdge
}

const TABBABLE = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'iframe',
  'summary',
  'audio[controls]',
  'video[controls]',
  '[tabindex]',
  '[contenteditable]:not([contenteditable="false"])'
].join(', ')

function tabIndexOf(element: Element): number {
  const raw = element.getAttribute('tabindex')
  if (raw === null) return 0
  const value = Number.parseInt(raw, 10)
  return Number.isNaN(value) ? 0 : value
}

function disabled(element: Element): boolean {
  if ((element as { disabled?: unknown }).disabled === true) return true
  // A control under a disabled fieldset is disabled too (its first legend's controls aside).
  const fieldset = element.closest('fieldset[disabled]')
  return fieldset !== null && element.closest('legend')?.parentElement !== fieldset
}

function tabbable(element: HTMLElement): boolean {
  if (tabIndexOf(element) < 0) return false
  if (disabled(element)) return false
  if (element instanceof HTMLInputElement && element.type === 'hidden') return false
  if (element.closest('[inert], [aria-hidden="true"]')) return false
  if (element.getClientRects().length === 0) return false
  const view = element.ownerDocument.defaultView
  return view === null || view.getComputedStyle(element).visibility !== 'hidden'
}

/** The document's (or `root`'s) tabbable controls in sequential focus order, as far as a script reads it. */
export function tabbablesIn(root: ParentNode): HTMLElement[] {
  const all = [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(tabbable)
  const positive = all
    .filter((element) => tabIndexOf(element) > 0)
    .sort((a, b) => tabIndexOf(a) - tabIndexOf(b))
  return [...positive, ...all.filter((element) => tabIndexOf(element) === 0)]
}

/** The control at `edge` of the order, or null in a document with nothing to land on. */
export function edgeControl(edge: FocusEdge, root: ParentNode): HTMLElement | null {
  const order = tabbablesIn(root)
  return (edge === 'first' ? order[0] : order[order.length - 1]) ?? null
}

/**
 * Land the focus on the control at `edge` of the order (scrolling it into view, as Tab does);
 * the control, or null when the document has none.
 */
export function focusEdge(edge: FocusEdge, root: ParentNode): HTMLElement | null {
  const target = edgeControl(edge, root)
  target?.focus()
  return target
}
