import { extensionIdOfUrl } from '@core/extensions/runtime/extensionUrls'
import { extensionOrigin } from '@core/extensions/runtime/plan'

/**
 * `new URL('chrome-extension://<id>/...').origin` in an extension's realms.
 *
 * A WebView has no `chrome-extension:` scheme, so its URL parser treats the spelling as a
 * non-special scheme and `origin` answers the opaque `"null"`; Chrome answers the extension's
 * origin. The extension's pages live on the served origin here (`extensionUrls.ts`), and every
 * origin the runtime reports for them says so: `location.origin` inside the page,
 * `sender.origin`, `getContexts`'s `documentOrigin`, a `MessageEvent`'s `origin`. So the origin
 * of an extension URL in either spelling is the served one, and `URL.prototype.origin` answers
 * it for Chrome's spelling too: Keplr's background guards every internal message with
 * `new URL(sender.url).origin !== message.origin` (its popup's `location.origin`) and rejected
 * its own popup with `Invalid origin` on the `"null"`. Every other URL keeps the native answer.
 *
 * Installed on an extension page's and the MV3 worker page's `URL.prototype` and on an isolated
 * world's (the world's own interface object); the `with` scope gets a subclass of the page's
 * `URL` in its store (`scopedUrlClass`), the page's own untouched.
 */

/** The origin of `href` given what the native getter answered. */
export function extensionUrlOrigin(href: string, native: string): string {
  if (native !== 'null') return native
  const id = extensionIdOfUrl(href)
  return id === null ? native : extensionOrigin(id)
}

interface UrlRealm {
  URL?: { prototype: object }
}

/**
 * Patch `realm.URL.prototype.origin`; true when it was, false when the realm has no `URL` or
 * its `origin` is not the configurable accessor a Web IDL interface gives (already patched).
 */
export function installUrlOrigin(realm: UrlRealm): boolean {
  const proto = realm.URL?.prototype
  if (!proto) return false
  const origin = Object.getOwnPropertyDescriptor(proto, 'origin')
  const href = Object.getOwnPropertyDescriptor(proto, 'href')
  if (!origin?.get || !origin.configurable || !href?.get) return false
  const nativeOrigin = origin.get
  const nativeHref = href.get
  Object.defineProperty(proto, 'origin', {
    ...origin,
    get(this: URL) {
      const native = String(nativeOrigin.call(this))
      return native === 'null' ? extensionUrlOrigin(String(nativeHref.call(this)), native) : native
    }
  })
  return true
}

/**
 * The page's `URL` subclassed with the patched `origin`, for the `with` scope's store: a bare
 * `URL`, `window.URL` and `self.URL` in a content script resolve to it, `instanceof URL` holds,
 * the statics (`createObjectURL`, `canParse`) are inherited.
 */
export function scopedUrlClass(NativeURL: typeof URL): typeof URL {
  return class URL extends NativeURL {
    override get origin(): string {
      return extensionUrlOrigin(this.href, super.origin)
    }
  }
}
