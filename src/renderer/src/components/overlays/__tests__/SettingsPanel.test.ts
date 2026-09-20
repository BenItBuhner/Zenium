// @vitest-environment happy-dom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import type { HostCapabilities, UIState } from '@shared/types'
import { DEFAULT_SETTINGS, emptyPasswordsStatus, emptyResourceSnapshot } from '@shared/defaults'
import {
  UNAVAILABLE_SPELLCHECK,
  type SpellcheckDictionaryStatus,
  type SpellcheckStatus
} from '@shared/spellcheck'
import type { TranslateUIState } from '@shared/translate'
import { uiStore } from '@renderer/lib/ui'
import { SettingsPanel } from '../SettingsPanel'

/** Electron's capabilities (`src/main/platform/index.ts`): no page controls on the desktop. */
const DESKTOP: HostCapabilities = {
  windowControls: true,
  nativeMenus: true,
  windowDrag: true,
  devtools: true,
  compactReveal: true,
  pictureInPicture: true,
  viewSource: true,
  windows: true,
  extensions: true,
  resourceGovernor: true,
  sync: true,
  print: true,
  printPreview: true,
  pdfViewer: false,
  agents: true,
  updates: true,
  share: false,
  clipboardChip: false,
  appLinkSettings: false,
  pullToRefresh: false,
  passwords: true,
  defaultBrowser: false,
  requestBlocking: true,
  reducedExtensionIsolation: false,
  pageControls: false,
  darkenSites: false,
  privateTabs: false,
  windowControlsOverlay: false,
  windowMaterial: false,
  secureDns: true,
  newTabPage: true,
  pageTabs: false,
  pinShortcuts: false,
  translate: true,
  voiceSearch: false,
  screenCapture: false,
  shareSheet: false,
  selectionToolbar: false,
  popupSurface: true,
  qrScan: false,
  readAloud: false
}

const ANDROID: HostCapabilities = {
  ...DESKTOP,
  windowControls: false,
  nativeMenus: false,
  windowDrag: false,
  devtools: false,
  compactReveal: false,
  pictureInPicture: false,
  viewSource: false,
  windows: false,
  extensions: false,
  resourceGovernor: false,
  sync: false,
  share: true,
  clipboardChip: true,
  appLinkSettings: true,
  pullToRefresh: true,
  defaultBrowser: true,
  pageControls: true,
  darkenSites: true,
  privateTabs: true,
  secureDns: false,
  newTabPage: false,
  pageTabs: true,
  selectionToolbar: true,
  popupSurface: false
}

function state(capabilities: HostCapabilities, platform: UIState['platform']): UIState {
  return {
    platform,
    capabilities,
    version: '0.0.0-test',
    tabs: {},
    essentialTabIds: [],
    spaces: [{ id: 'space', name: 'Personal', activeTabId: null, tabIds: [] }],
    activeSpaceId: 'space',
    containers: [],
    folders: {},
    splitGroups: {},
    settings: DEFAULT_SETTINGS,
    shortcuts: [],
    searchEngines: [],
    glance: null,
    compactSidebarRevealed: false,
    downloads: [],
    bookmarks: [],
    recentlyClosedCount: 0,
    media: [],
    findResult: null,
    devtoolsOpenFor: [],
    resources: emptyResourceSnapshot(),
    foreignTabIds: [],
    windowCount: 1,
    boosts: [],
    zappingTabId: null,
    liveFolders: {},
    extensions: [],
    mods: [],
    agents: [],
    passwords: emptyPasswordsStatus(),
    pageEnvironment: { largeScreen: false, pointerAndKeyboard: false, fontScale: 1 },
    translate: TRANSLATE,
    spellcheck: UNAVAILABLE_SPELLCHECK
  } as unknown as UIState
}

/** Translation with a couple of languages, so the Languages pane renders around Spell check. */
const TRANSLATE: TranslateUIState = {
  available: true,
  preferences: {
    preferred: ['en'],
    alwaysTranslate: [],
    neverTranslate: [],
    neverTranslateSites: [],
    autoOffer: true
  },
  languages: ['de', 'en', 'fr'],
  installed: [],
  downloading: [],
  registryDate: '2026-09-01',
  modelLicense: 'MPL-2.0',
  tabs: {}
}

/** Electron's checker with dictionaries for a few languages, `enabled` ones checked in. */
function checker(
  languages: Array<
    [code: string, name: string, enabled: boolean, status?: SpellcheckDictionaryStatus]
  >,
  systemLanguages = false
): SpellcheckStatus {
  return {
    available: true,
    systemLanguages,
    languages: languages.map(([code, name, enabled, status]) => ({
      code,
      name,
      enabled,
      status: status ?? (enabled ? 'ready' : 'unknown')
    }))
  }
}

