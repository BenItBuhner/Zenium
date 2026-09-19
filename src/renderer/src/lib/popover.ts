/*
 * The keyboard side of the renderer's popovers (v2 draft §9.22). One popover at a time and light
 * dismiss are the chrome layer's (lib/popoverStore.ts, through `useLightDismiss`).
 */

/**
 * Whether the popover about to open was reached with the keyboard: the control that has focus
 * shows its focus ring (`:focus-visible`), which a pointer click on it would not have given it.
 * A menu then focuses its first item rather than itself, and the page – which did not have
 * focus – does not get it back when the popover closes (§9.22).
 */
export function openedFromKeyboard(): boolean {
  return document.activeElement?.matches(':focus-visible') ?? false
}

/** Focusable descendants in tab order, as Tab would visit them. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  const selector =
    'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
  return [...root.querySelectorAll<HTMLElement>(selector)].filter(
    (el) => !el.hidden && el.getAttribute('aria-hidden') !== 'true' && el.tabIndex >= 0
  )
}

/**
 * Tab wraps inside `root` while a popover, dialog or sheet is open (§9.22): a press at the last
 * focusable goes to the first, Shift+Tab at the first to the last, and one from outside the root
 * enters it at the end the key heads for. A step within the root is the browser's; with nothing
 * focusable inside, the key does nothing.
 */
export function wrapTab(root: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== 'Tab') return
  const items = focusableIn(root)
  if (items.length === 0) {
    e.preventDefault()
    return
  }
  const current = document.activeElement
  const index = current instanceof HTMLElement ? items.indexOf(current) : -1
  let next: HTMLElement | undefined
  if (index === -1 || !root.contains(current)) next = e.shiftKey ? items.at(-1) : items[0]
  else if (e.shiftKey && index === 0) next = items.at(-1)
  else if (!e.shiftKey && index === items.length - 1) next = items[0]
  if (!next) return
  e.preventDefault()
  next.focus()
}

/** An element the keyboard comes up for when it takes the focus: a text field of any kind. */
export function isTextField(el: Element): el is HTMLElement {
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement)
    return !/^(button|checkbox|radio|range|submit|reset|file|color|image|hidden)$/.test(el.type)
  return el instanceof HTMLElement && el.isContentEditable
}

/** The option a picker or menu opens on: checked, selected or current (a checkbox is a setting, not an option). */
const CHECKED =
  '[aria-checked="true"], [aria-selected="true"], [aria-current]:not([aria-current="false"]), input[type="radio"]:checked'

/**
 * What takes the focus as a phone sheet opens (§9.22, §9.24): the option that is checked or
 * selected, so a picker opens on its current value; else the first row or focusable control of
 * the body that is not a text field – a field would bring the keyboard up with the sheet, so a
 * form's first focus is its first button, Cancel – else such a control in the sheet's header;
 * else the dialog itself (`tabIndex -1`), for a sheet that is all notice. The grabber is first
 * in the tab order but never the first focus. `sheet` is the dialog element, `body` its
 * scrolling content.
 */
export function sheetInitialFocus(sheet: HTMLElement, body: HTMLElement): HTMLElement {
  const inBody = focusableIn(body)
  const checked = body.querySelector(CHECKED)
  if (checked) {
    const option = inBody.find(
      (el) => el === checked || el.contains(checked) || checked.contains(el)
    )
    if (option) return option
  }
  const control = (list: HTMLElement[]): HTMLElement | undefined =>
    list.find((el) => !isTextField(el))
  const inHeader = focusableIn(sheet).filter(
    (el) => !body.contains(el) && !el.closest('.zen-sheet-handle-hit')
  )
  return control(inBody) ?? control(inHeader) ?? sheet
}
