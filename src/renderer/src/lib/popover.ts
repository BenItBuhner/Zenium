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
