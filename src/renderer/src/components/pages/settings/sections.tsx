import type { ReactNode } from 'react'
import { Check, CircleAlert, CreditCard, Fingerprint, MapPin } from 'lucide-react'
import type { InternalPageSection } from '@shared/internalPages'
import type {
  BookmarksBarMode,
  ColorScheme,
  ContainerColor,
  ContainerIcon as ContainerIconName,
  CrashRestoreMode,
  DesktopSiteDefault,
  DownloadSettings,
  FormFactor,
  GlanceTrigger,
  GovernorActionKind,
  GpuMode,
  ImportSource,
  NewTabBackgroundKind,
  NewTabPosition,
  NewTabPreset,
  NewTabSettings,
  NewTabShortcutsMode,
  PasswordsStatus,
  PermissionRule,
  PhoneBarPosition,
  PinnedCloseBehavior,
  ResourceEnforcement,
  ResourceProcessProfile,
  ResourceSettings,
  SearchEngine,
  Settings,
  ShortcutGroup,
  ShortcutPreset,
  SyncScope,
  Tab,
  ThirdPartyPinnedBehavior,
  ToolbarLayout,
  UIState,
  UrlbarBehavior,
  WindowSyncMode
} from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'
import { CONTAINER_COLORS, CONTAINER_ICONS, spaceLabel } from '@shared/defaults'
import { resolveDownloadSettings } from '@shared/downloads'
import {
  MAX_NEW_TAB_SHORTCUTS,
  newTabPresetChoices,
  newTabSections,
  newTabShortcutsMode,
  pickNewTabPreset,
  setNewTabBackground,
  setNewTabSection,
  setNewTabShortcutsMode
} from '@shared/newTab'
import { formatZoom, zoomChoices, zoomKey } from '@shared/pageControls'
import {
  READ_ALOUD_RATES,
  baseLanguage,
  normalizeLanguageTag,
  sanitizeReadAloudRate,
  voiceForLanguage,
  type ReadAloudHighlightMode,
  type ReadAloudVoice,
  type ReadAloudVoicesResult
} from '@shared/readAloud'
import { engineHost } from '@shared/search'
import {
  SHORTCUT_GROUP_LABELS,
  SHORTCUT_PRESETS,
  SHORTCUT_PRESET_DESCRIPTIONS,
  SHORTCUT_PRESET_LABELS,
  bindingsEqual,
  defaultShortcuts,
  formatBinding,
  shortcutHint
} from '@shared/shortcuts'
import { describeUpdateTarget, type UpdateChannel } from '@shared/updates'
import { inputToUrl } from '@shared/url'
import { languageName } from '@shared/languageNames'
import { SPELLCHECK_LANGUAGES_MAX, type SpellcheckDictionaryStatus } from '@shared/spellcheck'
import type { TranslatePreferences } from '@shared/translate'
import { cmd, run } from '@renderer/lib/api'
import {
  CLIPBOARD_CLEAR_OPTIONS,
  NETWORK_NAMES,
  addressRowSubtitle,
  addressTitle,
  androidProviderHint,
  cardSubtitle,
  cardTitle,
  openAutofillEdit,
  passkeySubtitle,
  vaultGateCopy
} from '@renderer/lib/autofill'
import type { AutofillSettingsData, VaultGate } from '@renderer/lib/autofillSettings'
import { requestDefaultBrowser } from '@renderer/lib/defaultBrowser'
import { downloadFolderLabel } from '@renderer/lib/downloadText'
import { downloadsEngine } from '@renderer/lib/downloadsEngine'
import {
  NEW_TAB_LAYOUT_HINT,
  NEW_TAB_PRESET_DESCRIPTIONS,
  NEW_TAB_PRESET_LABELS,
  newTabBackgroundValue
} from '@renderer/lib/newTabSettings'
import { formatRate } from '@renderer/lib/readAloud'
import { describePermissionRule, siteLabel } from '@renderer/lib/security'
import { tabTitle } from '@renderer/lib/selectors'
import { wordProblem, type DictionaryWords } from '@renderer/lib/spellcheckWords'
import { openOverlay } from '@renderer/lib/ui'
import { languageOptions, pairKey, pairLabel, warmRegistryModels } from '@renderer/lib/translate'
import { formatBytes, relativeTime } from '@renderer/lib/utils'
import { VaultPassphraseForm } from '../../autofill/PassphraseForm'
import { ContainerIcon } from '../../ContainerIcon'
import {
  clearDataGroups,
  safetyCheckGroups,
  siteSettingsGroups
} from '../../siteControls/settingsRows'
import {
  APP_ICON_HINT,
  PASSWORD_GRACE_OPTIONS,
  PASSWORDS_COPY,
  checkupLabel,
  detail,
  headline,
  installLabel,
  passwordsSavedLabel,
  vaultProtectionLabel
} from '../../overlays/settingsCopy'
import { ModelPickList, PickList } from '../../translate/pickers'
import {
  AddRouteForm,
  AppIconGrid,
  CodeBlock,
  CopyRow,
  CssEditor,
  EngineGlyph,
  NewContainerForm,
  ResourceMeter,
  SearchEngineForm,
  ShortcutForm,
  SyncSetupForm,
  UpdateStatusBlock,
  UrlForm,
  WordForm,
  ZoomBlock
} from './blocks'
import { importGroups } from '../../import/importRows'
import { extensionsGroups } from './extensions'
import {
  choice,
  onLayout,
  type FieldRow,
  type RowGroup,
  type SectionModel,
  type SettingsRow
} from './model'
import {
  cookiesGroups,
  httpsOnlyGroups,
  safeBrowsingGroups,
  secureDnsGroups,
  signalsGroups
} from './protectionRows'
import { ShortcutRow } from './ShortcutRow'
import { trackingGroups } from './tracking'

/**
 * The Settings sections as data: one builder per category turns the browser state into the
 * groups and rows of `model.ts`. Every row the desktop overlay once drew with its own components
 * is here in its v2 form – a menulist is a value row, a checkbox a switch row, a button an action
 * row (with the desktop's `button` where Zen's about:preferences trails one), an input a field
 * row, a list a group of item rows – reading the same settings and running the same commands, so
 * nothing is reachable on one platform only. The phone draws the rows in its vocabulary (§10.4)
 * and the desktop two-pane in its own (§10.5); the categories the phone never lists (Compact
 * Mode, Resources, Sync, Keyboard Shortcuts, Default Browser) are builders all the same, so
 * "Find in Settings" reaches their rows.
 */

export interface SectionContext {
  state: UIState
  /** The Settings tab the page lives in; its opener is the site an action may be about. */
  tab: Tab
  /**
   * The host has a pointer that hovers (a mouse or trackpad): the rows that describe a mouse
   * gesture – double-click, Alt + Click – keep it; a touch host reads its own gesture instead.
   */
  pointer: boolean
  /**
   * The chrome's layout: the phone shell has the phone bar (its position and its editor row) and
   * no bookmarks bar; the desktop and tablet shells the other way round. A builder says which
   * shells a row or group belongs to with `layouts`, and `buildSection` keeps the layout's own
   * (`onLayout`), so a phone's row never reaches a desktop's page or its search (BUG-055).
   * Absent, every row shows.
   */
  formFactor?: FormFactor
  set(patch: Partial<Settings>): void
  /** Move the page to another category (About › Check for updates lands on Updates). */
  navigate(section: string): void
  /** The navigation bar's editor sheet (Look and Feel › Navigation bar). */
  openBarEditor(): void
  /** Leave for `tabId` and open the Boost editor on it (Boosts › Boost the site you came from). */
  boost(tabId: string): void
  /**
   * What Settings › Autofill reads of the vault – its lists while unlocked, its gate while
   * locked – and does to it (`useAutofillSettings`); `idleAutofillSettings()` where there is no
   * vault to read (a test, the landing's search).
   */
  autofill: AutofillSettingsData
  /**
   * The speech engine's voices (`readAloud.voices`, `useReadAloudVoices`) for Accessibility ›
   * Read aloud's voice rows; null while the list is on its way or where the host has no engine.
   */
  readAloudVoices: ReadAloudVoicesResult | null
  /**
   * The profile's custom spell-check dictionary (Settings › Languages › Spell check) and what
   * moves it (`useDictionaryWords`); `idleDictionaryWords()` where there is none to read.
   */
  dictionary: DictionaryWords
  /**
   * What the import engine found on this computer (Settings › Import's pane names the browsers
   * among them; `useImportSources`): `null` while it looks, left out where the pane is not
   * drawn – the phone page, whose Import rows read files, and a test.
   */
  importSources?: ImportSource[] | null
}

export function buildSection(section: InternalPageSection, ctx: SectionContext): SectionModel {
  const builder = BUILDERS[section.id]
  return { section, groups: builder ? onLayout(builder(ctx), ctx.formFactor) : [] }
}

/** Every listed section, built; what the landing's search filters. */
export function buildSections(
  sections: readonly InternalPageSection[],
  ctx: SectionContext
): SectionModel[] {
  return sections.map((section) => buildSection(section, ctx))
}

type Builder = (ctx: SectionContext) => RowGroup[]

const BUILDERS: Readonly<Record<string, Builder>> = {
  look: lookSection,
  compact: compactSection,
  accessibility: accessibilitySection,
  newtab: newTabSection,
  tabs: tabsSection,
  downloads: downloadsSection,
  resources: resourcesSection,
  privacy: privacySection,
  search: searchSection,
  autofill: autofillSection,
  languages: languagesSection,
  spaces: spaceRoutingSection,
  containers: containersSection,
  boosts: boostsSection,
  mods: modsSection,
  extensions: extensionsSection,
  agents: agentsSection,
  passwords: passwordsSection,
  security: securitySection,
  sync: syncSection,
  import: importGroups,
  shortcuts: shortcutsSection,
  'default-browser': defaultBrowserSection,
  updates: updatesSection,
  about: aboutSection
}

function sorted<T>(map: Record<string, T>): Array<[string, T]> {
  return Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
}

/** A row that only lists something: shows what it is, and holds the rows that act on it. */
function item(
  id: string,
  label: string,
  description: string | undefined,
  rows: SettingsRow[],
  extra: {
    leading?: ReactNode
    keywords?: readonly string[]
    sheetDescription?: string
    disabled?: boolean
  } = {}
): SettingsRow {
  return {
    kind: 'item',
    id,
    label,
    description,
    keywords: extra.keywords,
    leading: extra.leading,
    disabled: extra.disabled,
    sheet: {
      title: label,
      description: extra.sheetDescription ?? description,
      groups: [{ id: `${id}-actions`, heading: null, rows }]
    }
  }
}

/**
 * A whole number the desktop keeps in a 96 px field (§9.12): the row shows it, the sheet or the
 * inline field edits it, and a value outside `min`…`max` (or no number) is refused with the one
 * message; `unit` follows the value in the row's description ("10 min").
 */
function numberRow(
  row: Omit<FieldRow, 'kind' | 'input' | 'value' | 'display' | 'onCommit'> & {
    value: number
    min: number
    max: number
    unit?: string
    onCommit(value: number): void
  }
): FieldRow {
  const { value, unit, onCommit, ...rest } = row
  return {
    ...rest,
    kind: 'field',
    input: 'number',
    value: String(value),
    display: unit ? `${value} ${unit}` : undefined,
    onCommit: (text) => {
      const n = Number(text.trim())
      if (text.trim() === '' || !Number.isInteger(n) || n < row.min || n > row.max)
        return `Enter a whole number from ${row.min} to ${row.max}`
      if (n !== value) onCommit(n)
      return undefined
    }
  }
}

// ---------------------------------------------------------------------------
// Look and Feel
// ---------------------------------------------------------------------------

/**
 * Groups in the order the design lead set for the tab: identity (Appearance, App icon), then the
 * chrome (URL bar, Pages), then page behaviour (Sites, Site exceptions), Glance last.
 */
