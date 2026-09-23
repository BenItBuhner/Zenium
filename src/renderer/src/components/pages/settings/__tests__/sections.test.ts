// @vitest-environment happy-dom
import { createElement, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ExtensionErrorEntry,
  ExtensionInfo,
  FormFactor,
  HostCapabilities,
  ImportSource,
  SafetyCheckResult,
  Settings,
  SyncStatus,
  Tab,
  ToolbarLayout,
  UIState
} from '@shared/types'
import { defaultScope } from '@core/sync/records'
import { INTERNAL_PAGES, availableSections } from '@shared/internalPages'
import {
  DEFAULT_BLOCKING_SETTINGS,
  customListId,
  emptyBlockingStatus,
  type FilterListStatus,
  type ListTier
} from '@shared/blocking'
import {
  DEFAULT_CONTAINERS,
  DEFAULT_SETTINGS,
  INACTIVE_TAB_AUTO_CLOSE_DAYS,
  emptyAgentServerStatus,
  emptyAutofillUIState,
  emptyPasswordsStatus,
  emptyResourceSnapshot
} from '@shared/defaults'
import {
  ANDROID_FONT_FAMILIES,
  FONT_SIZE_STEPS,
  GENERIC_FONT_FAMILIES,
  MINIMUM_FONT_SIZE_STEPS
} from '@shared/fonts'
import { MAX_NEW_TAB_SHORTCUTS } from '@shared/newTab'
import { defaultShortcuts } from '@shared/shortcuts'
import { DEFAULT_PAGE_ENVIRONMENT } from '@shared/pageControls'
import { DEFAULT_SEARCH_ENGINES } from '@shared/search'
import { UNAVAILABLE_SPELLCHECK } from '@shared/spellcheck'
import type { TranslateUIState } from '@shared/translate'
import { emptyPrivacyStatus, type PrivacyStatus } from '@shared/privacy'
import { emptySiteDataStatus } from '@shared/siteData'
import { emptyUpdateStatus } from '@shared/updates'

