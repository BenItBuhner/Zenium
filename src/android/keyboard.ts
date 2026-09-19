/**
 * The soft keyboard for the chrome's own fields, on the device (the preview host has the
 * browser's). The WebView raises it on a focus change into an editable element within a tap's
 * user-gesture window; the chrome focuses its fields (URL bar, rename, settings) programmatically
 * after an async snapshot, outside that window, so `focusin` asks the host for it and `focusout`
 * – to nothing editable – asks the host to take it down.
 *
 * And the busy form of §9.30: its fields go read-only while the value is applied and Chromium
 * hides the keyboard for a read-only field (its text input type is none). Refused, the field
 * clears, turns editable again and takes the focus – but it has the focus already, so that
 * `focus()` is a no-op, no `focusin` fires and Chromium shows the keyboard on a focus CHANGE
 * alone: the field would stay focused with no keyboard to type into. So the focused field is
 * watched for its `readonly` going, and once it is editable again and still focused, the next
 * frame blurs and refocuses it in one breath – a real focus change, in the WebView's eyes and
 * ours (`focusin` asks the host). The blur of that swap is the policy's own: it asks for no
 * hiding. One place for every surface, and none for a mouse: the desktop never runs this.
 */

export type KeyboardMessage = 'chrome.showKeyboard' | 'chrome.hideKeyboard'

type Field = HTMLInputElement | HTMLTextAreaElement

const isEditable = (el: EventTarget | null): el is Field =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement

/**
 * Install the policy on `doc`; `send` carries a message to the host. Returns the uninstall.
 */
export function installKeyboardPolicy(
  send: (message: KeyboardMessage) => void,
  doc: Document = document
): () => void {
  let watched: Field | null = null
  /** The watched field has been seen read-only: the keyboard went with that. */
  let held = false
  let frame: number | null = null
  let swapping = false

  function unwatch(): void {
    observer.disconnect()
    watched = null
    held = false
    if (frame !== null) {
      cancelAnimationFrame(frame)
      frame = null
    }
  }

  /** The watched field's `readonly` went while it kept the focus: swap the focus next frame. */
  function released(): void {
    const field = watched
    if (!field || frame !== null) return
    frame = requestAnimationFrame(() => {
      frame = null
      if (doc.activeElement !== field || field.readOnly || field.disabled) return
      swapping = true
      try {
        field.blur()
        field.focus({ preventScroll: true })
      } finally {
        swapping = false
      }
      // The field did not take the focus back: the keyboard has nothing to serve.
      if (doc.activeElement !== field) {
        unwatch()
        send('chrome.hideKeyboard')
      }
    })
  }

  // Read-only arriving is the keyboard going, Chromium's doing; what matters is its going
  // after that, while the field is still the one focused.
  const observer = new MutationObserver(() => {
    const field = watched
    if (!field) return
    if (field.readOnly) held = true
    else if (held) {
      held = false
      released()
    }
  })

  function watch(field: Field): void {
    unwatch()
    watched = field
    held = field.readOnly
    observer.observe(field, { attributes: true, attributeFilter: ['readonly'] })
  }

  const onFocusIn = (e: FocusEvent): void => {
    if (!isEditable(e.target)) return
    send('chrome.showKeyboard')
    watch(e.target)
  }
  const onFocusOut = (e: FocusEvent): void => {
    if (!isEditable(e.target) || swapping) return
    unwatch()
    if (!isEditable(e.relatedTarget)) send('chrome.hideKeyboard')
  }
  doc.addEventListener('focusin', onFocusIn)
  doc.addEventListener('focusout', onFocusOut)
  return () => {
    unwatch()
    doc.removeEventListener('focusin', onFocusIn)
    doc.removeEventListener('focusout', onFocusOut)
  }
}
