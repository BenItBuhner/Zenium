import { EXTENSION_ORIGIN_SUFFIX } from './plan'

/**
 * The two spellings of an extension's own URL on the Android runtime. WebView refuses
 * `chrome-extension://`, so the runtime serves an extension's pages on a secure origin of its
 * own, `https://<id>.ext.zenium.invalid/` (`plan.ts`); Chrome, and the extensions written for
 * it, spell the same page `chrome-extension://<id>/`. The host keeps both apart at its
 * boundary: what the WebView loads is the served spelling (`toServedUrl`), what an extension
 * observes of its own pages – a tab's URL, a message sender's URL – is Chrome's
 * (`presentExtensionUrl`). The Kotlin twin is `ext/ExtensionUrls.kt`; the two must agree.
 *
 * `runtime.getURL` keeps answering the served spelling: its result is what the extension hands
 * to `fetch`, `<img src>`, `<link href>`, `<iframe src>` and `import()`, and only the served
 * spelling loads there. Chrome's spelling written out by hand on an extension page is mapped
 * before the load: `fetch` and `XMLHttpRequest` in `src/android/extensionCorsProxy.ts`, the
 * loading elements in `src/android/extensionFrameUrls.ts`, a navigation in
 * `ext/ExtensionPageNavigation.kt`.
 */

const ID = '[a-p]{32}'
const CHROME_EXTENSION = new RegExp(`^chrome-extension://(${ID})(?=[/?#]|$)(.*)$`, 'i')
const SERVED = new RegExp(
  `^https://(${ID})${EXTENSION_ORIGIN_SUFFIX.replace(/\./g, '\\.')}(?=[/?#]|$)(.*)$`,
  'i'
)

/** `chrome-extension://<id>`, the origin Chrome gives an extension's pages. */
export function chromeExtensionOrigin(id: string): string {
  return `chrome-extension://${id}`
}

/** `chrome-extension://<id>/<path>`, leading slashes of `path` collapsed like `runtime.getURL`. */
export function chromeExtensionUrl(id: string, path: string): string {
  return `${chromeExtensionOrigin(id)}/${path.replace(/^\/+/, '')}`
}

/** A path that may be empty or start at `?` / `#` gets its root slash, as URL parsing would give it. */
function rooted(rest: string): string {
  return rest.startsWith('/') ? rest : `/${rest}`
}

/**
 * `chrome-extension://<id>/p` as the WebView can load it, `https://<id>.ext.zenium.invalid/p`;
 * any other URL as it is.
 */
export function toServedUrl(url: string): string {
  const match = CHROME_EXTENSION.exec(url)
  if (!match) return url
  return `https://${match[1].toLowerCase()}${EXTENSION_ORIGIN_SUFFIX}${rooted(match[2])}`
}

/**
 * `https://<id>.ext.zenium.invalid/p` as Chrome spells it, `chrome-extension://<id>/p`; any
 * other URL as it is.
 */
export function presentExtensionUrl(url: string): string {
  const match = SERVED.exec(url)
  if (!match) return url
  return `chrome-extension://${match[1].toLowerCase()}${rooted(match[2])}`
}

/** The extension id of either spelling of an extension page's URL, or null for any other URL. */
export function extensionIdOfUrl(url: string): string | null {
  const match = CHROME_EXTENSION.exec(url) ?? SERVED.exec(url)
  return match ? match[1].toLowerCase() : null
}

/** True for either spelling of an extension page's URL. */
export function isExtensionPageUrl(url: string): boolean {
  return extensionIdOfUrl(url) !== null
}

/**
 * Whether two URLs name the same extension page whichever way each is spelled: a
 * `tabs.query({ url })` pattern built from `runtime.getURL` (served) against a tab whose URL is
 * presented (Chrome's), or the reverse.
 */
export function sameExtensionUrl(a: string, b: string): boolean {
  return presentExtensionUrl(a) === presentExtensionUrl(b)
}
