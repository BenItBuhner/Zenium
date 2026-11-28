import type { UIState } from '@shared/types'

/**
 * Who draws a window's minimise / maximise / close on Windows. Popups and app windows keep the
 * OS's own buttons over their top row (Window Controls Overlay, with Snap Layouts on the
 * maximise button). A browser window has none: the OS will not shrink or hide them, so they
 * would hold an empty band across the top. The chrome draws its own instead, looking and sitting
 * as the OS's did (`CaptionButtons`): in the top trailing corner of the top row where the layout
 * shows one (the toolbar, the horizontal strip), and otherwise hidden, with no band kept, until
 * the cursor touches the window's top edge (`CaptionReveal`). Snap stays on Win+Z and on
 * dragging the window to the top of the screen.
 */
export function nativeCaption(state: UIState): boolean {
  return state.capabilities.windowControlsOverlay && state.window.chrome !== 'full'
}

/** A Windows browser window: the chrome draws the caption buttons (see `nativeCaption`). */
export function ownCaption(state: UIState): boolean {
  return state.capabilities.windowControlsOverlay && state.window.chrome === 'full'
}

/** The footprint of the chrome's caption buttons: three of Windows' 46-wide buttons. */
export const CAPTION_BUTTONS_WIDTH = 3 * 46

/**
 * The chrome's caption buttons stand over the top of a right-hand sidebar: the toolbar layout
 * with its row showing and the sidebar wide enough to take them, the case where the OS's buttons
 * sat over the sidebar too. The sidebar keeps its title row clear for them then, as it did.
 */
export function captionOverSidebar(state: UIState): boolean {
  const s = state.settings
  const compact = s.compactMode
  return (
    ownCaption(state) &&
    !state.window.fullscreen &&
    s.toolbarLayout === 'multiple' &&
    s.sidebarSide === 'right' &&
    s.sidebarExpanded &&
    s.sidebarWidth >= CAPTION_BUTTONS_WIDTH &&
    !(
      compact.enabled &&
      (compact.hideToolbar || (compact.hideSidebar && !compact.sidebarPersistent))
    )
  )
}
