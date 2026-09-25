/**
 * What an extension's scripts ask of the engine and an older system WebView does not have,
 * given to the extension's OWN realms and to no web page's: an extension page's realm (a popup,
 * an options page, the MV3 worker's page, an offscreen document, an extension page open as a
 * tab) and an isolated world's (Chromium 146+, where every one of these is native anyway). On a
 * WebView without isolated worlds a content script runs on the page's real global behind the
 * `with` scope, and a builtin added there would be the page's to see and to fingerprint, so the
 * `with` scope gets nothing of this; a content script that needs one of these on WebView 113 is
 * recorded as the engine's line.
 *
 * Each polyfill is installed only where the engine lacks it and in the engine's own shape (a
 * writable, configurable, non-enumerable method of the same name and length), so an extension's
 * own feature test reads as on a Chrome that has it.
 *
 * - `Promise.withResolvers` (Chromium 119): Adobe Photoshop's worker dies at its telemetry init
 *   without it on WebView 113 (`background.js:180`, compat rounds 14-16); the only builtin of
 *   that bundle newer than the engine's.
 */

/** The realm's constructors the polyfills look at; a window or a worker page's global. */
export interface PolyfillRealm {
  Promise?: PromiseConstructor
}

/** Installs what the realm lacks; returns the names installed, for the boot's stats. */
export function installExtensionPolyfills(realm: PolyfillRealm): string[] {
  const installed: string[] = []
  const PromiseCtor = realm.Promise
  if (typeof PromiseCtor === 'function' && typeof PromiseCtor.withResolvers !== 'function') {
    Object.defineProperty(PromiseCtor, 'withResolvers', {
      configurable: true,
      writable: true,
      enumerable: false,
      value: function withResolvers<T>(this: PromiseConstructor): PromiseWithResolvers<T> {
        // `this` is the constructor called on, as the engine's does (a subclass gets its own).
        let resolve!: (value: T | PromiseLike<T>) => void
        let reject!: (reason?: unknown) => void
        const promise = new this<T>((res, rej) => {
          resolve = res
          reject = rej
        })
        return { promise, resolve, reject }
      }
    })
    installed.push('Promise.withResolvers')
  }
  return installed
}
