import { bookmarkChromeOpen, type UiState } from '@renderer/lib/ui'

/** The parts of the UI state that decide what covers the content frame. */
export type ScrimInput = Pick<
  UiState,
  | 'overlay'
  | 'urlbar'
  | 'drag'
  | 'drawerOpen'
  | 'menu'
  | 'siteInfoOpen'
  | 'externalProtocol'
  | 'barEditorOpen'
  | 'tabsMenu'
  | 'securityPromptOpen'
  | 'stageActive'
  | 'starDialog'
  | 'bookmarkEdit'
  | 'bookmarkAllTabs'
  | 'barMenuOpen'
  | 'extensionPrompts'
  | 'extensionPopup'
  | 'floatingChrome'
>

/**
 * Only the extensions' chrome is over the content frame: a popover (the puzzle panel, a local
 * menu, a menulist's list), the popup frame, or an install or permission prompt. The page
 * behind is captured all the same, but the frame draws no dim of its own then: popovers have
 * no scrim (design language v2 §9.5), and a prompt's scrim is its host's – the frame dialog
 * host's §9.5 scrim on desktop (lib/portals.tsx), the sheet's on a phone (one per stack,
 * §9.24). False when a shipped overlay is up as well, or nothing is: the frame keeps its own
 * treatment. The extensions' counterpart of `panelAloneOverContent`.
 */
export function extensionChromeAloneOverContent(ui: ScrimInput): boolean {
  const shipped =
    ui.overlay !== 'none' ||
    ui.urlbar.open ||
    ui.drag !== null ||
    ui.drawerOpen ||
    ui.menu !== null ||
    ui.siteInfoOpen ||
    ui.externalProtocol !== null ||
    ui.barEditorOpen ||
    ui.tabsMenu !== null ||
    ui.securityPromptOpen ||
    ui.stageActive ||
    bookmarkChromeOpen(ui)
  if (shipped) return false
  return ui.extensionPrompts.length > 0 || ui.extensionPopup !== null || ui.floatingChrome > 0
}
