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

/** Focusable descendants in tab order, as Tab would visit them. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  const selector =
    'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
  return [...root.querySelectorAll<HTMLElement>(selector)].filter(
    (el) => !el.hidden && el.getAttribute('aria-hidden') !== 'true' && el.tabIndex >= 0
  )
}
