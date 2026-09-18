/**
 * One popover at a time (v2 draft §9.20): opening another closes the first. Every renderer-owned
 * popover (the extensions panel, a local menu, a menulist's list, an action popup's frame) claims
 * the slot while it is up; whatever held it before is asked to close.
 */
let current: (() => void) | null = null

/** Take the slot, closing its holder; returns the release to call when this popover is gone. */
export function claimPopover(close: () => void): () => void {
  if (current && current !== close) current()
  current = close
  return () => {
    if (current === close) current = null
  }
}

/** Close the open popover without taking the slot: a modal dialog is going up over it. */
export function closePopover(): void {
  current?.()
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
