// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Settings, Tab, UIState } from '@shared/types'
import { INTERNAL_PAGES, availableSections } from '@shared/internalPages'
import { DEFAULT_BLOCKING_SETTINGS, emptyBlockingStatus } from '@shared/blocking'
import {
  DEFAULT_CONTAINERS,
  DEFAULT_SETTINGS,
  emptyAutofillUIState,
  emptyPasswordsStatus,
  emptyResourceSnapshot
} from '@shared/defaults'
import { DEFAULT_PAGE_ENVIRONMENT } from '@shared/pageControls'
import { DEFAULT_SEARCH_ENGINES } from '@shared/search'
import type { TranslateUIState } from '@shared/translate'
import { emptyPrivacyStatus } from '@shared/privacy'
import { emptyUpdateStatus } from '@shared/updates'

/*
 * The desktop's Settings rows, as the overlay panes had them before the tab (PR #193) became the
 * one rendering: every category the Electron host shows is built through the shared builder
 * with the desktop layout and walked, and each row the panes offered – Zen's, #62's Security,
 * #106's Languages, #115's tracking prevention, #135's site controls, #145's Autofill, #156's
 * protection, #228's zoom, dark theme and spell check, #254's sync scope – is asserted by its
 * label, item sheets included. The list is the inventory taken on `main` before the merge
 * (`internal/desktop-parity/settings-row-inventory-pr193.md`); a row that moves category or
 * loses its label fails here rather than silently.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { buildSection } = await import('../sections')
const { allRows, groupShows } = await import('../model')
const { idleAutofillSettings } = await import('@renderer/lib/autofillSettings')
const { idleDictionaryWords } = await import('@renderer/lib/spellcheckWords')

/** Electron's capabilities (`src/main/platform/index.ts`), the Windows material on. */
const ELECTRON: HostCapabilities = {
  windowControls: true,
  windowControlsOverlay: false,
  windowMaterial: true,
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
  defaultBrowser: true,
  requestBlocking: true,
  reducedExtensionIsolation: false,
  pageControls: false,
  darkenSites: true,
  privateTabs: false,
  secureDns: true,
  newTabPage: true,
  pageTabs: true,
  pinShortcuts: false,
  translate: true,
  voiceSearch: false,
  screenCapture: true,
  shareSheet: true,
  selectionToolbar: false,
  popupSurface: true,
  qrScan: false,
  readAloud: true
}

const SETTINGS_TAB = {
  id: 'settings',
  spaceId: 'space',
  containerId: 'default',
  url: 'zen://settings',
  title: 'Settings',
  favicon: null,
  pinned: false,
  essential: false,
  pinnedUrl: null,
  customTitle: null,
  customIcon: null,
  windowId: null,
  folderId: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  audible: false,
  muted: false,
  discarded: false,
  frozen: false,
  cpuThrottle: 1,
  zoom: 1,
  splitGroupId: null,
  createdAt: 0,
  lastActiveAt: 0,
  errorCode: null,
  bookmarked: false,
  readerable: false,
  blockedCount: 0,
  openerTabId: null
} as Tab

const TRANSLATE: TranslateUIState = {
  available: true,
  preferences: {
    preferred: ['en', 'de'],
    alwaysTranslate: ['fr'],
    neverTranslate: ['es'],
    neverTranslateSites: ['example.org'],
    autoOffer: true
  },
  languages: ['de', 'en', 'fr', 'es'],
  installed: [
    { from: 'de', to: 'en', version: '1.0', bytes: 35_000_000, installed: true, downloading: false }
  ],
  downloading: [],
  registryDate: '2026-09-01',
  modelLicense: 'MPL-2.0',
  tabs: {}
}

const NOW = 1_800_000_000_000

