// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ExtensionErrorEntry,
  ExtensionInfo,
  HostCapabilities,
  SafetyCheckResult,
  Settings,
  Tab,
  UIState
} from '@shared/types'
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
  emptyAgentServerStatus,
  emptyAutofillUIState,
  emptyPasswordsStatus,
  emptyResourceSnapshot
} from '@shared/defaults'
import { MAX_NEW_TAB_SHORTCUTS } from '@shared/newTab'
import { DEFAULT_PAGE_ENVIRONMENT } from '@shared/pageControls'
import { DEFAULT_SEARCH_ENGINES } from '@shared/search'
import { UNAVAILABLE_SPELLCHECK } from '@shared/spellcheck'
import type { TranslateUIState } from '@shared/translate'
import { emptyPrivacyStatus, type PrivacyStatus } from '@shared/privacy'
import { emptyUpdateStatus } from '@shared/updates'

/*
 * The phone Settings page as data (v2 §10.3–10.4): every category builds from the browser state
 * into groups of rows with unique ids, the rows of other wave PRs (#46, #52, #78) are in place,
 * a row's callback runs the setting or command it stands for, and the landing's search reads
 * the same rows across every category.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { buildSection, buildSections } = await import('../sections')
const { allRows, currentOptionLabel, findRow, groupShows, optionGroups, rowText, searchRows } =
  await import('../model')
const { uiStore } = await import('@renderer/lib/ui')
const { idleAutofillSettings } = await import('@renderer/lib/autofillSettings')

type Model = ReturnType<typeof buildSection>
type Row = ReturnType<typeof allRows>[number]
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
  secureDns: false,
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
  qrScan: false
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

/**
 * A context that records what the rows ask of the page; a touch host unless `pointer` says so.
 * The vault reads idle (no lists, the gate idle) unless `autofill` brings some.
 */