function lookSection({ state, set, pointer, openBarEditor }: SectionContext): RowGroup[] {
  const s = state.settings
  const caps = state.capabilities
  const pc = s.pageControls
  const patchControls = (patch: Partial<typeof pc>): void =>
    set({ pageControls: { ...pc, ...patch } })
  const groups: RowGroup[] = [
    {
      id: 'appearance',
      heading: 'Appearance',
      rows: [
        choice<ColorScheme>({
          id: 'color-scheme',
          label: 'Colour scheme',
          value: s.colorScheme,
          options: [
            { value: 'system', label: 'Follow system' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' }
          ],
          onChange: (v) => set({ colorScheme: v })
        }),
        choice<ToolbarLayout>({
          id: 'toolbar-layout',
          label: 'Toolbar layout',
          value: s.toolbarLayout,
          sheetDescription:
            'Single: everything lives in the sidebar. Multiple: a top toolbar holds navigation.',
          options: [
            { value: 'single', label: 'Single toolbar' },
            { value: 'multiple', label: 'Multiple toolbars' },
            { value: 'collapsed', label: 'Collapsed toolbar' }
          ],
          onChange: (v) => set({ toolbarLayout: v })
        }),
        {
          kind: 'switch',
          id: 'tabs-right',
          label: 'Tabs on the right',
          checked: s.sidebarSide === 'right',
          onChange: (v) => set({ sidebarSide: v ? 'right' : 'left' })
        },
        {
          kind: 'switch',
          id: 'sidebar-expanded',
          label: 'Expanded sidebar',
          // The double-click is a mouse gesture: only a pointer host is told about it.
          description: pointer
            ? 'Show tab titles next to their icons. Double-click the sidebar edge to toggle.'
            : 'Show tab titles next to their icons.',
          checked: s.sidebarExpanded,
          onChange: (v) => set({ sidebarExpanded: v })
        },
        {
          kind: 'switch',
          id: 'borderless',
          label: 'Remove browser padding',
          description: 'Hide the rounded frame around web content.',
          checked: s.borderless,
          onChange: (v) => set({ borderless: v })
        }
      ]
    }
  ]
  if (caps.windowMaterial) {
    groups[0].rows.push({
      kind: 'switch',
      id: 'window-material',
      label: 'Use Windows transparency effects',
      description: 'Let the desktop show through the window frame (Mica). Applies to new windows.',
      keywords: ['mica', 'acrylic', 'transparent'],
      checked: s.windowMaterial === 'mica',
      onChange: (v) => set({ windowMaterial: v ? 'mica' : 'none' })
    })
  }
  if (!caps.pageControls) {
    // Chrome's Page zoom menulist and the per-site zooms, under Appearance where the host has no
    // page-controls sheet (the desktop); a host with one keeps the zoom under Accessibility.
    groups[0].rows.push(
      choice({
        id: 'page-zoom',
        label: 'Page zoom',
        description: 'Sites without a zoom of their own open at this size.',
        keywords: ['zoom', 'default zoom', 'text size'],
        value: zoomKey(pc.zoom),
        options: zoomChoices(pc.zoom),
        onChange: (v) => patchControls({ zoom: Number(v) / 100 })
      })
    )
    groups.push({
      id: 'site-zooms',
      heading: 'Sites with their own zoom',
      rows: sorted(pc.siteZooms).map(([domain, factor]) =>
        item(`site-zoom:${domain}`, domain, formatZoom(factor), [
          {
            kind: 'action',
            id: `site-zoom:${domain}:forget`,
            label: 'Remove zoom',
            description: 'The site opens at the page zoom again.',
            button: 'Remove',
            onPress: () => run('pageControls.forgetSite', { kind: 'zoom', domain })
          }
        ])
      ),
      empty: 'No sites yet. Zooming a page remembers the zoom for its site here.'
    })
  }
  groups.push({
    id: 'app-icon',
    heading: 'App icon',
    description: APP_ICON_HINT[state.platform],
    rows: [
      {
        kind: 'custom',
        id: 'app-icon-colour',
        label: 'Colour',
        keywords: ['icon', 'launcher', 'home screen'],
        render: () => <AppIconGrid value={s.appIcon} onChange={(id) => set({ appIcon: id })} />
      }
    ]
  })
  // The bookmarks bar is the desktop and tablet shells' (App.tsx); the phone shell has none.
  groups.push({
    id: 'bookmarks',
    heading: 'Bookmarks',
    layouts: ['desktop', 'tablet'],
    rows: [
      choice<BookmarksBarMode>({
        id: 'bookmarks-bar',
        label: 'Show bookmarks bar',
        keywords: ['toolbar', 'favourites'],
        value: s.bookmarksBar,
        sheetDescription:
          'Always, only on the new tab page, or never. Compact mode hides it with the toolbar.',
        options: [
          { value: 'always', label: 'Always' },
          { value: 'newtab', label: 'Only on new tab page' },
          { value: 'never', label: 'Never' }
        ],
        onChange: (v) => set({ bookmarksBar: v })
      }),
      {
        kind: 'action',
        id: 'bookmarks-import',
        label: 'Import bookmarks',
        description: 'From a Netscape HTML file, which Chrome, Edge and Firefox all export.',
        keywords: ['html', 'chrome', 'firefox', 'edge'],
        button: 'Import…',
        onPress: () => void run('bookmark.import', undefined)
      },
      {
        kind: 'action',
        id: 'bookmarks-export',
        label: 'Export bookmarks',
        description: 'To a Netscape HTML file other browsers can import.',
        keywords: ['html', 'backup'],
        button: 'Export…',
        onPress: () => void run('bookmark.export', undefined)
      }
    ]
  })
  // The phone bar is the phone shell's alone: where it sits and which controls it carries are
  // its rows (BUG-055 – the desktop drew "Position on phones" for a bar it does not have).
  groups.push({
    id: 'url-bar',
    heading: 'URL bar',
    rows: [
      choice<UrlbarBehavior>({
        id: 'urlbar-behaviour',
        label: 'Floating behaviour',
        value: s.urlbarBehavior,
        options: [
          { value: 'float-typing', label: 'Floating only when typing' },
          { value: 'always-float', label: 'Always floating' },
          { value: 'normal', label: 'Normal (attached to top)' }
        ],
        onChange: (v) => set({ urlbarBehavior: v })
      }),
      choice<PhoneBarPosition>({
        id: 'phone-bar-position',
        label: 'Position on phones',
        keywords: ['address bar', 'bottom', 'top'],
        layouts: ['phone'],
        value: s.phoneBarPosition,
        sheetDescription: 'Hold the address bar to carry it to the other edge.',
        options: [
          { value: 'bottom', label: 'Bottom' },
          { value: 'top', label: 'Top' }
        ],
        onChange: (v) => set({ phoneBarPosition: v })
      }),
      {
        kind: 'switch',
        id: 'hide-toolbar-on-scroll',
        label: 'Hide toolbar when scrolling',
        description:
          'On phones, the bar slides away as a page scrolls down and back as it scrolls up.',
        keywords: ['address bar', 'scroll', 'hide', 'toolbar'],
        layouts: ['phone'],
        checked: s.hideToolbarOnScroll,
        onChange: (v) => set({ hideToolbarOnScroll: v })
      },
      {
        kind: 'action',
        id: 'navigation-bar',
        label: 'Navigation bar',
        description: 'Choose the controls beside the address bar and their order.',
        keywords: ['customise', 'toolbar items', 'buttons'],
        layouts: ['phone'],
        onPress: openBarEditor
      }
    ]
  })
  if (caps.pullToRefresh) {
    groups.push({
      id: 'pages',
      heading: 'Pages',
      rows: [
        {
          kind: 'switch',
          id: 'pull-to-refresh',
          label: 'Pull to refresh',
          description: 'Drag down from the top of a page to reload it.',
          checked: s.pullToRefresh,
          onChange: (v) => set({ pullToRefresh: v })
        }
      ]
    })
  }
  // The desktop-site default is the page-controls host's; the dark theme for sites is any host
  // that darkens pages (CT-18). Each exceptions list belongs to the row above it.
  if (caps.pageControls || caps.darkenSites) {
    const siteRows: SettingsRow[] = []
    if (caps.pageControls)
      siteRows.push(
        choice<DesktopSiteDefault>({
          id: 'desktop-site',
          label: 'Desktop site',
          keywords: ['mobile', 'layout', 'viewport'],
          value: pc.desktopSite,
          sheetDescription:
            'Automatic asks sites for their desktop layout on large screens, or when a keyboard and mouse are attached.',
          options: [
            { value: 'auto', label: 'Automatic' },
            { value: 'on', label: 'Always' },
            { value: 'off', label: 'Never' }
          ],
          onChange: (v) => patchControls({ desktopSite: v })
        })
      )
    if (caps.darkenSites)
      siteRows.push({
        kind: 'switch',
        id: 'darken-sites',
        label: 'Apply dark theme to sites',
        // One sentence: the 13/20 description clamps at two lines (§9.2), and where the menu's
        // per-site choice goes is the Site exceptions group's description below.
        description: 'Sites without a dark theme get one while Zenium is dark.',
        keywords: ['dark mode', 'auto dark', 'darken', 'night'],
        checked: pc.darkenSites,
        onChange: (v) => patchControls({ darkenSites: v })
      })
    groups.push({ id: 'sites', heading: 'Sites', rows: siteRows })
    const exceptions: SettingsRow[] = [
      ...(caps.pageControls ? sorted(pc.desktopSites) : []).map(([domain, on]) =>
        item(`desktop-site:${domain}`, domain, on ? 'Desktop site on' : 'Desktop site off', [
          {
            kind: 'action',
            id: `desktop-site:${domain}:forget`,
            label: 'Remove exception',
            description: 'The site follows the Desktop site setting again.',
            button: 'Remove',
            onPress: () => run('pageControls.forgetSite', { kind: 'desktop', domain })
          }
        ])
      ),
      ...(caps.darkenSites ? sorted(pc.darkenSiteExceptions) : []).map(([domain, on]) =>
        item(`darken:${domain}`, domain, on ? 'Dark theme on' : 'Dark theme off', [
          {
            kind: 'action',
            id: `darken:${domain}:forget`,
            label: 'Remove exception',
            description: 'The site follows the dark theme setting again.',
            button: 'Remove',
            onPress: () => run('pageControls.forgetSite', { kind: 'darken', domain })
          }
        ])
      )
    ]
    const creators = [
      caps.pageControls && 'Desktop Site',
      caps.darkenSites && 'Dark Theme for This Site'
    ].filter((x): x is string => typeof x === 'string')
    groups.push({
      id: 'site-exceptions',
      heading: 'Site exceptions',
      description: `${creators.join(' and ')} in the menu ${creators.length > 1 ? 'remember' : 'remembers'} a site’s choice here.`,
      rows: exceptions,
      empty: 'No exceptions yet'
    })
  }
  // Only a mouse drags tabs (a finger scrolls the strip): a touch host is not offered the row.
  if (pointer) {
    groups.push({
      id: 'split-view',
      heading: 'Split view',
      rows: [
        {
          kind: 'switch',
          id: 'split-edge-zones',
          label: 'Split view drag and drop',
          description: 'Drag a tab to the edge of the page to open it in a split view.',
          keywords: ['split screen', 'side by side', 'pane', 'drag', 'edge'],
          checked: s.splitEdgeZones,
          onChange: (v) => set({ splitEdgeZones: v })
        }
      ]
    })
  }
  groups.push({
    id: 'glance',
    heading: 'Glance',
    rows: [
      {
        kind: 'switch',
        id: 'glance-enabled',
        label: 'Enable Glance',
        description: 'Preview links on top of the current tab without leaving it.',
        checked: s.glanceEnabled,
        onChange: (v) => set({ glanceEnabled: v })
      },
      // The modifier-click trigger is a pointer's; a touch host opens Glance from the link's
      // long-press menu (menus.ts, "Open Link in Glance"), so its row says that and picks nothing.
      pointer
        ? choice<GlanceTrigger>({
            id: 'glance-trigger',
            label: 'Trigger',
            value: s.glanceTrigger,
            disabled: !s.glanceEnabled,
            options: [
              { value: 'alt', label: 'Alt + Click' },
              { value: 'ctrl', label: 'Ctrl + Click' },
              { value: 'shift', label: 'Shift + Click' }
            ],
            onChange: (v) => set({ glanceTrigger: v })
          })
        : {
            kind: 'info',
            id: 'glance-trigger',
            label: 'Trigger',
            description: 'Hold a link and choose Open Link in Glance.',
            keywords: ['long press', 'link menu'],
            disabled: !s.glanceEnabled
          }
    ]
  })
  return groups
}

// ---------------------------------------------------------------------------
// Compact Mode (the desktop and tablet shells; the phone shell has no bars to hide)
// ---------------------------------------------------------------------------

/**
 * Zen's compact mode: the mode itself, then which bars it hides. Hiding neither would hide
 * nothing, so turning one off turns the other on, as Zen's preferences do.
 */
function compactSection({ state, set }: SectionContext): RowGroup[] {
  const s = state.settings
  const cm = s.compactMode
  const chord = shortcutHint(state.shortcuts ?? [], 'compact.toggle', state.platform)
  return [
    {
      id: 'compact',
      heading: 'Compact mode',
      rows: [
        {
          kind: 'switch',
          id: 'compact-enabled',
          label: 'Enable compact mode',
          description: `${chord ? `${chord}. ` : ''}Hidden bars reappear when you hover the window edge.`,
          keywords: ['hide', 'sidebar', 'toolbar', 'fullscreen'],
          checked: cm.enabled,
          onChange: (v) => set({ compactMode: { ...cm, enabled: v } })
        },
        {
          kind: 'switch',
          id: 'compact-hide-sidebar',
          label: 'Hide sidebar',
          checked: cm.hideSidebar,
          onChange: (v) =>
            set({ compactMode: { ...cm, hideSidebar: v, hideToolbar: v ? cm.hideToolbar : true } })
        },
        {
          kind: 'switch',
          id: 'compact-hide-toolbar',
          label: 'Hide top toolbar',
          description: 'Only applies to the Multiple / Collapsed toolbar layouts.',
          checked: cm.hideToolbar,
          disabled: s.toolbarLayout === 'single',
          onChange: (v) =>
            set({ compactMode: { ...cm, hideToolbar: v, hideSidebar: v ? cm.hideSidebar : true } })
        }
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// Accessibility (page zoom, from #78)
// ---------------------------------------------------------------------------

/**
 * Settings › Accessibility: the page zoom groups on a host with page controls (the phone), and
 * Read aloud's groups on a host with a speech engine (`readAloudGroups`, both platforms) – the
 * category shows where either is true.
 */
function accessibilitySection(ctx: SectionContext): RowGroup[] {
  const groups: RowGroup[] = []
  if (ctx.state.capabilities.pageControls) groups.push(...pageZoomGroups(ctx))
  if (ctx.state.capabilities.readAloud) groups.push(...readAloudGroups(ctx))
  return groups
}

function pageZoomGroups({ state, set }: SectionContext): RowGroup[] {
  const pc = state.settings.pageControls
  const patch = (p: Partial<typeof pc>): void => set({ pageControls: { ...pc, ...p } })
  const fontScale = state.pageEnvironment.fontScale || 1
  const scale = pc.zoomIncludesOsFontSize ? fontScale : 1
  const fontHint =
    fontScale === 1
      ? 'Follow the font size chosen in the system settings; it is at 100% now.'
      : `The system font size is ${formatZoom(fontScale)}; with it, pages open at ${formatZoom(pc.zoom * scale)}.`
  return [
    {
      id: 'zoom',
      heading: 'Page zoom',
      rows: [
        {
          kind: 'custom',
          id: 'default-zoom',
          label: 'Default zoom',
          description: 'Sites without a zoom of their own open at this size.',
          keywords: ['text size', 'magnify', formatZoom(pc.zoom)],
          render: () => (
            <ZoomBlock
              value={pc.zoom}
              previewFactor={pc.zoom * scale}
              onChange={(factor) => patch({ zoom: factor })}
            />
          )
        },
        {
          kind: 'switch',
          id: 'zoom-os-font',
          label: 'Include system font size',
          description: fontHint,
          checked: pc.zoomIncludesOsFontSize,
          onChange: (v) => patch({ zoomIncludesOsFontSize: v })
        },
        {
          kind: 'switch',
          id: 'force-zoom',
          label: 'Force enable zoom',
          description: 'Pinch to zoom on every page, even where a site turns it off.',
          checked: pc.forceZoom,
          onChange: (v) => patch({ forceZoom: v })
        }
      ]
    },
    {
      id: 'site-zooms',
      heading: 'Sites with their own zoom',
      description: 'Zoom In and Zoom Out in the menu remember a site’s zoom here.',
      rows: sorted(pc.siteZooms).map(([domain, factor]) =>
        item(`zoom:${domain}`, domain, formatZoom(factor), [
          {
            kind: 'action',
            id: `zoom:${domain}:forget`,
            label: 'Remove zoom',
            description: 'The site opens at the default zoom again.',
            button: 'Remove',
            onPress: () => run('pageControls.forgetSite', { kind: 'zoom', domain })
          }
        ])
      ),
      empty: 'No sites yet'
    }
  ]
}

// ---------------------------------------------------------------------------
// Read aloud (Accessibility)
// ---------------------------------------------------------------------------

/**
 * The highlight modes (`readAloud.setHighlight`) in the picker's order – the default first –
 * with their labels, Edge's "Text highlighting" words.
 */
const READ_ALOUD_HIGHLIGHT_OPTIONS: ReadonlyArray<{
  value: ReadAloudHighlightMode
  label: string
}> = [
  { value: 'both', label: 'Sentence and word' },
  { value: 'sentence', label: 'Sentence' },
  { value: 'word', label: 'Word' },
  { value: 'off', label: 'Off' }
]

/**
 * The languages Settings › Read aloud offers a voice for: the languages Zenium reads in
 * (Languages › preferred, the first of them the model's own UI language), then any the player
 * already chose a voice for, in that order and once each; English where nothing names one.
 */
export function readAloudLanguages(state: UIState): string[] {
  const out: string[] = []
  const add = (tag: string): void => {
    const clean = normalizeLanguageTag(tag)
    if (clean && !out.includes(clean)) out.push(clean)
  }
  for (const lang of state.translate.preferences.preferred) add(lang)
  for (const lang of Object.keys(state.settings.readAloud.voiceByLanguage)) add(lang)
  if (out.length === 0) add('en')
  return out
}

/**
 * Settings › Accessibility › Read aloud (CT-12, CT-13; Chrome for Android keeps Listen to this
 * page under Accessibility), on hosts with a speech engine – one builder for the phone page and
 * the desktop panel: the speed the player starts at (the model's ladder, `readAloud.setRate`),
 * the highlight the page draws while it reads (`readAloud.setHighlight`), then a Voices group
 * with one value row per language (`readAloudLanguages`) – the engine's voices for it, the
 * language's current voice (the user's choice, else the engine's default for it) as the value –
 * writing `readAloud.setVoice` for that language. The player's speed chip and voice picker
 * write the same settings, so a change here reaches a session under way from its next sentence.
 * Before the voice list arrives the group holds one line saying so; an engine without a voice
 * for a language says that in the row.
 */
export function readAloudGroups({
  state,
  readAloudVoices
}: Pick<SectionContext, 'state' | 'readAloudVoices'>): RowGroup[] {
  const prefs = state.settings.readAloud
  const rate = String(sanitizeReadAloudRate(prefs.rate))
  const rates = READ_ALOUD_RATES.map((r) => String(r))
  if (!rates.includes(rate)) rates.push(rate)
  const voices = readAloudVoices?.voices ?? null
  const voiceRows: SettingsRow[] = []
  if (voices !== null && voices.length > 0) {
    for (const lang of readAloudLanguages(state)) {
      const base = baseLanguage(lang)
      const own = voices.filter((v) => baseLanguage(v.lang) === base)
      const label = languageName(lang)
      if (own.length === 0) {
        voiceRows.push({
          kind: 'info',
          id: `read-aloud-voice:${lang}`,
          label,
          description: 'No voice for this language on this device',
          keywords: ['voice', 'read aloud']
        })
        continue
      }
      const current = voiceForLanguage(voices, lang, prefs.voiceByLanguage) ?? own[0]!.id
      voiceRows.push(
        choice<string>({
          id: `read-aloud-voice:${lang}`,
          label,
          keywords: ['voice', 'read aloud', 'listen'],
          sheetDescription: `The voices on this device for ${label}. Read aloud speaks ${label} pages with the one chosen here.`,
          value: current,
          options: own.map((voice) => ({
            value: voice.id,
            label: voice.name,
            description: voiceOptionDescription(voice, lang)
          })),
          onChange: (voiceId) => run('readAloud.setVoice', { voiceId, lang })
        })
      )
    }
  }
  return [
    {
      id: 'read-aloud',
      heading: 'Read aloud',
      description:
        'Listen to This Page reads a page sentence by sentence; the player’s own controls change these too.',
      rows: [
        choice<string>({
          id: 'read-aloud-rate',
          label: 'Speed',
          keywords: ['rate', 'read aloud', 'listen', 'speech'],
          value: rate,
          options: rates.map((value) => ({ value, label: formatRate(Number(value)) })),
          onChange: (value) => run('readAloud.setRate', { rate: Number(value) })
        }),
        choice<ReadAloudHighlightMode>({
          id: 'read-aloud-highlight',
          label: 'Highlight while reading',
          keywords: ['read aloud', 'listen', 'highlight'],
          value: prefs.highlight,
          sheetDescription: 'The page marks what is being read: the sentence, the word, or both.',
          options: READ_ALOUD_HIGHLIGHT_OPTIONS,
          onChange: (mode) => run('readAloud.setHighlight', { mode })
        })
      ]
    },
    {
      id: 'read-aloud-voices',
      heading: 'Voices',
      description:
        'One voice per language, from the voices on this device. Listen picks the language’s voice as it reads.',
      rows:
        voices === null
          ? [{ kind: 'info', id: 'read-aloud-voices-loading', label: 'Looking for voices…' }]
          : voiceRows,
      empty: 'No voices on this device'
    }
  ]
}

/**
 * A voice's second line in the picker: its own language where it is a regional variant of the
 * row's (`English (United Kingdom)` under English), where it runs, and its quality when the
 * engine says.
 */
function voiceOptionDescription(voice: ReadAloudVoice, lang: string): string {
  const parts: string[] = []
  const own = normalizeLanguageTag(voice.lang)
  if (own && own !== normalizeLanguageTag(lang)) parts.push(languageName(voice.lang))
  parts.push(voice.local ? 'On this device' : 'Needs a network')
  if (voice.quality === 'high') parts.push('High quality')
  else if (voice.quality === 'low') parts.push('Low quality')
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// New Tab
// ---------------------------------------------------------------------------

/**
 * Settings › New Tab, on a host that renders `zen://newtab` (`newTabPage`; the desktop overlay's
 * section row for row, `NewTabSection.tsx`): the page on or off, the layout (the preset the
 * phone's sheet picks too), the shortcuts source, the background and the greeting – rows that
 * write the one model's sections through the same toggles as the phone's sheet – then the
 * shortcut tiles as item rows – each with its address, its place in the grid and a confirmed
 * removal – and an Add shortcut form. The image background is offered only where the host can
 * pick a file; choosing it there opens the host's picker.
 */
function newTabSection({ state, set }: SectionContext): RowGroup[] {
  const prefs = state.settings.newTab
  const write = (next: NewTabSettings): void => set({ newTab: next })
  const { image, canPick } = state.newTabBackground
  const backgroundOptions: Array<{ value: NewTabBackgroundKind; label: string }> = [
    { value: 'space', label: 'Space gradient' },
    { value: 'solid', label: 'Solid colour' }
  ]
  if (canPick) backgroundOptions.push({ value: 'image', label: 'Image from file' })
  const background = newTabBackgroundValue(prefs, image)
  const shortcuts = state.newTabShortcuts
  const full = shortcuts.length >= MAX_NEW_TAB_SHORTCUTS
  return [
    {
      id: 'newtab',
      heading: 'New tab page',
      rows: [
        {
          kind: 'switch',
          id: 'newtab-enabled',
          label: 'Open the new tab page',
          description: 'Off, a new tab shows only the address bar.',
          checked: prefs.enabled,
          onChange: (v) => write({ ...prefs, enabled: v })
        },
        choice<NewTabPreset>({
          id: 'newtab-layout',
          label: 'Layout',
          keywords: ['preset', 'focused', 'inspirational', 'custom'],
          value: prefs.preset,
          options: newTabPresetChoices(prefs).map((value) => ({
            value,
            label: NEW_TAB_PRESET_LABELS[value],
            description: NEW_TAB_PRESET_DESCRIPTIONS[value]
          })),
          sheetDescription: NEW_TAB_LAYOUT_HINT,
          onChange: (v) => write(pickNewTabPreset(prefs, v))
        }),
        choice<NewTabShortcutsMode>({
          id: 'newtab-shortcuts',
          label: 'Shortcuts',
          value: newTabShortcutsMode(prefs),
          options: [
            { value: 'most-visited', label: 'Most visited' },
            { value: 'my-shortcuts', label: 'My shortcuts' },
            { value: 'hidden', label: 'Hide' }
          ],
          sheetDescription:
            'Your shortcuts take the first tiles; the most visited sites fill the rest.',
          onChange: (v) => write(setNewTabShortcutsMode(prefs, v))
        }),
        choice<NewTabBackgroundKind>({
          id: 'newtab-background',
          label: 'Background',
          keywords: ['image', 'gradient', 'colour', 'color', 'wallpaper'],
          value: background,
          options: backgroundOptions,
          sheetDescription:
            background === 'image' && image
              ? 'Your image is stored on this device only.'
              : undefined,
          onChange: (v) => {
            // Picking the file sets the background once a file was chosen; a cancelled picker
            // keeps the current choice.
            if (v === 'image' && !image) void run('newtab.pickBackgroundImage', undefined)
            else write(setNewTabBackground(prefs, v))
          }
        }),
        // The image rows exist where a file can be picked; both depend on an image being set.
        ...(canPick
          ? [
              {
                kind: 'action',
                id: 'newtab-change-image',
                label: 'Change background image',
                description: 'Pick another file; the current image is replaced.',
                keywords: ['wallpaper', 'photo'],
                button: 'Change…',
                disabled: !image,
                onPress: () => run('newtab.pickBackgroundImage', undefined)
              } satisfies SettingsRow,
              {
                kind: 'action',
                id: 'newtab-remove-image',
                label: 'Remove background image',
                button: 'Remove',
                disabled: !image,
                onPress: () => run('newtab.clearBackgroundImage', undefined)
              } satisfies SettingsRow
            ]
          : []),
        {
          kind: 'switch',
          id: 'newtab-greeting',
          label: 'Show a greeting',
          description: 'A line above the search box that follows the hour.',
          checked: newTabSections(prefs).greeting,
          onChange: (v) => write(setNewTabSection(prefs, 'greeting', v))
        }
      ]
    },
    {
      id: 'newtab-shortcuts',
      heading: 'My shortcuts',
      description: 'The sites on every new tab: the first tiles, ahead of the most visited.',
      rows: shortcuts.map((shortcut, i) => {
        const move = (dir: -1 | 1): void => {
          const ids = shortcuts.map((x) => x.id)
          ;[ids[i], ids[i + dir]] = [ids[i + dir], ids[i]]
          run('newtab.reorderShortcuts', { ids })
        }
        return item(`shortcut:${shortcut.id}`, shortcut.title || shortcut.url, shortcut.url, [
          {
            kind: 'field',
            id: `shortcut:${shortcut.id}:title`,
            label: 'Name',
            value: shortcut.title,
            input: 'text',
            placeholder: 'Name',
            onCommit: (v) => {
              run('newtab.updateShortcut', { id: shortcut.id, title: v.trim(), url: shortcut.url })
              return undefined
            }
          },
          {
            kind: 'field',
            id: `shortcut:${shortcut.id}:url`,
            label: 'Address',
            value: shortcut.url,
            input: 'text',
            placeholder: 'example.com',
            onCommit: (v) => {
              if (!inputToUrl(v.trim())) return 'Enter a web address.'
              run('newtab.updateShortcut', {
                id: shortcut.id,
                title: shortcut.title,
                url: v.trim()
              })
              return undefined
            }
          },
          {
            kind: 'action',
            id: `shortcut:${shortcut.id}:up`,
            label: 'Move up',
            button: 'Up',
            disabled: i === 0,
            onPress: () => move(-1)
          },
          {
            kind: 'action',
            id: `shortcut:${shortcut.id}:down`,
            label: 'Move down',
            button: 'Down',
            disabled: i === shortcuts.length - 1,
            onPress: () => move(1)
          },
          {
            kind: 'action',
            id: `shortcut:${shortcut.id}:remove`,
            label: 'Remove shortcut',
            button: 'Remove…',
            destructive: true,
            confirm: {
              title: `Remove ${shortcut.title || shortcut.url}?`,
              description: 'The tile leaves the grid; the site itself is not affected.',
              action: 'Remove'
            },
            onPress: () => run('newtab.removeShortcut', { id: shortcut.id })
          }
        ])
      }),
      empty: 'No shortcuts yet. Add the sites you want on every new tab.'
    },
    {
      id: 'newtab-add',
      heading: null,
      rows: [
        {
          kind: 'action',
          id: 'newtab-add-shortcut',
          label: 'Add shortcut',
          description: full ? `The grid holds ${MAX_NEW_TAB_SHORTCUTS} shortcuts.` : undefined,
          disabled: full,
          keywords: ['tile', 'site'],
          button: 'Add…',
          form: {
            title: 'Add shortcut',
            render: (close) => (
              <ShortcutForm
                onSubmit={(title, url) => void run('newtab.addShortcut', { title, url })}
                close={close}
              />
            )
          }
        }
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// Tab Management
// ---------------------------------------------------------------------------

function tabsSection({ state, set }: SectionContext): RowGroup[] {
  const s = state.settings
  const windows = state.capabilities.windows
  // #129's session rows follow the desktop panel: a crash offer and a "Close N tabs?" question
  // are a windowed host's (Android's runs end by the process going, its pages just come back).
  const sessionRows: SettingsRow[] = windows
    ? [
        choice<CrashRestoreMode>({
          id: 'crash-restore',
          label: 'Restore pages after a crash',
          description: 'What happens to the open pages when Zenium did not shut down correctly.',
          value: s.crashRestore,
          options: [
            { value: 'ask', label: 'Ask first' },
            { value: 'always', label: 'Restore them' },
            { value: 'never', label: 'Start fresh' }
          ],
          onChange: (v) => set({ crashRestore: v })
        }),
        {
          kind: 'switch',
          id: 'warn-close-window',
          label: 'Warn before closing a window with multiple tabs',
          description: 'Also asks before quitting with more than one tab open.',
          checked: s.warnOnCloseWindow,
          onChange: (v) => set({ warnOnCloseWindow: v })
        }
      ]
    : []
  // The inverse: the tab overview's Close all tabs and its "Close N tabs?" prompt are the phone
  // host's (a windowed host has no overview), so the switch that turns the prompt off is too.
  const overviewRows: SettingsRow[] = windows
    ? []
    : [
        {
          kind: 'switch',
          id: 'confirm-close-all',
          label: 'Confirm before closing all tabs',
          description: 'The tab overview asks before it closes every tab of a Space.',
          checked: s.confirmCloseAll,
          onChange: (v) => set({ confirmCloseAll: v })
        }
      ]
  const groups: RowGroup[] = [
    {
      id: 'tabs',
      heading: 'Tabs',
      rows: [
        choice<NewTabPosition>({
          id: 'new-tab-position',
          label: 'Open new tabs',
          value: s.newTabPosition,
          options: [
            { value: 'end', label: 'At the end of the list' },
            { value: 'after-current', label: 'Below the current tab' }
          ],
          onChange: (v) => set({ newTabPosition: v })
        }),
        {
          kind: 'switch',
          id: 'tab-separator',
          label: 'Show separator between pinned and regular tabs',
          checked: s.showTabSeparator,
          onChange: (v) => set({ showTabSeparator: v })
        },
        {
          kind: 'switch',
          id: 'ctrl-tab-section',
          label: 'Ctrl+Tab stays within Essentials or regular tabs',
          checked: s.ctrlTabCyclesWithinSection,
          onChange: (v) => set({ ctrlTabCyclesWithinSection: v })
        },
        ...overviewRows,
        {
          kind: 'switch',
          id: 'restore-session',
          label: 'Restore previous session on startup',
          checked: s.restoreSession,
          onChange: (v) => set({ restoreSession: v })
        },
        ...sessionRows
      ]
    }
  ]
  if (state.capabilities.windows) {
    groups.push({
      id: 'window-sync',
      heading: 'Window sync',
      rows: [
        choice<WindowSyncMode>({
          id: 'window-sync',
          label: 'Tabs across windows',
          value: s.windowSync,
          sheetDescription:
            'Zenium mirrors your Spaces and tabs in every window. Choose pinned only to keep unpinned tabs per window.',
          options: [
            { value: 'all', label: 'Sync all tabs' },
            { value: 'pinned', label: 'Sync only pinned tabs in Spaces' },
            { value: 'off', label: 'Off – windows are independent' }
          ],
          onChange: (v) => set({ windowSync: v })
        }),
        {
          kind: 'action',
          id: 'blank-window',
          label: 'Open a blank window',
          description:
            'Ctrl+Shift+N opens a window without Spaces, pinned tabs or Essentials. Its tabs are temporary.',
          button: 'Open',
          onPress: () => run('window.newUnsynced', undefined)
        }
      ]
    })
  }
  groups.push(
    {
      id: 'pinned',
      heading: 'Pinned tabs and Essentials',
      rows: [
        choice<PinnedCloseBehavior>({
          id: 'pinned-close',
          label: 'When closing a pinned tab',
          value: s.pinnedCloseBehavior,
          options: [
            { value: 'reset-unload-switch', label: 'Reset, unload and switch to next' },
            { value: 'reset-unload', label: 'Reset and unload' },
            { value: 'reset', label: 'Reset to pinned URL' },
            { value: 'unload', label: 'Unload' },
            { value: 'unload-switch', label: 'Unload and switch to next' },
            { value: 'switch', label: 'Switch to next tab' },
            { value: 'close', label: 'Close the tab' }
          ],
          onChange: (v) => set({ pinnedCloseBehavior: v })
        }),
        {
          kind: 'switch',
          id: 'pinned-reset-startup',
          label: 'Restore pinned tabs to their pinned URL on startup',
          checked: s.pinnedResetOnStartup,
          onChange: (v) => set({ pinnedResetOnStartup: v })
        },
        choice<ThirdPartyPinnedBehavior>({
          id: 'third-party-pinned',
          label: 'Third-party links on pinned and essential tabs',
          value: s.thirdPartyOnPinned,
          options: [
            { value: 'new-tab', label: 'Open in their own tab' },
            { value: 'glance', label: 'Open in Glance' },
            { value: 'same-tab', label: 'Open in the same tab' }
          ],
          onChange: (v) => set({ thirdPartyOnPinned: v })
        }),
        {
          kind: 'switch',
          id: 'container-essentials',
          label: 'Container-specific Essentials',
          description: 'Each container gets its own set of Essentials.',
          checked: s.containerSpecificEssentials,
          onChange: (v) => set({ containerSpecificEssentials: v })
        },
        {
          kind: 'field',
          id: 'essentials-max',
          label: 'Maximum number of Essentials',
          value: String(s.essentialsMax),
          input: 'number',
          min: 1,
          max: 24,
          onCommit: (value) => {
            const n = Number(value)
            if (!Number.isInteger(n) || n < 1 || n > 24) return 'Enter a number from 1 to 24'
            set({ essentialsMax: n })
            return undefined
          }
        }
      ]
    },
    // The same three keys twice over: Zen's "Tab unloading" rows on the desktop and tablet
    // shells (the pane's wording, its fields), Edge's sleeping tabs on the phone (CT-22).
    {
      id: 'unloading',
      heading: 'Tab unloading',
      layouts: ['desktop', 'tablet'],
      rows: [
        {
          kind: 'switch',
          id: 'unloading-enabled',
          label: 'Unload inactive tabs',
          description: 'Frees memory by unloading tabs you have not used for a while.',
          keywords: ['sleeping tabs', 'memory saver', 'discard', 'inactive'],
          checked: s.unloadEnabled,
          onChange: (v) => set({ unloadEnabled: v })
        },
        {
          kind: 'field',
          id: 'unloading-after',
          label: 'Unload after',
          value: String(s.unloadTimeoutMinutes),
          display: `${s.unloadTimeoutMinutes} minutes`,
          input: 'number',
          min: 1,
          max: 1440,
          disabled: !s.unloadEnabled,
          onCommit: (value) => {
            const n = Number(value)
            if (!Number.isInteger(n) || n < 1 || n > 1440)
              return 'Enter a number of minutes from 1 to 1440'
            set({ unloadTimeoutMinutes: n })
            return undefined
          }
        },
        {
          kind: 'field',
          id: 'unloading-excluded',
          label: 'Never unload these domains',
          value: s.unloadExcludedDomains.join(', '),
          display: s.unloadExcludedDomains.length ? s.unloadExcludedDomains.join(', ') : 'None',
          input: 'text',
          placeholder: 'mail.google.com, notion.so',
          disabled: !s.unloadEnabled,
          onCommit: (value) => {
            set({
              unloadExcludedDomains: value
                .split(',')
                .map((d) => d.trim().toLowerCase())
                .filter(Boolean)
            })
            return undefined
          }
        }
      ]
    },
    ...sleepingTabsGroups(s, set)
  )
  return groups
}

/**
 * Edge's ladder for "Put inactive tabs to sleep after" (Settings › System and performance), in
 * minutes: 30 seconds to 12 hours. The engine stores the timeout in minutes down to a half.
 */
const SLEEP_TIMEOUTS: readonly number[] = [0.5, 1, 5, 15, 30, 60, 120, 180, 360, 720]

/** "30 seconds", "5 minutes", "1 hour", "12 hours": the ladder's labels, and any stored value's. */
export function sleepTimeoutLabel(minutes: number): string {
  if (minutes < 1) return `${Math.round(minutes * 60)} seconds`
  if (minutes < 60) return minutes === 1 ? '1 minute' : `${minutes} minutes`
  const hours = minutes / 60
  const shown = Number.isInteger(hours) ? String(hours) : hours.toFixed(1).replace(/\.0$/, '')
  return hours === 1 ? '1 hour' : `${shown} hours`
}

/**
 * Sleeping tabs on a phone (CT-22), in Edge's words: the switch ("Save resources with sleeping
 * tabs"), the timeout as a choice on Edge's ladder – a stored value off it (an older profile's
 * 20 minutes) is listed in its place rather than shown as nothing – and the never-sleep sites
 * as a managed list ("No sites yet" while it is empty, §9.17), each with Remove, and an Add sheet
 * in a group of its own taking a site (a URL is cut down to its host). Every dependent row reads
 * at .4 while the switch is off (§10.4). A sleeping tab fades
 * in the tab overview and wakes when it is opened; memory pressure puts pages to sleep ahead of
 * the timeout whatever the switch says. The phone shell's groups: the desktop and tablet shells
 * bind the same keys through Zen's "Tab unloading" rows in `tabsSection`.
 */
function sleepingTabsGroups(s: Settings, set: (patch: Partial<Settings>) => void): RowGroup[] {
  const off = !s.unloadEnabled
  const keywords = ['sleeping tabs', 'memory saver', 'discard', 'unload', 'inactive', 'battery']
  const ladder = SLEEP_TIMEOUTS.includes(s.unloadTimeoutMinutes)
    ? SLEEP_TIMEOUTS
    : [...SLEEP_TIMEOUTS, s.unloadTimeoutMinutes].sort((a, b) => a - b)
  const sites = [...s.unloadExcludedDomains].sort((a, b) => a.localeCompare(b))
  const addSite = (raw: string): void => {
    const host = raw
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
      .split(':')[0]
    if (!host || s.unloadExcludedDomains.includes(host)) return
    set({ unloadExcludedDomains: [...s.unloadExcludedDomains, host] })
  }
  return [
    {
      id: 'sleeping-tabs',
      heading: 'Sleeping tabs',
      layouts: ['phone'],
      description:
        'Tabs you have not looked at for a while go to sleep to save memory and battery. A sleeping tab fades in the tab overview and wakes when you open it.',
      rows: [
        {
          kind: 'switch',
          id: 'unload-enabled',
          label: 'Save resources with sleeping tabs',
          keywords,
          checked: s.unloadEnabled,
          onChange: (v) => set({ unloadEnabled: v })
        },
        choice({
          id: 'unload-after',
          label: 'Put inactive tabs to sleep after',
          keywords,
          value: String(s.unloadTimeoutMinutes),
          disabled: off,
          options: ladder.map((minutes) => ({
            value: String(minutes),
            label: sleepTimeoutLabel(minutes)
          })),
          onChange: (v) => set({ unloadTimeoutMinutes: Number(v) })
        })
      ]
    },
    {
      id: 'never-sleep',
      heading: 'Never put these sites to sleep',
      layouts: ['phone'],
      description:
        'Pages on these sites stay awake in the background – a chat, a player, a document you come back to.',
      rows: sites.map((domain) =>
        item(
          `never-sleep:${domain}`,
          domain,
          undefined,
          [
            {
              kind: 'action',
              id: `never-sleep:${domain}:remove`,
              label: 'Remove',
              description: 'Pages on the site go to sleep like any other.',
              onPress: () =>
                set({
                  unloadExcludedDomains: s.unloadExcludedDomains.filter((d) => d !== domain)
                })
            }
          ],
          { keywords, disabled: off }
        )
      ),
      // The list's own empty state (§9.17): one plain row where its sites would be, so the Add
      // action below is a group of its own, as the spell-check languages' is.
      empty: 'No sites yet'
    },
    {
      id: 'never-sleep-add',
      heading: null,
      layouts: ['phone'],
      rows: [
        {
          kind: 'action',
          id: 'never-sleep-add',
          label: 'Add a site',
          keywords,
          disabled: off,
          form: {
            title: 'Never put this site to sleep',
            render: (close) => (
              <UrlForm
                id="never-sleep-site"
                label="Site"
                placeholder="mail.example.com"
                action="Add"
                onSubmit={addSite}
                close={close}
              />
            )
          }
        }
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/**
 * Settings › Downloads (#161's desktop section row for row, on the engine's `Settings.downloads`):
 * the folder through the host's own picker, whether to ask where to save, the file types that
 * open by themselves once they are on disk, and the completion notification (Android's
 * downloader posts it, the desktop shell its own). The downloads bubble and the toolbar button
 * are the desktop chrome's – a single-window host shows its downloads panel as a transfer
 * starts (`Browser.onDownloadStarted`) – so their switches show where the chrome has windows.
 */
function downloadsSection({ state, set }: SectionContext): RowGroup[] {
  const d = resolveDownloadSettings(state.settings)
  const patch = (p: Partial<DownloadSettings>): void => set({ downloads: p })
  const types = d.autoOpenTypes.map((t) => `.${t}`).join(', ')
  const saving: SettingsRow[] = [
    {
      kind: 'action',
      id: 'download-directory',
      label: 'Save files to',
      // Android keeps a picked folder as a document-tree URI: the row reads its relative path.
      description:
        d.directory === null ? 'The system Downloads folder' : downloadFolderLabel(d.directory),
      keywords: ['folder', 'location', 'directory'],
      button: 'Change…',
      onPress: () => {
        // A dismissed picker keeps the folder as it is.
        void downloadsEngine.chooseDirectory().then((dir) => {
          if (dir !== null) patch({ directory: dir })
        })
      }
    },
    {
      kind: 'action',
      id: 'download-directory-default',
      label: 'Use the default folder',
      disabled: d.directory === null,
      button: 'Use default',
      onPress: () => patch({ directory: null })
    },
    {
      kind: 'switch',
      id: 'ask-where-to-save',
      label: 'Always ask where to save files',
      checked: d.askWhereToSave,
      onChange: (v) => set({ askWhereToSave: v })
    }
  ]
  if (state.platform !== 'android') {
    // A desktop OS has a file manager to show the folder in; Android's picked folder is a
    // document tree with no such window.
    saving.splice(1, 0, {
      kind: 'action',
      id: 'download-open-folder',
      label: 'Open the downloads folder',
      keywords: ['reveal', 'file manager', 'explorer', 'finder'],
      leaves: 'external',
      onPress: () => downloadsEngine.openFolder()
    })
  }
  if (d.autoOpenTypes.length > 0) {
    saving.push({
      kind: 'action',
      id: 'download-auto-open',
      label: 'Open certain file types automatically',
      description: types,
      keywords: ['auto open', 'always open'],
      button: 'Stop…',
      confirm: {
        title: 'Stop opening these files automatically?',
        description: `Files of these types are saved without opening: ${types}.`,
        action: 'Stop'
      },
      onPress: () => patch({ autoOpenTypes: [] })
    })
  }
  const groups: RowGroup[] = [{ id: 'saving', heading: 'Saving', rows: saving }]
  if (state.capabilities.windows) {
    groups.push({
      id: 'downloads-panel',
      heading: 'Downloads panel',
      rows: [
        {
          kind: 'switch',
          id: 'download-open-on-complete',
          label: 'Show the downloads when a download finishes',
          description:
            'The bubble opens by itself once the last download in progress is done and leaves again after five seconds.',
          checked: d.openPanelOnComplete,
          onChange: (v) => patch({ openPanelOnComplete: v })
        },
        {
          kind: 'switch',
          id: 'download-open-on-start',
          label: 'Show the downloads when a download starts',
          description: 'Off, the toolbar button animates instead.',
          checked: d.openPanelOnStart,
          onChange: (v) => patch({ openPanelOnStart: v })
        },
        {
          kind: 'switch',
          id: 'download-always-show-button',
          label: 'Always show the downloads button',
          description: 'Keep the button in the toolbar when nothing is downloading.',
          checked: d.alwaysShowButton,
          onChange: (v) => patch({ alwaysShowButton: v })
        }
      ]
    })
  }
  groups.push({
    id: 'download-notifications',
    heading: 'Notifications',
    rows: [
      {
        kind: 'switch',
        id: 'download-notify',
        label: 'Notify when a download finishes',
        description: 'A system notification once the file is saved; opening it shows the file.',
        checked: d.notifyOnComplete,
        onChange: (v) => patch({ notifyOnComplete: v })
      }
    ]
  })
  return groups
}

// ---------------------------------------------------------------------------
// Resources (the resource governor; hosts with the `resourceGovernor` capability)
// ---------------------------------------------------------------------------

const GOVERNOR_ACTION_LABELS: Record<GovernorActionKind, string> = {
  purge: 'Purged memory of',
  throttle: 'Throttled CPU of',
  unthrottle: 'Unthrottled',
  freeze: 'Froze',
  thaw: 'Woke',
  discard: 'Unloaded',
  reload: 'Reloaded',
  'pause-media': 'Paused media in',
  defer: 'Deferred loading'
}

function fmtMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${Math.round(mb).toLocaleString('en-US')} MB`
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  return `${Math.round(m / 60)} h ago`
}

function concurrencyFor(r: ResourceSettings, cores: number): string {
  if (!cores) return '?'
  if (!r.enabled || r.cpuPercent >= 100) return String(cores)
  return String(Math.max(1, Math.min(cores, Math.round((cores * r.cpuPercent) / 100))))
}

const percent = (v: number): string => `${v}%`

/**
 * The resource governor (the desktop overlay's Resources section, row for row): live usage as
 * meters with the two actions, the biggest pages as items that can be unloaded, then the
 * governor's switch and enforcement, the budgets (the two shares as slider rows), sleeping and
 * unloading, what it never touches, the process profile that needs a relaunch, and its log.
 */
function resourcesSection({ state, set }: SectionContext): RowGroup[] {
  const r = state.settings.resources
  const snap = state.resources
  const setR = (patch: Partial<ResourceSettings>): void => set({ resources: { ...r, ...patch } })
  const setP = (patch: Partial<ResourceProcessProfile>): void =>
    set({ resources: { ...r, process: { ...r.process, ...patch } } })
  const totalMb = snap.system.totalMemoryMb
  const percentBudget = totalMb ? Math.round((totalMb * r.memoryPercent) / 100) : 0
  const notes: string[] = []
  if (snap.system.onBattery)
    notes.push(`On battery – budgets are tightened to ${Math.round(r.batteryFactor * 100)}%.`)
  if (snap.system.idle) notes.push('System idle – hidden pages are frozen.')
  const livePages = snap.tabs.filter((u) => {
    const tab = state.tabs[u.tabId]
    return tab !== undefined && !tab.discarded
  })
  const groups: RowGroup[] = [
    {
      id: 'usage',
      heading: 'Live usage',
      description:
        'The resource governor keeps every Chromium process of this browser under the budgets you set. Hidden pages are purged, CPU-throttled, frozen and finally unloaded – cheapest first – and background loads queue up instead of all starting at once.',
      rows: [
        {
          kind: 'custom',
          id: 'usage-meters',
          label: 'Memory, CPU and GPU memory',
          keywords: ['usage', 'live', 'gauge', 'battery', 'idle'],
          render: () => (
            <div className="zen-settings-meters">
              <ResourceMeter
                label="Memory"
                gauge={snap.memory}
                fallbackMax={totalMb}
                format={fmtMb}
                note={`${snap.loadedTabs} live · ${snap.frozenTabs} frozen · ${snap.throttledTabs} throttled · ${snap.queuedLoads} waiting to load · ${fmtMb(snap.overheadMb)} browser, GPU and network overhead`}
              />
              <ResourceMeter
                label="CPU"
                gauge={snap.cpu}
                fallbackMax={100}
                format={(v) => `${Math.round(v)}%`}
                note={`Share of all ${snap.system.cpuCount || '?'} cores; pages see ${concurrencyFor(r, snap.system.cpuCount)} of them.`}
              />
              <ResourceMeter
                label="GPU memory"
                gauge={snap.gpu}
                fallbackMax={0}
                format={fmtMb}
                note={r.gpuMode === 'off' ? 'Hardware acceleration is off.' : undefined}
              />
              {notes.map((note) => (
                <span key={note} className="zen-settings-description zen-settings-description-full">
                  {note}
                </span>
              ))}
            </div>
          )
        },
        {
          kind: 'action',
          id: 'resources-trim',
          label: 'Free up memory now',
          description: 'Purges and unloads what the governor can spare.',
          keywords: ['trim', 'purge', 'memory'],
          button: 'Free up',
          onPress: () => run('resources.trim', undefined)
        },
        {
          kind: 'action',
          id: 'resources-snapshot',
          label: 'Refresh the sample',
          description: snap.sampledAt
            ? `Sampled ${ago(snap.sampledAt)}.`
            : 'Waiting for the first sample…',
          button: 'Refresh',
          onPress: () => run('resources.snapshot', undefined)
        }
      ]
    },
    {
      id: 'biggest',
      heading: 'Biggest pages',
      rows: livePages.slice(0, 8).map((u) => {
        const tab = state.tabs[u.tabId]
        const states: string[] = []
        if (tab.frozen) states.push('frozen')
        if (tab.cpuThrottle > 1) states.push(`CPU ×${tab.cpuThrottle}`)
        return item(
          `page:${u.tabId}`,
          tabTitle(tab),
          `${fmtMb(u.memoryMb)} · ${u.cpuPercent.toFixed(1)}% CPU · ${u.processes} process${u.processes === 1 ? '' : 'es'}${states.length ? ` · ${states.join(' · ')}` : ''}`,
          [
            {
              kind: 'action',
              id: `page:${u.tabId}:unload`,
              label: 'Unload',
              description: 'The tab stays; the page reloads when you return to it.',
              button: 'Unload',
              onPress: () => run('tab.unload', { tabId: u.tabId })
            }
          ]
        )
      }),
      empty: 'No pages are loaded'
    },
    {
      id: 'governor',
      heading: 'Resource governor',
      rows: [
        {
          kind: 'switch',
          id: 'governor-enabled',
          label: 'Keep the browser within budgets',
          description: 'Turning this off also drops the startup switches below after a relaunch.',
          checked: r.enabled,
          onChange: (v) => setR({ enabled: v })
        },
        choice<ResourceEnforcement>({
          id: 'governor-enforcement',
          label: 'Enforcement',
          value: r.enforcement,
          sheetDescription:
            'Balanced only touches hidden pages. Strict may also purge and throttle visible panes. Extreme may throttle and, as a last resort, reload the page you are looking at.',
          options: [
            { value: 'balanced', label: 'Balanced – hidden pages only' },
            { value: 'strict', label: 'Strict – visible panes too' },
            { value: 'extreme', label: 'Extreme – even the active page' }
          ],
          onChange: (v) => setR({ enforcement: v })
        })
      ]
    },
    {
      id: 'budgets',
      heading: 'Budgets',
      rows: [
        numberRow({
          id: 'memory-mb',
          label: 'Memory budget',
          description:
            r.memoryMb > 0
              ? 'Every Chromium process together. Set to 0 to use a share of installed RAM instead.'
              : `Using ${r.memoryPercent}% of installed RAM${totalMb ? ` = ${fmtMb(percentBudget)}` : ''}.`,
          keywords: ['ram'],
          value: r.memoryMb,
          min: 0,
          max: 1_048_576,
          unit: 'MB',
          onCommit: (v) => setR({ memoryMb: v })
        }),
        {
          kind: 'slider',
          id: 'memory-percent',
          label: 'Share of installed RAM',
          description: 'Used when the memory budget above is 0.',
          value: r.memoryPercent,
          min: 5,
          max: 100,
          step: 5,
          format: percent,
          disabled: r.memoryMb > 0,
          onChange: (v) => setR({ memoryPercent: v })
        },
        {
          kind: 'slider',
          id: 'cpu-percent',
          label: 'CPU budget',
          description:
            'Share of the whole machine. Pages are also told they have proportionally fewer cores. 100% = no limit.',
          keywords: ['hardwareConcurrency', 'cores'],
          value: r.cpuPercent,
          min: 5,
          max: 100,
          step: 5,
          format: percent,
          onChange: (v) => setR({ cpuPercent: v })
        },
        numberRow({
          id: 'gpu-memory-mb',
          label: 'GPU memory budget',
          description: '0 = no limit. Also caps Chromium’s GPU tile memory after a relaunch.',
          value: r.gpuMemoryMb,
          min: 0,
          max: 65_536,
          unit: 'MB',
          onCommit: (v) => setR({ gpuMemoryMb: v })
        }),
        choice({
          id: 'battery-factor',
          label: 'On battery, shrink budgets to',
          value: String(Math.round(r.batteryFactor * 100)),
          options: [
            { value: '100', label: '100% (no change)' },
            { value: '85', label: '85%' },
            { value: '70', label: '70%' },
            { value: '50', label: '50%' },
            { value: '25', label: '25%' }
          ],
          onChange: (v) => setR({ batteryFactor: Number(v) / 100 })
        })
      ]
    },
    {
      id: 'sleeping',
      heading: 'Sleeping and unloading',
      rows: [
        numberRow({
          id: 'freeze-after',
          label: 'Freeze hidden pages after',
          description:
            'A frozen page keeps its state but runs no script or timers, like Chrome’s tab freezing. 0 freezes as soon as a page is hidden.',
          value: r.freezeAfterMinutes,
          min: 0,
          max: 1440,
          unit: 'min',
          onCommit: (v) => setR({ freezeAfterMinutes: v })
        }),
        numberRow({
          id: 'idle-freeze',
          label: 'Freeze everything when idle for',
          description:
            'No input anywhere on the system. 0 = off. Extreme enforcement freezes visible pages as well.',
          value: r.idleFreezeMinutes,
          min: 0,
          max: 1440,
          unit: 'min',
          onCommit: (v) => setR({ idleFreezeMinutes: v })
        }),
        {
          kind: 'switch',
          id: 'resources-unload',
          label: 'Unload hidden pages',
          description: 'Zen’s tab unloading; the same setting as under Tab Management.',
          checked: state.settings.unloadEnabled,
          onChange: (v) => set({ unloadEnabled: v })
        },
        numberRow({
          id: 'resources-unload-after',
          label: 'Unload hidden pages after',
          value: state.settings.unloadTimeoutMinutes,
          min: 1,
          max: 1440,
          unit: 'min',
          disabled: !state.settings.unloadEnabled,
          onCommit: (v) => set({ unloadTimeoutMinutes: v })
        }),
        numberRow({
          id: 'max-loaded',
          label: 'Maximum live pages',
          description:
            'Hard cap on pages kept in memory; the oldest hidden page is unloaded to make room. 0 = unlimited.',
          value: r.maxLoadedTabs,
          min: 0,
          max: 500,
          onCommit: (v) => setR({ maxLoadedTabs: v })
        }),
        numberRow({
          id: 'max-loads',
          label: 'Background loads at once',
          description:
            'Further background tabs wait in a queue instead of starting more renderers.',
          value: r.maxConcurrentLoads,
          min: 1,
          max: 16,
          onCommit: (v) => setR({ maxConcurrentLoads: v })
        })
      ]
    },
    {
      id: 'protect',
      heading: 'Never touch',
      rows: [
        {
          kind: 'switch',
          id: 'protect-audible',
          label: 'Pages playing audio',
          checked: r.protectAudible,
          onChange: (v) => setR({ protectAudible: v })
        },
        {
          kind: 'switch',
          id: 'protect-pinned',
          label: 'Pinned tabs',
          checked: r.protectPinned,
          onChange: (v) => setR({ protectPinned: v })
        },
        {
          kind: 'switch',
          id: 'protect-essentials',
          label: 'Essentials',
          checked: r.protectEssentials,
          onChange: (v) => setR({ protectEssentials: v })
        },
        {
          kind: 'info',
          id: 'protect-domains',
          label: 'Excluded domains',
          description: state.settings.unloadExcludedDomains.length
            ? state.settings.unloadExcludedDomains.join(', ')
            : 'None – add them under Tab Management › Never unload these domains.',
          keywords: state.settings.unloadExcludedDomains
        }
      ]
    },
    {
      id: 'process',
      heading: 'Process profile',
      description: 'These switches take effect when the browser starts.',
      rows: [
        ...(snap.restartRequired
          ? [
              {
                kind: 'action',
                id: 'resources-relaunch',
                label: 'Relaunch to apply',
                description: 'The process profile changed since the browser started.',
                button: 'Relaunch',
                onPress: () => run('resources.relaunch', undefined)
              } satisfies SettingsRow
            ]
          : []),
        choice<GpuMode>({
          id: 'gpu-mode',
          label: 'GPU',
          value: r.gpuMode,
          sheetDescription:
            'Low keeps compositing on the GPU but rasterises, decodes video and draws canvases on the CPU. Off disables hardware acceleration.',
          keywords: ['hardware acceleration'],
          options: [
            { value: 'auto', label: 'Automatic' },
            { value: 'low', label: 'Low GPU usage' },
            { value: 'off', label: 'Off – software rendering' }
          ],
          onChange: (v) => setR({ gpuMode: v })
        }),
        numberRow({
          id: 'renderer-limit',
          label: 'Renderer process limit',
          description:
            'Chromium reuses processes across sites once the limit is reached. 0 = Chromium’s default.',
          value: r.process.rendererProcessLimit,
          min: 0,
          max: 64,
          onCommit: (v) => setP({ rendererProcessLimit: v })
        }),
        numberRow({
          id: 'renderer-heap',
          label: 'JavaScript heap cap per page',
          description:
            'A page that grows past its V8 heap cap is unloaded instead of bloating. 0 = default.',
          value: r.process.rendererHeapMb,
          min: 0,
          max: 16384,
          unit: 'MB',
          onCommit: (v) => setP({ rendererHeapMb: v })
        }),
        {
          kind: 'switch',
          id: 'low-end-device',
          label: 'Low-end device mode',
          description:
            'Chromium sizes every cache and tile budget as if this were a low-memory device.',
          checked: r.process.lowEndDeviceMode,
          onChange: (v) => setP({ lowEndDeviceMode: v })
        },
        {
          kind: 'switch',
          id: 'no-spare-renderer',
          label: 'No spare renderer process',
          description:
            'Chromium otherwise keeps a warm, empty renderer waiting for the next navigation.',
          checked: r.process.disableSpareRenderer,
          onChange: (v) => setP({ disableSpareRenderer: v })
        },
        {
          kind: 'switch',
          id: 'no-bfcache',
          label: 'Drop the back/forward cache',
          description: 'Chromium otherwise keeps up to six previous documents alive per tab.',
          checked: r.process.disableBackForwardCache,
          onChange: (v) => setP({ disableBackForwardCache: v })
        },
        {
          kind: 'switch',
          id: 'no-prerender',
          label: 'Block prerendering',
          description: 'Stops pages from loading other pages in hidden renderers ahead of time.',
          checked: r.process.disablePrerender,
          onChange: (v) => setP({ disablePrerender: v })
        },
        numberRow({
          id: 'raster-threads',
          label: 'Raster threads per page',
          description: '0 = Chromium’s default.',
          value: r.process.rasterThreads,
          min: 0,
          max: 8,
          onCommit: (v) => setP({ rasterThreads: v })
        }),
        {
          kind: 'switch',
          id: 'v8-size',
          label: 'V8: favour memory over speed',
          description: 'Smaller heaps, slightly slower script.',
          checked: r.process.v8OptimizeForSize,
          onChange: (v) => setP({ v8OptimizeForSize: v })
        }
      ]
    },
    {
      id: 'log',
      heading: 'Recent actions',
      rows: snap.recentActions.slice(0, 15).map((a, i) => ({
        kind: 'info',
        id: `action:${a.at}:${i}`,
        label: `${GOVERNOR_ACTION_LABELS[a.kind]} ${a.title || 'a tab'}`,
        description: `${ago(a.at)} – ${a.reason}`
      })),
      empty: 'Nothing yet – the governor has not had to act'
    }
  ]
  return groups
}

// ---------------------------------------------------------------------------
// Privacy and Security (ad and tracker blocking, the site-controls program's Safety check, Clear
// browsing data and Site settings blocks, the protection groups of `protectionRows.tsx`; the
// remembered per-site answers are Security's)
// ---------------------------------------------------------------------------

/**
 * Groups in Chrome's Privacy and security order – Safety check, Safe Browsing, Tracking
 * prevention, Clear browsing data, Cookies, Site settings, HTTPS-only, Secure DNS, Privacy
 * signals – each program's groups self-contained: the site-controls program's
 * (`siteControls/settingsRows`) at the safety-check, clear-browsing-data and site-settings
 * positions, the request engine's (`tracking.tsx`) at the tracking-prevention position, the
 * protection program's (`protectionRows.tsx`) at the safe-browsing, cookies, https-only,
 * secure-dns and privacy-signals positions; the remembered per-site answers are Security's
 * (`securitySection`).
 */
function privacySection(ctx: SectionContext): RowGroup[] {
  const { state, set } = ctx
  return [
    ...safetyCheckGroups(ctx),
    ...safeBrowsingGroups(state, set),
    ...trackingGroups(ctx),
    ...clearDataGroups(ctx),
    ...cookiesGroups(state, set),
    ...siteSettingsGroups(ctx),
    ...httpsOnlyGroups(state, set),
    ...secureDnsGroups(state, set),
    ...signalsGroups(state, set)
  ]
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Chrome for Android's Search settings: the engine picker lists the shipped engines, then an
 * "Added" heading with the ones added by hand and a "Recently visited" heading with the engines
 * pages offered through OpenSearch (OMN-27), each with its favicon and, for the user's own, the
 * host it searches; the user's engines are listed under the picker with Make default and
 * Remove, and a form adds one by name and `%s` template.
 */
function searchSection({ state, set }: SectionContext): RowGroup[] {
  const s = state.settings
  // An extension's engine (`chrome_settings_overrides`) is not the user's to pick or remove; it
  // is the default only through the extension, which the URL bar follows (`defaultSearchEngineOf`).
  const engines = state.searchEngines.filter((e) => e.source !== 'extension')
  const own = engines.filter((e) => e.source === 'custom' || e.source === 'discovered')
  const glyph = (e: SearchEngine): ReactNode => <EngineGlyph engine={e} />
  /**
   * The picker's heading for the user's engines; the shipped ones (no `source`) sit above any
   * heading, and only the user's own name the host they search under the label.
   */
  const pickerGroup = (e: SearchEngine): string | undefined =>
    e.source === 'custom' ? 'Added' : e.source === 'discovered' ? 'Recently visited' : undefined
  return [
    {
      id: 'search',
      heading: 'Search',
      rows: [
        choice({
          id: 'search-engine',
          label: 'Default search engine',
          value: s.searchEngineId,
          options: engines.map((e) => ({
            value: e.id,
            label: e.name,
            description: pickerGroup(e) ? (engineHost(e) ?? undefined) : undefined,
            leading: glyph(e),
            group: pickerGroup(e)
          })),
          onChange: (v) => set({ searchEngineId: v })
        }),
        {
          kind: 'switch',
          id: 'search-suggestions',
          label: 'Show search suggestions',
          description: 'Sends what you type to the search engine as you type.',
          checked: s.searchSuggestions,
          onChange: (v) => set({ searchSuggestions: v })
        },
        // Suggestion privacy (omnibox-45): the local sources each behind their own switch, as
        // Edge's; private windows show neither whatever these say.
        {
          kind: 'switch',
          id: 'history-suggestions',
          label: 'Show history suggestions',
          description: 'Pages you visited, and completing an address you typed before.',
          checked: s.historySuggestions !== false,
          onChange: (v) => set({ historySuggestions: v })
        },
        {
          kind: 'switch',
          id: 'bookmark-suggestions',
          label: 'Show bookmark suggestions',
          description: 'Bookmarks whose title or address matches what you type.',
          checked: s.bookmarkSuggestions !== false,
          onChange: (v) => set({ bookmarkSuggestions: v })
        },
        // The desktop URL bar shows the whole URL at rest (§10.1); the phone pill shows hosts
        // only, so the row is the desktop and tablet shells'.
        {
          kind: 'switch',
          id: 'full-urls',
          label: 'Always show full URLs',
          description: 'Keep the scheme and www. in the address bar instead of hiding them.',
          keywords: ['scheme', 'https', 'www', 'address bar'],
          layouts: ['desktop', 'tablet'],
          checked: Boolean(s.showFullUrls),
          onChange: (v) => set({ showFullUrls: v })
        },
        {
          kind: 'info',
          id: 'search-keywords',
          label: 'Engine keywords',
          description: `Type a keyword, then a space: ${engines.map((e) => e.keyword).join(' · ')}`
        }
      ]
    },
    {
      id: 'search-engines',
      heading: 'Added search engines',
      description:
        'Engines you added, and engines from sites you visited that offer one. Sites in private tabs are never listed.',
      rows: own.map((e) =>
        item(
          `search-engine:${e.id}`,
          e.name,
          e.id === s.searchEngineId
            ? 'Default search engine'
            : e.source === 'discovered'
              ? `Recently visited · ${engineHost(e) ?? e.searchUrl}`
              : (engineHost(e) ?? e.searchUrl),
          [
            {
              kind: 'action',
              id: `search-engine:${e.id}:default`,
              label: 'Make default',
              description: `Searches from the URL bar use ${e.name}.`,
              disabled: e.id === s.searchEngineId,
              onPress: () => set({ searchEngineId: e.id })
            },
            {
              kind: 'action',
              id: `search-engine:${e.id}:remove`,
              label: 'Remove',
              description:
                e.source === 'discovered'
                  ? 'The site offers it again on your next visit.'
                  : undefined,
              destructive: true,
              confirm: {
                title: `Remove ${e.name}?`,
                description:
                  e.id === s.searchEngineId
                    ? 'The URL bar goes back to the default engine.'
                    : undefined,
                action: 'Remove'
              },
              onPress: () => run('search.removeEngine', { id: e.id })
            }
          ],
          { leading: glyph(e), keywords: [e.keyword, engineHost(e) ?? ''] }
        )
      ),
      empty: 'No search engines added yet'
    },
    {
      id: 'add-search-engine',
      heading: null,
      rows: [
        {
          kind: 'action',
          id: 'add-search-engine',
          label: 'Add search engine',
          keywords: ['custom', 'opensearch', '%s'],
          button: 'Add…',
          form: {
            title: 'Add search engine',
            description: 'Put %s in the URL where the search terms go.',
            render: (close) => (
              <SearchEngineForm
                onAdd={(name, url) => cmd('search.addEngine', { name, url })}
                close={close}
              />
            )
          }
        }
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// Autofill (services-password-fill, #145)
// ---------------------------------------------------------------------------

/**
 * Settings > Autofill on the phone: the rows of the desktop `AutofillSection` in the page's
 * form – the password switches and the clipboard choice, then, while the vault is locked, its
 * gate (§9.30: Unlock as an action row that is busy while the device checks, the passphrase form
 * at the gutter once the vault asks for one), else the vault's addresses, payment methods and
 * passkeys as item rows with their sheets and the editors behind them. The lists and the gate
 * come in through `ctx.autofill` (`useAutofillSettings`), fetched while this section is shown.
 */
function autofillSection({ state, set, autofill }: SectionContext): RowGroup[] {
  const s = state.settings.passwords
  const android = state.platform === 'android'
  const system = state.autofill.systemAutofill
  const zenium = s.androidProvider === 'zenium'
  const groups: RowGroup[] = [
    {
      id: 'autofill-passwords',
      heading: 'Passwords',
      rows: [
        {
          kind: 'switch',
          id: 'autofill-offer-to-save',
          label: 'Offer to save passwords',
          description: 'Ask to save or update a login after you sign in on a site.',
          keywords: ['save passwords', 'login', 'update'],
          checked: s.offerToSave,
          onChange: (v) => set({ passwords: { ...s, offerToSave: v } })
        },
        {
          kind: 'switch',
          id: 'autofill-auto-sign-in',
          label: 'Sign in automatically',
          description:
            'Fill the one saved login of a site as soon as its form is focused, without the picker.',
          keywords: ['auto sign-in', 'fill'],
          checked: s.autoSignIn,
          onChange: (v) => set({ passwords: { ...s, autoSignIn: v } })
        },
        // The Android host alone has a system autofill service that could own the pages instead.
        ...(android
          ? [
              {
                kind: 'switch',
                id: 'autofill-android-provider',
                label: 'Use Zenium to fill passwords in pages',
                description: androidProviderHint(system, zenium),
                keywords: ['autofill service', 'provider', 'system', 'google'],
                checked: !system?.enabled || zenium,
                disabled: !system?.enabled,
                onChange: (v) =>
                  set({ passwords: { ...s, androidProvider: v ? 'zenium' : 'system' } })
              } satisfies SettingsRow
            ]
          : []),
        choice({
          id: 'autofill-clipboard-clear',
          label: 'Clear copied passwords',
          keywords: ['clipboard', 'card number', 'copy'],
          value: String(s.clipboardClearSeconds),
          options: CLIPBOARD_CLEAR_OPTIONS,
          sheetDescription:
            'Remove a copied password or card number from the clipboard again after this long.',
          onChange: (v) => set({ passwords: { ...s, clipboardClearSeconds: Number(v) } })
        })
      ]
    }
  ]
  if (state.passwords.locked) return [...groups, vaultGateGroup(state.passwords, autofill.gate)]
  return [
    ...groups,
    ...addressGroups(state, set, autofill),
    ...cardGroups(state, set, autofill),
    passkeysGroup(autofill)
  ]
}

/**
 * The vault gate (§9.27 on desktop; here the group's heading names it, §10.3): idle, one Unlock
 * action row – busy while the device checks (§9.30), not pressable while the vault is unreadable
 * (`status.error`, which the description then says); once the vault asks for its passphrase, or
 * for a new one where the device cannot verify the user, the shared passphrase form at the
 * gutter (`VaultPassphraseForm`), whose Cancel returns to the idle gate.
 */
function vaultGateGroup(status: PasswordsStatus, gate: VaultGate): RowGroup {
  const { title, description } = vaultGateCopy(gate.step, status, gate.error)
  const keywords = ['vault', 'locked', 'unlock', 'passphrase']
  return {
    id: 'autofill-vault',
    heading: title,
    description,
    rows:
      gate.step === 'idle'
        ? [
            {
              kind: 'action',
              id: 'autofill-unlock',
              label: 'Unlock',
              keywords,
              busy: gate.busy,
              disabled: status.error !== null,
              button: 'Unlock',
              onPress: () => gate.unlock()
            }
          ]
        : [
            {
              kind: 'custom',
              id: 'autofill-vault-passphrase',
              label: title,
              keywords,
              render: () => <VaultPassphraseForm gate={gate} />
            }
          ]
  }
}

/**
 * A vault list as groups (§10.3): the heading with its switch, the entries as item rows under
 * it (one 20 px glyph column, labels at 48 – §10.4) with the §9.17 empty line once the list has
 * arrived, and the add action last; the two tails carry no heading, so the three read as one.
 */
function vaultListGroups(
  id: string,
  head: Omit<RowGroup, 'id'>,
  entries: SettingsRow[] | null,
  empty: string,
  add: SettingsRow | null
): RowGroup[] {
  const groups: RowGroup[] = [{ id, ...head }]
  groups.push({
    id: `${id}-list`,
    heading: null,
    rows: entries ?? [],
    empty: entries ? empty : undefined
  })
  if (add) groups.push({ id: `${id}-add`, heading: null, rows: [add] })
  return groups
}

function addressGroups(
  state: UIState,
  set: SectionContext['set'],
  { addresses }: AutofillSettingsData
): RowGroup[] {
  const a = state.settings.autofill
  return vaultListGroups(
    'autofill-addresses',
    {
      heading: 'Addresses',
      rows: [
        {
          kind: 'switch',
          id: 'autofill-save-addresses',
          label: 'Save and fill addresses',
          description:
            'Offer to save addresses typed into forms, and fill them back into checkouts and sign-ups.',
          checked: a.addresses,
          onChange: (v) => set({ autofill: { ...a, addresses: v } })
        }
      ]
    },
    addresses?.map((address) =>
      item(
        `autofill-address:${address.id}`,
        addressTitle(address),
        addressRowSubtitle(address),
        [
          {
            kind: 'action',
            id: `autofill-address:${address.id}:edit`,
            label: 'Edit address',
            closesSheet: true,
            onPress: () => openAutofillEdit({ kind: 'address', id: address.id })
          },
          {
            kind: 'action',
            id: `autofill-address:${address.id}:delete`,
            label: 'Delete address',
            destructive: true,
            confirm: {
              title: `Delete ${addressTitle(address)}?`,
              description: 'Zenium stops filling it into forms.',
              action: 'Delete'
            },
            onPress: () => run('autofill.removeAddress', { id: address.id })
          }
        ],
        {
          leading: <MapPin className="zen-settings-glyph" aria-hidden="true" />,
          keywords: [address.organization, address.locality, address.country].filter(Boolean)
        }
      )
    ) ?? null,
    'No addresses saved yet',
    {
      kind: 'action',
      id: 'autofill-add-address',
      label: 'Add address',
      keywords: ['new address'],
      onPress: () => openAutofillEdit({ kind: 'address', id: null })
    }
  )
}

function cardGroups(
  state: UIState,
  set: SectionContext['set'],
  { cards, copying, copyCard }: AutofillSettingsData
): RowGroup[] {
  const a = state.settings.autofill
  return vaultListGroups(
    'autofill-cards',
    {
      heading: 'Payment methods',
      description: 'Card numbers stay in the vault; security codes are never saved.',
      rows: [
        {
          kind: 'switch',
          id: 'autofill-save-cards',
          label: 'Save and fill payment methods',
          description:
            'Offer to save cards typed into checkouts, and fill them back after you verify it is you.',
          keywords: ['credit card', 'debit card'],
          checked: a.cards,
          onChange: (v) => set({ autofill: { ...a, cards: v } })
        }
      ]
    },
    cards?.map((card) =>
      item(
        `autofill-card:${card.id}`,
        cardTitle(card),
        cardSubtitle(card),
        [
          {
            kind: 'action',
            id: `autofill-card:${card.id}:copy`,
            label: 'Copy card number',
            description: 'Unlocks with your passphrase where the vault asks for it.',
            busy: copying === card.id,
            onPress: () => copyCard(card)
          },
          {
            kind: 'action',
            id: `autofill-card:${card.id}:edit`,
            label: 'Edit card',
            closesSheet: true,
            onPress: () => openAutofillEdit({ kind: 'card', id: card.id })
          },
          {
            kind: 'action',
            id: `autofill-card:${card.id}:delete`,
            label: 'Delete card',
            destructive: true,
            confirm: {
              title: `Delete ${cardTitle(card)}?`,
              description: 'Zenium stops filling it into checkouts.',
              action: 'Delete'
            },
            onPress: () => run('autofill.removeCard', { id: card.id })
          }
        ],
        {
          leading: <CreditCard className="zen-settings-glyph" aria-hidden="true" />,
          keywords: [NETWORK_NAMES[card.network], card.last4, card.name].filter(Boolean)
        }
      )
    ) ?? null,
    'No cards saved yet',
    {
      kind: 'action',
      id: 'autofill-add-card',
      label: 'Add card',
      keywords: ['new card', 'credit card', 'debit card'],
      onPress: () => openAutofillEdit({ kind: 'card', id: null })
    }
  )
}

function passkeysGroup({ passkeys }: AutofillSettingsData): RowGroup {
  return {
    id: 'autofill-passkeys',
    heading: 'Passkeys',
    description:
      "Passkeys created in Zenium. The keys themselves stay with your device's authenticator (Windows Hello, Touch ID, Google Password Manager); this is where they exist and when they were last used.",
    rows:
      passkeys?.map((passkey) =>
        item(
          `autofill-passkey:${passkey.id}`,
          passkey.userDisplayName || passkey.userName,
          passkeySubtitle(passkey),
          [
            {
              kind: 'action',
              id: `autofill-passkey:${passkey.id}:forget`,
              label: "Forget this passkey's record",
              description: 'The passkey itself stays with the authenticator that holds it.',
              destructive: true,
              confirm: {
                title: `Forget the passkey for ${passkey.rpName || passkey.rpId}?`,
                description:
                  'Only the record goes; the key itself stays with the authenticator that holds it.',
                action: 'Forget'
              },
              onPress: () => run('autofill.removePasskey', { id: passkey.id })
            }
          ],
          {
            leading: <Fingerprint className="zen-settings-glyph" aria-hidden="true" />,
            keywords: [passkey.rpId, passkey.rpName, passkey.userName].filter(Boolean)
          }
        )
      ) ?? [],
    empty: passkeys ? 'No passkeys yet' : undefined
  }
}

// ---------------------------------------------------------------------------
// Languages (page translation, #106)
// ---------------------------------------------------------------------------

/**
 * Settings › Languages, the desktop pane (`LanguagesSection.tsx`) row for row: whether Zenium
 * offers to translate, the languages the user reads – the first is what pages are translated
 * into – as item rows that promote or remove, the always and never lists, the sites never
 * offered, and the models on the device with their size and a confirmed removal. What the
 * desktop adds through a menulist is an action row here (§9.13: no menulist on a phone settings
 * page) opening a sheet of the languages or models left to pick. The lists read the core's
 * translate state and write through its commands, so both platforms keep one set of rules.
 */
function languagesSection({ state, dictionary }: SectionContext): RowGroup[] {
  const t = state.translate
  const prefs = t.preferences
  // The "Download a model" sheet lists the registry's pairs, which the core is asked for: asked
  // here, so the list is at hand by the time the sheet – which measures itself as it mounts –
  // opens (once; nothing happens after the first answer).
  warmRegistryModels()
  const set = (patch: Partial<TranslatePreferences>): void => run('translate.setPreferences', patch)
  const rule = (language: string, value: 'always' | 'never' | 'ask'): void =>
    run('translate.setLanguageRule', { language, rule: value })

  /** The languages in `codes` as item rows, each opening the rows `actions` gives it. */
  const languageRows = (
    prefix: string,
    codes: readonly string[],
    actions: (code: string, index: number) => SettingsRow[],
    description?: (code: string, index: number) => string | undefined
  ): SettingsRow[] =>
    codes.map((code, index) =>
      item(
        `${prefix}:${code}`,
        languageName(code),
        description?.(code, index),
        actions(code, index),
        { keywords: [code] }
      )
    )

  /** The action row that adds to a list, in a group of its own after it; none when nothing is left. */
  const addGroup = (
    id: string,
    title: string,
    codes: readonly string[],
    onAdd: (code: string) => void
  ): RowGroup[] => {
    const options = languageOptions(t.languages.filter((code) => !codes.includes(code)))
    if (options.length === 0) return []
    return [
      {
        id: `${id}-add`,
        heading: null,
        rows: [
          {
            kind: 'action',
            id: `languages-${id}-add`,
            label: 'Add a language',
            keywords: [title],
            button: 'Add…',
            form: {
              title,
              render: (close) => (
                <PickList label={title} options={options} onPick={onAdd} close={close} />
              )
            }
          }
        ]
      }
    ]
  }

  const preferred = prefs.preferred
  const installedBytes = t.installed.reduce((sum, m) => sum + m.bytes, 0)
  const modelRows: SettingsRow[] = [
    ...t.installed.map((m) => {
      const pair = pairLabel(m.from, m.to)
      return item(`languages-model:${pairKey(m)}`, pair, formatBytes(m.bytes), [
        {
          kind: 'action',
          id: `languages-model:${pairKey(m)}:remove`,
          label: 'Remove model',
          description: 'It is downloaded again the next time these languages are translated.',
          destructive: true,
          button: 'Remove…',
          confirm: {
            title: `Remove the ${pair} model?`,
            description: `${formatBytes(m.bytes)} is freed; the model is downloaded again the next time a page in these languages is translated.`,
            action: 'Remove'
          },
          onPress: () => run('translate.removeModel', { from: m.from, to: m.to })
        }
      ])
    }),
    ...t.downloading.map((m): SettingsRow => ({
      kind: 'info',
      id: `languages-model:${pairKey(m)}`,
      label: pairLabel(m.from, m.to),
      description: 'Downloading…'
    }))
  ]
  if (t.installed.length > 0) {
    modelRows.push({
      kind: 'info',
      id: 'languages-models-total',
      label: `${formatBytes(installedBytes)} on this device`,
      keywords: ['storage', 'space']
    })
  }

  return [
    {
      id: 'translation',
      heading: 'Translation',
      description:
        'Pages in other languages are translated on this device, with models Zenium downloads the first time a language pair is used. Nothing leaves the device.',
      rows: [
        {
          kind: 'switch',
          id: 'languages-offer',
          label: 'Offer to translate pages in other languages',
          keywords: ['automatic', 'translation bar', 'auto offer'],
          checked: prefs.autoOffer,
          onChange: (autoOffer) => set({ autoOffer })
        }
      ]
    },
    {
      id: 'read',
      heading: 'Languages you read',
      description:
        'Pages in these languages are shown as they are; the first one is the language other pages are translated into.',
      rows: languageRows(
        'languages-read',
        preferred,
        (code, index) => [
          ...(index > 0
            ? [
                {
                  kind: 'action',
                  id: `languages-read:${code}:first`,
                  label: 'Translate pages into this language',
                  description: 'Puts it first among the languages you read.',
                  button: 'Make first',
                  onPress: () => set({ preferred: [code, ...preferred.filter((c) => c !== code)] })
                } satisfies SettingsRow
              ]
            : []),
          ...(preferred.length > 1
            ? [
                {
                  kind: 'action',
                  id: `languages-read:${code}:remove`,
                  label: 'Remove',
                  description: 'Pages in this language are offered for translation again.',
                  button: 'Remove',
                  onPress: () => set({ preferred: preferred.filter((c) => c !== code) })
                } satisfies SettingsRow
              ]
            : [])
        ],
        (_code, index) => (index === 0 ? 'Pages are translated into this language' : undefined)
      )
    },
    ...addGroup('read', 'Add a language you read', preferred, (code) =>
      set({ preferred: [...preferred, code] })
    ),
    {
      id: 'always',
      heading: 'Always translate',
      description: 'Pages in these languages are translated as soon as they load, without asking.',
      rows: languageRows('languages-always', prefs.alwaysTranslate, (code) => [
        {
          kind: 'action',
          id: `languages-always:${code}:ask`,
          label: 'Remove',
          description: 'Zenium asks before translating pages in this language again.',
          button: 'Remove',
          onPress: () => rule(code, 'ask')
        }
      ]),
      empty: 'No languages yet'
    },
    ...addGroup('always', 'Always translate', prefs.alwaysTranslate, (code) =>
      rule(code, 'always')
    ),
    {
      id: 'never',
      heading: 'Never translate',
      description: 'Zenium never offers to translate pages in these languages.',
      rows: languageRows('languages-never', prefs.neverTranslate, (code) => [
        {
          kind: 'action',
          id: `languages-never:${code}:ask`,
          label: 'Remove',
          description: 'Zenium offers to translate pages in this language again.',
          button: 'Remove',
          onPress: () => rule(code, 'ask')
        }
      ]),
      empty: 'No languages yet'
    },
    ...addGroup('never', 'Never translate', prefs.neverTranslate, (code) => rule(code, 'never')),
    {
      id: 'sites',
      heading: 'Sites never translated',
      description:
        'Zenium does not offer to translate these sites. Add one from the translation bar’s options while you are on the site.',
      rows: prefs.neverTranslateSites.map((site) =>
        item(`languages-site:${site}`, site, undefined, [
          {
            kind: 'action',
            id: `languages-site:${site}:forget`,
            label: 'Remove',
            description: 'Zenium offers to translate this site again.',
            button: 'Remove',
            onPress: () =>
              set({ neverTranslateSites: prefs.neverTranslateSites.filter((s) => s !== site) })
          }
        ])
      ),
      empty: 'No sites yet'
    },
    {
      id: 'models',
      heading: 'Translation models',
      description: `Downloaded the first time a language pair is translated and kept on this device. Mozilla’s Firefox Translations models (${t.modelLicense}); list from ${t.registryDate}.`,
      rows: modelRows,
      empty: 'No models on this device yet'
    },
    {
      id: 'models-add',
      heading: null,
      rows: [
        {
          kind: 'action',
          id: 'languages-model-download',
          label: 'Download a model',
          description: 'Fetch a language pair ahead of time, for pages read offline.',
          keywords: ['offline', 'language pair'],
          button: 'Download…',
          form: {
            title: 'Download a model',
            render: (close) => (
              <ModelPickList onDevice={[...t.installed, ...t.downloading]} close={close} />
            )
          }
        }
      ]
    },
    ...spellcheckGroups(state, dictionary)
  ]
}

/** What a language's dictionary is doing, as its row's description; nothing while it is ready. */
function dictionaryDetail(status: SpellcheckDictionaryStatus): string | undefined {
  if (status === 'downloading') return 'Downloading dictionary…'
  if (status === 'failed') return 'Dictionary download failed'
  return undefined
}

/**
 * Settings › Languages › Spell check on a phone, the desktop pane's `SpellcheckGroups` row for
 * row (CT-07, CT-19). Android's WebView has no spellchecker of the browser's own – the system
 * spell checker service chosen next to the keyboards checks its text fields – so on that host
 * the group states the limit and leads to the keyboard settings (`spellcheck.openKeyboardSettings`).
 * A host with a checker of its own gets the switch, the languages checked in as item rows – the
 * dictionary's state as the description, Remove inside – and an Add sheet of the host's other
 * dictionaries up to Chrome's five; with the switch off the list is the dependent group at .4
 * (§10.4). A host whose checker follows the OS's languages shows where they are chosen instead.
 * The custom dictionary (Chrome's "Customize spell check": the words the checker never marks,
 * each with Remove inside, and the Add a new word form) follows on the desktop and tablet
 * shells, whose host checks spelling itself; no phone host does.
 */
function spellcheckGroups(state: UIState, dictionary: DictionaryWords): RowGroup[] {
  const status = state.spellcheck
  const settings = state.settings.spellcheck
  const keywords = ['spelling', 'spell check', 'dictionary', 'misspelt', 'autocorrect']
  if (!status.available) {
    return [
      {
        id: 'spellcheck',
        heading: 'Spell check',
        description:
          'Text fields are checked by the spell checker of the keyboard in use. Its languages, and whether it marks or corrects words as you type, are chosen with the keyboard in the system settings.',
        rows: [
          {
            kind: 'action',
            id: 'spellcheck-keyboard',
            label: 'Keyboard settings',
            description: 'Open the system’s keyboard and spell checker settings.',
            keywords,
            leaves: 'external',
            onPress: () => run('spellcheck.openKeyboardSettings', undefined)
          }
        ]
      }
    ]
  }
  const checked = status.languages.filter((l) => l.enabled)
  const remaining = status.languages.filter((l) => !l.enabled)
  const off = !settings.enabled
  const groups: RowGroup[] = [
    {
      id: 'spellcheck',
      heading: 'Spell check',
      description:
        'Misspelt words in text fields are underlined as you type; their menu offers corrections and Add to Dictionary.',
      rows: [
        {
          kind: 'switch',
          id: 'spellcheck-enabled',
          label: 'Check the spelling of text fields',
          keywords,
          checked: settings.enabled,
          onChange: (enabled) => run('spellcheck.setEnabled', { enabled })
        }
      ]
    }
  ]
  if (status.systemLanguages) {
    groups.push({
      id: 'spellcheck-languages',
      heading: 'Languages',
      rows: [
        {
          kind: 'info',
          id: 'spellcheck-system-languages',
          label: 'Languages follow the system',
          description:
            'The system’s spell checker checks in the languages chosen for it in the system settings; a text field’s menu switches between them.',
          keywords
        }
      ]
    })
    return groups
  }
  groups.push({
    id: 'spellcheck-languages',
    heading: 'Languages',
    description: `Text fields are checked in up to ${SPELLCHECK_LANGUAGES_MAX} languages at a time. A dictionary is downloaded the first time a language is checked in and kept on this device.`,
    rows: checked.map((language) =>
      item(
        `spellcheck-language:${language.code}`,
        language.name,
        dictionaryDetail(language.status),
        [
          {
            kind: 'action',
            id: `spellcheck-language:${language.code}:remove`,
            label: 'Remove',
            description: 'Text fields are no longer checked in this language.',
            button: 'Remove',
            onPress: () => run('spellcheck.setLanguage', { code: language.code, on: false })
          }
        ],
        { keywords: [language.code, ...keywords], disabled: off }
      )
    ),
    empty: 'No languages yet'
  })
  if (checked.length >= SPELLCHECK_LANGUAGES_MAX) {
    groups.push({
      id: 'spellcheck-add',
      heading: null,
      rows: [
        {
          kind: 'info',
          id: 'spellcheck-limit',
          label: `Up to ${SPELLCHECK_LANGUAGES_MAX} languages can be checked at a time`,
          description: 'Remove one to add another.',
          disabled: off
        }
      ]
    })
  } else if (remaining.length > 0) {
    const options = remaining.map((l) => ({ value: l.code, label: l.name }))
    groups.push({
      id: 'spellcheck-add',
      heading: null,
      rows: [
        {
          kind: 'action',
          id: 'spellcheck-add',
          label: 'Add a language',
          keywords,
          disabled: off,
          button: 'Add…',
          form: {
            title: 'Add a language to check in',
            render: (close) => (
              <PickList
                label="Add a language to check in"
                options={options}
                onPick={(code) => run('spellcheck.setLanguage', { code, on: true })}
                close={close}
              />
            )
          }
        }
      ]
    })
  }
  groups.push(...customDictionaryGroups(dictionary, off, keywords))
  return groups
}

/**
 * Chrome's "Customize spell check" as two groups: the words the checker never marks – added
 * here or with a text field's Add to Dictionary – each an item whose sheet holds Remove, and
 * the Add a new word action with its §9.12 form (`WordForm`). Nothing is drawn while the words
 * have not arrived; both groups follow the spell check switch as its dependent (§10.4).
 */
function customDictionaryGroups(
  dictionary: DictionaryWords,
  off: boolean,
  keywords: readonly string[]
): RowGroup[] {
  const words = dictionary.words
  const layouts: FormFactor[] = ['desktop', 'tablet']
  return [
    {
      id: 'spellcheck-dictionary',
      heading: 'Custom dictionary',
      description:
        'Words the checker never marks. Add to Dictionary in a text field’s menu puts a word here too.',
      layouts,
      rows: (words ?? []).map((word) =>
        item(
          `spellcheck-word:${word}`,
          word,
          undefined,
          [
            {
              kind: 'action',
              id: `spellcheck-word:${word}:remove`,
              label: 'Remove',
              description: 'The checker marks this word again.',
              button: 'Remove',
              onPress: () => dictionary.remove(word)
            }
          ],
          { keywords: ['custom dictionary', 'word', ...keywords], disabled: off }
        )
      ),
      empty: words === null ? undefined : 'No words yet'
    },
    {
      id: 'spellcheck-add-word',
      heading: null,
      layouts,
      rows: [
        {
          kind: 'action',
          id: 'spellcheck-add-word',
          label: 'Add a new word',
          description: 'One word the checker never marks.',
          keywords: ['custom dictionary', 'customize spell check', ...keywords],
          disabled: off,
          button: 'Add…',
          form: {
            title: 'Add a new word',
            render: (close) => (
              <WordForm
                problem={(word) => wordProblem(word, words)}
                onAdd={dictionary.add}
                close={close}
              />
            )
          }
        }
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// Space Routing
// ---------------------------------------------------------------------------

function spaceRoutingSection({ state, set }: SectionContext): RowGroup[] {
  const routing = state.settings.spaceRouting
  const remove = (domain: string): void => {
    const next = { ...routing }
    delete next[domain]
    set({ spaceRouting: next })
  }
  return [
    {
      id: 'routes',
      heading: 'Routes',
      description:
        'Space Routing opens links from the listed domains in a specific Space, wherever you click them.',
      rows: sorted(routing).map(([domain, spaceId]) => {
        const space = state.spaces.find((sp) => sp.id === spaceId)
        return item(
          `route:${domain}`,
          domain,
          space ? spaceLabel(space) : 'Space no longer exists',
          [
            {
              kind: 'action',
              id: `route:${domain}:remove`,
              label: 'Remove route',
              button: 'Remove',
              onPress: () => remove(domain)
            }
          ]
        )
      }),
      empty: 'No routes yet'
    },
    {
      id: 'add-route',
      heading: null,
      rows: [
        {
          kind: 'action',
          id: 'add-route',
          label: 'Add route',
          button: 'Add…',
          keywords: ['domain', 'space'],
          disabled: state.spaces.length === 0,
          form: {
            title: 'Add route',
            description: 'Links to the domain open in the Space you pick.',
            render: (close) => (
              <AddRouteForm
                spaces={state.spaces}
                onAdd={(domain, spaceId) =>
                  set({ spaceRouting: { ...routing, [domain]: spaceId } })
                }
                close={close}
              />
            )
          }
        }
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

function containersSection({ state }: SectionContext): RowGroup[] {
  const containers = state.containers
  return [
    {
      id: 'containers',
      heading: 'Containers',
      description:
        'Containers keep cookies and site data separate, so you can stay signed in to several accounts on the same site. Assign a container to a Space to isolate it.',
      rows: containers.map((c, i) => {
        const editable = c.id !== DEFAULT_CONTAINER_ID
        const rows: SettingsRow[] = editable
          ? [
              choice<ContainerColor>({
                id: `container:${c.id}:colour`,
                label: 'Colour',
                value: c.color,
                options: (Object.keys(CONTAINER_COLORS) as ContainerColor[]).map((k) => ({
                  value: k,
                  label: k.charAt(0).toUpperCase() + k.slice(1)
                })),
                onChange: (v) => run('container.update', { id: c.id, patch: { color: v } })
              }),
              choice<ContainerIconName>({
                id: `container:${c.id}:icon`,
                label: 'Icon',
                value: c.icon,
                options: CONTAINER_ICONS.map((k) => ({
                  value: k,
                  label: k.charAt(0).toUpperCase() + k.slice(1)
                })),
                onChange: (v) => run('container.update', { id: c.id, patch: { icon: v } })
              }),
              {
                kind: 'action',
                id: `container:${c.id}:up`,
                label: 'Move up',
                button: 'Up',
                disabled: i <= 1,
                onPress: () => run('container.reorder', { id: c.id, index: i - 1 })
              },
              {
                kind: 'action',
                id: `container:${c.id}:down`,
                label: 'Move down',
                button: 'Down',
                disabled: i >= containers.length - 1,
                onPress: () => run('container.reorder', { id: c.id, index: i + 1 })
              },
              {
                kind: 'action',
                id: `container:${c.id}:delete`,
                label: 'Delete container',
                description: 'Its cookies and site data are cleared.',
                button: 'Delete…',
                destructive: true,
                confirm: {
                  title: `Delete ${c.name}?`,
                  description:
                    'Tabs in this container lose their sign-ins; its site data is cleared.',
                  action: 'Delete'
                },
                onPress: () => run('container.delete', { id: c.id })
              }
            ]
          : []
        return item(
          `container:${c.id}`,
          c.name,
          editable ? undefined : 'Tabs without a container',
          rows,
          { leading: <ContainerIcon container={c} size={20} />, keywords: [c.color, c.icon] }
        )
      })
    },
    {
      id: 'new-container',
      heading: null,
      rows: [
        {
          kind: 'action',
          id: 'new-container',
          label: 'New container',
          keywords: ['create', 'colour', 'icon'],
          button: 'New…',
          form: {
            title: 'New container',
            render: (close) => (
              <NewContainerForm
                onCreate={(name, color, icon) => run('container.create', { name, color, icon })}
                close={close}
              />
            )
          }
        }
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// Boosts
// ---------------------------------------------------------------------------

function boostsSection({ state, tab, boost }: SectionContext): RowGroup[] {
  const opener = tab.openerTabId ? state.tabs[tab.openerTabId] : undefined
  const site =
    opener && /^https?:/.test(opener.url) && state.window.kind !== 'private' ? opener : null
  return [
    {
      id: 'boosts',
      heading: 'Active Boosts',
      description:
        'Boosts change how a website looks: tint its colours, swap fonts, zap elements away or force dark mode. They apply to every page of the site and stay until you remove them.',
      rows: state.boosts.map((b) => {
        const parts = [
          b.tint && 'tint',
          b.font && 'font',
          b.fontSize !== 100 && `${b.fontSize}% text`,
          b.darkMode && 'dark mode',
          b.zapped.length > 0 && `${b.zapped.length} zapped`,
          b.css.trim() && 'custom CSS'
        ].filter((p): p is string => typeof p === 'string')
        return item(
          `boost:${b.domain}`,
          b.domain,
          `${parts.join(' · ') || 'Nothing configured'} · ${relativeTime(b.updatedAt)}`,
          [
            {
              kind: 'switch',
              id: `boost:${b.domain}:enabled`,
              label: 'Enabled',
              checked: b.enabled,
              onChange: (v) => run('boost.update', { domain: b.domain, patch: { enabled: v } })
            },
            {
              kind: 'action',
              id: `boost:${b.domain}:remove`,
              label: 'Remove Boost',
              button: 'Remove…',
              destructive: true,
              confirm: {
                title: `Remove the Boost for ${b.domain}?`,
                description: 'The site shows as its author made it again.',
                action: 'Remove'
              },
              onPress: () => run('boost.remove', { domain: b.domain })
            }
          ],
          {
            leading: b.tint ? (
              <span
                className="zen-settings-tint"
                style={{ background: b.tint }}
                aria-hidden="true"
              />
            ) : undefined,
            keywords: parts
          }
        )
      }),
      empty: 'No Boosts yet'
    },
    {
      id: 'boost-current',
      heading: null,
      rows: [
        {
          kind: 'action',
          id: 'boost-current',
          label: site
            ? `Boost ${new URL(site.url).hostname.replace(/^www\./, '')}`
            : 'Boost a site',
          description: site
            ? 'Opens the Boost editor on the site you came from.'
            : 'Open a site and tap the sparkle in the address bar.',
          button: 'Boost…',
          disabled: !site,
          onPress: () => site && boost(site.id)
        }
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// Mods
// ---------------------------------------------------------------------------

function modsSection({ state }: SectionContext): RowGroup[] {
  return [
    {
      id: 'mods',
      heading: 'Mods',
      description:
        'Custom CSS for the browser chrome, like Zen’s Mods and userChrome.css. Style hooks: .zen-tab, .zen-essential, .zen-panel, .zen-content-frame, .zen-toolbar-button, [data-active].',
      rows: state.mods.map((mod) =>
        item(
          `mod:${mod.id}`,
          mod.name,
          mod.source ?? `${mod.css.length.toLocaleString()} characters`,
          [
            {
              kind: 'switch',
              id: `mod:${mod.id}:enabled`,
              label: 'Enabled',
              checked: mod.enabled,
              onChange: (v) => run('mod.update', { id: mod.id, patch: { enabled: v } })
            },
            {
              kind: 'field',
              id: `mod:${mod.id}:name`,
              label: 'Name',
              value: mod.name,
              input: 'text',
              onCommit: (name) => {
                const trimmed = name.trim()
                if (!trimmed) return 'Enter a name'
                if (trimmed !== mod.name)
                  run('mod.update', { id: mod.id, patch: { name: trimmed } })
                return undefined
              }
            },
            {
              kind: 'custom',
              id: `mod:${mod.id}:css`,
              label: 'CSS',
              render: () => (
                <CssEditor
                  value={mod.css}
                  onCommit={(css) => run('mod.update', { id: mod.id, patch: { css } })}
                />
              )
            },
            {
              kind: 'action',
              id: `mod:${mod.id}:remove`,
              label: 'Remove Mod',
              button: 'Remove…',
              destructive: true,
              confirm: {
                title: `Remove ${mod.name}?`,
                description: 'Its CSS stops applying to the browser.',
                action: 'Remove'
              },
              onPress: () => run('mod.remove', { id: mod.id })
            }
          ],
          { keywords: ['css', 'style'] }
        )
      ),
      empty: 'No Mods installed'
    },
    {
      id: 'add-mod',
      heading: 'Add a Mod',
      rows: [
        {
          kind: 'action',
          id: 'new-mod',
          label: 'New Mod',
          description: 'Starts an empty stylesheet you edit here.',
          button: 'New',
          onPress: () => run('mod.add', { name: 'New Mod', css: '/* your CSS */\n' })
        },
        {
          kind: 'action',
          id: 'import-mod-url',
          label: 'Import from URL',
          button: 'Import…',
          form: {
            title: 'Import a Mod from a URL',
            render: (close) => (
              <UrlForm
                id="mod-url"
                label="Stylesheet URL"
                placeholder="https://example.com/mod.css"
                action="Import"
                onSubmit={(url) => run('mod.importUrl', { url })}
                close={close}
              />
            )
          }
        },
        {
          kind: 'action',
          id: 'import-mod-file',
          label: 'Import from file',
          button: 'Import…',
          onPress: () => run('mod.importFile', undefined)
        }
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// Extensions
// ---------------------------------------------------------------------------

function extensionsSection(ctx: SectionContext): RowGroup[] {
  return extensionsGroups(ctx)
}

// ---------------------------------------------------------------------------
// AI Agents
// ---------------------------------------------------------------------------

function agentsSection({ state, set }: SectionContext): RowGroup[] {
  const a = state.settings.agents
  const server = state.agentServer
  const setAgents = (patch: Partial<typeof a>): void => set({ agents: { ...a, ...patch } })
  const groups: RowGroup[] = [
    {
      id: 'server',
      heading: 'Server',
      description:
        'Let any AI agent drive this browser through a built-in Model Context Protocol server. Agents open their own tabs, read pages and click and type in them; each one gets a coloured cursor and tab badge.',
      rows: [
        {
          kind: 'switch',
          id: 'mcp-enabled',
          label: 'Enable the MCP server',
          description:
            server.error ??
            (server.running && server.url ? `Running at ${server.url}` : 'The server is off.'),
          keywords: ['mcp', 'model context protocol'],
          checked: a.enabled,
          onChange: (v) => setAgents({ enabled: v })
        },
        {
          kind: 'field',
          id: 'mcp-port',
          label: 'Port',
          description: undefined,
          value: String(a.port),
          input: 'number',
          min: 1024,
          max: 65535,
          onCommit: (value) => {
            const port = Number(value)
            if (!Number.isInteger(port) || port < 1024 || port > 65535)
              return 'Enter a port from 1024 to 65535'
            setAgents({ port })
            return undefined
          }
        },
        {
          kind: 'switch',
          id: 'mcp-lan',
          label: 'Allow devices on the local network',
          description:
            'Off by default. Lets an agent on another device drive this browser over Wi-Fi.',
          checked: a.lan,
          onChange: (v) => setAgents({ lan: v })
        }
      ]
    }
  ]
  if (a.enabled && server.running && server.url) {
    const url = server.url
    const httpConfig = JSON.stringify({ mcpServers: { zenium: { url } } }, null, 2)
    const stdioConfig = JSON.stringify(
      { mcpServers: { zenium: { command: 'zenium', args: ['--mcp'] } } },
      null,
      2
    )
    groups.push({
      id: 'connect',
      heading: 'Connect an agent',
      description:
        'Put the token in an Authorization: Bearer header, or append ?token=… to the URL.' +
        (server.lanUrls.length
          ? ` On the local network: ${server.lanUrls.join(', ')} – only share the token with devices you trust.`
          : ''),
      rows: [
        {
          kind: 'custom',
          id: 'mcp-endpoint',
          label: 'Streamable HTTP endpoint',
          keywords: [url],
          render: () => <CopyRow label="Streamable HTTP endpoint" value={url} />
        },
        {
          kind: 'custom',
          id: 'mcp-token',
          label: 'Connection token',
          description: 'Skips the approval prompt.',
          render: () => <CopyRow label="Connection token" value={server.token} secret />
        },
        {
          kind: 'custom',
          id: 'mcp-config',
          label: 'mcp.json (URL)',
          keywords: ['config', 'streamable http'],
          render: () => <CodeBlock label="mcp.json (URL)" value={httpConfig} />
        },
        {
          kind: 'custom',
          id: 'mcp-config-stdio',
          label: 'mcp.json (command)',
          description: 'For clients that start the server themselves over stdio.',
          keywords: ['config', 'stdio', 'command'],
          render: () => <CodeBlock label="mcp.json (command)" value={stdioConfig} />
        },
        {
          kind: 'action',
          id: 'mcp-regenerate',
          label: 'Regenerate token',
          description: 'Agents using the old token must reconnect.',
          button: 'Regenerate…',
          destructive: true,
          confirm: {
            title: 'Regenerate the connection token?',
            description: 'Every agent that connects with the current token is cut off.',
            action: 'Regenerate'
          },
          onPress: () => run('agent.regenerateToken', undefined)
        }
      ]
    })
  }
  groups.push(
    {
      id: 'behaviour',
      heading: 'Behaviour',
      rows: [
        choice({
          id: 'agent-default-mode',
          label: 'Default mode for new agents',
          value: a.defaultMode,
          sheetDescription:
            'Foreground brings the agent’s tab in front of you before each action; background keeps you on your own tab.',
          options: [
            { value: 'foreground', label: 'Foreground (watch it work)' },
            { value: 'background', label: 'Background (out of your way)' }
          ],
          onChange: (v) => setAgents({ defaultMode: v })
        }),
        {
          kind: 'switch',
          id: 'agent-cursor',
          label: 'Show the agent’s cursor',
          description: 'Draw a labelled cursor in the pages an agent drives.',
          checked: a.showCursor,
          onChange: (v) => setAgents({ showCursor: v })
        },
        {
          kind: 'switch',
          id: 'agent-approve',
          label: 'Ask before a new agent connects',
          description:
            'When off, any agent that reaches the server may control the browser. The connection token always skips the prompt.',
          checked: a.approveNewAgents,
          onChange: (v) => setAgents({ approveNewAgents: v })
        },
        {
          kind: 'switch',
          id: 'agent-scripts',
          label: 'Allow agents to run JavaScript in pages',
          description:
            'Off by default. Lets an agent run arbitrary script in the pages it drives, including sites you are signed in to.',
          checked: a.allowScripts,
          onChange: (v) => setAgents({ allowScripts: v })
        }
      ]
    },
    {
      id: 'connected',
      heading: 'Connected agents',
      rows: state.agents.map((agent) =>
        item(
          `agent:${agent.id}`,
          agent.name,
          `${agent.pending ? 'Awaiting approval · ' : ''}${agent.transport === 'stdio' ? 'stdio' : 'HTTP'} · ${agent.tabIds.length} tab${agent.tabIds.length === 1 ? '' : 's'} · ${agent.calls} action${agent.calls === 1 ? '' : 's'} · active ${relativeTime(agent.lastActiveAt)}`,
          [
            choice({
              id: `agent:${agent.id}:mode`,
              label: 'Mode',
              value: agent.mode,
              options: [
                { value: 'foreground', label: 'Foreground' },
                { value: 'background', label: 'Background' }
              ],
              onChange: (mode) => run('agent.setMode', { id: agent.id, mode })
            }),
            {
              kind: 'action',
              id: `agent:${agent.id}:disconnect`,
              label: 'Disconnect',
              description: 'Releases the tabs it opened.',
              button: 'Disconnect…',
              destructive: true,
              confirm: { title: `Disconnect ${agent.name}?`, action: 'Disconnect' },
              onPress: () => run('agent.disconnect', { id: agent.id })
            }
          ],
          {
            leading: (
              <span
                className="zen-settings-agent-dot"
                style={{ background: agent.color }}
                aria-hidden="true"
              />
            )
          }
        )
      ),
      empty: a.enabled
        ? 'No agents connected – point an MCP client at the endpoint above'
        : 'Turn the server on to let agents connect'
    }
  )
  if (a.approvedNames.length > 0) {
    groups.push({
      id: 'remembered',
      heading: 'Remembered agents',
      rows: a.approvedNames.map((name) =>
        item(`approved:${name}`, name, 'Allowed to connect without asking', [
          {
            kind: 'action',
            id: `approved:${name}:forget`,
            label: 'Forget',
            description: 'It is asked about the next time it connects.',
            button: 'Forget',
            onPress: () => run('agent.forget', { name })
          }
        ])
      )
    })
  }
  return groups
}

// ---------------------------------------------------------------------------
// Passwords (the desktop panel's Settings › Passwords and the manager's own settings view, as
// phone rows: the ways into the manager, the two preferences, the vault's protection and lock,
// import and export. The manager is an overlay over the Settings tab as over any page; the rows
// about a vault operation land on the manager's view that does it, behind its re-authentication)
// ---------------------------------------------------------------------------

function passwordsSection({ state, tab, set }: SectionContext): RowGroup[] {
  const status = state.passwords
  const s = state.settings.passwords
  const patch = (p: Partial<typeof s>): void => set({ passwords: { ...s, ...p } })
  const open = (view: 'logins' | 'checkup' | 'settings'): void =>
    void openOverlay('passwords', tab.id, null, null, view)
  const unlocked = !status.locked && !status.error
  return [
    {
      id: 'passwords-manager',
      heading: 'Password manager',
      rows: [
        {
          kind: 'action',
          id: 'passwords-manage',
          label: PASSWORDS_COPY.manage,
          description: passwordsSavedLabel(status),
          keywords: ['saved passwords', 'logins', 'vault', 'generator'],
          leaves: 'chevron',
          onPress: () => open('logins')
        },
        {
          kind: 'action',
          id: 'passwords-checkup',
          label: PASSWORDS_COPY.checkup,
          description: checkupLabel(status.checkup),
          keywords: ['checkup', 'compromised', 'breach', 'reused', 'weak', 'leaked'],
          leaves: 'chevron',
          onPress: () => open('checkup')
        }
      ]
    },
    {
      id: 'passwords-saving',
      heading: 'Saving',
      rows: [
        {
          kind: 'switch',
          id: 'passwords-offer-to-save',
          label: PASSWORDS_COPY.offerToSave.label,
          description: PASSWORDS_COPY.offerToSave.description,
          checked: s.offerToSave,
          onChange: (v) => patch({ offerToSave: v })
        }
      ]
    },
    {
      id: 'passwords-security',
      heading: 'Security',
      rows: [
        choice({
          id: 'passwords-reauth-grace',
          label: PASSWORDS_COPY.grace.label,
          sheetDescription: PASSWORDS_COPY.grace.description,
          keywords: ['re-authentication', 'grace period', 'verify', 'reveal', 'copy'],
          value: String(s.reauthGraceSeconds),
          options: PASSWORD_GRACE_OPTIONS,
          onChange: (v) => patch({ reauthGraceSeconds: Number(v) })
        }),
        {
          kind: 'action',
          id: 'passwords-protection',
          label: PASSWORDS_COPY.protection.label,
          description: vaultProtectionLabel(status),
          keywords: ['passphrase', 'keychain', 'keystore', 'biometrics', 'fingerprint'],
          leaves: 'chevron',
          onPress: () => open('settings')
        },
        {
          kind: 'action',
          id: 'passwords-lock',
          label: PASSWORDS_COPY.lock.label,
          description: unlocked ? PASSWORDS_COPY.lock.description : PASSWORDS_COPY.lock.locked,
          keywords: ['lock now', 'forget'],
          // Nothing to lock: laid out at 40%, not pressable (§10.4), rather than a row that vanishes.
          button: 'Lock now',
          disabled: !unlocked,
          onPress: () => run('passwords.lock', undefined)
        }
      ]
    },
    {
      id: 'passwords-transfer',
      heading: 'Import and export',
      rows: [
        {
          kind: 'action',
          id: 'passwords-import',
          label: PASSWORDS_COPY.importCsv.label,
          description: PASSWORDS_COPY.importCsv.description,
          keywords: ['csv', 'chrome', 'firefox', 'bitwarden', 'lastpass', 'keepass'],
          leaves: 'chevron',
          onPress: () => open('settings')
        },
        {
          kind: 'action',
          id: 'passwords-export',
          label: PASSWORDS_COPY.exportCsv.label,
          description: PASSWORDS_COPY.exportCsv.description,
          keywords: ['csv', 'backup'],
          leaves: 'chevron',
          onPress: () => open('settings')
        }
      ]
    }
  ]
}

// Security (the answers Zenium remembered per site, and this session's sign-ins)
// ---------------------------------------------------------------------------

/**
 * Every per-site answer Zenium remembered – a site allowed to open pop-up windows on its own, a
 * scheme it may hand to another app, the camera, location, storage and file permissions – as an
 * item row, the site over what it may or may not do, whose sheet (a Forget button on the desktop)
 * takes the answer back; Forget all after them once there is more than one; then the sign-ins and
 * certificate choices kept for this session. Ungated: every host keeps these answers.
 */
function securitySection({ state }: SectionContext): RowGroup[] {
  const rules = [...state.permissionRules].sort(
    (a, b) => a.origin.localeCompare(b.origin) || a.permission.localeCompare(b.permission)
  )
  return [
    {
      id: 'security-permissions',
      heading: 'Site permissions',
      description:
        'Answers you gave sites asking to open pop-ups, to hand links to another app, or to use the camera, location and more.',
      rows: [
        ...rules.map(permissionRuleRow),
        ...(rules.length > 1
          ? [
              {
                kind: 'action',
                id: 'security-forget-all',
                label: 'Forget all site permissions',
                description: 'Every site asks again the next time it needs something.',
                button: 'Forget all…',
                destructive: true,
                confirm: {
                  title: 'Forget all site permissions?',
                  description: 'Every site asks again the next time it needs something.',
                  action: 'Forget all'
                },
                onPress: () => run('permissions.reset', undefined)
              } satisfies SettingsRow
            ]
          : [])
      ],
      empty: 'No site permissions remembered yet'
    },
    {
      id: 'security-session',
      heading: 'This session',
      rows: [
        {
          kind: 'action',
          id: 'security-forget-session',
          label: 'Forget sign-ins and certificates',
          description: 'Remembered until Zenium quits, in memory only',
          keywords: ['password', 'http authentication', 'client certificate', 'log in'],
          button: 'Forget',
          onPress: () => run('security.forgetSession', undefined)
        }
      ]
    }
  ]
}

/** One remembered answer: the site over what it may or may not do; its sheet forgets it. */
function permissionRuleRow(rule: PermissionRule): SettingsRow {
  const id = `security-rule:${rule.origin}:${rule.permission}`
  const kind = rule.permission.split(':')[0]
  const keywords =
    kind === 'popups'
      ? ['pop-ups', 'popups', 'blocked', 'exception']
      : kind === 'openExternal'
        ? ['external apps', 'other apps', 'protocol', 'scheme', 'link']
        : ['permission']
  return item(
    id,
    siteLabel(rule.origin),
    describePermissionRule(rule),
    [
      {
        kind: 'action',
        id: `${id}:forget`,
        label: 'Forget this answer',
        description: 'The site asks again the next time it needs it.',
        button: 'Forget',
        onPress: () =>
          run('permissions.forget', { origin: rule.origin, permission: rule.permission })
      }
    ],
    { keywords }
  )
}

// ---------------------------------------------------------------------------
// Sync (hosts with the `sync` capability)
// ---------------------------------------------------------------------------

const SYNC_SCOPE_LABELS: ReadonlyArray<{
  key: keyof SyncScope
  label: string
  hint?: string
}> = [
  { key: 'spaces', label: 'Spaces', hint: 'Names, icons, themes and order' },
  { key: 'folders', label: 'Folders' },
  { key: 'pinnedTabs', label: 'Pinned tabs' },
  { key: 'essentials', label: 'Essentials' },
  { key: 'openTabs', label: 'Open tabs', hint: 'Unpinned tabs arrive unloaded on other devices' },
  { key: 'containers', label: 'Containers' },
  { key: 'bookmarks', label: 'Bookmarks' },
  {
    key: 'passwords',
    label: 'Passwords',
    hint: 'Saved passwords and passkey records, encrypted with your sync passphrase'
  },
  { key: 'settings', label: 'Settings' },
  { key: 'shortcuts', label: 'Keyboard shortcuts' },
  { key: 'boosts', label: 'Boosts' }
]

/**
 * Zen 1.22's "Sync your Spaces across devices" through a folder a cloud drive or Syncthing
 * keeps in sync, encrypted on this device first. Not set up: the explanation and the one action
 * whose dialog is the setup form. Set up: the status with Sync now (or, while the folder cannot
 * be reached, the way to choose one again – ID-08's unmounted drive), a merge question while
 * the folder held data already, this device's name, the other devices, what to sync, and the
 * two ways off – confirmed, the second destructive.
 */
function syncSection({ state }: SectionContext): RowGroup[] {
  const sync = state.sync
  const intro: RowGroup = {
    id: 'sync',
    heading: 'Sync across devices',
    description:
      'Keep your Spaces, folders, pinned tabs, Essentials, bookmarks, passwords and settings the same on every device, including your phone. Pick a folder that is already synced between your devices (Dropbox, iCloud Drive, Google Drive, OneDrive, Nextcloud, Syncthing…) and a passphrase. Everything is encrypted on this device before it is written – the folder only ever holds ciphertext.',
    rows: []
  }
  if (!sync.enabled) {
    intro.rows.push({
      kind: 'action',
      id: 'sync-setup',
      label: 'Set up sync',
      description: 'Choose the folder and a passphrase; this device joins the folder.',
      keywords: ['folder', 'passphrase', 'connect', 'dropbox', 'syncthing'],
      button: 'Set up…',
      form: {
        title: 'Set up sync',
        description: 'Use the same folder and passphrase on every device.',
        render: (close) => (
          <SyncSetupForm deviceName={sync.deviceName} scope={sync.scope} close={close} />
        )
      }
    })
    return [intro]
  }
  intro.rows.push(
    {
      kind: 'info',
      id: 'sync-status',
      label: sync.syncing
        ? 'Syncing…'
        : sync.lastSyncAt
          ? `Last synced ${relativeTime(sync.lastSyncAt)}`
          : 'Waiting for the first sync',
      description: sync.lastError ?? sync.folderName ?? sync.folder ?? undefined,
      keywords: ['status', 'folder', 'error'],
      trailing: sync.lastError ? (
        <CircleAlert
          className="zen-settings-trailing-glyph zen-settings-danger"
          aria-label="Error"
        />
      ) : undefined
    },
    sync.folderLost
      ? {
          // The folder went away (an unmounted drive, a revoked tree): the status line says so and
          // this takes the user to a folder again; nothing syncs until then.
          kind: 'action',
          id: 'sync-choose-folder',
          label: 'Choose the sync folder again',
          description: 'The folder cannot be reached. Pick it, or another your devices share.',
          keywords: ['folder', 'lost', 'unmounted', 'choose'],
          button: 'Choose…',
          disabled: sync.syncing,
          onPress: () =>
            void cmd('sync.chooseFolder', undefined).then(
              (folder) => folder && run('sync.setFolder', { folder })
            )
        }
      : {
          kind: 'action',
          id: 'sync-now',
          label: 'Sync now',
          description: 'Write this device’s changes to the folder and read the other devices’.',
          button: 'Sync now',
          busy: sync.syncing,
          disabled: sync.pendingMerge,
          onPress: () => run('sync.now', undefined)
        }
  )
  const groups: RowGroup[] = [intro]
  if (sync.pendingMerge) {
    groups.push({
      id: 'sync-merge',
      heading: 'This folder already contains synced data',
      description:
        'Merge it with the Spaces on this device, or keep only this device’s data and replace what the other devices have.',
      rows: [
        {
          kind: 'action',
          id: 'sync-merge',
          label: 'Merge with this device',
          description: 'The folder’s Spaces and this device’s are combined.',
          button: 'Merge',
          onPress: () => run('sync.confirmMerge', { merge: true })
        },
        {
          kind: 'action',
          id: 'sync-keep-mine',
          label: 'Keep only this device’s data',
          description: 'What the other devices have is replaced.',
          button: 'Keep mine…',
          destructive: true,
          confirm: {
            title: 'Replace the other devices’ data?',
            description:
              'The folder’s synced data is replaced with this device’s; the other devices take it on their next sync.',
            action: 'Replace'
          },
          onPress: () => run('sync.confirmMerge', { merge: false })
        }
      ]
    })
  }
  groups.push(
    {
      id: 'sync-device',
      heading: 'This device',
      rows: [
        {
          kind: 'field',
          id: 'sync-device-name',
          label: 'Name',
          description: 'How the other devices list this one.',
          value: sync.deviceName,
          input: 'text',
          onCommit: (value) => {
            const name = value.trim()
            if (!name) return 'Enter a name'
            if (name !== sync.deviceName) run('sync.setDeviceName', { name })
            return undefined
          }
        }
      ]
    },
    {
      id: 'sync-devices',
      heading: 'Devices',
      rows: sync.devices.map((d) => ({
        kind: 'info',
        id: `device:${d.id}`,
        label: d.name,
        description: `Last seen ${relativeTime(d.lastSeen)}`
      })),
      empty:
        'No other device has synced to this folder yet – set up sync there with the same folder and passphrase'
    },
    {
      id: 'sync-scope',
      heading: 'What to sync',
      rows: SYNC_SCOPE_LABELS.map((entry) => ({
        kind: 'switch',
        id: `scope:${entry.key}`,
        label: entry.label,
        description: entry.hint,
        checked: sync.scope[entry.key],
        onChange: (v: boolean) => run('sync.setScope', { [entry.key]: v })
      }))
    },
    {
      id: 'sync-off',
      heading: null,
      rows: [
        {
          kind: 'action',
          id: 'sync-disconnect',
          label: 'Turn off sync',
          description: 'This device keeps its data and stops reading and writing the folder.',
          button: 'Turn off…',
          confirm: {
            title: 'Turn off sync?',
            description:
              'This device keeps everything it has; the folder is left as it is for the other devices.',
            action: 'Turn off'
          },
          onPress: () => run('sync.disconnect', { wipeRemote: false })
        },
        {
          kind: 'action',
          id: 'sync-wipe',
          label: 'Turn off and remove this device’s data',
          description: 'Its records leave the folder; the other devices forget it.',
          button: 'Remove…',
          destructive: true,
          confirm: {
            title: 'Remove this device from sync?',
            description:
              'Sync turns off and this device’s records are deleted from the folder. Its Spaces stay on this device.',
            action: 'Remove'
          },
          onPress: () => run('sync.disconnect', { wipeRemote: true })
        }
      ]
    }
  )
  return groups
}

// ---------------------------------------------------------------------------
// Keyboard Shortcuts (the desktop and tablet shells)
// ---------------------------------------------------------------------------

const SHORTCUT_GROUP_ORDER: readonly ShortcutGroup[] = [
  'zen-compact-mode',
  'zen-workspace',
  'zen-split-view',
  'zen-other',
  'windowAndTabManagement',
  'navigation',
  'searchAndFind',
  'pageOperations',
  'historyAndBookmarks',
  'mediaAndDisplay',
  'devTools'
]

/**
 * Zen's keyboard shortcut manager: the preset and the count of rows changed from it, then every
 * shortcut in Zen's groups, each a row of its own (`ShortcutRow.tsx`) whose button records a
 * new chord. "Find in Settings" filters them – by label or by chord – so the manager's own
 * filter field is gone.
 */
function shortcutsSection({ state }: SectionContext): RowGroup[] {
  const preset = state.settings.shortcutPreset
  const defaults = new Map(
    defaultShortcuts(state.platform, preset).map((s) => [s.id, s.binding] as const)
  )
  const changed = state.shortcuts.filter((s) => {
    const base = defaults.get(s.id)
    return base !== undefined && !bindingsEqual(base, s.binding)
  }).length
  const groups: RowGroup[] = [
    {
      id: 'preset',
      heading: 'Preset',
      description: 'Click a shortcut, then press the new keys. Backspace clears it, Esc cancels.',
      rows: [
        choice<ShortcutPreset>({
          id: 'shortcut-preset',
          label: 'Shortcut set',
          value: preset,
          sheetDescription: SHORTCUT_PRESET_DESCRIPTIONS[preset],
          options: SHORTCUT_PRESETS.map((p) => ({ value: p, label: SHORTCUT_PRESET_LABELS[p] })),
          onChange: (next) => run('settings.update', { shortcutPreset: next })
        }),
        {
          kind: 'action',
          id: 'shortcuts-reset',
          label: 'Your changes',
          description:
            changed === 0
              ? 'Every shortcut is the preset’s.'
              : `${changed} ${changed === 1 ? 'shortcut differs' : 'shortcuts differ'} from the preset.`,
          keywords: ['reset', 'defaults'],
          button: 'Reset to preset',
          disabled: changed === 0,
          onPress: () => run('shortcuts.reset', undefined)
        }
      ]
    }
  ]
  for (const group of SHORTCUT_GROUP_ORDER) {
    const items = state.shortcuts.filter((s) => s.group === group && !s.hidden)
    if (items.length === 0) continue
    groups.push({
      id: `shortcuts-${group}`,
      heading: SHORTCUT_GROUP_LABELS[group],
      rows: items.map((s) => ({
        kind: 'custom',
        id: `shortcut:${s.id}`,
        label: s.label,
        keywords: [
          formatBinding(s.binding, state.platform),
          ...(s.unsupported ? ['unsupported'] : [])
        ],
        bare: true,
        render: () => (
          <ShortcutRow shortcut={s} shortcuts={state.shortcuts} platform={state.platform} />
        )
      }))
    })
  }
  return groups
}

// ---------------------------------------------------------------------------
// Default Browser (the desktop OSes; Android keeps its one row under About)
// ---------------------------------------------------------------------------

/**
 * Which browser the OS hands web links to, and the request to make it Zenium: a status row
 * while the OS is asked, the ✓ once Zenium holds the role, the Make default button otherwise –
 * on Windows with the note that it opens Windows Settings, where the user presses Set default.
 * `state.defaultBrowser` is what the core's DefaultBrowserService refreshes at start, on window
 * focus and when the OS answers.
 */
function defaultBrowserSection({ state }: SectionContext): RowGroup[] {
  const isDefault = state.defaultBrowser.isDefault
  const row: SettingsRow =
    isDefault === true
      ? {
          kind: 'info',
          id: 'default-browser',
          label: 'Zenium is your default browser',
          description: 'Links from other apps open here.',
          keywords: ['default browser', 'links'],
          trailing: (
            <Check
              className="zen-settings-trailing-glyph zen-settings-ok"
              aria-label="Zenium is the default browser"
            />
          )
        }
      : isDefault === false
        ? {
            kind: 'action',
            id: 'default-browser',
            label: 'Zenium is not your default browser',
            description:
              state.platform === 'win32'
                ? 'Make default opens Windows Settings, where you press Set default.'
                : 'Open links from other apps in Zenium.',
            keywords: ['default browser', 'links', 'make default'],
            button: 'Make default',
            onPress: () => void requestDefaultBrowser('settings')
          }
        : {
            kind: 'info',
            id: 'default-browser',
            label: 'Checking which browser opens your links',
            keywords: ['default browser', 'links']
          }
  return [{ id: 'default-browser', heading: 'Default browser', rows: [row] }]
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

function updatesSection({ state, set }: SectionContext): RowGroup[] {
  const u = state.updates
  const prefs = state.settings.updates
  const inPlace = u.mode === 'in-place'
  const canDownload = u.mode !== 'manual' && Boolean(u.release?.asset) && !u.signerMismatch
  const busy = u.phase === 'checking' || u.phase === 'downloading'
  const release = u.release
  const primary: SettingsRow =
    u.phase === 'downloading'
      ? {
          kind: 'action',
          id: 'update-cancel',
          label: 'Cancel download',
          button: 'Cancel',
          onPress: () => run('updates.cancel', undefined)
        }
      : u.phase === 'ready'
        ? {
            kind: 'action',
            id: 'update-install',
            label: inPlace ? 'Restart to update' : 'Install the update',
            button: inPlace ? 'Restart' : 'Install',
            onPress: () => run('updates.install', undefined)
          }
        : u.phase === 'available' && canDownload
          ? {
              kind: 'action',
              id: 'update-download',
              label: `Download ${release?.version ?? ''}`.trim(),
              description: release?.asset
                ? `${release.asset.name} (${formatBytes(release.asset.size)})`
                : undefined,
              button: 'Download',
              onPress: () => run('updates.download', undefined)
            }
          : {
              kind: 'action',
              id: 'update-check',
              label: 'Check for updates',
              button: 'Check now',
              busy,
              onPress: () => run('updates.check', undefined)
            }
  const statusRows: SettingsRow[] = [
    {
      kind: 'custom',
      id: 'update-status',
      label: headline(u),
      description: detail(u),
      keywords: ['version', u.currentVersion],
      render: () => (
        <UpdateStatusBlock
          headline={headline(u)}
          detail={detail(u)}
          progress={u.phase === 'downloading' && u.progress ? u.progress.percent : null}
        />
      )
    },
    primary
  ]
  if (release) {
    statusRows.push({
      kind: 'action',
      id: 'release-notes',
      label: 'Release notes',
      description: `${release.tag}${release.prerelease ? ' · pre-release' : ''}`,
      leaves: 'external',
      onPress: () => run('updates.openRelease', undefined)
    })
  }
  const groups: RowGroup[] = [
    { id: 'status', heading: null, rows: statusRows },
    {
      id: 'automatic',
      heading: 'Automatic updates',
      rows: [
        {
          kind: 'switch',
          id: 'auto-check',
          label: 'Check for updates automatically',
          description:
            'On startup and every six hours. Nothing is installed without you seeing it here first.',
          checked: prefs.autoCheck,
          onChange: (v) => set({ updates: { ...prefs, autoCheck: v } })
        },
        ...(inPlace
          ? [
              {
                kind: 'switch',
                id: 'auto-download',
                label: 'Download updates in the background',
                description:
                  'Fetch a new version as soon as it is found; it installs when you restart Zenium.',
                checked: prefs.autoDownload,
                disabled: !prefs.autoCheck,
                onChange: (v: boolean) => set({ updates: { ...prefs, autoDownload: v } })
              } satisfies SettingsRow
            ]
          : []),
        choice<UpdateChannel>({
          id: 'release-channel',
          label: 'Release channel',
          value: prefs.channel,
          sheetDescription:
            u.channel === 'beta' && prefs.channel !== 'beta'
              ? 'Pre-release builds follow the beta channel until a final release replaces them.'
              : 'Beta receives pre-releases (x.y.z-beta.n) as well as final releases.',
          options: [
            { value: 'stable', label: 'Stable' },
            { value: 'beta', label: 'Beta (pre-releases)' }
          ],
          onChange: (v) => set({ updates: { ...prefs, channel: v } })
        })
      ]
    },
    {
      id: 'applied',
      heading: 'How updates are applied',
      rows: [
        {
          kind: 'info',
          id: 'install-kind',
          label: installLabel(u),
          description: `${describeUpdateTarget(u.target)} ${u.target.os}${u.target.arch !== 'universal' ? ` · ${u.target.arch}` : ''}`
        },
        {
          kind: 'info',
          id: 'verification',
          label: 'Verification',
          description:
            u.signature === 'verified'
              ? 'Release manifests are signed; this build checks the signature before trusting a release, then verifies every download against its SHA-256.'
              : 'Every download is verified against the SHA-256 the release publishes.',
          trailing:
            u.signature === 'verified' ? (
              <Check
                className="zen-settings-trailing-glyph zen-settings-ok"
                aria-label="Verified"
              />
            ) : undefined
        }
      ]
    }
  ]
  return groups
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

function aboutSection({ state, navigate }: SectionContext): RowGroup[] {
  const engineHost = state.platform === 'android' ? 'Android System WebView' : 'Electron'
  const update = state.updates
  const newer = update.phase === 'available' || update.phase === 'ready' ? update.release : null
  const rows: SettingsRow[] = [
    {
      kind: 'info',
      id: 'version',
      label: 'Zenium',
      description: `Version ${state.version} · running on Chromium via ${engineHost}${newer ? ` · ${newer.version} is available` : ''}`,
      keywords: ['version', state.version]
    }
  ]
  if (state.capabilities.updates) {
    rows.push({
      kind: 'action',
      id: 'check-updates',
      label: newer ? `Update to ${newer.version}` : 'Check for updates',
      leaves: 'chevron',
      onPress: () => {
        navigate('updates')
        if (!newer) run('updates.check', undefined)
      }
    })
  }
  // The browser role has a category of its own on the desktop OSes (Default Browser, the
  // desktop's content); Android keeps the one row here.
  if (state.capabilities.defaultBrowser && state.platform === 'android') {
    rows.push(
      state.defaultBrowser.isDefault
        ? {
            kind: 'info',
            id: 'default-browser',
            label: 'Default browser',
            description: 'Zenium is your default browser.',
            trailing: (
              <Check
                className="zen-settings-trailing-glyph zen-settings-ok"
                aria-label="Zenium is the default browser"
              />
            )
          }
        : {
            kind: 'action',
            id: 'default-browser',
            label: 'Set as default browser',
            description: 'Open links from other apps in Zenium.',
            onPress: () => run('defaultBrowser.request', { source: 'settings' })
          }
    )
  }
  rows.push(
    {
      kind: 'info',
      id: 'engine',
      label: 'Engine',
      description:
        'Blink and V8 – the same engine as Chrome. The chrome reimplements Zen Browser 1.22: Spaces, Essentials, Glance, Split View, compact mode, window sync, Boosts, Live Folders, Reader View, Mods and cross-device sync.'
    },
    {
      kind: 'action',
      id: 'upstream',
      label: 'Upstream project',
      description: 'zen-browser.app – this port is not affiliated with the Zen team.',
      leaves: 'external',
      onPress: () => run('app.openExternal', { url: 'https://zen-browser.app' })
    }
  )
  return [{ id: 'about', heading: 'About', rows }]
}