/** A desktop profile with something in every list, so the per-item rows build too. */
function desktopState(): UIState {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    spaceRouting: { 'example.com': 'space' },
    unloadExcludedDomains: ['mail.example.com'],
    pageControls: {
      ...DEFAULT_SETTINGS.pageControls,
      siteZooms: { 'wikipedia.org': 1.25 },
      darkenSiteExceptions: { 'example.net': false }
    },
    agents: { ...DEFAULT_SETTINGS.agents, enabled: true },
    downloads: { ...DEFAULT_SETTINGS.downloads, autoOpenTypes: ['pdf'] },
    blocking: {
      ...DEFAULT_BLOCKING_SETTINGS,
      customLists: [
        {
          id: 'custom:annoyances',
          url: 'https://example.com/annoyances.txt',
          name: 'Annoyances',
          enabled: true
        }
      ]
    }
  } as Settings
  return {
    platform: 'linux',
    capabilities: ELECTRON,
    version: '0.3.77-test',
    systemDark: false,
    tabs: { settings: SETTINGS_TAB },
    essentialTabIds: [],
    spaces: [{ id: 'space', name: 'Personal', activeTabId: 'settings', tabIds: ['settings'] }],
    activeSpaceId: 'space',
    containers: DEFAULT_CONTAINERS,
    folders: {},
    splitGroups: {},
    settings,
    shortcuts: [
      {
        id: 'key_newNavigatorTab',
        action: 'tab.new',
        group: 'windowAndTabManagement',
        label: 'New tab',
        binding: { key: 't', ctrl: true, alt: false, shift: false, meta: false },
        extraBindings: [],
        unsupported: false,
        hidden: false
      }
    ],
    searchEngines: DEFAULT_SEARCH_ENGINES,
    searchEngineControl: null,
    glance: null,
    compactSidebarRevealed: false,
    window: {
      id: 'w',
      kind: 'main',
      maximized: false,
      fullscreen: false,
      focused: true,
      htmlFullscreenTabId: null
    },
    downloads: [],
    downloadsProgress: { active: 0, progress: 0 },
    bookmarks: [],
    newTabShortcuts: [{ id: 'nt1', title: 'Zenium', url: 'https://zenium.example/' }],
    newTabHiddenHosts: [],
    newTabBackground: { image: false, canPick: true },
    recentlyClosedCount: 0,
    recentlyClosed: [],
    media: [],
    findResult: null,
    devtoolsOpenFor: [],
    resources: { ...emptyResourceSnapshot(), restartRequired: true },
    foreignTabIds: [],
    windowCount: 1,
    boosts: [
      {
        domain: 'github.com',
        enabled: true,
        tint: null,
        tintIntensity: 0,
        font: null,
        fontSize: 100,
        darkMode: false,
        zapped: [],
        css: '',
        updatedAt: 1
      }
    ],
    zappingTabId: null,
    liveFolders: {},
    extensions: [],
    extensionUpdates: { checking: false, lastCheckedAt: null },
    sidePanel: null,
    mods: [{ id: 'm1', name: 'Round tabs', source: null, css: '', enabled: true, updatedAt: 1 }],
    sync: {
      enabled: true,
      folder: '/home/me/Sync',
      folderName: '/home/me/Sync',
      folderLost: false,
      deviceId: 'dev',
      deviceName: 'Laptop',
      scope: {
        spaces: true,
        folders: true,
        pinnedTabs: true,
        essentials: true,
        openTabs: false,
        containers: true,
        bookmarks: true,
        passwords: true,
        settings: true,
        shortcuts: true,
        boosts: true
      },
      lastSyncAt: NOW - 60_000,
      lastError: null,
      syncing: false,
      devices: [{ id: 'other', name: 'Phone', lastSeen: NOW - 120_000 }],
      pendingMerge: false
    },
    agents: [],
    agentServer: {
      running: true,
      url: 'http://127.0.0.1:8765/mcp',
      lanUrls: [],
      token: 'secret-token',
      error: null
    },
    updates: emptyUpdateStatus('0.3.77-test', { os: 'linux', arch: 'x64', kind: 'appimage' }),
    passwords: emptyPasswordsStatus(),
    defaultBrowser: { isDefault: false, prompt: null },
    blockedPopups: {},
    permissionRules: [{ origin: 'https://meet.example', permission: 'camera', decision: 'allow' }],
    permissionDefaults: {},
    lastSafetyCheck: null,
    permissionPrompts: [],
    securityPrompts: [],
    pageDialogs: [],
    screenCaptureRequests: [],
    shareRequests: [],
    crashRestore: null,
    autofill: emptyAutofillUIState(),
    blocking: {
      ...emptyBlockingStatus(),
      ready: true,
      lists: [
        {
          id: 'easylist',
          name: 'EasyList',
          description: 'Ads',
          url: 'https://lists.example/easylist.txt',
          homepage: 'https://lists.example/easylist',
          licence: 'GPL-3.0',
          tier: 'basic',
          enabled: true,
          version: '1',
          updatedAt: NOW,
          filterCount: 1000,
          bundled: false,
          updating: false,
          lastError: null
        },
        {
          id: 'custom:annoyances',
          name: 'Annoyances',
          description: 'Annoyances filters',
          url: 'https://example.com/annoyances.txt',
          homepage: 'https://example.com/',
          licence: 'GPL-3.0',
          tier: null,
          enabled: true,
          version: '1',
          updatedAt: NOW,
          filterCount: 10,
          bundled: false,
          updating: false,
          lastError: null
        }
      ],
      siteExceptions: ['https://news.example']
    },
    privacy: { ...emptyPrivacyStatus(), httpsOnlyExceptions: ['intranet.example'] },
    translate: TRANSLATE,
    pageEnvironment: DEFAULT_PAGE_ENVIRONMENT,
    spellcheck: {
      available: true,
      systemLanguages: false,
      languages: [
        { code: 'en-US', name: 'English (United States)', enabled: true, status: 'ready' },
        { code: 'de', name: 'German', enabled: false, status: 'unknown' }
      ]
    },
    readAloud: null,
    import: null
  } as unknown as UIState
}

