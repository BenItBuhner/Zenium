// @vitest-environment happy-dom
import {
  createElement,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ExtensionErrorEntry,
  ExtensionInfo,
  FormFactor,
  HostCapabilities,
  ImportSource,
  Platform,
  SafetyCheckResult,
  SearchEngine,
  Settings,
  SyncStatus,
  Tab,
  ToolbarLayout,
  UIState,
  WebDavProbe
} from '@shared/types'
import type { InstalledWebApp } from '@shared/webApp'
import { defaultScope } from '@core/sync/records'
import { DEFAULT_WEBDAV_FOLDER } from '@core/sync/webdav'
import { PROXY_MODES, type ProxyMode } from '@core/extensions/api/proxy'
import { INTERNAL_PAGES, availableSections } from '@shared/internalPages'
import {
  DEFAULT_BLOCKING_SETTINGS,
  customListId,
  emptyBlockingStatus,
  type FilterListStatus,
  type ListTier,
  type TrackingLevel,
  type TrackingLevelPrivateMode
} from '@shared/blocking'
import {
  DEFAULT_CONTAINERS,
  DEFAULT_SETTINGS,
  INACTIVE_TAB_AUTO_CLOSE_DAYS,
  emptyAgentServerStatus,
  emptyAgentSkillStatus,
  emptyAutofillUIState,
  emptyPasswordsStatus,
  emptyResourceSnapshot
} from '@shared/defaults'
import { EXTENSION_SETTING_KEYS } from '@shared/extensionSettings'
import {
  ANDROID_FONT_FAMILIES,
  FONT_SIZE_STEPS,
  GENERIC_FONT_FAMILIES,
  MINIMUM_FONT_SIZE_STEPS
} from '@shared/fonts'
import { HELP_URL, ISSUES_URL } from '@shared/links'
import { MAX_NEW_TAB_SHORTCUTS } from '@shared/newTab'
import { defaultShortcuts } from '@shared/shortcuts'
import { DEFAULT_PAGE_ENVIRONMENT } from '@shared/pageControls'
import { DEFAULT_SEARCH_ENGINES, withDefaultSearchEngineActive } from '@shared/search'
import { UNAVAILABLE_SPELLCHECK } from '@shared/spellcheck'
import { THEME_PRESETS, makeTheme } from '@shared/theme'
import type { TranslateUIState } from '@shared/translate'
import { emptyPrivacyStatus, type PrivacyStatus } from '@shared/privacy'
import { emptySiteDataStatus } from '@shared/siteData'
import { TOAST_UNDO_MS } from '@shared/toastCard'
import { emptyUpdateStatus } from '@shared/updates'

/*
 * The phone Settings page as data (v2 §10.3–10.4): every category builds from the browser state
 * into groups of rows with unique ids, the rows of other wave PRs (#46, #52, #78) are in place,
 * a row's callback runs the setting or command it stands for, and the landing's search reads
 * the same rows across every category.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const {
  buildSection,
  buildSections,
  autoCloseDescription,
  MOD_PICTURE_HINT,
  PROXY_SETTINGS_COPY,
  proxyHeldDescription
} = await import('../sections')
const {
  allRows,
  controlledRuns,
  currentOptionLabel,
  findRow,
  groupShows,
  itemMenuItems,
  onLayout,
  optionGroups,
  rowText,
  searchRows
} = await import('../model')
const { extensionRevealStore } = await import('@renderer/lib/extensions/manage')
const { FontPreview } = await import('../fontBlocks')
const { SearchEngineForm } = await import('../blocks')
const { familyOptions, fontSizeOptions, previewFamilies } = await import('../fontsModel')
const { uiStore } = await import('@renderer/lib/ui')
const { idleAutofillSettings } = await import('@renderer/lib/autofillSettings')
const { idleDictionaryWords } = await import('@renderer/lib/spellcheckWords')
const { SYNC_COPY, SYNC_SCOPES, clearSyncSetup, emptySyncSetup, syncSetupStore } =
  await import('@renderer/lib/syncSetup')
const remoteTabs = await import('@renderer/lib/remoteTabs')

type Model = ReturnType<typeof buildSection>
type Row = ReturnType<typeof allRows>[number]
type ItemRow = Extract<Row, { kind: 'item' }>
type RowGroup = Model['groups'][number]

const ANDROID: HostCapabilities = {
  windowControls: false,
  windowControlsOverlay: false,
  windowMaterial: false,
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
  print: true,
  printPreview: false,
  savePageFormats: false,
  pdfViewer: true,
  pdfPrint: false,
  agents: true,
  agentSkills: false,
  updates: true,
  share: true,
  sharePanel: false,
  clipboardChip: true,
  appLinkSettings: true,
  pullToRefresh: true,
  passwords: true,
  defaultBrowser: true,
  requestBlocking: true,
  reducedExtensionIsolation: false,
  pageControls: true,
  darkenSites: true,
  privateTabs: true,
  inactiveTabs: true,
  secureDns: false,
  quitsThroughCore: false,
  lookalikeHolds: false,
  newTabPage: false,
  pageTabs: true,
  // Kotlin's boot info turns this on where the launcher can pin (ShortcutManagerCompat).
  pinShortcuts: false,
  translate: true,
  voiceSearch: false,
  screenCapture: false,
  shareSheet: false,
  selectionToolbar: true,
  popupSurface: false,
  qrScan: false,
  readAloud: false,
  pageLanguages: false,
  genericFontFamilies: false,
  caretBrowsing: false,
  placementAnswered: true
}

function tab(id: string, url: string, patch: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 'space',
    containerId: 'default',
    url,
    title: id,
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
    openerTabId: null,
    ...patch
  } as Tab
}

const SITE = tab('site', 'https://news.example/')
const SETTINGS = tab('settings', 'zen://settings', { openerTabId: 'site', title: 'Settings' })

/** The translation engine's slice (#106): two languages read, one always, a site, two models. */
const TRANSLATE: TranslateUIState = {
  available: true,
  preferences: {
    preferred: ['en', 'fr'],
    alwaysTranslate: ['es'],
    neverTranslate: [],
    neverTranslateSites: ['news.example'],
    autoOffer: true
  },
  languages: ['de', 'en', 'es', 'fr'],
  installed: [
    { from: 'es', to: 'en', version: '1.0', bytes: 40_000_000, installed: true, downloading: false }
  ],
  downloading: [
    { from: 'de', to: 'en', version: '1.0', bytes: 40_000_000, installed: false, downloading: true }
  ],
  registryDate: '2026-09-01',
  modelLicense: 'MPL-2.0',
  tabs: {}
}

/** Safe Browsing with two feeds in memory, refreshed two minutes ago (#156's rows read it). */
const SAFE_BROWSING: PrivacyStatus['safeBrowsing'] = {
  ready: true,
  enabled: true,
  entries: 4895,
  updating: false,
  lastUpdatedAt: Date.now() - 2 * 60_000,
  remoteLookups: false,
  remoteErrors: 0,
  feeds: [
    {
      id: 'urlhaus',
      name: 'URLhaus',
      homepage: 'https://urlhaus.abuse.ch/',
      licence: 'CC0',
      entries: 4000,
      updatedAt: Date.now() - 2 * 60_000,
      bundled: false,
      updating: false,
      lastError: null
    },
    {
      id: 'phishing-database',
      name: 'Phishing.Database',
      homepage: 'https://phish.co.za/',
      licence: 'MIT',
      entries: 895,
      updatedAt: null,
      bundled: true,
      updating: false,
      lastError: null
    }
  ]
}
const PRIVACY_STATUS: PrivacyStatus = { ...emptyPrivacyStatus(), safeBrowsing: SAFE_BROWSING }

function state(patch: Partial<UIState> = {}, settings: Partial<Settings> = {}): UIState {
  return {
    platform: 'android',
    capabilities: ANDROID,
    version: '0.3.0-test',
    tabs: { site: SITE, settings: SETTINGS },
    essentialTabIds: [],
    spaces: [
      { id: 'space', name: 'Personal', activeTabId: 'settings', tabIds: ['site', 'settings'] }
    ],
    activeSpaceId: 'space',
    containers: DEFAULT_CONTAINERS,
    folders: {},
    splitGroups: {},
    settings: { ...DEFAULT_SETTINGS, ...settings },
    shortcuts: [],
    searchEngines: DEFAULT_SEARCH_ENGINES,
    extensionControls: {},
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
    bookmarks: [],
    readingList: [],
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
    webApps: [],
    agents: [],
    agentServer: emptyAgentServerStatus(),
    agentSkills: emptyAgentSkillStatus(),
    updates: emptyUpdateStatus('0.3.0-test', { os: 'android', arch: 'arm64', kind: 'apk' }),
    passwords: emptyPasswordsStatus(),
    autofill: emptyAutofillUIState(),
    defaultBrowser: { isDefault: false, prompt: null },
    permissionRules: [],
    permissionDefaults: {},
    deviceGrants: [],
    lastSafetyCheck: null,
    blocking: emptyBlockingStatus(),
    privacy: emptyPrivacyStatus(),
    pageEnvironment: DEFAULT_PAGE_ENVIRONMENT,
    newTabShortcuts: [],
    siteData: emptySiteDataStatus(),
    newTabBackground: { image: false, canPick: false, accent: null },
    translate: TRANSLATE,
    spellcheck: UNAVAILABLE_SPELLCHECK,
    ...patch
  } as unknown as UIState
}

/** A list of the user's own, as the settings keep it and as the engine reports it. */
const CUSTOM = {
  id: customListId('https://example.com/annoyances.txt'),
  url: 'https://example.com/annoyances.txt',
  name: 'Annoyances',
  enabled: true
}

function filterList(id: string, name: string, tier: ListTier | null): FilterListStatus {
  return {
    id,
    name,
    description: `${name} filters`,
    url: `https://lists.example/${id}.txt`,
    homepage: `https://lists.example/${id}`,
    licence: 'GPL-3.0',
    tier,
    enabled: true,
    version: '202609190000',
    updatedAt: 1_000_000,
    filterCount: 1000,
    bundled: false,
    updating: false,
    lastError: null
  }
}

/**
 * The request engine ready and busy (#115): two default lists and a custom one, a site excepted,
 * two filters of the user's with one line the parser refused, 1,284 requests blocked so far.
 */
function blockingState(patch: Partial<UIState> = {}): UIState {
  return state(
    {
      blocking: {
        ...emptyBlockingStatus(),
        ready: true,
        sessionBlocked: 1284,
        siteExceptions: ['https://news.example'],
        lastUpdatedAt: 1_000_000,
        lists: [
          filterList('easylist', 'EasyList', 'basic'),
          filterList('easyprivacy', 'EasyPrivacy', 'balanced'),
          filterList(CUSTOM.id, CUSTOM.name, null)
        ],
        userFilterErrors: [{ line: 2, message: 'Unknown option "foo"' }]
      },
      ...patch
    },
    {
      blocking: {
        ...DEFAULT_BLOCKING_SETTINGS,
        customLists: [CUSTOM],
        userFilters: '||ads.example^\n||tracker.example^$foo'
      }
    }
  )
}

type AutofillData = Parameters<typeof buildSection>[1]['autofill']
type VoicesData = Parameters<typeof buildSection>[1]['readAloudVoices']
type DictionaryWords = Parameters<typeof buildSection>[1]['dictionary']

/**
 * A context that records what the rows ask of the page; a touch host unless `pointer` says so.
 * The vault reads idle (no lists, the gate idle) unless `autofill` brings some; the speech
 * engine's voices are still on their way (null) unless `readAloudVoices` brings the list; the
 * custom dictionary has no words unless `dictionary` brings some; the device has a screen lock
 * unless `screenLock` says not.
 */
function context(
  s: UIState = state(),
  pointer = false,
  autofill: Partial<AutofillData> = {},
  readAloudVoices: VoicesData = null,
  dictionary: Partial<DictionaryWords> = {},
  screenLock = true
): {
  ctx: Parameters<typeof buildSection>[1]
  patches: Partial<Settings>[]
  navigated: string[]
  barEditor: number
  boosted: string[]
} {
  const record = { patches: [] as Partial<Settings>[], navigated: [] as string[], barEditor: 0 }
  const boosted: string[] = []
  const ctx: Parameters<typeof buildSection>[1] = {
    state: s,
    tab: s.tabs.settings ?? SETTINGS,
    pointer,
    set: (patch) => record.patches.push(patch),
    navigate: (section) => record.navigated.push(section),
    openBarEditor: () => {
      record.barEditor += 1
    },
    boost: (tabId) => boosted.push(tabId),
    autofill: { ...idleAutofillSettings(), ...autofill },
    readAloudVoices,
    dictionary: { ...idleDictionaryWords(), ...dictionary },
    screenLock
  }
  return {
    ctx,
    get patches() {
      return record.patches
    },
    get navigated() {
      return record.navigated
    },
    get barEditor() {
      return record.barEditor
    },
    boosted
  }
}

const PAGE = INTERNAL_PAGES.settings

function phoneSections(s: UIState = state()): Model[] {
  return buildSections(availableSections(PAGE, s.capabilities, 'phone'), context(s).ctx)
}

function section(id: string, s: UIState = state()): Model {
  const def = PAGE.sections.find((x) => x.id === id)
  if (!def) throw new Error(`no section ${id}`)
  return buildSection(def, context(s).ctx)
}

function row(model: Model, id: string): Row {
  const found = findRow(model.groups, id)
  if (!found) throw new Error(`no row ${id} in ${model.section.id}`)
  return found
}

/** The class list of a row's glyph element (a Lucide icon rendered with a `className`). */
function glyphClass(node: ReactNode): string {
  if (!isValidElement<{ className?: string }>(node)) throw new Error('not a glyph element')
  return node.props.className ?? ''
}

beforeEach(() => invoke.mockClear())

describe('the section model', () => {
  it('builds every phone category into groups that draw something', () => {
    const models = phoneSections()
    expect(models.map((m) => m.section.id)).toEqual([
      'look',
      'tabs',
      'downloads',
      'search',
      'autofill',
      'languages',
      'privacy',
      'spaces',
      'containers',
      'boosts',
      // No Mods: the phone shell mounts no ModStyles (seed #31; the Mods describe below).
      'agents',
      'passwords',
      'security',
      'import',
      'accessibility',
      'updates',
      'about'
    ])
    for (const model of models) {
      expect(model.groups.length, model.section.id).toBeGreaterThan(0)
      expect(model.groups.every(groupShows), model.section.id).toBe(true)
    }
  })

  it('keeps row ids unique within a category, item sheets included', () => {
    const containers = [
      ...DEFAULT_CONTAINERS,
      { id: 'school', name: 'School', color: 'yellow', icon: 'tree' },
      { id: 'travel', name: 'Travel', color: 'purple', icon: 'vacation' }
    ]
    const s = state({ containers } as Partial<UIState>, {
      pageControls: {
        ...DEFAULT_SETTINGS.pageControls,
        siteZooms: { 'a.test': 1.25, 'b.test': 0.9 },
        desktopSites: { 'a.test': true },
        darkenSiteExceptions: { 'b.test': false }
      }
    })
    for (const model of phoneSections(s)) {
      const ids = allRows(model.groups).map((r) => r.id)
      expect(new Set(ids).size, model.section.id).toBe(ids.length)
      for (const group of model.groups) {
        for (const r of group.rows) expect(r.label, `${model.section.id}/${r.id}`).not.toBe('')
      }
    }
  })

  it('has the rows the wave added: Default browser (#46), Navigation bar (#52), page controls (#78)', () => {
    const look = section('look')
    expect(row(look, 'navigation-bar').kind).toBe('action')
    expect(row(look, 'desktop-site').kind).toBe('value')
    expect(row(look, 'darken-sites')).toMatchObject({
      kind: 'switch',
      label: 'Apply dark theme to sites'
    })
    expect(look.groups.find((g) => g.id === 'site-exceptions')?.empty).toBe('No exceptions yet')

    const access = section('accessibility')
    expect(access.groups.map((g) => g.heading)).toEqual([
      'Page zoom',
      'Sites with their own zoom',
      'Touchpad'
    ])
    expect(row(access, 'default-zoom').kind).toBe('custom')
    expect(row(access, 'zoom-os-font').label).toBe('Include system font size')
    expect(row(access, 'force-zoom').label).toBe('Force enable zoom')

    const about = section('about')
    expect(row(about, 'default-browser')).toMatchObject({
      kind: 'action',
      label: 'Set as default browser'
    })
    const isDefault = section('about', state({ defaultBrowser: { isDefault: true, prompt: null } }))
    expect(row(isDefault, 'default-browser')).toMatchObject({
      kind: 'info',
      label: 'Default browser'
    })
  })

  it('opens What’s new and the Legal group’s Privacy notice and Terms as chrome pages, on a host with page tabs alone (SET-54, SET-55)', () => {
    const about = section('about')
    expect(about.groups.map((g) => [g.id, g.heading])).toEqual([
      ['about', 'About'],
      ['legal', 'Legal']
    ])
    expect(about.groups[0]!.rows.map((r) => r.id)).toEqual([
      'version',
      'check-updates',
      'get-help',
      'report-issue',
      'default-browser',
      'open-by-default',
      'whats-new',
      'engine',
      'upstream',
      'licences'
    ])
    const whatsNew = row(about, 'whats-new')
    expect(whatsNew).toMatchObject({
      kind: 'action',
      label: 'What’s new',
      description: 'The highlights of Zenium 0.3.0-test.',
      leaves: 'chevron'
    })
    if (whatsNew.kind !== 'action') throw new Error('not an action row')
    whatsNew.onPress?.()
    expect(invoke).toHaveBeenCalledWith('page.open', { id: 'whats-new', section: undefined })

    expect(about.groups[1]!.rows.map((r) => [r.id, r.label])).toEqual([
      ['privacy-notice', 'Privacy notice'],
      ['terms', 'Terms']
    ])
    for (const id of ['privacy-notice', 'terms'] as const) {
      const legal = row(about, id)
      if (legal.kind !== 'action') throw new Error('not an action row')
      expect(legal.leaves).toBe('chevron')
      legal.onPress?.()
      expect(invoke).toHaveBeenCalledWith('page.open', { id, section: undefined })
    }
    // The landing's search finds them under About by their words.
    expect(searchRows([about], 'privacy notice').map((h) => h.row.id)).toEqual(['privacy-notice'])
    expect(searchRows([about], 'release notes').map((h) => h.row.id)).toEqual(['whats-new'])

    // The version block (the desktop's custom row, settings-73) copies its report on a hold on a
    // touch layout (the toast's word with it); the desktop's is text to select.
    const version = row(about, 'version')
    expect(version).toMatchObject({
      kind: 'custom',
      copy: {
        text: expect.stringMatching(
          /^Zenium 0\.3\.0-test( · Chromium [\d.]+)? · Android System WebView$/
        ),
        confirmation: 'Version copied'
      }
    })
    const desktop = buildSection(
      PAGE.sections.find((x) => x.id === 'about')!,
      { ...context(state()).ctx, formFactor: 'desktop' }
    )
    expect(row(desktop, 'version')).not.toHaveProperty('copy')

    // Open by default (DEF-06): the host's reading on the row, the tap leaving for the screen.
    const openBy = row(about, 'open-by-default')
    expect(openBy).toMatchObject({
      kind: 'action',
      label: 'Open by default',
      description: 'Choose which links open in Zenium.',
      leaves: 'external'
    })
    if (openBy.kind !== 'action') throw new Error('not an action row')
    openBy.onPress?.()
    expect(invoke).toHaveBeenCalledWith('app.openAppLinkSettings', undefined)
    const allowed = section(
      'about',
      state({ defaultBrowser: { isDefault: true, prompt: null, appLinks: 'allowed' } })
    )
    expect(row(allowed, 'open-by-default').description).toBe(
      'Zenium is set to open web links from other apps.'
    )
    const disallowed = section(
      'about',
      state({ defaultBrowser: { isDefault: false, prompt: null, appLinks: 'disallowed' } })
    )
    expect(row(disallowed, 'open-by-default').description).toBe(
      'Zenium is set not to open web links from other apps.'
    )
    // Without the screen (a desktop host) there is no row.
    const noScreen = section(
      'about',
      state({ capabilities: { ...ANDROID, appLinkSettings: false } })
    )
    expect(findRow(noScreen.groups, 'open-by-default')).toBeNull()

    // A host without page tabs has nowhere to open a chrome page: the rows stay away.
    const noTabs = section('about', state({ capabilities: { ...ANDROID, pageTabs: false } }))
    expect(findRow(noTabs.groups, 'whats-new')).toBeNull()
    expect(noTabs.groups.map((g) => g.id)).toEqual(['about'])
  })

  it('carries #115’s Privacy and security groups (tracking-*) at Chrome’s tracking-prevention position, behind requestBlocking', () => {
    const privacy = section('privacy', blockingState())
    // The engine's groups sit after the Cookies and site data groups, before the signals (the
    // #650 lead check: Chrome's cookies-and-ad-privacy stretch); their own order and content are
    // asserted here (the whole category's order is #135's test).
    const tracking = privacy.groups.filter((g) => g.id.startsWith('tracking-'))
    expect(tracking.map((g) => g.id)).toEqual([
      'tracking-prevention',
      'tracking-lists',
      'tracking-custom-lists',
      'tracking-filters',
      'tracking-exceptions'
    ])
    expect(tracking.map((g) => g.heading)).toEqual([
      'Tracking prevention',
      'Filter lists',
      'Your lists',
      'Your filters',
      'Sites without blocking'
    ])
    // The engine's rows are its own groups: every row and every item-sheet row is tracking-*
    // (the remembered per-site answers are Security's since #62).
    for (const r of allRows(tracking)) expect(r.id, r.label).toMatch(/^tracking-/)
    expect(row(privacy, 'tracking-enabled')).toMatchObject({
      kind: 'switch',
      label: 'Block ads and trackers',
      checked: true
    })
    const level = row(privacy, 'tracking-level')
    if (level.kind !== 'value') throw new Error('not a value row')
    expect(currentOptionLabel(level)).toBe('Balanced')
    expect(level.options.map((o) => o.label)).toEqual(['Off', 'Basic', 'Balanced', 'Strict'])
    expect(row(privacy, 'tracking-blocked')).toMatchObject({
      kind: 'info',
      description: '1,284 requests'
    })
    // Each list is one item whose sheet holds its switch, its refresh and its homepage.
    expect(row(privacy, 'tracking-list:easylist')).toMatchObject({
      kind: 'item',
      label: 'EasyList'
    })
    expect(row(privacy, 'tracking-list:easylist:enabled').kind).toBe('switch')
    expect(row(privacy, 'tracking-list:easylist:update').kind).toBe('action')
    expect(row(privacy, 'tracking-list:easylist:homepage')).toMatchObject({
      kind: 'action',
      leaves: 'external'
    })
    // A custom list adds a destructive Remove that confirms first; the excepted site an item.
    expect(row(privacy, `tracking-list:${CUSTOM.id}:remove`)).toMatchObject({
      kind: 'action',
      destructive: true,
      confirm: { action: 'Remove' }
    })
    expect(row(privacy, 'tracking-site:https://news.example')).toMatchObject({
      kind: 'item',
      label: 'news.example'
    })
    expect(row(privacy, 'tracking-add-list').kind).toBe('action')
    expect(row(privacy, 'tracking-add-site').kind).toBe('action')
    expect(row(privacy, 'tracking-user-filters')).toMatchObject({
      kind: 'action',
      description: '2 filters · 1 line not understood'
    })

    // Without the engine its groups build to nothing (`availableSections` hides the whole
    // category, `requires`); #135's and #156's groups are the ones left.
    const without = section(
      'privacy',
      blockingState({ capabilities: { ...ANDROID, requestBlocking: false } })
    )
    expect(without.groups.filter((g) => g.id.startsWith('tracking-'))).toEqual([])
    // W7-6's hub cards lead (a group the desktop and tablet shells draw; the fixture has no
    // layout, so it stays here too); the programs follow in the cards' order (W8-8, Q6), a
    // group no card names after the card it is kin to (the #650 lead check) – the signals
    // after Cookies where Tracking prevention would stand, HTTPS-only and Secure DNS after
    // Safe Browsing.
    expect(without.groups.map((g) => g.id)).toEqual([
      'privacy-hub',
      'clear-data',
      'site-data',
      'cookies-related-sites',
      'cookies-add-site',
      'site-data-allow',
      'site-data-allow-add',
      'site-data-clearOnExit',
      'site-data-clearOnExit-add',
      'site-data-block',
      'site-data-block-add',
      'site-data-exit',
      'site-data-viewer',
      'signals',
      'safe-browsing',
      'safe-browsing-feeds',
      'https-only',
      'https-only-sites',
      'secure-dns',
      'sites-permissions',
      'sites-content',
      'sites-additional',
      'sites-own',
      'sites-unused',
      'safety-check',
      'safety-check-results',
      'safety-check-actions',
      'preload',
      'private-lock'
    ])
  })

  it('carries the overview’s "Confirm before closing all tabs" switch in Tabs, bound to confirmCloseAll (TAB-06)', () => {
    const c = context(state({}, { confirmCloseAll: false }))
    const tabs = buildSection(
      PAGE.sections.find((x) => x.id === 'tabs')!,
      c.ctx
    )
    const ids = tabs.groups.find((g) => g.id === 'tabs')?.rows.map((r) => r.id) ?? []
    // A row among the tab rows, right before the session ones; no card of its own (§9.17).
    expect(ids.indexOf('confirm-close-all')).toBe(ids.indexOf('restore-session') - 1)
    const confirm = row(tabs, 'confirm-close-all')
    if (confirm.kind !== 'switch') throw new Error('not a switch')
    expect(confirm.label).toBe('Confirm before closing all tabs')
    expect(confirm.checked).toBe(false)
    confirm.onChange(true)
    expect(c.patches).toEqual([{ confirmCloseAll: true }])
    expect(DEFAULT_SETTINGS.confirmCloseAll).toBe(true)

    // A windowed host has no tab overview and no Close all tabs: the switch stays off its Tabs.
    const desktop = buildSection(
      PAGE.sections.find((x) => x.id === 'tabs')!,
      context(state({ platform: 'linux', capabilities: { ...ANDROID, windows: true } })).ctx
    )
    expect(findRow(desktop.groups, 'confirm-close-all')).toBeNull()
  })

  it('carries "Lock private tabs when you leave Zenium" in Privacy and Security, device-local and off by default, confirmed by the device before the core keeps it (INC-05, SET-17)', async () => {
    const { privateLockStore, resetPrivateLock, setPrivateLockHost } =
      await import('@renderer/lib/privateLock')
    resetPrivateLock()
    const verify = vi.fn(async () => true)
    setPrivateLockHost({ verify, unlock: async () => ({ locked: false }) })
    privateLockStore.set({ screenLock: true })
    try {
      const privacy = section('privacy', state({ privateLockOnLeave: false }))
      // The last group of the category, Chrome's position (after Do Not Track), its own heading.
      const group = privacy.groups.at(-1)!
      expect(group).toMatchObject({ id: 'private-lock', heading: 'Private tabs' })
      const lock = row(privacy, 'private-lock-on-leave')
      if (lock.kind !== 'switch') throw new Error('not a switch')
      expect(lock.label).toBe('Lock private tabs when you leave Zenium')
      expect(lock.description).toBe('Use your screen lock to see them again.')
      expect(lock.checked).toBe(false)
      expect(lock.disabled).toBe(false)
      // The switch is `state.privateLockOnLeave` (BrowserState.privateDevice), not a setting: the
      // change is the device's confirmation, then the core's device-local command – no
      // `settings.update` patch.
      lock.onChange(true)
      await vi.waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('private.setLockOnLeave', { enabled: true })
      )
      expect(verify).toHaveBeenCalledTimes(1)
      expect(
        section('privacy', state({ privateLockOnLeave: true })).groups.at(-1)!.rows[0]
      ).toMatchObject({
        checked: true
      })
      // The landing's search finds it by Chrome's name for it too.
      expect(searchRows([privacy], 'incognito').map((r) => r.row.id)).toEqual([
        'private-lock-on-leave'
      ])

      // No screen lock on the device: the row is disabled at .4 (§9.30), its description says why,
      // and the change is not made.
      const bare = buildSection(
        PAGE.sections.find((x) => x.id === 'privacy')!,
        context(state(), false, {}, null, {}, false).ctx
      )
      const disabled = row(bare, 'private-lock-on-leave')
      if (disabled.kind !== 'switch') throw new Error('not a switch')
      expect(disabled.disabled).toBe(true)
      expect(disabled.description).toBe('Needs a screen lock on this device.')
      privateLockStore.set({ screenLock: false })
      invoke.mockClear()
      disabled.onChange(true)
      await Promise.resolve()
      expect(invoke).not.toHaveBeenCalled()

      // Phone-host-only, as `confirmCloseAll`: a windowed host's private window has no lock.
      const desktop = buildSection(
        PAGE.sections.find((x) => x.id === 'privacy')!,
        context(state({ platform: 'linux', capabilities: { ...ANDROID, windows: true } })).ctx
      )
      expect(findRow(desktop.groups, 'private-lock-on-leave')).toBeNull()
      expect(desktop.groups.some((g) => g.id === 'private-lock')).toBe(false)
    } finally {
      resetPrivateLock()
    }
  })

  it('carries #129’s session rows where the desktop panel has them: Tabs, on a windowed host only', () => {
    const phone = section('tabs')
    expect(findRow(phone.groups, 'crash-restore')).toBeNull()
    expect(findRow(phone.groups, 'warn-close-window')).toBeNull()
    // The phone's startup row is the switch it was (W6-3): the windowed hosts have On startup.
    expect(findRow(phone.groups, 'restore-session')?.kind).toBe('switch')

    const c = context(state({ platform: 'linux', capabilities: { ...ANDROID, windows: true } }))
    const tabs = buildSection(
      PAGE.sections.find((x) => x.id === 'tabs')!,
      c.ctx
    )
    const ids = tabs.groups.find((g) => g.id === 'tabs')?.rows.map((r) => r.id) ?? []
    expect(findRow(tabs.groups, 'restore-session')).toBeNull()
    expect(ids.slice(ids.indexOf('crash-restore'))).toEqual(['crash-restore', 'warn-close-window'])
    const crash = row(tabs, 'crash-restore')
    if (crash.kind !== 'value') throw new Error('not a value row')
    expect(crash.value).toBe(DEFAULT_SETTINGS.crashRestore)
    expect(crash.options.map((o) => o.label)).toEqual(['Ask first', 'Restore them', 'Start fresh'])
    crash.onChange('never')
    const warn = row(tabs, 'warn-close-window')
    if (warn.kind !== 'switch') throw new Error('not a switch')
    expect(warn.checked).toBe(DEFAULT_SETTINGS.warnOnCloseWindow)
    warn.onChange(!warn.checked)
    expect(c.patches).toEqual([
      { crashRestore: 'never' },
      { warnOnCloseWindow: !DEFAULT_SETTINGS.warnOnCloseWindow }
    ])
  })

  it('carries #161’s Downloads rows in Chrome’s words: Location with Change…, ask where to save, auto-open types, the notification; the bubble’s switches on a windowed host only', async () => {
    const c = context(state())
    const downloads = buildSection(
      PAGE.sections.find((x) => x.id === 'downloads')!,
      c.ctx
    )
    expect(downloads.groups.map((g) => g.id)).toEqual(['saving', 'download-notifications'])
    expect(downloads.groups.every(groupShows)).toBe(true)
    // Location (Chrome's `IDS_SETTINGS_DOWNLOAD_LOCATION`) names the system folder until the
    // engine has said where that is or one is picked; a dismissed picker keeps it.
    const folder = row(downloads, 'download-directory')
    expect(folder.label).toBe('Location')
    expect(folder.description).toBe('The system Downloads folder')
    // …and those words are prose: they keep §9.2's two lines, not the path's one (seed #29).
    expect(folder.address).toBe(false)
    // No Use the default folder row while the default is in force (§10.4): the row is there only
    // once a folder has been picked, and then as a plain action row, never a disabled one.
    expect(
      downloads.groups.flatMap((g) => g.rows).find((r) => r.id === 'download-directory-default')
    ).toBeUndefined()
    if (folder.kind !== 'action') throw new Error('not an action')
    expect(folder.button).toBe('Change…')
    invoke.mockResolvedValueOnce(null)
    folder.onPress?.()
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledWith('download.chooseDirectory', undefined)
    expect(c.patches).toEqual([])
    invoke.mockResolvedValueOnce('/sdcard/Zenium' as never)
    folder.onPress?.()
    await new Promise((r) => setTimeout(r, 0))
    // The one-key patch goes inside `downloads`; `askWhereToSave` stays at the top level.
    expect(c.patches).toEqual([{ downloads: { directory: '/sdcard/Zenium' } }])
    // The engine's answer to `download.directory` – the desktop's platform folder by its path,
    // as Chrome's row shows it (HB-20) – is the line once the page has it, over the setting.
    const resolved = buildSection(
      PAGE.sections.find((x) => x.id === 'downloads')!,
      {
        ...c.ctx,
        downloadDirectory: '/home/bennett/Downloads'
      }
    )
    expect(row(resolved, 'download-directory').description).toBe('/home/bennett/Downloads')
    // A path: one line, shortened from its start so the folder's name stays (§9.2's exception).
    expect(row(resolved, 'download-directory').address).toBe(true)
    // An empty answer (a host that cannot name one) leaves the setting's words.
    const unnamed = buildSection(
      PAGE.sections.find((x) => x.id === 'downloads')!,
      {
        ...c.ctx,
        downloadDirectory: ''
      }
    )
    expect(row(unnamed, 'download-directory').description).toBe('The system Downloads folder')
    expect(row(unnamed, 'download-directory').address).toBe(false)
    // A folder picked on Android is a document-tree URI: the row reads its relative path (#93).
    const pickedCtx = context(
      state(
        {},
        {
          downloads: {
            ...DEFAULT_SETTINGS.downloads,
            directory:
              'content://com.android.externalstorage.documents/tree/primary%3ADownload%2FZenium'
          }
        }
      )
    )
    const picked = buildSection(
      PAGE.sections.find((x) => x.id === 'downloads')!,
      pickedCtx.ctx
    )
    expect(row(picked, 'download-directory').description).toBe('Download/Zenium')
    expect(row(picked, 'download-directory').address).toBe(true)
    // …and the way back appears under it, enabled: Use the default folder clears the setting.
    const useDefault = row(picked, 'download-directory-default')
    expect(useDefault.disabled).toBeUndefined()
    expect(useDefault.label).toBe('Use the default folder')
    expect(
      picked.groups
        .find((g) => g.id === 'saving')!
        .rows.map((r) => r.id)
        .slice(0, 2)
    ).toEqual(['download-directory', 'download-directory-default'])
    if (useDefault.kind !== 'action') throw new Error('not an action')
    expect(useDefault.button).toBe('Use default')
    useDefault.onPress?.()
    expect(pickedCtx.patches).toEqual([{ downloads: { directory: null } }])
    // The interface's label (Chrome's `IDS_SETTINGS_PROMPT_FOR_DOWNLOAD` runs on "before
    // downloading", a second line on a phone; it stays a search keyword); no switch for the
    // danger warnings, as Chrome has none (Safe Browsing governs them).
    const ask = row(downloads, 'ask-where-to-save')
    expect(ask.label).toBe('Ask where to save each file')
    expect(ask.keywords).toContain('before downloading')
    expect(
      downloads.groups.flatMap((g) => g.rows).filter((r) => /danger|warn/i.test(r.label))
    ).toEqual([])
    if (ask.kind !== 'switch') throw new Error('not a switch')
    expect(ask.checked).toBe(DEFAULT_SETTINGS.askWhereToSave)
    ask.onChange(true)
    const notify = row(downloads, 'download-notify')
    if (notify.kind !== 'switch') throw new Error('not a switch')
    notify.onChange(true)
    expect(c.patches.slice(1)).toEqual([
      { askWhereToSave: true },
      { downloads: { notifyOnComplete: true } }
    ])
    // No row for the auto-open list while it is empty; the row clears it after a confirmation.
    expect(findRow(downloads.groups, 'download-auto-open')).toBeNull()
    const typed = context(
      state({}, { downloads: { ...DEFAULT_SETTINGS.downloads, autoOpenTypes: ['pdf', 'png'] } })
    )
    const withTypes = buildSection(
      PAGE.sections.find((x) => x.id === 'downloads')!,
      typed.ctx
    )
    const auto = row(withTypes, 'download-auto-open')
    expect(auto.description).toBe('.pdf, .png')
    if (auto.kind !== 'action') throw new Error('not an action')
    expect(auto.confirm?.action).toBe('Stop')
    auto.onPress?.()
    expect(typed.patches).toEqual([{ downloads: { autoOpenTypes: [] } }])
    // The Tabs group no longer carries the ask-where-to-save row (#161 moved it on the desktop).
    expect(findRow(section('tabs').groups, 'ask-where-to-save')).toBeNull()

    // The downloads bubble and its toolbar button are the desktop chrome's.
    const windowed = context(
      state({ platform: 'linux', capabilities: { ...ANDROID, windows: true } })
    )
    const desktop = buildSection(
      PAGE.sections.find((x) => x.id === 'downloads')!,
      windowed.ctx
    )
    expect(desktop.groups.map((g) => g.id)).toEqual([
      'saving',
      'downloads-panel',
      'download-notifications'
    ])
    expect(desktop.groups.find((g) => g.id === 'downloads-panel')?.rows.map((r) => r.id)).toEqual([
      'download-open-on-complete',
      'download-open-on-start',
      'download-always-show-button'
    ])
  })

  describe('#145’s Autofill category', () => {
    const AUTOFILL = PAGE.sections.find((x) => x.id === 'autofill')!
    const unlocked = (): UIState =>
      state({ passwords: { ...emptyPasswordsStatus(), locked: false } })
    const address = {
      id: 'a1',
      country: 'US',
      name: 'Ada Lovelace',
      organization: 'Analytical Engines',
      streetAddress: '12 Ada Way',
      locality: 'Springfield',
      region: 'CA',
      postalCode: '90210',
      sortingCode: '',
      phone: '',
      email: '',
      createdAt: 0,
      updatedAt: 0,
      lastUsedAt: null
    }
    const card = {
      id: 'c1',
      last4: '4242',
      network: 'visa' as const,
      expMonth: 12,
      expYear: 2031,
      expired: false,
      name: 'Ada Lovelace',
      nickname: 'Work Visa',
      createdAt: 0,
      updatedAt: 0,
      lastUsedAt: null
    }
    const passkey = {
      id: 'p1',
      rpId: 'example.com',
      rpName: 'Example',
      userName: 'ada@example.com',
      userDisplayName: 'Ada',
      credentialId: '',
      origin: 'https://example.com',
      createdAt: 0,
      lastUsedAt: null
    }

    it('is listed behind the passwords capability, like the desktop section', () => {
      expect(AUTOFILL.requires).toBe('passwords')
      const without = state({ capabilities: { ...ANDROID, passwords: false } })
      expect(phoneSections(without).some((m) => m.section.id === 'autofill')).toBe(false)
      expect(phoneSections().some((m) => m.section.id === 'autofill')).toBe(true)
    })

    it('carries the password switches and the clipboard choice, patching inside `passwords`', () => {
      const c = context(state())
      const model = buildSection(AUTOFILL, c.ctx)
      const offer = row(model, 'autofill-offer-to-save')
      if (offer.kind !== 'switch') throw new Error('not a switch')
      expect(offer.checked).toBe(DEFAULT_SETTINGS.passwords.offerToSave)
      offer.onChange(!offer.checked)
      const auto = row(model, 'autofill-auto-sign-in')
      if (auto.kind !== 'switch') throw new Error('not a switch')
      auto.onChange(true)
      const clear = row(model, 'autofill-clipboard-clear')
      if (clear.kind !== 'value') throw new Error('not a value row')
      expect(clear.value).toBe(String(DEFAULT_SETTINGS.passwords.clipboardClearSeconds))
      expect(clear.options.map((o) => o.value)).toEqual(['0', '30', '60', '120', '300'])
      clear.onChange('120')
      expect(c.patches).toEqual([
        { passwords: { ...DEFAULT_SETTINGS.passwords, offerToSave: !offer.checked } },
        { passwords: { ...DEFAULT_SETTINGS.passwords, autoSignIn: true } },
        { passwords: { ...DEFAULT_SETTINGS.passwords, clipboardClearSeconds: 120 } }
      ])
    })

    it('offers Zenium as the provider on Android alone: pressable while a system service is set, naming it', () => {
      const none = buildSection(AUTOFILL, context(state()).ctx)
      const off = row(none, 'autofill-android-provider')
      if (off.kind !== 'switch') throw new Error('not a switch')
      // No service set: Zenium fills either way, so the switch reads on and cannot be moved.
      expect(off.checked).toBe(true)
      expect(off.disabled).toBe(true)
      expect(off.description).toMatch(/No autofill service is set/)

      const google = context(
        state({
          autofill: {
            ...emptyAutofillUIState(),
            systemAutofill: {
              enabled: true,
              service: 'com.google.android.gms/.autofill.service.AutofillService'
            }
          }
        })
      )
      const on = row(buildSection(AUTOFILL, google.ctx), 'autofill-android-provider')
      if (on.kind !== 'switch') throw new Error('not a switch')
      expect(on.checked).toBe(false)
      expect(on.disabled).toBeFalsy()
      expect(on.description).toMatch(/^Google saves and fills passwords/)
      on.onChange(true)
      expect(google.patches).toEqual([
        { passwords: { ...DEFAULT_SETTINGS.passwords, androidProvider: 'zenium' } }
      ])

      const desktop = buildSection(AUTOFILL, context(state({ platform: 'linux' })).ctx)
      expect(findRow(desktop.groups, 'autofill-android-provider')).toBeNull()
    })

    it('while the vault is locked shows its gate – Unlock as an action, the passphrase form once asked – and none of the lists', () => {
      const unlock = vi.fn()
      const idle = buildSection(
        AUTOFILL,
        context(state(), false, {
          gate: { step: 'idle', busy: false, error: null, unlock, reset: () => undefined }
        }).ctx
      )
      expect(idle.groups.map((g) => g.id)).toEqual(['autofill-passwords', 'autofill-vault'])
      expect(idle.groups[1]?.heading).toBe('The vault is locked')
      const action = row(idle, 'autofill-unlock')
      if (action.kind !== 'action') throw new Error('not an action')
      expect(action.busy).toBe(false)
      action.onPress?.()
      expect(unlock).toHaveBeenCalledWith()
      expect(findRow(idle.groups, 'autofill-add-address')).toBeNull()

      // Busy while the device checks; a refusal is the gate's description.
      const busy = buildSection(
        AUTOFILL,
        context(state(), false, {
          gate: { step: 'idle', busy: true, error: null, unlock, reset: () => undefined }
        }).ctx
      )
      const checking = row(busy, 'autofill-unlock')
      if (checking.kind !== 'action') throw new Error('not an action')
      expect(checking.busy).toBe(true)
      const refused = buildSection(
        AUTOFILL,
        context(state(), false, {
          gate: {
            step: 'idle',
            busy: false,
            error: 'The vault stayed locked.',
            unlock,
            reset: () => undefined
          }
        }).ctx
      )
      expect(refused.groups[1]?.description).toBe('The vault stayed locked.')

      // Once the vault asks for its passphrase the form takes the gate's place, as a custom row.
      const asked = buildSection(
        AUTOFILL,
        context(state(), false, {
          gate: { step: 'passphrase', busy: false, error: null, unlock, reset: () => undefined }
        }).ctx
      )
      expect(row(asked, 'autofill-vault-passphrase').kind).toBe('custom')
      expect(findRow(asked.groups, 'autofill-unlock')).toBeNull()
      const setup = buildSection(
        AUTOFILL,
        context(state(), false, {
          gate: { step: 'setup', busy: false, error: null, unlock, reset: () => undefined }
        }).ctx
      )
      expect(setup.groups[1]?.heading).toBe('Set a vault passphrase')

      // An unreadable vault: the gate says so and Unlock is not pressable.
      const broken = buildSection(
        AUTOFILL,
        context(
          state({ passwords: { ...emptyPasswordsStatus(), error: 'The vault file is damaged.' } })
        ).ctx
      )
      expect(broken.groups[1]?.description).toBe('The vault file is damaged.')
      expect(row(broken, 'autofill-unlock').disabled).toBe(true)
    })

    it('unlocked: the address, payment method and passkey switches and lists, empty until fetched, one line when empty', () => {
      const c = context(unlocked())
      const model = buildSection(AUTOFILL, c.ctx)
      expect(model.groups.map((g) => g.id)).toEqual([
        'autofill-passwords',
        'autofill-addresses',
        'autofill-addresses-list',
        'autofill-addresses-add',
        'autofill-cards',
        'autofill-cards-list',
        'autofill-cards-add',
        'autofill-passkeys'
      ])
      // Lists not yet fetched draw nothing: no rows and no empty line.
      const addresses = model.groups.find((g) => g.id === 'autofill-addresses-list')!
      expect(addresses.rows).toEqual([])
      expect(addresses.empty).toBeUndefined()
      expect(groupShows(addresses)).toBe(false)
      const saveAddresses = row(model, 'autofill-save-addresses')
      if (saveAddresses.kind !== 'switch') throw new Error('not a switch')
      saveAddresses.onChange(false)
      const saveCards = row(model, 'autofill-save-cards')
      if (saveCards.kind !== 'switch') throw new Error('not a switch')
      saveCards.onChange(false)
      expect(c.patches).toEqual([
        { autofill: { ...DEFAULT_SETTINGS.autofill, addresses: false } },
        { autofill: { ...DEFAULT_SETTINGS.autofill, cards: false } }
      ])

      // Fetched and empty: the §9.17 line, one per list.
      const fetched = buildSection(
        AUTOFILL,
        context(unlocked(), false, { addresses: [], cards: [], passkeys: [] }).ctx
      )
      const empties = fetched.groups.filter((g) => g.rows.length === 0).map((g) => g.empty)
      expect(empties).toEqual(['No addresses saved yet', 'No cards saved yet', 'No passkeys yet'])
      expect(fetched.groups.every(groupShows)).toBe(true)
    })

    it('lists each entry as an item with a glyph and its sheet: edit closes the sheet for the editor, delete confirms, copy is busy while it runs', async () => {
      const { uiStore } = await import('@renderer/lib/ui')
      const copyCard = vi.fn()
      const c = context(unlocked(), false, {
        addresses: [address],
        cards: [card],
        passkeys: [passkey],
        copying: 'c1',
        copyCard
      })
      const model = buildSection(AUTOFILL, c.ctx)
      const ids = allRows(model.groups).map((r) => r.id)
      expect(new Set(ids).size).toBe(ids.length)

      const a = row(model, 'autofill-address:a1')
      if (a.kind !== 'item') throw new Error('not an item')
      expect(a.label).toBe('Ada Lovelace')
      expect(a.description).toMatch(/12 Ada Way/)
      expect(a.leading).toBeTruthy()
      expect(rowText(a)).toMatch(/Analytical Engines/)
      const edit = findRow(a.sheet.groups, 'autofill-address:a1:edit')
      if (edit?.kind !== 'action') throw new Error('not an action')
      expect(edit.closesSheet).toBe(true)
      edit.onPress?.()
      expect(uiStore.get().autofillEdit).toEqual({ kind: 'address', id: 'a1' })
      const remove = findRow(a.sheet.groups, 'autofill-address:a1:delete')
      if (remove?.kind !== 'action') throw new Error('not an action')
      expect(remove.destructive).toBe(true)
      expect(remove.confirm?.action).toBe('Delete')
      remove.onPress?.()
      expect(invoke).toHaveBeenCalledWith('autofill.removeAddress', { id: 'a1' })

      const k = row(model, 'autofill-card:c1')
      if (k.kind !== 'item') throw new Error('not an item')
      expect(k.label).toBe('Work Visa')
      expect(k.description).toBe('Ada Lovelace, expires 12/31')
      // The network and last four are what a search finds it by, nickname or not.
      expect(rowText(k)).toMatch(/Visa/)
      expect(rowText(k)).toMatch(/4242/)
      const copy = findRow(k.sheet.groups, 'autofill-card:c1:copy')
      if (copy?.kind !== 'action') throw new Error('not an action')
      expect(copy.busy).toBe(true)
      copy.onPress?.()
      expect(copyCard).toHaveBeenCalledWith(card)
      const editCard = findRow(k.sheet.groups, 'autofill-card:c1:edit')
      if (editCard?.kind !== 'action') throw new Error('not an action')
      editCard.onPress?.()
      expect(uiStore.get().autofillEdit).toEqual({ kind: 'card', id: 'c1' })
      const add = row(model, 'autofill-add-card')
      if (add.kind !== 'action') throw new Error('not an action')
      add.onPress?.()
      expect(uiStore.get().autofillEdit).toEqual({ kind: 'card', id: null })
      uiStore.set({ autofillEdit: null })

      const p = row(model, 'autofill-passkey:p1')
      if (p.kind !== 'item') throw new Error('not an item')
      expect(p.label).toBe('Ada')
      expect(rowText(p)).toMatch(/example\.com/)
      const forget = findRow(p.sheet.groups, 'autofill-passkey:p1:forget')
      if (forget?.kind !== 'action') throw new Error('not an action')
      expect(forget.destructive).toBe(true)
      forget.onPress?.()
      expect(invoke).toHaveBeenCalledWith('autofill.removePasskey', { id: 'p1' })
    })
  })

  it('carries #148’s New Tab rows on a host that renders the page; the phone has none', () => {
    expect(phoneSections().some((m) => m.section.id === 'newtab')).toBe(false)

    const c = context(
      state({
        capabilities: { ...ANDROID, newTabPage: true },
        newTabShortcuts: [
          { id: 'a', title: 'Zen', url: 'https://zen.test/' },
          { id: 'b', title: '', url: 'https://b.test/' }
        ]
      } as Partial<UIState>)
    )
    const models = buildSections(availableSections(PAGE, c.ctx.state.capabilities, 'phone'), c.ctx)
    expect(models.map((m) => m.section.id).slice(0, 3)).toEqual(['look', 'newtab', 'tabs'])
    const newtab = models[1]
    expect(newtab.groups.map((g) => g.heading)).toEqual([
      'New tab page',
      'My shortcuts',
      null,
      null
    ])
    expect(newtab.groups.every(groupShows)).toBe(true)

    // NTP-12 / NTP-22: the background's own reset is one row and asks nothing – disabled on the
    // default already; the whole page's reset is bulk, behind the row's destructive confirmation.
    const resetBackground = row(newtab, 'newtab-reset-background')
    if (resetBackground.kind !== 'action') throw new Error('not an action')
    expect(resetBackground.disabled).toBe(true)
    expect(resetBackground.confirm).toBeUndefined()
    resetBackground.onPress?.()
    expect(invoke).toHaveBeenCalledWith('newtab.resetBackground', undefined)
    const reset = row(newtab, 'newtab-reset')
    if (reset.kind !== 'action') throw new Error('not an action')
    expect(reset.destructive).toBe(true)
    expect(reset.confirm).toMatchObject({ title: 'Reset the new tab page?', action: 'Reset' })
    reset.onPress?.()
    expect(invoke).toHaveBeenCalledWith('newtab.reset', undefined)

    // The page's preferences patch inside `newTab`, keeping the rest of it. The rows write the
    // one model's sections as the phone's sheet does: a background other than the space gradient
    // is a wallpaper, so the layout becomes Custom with the wallpaper section on.
    const enabled = row(newtab, 'newtab-enabled')
    if (enabled.kind !== 'switch') throw new Error('not a switch')
    enabled.onChange(false)
    const background = row(newtab, 'newtab-background')
    if (background.kind !== 'value') throw new Error('not a value row')
    // No file picker on this host: the image option is not offered.
    expect(background.options.map((o) => o.value)).toEqual(['space', 'solid'])
    background.onChange('solid')
    const focusedModules = { ...DEFAULT_SETTINGS.newTab.modules }
    expect(c.patches).toEqual([
      { newTab: { ...DEFAULT_SETTINGS.newTab, enabled: false } },
      {
        newTab: {
          ...DEFAULT_SETTINGS.newTab,
          preset: 'custom',
          modules: { ...focusedModules, wallpaper: true },
          background: 'solid'
        }
      }
    ])
    // The layout row is the phone sheet's preset, with the same names; the feed layout is not
    // offered while there is no feed.
    const layout = row(newtab, 'newtab-layout')
    if (layout.kind !== 'value') throw new Error('not a value row')
    expect(layout.value).toBe('focused')
    expect(layout.options.map((o) => o.label)).toEqual(['Focused', 'Inspirational', 'Custom'])
    layout.onChange('inspirational')
    expect(c.patches.at(-1)).toEqual({
      newTab: { ...DEFAULT_SETTINGS.newTab, preset: 'inspirational' }
    })
    // Hide is the shortcuts section off; the greeting switch is that section.
    const mode = row(newtab, 'newtab-shortcuts')
    if (mode.kind !== 'value') throw new Error('not a value row')
    expect(mode.value).toBe('most-visited')
    expect(mode.options.map((o) => o.value)).toEqual(['most-visited', 'my-shortcuts', 'hidden'])
    mode.onChange('hidden')
    expect(c.patches.at(-1)).toEqual({
      newTab: {
        ...DEFAULT_SETTINGS.newTab,
        preset: 'custom',
        modules: { ...focusedModules, shortcuts: false }
      }
    })
    const greeting = row(newtab, 'newtab-greeting')
    if (greeting.kind !== 'switch') throw new Error('not a switch')
    expect(greeting.checked).toBe(false)
    greeting.onChange(true)
    expect(c.patches.at(-1)).toEqual({
      newTab: {
        ...DEFAULT_SETTINGS.newTab,
        preset: 'custom',
        modules: { ...focusedModules, greeting: true }
      }
    })

    // A layout synced from a phone has its switch here: Inspirational reads as its sections – a
    // greeting on, the space colours as a wallpaper – and an image this device has not got as
    // the space gradient.
    const synced = section(
      'newtab',
      state({ capabilities: { ...ANDROID, newTabPage: true } } as Partial<UIState>, {
        newTab: { ...DEFAULT_SETTINGS.newTab, preset: 'inspirational', background: 'image' }
      })
    )
    const syncedLayout = row(synced, 'newtab-layout')
    if (syncedLayout.kind !== 'value') throw new Error('not a value row')
    expect(currentOptionLabel(syncedLayout)).toBe('Inspirational')
    expect(row(synced, 'newtab-greeting')).toMatchObject({ checked: true })
    expect(row(synced, 'newtab-background')).toMatchObject({ value: 'space' })
    expect(row(synced, 'newtab-shortcuts')).toMatchObject({ value: 'most-visited' })
    // A background other than the default – as the page shows it, so a solid colour under a
    // layout with its wallpaper section on – arms its reset row.
    const solid = section(
      'newtab',
      state({ capabilities: { ...ANDROID, newTabPage: true } } as Partial<UIState>, {
        newTab: {
          ...DEFAULT_SETTINGS.newTab,
          preset: 'custom',
          modules: { ...DEFAULT_SETTINGS.newTab.modules, wallpaper: true },
          background: 'solid'
        }
      })
    )
    expect(row(solid, 'newtab-reset-background')).toMatchObject({ disabled: false })

    // NTP-14: "Use the picture's colour" is a switch directly under the background – with the
    // image rows, so only where a file can be picked – at rest (disabled) without an image and
    // until its colour is read, on when the active space's theme follows the picture; flipping
    // it is the command.
    expect(findRow(newtab.groups, 'newtab-image-colour')).toBeNull()
    const pickable = (accent: string | null, image = true, following = false): Model =>
      section(
        'newtab',
        state({
          capabilities: { ...ANDROID, newTabPage: true },
          newTabBackground: { image, canPick: true, accent },
          spaces: [
            {
              id: 'space',
              name: 'Personal',
              activeTabId: 'settings',
              tabIds: ['site', 'settings'],
              theme: following ? { ...makeTheme('#3b6fd6'), fromImage: true } : null
            }
          ]
        } as unknown as Partial<UIState>)
      )
    expect(row(pickable(null, false), 'newtab-image-colour')).toMatchObject({
      kind: 'switch',
      checked: false,
      disabled: true
    })
    expect(row(pickable(null), 'newtab-image-colour')).toMatchObject({ disabled: true })
    const ids = pickable('#3b6fd6').groups[0].rows.map((r) => r.id)
    expect(ids.indexOf('newtab-image-colour')).toBe(ids.indexOf('newtab-background') + 1)
    const useColour = row(pickable('#3b6fd6'), 'newtab-image-colour')
    if (useColour.kind !== 'switch') throw new Error('not a switch')
    expect(useColour).toMatchObject({
      label: "Use the picture's colour",
      checked: false,
      disabled: false
    })
    useColour.onChange(true)
    expect(invoke).toHaveBeenCalledWith('newtab.useImageColor', { on: true })
    const following = row(pickable('#3b6fd6', true, true), 'newtab-image-colour')
    if (following.kind !== 'switch') throw new Error('not a switch')
    expect(following).toMatchObject({ checked: true, disabled: false })
    following.onChange(false)
    expect(invoke).toHaveBeenCalledWith('newtab.useImageColor', { on: false })
    // The picture let go while on: the switch keeps the space's choice, at rest.
    expect(row(pickable(null, false, true), 'newtab-image-colour')).toMatchObject({
      checked: true,
      disabled: true
    })

    // A shortcut without a name is listed by its address; its sheet edits, moves and removes it.
    expect(row(newtab, 'shortcut:b').label).toBe('https://b.test/')
    const up = row(newtab, 'shortcut:b:up')
    if (up.kind !== 'action') throw new Error('not an action')
    up.onPress?.()
    expect(invoke).toHaveBeenCalledWith('newtab.reorderShortcuts', { ids: ['b', 'a'] })
    const first = row(newtab, 'shortcut:a:up')
    expect(first.disabled).toBe(true)
    const address = row(newtab, 'shortcut:a:url')
    if (address.kind !== 'field') throw new Error('not a field')
    expect(address.onCommit('not an address')).toBe('Enter a web address.')
    expect(address.onCommit('zen.test/docs')).toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('newtab.updateShortcut', {
      id: 'a',
      title: 'Zen',
      url: 'zen.test/docs'
    })
    const remove = row(newtab, 'shortcut:a:remove')
    expect(remove).toMatchObject({ kind: 'action', destructive: true })
    if (remove.kind !== 'action') throw new Error('not an action')
    expect(remove.confirm?.action).toBe('Remove')
    remove.onPress?.()
    expect(invoke).toHaveBeenCalledWith('newtab.removeShortcut', { id: 'a' })
    expect(row(newtab, 'newtab-add-shortcut')).toMatchObject({ kind: 'action', disabled: false })

    // An empty list shows its one-line empty state; a full grid disables Add shortcut.
    const empty = context(
      state({ capabilities: { ...ANDROID, newTabPage: true } } as Partial<UIState>)
    )
    const none = buildSection(
      PAGE.sections.find((x) => x.id === 'newtab')!,
      empty.ctx
    )
    expect(none.groups.find((g) => g.id === 'newtab-shortcuts')).toMatchObject({
      rows: [],
      empty: 'No shortcuts yet. Add the sites you want on every new tab.'
    })
    const full = context(
      state({
        capabilities: { ...ANDROID, newTabPage: true },
        newTabShortcuts: Array.from({ length: MAX_NEW_TAB_SHORTCUTS }, (_, i) => ({
          id: `s${i}`,
          title: `Site ${i}`,
          url: `https://s${i}.test/`
        }))
      } as Partial<UIState>)
    )
    const packed = buildSection(
      PAGE.sections.find((x) => x.id === 'newtab')!,
      full.ctx
    )
    expect(row(packed, 'newtab-add-shortcut').disabled).toBe(true)
  })

  it('NTP-16: a Cards row beside Layout on the phone layout opens the stack’s own Show list – the second door to the one setting (§9.29); the other layouts have no stack and no row', async () => {
    const { magicStackCustomizeStore, closeMagicStackCustomize } =
      await import('@renderer/components/newtab/magicStackCustomize')
    const host = state({ capabilities: { ...ANDROID, newTabPage: true } } as Partial<UIState>)
    const on = (layout: FormFactor): Model =>
      buildSections(availableSections(PAGE, host.capabilities, layout), {
        ...context(host).ctx,
        formFactor: layout
      }).find((m) => m.section.id === 'newtab')!
    const phone = on('phone')
    const group = phone.groups[0]!
    expect(group.heading).toBe('New tab page')
    const ids = group.rows.map((r) => r.id)
    expect(ids.indexOf('newtab-cards')).toBe(ids.indexOf('newtab-layout') + 1)
    expect(ids.indexOf('newtab-shortcuts')).toBe(ids.indexOf('newtab-cards') + 1)
    const cards = row(phone, 'newtab-cards')
    if (cards.kind !== 'action') throw new Error('not an action')
    expect(cards).toMatchObject({
      label: 'Cards',
      description: 'Choose which cards show under the shortcuts',
      leaves: 'chevron',
      layouts: ['phone']
    })
    expect(cards.page).toBeUndefined()
    expect(rowText(cards)).not.toMatch(/magic stack/i)
    // The press opens the very sheet the page's gear opens – a store, not a page or a copy.
    expect(magicStackCustomizeStore.get().open).toBe(false)
    cards.onPress?.()
    expect(magicStackCustomizeStore.get().open).toBe(true)
    closeMagicStackCustomize()
    expect(invoke).not.toHaveBeenCalledWith('newtab.setModuleHidden', expect.anything())
    // The landing's search reaches it by what the cards hold.
    for (const query of ['recently closed', 'downloads', 'default browser']) {
      expect(
        searchRows([phone], query).map((h) => h.row.id),
        query
      ).toContain('newtab-cards')
    }
    // The desktop and the tablet: the page keeps its rows, and this one is not among them.
    for (const layout of ['desktop', 'tablet'] as const) {
      const model = on(layout)
      const rows = allRows(model.groups).map((r) => r.id)
      expect(rows, layout).toContain('newtab-layout')
      expect(rows, layout).not.toContain('newtab-cards')
    }
  })

  it('carries #92’s Passwords rows: the ways into the manager, the preferences, protection and lock, import and export; behind `passwords`', async () => {
    const without = { ...ANDROID, passwords: false }
    expect(availableSections(PAGE, without, 'phone').some((s) => s.id === 'passwords')).toBe(false)

    const c = context()
    const passwords = buildSection(
      PAGE.sections.find((x) => x.id === 'passwords')!,
      c.ctx
    )
    expect(passwords.groups.map((g) => g.heading)).toEqual([
      'Password manager',
      'Saving',
      'Security',
      'Import and export'
    ])
    expect(allRows(passwords.groups).map((r) => r.id)).toEqual([
      'passwords-manage',
      'passwords-checkup',
      'passwords-offer-to-save',
      'passwords-leak-detection',
      'passwords-reauth-grace',
      'passwords-protection',
      'passwords-lock',
      'passwords-import',
      'passwords-export'
    ])

    // The way into the manager: what it holds on the second line, a chevron for leaving the page.
    const manage = row(passwords, 'passwords-manage')
    expect(manage).toMatchObject({
      kind: 'action',
      label: 'Manage passwords',
      description: 'No vault yet',
      leaves: 'chevron'
    })
    const held = state({
      passwords: { ...emptyPasswordsStatus(), locked: false, count: 3 }
    } as Partial<UIState>)
    expect(row(section('passwords', held), 'passwords-manage').description).toBe('3 logins saved')
    const locked = state({
      passwords: { ...emptyPasswordsStatus(), protection: { os: true, passphrase: false } }
    } as Partial<UIState>)
    expect(row(section('passwords', locked), 'passwords-manage').description).toBe(
      'The vault is locked'
    )
    if (manage.kind !== 'action') throw new Error('not an action')
    manage.onPress?.()
    await vi.waitFor(() => expect(uiStore.get().overlay).toBe('passwords'))
    expect(uiStore.get().overlaySection).toBe('logins')
    uiStore.set({ overlay: 'none', overlaySection: null })

    // The checkup row says what the checkup would find, then what it found and when; it opens
    // the manager on the checkup view. Rows about a vault operation open the settings view.
    const checkup = row(passwords, 'passwords-checkup')
    expect(checkup).toMatchObject({ kind: 'action', label: 'Check passwords', leaves: 'chevron' })
    expect(checkup.description).toBe(
      'Finds passwords that appeared in data breaches, are reused across sites or are easy to guess.'
    )
    const checked = state({
      passwords: {
        ...emptyPasswordsStatus(),
        locked: false,
        count: 3,
        checkup: {
          ...emptyPasswordsStatus().checkup,
          finishedAt: Date.now(),
          compromised: ['a'],
          weak: ['a', 'b'],
          reused: [['b', 'c']]
        }
      }
    } as Partial<UIState>)
    expect(row(section('passwords', checked), 'passwords-checkup').description).toBe(
      '3 passwords need attention · Last checked just now'
    )
    const running = state({
      passwords: {
        ...emptyPasswordsStatus(),
        locked: false,
        checkup: { ...emptyPasswordsStatus().checkup, running: true, checked: 2, total: 5 }
      }
    } as Partial<UIState>)
    expect(row(section('passwords', running), 'passwords-checkup').description).toBe(
      'Checking 2 of 5'
    )
    for (const [id, view] of [
      ['passwords-checkup', 'checkup'],
      ['passwords-protection', 'settings'],
      ['passwords-import', 'settings'],
      ['passwords-export', 'settings']
    ] as const) {
      const r = row(passwords, id)
      if (r.kind !== 'action') throw new Error(`${id} is not an action`)
      expect(r.leaves).toBe('chevron')
      r.onPress?.()
      await vi.waitFor(() => expect(uiStore.get().overlay).toBe('passwords'))
      expect(uiStore.get().overlaySection).toBe(view)
      uiStore.set({ overlay: 'none', overlaySection: null })
    }

    // Protection names how the key is kept – or will be, before there is a vault.
    expect(row(passwords, 'passwords-protection').description).toBe(
      'A passphrase, created with the first login'
    )
    expect(row(section('passwords', locked), 'passwords-protection').description).toBe(
      'Device keychain'
    )

    // Lock is a plain press while the vault is open, laid out at 40% once it is locked.
    const lock = row(section('passwords', held), 'passwords-lock')
    expect(lock).toMatchObject({
      kind: 'action',
      label: 'Lock the vault',
      description: 'Forget the key until the manager is opened again.',
      disabled: false
    })
    if (lock.kind !== 'action') throw new Error('not an action')
    invoke.mockClear()
    lock.onPress?.()
    expect(invoke).toHaveBeenCalledWith('passwords.lock', undefined)
    expect(row(section('passwords', locked), 'passwords-lock')).toMatchObject({
      description: 'The vault is locked.',
      disabled: true
    })

    // The two preferences patch inside `passwords`, keeping the rest of it.
    const offer = row(passwords, 'passwords-offer-to-save')
    if (offer.kind !== 'switch') throw new Error('not a switch')
    expect(offer.checked).toBe(true)
    offer.onChange(false)
    expect(c.patches.at(-1)).toEqual({
      passwords: { ...DEFAULT_SETTINGS.passwords, offerToSave: false }
    })

    // ID-31's switch opens Security with a one-line label (Chrome's wraps on a phone, §9.2)
    // over a one-sentence description; it is on by default, as Chrome's.
    const leak = row(passwords, 'passwords-leak-detection')
    expect(leak).toMatchObject({
      kind: 'switch',
      label: 'Warn about exposed passwords',
      checked: true
    })
    expect(leak.description).toBe(
      'Zenium checks passwords you sign in with against known data breaches.'
    )
    if (leak.kind !== 'switch') throw new Error('not a switch')
    leak.onChange(false)
    expect(c.patches.at(-1)).toEqual({
      passwords: { ...DEFAULT_SETTINGS.passwords, leakDetection: false }
    })
    const off = state({}, { passwords: { ...DEFAULT_SETTINGS.passwords, leakDetection: false } })
    expect(row(section('passwords', off), 'passwords-leak-detection')).toMatchObject({
      checked: false
    })

    const grace = row(passwords, 'passwords-reauth-grace')
    if (grace.kind !== 'value') throw new Error('not a value row')
    expect(currentOptionLabel(grace)).toBe('After 1 minute')
    expect(grace.options.map((o) => o.label)).toEqual([
      'Every time',
      'After 30 seconds',
      'After 1 minute',
      'After 5 minutes',
      'After 15 minutes',
      'After 1 hour'
    ])
    expect(grace.sheetDescription).toBe(
      'How long one verification covers reveals, copies and exports.'
    )
    grace.onChange('300')
    expect(c.patches.at(-1)).toEqual({
      passwords: { ...DEFAULT_SETTINGS.passwords, reauthGraceSeconds: 300 }
    })
  })

  it('carries #106’s Languages rows behind the translation engine: the offer switch, the lists as items, the models with a confirmed removal', () => {
    const silent = state({ capabilities: { ...ANDROID, translate: false } })
    expect(phoneSections(silent).map((m) => m.section.id)).not.toContain('languages')

    // The preferred languages (CT-41, `Settings.languages`; translate's `preferred` is derived
    // from them) mirror the engine slice's two languages read.
    const c = context(state({}, { languages: ['en', 'fr'] }))
    const languages = buildSection(
      PAGE.sections.find((x) => x.id === 'languages')!,
      c.ctx
    )
    expect(languages.groups.map((g) => g.id)).toEqual([
      // CT-41's Preferred languages open the category (Chrome's order), one group: the list's
      // rows and Add language together, since the add row is the list's own last row.
      'preferred',
      'translation',
      'always',
      'always-add',
      'never',
      'never-add',
      'sites',
      'models',
      'models-add',
      // CT-07's spell check group closes the category (its own test below).
      'spellcheck'
    ])
    expect(languages.groups.every(groupShows)).toBe(true)
    expect(languages.groups.map((g) => g.heading)).toEqual([
      'Preferred languages',
      'Translation',
      'Always translate',
      null,
      'Never translate',
      null,
      'Sites never translated',
      'Translation models',
      null,
      'Spell check'
    ])

    // The offer switch and the lists write through the engine's commands, not the settings.
    const offer = row(languages, 'languages-offer')
    if (offer.kind !== 'switch') throw new Error('not a switch')
    expect(offer.checked).toBe(true)
    offer.onChange(false)
    expect(invoke).toHaveBeenCalledWith('translate.setPreferences', { autoOffer: false })

    // The preferred languages are §10.4 item rows in the list's order, each with the item sheet
    // (Move Up / Move Down / Remove) the desktop's ⋯ lists, writing the list whole onto the
    // setting (its own test below walks the sheet).
    expect(row(languages, 'languages-preferred:en')).toMatchObject({
      kind: 'item',
      label: 'English',
      menu: 'Options for English',
      sheet: { title: 'English' }
    })
    expect(row(languages, 'languages-preferred:fr')).toMatchObject({
      kind: 'item',
      label: 'French'
    })
    const add = row(languages, 'languages-add')
    if (add.kind !== 'action') throw new Error('not an action')
    expect(add.form?.title).toBe('Add language')
    expect(findRow(languages.groups, 'languages-read:en')).toBeNull()
    expect(findRow(languages.groups, 'languages-read-add')).toBeNull()

    // A translate list's language is an item row whose one action, Remove, is the sheet's row
    // on the phone and the inline button on a mouse (§10.5: the count picks the form), plain
    // ink and unconfirmed (a preference removed, §10.4).
    const always = row(languages, 'languages-always:es')
    if (always.kind !== 'item') throw new Error('not an item')
    expect(always.label).toBe('Spanish')
    expect(always.action).toMatchObject({ label: 'Remove' })
    expect(always.action?.destructive).toBeFalsy()
    const ask = row(languages, 'languages-always:es:ask')
    if (ask.kind !== 'action') throw new Error('not an action')
    expect(ask.destructive).toBeFalsy()
    expect(ask.confirm).toBeUndefined()
    ask.onPress?.()
    expect(invoke).toHaveBeenCalledWith('translate.setLanguageRule', {
      language: 'es',
      rule: 'ask'
    })
    invoke.mockClear()
    always.action?.onPress()
    expect(invoke).toHaveBeenCalledWith('translate.setLanguageRule', {
      language: 'es',
      rule: 'ask'
    })
    expect(languages.groups.find((g) => g.id === 'never')).toMatchObject({
      rows: [],
      empty: 'No languages yet'
    })

    // Every Add row of the section is the one route (§10.2): the phone's find-and-pick page
    // with the list in its address, the desktop's filtered list dialog.
    for (const [id, list, title] of [
      ['languages-add', 'preferred', 'Add language'],
      ['languages-always-add', 'always', 'Always translate'],
      ['languages-never-add', 'never', 'Never translate']
    ] as const) {
      const r = row(languages, id)
      if (r.kind !== 'action') throw new Error(`${id} is not an action`)
      expect(r.label).toBe('Add language')
      expect(r.page).toBe('add')
      expect(r.pageQuery).toEqual({ list })
      expect(r.form?.title).toBe(title)
      expect(r.form?.body).toBe('list')
    }

    const site = row(languages, 'languages-site:news.example')
    if (site.kind !== 'item') throw new Error('not an item')
    expect(site.action).toMatchObject({ label: 'Remove' })
    const forget = row(languages, 'languages-site:news.example:forget')
    if (forget.kind !== 'action') throw new Error('not an action')
    forget.onPress?.()
    expect(invoke).toHaveBeenCalledWith('translate.setPreferences', { neverTranslateSites: [] })

    // A model on the device is an item whose removal confirms; one arriving is a static row.
    expect(row(languages, 'languages-model:es:en')).toMatchObject({
      kind: 'item',
      label: 'Spanish to English',
      description: '38.1 MB'
    })
    const remove = row(languages, 'languages-model:es:en:remove')
    if (remove.kind !== 'action') throw new Error('not an action')
    expect(remove.destructive).toBe(true)
    expect(remove.confirm?.action).toBe('Remove')
    remove.onPress?.()
    expect(invoke).toHaveBeenCalledWith('translate.removeModel', { from: 'es', to: 'en' })
    expect(row(languages, 'languages-model:de:en')).toMatchObject({
      kind: 'info',
      label: 'German to English',
      description: 'Downloading…'
    })
    expect(row(languages, 'languages-models-total').label).toBe('38.1 MB on this device')
    const download = row(languages, 'languages-model-download')
    if (download.kind !== 'action') throw new Error('not an action')
    expect(download.form?.title).toBe('Download a model')

    // Nothing left to add to a translate list: no add row for that list.
    const everything = section(
      'languages',
      state({
        translate: {
          ...TRANSLATE,
          preferences: { ...TRANSLATE.preferences, alwaysTranslate: ['de', 'en', 'es', 'fr'] }
        }
      })
    )
    expect(everything.groups.map((g) => g.id)).not.toContain('always-add')
  })

  it('CT-41: the preferred languages are item rows in the list’s order whose sheet – Move Up / Move Down / Remove, the desktop ⋯’s items – writes the list whole onto the setting, the inapplicable row disabled; Add language opens the page or the filtered dialog; the copy says what the order does', () => {
    const c = context(state({}, { languages: ['en-GB', 'en', 'de'] }))
    const def = PAGE.sections.find((x) => x.id === 'languages')!
    const model = buildSection(def, c.ctx)
    const group = model.groups.find((g) => g.id === 'preferred')!
    expect(group.rows.map((r) => r.id)).toEqual([
      'languages-preferred:en-GB',
      'languages-preferred:en',
      'languages-preferred:de',
      'languages-add'
    ])
    expect(group.rows.map((r) => r.label)).toEqual([
      'English (United Kingdom)',
      'English',
      'German',
      'Add language'
    ])
    // The phone host's copy (`pageLanguages` false): two sentences (§10.3's density, the #322
    // Q6 precedent) – translation follows the list, sites follow the device's languages.
    expect(group.description).toBe(
      'Pages are translated into the first language here. Sites that come in several languages follow this device’s languages, not this list.'
    )
    expect(group.description).not.toContain('checks spelling')

    // The item row: a plain row (no control, the desktop's ⋯ named for it) whose sheet is
    // titled with the name and holds the three action rows; the desktop menu is those rows
    // (`itemMenuItems`), so one definition serves both.
    const itemOf = (model: Model, id: string): ItemRow => {
      const r = row(model, id)
      if (r.kind !== 'item') throw new Error(`${id} is not an item`)
      return r
    }
    const menuOf = (id: string): { label: string; disabled?: boolean; onSelect(): void }[] =>
      itemMenuItems(itemOf(model, id), () => undefined).map((i) => ({
        label: i.label,
        disabled: i.disabled,
        onSelect: i.onSelect
      }))
    expect(itemOf(model, 'languages-preferred:en').menu).toBe('Options for English')
    expect(itemOf(model, 'languages-preferred:en').sheet.title).toBe('English')
    expect(itemOf(model, 'languages-preferred:en').action).toBeUndefined()
    // Title Case items (§9.1); the first row's Move Up and the last row's Move Down stay
    // listed, disabled (§9.30's .4); Remove stays on while more than one language remains, in
    // the plain ink and unconfirmed (§10.4: a preference removed is no data destroyed).
    expect(menuOf('languages-preferred:en-GB').map((i) => [i.label, i.disabled ?? false])).toEqual([
      ['Move Up', true],
      ['Move Down', false],
      ['Remove', false]
    ])
    expect(menuOf('languages-preferred:de').map((i) => [i.label, i.disabled ?? false])).toEqual([
      ['Move Up', false],
      ['Move Down', true],
      ['Remove', false]
    ])
    const removeRow = row(model, 'languages-preferred:de:remove')
    if (removeRow.kind !== 'action') throw new Error('not an action')
    expect(removeRow.destructive).toBeFalsy()
    expect(removeRow.confirm).toBeUndefined()
    // Each item writes the whole list, reordered or shortened, through `settings.update`.
    menuOf('languages-preferred:en')[0].onSelect()
    expect(c.patches.at(-1)).toEqual({ languages: ['en', 'en-GB', 'de'] })
    menuOf('languages-preferred:en')[1].onSelect()
    expect(c.patches.at(-1)).toEqual({ languages: ['en-GB', 'de', 'en'] })
    menuOf('languages-preferred:en-GB')[2].onSelect()
    expect(c.patches.at(-1)).toEqual({ languages: ['en', 'de'] })

    // One language left: Chrome keeps it, so Remove is disabled on the only row.
    const one = buildSection(def, context(state({}, { languages: ['en'] })).ctx)
    expect(
      itemMenuItems(itemOf(one, 'languages-preferred:en'), () => undefined).map(
        (i) => i.disabled ?? false
      )
    ).toEqual([true, true, true])

    // Add language: an action row with the desktop's button (§10.5) that on the phone leaves
    // for the section's find-and-pick page (§10.2, `?list=preferred`) and on a mouse opens the
    // filtered dialog, whose choices leave out the languages already listed.
    const add = row(model, 'languages-add')
    if (add.kind !== 'action') throw new Error('not an action')
    expect(add.button).toBe('Add…')
    expect(add.disabled).toBeFalsy()
    expect(add.page).toBe('add')
    expect(add.pageQuery).toEqual({ list: 'preferred' })
    expect(add.form?.title).toBe('Add language')
    // The dialog's body is a list (160 rows behind a filter): the desktop dialog stands at most
    // 80 % of the frame and scrolls under its title block (§9.20, #314 (c)) rather than 16 from
    // the frame's top and bottom like a page.
    expect(add.form?.body).toBe('list')

    // A full list (Chrome's 32) disables the row and says why.
    const full = Array.from({ length: 32 }, (_, i) => `x${String(i).padStart(2, '0')}`)
    const capped = buildSection(def, context(state({}, { languages: full })).ctx)
    const addCapped = row(capped, 'languages-add')
    if (addCapped.kind !== 'action') throw new Error('not an action')
    expect(addCapped.disabled).toBe(true)
    expect(addCapped.description).toContain('32 languages at most')

    // A desktop host hands the list to its pages: the copy says sites follow it and the
    // dictionary does too.
    const desktop = buildSection(
      def,
      context(
        state(
          { platform: 'linux', capabilities: { ...ANDROID, pageLanguages: true } },
          { languages: ['en'] }
        )
      ).ctx
    )
    const desktopGroup = desktop.groups.find((g) => g.id === 'preferred')!
    expect(desktopGroup.description).toBe(
      'In your order of preference: sites that come in several languages show the first one here they have. Pages are translated into the first language.'
    )
    expect(desktopGroup.description).not.toContain('device’s languages')
  })

  it('CT-41: a listed tag the runtime cannot name is labelled with the catalogue’s English name, never the bare tag (#350 review R6)', () => {
    // Android's ICU has no name for Assamese: `of` hands the tag back.
    const of = Intl.DisplayNames.prototype.of
    const spy = vi.spyOn(Intl.DisplayNames.prototype, 'of').mockImplementation(function (
      this: Intl.DisplayNames,
      code: string
    ) {
      return code === 'as' ? code : of.call(this, code)
    })
    try {
      const c = context(state({}, { languages: ['as', 'en'] }))
      const def = PAGE.sections.find((x) => x.id === 'languages')!
      const model = buildSection(def, c.ctx)
      const assamese = row(model, 'languages-preferred:as')
      if (assamese.kind !== 'item') throw new Error('not an item')
      expect(assamese.label).toBe('Assamese')
      expect(assamese.menu).toBe('Options for Assamese')
      expect(assamese.sheet.title).toBe('Assamese')
      expect(assamese.keywords).toContain('as')
    } finally {
      spy.mockRestore()
    }
  })

  it('carries #135’s site-controls rows in the hub cards’ order (the #553 lead check’s Q6), each un-carded group after its kin as Chrome’s page holds them (the #650 lead check): Delete browsing data, Cookies and site data with #115’s Tracking prevention and the signals, Safe Browsing with HTTPS-only and Secure DNS, Site settings, Safety check, Preload pages, the lock', () => {
    const c = context()
    const privacy = buildSection(
      PAGE.sections.find((x) => x.id === 'privacy')!,
      c.ctx
    )
    // The whole category in the cards' order – #135's, #156's and #115's groups (each program's
    // own order and content is its own test); the remembered per-site answers are Security's
    // since #62 (no `permissions` group here). W7-6's hub cards lead the category (settings-12);
    // the five carded programs follow in the cards' order (W8-8), and a group no card names
    // follows the card it is kin to (the #650 lead check): Tracking prevention and Privacy
    // signals after Cookies (Chrome's cookies-and-ad-privacy stretch), HTTPS-only and Secure
    // DNS after Safe Browsing (Chrome's Security page carries both); Preload pages – Chrome's
    // Performance › Speed row, its seat another slice's – stays after Safety check for now, and
    // the private-tab lock is last.
    expect(privacy.groups.map((g) => g.id)).toEqual([
      'privacy-hub',
      'clear-data',
      'site-data',
      'cookies-related-sites',
      'cookies-add-site',
      'site-data-allow',
      'site-data-allow-add',
      'site-data-clearOnExit',
      'site-data-clearOnExit-add',
      'site-data-block',
      'site-data-block-add',
      'site-data-exit',
      'site-data-viewer',
      'tracking-prevention',
      'tracking-lists',
      'tracking-custom-lists',
      'tracking-filters',
      'tracking-exceptions',
      'signals',
      'safe-browsing',
      'safe-browsing-feeds',
      'https-only',
      'https-only-sites',
      'secure-dns',
      'sites-permissions',
      'sites-content',
      'sites-additional',
      'sites-own',
      'sites-unused',
      'safety-check',
      'safety-check-results',
      'safety-check-actions',
      'preload',
      'private-lock'
    ])
    expect(privacy.groups.every(groupShows)).toBe(true)

    // Before the first run: the standing says so, the results are their empty line, Check now runs it.
    expect(row(privacy, 'safety-check-standing')).toMatchObject({
      kind: 'info',
      label: 'Safety check',
      description: 'Not checked yet'
    })
    expect(privacy.groups.find((g) => g.id === 'safety-check-results')).toMatchObject({
      rows: [],
      empty: 'Run the check to see results'
    })
    const now = row(privacy, 'safety-check-now')
    if (now.kind !== 'action') throw new Error('not an action')
    now.onPress?.()
    expect(invoke).toHaveBeenCalledWith('privacy.safetyCheck', undefined)

    // Delete browsing data is one action row whose sheet is the form – Chrome's words since
    // M124 (W8-7: `IDS_SETTINGS_CLEAR_BROWSING_DATA` "Delete browsing data", the row's button
    // Chrome's `IDS_SETTINGS_CLEAR` "Delete" with the opener's ellipsis).
    const clear = row(privacy, 'clear-data-open')
    if (clear.kind !== 'action') throw new Error('not an action')
    expect(clear.label).toBe('Delete browsing data')
    expect(clear.button).toBe('Delete…')
    expect(clear.form?.title).toBe('Delete browsing data')
    expect(clear.form?.description).toContain('time range')
    expect(clear.form?.description).toContain('what to delete')
    // On the phone layout the sheet is Quick Delete's (HB-07, MOT-24 UI): the same title, its
    // description saying what the Tabs row does since nothing else on the sheet does before the
    // switch is on (the reviewer's N5); the wide layouts' sheet says nothing of tabs.
    expect(clear.form?.description).not.toContain('Tabs')
    const phonePrivacy = buildSection(
      PAGE.sections.find((x) => x.id === 'privacy')!,
      {
        ...c.ctx,
        formFactor: 'phone'
      }
    )
    const phoneClear = row(phonePrivacy, 'clear-data-open')
    if (phoneClear.kind !== 'action') throw new Error('not an action')
    expect(phoneClear.form?.title).toBe('Delete browsing data')
    expect(phoneClear.form?.description).toBe(
      `${clear.form?.description} Turn on Tabs to close the tabs you used in that time as well.`
    )

    // Site settings: the catalogue this host honours, each an item whose sheet holds the default
    // as a value row; a type with one possible default is a fact. Notifications are in it since
    // the page-script `Notification` polyfill (#223, MW-05) made them a permission the Android
    // host enforces, the row wired to the shared permission service as every other type is.
    const notifications = row(privacy, 'sites:notifications')
    expect(notifications).toMatchObject({
      kind: 'item',
      label: 'Notifications',
      description: 'Sites can ask to send notifications'
    })
    const notificationsDefault = row(privacy, 'sites:notifications:default')
    if (notificationsDefault.kind !== 'value') throw new Error('not a value row')
    expect(notificationsDefault.value).toBe('ask')
    expect(notificationsDefault.options.map((o) => o.label)).toEqual(['Ask', 'Block'])
    notificationsDefault.onChange('deny')
    expect(invoke).toHaveBeenCalledWith('permissions.setDefault', {
      permission: 'notifications',
      decision: 'deny'
    })
    const location = row(privacy, 'sites:geolocation')
    expect(location).toMatchObject({
      kind: 'item',
      label: 'Location',
      description: 'Sites can ask for your location'
    })
    const locationDefault = row(privacy, 'sites:geolocation:default')
    if (locationDefault.kind !== 'value') throw new Error('not a value row')
    expect(locationDefault.value).toBe('ask')
    expect(locationDefault.options.map((o) => [o.label, o.description])).toEqual([
      ['Ask', 'Default'],
      ['Block', undefined]
    ])
    locationDefault.onChange('deny')
    expect(invoke).toHaveBeenCalledWith('permissions.setDefault', {
      permission: 'geolocation',
      decision: 'deny'
    })
    expect(privacy.groups.find((g) => g.id === 'sites-own')).toMatchObject({
      rows: [],
      empty: 'No site has settings of its own yet'
    })
    expect(findRow(privacy.groups, 'sites-reset-all')).toBeNull()

    // A stored default reads on the row; a site's answers list under their type and under the
    // site: under the type as item rows whose one action, Forget, runs at once (the lead's #418
    // ruling 5), under the site reset through the permission command at once too – plain, no
    // confirmation (the lead's #431 Q1 ruling; only the bulk Reset all confirms).
    const rules = [
      { origin: 'https://meet.example', permission: 'camera', decision: 'allow' as const },
      { origin: 'https://meet.example', permission: 'microphone', decision: 'deny' as const },
      { origin: 'https://news.example', permission: 'popups', decision: 'allow' as const }
    ]
    const stored = section(
      'privacy',
      state({ permissionRules: rules, permissionDefaults: { camera: 'deny' } } as Partial<UIState>)
    )
    expect(row(stored, 'sites:camera').description).toBe('Sites cannot use your camera')
    const cameraSite = row(stored, 'sites:camera:https://meet.example:camera')
    expect(cameraSite).toMatchObject({
      kind: 'item',
      label: 'meet.example',
      description: 'Allowed',
      action: { label: 'Forget' }
    })
    if (cameraSite.kind !== 'item') throw new Error('not an item')
    cameraSite.action?.onPress()
    expect(invoke).toHaveBeenCalledWith('permissions.forget', {
      origin: 'https://meet.example',
      permission: 'camera'
    })
    expect(findRow(stored.groups, 'sites:camera:https://news.example:popups')).toBeNull()
    const own = stored.groups.find((g) => g.id === 'sites-own')
    expect(own?.rows.map((r) => r.id)).toEqual([
      'sites:site:https://meet.example',
      'sites:site:https://news.example',
      'sites-reset-all'
    ])
    expect(row(stored, 'sites:site:https://meet.example')).toMatchObject({
      kind: 'item',
      label: 'meet.example',
      description: 'Camera: allowed · Microphone: blocked'
    })
    expect(row(stored, 'sites:site:https://meet.example:microphone')).toMatchObject({
      kind: 'info',
      label: 'Microphone',
      description: 'Blocked'
    })
    const reset = row(stored, 'sites:site:https://meet.example:reset')
    if (reset.kind !== 'action') throw new Error('not an action')
    expect(reset).toMatchObject({ label: 'Reset site settings', button: 'Reset' })
    expect(reset.confirm).toBeUndefined()
    expect(reset.destructive).toBeUndefined()
    invoke.mockClear()
    reset.onPress?.()
    expect(invoke.mock.calls).toEqual([
      ['permissions.resetOrigin', { origin: 'https://meet.example' }]
    ])
    const resetAll = row(stored, 'sites-reset-all')
    expect(resetAll).toMatchObject({ kind: 'action', destructive: true, button: 'Reset all…' })
    if (resetAll.kind !== 'action') throw new Error('not an action')
    expect(resetAll.confirm?.action).toBe('Reset all')
    resetAll.onPress?.()
    expect(invoke).toHaveBeenCalledWith('permissions.reset', undefined)

    // The search reaches the catalogue rows under their group's caption.
    const hits = searchRows(phoneSections(), 'location')
    expect(hits.find((h) => h.row.id === 'sites:geolocation')?.caption).toBe(
      'Privacy and Security › Site settings'
    )
  })

  it('reads the last Safety check from the state: a row per area with its glyph, the reviews as sheets of sites, Extensions leaving for its category', async () => {
    const result: SafetyCheckResult = {
      checkedAt: Date.now() - 60_000,
      updates: {
        state: 'info',
        summary: 'Version 0.3.1 is available',
        currentVersion: '0.3.0-test',
        latestVersion: '0.3.1'
      },
      safeBrowsing: {
        state: 'safe',
        summary: 'Safe Browsing is on',
        configured: true,
        enabled: true
      },
      passwords: {
        state: 'info',
        summary: '3 passwords not checked yet',
        compromised: 0,
        weak: 0,
        reused: 0,
        known: false,
        checkedAt: null
      },
      permissions: {
        state: 'warning',
        summary: '1 site worth a look: unused permissions or several at once',
        grantedSites: 2,
        review: [{ origin: 'https://meet.example', permissions: ['camera'], reason: 'unused' }],
        revoked: []
      },
      notifications: {
        state: 'info',
        summary: '1 site may send notifications',
        sites: [{ origin: 'https://news.example', shown: 4 }]
      },
      extensions: {
        state: 'warning',
        summary: '1 extension to review',
        flagged: [{ id: 'x', name: 'Ext', reasons: ['broad host access'] }]
      }
    }
    const rules = [
      { origin: 'https://meet.example', permission: 'camera', decision: 'allow' as const },
      { origin: 'https://docs.example', permission: 'geolocation', decision: 'allow' as const }
    ]
    const c = context(
      state({
        lastSafetyCheck: result,
        permissionRules: rules,
        capabilities: { ...ANDROID, extensions: true },
        updates: {
          ...emptyUpdateStatus('0.3.0-test', { os: 'android', arch: 'arm64', kind: 'apk' }),
          phase: 'available',
          mode: 'in-place',
          release: {
            version: '0.3.1',
            tag: 'v0.3.1',
            prerelease: false,
            publishedAt: '2026-09-01T00:00:00Z',
            releaseUrl: 'https://zen.test/r',
            notesUrl: 'https://zen.test/n',
            asset: {
              os: 'android',
              arch: 'arm64',
              kind: 'apk',
              name: 'zenium.apk',
              url: 'https://zen.test/a',
              size: 1,
              sha256: '00'
            }
          }
        },
        passwords: { ...emptyPasswordsStatus(), locked: false, count: 3 }
      } as Partial<UIState>)
    )
    const privacy = buildSection(
      PAGE.sections.find((x) => x.id === 'privacy')!,
      c.ctx
    )
    expect(row(privacy, 'safety-check-standing')).toMatchObject({
      kind: 'info',
      label: 'Some things need your attention',
      description: 'Checked 1 min ago'
    })
    const results = privacy.groups.find((g) => g.id === 'safety-check-results')
    expect(results?.rows.map((r) => [r.id, r.kind])).toEqual([
      ['safety-check:updates', 'action'],
      ['safety-check:safeBrowsing', 'info'],
      ['safety-check:passwords', 'action'],
      ['safety-check:permissions', 'item'],
      ['safety-check:notifications', 'item'],
      ['safety-check:extensions', 'action']
    ])
    for (const r of results?.rows ?? []) {
      if (r.kind === 'info' || r.kind === 'action' || r.kind === 'item')
        expect(r.leading, r.id).toBeDefined()
    }

    // An update to download is the row's press; the password checkup runs and the check reads again.
    const updates = row(privacy, 'safety-check:updates')
    if (updates.kind !== 'action') throw new Error('not an action')
    expect(updates.description).toBe('Version 0.3.1 is available')
    updates.onPress?.()
    expect(invoke).toHaveBeenCalledWith('updates.download', undefined)
    const passwords = row(privacy, 'safety-check:passwords')
    if (passwords.kind !== 'action') throw new Error('not an action')
    expect(passwords.description).toBe('3 passwords not checked yet')
    // Nothing compromised: the description stays at 69% (no tone on the row).
    expect(passwords.tone).toBeUndefined()
    passwords.onPress?.()
    expect(invoke).toHaveBeenCalledWith('passwords.checkupRun', undefined)

    // The row reads the device's checkup summary (PS-20 / ID-19): the counts' sentence dated by
    // the last run, and, while any login is compromised, Review leaving for the manager's
    // checkup view in place of running the checkup again.
    const compromised = section(
      'privacy',
      state({
        lastSafetyCheck: {
          ...result,
          passwords: {
            state: 'warning',
            summary: '2 compromised passwords found; change them now',
            compromised: 2,
            weak: 1,
            reused: 0,
            known: true,
            checkedAt: Date.now() - 3 * 3_600_000
          }
        },
        passwords: { ...emptyPasswordsStatus(), locked: false, count: 3 }
      } as Partial<UIState>)
    )
    const review = row(compromised, 'safety-check:passwords')
    // The description is the status sentence, so the row carries the warning tone and the
    // description takes the glyph's ink (§9.33; `data-tone` on the row, pr-261).
    expect(review).toMatchObject({
      kind: 'action',
      label: 'Passwords',
      description: '2 compromised passwords found; change them now · Last checked 3 h ago',
      tone: 'warn',
      leaves: 'chevron'
    })
    if (review.kind !== 'action') throw new Error('not an action')
    invoke.mockClear()
    review.onPress?.()
    expect(invoke).not.toHaveBeenCalledWith('passwords.checkupRun', undefined)
    await vi.waitFor(() => expect(uiStore.get().overlay).toBe('passwords'))
    expect(uiStore.get().overlaySection).toBe('checkup')
    uiStore.set({ overlay: 'none', overlaySection: null })

    // The permissions review lists every site holding a permission, the flagged one first with
    // why; a site's row is an item in the grant rows' shape whose one action, Reset, resets it
    // at once – no confirmation (the lead's #431 Q1 ruling) – and the check runs again. The
    // phone's sheet holds the same Reset as a plain row.
    const permissions = row(privacy, 'safety-check:permissions')
    if (permissions.kind !== 'item') throw new Error('not an item')
    expect(permissions.sheet.title).toBe('Site permissions')
    expect(permissions.sheet.groups[0].rows.map((r) => [r.label, r.description])).toEqual([
      ['meet.example', 'Camera · Not used for weeks'],
      ['docs.example', 'Location']
    ])
    const meet = row(privacy, 'safety-check:permissions:https://meet.example')
    expect(meet).toMatchObject({
      kind: 'item',
      label: 'meet.example',
      description: 'Camera · Not used for weeks',
      action: { label: 'Reset' }
    })
    if (meet.kind !== 'item') throw new Error('not an item')
    expect(meet.action?.destructive).toBeUndefined()
    expect(meet.sheet.title).toBe('meet.example')
    invoke.mockClear()
    meet.action?.onPress()
    expect(invoke.mock.calls).toEqual([
      ['permissions.resetOrigin', { origin: 'https://meet.example' }],
      ['privacy.safetyCheck', undefined]
    ])
    const meetReset = row(privacy, 'safety-check:permissions:https://meet.example:reset')
    if (meetReset.kind !== 'action') throw new Error('not an action')
    expect(meetReset).toMatchObject({ label: 'Reset', button: 'Reset' })
    expect(meetReset.confirm).toBeUndefined()
    expect(meetReset.destructive).toBeUndefined()
    invoke.mockClear()
    meetReset.onPress?.()
    expect(invoke.mock.calls).toEqual([
      ['permissions.resetOrigin', { origin: 'https://meet.example' }],
      ['privacy.safetyCheck', undefined]
    ])

    // The notifications review blocks a site after a confirmation (a new Block is a decision,
    // not a removal: the #431 ruling leaves it).
    const notifications = row(privacy, 'safety-check:notifications')
    if (notifications.kind !== 'item') throw new Error('not an item')
    const news = row(privacy, 'safety-check:notifications:https://news.example')
    expect(news).toMatchObject({
      kind: 'action',
      label: 'news.example',
      description: '4 notifications since Zenium started'
    })
    if (news.kind !== 'action') throw new Error('not an action')
    expect(news.confirm?.action).toBe('Stop')
    news.onPress?.()
    expect(invoke).toHaveBeenCalledWith('permissions.set', {
      origin: 'https://news.example',
      permission: 'notifications',
      decision: 'deny'
    })

    // Extensions leaves for its category; without extensions on the host the row is a fact.
    const extensions = row(privacy, 'safety-check:extensions')
    expect(extensions).toMatchObject({ kind: 'action', leaves: 'chevron' })
    if (extensions.kind !== 'action') throw new Error('not an action')
    extensions.onPress?.()
    expect(c.navigated).toEqual(['extensions'])
    const noExtensions = section(
      'privacy',
      state({ lastSafetyCheck: result, permissionRules: rules } as Partial<UIState>)
    )
    expect(row(noExtensions, 'safety-check:extensions').kind).toBe('info')
    expect(row(noExtensions, 'safety-check:safeBrowsing')).toMatchObject({
      kind: 'info',
      description: 'Safe Browsing is on'
    })
  })

  it('reviews the permissions the sweep removed first (PS-41): Chrome’s module as the sheet’s first group – Allow again and Got it with their toasts and undos – then the granted sites; the row keeps its review with no granted site', async () => {
    const revoked = [
      {
        origin: 'https://meet.example',
        permissions: ['camera', 'microphone'],
        revokedAt: Date.now() - 2 * 86_400_000
      },
      { origin: 'https://maps.example', permissions: ['geolocation'], revokedAt: Date.now() }
    ]
    const result: SafetyCheckResult = {
      checkedAt: Date.now() - 60_000,
      updates: {
        state: 'safe',
        summary: 'Up to date',
        currentVersion: '0.3.0',
        latestVersion: null
      },
      safeBrowsing: {
        state: 'safe',
        summary: 'Safe Browsing is on',
        configured: true,
        enabled: true
      },
      passwords: {
        state: 'safe',
        summary: 'No passwords saved',
        compromised: 0,
        weak: 0,
        reused: 0,
        known: false,
        checkedAt: null
      },
      permissions: {
        state: 'info',
        summary: 'Permissions removed from 2 sites',
        grantedSites: 1,
        review: [],
        revoked
      },
      notifications: { state: 'safe', summary: 'No site may send notifications', sites: [] },
      extensions: { state: 'unavailable', summary: 'This host runs no extensions', flagged: [] }
    }
    const rules = [
      { origin: 'https://docs.example', permission: 'geolocation', decision: 'allow' as const }
    ]
    const privacy = section(
      'privacy',
      state({ lastSafetyCheck: result, permissionRules: rules } as Partial<UIState>)
    )
    // The card reads the row's info state; the row is the review, its sentence the engine's.
    expect(row(privacy, 'safety-check-standing')).toMatchObject({
      label: 'A few things to look at'
    })
    const permissions = row(privacy, 'safety-check:permissions')
    if (permissions.kind !== 'item') throw new Error('not an item')
    expect(permissions.description).toBe('Permissions removed from 2 sites')
    expect(permissions.sheet.title).toBe('Site permissions')
    // The sheet's description covers both lists (the lead's #637 ruling on nit 6).
    expect(permissions.sheet.description).toBe(
      'Sites allowed to use something, and permissions taken back from unused sites. Resetting a site makes it ask again.'
    )
    expect(permissions.sheet.groups.map((g) => [g.id, g.heading])).toEqual([
      ['safety-check:permissions:revoked', 'Permissions removed from 2 sites'],
      ['safety-check:permissions:sites', 'Sites with permissions you granted']
    ])
    const block = permissions.sheet.groups[0]
    // The block's description says once why the permissions went; each row is the permissions
    // alone (ruling 1); Got it says what it does in the house's words (ruling 2).
    expect(block.description).toBe(
      "To protect your data, permissions were removed from sites you haven't visited recently."
    )
    expect(block.rows.map((r) => [r.kind, r.label, r.description])).toEqual([
      ['item', 'meet.example', 'Camera, Microphone'],
      ['item', 'maps.example', 'Location'],
      ['action', 'Got it', 'Clears this list. Sites ask again when they need a permission.']
    ])
    expect(permissions.sheet.groups[1].rows.map((r) => r.label)).toEqual(['docs.example'])

    // Allow again: the site's permissions come back at once (no confirmation), the check runs
    // again, and Chrome's toast offers Undo – on §9.33's Undo clock – which reverses it and
    // reads the check once more. The desktop button's reader name is Chrome's own sentence.
    uiStore.set({ toasts: [] })
    const meet = row(privacy, 'safety-check:permissions:revoked:https://meet.example')
    if (meet.kind !== 'item') throw new Error('not an item')
    expect(meet.action).toMatchObject({
      label: 'Allow again',
      ariaLabel: 'Allow permissions again for meet.example'
    })
    expect(meet.action?.destructive).toBeUndefined()
    expect(meet.sheet.title).toBe('meet.example')
    expect(meet.sheet.description).toBe('Camera, Microphone')
    const regrant = row(
      privacy,
      'safety-check:permissions:revoked:https://meet.example:allow-again'
    )
    expect(regrant).toMatchObject({ kind: 'action', label: 'Allow again', button: 'Allow again' })
    if (regrant.kind !== 'action') throw new Error('not an action')
    expect(regrant.confirm).toBeUndefined()
    // Allow again keeps the sheet open for the sites left (ruling 8 iii).
    expect(regrant.closesSheet).toBeUndefined()
    invoke.mockClear()
    meet.action?.onPress()
    expect(invoke.mock.calls).toEqual([
      ['permissions.regrantRevoked', { origin: 'https://meet.example' }],
      ['privacy.safetyCheck', undefined]
    ])
    let toasts = uiStore.get().toasts
    expect(toasts.map((t) => [t.message, t.kind, t.action?.label, t.duration])).toEqual([
      ['Permissions allowed again for meet.example', 'info', 'Undo', TOAST_UNDO_MS]
    ])
    // A second press inside the round-trip – the row stands until the check's result lands –
    // is the engine's no-op and would only double the toast: it does nothing, from the button
    // or from the phone sheet's row alike.
    meet.action?.onPress()
    regrant.onPress?.()
    expect(invoke.mock.calls).toHaveLength(2)
    expect(uiStore.get().toasts).toHaveLength(1)
    invoke.mockClear()
    toasts[0].action?.onPick()
    expect(invoke.mock.calls).toEqual([
      ['permissions.undoRegrantRevoked', { origin: 'https://meet.example' }],
      ['privacy.safetyCheck', undefined]
    ])
    uiStore.set({ toasts: [] })
    // The check back (its promise settled), the guard lifts and a press acts again.
    await new Promise((resolve) => setTimeout(resolve, 0))
    invoke.mockClear()
    regrant.onPress?.()
    expect(invoke.mock.calls).toEqual([
      ['permissions.regrantRevoked', { origin: 'https://meet.example' }],
      ['privacy.safetyCheck', undefined]
    ])
    expect(uiStore.get().toasts).toHaveLength(1)
    uiStore.set({ toasts: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The check's result back without the site: its rows are gone from the rebuilt sheet, so
    // the phone's item sheet opened for it resolves to no row and leaves with its act (the
    // stack's orphan rule, `sheets.tsx`), while the review sheet stays for the sites left.
    const afterMeet = section(
      'privacy',
      state({
        lastSafetyCheck: {
          ...result,
          permissions: {
            ...result.permissions,
            summary: 'Permissions removed from 1 site',
            revoked: [revoked[1]]
          }
        },
        permissionRules: rules
      } as Partial<UIState>)
    )
    expect(
      findRow(afterMeet.groups, 'safety-check:permissions:revoked:https://meet.example')
    ).toBeNull()
    expect(
      findRow(afterMeet.groups, 'safety-check:permissions:revoked:https://meet.example:allow-again')
    ).toBeNull()
    expect(row(afterMeet, 'safety-check:permissions:revoked:https://maps.example').kind).toBe(
      'item'
    )
    expect(row(afterMeet, 'safety-check:permissions').kind).toBe('item')

    // Got it: the list is acknowledged through the engine, which hands back the records; the
    // bulk toast counts them – on the Undo clock – and its Undo puts them back as they were.
    // The rule is that the toast's Undo stays in reach (the lead's on #668), and the chassis
    // keeps it there on every host – the phone lifts the toast over the sheet (#651), the tablet
    // and the desktop lift it over a standing dialog in the frame dialog host's seat (#678) – so
    // Got it keeps the sheet with the granted list under it on all three layouts: no
    // `closesSheet` on any host – three pins, one per host, each built for its layout.
    const records = revoked.map((r) => ({ ...r, expiresAt: r.revokedAt + 30 * 86_400_000 }))
    invoke.mockImplementation(async (name) =>
      name === 'permissions.acknowledgeRevoked' ? (records as unknown as null) : null
    )
    invoke.mockClear()
    const gotIt = row(privacy, 'safety-check:permissions:revoked:acknowledge')
    if (gotIt.kind !== 'action') throw new Error('not an action')
    expect(gotIt).toMatchObject({ button: 'Got it' })
    const reviewState = state({
      lastSafetyCheck: result,
      permissionRules: rules
    } as Partial<UIState>)
    const privacyDef = PAGE.sections.find((x) => x.id === 'privacy')
    if (!privacyDef) throw new Error('no privacy section')
    const gotItOn = (
      formFactor: 'desktop' | 'tablet' | 'phone'
    ): Extract<Row, { kind: 'action' }> => {
      const built = buildSection(privacyDef, { ...context(reviewState).ctx, formFactor })
      const hostGotIt = row(built, 'safety-check:permissions:revoked:acknowledge')
      if (hostGotIt.kind !== 'action') throw new Error(`${formFactor}: not an action`)
      expect(hostGotIt).toMatchObject({ button: 'Got it' })
      return hostGotIt
    }
    // The desktop: the review is an item dialog in the frame dialog host; the toast lifts over
    // it in the host's seat (#678), so Got it leaves the dialog standing.
    expect(gotItOn('desktop').closesSheet).toBeUndefined()
    // The tablet: the same host and the same seat (#678, `TabletShell`); the dialog stands.
    expect(gotItOn('tablet').closesSheet).toBeUndefined()
    // The phone: the sheet stays as since #668 – its messages lift over the sheet (#651).
    expect(gotItOn('phone').closesSheet).toBeUndefined()
    expect(gotIt.closesSheet).toBeUndefined()
    expect(gotIt.confirm).toBeUndefined()
    expect(gotIt.destructive).toBeUndefined()
    gotIt.onPress?.()
    await vi.waitFor(() => expect(uiStore.get().toasts).toHaveLength(1))
    expect(invoke.mock.calls).toEqual([
      ['permissions.acknowledgeRevoked', undefined],
      ['privacy.safetyCheck', undefined]
    ])
    toasts = uiStore.get().toasts
    expect(toasts.map((t) => [t.message, t.kind, t.action?.label, t.duration])).toEqual([
      ['Review complete for 2 sites', 'info', 'Undo', TOAST_UNDO_MS]
    ])
    invoke.mockClear()
    toasts[0].action?.onPick()
    expect(invoke.mock.calls).toEqual([
      ['permissions.restoreRevokedList', { records }],
      ['privacy.safetyCheck', undefined]
    ])
    uiStore.set({ toasts: [] })
    invoke.mockImplementation(async () => null)

    // The check back after Got it with the list acknowledged: the block is gone from the rebuilt
    // sheet, which stays as the granted list alone (the row is still the review while a site
    // holds a permission), the toast above it. With no granted site either the row has nothing
    // to review and is an info row with no sheet, so the sheet open for it resolves to no item
    // row and leaves with its act – the stack's orphan rule (`sheets.tsx`, `dialogs.tsx` `fits`)
    // – while the toast keeps its seat and its clock.
    const acknowledged: SafetyCheckResult = {
      ...result,
      permissions: {
        ...result.permissions,
        state: 'safe',
        summary: '1 site with permissions you granted',
        revoked: []
      }
    }
    const afterGotIt = section(
      'privacy',
      state({ lastSafetyCheck: acknowledged, permissionRules: rules } as Partial<UIState>)
    )
    const kept = row(afterGotIt, 'safety-check:permissions')
    if (kept.kind !== 'item') throw new Error('not an item')
    expect(kept.sheet.groups.map((g) => g.id)).toEqual(['safety-check:permissions:sites'])
    expect(findRow(afterGotIt.groups, 'safety-check:permissions:revoked:acknowledge')).toBeNull()
    const emptied = section(
      'privacy',
      state({
        lastSafetyCheck: {
          ...acknowledged,
          permissions: { ...acknowledged.permissions, grantedSites: 0 }
        },
        permissionRules: []
      } as Partial<UIState>)
    )
    expect(row(emptied, 'safety-check:permissions').kind).toBe('info')

    // One site: the singular forms.
    const one = section(
      'privacy',
      state({
        lastSafetyCheck: {
          ...result,
          permissions: {
            ...result.permissions,
            summary: 'Permissions removed from 1 site',
            grantedSites: 0,
            revoked: [revoked[1]]
          }
        },
        permissionRules: []
      } as Partial<UIState>)
    )
    // With no granted site the row is still the review: the removed permissions are what it opens.
    const single = row(one, 'safety-check:permissions')
    if (single.kind !== 'item') throw new Error('not an item')
    expect(single.sheet.groups[0].description).toBe(
      "To protect your data, permissions were removed from a site you haven't visited recently."
    )
    expect(single.sheet.groups[1]).toMatchObject({
      heading: 'Sites with permissions you granted',
      rows: [],
      empty: 'No site holds a permission'
    })

    // With nothing removed the sheet is as it was: one headingless list of the granted sites.
    const none = section(
      'privacy',
      state({
        lastSafetyCheck: {
          ...result,
          permissions: {
            ...result.permissions,
            state: 'safe',
            summary: '1 site with permissions you granted',
            revoked: []
          }
        },
        permissionRules: rules
      } as Partial<UIState>)
    )
    const plain = row(none, 'safety-check:permissions')
    if (plain.kind !== 'item') throw new Error('not an item')
    expect(plain.sheet.groups.map((g) => [g.id, g.heading])).toEqual([
      ['safety-check:permissions:sites', null]
    ])
  })

  it('keeps the sweep’s switch last among the Site settings under its own heading, bound to the setting, in each host’s own words (PS-41)', () => {
    const phone = section('privacy')
    const ids = phone.groups.map((g) => g.id)
    expect(ids[ids.indexOf('sites-own') + 1]).toBe('sites-unused')
    expect(ids.indexOf('sites-own')).toBeGreaterThan(ids.indexOf('sites-permissions'))
    // A heading of its own after the danger-ink Reset all sites (the lead's #637 ruling 6).
    expect(phone.groups.find((g) => g.id === 'sites-unused')?.heading).toBe('Unused sites')
    const sw = row(phone, 'sites-auto-revoke')
    // The phone's one sentence keeps "recently" (ruling 5); Chrome's contraction stays with
    // Chrome's verbatim words (ruling 7).
    expect(sw).toMatchObject({
      kind: 'switch',
      label: 'Automatically remove permissions',
      description: "Let Zenium remove permissions from sites that you haven't visited recently.",
      checked: true
    })
    if (sw.kind !== 'switch') throw new Error('not a switch')
    invoke.mockClear()
    sw.onChange(false)
    expect(invoke.mock.calls).toEqual([['settings.update', { autoRevokeUnusedPermissions: false }]])
    expect(
      row(
        section('privacy', state({}, { autoRevokeUnusedPermissions: false })),
        'sites-auto-revoke'
      )
    ).toMatchObject({ checked: false })

    const desktop = section(
      'privacy',
      state({ platform: 'linux', capabilities: { ...ANDROID, windows: true } })
    )
    expect(desktop.groups.find((g) => g.id === 'sites-unused')?.heading).toBe('Unused sites')
    expect(row(desktop, 'sites-auto-revoke')).toMatchObject({
      kind: 'switch',
      label: 'Automatically remove permissions from unused sites',
      description:
        "To protect your data, let Zenium remove permissions from sites you haven't visited recently. Notifications are not removed.",
      checked: true
    })
    // The search reaches it under its heading.
    const hits = searchRows(phoneSections(), 'unused sites')
    expect(hits.find((h) => h.row.id === 'sites-auto-revoke')?.caption).toBe(
      'Privacy and Security › Unused sites'
    )
  })

  it('orders Look and Feel identity, chrome, page behaviour, Glance (design lead, #134)', () => {
    // Without a layout every row shows; the phone shell's list has no Bookmarks group (no bar).
    // CT-25's Customise fonts follows Appearance: what pages look like, before the chrome's own.
    // Home (the phone's homepage, SET-36) follows the URL bar group: the chrome's controls.
    expect(section('look').groups.map((g) => g.id)).toEqual([
      'appearance',
      'fonts',
      'app-icon',
      'bookmarks',
      'url-bar',
      'home',
      'pages',
      'sites',
      'site-exceptions',
      'glance'
    ])
    const phone = buildSection(PAGE.sections[0], { ...context().ctx, formFactor: 'phone' })
    expect(phone.groups.map((g) => g.id)).toEqual([
      'appearance',
      'fonts',
      'app-icon',
      'url-bar',
      'home',
      'pages',
      'sites',
      'site-exceptions',
      'glance'
    ])
    expect(findRow(phone.groups, 'navigation-bar')).not.toBeNull()
    const desktop = buildSection(PAGE.sections[0], { ...context().ctx, formFactor: 'desktop' })
    expect(findRow(desktop.groups, 'navigation-bar')).toBeNull()
    expect(findRow(desktop.groups, 'bookmarks-bar')?.kind).toBe('value')
  })

  it('gates compact mode’s Hide top toolbar on the layout having a top toolbar (§10.4): off in Only sidebar and Collapsed sidebar, live in the other two', () => {
    const hide = (layout: ToolbarLayout): Row =>
      row(section('compact', state({}, { toolbarLayout: layout })), 'compact-hide-toolbar')
    // The Only sidebar and Collapsed sidebar layouts keep the navigation in the sidebar: nothing
    // to hide, the switch off and the description naming both.
    for (const layout of ['single', 'collapsed'] as const) {
      const r = hide(layout)
      expect(r.kind).toBe('switch')
      expect(r.disabled, layout).toBe(true)
      expect(r.description).toBe(
        'Not in the Only sidebar or Collapsed sidebar layouts, which have no top toolbar to hide.'
      )
    }
    // The layouts with a toolbar row of their own – the multiple layout's, the horizontal
    // layout's row under the strip – keep the switch live.
    for (const layout of ['multiple', 'horizontal'] as const) {
      expect(hide(layout).disabled, layout).toBe(false)
    }
  })

  it('makes Look and Feel’s Expanded sidebar a dependent row where the layout fixes the rail (§10.4, §9.37): set by Collapsed sidebar and Horizontal tabs, live under the other two', () => {
    const expanded = (layout: ToolbarLayout, formFactor?: FormFactor): Row => {
      const s = state({}, { toolbarLayout: layout, sidebarExpanded: true })
      const look = buildSection(PAGE.sections[0], { ...context(s, true).ctx, formFactor })
      return row(look, 'sidebar-expanded')
    }
    // The rail is the layout's: the row lies at .4 (`disabled` → `aria-disabled`), unchecked
    // as the sidebar is whatever the setting stored, and its description says what set it.
    for (const layout of ['collapsed', 'horizontal'] as const) {
      const r = expanded(layout, 'desktop')
      if (r.kind !== 'switch') throw new Error('not a switch')
      expect(r.disabled, layout).toBe(true)
      expect(r.checked, layout).toBe(false)
      expect(r.description, layout).toBe('Set by the layout.')
    }
    // The two layouts that leave the width to the setting keep the switch live, checked as
    // stored, with its own words (the pointer host's double-click among them).
    for (const layout of ['single', 'multiple'] as const) {
      const r = expanded(layout, 'desktop')
      if (r.kind !== 'switch') throw new Error('not a switch')
      expect(r.disabled ?? false, layout).toBe(false)
      expect(r.checked, layout).toBe(true)
      expect(r.description, layout).toBe(
        'Show tab titles next to their icons. Double-click the sidebar edge to toggle.'
      )
    }
    // A context without a form factor is the desktop's page and its search: the row reads the
    // same. The tablet's shell is its own, which the desktop's layout never reaches: its row
    // stays live whatever the profile stored.
    expect(expanded('horizontal').disabled).toBe(true)
    const tablet = expanded('horizontal', 'tablet')
    if (tablet.kind !== 'switch') throw new Error('not a switch')
    expect(tablet.disabled ?? false).toBe(false)
    expect(tablet.checked).toBe(true)
  })

  it('makes Look and Feel’s Expand on hover the Collapsed sidebar layout’s dependent row (tabs-03, §10.4): live there, at .4 with the way back under the other three', () => {
    const hover = (layout: ToolbarLayout, stored = true): { row: Row; patches: unknown[] } => {
      const c = context(state({}, { toolbarLayout: layout, sidebarExpandOnHover: stored }), true)
      const look = buildSection(PAGE.sections[0], { ...c.ctx, formFactor: 'desktop' })
      return { row: row(look, 'sidebar-expand-on-hover'), patches: c.patches }
    }
    // The row follows Expanded sidebar under the layout card, and only the desktop has it: the
    // layout it depends on never reaches the phone or the tablet.
    const look = buildSection(PAGE.sections[0], context(state(), true).ctx)
    const ids = look.groups[0].rows.map((r) => r.id)
    expect(ids.indexOf('sidebar-expand-on-hover')).toBe(ids.indexOf('sidebar-expanded') + 1)
    expect(hover('collapsed').row.layouts).toEqual(['desktop'])
    // Under Collapsed sidebar the switch is live, checked as stored, and writes the setting.
    const live = hover('collapsed')
    if (live.row.kind !== 'switch') throw new Error('not a switch')
    expect(live.row.disabled ?? false).toBe(false)
    expect(live.row.checked).toBe(true)
    expect(live.row.description).toBe(
      'Rest the pointer on the sidebar to show it in full until the pointer leaves.'
    )
    live.row.onChange(false)
    expect(live.patches).toEqual([{ sidebarExpandOnHover: false }])
    const off = hover('collapsed', false)
    if (off.row.kind !== 'switch') throw new Error('not a switch')
    expect(off.row.checked).toBe(false)
    // Under the other three layouts nothing flies out: the row lies at .4 (`aria-disabled`),
    // unchecked whatever the profile stored, and its description names the layout that uses it.
    for (const layout of ['single', 'multiple', 'horizontal'] as const) {
      const r = hover(layout).row
      if (r.kind !== 'switch') throw new Error('not a switch')
      expect(r.disabled, layout).toBe(true)
      expect(r.checked, layout).toBe(false)
      expect(r.description, layout).toBe('Only in the Collapsed sidebar layout.')
    }
    // The default ships on (Zen's compact behaviour, Edge's): the rail flies out until the row is
    // turned off.
    expect(DEFAULT_SETTINGS.sidebarExpandOnHover).toBe(true)
  })

  it('keeps a shell’s controls to its layout: the phone bar’s rows never reach the desktop page or its search (BUG-055)', () => {
    const host = state({
      platform: 'linux',
      capabilities: { ...ANDROID, windows: true, pageControls: false, pullToRefresh: false }
    })
    const on = (layout: 'desktop' | 'tablet' | 'phone'): Model[] =>
      buildSections(availableSections(PAGE, host.capabilities, layout, 'linux'), {
        ...context(host).ctx,
        formFactor: layout
      })
    const ids = (models: Model[]): string[] =>
      models.flatMap((m) => allRows(m.groups).map((r) => r.id))

    // The desktop two-pane (§10.5): no phone bar, so neither its position nor its editor – and
    // no row anywhere on the page that names another layout as its own.
    const desktop = on('desktop')
    expect(ids(desktop)).not.toContain('phone-bar-position')
    expect(ids(desktop)).not.toContain('navigation-bar')
    expect(ids(desktop)).not.toContain('hide-toolbar-on-scroll')
    for (const model of desktop) {
      for (const r of allRows(model.groups)) {
        expect(r.layouts === undefined || r.layouts.includes('desktop'), r.id).toBe(true)
      }
      for (const g of model.groups) {
        expect(g.layouts === undefined || g.layouts.includes('desktop'), g.id).toBe(true)
        expect(groupShows(g), `${model.section.id}/${g.id}`).toBe(true)
      }
    }
    // The URL bar group stays for its desktop rows; the bar's rows sit beside them elsewhere.
    const look = desktop.find((m) => m.section.id === 'look')!
    expect(look.groups.find((g) => g.id === 'url-bar')?.rows.map((r) => r.id)).toEqual([
      'urlbar-behaviour'
    ])
    expect(findRow(look.groups, 'bookmarks-bar')).not.toBeNull()
    const search = desktop.find((m) => m.section.id === 'search')!
    expect(findRow(search.groups, 'full-urls')).not.toBeNull()
    // "Find in Settings" reads the same filtered rows: "phones" finds no phone-bar row here…
    expect(searchRows(desktop, 'phones').map((h) => h.row.id)).toEqual([])
    expect(searchRows(desktop, 'address bar').map((h) => h.row.id)).toEqual([
      'customize-toolbar',
      'full-urls'
    ])

    // …the tablet shell is the desktop's (no phone bar, a bookmarks bar)…
    const tablet = on('tablet')
    expect(ids(tablet)).not.toContain('phone-bar-position')
    expect(ids(tablet)).not.toContain('navigation-bar')
    expect(ids(tablet)).not.toContain('hide-toolbar-on-scroll')
    expect(ids(tablet)).toContain('bookmarks-bar')
    expect(ids(tablet)).toContain('full-urls')

    // …and the phone shell has the bar (its position, its hiding on scroll, its editor) and
    // neither of the desktop's.
    const phone = on('phone')
    expect(searchRows(phone, 'phones').map((h) => h.row.id)).toEqual([
      'phone-bar-position',
      'hide-toolbar-on-scroll'
    ])
    expect(ids(phone)).toContain('navigation-bar')
    expect(ids(phone)).not.toContain('bookmarks-bar')
    expect(ids(phone)).not.toContain('full-urls')
  })

  it('offers a mouse host the split view drag and drop switch before Glance, on by default (split-12)', () => {
    const c = context(state(), true)
    const look = buildSection(PAGE.sections[0], c.ctx)
    expect(look.groups.map((g) => g.id).slice(-2)).toEqual(['split-view', 'glance'])
    const zones = row(look, 'split-edge-zones')
    expect(zones).toMatchObject({
      kind: 'switch',
      label: 'Split view drag and drop',
      description: 'Drag a tab to the edge of the page to open it in a split view.',
      checked: true
    })
    if (zones.kind !== 'switch') throw new Error('not a switch')
    zones.onChange(false)
    expect(c.patches).toEqual([{ splitEdgeZones: false }])
    // A finger scrolls the strip rather than dragging a tab: the touch host has no such row.
    expect(section('look').groups.map((g) => g.id)).not.toContain('split-view')
  })

  it('keeps the left pane’s link rule off the page: the split view group is the drag switch alone – the rule is each split’s own, on the pane’s ⋯ menu (split-13, §9.35)', () => {
    const c = context(state(), true)
    const look = buildSection(PAGE.sections[0], c.ctx)
    const group = look.groups.find((g) => g.id === 'split-view')!
    expect(group.rows.map((r) => r.id)).toEqual(['split-edge-zones'])
    expect(searchRows([look], 'right pane').map((h) => h.row.id)).toEqual([])
  })

  it('tells a touch host its own gestures: no double-click, Glance from the link menu', () => {
    const touch = section('look')
    expect(row(touch, 'sidebar-expanded').description).toBe('Show tab titles next to their icons.')
    expect(row(touch, 'glance-trigger')).toMatchObject({
      kind: 'info',
      label: 'Trigger',
      description: 'Hold a link and choose Open Link in Glance.',
      disabled: false
    })
    const off = buildSection(PAGE.sections[0], context(state({}, { glanceEnabled: false })).ctx)
    expect(row(off, 'glance-trigger').disabled).toBe(true)

    const mouse = buildSection(PAGE.sections[0], context(state(), true).ctx)
    expect(row(mouse, 'sidebar-expanded').description).toContain('Double-click the sidebar edge')
    const trigger = row(mouse, 'glance-trigger')
    if (trigger.kind !== 'value') throw new Error('not a value row')
    expect(trigger.options.map((o) => o.label)).toEqual([
      'Alt + Click',
      'Ctrl + Click',
      'Shift + Click'
    ])
  })

  it('leaves out what the host cannot do: no Sites group or Accessibility without page controls', () => {
    const desktop = state({
      platform: 'linux',
      capabilities: {
        ...ANDROID,
        pageControls: false,
        darkenSites: false,
        pullToRefresh: false,
        defaultBrowser: false
      }
    })
    const look = section('look', desktop)
    expect(look.groups.map((g) => g.id)).not.toContain('sites')
    expect(look.groups.map((g) => g.id)).not.toContain('pages')
    expect(phoneSections(desktop).map((m) => m.section.id)).not.toContain('accessibility')
    expect(findRow(section('about', desktop).groups, 'default-browser')).toBeNull()
  })
})

/*
 * Accessibility › Read aloud (CT-12, CT-13): the speed, the highlight and one voice row per
 * language the browser reads in, from the one builder both platforms draw – behind
 * `capabilities.readAloud`, which the Android fixture above leaves off.
 */
describe('Accessibility › Read aloud on a host with a speech engine', () => {
  const speaking = (settings: Partial<Settings> = {}): UIState =>
    state({ capabilities: { ...ANDROID, readAloud: true } }, settings)
  const VOICES: NonNullable<VoicesData> = {
    voices: [
      { id: 'en-gb-1', name: 'Daniel', lang: 'en-GB', local: true, quality: 'high' },
      { id: 'en-us-1', name: 'Samantha', lang: 'en-US', local: true, default: true },
      { id: 'en-us-2', name: 'Ava', lang: 'en-US', local: false },
      { id: 'fr-1', name: 'Thomas', lang: 'fr-FR', local: true }
    ],
    byLanguage: {
      en: 'en-us-1',
      'en-gb': 'en-gb-1',
      'en-us': 'en-us-1',
      fr: 'fr-1',
      'fr-fr': 'fr-1'
    }
  }
  const ACCESSIBILITY = PAGE.sections.find((x) => x.id === 'accessibility')!
  const build = (s: UIState, voices: VoicesData): Model =>
    buildSection(ACCESSIBILITY, context(s, false, {}, voices).ctx)

  it('stays off without the engine, and adds its two groups after the zoom groups with it', () => {
    expect(section('accessibility').groups.map((g) => g.id)).toEqual([
      'zoom',
      'site-zooms',
      'touchpad'
    ])
    const model = build(speaking(), VOICES)
    expect(model.groups.map((g) => g.id)).toEqual([
      'zoom',
      'site-zooms',
      'read-aloud',
      'read-aloud-voices',
      'touchpad'
    ])
    expect(model.groups.map((g) => g.heading)).toEqual([
      'Page zoom',
      'Sites with their own zoom',
      'Read aloud',
      'Voices',
      'Touchpad'
    ])
    for (const group of model.groups) expect(groupShows(group)).toBe(true)
  })

  it('ends, on Android alone, with the touchpad swipe’s switch in Chrome’s words, on every layout (GN-23 / A11Y-14)', () => {
    // Chrome Android's Accessibility page ends with "Swipe between pages using a touchpad"
    // (`accessibility_preferences.xml` `touchpad_overscroll_history_navigation`; the strings are
    // `browser_ui_strings.grd`'s), on by default (`settings.a11y.touchpad_overscroll_history_navigation`).
    const access = section('accessibility')
    const group = access.groups[access.groups.length - 1]!
    expect(group.id).toBe('touchpad')
    expect(group.layouts).toBeUndefined()
    const swipe = row(access, 'touchpad-swipe-navigate')
    expect(swipe).toMatchObject({
      kind: 'switch',
      label: 'Swipe between pages using a touchpad',
      description: 'Navigate back and forth by swiping with two fingers on the touchpad.',
      checked: true
    })
    expect(swipe.layouts).toBeUndefined()
    expect(DEFAULT_SETTINGS.touchpadSwipeToNavigate).toBe(true)
    // The switch writes the one key; a profile from before it existed reads as on.
    const c = context(state())
    const written = buildSection(ACCESSIBILITY, c.ctx)
    const r = row(written, 'touchpad-swipe-navigate')
    if (r.kind !== 'switch') throw new Error('not a switch')
    r.onChange(false)
    expect(c.patches).toEqual([{ touchpadSwipeToNavigate: false }])
    const legacy = state({}, { touchpadSwipeToNavigate: undefined as unknown as boolean })
    expect(row(section('accessibility', legacy), 'touchpad-swipe-navigate')).toMatchObject({
      checked: true
    })
    const off = section('accessibility', state({}, { touchpadSwipeToNavigate: false }))
    expect(row(off, 'touchpad-swipe-navigate')).toMatchObject({ checked: false })

    // Every Android layout keeps the row – Chrome shows it on phone and tablet alike, and an
    // Android session with a hovering pointer (DeX, a trackpad) is the desktop layout here
    // (`classifyViewport`), the very place the touchpad is: a `layouts` pin would hide it there.
    for (const layout of ['phone', 'tablet', 'desktop'] as const) {
      const model = buildSection(ACCESSIBILITY, { ...context(state()).ctx, formFactor: layout })
      expect(
        allRows(model.groups).map((x) => x.id),
        layout
      ).toContain('touchpad-swipe-navigate')
    }
    // The desktop platform has no touchpad swipe and no row: the shared builder gains nothing there.
    const desktop = state({
      platform: 'linux',
      capabilities: { ...ANDROID, pageControls: false, readAloud: true }
    })
    for (const layout of ['phone', 'tablet', 'desktop'] as const) {
      const model = buildSection(ACCESSIBILITY, {
        ...context(desktop, false, {}, VOICES).ctx,
        formFactor: layout
      })
      expect(
        model.groups.map((g) => g.id),
        layout
      ).toEqual(['read-aloud', 'read-aloud-voices'])
    }
  })

  it('is the whole category on a desktop without page controls, and lists the category there', () => {
    const desktop = state({
      platform: 'linux',
      capabilities: { ...ANDROID, pageControls: false, readAloud: true }
    })
    expect(phoneSections(desktop).map((m) => m.section.id)).toContain('accessibility')
    expect(build(desktop, VOICES).groups.map((g) => g.id)).toEqual([
      'read-aloud',
      'read-aloud-voices'
    ])
  })

  it('offers the speed on the model’s ladder and the highlight in Edge’s words, run as commands', () => {
    const model = build(
      speaking({ readAloud: { rate: 1.2, voiceByLanguage: {}, highlight: 'both' } }),
      VOICES
    )
    const speed = row(model, 'read-aloud-rate')
    if (speed.kind !== 'value') throw new Error('not a value row')
    expect(speed.label).toBe('Speed')
    expect(currentOptionLabel(speed)).toBe('1.2×')
    expect(speed.options.map((o) => o.label)).toEqual([
      '0.5×',
      '0.8×',
      '1×',
      '1.2×',
      '1.5×',
      '2×',
      '3×',
      '4×'
    ])
    speed.onChange('2')
    expect(invoke).toHaveBeenCalledWith('readAloud.setRate', { rate: 2 })

    const highlight = row(model, 'read-aloud-highlight')
    if (highlight.kind !== 'value') throw new Error('not a value row')
    expect(currentOptionLabel(highlight)).toBe('Sentence and word')
    expect(highlight.options.map((o) => o.label)).toEqual([
      'Sentence and word',
      'Sentence',
      'Word',
      'Off'
    ])
    highlight.onChange('off')
    expect(invoke).toHaveBeenCalledWith('readAloud.setHighlight', { mode: 'off' })
  })

  it('has a voice row per language the browser reads in, plus any the player chose a voice for', () => {
    const model = build(
      speaking({
        readAloud: { rate: 1, voiceByLanguage: { 'en-gb': 'en-gb-1', de: 'x' }, highlight: 'both' }
      }),
      VOICES
    )
    const voices = model.groups.find((g) => g.id === 'read-aloud-voices')!
    expect(voices.rows.map((r) => r.id)).toEqual([
      'read-aloud-voice:en',
      'read-aloud-voice:fr',
      'read-aloud-voice:en-gb',
      'read-aloud-voice:de'
    ])
    expect(voices.rows.map((r) => r.label)).toEqual([
      'English',
      'French',
      'English (United Kingdom)',
      'German'
    ])
    // English: every English voice, the engine's default as the value, regions on the options.
    const english = row(model, 'read-aloud-voice:en')
    if (english.kind !== 'value') throw new Error('not a value row')
    expect(english.value).toBe('en-us-1')
    expect(english.options.map((o) => o.label)).toEqual(['Daniel', 'Samantha', 'Ava'])
    expect(english.options[0]?.description).toBe(
      'English (United Kingdom) · On this device · High quality'
    )
    expect(english.options[2]?.description).toBe('English (United States) · Needs a network')
    english.onChange('en-gb-1')
    expect(invoke).toHaveBeenCalledWith('readAloud.setVoice', { voiceId: 'en-gb-1', lang: 'en' })
    // British English: the saved choice is the value.
    const british = row(model, 'read-aloud-voice:en-gb')
    if (british.kind !== 'value') throw new Error('not a value row')
    expect(british.value).toBe('en-gb-1')
    // German: nothing speaks it – a fact, not a picker.
    expect(row(model, 'read-aloud-voice:de')).toMatchObject({
      kind: 'info',
      description: 'No voice for this language on this device'
    })
  })

  it('says the list is on its way, then that the device has none', () => {
    const waiting = build(speaking(), null).groups.find((g) => g.id === 'read-aloud-voices')!
    expect(waiting.rows).toEqual([
      { kind: 'info', id: 'read-aloud-voices-loading', label: 'Looking for voices…' }
    ])
    const none = build(speaking(), { voices: [], byLanguage: {} }).groups.find(
      (g) => g.id === 'read-aloud-voices'
    )!
    expect(none.rows).toEqual([])
    expect(none.empty).toBe('No voices on this device')
    expect(groupShows(none)).toBe(true)
  })

  it('is found by the landing’s search under its category', () => {
    const models = buildSections(
      availableSections(PAGE, speaking().capabilities, 'phone'),
      context(speaking(), false, {}, VOICES).ctx
    )
    const hits = searchRows(models, 'voice')
    expect(hits.map((h) => h.caption)).toContain('Accessibility › Voices')
    expect(searchRows(models, 'speed').map((h) => h.row.id)).toContain('read-aloud-rate')
  })
})

describe('what a row does', () => {
  it('a switch row patches its setting; a value row patches its choice', () => {
    const c = context()
    const look = buildSection(PAGE.sections[0], c.ctx)
    const borderless = row(look, 'borderless')
    if (borderless.kind !== 'switch') throw new Error('not a switch')
    expect(borderless.checked).toBe(DEFAULT_SETTINGS.borderless)
    borderless.onChange(!borderless.checked)
    expect(c.patches).toEqual([{ borderless: !DEFAULT_SETTINGS.borderless }])

    const scheme = row(look, 'color-scheme')
    if (scheme.kind !== 'value') throw new Error('not a value row')
    expect(currentOptionLabel(scheme)).toBe('Follow system')
    scheme.onChange('dark')
    expect(c.patches[1]).toEqual({ colorScheme: 'dark' })
  })

  it('CT-23: the colour scheme row says pages follow it – the desktop’s description, the phone picker’s title block', () => {
    const scheme = row(section('look'), 'color-scheme')
    if (scheme.kind !== 'value') throw new Error('not a value row')
    expect(scheme.sheetDescription).toBe('Websites follow this too.')
    expect(scheme.options.map((o) => o.label)).toEqual(['Follow system', 'Light', 'Dark'])
  })

  describe('CT-25: Customise fonts', () => {
    const desktopHost = (settings: Partial<Settings> = {}): UIState =>
      state(
        { platform: 'linux', capabilities: { ...ANDROID, genericFontFamilies: true } },
        settings
      )

    it('the two sizes on the phone are §10.4 slider rows over Chrome’s stops – the value is the stop’s index, the row reads the size, no end labels – and a step or letting go writes the size alone into the fonts', () => {
      const c = context()
      const look = buildSection(PAGE.sections[0], { ...c.ctx, formFactor: 'phone' })
      const size = row(look, 'fonts-size-phone')
      if (size.kind !== 'slider') throw new Error('not a slider')
      expect([size.min, size.max, size.step]).toEqual([0, FONT_SIZE_STEPS.length - 1, 1])
      expect(FONT_SIZE_STEPS[size.value]).toBe(16)
      expect(size.format(size.value)).toBe('16 px')
      expect('ends' in size).toBe(false)
      size.onChange(FONT_SIZE_STEPS.indexOf(20))
      expect(c.patches.at(-1)).toEqual({ fonts: { ...DEFAULT_SETTINGS.fonts, size: 20 } })
      // The same stop again is not a write.
      const before = c.patches.length
      size.onChange(size.value)
      expect(c.patches.length).toBe(before)

      const minimum = row(look, 'fonts-minimum-size-phone')
      if (minimum.kind !== 'slider') throw new Error('not a slider')
      expect(minimum.value).toBe(0)
      expect(minimum.format(0)).toBe('None')
      expect(minimum.format(MINIMUM_FONT_SIZE_STEPS.indexOf(12))).toBe('12 px')
      expect(minimum.description).toBe('The smallest text a page may use.')
      minimum.onChange(MINIMUM_FONT_SIZE_STEPS.indexOf(12))
      expect(c.patches.at(-1)).toEqual({ fonts: { ...DEFAULT_SETTINGS.fonts, minimumSize: 12 } })
      // The desktop's rows are not the phone's (§10.5: no slider on a desktop page).
      expect(findRow(look.groups, 'fonts-size')).toBeNull()
      expect(findRow(look.groups, 'fonts-minimum-size')).toBeNull()

      // A synced size between two stops sits on the nearest one, and the row reads that stop.
      const odd = buildSection(PAGE.sections[0], {
        ...context(state({}, { fonts: { ...DEFAULT_SETTINGS.fonts, size: 19 } })).ctx,
        formFactor: 'phone'
      })
      const oddSize = row(odd, 'fonts-size-phone')
      if (oddSize.kind !== 'slider') throw new Error('not a slider')
      expect(FONT_SIZE_STEPS[oddSize.value]).toBe(18)
    })

    it('the two sizes on the desktop are §10.5’s menulists of the stops – "16 px", "None" – a size off the ladder listed where it falls so the row never shows a value its list lacks; a pick writes the size alone', () => {
      const c = context()
      const look = buildSection(PAGE.sections[0], { ...c.ctx, formFactor: 'desktop' })
      const size = row(look, 'fonts-size')
      if (size.kind !== 'value') throw new Error('not a value row')
      expect(size.value).toBe('16')
      expect(currentOptionLabel(size)).toBe('16 px')
      expect(size.options.map((o) => o.value)).toEqual(FONT_SIZE_STEPS.map(String))
      expect(size.options[0]).toEqual({ value: '9', label: '9 px' })
      size.onChange('20')
      expect(c.patches.at(-1)).toEqual({ fonts: { ...DEFAULT_SETTINGS.fonts, size: 20 } })
      const before = c.patches.length
      size.onChange('16')
      expect(c.patches.length).toBe(before)

      const minimum = row(look, 'fonts-minimum-size')
      if (minimum.kind !== 'value') throw new Error('not a value row')
      expect(minimum.value).toBe('0')
      expect(currentOptionLabel(minimum)).toBe('None')
      expect(minimum.options.slice(0, 2)).toEqual([
        { value: '0', label: 'None' },
        { value: '6', label: '6 px' }
      ])
      minimum.onChange('12')
      expect(c.patches.at(-1)).toEqual({ fonts: { ...DEFAULT_SETTINGS.fonts, minimumSize: 12 } })
      expect(findRow(look.groups, 'fonts-size-phone')).toBeNull()
      expect(findRow(look.groups, 'fonts-minimum-size-phone')).toBeNull()

      // A synced 19 is a stop of its own between 18 and 20, so the menulist shows "19 px".
      expect(
        fontSizeOptions(FONT_SIZE_STEPS, 19)
          .map((o) => o.label)
          .slice(9, 13)
      ).toEqual(['18 px', '19 px', '20 px', '22 px'])
      expect(fontSizeOptions(FONT_SIZE_STEPS, 16)).toHaveLength(FONT_SIZE_STEPS.length)
      const odd = buildSection(PAGE.sections[0], {
        ...context(state({}, { fonts: { ...DEFAULT_SETTINGS.fonts, size: 19 } })).ctx,
        formFactor: 'desktop'
      })
      const oddSize = row(odd, 'fonts-size')
      if (oddSize.kind !== 'value') throw new Error('not a value row')
      expect(currentOptionLabel(oddSize)).toBe('19 px')
    })

    it('a phone host whose engine ignores the generic slots lists the standard family alone, with WebView’s aliases, as a form row in the phone shell; the preview follows; no Reset at the defaults', () => {
      const c = context()
      const model = buildSection(PAGE.sections[0], { ...c.ctx, formFactor: 'phone' })
      const group = model.groups.find((g) => g.id === 'fonts')!
      expect(group.heading).toBe('Customise fonts')
      expect(group.description).toContain('are the system’s on this device')
      expect(group.rows.map((r) => r.id)).toEqual([
        'fonts-size-phone',
        'fonts-minimum-size-phone',
        'fonts-standard-phone',
        'fonts-preview'
      ])
      const standard = row(model, 'fonts-standard-phone')
      if (standard.kind !== 'action') throw new Error('not an action')
      expect(standard.label).toBe('Standard font')
      expect(standard.description).toBe('System default')
      expect(standard.form?.title).toBe('Standard font')
      // The picker's sheet opens expanded, scrolled to the checked face, when its rows exceed
      // the peek (§9.13, the #350 lead check's addition).
      expect(standard.form?.body).toBe('picker')
      expect(findRow(model.groups, 'fonts-reset')).toBeNull()

      // The picker's options: the platform's default first, then the aliases, each in its face.
      const options = familyOptions(null, null, false)
      expect(options.map((o) => o.value)).toEqual(['', ...ANDROID_FONT_FAMILIES])
      expect(options[0].font).toBeUndefined()
      expect(options.slice(1).every((o) => o.font === o.value)).toBe(true)
    })

    it('a desktop host lists the four slots as menulist rows whose options carry their face as a CSS family for the picker’s specimen – the generic names, then the installed families in one run, no heading – keeping a synced family the computer lacks; Reset comes once anything moved and writes the defaults whole', () => {
      const c = context(desktopHost({ fonts: { ...DEFAULT_SETTINGS.fonts, serif: 'Georgia' } }))
      const model = buildSection(PAGE.sections[0], {
        ...c.ctx,
        formFactor: 'desktop',
        localFonts: ['Georgia', 'Inter', 'monospace']
      })
      const group = model.groups.find((g) => g.id === 'fonts')!
      expect(group.description).not.toContain('on this device')
      expect(group.rows.map((r) => r.id)).toEqual([
        'fonts-size',
        'fonts-minimum-size',
        'fonts-standard',
        'fonts-serif',
        'fonts-sansSerif',
        'fonts-fixed',
        'fonts-preview',
        'fonts-reset'
      ])
      const serif = row(model, 'fonts-serif')
      if (serif.kind !== 'value') throw new Error('not a value row')
      expect(serif.value).toBe('Georgia')
      expect(currentOptionLabel(serif)).toBe('Georgia')
      expect(serif.options.map((o) => o.value)).toEqual([
        '',
        ...GENERIC_FONT_FAMILIES,
        'Georgia',
        'Inter'
      ])
      // The face rides as a CSS family value (quoted, so "Fira Code" is one family); the desktop
      // popover draws no group headings, so no option is grouped (the #350 review's nit 2).
      expect(serif.options.find((o) => o.value === 'Inter')).toEqual({
        value: 'Inter',
        label: 'Inter',
        font: '"Inter"'
      })
      expect(serif.options.every((o) => o.group === undefined)).toBe(true)
      expect(serif.options.find((o) => o.value === 'serif')).toMatchObject({
        label: 'Serif',
        font: 'serif'
      })
      // Choosing writes the slot alone; the platform's default writes null.
      serif.onChange('Inter')
      expect(c.patches.at(-1)).toEqual({
        fonts: { ...DEFAULT_SETTINGS.fonts, serif: 'Inter' }
      })
      serif.onChange('')
      expect(c.patches.at(-1)).toEqual({ fonts: { ...DEFAULT_SETTINGS.fonts, serif: null } })

      // A family the computer no longer lists stays an option, so the row never shows a value
      // its picker lacks.
      const gone = buildSection(PAGE.sections[0], {
        ...context(desktopHost({ fonts: { ...DEFAULT_SETTINGS.fonts, fixed: 'Fira Code' } })).ctx,
        formFactor: 'desktop',
        localFonts: ['Inter']
      })
      const fixed = row(gone, 'fonts-fixed')
      if (fixed.kind !== 'value') throw new Error('not a value row')
      expect(fixed.options.at(-1)).toMatchObject({ value: 'Fira Code', font: '"Fira Code"' })

      // Before the computer has answered, the rows keep to the generic names.
      const waiting = buildSection(PAGE.sections[0], {
        ...context(desktopHost()).ctx,
        formFactor: 'desktop',
        localFonts: null
      })
      const standard = row(waiting, 'fonts-standard')
      if (standard.kind !== 'value') throw new Error('not a value row')
      expect(standard.options.map((o) => o.value)).toEqual(['', ...GENERIC_FONT_FAMILIES])
      expect(findRow(waiting.groups, 'fonts-reset')).toBeNull()

      // Reset is plain and unconfirmed (§10.4: a reset to the defaults destroys no data).
      const reset = row(model, 'fonts-reset')
      if (reset.kind !== 'action') throw new Error('not an action')
      expect(reset.button).toBe('Reset')
      expect(reset.destructive).toBeFalsy()
      expect(reset.confirm).toBeUndefined()
      reset.onPress?.()
      expect(c.patches.at(-1)).toEqual({ fonts: DEFAULT_SETTINGS.fonts })
    })

    it('a slot or size an extension holds (chrome.fontSettings; state.extensionControls keyed fonts.<slot>, fonts.size, fonts.minimumSize) is drawn controlled in both of the row’s forms showing the extension’s value – the one in effect – over the user’s own, its neighbours not; the preview renders in the effective fonts, Reset keeps to the user’s; Disable takes the Extensions page’s path, Manage the extension’s own page', async () => {
      const extension = { extensionId: 'a'.repeat(32), name: 'Advanced Font Settings' }
      const extensionControls = {
        'fonts.standard': { ...extension, value: 'Inter' },
        'fonts.size': { ...extension, value: 20 }
      }
      // The user's own values underneath differ from the extension's: Georgia at 16 px.
      const held = state(
        {
          platform: 'linux',
          capabilities: { ...ANDROID, genericFontFamilies: true },
          extensionControls
        },
        { fonts: { ...DEFAULT_SETTINGS.fonts, standard: 'Georgia', size: 16 } }
      )
      const c = context(held)
      const desktop = buildSection(PAGE.sections[0], {
        ...c.ctx,
        formFactor: 'desktop',
        localFonts: ['Georgia']
      })
      // The held rows carry the extension and show its value in their disabled control, as
      // Chrome's fonts page shows the preference's effective value; the family is listed even
      // though the computer has no such face, so the row never shows a value its list lacks.
      const standard = row(desktop, 'fonts-standard')
      if (standard.kind !== 'value') throw new Error('not a value row')
      expect(standard.controlled).toMatchObject({ ...extension, value: 'Inter' })
      expect(standard.value).toBe('Inter')
      expect(standard.options.some((o) => o.value === 'Inter')).toBe(true)
      const size = row(desktop, 'fonts-size')
      if (size.kind !== 'value') throw new Error('not a value row')
      expect(size.controlled).toMatchObject({ ...extension, value: 20 })
      expect(size.value).toBe('20')
      // The rows beside them are the user's, and so is Reset, which resets the user's own
      // values (the held preferences stay the extension's until it is disabled, as in Chrome).
      for (const id of ['fonts-minimum-size', 'fonts-serif', 'fonts-sansSerif', 'fonts-fixed'])
        expect(row(desktop, id).controlled).toBeUndefined()
      expect(row(desktop, 'fonts-preview').controlled).toBeUndefined()
      const reset = row(desktop, 'fonts-reset')
      expect(reset.controlled).toBeUndefined()
      if (reset.kind !== 'action') throw new Error('not an action')
      reset.onPress?.()
      expect(c.patches.at(-1)).toEqual({ fonts: DEFAULT_SETTINGS.fonts })
      // The preview renders in the effective fonts – what a page gets: Inter at 20 px.
      const preview = row(desktop, 'fonts-preview')
      if (preview.kind !== 'custom') throw new Error('not a custom row')
      const html = renderToStaticMarkup(preview.render() as ReactElement)
      expect(html).toContain('--zen-settings-preview-family:&quot;Inter&quot;')
      expect(html).toContain('--zen-settings-preview-size:20px')
      expect(html).not.toContain('Georgia')
      // Disable goes through the host's own path, the one the Extensions page's switch takes.
      standard.controlled!.onDisable()
      expect(invoke).toHaveBeenCalledWith('extension.setEnabled', {
        id: extension.extensionId,
        enabled: false
      })
      // Manage – the phone indicator row's press – is "Manage extension": the extension's
      // details, where its switch is, asked for on the management surface
      // (`extensionRevealStore`); on this host without page tabs, the Add-ons overlay.
      standard.controlled!.onManage()
      expect(extensionRevealStore.get().id).toBe(extension.extensionId)
      await vi.waitFor(() => expect(uiStore.get().overlay).toBe('addons'))
      expect(invoke).not.toHaveBeenCalledWith('extension.setEnabled', {
        id: extension.extensionId,
        enabled: true
      })
      uiStore.set({ overlay: 'none' })
      extensionRevealStore.set({ id: null })
      // The indicator rows the group draws (`controlledRuns`, one per run of consecutive rows
      // one extension holds): the held size and the held standard face are separated by the
      // free minimum size, so each gets its own, after itself.
      const fontsRows = desktop.groups.find((g) => g.id === 'fonts')!.rows
      const ids = fontsRows.map((r) => r.id)
      const after = controlledRuns(fontsRows)
        .map((n, i) => (n > 0 ? `${ids[i]}:${n}` : null))
        .filter((s) => s !== null)
      expect(after).toEqual(['fonts-size:1', 'fonts-standard:1'])

      // The phone shell's forms of the same rows carry the same control and value: the family
      // row's description is the extension's face, the slider stands on its stop.
      const phone = buildSection(PAGE.sections[0], { ...c.ctx, formFactor: 'phone' })
      const standardPhone = row(phone, 'fonts-standard-phone')
      expect(standardPhone.controlled).toMatchObject({ ...extension, value: 'Inter' })
      expect(standardPhone.description).toBe('Inter')
      const sizePhone = row(phone, 'fonts-size-phone')
      expect(sizePhone.controlled).toMatchObject({ ...extension, value: 20 })
      if (sizePhone.kind !== 'slider') throw new Error('not a slider row')
      expect(sizePhone.format(sizePhone.value)).toBe('20 px')
      expect(row(phone, 'fonts-minimum-size-phone').controlled).toBeUndefined()

      // No extension holding anything: no row is controlled.
      const free = buildSection(PAGE.sections[0], {
        ...context(desktopHost()).ctx,
        formFactor: 'desktop'
      })
      for (const r of free.groups.find((g) => g.id === 'fonts')!.rows)
        expect(r.controlled).toBeUndefined()
    })

    it('an extension holding the size, the minimum size and the standard face – a run of consecutive rows – gets one indicator row after the run in either shell’s form, the faces beside them free (controlledRuns on the built group)', () => {
      const extension = { extensionId: 'a'.repeat(32), name: 'Advanced Font Settings' }
      const held = state(
        {
          platform: 'linux',
          capabilities: { ...ANDROID, genericFontFamilies: true },
          extensionControls: {
            'fonts.size': { ...extension, value: 18 },
            'fonts.minimumSize': { ...extension, value: 12 },
            'fonts.standard': { ...extension, value: 'Inter' }
          }
        },
        { fonts: { ...DEFAULT_SETTINGS.fonts } }
      )
      const c = context(held)
      for (const formFactor of ['desktop', 'phone'] as const) {
        const model = buildSection(PAGE.sections[0], {
          ...c.ctx,
          formFactor,
          localFonts: ['Inter']
        })
        const rows = model.groups.find((g) => g.id === 'fonts')!.rows
        const suffix = formFactor === 'phone' ? '-phone' : ''
        expect(rows.slice(0, 4).map((r) => r.id)).toEqual([
          `fonts-size${suffix}`,
          `fonts-minimum-size${suffix}`,
          `fonts-standard${suffix}`,
          `fonts-serif${suffix}`
        ])
        // The run of three closes on the standard face: one indicator there, none elsewhere.
        const runs = controlledRuns(rows)
        expect(runs[2]).toBe(3)
        expect(runs.filter((n) => n > 0)).toEqual([3])
        for (const r of rows.slice(3)) expect(r.controlled).toBeUndefined()
        // The held rows show the extension's values, the one in effect.
        const standard = row(model, `fonts-standard${suffix}`)
        expect(standard.controlled).toMatchObject({ ...extension, value: 'Inter' })
        expect(standard.kind === 'value' ? standard.value : standard.description).toBe('Inter')
      }
    })

    it('the preview is §10.3’s static content row – a 13/69 % label over the samples, which are decoration for the eye – in the page fonts themselves: the standard family at the size, the fixed one at Chrome’s ratio, both floored by the minimum', () => {
      const fonts = { ...DEFAULT_SETTINGS.fonts, standard: 'Inter', size: 24, minimumSize: 20 }
      expect(previewFamilies(fonts, 'linux')).toEqual({ standard: 'Inter', fixed: 'Monospace' })
      expect(previewFamilies(DEFAULT_SETTINGS.fonts, 'android')).toEqual({
        standard: 'serif',
        fixed: 'monospace'
      })
      const html = renderToStaticMarkup(createElement(FontPreview, { fonts, platform: 'linux' }))
      expect(html).toContain('data-row="fonts-preview"')
      expect(html).toContain('data-static')
      // The content row's label form (§10.3): the label first at 13/69 %, the two samples hidden
      // from the accessibility tree (the caption says what they are), the caption last.
      expect(html).toMatch(
        /<span class="zen-settings-description" data-part="label">Preview<\/span><p [^>]*data-face="standard"[^>]*aria-hidden="true"/
      )
      expect(html).toMatch(/<p [^>]*data-face="fixed"[^>]*aria-hidden="true"/)
      expect(html).toMatch(
        /data-part="description">How a page’s text and its fixed-width text look with these settings\.<\/span>/
      )
      expect(html).toContain('--zen-settings-preview-family:&quot;Inter&quot;')
      expect(html).toContain('--zen-settings-preview-size:24px')
      // Chrome's monospace size for 24 is 20 (the 13/16 ratio), floored by the minimum of 20.
      expect(html).toContain('--zen-settings-preview-fixed-size:20px')
      expect(html).toContain('--zen-settings-preview-fixed-family:&quot;Monospace&quot;')
    })

    it('is found by the landing’s search under Look and Feel', () => {
      const models = phoneSections()
      expect(searchRows(models, 'font size').map((h) => h.row.id)).toContain('fonts-size-phone')
      expect(searchRows(models, 'typeface').map((h) => h.caption)).toContain(
        'Look and Feel › Customise fonts'
      )
    })
  })

  it('page-control rows patch inside pageControls, keeping the rest of it', () => {
    const c = context()
    const look = buildSection(PAGE.sections[0], c.ctx)
    const darken = row(look, 'darken-sites')
    if (darken.kind !== 'switch') throw new Error('not a switch')
    darken.onChange(true)
    expect(c.patches).toEqual([
      { pageControls: { ...DEFAULT_SETTINGS.pageControls, darkenSites: true } }
    ])
  })

  it('a dependent row is disabled while its parent is off', () => {
    const on = row(section('look'), 'glance-trigger')
    expect(on.disabled).toBe(false)
    const off = row(section('look', state({}, { glanceEnabled: false })), 'glance-trigger')
    expect(off.disabled).toBe(true)
  })

  it('Navigation bar opens the bar editor; Check for updates moves to Updates and checks', () => {
    const c = context()
    const look = buildSection(PAGE.sections[0], c.ctx)
    const bar = row(look, 'navigation-bar')
    if (bar.kind !== 'action') throw new Error('not an action')
    bar.onPress?.()
    expect(c.barEditor).toBe(1)

    const about = buildSection(PAGE.sections[PAGE.sections.length - 1], c.ctx)
    const check = row(about, 'check-updates')
    if (check.kind !== 'action') throw new Error('not an action')
    check.onPress?.()
    expect(c.navigated).toEqual(['updates'])
    expect(invoke).toHaveBeenCalledWith('updates.check', undefined)
  })

  it('Set as default browser asks the host from the settings', () => {
    const about = section('about')
    const r = row(about, 'default-browser')
    if (r.kind !== 'action') throw new Error('not an action')
    r.onPress?.()
    expect(invoke).toHaveBeenCalledWith('defaultBrowser.request', { source: 'settings' })
  })

  describe('the §10.5 controlled-setting rows beyond fonts: chrome.privacy, the search override (PR #508)', () => {
    const extension = { extensionId: 'b'.repeat(32), name: 'Privacy Guard' }
    const held = (
      controls: UIState['extensionControls'],
      settings: Partial<Settings> = {}
    ): UIState => state({ privacy: PRIVACY_STATUS, extensionControls: controls }, settings)

    // The maps below are what the host publishes: `SERVICE_CONTROL_KEYS`
    // (main/platform/extensionApi/privacy.ts) carries the eight chrome.privacy settings Zenium has
    // a row for, each under its `EXTENSION_SETTING_KEYS` name – the one name the row, the table
    // and the service share – and searchProvider.ts the default engine. Each service reads the
    // extension's value over the user's (the layer, #522), so a held row shows the value in effect
    // and is marked whatever that value is – Chrome marks the pref whenever an extension holds it,
    // at the user's own value too. The last test pins the names: every key of the shared table has
    // its row here, so a key renamed on one side without the other fails it.
    const dntHeld = held({ 'privacy.doNotTrack': { ...extension, value: true } })

    it("Safe Browsing: services.safeBrowsingEnabled holds the level row at the extension's value – off, the API key row and its gate following the level in effect; held on at the user's own level, marked all the same; Disable takes the Extensions page's path", () => {
      const model = section(
        'privacy',
        held({ 'privacy.safeBrowsingEnabled': { ...extension, value: false } })
      )
      const level = row(model, 'safe-browsing-level')
      if (level.kind !== 'value') throw new Error('not a value row')
      expect(level.value).toBe('off')
      expect(level.controlled).toMatchObject({ ...extension, value: false })
      // The key row follows the level in effect (off): no key to try.
      expect(row(model, 'safe-browsing-api-key').disabled).toBe(true)
      expect(row(model, 'safe-browsing-api-key').controlled).toBeUndefined()
      // One indicator, after the level row alone: "An extension sets this. Disable it to use
      // your own value."
      const rows = model.groups.find((g) => g.id === 'safe-browsing')!.rows
      expect(controlledRuns(rows)).toEqual([1, 0])
      // Held on while the user has it on: the value is the user's, the mark is there.
      const same = section(
        'privacy',
        held({ 'privacy.safeBrowsingEnabled': { ...extension, value: true } })
      )
      expect(row(same, 'safe-browsing-level')).toMatchObject({
        value: 'standard',
        controlled: expect.objectContaining({ ...extension, value: true })
      })
      expect(row(same, 'safe-browsing-api-key').disabled ?? false).toBe(false)
      // Held off while the user has it off: still marked (the extension holds it).
      const off = section(
        'privacy',
        held(
          { 'privacy.safeBrowsingEnabled': { ...extension, value: false } },
          { privacy: { ...DEFAULT_SETTINGS.privacy, safeBrowsingEnabled: false } }
        )
      )
      expect(row(off, 'safe-browsing-level')).toMatchObject({
        value: 'off',
        controlled: expect.objectContaining(extension)
      })
      level.controlled!.onDisable()
      expect(invoke).toHaveBeenCalledWith('extension.setEnabled', {
        id: extension.extensionId,
        enabled: false
      })
      // Do Not Track beside it stays the user's: one held key, one row.
      expect(row(model, 'signals-dnt').controlled).toBeUndefined()
    })

    it('Do Not Track: websites.doNotTrackEnabled holds the DNT switch at its value under the one name the row, the table and the protection service share (`privacy.doNotTrack`); GPC beside it stays the user’s', () => {
      const model = section('privacy', dntHeld)
      expect(row(model, 'signals-dnt')).toMatchObject({
        kind: 'switch',
        checked: true,
        controlled: expect.objectContaining({ ...extension, value: true })
      })
      expect(row(model, 'signals-gpc').controlled).toBeUndefined()
      const rows = model.groups.find((g) => g.id === 'signals')!.rows
      expect(controlledRuns(rows)).toEqual([0, 1])
      // Held at the user's own value, the row is marked all the same (Chrome marks the pref
      // whenever an extension holds it, whatever the value).
      const same = section(
        'privacy',
        held({ 'privacy.doNotTrack': { ...extension, value: false } })
      )
      expect(row(same, 'signals-dnt')).toMatchObject({
        checked: false,
        controlled: expect.objectContaining({ ...extension, value: false })
      })
      // The old name reaches no row: the map and the row moved together.
      expect(
        row(
          section('privacy', held({ 'privacy.dnt': { ...extension, value: true } })),
          'signals-dnt'
        ).controlled
      ).toBeUndefined()
      // Disable takes the Extensions page's path.
      row(model, 'signals-dnt').controlled!.onDisable()
      expect(invoke).toHaveBeenCalledWith('extension.setEnabled', {
        id: extension.extensionId,
        enabled: false
      })
    })

    it('third-party cookies: websites.thirdPartyCookiesAllowed holds the default radio and the private-only switch as one run (one indicator, "An extension sets these.") – false is Block third-party over the user\'s Allow all, true is Allow all cookies over the user\'s block, the private-only switch following the default in effect', () => {
      // The user allows all cookies; the extension blocks third-party ones.
      const blocked = section(
        'privacy',
        state(
          {
            privacy: PRIVACY_STATUS,
            siteData: { ...emptySiteDataStatus(), default: 'allow' },
            extensionControls: { 'privacy.thirdPartyCookies': { ...extension, value: false } }
          },
          { privacy: { ...DEFAULT_SETTINGS.privacy, thirdPartyCookies: 'allow' } }
        )
      )
      const radio = row(blocked, 'site-data-default')
      if (radio.kind !== 'value') throw new Error('not a value row')
      expect(radio.value).toBe('block-third-party')
      expect(radio.controlled).toMatchObject({ ...extension, value: false })
      // The extension's block is the whole profile's: the private-only switch reads off, and is
      // in the run (held with the radio), not disabled beneath it.
      expect(row(blocked, 'site-data-private-only')).toMatchObject({
        kind: 'switch',
        checked: false,
        disabled: false,
        controlled: expect.objectContaining({ ...extension, value: false })
      })
      const rows = blocked.groups.find((g) => g.id === 'site-data')!.rows
      expect(rows.map((r) => r.id)).toEqual(['site-data-default', 'site-data-private-only'])
      expect(controlledRuns(rows)).toEqual([0, 2])
      // The user blocks third-party cookies; the extension allows them all.
      const allowed = section(
        'privacy',
        held({ 'privacy.thirdPartyCookies': { ...extension, value: true } })
      )
      expect(row(allowed, 'site-data-default')).toMatchObject({
        value: 'allow',
        controlled: expect.objectContaining({ ...extension, value: true })
      })
      expect(row(allowed, 'site-data-private-only')).toMatchObject({
        checked: false,
        disabled: true,
        controlled: expect.objectContaining(extension)
      })
      expect(controlledRuns(allowed.groups.find((g) => g.id === 'site-data')!.rows)).toEqual([0, 2])
      // Held at the user's own value (both block): marked, the radio where the user left it.
      const same = section(
        'privacy',
        held({ 'privacy.thirdPartyCookies': { ...extension, value: false } })
      )
      expect(row(same, 'site-data-default')).toMatchObject({
        value: 'block-third-party',
        controlled: expect.objectContaining(extension)
      })
      // A held Do Not Track alone leaves both cookie rows the user's and live.
      const dnt = section('privacy', dntHeld)
      expect(row(dnt, 'site-data-default')).toMatchObject({ value: 'block-third-party' })
      expect(row(dnt, 'site-data-default').controlled).toBeUndefined()
      expect(row(dnt, 'site-data-private-only')).toMatchObject({ checked: true, disabled: false })
      expect(row(dnt, 'site-data-private-only').controlled).toBeUndefined()
      expect(controlledRuns(dnt.groups.find((g) => g.id === 'site-data')!.rows)).toEqual([0, 0])
    })

    it("search: the extension holding the default engine (chrome_settings_overrides) holds the picker at its engine, listed for the held row to show, the user's pick waiting – the suggestions switch beside it the user's and live until services.searchSuggestEnabled holds it too, when the two rows are one run", () => {
      const engine: SearchEngine = {
        id: `extension:${extension.extensionId}`,
        name: 'Guarded Search',
        searchUrl: 'https://search.guard.example/?q=%s',
        suggestUrl: null,
        keyword: '@guard',
        glyph: 'G',
        source: 'extension',
        favicon: null
      }
      const model = section(
        'search',
        state(
          {
            searchEngines: [...DEFAULT_SEARCH_ENGINES, engine],
            extensionControls: {
              'search.defaultEngine': { ...extension, value: engine.id }
            }
          },
          { searchEngineId: DEFAULT_SEARCH_ENGINES[1].id, searchSuggestions: true }
        )
      )
      const picker = row(model, 'search-engine')
      if (picker.kind !== 'value') throw new Error('not a value row')
      expect(picker.controlled).toMatchObject({ ...extension, value: engine.id })
      expect(picker.value).toBe(engine.id)
      expect(picker.options[0]).toMatchObject({ value: engine.id, label: 'Guarded Search' })
      expect(picker.options.filter((o) => o.value === engine.id)).toHaveLength(1)
      const suggestions = row(model, 'search-suggestions')
      expect(suggestions).toMatchObject({ kind: 'switch', checked: true })
      expect(suggestions.controlled).toBeUndefined()
      expect(suggestions.disabled ?? false).toBe(false)
      // One indicator after the engine row alone: "An extension sets this. Disable it to use
      // your own value." – the suggestions row beside it is not in the run.
      const rows = model.groups.find((g) => g.id === 'search')!.rows
      expect(controlledRuns(rows).filter((n) => n > 0)).toEqual([1])
      expect(controlledRuns(rows)[rows.findIndex((r) => r.id === 'search-engine')]).toBe(1)
      // The same extension holding the suggestions switch too (off, the user's on): the switch
      // reads the extension's value and the two rows are one run – one indicator, "An extension
      // sets these." – after the suggestions row.
      const both = section(
        'search',
        state(
          {
            searchEngines: [...DEFAULT_SEARCH_ENGINES, engine],
            extensionControls: {
              'search.defaultEngine': { ...extension, value: engine.id },
              'search.suggestions': { ...extension, value: false }
            }
          },
          { searchEngineId: DEFAULT_SEARCH_ENGINES[1].id, searchSuggestions: true }
        )
      )
      expect(row(both, 'search-suggestions')).toMatchObject({
        kind: 'switch',
        checked: false,
        controlled: expect.objectContaining({ ...extension, value: false })
      })
      expect(row(both, 'search-engine').controlled).toMatchObject({ value: engine.id })
      const bothRows = both.groups.find((g) => g.id === 'search')!.rows
      expect(controlledRuns(bothRows).filter((n) => n > 0)).toEqual([2])
      expect(
        controlledRuns(bothRows)[bothRows.findIndex((r) => r.id === 'search-suggestions')]
      ).toBe(2)
      // No extension holding the default: the picker is the user's and lists no extension engine.
      const free = section('search', state({ searchEngines: [...DEFAULT_SEARCH_ENGINES, engine] }))
      const own = row(free, 'search-engine')
      if (own.kind !== 'value') throw new Error('not a value row')
      expect(own.controlled).toBeUndefined()
      expect(own.value).toBe(DEFAULT_SETTINGS.searchEngineId)
      expect(own.options.some((o) => o.value === engine.id)).toBe(false)
    })

    it("offering to save passwords, addresses, cards: services.passwordSavingEnabled, services.autofillAddressEnabled and services.autofillCreditCardEnabled hold the four rows at the extension's values – the Passwords page's switch and the Autofill page's three, marked at the user's own value too, Auto sign-in beside them the user's", () => {
      // The vault unlocked: the address and payment groups are drawn. The user offers to save
      // passwords and addresses, not cards; the extension says the reverse of each.
      const s = state(
        {
          platform: 'linux',
          capabilities: { ...ANDROID, windows: true },
          passwords: { ...emptyPasswordsStatus(), locked: false },
          extensionControls: {
            'passwords.offerToSave': { ...extension, value: false },
            'autofill.addresses': { ...extension, value: false },
            'autofill.cards': { ...extension, value: true }
          }
        },
        {
          passwords: { ...DEFAULT_SETTINGS.passwords, offerToSave: true },
          autofill: { ...DEFAULT_SETTINGS.autofill, addresses: true, cards: false }
        }
      )
      const passwords = section('passwords', s)
      expect(row(passwords, 'passwords-offer-to-save')).toMatchObject({
        kind: 'switch',
        checked: false,
        controlled: expect.objectContaining({ ...extension, value: false })
      })
      const autofill = buildSection(
        PAGE.sections.find((x) => x.id === 'autofill')!,
        context(s, false, { addresses: [], cards: [] }).ctx
      )
      // The same key twice on the Autofill page's first switch: one value, one mark.
      expect(row(autofill, 'autofill-offer-to-save')).toMatchObject({
        checked: false,
        controlled: expect.objectContaining({ ...extension, value: false })
      })
      expect(row(autofill, 'autofill-save-addresses')).toMatchObject({
        checked: false,
        controlled: expect.objectContaining({ ...extension, value: false })
      })
      expect(row(autofill, 'autofill-save-cards')).toMatchObject({
        checked: true,
        controlled: expect.objectContaining({ ...extension, value: true })
      })
      expect(row(autofill, 'autofill-auto-sign-in').controlled).toBeUndefined()
      // Held at the user's own values: marked all the same, the switches where the user left them.
      const same = state(
        {
          platform: 'linux',
          capabilities: { ...ANDROID, windows: true },
          passwords: { ...emptyPasswordsStatus(), locked: false },
          extensionControls: {
            'passwords.offerToSave': { ...extension, value: true },
            'autofill.addresses': { ...extension, value: true },
            'autofill.cards': { ...extension, value: false }
          }
        },
        {
          passwords: { ...DEFAULT_SETTINGS.passwords, offerToSave: true },
          autofill: { ...DEFAULT_SETTINGS.autofill, addresses: true, cards: false }
        }
      )
      expect(row(section('passwords', same), 'passwords-offer-to-save')).toMatchObject({
        checked: true,
        controlled: expect.objectContaining({ ...extension, value: true })
      })
      const sameAutofill = buildSection(
        PAGE.sections.find((x) => x.id === 'autofill')!,
        context(same, false, { addresses: [], cards: [] }).ctx
      )
      expect(row(sameAutofill, 'autofill-save-addresses')).toMatchObject({
        checked: true,
        controlled: expect.objectContaining(extension)
      })
      expect(row(sameAutofill, 'autofill-save-cards')).toMatchObject({
        checked: false,
        controlled: expect.objectContaining(extension)
      })
      // Disable takes the Extensions page's path from any of the four.
      row(sameAutofill, 'autofill-save-cards').controlled!.onDisable()
      expect(invoke).toHaveBeenCalledWith('extension.setEnabled', {
        id: extension.extensionId,
        enabled: false
      })
    })

    it("Preload pages: network.networkPredictionEnabled holds the level row – false is No preloading over the user's Standard, true the user's own level (Standard, or the user's No preloading) – marked either way, the one row its own run", () => {
      const none = section(
        'privacy',
        held({ 'privacy.preloadPages': { ...extension, value: false } })
      )
      const level = row(none, 'preload-pages')
      if (level.kind !== 'value') throw new Error('not a value row')
      expect(level.value).toBe('none')
      expect(level.controlled).toMatchObject({ ...extension, value: false })
      expect(controlledRuns(none.groups.find((g) => g.id === 'preload')!.rows)).toEqual([1])
      // `true` leaves the user's level: Standard for a user at Standard (or Extended, which reads
      // as Standard), No preloading for a user who chose none – marked all the same.
      const standard = section(
        'privacy',
        held({ 'privacy.preloadPages': { ...extension, value: true } })
      )
      expect(row(standard, 'preload-pages')).toMatchObject({
        value: 'standard',
        controlled: expect.objectContaining({ ...extension, value: true })
      })
      const usersNone = section(
        'privacy',
        held({ 'privacy.preloadPages': { ...extension, value: true } }, { preloadPages: 'none' })
      )
      expect(row(usersNone, 'preload-pages')).toMatchObject({
        value: 'none',
        controlled: expect.objectContaining({ ...extension, value: true })
      })
      level.controlled!.onDisable()
      expect(invoke).toHaveBeenCalledWith('extension.setEnabled', {
        id: extension.extensionId,
        enabled: false
      })
    })

    it('nothing held: none of the rows carries a control, and each shows the user’s own value', () => {
      const s = state({
        privacy: PRIVACY_STATUS,
        platform: 'linux',
        passwords: { ...emptyPasswordsStatus(), locked: false }
      })
      const privacy = section('privacy', s)
      for (const id of [
        'safe-browsing-level',
        'signals-dnt',
        'site-data-default',
        'site-data-private-only',
        'preload-pages'
      ])
        expect(row(privacy, id).controlled, id).toBeUndefined()
      expect(row(privacy, 'safe-browsing-level')).toMatchObject({ value: 'standard' })
      expect(row(privacy, 'site-data-default')).toMatchObject({ value: 'block-third-party' })
      expect(row(privacy, 'site-data-private-only')).toMatchObject({ checked: true })
      expect(row(privacy, 'preload-pages')).toMatchObject({ value: 'standard' })
      const search = section('search', s)
      for (const id of ['search-engine', 'search-suggestions'])
        expect(row(search, id).controlled, id).toBeUndefined()
      const passwords = section('passwords', s)
      expect(row(passwords, 'passwords-offer-to-save').controlled).toBeUndefined()
      const autofill = buildSection(
        PAGE.sections.find((x) => x.id === 'autofill')!,
        context(s, false, { addresses: [], cards: [] }).ctx
      )
      for (const id of ['autofill-offer-to-save', 'autofill-save-addresses', 'autofill-save-cards'])
        expect(row(autofill, id).controlled, id).toBeUndefined()
    })

    it('one name each (the one table): every key of the shared `EXTENSION_SETTING_KEYS` has its row, and each row reads exactly that key – a map carrying all eight under those names holds all eight rows, so a key renamed in the table without its row (or a ninth setting without one) fails here', () => {
      const keys = Object.values(EXTENSION_SETTING_KEYS)
      const controls = Object.fromEntries(keys.map((key) => [key, { ...extension, value: false }]))
      // Which row each key holds: the Privacy page's five, the Search page's switch, the
      // Passwords page's switch (the Autofill page repeats it), the Autofill page's two.
      const vault = state(
        {
          privacy: PRIVACY_STATUS,
          platform: 'linux',
          capabilities: { ...ANDROID, windows: true },
          passwords: { ...emptyPasswordsStatus(), locked: false },
          extensionControls: controls
        },
        { autofill: { ...DEFAULT_SETTINGS.autofill, addresses: true, cards: true } }
      )
      const privacy = section('privacy', vault)
      const search = section('search', vault)
      const passwords = section('passwords', vault)
      const autofill = buildSection(
        PAGE.sections.find((x) => x.id === 'autofill')!,
        context(vault, false, { addresses: [], cards: [] }).ctx
      )
      const rows: Record<string, Row> = {
        [EXTENSION_SETTING_KEYS.safeBrowsing]: row(privacy, 'safe-browsing-level'),
        [EXTENSION_SETTING_KEYS.thirdPartyCookies]: row(privacy, 'site-data-default'),
        [EXTENSION_SETTING_KEYS.doNotTrack]: row(privacy, 'signals-dnt'),
        [EXTENSION_SETTING_KEYS.preloadPages]: row(privacy, 'preload-pages'),
        [EXTENSION_SETTING_KEYS.searchSuggestions]: row(search, 'search-suggestions'),
        [EXTENSION_SETTING_KEYS.passwordSaving]: row(passwords, 'passwords-offer-to-save'),
        [EXTENSION_SETTING_KEYS.autofillAddresses]: row(autofill, 'autofill-save-addresses'),
        [EXTENSION_SETTING_KEYS.autofillCards]: row(autofill, 'autofill-save-cards')
      }
      expect(Object.keys(rows).sort()).toEqual([...keys].sort())
      expect(keys).toHaveLength(8)
      for (const [key, r] of Object.entries(rows))
        expect(r.controlled, key).toMatchObject({ ...extension, value: false })
      // Each held at the extension's `false`, over the user's defaults (everything on, cookies
      // blocked for third parties, Standard preloading).
      expect(row(privacy, 'safe-browsing-level')).toMatchObject({ value: 'off' })
      expect(row(privacy, 'site-data-default')).toMatchObject({ value: 'block-third-party' })
      expect(row(privacy, 'signals-dnt')).toMatchObject({ checked: false })
      expect(row(privacy, 'preload-pages')).toMatchObject({ value: 'none' })
      expect(row(search, 'search-suggestions')).toMatchObject({ checked: false })
      expect(row(passwords, 'passwords-offer-to-save')).toMatchObject({ checked: false })
      expect(row(autofill, 'autofill-offer-to-save')).toMatchObject({
        checked: false,
        controlled: expect.objectContaining(extension)
      })
      expect(row(autofill, 'autofill-save-addresses')).toMatchObject({ checked: false })
      expect(row(autofill, 'autofill-save-cards')).toMatchObject({ checked: false })
      // A key under any other name reaches no row.
      const stray = held({
        'privacy.dnt': { ...extension, value: true },
        'privacy.safeBrowsing': { ...extension, value: false },
        'network.networkPredictionEnabled': { ...extension, value: false }
      })
      const strayPrivacy = section('privacy', stray)
      for (const id of ['signals-dnt', 'safe-browsing-level', 'preload-pages'])
        expect(row(strayPrivacy, id).controlled, id).toBeUndefined()
    })
  })

  describe('About (settings-73, shortcuts-menus-164)', () => {
    it('heads the page with the wordmark, the version with its channel, the engine and the copyright line', () => {
      const version = row(section('about'), 'version')
      if (version.kind !== 'custom') throw new Error('not a custom row')
      expect(version.label).toBe('Zenium')
      // A pre-release tag in the version is the Beta channel (as the updater reads it).
      expect(version.description).toBe('Version 0.3.0-test · Beta')
      expect(version.keywords).toEqual(
        expect.arrayContaining(['version', '0.3.0-test', 'channel', 'copyright'])
      )
      expect(version.keywords).toContain('Android System WebView')
      const html = renderToStaticMarkup(createElement(() => version.render()))
      expect(html).toContain('class="zen-settings-about-wordmark">Zenium<')
      expect(html).toContain('Version 0.3.0-test · Beta')
      expect(html).toContain('Running on Chromium via Android System WebView')
      expect(html).toMatch(/© 2026(–\d{4})? Zenium contributors · Apache License 2.0/)

      const stable = row(section('about', state({ version: '0.4.27' })), 'version')
      expect(stable.description).toBe('Version 0.4.27 · Stable')
      const dev = row(
        section(
          'about',
          state({
            version: '0.4.27',
            updates: emptyUpdateStatus('0.4.27', { os: 'linux', arch: 'x64', kind: 'dev' })
          })
        ),
        'version'
      )
      expect(dev.description).toBe('Version 0.4.27 · Development build')
    })

    it('turns the update row into Relaunch to update once an update is downloaded', () => {
      const release = {
        version: '0.3.1',
        tag: 'v0.3.1',
        prerelease: false,
        publishedAt: '2026-03-01T00:00:00Z',
        releaseUrl: 'https://github.com/BenItBuhner/Zenium/releases/tag/v0.3.1',
        notesUrl: 'https://github.com/BenItBuhner/Zenium/releases/tag/v0.3.1',
        asset: null
      }
      const ready = state({
        updates: {
          ...emptyUpdateStatus('0.3.0-test', { os: 'android', arch: 'arm64', kind: 'apk' }),
          phase: 'ready',
          mode: 'in-place',
          release
        }
      })
      const about = section('about', ready)
      expect(findRow(about.groups, 'check-updates')).toBeNull()
      const relaunch = row(about, 'relaunch-to-update')
      if (relaunch.kind !== 'action') throw new Error('not an action')
      expect(relaunch).toMatchObject({
        label: 'Relaunch to update',
        description: '0.3.1 is downloaded and installs when Zenium relaunches.',
        button: 'Relaunch'
      })
      relaunch.onPress?.()
      expect(invoke).toHaveBeenCalledWith('updates.install', undefined)

      // An update found but not yet downloaded keeps the row that leads to the Updates page.
      const available = section(
        'about',
        state({
          updates: {
            ...emptyUpdateStatus('0.3.0-test', { os: 'android', arch: 'arm64', kind: 'apk' }),
            phase: 'available',
            release
          }
        })
      )
      expect(findRow(available.groups, 'relaunch-to-update')).toBeNull()
      expect(row(available, 'check-updates').label).toBe('Update to 0.3.1')
    })

    it('offers Get help, Report an issue and the licences page, where the Help menu goes', () => {
      const about = section('about')
      // The Android rows (Open by default, What's new) and the Legal group (SET-54, SET-55) sit
      // among them on this host; their own test is above.
      expect(allRows(about.groups).map((r) => r.id)).toEqual([
        'version',
        'check-updates',
        'get-help',
        'report-issue',
        'default-browser',
        'open-by-default',
        'whats-new',
        'engine',
        'upstream',
        'licences',
        'privacy-notice',
        'terms'
      ])
      const help = row(about, 'get-help')
      if (help.kind !== 'action') throw new Error('not an action')
      expect(help.leaves).toBe('external')
      help.onPress?.()
      expect(invoke).toHaveBeenCalledWith('app.openExternal', { url: HELP_URL })
      const issue = row(about, 'report-issue')
      if (issue.kind !== 'action') throw new Error('not an action')
      expect(issue.leaves).toBe('external')
      issue.onPress?.()
      expect(invoke).toHaveBeenCalledWith('app.openExternal', { url: ISSUES_URL })
      const licences = row(about, 'licences')
      if (licences.kind !== 'action') throw new Error('not an action')
      expect(licences.label).toBe('Open-source licences')
      expect(licences.leaves).toBe('chevron')
      licences.onPress?.()
      expect(invoke).toHaveBeenCalledWith('page.open', { id: 'licences', section: undefined })
      // The search finds the page under Chrome's name for it too.
      expect(searchRows([about], 'credits').map((h) => h.row.id)).toContain('licences')
    })
  })

  it('a list item opens a sheet of rows about it; a destructive one confirms first', () => {
    const s = state({
      containers: [
        ...DEFAULT_CONTAINERS,
        { id: 'work', name: 'Work', color: 'blue', icon: 'briefcase' }
      ]
    } as Partial<UIState>)
    const containers = section('containers', s)
    const work = row(containers, 'container:work')
    if (work.kind !== 'item') throw new Error('not an item')
    expect(work.sheet.title).toBe('Work')
    const remove = row(containers, 'container:work:delete')
    if (remove.kind !== 'action') throw new Error('not an action')
    expect(remove.destructive).toBe(true)
    expect(remove.confirm?.action).toBe('Delete')
    remove.onPress?.()
    expect(invoke).toHaveBeenCalledWith('container.delete', { id: 'work' })
    // The default container is listed but has nothing to act on.
    const def = row(containers, 'container:default')
    if (def.kind !== 'item') throw new Error('not an item')
    expect(def.sheet.groups.flatMap((g) => g.rows)).toEqual([])
  })

  it('Search lists the engines with their marks, the visited ones under Recently visited, and manages the added ones (OMN-27)', () => {
    const mine = {
      id: 'custom:mine',
      name: 'Mine',
      searchUrl: 'https://mine.example/?q=%s',
      suggestUrl: null,
      keyword: '@mine',
      glyph: 'M',
      source: 'custom' as const,
      favicon: null
    }
    const forum = {
      id: 'discovered:forum.example',
      name: 'Forum',
      searchUrl: 'https://forum.example/search?q=%s',
      suggestUrl: null,
      keyword: '@forum',
      glyph: 'F',
      source: 'discovered' as const,
      favicon: 'https://forum.example/favicon.ico',
      visitedAt: 5
    }
    const s = state(
      { searchEngines: [...DEFAULT_SEARCH_ENGINES, mine, forum] } as Partial<UIState>,
      { searchEngines: [mine, forum], searchEngineId: 'custom:mine' }
    )
    const c = context(s)
    const search = buildSection(
      PAGE.sections.find((x) => x.id === 'search')!,
      c.ctx
    )

    const picker = row(search, 'search-engine')
    if (picker.kind !== 'value') throw new Error('not a value row')
    expect(currentOptionLabel(picker)).toBe('Mine')
    // The shipped engines above any heading; the user's own under "Added" (hand-added) and
    // "Recently visited" (offered by a page), each with the host it searches under its name.
    expect(
      optionGroups(picker.options).map((g) => [g.heading, g.options.map((o) => o.label)])
    ).toEqual([
      [null, DEFAULT_SEARCH_ENGINES.map((e) => e.name)],
      ['Added', ['Mine']],
      ['Recently visited', ['Forum']]
    ])
    expect(picker.options.every((o) => o.leading)).toBe(true)
    expect(picker.options.find((o) => o.value === forum.id)?.description).toBe('forum.example')
    expect(picker.options.find((o) => o.value === mine.id)?.description).toBe('mine.example')
    expect(picker.options.find((o) => o.value === 'google')?.description).toBeUndefined()
    // A host is an address: one line kept from its end (§9.2's exception); an option with no
    // line under it carries no flag.
    expect(picker.options.find((o) => o.value === forum.id)?.address).toBe(true)
    expect(picker.options.find((o) => o.value === 'google')?.address).toBe(false)
    picker.onChange(forum.id)
    expect(c.patches).toEqual([{ searchEngineId: forum.id }])

    // The added engines: the default says so, a visited one names its site, every row carries
    // its shortcut (Chrome's Shortcut column, settings-42); Make default and Remove.
    const mineRow = row(search, 'search-engine:custom:mine')
    if (mineRow.kind !== 'item') throw new Error('not an item')
    expect(mineRow.description).toBe('Default search engine · @mine')
    const forumRow = row(search, 'search-engine:discovered:forum.example')
    if (forumRow.kind !== 'item') throw new Error('not an item')
    expect(forumRow.description).toBe('Recently visited · @forum · forum.example')
    const makeDefault = row(search, 'search-engine:custom:mine:default')
    if (makeDefault.kind !== 'action') throw new Error('not an action')
    expect(makeDefault.disabled).toBe(true)
    const forumDefault = row(search, 'search-engine:discovered:forum.example:default')
    if (forumDefault.kind !== 'action') throw new Error('not an action')
    forumDefault.onPress?.()
    expect(c.patches[1]).toEqual({ searchEngineId: forum.id })
    const remove = row(search, 'search-engine:custom:mine:remove')
    if (remove.kind !== 'action') throw new Error('not an action')
    expect(remove.destructive).toBe(true)
    expect(remove.confirm).toMatchObject({ title: 'Remove Mine?', action: 'Remove' })
    remove.onPress?.()
    expect(invoke).toHaveBeenCalledWith('search.removeEngine', { id: 'custom:mine' })

    // The form to add one; shipped engines are never listed as added.
    const add = row(search, 'add-search-engine')
    if (add.kind !== 'action') throw new Error('not an action')
    expect(add.form?.title).toBe('Add search engine')
    expect(allRows(search.groups).some((r) => r.id === 'search-engine:google')).toBe(false)
    // The chassis form with Add as its verb over every engine of the profile (no `engineId`:
    // the new engine has none); its shortcut goes to the command as the engine's `keyword`
    // (W5-4) – typed, the engine's own; empty, the engine derives one from the name.
    const addForm = add.form!.render(() => {})
    if (!isValidElement<ComponentProps<typeof SearchEngineForm>>(addForm))
      throw new Error('not an element')
    expect(addForm.type).toBe(SearchEngineForm)
    expect(addForm.props).toMatchObject({ action: 'Add', engines: s.searchEngines })
    expect(addForm.props.initial).toBeUndefined()
    expect(addForm.props.engineId).toBeUndefined()
    addForm.props.onSubmit({
      name: 'Wiki',
      url: 'https://wiki.example/w?search=%s',
      shortcut: '@wiki'
    })
    expect(invoke).toHaveBeenCalledWith('search.addEngine', {
      name: 'Wiki',
      url: 'https://wiki.example/w?search=%s',
      keyword: '@wiki'
    })
    addForm.props.onSubmit({ name: 'Wiki', url: 'https://wiki.example/w?search=%s', shortcut: '' })
    expect(invoke).toHaveBeenLastCalledWith('search.addEngine', {
      name: 'Wiki',
      url: 'https://wiki.example/w?search=%s',
      keyword: ''
    })
    // A fresh profile: the group shows its empty state.
    const fresh = section('search')
    const added = fresh.groups.find((g) => g.id === 'search-engines')!
    expect(added.rows).toEqual([])
    expect(groupShows(added)).toBe(true)
    expect(added.empty).toBe('No search engines added yet')
  })

  describe('Mods › the CSS field (services pass 15, ID-43)', () => {
    it('carries the lead’s §9.12 hint about pictures under the field, one line in one place', () => {
      const model = section(
        'mods',
        state({
          mods: [
            { id: 'm1', name: 'Round tabs', source: null, css: '', enabled: true, updatedAt: 1 }
          ]
        })
      )
      const css = row(model, 'mod:m1:css')
      if (css.kind !== 'custom') throw new Error('not a custom row')
      expect(css.label).toBe('CSS')
      const html = renderToStaticMarkup(createElement(() => css.render()))
      expect(html).toContain('aria-label="CSS"')
      // A Mod syncs as its CSS text (#682): a picture stored on this device never travels, so the
      // field says so – the lead's words verbatim, a §9.12 full-width hint under the textarea.
      expect(MOD_PICTURE_HINT).toBe(
        'A picture stored on this device stays on it; other devices need a web address.'
      )
      expect(html).toContain(
        `<span class="zen-settings-description zen-settings-description-full">${MOD_PICTURE_HINT}</span>`
      )
      expect(html.indexOf('</textarea>')).toBeLessThan(html.indexOf(MOD_PICTURE_HINT))
    })
  })

  describe('Search › site search management on every layout (omnibox-09, settings-43, SET-10)', () => {
    const mine = {
      id: 'custom:mine',
      name: 'Mine',
      searchUrl: 'https://mine.example/?q=%s',
      suggestUrl: null,
      keyword: '@mine',
      glyph: 'M',
      source: 'custom' as const,
      favicon: null
    }
    const wiki = {
      id: 'custom:wiki',
      name: 'Wiki',
      searchUrl: 'https://wiki.example/w?search=%s',
      suggestUrl: null,
      keyword: '@wiki',
      glyph: 'W',
      source: 'custom' as const,
      favicon: null
    }
    const forum = {
      id: 'discovered:forum.example',
      name: 'Forum',
      searchUrl: 'https://forum.example/search?q=%s',
      suggestUrl: null,
      keyword: '@forum',
      glyph: 'F',
      source: 'discovered' as const,
      favicon: 'https://forum.example/favicon.ico',
      visitedAt: 5,
      active: false
    }
    const def = PAGE.sections.find((x) => x.id === 'search')!
    const searchOn = (
      layout: FormFactor | undefined
    ): { model: Model; ctx: ReturnType<typeof context> } => {
      const s = state(
        { searchEngines: [...DEFAULT_SEARCH_ENGINES, mine, wiki, forum] } as Partial<UIState>,
        { searchEngines: [mine, wiki, forum], searchEngineId: 'custom:mine' }
      )
      const c = context(s)
      return { model: buildSection(def, { ...c.ctx, formFactor: layout }), ctx: c }
    }
    const ids = (model: Model, group: string): string[] =>
      model.groups.find((g) => g.id === group)?.rows.map((r) => r.id) ?? []
    /** The ids of the rows an engine's sheet offers, in order. */
    const sheetIds = (model: Model, id: string): string[] => {
      const found = row(model, id)
      if (found.kind !== 'item') throw new Error('not an item')
      return found.sheet.groups.flatMap((g) => g.rows.map((r) => r.id))
    }

    it('lists the active engines under Added and the deactivated ones under Inactive, offered by neither the picker nor the keywords row', () => {
      const { model } = searchOn('desktop')
      expect(ids(model, 'search-engines')).toEqual([
        'search-engine:custom:mine',
        'search-engine:custom:wiki'
      ])
      expect(ids(model, 'inactive-search-engines')).toEqual([
        'search-engine:discovered:forum.example'
      ])
      const inactive = model.groups.find((g) => g.id === 'inactive-search-engines')!
      expect(inactive.heading).toBe('Inactive')
      expect(inactive.empty).toBeUndefined()
      // The heading says "Inactive"; the row does not say it again (§9.17) – it keeps its
      // source, its shortcut and its host, as a row under Added does.
      expect(row(model, 'search-engine:discovered:forum.example')).toMatchObject({
        kind: 'item',
        description: 'Recently visited · @forum · forum.example'
      })
      for (const r of inactive.rows) expect(r.description).not.toMatch(/\bInactive\b/)
      // Not the default's candidate: the picker lists the active engines alone …
      const picker = row(model, 'search-engine')
      if (picker.kind !== 'value') throw new Error('not a value row')
      expect(picker.options.map((o) => o.value)).not.toContain(forum.id)
      expect(picker.options.map((o) => o.value)).toContain(wiki.id)
      // … and so does the keywords row.
      const keywords = row(model, 'search-keywords')
      if (keywords.kind !== 'info') throw new Error('not an info row')
      expect(keywords.description).toContain('@wiki')
      expect(keywords.description).not.toContain('@forum')
    })

    it('the Inactive heading is not drawn while no engine is deactivated, on any layout', () => {
      const s = state({ searchEngines: [...DEFAULT_SEARCH_ENGINES, mine] } as Partial<UIState>, {
        searchEngines: [mine],
        searchEngineId: 'custom:mine'
      })
      for (const layout of ['desktop', 'tablet', 'phone'] as const) {
        const model = buildSection(def, { ...context(s).ctx, formFactor: layout })
        expect(model.groups.map((g) => g.id)).toEqual([
          'search',
          'search-engines',
          'add-search-engine'
        ])
      }
    })

    it('"Choose your search engine again" (W6-2) stands in the EEA or over a record, on every layout, and asks the core for the screen', () => {
      const eea = { region: 'DE', eea: true, required: false, seed: 1 }
      const elsewhere = { region: 'US', eea: false, required: false, seed: 1 }
      const record = { engineId: 'duckduckgo', region: 'DE', madeAt: 1, version: 1 }

      // In the EEA the row stands whether or not the choice was made yet.
      const inEea = buildSection(def, {
        ...context(state({ searchChoice: eea })).ctx,
        formFactor: 'desktop'
      })
      const again = row(inEea, 'search-choice-again')
      if (again.kind !== 'action') throw new Error('not an action')
      expect(again).toMatchObject({
        label: 'Choose your search engine again',
        button: 'Choose…'
      })
      // The phone draws the screen too (OMN-26): the row is not kept from any layout.
      expect(again.layouts).toBeUndefined()
      expect(again.description).toMatch(/random order/)
      expect(inEea.groups[0]!.rows.map((r) => r.id)).toEqual(
        expect.arrayContaining(['search-engine', 'search-choice-again'])
      )
      again.onPress?.()
      expect(invoke).toHaveBeenCalledWith('searchChoice.askAgain', undefined)
      expect(findRow(onLayout(inEea.groups, 'phone'), 'search-choice-again')).not.toBeNull()

      // A device that left the EEA keeps the row while its record stands.
      const recorded = buildSection(def, {
        ...context(state({ searchChoice: elsewhere }, { searchChoice: record })).ctx,
        formFactor: 'desktop'
      })
      expect(findRow(recorded.groups, 'search-choice-again')).not.toBeNull()

      // Outside the EEA with no record: no row, and the group is as it was.
      const outside = buildSection(def, {
        ...context(state({ searchChoice: elsewhere })).ctx,
        formFactor: 'desktop'
      })
      expect(findRow(outside.groups, 'search-choice-again')).toBeNull()
      expect(outside.groups.map((g) => g.id)).toEqual([
        'search',
        'search-engines',
        'add-search-engine'
      ])
    })

    it('Edit is a form row over the chassis’s Add / Edit form pre-filled – name, shortcut, URL – saving through search.updateEngine', () => {
      const { model } = searchOn('desktop')
      const edit = row(model, 'search-engine:custom:wiki:edit')
      if (edit.kind !== 'action') throw new Error('not an action')
      expect(edit).toMatchObject({ label: 'Edit', button: 'Edit…' })
      expect(edit.form).toMatchObject({
        title: 'Edit search engine',
        description: 'Put %s in the URL where the search terms go.'
      })
      const form = edit.form!.render(() => {})
      if (!isValidElement<ComponentProps<typeof SearchEngineForm>>(form))
        throw new Error('not an element')
      // #419's one form for Add and Edit: the engine's values as the fields start, Save as the
      // verb, the profile's engines for the shortcut's uniqueness with the engine's own word
      // excepted (`engineId`).
      expect(form.type).toBe(SearchEngineForm)
      expect(form.props).toMatchObject({
        initial: { name: 'Wiki', url: wiki.searchUrl, shortcut: '@wiki' },
        action: 'Save',
        engineId: wiki.id
      })
      expect(form.props.engines).toContain(wiki)
      // The form's `shortcut` is the command's `keyword`, its `url` the engine's `searchUrl`.
      form.props.onSubmit({ name: 'Wiki 2', url: wiki.searchUrl, shortcut: '@w' })
      expect(invoke).toHaveBeenCalledWith('search.updateEngine', {
        id: wiki.id,
        name: 'Wiki 2',
        searchUrl: wiki.searchUrl,
        keyword: '@w'
      })
    })

    it('Deactivate takes an added engine out of the URL bar, is held on the default, and Activate brings an inactive one back', () => {
      const { model } = searchOn('desktop')
      const deactivate = row(model, 'search-engine:custom:wiki:deactivate')
      if (deactivate.kind !== 'action') throw new Error('not an action')
      expect(deactivate.disabled).toBeFalsy()
      expect(deactivate.description).toBe(
        'Keeps Wiki in the list but out of the URL bar until you activate it.'
      )
      deactivate.onPress?.()
      expect(invoke).toHaveBeenCalledWith('search.setEngineActive', {
        id: wiki.id,
        active: false
      })
      // The default engine stays active: its row says so and takes no press.
      const held = row(model, 'search-engine:custom:mine:deactivate')
      if (held.kind !== 'action') throw new Error('not an action')
      expect(held.disabled).toBe(true)
      expect(held.description).toBe('The default search engine stays active.')
      // An inactive engine offers Activate in the place of Deactivate, and no Make default.
      expect(sheetIds(model, 'search-engine:discovered:forum.example')).toEqual([
        'search-engine:discovered:forum.example:edit',
        'search-engine:discovered:forum.example:activate',
        'search-engine:discovered:forum.example:remove'
      ])
      const activate = row(model, 'search-engine:discovered:forum.example:activate')
      if (activate.kind !== 'action') throw new Error('not an action')
      expect(activate.description).toBe('@forum works in the URL bar again.')
      activate.onPress?.()
      expect(invoke).toHaveBeenCalledWith('search.setEngineActive', {
        id: forum.id,
        active: true
      })
      // Make default and Remove stay on an active engine.
      expect(sheetIds(model, 'search-engine:custom:wiki')).toEqual([
        'search-engine:custom:wiki:default',
        'search-engine:custom:wiki:edit',
        'search-engine:custom:wiki:deactivate',
        'search-engine:custom:wiki:remove'
      ])
    })

    it('the phone and tablet shells list a deactivated engine under Inactive as the desktop does, its sheet offering Activate and an active engine’s Deactivate (SET-10)', () => {
      for (const layout of ['phone', 'tablet'] as const) {
        invoke.mockClear()
        const { model } = searchOn(layout)
        // The groups the shell draws: `onLayout` is the filter the phone's page and the
        // tablet's pane apply, so a `layouts: ['desktop']` left on the heading or a row would
        // show here as its absence.
        const drawn = onLayout(model.groups, layout)
        expect(drawn.map((g) => g.id)).toEqual([
          'search',
          'search-engines',
          'inactive-search-engines',
          'add-search-engine'
        ])
        expect(ids({ ...model, groups: drawn }, 'search-engines')).toEqual([
          'search-engine:custom:mine',
          'search-engine:custom:wiki'
        ])
        expect(ids({ ...model, groups: drawn }, 'inactive-search-engines')).toEqual([
          'search-engine:discovered:forum.example'
        ])
        const inactive = drawn.find((g) => g.id === 'inactive-search-engines')!
        expect(inactive.heading).toBe('Inactive')
        expect(inactive.layouts).toBeUndefined()
        // No empty state (§9.17): the group comes with the first engine deactivated and goes
        // with the last activated.
        expect(inactive.empty).toBeUndefined()
        // The heading says "Inactive"; the row does not say it again (§9.17) – it keeps its
        // source, its shortcut and its host, as the desktop's row under the heading does.
        expect(findRow(drawn, 'search-engine:discovered:forum.example')).toMatchObject({
          kind: 'item',
          description: 'Recently visited · @forum · forum.example'
        })
        for (const r of inactive.rows) expect(r.description).not.toMatch(/\bInactive\b/)
        // The inactive engine's sheet – the phone's sheet, the tablet's dialog – offers Edit,
        // Activate and Remove in the desktop's order, and no Make default; an active engine's
        // offers Make default, Edit, Deactivate and Remove.
        const drawnModel = { ...model, groups: drawn }
        expect(sheetIds(drawnModel, 'search-engine:discovered:forum.example')).toEqual([
          'search-engine:discovered:forum.example:edit',
          'search-engine:discovered:forum.example:activate',
          'search-engine:discovered:forum.example:remove'
        ])
        expect(sheetIds(drawnModel, 'search-engine:custom:wiki')).toEqual([
          'search-engine:custom:wiki:default',
          'search-engine:custom:wiki:edit',
          'search-engine:custom:wiki:deactivate',
          'search-engine:custom:wiki:remove'
        ])
        // The rows are the desktop's – the same ids, labels, descriptions and command – kept
        // from no layout.
        const activate = findRow(drawn, 'search-engine:discovered:forum.example:activate')
        if (activate?.kind !== 'action') throw new Error('not an action')
        expect(activate).toMatchObject({
          label: 'Activate',
          description: '@forum works in the URL bar again.'
        })
        expect(activate.layouts).toBeUndefined()
        activate.onPress?.()
        expect(invoke).toHaveBeenCalledWith('search.setEngineActive', {
          id: forum.id,
          active: true
        })
        const deactivate = findRow(drawn, 'search-engine:custom:wiki:deactivate')
        if (deactivate?.kind !== 'action') throw new Error('not an action')
        expect(deactivate).toMatchObject({
          label: 'Deactivate',
          description: 'Keeps Wiki in the list but out of the URL bar until you activate it.'
        })
        expect(deactivate.layouts).toBeUndefined()
        expect(deactivate.disabled).toBeFalsy()
        deactivate.onPress?.()
        expect(invoke).toHaveBeenCalledWith('search.setEngineActive', {
          id: wiki.id,
          active: false
        })
        // The default engine stays active on every layout: its row says so and takes no press.
        const held = findRow(drawn, 'search-engine:custom:mine:deactivate')
        if (held?.kind !== 'action') throw new Error('not an action')
        expect(held.disabled).toBe(true)
        expect(held.description).toBe('The default search engine stays active.')
        // The picker still leaves the deactivated engine out: the flag is the model's, not the
        // layout's.
        const picker = row(model, 'search-engine')
        if (picker.kind !== 'value') throw new Error('not a value row')
        expect(picker.options.map((o) => o.value)).not.toContain(forum.id)
        expect(picker.options.map((o) => o.value)).toContain(wiki.id)
      }
    })

    it('the model is one across the layouts: the phone’s and the tablet’s Search groups are the desktop’s, row for row', () => {
      const desktop = searchOn('desktop').model
      for (const layout of ['phone', 'tablet'] as const) {
        const { model } = searchOn(layout)
        // `formFactor` no longer reaches the section: the same groups, headings, row ids and
        // descriptions come out whatever the layout asked for …
        expect(model.groups.map((g) => [g.id, g.heading, g.layouts])).toEqual(
          desktop.groups.map((g) => [g.id, g.heading, g.layouts])
        )
        for (const id of [
          'search-engine:custom:mine',
          'search-engine:custom:wiki',
          'search-engine:discovered:forum.example'
        ]) {
          expect(sheetIds(model, id)).toEqual(sheetIds(desktop, id))
          expect(row(model, id).description).toBe(row(desktop, id).description)
        }
        // … and the shell's layout filter takes nothing away from the engines' groups.
        expect(onLayout(model.groups, layout).map((g) => g.id)).toEqual(
          model.groups.map((g) => g.id)
        )
      }
    })

    it('on the phone and the tablet, Edit is the desktop’s row – the chassis’s Add / Edit form pre-filled, Save keeping the engine’s id through search.updateEngine (SET-10)', () => {
      for (const layout of ['phone', 'tablet'] as const) {
        invoke.mockClear()
        const { model } = searchOn(layout)
        const edit = row(model, 'search-engine:custom:wiki:edit')
        if (edit.kind !== 'action') throw new Error('not an action')
        expect(edit).toMatchObject({ label: 'Edit', button: 'Edit…' })
        expect(edit.layouts).toBeUndefined()
        expect(edit.form).toMatchObject({
          title: 'Edit search engine',
          description: 'Put %s in the URL where the search terms go.'
        })
        const form = edit.form!.render(() => {})
        if (!isValidElement<ComponentProps<typeof SearchEngineForm>>(form))
          throw new Error('not an element')
        expect(form.type).toBe(SearchEngineForm)
        expect(form.props).toMatchObject({
          initial: { name: 'Wiki', url: wiki.searchUrl, shortcut: '@wiki' },
          action: 'Save',
          engineId: wiki.id
        })
        expect(form.props.engines).toContain(wiki)
        form.props.onSubmit({ name: 'Wiki 2', url: wiki.searchUrl, shortcut: '@w' })
        // The same command as the desktop's, the id the engine's own: the edit is in place, and
        // the default flag – `searchEngineId` – is not the command's to touch.
        expect(invoke).toHaveBeenCalledWith('search.updateEngine', {
          id: wiki.id,
          name: 'Wiki 2',
          searchUrl: wiki.searchUrl,
          keyword: '@w'
        })
        // The default engine's Edit is the same row; the inactive engine's, too.
        expect(row(model, 'search-engine:custom:mine:edit')).toMatchObject({ label: 'Edit' })
        expect(row(model, 'search-engine:discovered:forum.example:edit')).toMatchObject({
          label: 'Edit'
        })
      }
    })

    it('a deactivated engine made the default (the core activates it as it takes the default) leaves the Inactive group and stands under Added as the default, in the picker and the keywords row (A7)', () => {
      // The list as the core writes it back: the flag deleted on the engine the id names.
      const user = withDefaultSearchEngineActive([mine, wiki, forum], forum.id)
      expect('active' in user[2]).toBe(false)
      const s = state({ searchEngines: [...DEFAULT_SEARCH_ENGINES, ...user] } as Partial<UIState>, {
        searchEngines: user,
        searchEngineId: forum.id
      })
      const model = buildSection(def, { ...context(s).ctx, formFactor: 'desktop' })
      expect(model.groups.some((g) => g.id === 'inactive-search-engines')).toBe(false)
      expect(ids(model, 'search-engines')).toEqual([
        'search-engine:custom:mine',
        'search-engine:custom:wiki',
        'search-engine:discovered:forum.example'
      ])
      // The default's row, as any default's: its standing and its shortcut, the host left off.
      expect(row(model, 'search-engine:discovered:forum.example')).toMatchObject({
        kind: 'item',
        description: 'Default search engine · @forum'
      })
      // The default's sheet: Make default held, Deactivate held with its reason – the refusal.
      expect(sheetIds(model, 'search-engine:discovered:forum.example')).toEqual([
        'search-engine:discovered:forum.example:default',
        'search-engine:discovered:forum.example:edit',
        'search-engine:discovered:forum.example:deactivate',
        'search-engine:discovered:forum.example:remove'
      ])
      const held = row(model, 'search-engine:discovered:forum.example:deactivate')
      if (held.kind !== 'action') throw new Error('not an action')
      expect(held.disabled).toBe(true)
      expect(held.description).toBe('The default search engine stays active.')
      const picker = row(model, 'search-engine')
      if (picker.kind !== 'value') throw new Error('not a value row')
      expect(picker.value).toBe(forum.id)
      expect(picker.options.map((o) => o.value)).toContain(forum.id)
      const keywords = row(model, 'search-keywords')
      if (keywords.kind !== 'info') throw new Error('not an info row')
      expect(keywords.description).toContain('@forum')
    })
  })

  it('a per-site zoom is one item with a Remove zoom action that forgets the site', () => {
    const s = state(
      {},
      {
        pageControls: { ...DEFAULT_SETTINGS.pageControls, siteZooms: { 'a.test': 1.25 } }
      }
    )
    const access = section('accessibility', s)
    expect(row(access, 'zoom:a.test')).toMatchObject({
      kind: 'item',
      label: 'a.test',
      description: '125%'
    })
    const forget = row(access, 'zoom:a.test:forget')
    if (forget.kind !== 'action') throw new Error('not an action')
    forget.onPress?.()
    expect(invoke).toHaveBeenCalledWith('pageControls.forgetSite', {
      kind: 'zoom',
      domain: 'a.test'
    })
  })

  it('carries ID-23’s Import rows: the two file imports over `dialog.openText`, busy while theirs runs, and the last import until it is dismissed', async () => {
    // The phone shell's rows (the pane's dialog rows are the mouse layouts', tested below).
    const def = PAGE.sections.find((x) => x.id === 'import')!
    const phoneImport = (s: UIState): Model =>
      buildSection(def, { ...context(s).ctx, formFactor: 'phone' })
    // Android has no other browser's profile to read: the category is the file rows alone,
    // the passwords one behind the host's vault.
    const idle = phoneImport(state({ import: null } as Partial<UIState>))
    expect(idle.groups.map((g) => g.id)).toEqual(['import-files'])
    expect(allRows(idle.groups).map((r) => r.id)).toEqual([
      'import-bookmarks-file',
      'import-passwords-file'
    ])
    expect(idle.groups.every(groupShows)).toBe(true)
    const noVault = state({
      import: null,
      capabilities: { ...ANDROID, passwords: false }
    } as Partial<UIState>)
    expect(allRows(phoneImport(noVault).groups).map((r) => r.id)).toEqual(['import-bookmarks-file'])

    // A press asks the engine for that one kind from the file source; the host's file dialog
    // is the engine's to open.
    const bookmarks = row(idle, 'import-bookmarks-file')
    expect(bookmarks).toMatchObject({
      kind: 'action',
      label: 'Import bookmarks from a file',
      busy: false,
      disabled: false
    })
    if (bookmarks.kind !== 'action') throw new Error('not an action')
    bookmarks.onPress?.()
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('import.run', {
        source: 'file:bookmarks',
        kinds: ['bookmarks']
      })
    )
    const passwords = row(idle, 'import-passwords-file')
    if (passwords.kind !== 'action') throw new Error('not an action')
    passwords.onPress?.()
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('import.run', {
        source: 'file:passwords',
        kinds: ['passwords']
      })
    )

    // While the bookmarks file imports its row is busy (§9.30) and the other row waits.
    const html: ImportSource = {
      id: 'file:bookmarks',
      browser: 'file',
      browserName: 'Bookmarks HTML file',
      profileId: '',
      name: 'Bookmarks HTML file',
      path: '',
      running: false,
      kinds: ['bookmarks'],
      limits: {}
    }
    const running = phoneImport(
      state({
        import: {
          source: html,
          kinds: ['bookmarks'],
          status: 'running',
          current: 'bookmarks',
          results: {},
          error: null,
          folderId: null,
          startedAt: 1,
          finishedAt: null
        }
      } as Partial<UIState>)
    )
    expect(row(running, 'import-bookmarks-file')).toMatchObject({ busy: true, disabled: false })
    expect(row(running, 'import-passwords-file')).toMatchObject({ busy: false, disabled: true })
    expect(running.groups.map((g) => g.id)).toEqual(['import-files'])
    invoke.mockClear()
    const busyRow = row(running, 'import-bookmarks-file')
    if (busyRow.kind !== 'action') throw new Error('not an action')
    busyRow.onPress?.()
    expect(invoke).not.toHaveBeenCalled()

    // The result stays as a group under the rows: the headline in Chrome's words, a row per
    // kind with what came in and what was skipped, Show imported bookmarks for the folder made,
    // Dismiss clearing it.
    const finished = state({
      import: {
        source: html,
        kinds: ['bookmarks'],
        status: 'done',
        current: null,
        results: {
          bookmarks: { imported: 42, duplicates: 3, unreadable: 0, invalid: 1, error: null }
        },
        error: null,
        folderId: 'imported-folder',
        startedAt: 1,
        finishedAt: 2
      }
    } as Partial<UIState>)
    const last = phoneImport(finished)
    expect(last.groups.map((g) => g.id)).toEqual(['import-files', 'import-last'])
    expect(last.groups[1].heading).toBe('Last import')
    expect(last.groups[1].rows.map((r) => r.id)).toEqual([
      'import-last-headline',
      'import-last-bookmarks',
      'import-last-show',
      'import-last-dismiss'
    ])
    const headline = row(last, 'import-last-headline')
    expect(headline).toMatchObject({
      kind: 'info',
      label: 'Your bookmarks and settings are ready',
      description: 'From a bookmarks HTML file'
    })
    // The kind's lines share the row on the one joiner the pane and the desktop use (` · `).
    const bookmarksRow = row(last, 'import-last-bookmarks')
    expect(bookmarksRow).toMatchObject({
      kind: 'info',
      label: 'Bookmarks',
      description: '42 bookmarks imported · 3 already saved, 1 unusable'
    })
    expect(headline).not.toHaveProperty('tone')
    expect(headline).toMatchObject({ danger: false })
    // The outcome is a trailing 16 px glyph in the status ink (the Updates rows' "Verified"),
    // never a leading one: the group's action rows have no leading slot, and §10.4 keeps the
    // labels of one list on one left edge.
    for (const r of [headline, bookmarksRow]) {
      if (r.kind !== 'info') throw new Error('not an info row')
      expect(r.leading).toBeUndefined()
      expect(glyphClass(r.trailing)).toContain('zen-settings-ok')
    }
    expect(row(last, 'import-bookmarks-file')).toMatchObject({ busy: false, disabled: false })
    const show = row(last, 'import-last-show')
    if (show.kind !== 'action') throw new Error('not an action')
    show.onPress?.()
    await vi.waitFor(() => expect(uiStore.get().overlay).toBe('bookmarks'))
    expect(uiStore.get().overlayFolderId).toBe('imported-folder')
    uiStore.set({ overlay: 'none', overlayFolderId: null })
    const dismiss = row(last, 'import-last-dismiss')
    if (dismiss.kind !== 'action') throw new Error('not an action')
    dismiss.onPress?.()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('import.dismiss', undefined))

    // A run-level failure (the picker's bridge call rejected: `ImportService.run`'s outer catch)
    // is the headline row with the failure as its LABEL – so the row's `danger` puts the ink on
    // that sentence and the caption under it stays at 69% (§9.33, one ink per row); never `tone`,
    // which would colour the neutral caption instead. No folder to show.
    const failed = state({
      import: {
        source: html,
        kinds: ['bookmarks'],
        status: 'failed',
        current: null,
        results: {},
        error: 'The file picker could not be opened.',
        folderId: null,
        startedAt: 1,
        finishedAt: 2
      }
    } as Partial<UIState>)
    const failedLast = phoneImport(failed)
    expect(failedLast.groups[1].rows.map((r) => r.id)).toEqual([
      'import-last-headline',
      'import-last-dismiss'
    ])
    const failedHeadline = row(failedLast, 'import-last-headline')
    expect(failedHeadline).toMatchObject({
      kind: 'info',
      label: 'The file picker could not be opened.',
      description: 'From a bookmarks HTML file',
      danger: true
    })
    expect(failedHeadline).not.toHaveProperty('tone')
    if (failedHeadline.kind !== 'info') throw new Error('not an info row')
    // The glyph takes the ink of the text beside it: a failure is danger, not the safety warn.
    expect(glyphClass(failedHeadline.trailing)).toContain('zen-settings-danger')

    // A run whose every kind failed is a failure too (the #259 ruling): the headline names what
    // could not be imported in the danger ink, and the kind's row carries the reason on its
    // description – the status ink on the line that is the status, on each row.
    const noBookmarks = state({
      import: {
        source: html,
        kinds: ['bookmarks'],
        status: 'done',
        current: null,
        results: {
          bookmarks: {
            imported: 0,
            duplicates: 0,
            unreadable: 0,
            invalid: 0,
            error: 'No bookmarks were found in that file.'
          }
        },
        error: null,
        folderId: null,
        startedAt: 1,
        finishedAt: 2
      }
    } as Partial<UIState>)
    const noBookmarksLast = phoneImport(noBookmarks)
    expect(noBookmarksLast.groups[1].rows.map((r) => r.id)).toEqual([
      'import-last-headline',
      'import-last-bookmarks',
      'import-last-dismiss'
    ])
    const noBookmarksHeadline = row(noBookmarksLast, 'import-last-headline')
    expect(noBookmarksHeadline).toMatchObject({
      label: 'Bookmarks could not be imported.',
      description: 'From a bookmarks HTML file',
      danger: true
    })
    if (noBookmarksHeadline.kind !== 'info') throw new Error('not an info row')
    expect(glyphClass(noBookmarksHeadline.trailing)).toContain('zen-settings-danger')
    const noBookmarksRow = row(noBookmarksLast, 'import-last-bookmarks')
    expect(noBookmarksRow).toMatchObject({
      label: 'Bookmarks',
      description: 'No bookmarks were found in that file.',
      tone: 'danger'
    })
    expect(noBookmarksRow).not.toHaveProperty('danger')
    if (noBookmarksRow.kind !== 'info') throw new Error('not an info row')
    expect(glyphClass(noBookmarksRow.trailing)).toContain('zen-settings-danger')

    // A file pick the user dismissed leaves a cancelled run with nothing reported: no group.
    const dismissedPick = state({
      import: {
        source: html,
        kinds: ['bookmarks'],
        status: 'cancelled',
        current: null,
        results: {},
        error: null,
        folderId: null,
        startedAt: 1,
        finishedAt: 2
      }
    } as Partial<UIState>)
    expect(phoneImport(dismissedPick).groups.map((g) => g.id)).toEqual(['import-files'])

    // The category's search words reach it from the landing.
    const s = state({ import: null } as Partial<UIState>)
    const hits = searchRows(phoneSections(s), 'csv').map((h) => h.row.id)
    expect(hits).toContain('import-passwords-file')
  })

  it('on a mouse the Import category is the pane that leads to the dialog: the browsers found, two button rows, and the last import as one row (#259’s lead verdict)', async () => {
    const def = PAGE.sections.find((x) => x.id === 'import')!
    const mouse = (
      s: UIState,
      importSources?: ImportSource[] | null,
      layout: 'desktop' | 'tablet' = 'desktop'
    ): Model => buildSection(def, { ...context(s).ctx, formFactor: layout, importSources })
    const chrome: ImportSource = {
      id: 'chrome:Default',
      browser: 'chrome',
      browserName: 'Google Chrome',
      profileId: 'Default',
      name: 'Person 1',
      path: '',
      running: false,
      kinds: ['bookmarks', 'history', 'passwords'],
      limits: {}
    }
    const firefox: ImportSource = {
      ...chrome,
      id: 'firefox:a.default',
      browser: 'firefox',
      browserName: 'Firefox',
      profileId: 'a.default',
      name: 'default'
    }
    const html: ImportSource = {
      id: 'file:bookmarks',
      browser: 'file',
      browserName: 'Bookmarks HTML file',
      profileId: '',
      name: 'Bookmarks HTML file',
      path: '',
      running: false,
      kinds: ['bookmarks'],
      limits: {}
    }
    const none = state({ import: null } as Partial<UIState>)

    // Two groups, one button row each (§10.5: a command row trails its button); none of the
    // phone's whole-row file rows. The tablet is the same pane.
    const idle = mouse(none)
    expect(idle.groups.map((g) => g.id)).toEqual(['import-browsers', 'import-file'])
    expect(allRows(idle.groups).map((r) => r.id)).toEqual(['import-browser', 'import-file-dialog'])
    expect(allRows(mouse(none, undefined, 'tablet').groups).map((r) => r.id)).toEqual([
      'import-browser',
      'import-file-dialog'
    ])
    expect(row(idle, 'import-browser')).toMatchObject({
      kind: 'action',
      label: 'Bookmarks, history and passwords',
      description: 'From Google Chrome, Chromium, Microsoft Edge, Firefox or Safari',
      button: 'Import…'
    })
    expect(row(idle, 'import-file-dialog')).toMatchObject({
      kind: 'action',
      label: 'Bookmarks HTML or passwords CSV',
      button: 'Import file…'
    })
    expect(idle.groups[1].heading).toBe('Import from a file')

    // The first group's line under its heading: looking while the engine's answer is out (or
    // where nothing asked, the landing's search), the browsers by name, or none – the file
    // sources are not browsers.
    expect(idle.groups[0].description).toBe('Looking for other browsers on this computer…')
    expect(mouse(none, null).groups[0].description).toBe(
      'Looking for other browsers on this computer…'
    )
    expect(mouse(none, [html]).groups[0].description).toBe(
      'No other browsers were found on this computer.'
    )
    expect(mouse(none, [chrome, firefox, html]).groups[0].description).toBe(
      'Found on this computer: Google Chrome and Firefox.'
    )

    // The buttons open the dialog over the Settings tab – the file row on the file sources.
    const browser = row(idle, 'import-browser')
    if (browser.kind !== 'action') throw new Error('not an action')
    browser.onPress?.()
    await vi.waitFor(() => expect(uiStore.get().importDialog).toEqual({ source: null }))
    uiStore.set({ importDialog: null })
    const file = row(idle, 'import-file-dialog')
    if (file.kind !== 'action') throw new Error('not an action')
    file.onPress?.()
    await vi.waitFor(() => expect(uiStore.get().importDialog).toEqual({ source: 'file:bookmarks' }))
    uiStore.set({ importDialog: null })

    // The last import is one row on the pane: the headline, then the source and the counts on
    // one line; its glyph and Dismiss trail (the lead's nit: leading, it indented the pane's
    // one such label 26 px past its neighbours). The phone's headline, kind and action rows
    // stay off the pane.
    const finished = state({
      import: {
        source: chrome,
        kinds: ['bookmarks', 'passwords'],
        status: 'done',
        current: null,
        results: {
          bookmarks: { imported: 42, duplicates: 3, unreadable: 0, invalid: 1, error: null },
          passwords: { imported: 7, duplicates: 0, unreadable: 0, invalid: 0, error: null }
        },
        error: null,
        folderId: 'imported-folder',
        startedAt: 1,
        finishedAt: 2
      }
    } as Partial<UIState>)
    const last = mouse(finished, [chrome])
    expect(last.groups.map((g) => g.id)).toEqual(['import-browsers', 'import-file', 'import-last'])
    expect(last.groups[2].heading).toBe('Last import')
    expect(last.groups[2].rows.map((r) => r.id)).toEqual(['import-last-summary'])
    const summary = row(last, 'import-last-summary')
    expect(summary).toMatchObject({
      kind: 'info',
      label: 'Your bookmarks and settings are ready',
      description: 'From Google Chrome (Person 1) · 42 bookmarks imported · 7 passwords imported',
      danger: false,
      clamp: true
    })
    if (summary.kind !== 'info') throw new Error('not an info row')
    expect(summary.leading).toBeUndefined()
    expect(isValidElement(summary.trailing)).toBe(true)

    // A failed run: the failure is the label in the danger ink, the source alone under it.
    const failed = mouse(
      state({
        import: {
          source: chrome,
          kinds: ['bookmarks'],
          status: 'failed',
          current: null,
          results: {},
          error: 'Google Chrome is open. Close Google Chrome and try again.',
          folderId: null,
          startedAt: 1,
          finishedAt: 2
        }
      } as Partial<UIState>),
      [chrome]
    )
    expect(row(failed, 'import-last-summary')).toMatchObject({
      label: 'Google Chrome is open. Close Google Chrome and try again.',
      description: 'From Google Chrome (Person 1)',
      danger: true
    })
    expect(row(failed, 'import-last-summary')).not.toHaveProperty('tone')
  })

  it('carries #62’s Security rows: each remembered site answer an item that forgets it, Forget all once there are two, the session’s sign-ins', () => {
    // Ungated, as the desktop pane is; empty until a site has been answered.
    const empty = section('security')
    expect(empty.groups.map((g) => g.id)).toEqual([
      'security-permissions',
      'security-notifications',
      'security-session'
    ])
    expect(empty.groups[0].rows).toEqual([])
    expect(empty.groups[0].empty).toBe('No site permissions remembered yet')
    expect(empty.groups.every(groupShows)).toBe(true)

    const s = state({
      permissionRules: [
        { origin: 'https://zoom.example', permission: 'openExternal:zoommtg', decision: 'allow' },
        { origin: 'https://news.example', permission: 'popups', decision: 'allow' },
        { origin: 'https://news.example', permission: 'camera', decision: 'deny' }
      ]
    } as Partial<UIState>)
    const security = section('security', s)
    // Sorted by site, then by what was asked; the description is the answer in sentence case.
    expect(security.groups[0].rows.map((r) => r.id)).toEqual([
      'security-rule:https://news.example:camera',
      'security-rule:https://news.example:popups',
      'security-rule:https://zoom.example:openExternal:zoommtg',
      'security-forget-all'
    ])
    expect(row(security, 'security-rule:https://news.example:popups')).toMatchObject({
      kind: 'item',
      label: 'news.example',
      description: 'May open pop-up windows'
    })
    expect(row(security, 'security-rule:https://news.example:camera').description).toBe(
      'May not use the camera'
    )
    expect(
      row(security, 'security-rule:https://zoom.example:openExternal:zoommtg').description
    ).toBe('May hand zoommtg: links to another app')
    const forget = row(security, 'security-rule:https://news.example:popups:forget')
    if (forget.kind !== 'action') throw new Error('not an action')
    forget.onPress?.()
    expect(invoke).toHaveBeenCalledWith('permissions.forget', {
      origin: 'https://news.example',
      permission: 'popups'
    })
    const all = row(security, 'security-forget-all')
    if (all.kind !== 'action') throw new Error('not an action')
    expect(all.destructive).toBe(true)
    expect(all.confirm?.action).toBe('Forget all')
    all.onPress?.()
    expect(invoke).toHaveBeenCalledWith('permissions.reset', undefined)
    // One rule is forgotten from its own sheet; Forget all waits for a second.
    const one = section('security', state({ permissionRules: [s.permissionRules[0]] }))
    expect(findRow(one.groups, 'security-forget-all')).toBeNull()

    const session = row(security, 'security-forget-session')
    if (session.kind !== 'action') throw new Error('not an action')
    expect(session.label).toBe('Forget sign-ins and certificates')
    session.onPress?.()
    expect(invoke).toHaveBeenCalledWith('security.forgetSession', undefined)
    // The landing's search reaches them by what the rows are about.
    expect(searchRows([security], 'pop-ups').map((h) => h.row.id)).toContain(
      'security-rule:https://news.example:popups'
    )
    expect(searchRows([security], 'certificate').map((h) => h.row.id)).toContain(
      'security-forget-session'
    )
    // The Privacy category no longer lists them: they moved here.
    expect(findRow(section('privacy', s).groups, 'permissions-reset')).toBeNull()
  })

  it('carries SET-26’s Notifications row on the phone: one action leaving for the system’s notification settings', () => {
    const security = section('security')
    const group = security.groups.find((g) => g.id === 'security-notifications')
    expect(group).toMatchObject({ heading: 'Notifications', layouts: ['phone'] })
    const settings = row(security, 'notification-settings')
    if (settings.kind !== 'action') throw new Error('not an action')
    expect(settings).toMatchObject({ label: 'Notification settings', leaves: 'external' })
    expect(settings.layouts).toBeUndefined()
    settings.onPress?.()
    expect(invoke).toHaveBeenCalledWith('app.openNotificationSettings', undefined)
    // The tablet and the desktop keep their notifications where the OS puts them: no row.
    for (const layout of ['tablet', 'desktop'] as const) {
      expect(onLayout(security.groups, layout).map((g) => g.id)).toEqual([
        'security-permissions',
        'security-session'
      ])
    }
    expect(onLayout(security.groups, 'phone').map((g) => g.id)).toContain('security-notifications')
    // The landing's search reaches it by what the row is about.
    expect(searchRows([security], 'notifications').map((h) => h.row.id)).toContain(
      'notification-settings'
    )
  })

  it('the request engine’s rows run the blocking commands or patch `blocking`, and follow the master switch', () => {
    const c = context(blockingState())
    const privacy = buildSection(
      PAGE.sections.find((x) => x.id === 'privacy')!,
      c.ctx
    )
    // The master switch and the exceptions are decisions of the `ads` permission: commands.
    const master = row(privacy, 'tracking-enabled')
    if (master.kind !== 'switch') throw new Error('not a switch')
    master.onChange(false)
    expect(invoke).toHaveBeenCalledWith('blocking.setEnabled', { enabled: false })
    const current = row(privacy, 'tracking-site-current')
    if (current.kind !== 'switch') throw new Error('not a switch')
    expect(current.label).toBe('Block on news.example')
    // The site the tab came from is excepted, so the switch is off; on again lifts the exception.
    expect(current.checked).toBe(false)
    current.onChange(true)
    expect(invoke).toHaveBeenCalledWith('blocking.setSiteException', {
      site: 'https://news.example',
      excepted: false
    })
    const again = row(privacy, 'tracking-site:https://news.example:block')
    if (again.kind !== 'action') throw new Error('not an action')
    again.onPress?.()
    expect(invoke).toHaveBeenLastCalledWith('blocking.setSiteException', {
      site: 'https://news.example',
      excepted: false
    })
    const update = row(privacy, 'tracking-update-now')
    if (update.kind !== 'action') throw new Error('not an action')
    update.onPress?.()
    expect(invoke).toHaveBeenLastCalledWith('blocking.updateLists', {})
    const updateOne = row(privacy, 'tracking-list:easylist:update')
    if (updateOne.kind !== 'action') throw new Error('not an action')
    updateOne.onPress?.()
    expect(invoke).toHaveBeenLastCalledWith('blocking.updateLists', { id: 'easylist' })

    // The rest patches `settings.blocking`, keeping the rest of it.
    const level = row(privacy, 'tracking-level')
    if (level.kind !== 'value') throw new Error('not a value row')
    level.onChange('strict')
    const base = c.ctx.state.settings.blocking
    expect(c.patches[0]).toEqual({ blocking: { ...base, level: 'strict' } })
    const auto = row(privacy, 'tracking-auto-update')
    if (auto.kind !== 'switch') throw new Error('not a switch')
    auto.onChange(false)
    expect(c.patches[1]).toEqual({ blocking: { ...base, autoUpdate: false } })
    const useList = row(privacy, 'tracking-list:easylist:enabled')
    if (useList.kind !== 'switch') throw new Error('not a switch')
    useList.onChange(false)
    expect(c.patches[2]).toMatchObject({ blocking: { lists: { easylist: false } } })
    const useCustom = row(privacy, `tracking-list:${CUSTOM.id}:enabled`)
    if (useCustom.kind !== 'switch') throw new Error('not a switch')
    useCustom.onChange(false)
    expect(c.patches[3]).toMatchObject({
      blocking: { customLists: [{ ...CUSTOM, enabled: false }] }
    })
    const remove = row(privacy, `tracking-list:${CUSTOM.id}:remove`)
    if (remove.kind !== 'action') throw new Error('not an action')
    remove.onPress?.()
    expect(c.patches[4]).toMatchObject({ blocking: { customLists: [] } })
    expect(c.patches).toHaveLength(5)

    // With the master switch off the dependent rows stay laid out at 40% and take no press.
    const off = section(
      'privacy',
      blockingState({ blocking: { ...emptyBlockingStatus(), enabled: false } })
    )
    for (const id of [
      'tracking-level',
      'tracking-auto-update',
      'tracking-update-now',
      'tracking-add-list',
      'tracking-add-site'
    ])
      expect(row(off, id).disabled, id).toBe(true)
    expect(row(off, 'tracking-enabled').disabled).toBeUndefined()
    // The counter reads the core's state; before the engine is ready it says so instead.
    expect(row(off, 'tracking-blocked').description).toBe('Filter lists are loading')
  })

  it('PS-49: “Always use Strict in private windows” (private tabs on Android) follows the Level row as its dependent on every layout', () => {
    const def = PAGE.sections.find((x) => x.id === 'privacy')!
    const withLevel = (
      level: TrackingLevel,
      levelPrivate: TrackingLevelPrivateMode = 'default',
      enabled = true,
      host: Partial<UIState> = {}
    ): UIState =>
      state(
        { blocking: { ...emptyBlockingStatus(), ready: true, enabled }, ...host },
        { blocking: { ...DEFAULT_BLOCKING_SETTINGS, level, levelPrivate } }
      )
    // Directly after the Level row in the Tracking prevention group, by name, on the three
    // layouts. The noun follows the host through the same `capabilities.windows` read the cookies
    // twin uses: windows on the desktop; tabs on Android – the phone and the tablet alike, since
    // `src/android/platform.ts` sets `windows: false` for all of Android. Both pairs verbatim.
    const WINDOWS = {
      label: 'Always use Strict in private windows',
      description: 'Whatever the level above, private windows block at Strict.',
      keywords: ['private windows', 'strict', 'tracking prevention level'],
      twin: 'Only in private windows'
    }
    const TABS = {
      label: 'Always use Strict in private tabs',
      description: 'Whatever the level above, private tabs block at Strict.',
      keywords: ['private tabs', 'strict', 'tracking prevention level'],
      twin: 'Only in private tabs'
    }
    const desktop: Partial<UIState> = {
      platform: 'linux',
      capabilities: { ...ANDROID, windows: true }
    }
    const chassis = [
      { name: 'desktop', formFactor: 'desktop', host: desktop, words: WINDOWS },
      { name: 'tablet', formFactor: 'tablet', host: {}, words: TABS },
      { name: 'phone', formFactor: 'phone', host: {}, words: TABS }
    ] as const
    for (const { name, formFactor, host, words } of chassis) {
      const privacy = buildSection(def, {
        ...context(withLevel('balanced', 'default', true, host)).ctx,
        formFactor
      })
      const ids = privacy.groups.find((g) => g.id === 'tracking-prevention')!.rows.map((r) => r.id)
      expect(ids.indexOf('tracking-level-private'), name).toBe(ids.indexOf('tracking-level') + 1)
      expect(row(privacy, 'tracking-level-private'), name).toMatchObject({
        kind: 'switch',
        label: words.label,
        description: words.description,
        keywords: words.keywords,
        checked: false,
        disabled: false
      })
      // The cookies twin on the same chassis speaks the same noun.
      expect(row(privacy, 'site-data-private-only').label, name).toBe(words.twin)
    }
    // Moot – at .4, still laid out and read – while blocking is off or the level above is already
    // Strict; live at every other level, Off included (private windows then block at Strict alone).
    const off = section('privacy', withLevel('balanced', 'strict', false))
    expect(row(off, 'tracking-level-private')).toMatchObject({ checked: true, disabled: true })
    const strict = section('privacy', withLevel('strict'))
    expect(row(strict, 'tracking-level-private')).toMatchObject({ checked: false, disabled: true })
    for (const level of ['off', 'basic', 'balanced'] as const)
      expect(
        row(section('privacy', withLevel(level)), 'tracking-level-private').disabled,
        level
      ).toBe(false)
    // The switch patches `settings.blocking.levelPrivate`, keeping the rest of `blocking`.
    const c = context(withLevel('balanced'))
    const live = row(buildSection(def, c.ctx), 'tracking-level-private')
    if (live.kind !== 'switch') throw new Error('not a switch')
    live.onChange(true)
    expect(c.patches).toEqual([
      { blocking: { ...c.ctx.state.settings.blocking, levelPrivate: 'strict' } }
    ])
    const on = context(withLevel('balanced', 'strict'))
    const onRow = row(buildSection(def, on.ctx), 'tracking-level-private')
    if (onRow.kind !== 'switch') throw new Error('not a switch')
    expect(onRow.checked).toBe(true)
    onRow.onChange(false)
    expect(on.patches).toEqual([
      { blocking: { ...on.ctx.state.settings.blocking, levelPrivate: 'default' } }
    ])
  })

  it('Boosts offers the site the tab came from, and leaves for it', () => {
    const c = context()
    const boosts = buildSection(
      PAGE.sections.find((x) => x.id === 'boosts')!,
      c.ctx
    )
    const current = row(boosts, 'boost-current')
    if (current.kind !== 'action') throw new Error('not an action')
    current.onPress?.()
    expect(c.boosted).toEqual(['site'])
  })
})

// ---------------------------------------------------------------------------
// Extensions (wave 4 UI)
// ---------------------------------------------------------------------------

const EXT_ID = 'a'.repeat(32)
const NOW = 1_800_000_000_000

/** An installed extension as the host reports it; `over` is what a case is about. */
function ext(over: Partial<ExtensionInfo>): ExtensionInfo {
  return {
    id: EXT_ID,
    name: 'Dark Reader',
    version: '4.9.132',
    description: 'Dark mode for every website',
    path: '/data/extensions/dark-reader',
    enabled: true,
    icon: 'data:image/png;base64,AAAA',
    popup: 'popup.html',
    error: null,
    source: 'chrome-web-store',
    publisher: 'chrome-web-store',
    updateUrl: 'https://clients2.google.com/service/update2/crx',
    installedAt: NOW - 30 * 24 * 60 * 60 * 1000,
    updatedAt: NOW - 30 * 24 * 60 * 60 * 1000,
    pinned: false,
    toolbarPinned: false,
    allowFileAccess: false,
    allowPrivate: false,
    allowUserScripts: false,
    manifestVersion: 3,
    permissions: ['storage', 'tabs'],
    hostPermissions: ['<all_urls>'],
    optionsPage: 'options.html',
    newTabPage: null,
    newTabOverride: false,
    warnings: ['Read and change all your data on all websites', 'Read your browsing history'],
    pendingWarnings: null,
    updateState: 'up-to-date',
    availableVersion: null,
    updateError: null,
    updateCheckedAt: null,
    errors: [],
    ...over
  }
}

function entry(over: Partial<ExtensionErrorEntry>): ExtensionErrorEntry {
  return {
    id: 1,
    level: 'error',
    source: 'worker',
    message: 'Uncaught TypeError: Cannot read properties of undefined',
    url: `chrome-extension://${EXT_ID}/background.js`,
    line: 12,
    context: null,
    at: NOW - 10 * 60 * 1000,
    lastAt: NOW - 10 * 60 * 1000,
    count: 1,
    ...over
  }
}

/** The host with extensions on, as the Android runtime and the desktop report it. */
function extState(
  extensions: ExtensionInfo[],
  patch: Partial<UIState> = {},
  capabilities: Partial<HostCapabilities> = {}
): UIState {
  return state({
    extensions,
    extensionUpdates: { lastCheckedAt: null, checking: false },
    capabilities: { ...ANDROID, extensions: true, ...capabilities },
    ...patch
  })
}

/** The lines of the console the details sheet surfaces: one repeated worker error, a warning, a load failure. */
const CONSOLE: ExtensionErrorEntry[] = [
  entry({ id: 1, at: NOW - 60 * 60 * 1000, lastAt: NOW - 60 * 60 * 1000 }),
  entry({
    id: 2,
    level: 'warning',
    source: 'content',
    message: 'Deprecated API',
    url: 'https://news.example/app.js',
    line: null,
    context: 'https://news.example/',
    at: NOW - 30 * 60 * 1000,
    lastAt: NOW - 5 * 60 * 1000,
    count: 3
  }),
  entry({
    id: 3,
    source: 'load',
    message: 'Manifest file is missing or unreadable',
    url: null,
    line: null,
    at: NOW - 60 * 1000,
    lastAt: NOW - 60 * 1000
  })
]

function sheetOf(r: Row): RowGroup[] {
  if (r.kind !== 'item' && r.kind !== 'detail') throw new Error(`${r.id} opens no sheet`)
  return r.sheet.groups
}

describe('the Extensions category', () => {
  beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(NOW))
  afterEach(() => vi.restoreAllMocks())

  it('with nothing installed: the empty line, the three ways in, the update check disabled', () => {
    const model = section('extensions', extState([]))
    expect(model.groups.map((g) => g.id)).toEqual([
      'extensions',
      'install-extension',
      'extension-updates'
    ])
    const [list, install] = model.groups
    // The group is "Installed" under the bar's "Extensions", not the title again.
    expect(list!.heading).toBe('Installed')
    expect(list!.rows).toEqual([])
    expect(list!.empty).toBe('No extensions yet')
    expect(list!.aside).toBeUndefined()
    expect(install!.rows.map((r) => r.id)).toEqual([
      'install-from-store',
      'install-from-file',
      'load-unpacked'
    ])
    const check = row(model, 'extensions-check-updates')
    expect(check).toMatchObject({ kind: 'action', disabled: true, description: 'Not checked yet' })
    // The store form is a sheet; the two file rows run the hosts' pickers.
    expect(row(model, 'install-from-store')).toMatchObject({ kind: 'action' })
    if (row(model, 'install-from-store').kind === 'action') {
      expect((row(model, 'install-from-store') as { form?: unknown }).form).toBeDefined()
    }
    const file = row(model, 'install-from-file')
    if (file.kind !== 'action') throw new Error('not an action')
    file.onPress?.()
    expect(invoke).toHaveBeenCalledWith('extension.installFromFile', undefined)
    const unpacked = row(model, 'load-unpacked')
    if (unpacked.kind !== 'action') throw new Error('not an action')
    unpacked.onPress?.()
    expect(invoke).toHaveBeenCalledWith('extension.add', undefined)
  })

  it('one extension: an item row with its icon, name and line, opening the details sheet', () => {
    const model = section('extensions', extState([ext({})]))
    const list = model.groups[0]!
    expect(list.aside).toBe('1')
    const item = row(model, `extension:${EXT_ID}`)
    expect(item).toMatchObject({
      kind: 'item',
      label: 'Dark Reader',
      description: 'Dark mode for every website'
    })
    expect(item.tone).toBeUndefined()
    if (item.kind !== 'item') throw new Error('not an item')
    expect(item.leading).toBeDefined()
    expect(item.keywords).toEqual(expect.arrayContaining([EXT_ID, '4.9.132']))
    // The details sheet: the name as its title block, the line as the description (§9.23).
    expect(item.sheet.title).toBe('Dark Reader')
    expect(item.sheet.description).toBe('Dark mode for every website')
    expect(item.sheet.descriptionTone).toBeUndefined()
    const groups = sheetOf(item)
    expect(groups.map((g) => g.heading)).toEqual([null, 'Access', 'Source', null])
    // Controls: Enabled, Options (the manifest has a page), Errors; no toolbar on a phone.
    expect(groups[0]!.rows.map((r) => [r.id, r.kind])).toEqual([
      [`extension:${EXT_ID}:enabled`, 'switch'],
      [`extension:${EXT_ID}:options`, 'action'],
      [`extension:${EXT_ID}:errors`, 'detail']
    ])
    expect(row(model, `extension:${EXT_ID}:options`)).toMatchObject({ leaves: 'chevron' })
    // Permissions: the detail row then the switches; no user scripts without the permission.
    expect(groups[1]!.rows.map((r) => [r.id, r.kind])).toEqual([
      [`extension:${EXT_ID}:permissions`, 'detail'],
      [`extension:${EXT_ID}:file-access`, 'switch'],
      [`extension:${EXT_ID}:private`, 'switch']
    ])
    expect(row(model, `extension:${EXT_ID}:private`).label).toBe('Allow in private tabs')
    // Source: the store as an external link, then the facts; no Updated (never updated), no MV2 note.
    expect(groups[2]!.rows.map((r) => [r.id, r.kind])).toEqual([
      [`extension:${EXT_ID}:source`, 'action'],
      [`extension:${EXT_ID}:id`, 'info'],
      [`extension:${EXT_ID}:version`, 'info'],
      [`extension:${EXT_ID}:installed`, 'info']
    ])
    expect(row(model, `extension:${EXT_ID}:source`)).toMatchObject({
      description: 'Chrome Web Store',
      leaves: 'external'
    })
    expect(row(model, `extension:${EXT_ID}:id`).description).toBe(EXT_ID)
    expect(row(model, `extension:${EXT_ID}:version`).description).toBe('4.9.132')
    // Remove, destructive, with its confirm sheet (depth two from the details sheet).
    const remove = row(model, `extension:${EXT_ID}:remove`)
    expect(remove).toMatchObject({ kind: 'action', destructive: true })
    if (remove.kind !== 'action') throw new Error('not an action')
    expect(remove.confirm).toMatchObject({ title: 'Remove Dark Reader?', action: 'Remove' })
  })

  it('the Permissions detail row counts the warning lines and the sites, and lists both', () => {
    const model = section('extensions', extState([ext({})]))
    const permissions = row(model, `extension:${EXT_ID}:permissions`)
    expect(permissions).toMatchObject({ kind: 'detail', summary: '3 permissions' })
    const [lines, sites] = sheetOf(permissions)
    expect(lines!.rows.map((r) => r.label)).toEqual([
      'Read and change all your data on all websites',
      'Read your browsing history'
    ])
    expect(lines!.rows.every((r) => r.kind === 'info' && r.leading)).toBe(true)
    expect(sites!.heading).toBe('Site access')
    expect(sites!.rows.map((r) => r.label)).toEqual(['All sites'])

    // Distinct hosts, one line each; none at all reads as none.
    const scoped = section(
      'extensions',
      extState([
        ext({
          warnings: [],
          hostPermissions: [
            'https://*.example.com/*',
            'https://news.example/*',
            '*://*.example.com/*'
          ]
        })
      ])
    )
    const detail = row(scoped, `extension:${EXT_ID}:permissions`)
    expect(detail).toMatchObject({ summary: '2 permissions' })
    const [noLines, hosts] = sheetOf(detail)
    expect(noLines!.rows).toEqual([])
    expect(noLines!.empty).toBe('This extension requires no special permissions')
    expect(hosts!.rows.map((r) => r.label).sort()).toEqual(['*.example.com', 'news.example'])
    const bare = section('extensions', extState([ext({ warnings: [], hostPermissions: [] })]))
    expect(row(bare, `extension:${EXT_ID}:permissions`)).toMatchObject({ summary: 'None' })
  })

  it('several extensions sort by name; the line is the error, else Off, else the description', () => {
    const broken = ext({
      id: 'b'.repeat(32),
      name: 'Broken',
      error: 'Manifest file is missing or unreadable',
      source: 'unpacked',
      publisher: null,
      updateUrl: null
    })
    const off = ext({ id: 'c'.repeat(32), name: 'Adblock', enabled: false })
    const noisy = ext({ id: 'd'.repeat(32), name: 'Noisy', errors: CONSOLE })
    const model = section('extensions', extState([noisy, broken, ext({}), off]))
    const list = model.groups[0]!
    expect(list.aside).toBe('4')
    expect(list.rows.map((r) => r.label)).toEqual(['Adblock', 'Broken', 'Dark Reader', 'Noisy'])
    expect(row(model, `extension:${off.id}`)).toMatchObject({ description: 'Off' })
    expect(row(model, `extension:${off.id}`).tone).toBeUndefined()
    expect(row(model, `extension:${broken.id}`)).toMatchObject({
      description: 'Manifest file is missing or unreadable',
      tone: 'danger'
    })
    // The details sheet repeats the error where the line would be; its controls that need a
    // loaded extension are disabled; an unpacked extension reloads and has no store link.
    const brokenItem = row(model, `extension:${broken.id}`)
    if (brokenItem.kind !== 'item') throw new Error('not an item')
    expect(brokenItem.sheet.description).toBe('Manifest file is missing or unreadable')
    expect(brokenItem.sheet.descriptionTone).toBe('danger')
    expect(row(model, `extension:${broken.id}:file-access`).disabled).toBe(true)
    expect(row(model, `extension:${broken.id}:options`).disabled).toBe(true)
    expect(row(model, `extension:${broken.id}:reload`)).toMatchObject({ kind: 'action' })
    expect(row(model, `extension:${broken.id}:source`)).toMatchObject({
      kind: 'info',
      description: 'Unpacked'
    })
    // Every id is unique through the item sheets and the detail sheets inside them.
    const ids = allRows(model.groups).map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(`extension:${noisy.id}:clear-errors`)
    expect(ids).toContain(`extension:${noisy.id}:error:2`)
  })

  it('a synced landing waiting for approval (services pass 16, ID-44) reads the pending line in the warn ink for Off, and again under its Enabled switch; approved, the line goes', () => {
    const pending = ext({
      id: 'c'.repeat(32),
      name: 'Adblock',
      enabled: false,
      pendingApproval: true
    })
    const model = section('extensions', extState([pending, ext({})]))
    const item = row(model, `extension:${pending.id}`)
    // The lead's words as ruled (round 4): a spaced en dash, U+2013, between the two halves.
    expect(item).toMatchObject({
      description: 'Synced from another device – needs your permission',
      tone: 'warn'
    })
    expect(item.description).toContain(' \u2013 ')
    expect(item.description).not.toContain('\u2014')
    const enabled = row(model, `extension:${pending.id}:enabled`)
    if (enabled.kind !== 'switch') throw new Error('not a switch')
    expect(enabled.checked).toBe(false)
    expect(enabled.description).toBe('Synced from another device – needs your permission')
    // The switch runs the same command as ever: the host's `setEnabled` opens the prompt.
    enabled.onChange(true)
    expect(invoke).toHaveBeenCalledWith('extension.setEnabled', { id: pending.id, enabled: true })
    // The other extension, installed here, says nothing of the kind.
    expect(row(model, `extension:${EXT_ID}`).tone).toBeUndefined()
    const plainSwitch = row(model, `extension:${EXT_ID}:enabled`)
    if (plainSwitch.kind !== 'switch') throw new Error('not a switch')
    expect(plainSwitch.description).toBeUndefined()
    // Approved (on, the flag gone) or merely off: the description is the extension's own, or Off.
    const approved = section('extensions', extState([ext({ id: pending.id, name: 'Adblock' })]))
    expect(row(approved, `extension:${pending.id}`).description).toBe(ext({}).description)
    expect(row(approved, `extension:${pending.id}`).tone).toBeUndefined()
    const off = section('extensions', extState([ext({ id: pending.id, enabled: false })]))
    expect(row(off, `extension:${pending.id}`)).toMatchObject({ description: 'Off' })
    // A load error outranks the line: one red line per row (the lead's ruling on #212).
    const broken = section(
      'extensions',
      extState([
        ext({ id: pending.id, enabled: false, pendingApproval: true, error: 'Bad manifest' })
      ])
    )
    expect(row(broken, `extension:${pending.id}`)).toMatchObject({
      description: 'Bad manifest',
      tone: 'danger'
    })
  })

  it('the Errors detail row sums the console and lists it newest first, then Clear errors', () => {
    const noisy = ext({ errors: CONSOLE })
    const model = section('extensions', extState([noisy]))
    const errors = row(model, `extension:${EXT_ID}:errors`)
    expect(errors).toMatchObject({
      kind: 'detail',
      label: 'Errors',
      summary: '2 errors, 1 warning'
    })
    if (errors.kind !== 'detail') throw new Error('not a detail row')
    expect(errors.sheet.title).toBe('Errors')
    expect(errors.sheet.description).toBe('Dark Reader')
    const [lines, clear] = errors.sheet.groups
    // Newest by its latest occurrence: the load failure (1 min), the repeated warning (5 min), the hour-old error.
    expect(lines!.rows.map((r) => r.id)).toEqual([
      `extension:${EXT_ID}:error:3`,
      `extension:${EXT_ID}:error:2`,
      `extension:${EXT_ID}:error:1`
    ])
    expect(lines!.rows.map((r) => r.label)).toEqual([
      'Manifest file is missing or unreadable',
      'Deprecated API',
      'Uncaught TypeError: Cannot read properties of undefined'
    ])
    // Source · when · ×count · file:line, each only when known; the extension's own origin drops.
    expect(lines!.rows.map((r) => r.description)).toEqual([
      'Loading · 1 min ago',
      'Content script · 5 min ago · ×3 · https://news.example/app.js',
      'Service worker · 1 h ago · background.js:12'
    ])
    expect(lines!.rows.every((r) => r.kind === 'info' && r.clamp && r.leading)).toBe(true)
    // Clear errors: destructive, no confirm (a third sheet would break §9.24; a cleared log is no loss).
    expect(clear!.rows.map((r) => r.id)).toEqual([`extension:${EXT_ID}:clear-errors`])
    const clearRow = clear!.rows[0]!
    expect(clearRow).toMatchObject({ kind: 'action', label: 'Clear errors', destructive: true })
    if (clearRow.kind !== 'action') throw new Error('not an action')
    expect(clearRow.confirm).toBeUndefined()
    clearRow.onPress?.()
    expect(invoke).toHaveBeenCalledWith('extension.clearErrors', { id: EXT_ID })

    // Only warnings, only errors, none: the summary's other forms and the §9.17 empty state.
    const warned = section('extensions', extState([ext({ errors: [CONSOLE[1]!] })]))
    expect(row(warned, `extension:${EXT_ID}:errors`)).toMatchObject({ summary: '1 warning' })
    const quiet = section('extensions', extState([ext({})]))
    const none = row(quiet, `extension:${EXT_ID}:errors`)
    expect(none).toMatchObject({ summary: 'None' })
    if (none.kind !== 'detail') throw new Error('not a detail row')
    expect(none.sheet.groups).toHaveLength(1)
    expect(none.sheet.groups[0]!.rows).toEqual([])
    expect(none.sheet.groups[0]!.empty).toBe('No errors')
  })

  it('the rows run the extension commands they stand for', () => {
    const model = section(
      'extensions',
      extState([ext({ permissions: ['storage', 'userScripts'] })])
    )
    const enabled = row(model, `extension:${EXT_ID}:enabled`)
    if (enabled.kind !== 'switch') throw new Error('not a switch')
    expect(enabled.checked).toBe(true)
    enabled.onChange(false)
    expect(invoke).toHaveBeenCalledWith('extension.setEnabled', { id: EXT_ID, enabled: false })
    const options = row(model, `extension:${EXT_ID}:options`)
    if (options.kind !== 'action') throw new Error('not an action')
    options.onPress?.()
    expect(invoke).toHaveBeenCalledWith('extension.openOptions', { id: EXT_ID })
    for (const [suffix, command, key] of [
      ['file-access', 'extension.setAllowFileAccess', 'allow'],
      ['private', 'extension.setAllowPrivate', 'allowed'],
      ['user-scripts', 'extension.setAllowUserScripts', 'allowed']
    ] as const) {
      const r = row(model, `extension:${EXT_ID}:${suffix}`)
      if (r.kind !== 'switch') throw new Error(`${suffix} is not a switch`)
      r.onChange(true)
      expect(invoke).toHaveBeenCalledWith(command, { id: EXT_ID, [key]: true })
    }
    const remove = row(model, `extension:${EXT_ID}:remove`)
    if (remove.kind !== 'action') throw new Error('not an action')
    remove.onPress?.()
    expect(invoke).toHaveBeenCalledWith('extension.remove', { id: EXT_ID })
    const source = row(model, `extension:${EXT_ID}:source`)
    if (source.kind !== 'action') throw new Error('not an action')
    source.onPress?.()
    expect(invoke).toHaveBeenCalledWith('tab.create', {
      url: `https://chromewebstore.google.com/detail/${EXT_ID}`,
      active: true
    })
    const check = row(model, 'extensions-check-updates')
    if (check.kind !== 'action') throw new Error('not an action')
    expect(check.disabled).toBe(false)
    check.onPress?.()
    expect(invoke).toHaveBeenCalledWith('extension.checkForUpdates', undefined)
  })

  it('the update check is busy while it runs and says when it last ran (§9.30)', () => {
    const checking = section(
      'extensions',
      extState([ext({})], { extensionUpdates: { lastCheckedAt: null, checking: true } })
    )
    expect(row(checking, 'extensions-check-updates')).toMatchObject({
      busy: true,
      description: 'Checking for updates…'
    })
    const checked = section(
      'extensions',
      extState([ext({ updateCheckedAt: NOW - 2 * 60 * 60 * 1000 })], {
        extensionUpdates: { lastCheckedAt: NOW - 3 * 60 * 60 * 1000, checking: false }
      })
    )
    expect(row(checked, 'extensions-check-updates')).toMatchObject({
      busy: false,
      description: 'Last checked 2 h ago'
    })
    // An update on offer is a row of the details sheet, busy while it is taken.
    const offered = section(
      'extensions',
      extState([ext({ updateState: 'available', availableVersion: '4.9.133' })])
    )
    const update = row(offered, `extension:${EXT_ID}:update`)
    expect(update).toMatchObject({
      kind: 'action',
      label: 'Update to 4.9.133',
      description: 'Version 4.9.132 is installed.',
      busy: false
    })
    if (update.kind !== 'action') throw new Error('not an action')
    update.onPress?.()
    expect(invoke).toHaveBeenCalledWith('extension.update', { id: EXT_ID })
    const updating = section('extensions', extState([ext({ updateState: 'updating' })]))
    expect(row(updating, `extension:${EXT_ID}:update`)).toMatchObject({
      label: 'Update',
      busy: true
    })
  })

  it('follows the host: a toolbar pin only with windows, private windows on a desktop, MV2 and Updated when they apply', () => {
    const desktop = section(
      'extensions',
      extState(
        [
          ext({
            manifestVersion: 2,
            toolbarPinned: true,
            updatedAt: NOW - 24 * 60 * 60 * 1000,
            source: 'edge-add-ons',
            publisher: 'edge-add-ons'
          })
        ],
        {},
        { windows: true, privateTabs: false }
      )
    )
    const pinned = row(desktop, `extension:${EXT_ID}:pinned`)
    expect(pinned).toMatchObject({ kind: 'switch', label: 'Pin to toolbar', checked: true })
    if (pinned.kind !== 'switch') throw new Error('not a switch')
    pinned.onChange(false)
    expect(invoke).toHaveBeenCalledWith('extension.setToolbarPinned', { id: EXT_ID, pinned: false })
    expect(row(desktop, `extension:${EXT_ID}:private`).label).toBe('Allow in private windows')
    expect(row(desktop, `extension:${EXT_ID}:updated`)).toMatchObject({
      kind: 'info',
      description: '1 d ago'
    })
    expect(row(desktop, `extension:${EXT_ID}:mv2`)).toMatchObject({
      kind: 'info',
      label: 'Manifest V2',
      tone: 'warn'
    })
    expect(row(desktop, `extension:${EXT_ID}:source`)).toMatchObject({
      description: 'Edge Add-ons',
      leaves: 'external'
    })
    const phone = section('extensions', extState([ext({})]))
    expect(findRow(phone.groups, `extension:${EXT_ID}:pinned`)).toBeNull()
    expect(findRow(phone.groups, `extension:${EXT_ID}:updated`)).toBeNull()
    expect(findRow(phone.groups, `extension:${EXT_ID}:mv2`)).toBeNull()
  })

  it('the landing search finds an extension by name, id and version; its sheets stay inside', () => {
    const s = extState([ext({ errors: CONSOLE })])
    const models = buildSections(availableSections(PAGE, s.capabilities, 'phone'), context(s).ctx)
    expect(models.map((m) => m.section.id)).toContain('extensions')
    const hit = searchRows(models, 'dark reader')
    expect(hit.map((h) => h.row.id)).toContain(`extension:${EXT_ID}`)
    expect(hit.find((h) => h.row.id === `extension:${EXT_ID}`)?.caption).toBe(
      'Extensions › Installed'
    )
    expect(searchRows(models, EXT_ID).map((h) => h.row.id)).toEqual([`extension:${EXT_ID}`])
    expect(searchRows(models, '4.9.132').map((h) => h.row.id)).toEqual([`extension:${EXT_ID}`])
    // The rows of the details and detail sheets are reached from the item row, not as hits.
    expect(searchRows(models, 'clear errors')).toEqual([])
  })
})

describe('the Apps category (shortcuts-menus-138)', () => {
  /** A desktop host that writes launchers (`pinShortcuts`), the Linux build's shape. */
  const PINS: HostCapabilities = {
    ...ANDROID,
    windows: true,
    extensions: true,
    pinShortcuts: true
  }
  const NOTES: InstalledWebApp = {
    id: 'notes',
    name: 'Notes',
    startUrl: 'https://notes.example/today',
    scope: 'https://notes.example/',
    pinnedAt: 2,
    icon: 'file:///icons/notes.png',
    bounds: null,
    windows: 0
  }
  const ATLAS: InstalledWebApp = {
    id: 'atlas',
    name: 'Atlas',
    startUrl: 'https://atlas.example/',
    scope: 'https://atlas.example/',
    pinnedAt: 1,
    windows: 0
  }
  const appsState = (webApps: InstalledWebApp[]): UIState =>
    state({ platform: 'linux', capabilities: PINS, webApps })

  it('is a section of the desktop OSes on a host that pins launchers, after Extensions; Android has none', () => {
    const ids = (caps: HostCapabilities, platform: Platform): string[] =>
      availableSections(PAGE, caps, 'desktop', platform).map((s) => s.id)
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      const listed = ids(PINS, platform)
      expect(listed.indexOf('apps'), platform).toBe(listed.indexOf('extensions') + 1)
    }
    // Without the launchers there is nothing to list; Android's apps are the launcher's tiles.
    expect(ids({ ...PINS, pinShortcuts: false }, 'linux')).not.toContain('apps')
    expect(ids(PINS, 'android')).not.toContain('apps')
    expect(availableSections(PAGE, PINS, 'phone', 'android').map((s) => s.id)).not.toContain('apps')
  })

  it('lists the installed apps by name, A to Z, each with its icon, its site and the row’s ⋯ of Open and Uninstall', () => {
    const model = section('apps', appsState([NOTES, ATLAS]))
    expect(model.groups.map((g) => g.id)).toEqual(['apps'])
    const list = model.groups[0]!
    expect(list.heading).toBe('Installed apps')
    expect(list.description).toContain('Save and Share')
    expect(list.rows.map((r) => r.id)).toEqual(['app:atlas', 'app:notes'])
    const notes = row(model, 'app:notes')
    expect(notes).toMatchObject({
      kind: 'item',
      label: 'Notes',
      description: 'notes.example',
      menu: 'Options for Notes'
    })
    if (notes.kind !== 'item') throw new Error('not an item')
    // The icon the host kept, else the globe (FaviconGlyph's own fallback).
    const iconOf = (r: Row): string | null | undefined => {
      if (r.kind !== 'item' || !isValidElement<{ src?: string | null }>(r.leading))
        throw new Error('no glyph')
      return r.leading.props.src
    }
    expect(iconOf(notes)).toBe(NOTES.icon)
    expect(iconOf(row(model, 'app:atlas'))).toBeUndefined()
    // The ⋯'s menu is the sheet's two action rows: Open launches the app, Uninstall – in the
    // danger ink, acting at once with no window of the app open (§10.5; the #435 lead check's
    // ruling 5: no prompt then) – removes its launcher and record.
    const prompt = vi.fn()
    const menu = itemMenuItems(notes, prompt)
    expect(menu.map((i) => ({ label: i.label, danger: i.danger ?? false }))).toEqual([
      { label: 'Open', danger: false },
      { label: 'Uninstall', danger: true }
    ])
    menu[0]!.onSelect()
    expect(invoke).toHaveBeenLastCalledWith('webapp.launch', { appId: 'notes' })
    menu[1]!.onSelect()
    expect(invoke).toHaveBeenLastCalledWith('webapp.uninstall', { appId: 'notes' })
    expect(prompt).not.toHaveBeenCalled()
    const uninstall = allRows(notes.sheet.groups).find((r) => r.id === 'app:notes:uninstall')
    if (uninstall?.kind !== 'action') throw new Error('not an action')
    expect(uninstall.destructive).toBe(true)
    expect(uninstall.confirm).toBeUndefined()
  })

  it('while a window of the app is open, Uninstall asks first with §9.23’s notice – "Uninstall <app>? Its open window closes.", Cancel | Uninstall as two secondaries, the verb plain – and the ⋯’s pick opens it rather than acting (the #435 lead check, ruling 5)', () => {
    const model = section(
      'apps',
      appsState([
        { ...NOTES, windows: 1 },
        { ...ATLAS, windows: 3 }
      ])
    )
    const notes = row(model, 'app:notes')
    if (notes.kind !== 'item') throw new Error('not an item')
    const uninstall = allRows(notes.sheet.groups).find((r) => r.id === 'app:notes:uninstall')
    if (uninstall?.kind !== 'action') throw new Error('not an action')
    expect(uninstall.confirm).toEqual({
      title: 'Uninstall Notes?',
      description: 'Its open window closes.',
      action: 'Uninstall',
      verbTone: 'plain'
    })
    // More than one window: the count is in the sentence's number.
    const atlas = row(model, 'app:atlas')
    if (atlas.kind !== 'item') throw new Error('not an item')
    const atlasUninstall = allRows(atlas.sheet.groups).find((r) => r.id === 'app:atlas:uninstall')
    if (atlasUninstall?.kind !== 'action') throw new Error('not an action')
    expect(atlasUninstall.confirm?.description).toBe('Its open windows close.')
    // The ⋯: Open acts at once as before; Uninstall hands its row to the prompt opener and does
    // nothing itself – the row's `onPress` is the prompt's verb (`ConfirmRowDialog`).
    invoke.mockClear()
    const prompt = vi.fn()
    const menu = itemMenuItems(notes, prompt)
    menu[0]!.onSelect()
    expect(invoke).toHaveBeenLastCalledWith('webapp.launch', { appId: 'notes' })
    menu[1]!.onSelect()
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith(uninstall)
    expect(invoke).not.toHaveBeenCalledWith('webapp.uninstall', expect.anything())
    uninstall.onPress?.()
    expect(invoke).toHaveBeenLastCalledWith('webapp.uninstall', { appId: 'notes' })
  })

  it('with nothing installed: the one group’s empty line, naming where an app is installed from', () => {
    const model = section('apps', appsState([]))
    const list = model.groups[0]!
    expect(list.rows).toEqual([])
    expect(list.empty).toBe('No apps installed')
    expect(groupShows(list)).toBe(true)
  })

  it('the landing search finds an app by name and by its site', () => {
    // The page less Extensions, whose builder wants the update check the bare fixture lacks.
    const caps: HostCapabilities = { ...PINS, extensions: false }
    const s = state({ platform: 'linux', capabilities: caps, webApps: [NOTES, ATLAS] })
    const models = buildSections(availableSections(PAGE, caps, 'desktop', 'linux'), {
      ...context(s).ctx,
      formFactor: 'desktop'
    })
    expect(searchRows(models, 'notes').map((h) => h.row.id)).toContain('app:notes')
    expect(searchRows(models, 'atlas.example').map((h) => h.row.id)).toEqual(['app:atlas'])
    expect(searchRows(models, 'notes').find((h) => h.row.id === 'app:notes')?.caption).toBe(
      'Apps › Installed apps'
    )
  })
})

describe('searching the rows', () => {
  it('finds rows by label, description, keywords and option labels, with their caption', () => {
    const models = phoneSections()
    const zoom = searchRows(models, 'zoom')
    expect(zoom.map((h) => h.row.id)).toContain('default-zoom')
    expect(zoom.map((h) => h.row.id)).toContain('force-zoom')
    expect(zoom.find((h) => h.row.id === 'default-zoom')?.caption).toBe('Accessibility › Page zoom')

    // "Floating only when typing" is an option of Floating behaviour, not in its label.
    expect(searchRows(models, 'only when typing').map((h) => h.row.id)).toEqual([
      'urlbar-behaviour'
    ])
    // Hits come in nav order: Look and Feel's rows before Accessibility's.
    expect(searchRows(models, 'follow system').map((h) => h.row.id)).toEqual([
      'color-scheme',
      'zoom-os-font'
    ])
    // Keywords reach rows whose visible text says something else.
    expect(searchRows(models, 'address bar bottom').map((h) => h.row.id)).toContain(
      'phone-bar-position'
    )
    // Every term must match, in any order, in any case.
    expect(searchRows(models, 'THEME dark').map((h) => h.row.id)).toContain('darken-sites')
    expect(searchRows(models, 'dark theme spaceship')).toEqual([])
  })

  it('has no hits for an empty query: the landing shows its categories instead', () => {
    expect(searchRows(phoneSections(), '')).toEqual([])
    expect(searchRows(phoneSections(), '   ')).toEqual([])
  })

  it('captions a row of a group without a heading by its category alone', () => {
    const hits = searchRows(phoneSections(), 'new container')
    expect(hits.map((h) => [h.row.id, h.caption])).toEqual([['new-container', 'Containers']])
  })

  it('reads a value row’s option labels, a custom row’s keywords and a field row’s display', () => {
    const look = section('look')
    const scheme = row(look, 'color-scheme')
    expect(rowText(scheme)).toContain('Follow system')
    // The layout cards are a custom row: its captions are its keywords, so a search for a
    // layout's name lands on the grid.
    const layout = row(look, 'toolbar-layout')
    expect(layout.kind).toBe('custom')
    expect(rowText(layout)).toContain('Collapsed sidebar')
    expect(rowText(layout)).toContain('Horizontal tabs')
    const tabs = section('tabs')
    const max = row(tabs, 'essentials-max')
    expect(max.kind).toBe('field')
    expect(rowText(max)).toContain(max.kind === 'field' ? (max.display ?? max.value) : '')
  })

  it('carries #156’s protection groups at the hub cards’ positions: cookies after Delete browsing data with the signals closing Chrome’s cookies stretch, Safe Browsing after them with HTTPS-only and secure DNS – Chrome’s Security page – before Site settings', () => {
    const privacy = section('privacy', state({ privacy: PRIVACY_STATUS }))
    const ids = privacy.groups.map((g) => g.id)
    // The protection groups' own order and content are asserted here; the whole category's
    // order, with #135's and #115's groups around them, is #135's test.
    const families = ['safe-browsing', 'cookies', 'https-only', 'secure-dns', 'signals']
    const familyOf = (id: string): string | undefined =>
      families.find((f) => id === f || id.startsWith(`${f}-`))
    const protection = privacy.groups.filter((g) => familyOf(g.id) !== undefined)
    // The third-party cookie mode itself is Cookies and site data's default row since #322's
    // ruling on Q3 folded the Third-party cookies group into it; the related sites follow it –
    // and, the Third-party cookies card standing before Safe Browsing's, they come first. The
    // signals are the cookies stretch's tail (Chrome's cookies-and-ad-privacy run, the #650
    // lead check), HTTPS-only and Secure DNS are Safe Browsing's kin (Chrome's Security page).
    expect(protection.map((g) => g.id)).toEqual([
      'cookies-related-sites',
      'cookies-add-site',
      'signals',
      'safe-browsing',
      'safe-browsing-feeds',
      'https-only',
      'https-only-sites',
      'secure-dns'
    ])
    // Each family sits at its card's position among the neighbours' groups (the #553 lead
    // check's Q6: the groups take the cards' order – Delete browsing data, Third-party cookies,
    // Safe Browsing, Site settings, Safety check). Delete browsing data is the first group
    // under the cards.
    const at = (id: string): number => ids.indexOf(id)
    expect(at('clear-data')).toBe(at('privacy-hub') + 1)
    // #310's Cookies and site data groups (site-data-*) stand between Delete browsing data and
    // Safe Browsing, where the Third-party cookies card sits, the related sites right under the
    // default they qualify; siteData.test.ts asserts their content.
    expect(at('site-data')).toBe(at('clear-data') + 1)
    expect(at('cookies-related-sites')).toBe(at('site-data') + 1)
    expect(at('site-data-allow')).toBe(at('cookies-add-site') + 1)
    // The un-carded kin follow their card (the #650 lead check): Tracking prevention and the
    // signals close the cookies stretch, then Safe Browsing, then HTTPS-only and Secure DNS –
    // both rows of Chrome's Security page.
    expect(at('tracking-prevention')).toBe(at('site-data-viewer') + 1)
    expect(at('signals')).toBe(at('tracking-exceptions') + 1)
    expect(at('safe-browsing')).toBe(at('signals') + 1)
    expect(at('https-only')).toBe(at('safe-browsing-feeds') + 1)
    expect(at('secure-dns')).toBe(at('https-only-sites') + 1)
    // Site settings follows the Security stretch, Safety check follows Site settings, as the
    // cards do; the sweep's switch closes Site settings (PS-41: the last thing on both Chromes'
    // Site settings pages), so Safety check follows it.
    expect(at('sites-permissions')).toBe(at('secure-dns') + 1)
    expect(at('sites-unused')).toBe(at('sites-own') + 1)
    expect(at('safety-check')).toBe(at('sites-unused') + 1)
    // After the carded five: Preload pages (PS-43) stays where it stood – Chrome's Performance ›
    // Speed row, its seat another slice's question – and the private-tab lock is last (INC-05,
    // Chrome's Incognito lock after Do Not Track).
    expect(at('preload')).toBe(at('safety-check-actions') + 1)
    expect(at('preload')).toBe(ids.length - 2)
    expect(at('private-lock')).toBe(ids.length - 1)
    // The remembered per-site answers are the Security section's (#62), not a privacy group.
    expect(ids).not.toContain('permissions')
    expect(privacy.groups.every(groupShows)).toBe(true)
    // Every protection row is one of the five families, and a family never straddles a group.
    for (const group of protection) {
      const family = familyOf(group.id)!
      for (const r of group.rows) expect(r.id, group.id).toMatch(new RegExp(`^${family}(-|:)`))
    }
    expect(privacy.groups.find((g) => g.id === 'safe-browsing')?.heading).toBe('Safe Browsing')
    expect(privacy.groups.find((g) => g.id === 'signals')?.heading).toBe('Privacy signals')

    // The level choice stands for the one switch; the key row never shows the key itself.
    const level = row(privacy, 'safe-browsing-level')
    if (level.kind !== 'value') throw new Error('not a value row')
    expect(level.value).toBe('standard')
    expect(level.options.map((o) => o.value)).toEqual(['standard', 'off'])
    const key = row(privacy, 'safe-browsing-api-key')
    if (key.kind !== 'field') throw new Error('not a field')
    expect(key.secret).toBe(true)
    // A 39-character key: the desktop's field stands under the label (§9.12's stacked form).
    expect(key.form).toBe('stacked')
    expect(key.display).toBe('Not set · optional, adds Google Safe Browsing lookups')
    expect(rowText(key)).not.toContain('AIza')
    // Update feeds now runs the service; each feed is an item whose sheet refreshes it alone.
    const update = row(privacy, 'safe-browsing-update')
    if (update.kind !== 'action') throw new Error('not an action')
    expect(update.description).toBe('4,895 sites across 2 feeds · Updated 2 min ago')
    update.onPress?.()
    expect(invoke).toHaveBeenCalledWith('protection.updateFeeds', {})
    const feed = row(privacy, 'safe-browsing-feed:urlhaus')
    if (feed.kind !== 'item') throw new Error('not an item')
    expect(feed.description).toBe('4,000 sites · 2 min ago')
    const refresh = row(privacy, 'safe-browsing-feed:urlhaus:update')
    if (refresh.kind !== 'action') throw new Error('not an action')
    refresh.onPress?.()
    expect(invoke).toHaveBeenCalledWith('protection.updateFeeds', { id: 'urlhaus' })
    expect(row(privacy, 'safe-browsing-feed:urlhaus:homepage')).toMatchObject({
      kind: 'action',
      leaves: 'external'
    })

    // Cookies: the third-party mode is Cookies and site data's default (Chrome's three radios,
    // siteData.test.ts) with the private-only switch under it, which speaks of private tabs on a
    // host without windows; the related sites follow.
    const cookies = row(privacy, 'site-data-default')
    if (cookies.kind !== 'value') throw new Error('not a value row')
    expect(cookies.options.map((o) => o.value)).toEqual(['allow', 'block-third-party', 'block-all'])
    expect(row(privacy, 'site-data-private-only')).toMatchObject({
      kind: 'switch',
      label: 'Only in private tabs',
      checked: true,
      disabled: false
    })
    expect(privacy.groups.find((g) => g.id === 'cookies-related-sites')?.empty).toBe(
      'No related sites yet'
    )
    expect(row(privacy, 'cookies-add-site')).toMatchObject({ kind: 'action', disabled: false })

    // HTTPS-only: the three modes with the shared words; no site allowed over http yet.
    const https = row(privacy, 'https-only-mode')
    if (https.kind !== 'value') throw new Error('not a value row')
    expect(https.options.map((o) => o.value)).toEqual(['off', 'ask', 'always'])
    expect(https.sheetDescription).toContain('over https first')
    expect(privacy.groups.find((g) => g.id === 'https-only-sites')?.empty).toBe(
      'No sites allowed over http yet'
    )

    // Android has no resolver of its own: one row opens the system's Private DNS screen.
    expect(privacy.groups.find((g) => g.id === 'secure-dns')?.rows.map((r) => r.id)).toEqual([
      'secure-dns-private-dns'
    ])
    const privateDns = row(privacy, 'secure-dns-private-dns')
    if (privateDns.kind !== 'action') throw new Error('not an action')
    expect(privateDns.leaves).toBe('external')
    privateDns.onPress?.()
    expect(invoke).toHaveBeenCalledWith('protection.openPrivateDnsSettings', undefined)

    expect(row(privacy, 'signals-gpc').kind).toBe('switch')
    expect(row(privacy, 'signals-dnt').kind).toBe('switch')
  })

  // Preload pages (PS-43, services pass 10): Find in Settings lands a user typing Resources' old
  // word here, Resources gains no note row, and no relaunch notice follows a change of the level
  // – the request engine's refusal is live and the whole of the enforcement; no startup switch
  // waits behind it, so the level's own sentence went with the switch (the #522 addendum of
  // 06:02; the Resources process profile's generic notice is untouched by the level).
  it('Preload pages: the row’s search keywords carry prerender, prefetch and preload; Resources has no note row; no relaunch notice after a change of the level, whatever the process runs with', () => {
    const preload = row(section('privacy'), 'preload-pages')
    if (preload.kind !== 'value') throw new Error('not a value row')
    expect(preload.keywords).toEqual(expect.arrayContaining(['prerender', 'prefetch', 'preload']))
    expect(preload.options.map((o) => o.value)).toEqual(['standard', 'none'])
    // No note row in Resources: nothing there speaks of preloading or prerendering any more.
    const resources = section(
      'resources',
      state({}, { resources: { ...DEFAULT_SETTINGS.resources } })
    )
    for (const g of resources.groups)
      for (const r of g.rows) expect(rowText(r), r.id).not.toMatch(/preload|prerender/i)
    // The level's group is the one value row, under every level and every snapshot.
    for (const preloadPages of ['standard', 'none'] as const) {
      for (const snapshot of [
        emptyResourceSnapshot(),
        { ...emptyResourceSnapshot(), restartRequired: true, pendingSwitches: ['js-flags'] }
      ]) {
        const privacy = section('privacy', state({ resources: snapshot }, { preloadPages }))
        const group = privacy.groups.find((g) => g.id === 'preload')!
        expect(group.rows.map((r) => r.id)).toEqual(['preload-pages'])
        for (const r of group.rows) expect(rowText(r), r.id).not.toMatch(/relaunch/i)
        expect(privacy.groups.flatMap((g) => g.rows.map((r) => r.id))).not.toContain(
          'preload-relaunch'
        )
      }
    }
    // The process profile's own notice is Resources' and follows its own switches alone.
    expect(
      section(
        'resources',
        state({
          resources: { ...emptyResourceSnapshot(), restartRequired: true, pendingSwitches: ['gpu'] }
        })
      ).groups.flatMap((g) => g.rows.map((r) => r.id))
    ).toContain('resources-relaunch')
    expect(
      section('resources', state({ resources: emptyResourceSnapshot() })).groups.flatMap((g) =>
        g.rows.map((r) => r.id)
      )
    ).not.toContain('resources-relaunch')
  })

  it('#156’s rows patch settings.privacy on top of what is there, and run the protection commands', async () => {
    const c = context(state({ privacy: PRIVACY_STATUS }))
    const privacy = buildSection(
      PAGE.sections.find((x) => x.id === 'privacy')!,
      c.ctx
    )
    const level = row(privacy, 'safe-browsing-level')
    if (level.kind !== 'value') throw new Error('not a value row')
    level.onChange('off')
    const https = row(privacy, 'https-only-mode')
    if (https.kind !== 'value') throw new Error('not a value row')
    https.onChange('always')
    // The private-only switch off: third-party cookies blocked everywhere (the default radio
    // itself runs `siteData.setDefault`, siteData.test.ts).
    const privateOnly = row(privacy, 'site-data-private-only')
    if (privateOnly.kind !== 'switch') throw new Error('not a switch')
    privateOnly.onChange(false)
    const gpc = row(privacy, 'signals-gpc')
    if (gpc.kind !== 'switch') throw new Error('not a switch')
    gpc.onChange(true)
    const base = DEFAULT_SETTINGS.privacy
    expect(c.patches).toEqual([
      { privacy: { ...base, safeBrowsingEnabled: false } },
      { privacy: { ...base, httpsOnly: 'always' } },
      { privacy: { ...base, thirdPartyCookies: 'block' } },
      { privacy: { ...base, gpc: true } }
    ])

    // The key field is a §9.30 busy form: a malformed key is refused at once, a well-formed one
    // is tried against the API and kept only when Google takes it; clearing it needs no check.
    const key = row(privacy, 'safe-browsing-api-key')
    if (key.kind !== 'field') throw new Error('not a field')
    expect(key.onCommit('not a key!')).toBe(
      'A key is letters, digits, dashes and underscores, up to 128 of them'
    )
    invoke.mockResolvedValueOnce({ ok: false, problem: 'Google rejected this key' } as never)
    const refused = key.onCommit('AIzaSyBad')
    expect(refused).toBeInstanceOf(Promise)
    await expect(refused).resolves.toBe('Google rejected this key')
    expect(invoke).toHaveBeenCalledWith('protection.checkApiKey', { key: 'AIzaSyBad' })
    expect(c.patches.length).toBe(4)
    invoke.mockResolvedValueOnce({ ok: true } as never)
    await expect(key.onCommit(' AIzaSyGood ')).resolves.toBeUndefined()
    expect(c.patches.at(-1)).toEqual({ privacy: { ...base, safeBrowsingApiKey: 'AIzaSyGood' } })
    // The value as stored is no change; clearing a stored key needs no check.
    expect(key.onCommit('')).toBeUndefined()
    expect(c.patches.length).toBe(5)
    const keyed = context(
      state({ privacy: PRIVACY_STATUS }, { privacy: { ...base, safeBrowsingApiKey: 'AIzaSyOld' } })
    )
    const withKey = buildSection(
      PAGE.sections.find((x) => x.id === 'privacy')!,
      keyed.ctx
    )
    const stored = row(withKey, 'safe-browsing-api-key')
    if (stored.kind !== 'field') throw new Error('not a field')
    expect(stored.display).toBe('Set · lookups start with the next page you open')
    expect(stored.onCommit('')).toBeUndefined()
    expect(keyed.patches).toEqual([{ privacy: { ...base, safeBrowsingApiKey: '' } }])
    expect(invoke).toHaveBeenCalledTimes(2)

    // The feed rows and the key wait at .4 while Safe Browsing is off; the level stays live.
    const off = buildSection(
      PAGE.sections.find((x) => x.id === 'privacy')!,
      context(
        state(
          { privacy: { ...PRIVACY_STATUS, safeBrowsing: { ...SAFE_BROWSING, enabled: false } } },
          { privacy: { ...base, safeBrowsingEnabled: false } }
        )
      ).ctx
    )
    expect(row(off, 'safe-browsing-level')).toMatchObject({ value: 'off' })
    expect(row(off, 'safe-browsing-level').disabled).toBeFalsy()
    expect(row(off, 'safe-browsing-api-key').disabled).toBe(true)
    expect(row(off, 'safe-browsing-update').disabled).toBe(true)
    expect(row(off, 'safe-browsing-feed:urlhaus').disabled).toBe(true)

    // Related sites: each an item whose sheet removes it; the list waits while cookies are allowed.
    const listed = context(
      state(
        { privacy: PRIVACY_STATUS },
        {
          privacy: {
            ...base,
            thirdPartyCookies: 'block',
            thirdPartyCookieExceptions: ['accounts.example', 'login.example']
          }
        }
      )
    )
    const withSites = buildSection(
      PAGE.sections.find((x) => x.id === 'privacy')!,
      listed.ctx
    )
    expect(
      withSites.groups.find((g) => g.id === 'cookies-related-sites')?.rows.map((r) => r.id)
    ).toEqual(['cookies-site:accounts.example', 'cookies-site:login.example'])
    const remove = row(withSites, 'cookies-site:accounts.example:remove')
    if (remove.kind !== 'action') throw new Error('not an action')
    remove.onPress?.()
    expect(listed.patches).toEqual([
      {
        privacy: {
          ...base,
          thirdPartyCookies: 'block',
          thirdPartyCookieExceptions: ['login.example']
        }
      }
    ])
    // With third-party cookies allowed – the engine's site-data default says `allow` for the
    // mode, as `SiteDataService.default()` derives it – the related sites have nothing to relax.
    const allowed = buildSection(
      PAGE.sections.find((x) => x.id === 'privacy')!,
      context(
        state(
          {
            privacy: PRIVACY_STATUS,
            siteData: { ...emptySiteDataStatus(), default: 'allow' }
          },
          {
            privacy: {
              ...base,
              thirdPartyCookies: 'allow',
              thirdPartyCookieExceptions: ['a.example']
            }
          }
        )
      ).ctx
    )
    expect(row(allowed, 'cookies-site:a.example').disabled).toBe(true)
    expect(row(allowed, 'cookies-add-site').disabled).toBe(true)
    expect(row(allowed, 'site-data-private-only').disabled).toBe(true)

    // Sites allowed over http: stored ones forget through the permission, session ones through
    // the service; a site in both lists is one row.
    const plaintext = buildSection(
      PAGE.sections.find((x) => x.id === 'privacy')!,
      context(
        state({
          privacy: {
            ...PRIVACY_STATUS,
            httpsOnlyExceptions: ['old.example'],
            httpsOnlySessionExceptions: ['old.example', 'today.example']
          }
        })
      ).ctx
    )
    expect(
      plaintext.groups.find((g) => g.id === 'https-only-sites')?.rows.map((r) => r.id)
    ).toEqual(['https-only-site:old.example', 'https-only-session:today.example'])
    const forget = row(plaintext, 'https-only-site:old.example:forget')
    if (forget.kind !== 'action') throw new Error('not an action')
    forget.onPress?.()
    expect(invoke).toHaveBeenCalledWith('permissions.set', {
      origin: 'http://old.example',
      permission: 'https-only',
      decision: null
    })
    const forgetSession = row(plaintext, 'https-only-session:today.example:forget')
    if (forgetSession.kind !== 'action') throw new Error('not an action')
    forgetSession.onPress?.()
    expect(invoke).toHaveBeenCalledWith('protection.forgetPlaintext', { host: 'today.example' })
  })

  it('#156’s secure DNS rows on a host with a resolver: the switch, one resolver choice, the custom field as a busy form', async () => {
    const caps = { ...ANDROID, secureDns: true, windows: true }
    const c = context(
      state({ platform: 'linux', capabilities: caps, privacy: PRIVACY_STATUS } as Partial<UIState>)
    )
    const privacy = buildSection(
      PAGE.sections.find((x) => x.id === 'privacy')!,
      c.ctx
    )
    expect(findRow(privacy.groups, 'secure-dns-private-dns')).toBeNull()
    expect(privacy.groups.find((g) => g.id === 'secure-dns')?.rows.map((r) => r.id)).toEqual([
      'secure-dns-enabled',
      'secure-dns-resolver'
    ])
    const base = DEFAULT_SETTINGS.privacy
    const enabled = row(privacy, 'secure-dns-enabled')
    if (enabled.kind !== 'switch') throw new Error('not a switch')
    expect(enabled.checked).toBe(base.secureDnsMode !== 'off')
    enabled.onChange(false)
    expect(c.patches).toEqual([{ privacy: { ...base, secureDnsMode: 'off' } }])
    const resolver = row(privacy, 'secure-dns-resolver')
    if (resolver.kind !== 'value') throw new Error('not a value row')
    expect(resolver.options[0]).toMatchObject({ value: 'automatic' })
    expect(resolver.options.at(-1)).toMatchObject({ value: 'custom', label: 'Custom resolver' })
    resolver.onChange('custom')
    expect(c.patches.at(-1)).toEqual({
      privacy: { ...base, secureDnsMode: 'provider', secureDnsProvider: 'custom' }
    })
    // The private-only switch under the cookies default speaks of private windows here.
    expect(row(privacy, 'site-data-private-only')).toMatchObject({
      kind: 'switch',
      label: 'Only in private windows'
    })

    // With the custom entry picked the field appears: refused at once for a non-https address,
    // asked one question for a well-formed one, kept when the resolver answers.
    const custom = context(
      state(
        { platform: 'linux', capabilities: caps, privacy: PRIVACY_STATUS } as Partial<UIState>,
        {
          privacy: { ...base, secureDnsMode: 'provider', secureDnsProvider: 'custom' }
        }
      )
    )
    const withField = buildSection(
      PAGE.sections.find((x) => x.id === 'privacy')!,
      custom.ctx
    )
    const field = row(withField, 'secure-dns-custom')
    if (field.kind !== 'field') throw new Error('not a field')
    expect(field.display).toBe('Not set')
    expect(field.onCommit('http://dns.example/dns-query')).toBe(
      'The address must start with https://'
    )
    invoke.mockResolvedValueOnce({ ok: false, problem: 'No answer' } as never)
    await expect(field.onCommit('https://dns.example/dns-query')).resolves.toBe('No answer')
    expect(invoke).toHaveBeenCalledWith('protection.checkResolver', {
      url: 'https://dns.example/dns-query'
    })
    expect(custom.patches).toEqual([])
    invoke.mockResolvedValueOnce({ ok: true } as never)
    await expect(field.onCommit('https://dns.example/dns-query')).resolves.toBeUndefined()
    expect(custom.patches).toEqual([
      {
        privacy: {
          ...base,
          secureDnsMode: 'provider',
          secureDnsProvider: 'custom',
          secureDnsCustomUrl: 'https://dns.example/dns-query'
        }
      }
    ])
  })
})

describe('CT-07 / CT-19: the Spell check group of Languages on a phone', () => {
  it('states the keyboard’s checker and leads to its settings on a host with no checker of its own', () => {
    const languages = section('languages')
    const group = languages.groups.find((g) => g.id === 'spellcheck')
    expect(group?.heading).toBe('Spell check')
    expect(group?.description).toContain('spell checker of the keyboard in use')
    expect(group?.rows.map((r) => r.id)).toEqual(['spellcheck-keyboard'])
    const open = row(languages, 'spellcheck-keyboard')
    if (open.kind !== 'action') throw new Error('not an action')
    expect(open.label).toBe('Keyboard settings')
    expect(open.leaves).toBe('external')
    open.onPress?.()
    expect(invoke).toHaveBeenCalledWith('spellcheck.openKeyboardSettings', undefined)
    // Nothing of the desktop's own checker: no switch, no list, no dictionary.
    expect(findRow(languages.groups, 'spellcheck-enabled')).toBeNull()
    expect(languages.groups.map((g) => g.id)).not.toContain('spellcheck-languages')
  })

  it('carries the switch, the languages checked in with their dictionary’s state, Remove and an Add sheet where the host checks itself', () => {
    const s = state({
      spellcheck: {
        available: true,
        systemLanguages: false,
        languages: [
          { code: 'en-US', name: 'English (United States)', enabled: true, status: 'ready' },
          { code: 'de', name: 'German', enabled: true, status: 'downloading' },
          { code: 'fr', name: 'French', enabled: true, status: 'failed' },
          { code: 'es', name: 'Spanish', enabled: false, status: 'unknown' }
        ]
      }
    })
    const languages = section('languages', s)
    expect(languages.groups.map((g) => g.id).slice(-5)).toEqual([
      'spellcheck',
      'spellcheck-languages',
      'spellcheck-add',
      'spellcheck-dictionary',
      'spellcheck-add-word'
    ])
    const on = row(languages, 'spellcheck-enabled')
    if (on.kind !== 'switch') throw new Error('not a switch')
    expect(on.checked).toBe(true)
    on.onChange(false)
    expect(invoke).toHaveBeenCalledWith('spellcheck.setEnabled', { enabled: false })

    // The languages checked in are items; what their dictionary is doing is the description.
    expect(row(languages, 'spellcheck-language:en-US')).toMatchObject({
      kind: 'item',
      label: 'English (United States)',
      description: undefined
    })
    expect(row(languages, 'spellcheck-language:de').description).toBe('Downloading dictionary…')
    expect(row(languages, 'spellcheck-language:fr').description).toBe('Dictionary download failed')
    expect(findRow(languages.groups, 'spellcheck-language:es')).toBeNull()
    const remove = row(languages, 'spellcheck-language:de:remove')
    if (remove.kind !== 'action') throw new Error('not an action')
    remove.onPress?.()
    expect(invoke).toHaveBeenCalledWith('spellcheck.setLanguage', { code: 'de', on: false })

    // Add opens the §9.13 sheet with the languages not yet checked in.
    const add = row(languages, 'spellcheck-add')
    if (add.kind !== 'action') throw new Error('not an action')
    // One copy for the page's three Add rows (the #350 review's nit 3); the sheet's description
    // says what the pick does.
    expect(add.label).toBe('Add language')
    expect(add.form?.title).toBe('Add language')
    expect(add.form?.description).toBe('Text you type is checked in this language too.')
    expect(add.disabled).toBeFalsy()
  })

  it('reads the list at .4 with the switch off, replaces Add with Chrome’s limit at five, and names the system where it chooses', () => {
    const five = ['en-US', 'de', 'fr', 'es', 'it'].map((code) => ({
      code,
      name: code,
      enabled: true,
      status: 'ready' as const
    }))
    const off = section(
      'languages',
      state(
        { spellcheck: { available: true, systemLanguages: false, languages: five } },
        { spellcheck: { ...DEFAULT_SETTINGS.spellcheck, enabled: false } }
      )
    )
    expect(row(off, 'spellcheck-enabled')).toMatchObject({ kind: 'switch', checked: false })
    expect(row(off, 'spellcheck-language:de').disabled).toBe(true)
    // Five checked in: the limit's info row stands where Add stood, dependent like the list.
    expect(row(off, 'spellcheck-limit')).toMatchObject({
      kind: 'info',
      label: 'Up to 5 languages can be checked at a time',
      description: 'Remove one to add another.',
      disabled: true
    })
    expect(findRow(off.groups, 'spellcheck-add')).toBeNull()

    const system = section(
      'languages',
      state({ spellcheck: { available: true, systemLanguages: true, languages: five } })
    )
    expect(row(system, 'spellcheck-system-languages')).toMatchObject({
      kind: 'info',
      label: 'Languages follow the system'
    })
    expect(findRow(system.groups, 'spellcheck-language:de')).toBeNull()
    expect(system.groups.map((g) => g.id)).not.toContain('spellcheck-add')
  })

  it('lists the custom dictionary’s words with Remove and the Add a new word form on the desktop and tablet shells alone', () => {
    const s = state({
      spellcheck: {
        available: true,
        systemLanguages: false,
        languages: [
          { code: 'en-US', name: 'English (United States)', enabled: true, status: 'ready' }
        ]
      }
    })
    const removed: string[] = []
    const c = context(s, false, {}, null, {
      words: ['Zenium', 'colour'],
      remove: (word) => removed.push(word)
    })
    const def = PAGE.sections.find((x) => x.id === 'languages')!
    const languages = buildSection(def, c.ctx)
    const dictionary = languages.groups.find((g) => g.id === 'spellcheck-dictionary')
    expect(dictionary?.heading).toBe('Custom dictionary')
    expect(dictionary?.layouts).toEqual(['desktop', 'tablet'])
    expect(dictionary?.rows.map((r) => [r.kind, r.label])).toEqual([
      ['item', 'Zenium'],
      ['item', 'colour']
    ])
    const remove = row(languages, 'spellcheck-word:colour:remove')
    if (remove.kind !== 'action') throw new Error('not an action')
    remove.onPress?.()
    expect(removed).toEqual(['colour'])
    const add = row(languages, 'spellcheck-add-word')
    if (add.kind !== 'action') throw new Error('not an action')
    expect(add.label).toBe('Add a new word')
    expect(add.form?.title).toBe('Add a new word')
    expect(add.disabled).toBeFalsy()

    // No words read yet (another category is open, a search): the list waits, Add stands.
    const waiting = buildSection(def, context(s).ctx)
    expect(groupShows(waiting.groups.find((g) => g.id === 'spellcheck-dictionary')!)).toBe(false)
    expect(findRow(waiting.groups, 'spellcheck-add-word')).not.toBeNull()
    // Read and empty: the §9.17 line.
    const none = buildSection(def, context(s, false, {}, null, { words: [] }).ctx)
    expect(none.groups.find((g) => g.id === 'spellcheck-dictionary')?.empty).toBe('No words yet')

    // Both groups are the desktop shell's: a phone builds neither, a desktop both.
    const phone = buildSection(def, { ...c.ctx, formFactor: 'phone' })
    expect(phone.groups.map((g) => g.id)).not.toContain('spellcheck-dictionary')
    expect(phone.groups.map((g) => g.id)).not.toContain('spellcheck-add-word')
    const desktop = buildSection(def, { ...c.ctx, formFactor: 'desktop' })
    expect(findRow(desktop.groups, 'spellcheck-word:Zenium')).not.toBeNull()
    expect(findRow(desktop.groups, 'spellcheck-add-word')).not.toBeNull()

    // With the checker off, both follow the switch as its dependent.
    const off = buildSection(
      def,
      context(
        state(
          { spellcheck: s.spellcheck },
          { spellcheck: { ...DEFAULT_SETTINGS.spellcheck, enabled: false } }
        ),
        false,
        {},
        null,
        { words: ['Zenium'] }
      ).ctx
    )
    expect(row(off, 'spellcheck-word:Zenium').disabled).toBe(true)
    expect(row(off, 'spellcheck-add-word').disabled).toBe(true)
  })
})

describe('CT-22: sleeping tabs in Tab Management on a phone, in Edge’s words', () => {
  it('has the switch and the 30 s to 12 h ladder, dependent on the switch', () => {
    const c = context()
    const tabs = buildSection(
      PAGE.sections.find((x) => x.id === 'tabs')!,
      c.ctx
    )
    const group = tabs.groups.find((g) => g.id === 'sleeping-tabs')
    expect(group?.heading).toBe('Sleeping tabs')
    expect(group?.rows.map((r) => r.id)).toEqual(['unload-enabled', 'unload-after'])
    const on = row(tabs, 'unload-enabled')
    if (on.kind !== 'switch') throw new Error('not a switch')
    expect(on.label).toBe('Save resources with sleeping tabs')
    expect(on.checked).toBe(true)
    on.onChange(false)
    expect(c.patches.at(-1)).toEqual({ unloadEnabled: false })

    const after = row(tabs, 'unload-after')
    if (after.kind !== 'value') throw new Error('not a choice')
    expect(after.label).toBe('Put inactive tabs to sleep after')
    // Edge's ladder; the default (20 minutes) is off it and is listed in its place, not lost.
    expect(after.options.map((o) => o.label)).toEqual([
      '30 seconds',
      '1 minute',
      '5 minutes',
      '15 minutes',
      '20 minutes',
      '30 minutes',
      '1 hour',
      '2 hours',
      '3 hours',
      '6 hours',
      '12 hours'
    ])
    expect(after.value).toBe('20')
    expect(after.disabled).toBe(false)
    after.onChange('0.5')
    expect(c.patches.at(-1)).toEqual({ unloadTimeoutMinutes: 0.5 })

    const off = section('tabs', state({}, { unloadEnabled: false }))
    expect(row(off, 'unload-after').disabled).toBe(true)
    expect(row(off, 'never-sleep-add').disabled).toBe(true)
  })

  it('lists the sites that never sleep with Remove, and an Add sheet that takes a host from what was typed', () => {
    const c = context(state({}, { unloadExcludedDomains: ['mail.example.com', 'chat.example'] }))
    const tabs = buildSection(
      PAGE.sections.find((x) => x.id === 'tabs')!,
      c.ctx
    )
    const group = tabs.groups.find((g) => g.id === 'never-sleep')
    expect(group?.heading).toBe('Never put these sites to sleep')
    expect(group?.rows.map((r) => r.id)).toEqual([
      'never-sleep:chat.example',
      'never-sleep:mail.example.com'
    ])
    const remove = row(tabs, 'never-sleep:chat.example:remove')
    if (remove.kind !== 'action') throw new Error('not an action')
    remove.onPress?.()
    expect(c.patches.at(-1)).toEqual({ unloadExcludedDomains: ['mail.example.com'] })

    // The Add action is a group of its own under the list, as the spell-check languages' is, so
    // the list can be empty and say so (§9.17).
    const groups = tabs.groups.map((g) => g.id)
    expect(groups.indexOf('never-sleep-add')).toBe(groups.indexOf('never-sleep') + 1)
    expect(tabs.groups.find((g) => g.id === 'never-sleep-add')?.heading).toBeNull()
    const add = row(tabs, 'never-sleep-add')
    if (add.kind !== 'action') throw new Error('not an action')
    expect(add.label).toBe('Add a site')
    expect(add.form?.title).toBe('Never put this site to sleep')
  })

  it('says "No sites yet" where the never-sleep list would be, with Add still there', () => {
    const tabs = section('tabs', state({}, { unloadExcludedDomains: [] }))
    const list = tabs.groups.find((g) => g.id === 'never-sleep')
    expect(list?.rows).toEqual([])
    expect(list?.empty).toBe('No sites yet')
    expect(row(tabs, 'never-sleep-add').label).toBe('Add a site')
  })

  it('is the phone shell’s: the desktop and tablet shells bind the same keys through Performance › Memory Saver (W8-2), and their Tab Management has no unloading rows', () => {
    const def = PAGE.sections.find((x) => x.id === 'tabs')!
    const c = context(state({}, { unloadExcludedDomains: ['mail.example.com'] }))
    const phone = buildSection(def, { ...c.ctx, formFactor: 'phone' })
    expect(phone.groups.map((g) => g.id)).toEqual(
      expect.arrayContaining(['sleeping-tabs', 'never-sleep', 'never-sleep-add'])
    )
    expect(phone.groups.map((g) => g.id)).not.toContain('unloading')
    expect(phone.groups.map((g) => g.id)).not.toContain('memory-saver')

    for (const layout of ['desktop', 'tablet'] as const) {
      const shell = buildSection(def, { ...c.ctx, formFactor: layout })
      const ids = shell.groups.map((g) => g.id)
      // The Tab unloading group went with Memory Saver; nothing of the phone's ladder came.
      expect(ids).not.toContain('unloading')
      expect(ids).not.toContain('sleeping-tabs')
      expect(ids).not.toContain('never-sleep')
      expect(ids).not.toContain('never-sleep-add')
      expect(findRow(shell.groups, 'unloading-enabled')).toBeNull()
      expect(findRow(shell.groups, 'unloading-after')).toBeNull()
      expect(findRow(shell.groups, 'unloading-excluded')).toBeNull()
      expect(findRow(shell.groups, 'unloading-add-current')).toBeNull()
      // The same three keys, from Performance.
      const performance = buildSection(
        PAGE.sections.find((x) => x.id === 'performance')!,
        {
          ...c.ctx,
          formFactor: layout
        }
      )
      const on = row(performance, 'memory-saver')
      if (on.kind !== 'switch') throw new Error('not a switch')
      on.onChange(false)
      expect(c.patches.at(-1)).toEqual({ unloadEnabled: false })
      const tier = row(performance, 'memory-saver-tier')
      if (tier.kind !== 'value') throw new Error('not a choice')
      tier.onChange('240')
      expect(c.patches.at(-1)).toEqual({ unloadTimeoutMinutes: 240 })
      const remove = row(performance, 'keep-active:mail.example.com:remove')
      if (remove.kind !== 'action') throw new Error('not an action')
      remove.onPress?.()
      expect(c.patches.at(-1)).toEqual({ unloadExcludedDomains: [] })
    }
  })
})

describe('W8-2: Performance on the desktop and tablet shells – Chrome’s Memory Saver and Energy Saver over the governor’s keys', () => {
  const DESKTOP_STATE = (settings: Partial<Settings> = {}, patch: Partial<UIState> = {}): UIState =>
    state(
      {
        platform: 'linux',
        capabilities: { ...ANDROID, windows: true, resourceGovernor: true },
        ...patch
      },
      settings
    )
  const perf = (
    s: UIState,
    formFactor: FormFactor = 'desktop'
  ): ReturnType<typeof context> & {
    model: Model
  } => {
    const c = context(s, true)
    const model = buildSection(
      PAGE.sections.find((x) => x.id === 'performance')!,
      {
        ...c.ctx,
        formFactor
      }
    )
    return { ...c, model }
  }

  it('draws Chrome’s groups in Chrome’s order on the desktop: Memory Saver, Always keep these sites active (with its Add group), the tab hover card’s row (W8-10), Energy Saver', () => {
    const { model } = perf(DESKTOP_STATE({ unloadExcludedDomains: ['mail.example.com'] }))
    expect(model.groups.map((g) => [g.id, g.heading])).toEqual([
      ['memory-saver', 'Memory Saver'],
      ['keep-active', 'Always keep these sites active'],
      ['keep-active-add', null],
      ['hover-card', 'Tab hover card'],
      ['energy-saver', 'Energy Saver']
    ])
    expect(allRows(model.groups).map((r) => [r.kind, r.id])).toEqual([
      ['switch', 'memory-saver'],
      ['value', 'memory-saver-tier'],
      ['item', 'keep-active:mail.example.com'],
      ['action', 'keep-active:mail.example.com:remove'],
      ['action', 'keep-active-add'],
      ['action', 'keep-active-current'],
      ['switch', 'hover-card-memory'],
      ['switch', 'energy-saver'],
      ['value', 'energy-saver-mode'],
      ['value', 'energy-saver-factor']
    ])
    for (const group of model.groups) expect(groupShows(group)).toBe(true)
  })

  it('gives the tablet Memory Saver alone – the Energy Saver group is the desktop’s (`layouts`), whatever the host says of a battery (Android’s condition on pr-584)', () => {
    const snapshot = (hasBattery: boolean | null): Partial<UIState> => ({
      resources: {
        ...emptyResourceSnapshot(),
        system: { ...emptyResourceSnapshot().system, hasBattery }
      }
    })
    // The gate is the shell's, not the battery's: a host that reports a battery keeps the group
    // on the desktop and still has none on the tablet.
    expect(perf(DESKTOP_STATE({}, snapshot(true))).model.groups.at(-1)?.id).toBe('energy-saver')
    // The tablet reports null (`emptyResourceSnapshot`); a true or a false changes nothing there.
    for (const hasBattery of [null, true, false]) {
      const { model, patches } = perf(
        DESKTOP_STATE({ unloadExcludedDomains: ['mail.example.com'] }, snapshot(hasBattery)),
        'tablet'
      )
      expect(model.groups.map((g) => [g.id, g.heading])).toEqual([
        ['memory-saver', 'Memory Saver'],
        ['keep-active', 'Always keep these sites active'],
        ['keep-active-add', null]
      ])
      expect(allRows(model.groups).map((r) => r.id)).toEqual([
        'memory-saver',
        'memory-saver-tier',
        'keep-active:mail.example.com',
        'keep-active:mail.example.com:remove',
        'keep-active-add',
        'keep-active-current'
      ])
      expect(allRows(model.groups).some((r) => r.id.startsWith('energy-saver'))).toBe(false)
      expect(patches).toEqual([])
    }
  })

  it('seats the tab hover card’s memory switch on the desktop (settings-29, W8-10): Chrome’s "Show tab memory usage" under its "Tab hover card" heading, off by default, bound to hoverCardMemoryUsage; the tablet has none', () => {
    const { model, patches } = perf(DESKTOP_STATE())
    const group = model.groups.find((g) => g.id === 'hover-card')!
    expect(group.heading).toBe('Tab hover card')
    expect(group.layouts).toEqual(['desktop'])
    expect(group.rows.map((r) => r.id)).toEqual(['hover-card-memory'])
    const memory = row(model, 'hover-card-memory')
    if (memory.kind !== 'switch') throw new Error('not a switch')
    expect(memory.label).toBe('Show tab memory usage')
    expect(memory.description).toBe(
      'The card that appears when you rest the pointer on a tab says how much memory its page is using.'
    )
    // Chrome 152's effective default: browser.hovercard.memory_usage_enabled registers true in
    // local state (RegisterBrowserPrefs) and MigrateHoverCardMemoryPref flips it to false once,
    // under Tab Declutter, on every desktop platform – so the switch rests off.
    expect(DEFAULT_SETTINGS.hoverCardMemoryUsage).toBe(false)
    expect(memory.checked).toBe(false)
    expect(memory.disabled).toBeFalsy()
    memory.onChange(true)
    expect(patches).toEqual([{ hoverCardMemoryUsage: true }])
    const on = row(perf(DESKTOP_STATE({ hoverCardMemoryUsage: true })).model, 'hover-card-memory')
    if (on.kind !== 'switch') throw new Error('not a switch')
    expect(on.checked).toBe(true)
    // Independent of Memory Saver: the switch stands whatever the mode.
    const saverOff = row(
      perf(DESKTOP_STATE({ unloadEnabled: false, hoverCardMemoryUsage: true })).model,
      'hover-card-memory'
    )
    if (saverOff.kind !== 'switch') throw new Error('not a switch')
    expect(saverOff.checked).toBe(true)
    expect(saverOff.disabled).toBeFalsy()
    // Found from Chrome's words and the card's.
    for (const query of ['hover card', 'memory usage', 'preview card']) {
      expect(
        searchRows([model], query).map((r) => r.row.id),
        query
      ).toContain('hover-card-memory')
    }
    // The tablet chrome mounts no hover card: no row there.
    expect(findRow(perf(DESKTOP_STATE(), 'tablet').model.groups, 'hover-card-memory')).toBeNull()
  })

  it('binds Memory Saver’s switch to unloadEnabled with Chrome’s three facts in two sentences that hold the row’s two lines (N1), Zenium named', () => {
    const { model, patches } = perf(DESKTOP_STATE())
    const on = row(model, 'memory-saver')
    if (on.kind !== 'switch') throw new Error('not a switch')
    expect(on.label).toBe('Memory Saver')
    expect(on.description).toBe(
      'Zenium frees up memory from inactive tabs so active tabs and other apps have more resources. Inactive tabs become active again when you go back to them.'
    )
    // Chrome's 214 characters clamped mid-sentence at the 664 column (about 190 fit two lines
    // of 13); this holds with room at narrower columns.
    expect(String(on.description).length).toBeLessThanOrEqual(160)
    expect(on.checked).toBe(true)
    on.onChange(false)
    expect(patches).toEqual([{ unloadEnabled: false }])
  })

  it('maps Chrome’s tiers onto unloadTimeoutMinutes as a radio – Moderate 6 h, Balanced 4 h, Maximum 2 h – and lists the shipped 20 minutes in its place as Custom', () => {
    const { model, patches } = perf(DESKTOP_STATE())
    const tier = row(model, 'memory-saver-tier')
    if (tier.kind !== 'value') throw new Error('not a choice')
    expect(tier.label).toBe('Memory Saver options')
    expect(tier.radios).toBe(true)
    expect(tier.disabled).toBe(false)
    // An existing profile's timer – the shipped 20 minutes – is off Chrome's ladder: shown
    // where it falls, shortest last, and picked (the migration affordance, pr-584 §D (3)); a
    // fresh desktop profile starts on Balanced (`freshPerformanceDefaults`, the core's).
    expect(tier.options.map((o) => [o.value, o.label])).toEqual([
      ['360', 'Moderate'],
      ['240', 'Balanced (recommended)'],
      ['120', 'Maximum'],
      ['20', 'Custom – 20 minutes']
    ])
    expect(tier.value).toBe('20')
    expect(tier.options.map((o) => o.description)).toEqual([
      'Get moderate memory savings. Your tabs become inactive after a longer period of time – 6 hours.',
      'Get balanced memory savings. Your tabs become inactive after an optimal period of time – 4 hours.',
      'Get maximum memory savings. Your tabs become inactive after a shorter period of time – 2 hours.',
      'The timer set before these options; kept until you pick one of them.'
    ])
    tier.onChange('120')
    expect(patches).toEqual([{ unloadTimeoutMinutes: 120 }])

    // On a tier, Chrome's three alone; an off-tier value between two tiers sits between them.
    const onTier = row(
      perf(DESKTOP_STATE({ unloadTimeoutMinutes: 240 })).model,
      'memory-saver-tier'
    )
    if (onTier.kind !== 'value') throw new Error('not a choice')
    expect(onTier.options.map((o) => o.value)).toEqual(['360', '240', '120'])
    expect(onTier.value).toBe('240')
    const between = row(
      perf(DESKTOP_STATE({ unloadTimeoutMinutes: 180 })).model,
      'memory-saver-tier'
    )
    if (between.kind !== 'value') throw new Error('not a choice')
    expect(between.options.map((o) => o.value)).toEqual(['360', '240', '180', '120'])
    expect(between.options[2].label).toBe('Custom – 3 hours')
    const longer = row(
      perf(DESKTOP_STATE({ unloadTimeoutMinutes: 720 })).model,
      'memory-saver-tier'
    )
    if (longer.kind !== 'value') throw new Error('not a choice')
    expect(longer.options.map((o) => o.value)).toEqual(['720', '360', '240', '120'])
  })

  it('lays the tier radio, the sites list and both Add rows out at .4 while Memory Saver is off (§10.4)', () => {
    const { model } = perf(
      DESKTOP_STATE({ unloadEnabled: false, unloadExcludedDomains: ['mail.example.com'] })
    )
    for (const id of [
      'memory-saver-tier',
      'keep-active:mail.example.com',
      'keep-active-add',
      'keep-active-current'
    ]) {
      expect(row(model, id).disabled, id).toBe(true)
    }
    // The list is the switch's one dependent as a whole (the re-read's NEW 2, as ruled): the
    // sites' group – heading, sentence, rows or the empty line – and the Add rows' group both
    // say `disabled`, dimming as one group; neither does while the switch is on.
    expect(model.groups.find((g) => g.id === 'keep-active')?.disabled).toBe(true)
    expect(model.groups.find((g) => g.id === 'keep-active-add')?.disabled).toBe(true)
    const emptyOff = perf(DESKTOP_STATE({ unloadEnabled: false, unloadExcludedDomains: [] }))
    expect(emptyOff.model.groups.find((g) => g.id === 'keep-active')).toMatchObject({
      rows: [],
      empty: 'No sites yet',
      disabled: true
    })
    expect(emptyOff.model.groups.find((g) => g.id === 'keep-active-add')?.disabled).toBe(true)
    const on = perf(DESKTOP_STATE({ unloadExcludedDomains: [] })).model
    expect(on.groups.find((g) => g.id === 'keep-active')?.disabled).toBe(false)
    expect(on.groups.find((g) => g.id === 'keep-active-add')?.disabled).toBe(false)
    // Energy Saver is its own switch: Memory Saver off leaves it alone.
    expect(row(model, 'energy-saver-mode').disabled).toBe(false)
  })

  it('lists the sites kept active alphabetically as item rows with a trailing plain Remove – a preference removed, not data destroyed (§10.4, §10.5; R1) – and says "No sites yet" when there are none (§9.17)', () => {
    const { model, patches } = perf(
      DESKTOP_STATE({ unloadExcludedDomains: ['mail.example.com', 'chat.example'] })
    )
    const list = model.groups.find((g) => g.id === 'keep-active')!
    expect(list.description).toBe(
      'Sites you add will always stay active and memory won’t be freed up from them.'
    )
    expect(list.rows.map((r) => r.id)).toEqual([
      'keep-active:chat.example',
      'keep-active:mail.example.com'
    ])
    const site = list.rows[0] as ItemRow
    expect(site.label).toBe('chat.example')
    // Plain ink on the row's button and on the tablet sheet's row alike, as the permission
    // rows' Forget is: the danger ink is for what destroys the user's data.
    expect(site.action).toEqual({ label: 'Remove', onPress: expect.any(Function) })
    expect(site.action?.destructive).toBeUndefined()
    const remove = row(model, 'keep-active:chat.example:remove')
    if (remove.kind !== 'action') throw new Error('not an action')
    expect(remove.button).toBe('Remove')
    expect(remove.destructive).toBeUndefined()
    remove.onPress?.()
    expect(patches).toEqual([{ unloadExcludedDomains: ['mail.example.com'] }])

    const empty = perf(DESKTOP_STATE({ unloadExcludedDomains: [] })).model
    const none = empty.groups.find((g) => g.id === 'keep-active')!
    expect(none.rows).toEqual([])
    expect(none.empty).toBe('No sites yet')
    expect(groupShows(none)).toBe(true)
  })

  it('adds a site from the Add form cut to its host – scheme, www and path dropped, lower-cased – and never a twin', () => {
    const { model, patches } = perf(DESKTOP_STATE({ unloadExcludedDomains: ['notion.so'] }))
    const add = row(model, 'keep-active-add')
    if (add.kind !== 'action') throw new Error('not an action')
    expect(add.label).toBe('Add a site')
    expect(add.button).toBe('Add…')
    expect(add.form?.title).toBe('Always keep this site active')
    const form = add.form!.render(() => undefined) as ReactElement<{
      id: string
      label: string
      placeholder: string
      action: string
      onSubmit: (raw: string) => void
    }>
    expect(form.props).toMatchObject({
      id: 'keep-active-site',
      label: 'Site',
      placeholder: 'mail.example.com',
      action: 'Add'
    })
    form.props.onSubmit('https://www.Mail.Example.com/inbox?x=1')
    form.props.onSubmit('  ')
    form.props.onSubmit('notion.so')
    form.props.onSubmit('chat.example:8443/room')
    expect(patches).toEqual([
      { unloadExcludedDomains: ['notion.so', 'mail.example.com'] },
      { unloadExcludedDomains: ['notion.so', 'chat.example'] }
    ])
  })

  it('binds Energy Saver’s switch to energySaver – on lands on the host’s fresh-profile default, the 20% threshold where the level reads and unplugged on Windows; off is off – in the user’s words (N3)', () => {
    const { model, patches } = perf(DESKTOP_STATE())
    const on = row(model, 'energy-saver')
    if (on.kind !== 'switch') throw new Error('not a switch')
    expect(on.label).toBe('Energy Saver')
    // Chrome's shape ("conserves battery power by limiting background activity…") with what a
    // background tab feels here; nothing of the governor or its budgets.
    expect(on.description).toBe(
      'Zenium conserves battery power by limiting background activity – background tabs are slowed and unloaded sooner while it is on.'
    )
    expect(String(on.description)).not.toMatch(/governor|budget/)
    expect(on.checked).toBe(true)
    on.onChange(false)
    expect(patches.at(-1)).toEqual({ energySaver: 'off' })

    // Turning on lands on Chrome's default condition (kEnabledBelowThreshold) where the host
    // reads a battery level – Linux's sysfs, macOS's pmset – and on unplugged on Windows, where
    // it cannot yet (`defaultEnergySaverMode`), never on the mode it had before off.
    for (const [platform, lands] of [
      ['linux', 'low-battery'],
      ['darwin', 'low-battery'],
      ['win32', 'on-battery']
    ] as const) {
      const off = perf(DESKTOP_STATE({ energySaver: 'off' }, { platform }))
      const offSwitch = row(off.model, 'energy-saver')
      if (offSwitch.kind !== 'switch') throw new Error('not a switch')
      expect(offSwitch.checked).toBe(false)
      offSwitch.onChange(true)
      expect(off.patches.at(-1), platform).toEqual({ energySaver: lands })
    }
  })

  it('offers Chrome’s two conditions as a radio in Chrome’s order – the 20% threshold, then unplugged – dependent on the switch', () => {
    const { model, patches } = perf(DESKTOP_STATE({ energySaver: 'low-battery' }))
    const mode = row(model, 'energy-saver-mode')
    if (mode.kind !== 'value') throw new Error('not a choice')
    expect(mode.label).toBe('Energy Saver options')
    expect(mode.radios).toBe(true)
    expect(mode.value).toBe('low-battery')
    expect(mode.options.map((o) => [o.value, o.label])).toEqual([
      ['low-battery', 'Turn on only when your battery is at 20% or lower'],
      ['on-battery', 'Turn on when your computer is unplugged']
    ])
    mode.onChange('on-battery')
    expect(patches).toEqual([{ energySaver: 'on-battery' }])

    // Off, the row shows the choice the switch would land on – the host's default.
    for (const [platform, lands] of [
      ['linux', 'low-battery'],
      ['win32', 'on-battery']
    ] as const) {
      const off = row(
        perf(DESKTOP_STATE({ energySaver: 'off' }, { platform })).model,
        'energy-saver-mode'
      )
      if (off.kind !== 'value') throw new Error('not a choice')
      expect(off.disabled).toBe(true)
      expect(off.value, platform).toBe(lands)
    }
  })

  it('hides the Energy Saver group on a desktop the host knows to have no battery (Chrome’s showBatterySettings_) and shows it where the host cannot tell', () => {
    const snapshot = (hasBattery: boolean | null): Partial<UIState> => ({
      resources: {
        ...emptyResourceSnapshot(),
        system: { ...emptyResourceSnapshot().system, hasBattery }
      }
    })
    const none = perf(DESKTOP_STATE({ energySaver: 'on-battery' }, snapshot(false)))
    expect(none.model.groups.map((g) => g.id)).toEqual([
      'memory-saver',
      'keep-active',
      'keep-active-add',
      'hover-card'
    ])
    expect(allRows(none.model.groups).some((r) => r.id.startsWith('energy-saver'))).toBe(false)
    // The mode itself is left as it was: nothing is written for a group not drawn.
    expect(none.patches).toEqual([])
    // A desktop host that cannot tell (Windows without a native module, a host before its first
    // reading) shows it, as one that knows there is a battery does. The tablet is the shell's
    // gate above, whatever its host says.
    for (const hasBattery of [null, true]) {
      const { model } = perf(DESKTOP_STATE({}, snapshot(hasBattery)))
      expect(model.groups.at(-1)?.id).toBe('energy-saver')
      expect(findRow(model.groups, 'energy-saver-mode')).not.toBeNull()
    }
    expect(emptyResourceSnapshot().system.hasBattery).toBeNull()
  })

  it('says under the threshold row when the host cannot read the battery level – Windows without a native module, a computer with no battery', () => {
    const snapshot = (batteryPercent: number | null): Partial<UIState> => ({
      resources: {
        ...emptyResourceSnapshot(),
        system: { ...emptyResourceSnapshot().system, batteryPercent }
      }
    })
    const threshold = (s: UIState): string | undefined => {
      const mode = row(perf(s).model, 'energy-saver-mode')
      if (mode.kind !== 'value') throw new Error('not a choice')
      return mode.options[0].description
    }
    expect(threshold(DESKTOP_STATE({}, snapshot(63)))).toBeUndefined()
    expect(threshold(DESKTOP_STATE({}, { ...snapshot(null), platform: 'win32' }))).toBe(
      'Zenium cannot read the battery level on Windows yet, so this option waits until it can.'
    )
    expect(threshold(DESKTOP_STATE({}, { ...snapshot(null), platform: 'linux' }))).toBe(
      'No battery level to read on this computer, so this option waits until there is one.'
    )
  })

  it('keeps Energy Saver’s effect beside it – the budget factor the governor applies while it is on – with nothing live in the row: no "is on now", no battery reading, whatever the mode does (NEW 3, as ruled)', () => {
    const { model, patches } = perf(DESKTOP_STATE())
    const factor = row(model, 'energy-saver-factor')
    if (factor.kind !== 'value') throw new Error('not a choice')
    expect(factor.label).toBe('While Energy Saver is on, shrink the budgets to')
    expect(factor.radios).toBeUndefined()
    expect(factor.value).toBe(String(Math.round(DEFAULT_SETTINGS.resources.batteryFactor * 100)))
    expect(factor.options.map((o) => o.value)).toEqual(['100', '85', '70', '50', '25'])
    expect(factor.description).toBeUndefined()
    factor.onChange('50')
    expect(patches).toEqual([{ resources: { ...DEFAULT_SETTINGS.resources, batteryFactor: 0.5 } }])

    // The row is its one line of 40 in every state of the host: on, waiting on battery at a
    // level, on battery with no level, unplugged – the page does not shift when the mode flips
    // (Chrome's Performance page carries no state sentence; the leaf and its bubble say it).
    const system = (patch: Partial<UIState['resources']['system']>): Partial<UIState> => ({
      resources: {
        ...emptyResourceSnapshot(),
        system: { ...emptyResourceSnapshot().system, ...patch }
      }
    })
    const hosts: readonly [Partial<Settings>, Partial<UIState>][] = [
      [{}, system({ onBattery: true, energySaver: true })],
      [{ energySaver: 'low-battery' }, system({ onBattery: true, batteryPercent: 63 })],
      [{ energySaver: 'low-battery' }, system({ onBattery: true })],
      [{ energySaver: 'on-battery' }, system({ onBattery: false, batteryPercent: 100 })]
    ]
    for (const [settings, host] of hosts) {
      const r = row(perf(DESKTOP_STATE(settings, host)).model, 'energy-saver-factor')
      expect(r.description, JSON.stringify([settings, host.resources?.system])).toBeUndefined()
      expect(r.tone).toBeUndefined()
    }
    expect(
      row(perf(DESKTOP_STATE({ energySaver: 'off' })).model, 'energy-saver-factor').disabled
    ).toBe(true)
  })

  it('leaves Resources one owner short: its twin switch, the after field, the battery factor and the excluded-domains fact went; a chevron row leads to Performance (§9.1)', () => {
    const c = context(DESKTOP_STATE(), true)
    const resources = buildSection(
      PAGE.sections.find((x) => x.id === 'resources')!,
      {
        ...c.ctx,
        formFactor: 'desktop'
      }
    )
    for (const gone of [
      'resources-unload',
      'resources-unload-after',
      'battery-factor',
      'protect-domains'
    ]) {
      expect(findRow(resources.groups, gone), gone).toBeNull()
    }
    const sleeping = resources.groups.find((g) => g.id === 'sleeping')!
    expect(sleeping.rows[0].id).toBe('resources-performance')
    const link = row(resources, 'resources-performance')
    if (link.kind !== 'action') throw new Error('not an action')
    expect(link.label).toBe('Memory Saver and Energy Saver')
    expect(link.leaves).toBe('chevron')
    expect(link.button).toBeUndefined()
    link.onPress?.()
    expect(c.navigated).toEqual(['performance'])
    expect(c.patches).toEqual([])
    // The usage note names the mode, not the plug.
    expect(allRows(resources.groups).some((r) => r.label === 'On battery, shrink budgets to')).toBe(
      false
    )
  })

  it('finds the section from Chrome’s words and the governor’s', () => {
    const { model } = perf(DESKTOP_STATE({ unloadExcludedDomains: ['mail.example.com'] }))
    for (const [query, id] of [
      ['memory saver', 'memory-saver'],
      ['discard', 'memory-saver-tier'],
      ['keep active', 'keep-active:mail.example.com'],
      ['energy saver', 'energy-saver'],
      ['unplugged', 'energy-saver-mode'],
      ['shrink', 'energy-saver-factor']
    ] as const) {
      expect(
        searchRows([model], query).map((r) => r.row.id),
        query
      ).toContain(id)
    }
  })
})

describe('TAB-20 / SET-34: inactive tabs in Tab Management on a phone, beside sleeping tabs, in Chrome’s words', () => {
  it('is a group of its own after the sleeping-tabs groups: the threshold as a value row on Chrome’s ladder and the auto-close switch, off at .4 while the threshold is Never', () => {
    const c = context()
    const tabs = buildSection(
      PAGE.sections.find((x) => x.id === 'tabs')!,
      {
        ...c.ctx,
        formFactor: 'phone'
      }
    )
    const ids = tabs.groups.map((g) => g.id)
    expect(ids.indexOf('inactive-tabs')).toBe(ids.indexOf('never-sleep-add') + 1)
    const group = tabs.groups.find((g) => g.id === 'inactive-tabs')
    expect(group?.heading).toBe('Inactive tabs')
    // The description tells the two apart: a sleeping tab keeps its place in the grid.
    expect(group?.description).toContain('Sleeping tabs stay in the grid')
    expect(group?.rows.map((r) => r.id)).toEqual([
      'inactive-tabs-after',
      'inactive-tabs-auto-close'
    ])

    const after = row(tabs, 'inactive-tabs-after')
    if (after.kind !== 'value') throw new Error('not a choice')
    expect(after.label).toBe('Move to inactive')
    expect(after.options.map((o) => o.label)).toEqual([
      'Never',
      'After 7 days inactive',
      'After 14 days inactive',
      'After 21 days inactive'
    ])
    // Chrome 152's default.
    expect(after.value).toBe('21')
    after.onChange('7')
    expect(c.patches.at(-1)).toEqual({ inactiveTabsArchiveDays: 7 })
    after.onChange('0')
    expect(c.patches.at(-1)).toEqual({ inactiveTabsArchiveDays: 0 })

    const autoClose = row(tabs, 'inactive-tabs-auto-close')
    if (autoClose.kind !== 'switch') throw new Error('not a switch')
    expect(autoClose.label).toBe('Automatically close inactive tabs')
    expect(autoClose.description).toBe('Inactive tabs are closed after 3 months')
    // The period is the core's constant (Chrome 152's 90 days) read in months as Chrome counts
    // them, not a second copy of the number.
    expect(autoClose.description).toBe(autoCloseDescription(INACTIVE_TAB_AUTO_CLOSE_DAYS))
    expect(autoCloseDescription(60)).toBe('Inactive tabs are closed after 2 months')
    expect(autoCloseDescription(30)).toBe('Inactive tabs are closed after 1 month')
    expect(autoClose.checked).toBe(true)
    expect(autoClose.disabled).toBe(false)
    autoClose.onChange(false)
    expect(c.patches.at(-1)).toEqual({ inactiveTabsAutoClose: false })

    // Never: nothing is archived, so the sweep's switch is a dependent row (§10.4), as Chrome
    // greys it; the value row itself stays live, it is the way back.
    const never = buildSection(
      PAGE.sections.find((x) => x.id === 'tabs')!,
      {
        ...context(state({}, { inactiveTabsArchiveDays: 0 })).ctx,
        formFactor: 'phone'
      }
    )
    expect(row(never, 'inactive-tabs-after').disabled).toBeUndefined()
    expect(row(never, 'inactive-tabs-auto-close').disabled).toBe(true)
  })

  it('exists only where the archive does (the capability), and only on the phone shell', () => {
    const def = PAGE.sections.find((x) => x.id === 'tabs')!
    const without = state({ capabilities: { ...ANDROID, inactiveTabs: false } })
    expect(section('tabs', without).groups.map((g) => g.id)).not.toContain('inactive-tabs')
    for (const layout of ['desktop', 'tablet'] as const) {
      const shell = buildSection(def, { ...context().ctx, formFactor: layout })
      expect(shell.groups.map((g) => g.id)).not.toContain('inactive-tabs')
    }
  })
})

describe('the Keyboard Shortcuts listing by layout', () => {
  it('lists Web Capture on the desktop shell alone; the tablet, whose chord takes a screenshot, leaves the row out and keeps the rest', () => {
    const def = PAGE.sections.find((x) => x.id === 'shortcuts')!
    const c = context(state({ platform: 'linux', shortcuts: defaultShortcuts('linux', 'chrome') }))
    const ids = (layout: FormFactor): string[] =>
      buildSection(def, { ...c.ctx, formFactor: layout })
        .groups.filter((g) => g.id === 'shortcuts-pageOperations')
        .flatMap((g) => g.rows.map((r) => r.id))
    expect(ids('desktop')).toContain('shortcut:key_webCapture')
    expect(ids('desktop')).toContain('shortcut:key_screenshot')
    expect(ids('tablet')).not.toContain('shortcut:key_webCapture')
    expect(ids('tablet')).toContain('shortcut:key_screenshot')
    expect(ids('tablet')).toHaveLength(ids('desktop').length - 1)
  })
})

describe('ID-08’s Sync category on a phone', () => {
  const TREE = 'content://com.android.externalstorage.documents/tree/primary%3ADrive%2FZenium'

  function syncStatus(patch: Partial<SyncStatus> = {}): SyncStatus {
    return {
      enabled: false,
      folder: null,
      folderName: null,
      folderLost: false,
      deviceId: 'dev-1',
      deviceName: 'Pixel 8',
      scope: defaultScope(),
      lastSyncAt: null,
      lastError: null,
      lastErrorKind: null,
      syncing: false,
      devices: [],
      pendingMerge: false,
      remoteTabsVersion: 0,
      transport: 'folder',
      webdav: null,
      webdavAvailable: false,
      authRefused: false,
      accountAvailable: false,
      account: null,
      accountLink: null,
      accountLinkFailure: null,
      accountSignedOut: false,
      ...patch
    }
  }

  function connected(patch: Partial<SyncStatus> = {}): SyncStatus {
    return syncStatus({
      enabled: true,
      folder: TREE,
      folderName: 'Zenium',
      lastSyncAt: Date.now() - 5 * 60_000,
      devices: [
        // The laptop's build announced no kind; the desktop's did (services pass 4).
        { id: 'dev-2', name: 'Work laptop', lastSeen: Date.now() - 2 * 3_600_000 },
        { id: 'dev-3', name: 'Home desktop', lastSeen: Date.now() - 60_000, kind: 'desktop' }
      ],
      ...patch
    })
  }

  function syncState(sync: SyncStatus): UIState {
    return state({ capabilities: { ...ANDROID, sync: true }, sync } as Partial<UIState>)
  }

  beforeEach(() => clearSyncSetup())
  afterEach(() => clearSyncSetup())

  it('is listed behind the `sync` capability only, and builds in both states with unique ids', () => {
    expect(phoneSections().map((m) => m.section.id)).not.toContain('sync')
    const listed = phoneSections(syncState(syncStatus())).map((m) => m.section.id)
    expect(listed).toContain('sync')
    for (const status of [
      syncStatus(),
      connected(),
      connected({ folderLost: true, lastError: 'The sync folder is no longer accessible' }),
      connected({ pendingMerge: true })
    ]) {
      const model = section('sync', syncState(status))
      expect(model.groups.length).toBeGreaterThan(0)
      expect(model.groups.every(groupShows)).toBe(true)
      const ids = allRows(model.groups).map((r) => r.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const r of allRows(model.groups)) expect(r.label, r.id).not.toBe('')
    }
  })

  it('before setup: the folder row, the device name and Turn on sync – laid out at 40 % until a folder is chosen – then What you sync', async () => {
    const model = section('sync', syncState(syncStatus()))
    expect(model.groups.map((g) => g.id)).toEqual(['sync-setup', 'sync-scope'])
    expect(model.groups[0]?.heading).toBe('Set up sync')
    expect(model.groups[0]?.rows.map((r) => r.id)).toEqual([
      'sync-folder',
      'sync-device-name',
      'sync-turn-on'
    ])
    const folder = row(model, 'sync-folder')
    expect(folder).toMatchObject({
      kind: 'action',
      label: 'Sync folder',
      description: 'Choose a folder that your cloud drive keeps in sync.',
      // The invitation is prose (§9.2's two lines); only a chosen folder is a path.
      address: false
    })
    const turnOn = row(model, 'sync-turn-on')
    if (turnOn.kind !== 'action') throw new Error('not an action')
    expect(turnOn.disabled).toBe(true)
    expect(turnOn.description).toBe('Choose a sync folder first.')
    expect(turnOn.form?.title).toBe('Create a passphrase')
    expect(turnOn.form?.description).toMatch(/^Zenium uses your passphrase to encrypt your data\./)
    // Nothing to render inside the sheet without a folder.
    expect(turnOn.form?.render(() => undefined)).toBeNull()

    // The system picker: a dismissed one keeps the draft as it was, a chosen tree becomes the
    // folder row's description (its display name, as the Downloads folder row shows its own).
    if (folder.kind !== 'action') throw new Error('not an action')
    invoke.mockResolvedValueOnce(null)
    folder.onPress?.()
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledWith('sync.chooseFolder', undefined)
    expect(syncSetupStore.get().folder).toBeNull()
    invoke.mockResolvedValueOnce(TREE as never)
    folder.onPress?.()
    await new Promise((r) => setTimeout(r, 0))
    expect(syncSetupStore.get().folder).toBe(TREE)

    const chosen = section('sync', syncState(syncStatus()))
    expect(row(chosen, 'sync-folder').description).toBe('Drive/Zenium')
    // …one line kept from its end, as every path the settings show (§9.2's exception).
    expect(row(chosen, 'sync-folder').address).toBe(true)
    const ready = row(chosen, 'sync-turn-on')
    if (ready.kind !== 'action') throw new Error('not an action')
    expect(ready.disabled).toBe(false)
    expect(ready.description).toBe('Create the passphrase every device will share.')
    expect(ready.form?.render(() => undefined)).not.toBeNull()

    // The device name is a one-field sheet; a changed name is sent, the same one is not.
    const name = row(chosen, 'sync-device-name')
    if (name.kind !== 'field') throw new Error('not a field')
    expect(name).toMatchObject({ label: 'This device', value: 'Pixel 8', input: 'text' })
    invoke.mockClear()
    name.onCommit('Pixel 8')
    expect(invoke).not.toHaveBeenCalled()
    name.onCommit('Ben’s phone')
    expect(invoke).toHaveBeenCalledWith('sync.setDeviceName', { name: 'Ben’s phone' })
  })

  it('What you sync: one switch per data type in Chrome’s order, Bookmarks, History, Open tabs, Passwords, Addresses, Payment methods, Reading list, Settings first, then Zenium’s own; each runs sync.setScope', () => {
    const model = section('sync', syncState(syncStatus()))
    const scope = model.groups.find((g) => g.id === 'sync-scope')
    expect(scope?.heading).toBe('What you sync')
    expect(scope?.rows.map((r) => r.label).slice(0, 8)).toEqual([
      'Bookmarks',
      'History',
      'Open tabs',
      'Passwords',
      'Addresses',
      'Payment methods',
      'Reading list',
      'Settings'
    ])
    // Every key of the engine's scope is a switch here, once – on a host that has what the key
    // names: the Extensions row (ID-44) sits behind the `extensions` capability, and this
    // fixture's phone has none, so the list is every row but that one.
    const keys = SYNC_SCOPES.map((s) => s.key)
    expect([...keys].sort()).toEqual(Object.keys(defaultScope()).sort())
    expect(SYNC_SCOPES.filter((s) => s.requires).map((s) => [s.key, s.requires])).toEqual([
      ['extensions', 'extensions']
    ])
    expect(scope?.rows.map((r) => r.id)).toEqual(
      keys.filter((k) => k !== 'extensions').map((k) => `sync-scope:${k}`)
    )
    const openTabs = row(model, 'sync-scope:openTabs')
    if (openTabs.kind !== 'switch') throw new Error('not a switch')
    expect(openTabs.checked).toBe(false)
    const passwords = row(model, 'sync-scope:passwords')
    if (passwords.kind !== 'switch') throw new Error('not a switch')
    expect(passwords.checked).toBe(true)
    passwords.onChange(false)
    expect(invoke).toHaveBeenCalledWith('sync.setScope', { passwords: false })
    // The vault's addresses and payment methods (services pass 16, ID-45; the lead's ruling on
    // #712): a row each right after Passwords, Chrome's "Addresses and more" and "Payment
    // methods" as the two types they are; on by default as Passwords; one scope key each, so a
    // switch gates its own type alone; and the one hint on both – the fact the name cannot
    // carry, that the entries travel under the folder's passphrase like the logins.
    const addresses = row(model, 'sync-scope:addresses')
    if (addresses.kind !== 'switch') throw new Error('not a switch')
    expect(addresses.checked).toBe(true)
    expect(addresses.description).toBe('Encrypted with your sync passphrase.')
    addresses.onChange(false)
    expect(invoke).toHaveBeenCalledWith('sync.setScope', { addresses: false })
    expect(invoke).not.toHaveBeenCalledWith('sync.setScope', { paymentMethods: false })
    const paymentMethods = row(model, 'sync-scope:paymentMethods')
    if (paymentMethods.kind !== 'switch') throw new Error('not a switch')
    expect(paymentMethods.checked).toBe(true)
    expect(paymentMethods.description).toBe('Encrypted with your sync passphrase.')
    paymentMethods.onChange(false)
    expect(invoke).toHaveBeenCalledWith('sync.setScope', { paymentMethods: false })
    // Passwords' own hint stands as it was: the two rows took nothing from it.
    expect(passwords.description).toBe(
      'Saved passwords and passkey records, encrypted with your sync passphrase.'
    )
    // History is on by default, as Chrome's (ID-13).
    const history = row(model, 'sync-scope:history')
    if (history.kind !== 'switch') throw new Error('not a switch')
    expect(history.checked).toBe(true)
    history.onChange(false)
    expect(invoke).toHaveBeenCalledWith('sync.setScope', { history: false })
    // The reading list is on by default too, as the bookmarks (services pass 11, ID-48); its
    // row is the label and the switch alone, as Bookmarks' and History's (the lead's rule: a
    // hint carries a fact the name cannot, never a restatement).
    const readingList = row(model, 'sync-scope:readingList')
    if (readingList.kind !== 'switch') throw new Error('not a switch')
    expect(readingList.checked).toBe(true)
    expect(readingList.description).toBeUndefined()
    readingList.onChange(false)
    expect(invoke).toHaveBeenCalledWith('sync.setScope', { readingList: false })
    // The Mods (services pass 15, ID-43): on by default as Chrome's Themes type is a toggle of
    // its own; the row is the label and the switch alone, seated last, after Boosts – the
    // chrome's CSS mods beside the per-site Boosts, Zenium's own types together.
    expect(scope?.rows.map((r) => r.label).slice(-2)).toEqual(['Boosts', 'Mods'])
    const mods = row(model, 'sync-scope:mods')
    if (mods.kind !== 'switch') throw new Error('not a switch')
    expect(mods.checked).toBe(true)
    expect(mods.description).toBeUndefined()
    mods.onChange(false)
    expect(invoke).toHaveBeenCalledWith('sync.setScope', { mods: false })
    // The same group, same order, once connected.
    const on = section('sync', syncState(connected()))
    expect(on.groups.find((g) => g.id === 'sync-scope')?.rows.map((r) => r.id)).toEqual(
      scope?.rows.map((r) => r.id)
    )
  })

  it('What you sync › Extensions (services pass 16, ID-44): on every host that installs extensions, after Settings and before Spaces (the lead’s seat), on by default, the lead’s label and hint verbatim; absent where the host has no extensions', () => {
    // A host with extensions – the desktop, or a phone whose build installs them.
    const withExtensions = (sync: SyncStatus): UIState =>
      state({
        capabilities: { ...ANDROID, sync: true, extensions: true },
        sync
      } as Partial<UIState>)
    for (const status of [syncStatus(), connected()]) {
      const model = section('sync', withExtensions(status))
      const scope = model.groups.find((g) => g.id === 'sync-scope')
      expect(scope?.rows.map((r) => r.id)).toEqual(SYNC_SCOPES.map((s) => `sync-scope:${s.key}`))
      // The seat (the lead's ruling, round 4): the last of Chrome's types – right after
      // Settings, right before Spaces – not among Zenium's own after Mods, which stay last.
      const labels = scope?.rows.map((r) => r.label) ?? []
      expect(labels.slice(7, 10)).toEqual(['Settings', 'Extensions', 'Spaces'])
      expect(labels.slice(-2)).toEqual(['Boosts', 'Mods'])
      expect(labels.indexOf('Extensions')).toBe(labels.indexOf('Settings') + 1)
      expect(labels.indexOf('Spaces')).toBe(labels.indexOf('Extensions') + 1)
      const extensions = row(model, 'sync-scope:extensions')
      if (extensions.kind !== 'switch') throw new Error('not a switch')
      expect(extensions.label).toBe('Extensions')
      expect(extensions.description).toBe(
        'Store extensions and whether they are enabled and pinned; unpacked ones stay on this device.'
      )
      expect(extensions.checked).toBe(true)
      expect(defaultScope().extensions).toBe(true)
      invoke.mockClear()
      extensions.onChange(false)
      expect(invoke).toHaveBeenCalledWith('sync.setScope', { extensions: false })
    }
    // Off in the engine's scope: the switch shows it off.
    const off = section(
      'sync',
      withExtensions(connected({ scope: { ...defaultScope(), extensions: false } }))
    )
    const offRow = row(off, 'sync-scope:extensions')
    if (offRow.kind !== 'switch') throw new Error('not a switch')
    expect(offRow.checked).toBe(false)
    // A host without extensions has no row for the type, before setup and connected alike.
    for (const status of [syncStatus(), connected()]) {
      const model = section('sync', syncState(status))
      expect(allRows(model.groups).map((r) => r.id)).not.toContain('sync-scope:extensions')
      expect(allRows(model.groups).map((r) => r.label)).not.toContain('Extensions')
    }
  })

  it('connected: the status with Sync now, the folder and device, the other devices newest first with their last-seen time, the toggles, and Turn off sync', async () => {
    const model = section('sync', syncState(connected()))
    expect(model.groups.map((g) => g.id)).toEqual([
      'sync-status',
      'sync-where',
      'sync-devices',
      'sync-scope',
      'sync-off'
    ])
    expect(model.groups[0]?.rows.map((r) => r.id)).toEqual(['sync-now'])
    const now = row(model, 'sync-now')
    if (now.kind !== 'action') throw new Error('not an action')
    expect(now).toMatchObject({ label: 'Sync now', busy: false, disabled: false })
    expect(now.description).toBe('Last synced 5 min ago')
    expect(now.tone).toBeUndefined()
    now.onPress?.()
    expect(invoke).toHaveBeenCalledWith('sync.now', undefined)
    // After the phrase the age is lower case (§9.1); "Just now" keeps its capital only where it
    // opens a line of its own, the device rows'.
    const fresh = row(section('sync', syncState(connected({ lastSyncAt: Date.now() }))), 'sync-now')
    expect(fresh.description).toBe('Last synced just now')

    // The folder row shows the tree's display name and re-chooses through the picker; the chosen
    // tree goes to the engine at once (there is no draft once sync is on).
    const folder = row(model, 'sync-folder')
    if (folder.kind !== 'action') throw new Error('not an action')
    expect(folder.description).toBe('Zenium')
    invoke.mockResolvedValueOnce(`${TREE}2` as never)
    folder.onPress?.()
    await new Promise((r) => setTimeout(r, 0))
    expect(invoke).toHaveBeenCalledWith('sync.chooseFolder', undefined)
    expect(invoke).toHaveBeenCalledWith('sync.setFolder', { folder: `${TREE}2` })
    expect(syncSetupStore.get().folder).toBeNull()

    const devices = model.groups.find((g) => g.id === 'sync-devices')
    expect(devices?.heading).toBe('Other devices')
    expect(devices?.aside).toBe('2')
    // The devices, then the row that opens their tabs (ID-28, pinned below).
    expect(devices?.rows.map((r) => [r.kind, r.label])).toEqual([
      ['info', 'Home desktop'],
      ['info', 'Work laptop'],
      ['item', 'Tabs from other devices']
    ])
    for (const r of devices?.rows ?? []) {
      if (r.kind !== 'info') continue
      expect(r.trailing).toBeTruthy()
    }
    // Each device row leads with the device's kind glyph (services pass 4; §10.4's leading slot
    // at the full ink): the desktop's laptop – Chrome's one computer glyph – and for the laptop
    // – whose build announced no kind – the stand-in at 69 %. The kind is searchable with the
    // row.
    const glyphOf = (m: Model, id: string): { kind: string | null; standin: boolean } => {
      const r = row(m, id)
      if (r.kind !== 'info' || !isValidElement(r.leading)) throw new Error(`no glyph on ${id}`)
      const markup = renderToStaticMarkup(r.leading)
      return {
        kind: /data-kind="([^"]+)"/.exec(markup)?.[1] ?? null,
        standin: markup.includes('zen-list-standin')
      }
    }
    expect(glyphOf(model, 'sync-device:dev-3')).toEqual({ kind: 'desktop', standin: false })
    expect(glyphOf(model, 'sync-device:dev-2')).toEqual({ kind: 'none', standin: true })
    expect(row(model, 'sync-device:dev-3').keywords).toContain('desktop')
    // A list in which no device announced a kind – every peer an older build – has no glyph
    // column at all (§10.4's condition, `anyDeviceKind`; the #453 lead check): no `leading` on
    // any device row, so the names stand at the gutter rather than behind a column of stand-ins.
    const bare = section(
      'sync',
      syncState(
        connected({
          devices: [
            { id: 'dev-2', name: 'Work laptop', lastSeen: Date.now() - 2 * 3_600_000 },
            { id: 'dev-3', name: 'Home desktop', lastSeen: Date.now() - 60_000 }
          ]
        })
      )
    )
    for (const id of ['sync-device:dev-3', 'sync-device:dev-2']) {
      const r = row(bare, id)
      if (r.kind !== 'info') throw new Error('not an info row')
      expect(r.leading, id).toBeUndefined()
      expect(r.trailing, id).toBeTruthy()
    }
    // The action row under the device run stands under the builder's hairline (the #453 lead
    // check): the run's glyphs and the row's plain label part there, and the one `--v2-border`
    // line closes the run – a separator, no glyph or empty slot drawn for alignment.
    expect(row(model, 'sync-remote-tabs').hairline).toBe(true)
    expect(row(bare, 'sync-remote-tabs').hairline).toBe(true)
    for (const r of devices?.rows ?? []) {
      if (r.kind === 'info') expect(r.hairline, r.id).toBeUndefined()
    }

    const off = model.groups.find((g) => g.id === 'sync-off')
    expect(off?.heading).toBeNull()
    const turnOff = row(model, 'sync-disconnect')
    if (turnOff.kind !== 'action') throw new Error('not an action')
    expect(turnOff).toMatchObject({ label: 'Turn off sync', destructive: true })
    expect(turnOff.form?.title).toBe('Turn off sync?')
  })

  it('Tabs from other devices (ID-28): an item row after the devices with the list’s summary, a dependent of the Open tabs switch and disabled with nothing to open; its sheet lists each device’s tabs as rows a tap opens', () => {
    const { remoteTabsStore } = remoteTabs
    const openTabs = { ...defaultScope(), openTabs: true }
    const laptop = {
      deviceId: 'dev-2',
      deviceName: 'Work laptop',
      updatedAt: Date.now() - 60_000,
      tabs: [
        {
          tabId: 't1',
          url: 'https://example.com/docs/page',
          title: 'Example docs',
          favicon: 'https://example.com/favicon.ico',
          lastActive: Date.now() - 2 * 60_000,
          windowId: null
        },
        {
          tabId: 't2',
          url: 'https://news.example.org/',
          title: '',
          favicon: null,
          lastActive: Date.now() - 3 * 3_600_000,
          windowId: 'w1'
        }
      ]
    }
    const desktop = {
      deviceId: 'dev-3',
      deviceName: 'Home desktop',
      updatedAt: Date.now() - 10_000,
      tabs: []
    }
    try {
      // Open tabs off in What you sync: the row stays laid out at 40 % and says which switch (§10.4).
      const off = row(section('sync', syncState(connected())), 'sync-remote-tabs')
      if (off.kind !== 'item') throw new Error('not an item row')
      expect(off).toMatchObject({
        label: 'Tabs from other devices',
        description: 'Turn on Open tabs in What you sync to see them.',
        disabled: true
      })
      expect(off.sheet.groups).toEqual([])

      // On, with nothing published yet: the empty sentence, and no empty sheet to open (§9.17).
      remoteTabsStore.set({ version: 0, devices: [] })
      const none = row(
        section('sync', syncState(connected({ scope: openTabs }))),
        'sync-remote-tabs'
      )
      expect(none).toMatchObject({
        description: 'No open tabs on your other devices yet.',
        disabled: true
      })

      // The list: the summary counts the tabs and the devices that have any.
      remoteTabsStore.set({ version: 1, devices: [laptop, desktop] })
      const model = section('sync', syncState(connected({ scope: openTabs })))
      const on = row(model, 'sync-remote-tabs')
      if (on.kind !== 'item') throw new Error('not an item row')
      expect(on).toMatchObject({ description: '2 tabs on 1 device', disabled: false })
      expect(on.sheet.title).toBe('Tabs from other devices')
      // One §10.3 group per device, the most recently published first, its count as the aside;
      // a device with no web tab open keeps its heading over the group's empty line.
      expect(on.sheet.groups.map((g) => [g.heading, g.aside, g.rows.length])).toEqual([
        ['Home desktop', '0', 0],
        ['Work laptop', '2', 2]
      ])
      expect(on.sheet.groups[0]?.empty).toBe('No open tabs on this device')
      // A tab: its title (the address when it has none) over "host · when it was last in front",
      // the favicon leading every row; a press opens the tab here once the sheet has gone.
      const rows = on.sheet.groups[1]?.rows ?? []
      expect(rows.map((r) => [r.kind, r.label, r.description])).toEqual([
        ['action', 'Example docs', 'example.com · 2 min ago'],
        ['action', 'news.example.org', 'news.example.org · 3 h ago']
      ])
      for (const r of rows) {
        if (r.kind !== 'action') throw new Error('not an action')
        expect(r.leading).toBeTruthy()
        expect(r.closesSheet).toBe(true)
        expect(r.leaves).toBeUndefined()
        // The title is the page's, any length: one line, truncating from the end (§6).
        expect(r.truncate).toBe(true)
      }
      const first = rows[0]
      if (first?.kind !== 'action') throw new Error('not an action')
      invoke.mockClear()
      first.onPress?.()
      expect(invoke).toHaveBeenCalledWith('tab.create', {
        url: 'https://example.com/docs/page',
        active: true
      })
      // A tab this device already holds under the same id (the Open tabs scope carried its
      // record, ID-10): its row brings that tab to the front rather than opening a second one.
      remoteTabsStore.set({
        version: 2,
        devices: [{ ...laptop, tabs: [{ ...laptop.tabs[0]!, tabId: 'site' }] }]
      })
      const heldRow = row(
        section('sync', syncState(connected({ scope: openTabs }))),
        'sync-remote-tabs'
      )
      if (heldRow.kind !== 'item') throw new Error('not an item row')
      const held = heldRow.sheet.groups[0]?.rows[0]
      if (held?.kind !== 'action') throw new Error('not an action')
      invoke.mockClear()
      held.onPress?.()
      expect(invoke).toHaveBeenCalledWith('tab.activate', { tabId: 'site' })
      expect(invoke).not.toHaveBeenCalledWith('tab.create', expect.anything())
      remoteTabsStore.set({ version: 1, devices: [laptop, desktop] })
      // The sheet's rows are the item's, reachable by id as any item sheet's rows are; the
      // landing's search does not walk them (hundreds of tabs would flood it), the row itself is found.
      expect(findRow(model.groups, 'sync-remote-tab:dev-2:t1')).toBe(first)
      const hits = searchRows(
        phoneSections(syncState(connected({ scope: openTabs }))),
        'other devices'
      )
      expect(hits.map((h) => h.row.id)).toContain('sync-remote-tabs')
      expect(hits.map((h) => h.row.id)).not.toContain('sync-remote-tab:dev-2:t1')
      // The summary's grammar: one tab, one device.
      remoteTabsStore.set({ version: 2, devices: [{ ...laptop, tabs: laptop.tabs.slice(0, 1) }] })
      expect(
        row(section('sync', syncState(connected({ scope: openTabs }))), 'sync-remote-tabs')
          .description
      ).toBe('1 tab on 1 device')
      // No other device: nothing to list, so the row is not drawn disabled on the first screen (§10.4).
      expect(
        findRow(
          section('sync', syncState(connected({ devices: [], scope: openTabs }))).groups,
          'sync-remote-tabs'
        )
      ).toBeNull()
    } finally {
      remoteTabsStore.set({ version: -1, devices: [] })
    }
  })

  it('says so where the device list is empty, says Syncing… and is busy while a sync runs, and shows the engine’s error in the danger ink', () => {
    const empty = section('sync', syncState(connected({ devices: [] })))
    const devices = empty.groups.find((g) => g.id === 'sync-devices')
    expect(devices?.rows).toEqual([])
    // The heading's count reads 0 rather than disappearing (§9.17; the lead's nit 2 on #261).
    expect(devices?.aside).toBe('0')
    expect(devices?.empty).toBe('No other device has synced to this folder yet')

    const first = row(section('sync', syncState(connected({ lastSyncAt: null }))), 'sync-now')
    expect(first.description).toBe('Waiting for first sync')

    const busy = row(section('sync', syncState(connected({ syncing: true }))), 'sync-now')
    if (busy.kind !== 'action') throw new Error('not an action')
    expect(busy.busy).toBe(true)
    expect(busy.description).toBe('Syncing…')

    const failed = row(
      section('sync', syncState(connected({ lastError: 'Could not read the folder' }))),
      'sync-now'
    )
    expect(failed).toMatchObject({ description: 'Could not read the folder', tone: 'danger' })
  })

  it('the folder-lost notice is a §9.17 / §9.33 message row over the folder row: an info row in the danger ink with its glyph trailing, nothing pressable; Sync now waits', () => {
    const model = section(
      'sync',
      syncState(
        connected({
          folderLost: true,
          lastError: 'The sync folder is no longer accessible. Choose it again to keep syncing.'
        })
      )
    )
    expect(model.groups[0]?.rows.map((r) => r.id)).toEqual(['sync-folder-lost', 'sync-now'])
    const notice = row(model, 'sync-folder-lost')
    if (notice.kind !== 'info') throw new Error('not an info row')
    expect(notice).toMatchObject({
      label: 'The sync folder is no longer accessible',
      description: 'Choose it again to keep syncing.',
      tone: 'danger'
    })
    // A lone status row trails its 16 glyph (§9.33; never leading in a group whose other row,
    // Sync now, has none – §10.4's mixing rule), and the glyph takes the danger ink through the
    // row's one tone: no ink class of its own.
    expect(notice.leading).toBeUndefined()
    if (!isValidElement<{ className?: string }>(notice.trailing)) throw new Error('no glyph')
    expect(notice.trailing.props.className).toBe('zen-settings-trailing-glyph')
    // The status line does not repeat the sentence the row above already says.
    const now = row(model, 'sync-now')
    if (now.kind !== 'action') throw new Error('not an action')
    expect(now.disabled).toBe(true)
    expect(now.description).toBe('Last synced 5 min ago')
    expect(now.tone).toBeUndefined()
    // The folder row is the way out.
    expect(row(model, 'sync-folder').kind).toBe('action')
  })

  it('the first sync’s merge question is a row with its sheet while it stands; Sync now waits on it', () => {
    const model = section('sync', syncState(connected({ pendingMerge: true, lastSyncAt: null })))
    expect(model.groups[0]?.rows.map((r) => r.id)).toEqual(['sync-merge', 'sync-now'])
    const merge = row(model, 'sync-merge')
    if (merge.kind !== 'action') throw new Error('not an action')
    expect(merge.label).toBe('This folder already has synced data')
    expect(merge.form?.title).toBe('Combine with the data in this folder?')
    const now = row(model, 'sync-now')
    if (now.kind !== 'action') throw new Error('not an action')
    expect(now.disabled).toBe(true)
    expect(section('sync', syncState(connected())).groups[0]?.rows.map((r) => r.id)).toEqual([
      'sync-now'
    ])
  })

  it('is found by the landing’s search: a cloud drive’s name lands on the folder row, "passphrase" on Turn on sync', () => {
    const models = phoneSections(syncState(syncStatus()))
    const dropbox = searchRows(models, 'dropbox')
    expect(dropbox.map((h) => h.row.id)).toContain('sync-folder')
    expect(dropbox.find((h) => h.row.id === 'sync-folder')?.caption).toBe('Sync › Set up sync')
    expect(searchRows(models, 'passphrase').map((h) => h.row.id)).toContain('sync-turn-on')
    expect(searchRows(models, 'open tabs').map((h) => h.row.id)).toContain('sync-scope:openTabs')
  })

  it('is the one section both hosts draw (#193’s shared builder): the desktop layout builds the same groups, and each action row trails its 32 px button (§10.5) that the phone never reads', () => {
    const def = PAGE.sections.find((x) => x.id === 'sync')!
    const desktop = (status: SyncStatus): Model =>
      buildSection(def, { ...context(syncState(status)).ctx, formFactor: 'desktop' })
    const phone = (status: SyncStatus): Model =>
      buildSection(def, { ...context(syncState(status)).ctx, formFactor: 'phone' })
    const buttons = (model: Model): Array<[string, string | undefined]> =>
      allRows(model.groups).flatMap((r) => (r.kind === 'action' ? [[r.id, r.button]] : []))

    // Before setup: Choose… until a folder is drafted, Change… after; Turn on… opens the form.
    const fresh = desktop(syncStatus())
    expect(fresh.groups.map((g) => g.id)).toEqual(phone(syncStatus()).groups.map((g) => g.id))
    expect(buttons(fresh)).toEqual([
      ['sync-folder', 'Choose…'],
      ['sync-turn-on', 'Turn on…']
    ])
    syncSetupStore.set({ folder: TREE })
    expect(buttons(desktop(syncStatus()))[0]).toEqual(['sync-folder', 'Change…'])
    syncSetupStore.set({ folder: null })

    // Connected: Sync now's button is its own label; the folder changes; the one way off trails
    // Turn off… (its prompt holds the wipe as a checkbox – no Remove… row, the lead's ruling on
    // #261's desktop page); the merge question's button opens its form.
    const on = desktop(connected())
    expect(on.groups.map((g) => g.id)).toEqual(phone(connected()).groups.map((g) => g.id))
    expect(buttons(on)).toEqual([
      ['sync-now', 'Sync now'],
      ['sync-folder', 'Change…'],
      ['sync-disconnect', 'Turn off…']
    ])
    expect(buttons(desktop(connected({ pendingMerge: true })))[0]).toEqual([
      'sync-merge',
      'Choose…'
    ])
    // The folder-lost row is a message row on both hosts – nothing to press, so no button –
    // over the folder row that chooses again.
    const lost = desktop(connected({ folderLost: true }))
    expect(row(lost, 'sync-folder-lost').kind).toBe('info')
    expect(buttons(lost)).toEqual([
      ['sync-now', 'Sync now'],
      ['sync-folder', 'Change…'],
      ['sync-disconnect', 'Turn off…']
    ])
  })

  it('keeps every row the desktop pane had (#193’s inventory): the device’s field under the pane’s own label on every shell, and one way off – Turn off sync, whose §9.23 prompt holds the wipe as its checkbox row on both hosts, so the pane’s second button is that checkbox and not a row', () => {
    const def = PAGE.sections.find((x) => x.id === 'sync')!
    const build = (layout: 'phone' | 'tablet' | 'desktop'): Model =>
      buildSection(def, { ...context(syncState(connected())).ctx, formFactor: layout })

    // The one field, the one command, the pane's label ("This device", not #193's port's "Name").
    for (const layout of ['phone', 'tablet', 'desktop'] as const) {
      expect(row(build(layout), 'sync-device-name')).toMatchObject({
        kind: 'field',
        label: 'This device',
        description: 'The name other devices show for this one.'
      })
    }

    // One row on every shell – its form the sheet on the phone, the form dialog on the desktop
    // (opened by Turn off…, in the danger ink as the row is destructive) – and no confirmation
    // or press of its own: the form is the prompt, and its footer's Turn off submits the checkbox
    // with the action (`SyncDisconnectForm`, pinned in syncForms.test.tsx). The lead's ruling on
    // #261's desktop page: removing the data only means something together with turning off
    // (§9.23), so it is never a second row – the pane's "Turn off and remove this device's data"
    // button is this checkbox. Nothing names a shell: the same row is what either page's search
    // reaches.
    for (const layout of ['phone', 'tablet', 'desktop'] as const) {
      const model = build(layout)
      expect(model.groups.find((g) => g.id === 'sync-off')?.rows.map((r) => r.id)).toEqual([
        'sync-disconnect'
      ])
      const off = row(model, 'sync-disconnect')
      if (off.kind !== 'action') throw new Error('not an action')
      expect(off).toMatchObject({
        label: 'Turn off sync',
        description: 'This device stops syncing and keeps what it has.',
        button: 'Turn off…',
        destructive: true,
        form: {
          title: 'Turn off sync?',
          description:
            'This device stops syncing and keeps everything it has. Other devices keep syncing with each other.'
        }
      })
      expect(off.confirm).toBeUndefined()
      expect(off.onPress).toBeUndefined()
      expect(off.layouts).toBeUndefined()
      const labels = allRows(model.groups).map((r) => r.label)
      expect(labels.filter((l) => l.startsWith('Turn off'))).toEqual(['Turn off sync'])
    }
  })

  // ID-32: a WebDAV server as the transport (services pass 12). The host says whether it can
  // reach one (`webdavAvailable`: a fetch and a secret store – the desktop's); the phone's
  // status reads false until its host lands both, and then these rows are its rows too.
  const DAV_ROOT = 'https://cloud.example.com/remote.php/dav/files/alice/'
  const SERVER = { url: DAV_ROOT, username: 'alice', folder: 'Zenium' }
  const SERVER_INTRO =
    'Keep your Spaces, folders, pinned tabs, bookmarks, passwords and settings the same on every device. Pick a folder that your cloud drive or Syncthing already keeps in sync – or a WebDAV server such as Nextcloud – and a passphrase: everything is encrypted on this device before it is written, so what is stored there is only ever ciphertext.'
  const TEST_HINT = 'Reaches the server with these details; nothing is written yet.'
  const APP_PASSWORD_HINT =
    'Create one under Security in the server’s personal settings – never the account’s own password.'

  /** Connected through the server, as the engine reports it (the folder is the server folder's URL). */
  function onServer(patch: Partial<SyncStatus> = {}): SyncStatus {
    return connected({
      transport: 'webdav',
      webdav: SERVER,
      webdavAvailable: true,
      folder: `${DAV_ROOT}Zenium/`,
      folderName: 'Zenium',
      ...patch
    })
  }

  const withServer = (): UIState => syncState(syncStatus({ webdavAvailable: true }))

  function actionRow(model: Model, id: string): Extract<Row, { kind: 'action' }> {
    const r = row(model, id)
    if (r.kind !== 'action') throw new Error(`${id} is not an action`)
    return r
  }

  function fieldRow(model: Model, id: string): Extract<Row, { kind: 'field' }> {
    const r = row(model, id)
    if (r.kind !== 'field') throw new Error(`${id} is not a field`)
    return r
  }

  /** The desktop's buttons on the section's action rows, in row order (§10.5). */
  function desktopButtons(s: UIState): Array<[string, string | undefined]> {
    const def = PAGE.sections.find((x) => x.id === 'sync')!
    const model = buildSection(def, { ...context(s).ctx, formFactor: 'desktop' })
    return allRows(model.groups).flatMap((r) => (r.kind === 'action' ? [[r.id, r.button]] : []))
  }

  it('ID-32: a host that reaches a WebDAV server opens the setup with Sync through – a value row of two radios, the folder picked – and names the server in the paragraph; without the host’s half there is no such row, whatever the draft says', () => {
    const model = section('sync', withServer())
    expect(model.groups[0]?.heading).toBe('Set up sync')
    expect(model.groups[0]?.description).toBe(SERVER_INTRO)
    expect(model.groups[0]?.rows.map((r) => r.id)).toEqual([
      'sync-transport',
      'sync-folder',
      'sync-device-name',
      'sync-turn-on'
    ])
    const transport = row(model, 'sync-transport')
    if (transport.kind !== 'value') throw new Error('not a value row')
    expect(transport).toMatchObject({ label: 'Sync through', value: 'folder', radios: true })
    expect(transport.description).toBeUndefined()
    expect(transport.options).toEqual([
      {
        value: 'folder',
        label: 'A folder on this device',
        description: 'Shared through your own cloud drive'
      },
      { value: 'webdav', label: 'A WebDAV server', description: 'Nextcloud and others' }
    ])
    expect(currentOptionLabel(transport)).toBe('A folder on this device')
    // The folder's rows under it are the ones pinned above, unchanged.
    expect(row(model, 'sync-folder')).toMatchObject({
      kind: 'action',
      label: 'Sync folder',
      description: 'Choose a folder that your cloud drive keeps in sync.'
    })
    expect(actionRow(model, 'sync-turn-on').description).toBe('Choose a sync folder first.')

    // A host without the fetch or the secret store (the phone today): the folder's paragraph
    // and rows alone, and a draft that says `webdav` is read as the folder.
    syncSetupStore.set({ transport: 'webdav' })
    const folderOnly = section('sync', syncState(syncStatus()))
    expect(folderOnly.groups[0]?.description).toBe(
      'Keep your Spaces, folders, pinned tabs, bookmarks, passwords and settings the same on every device. Pick a folder that your cloud drive or Syncthing already keeps in sync and a passphrase: everything is encrypted on this device before it is written, so the folder only ever holds ciphertext.'
    )
    expect(folderOnly.groups[0]?.rows.map((r) => r.id)).toEqual([
      'sync-folder',
      'sync-device-name',
      'sync-turn-on'
    ])
    expect(findRow(folderOnly.groups, 'sync-transport')).toBeNull()
    expect(desktopButtons(syncState(syncStatus()))).toEqual([
      ['sync-folder', 'Choose…'],
      ['sync-turn-on', 'Turn on…']
    ])
  })

  it('ID-32: picking the server swaps the folder row for the server form – Server address, Username, App password (masked), Folder – and Test connection; Turn on sync and Test connection wait at 40 % on the three details a connection needs; an http:// address is taken with its one risk under the field in the warn ink, never a refusal', () => {
    const build = (): Model => section('sync', withServer())
    const transport = row(build(), 'sync-transport')
    if (transport.kind !== 'value') throw new Error('not a value row')
    transport.onChange('webdav')
    expect(syncSetupStore.get()).toMatchObject({ transport: 'webdav', probe: { state: 'idle' } })

    const model = build()
    expect(model.groups[0]?.rows.map((r) => r.id)).toEqual([
      'sync-transport',
      'sync-webdav-url',
      'sync-webdav-username',
      'sync-webdav-password',
      'sync-webdav-folder',
      'sync-webdav-test',
      'sync-device-name',
      'sync-turn-on'
    ])
    expect(findRow(model.groups, 'sync-folder')).toBeNull()
    const picked = row(model, 'sync-transport')
    if (picked.kind !== 'value') throw new Error('not a value row')
    expect(currentOptionLabel(picked)).toBe('A WebDAV server')

    // The address: a URL field, stacked under its text on the desktop (a DAV root is longer
    // than the inline 160), Nextcloud's own shape as its hint and the row's line before anything
    // is typed; refused under the field when it is not an http(s) address – and a refused
    // value is not kept – accepted otherwise; cleared is not refused, only not filled in.
    const url = fieldRow(model, 'sync-webdav-url')
    expect(url).toMatchObject({
      label: 'Server address',
      description: 'For Nextcloud: https://cloud.example.com/remote.php/dav/files/USERNAME/',
      display: 'For Nextcloud: https://cloud.example.com/remote.php/dav/files/USERNAME/',
      value: '',
      input: 'url',
      form: 'stacked',
      placeholder: 'https://'
    })
    expect(url.warning).toBeUndefined()
    const invalid = 'Enter an address that starts with https:// or http://'
    expect(url.onCommit('cloud.example.com')).toBe(invalid)
    expect(url.onCommit('ftp://cloud.example.com/')).toBe(invalid)
    expect(url.onCommit('https://')).toBe(invalid)
    expect(syncSetupStore.get().webdav.url).toBe('')
    expect(url.onCommit(DAV_ROOT)).toBeUndefined()
    expect(syncSetupStore.get().webdav.url).toBe(DAV_ROOT)
    expect(fieldRow(build(), 'sync-webdav-url')).toMatchObject({
      value: DAV_ROOT,
      display: DAV_ROOT
    })
    expect(fieldRow(build(), 'sync-webdav-url').warning).toBeUndefined()
    expect(url.onCommit('')).toBeUndefined()
    expect(syncSetupStore.get().webdav.url).toBe('')
    // An http:// address is taken (a home server on the LAN) – not a refusal, the row is not
    // in a status ink – and the field left holding it carries the one risk in the warn ink
    // under it: the app password, the one thing sent unprotected (the records are ciphertext
    // either way). The line goes with the address.
    expect(url.onCommit(`http://192.168.1.10:8080/dav/`)).toBeUndefined()
    const plain = fieldRow(build(), 'sync-webdav-url')
    expect(plain.warning).toBe('Over http:// the app password is sent unprotected.')
    expect(plain.tone).toBeUndefined()
    expect(plain.display).toBe('http://192.168.1.10:8080/dav/')
    expect(url.onCommit(DAV_ROOT)).toBeUndefined()
    expect(fieldRow(build(), 'sync-webdav-url').warning).toBeUndefined()

    const username = fieldRow(model, 'sync-webdav-username')
    expect(username).toMatchObject({
      label: 'Username',
      description: 'Your account on the server.',
      display: 'Your account on the server.',
      value: '',
      input: 'text'
    })
    expect(username.onCommit('alice')).toBeUndefined()
    expect(fieldRow(build(), 'sync-webdav-username').display).toBe('alice')

    // The app password: a masked field whose row shows the hint before and dots after, never
    // the value – and the landing's search never reads the value either.
    const password = fieldRow(model, 'sync-webdav-password')
    expect(password).toMatchObject({
      label: 'App password',
      description: APP_PASSWORD_HINT,
      display: APP_PASSWORD_HINT,
      value: '',
      input: 'password',
      secret: true
    })
    expect(password.onCommit('app-pass')).toBeUndefined()
    const set = fieldRow(build(), 'sync-webdav-password')
    expect(set.value).toBe('app-pass')
    expect(set.display).toBe('••••••••')
    expect(rowText(set)).not.toContain('app-pass')
    expect(rowText(set)).toContain('App password')

    // The folder starts as the engine's default by its NAME – `Zenium`, no trailing slash – the
    // one string the connected page's Folder row reads back for it (seed #28: the two surfaces
    // said `Zenium/` and could drift apart; one value now, in one place).
    const folder = fieldRow(model, 'sync-webdav-folder')
    expect(folder).toMatchObject({
      label: 'Folder',
      description: 'Where the zenium-sync folder is kept on the server.',
      value: 'Zenium',
      input: 'text'
    })
    expect(folder.value).toBe(DEFAULT_WEBDAV_FOLDER)
    expect(folder.display).toBeUndefined()
    expect(folder.onCommit('Backups/Zenium')).toBeUndefined()
    expect(syncSetupStore.get().webdav.folder).toBe('Backups/Zenium')

    // Test connection and Turn on sync, as the first build had them: laid out at 40 % (§10.4)
    // until the address, the username and the app password are in, whichever order they come;
    // the folder may stay as it is.
    const testBefore = actionRow(model, 'sync-webdav-test')
    expect(testBefore).toMatchObject({
      label: 'Test connection',
      description: TEST_HINT,
      button: 'Test',
      busy: false,
      disabled: true
    })
    expect(testBefore.tone).toBeUndefined()
    expect(testBefore.form).toBeUndefined()
    const turnOnBefore = actionRow(model, 'sync-turn-on')
    expect(turnOnBefore.disabled).toBe(true)
    expect(turnOnBefore.description).toBe(
      'Fill in the server address, username and app password first.'
    )
    expect(turnOnBefore.form?.title).toBe('Create a passphrase')
    expect(turnOnBefore.form?.render(() => undefined)).toBeNull()

    // All three in: both rows are pressable, and Turn on sync's form is the passphrase form
    // over the server's details rather than a folder.
    const ready = build()
    expect(actionRow(ready, 'sync-webdav-test').disabled).toBe(false)
    const turnOn = actionRow(ready, 'sync-turn-on')
    expect(turnOn.disabled).toBe(false)
    expect(turnOn.description).toBe('Create the passphrase every device will share.')
    const form = turnOn.form?.render(() => undefined)
    if (!isValidElement<{ folder: string; webdav?: unknown }>(form)) throw new Error('no form')
    expect(form.props.folder).toBe('')
    expect(form.props.webdav).toEqual({
      url: DAV_ROOT,
      username: 'alice',
      password: 'app-pass',
      folder: 'Backups/Zenium'
    })

    // One detail out again and both wait again.
    password.onCommit('')
    const short = build()
    expect(actionRow(short, 'sync-webdav-test').disabled).toBe(true)
    expect(actionRow(short, 'sync-turn-on').disabled).toBe(true)
    expect(actionRow(short, 'sync-turn-on').form?.render(() => undefined)).toBeNull()

    // Back to the folder: its rows return, and the server's details stay in the draft for a
    // change of mind.
    const back = row(short, 'sync-transport')
    if (back.kind !== 'value') throw new Error('not a value row')
    back.onChange('folder')
    expect(build().groups[0]?.rows.map((r) => r.id)).toEqual([
      'sync-transport',
      'sync-folder',
      'sync-device-name',
      'sync-turn-on'
    ])
    expect(syncSetupStore.get().webdav.username).toBe('alice')
    expect(actionRow(build(), 'sync-turn-on').description).toBe('Choose a sync folder first.')
  })

  it('ID-32: Test connection is a §9.30 busy row while the engine reaches the server (`sync.testWebDav` with the details, trimmed) and reports the answer in its description alone (§9.33): Connected., the sign-in refused, the server not reached, or an address that did not answer as WebDAV; a press while busy does nothing, an edit drops the answer', async () => {
    const build = (): Model => section('sync', withServer())
    const test = (): Extract<Row, { kind: 'action' }> => actionRow(build(), 'sync-webdav-test')
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
    syncSetupStore.set({
      transport: 'webdav',
      webdav: {
        url: ` ${DAV_ROOT} `,
        username: ' alice ',
        password: 'app-pass',
        folder: ' Zenium/ '
      }
    })
    let finish: (value: never) => void = () => undefined
    invoke.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          finish = resolve as (value: never) => void
        })
    )
    test().onPress?.()
    expect(invoke).toHaveBeenCalledWith('sync.testWebDav', {
      url: DAV_ROOT,
      username: 'alice',
      password: 'app-pass',
      folder: 'Zenium/'
    })
    const busy = test()
    expect(busy).toMatchObject({ busy: true, disabled: false, description: 'Connecting…' })
    expect(busy.tone).toBeUndefined()
    busy.onPress?.()
    expect(invoke).toHaveBeenCalledTimes(1)
    finish({ ok: true } as never)
    await settle()
    const done = test()
    expect(done).toMatchObject({ busy: false, disabled: false, description: 'Connected.' })
    expect(done.tone).toBeUndefined()
    // The answer stays with the details it answered: another build reads the same line.
    expect(test().description).toBe('Connected.')

    // The refusals, each the description in the danger ink and nothing else – an action row
    // reporting its result carries no glyph (§9.33) – and each the page's sentence for the
    // answer's class (`webDavOutcomeLine`, the one mapping the Turn on refusal and the line
    // under Sync now read too): no method name, no status code in any of them.
    const answers: Array<[WebDavProbe, string]> = [
      [{ ok: false, kind: 'auth', status: 401 }, 'The server refused the sign-in.'],
      [
        { ok: false, kind: 'forbidden', status: 403 },
        'The server did not allow writing to the folder.'
      ],
      [
        { ok: false, kind: 'conflict', status: 423 },
        'The server did not allow writing to the folder.'
      ],
      [{ ok: false, kind: 'unavailable', status: 0 }, 'The server could not be reached.'],
      [{ ok: false, kind: 'unavailable', status: 503 }, 'The server could not be reached.'],
      [{ ok: false, kind: 'redirect', status: 301 }, 'The address redirected elsewhere.'],
      [
        { ok: false, kind: 'refused', status: 200 },
        'The address did not answer as a WebDAV server.'
      ],
      [
        { ok: false, kind: 'refused', status: 405 },
        'The address did not answer as a WebDAV server.'
      ],
      [
        { ok: false, kind: 'missing', status: 404 },
        'The address did not answer as a WebDAV server.'
      ]
    ]
    for (const [answer, line] of answers) {
      syncSetupStore.set({ probe: { state: 'idle' } })
      invoke.mockResolvedValueOnce(answer as never)
      test().onPress?.()
      await settle()
      const answered = test()
      expect(answered, line).toMatchObject({ description: line, tone: 'danger', busy: false })
      expect(answered.description, line).not.toMatch(/PROPFIND|\b[1-5]\d\d\b/)
      expect(answered.leading, line).toBeUndefined()
      expect(answered.leaves, line).toBeUndefined()
    }
    // The host's channel failing is the server not reached.
    syncSetupStore.set({ probe: { state: 'idle' } })
    invoke.mockRejectedValueOnce(new Error('channel closed'))
    test().onPress?.()
    await settle()
    expect(test()).toMatchObject({
      description: 'The server could not be reached.',
      tone: 'danger'
    })

    // An edit puts the row back to its hint – the answer was to the old details – and an answer
    // that lands after an edit is dropped for the same reason.
    const username = fieldRow(build(), 'sync-webdav-username')
    username.onCommit('bob')
    expect(test()).toMatchObject({ description: TEST_HINT, busy: false })
    expect(test().tone).toBeUndefined()
    invoke.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          finish = resolve as (value: never) => void
        })
    )
    test().onPress?.()
    expect(test().busy).toBe(true)
    fieldRow(build(), 'sync-webdav-username').onCommit('carol')
    expect(test().busy).toBe(false)
    finish({ ok: true } as never)
    await settle()
    expect(test()).toMatchObject({ busy: false, description: TEST_HINT })
    expect(syncSetupStore.get().probe).toEqual({ state: 'idle' })
    // Nothing to test without the details: the press is refused before anything is sent.
    invoke.mockClear()
    fieldRow(build(), 'sync-webdav-password').onCommit('')
    test().onPress?.()
    expect(invoke).not.toHaveBeenCalled()
    expect(test().busy).toBe(false)
  })

  it('ID-32: connected through a server, the second group is Server and device – the account on the host and the folder under its files as facts, nothing to press and no folder row – on every shell; the top level is named when the folder is none', () => {
    const model = section('sync', syncState(onServer()))
    expect(model.groups.map((g) => g.id)).toEqual([
      'sync-status',
      'sync-where',
      'sync-devices',
      'sync-scope',
      'sync-off'
    ])
    const where = model.groups.find((g) => g.id === 'sync-where')
    expect(where?.heading).toBe('Server and device')
    expect(where?.rows.map((r) => r.id)).toEqual([
      'sync-server',
      'sync-server-folder',
      'sync-device-name'
    ])
    expect(findRow(model.groups, 'sync-folder')).toBeNull()
    const server = row(model, 'sync-server')
    if (server.kind !== 'info') throw new Error('not an info row')
    expect(server).toMatchObject({
      label: 'WebDAV server',
      description: 'alice on cloud.example.com'
    })
    // The account's phrase is prose – a name, a word, a host – so it keeps §9.2's two lines;
    // the folder under it is a path and keeps its end on one line (seed #29).
    expect(server.address).toBeUndefined()
    expect(server.keywords).toContain(DAV_ROOT)
    expect(server.leading).toBeUndefined()
    expect(server.trailing).toBeUndefined()
    const folder = row(model, 'sync-server-folder')
    if (folder.kind !== 'info') throw new Error('not an info row')
    // The folder by its NAME – `Zenium`, no trailing slash: the string the setup's Folder field
    // started with, read back (seed #28: one value on both surfaces) – a path, so one line kept
    // from its end (seed #29).
    expect(folder).toMatchObject({ label: 'Folder', description: 'Zenium', address: true })
    expect(folder.description).toBe(DEFAULT_WEBDAV_FOLDER)
    expect(folder.trailing).toBeUndefined()
    // The same string the form's Folder field holds at a fresh setup: the two surfaces agree.
    clearSyncSetup()
    syncSetupStore.set({ transport: 'webdav' })
    const setup = section('sync', withServer())
    expect(fieldRow(setup, 'sync-webdav-folder').value).toBe(folder.description)
    clearSyncSetup()
    // The folder as the engine reads it (`webDavFolderSegments`): empty and dot segments
    // dropped, the segments joined with `/`, no trailing slash whatever was typed; the account's
    // top level named for none.
    const nested = section(
      'sync',
      syncState(onServer({ webdav: { ...SERVER, folder: '/Backups//./Zenium/' } }))
    )
    expect(row(nested, 'sync-server-folder').description).toBe('Backups/Zenium')
    expect(row(nested, 'sync-server-folder').address).toBe(true)
    const typed = section(
      'sync',
      syncState(onServer({ webdav: { ...SERVER, folder: 'Zenium/sub' } }))
    )
    expect(row(typed, 'sync-server-folder').description).toBe('Zenium/sub')
    const slashed = section(
      'sync',
      syncState(onServer({ webdav: { ...SERVER, folder: 'Zenium/' } }))
    )
    expect(row(slashed, 'sync-server-folder').description).toBe('Zenium')
    const root = section(
      'sync',
      syncState(
        onServer({
          webdav: { ...SERVER, folder: '' },
          folder: DAV_ROOT,
          folderName: 'cloud.example.com'
        })
      )
    )
    expect(row(root, 'sync-server-folder').description).toBe('The top level of your files')
    // …and that sentence is prose, not a path: no start-ellipsis on it.
    expect(row(root, 'sync-server-folder').address).toBe(false)
    // A folder transport keeps its heading and its row, its folder's name a path.
    const viaFolder = section('sync', syncState(connected()))
    expect(viaFolder.groups.find((g) => g.id === 'sync-where')?.heading).toBe('Folder and device')
    expect(row(viaFolder, 'sync-folder').kind).toBe('action')
    expect(row(viaFolder, 'sync-folder').address).toBe(true)
    // Sync now reads the status as with a folder; a round that fails for a reason that is not
    // the sign-in puts the page's sentence for the server's answer under it in the danger ink
    // (`lastErrorKind` through the one mapping), never the engine's method and status; an
    // error with no class – a record that would not decrypt – is the engine's own line, as
    // the folder transport's are.
    expect(actionRow(model, 'sync-now')).toMatchObject({
      description: 'Last synced 5 min ago',
      disabled: false
    })
    const failed: Array<[SyncStatus['lastErrorKind'], string, string]> = [
      ['conflict', 'WebDAV PUT answered 423', 'The server did not allow writing to the folder.'],
      ['forbidden', 'WebDAV MKCOL answered 403', 'The server did not allow writing to the folder.'],
      ['unavailable', 'WebDAV PROPFIND answered 503', 'The server could not be reached.'],
      ['redirect', 'WebDAV PROPFIND: the address redirected', 'The address redirected elsewhere.'],
      ['missing', 'WebDAV GET answered 404', 'The address did not answer as a WebDAV server.'],
      [null, 'Sync failed', 'Sync failed']
    ]
    for (const [lastErrorKind, lastError, line] of failed) {
      expect(
        actionRow(section('sync', syncState(onServer({ lastError, lastErrorKind }))), 'sync-now'),
        line
      ).toMatchObject({ description: line, tone: 'danger', disabled: false })
    }
    // The desktop's buttons: Sync now and Turn off…; the server's rows carry none.
    expect(desktopButtons(syncState(onServer()))).toEqual([
      ['sync-now', 'Sync now'],
      ['sync-disconnect', 'Turn off…']
    ])
    // The device name and the way off stand as they do with a folder.
    expect(row(model, 'sync-device-name')).toMatchObject({ kind: 'field', label: 'This device' })
    expect(row(model, 'sync-disconnect')).toMatchObject({ kind: 'action', label: 'Turn off sync' })
  })

  it('seed #34: on the touch layouts the connected page’s Folder row also copies its path – the line as the row shows it, "Folder copied" as the word – so its hold is the address sheet with Copy as its one row (a phone) or the held card with Copy as its footer button (a tablet); not on the desktop, and never for the top level', () => {
    const def = PAGE.sections.find((x) => x.id === 'sync')!
    const nested = onServer({ webdav: { ...SERVER, folder: '/Backups//./Zenium/' } })
    const on = (formFactor: 'phone' | 'tablet' | 'desktop' | undefined, s = nested): Row =>
      row(buildSection(def, { ...context(syncState(s)).ctx, formFactor }), 'sync-server-folder')
    // Both at once on either touch layout (the lead: "The Folder row carries copy on both touch
    // layouts"): the path (its line kept from its end) and the copy of that very line. A
    // context without a form factor shows every row as the version row's rule reads it
    // (`formFactor !== 'desktop'`, SET-54): the copy declared.
    for (const formFactor of ['phone', 'tablet', undefined] as const) {
      const touch = on(formFactor)
      if (touch.kind !== 'info') throw new Error('not an info row')
      expect(touch).toMatchObject({
        label: 'Folder',
        description: 'Backups/Zenium',
        address: true,
        copy: { text: 'Backups/Zenium', confirmation: 'Folder copied' }
      })
      expect(touch.copy?.text).toBe(touch.description)
      expect(touch.copy?.confirmation).toBe(SYNC_COPY.serverFolderCopied)
    }
    // The desktop copies from the folder editor's field (the lead; the version row's rule): the
    // address, no copy.
    const wide = on('desktop')
    if (wide.kind !== 'info') throw new Error('not an info row')
    expect(wide.address).toBe(true)
    expect(wide.copy).toBeUndefined()
    // The top level is a sentence, not a path: no address and nothing to copy, the phone's too.
    const root = on(
      'phone',
      onServer({
        webdav: { ...SERVER, folder: '' },
        folder: DAV_ROOT,
        folderName: 'cloud.example.com'
      })
    )
    if (root.kind !== 'info') throw new Error('not an info row')
    expect(root.address).toBe(false)
    expect(root.copy).toBeUndefined()
    // The Server row beside it copies nothing: its line is prose about the account.
    const server = row(
      buildSection(def, { ...context(syncState(nested)).ctx, formFactor: 'phone' }),
      'sync-server'
    )
    if (server.kind !== 'info') throw new Error('not an info row')
    expect(server.copy).toBeUndefined()
  })

  it('ID-32: a sign-in the server has stopped taking is the lone status row over the App password row – the info row in the danger ink with the key glyph trailing, nothing to press; Sync now waits with its status line, not the engine’s sentence – and the masked field’s commit hands the engine the new password as a §9.30 busy commit, an empty one nothing; a secret store that cannot keep it is the field’s refusal in the page’s words', async () => {
    const model = section(
      'sync',
      syncState(
        onServer({
          authRefused: true,
          lastError: 'WebDAV PROPFIND answered 401',
          lastErrorKind: 'auth'
        })
      )
    )
    expect(model.groups[0]?.rows.map((r) => r.id)).toEqual(['sync-auth-refused', 'sync-now'])
    const notice = row(model, 'sync-auth-refused')
    if (notice.kind !== 'info') throw new Error('not an info row')
    expect(notice).toMatchObject({
      label: 'The server refused the sign-in',
      description: 'Enter a new app password to keep syncing.',
      tone: 'danger'
    })
    expect(notice.leading).toBeUndefined()
    if (!isValidElement<{ className?: string }>(notice.trailing)) throw new Error('no glyph')
    expect(notice.trailing.props.className).toBe('zen-settings-trailing-glyph')
    const now = actionRow(model, 'sync-now')
    expect(now.disabled).toBe(true)
    expect(now.description).toBe('Last synced 5 min ago')
    expect(now.tone).toBeUndefined()

    // The way out is the next group's first row (§9.17): the App password field, masked and
    // empty – the old one is never read back – with what it does as its line.
    const where = model.groups.find((g) => g.id === 'sync-where')
    expect(where?.heading).toBe('Server and device')
    expect(where?.rows.map((r) => r.id)).toEqual([
      'sync-webdav-password',
      'sync-server',
      'sync-server-folder',
      'sync-device-name'
    ])
    const password = fieldRow(model, 'sync-webdav-password')
    expect(password).toMatchObject({
      label: 'App password',
      description: 'The one the server takes now; the old one is forgotten.',
      display: 'The one the server takes now; the old one is forgotten.',
      value: '',
      input: 'password',
      secret: true
    })
    expect(password.form).toBeUndefined()
    invoke.mockClear()
    expect(password.onCommit('')).toBeUndefined()
    expect(invoke).not.toHaveBeenCalled()
    // The commit settles with the engine (§9.30's busy form while it keeps the password and
    // runs a round): accepted when the engine answers nothing; a server that refuses the new
    // password in its turn leaves the status row to say so, not the field.
    const accepted = password.onCommit('new-app-pass')
    expect(accepted).toBeInstanceOf(Promise)
    expect(invoke).toHaveBeenCalledWith('sync.setWebDavPassword', { password: 'new-app-pass' })
    await expect(accepted).resolves.toBeUndefined()
    expect(rowText(password)).not.toContain('new-app-pass')
    // The secret store could not keep it: the field's refusal, in the page's words.
    invoke.mockResolvedValueOnce({ reason: 'secrets' } as never)
    await expect(password.onCommit('new-app-pass')).resolves.toBe(
      'The app password could not be kept on this device.'
    )
    // The host's channel failing is the same sentence: the password did not get kept.
    invoke.mockRejectedValueOnce(new Error('channel closed'))
    await expect(password.onCommit('new-app-pass')).resolves.toBe(
      'The app password could not be kept on this device.'
    )

    // Not refused: no password row – it appears with its state (§10.4) – and no status row.
    const fine = section('sync', syncState(onServer()))
    expect(findRow(fine.groups, 'sync-webdav-password')).toBeNull()
    expect(findRow(fine.groups, 'sync-auth-refused')).toBeNull()
    // The same rows on the desktop: a message row with no button, the field under it.
    expect(desktopButtons(syncState(onServer({ authRefused: true })))).toEqual([
      ['sync-now', 'Sync now'],
      ['sync-disconnect', 'Turn off…']
    ])
    // A folder transport's page never shows the row, whatever an older status carries.
    expect(
      findRow(
        section('sync', syncState(connected({ authRefused: true }))).groups,
        'sync-webdav-password'
      )
    ).toBeNull()
  })

  it('ID-32: the landing’s search reaches the server rows – "nextcloud" lands on Sync through and the address, "app password" on the masked field, the server’s host on the connected page’s row – and never reads the password itself; the desktop’s server form trails Test and Turn on…', () => {
    syncSetupStore.set({
      transport: 'webdav',
      webdav: { url: DAV_ROOT, username: 'alice', password: 'app-pass', folder: 'Zenium/' }
    })
    const models = phoneSections(withServer())
    const hits = (query: string): string[] => searchRows(models, query).map((h) => h.row.id)
    expect(hits('nextcloud')).toEqual(expect.arrayContaining(['sync-transport', 'sync-webdav-url']))
    expect(hits('webdav')).toContain('sync-transport')
    expect(hits('username')).toContain('sync-webdav-username')
    expect(hits('app password')).toContain('sync-webdav-password')
    expect(hits('test connection')).toContain('sync-webdav-test')
    expect(hits('app-pass')).toEqual([])
    expect(searchRows(models, 'server address')[0]?.caption).toBe('Sync › Set up sync')
    expect(desktopButtons(withServer())).toEqual([
      ['sync-webdav-test', 'Test'],
      ['sync-turn-on', 'Turn on…']
    ])
    const on = phoneSections(syncState(onServer()))
    expect(searchRows(on, 'cloud.example.com').map((h) => h.row.id)).toContain('sync-server')
    expect(searchRows(on, 'webdav server').map((h) => h.row.id)).toContain('sync-server')
  })

  it('ID-32: the draft starts empty – no transport picked (the host’s default), the engine’s default folder by its name, Zenium, no test asked – and is cleared whole, the typed app password with it', () => {
    expect(emptySyncSetup()).toEqual({
      folder: null,
      transport: null,
      webdav: { url: '', username: '', password: '', folder: 'Zenium' },
      probe: { state: 'idle' }
    })
    expect(emptySyncSetup().webdav.folder).toBe(DEFAULT_WEBDAV_FOLDER)
    syncSetupStore.set({
      folder: TREE,
      transport: 'webdav',
      webdav: { url: DAV_ROOT, username: 'alice', password: 'app-pass', folder: 'Zenium/' },
      probe: { state: 'done', probe: { ok: true } }
    })
    clearSyncSetup()
    expect(syncSetupStore.get()).toEqual(emptySyncSetup())
  })

  // The Zenium account (the third transport): offered first, and picked, where the host reaches
  // the service (`accountAvailable`: the same fetch and secret store as a WebDAV server).
  const EMAIL = 'ada@example.com'
  const ACCOUNT_INTRO =
    'Keep your Spaces, folders, pinned tabs, bookmarks, passwords and settings the same on every device. Sign in to your Zenium account – or pick a folder that your cloud drive keeps in sync, or a WebDAV server such as Nextcloud – and choose a passphrase: everything is encrypted on this device before it is sent, so what is stored is only ever ciphertext.'
  const LINK = {
    userCode: 'WXYZ-2345',
    verificationUrl: 'https://zenium.techlitnow.com/link?code=WXYZ-2345',
    expiresAt: Date.now() + 600_000
  }

  function withAccount(patch: Partial<SyncStatus> = {}): UIState {
    return syncState(syncStatus({ webdavAvailable: true, accountAvailable: true, ...patch }))
  }

  function onAccount(patch: Partial<SyncStatus> = {}): SyncStatus {
    return connected({
      transport: 'account',
      webdavAvailable: true,
      accountAvailable: true,
      account: { email: EMAIL },
      folder: 'https://accounts.example.convex.cloud',
      folderName: EMAIL,
      ...patch
    })
  }

  it('the Zenium account: a host that reaches the service opens Sync through with the account first, picked and recommended, then the folder and the server; Sign in is the setup’s one row and Turn on sync waits for it', () => {
    invoke.mockClear()
    const model = section('sync', withAccount())
    expect(model.groups[0]?.description).toBe(ACCOUNT_INTRO)
    expect(model.groups[0]?.rows.map((r) => r.id)).toEqual([
      'sync-transport',
      'sync-account-sign-in',
      'sync-device-name',
      'sync-turn-on'
    ])
    const transport = row(model, 'sync-transport')
    if (transport.kind !== 'value') throw new Error('not a value row')
    expect(transport.value).toBe('account')
    expect(transport.options).toEqual([
      {
        value: 'account',
        label: 'Zenium account',
        description: 'Recommended – nothing else to set up'
      },
      {
        value: 'folder',
        label: 'A folder on this device',
        description: 'Shared through your own cloud drive'
      },
      { value: 'webdav', label: 'A WebDAV server', description: 'Nextcloud and others' }
    ])
    const signIn = actionRow(model, 'sync-account-sign-in')
    expect(signIn).toMatchObject({
      label: 'Sign in',
      description: 'Opens the sign-in page in a new tab.',
      button: 'Sign in'
    })
    expect(signIn.tone).toBeUndefined()
    signIn.onPress?.()
    expect(invoke).toHaveBeenCalledWith('sync.accountSignIn', undefined)
    const turnOn = actionRow(model, 'sync-turn-on')
    expect(turnOn.disabled).toBe(true)
    expect(turnOn.description).toBe('Sign in to your Zenium account first.')
    expect(turnOn.form?.render(() => undefined)).toBeNull()
    expect(desktopButtons(withAccount())).toEqual([
      ['sync-account-sign-in', 'Sign in'],
      ['sync-turn-on', 'Turn on…']
    ])

    // The other two stay a pick away, their rows as before.
    transport.onChange('folder')
    expect(section('sync', withAccount()).groups[0]?.rows.map((r) => r.id)).toEqual([
      'sync-transport',
      'sync-folder',
      'sync-device-name',
      'sync-turn-on'
    ])
    transport.onChange('webdav')
    expect(findRow(section('sync', withAccount()).groups, 'sync-webdav-url')).not.toBeNull()
    expect(findRow(section('sync', withAccount()).groups, 'sync-account-sign-in')).toBeNull()

    // A host that cannot reach the service never offers it, whatever the draft says.
    syncSetupStore.set({ transport: 'account' })
    const serverOnly = section('sync', withServer())
    expect(serverOnly.groups[0]?.description).toBe(SERVER_INTRO)
    const choices = row(serverOnly, 'sync-transport')
    if (choices.kind !== 'value') throw new Error('not a value row')
    expect(choices.value).toBe('folder')
    expect(choices.options.map((o) => o.value)).toEqual(['folder', 'webdav'])
  })

  it('the Zenium account: while the new tab waits, its code stands with “Waiting for the sign-in to finish in the new tab…” over Cancel sign-in; leaving the account for another transport cancels it; a sign-in that did not finish says why in the page’s words', () => {
    invoke.mockClear()
    const waiting = section('sync', withAccount({ accountLink: LINK }))
    expect(waiting.groups[0]?.rows.map((r) => r.id)).toEqual([
      'sync-transport',
      'sync-account-code',
      'sync-account-cancel',
      'sync-device-name',
      'sync-turn-on'
    ])
    expect(row(waiting, 'sync-account-code')).toMatchObject({
      kind: 'info',
      label: 'WXYZ-2345',
      description: 'Waiting for the sign-in to finish in the new tab…'
    })
    const cancel = actionRow(waiting, 'sync-account-cancel')
    expect(cancel).toMatchObject({ label: 'Cancel sign-in', button: 'Cancel' })
    cancel.onPress?.()
    expect(invoke).toHaveBeenCalledWith('sync.accountCancel', undefined)
    invoke.mockClear()
    const transport = row(waiting, 'sync-transport')
    if (transport.kind !== 'value') throw new Error('not a value row')
    transport.onChange('folder')
    expect(invoke).toHaveBeenCalledWith('sync.accountCancel', undefined)
    clearSyncSetup()

    const lines: Array<[NonNullable<SyncStatus['accountLinkFailure']>, string]> = [
      ['expired', 'The code expired before the sign-in finished.'],
      ['unavailable', 'Your Zenium account could not be reached.'],
      ['rate-limited', 'Too many requests to your Zenium account. Try again in a moment.'],
      ['secrets', 'The sign-in could not be kept on this device.']
    ]
    for (const [failure, line] of lines) {
      const signIn = actionRow(
        section('sync', withAccount({ accountLinkFailure: failure })),
        'sync-account-sign-in'
      )
      expect(signIn.description).toBe(line)
      expect(signIn.tone).toBe('danger')
      expect(signIn.description).not.toMatch(/\d{3}|sync:|devices:|auth\//)
    }
  })

  it('the Zenium account: approved, the setup names the account by its email with Sign out, and Turn on sync opens the passphrase form for the account', () => {
    invoke.mockClear()
    const model = section('sync', withAccount({ account: { email: EMAIL } }))
    expect(model.groups[0]?.rows.map((r) => r.id)).toEqual([
      'sync-transport',
      'sync-account',
      'sync-account-sign-out',
      'sync-device-name',
      'sync-turn-on'
    ])
    expect(row(model, 'sync-account')).toMatchObject({
      kind: 'info',
      label: 'Zenium account',
      description: EMAIL
    })
    const signOut = actionRow(model, 'sync-account-sign-out')
    expect(signOut).toMatchObject({
      label: 'Sign out',
      description: 'This device forgets the sign-in.',
      button: 'Sign out…',
      confirm: {
        title: 'Sign out of your Zenium account?',
        description: 'This device forgets the sign-in.',
        action: 'Sign out',
        verbTone: 'plain'
      }
    })
    expect(signOut.destructive).toBeUndefined()
    signOut.onPress?.()
    expect(invoke).toHaveBeenCalledWith('sync.accountSignOut', undefined)
    const turnOn = actionRow(model, 'sync-turn-on')
    expect(turnOn.disabled).toBe(false)
    expect(turnOn.description).toBe('Create the passphrase every device will share.')
    const form = turnOn.form?.render(() => undefined)
    if (!isValidElement<{ folder: string; account?: boolean; webdav?: unknown }>(form))
      throw new Error('no form')
    expect(form.props).toMatchObject({ folder: '', account: true })
    expect(form.props.webdav).toBeUndefined()
    expect(searchRows(phoneSections(withAccount()), 'zenium account').map((h) => h.row.id)).toEqual(
      expect.arrayContaining(['sync-transport', 'sync-account-sign-in'])
    )
  })

  it('the Zenium account, connected: Account and device names the email, Sign out confirms first and turns sync off, the empty devices line and the merge and Turn off prompts name the account; the account’s errors are the page’s sentences', () => {
    invoke.mockClear()
    const model = section('sync', syncState(onAccount()))
    const where = model.groups.find((g) => g.id === 'sync-where')
    expect(where?.heading).toBe('Account and device')
    expect(where?.rows.map((r) => r.id)).toEqual([
      'sync-account',
      'sync-account-sign-out',
      'sync-device-name'
    ])
    expect(row(model, 'sync-account').description).toBe(EMAIL)
    const signOut = actionRow(model, 'sync-account-sign-out')
    expect(signOut).toMatchObject({
      description: 'This device stops syncing and keeps what it has.',
      confirm: {
        title: 'Sign out of your Zenium account?',
        description:
          'This device stops syncing and keeps what it has. Your other devices keep syncing.',
        action: 'Sign out',
        verbTone: 'plain'
      }
    })
    expect(signOut.destructive).toBeUndefined()
    syncSetupStore.set({ transport: 'webdav' })
    signOut.onPress?.()
    expect(invoke).toHaveBeenCalledWith('sync.accountSignOut', undefined)
    expect(syncSetupStore.get()).toEqual(emptySyncSetup())
    expect(desktopButtons(syncState(onAccount()))).toEqual([
      ['sync-now', 'Sync now'],
      ['sync-account-sign-out', 'Sign out…'],
      ['sync-disconnect', 'Turn off…']
    ])

    const alone = section('sync', syncState(onAccount({ devices: [] })))
    expect(alone.groups.find((g) => g.id === 'sync-devices')?.empty).toBe(
      'No other device has synced to this account yet'
    )
    const merge = actionRow(
      section('sync', syncState(onAccount({ pendingMerge: true }))),
      'sync-merge'
    )
    expect(merge.label).toBe('Your Zenium account already has synced data')
    expect(merge.form?.title).toBe('Combine with the data in your account?')
    const off = actionRow(model, 'sync-disconnect').form?.render(() => undefined)
    if (!isValidElement<{ account?: boolean }>(off)) throw new Error('no form')
    expect(off.props.account).toBe(true)

    const lines: Array<[NonNullable<SyncStatus['lastErrorKind']>, string]> = [
      ['quota', 'Your Zenium account’s sync storage is full.'],
      ['too-large', 'Some of this device’s data is too large to sync.'],
      ['unavailable', 'Your Zenium account could not be reached.'],
      ['refused', 'Your Zenium account did not accept the request.']
    ]
    for (const [kind, line] of lines) {
      const now = actionRow(
        section(
          'sync',
          syncState(onAccount({ lastError: 'sync:write quota (HTTP 200)', lastErrorKind: kind }))
        ),
        'sync-now'
      )
      expect(now.description).toBe(line)
      expect(now.tone).toBe('danger')
    }
  })

  it('the Zenium account, signed out by the service: the §9.33 message row, Sync now waiting and saying nothing twice, and Sign in again first under it – the code and Cancel while it waits', () => {
    invoke.mockClear()
    const model = section(
      'sync',
      syncState(
        onAccount({
          accountSignedOut: true,
          lastError: 'You were signed out of your Zenium account.',
          lastErrorKind: 'signed-out'
        })
      )
    )
    const status = model.groups.find((g) => g.id === 'sync-status')
    expect(status?.rows.map((r) => r.id)).toEqual(['sync-account-signed-out', 'sync-now'])
    expect(row(model, 'sync-account-signed-out')).toMatchObject({
      kind: 'info',
      label: 'You were signed out of your Zenium account',
      description: 'Sign in again to keep syncing.',
      tone: 'danger'
    })
    const now = actionRow(model, 'sync-now')
    expect(now.disabled).toBe(true)
    expect(now.tone).toBeUndefined()
    expect(model.groups.find((g) => g.id === 'sync-where')?.rows.map((r) => r.id)).toEqual([
      'sync-account-sign-in',
      'sync-account',
      'sync-account-sign-out',
      'sync-device-name'
    ])
    const again = actionRow(model, 'sync-account-sign-in')
    expect(again).toMatchObject({ label: 'Sign in again', button: 'Sign in again' })
    again.onPress?.()
    expect(invoke).toHaveBeenCalledWith('sync.accountSignIn', undefined)

    const waiting = section(
      'sync',
      syncState(onAccount({ accountSignedOut: true, accountLink: LINK }))
    )
    expect(waiting.groups.find((g) => g.id === 'sync-where')?.rows.map((r) => r.id)).toEqual([
      'sync-account-code',
      'sync-account-cancel',
      'sync-account',
      'sync-account-sign-out',
      'sync-device-name'
    ])
    // A folder device's page never shows the account's rows, whatever an older status carries.
    expect(
      findRow(
        section('sync', syncState(connected({ accountSignedOut: true }))).groups,
        'sync-account-signed-out'
      )
    ).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Settings › Account: the Zenium account on a page of its own (the P0 after v0.5.58: no
  // Account anywhere in Settings on the released phone), on every host that syncs.
  // -------------------------------------------------------------------------

  describe('the Account page', () => {
    const ACCOUNT_INTRO_LINE =
      'Keep your Spaces, folders, pinned tabs, bookmarks, passwords and settings the same on every device. Everything is encrypted on this device before it is sent, so what is stored is only ever ciphertext.'

    it('is listed behind the `sync` capability right before Sync, on the phone and the desktop, and builds in every state with unique ids', () => {
      expect(phoneSections().map((m) => m.section.id)).not.toContain('account')
      const phone = phoneSections(withAccount()).map((m) => m.section.id)
      expect(phone.indexOf('sync')).toBe(phone.indexOf('account') + 1)
      const desktop = availableSections(PAGE, withAccount().capabilities, 'desktop', 'linux').map(
        (s) => s.id
      )
      expect(desktop.indexOf('sync')).toBe(desktop.indexOf('account') + 1)
      for (const s of [
        withAccount(),
        withAccount({ accountLink: LINK }),
        withAccount({ accountLinkFailure: 'expired' }),
        withAccount({ account: { email: EMAIL } }),
        syncState(onAccount()),
        syncState(onAccount({ pendingMerge: true })),
        syncState(onAccount({ accountSignedOut: true })),
        syncState(connected({ accountAvailable: true, account: { email: EMAIL } })),
        syncState(syncStatus())
      ]) {
        const model = section('account', s)
        expect(model.groups.length).toBeGreaterThan(0)
        if (s.sync.accountAvailable) expect(model.groups[0]?.description).toBe(ACCOUNT_INTRO_LINE)
        expect(model.groups.every(groupShows)).toBe(true)
        const ids = allRows(model.groups).map((r) => r.id)
        expect(new Set(ids).size).toBe(ids.length)
        for (const r of allRows(model.groups)) expect(r.label, r.id).not.toBe('')
      }
    })

    it('signed out: the paragraph and Sign in, which opens the sign-in page; while the tab waits, the code and Cancel; a sign-in that failed says why', () => {
      invoke.mockClear()
      const model = section('account', withAccount())
      expect(model.groups.map((g) => g.id)).toEqual(['account'])
      expect(model.groups[0]).toMatchObject({
        heading: 'Zenium account',
        description: ACCOUNT_INTRO_LINE
      })
      expect(model.groups[0]?.rows.map((r) => r.id)).toEqual(['account-sign-in'])
      const signIn = row(model, 'account-sign-in')
      if (signIn.kind !== 'action') throw new Error('not an action')
      expect(signIn).toMatchObject({
        label: 'Sign in',
        description: 'Opens the sign-in page in a new tab.',
        button: 'Sign in'
      })
      signIn.onPress?.()
      expect(invoke).toHaveBeenCalledWith('sync.accountSignIn', undefined)

      const waiting = section('account', withAccount({ accountLink: LINK }))
      expect(waiting.groups[0]?.rows.map((r) => r.id)).toEqual(['account-code', 'account-cancel'])
      expect(row(waiting, 'account-code')).toMatchObject({
        kind: 'info',
        label: 'WXYZ-2345',
        description: 'Waiting for the sign-in to finish in the new tab…'
      })

      const failed = section('account', withAccount({ accountLinkFailure: 'expired' }))
      expect(row(failed, 'account-sign-in')).toMatchObject({
        tone: 'danger',
        description: 'The code expired before the sign-in finished.'
      })
    })

    it('signed in, sync off: who, Turn on sync with the passphrase form, the way to Sync, the devices the sync will list, and Sign out that confirms', () => {
      invoke.mockClear()
      const model = section('account', withAccount({ account: { email: EMAIL } }))
      expect(model.groups.map((g) => g.id)).toEqual([
        'account',
        'account-devices',
        'account-sign-out'
      ])
      expect(model.groups[0]?.rows.map((r) => r.id)).toEqual([
        'account-email',
        'account-sync-turn-on',
        'account-sync-settings'
      ])
      expect(row(model, 'account-email')).toMatchObject({
        kind: 'info',
        label: 'Signed in as',
        description: EMAIL
      })
      const turnOn = row(model, 'account-sync-turn-on')
      if (turnOn.kind !== 'action') throw new Error('not an action')
      expect(turnOn).toMatchObject({ label: 'Turn on sync', button: 'Turn on…' })
      expect(turnOn.disabled).toBeFalsy()
      expect(turnOn.form?.title).toBe('Create a passphrase')
      expect(turnOn.form?.render(() => undefined)).not.toBeNull()
      const settings = row(model, 'account-sync-settings')
      if (settings.kind !== 'action') throw new Error('not an action')
      expect(settings).toMatchObject({ label: 'Sync settings', button: 'Open' })

      const devices = model.groups[1]!
      expect(devices).toMatchObject({
        heading: 'Devices',
        rows: [],
        empty: 'Turn on sync to see your other devices'
      })
      expect(devices.aside).toBeUndefined()

      const signOut = row(model, 'account-sign-out')
      if (signOut.kind !== 'action') throw new Error('not an action')
      expect(signOut).toMatchObject({
        label: 'Sign out',
        description: 'This device forgets the sign-in.',
        button: 'Sign out…',
        confirm: {
          title: 'Sign out of your Zenium account?',
          description: 'This device forgets the sign-in.',
          action: 'Sign out',
          verbTone: 'plain'
        }
      })
      expect(signOut.destructive).toBeUndefined()
      signOut.onPress?.()
      expect(invoke).toHaveBeenCalledWith('sync.accountSignOut', undefined)
    })

    it('signed in and syncing through the account: Sync now with the status line, the other devices with their count, and Sign out that also turns sync off', () => {
      invoke.mockClear()
      const model = section('account', syncState(onAccount()))
      expect(model.groups[0]?.rows.map((r) => r.id)).toEqual([
        'account-email',
        'account-sync-now',
        'account-sync-settings'
      ])
      const syncNow = row(model, 'account-sync-now')
      if (syncNow.kind !== 'action') throw new Error('not an action')
      expect(syncNow).toMatchObject({ label: 'Sync now', button: 'Sync now' })
      expect(syncNow.description).toMatch(/^Last synced /)
      expect(syncNow.disabled).toBeFalsy()
      syncNow.onPress?.()
      expect(invoke).toHaveBeenCalledWith('sync.now', undefined)

      const devices = model.groups[1]!
      expect(devices.aside).toBe('2')
      expect(devices.rows.map((r) => r.id)).toEqual([
        'account-device:dev-3',
        'account-device:dev-2'
      ])
      expect(devices.empty).toBe('No other device has synced to this account yet')

      const signOut = row(model, 'account-sign-out')
      if (signOut.kind !== 'action') throw new Error('not an action')
      expect(signOut.description).toBe('This device stops syncing and keeps what it has.')
      expect(signOut.confirm).toMatchObject({
        description:
          'This device stops syncing and keeps what it has. Your other devices keep syncing.',
        verbTone: 'plain'
      })
      expect(signOut.destructive).toBeUndefined()

      // The merge question first while the first sync waits on it; Sync now waits too.
      const merging = section('account', syncState(onAccount({ pendingMerge: true })))
      expect(merging.groups[0]?.rows.map((r) => r.id)).toEqual([
        'account-email',
        'account-merge',
        'account-sync-now',
        'account-sync-settings'
      ])
      const merge = row(merging, 'account-merge')
      if (merge.kind !== 'action') throw new Error('not an action')
      expect(merge.form?.title).toBe('Combine with the data in your account?')
      expect(row(merging, 'account-sync-now')).toMatchObject({ disabled: true })

      // An error the engine keeps is the §9.33 sentence under Sync now, in the danger ink.
      const failing = section(
        'account',
        syncState(onAccount({ lastError: 'x', lastErrorKind: 'quota' }))
      )
      expect(row(failing, 'account-sync-now')).toMatchObject({
        tone: 'danger',
        description: 'Your Zenium account’s sync storage is full.'
      })
    })

    it('signed out by the service: the message row over Sign in again; syncing another way: a fact and the way to Sync; no service: one row', () => {
      const signedOut = section('account', syncState(onAccount({ accountSignedOut: true })))
      expect(signedOut.groups.map((g) => g.id)).toEqual(['account'])
      expect(signedOut.groups[0]?.rows.map((r) => r.id)).toEqual([
        'account-signed-out',
        'account-sign-in'
      ])
      expect(row(signedOut, 'account-signed-out')).toMatchObject({
        kind: 'info',
        tone: 'danger',
        label: 'You were signed out of your Zenium account'
      })
      expect(row(signedOut, 'account-sign-in')).toMatchObject({ label: 'Sign in again' })

      const folder = section(
        'account',
        syncState(connected({ accountAvailable: true, account: { email: EMAIL } }))
      )
      expect(folder.groups[0]?.rows.map((r) => r.id)).toEqual([
        'account-email',
        'account-sync-elsewhere',
        'account-sync-settings'
      ])
      expect(row(folder, 'account-sync-elsewhere')).toMatchObject({
        kind: 'info',
        label: 'Sync',
        description:
          'This device syncs through a folder, not your account. Turn off sync under Sync to sync through your account instead.'
      })
      expect(folder.groups[1]).toMatchObject({ rows: [] })
      expect(folder.groups[1]?.aside).toBeUndefined()
      const folderSignOut = row(folder, 'account-sign-out')
      if (folderSignOut.kind !== 'action') throw new Error('not an action')
      expect(folderSignOut.description).toBe('This device forgets the sign-in.')
      expect(folderSignOut.confirm?.description).toBe('This device forgets the sign-in.')

      const none = section('account', syncState(syncStatus()))
      expect(none.groups.map((g) => g.id)).toEqual(['account'])
      expect(none.groups[0]?.rows.map((r) => r.id)).toEqual(['account-unavailable'])
      expect(row(none, 'account-unavailable')).toMatchObject({
        label: 'Not available on this device'
      })
    })

    it('the desktop page draws the same rows with their buttons (§10.5)', () => {
      const def = PAGE.sections.find((x) => x.id === 'account')!
      const model = buildSection(def, {
        ...context(syncState(onAccount())).ctx,
        formFactor: 'desktop'
      })
      expect(
        allRows(model.groups).flatMap((r) => (r.kind === 'action' ? [[r.id, r.button]] : []))
      ).toEqual([
        ['account-sync-now', 'Sync now'],
        ['account-sync-settings', 'Open'],
        ['account-sign-out', 'Sign out…']
      ])
    })
  })
})

describe('SET-36 / NTP-30: the Home group of Look and Feel on a phone', () => {
  const homeGroup = (s: UIState = state()): RowGroup => {
    const group = section('look', s).groups.find((g) => g.id === 'home')
    if (!group) throw new Error('no Home group')
    return group
  }
  const withHomepage = (homepage: Settings['homepage'], patch: Partial<UIState> = {}): UIState =>
    state(patch, { homepage })

  it('is the phone’s, headed Home, with the Homepage value row and the §9.13 picker: Off, New tab page, Specific page', () => {
    const group = homeGroup()
    expect(group.heading).toBe('Home')
    expect(group.layouts).toEqual(['phone'])
    expect(group.rows.map((r) => r.id)).toEqual(['homepage'])
    const homepage = group.rows[0]
    if (homepage.kind !== 'value') throw new Error('not a value row')
    expect(homepage.label).toBe('Homepage')
    expect(currentOptionLabel(homepage)).toBe('New tab page')
    // Home is a button wherever it lives (§9.13): the copy names one thing.
    expect(homepage.sheetDescription).toBe('Where the Home button goes.')
    expect(homepage.options.map((o) => [o.label, o.description ?? ''])).toEqual([
      ['Off', 'No Home button.'],
      ['New tab page', ''],
      ['Specific page', 'Enter an address below, or use the current page.']
    ])
    // The search finds it by the words a user has for it.
    expect(searchRows(phoneSections(), 'home button').map((h) => h.row.id)).toContain('homepage')
  })

  it('a choice patches the mode and keeps the address; Specific page reveals the Address row and Use current page', () => {
    const c = context(withHomepage({ mode: 'newtab', url: 'https://kept.example/' }))
    const look = buildSection(PAGE.sections[0], c.ctx)
    const homepage = row(look, 'homepage')
    if (homepage.kind !== 'value') throw new Error('not a value row')
    homepage.onChange('url')
    expect(c.patches).toEqual([{ homepage: { mode: 'url', url: 'https://kept.example/' } }])

    const group = homeGroup(withHomepage({ mode: 'url', url: '' }))
    expect(group.rows.map((r) => r.id)).toEqual([
      'homepage',
      'homepage-address',
      'homepage-use-current'
    ])
    const address = group.rows[1]
    if (address.kind !== 'field') throw new Error('not a field row')
    // A §9.12 URL field: the address keyboard, the host as its hint, "Not set" until one is.
    expect(address).toMatchObject({
      label: 'Address',
      input: 'url',
      value: '',
      display: 'Not set',
      placeholder: 'example.com',
      layouts: ['phone']
    })
    // "Not set" is a word, not an address: no start-ellipsis until a page is held (seed #29).
    expect(address.address).toBe(false)
    const specific = group.rows[0]
    if (specific.kind !== 'value') throw new Error('not a value row')
    expect(specific.options[2]).toMatchObject({
      description: 'Enter an address below, or use the current page.',
      address: false
    })
  })

  it('the Address sheet refuses what is not a web page and keeps the sheet up; a host becomes its https page', () => {
    const c = context(withHomepage({ mode: 'url', url: '' }))
    const look = buildSection(PAGE.sections[0], c.ctx)
    const address = row(look, 'homepage-address')
    if (address.kind !== 'field') throw new Error('not a field row')
    expect(address.onCommit('zen://settings')).toBe('Enter a web address, like example.com')
    expect(address.onCommit('   ')).toBe('Enter a web address, like example.com')
    expect(c.patches).toEqual([])
    expect(address.onCommit('news.ycombinator.com')).toBeUndefined()
    expect(c.patches).toEqual([{ homepage: { mode: 'url', url: 'https://news.ycombinator.com/' } }])
  })

  it('shows the page set: the row reads Specific page, the option and the field carry the address without its scheme', () => {
    const group = homeGroup(withHomepage({ mode: 'url', url: 'https://news.ycombinator.com/' }))
    const homepage = group.rows[0]
    if (homepage.kind !== 'value') throw new Error('not a value row')
    expect(currentOptionLabel(homepage)).toBe('Specific page')
    expect(homepage.options[2]).toMatchObject({
      label: 'Specific page',
      description: 'news.ycombinator.com',
      // An address: one line, shortened from its start so the page's end stays (seed #29).
      address: true
    })
    const address = group.rows[1]
    if (address.kind !== 'field') throw new Error('not a field row')
    expect(address.value).toBe('news.ycombinator.com')
    expect(address.display).toBe('news.ycombinator.com')
    expect(address.address).toBe(true)
  })

  it('Use current page names the page Settings was opened from and writes it; without one it is disabled and says what to do', () => {
    const c = context(withHomepage({ mode: 'url', url: '' }))
    const look = buildSection(PAGE.sections[0], c.ctx)
    const current = row(look, 'homepage-use-current')
    if (current.kind !== 'action') throw new Error('not an action row')
    // The Settings tab's opener is the site (`SETTINGS.openerTabId`).
    expect(current.disabled).toBe(false)
    expect(current.description).toBe('news.example')
    expect(current.address).toBe(true)
    current.onPress?.()
    expect(c.patches).toEqual([{ homepage: { mode: 'url', url: 'https://news.example/' } }])

    // Settings opened from nowhere (the menu of a blank tab): nothing to use.
    const orphan = tab('settings', 'zen://settings', { title: 'Settings' })
    const nowhere = withHomepage(
      { mode: 'url', url: '' },
      { tabs: { site: SITE, settings: orphan } }
    )
    const idle = row(section('look', nowhere), 'homepage-use-current')
    if (idle.kind !== 'action') throw new Error('not an action row')
    expect(idle.disabled).toBe(true)
    expect(idle.description).toBe('Open a page, then come back to Settings from it.')
    expect(idle.address).toBe(false)

    // An opener that is an internal page is no page of the user's either…
    const internal = withHomepage(
      { mode: 'url', url: '' },
      { tabs: { site: tab('site', 'zen://history'), settings: SETTINGS } }
    )
    const fromInternal = row(section('look', internal), 'homepage-use-current')
    if (fromInternal.kind !== 'action') throw new Error('not an action row')
    expect(fromInternal.disabled).toBe(true)

    // …and a private window's page is never offered as the homepage.
    const priv = withHomepage(
      { mode: 'url', url: '' },
      { window: { ...state().window, kind: 'private' } }
    )
    const fromPrivate = row(section('look', priv), 'homepage-use-current')
    if (fromPrivate.kind !== 'action') throw new Error('not an action row')
    expect(fromPrivate.disabled).toBe(true)
  })

  it('Off and New tab page show the value row alone', () => {
    expect(homeGroup(withHomepage({ mode: 'off', url: '' })).rows.map((r) => r.id)).toEqual([
      'homepage'
    ])
    expect(
      homeGroup(withHomepage({ mode: 'newtab', url: 'https://kept.example/' })).rows.map(
        (r) => r.id
      )
    ).toEqual(['homepage'])
  })

  it('an extension holding the homepage (chrome_settings_overrides.homepage; state.extensionControls.homepage with its page) holds the rows: the picker at Specific page, the Address showing the extension’s page over the user’s, Use current page with them – one run under one indicator; Off stays the user’s, and the row is free again without the extension', () => {
    const extension = { extensionId: 'a'.repeat(32), name: 'Bing Homepage & Search' }
    const extensionControls = { homepage: { ...extension, value: 'https://www.bing.com/' } }
    // The user's own page underneath differs from the extension's.
    const held = homeGroup(
      withHomepage({ mode: 'url', url: 'https://news.example/' }, { extensionControls })
    )
    expect(held.rows.map((r) => r.id)).toEqual([
      'homepage',
      'homepage-address',
      'homepage-use-current'
    ])
    const picker = held.rows[0]
    if (picker.kind !== 'value') throw new Error('not a value row')
    expect(picker.controlled).toMatchObject({ ...extension, value: 'https://www.bing.com/' })
    expect(currentOptionLabel(picker)).toBe('Specific page')
    expect(picker.options[2]).toMatchObject({ label: 'Specific page', description: 'bing.com' })
    const address = held.rows[1]
    if (address.kind !== 'field') throw new Error('not a field row')
    expect(address.controlled).toMatchObject(extension)
    expect(address.value).toBe('bing.com')
    expect(held.rows[2].controlled).toMatchObject(extension)
    // One run of three held rows: the indicator stands after the last (§10.5's rule).
    expect(controlledRuns(held.rows)).toEqual([0, 0, 3])

    // Over the new tab page as well: the extension's page is what Home opens.
    const overNewTab = homeGroup(withHomepage({ mode: 'newtab', url: '' }, { extensionControls }))
    expect(overNewTab.rows.map((r) => r.id)).toEqual([
      'homepage',
      'homepage-address',
      'homepage-use-current'
    ])
    expect(overNewTab.rows[0].controlled).toMatchObject(extension)

    // Off is the user's – Chrome's "Show home button" is no extension's: the row stands free,
    // Off, alone; the extension's page waits until the button is on.
    const off = homeGroup(withHomepage({ mode: 'off', url: '' }, { extensionControls }))
    expect(off.rows.map((r) => r.id)).toEqual(['homepage'])
    expect(off.rows[0].controlled).toBeUndefined()
    if (off.rows[0].kind !== 'value') throw new Error('not a value row')
    expect(currentOptionLabel(off.rows[0])).toBe('Off')

    // A choice made from the held state's neighbour keeps the user's own address, not the extension's.
    const c = context(
      withHomepage({ mode: 'newtab', url: 'https://kept.example/' }, { extensionControls })
    )
    const look = buildSection(PAGE.sections[0], c.ctx)
    const homepage = row(look, 'homepage')
    if (homepage.kind !== 'value') throw new Error('not a value row')
    homepage.onChange('url')
    expect(c.patches).toEqual([{ homepage: { mode: 'url', url: 'https://kept.example/' } }])

    // Disable takes the Extensions page's path; nothing held without the extension.
    homepage.controlled!.onDisable()
    expect(invoke).toHaveBeenCalledWith('extension.setEnabled', {
      id: extension.extensionId,
      enabled: false
    })
    const free = homeGroup(withHomepage({ mode: 'url', url: 'https://news.example/' }))
    expect(free.rows[0].controlled).toBeUndefined()
  })
})

/* ---- W8-3: Appearance's theme row, the Home button rows, the system accent ---- */

describe('W8-3: Settings › Appearance on the desktop – the theme row (settings-30), Show home button (settings-32), Use system accent colour (settings-116)', () => {
  /** The Look and Feel category on a form factor, with the patches its rows write. */
  function look(
    s: UIState = state(),
    formFactor: FormFactor = 'desktop'
  ): { model: Model; patches: Partial<Settings>[] } {
    const c = context(s)
    return { model: buildSection(PAGE.sections[0], { ...c.ctx, formFactor }), patches: c.patches }
  }
  const appearanceIds = (model: Model): string[] =>
    model.groups.find((g) => g.id === 'appearance')!.rows.map((r) => r.id)
  const themed = (patch: Partial<UIState> = {}, settings: Partial<Settings> = {}): UIState =>
    state(
      {
        spaces: [
          {
            id: 'space',
            name: 'Personal',
            icon: '',
            activeTabId: 'settings',
            tabIds: ['site', 'settings'],
            theme: makeTheme('#2f6fed', ['#5ac8fa'])
          } as unknown as UIState['spaces'][number]
        ],
        ...patch
      },
      settings
    )

  it('the theme row stands after Colour scheme on the desktop and the tablet, never on the phone, naming the active space’s theme and the space – "Default · Personal Space" at rest (the picker’s own description, #572’s N5) – with the picker as its door (Chrome’s row opens Customize Chrome; no store is named), hung from the Change… button that opened it (§9.20, #572’s L8)', async () => {
    const { model } = look()
    const ids = appearanceIds(model)
    expect(ids.slice(0, 2)).toEqual(['color-scheme', 'theme'])
    const theme = row(model, 'theme')
    expect(theme).toMatchObject({
      kind: 'action',
      label: 'Theme',
      description: 'Default · Personal Space',
      layouts: ['desktop', 'tablet'],
      button: 'Change…',
      // The button hangs the `theme` overlay from itself (round C): the row's view draws it as
      // the popover's anchor – aria-haspopup="dialog", aria-expanded while the picker hangs.
      popover: 'theme'
    })
    if (theme.kind !== 'action') throw new Error('not an action row')
    expect(theme.anchors).toBeUndefined()
    // The desktop button passes itself (`anchorOf`, lib/anchor.ts); the picker opens for the
    // space as the `theme` overlay with the anchor's boxes in the store – the element stays
    // with the button – and not through the core's `theme.open`, which seats the picker.
    const column = { x: 400, y: 0, width: 1200, height: 1000 }
    theme.onPress?.({ x: 1000, y: 240, width: 88, height: 32, column })
    await vi.waitFor(() => expect(uiStore.get().overlay).toBe('theme'))
    expect(uiStore.get().overlaySpaceId).toBe('space')
    expect(uiStore.get().overlayAnchor).toEqual({ x: 1000, y: 240, width: 88, height: 32, column })
    expect(invoke).not.toHaveBeenCalledWith('urlbar.runCommand', { action: 'theme.open' })
    uiStore.set({ overlay: 'none', overlaySpaceId: null, overlayAnchor: null })
    // Without a control (nothing on the desktop presses it so; the guard) it opens at its seat.
    theme.onPress?.()
    await vi.waitFor(() => expect(uiStore.get().overlay).toBe('theme'))
    expect(uiStore.get().overlayAnchor).toBeNull()
    uiStore.set({ overlay: 'none', overlaySpaceId: null })
    expect(rowText(theme).toLowerCase()).not.toContain('store')
    expect(onLayout(model.groups, 'tablet').some((g) => g.rows.some((r) => r.id === 'theme'))).toBe(
      true
    )
    expect(onLayout(model.groups, 'phone').some((g) => g.rows.some((r) => r.id === 'theme'))).toBe(
      false
    )
  })

  it('with a theme the row names it – a preset by its name, colours of the user’s own "Custom" – and trails "Reset to default", the picker’s button by the same name: one space.update putting the theme to null (§9.1)', () => {
    invoke.mockClear()
    const { model } = look(themed())
    const theme = row(model, 'theme')
    expect(theme).toMatchObject({
      description: 'Custom · Personal Space',
      button: 'Reset to default'
    })
    if (theme.kind !== 'action') throw new Error('not an action row')
    // Reset to default opens nothing (no `popover`), but it is the picker's anchor still while
    // the picker its Change… opened hangs from it (`anchors`, round C): one element through
    // the flip, expanded and lit until the popover closes.
    expect(theme.popover).toBeUndefined()
    expect(theme.anchors).toBe('theme')
    theme.onPress?.()
    expect(invoke).toHaveBeenCalledWith('space.update', {
      spaceId: 'space',
      patch: { theme: null }
    })
    // A preset as the picker wrote it reads by its name; the space is named the same way with
    // several spaces as with one.
    const preset = state({
      spaces: [
        {
          id: 'space',
          name: 'Work',
          icon: '',
          activeTabId: 'settings',
          tabIds: ['site', 'settings'],
          theme: structuredClone(THEME_PRESETS[1].theme)
        },
        { id: 'other', name: 'Play', icon: '', activeTabId: null, tabIds: [] }
      ] as unknown as UIState['spaces']
    })
    expect(row(look(preset).model, 'theme').description).toBe(
      `${THEME_PRESETS[1].name} · Work Space`
    )
  })

  it('"Show home button" is the Home control’s pin (toolbarPins.home; Chrome’s show_home_button, off by default), desktop alone: off it stands by itself, on it writes home: true and reveals the Home page value row – Chrome’s radio – at New Tab page', () => {
    const { model, patches } = look()
    const ids = appearanceIds(model)
    expect(
      ids.slice(ids.indexOf('show-forward-button'), ids.indexOf('show-forward-button') + 3)
    ).toEqual(['show-forward-button', 'show-home-button', 'customize-toolbar'])
    const show = row(model, 'show-home-button')
    expect(show).toMatchObject({
      kind: 'switch',
      label: 'Show home button',
      checked: false,
      layouts: ['desktop']
    })
    if (show.kind !== 'switch') throw new Error('not a switch')
    show.onChange(true)
    expect(patches).toEqual([{ toolbarPins: { home: true } }])
    // The search finds it by Chrome's words and the user's.
    for (const query of ['home button', 'homepage', 'home page'])
      expect(
        searchRows([model], query).map((h) => h.row.id),
        query
      ).toContain('show-home-button')

    const on = look(state({}, { toolbarPins: { home: true } }))
    const onIds = appearanceIds(on.model)
    expect(
      onIds.slice(onIds.indexOf('show-home-button'), onIds.indexOf('show-home-button') + 3)
    ).toEqual(['show-home-button', 'home-page', 'customize-toolbar'])
    const page = row(on.model, 'home-page')
    if (page.kind !== 'value') throw new Error('not a value row')
    // §9.14's radios on the desktop (the lead's Q7 on #572), not the menulist – W8-2's radio-list
    // row (`ValueRow.radios`, pr-584 R2), the one primitive for a page's radios.
    expect(page).toMatchObject({ label: 'Home page', layouts: ['desktop'], radios: true })
    expect(currentOptionLabel(page)).toBe('New Tab page')
    expect(page.options.map((o) => o.label)).toEqual(['New Tab page', 'Enter custom web address'])
    page.onChange('url')
    expect(on.patches).toEqual([{ homepage: { mode: 'url', url: '' } }])
    // Off again folds the page rows with it; the phone and the tablet never see any of them.
    const off = row(on.model, 'show-home-button')
    if (off.kind !== 'switch') throw new Error('not a switch')
    off.onChange(false)
    expect(on.patches.at(-1)).toEqual({ toolbarPins: {} })
    for (const formFactor of ['phone', 'tablet'] as const)
      for (const id of ['show-home-button', 'home-page', 'home-page-address'])
        expect(
          findRow(look(state({}, { toolbarPins: { home: true } }), formFactor).model.groups, id),
          `${id} on the ${formFactor}`
        ).toBeNull()
  })

  it('"Enter custom web address" reveals the Address field (§9.12, stacked): what is typed is fixed up as Chrome’s FixupURL does – a bare domain becomes its https page – and what is no web address is refused with the line under the field', () => {
    const { model, patches } = look(
      state({}, { toolbarPins: { home: true }, homepage: { mode: 'url', url: '' } })
    )
    const ids = appearanceIds(model)
    expect(ids.slice(ids.indexOf('home-page'), ids.indexOf('home-page') + 2)).toEqual([
      'home-page',
      'home-page-address'
    ])
    const address = row(model, 'home-page-address')
    if (address.kind !== 'field') throw new Error('not a field row')
    expect(address).toMatchObject({
      label: 'Address',
      input: 'url',
      form: 'stacked',
      value: '',
      display: 'Not set',
      placeholder: 'Enter custom web address',
      layouts: ['desktop']
    })
    expect(address.onCommit('zen://settings')).toBe('Enter a web address, like example.com')
    expect(address.onCommit('not a url at all')).toBe('Enter a web address, like example.com')
    expect(address.onCommit('')).toBe('Enter a web address, like example.com')
    expect(patches).toEqual([])
    expect(address.onCommit('news.ycombinator.com')).toBeUndefined()
    expect(patches).toEqual([{ homepage: { mode: 'url', url: 'https://news.ycombinator.com/' } }])
    expect(address.onCommit('  http://example.com/a?b=c  ')).toBeUndefined()
    expect(patches.at(-1)).toEqual({ homepage: { mode: 'url', url: 'http://example.com/a?b=c' } })
    // The page set reads without its scheme, as the phone's row does.
    const set = look(
      state(
        {},
        {
          toolbarPins: { home: true },
          homepage: { mode: 'url', url: 'https://news.ycombinator.com/' }
        }
      )
    )
    const shown = row(set.model, 'home-page-address')
    if (shown.kind !== 'field') throw new Error('not a field row')
    expect(shown.value).toBe('news.ycombinator.com')
    expect(currentOptionLabel(row(set.model, 'home-page') as never)).toBe(
      'Enter custom web address'
    )
  })

  it('a phone’s Off reads as New Tab page on the desktop (Chrome has no Off) and an extension’s homepage holds the two rows at its page, as it holds the phone’s', () => {
    const off = look(state({}, { toolbarPins: { home: true }, homepage: { mode: 'off', url: '' } }))
    expect(appearanceIds(off.model)).not.toContain('home-page-address')
    expect(currentOptionLabel(row(off.model, 'home-page') as never)).toBe('New Tab page')
    const extension = { extensionId: 'a'.repeat(32), name: 'Bing Homepage & Search' }
    const held = look(
      state(
        { extensionControls: { homepage: { ...extension, value: 'https://www.bing.com/' } } },
        { toolbarPins: { home: true }, homepage: { mode: 'newtab', url: '' } }
      )
    )
    const page = row(held.model, 'home-page')
    const address = row(held.model, 'home-page-address')
    expect(page.controlled).toMatchObject(extension)
    expect(address.controlled).toMatchObject(extension)
    if (address.kind !== 'field') throw new Error('not a field row')
    expect(address.value).toBe('bing.com')
    // The switch itself is the user's: Chrome's "Show home button" is no extension's to set.
    expect(row(held.model, 'show-home-button').controlled).toBeUndefined()
  })

  it('"Use system accent colour" stands under the theme row on the desktop where the host read an OS accent (Windows, macOS), off by default as Chrome’s follows_system_colors is, and is absent where there is none to read (Linux)', () => {
    // No accent read (Linux, the fixture's default): no row, and the search has none either.
    expect(appearanceIds(look().model)).not.toContain('use-system-accent')
    const withAccent = look(state({ systemAccent: '#0078d4' }))
    const ids = appearanceIds(withAccent.model)
    expect(ids.slice(0, 3)).toEqual(['color-scheme', 'theme', 'use-system-accent'])
    const accent = row(withAccent.model, 'use-system-accent')
    expect(accent).toMatchObject({
      kind: 'switch',
      label: 'Use system accent colour',
      description: 'Controls take the colour your system uses.',
      checked: false,
      layouts: ['desktop']
    })
    if (accent.kind !== 'switch') throw new Error('not a switch')
    accent.onChange(true)
    expect(withAccent.patches).toEqual([{ useSystemAccent: true }])
    // A themed space keeps its own accent: the row says when the OS's shows.
    expect(
      row(look(themed({ systemAccent: '#0078d4' })).model, 'use-system-accent').description
    ).toBe('Controls take the colour your system uses while the Space has the default look.')
    for (const formFactor of ['phone', 'tablet'] as const)
      expect(
        findRow(
          look(state({ systemAccent: '#0078d4' }), formFactor).model.groups,
          'use-system-accent'
        ),
        formFactor
      ).toBeNull()
  })

  it('"Show the mini menu when text is selected" (CT-39; Edge’s Appearance › Context menus row) closes the Appearance group on desktop hosts with the popup surface, in the desktop and tablet layouts, on by default with an absent value reading as on, and is absent without the capability and off the phone', () => {
    // The fixture's host has no popup surface: no row, and the search has none either.
    expect(appearanceIds(look().model)).not.toContain('show-selection-menu')
    const host = (settings: Partial<Settings> = {}): UIState =>
      state({ capabilities: { ...ANDROID, selectionMenu: true } }, settings)
    const on = look(host())
    expect(appearanceIds(on.model).at(-1)).toBe('show-selection-menu')
    const menu = row(on.model, 'show-selection-menu')
    expect(menu).toMatchObject({
      kind: 'switch',
      label: 'Show the mini menu when text is selected',
      checked: true,
      layouts: ['desktop', 'tablet']
    })
    expect(menu.description).toBeUndefined()
    if (menu.kind !== 'switch') throw new Error('not a switch')
    menu.onChange(false)
    expect(on.patches).toEqual([{ showSelectionMenu: false }])
    expect(
      row(look(host({ showSelectionMenu: false })).model, 'show-selection-menu')
    ).toMatchObject({ checked: false })
    // A desktop host laid out at a tablet width (a coarse pointer) still runs the menu: its row stays.
    expect(findRow(look(host(), 'tablet').model.groups, 'show-selection-menu')).not.toBeNull()
    expect(findRow(look(host(), 'phone').model.groups, 'show-selection-menu')).toBeNull()
  })
})

/* ---- W7-6: the Privacy and security hub cards, Reset settings ---- */

describe('the Privacy and security hub (W7-6, settings-12)', () => {
  /** The privacy category with a context that records which group a card asks the page for. */
  function hub(s: UIState = state()): { privacy: Model; revealed: string[] } {
    const revealed: string[] = []
    const def = PAGE.sections.find((x) => x.id === 'privacy')!
    const privacy = buildSection(def, {
      ...context(s).ctx,
      reveal: (groupId) => revealed.push(groupId)
    })
    return { privacy, revealed }
  }

  it('leads the category with Chrome’s cards in Chrome’s order, each a §10.4 action row with a glyph and one line – the four landings with a chevron, the dialog card with §9.1’s ellipsis and none', () => {
    const { privacy } = hub()
    const cards = privacy.groups[0]
    expect(cards).toMatchObject({
      id: 'privacy-hub',
      heading: null,
      layouts: ['desktop', 'tablet']
    })
    // The first card follows the dialog it opens by name (the #553 lead check's F1: one name
    // for one thing) – Chrome's "Delete browsing data" since M124, the family renamed together
    // in W8-7; the third names its landing, Safe Browsing, since the nav has a Security
    // category (F3 / Q4).
    expect(cards.rows.map((r) => [r.id, r.label])).toEqual([
      ['hub-clear-data', 'Delete browsing data…'],
      ['hub-cookies', 'Third-party cookies'],
      ['hub-security', 'Safe Browsing'],
      ['hub-site-settings', 'Site settings'],
      ['hub-safety-check', 'Safety check']
    ])
    for (const card of cards.rows) {
      if (card.kind !== 'action') throw new Error(`${card.id} is not an action row`)
      // A chevron says the card moves the page to its landing (Q5); a dialog is said by the
      // ellipsis, and the row's `aria-haspopup` (rows.tsx) – no chevron (F1).
      expect(card.leaves).toBe(card.id === 'hub-clear-data' ? undefined : 'chevron')
      expect(card.button).toBeUndefined()
      expect(glyphClass(card.leading)).toBe('zen-settings-glyph')
      expect(card.description).toBeTruthy()
    }
    expect(cards.rows.map((r) => r.description)).toEqual([
      'Delete history, cookies, cache and more',
      // The default setting, on a host with private tabs (the fixture's capabilities).
      'Third-party cookies are blocked in private tabs',
      'Safe Browsing (protection from dangerous sites) and other security settings',
      'What sites may use and show (location, camera, pop-ups and more)',
      // "Data breaches" is what the check does: Password Checkup's HIBP range lookup (Q8).
      'Zenium can help keep you safe from data breaches, bad extensions and more'
    ])
  })

  it('lands each card on its program’s first group – present under the cards – and opens the PS-13 dialog from Delete browsing data…', () => {
    const { privacy, revealed } = hub()
    const groupIds = privacy.groups.map((g) => g.id)
    const targets = ['site-data', 'safe-browsing', 'sites-permissions', 'safety-check']
    for (const target of targets) expect(groupIds.indexOf(target)).toBeGreaterThan(0)
    // Each program's first group: the card lands at the program's head, not in its middle.
    expect(groupIds.indexOf('safe-browsing')).toBeLessThan(groupIds.indexOf('safe-browsing-feeds'))
    expect(groupIds.indexOf('safety-check')).toBeLessThan(groupIds.indexOf('safety-check-results'))
    expect(groupIds.indexOf('sites-permissions')).toBeLessThan(groupIds.indexOf('sites-own'))

    const cards = privacy.groups[0].rows
    for (const id of ['hub-cookies', 'hub-security', 'hub-site-settings', 'hub-safety-check']) {
      const card = row(privacy, id)
      if (card.kind !== 'action') throw new Error('not an action row')
      expect(card.form).toBeUndefined()
      card.onPress?.()
    }
    expect(revealed).toEqual(targets)

    const clear = cards[0]
    if (clear.kind !== 'action') throw new Error('not an action row')
    // The same sheet as the Delete browsing data row's (`clear-data-open`), no landing.
    expect(clear.form?.title).toBe('Delete browsing data')
    expect(clear.onPress).toBeUndefined()
    const existing = row(privacy, 'clear-data-open')
    if (existing.kind !== 'action') throw new Error('not an action row')
    expect(existing.form).toBe(clear.form)
    // Nothing of the section went: the programs' groups stand under the cards as before.
    expect(groupIds.slice(1)).toEqual(
      section('privacy')
        .groups.map((g) => g.id)
        .slice(1)
    )
    expect(groupIds.slice(1)).toContain('clear-data')
  })

  it('keeps the cards to the desktop and tablet shells: the phone’s Privacy page is the plain list, in the cards’ order (W8-8)', () => {
    const { privacy } = hub()
    const phone = onLayout(privacy.groups, 'phone').map((g) => g.id)
    expect(phone).not.toContain('privacy-hub')
    // The phone's list moves with the desktop's groups (the #553 lead check's Q6): Delete
    // browsing data leads it, the carded programs follow in the cards' order, Safety check the
    // last of them; the same groups, the cards alone taken away.
    expect(phone[0]).toBe('clear-data')
    expect(phone).toEqual(privacy.groups.map((g) => g.id).slice(1))
    const heads = ['clear-data', 'site-data', 'safe-browsing', 'sites-permissions', 'safety-check']
    expect(phone.filter((id) => heads.includes(id))).toEqual(heads)
    expect(onLayout(privacy.groups, 'desktop')[0].id).toBe('privacy-hub')
    expect(onLayout(privacy.groups, 'tablet')[0].id).toBe('privacy-hub')
    // A phone in landscape draws the two panes (`formFactor: 'phone'` still): no cards there either.
    expect(onLayout(privacy.groups, 'phone').length).toBe(privacy.groups.length - 1)
  })

  it('reads the Third-party cookies card’s line from the site-data default and the private choice', () => {
    const line = (s: UIState): string | undefined => row(hub(s).privacy, 'hub-cookies').description
    expect(line(state({ siteData: { ...emptySiteDataStatus(), default: 'allow' } }))).toBe(
      'Third-party cookies are allowed'
    )
    expect(line(state({ siteData: { ...emptySiteDataStatus(), default: 'block-all' } }))).toBe(
      'All cookies are blocked'
    )
    expect(
      line(state({}, { privacy: { ...DEFAULT_SETTINGS.privacy, thirdPartyCookies: 'block' } }))
    ).toBe('Third-party cookies are blocked')
    // A host with windows (the desktop) says private windows.
    expect(line(state({ capabilities: { ...ANDROID, windows: true } }))).toBe(
      'Third-party cookies are blocked in private windows'
    )
  })

  it('is found by the search as rows, beside every row under the cards', () => {
    const { privacy } = hub()
    const ids = (q: string): string[] => searchRows([privacy], q).map((h) => h.row.id)
    expect(ids('safety check')).toEqual(
      expect.arrayContaining(['hub-safety-check', 'safety-check-now'])
    )
    expect(ids('site settings')).toContain('hub-site-settings')
    expect(ids('third-party cookies')).toContain('hub-cookies')
    // The dialog card is found by Chrome's M124+ name (its own since W8-7) and still by the
    // pre-M124 one it kept as a search alias; the row under it the same. A card's hit reads
    // the category alone as its caption: the cards' group has no heading.
    expect(ids('clear browsing data')).toEqual(
      expect.arrayContaining(['hub-clear-data', 'clear-data-open'])
    )
    expect(ids('delete browsing data')).toEqual(
      expect.arrayContaining(['hub-clear-data', 'clear-data-open'])
    )
    const hit = searchRows([privacy], 'delete browsing data').find(
      (h) => h.row.id === 'hub-clear-data'
    )
    expect(hit?.caption).toBe('Privacy and Security')
  })
})

/*
 * Settings › Mods (seed #31, the lead's ruling): a Mod is a CSS sheet for the browser chrome,
 * which `ModStyles` injects – mounted by the desktop and tablet shells, never the phone's. The
 * category is the desktop's and the tablet's; a phone draws no Mods page (its switches would
 * apply nothing – a page describing its own absence, the rule #628's transport row and #632's
 * Print row follow), lists none of its rows in the landing's search, and opens the landing for
 * `zen://settings/mods`, as it does for `zen://settings/performance`. The records beneath stay:
 * `ModService`, the desktop's and tablet's page and the `mod` sync record are untouched.
 */
describe('Settings › Mods on the phone (seed #31: hidden, the records untouched)', () => {
  const MOD = {
    id: 'm1',
    name: 'Round tabs',
    source: null,
    css: '.zen-tab { border-radius: 12px }',
    enabled: true,
    updatedAt: 1
  }
  const withMods = (): UIState => state({ mods: [MOD] } as Partial<UIState>)
  const on = (layout: FormFactor, s: UIState = withMods()): Model[] =>
    buildSections(availableSections(PAGE, s.capabilities, layout), {
      ...context(s).ctx,
      formFactor: layout
    })

  it('is a category of the desktop and tablet shells right after Boosts, and not of the phone – whatever the host’s capabilities or the Mods it holds', () => {
    for (const layout of ['desktop', 'tablet'] as const) {
      const ids = availableSections(PAGE, ANDROID, layout).map((s) => s.id)
      expect(ids.indexOf('mods'), layout).toBe(ids.indexOf('boosts') + 1)
      expect(
        on(layout).some((m) => m.section.id === 'mods'),
        layout
      ).toBe(true)
    }
    expect(phoneSections().map((m) => m.section.id)).not.toContain('mods')
    expect(phoneSections(withMods()).map((m) => m.section.id)).not.toContain('mods')
    // The gate is the model's own layout list, as Performance's and Reset Settings' are; no
    // capability and no platform take part.
    const def = PAGE.sections.find((s) => s.id === 'mods')!
    expect(def.layouts).toEqual(['desktop', 'tablet'])
    expect(def.requires).toBeUndefined()
    expect(def.platforms).toBeUndefined()
  })

  it('surfaces none of its rows in the phone landing’s search, while the desktop’s and the tablet’s find the Mod, its switch and the Add a Mod rows', () => {
    const modRows = (models: Model[], q: string): string[] =>
      searchRows(models, q)
        .map((h) => h.row.id)
        .filter((id) => id.startsWith('mod:') || id === 'new-mod' || id.startsWith('import-mod'))
    for (const q of ['mods', 'css', 'round tabs', 'new mod', 'stylesheet', 'userchrome']) {
      expect(modRows(phoneSections(withMods()), q), q).toEqual([])
      expect(
        searchRows(phoneSections(withMods()), q).map((h) => h.caption),
        q
      ).not.toContainEqual(expect.stringMatching(/^Mods/))
    }
    for (const layout of ['desktop', 'tablet'] as const) {
      expect(modRows(on(layout), 'round tabs'), layout).toContain('mod:m1')
      expect(modRows(on(layout), 'new mod'), layout).toContain('new-mod')
      const hit = searchRows(on(layout), 'round tabs').find((h) => h.row.id === 'mod:m1')
      expect(hit?.caption, layout).toBe('Mods › Mods')
    }
  })

  it('leaves the section itself as it was for the shells that draw it: the Mod’s item with its Enabled switch, Name, CSS and Remove, and the Add a Mod rows', () => {
    const mods = on('desktop').find((m) => m.section.id === 'mods')!
    expect(mods.groups.map((g) => g.id)).toEqual(['mods', 'add-mod'])
    const item = row(mods, 'mod:m1')
    if (item.kind !== 'item') throw new Error('not an item row')
    expect(item.label).toBe('Round tabs')
    expect(item.sheet.groups.flatMap((g) => g.rows.map((r) => r.id))).toEqual([
      'mod:m1:enabled',
      'mod:m1:name',
      'mod:m1:css',
      'mod:m1:remove'
    ])
    const enabled = row(mods, 'mod:m1:enabled')
    if (enabled.kind !== 'switch') throw new Error('not a switch row')
    expect(enabled.checked).toBe(true)
    enabled.onChange(false)
    expect(invoke).toHaveBeenCalledWith('mod.update', { id: 'm1', patch: { enabled: false } })
    expect(mods.groups[1].rows.map((r) => r.id)).toEqual([
      'new-mod',
      'import-mod-url',
      'import-mod-file'
    ])
  })
})

describe('Reset settings (W7-6, settings-70)', () => {
  it('is one row at the foot of the list, before About, on the desktop and tablet shells alone – under the title with no sub-heading (F2)', () => {
    for (const layout of ['desktop', 'tablet'] as const) {
      const ids = availableSections(PAGE, ANDROID, layout).map((s) => s.id)
      expect(ids.indexOf('reset')).toBe(ids.indexOf('about') - 1)
    }
    expect(phoneSections().map((m) => m.section.id)).not.toContain('reset')
    const reset = section('reset')
    // Both panes one form (the #553 lead check's F2 / Q3): the row stands under the category's
    // 22 title as the hub's cards do; the category's name is the nav's and the title's.
    expect(reset.groups.map((g) => [g.id, g.heading])).toEqual([['reset', null]])
    expect(reset.groups[0].rows.map((r) => r.id)).toEqual(['reset-settings'])
  })

  it('is "Restore settings to their original defaults", whose §9.23 confirmation carries Chrome’s copy and runs settings.reset', () => {
    const reset = section('reset')
    const restore = row(reset, 'reset-settings')
    if (restore.kind !== 'action') throw new Error('not an action row')
    expect(restore.label).toBe('Restore settings to their original defaults')
    // Label alone, as Chrome's row is: the sentence that says what resets is the confirmation's.
    expect(restore.description).toBeUndefined()
    // A destructive bulk act on the house's chassis: the desktop's trailing button, the danger
    // ink, the confirmation before anything runs.
    expect(restore.button).toBe('Reset…')
    expect(restore.destructive).toBe(true)
    expect(restore.confirm).toEqual({
      title: 'Reset settings?',
      description:
        'This will reset your startup page, home page, new tab page, search engine, pinned tabs, and site permissions. It will also disable all extensions and clear temporary data like cookies. Your bookmarks, history, and saved passwords will not be cleared.',
      action: 'Reset settings'
    })
    expect(invoke).not.toHaveBeenCalled()
    restore.onPress?.()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('settings.reset', undefined)
  })

  it('is found by the search from any category, by Chrome’s words and the row’s own', () => {
    const models = buildSections(availableSections(PAGE, ANDROID, 'desktop'), context().ctx)
    const ids = (q: string): string[] => searchRows(models, q).map((h) => h.row.id)
    expect(ids('restore defaults')).toEqual(['reset-settings'])
    expect(ids('reset settings')).toContain('reset-settings')
    expect(ids('factory')).toContain('reset-settings')
    // The two clauses the round added to the sentence find the row too.
    expect(ids('home page')).toContain('reset-settings')
    expect(ids('site permissions')).toContain('reset-settings')
    // Without a heading the hit's caption is the category alone.
    const hit = searchRows(models, 'restore defaults')[0]
    expect(hit.caption).toBe('Reset Settings')
  })
})

/*
 * Settings › System (Chrome's chrome://settings/system): the one row that opens the computer's
 * proxy settings – the OS panel – and, while an extension holds `chrome.proxy`, the §10.5
 * controlled-setting primitive on it: the host publishes `extensionControls.proxy` with the
 * configuration's mode as the value (`ProxyApi.publishControls`, `PROXY_CONTROL_KEY`).
 */
describe('Settings › System: "Open your computer\'s proxy settings" (Chrome\'s System page)', () => {
  const desktop = (patch: Partial<UIState> = {}): UIState =>
    state({ platform: 'linux', capabilities: { ...ANDROID, windows: true }, ...patch })
  const extension = { extensionId: 'c'.repeat(32), name: 'FoxyProxy' }
  const holding = (value?: string): UIState =>
    desktop({
      extensionControls: { proxy: { ...extension, ...(value === undefined ? {} : { value }) } }
    })

  it('is a category of the desktop OSes, before Reset Settings as Chrome’s System precedes its Reset settings; Android has none, on any layout', () => {
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      const ids = availableSections(PAGE, ANDROID, 'desktop', platform).map((s) => s.id)
      expect(ids.indexOf('system'), platform).toBe(ids.indexOf('reset') - 1)
    }
    for (const layout of ['phone', 'tablet', 'desktop'] as const) {
      expect(availableSections(PAGE, ANDROID, layout, 'android').map((s) => s.id)).not.toContain(
        'system'
      )
    }
    expect(phoneSections().map((m) => m.section.id)).not.toContain('system')
    const def = PAGE.sections.find((s) => s.id === 'system')!
    expect(def.label).toBe('System')
    expect(def.platforms).toEqual(['win32', 'darwin', 'linux'])
  })

  it('is one action row under the title with no sub-heading, Chrome’s label word for word, leaving for the OS panel, whose press asks the host for the panel and says so in one sentence when nothing opened', async () => {
    const model = section('system', desktop())
    expect(model.groups.map((g) => [g.id, g.heading])).toEqual([['system', null]])
    const proxy = row(model, 'proxy-settings')
    if (proxy.kind !== 'action') throw new Error('not an action row')
    expect(proxy).toMatchObject({
      label: "Open your computer's proxy settings",
      description: "Zenium uses your computer's proxy settings.",
      leaves: 'external'
    })
    expect(proxy.button).toBeUndefined()
    expect(proxy.controlled).toBeUndefined()
    // The door opened: the host says so and the page says nothing.
    invoke.mockResolvedValueOnce('opened' as unknown as null)
    proxy.onPress?.()
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('system.openProxySettings', undefined)
    )
    await Promise.resolve()
    expect(uiStore.get().toasts.map((t) => t.message)).toEqual([])
    // No door (a Linux desktop Chrome's table does not know, its tool not on the PATH): one
    // sentence in Zenium's words, on the frame's toast.
    invoke.mockResolvedValueOnce('unsupported' as unknown as null)
    proxy.onPress?.()
    await vi.waitFor(() =>
      expect(uiStore.get().toasts.map((t) => [t.message, t.kind])).toEqual([
        ["Zenium could not open your computer's proxy settings.", 'info']
      ])
    )
    uiStore.set({ toasts: [] })
  })

  it('is held while an extension holds chrome.proxy: the row carries the control (one indicator row after it, "Controlled by FoxyProxy"), its description the configuration’s mode alone in Chrome’s words – the indicator names the holder – Disable takes the Extensions page’s path', () => {
    const held = section('system', holding('fixed_servers'))
    const proxy = row(held, 'proxy-settings')
    expect(proxy.controlled).toMatchObject({ ...extension, value: 'fixed_servers' })
    expect(proxy.description).toBe('Using fixed servers.')
    expect(proxy.description).not.toContain('FoxyProxy')
    // The primitive draws the indicator after the run: one row, one indicator.
    expect(controlledRuns(held.groups[0]!.rows)).toEqual([1])
    // The five modes of a `chrome.proxy` configuration (the API's `Mode`, the host's value), each
    // one sentence in Chrome's words and nothing else; the map is total over the five.
    const modes: Array<[ProxyMode, string]> = [
      ['fixed_servers', 'Using fixed servers.'],
      ['pac_script', 'Using a PAC script.'],
      ['auto_detect', 'Using automatic detection.'],
      ['direct', 'Using a direct connection.'],
      ['system', "Using the system's proxy settings."]
    ]
    expect(modes.map(([mode]) => mode).sort()).toEqual([...PROXY_MODES].sort())
    expect(Object.keys(PROXY_SETTINGS_COPY.modes).sort()).toEqual([...PROXY_MODES].sort())
    for (const [mode, sentence] of modes) {
      expect(row(section('system', holding(mode)), 'proxy-settings').description, mode).toBe(
        sentence
      )
    }
    // Disable takes the Extensions page's path; the host's proxy service puts the sessions back
    // on the system proxy as the extension unloads.
    proxy.controlled!.onDisable()
    expect(invoke).toHaveBeenCalledWith('extension.setEnabled', {
      id: extension.extensionId,
      enabled: false
    })
    // Another key held is not this row's.
    const other = section(
      'system',
      desktop({ extensionControls: { homepage: { ...extension, value: 'https://x.example/' } } })
    )
    expect(row(other, 'proxy-settings').controlled).toBeUndefined()
    expect(controlledRuns(other.groups[0]!.rows)).toEqual([0])
  })

  it('keeps the resting sentence for a held value that is not one of the five modes – unreachable through proxy.ts, which always publishes the mode – so the row never loses its description', () => {
    // The host's `ProxyApi.publishControls` sets `value` to the configuration's `mode`, always
    // one of `PROXY_MODES`; the fallback covers a value from anywhere else, and none at all.
    for (const value of ['socks', 'FIXED_SERVERS', '', undefined]) {
      const proxy = row(section('system', holding(value)), 'proxy-settings')
      expect(proxy.controlled).toMatchObject(extension)
      expect(proxy.description, String(value)).toBe("Zenium uses your computer's proxy settings.")
    }
    expect(proxyHeldDescription({ value: 42 })).toBe("Zenium uses your computer's proxy settings.")
    expect(proxyHeldDescription({ value: ['direct'] })).toBe(
      "Zenium uses your computer's proxy settings."
    )
    expect(proxyHeldDescription({ value: 'direct' })).toBe('Using a direct connection.')
  })

  it('is found by the search by Chrome’s words and the row’s own, its caption the category alone', () => {
    const models = buildSections(
      availableSections(PAGE, ANDROID, 'desktop', 'linux'),
      context(desktop()).ctx
    )
    const ids = (q: string): string[] => searchRows(models, q).map((h) => h.row.id)
    expect(ids('proxy')).toEqual(['proxy-settings'])
    expect(ids("computer's proxy settings")).toEqual(['proxy-settings'])
    expect(ids('pac')).toContain('proxy-settings')
    expect(searchRows(models, 'proxy')[0]!.caption).toBe('System')
  })
})

/*
 * Settings › Default browser (the desktop OSes' section; Android keeps its row under About): the
 * action row's button is §9.29's one name for the act – "Set as default", the strip's and the
 * prompt's word (W8-F21) – and on Windows the hint names that button and then Windows' own
 * "Set default", the OS's label kept. Chrome's "Make default" stays a search alias, no label.
 */
describe('Settings › Default browser: the row’s button says Set as default (§9.29, W8-F21)', () => {
  const notDefault = (platform: Platform): UIState =>
    state({
      platform,
      capabilities: { ...ANDROID, windows: true, defaultBrowser: true },
      defaultBrowser: { isDefault: false, prompt: null }
    })

  it('offers Set as default – the strip’s and the prompt’s word – and asks the host from the settings', () => {
    const model = section('default-browser', notDefault('linux'))
    expect(model.groups.map((g) => [g.id, g.heading])).toEqual([
      ['default-browser', 'Default browser']
    ])
    const r = row(model, 'default-browser')
    if (r.kind !== 'action') throw new Error('not an action row')
    expect(r.label).toBe('Zenium is not your default browser')
    expect(r.description).toBe('Open links from other apps in Zenium.')
    expect(r.button).toBe('Set as default')
    r.onPress?.()
    expect(invoke).toHaveBeenCalledWith('defaultBrowser.request', { source: 'settings' })
  })

  it('on Windows names its own button, then Windows’ Set default – the OS’s word, kept', () => {
    const r = row(section('default-browser', notDefault('win32')), 'default-browser')
    expect(r.description).toBe(
      'Set as default opens Windows Settings, where you press Set default.'
    )
  })

  it('is found under Set as default and still under Chrome’s Make default', () => {
    const model = section('default-browser', notDefault('linux'))
    for (const query of ['set as default', 'make default']) {
      expect(
        searchRows([model], query).map((h) => h.row.id),
        query
      ).toContain('default-browser')
    }
  })
})