function context(
  s: UIState = state(),
  pointer = false,
  autofill: Partial<AutofillData> = {}
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
    autofill: { ...idleAutofillSettings(), ...autofill }
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
      'cookies',
      'cookies-related-sites',
      'cookies-add-site',
      'sites-permissions',
      'sites-content',
      'sites-additional',
      'sites-own',
      'https-only',
      'https-only-sites',
      'secure-dns',
      'signals'
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

  it('carries #161’s Downloads rows: the folder, ask where to save, auto-open types, the notification; the bubble’s switches on a windowed host only', async () => {
    const c = context(state())
    const downloads = buildSection(
      PAGE.sections.find((x) => x.id === 'downloads')!,
      c.ctx
    )
    expect(downloads.groups.map((g) => g.id)).toEqual(['saving', 'download-notifications'])
    expect(downloads.groups.every(groupShows)).toBe(true)
    // The folder row names the system folder until one is picked; a dismissed picker keeps it.
    const folder = row(downloads, 'download-directory')
    expect(folder.description).toBe('The system Downloads folder')
    expect(row(downloads, 'download-directory-default').disabled).toBe(true)
    if (folder.kind !== 'action') throw new Error('not an action')
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
    // A folder picked on Android is a document-tree URI: the row reads its relative path (#93).
    const picked = buildSection(
      PAGE.sections.find((x) => x.id === 'downloads')!,
      context(
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
      ).ctx
    )
    expect(row(picked, 'download-directory').description).toBe('Download/Zenium')
    expect(row(picked, 'download-directory-default').disabled).toBe(false)
    const ask = row(downloads, 'ask-where-to-save')
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

    const languages = section('languages')
    expect(languages.groups.map((g) => g.id)).toEqual([
      'translation',
      'read',
      'read-add',
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
      'Translation',
      'Languages you read',
      null,
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

    // The first language read is the target; the others can be put first or removed.
    expect(row(languages, 'languages-read:en')).toMatchObject({
      kind: 'item',
      label: 'English',
      description: 'Pages are translated into this language'
    })
    expect(findRow(languages.groups, 'languages-read:en:first')).toBeNull()
    const first = row(languages, 'languages-read:fr:first')
    if (first.kind !== 'action') throw new Error('not an action')
    first.onPress?.()
    expect(invoke).toHaveBeenCalledWith('translate.setPreferences', { preferred: ['fr', 'en'] })
    const drop = row(languages, 'languages-read:fr:remove')
    if (drop.kind !== 'action') throw new Error('not an action')
    drop.onPress?.()
    expect(invoke).toHaveBeenCalledWith('translate.setPreferences', { preferred: ['en'] })

    // What the desktop adds through a menulist is an action row opening a sheet (§9.13).
    const add = row(languages, 'languages-read-add')
    if (add.kind !== 'action') throw new Error('not an action')
    expect(add.form?.title).toBe('Add a language you read')

    const ask = row(languages, 'languages-always:es:ask')
    if (ask.kind !== 'action') throw new Error('not an action')
    ask.onPress?.()
    expect(invoke).toHaveBeenCalledWith('translate.setLanguageRule', {
      language: 'es',
      rule: 'ask'
    })
    expect(languages.groups.find((g) => g.id === 'never')).toMatchObject({
      rows: [],
      empty: 'No languages yet'
    })

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

    // Nothing left to add: no add row for that list.
    const everything = section(
      'languages',
      state({
        translate: {
          ...TRANSLATE,
          preferences: { ...TRANSLATE.preferences, preferred: ['de', 'en', 'es', 'fr'] }
        }
      })
    )
    expect(everything.groups.map((g) => g.id)).not.toContain('read-add')
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
      'cookies',
      'cookies-related-sites',
      'cookies-add-site',
      'sites-permissions',
      'sites-content',
      'sites-additional',
      'sites-own',
      'https-only',
      'https-only-sites',
      'secure-dns',
      'signals'
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

  it('reads the last Safety check from the state: a row per area with its glyph, the reviews as sheets of sites, Extensions leaving for its category', () => {
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
        known: false
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
    passwords.onPress?.()
    expect(invoke).toHaveBeenCalledWith('passwords.checkupRun', undefined)

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
    expect(section('look').groups.map((g) => g.id)).toEqual([
      'appearance',
      'app-icon',
      'url-bar',
      'pages',
      'sites',
      'site-exceptions',
      'glance'
    ])
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

    // The added engines: the default says so, a visited one names its site; Make default and Remove.
    const mineRow = row(search, 'search-engine:custom:mine')
    if (mineRow.kind !== 'item') throw new Error('not an item')
    expect(mineRow.description).toBe('Default search engine')
    const forumRow = row(search, 'search-engine:discovered:forum.example')
    if (forumRow.kind !== 'item') throw new Error('not an item')
    expect(forumRow.description).toBe('Recently visited · forum.example')
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

  it('carries #62’s Security rows: each remembered site answer an item that forgets it, Forget all once there are two, the session’s sign-ins', () => {
    // Ungated, as the desktop pane is; empty until a site has been answered.
    const empty = section('security')
    expect(empty.groups.map((g) => g.id)).toEqual(['security-permissions', 'security-session'])
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

  it('reads a value row’s current label and a field row’s display', () => {
    const look = section('look')
    const scheme = row(look, 'toolbar-layout')
    expect(rowText(scheme)).toContain('Collapsed toolbar')
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
    expect(protection.map((g) => g.id)).toEqual([
      'safe-browsing',
      'safe-browsing-feeds',
      'cookies',
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
    expect(at('cookies')).toBe(at('clear-data') + 1)
    expect(at('cookies-add-site')).toBe(at('sites-permissions') - 1)
    expect(at('https-only')).toBe(at('sites-own') + 1)
    expect(at('signals')).toBe(ids.length - 1)
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

    // Cookies: the middle mode speaks of private tabs on a host without windows.
    const cookies = row(privacy, 'cookies-mode')
    if (cookies.kind !== 'value') throw new Error('not a value row')
    expect(cookies.options.map((o) => o.label)).toEqual([
      'Allow third-party cookies',
      'Block third-party cookies in private tabs',
      'Block third-party cookies'
    ])
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
    const cookies = row(privacy, 'cookies-mode')
    if (cookies.kind !== 'value') throw new Error('not a value row')
    cookies.onChange('block')
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
    const allowed = buildSection(
      PAGE.sections.find((x) => x.id === 'privacy')!,
      context(
        state(
          { privacy: PRIVACY_STATUS },
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
    // The middle cookie mode speaks of private windows here.
    const cookies = row(privacy, 'cookies-mode')
    if (cookies.kind !== 'value') throw new Error('not a value row')
    expect(cookies.options[1]?.label).toBe('Block third-party cookies in private windows')

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
    expect(languages.groups.map((g) => g.id).slice(-3)).toEqual([
      'spellcheck',
      'spellcheck-languages',
      'spellcheck-add'
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
    expect(add.label).toBe('Add a language')
    expect(add.form?.title).toBe('Add a language to check in')
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
})
