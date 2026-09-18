import { tabbables } from '../bookmarks/popover'

/** The toolbar button the bubble hangs from, and the bubble itself. */
export const DOWNLOADS_BUTTON = '[data-zen-downloads-button]'
export const DOWNLOADS_BUBBLE = '[data-zen-downloads-bubble]'

/**
 * Where the keyboard lands when it enters the open bubble (§9.22): its first row, else its first
 * control (the footer's row when the list is empty), else the panel itself. Used by the bubble
 * the user opened and by the button's Tab, which steps into a bubble that opened by itself.
 */
export function bubbleEntry(): HTMLElement | null {
  const panel = document.querySelector<HTMLElement>(DOWNLOADS_BUBBLE)
  if (!panel) return null
  return panel.querySelector<HTMLElement>('[data-download-id]') ?? tabbables(panel)[0] ?? panel
}
