import { describe, expect, it } from 'vitest'
import type { ExtensionPromptRequest } from '@shared/types'
import type { ExtensionPopupState } from '@renderer/lib/ui'
import { extensionChromeAloneOverContent, type ScrimInput } from '../scrim'

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
  starDialog: null,
  bookmarkEdit: null,
  bookmarkAllTabs: null,
  barMenuOpen: false,
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

describe('extensionChromeAloneOverContent', () => {
  it('leaves the frame alone when nothing of the extensions is up', () => {
    expect(extensionChromeAloneOverContent(quiet)).toBe(false)
  })

  it('takes the dim off behind the popup frame or a popover, which have no scrim (§9.5)', () => {
    expect(extensionChromeAloneOverContent({ ...quiet, extensionPopup: popup })).toBe(true)
    expect(extensionChromeAloneOverContent({ ...quiet, floatingChrome: 1 })).toBe(true)
  })

  it("takes the dim off behind a prompt, whose scrim is its host's", () => {
    expect(extensionChromeAloneOverContent({ ...quiet, extensionPrompts: [prompt] })).toBe(true)
    expect(
      extensionChromeAloneOverContent({
        ...quiet,
        extensionPrompts: [prompt],
        extensionPopup: popup,
        floatingChrome: 1
      })
    ).toBe(true)
  })

  it('defers to the shipped overlays when one of them is up as well', () => {
    const withPanel: ScrimInput = { ...quiet, floatingChrome: 1 }
    const alone = extensionChromeAloneOverContent
    expect(alone({ ...withPanel, overlay: 'settings' })).toBe(false)
    expect(alone({ ...withPanel, drawerOpen: true })).toBe(false)
    expect(alone({ ...withPanel, siteInfoOpen: true })).toBe(false)
    expect(alone({ ...withPanel, stageActive: true })).toBe(false)
    expect(alone({ ...withPanel, drag: { tabId: 't', x: 0, y: 0 } })).toBe(false)
    expect(alone({ ...withPanel, urlbar: { ...quiet.urlbar, open: true } })).toBe(false)
    expect(alone({ ...withPanel, barEditorOpen: true })).toBe(false)
    expect(alone({ ...withPanel, securityPromptOpen: true })).toBe(false)
    expect(alone({ ...withPanel, barMenuOpen: true })).toBe(false)
    expect(alone({ ...withPanel, bookmarkAllTabs: { tabIds: [], defaultTitle: '' } })).toBe(false)
    expect(alone({ ...withPanel, tabsMenu: { x: 0, y: 0, width: 44, height: 44 } })).toBe(false)
    expect(alone({ ...quiet, extensionPrompts: [prompt], overlay: 'settings' })).toBe(false)
  })
})
