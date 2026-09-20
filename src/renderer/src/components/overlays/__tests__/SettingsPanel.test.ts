// @vitest-environment happy-dom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import type { HostCapabilities, UIState } from '@shared/types'
import { DEFAULT_SETTINGS, emptyPasswordsStatus, emptyResourceSnapshot } from '@shared/defaults'
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
  selectionToolbar: false,
  popupSurface: true,
  qrScan: false
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
    pageEnvironment: { largeScreen: false, pointerAndKeyboard: false, fontScale: 1 }
  } as unknown as UIState
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
