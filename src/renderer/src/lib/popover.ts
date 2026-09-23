/*
 * The keyboard side of the renderer's popovers (v2 draft §9.22) and the anchor's `aria-expanded`
 * (§9.20). One popover at a time and light dismiss are the chrome layer's (lib/popoverStore.ts,
 * through `useLightDismiss`).
 */

/**
 * `aria-expanded` on the control a popover hangs from, held for the popover's life – the anchor
 * wears its pressed fill and says what it has open while the popover stands (§9.20) – and given
 * back when it leaves. A count, not a flag: one anchor can carry two surfaces. The sidebar's
 * "⋯" has the app menu and, while the hub's toolbar button has folded (§9.29), the media hub's
 * popover too, which opens from the menu's own "Now Playing…" row as the menu leaves – so the
 * first hold sets the attribute, the last release puts back what the anchor said at rest (the
 * hub button's own `false`, nothing on the "⋯"), and a surface leaving while another still
 * stands changes nothing. One source of truth per anchor: nothing else writes `aria-expanded`
 * on a control held here.
 */
const holds = new WeakMap<Element, { count: number; rest: string | null }>()

export function holdExpanded(anchor: HTMLElement): () => void {
  const hold = holds.get(anchor) ?? { count: 0, rest: anchor.getAttribute('aria-expanded') }
  hold.count += 1
  holds.set(anchor, hold)
  anchor.setAttribute('aria-expanded', 'true')
  let released = false
  return () => {
    if (released) return
    released = true
    hold.count -= 1
    if (hold.count > 0) return
    holds.delete(anchor)
    if (hold.rest === null) anchor.removeAttribute('aria-expanded')
    else anchor.setAttribute('aria-expanded', hold.rest)
  }
}

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

/** How long a refused return waits for the inert to lift before it is given up. */
const RETURN_WAIT_MS = 1000

/**
 * Give `target` the focus back as a popover or dialog leaves (§9.22, §9.24): now, or once it
 * can take it. A control inside an `inert` subtree refuses the focus, and it would fall to
 * `body` with the panel: the frame dialog host keeps the window chrome inert through a dialog's
 * way out (lib/portals.tsx: `holdChromeInert` stands until the kept panel's exit animation has
 * ended), so a toolbar button or a button on one of the frame's strips refuses as the dialog
 * unmounts; and a control of a dialog a prompt opened over refuses while that dialog is still
 * covered – `inert` from a state its owner drops a render later than the prompt's cleanup runs.
 * The refusal is watched for on the nearest inert root: as its `inert` goes – not one fixed
 * frame later – the control takes the focus, unless something else took it meanwhile (a dialog
 * opened over the way out), the control is gone, or the hold outlasts `RETURN_WAIT_MS` (a dialog
 * stacked on the leaving one, whose own return governs). The hold is resolved again at every
 * change: should the nearest go while an outer one stands (the chrome hold and a dialog's cover
 * are siblings today, never nested, but the watch does not depend on it), the outer is watched
 * in its turn, and a hold that comes up between the control and the one watched is too.
 */
export function returnFocusTo(target: HTMLElement): void {
  target.focus({ preventScroll: true })
  if (document.activeElement === target) return
  let held = target.closest<HTMLElement>('[inert]')
  if (!held || typeof MutationObserver === 'undefined') return
  let watching = true
  const stop = (): void => {
    if (!watching) return
    watching = false
    observer.disconnect()
    document.removeEventListener('focusin', stop, true)
    clearTimeout(timer)
  }
  const watch = (root: HTMLElement): void => {
    held = root
    observer.observe(root, { attributes: true, attributeFilter: ['inert'] })
  }
  const observer = new MutationObserver(() => {
    const still = target.closest<HTMLElement>('[inert]')
    if (still) {
      if (still !== held) {
        observer.disconnect()
        watch(still)
      }
      return
    }
    stop()
    if (!target.isConnected) return
    const active = document.activeElement
    if (active && active !== document.body) return
    target.focus({ preventScroll: true })
  })
  watch(held)
  document.addEventListener('focusin', stop, true)
  const timer = setTimeout(stop, RETURN_WAIT_MS)
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
 * the body – unless that first control is a text field: a field would bring the keyboard up
 * with the sheet, so a form sheet whose first control is a field focuses the dialog itself
 * (`tabIndex -1`, named by its title), §9.22's form-sheet exception, and never the button after
 * the field (landing on Cancel is the failure case the section names); else such a control in
 * the sheet's header that is not a text field; else the dialog itself, for a sheet that is all
 * notice. A footer's buttons – `.zen-sheet-footer`, the chassis's slot or a prompt's own under
 * its paragraph, Cancel first – are the way out, never the landing: a prompt whose only controls
 * are its footer's opens on its container. The grabber is first in the tab order but never the
 * first focus. `sheet` is the dialog element, `body` its scrolling content.
 */
export function sheetInitialFocus(sheet: HTMLElement, body: HTMLElement): HTMLElement {
  const inBody = focusableIn(body).filter((el) => !el.closest('.zen-sheet-footer'))
  const checked = body.querySelector(CHECKED)
  if (checked) {
    const option = inBody.find(
      (el) => el === checked || el.contains(checked) || checked.contains(el)
    )
    if (option) return option
  }
  const first = inBody[0]
  if (first) return isTextField(first) ? sheet : first
  const inHeader = focusableIn(sheet).filter(
    (el) =>
      !body.contains(el) && !el.closest('.zen-sheet-handle-hit') && !el.closest('.zen-sheet-footer')
  )
  return inHeader.find((el) => !isTextField(el)) ?? sheet
}
