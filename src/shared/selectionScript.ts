/**
 * The page's word on what text is selected (CT-39, the mini menu over a selection).
 *
 * Edge's mini menu comes up once the pointer or the keyboard has settled on a non-collapsed
 * selection – the `mouseup` / `keyup` after the drag or the shift-arrows – and goes as the
 * selection collapses, as the pointer goes down again or as the page scrolls (the browser
 * itself takes it down when its window loses the keyboard). This script tells the browser
 * exactly that and nothing more: one report per settled selection
 * (`SELECTION_REPORT_DEBOUNCE_MS` after the last event) with the text (whitespace folded, cut at
 * `SELECTION_REPORT_MAX_CHARS`), the selection's bounding box in the viewport's CSS pixels and
 * whether it is a text field's; one empty report (`text: ''`) when a reported selection is gone
 * or should stop being shown; and, after a scroll or a resize settles with the selection still
 * there, the report again with the fresh box. Nothing is read or sent while nothing is
 * selected: a caret's every move fires `selectionchange`, and each one costs the `isCollapsed`
 * check alone.
 *
 * The top document alone: a frame's rect is the frame's, which this world cannot place in the
 * page (a cross-origin frame does not know its own offset), so a selection inside an iframe has
 * no mini menu. Runs in the Electron preload; the Android host does not install it – its
 * system toolbar is the phone's selection menu (`Menus.selectionToolbar`).
 */

import { isEditingElement } from './editingFocus'

/** The selection's bounding box in the viewport's CSS pixels. */
export interface SelectionRect {
  x: number
  y: number
  width: number
  height: number
}

export interface SelectionReport {
  /**
   * The selected text with whitespace runs folded to one space, trimmed and cut at
   * `SELECTION_REPORT_MAX_CHARS`; `''` says a reported selection is gone (the menu closes).
   */
  text: string
  /** Where the selection is, in the viewport's CSS pixels; null with `text: ''`. */
  rect: SelectionRect | null
  /** Whether the selection is a text field's (an `<input>`, a `<textarea>`, editable content). */
  isEditable: boolean
}

export interface SelectionReporterTransport {
  send(report: SelectionReport): void
}

/** How long after the last pointer / keyboard / selection event the selection counts as settled. */
export const SELECTION_REPORT_DEBOUNCE_MS = 150

/** The most characters a report carries: a search, a definition or a translation needs no more. */
export const SELECTION_REPORT_MAX_CHARS = 1000

const EMPTY_REPORT: SelectionReport = { text: '', rect: null, isEditable: false }

function foldText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, SELECTION_REPORT_MAX_CHARS)
}

function rectOf(box: { left: number; top: number; width: number; height: number }): SelectionRect {
  const round = (v: number): number => Math.round(v * 100) / 100
  return {
    x: round(box.left),
    y: round(box.top),
    width: round(box.width),
    height: round(box.height)
  }
}

/**
 * What is selected in `doc` right now, or null when nothing is: a text field's own selection
 * (`selectionStart` / `selectionEnd`, which the document's `Selection` does not carry) with the
 * field's box, else the document's first range with its bounding box. A password field's
 * selection is nobody's business and reads as nothing.
 */
export function currentSelectionReport(doc: Document): SelectionReport | null {
  const active = doc.activeElement
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    if (active instanceof HTMLInputElement && active.type === 'password') return null
    const start = active.selectionStart
    const end = active.selectionEnd
    if (start !== null && end !== null && end > start) {
      const text = foldText(active.value.slice(start, end))
      if (!text) return null
      return { text, rect: rectOf(active.getBoundingClientRect()), isEditable: true }
    }
  }
  const selection = doc.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const text = foldText(selection.toString())
  if (!text) return null
  const range = selection.getRangeAt(0)
  const anchor = selection.anchorNode
  const element =
    anchor && anchor.nodeType === 1 ? (anchor as Element) : (anchor?.parentElement ?? null)
  return {
    text,
    rect: rectOf(range.getBoundingClientRect()),
    isEditable: isEditingElement(element)
  }
}

