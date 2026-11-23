import type { UIState } from '@shared/types'

/**
 * Who draws a window's minimise / maximise / close on Windows. Popups and app windows keep the
 * OS's own buttons over their top row (Window Controls Overlay, with Snap Layouts on the
 * maximise button). A browser window has none: the OS will not shrink or hide them, so they
 * would hold an empty band across the top. The chrome draws its own instead, in the top row
 * where the layout has one (the toolbar, the horizontal strip) and otherwise hidden until the
 * cursor touches the window's top edge (`CaptionReveal`). Snap stays on Win+Z and on dragging
 * the window to the top of the screen.
 */
export function nativeCaption(state: UIState): boolean {
  return state.capabilities.windowControlsOverlay && state.window.chrome !== 'full'
}

/** A Windows browser window: the chrome draws the caption buttons (see `nativeCaption`). */
export function ownCaption(state: UIState): boolean {
  return state.capabilities.windowControlsOverlay && state.window.chrome === 'full'
}
