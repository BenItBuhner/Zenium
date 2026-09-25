/** A `BrowserWindow` as the flash sees one: liveness, focus, the flash itself and its events. */
export interface FlashableWindow {
  isDestroyed(): boolean
  isFocused(): boolean
  flashFrame(flag: boolean): void
  once(event: 'focus' | 'closed', listener: () => void): unknown
  removeListener(event: 'focus' | 'closed', listener: () => void): unknown
}

/** Windows flashing right now, so a second dialog in the same window adds no second flash. */
const flashing = new WeakSet<FlashableWindow>()

/**
 * Chrome's attention call for a page dialog – `alert`, `confirm`, `prompt`, a `beforeunload`
 * question – that opened in a window the user is not in (os-19): the window's taskbar button
 * flashes (`BrowserWindow.flashFrame`: the Dock icon bounces on macOS, the urgency hint goes up
 * on Linux) until the window is focused, when the flash stops. A window in front is left alone:
 * its dialog is on screen there, or waiting for its tab. One flash per window at a time, ended
 * by the focus that answers them all, or by the window closing. Returns whether it flashes.
 */
export function flashUntilFocused(win: FlashableWindow): boolean {
  if (win.isDestroyed() || win.isFocused()) return false
  if (flashing.has(win)) return true
  flashing.add(win)
  const stop = (): void => {
    flashing.delete(win)
    win.removeListener('focus', stop)
    win.removeListener('closed', stop)
    if (!win.isDestroyed()) win.flashFrame(false)
  }
  win.once('focus', stop)
  win.once('closed', stop)
  win.flashFrame(true)
  return true
}