/**
 * Report the document's selection as it settles and its going (see the module's note). Returns
 * the uninstaller. Installs in the top document alone.
 */
export function installSelectionReporter(
  transport: SelectionReporterTransport,
  doc: Document = document
): () => void {
  const win = doc.defaultView
  if (!win) return () => undefined
  try {
    if (win.top !== win) return () => undefined
  } catch {
    return () => undefined
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  /** Whether the last report sent carried a selection (so its going owes one empty report). */
  let reported = false
  /** The pointer is down: a drag in progress settles at its up, not before. */
  let pointerDown = false

  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const hide = (): void => {
    cancel()
    if (!reported) return
    reported = false
    transport.send(EMPTY_REPORT)
  }
  const report = (): void => {
    timer = null
    const current = currentSelectionReport(doc)
    if (!current) {
      hide()
      return
    }
    reported = true
    transport.send(current)
  }
  const schedule = (): void => {
    cancel()
    timer = setTimeout(report, SELECTION_REPORT_DEBOUNCE_MS)
  }
  const hasSelection = (): boolean => {
    const active = doc.activeElement
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      const start = active.selectionStart
      const end = active.selectionEnd
      if (start !== null && end !== null && end > start) return true
    }
    const selection = doc.getSelection()
    return selection !== null && selection.rangeCount > 0 && !selection.isCollapsed
  }

  const onSelectionChange = (): void => {
    if (!hasSelection()) {
      hide()
      return
    }
    if (!pointerDown) schedule()
  }
  const onPointerDown = (): void => {
    pointerDown = true
    hide()
  }
  const onPointerUp = (): void => {
    pointerDown = false
    if (hasSelection()) schedule()
  }
  const onKeyUp = (): void => {
    if (hasSelection()) schedule()
    else hide()
  }
  /**
   * The page scrolled or the viewport changed: the box reported is stale, so the menu goes now
   * and comes back over the selection once the movement settles (Chromium's Android controller
   * hides its selection popups through a scroll and restores them after; Edge's mini menu goes
   * on scroll). Nothing is read while nothing is selected.
   */
  const onMoved = (): void => {
    if (!hasSelection()) return
    hide()
    if (!pointerDown) schedule()
  }
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') hide()
  }

  // Not the window's `blur`: the chrome taking the keyboard (a chip of the menu pressed, the
  // address bar) blurs the page while the selection stands; the browser clears the model when
  // its window loses the keyboard (`SelectionMenuService.onWindowBlur`).
  const passive = { capture: true, passive: true } as const
  doc.addEventListener('selectionchange', onSelectionChange, passive)
  win.addEventListener('pointerdown', onPointerDown, passive)
  win.addEventListener('mousedown', onPointerDown, passive)
  win.addEventListener('pointerup', onPointerUp, passive)
  win.addEventListener('mouseup', onPointerUp, passive)
  win.addEventListener('pointercancel', onPointerUp, passive)
  win.addEventListener('keyup', onKeyUp, passive)
  win.addEventListener('scroll', onMoved, passive)
  win.addEventListener('resize', onMoved, passive)
  win.addEventListener('pagehide', hide)
  doc.addEventListener('visibilitychange', onVisibility)
  return () => {
    cancel()
    reported = false
    doc.removeEventListener('selectionchange', onSelectionChange, passive)
    win.removeEventListener('pointerdown', onPointerDown, passive)
    win.removeEventListener('mousedown', onPointerDown, passive)
    win.removeEventListener('pointerup', onPointerUp, passive)
    win.removeEventListener('mouseup', onPointerUp, passive)
    win.removeEventListener('pointercancel', onPointerUp, passive)
    win.removeEventListener('keyup', onKeyUp, passive)
    win.removeEventListener('scroll', onMoved, passive)
    win.removeEventListener('resize', onMoved, passive)
    win.removeEventListener('pagehide', hide)
    doc.removeEventListener('visibilitychange', onVisibility)
  }
}
