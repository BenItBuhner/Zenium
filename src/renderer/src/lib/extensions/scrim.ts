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
 * What the extensions' chrome asks of the content frame while it alone is over it (design
 * language v2 §9.5): a popover, the puzzle panel or the popup frame leave the page undimmed
 * (`none`); an install or permission prompt dims it the way a dialog does (`dialog`). `null`
 * when a shipped overlay is up as well, or nothing is: the frame keeps its own treatment.
 */
export function extensionChromeScrim(ui: ScrimInput): 'none' | 'dialog' | null {
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
  if (shipped) return null
  if (ui.extensionPrompts.length > 0) return 'dialog'
  if (ui.extensionPopup !== null || ui.floatingChrome > 0) return 'none'
  return null
}
