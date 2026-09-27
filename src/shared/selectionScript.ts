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
 * THE GESTURE RULE. A menu is raised by a gesture alone – the `pointerup` / `keyup` ending a
 * press that began in this document – and only when that gesture made or changed the
 * selection: the selection is snapshotted (a text control's bounds, or the range's ends and its
 * text) as the pointer or the key goes down and measured against the selection standing at the
 * up. The same selection merely persisting through an unrelated click or key raises nothing;
 * a selection a script made (`Selection.addRange`, `selectAllChildren`, a text control's
 * `select()` on load, a find match) raises nothing on its own; an up whose down the page never
 * saw (the key went down in the chrome, the press began in another window) raises nothing. So
 * a page cannot summon the browser's menu or choose where it stands. `selectionchange` alone
 * only maintains a menu a gesture raised: the fresh box when a script or a selection handle
 * moves the standing selection, the empty report when it collapses. What is sent at the
 * settle is always read fresh (`currentSelectionReport`) – the snapshot is compared, never
 * sent. This is Blink's own rule for its selection handles: `SetSelectionOptions`'
 * `should_show_handle_` is false by default (`third_party/blink/renderer/core/editing/
 * set_selection_options.h:53`), every DOM API path in `dom_selection.cc` passes the default
 * (`:319`, `:325`, `:351`, `:358`), and only `SelectionController`'s pointer and gesture paths
 * set it (`selection_controller.cc:622` a tap inside the selection, `:1054` / `:1062` the caret
 * and the word from a hit test) – so Chromium for Android's selection action mode, which
 * follows the handle events (`SelectionPopupControllerImpl.java`), never shows for a script's
 * selection.
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

/**
 * Cut, fold, cut: a Select All on a long page is megabytes, and the fold's regex need not walk
 * what the cap drops – the first cut is generous so the fold has room to shrink the text.
 */
function foldText(text: string): string {
  return text
    .slice(0, SELECTION_REPORT_MAX_CHARS * 4)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SELECTION_REPORT_MAX_CHARS)
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

/** What is selected: a text control's own selection, or the document's first range. */
type Selected =
  | { kind: 'field'; field: HTMLInputElement | HTMLTextAreaElement; start: number; end: number }
  | { kind: 'range'; selection: Selection; range: Range }

/**
 * What is selected in `doc` right now, or null when nothing is: a text field's own selection
 * (`selectionStart` / `selectionEnd`, which the document's `Selection` does not carry), else the
 * document's first non-collapsed range. A password field's selection is nobody's business and
 * reads as nothing.
 */
function selected(doc: Document): Selected | null {
  const active = doc.activeElement
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    if (active instanceof HTMLInputElement && active.type === 'password') return null
    const start = active.selectionStart
    const end = active.selectionEnd
    if (start !== null && end !== null && end > start) {
      return { kind: 'field', field: active, start, end }
    }
  }
  const selection = doc.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  return { kind: 'range', selection, range: selection.getRangeAt(0) }
}

/**
 * The selection as a report: a text field's with the field's box, else the range's with its
 * bounding box. Null when nothing is selected (or the selection folds to nothing).
 */
export function currentSelectionReport(doc: Document): SelectionReport | null {
  const current = selected(doc)
  if (!current) return null
  if (current.kind === 'field') {
    const text = foldText(current.field.value.slice(current.start, current.end))
    if (!text) return null
    return { text, rect: rectOf(current.field.getBoundingClientRect()), isEditable: true }
  }
  const text = foldText(current.selection.toString())
  if (!text) return null
  const anchor = current.selection.anchorNode
  const element =
    anchor && anchor.nodeType === 1 ? (anchor as Element) : (anchor?.parentElement ?? null)
  return {
    text,
    rect: rectOf(current.range.getBoundingClientRect()),
    isEditable: isEditingElement(element)
  }
}

/**
 * The selection as a gesture is measured against (the gesture rule): a text control's selection
 * by the control and its bounds, a range by its ends and its text. Compared, never sent.
 */
interface SelectionSnapshot {
  field: Element | null
  startContainer: Node | null
  startOffset: number
  endContainer: Node | null
  endOffset: number
  text: string
}

function selectionSnapshot(doc: Document): SelectionSnapshot | null {
  const current = selected(doc)
  if (!current) return null
  if (current.kind === 'field') {
    return {
      field: current.field,
      startContainer: null,
      startOffset: current.start,
      endContainer: null,
      endOffset: current.end,
      text: foldText(current.field.value.slice(current.start, current.end))
    }
  }
  const { range } = current
  return {
    field: null,
    startContainer: range.startContainer,
    startOffset: range.startOffset,
    endContainer: range.endContainer,
    endOffset: range.endOffset,
    text: foldText(current.selection.toString())
  }
}

function sameSelection(a: SelectionSnapshot | null, b: SelectionSnapshot | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.field === b.field &&
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset &&
    a.text === b.text
  )
}

