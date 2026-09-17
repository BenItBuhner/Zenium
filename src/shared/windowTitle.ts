/** User-visible product name for native window titles (Alt+Tab, taskbar, Dock). */
export const PRODUCT_NAME = 'Zenium'

/**
 * Format the OS window title from the active tab. No tabs (or a blank title) is just the
 * product name; a private window appends ` (Private)` when a tab title is shown.
 */
export function formatWindowTitle(tabTitle: string | null | undefined, isPrivate = false): string {
  const title = tabTitle?.trim() ?? ''
  if (!title) return PRODUCT_NAME
  return isPrivate ? `${title} - ${PRODUCT_NAME} (Private)` : `${title} - ${PRODUCT_NAME}`
}
