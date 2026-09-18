import { overlayCoversContent, type UiState } from '@renderer/lib/ui'

/**
 * Only the extensions' chrome is over the content frame: a popover (the puzzle panel, a local
 * menu, a menulist's list), the popup frame, or an install or permission prompt. The page
 * behind is captured all the same, but the frame draws no dim of its own then: popovers have
 * no scrim (design language v2 §9.5), and a prompt's scrim is its host's – the frame dialog
 * host's §9.5 scrim on desktop (lib/portals.tsx), the sheet's on a phone (one per stack,
 * §9.24). False when a shipped overlay is up as well, or nothing is: the frame keeps its own
 * treatment. The extensions' counterpart of `panelAloneOverContent`, and built the same way,
 * so an overlay added to `overlayCoversContent` counts here without a second list.
 */
export function extensionChromeAloneOverContent(ui: UiState): boolean {
  const up = ui.extensionPrompts.length > 0 || ui.extensionPopup !== null || ui.floatingChrome > 0
  return (
    up &&
    !overlayCoversContent({ ...ui, extensionPrompts: [], extensionPopup: null, floatingChrome: 0 })
  )
}
