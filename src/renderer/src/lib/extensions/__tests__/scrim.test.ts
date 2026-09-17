import { describe, expect, it } from 'vitest'
import type { ExtensionPromptRequest } from '@shared/types'
import type { ExtensionPopupState } from '@renderer/lib/ui'
import { extensionChromeScrim, type ScrimInput } from '../scrim'

const quiet: ScrimInput = {
  overlay: 'none',
  urlbar: { open: false, mode: 'new-tab', tabId: null, initialText: undefined, attached: false },
  drag: null,
  drawerOpen: false,
  menu: null,
  siteInfoOpen: false,
  externalProtocol: null,
  barEditorOpen: false,
  tabsMenu: null,
  securityPromptOpen: false,
  stageActive: false,
  extensionPrompts: [],
  extensionPopup: null,
  floatingChrome: 0
}

const prompt: ExtensionPromptRequest = {
  requestId: 'p1',
  kind: 'install',
  name: 'Ext',
  icon: null,
  warnings: [],
  source: 'chrome-web-store'
}

const popup: ExtensionPopupState = {
  id: 'a'.repeat(32),
  anchor: { x: 0, y: 0, width: 28, height: 28 },
  content: null,
  shown: true
}

describe('extensionChromeScrim', () => {
  it('leaves the frame alone when nothing of the extensions is up', () => {
    expect(extensionChromeScrim(quiet)).toBeNull()
  })

  it('asks for no scrim behind the popup frame or the puzzle panel (§9.5)', () => {
    expect(extensionChromeScrim({ ...quiet, extensionPopup: popup })).toBe('none')
    expect(extensionChromeScrim({ ...quiet, floatingChrome: 1 })).toBe('none')
  })

  it('asks for the dialog scrim behind an install or permission prompt', () => {
    expect(extensionChromeScrim({ ...quiet, extensionPrompts: [prompt] })).toBe('dialog')
    // A prompt wins over a popup or panel that is still open underneath it.
    expect(
      extensionChromeScrim({
        ...quiet,
        extensionPrompts: [prompt],
        extensionPopup: popup,
        floatingChrome: 1
      })
    ).toBe('dialog')
  })

  it('defers to the shipped overlays when one of them is up as well', () => {
    const withPanel: ScrimInput = { ...quiet, floatingChrome: 1 }
    expect(extensionChromeScrim({ ...withPanel, overlay: 'settings' })).toBeNull()
    expect(extensionChromeScrim({ ...withPanel, drawerOpen: true })).toBeNull()
    expect(extensionChromeScrim({ ...withPanel, siteInfoOpen: true })).toBeNull()
    expect(extensionChromeScrim({ ...withPanel, stageActive: true })).toBeNull()
    expect(extensionChromeScrim({ ...withPanel, drag: { tabId: 't', x: 0, y: 0 } })).toBeNull()
    expect(
      extensionChromeScrim({ ...withPanel, urlbar: { ...quiet.urlbar, open: true } })
    ).toBeNull()
    expect(extensionChromeScrim({ ...withPanel, barEditorOpen: true })).toBeNull()
    expect(extensionChromeScrim({ ...withPanel, securityPromptOpen: true })).toBeNull()
    expect(
      extensionChromeScrim({ ...withPanel, tabsMenu: { x: 0, y: 0, width: 44, height: 44 } })
    ).toBeNull()
    expect(
      extensionChromeScrim({ ...quiet, extensionPrompts: [prompt], overlay: 'settings' })
    ).toBeNull()
  })
})
