/**
 * A path or URL an extension hands back for one of its own files – `action.setIcon`'s `path`,
 * `notifications.create`'s `iconUrl` – read as the package path it names.
 *
 * Chrome resolves these by loading them as URLs from the extension's own context, so three
 * spellings name the same file: a package path (`icons/a.png`, `/icons/a.png`), the static URL
 * (`chrome-extension://<id>/icons/a.png`) and the DYNAMIC one. `chrome.runtime.getURL(path)`
 * answers `chrome-extension://<guid>/path` when `path` falls under a `use_dynamic_url`
 * web-accessible entry – Chromium's per-session GUID origin, which Electron does not expose –
 * and extensions hand that straight back (Simplify Copilot builds its `setIcon` dictionary from
 * `runtime.getURL`; every entry comes back on the GUID host). The GUID host counts as the
 * caller's own here: what it names is read from the caller's own package, which the caller can
 * read anyway, so another extension's GUID gains nothing.
 *
 * Not for `action.setPopup`: Chrome refuses the dynamic URL there ("The specified popup path is
 * invalid. Ensure it is a path to a file in this extension.") and takes the static one.
 */
import { normalizeResourcePath } from './webAccessible'

const DYNAMIC_HOST = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** Chromium's dynamic extension origin host: a version-4 UUID drawn per session. */
export function isDynamicExtensionHost(host: string): boolean {
  return DYNAMIC_HOST.test(host)
}

/**
 * The package path `value` names for `extensionId`, or null when it names something else: a URL
 * of another scheme, another extension's static origin, or text no URL parser takes.
 */
export function ownResourcePath(extensionId: string, value: string): string | null {
  if (!HAS_SCHEME.test(value)) return normalizeResourcePath(value)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'chrome-extension:') return null
  if (url.hostname !== extensionId && !isDynamicExtensionHost(url.hostname)) return null
  return normalizeResourcePath(url.pathname)
}