/**
 * The inventory: the desktop overlay's categories on `main` before the merge, each with the
 * labels of its rows as the builder words them. A category the overlay had of its own that the
 * builder folds into another (Site Settings, Clear Browsing Data and Safety Check sit under
 * Privacy and Security, as the phone had them) is listed under the category it lives in now.
 */
const INVENTORY: Record<string, readonly string[]> = {
  look: [
    'Colour scheme',
    'Toolbar layout',
    'Tabs on the right',
    'Expanded sidebar',
    'Remove browser padding',
    'Use Windows transparency effects',
    'Page zoom',
    'wikipedia.org',
    'Remove zoom',
    'Colour',
    'Show bookmarks bar',
    'Import bookmarks',
    'Export bookmarks',
    'Floating behaviour',
    'Apply dark theme to sites',
    'example.net',
    'Remove exception',
    'Split view drag and drop',
    'Enable Glance',
    'Trigger'
  ],
  compact: ['Enable compact mode', 'Hide sidebar', 'Hide top toolbar'],
  newtab: [
    'Open the new tab page',
    'Layout',
    'Shortcuts',
    'Background',
    'Change background image',
    'Remove background image',
    'Show a greeting',
    'Zenium',
    'Add shortcut'
  ],
  tabs: [
    'Open new tabs',
    'Show separator between pinned and regular tabs',
    'Ctrl+Tab stays within Essentials or regular tabs',
    'Restore previous session on startup',
    'Restore pages after a crash',
    'Warn before closing a window with multiple tabs',
    'Tabs across windows',
    'Open a blank window',
    'When closing a pinned tab',
    'Restore pinned tabs to their pinned URL on startup',
    'Third-party links on pinned and essential tabs',
    'Container-specific Essentials',
    'Maximum number of Essentials',
    'Unload inactive tabs',
    'Unload after',
    'Never unload these domains'
  ],
  downloads: [
    'Save files to',
    'Open the downloads folder',
    'Always ask where to save files',
    'Show the downloads when a download finishes',
    'Show the downloads when a download starts',
    'Always show the downloads button',
    'Notify when a download finishes',
    'Open certain file types automatically'
  ],
  resources: [
    'Memory, CPU and GPU memory',
    'Free up memory now',
    'Refresh the sample',
    'Keep the browser within budgets',
    'Enforcement',
    'Memory budget',
    'Share of installed RAM',
    'CPU budget',
    'GPU memory budget',
    'On battery, shrink budgets to',
    'Freeze hidden pages after',
    'Freeze everything when idle for',
    'Unload hidden pages',
    'Unload hidden pages after',
    'Maximum live pages',
    'Background loads at once',
    'Pages playing audio',
    'Pinned tabs',
    'Essentials',
    'Excluded domains',
    'Relaunch to apply',
    'GPU',
    'Renderer process limit',
    'JavaScript heap cap per page',
    'Low-end device mode',
    'No spare renderer process',
    'Drop the back/forward cache',
    'Block prerendering',
    'Raster threads per page',
    'V8: favour memory over speed'
  ],
  search: [
    'Default search engine',
    'Show search suggestions',
    'Show history suggestions',
    'Show bookmark suggestions',
    'Always show full URLs',
    'Engine keywords'
  ],
  autofill: [
    'Offer to save passwords',
    'Sign in automatically',
    'Clear copied passwords',
    'Unlock'
  ],
  languages: [
    'Offer to translate pages in other languages',
    'English',
    'German',
    'Translate pages into this language',
    'Add a language',
    'French',
    'Spanish',
    'example.org',
    'German to English',
    'Remove model',
    'Download a model',
    'Check the spelling of text fields',
    'English (United States)',
    'Zenium',
    'Add a new word'
  ],
  privacy: [
    // Safety Check (#135)
    'Safety check',
    'Check now',
    // Security (#156)
    'Protection level',
    'Google Safe Browsing API key',
    'Update feeds now',
    // Tracking prevention (#115)
    'Block ads and trackers',
    'Level',
    'Update lists automatically',
    'Update lists now',
    'EasyList',
    'Annoyances',
    'Add a list by its URL',
    'Edit your filters',
    'news.example',
    'Add a site',
    // Clear Browsing Data (#135)
    'Clear browsing data',
    // Cookies, HTTPS-only, secure DNS, signals (#156)
    'Third-party cookies',
    'HTTPS-only mode',
    'intranet.example',
    'Use secure DNS',
    'Resolver',
    'Send a Global Privacy Control signal',
    'Send a Do Not Track request',
    // Site Settings (#135): the 40 content types and the sites with their own settings
    'Location',
    'Camera',
    'Microphone',
    'Notifications',
    'Background sync',
    'Motion sensors',
    'Automatic downloads',
    'MIDI devices',
    'USB devices',
    'Serial ports',
    'HID devices',
    'Bluetooth devices',
    'File editing',
    'Clipboard',
    'Payment handlers',
    'Insecure content',
    'Virtual reality',
    'Window management',
    'Fonts',
    'Local network access',
    'Images',
    'JavaScript',
    'Pop-ups and redirects',
    'Ads and trackers',
    'Sound',
    'PDF documents',
    'Protected content',
    'Third-party sign-in',
    'On-device site data',
    'Open other apps',
    'Cookies while embedded',
    'Cookies for embedded sites',
    'Your device use',
    'Fullscreen',
    'Pointer lock',
    'Keyboard lock',
    'Speaker selection',
    'Clipboard writes',
    'Screen sharing',
    'MIDI system messages',
    'Default behaviour',
    'meet.example',
    'Reset all sites'
  ],
  spaces: ['example.com', 'Remove route', 'Add route'],
  containers: [
    'No Container',
    'Personal',
    'Colour',
    'Icon',
    'Move up',
    'Move down',
    'Delete container',
    'New container'
  ],
  boosts: ['github.com', 'Boost a site'],
  mods: ['Round tabs', 'New Mod', 'Import from URL', 'Import from file'],
  extensions: ['From the Chrome Web Store', 'From a file', 'Load unpacked', 'Check for updates'],
  agents: [
    'Enable the MCP server',
    'Port',
    'Allow devices on the local network',
    'Connection token',
    'Regenerate token',
    'Default mode for new agents',
    'Show the agent’s cursor',
    'Ask before a new agent connects',
    'Allow agents to run JavaScript in pages'
  ],
  passwords: ['Manage passwords', 'Offer to save passwords', 'Ask again before showing or copying'],
  // #259's Import (ID-23): the pane's two dialog rows; the last import's one row comes and goes.
  import: ['Bookmarks, history and passwords', 'Bookmarks HTML or passwords CSV'],
  security: ['meet.example', 'Forget sign-ins and certificates'],
  sync: [
    'Sync now',
    'Name',
    'Phone',
    'Spaces',
    'Folders',
    'Pinned tabs',
    'Essentials',
    'Open tabs',
    'Containers',
    'Bookmarks',
    'Passwords',
    'Settings',
    'Keyboard shortcuts',
    'Boosts',
    'Turn off sync',
    'Turn off and remove this device’s data'
  ],
  shortcuts: ['Shortcut set', 'Your changes', 'New tab'],
  'default-browser': ['Zenium is not your default browser'],
  updates: [
    'Check for updates',
    'Check for updates automatically',
    'Download updates in the background',
    'Release channel',
    'Verification'
  ],
  about: ['Zenium', 'Check for updates', 'Engine', 'Upstream project']
}

