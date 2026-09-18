import { inputToUrl } from '@shared/url'

/** The grid holds ten tiles at most (`MAX_NEW_TAB_SHORTCUTS` in the core). */
const MAX_SHORTCUTS = 10

/**
 * What stops the shortcut dialog's form from saving, in Chrome's words: nothing, no web address,
 * the same address twice, or no room left on the grid. Pure, for the tests.
 */
export function shortcutFormError(
  url: string,
  existing: Array<{ id: string; url: string }>,
  editingId: string | null
): string | null {
  const address = inputToUrl(url.trim())
  if (!address || !/^https?:\/\//i.test(address)) return 'Enter a web address, like example.com'
  let canonical: string
  try {
    canonical = new URL(address).href
  } catch {
    return 'Enter a web address, like example.com'
  }
  if (existing.some((s) => s.id !== editingId && s.url === canonical))
    return 'This shortcut already exists'
  if (editingId === null && existing.length >= MAX_SHORTCUTS)
    return `The grid holds ${MAX_SHORTCUTS} shortcuts`
  return null
}
