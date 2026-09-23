/**
 * Whether a page's text field has the keyboard (history-14).
 *
 * macOS gives ⌘← and ⌘→ two jobs: Back and Forward in the browser, line start and line end in
 * a text field. Chrome settles it by letting the renderer see the key first – a field consumes
 * it, a page without one does not and the browser goes back. Zenium matches its shortcut table
 * in the browser before the page sees the key (`KeyboardHandler`), so the page says ahead of
 * time instead: whenever the keyboard settles on something in this document, whether that is a
 * text field. The browser leaves the caret's chords to a document that says so
 * (`KeyboardHandler.setEditing`).
 *
 * A frame speaks for its own document alone, and only while it holds the keyboard: the frame
 * gaining it reports, the one losing it says nothing (it cannot tell where the keyboard went –
 * the chrome, another frame), so the last report always comes from the frame that has it. The
 * keyboard resting on a nested frame's element is that frame's document to report.
 *
 * Runs in the Electron preload of every frame; the Android host does not install it (its keys
 * do not come through the table with ⌘).
 */

export interface EditingFocusTransport {
  /** Whether a text field of this document has the keyboard. */
  send(editing: boolean): void
}

/** `<input>` types the keyboard does not type text into. */
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit'
])

/** Whether the keyboard on `el` types text: a text-like input, a textarea or editable content. */
export function isEditingElement(el: Element | null): boolean {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(el.type)
  return el instanceof HTMLElement && el.isContentEditable
}

/** Focus on one of these means the keyboard is in another document, whose script reports. */
const NESTED_CONTEXT_TAGS = new Set(['iframe', 'frame', 'object', 'embed'])

function isNestedContext(el: Element): boolean {
  return NESTED_CONTEXT_TAGS.has(el.localName)
}

/**
 * Report, after every change of focus that leaves the keyboard in this document, whether it
 * is on a text field. One report per change: the events of a focus move (`focusout`, then
 * `focusin`) are read together once they have settled. Returns the uninstaller.
 */
export function installEditingFocusReporter(
  transport: EditingFocusTransport,
  doc: Document = document
): () => void {
  const win = doc.defaultView
  let timer: ReturnType<typeof setTimeout> | null = null
  const report = (): void => {
    timer = null
    if (!doc.hasFocus()) return
    const active = doc.activeElement
    if (active && isNestedContext(active)) return
    transport.send(isEditingElement(active))
  }
  const schedule = (): void => {
    if (timer === null) timer = setTimeout(report, 0)
  }
  doc.addEventListener('focusin', schedule, true)
  doc.addEventListener('focusout', schedule, true)
  // The frame gained the keyboard (back from the chrome, or from another frame); a document
  // shown again from the back-forward cache reports its state anew.
  win?.addEventListener('focus', schedule)
  win?.addEventListener('pageshow', schedule)
  schedule()
  return () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    doc.removeEventListener('focusin', schedule, true)
    doc.removeEventListener('focusout', schedule, true)
    win?.removeEventListener('focus', schedule)
    win?.removeEventListener('pageshow', schedule)
  }
}