/** Group headings the overlay's panes named that the builder keeps as headings. */
const HEADINGS: Record<string, readonly string[]> = {
  look: [
    'Appearance',
    'Sites with their own zoom',
    'App icon',
    'Bookmarks',
    'Sites',
    'Site exceptions',
    'Split view',
    'Glance'
  ],
  tabs: ['Tabs', 'Window sync', 'Pinned tabs and Essentials', 'Tab unloading'],
  languages: [
    'Translation',
    'Languages you read',
    'Always translate',
    'Never translate',
    'Sites never translated',
    'Translation models',
    'Spell check',
    'Custom dictionary'
  ],
  privacy: [
    'Safety check',
    'Safe Browsing',
    'Tracking prevention',
    'Filter lists',
    'Your lists',
    'Your filters',
    'Sites without blocking',
    'Clear browsing data',
    'Third-party cookies',
    'Site settings',
    'Content',
    'Additional permissions',
    'Sites with their own settings',
    'HTTPS-only mode',
    'Sites allowed over http',
    'Secure DNS',
    'Privacy signals'
  ],
  sync: ['Sync across devices', 'This device', 'Devices', 'What to sync'],
  import: ['Import from another browser', 'Import from a file'],
  security: ['Site permissions', 'This session'],
  passwords: ['Password manager', 'Saving', 'Security']
}

