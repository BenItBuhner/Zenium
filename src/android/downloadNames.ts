/**
 * Names for `blob:` and `data:` downloads on Android. The WebView's `DownloadListener` only
 * carries the response's Content-Disposition, never the anchor's `download` attribute, so the
 * page script remembers the attribute for every anchor that is clicked (or `click()`ed – the
 * usual programmatic pattern is a detached anchor) and Kotlin asks the page for it by key.
 */

/** How many names a page keeps; downloads are announced right after the click. */
export const DOWNLOAD_NAME_LIMIT = 32

/**
 * Registry key for an href: `data:` URLs run to megabytes, so the key is the first 200 characters
 * plus the length rather than the whole string. Kotlin builds the same key (`DownloadLogic`).
 */
export function downloadNameKey(href: string): string {
  return `${href.slice(0, 200)}#${href.length}`
}

export type DownloadNames = Record<string, string>

/** Remember `name` for `href`, dropping the oldest entries past the limit. */
export function rememberDownloadName(names: DownloadNames, href: string, name: string): void {
  if (!name || !href) return
  const key = downloadNameKey(href)
  delete names[key]
  names[key] = name
  const keys = Object.keys(names)
  for (let i = 0; i < keys.length - DOWNLOAD_NAME_LIMIT; i++) {
    const k = keys[i]
    if (k !== undefined) delete names[k]
  }
}

/** The `download` attribute worth remembering: anchors to `blob:`, `data:` or without a server name. */
export function downloadNameOf(anchor: {
  href: string
  getAttribute(name: string): string | null
}): { href: string; name: string } | null {
  const name = anchor.getAttribute('download')
  if (name === null) return null
  const href = anchor.href
  if (!href) return null
  return { href, name }
}
