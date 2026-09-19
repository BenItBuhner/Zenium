// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Settings, Tab, UIState } from '@shared/types'
import { INTERNAL_PAGES, availableSections } from '@shared/internalPages'
import { emptyBlockingStatus } from '@shared/blocking'
import {
  DEFAULT_CONTAINERS,
  DEFAULT_SETTINGS,
  emptyAgentServerStatus,
  emptyPasswordsStatus,
  emptyResourceSnapshot
} from '@shared/defaults'
import { MAX_NEW_TAB_SHORTCUTS } from '@shared/newTab'
import { DEFAULT_PAGE_ENVIRONMENT } from '@shared/pageControls'
import { emptyPrivacyStatus, type PrivacyStatus } from '@shared/privacy'
import { DEFAULT_SEARCH_ENGINES } from '@shared/search'
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
const { allRows, currentOptionLabel, findRow, groupShows, rowText, searchRows } =
  await import('../model')
const { uiStore } = await import('@renderer/lib/ui')

type Model = ReturnType<typeof buildSection>
type Row = ReturnType<typeof allRows>[number]

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
  privateTabs: true,
  secureDns: false,
  newTabPage: false,
  pageTabs: true,
  // Kotlin's boot info turns this on where the launcher can pin (ShortcutManagerCompat).
  pinShortcuts: false
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
    defaultBrowser: { isDefault: false, prompt: null },
    permissionRules: [],
    blocking: emptyBlockingStatus(),
    privacy: emptyPrivacyStatus(),
    pageEnvironment: DEFAULT_PAGE_ENVIRONMENT,
    newTabShortcuts: [],
    newTabBackground: { image: false, canPick: false },
    ...patch
  } as unknown as UIState
}

/** A context that records what the rows ask of the page; a touch host unless `pointer` says so. */
function context(
  s: UIState = state(),
  pointer = false
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
    boost: (tabId) => boosted.push(tabId)
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

  it('carries #156’s protection groups in Chrome’s order: Safe Browsing, cookies, HTTPS-only, secure DNS, the signals', () => {
    const privacy = section('privacy', state({ privacy: PRIVACY_STATUS }))
    const ids = privacy.groups.map((g) => g.id)
    const order = [
      'safe-browsing',
      'safe-browsing-feeds',
      'tracking',
      'cookies',
      'cookies-related-sites',
      'cookies-add-site',
      'permissions',
      'https-only',
      'https-only-sites',
      'secure-dns',
      'signals'
    ]
    expect(order.map((id) => ids.indexOf(id))).toEqual(
      [...order.map((id) => ids.indexOf(id))].sort((a, b) => a - b)
    )
    expect(ids.indexOf('safe-browsing')).toBe(0)
    expect(privacy.groups.every(groupShows)).toBe(true)
    // Every protection row is one of the five families, and a family never straddles a group.
    const families = ['safe-browsing', 'cookies', 'https-only', 'secure-dns', 'signals']
    for (const group of privacy.groups) {
      const family = families.find((f) => group.id === f || group.id.startsWith(`${f}-`))
      if (!family) continue
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
      capabilities: { ...ANDROID, pageControls: false, pullToRefresh: false, defaultBrowser: false }
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
    const after = row(tabs, 'unload-after')
    expect(after.kind).toBe('field')
    expect(rowText(after)).toContain(after.kind === 'field' ? (after.display ?? after.value) : '')
  })
})