/**
 * Report the document's selection as a gesture settles on it and its going (see the module's
 * note). Returns the uninstaller. Installs in the top document alone.
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
  /**
   * A gesture raised the menu over the selection that stands, and it is owed back after a
   * scroll's hide: `selectionchange` and a scroll maintain it. Nothing but a gesture sets it.
   */
  let owed = false
  /** The pointer is down: a drag in progress settles at its up, not before. */
  let pointerDown = false
  /**
   * The selection as it stood when the pointer or the key went down, for the up to measure
   * against; `undefined` while no press begun in this document is in flight.
   */
  let gestureStart: SelectionSnapshot | null | undefined

  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  /** The menu goes now (the report about to be sent with it); `owed` stands – a scroll's hide. */
  const hide = (): void => {
    cancel()
    if (!reported) return
    reported = false
    transport.send(EMPTY_REPORT)
  }
  /** The menu goes and is not owed back: the selection collapsed, the pointer went down, the page went. */
  const drop = (): void => {
    owed = false
    hide()
  }
  /** The settle: the selection read fresh – never the snapshot – and sent. */
  const report = (): void => {
    timer = null
    if (!owed) return
    const current = currentSelectionReport(doc)
    if (!current) {
      drop()
      return
    }
    reported = true
    transport.send(current)
  }
  const schedule = (): void => {
    cancel()
    timer = setTimeout(report, SELECTION_REPORT_DEBOUNCE_MS)
  }

  /**
   * The gesture ended. Measured against its start, the selection it made or changed is
   * reported once it settles; one it left as it stood – a script's, or the user's own from
   * before, persisting through an unrelated click or key – raises nothing; none left clears.
   * An up without a down seen here (the key went down in the chrome, the press began in another
   * window) is no gesture of this document's.
   */
  const settleGesture = (): void => {
    const start = gestureStart
    gestureStart = undefined
    if (start === undefined) return
    const now = selectionSnapshot(doc)
    if (now === null) {
      drop()
      return
    }
    if (sameSelection(start, now)) return
    owed = true
    schedule()
  }

  /**
   * The selection changed or collapsed. A standing menu follows it (a script's change, a
   * selection handle dragged, the shift-arrow before its key comes up: the fresh box at the
   * settle) and goes with its collapse; one that does not stand is not raised by this – a
   * page's script may select what it likes and no menu comes of it.
   */
  const onSelectionChange = (): void => {
    if (selected(doc) === null) {
      drop()
      return
    }
    if (owed && !pointerDown) schedule()
  }
  const onPointerDown = (event: Event): void => {
    // The mouse events follow the pointer events for one press: one snapshot, one drop.
    if (pointerDown && event.type === 'mousedown') return
    pointerDown = true
    gestureStart = selectionSnapshot(doc)
    drop()
  }
  const onPointerUp = (): void => {
    if (!pointerDown) return
    pointerDown = false
    settleGesture()
  }
  const onKeyDown = (): void => {
    gestureStart = selectionSnapshot(doc)
  }
  const onKeyUp = (): void => {
    settleGesture()
  }
  /**
   * The page scrolled or the viewport changed: the box reported is stale, so the menu goes now
   * and comes back over the selection once the movement settles (Chromium's Android controller
   * hides its selection popups through a scroll and restores them after; Edge's mini menu goes
   * on scroll). Nothing is read while no menu is owed.
   */
  const onMoved = (): void => {
    if (!owed) return
    hide()
    if (!pointerDown) schedule()
  }
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') drop()
  }
  /**
   * The keyboard left the page – the chrome's field took it, the menu's own document, another
   * window: a press begun here ends elsewhere, and its up is not this document's gesture. The
   * standing menu is the browser's to clear (`SelectionMenuService.onWindowBlur` for the
   * window's blur; the chrome taking the keyboard leaves the model alone).
   */
  const onBlur = (): void => {
    gestureStart = undefined
    pointerDown = false
  }

  // Capture on the window: a page's own handlers may stop a key's or a pointer's propagation,
  // and the gesture must be seen whatever the page does with it. Passive: nothing here is ever
  // prevented – the page's defaults stand.
  const listen = { capture: true, passive: true } as const
  doc.addEventListener('selectionchange', onSelectionChange, listen)
  win.addEventListener('pointerdown', onPointerDown, listen)
  win.addEventListener('mousedown', onPointerDown, listen)
  win.addEventListener('pointerup', onPointerUp, listen)
  win.addEventListener('mouseup', onPointerUp, listen)
  win.addEventListener('pointercancel', onPointerUp, listen)
  win.addEventListener('keydown', onKeyDown, listen)
  win.addEventListener('keyup', onKeyUp, listen)
  win.addEventListener('scroll', onMoved, listen)
  win.addEventListener('resize', onMoved, listen)
  win.addEventListener('blur', onBlur)
  win.addEventListener('pagehide', drop)
  doc.addEventListener('visibilitychange', onVisibility)
  return () => {
    cancel()
    reported = false
    owed = false
    gestureStart = undefined
    doc.removeEventListener('selectionchange', onSelectionChange, listen)
    win.removeEventListener('pointerdown', onPointerDown, listen)
    win.removeEventListener('mousedown', onPointerDown, listen)
    win.removeEventListener('pointerup', onPointerUp, listen)
    win.removeEventListener('mouseup', onPointerUp, listen)
    win.removeEventListener('pointercancel', onPointerUp, listen)
    win.removeEventListener('keydown', onKeyDown, listen)
    win.removeEventListener('keyup', onKeyUp, listen)
    win.removeEventListener('scroll', onMoved, listen)
    win.removeEventListener('resize', onMoved, listen)
    win.removeEventListener('blur', onBlur)
    win.removeEventListener('pagehide', drop)
    doc.removeEventListener('visibilitychange', onVisibility)
  }
}
