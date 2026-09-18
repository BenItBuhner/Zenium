/**
 * Chrome's page-facing `window.chrome` object for engines that ship a bare one.
 *
 * Chrome gives every http(s) document a `chrome` object carrying `app`, `csi()` and
 * `loadTimes()` (the last two from //chrome/renderer's loadtimes bindings, `app` from Chrome's
 * app bindings). Chromium embedders that compile the extensions subsystem but not //chrome –
 * Electron, CEF – get the object created by the extensions dispatcher, empty. Google's sign-in
 * BotGuard reads that as an embedded browser: a Chrome user agent whose `window.chrome` exists
 * but has no `app` gets "Couldn't sign you in – This browser or app may not be secure" (verified
 * against Chrome 152 on the identifier step: a bare `{}` is refused, `{ app }` passes, `csi` and
 * `loadTimes` alone do not help). Engines with no `chrome` object at all (WebView, Firefox,
 * Safari) are read as non-Chrome browsers and pass, so an absent object is left absent.
 *
 * {@link completeChromeObject} adds the three members with Chrome 152's shapes, values and
 * property attributes (all writable, enumerable, configurable data properties on plain
 * objects), leaving whatever is already there alone. Self-contained on purpose: the desktop
 * preload serialises it into the page's main world at document start
 * (`contextBridge.executeInMainWorld`), so nothing in it may refer to anything outside it.
 * Android's page script may install it the same way (`CHROME_OBJECT_SOURCE`); the system
 * WebView exposes no `chrome` object, so there it does nothing.
 */
export function completeChromeObject(win: Window = globalThis as unknown as Window): void {
  const w = win as Window & { chrome?: Record<string, unknown> }
  const chrome = w.chrome
  if (!chrome || typeof chrome !== 'object') return
  const define = (target: object, name: string, value: unknown): void => {
    try {
      Object.defineProperty(target, name, {
        value,
        writable: true,
        enumerable: true,
        configurable: true
      })
    } catch {
      // A page that froze the object first keeps it as it is.
    }
  }
  const timing = (): PerformanceTiming | null => {
    try {
      return w.performance?.timing ?? null
    } catch {
      return null
    }
  }
  const seconds = (ms: number): number => (ms > 0 ? ms / 1000 : 0)
  if (!('loadTimes' in chrome)) {
    // Deprecated in Chrome (Navigation Timing 2 replaces it) but still present and still read.
    define(chrome, 'loadTimes', function (): Record<string, unknown> {
      const t = timing()
      const start = t?.navigationStart ?? 0
      return {
        requestTime: seconds(start),
        startLoadTime: seconds(start),
        commitLoadTime: seconds(t?.responseStart ?? 0),
        finishDocumentLoadTime: seconds(t?.domContentLoadedEventEnd ?? 0),
        finishLoadTime: seconds(t?.loadEventEnd ?? 0),
        firstPaintTime: seconds(t?.responseStart ?? 0),
        firstPaintAfterLoadTime: 0,
        navigationType: 'Other',
        wasFetchedViaSpdy: false,
        wasNpnNegotiated: false,
        npnNegotiatedProtocol: 'unknown',
        wasAlternateProtocolAvailable: false,
        connectionInfo: 'unknown'
      }
    })
  }
  if (!('csi' in chrome)) {
    define(chrome, 'csi', function (): Record<string, number> {
      const t = timing()
      const start = t?.navigationStart ?? 0
      const now = start > 0 ? Date.now() - start : 0
      return {
        startE: start,
        onloadT: t?.domContentLoadedEventEnd ?? 0,
        pageT: now,
        tran: 15
      }
    })
  }
  if (!('app' in chrome)) {
    const app: Record<string, unknown> = {}
    define(app, 'isInstalled', false)
    define(app, 'getDetails', function getDetails(): null {
      return null
    })
    define(app, 'getIsInstalled', function getIsInstalled(): boolean {
      return false
    })
    define(app, 'installState', function installState(...args: unknown[]): void {
      // Chrome answers the callback asynchronously, ignores a missing one, and its function
      // reports no formal parameters (`length` 0) – hence the rest parameter.
      const callback = args[0]
      if (typeof callback === 'function')
        w.setTimeout(() => (callback as (state: string) => void)('not_installed'), 0)
    })
    define(app, 'runningState', function runningState(): string {
      return 'cannot_run'
    })
    const installState: Record<string, string> = {}
    define(installState, 'DISABLED', 'disabled')
    define(installState, 'INSTALLED', 'installed')
    define(installState, 'NOT_INSTALLED', 'not_installed')
    define(app, 'InstallState', installState)
    const runningState: Record<string, string> = {}
    define(runningState, 'CANNOT_RUN', 'cannot_run')
    define(runningState, 'READY_TO_RUN', 'ready_to_run')
    define(runningState, 'RUNNING', 'running')
    define(app, 'RunningState', runningState)
    define(chrome, 'app', app)
  }
}

/** The completion as page source, for hosts that inject into the main world by string. */
export const CHROME_OBJECT_SOURCE = `(${completeChromeObject.toString()})(window)`
