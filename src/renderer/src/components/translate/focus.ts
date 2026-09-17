import type { KeyboardEvent } from 'react'

/** What Tab stops on inside a popover: enabled controls and anything given a tab index. */
const STOPS =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), ' +
  'textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * Keep Tab inside `container` while it is up (§9.22): Tab on its last stop goes to the first,
 * Shift+Tab on the first (or on the container itself) to the last; anywhere else Tab moves as
 * it would. Call from the container's keydown handler.
 */
export function wrapTab(container: HTMLElement, e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return
  const stops = [...container.querySelectorAll<HTMLElement>(STOPS)].filter(
    (el) => el.getClientRects().length > 0
  )
  const first = stops[0]
  const last = stops[stops.length - 1]
  if (!first || !last) {
    e.preventDefault()
    return
  }
  const current = document.activeElement
  if (e.shiftKey && (current === first || current === container)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && current === last) {
    e.preventDefault()
    first.focus()
  }
}