/*
 * The phone Settings page as data (v2 §10.3–10.4): every category builds from the browser state
 * into groups of rows with unique ids, the rows of other wave PRs (#46, #52, #78) are in place,
 * a row's callback runs the setting or command it stands for, and the landing's search reads
 * the same rows across every category.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { buildSection, buildSections, autoCloseDescription } = await import('../sections')
const {
  allRows,
  currentOptionLabel,
  findRow,
  groupShows,
  itemMenuItems,
  onLayout,
  optionGroups,
  rowText,
  searchRows
} = await import('../model')
const { FontPreview } = await import('../fontBlocks')
const { familyOptions, fontSizeOptions, previewFamilies } = await import('../fontsModel')
const { uiStore } = await import('@renderer/lib/ui')
const { idleAutofillSettings } = await import('@renderer/lib/autofillSettings')
const { idleDictionaryWords } = await import('@renderer/lib/spellcheckWords')
const { SYNC_SCOPES, syncSetupStore } = await import('@renderer/lib/syncSetup')
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
  pdfViewer: true,
  agents: true,
  updates: true,
  share: true,
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
  genericFontFamilies: false
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
    agentServer: emptyAgentServerStatus(),
    updates: emptyUpdateStatus('0.3.0-test', { os: 'android', arch: 'arm64', kind: 'apk' }),
    passwords: emptyPasswordsStatus(),
    autofill: emptyAutofillUIState(),
    defaultBrowser: { isDefault: false, prompt: null },
    permissionRules: [],
    permissionDefaults: {},
    lastSafetyCheck: null,
    blocking: emptyBlockingStatus(),
    privacy: emptyPrivacyStatus(),
    pageEnvironment: DEFAULT_PAGE_ENVIRONMENT,
    newTabShortcuts: [],
    siteData: emptySiteDataStatus(),
    newTabBackground: { image: false, canPick: false },
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
      'mods',
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
    expect(access.groups.map((g) => g.heading)).toEqual(['Page zoom', 'Sites with their own zoom'])
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
      'default-browser',
      'whats-new',
      'engine',
      'upstream'
    ])
    const whatsNew = row(about, 'whats-new')
    expect(whatsNew).toMatchObject({
      kind: 'action',
      label: 'What’s new',
      description: 'The highlights of Zenium 0.3.0-test',
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

    // A host without page tabs has nowhere to open a chrome page: the rows stay away.
    const noTabs = section('about', state({ capabilities: { ...ANDROID, pageTabs: false } }))
    expect(findRow(noTabs.groups, 'whats-new')).toBeNull()
    expect(noTabs.groups.map((g) => g.id)).toEqual(['about'])
  })

  it('carries #115’s Privacy and security groups (tracking-*) at Chrome’s tracking-prevention position, behind requestBlocking', () => {
    const privacy = section('privacy', blockingState())
    // The engine's groups sit between #135's Safety check and Clear browsing data groups; their
    // own order and content are asserted here (the whole category's order is #135's test).
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
    expect(without.groups.map((g) => g.id)).toEqual([
      'safety-check',
      'safety-check-results',
      'safety-check-actions',
      'safe-browsing',
      'safe-browsing-feeds',
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
      'sites-permissions',
      'sites-content',
      'sites-additional',
      'sites-own',
      'https-only',
      'https-only-sites',
      'secure-dns',
      'signals',
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

    const c = context(state({ platform: 'linux', capabilities: { ...ANDROID, windows: true } }))
    const tabs = buildSection(
      PAGE.sections.find((x) => x.id === 'tabs')!,
      c.ctx
    )
    const ids = tabs.groups.find((g) => g.id === 'tabs')?.rows.map((r) => r.id) ?? []
    expect(ids.slice(ids.indexOf('restore-session'))).toEqual([
      'restore-session',
      'crash-restore',
      'warn-close-window'
    ])
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
    // An empty answer (a host that cannot name one) leaves the setting's words.
    const unnamed = buildSection(
      PAGE.sections.find((x) => x.id === 'downloads')!,
      {
        ...c.ctx,
        downloadDirectory: ''
      }
    )
    expect(row(unnamed, 'download-directory').description).toBe('The system Downloads folder')
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
    expect(newtab.groups.map((g) => g.heading)).toEqual(['New tab page', 'My shortcuts', null])
    expect(newtab.groups.every(groupShows)).toBe(true)

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
      itemMenuItems(itemOf(model, id)).map((i) => ({
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
      itemMenuItems(itemOf(one, 'languages-preferred:en')).map((i) => i.disabled ?? false)
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

  it('carries #135’s site-controls rows in Chrome’s Privacy and security order: Safety check, then #115’s Tracking prevention, Clear browsing data, Site settings', () => {
    const c = context()
    const privacy = buildSection(
      PAGE.sections.find((x) => x.id === 'privacy')!,
      c.ctx
    )
    // The whole category in Chrome's order – #135's, #156's and #115's groups (each program's
    // own order and content is its own test); the remembered per-site answers are Security's
    // since #62 (no `permissions` group here).
    expect(privacy.groups.map((g) => g.id)).toEqual([
      'safety-check',
      'safety-check-results',
      'safety-check-actions',
      'safe-browsing',
      'safe-browsing-feeds',
      'tracking-prevention',
      'tracking-lists',
      'tracking-custom-lists',
      'tracking-filters',
      'tracking-exceptions',
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
      'sites-permissions',
      'sites-content',
      'sites-additional',
      'sites-own',
      'https-only',
      'https-only-sites',
      'secure-dns',
      'signals',
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

    // Clear browsing data is one action row whose sheet is the form.
    const clear = row(privacy, 'clear-data-open')
    if (clear.kind !== 'action') throw new Error('not an action')
    expect(clear.label).toBe('Clear browsing data')
    expect(clear.form?.title).toBe('Clear browsing data')
    expect(clear.form?.description).toContain('time range')

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
    // site, each forgotten or reset through the permission commands after a confirmation.
    const rules = [
      { origin: 'https://meet.example', permission: 'camera', decision: 'allow' as const },
      { origin: 'https://meet.example', permission: 'microphone', decision: 'deny' as const },
      { origin: 'https://news.example', permission: 'popups', decision: 'allow' as const }
    ]
    const stored = section(
      'privacy',
      state({ permissionRules: rules, permissionDefaults: { camera: 'deny' } } as Partial<UIState>)
    )
    expect(row(stored, 'sites:camera').description).toBe('Sites cannot use camera')
    const cameraSite = row(stored, 'sites:camera:https://meet.example:camera')
    expect(cameraSite).toMatchObject({
      kind: 'action',
      label: 'meet.example',
      description: 'Allowed'
    })
    if (cameraSite.kind !== 'action') throw new Error('not an action')
    expect(cameraSite.confirm?.action).toBe('Forget')
    cameraSite.onPress?.()
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
    expect(reset.confirm?.action).toBe('Reset')
    reset.onPress?.()
    expect(invoke).toHaveBeenCalledWith('permissions.resetOrigin', {
      origin: 'https://meet.example'
    })
    const resetAll = row(stored, 'sites-reset-all')
    expect(resetAll).toMatchObject({ kind: 'action', destructive: true })
    if (resetAll.kind !== 'action') throw new Error('not an action')
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
        review: [{ origin: 'https://meet.example', permissions: ['camera'], reason: 'unused' }]
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
    // why; a site's row resets it after a confirmation and the check runs again.
    const permissions = row(privacy, 'safety-check:permissions')
    if (permissions.kind !== 'item') throw new Error('not an item')
    expect(permissions.sheet.title).toBe('Site permissions')
    expect(permissions.sheet.groups[0].rows.map((r) => [r.label, r.description])).toEqual([
      ['meet.example', 'Camera · Not used for weeks'],
      ['docs.example', 'Location']
    ])
    const meet = row(privacy, 'safety-check:permissions:https://meet.example')
    if (meet.kind !== 'action') throw new Error('not an action')
    expect(meet.confirm?.action).toBe('Reset')
    invoke.mockClear()
    meet.onPress?.()
    expect(invoke.mock.calls).toEqual([
      ['permissions.resetOrigin', { origin: 'https://meet.example' }],
      ['privacy.safetyCheck', undefined]
    ])

    // The notifications review blocks a site after a confirmation.
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
    expect(searchRows(desktop, 'address bar').map((h) => h.row.id)).toEqual(['full-urls'])

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
    expect(section('accessibility').groups.map((g) => g.id)).toEqual(['zoom', 'site-zooms'])
    const model = build(speaking(), VOICES)
    expect(model.groups.map((g) => g.id)).toEqual([
      'zoom',
      'site-zooms',
      'read-aloud',
      'read-aloud-voices'
    ])
    expect(model.groups.map((g) => g.heading)).toEqual([
      'Page zoom',
      'Sites with their own zoom',
      'Read aloud',
      'Voices'
    ])
    for (const group of model.groups) expect(groupShows(group)).toBe(true)
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
    // A fresh profile: the group shows its empty state.
    const fresh = section('search')
    const added = fresh.groups.find((g) => g.id === 'search-engines')!
    expect(added.rows).toEqual([])
    expect(groupShows(added)).toBe(true)
    expect(added.empty).toBe('No search engines added yet')
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

  it('carries #156’s protection groups at Chrome’s positions: Safe Browsing after Safety check, cookies after Clear browsing data, HTTPS-only, secure DNS and the signals after Site settings', () => {
    const privacy = section('privacy', state({ privacy: PRIVACY_STATUS }))
    const ids = privacy.groups.map((g) => g.id)
    // The protection groups' own order and content are asserted here; the whole category's
    // order, with #135's and #115's groups around them, is #135's test.
    const families = ['safe-browsing', 'cookies', 'https-only', 'secure-dns', 'signals']
    const familyOf = (id: string): string | undefined =>
      families.find((f) => id === f || id.startsWith(`${f}-`))
    const protection = privacy.groups.filter((g) => familyOf(g.id) !== undefined)
    // The third-party cookie mode itself is Cookies and site data's default row since #322's
    // ruling on Q3 folded the Third-party cookies group into it; the related sites follow it.
    expect(protection.map((g) => g.id)).toEqual([
      'safe-browsing',
      'safe-browsing-feeds',
      'cookies-related-sites',
      'cookies-add-site',
      'https-only',
      'https-only-sites',
      'secure-dns',
      'signals'
    ])
    // Each family sits at its Chrome position among the neighbours' groups.
    const at = (id: string): number => ids.indexOf(id)
    expect(at('safe-browsing')).toBe(at('safety-check-actions') + 1)
    expect(at('safe-browsing-feeds')).toBe(at('tracking-prevention') - 1)
    // #310's Cookies and site data groups (site-data-*) stand between Clear browsing data and
    // Site settings, where Chrome's cookies page sits, the related sites right under the default
    // they qualify; siteData.test.ts asserts their content.
    expect(at('site-data')).toBe(at('clear-data') + 1)
    expect(at('cookies-related-sites')).toBe(at('site-data') + 1)
    expect(at('site-data-allow')).toBe(at('cookies-add-site') + 1)
    expect(at('site-data-viewer')).toBe(at('sites-permissions') - 1)
    expect(at('https-only')).toBe(at('sites-own') + 1)
    // The signals close the protection groups; after them only the private-tab lock (INC-05,
    // Chrome's Incognito lock after Do Not Track).
    expect(at('signals')).toBe(ids.length - 2)
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

  it('is the phone shell’s: the desktop and tablet shells bind the same keys through Zen’s Tab unloading rows', () => {
    const def = PAGE.sections.find((x) => x.id === 'tabs')!
    const c = context(state({}, { unloadExcludedDomains: ['mail.example.com'] }))
    const phone = buildSection(def, { ...c.ctx, formFactor: 'phone' })
    expect(phone.groups.map((g) => g.id)).toEqual(
      expect.arrayContaining(['sleeping-tabs', 'never-sleep', 'never-sleep-add'])
    )
    expect(phone.groups.map((g) => g.id)).not.toContain('unloading')

    for (const layout of ['desktop', 'tablet'] as const) {
      const shell = buildSection(def, { ...c.ctx, formFactor: layout })
      const ids = shell.groups.map((g) => g.id)
      expect(ids).toContain('unloading')
      expect(ids).not.toContain('sleeping-tabs')
      expect(ids).not.toContain('never-sleep')
      expect(ids).not.toContain('never-sleep-add')
      const group = shell.groups.find((g) => g.id === 'unloading')
      expect(group?.heading).toBe('Tab unloading')
      expect(group?.rows.map((r) => [r.kind, r.label])).toEqual([
        ['switch', 'Unload inactive tabs'],
        ['field', 'Unload after'],
        ['field', 'Never unload these domains']
      ])
      const on = row(shell, 'unloading-enabled')
      if (on.kind !== 'switch') throw new Error('not a switch')
      on.onChange(false)
      expect(c.patches.at(-1)).toEqual({ unloadEnabled: false })
      const after = row(shell, 'unloading-after')
      if (after.kind !== 'field') throw new Error('not a field')
      expect(after.display).toBe('20 minutes')
      expect(after.onCommit('0')).toBe('Enter a number of minutes from 1 to 1440')
      expect(after.onCommit('45')).toBeUndefined()
      expect(c.patches.at(-1)).toEqual({ unloadTimeoutMinutes: 45 })
      const excluded = row(shell, 'unloading-excluded')
      if (excluded.kind !== 'field') throw new Error('not a field')
      expect(excluded.value).toBe('mail.example.com')
      excluded.onCommit('Mail.example.com, notion.so')
      expect(c.patches.at(-1)).toEqual({ unloadExcludedDomains: ['mail.example.com', 'notion.so'] })
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
      syncing: false,
      devices: [],
      pendingMerge: false,
      remoteTabsVersion: 0,
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
        { id: 'dev-2', name: 'Work laptop', lastSeen: Date.now() - 2 * 3_600_000 },
        { id: 'dev-3', name: 'Home desktop', lastSeen: Date.now() - 60_000 }
      ],
      ...patch
    })
  }

  function syncState(sync: SyncStatus): UIState {
    return state({ capabilities: { ...ANDROID, sync: true }, sync } as Partial<UIState>)
  }

  beforeEach(() => syncSetupStore.set({ folder: null }))
  afterEach(() => syncSetupStore.set({ folder: null }))

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
      description: 'Choose a folder that your cloud drive keeps in sync.'
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

  it('What you sync: one switch per data type in Chrome’s order, Bookmarks, History, Open tabs, Passwords, Settings first, then Zenium’s own; each runs sync.setScope', () => {
    const model = section('sync', syncState(syncStatus()))
    const scope = model.groups.find((g) => g.id === 'sync-scope')
    expect(scope?.heading).toBe('What you sync')
    expect(scope?.rows.map((r) => r.label).slice(0, 5)).toEqual([
      'Bookmarks',
      'History',
      'Open tabs',
      'Passwords',
      'Settings'
    ])
    // Every key of the engine's scope is a switch here, once.
    const keys = SYNC_SCOPES.map((s) => s.key)
    expect([...keys].sort()).toEqual(Object.keys(defaultScope()).sort())
    expect(scope?.rows.map((r) => r.id)).toEqual(keys.map((k) => `sync-scope:${k}`))
    const openTabs = row(model, 'sync-scope:openTabs')
    if (openTabs.kind !== 'switch') throw new Error('not a switch')
    expect(openTabs.checked).toBe(false)
    const passwords = row(model, 'sync-scope:passwords')
    if (passwords.kind !== 'switch') throw new Error('not a switch')
    expect(passwords.checked).toBe(true)
    passwords.onChange(false)
    expect(invoke).toHaveBeenCalledWith('sync.setScope', { passwords: false })
    // History is on by default, as Chrome's (ID-13).
    const history = row(model, 'sync-scope:history')
    if (history.kind !== 'switch') throw new Error('not a switch')
    expect(history.checked).toBe(true)
    history.onChange(false)
    expect(invoke).toHaveBeenCalledWith('sync.setScope', { history: false })
    // The same group, same order, once connected.
    const on = section('sync', syncState(connected()))
    expect(on.groups.find((g) => g.id === 'sync-scope')?.rows.map((r) => r.id)).toEqual(
      scope?.rows.map((r) => r.id)
    )
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
      description: 'news.ycombinator.com'
    })
    const address = group.rows[1]
    if (address.kind !== 'field') throw new Error('not a field row')
    expect(address.value).toBe('news.ycombinator.com')
    expect(address.display).toBe('news.ycombinator.com')
  })

  it('Use current page names the page Settings was opened from and writes it; without one it is disabled and says what to do', () => {
    const c = context(withHomepage({ mode: 'url', url: '' }))
    const look = buildSection(PAGE.sections[0], c.ctx)
    const current = row(look, 'homepage-use-current')
    if (current.kind !== 'action') throw new Error('not an action row')
    // The Settings tab's opener is the site (`SETTINGS.openerTabId`).
    expect(current.disabled).toBe(false)
    expect(current.description).toBe('news.example')
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
})