/** The labels of the section list, in order. */
function navLabels(markup: string): string[] {
  const nav = markup.match(/<nav[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? ''
  return Array.from(nav.matchAll(/<button[^>]*>([^<]*)<\/button>/g), (m) => m[1])
}

function render(s: UIState): string {
  return renderToStaticMarkup(createElement(SettingsPanel, { state: s }))
}

describe('the Settings panel on hosts without page controls', () => {
  beforeEach(() => uiStore.set({ overlaySection: null }))

  it('has no Accessibility category on the desktop, where Chrome keeps zoom in the menu', () => {
    const labels = navLabels(render(state(DESKTOP, 'linux')))
    expect(labels).not.toContain('Accessibility')
    expect(labels.slice(0, 2)).toEqual(['Look and Feel', 'Compact Mode'])
  })

  it('shows Look and Feel when the store still names the Accessibility section on the desktop', () => {
    uiStore.set({ overlaySection: 'accessibility' })
    const markup = render(state(DESKTOP, 'linux'))
    expect(markup).not.toContain('Default zoom')
    expect(markup).toContain('Look and Feel')
  })

  it('lists Accessibility on a desktop with a speech engine, holding Read aloud alone (CT-12)', () => {
    const s = state({ ...DESKTOP, readAloud: true }, 'linux')
    s.settings = {
      ...DEFAULT_SETTINGS,
      readAloud: { rate: 1.5, voiceByLanguage: {}, highlight: 'sentence' }
    }
    expect(navLabels(render(s)).slice(0, 2)).toEqual(['Look and Feel', 'Accessibility'])
    uiStore.set({ overlaySection: 'accessibility' })
    const markup = render(s)
    // The pane: its title, the two groups of the shared builder, the voice list still on its way.
    expect(markup).toContain('data-testid="accessibility-pane"')
    expect(markup).toContain('Read aloud')
    expect(markup).toContain('Speed')
    expect(markup).toContain('1.5×')
    expect(markup).toContain('Highlight while reading')
    expect(markup).toContain('Sentence')
    expect(markup).toContain('Voices')
    expect(markup).toContain('Looking for voices…')
    // The phone's zoom groups stay off the desktop.
    expect(markup).not.toContain('Default zoom')
    expect(markup).not.toContain('Page zoom')
  })

  it('lists Accessibility after Look and Feel on a host with page controls', () => {
    const labels = navLabels(render(state(ANDROID, 'android')))
    expect(labels.slice(0, 2)).toEqual(['Look and Feel', 'Accessibility'])
    uiStore.set({ overlaySection: 'accessibility' })
    expect(render(state(ANDROID, 'android'))).toContain('Default zoom')
  })

  it("keeps Chrome's Page zoom menulist and the per-site zooms under Appearance on the desktop", () => {
    const s = state(DESKTOP, 'linux')
    s.settings = {
      ...DEFAULT_SETTINGS,
      pageControls: { ...DEFAULT_SETTINGS.pageControls, siteZooms: { 'wikipedia.org': 1.25 } }
    }
    const markup = render(s)
    expect(markup).toContain('Page zoom')
    expect(markup).toContain('Sites with their own zoom')
    expect(markup).toContain('wikipedia.org')
    expect(markup).toContain('125%')
    expect(markup).toContain('Remove zoom: wikipedia.org')
    // The Android sheet's rows stay off the desktop.
    expect(markup).not.toContain('Default zoom')
    expect(markup).not.toContain('Desktop site')
  })

  it('leaves Page zoom to Accessibility on a host with page controls', () => {
    const markup = render(state(ANDROID, 'android'))
    expect(markup).not.toContain('Page zoom')
    expect(markup).not.toContain('Sites with their own zoom')
  })
})

describe('the Page zoom menulist', () => {
  it("walks Chrome's presets from 25 to 500 percent", async () => {
    const { zoomChoices } = await import('@shared/pageControls')
    const labels = zoomChoices(1).map((c) => c.label)
    expect(labels[0]).toBe('25%')
    expect(labels[labels.length - 1]).toBe('500%')
    expect(labels).toContain('100%')
    expect(labels).toHaveLength(17)
    expect(zoomChoices(1).find((c) => c.label === '110%')?.value).toBe('110')
  })

  it('lists a stored factor off the ladder in its place rather than showing nothing', async () => {
    const { zoomChoices, zoomKey } = await import('@shared/pageControls')
    const choices = zoomChoices(1.15)
    expect(choices).toHaveLength(18)
    const idx = choices.findIndex((c) => c.value === zoomKey(1.15))
    expect(choices[idx - 1]?.label).toBe('110%')
    expect(choices[idx + 1]?.label).toBe('125%')
  })
})

describe('Settings › Languages › Spell check on the desktop', () => {
  beforeEach(() => uiStore.set({ overlaySection: 'languages' }))

  it('shows the switch, the languages checked in with what their dictionary is doing, and Add', () => {
    const s = state(DESKTOP, 'linux')
    s.spellcheck = checker([
      ['en-US', 'English (United States)', true],
      ['de', 'German', true, 'downloading'],
      ['fr', 'French', true, 'failed'],
      ['es', 'Spanish', false]
    ])
    const markup = render(s)
    expect(markup).toContain('Check the spelling of text fields')
    expect(markup).toContain('English (United States)')
    expect(markup).toContain('Downloading dictionary…')
    expect(markup).toContain('Dictionary download failed')
    expect(markup).toContain('Stop checking in German')
    // The languages not checked in wait in the Add menulist, not in the list.
    expect(markup).not.toContain('Stop checking in Spanish')
    expect(markup).toContain('Add a language to check in')
    expect(markup).toContain('checked in up to 5 languages at a time')
    expect(markup).toContain('Custom dictionary')
    expect(markup).not.toContain('Open keyboard settings')
  })

  it("replaces Add with Chrome's limit caption once five languages are checked in", () => {
    const s = state(DESKTOP, 'linux')
    s.spellcheck = checker([
      ['en-US', 'English (United States)', true],
      ['de', 'German', true],
      ['fr', 'French', true],
      ['es', 'Spanish', true],
      ['it', 'Italian', true],
      ['pt', 'Portuguese', false]
    ])
    const markup = render(s)
    expect(markup).toContain(
      'Up to 5 languages can be checked at a time. Remove one to add another.'
    )
    expect(markup).not.toContain('Add a language to check in')
  })

  it('reads the list at .4 with the switch off, the switch alone live (§9.30)', () => {
    const s = state(DESKTOP, 'linux')
    s.settings = {
      ...DEFAULT_SETTINGS,
      spellcheck: { ...DEFAULT_SETTINGS.spellcheck, enabled: false }
    }
    s.spellcheck = checker([['en-US', 'English (United States)', true]])
    const markup = render(s)
    const row = markup.match(/<div[^>]*data-language="en-US"[^>]*>/)?.[0] ?? ''
    expect(row).toContain('aria-disabled="true"')
    expect(markup).toContain('Check the spelling of text fields')
    // The whole languages list and the dictionary form follow the switch.
    expect(markup.match(/aria-disabled="true"/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it("names System Settings where the OS's checker chooses the languages (macOS)", () => {
    const s = state(DESKTOP, 'darwin')
    s.spellcheck = checker([['en-US', 'English (United States)', true]], true)
    const markup = render(s)
    expect(markup).toContain('System Settings › Keyboard')
    expect(markup).not.toContain('Add a language to check in')
    expect(markup).not.toContain('Stop checking in')
    expect(markup).toContain('Custom dictionary')
  })

  it("states the keyboard's checker and leads to its settings where the host has none of its own", () => {
    const markup = render(state(ANDROID, 'android'))
    expect(markup).toContain('Spell check')
    expect(markup).toContain('spell checker of the keyboard in use')
    expect(markup).toContain('Open keyboard settings')
    expect(markup).not.toContain('Check the spelling of text fields')
    expect(markup).not.toContain('Custom dictionary')
  })
})

describe('Look and Feel › Sites behind the darkening capability', () => {
  beforeEach(() => uiStore.set({ overlaySection: 'look' }))

  it('has the dark theme switch and the exceptions on a desktop that darkens pages without the rest of the page controls', () => {
    const s = state({ ...DESKTOP, darkenSites: true }, 'linux')
    let markup = render(s)
    expect(markup).toContain('Apply dark theme to sites')
    // With no exception yet the list is the one plain §9.17 row: one sentence, no full stop.
    expect(markup).toContain('>No exceptions yet<')
    expect(markup).not.toContain('No exceptions yet.')
    // The Android sheet's Desktop site row stays off the desktop.
    expect(markup).not.toContain('Desktop site')

    s.settings = {
      ...DEFAULT_SETTINGS,
      pageControls: {
        ...DEFAULT_SETTINGS.pageControls,
        darkenSiteExceptions: { 'sepia.example': false }
      }
    }
    markup = render(s)
    expect(markup).toContain('sepia.example')
    expect(markup).toContain('Dark theme off')
    expect(markup).toContain('Remove exception: sepia.example')
    expect(markup).not.toContain('No exceptions yet')
  })

  it('shows no Sites group at all on a host that neither darkens nor has page controls', () => {
    const markup = render(state(DESKTOP, 'linux'))
    expect(markup).not.toContain('Apply dark theme to sites')
    expect(markup).not.toContain('Site exceptions')
  })

  it('has both rows, and the one plain empty row, on a host with page controls', () => {
    const markup = render(state(ANDROID, 'android'))
    expect(markup).toContain('Desktop site')
    expect(markup).toContain('Apply dark theme to sites')
    expect(markup).toContain('>No exceptions yet<')
  })
})
