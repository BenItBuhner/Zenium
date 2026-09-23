/**
 * A window created hidden (`show: false`) is shown from `ready-to-show`, once its chrome has
 * painted, so it never flashes blank. That event is Electron's to send, and it has gone missing:
 * Electron 44.3's Windows builds left a `titleBarOverlay` window hidden for good (electron#54025,
 * fixed in 44.4.4), and nothing in the app could tell a slow first paint from a window that
 * would never appear. This shows the window after a bounded wait either way – a blank frame for
 * a moment beats no window at all – and says once, with the elapsed time, that the event was
 * missed.
 */

/** How long a hidden window waits for `ready-to-show` before it is shown regardless. */
export const READY_TO_SHOW_FALLBACK_MS = 2500

/** The slice of `BrowserWindow` the fallback needs (so a test can hand in a fake). */
export interface ShowableWindow {
  once(event: 'ready-to-show' | 'closed', listener: () => void): unknown
  isDestroyed(): boolean
  isVisible(): boolean
  show(): void
}

export interface ShowWhenReadyOptions {
  timeoutMs?: number
  now?: () => number
  warn?: (message: string) => void
}

/**
 * Show `win` when `ready-to-show` fires, or after `timeoutMs` if it has not fired by then –
 * whichever comes first, and only once: the late event after a fallback show is a no-op, and a
 * window closed or destroyed before either is left alone. Returns a function that cancels the
 * fallback timer (the window's `closed` does this by itself).
 */
export function showWhenReady(win: ShowableWindow, options: ShowWhenReadyOptions = {}): () => void {
  const { timeoutMs = READY_TO_SHOW_FALLBACK_MS, now = Date.now, warn = console.warn } = options
  const started = now()
  let done = false
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null
    if (done) return
    done = true
    if (win.isDestroyed()) return
    // Already on screen (the core showed it for a launch argument): nothing was missed that
    // matters, and a second `show()` would only pull the focus back.
    if (win.isVisible()) return
    warn(
      `[zen] window: ready-to-show did not fire within ${timeoutMs} ms (${now() - started} ms elapsed); showing the window anyway`
    )
    win.show()
  }, timeoutMs)
  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  win.once('ready-to-show', () => {
    cancel()
    if (done) return
    done = true
    if (!win.isDestroyed()) win.show()
  })
  win.once('closed', () => {
    done = true
    cancel()
  })
  return cancel
}
