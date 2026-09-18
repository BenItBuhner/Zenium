/**
 * The privacy signals a page can read: `navigator.globalPrivacyControl` (Global Privacy Control)
 * and `navigator.doNotTrack` (Do Not Track), the script-side halves of the `Sec-GPC: 1` and
 * `DNT: 1` request headers the hosts' request engines add.
 */

/** The page preload's sync IPC for the signals of the document it is about to run in. */
export const PRIVACY_SIGNALS_CHANNEL = 'zen:privacy-signals'

export interface PrivacySignals {
  gpc: boolean
  dnt: boolean
}

/**
 * Put the enabled signals on `Navigator.prototype` of the world this runs in. Self-contained on
 * purpose: the desktop preload serialises the function into the page's main world
 * (`contextBridge.executeInMainWorld`), so nothing in it may refer to anything outside it. The
 * Android host's document-start script (`privacy/Privacy.kt`) carries the same body.
 */
export function installNavigatorSignals(gpc: boolean, dnt: boolean): void {
  const define = (name: string, value: unknown): void => {
    try {
      Object.defineProperty(Navigator.prototype, name, {
        get: () => value,
        configurable: true,
        enumerable: true
      })
    } catch {
      // A prototype the page froze first keeps the engine's value.
    }
  }
  if (gpc) define('globalPrivacyControl', true)
  if (dnt) define('doNotTrack', '1')
}
