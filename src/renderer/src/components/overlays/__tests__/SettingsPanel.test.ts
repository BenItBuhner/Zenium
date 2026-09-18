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
  privateTabs: false,
  windowControlsOverlay: false,
  windowMaterial: false,
  secureDns: true
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
  privateTabs: true,
  secureDns: false
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
})
