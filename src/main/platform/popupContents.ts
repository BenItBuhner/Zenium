/**
 * The `WebContents` of a popup's `WebContentsView`, if it is still alive.
 *
 * Once a popup document destroys itself (`window.close()`, as Chrome's popups may) Electron's
 * `WebContentsView.webContents` reads `undefined`, while the `WebContents` handle taken at
 * creation stays an object that answers `isDestroyed()`. Every reader after the fact asks that
 * handle through this, and asks nothing of a destroyed one.
 */
export function liveWebContents<T extends { isDestroyed(): boolean }>(
  wc: T | null | undefined
): T | null {
  return wc && !wc.isDestroyed() ? wc : null
}