const PAGE = INTERNAL_PAGES.settings

describe('the desktop Settings tab carries every row of the overlay panes it replaces', () => {
  const state = desktopState()
  const sections = availableSections(PAGE, ELECTRON, 'desktop', 'linux')
  const ctx = {
    state,
    tab: SETTINGS_TAB,
    pointer: true,
    formFactor: 'desktop' as const,
    set: () => undefined,
    navigate: () => undefined,
    openBarEditor: () => undefined,
    boost: () => undefined,
    autofill: idleAutofillSettings(),
    screenLock: false,
    readAloudVoices: null,
    dictionary: { ...idleDictionaryWords(), words: ['Zenium'] }
  }
  const models = new Map(sections.map((s) => [s.id, buildSection(s, ctx)]))

  it('shows the overlay’s categories in Zen’s order, three of them folded into Privacy and Security', () => {
    expect(sections.map((s) => s.label)).toEqual([
      'Look and Feel',
      'Compact Mode',
      'New Tab',
      'Tab Management',
      'Downloads',
      'Resources',
      'Search',
      'Autofill',
      'Languages',
      'Privacy and Security',
      'Space Routing',
      'Containers',
      'Boosts',
      'Mods',
      'Extensions',
      'AI Agents',
      'Passwords',
      'Security',
      'Sync',
      'Import',
      'Accessibility',
      'Keyboard Shortcuts',
      'Default Browser',
      'Updates',
      'About'
    ])
    // Accessibility was the overlay's `pageControls` category (false on Electron); the speech
    // engine (#257, `readAloud`) brings it to the desktop with Read aloud's groups alone – the
    // zoom groups stay the phone's.
    expect(models.get('accessibility')!.groups.map((g) => g.id)).toEqual([
      'read-aloud',
      'read-aloud-voices'
    ])
  })

  for (const [id, labels] of Object.entries(INVENTORY)) {
    it(`carries the ${id} rows`, () => {
      const model = models.get(id)
      expect(model, `${id} is not a desktop category`).toBeDefined()
      const rows = allRows(model!.groups)
      const found = new Set(rows.map((r) => r.label))
      const missing = labels.filter((label) => !found.has(label))
      expect(missing, `rows of ${id} the tab does not carry`).toEqual([])
      // Nothing of the phone shell's reaches the desktop: every group and row shown is the
      // desktop's, and no group is left with no rows and no empty state.
      for (const group of model!.groups) {
        expect(group.layouts ?? ['desktop']).toContain('desktop')
        expect(groupShows(group), `${id} › ${group.id} shows`).toBe(true)
      }
      for (const row of rows) expect(row.layouts ?? ['desktop']).toContain('desktop')
    })
  }

  for (const [id, headings] of Object.entries(HEADINGS)) {
    it(`keeps the ${id} group headings`, () => {
      const model = models.get(id)!
      const found = model.groups.map((g) => g.heading).filter((h) => h !== null)
      expect(headings.filter((h) => !found.includes(h))).toEqual([])
    })
  }

  it('gives every row of a category an id of its own', () => {
    for (const [id, model] of models) {
      const ids = allRows(model.groups).map((r) => r.id)
      const dupes = ids.filter((rowId, i) => ids.indexOf(rowId) !== i)
      expect(dupes, `${id} repeats row ids`).toEqual([])
    }
  })

  // The desktop vocabulary (§10.5): a command row trails a button, so the phone's whole-row tap
  // targets the other programs added never reach the desktop as bare text. A row that leaves the
  // page (chevron, external) or leads with a status glyph (the safety check's results) is the
  // pressable row on both.
  it('gives every plain action row a desktop button label', () => {
    const bare: string[] = []
    for (const [id, model] of models) {
      for (const row of allRows(model.groups)) {
        if (row.kind !== 'action' || row.leaves || row.leading || row.button) continue
        bare.push(`${id} › ${row.label}`)
      }
    }
    expect(bare).toEqual([])
  })
})
