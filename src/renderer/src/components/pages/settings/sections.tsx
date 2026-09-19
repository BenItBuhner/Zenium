import type { ReactNode } from 'react'
import { Check, CircleAlert, Puzzle } from 'lucide-react'
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
  NewTabBackgroundKind,
  NewTabPosition,
  NewTabPreset,
  NewTabSettings,
  NewTabShortcutsMode,
  PermissionRule,
  PhoneBarPosition,
  PinnedCloseBehavior,
  ResourceEnforcement,
  ResourceProcessProfile,
  ResourceSettings,
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
import { TRACKING_LEVEL_LABELS, type TrackingLevel } from '@shared/blocking'
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
import { run } from '@renderer/lib/api'
import { requestDefaultBrowser } from '@renderer/lib/defaultBrowser'
import { downloadFolderLabel } from '@renderer/lib/downloadText'
import { downloadsEngine } from '@renderer/lib/downloadsEngine'
import {
  NEW_TAB_LAYOUT_HINT,
  NEW_TAB_PRESET_DESCRIPTIONS,
  NEW_TAB_PRESET_LABELS,
  newTabBackgroundValue
} from '@renderer/lib/newTabSettings'
import { describePermissionRule, siteLabel } from '@renderer/lib/security'
import { tabTitle } from '@renderer/lib/selectors'
import { openOverlay } from '@renderer/lib/ui'
import { formatBytes, relativeTime } from '@renderer/lib/utils'
import { ContainerIcon } from '../../ContainerIcon'
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
import {
  AddRouteForm,
  AppIconGrid,
  CodeBlock,
  CopyRow,
  CssEditor,
  NewContainerForm,
  ResourceMeter,
  ShortcutForm,
  SyncSetupForm,
  UpdateStatusBlock,
  UrlForm,
  ZoomBlock
} from './blocks'
import {
  choice,
  onLayout,
  type FieldRow,
  type RowGroup,
  type SectionModel,
  type SettingsRow
} from './model'
import { ShortcutRow } from './ShortcutRow'

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
  spaces: spaceRoutingSection,
  containers: containersSection,
  boosts: boostsSection,
  mods: modsSection,
  extensions: extensionsSection,
  agents: agentsSection,
  passwords: passwordsSection,
  security: securitySection,
  sync: syncSection,
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
  extra: { leading?: ReactNode; keywords?: readonly string[]; sheetDescription?: string } = {}
): SettingsRow {
  return {
    kind: 'item',
    id,
    label,
    description,
    keywords: extra.keywords,
    leading: extra.leading,
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
  if (caps.pageControls) {
    groups.push({
      id: 'sites',
      heading: 'Sites',
      rows: [
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
        }),
        {
          kind: 'switch',
          id: 'darken-sites',
          label: 'Apply dark theme to sites',
          description: 'Sites without a dark theme get one while Zenium is dark.',
          checked: pc.darkenSites,
          onChange: (v) => patchControls({ darkenSites: v })
        }
      ]
    })
    const exceptions: SettingsRow[] = [
      ...sorted(pc.desktopSites).map(([domain, on]) =>
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
      ...sorted(pc.darkenSiteExceptions).map(([domain, on]) =>
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
    groups.push({
      id: 'site-exceptions',
      heading: 'Site exceptions',
      description:
        'Desktop Site and Dark Theme for This Site in the menu remember a site’s choice here.',
      rows: exceptions,
      empty: 'No exceptions yet'
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

function accessibilitySection({ state, set }: SectionContext): RowGroup[] {
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
    {
      id: 'unloading',
      heading: 'Tab unloading',
      rows: [
        {
          kind: 'switch',
          id: 'unload-enabled',
          label: 'Unload inactive tabs',
          description: 'Frees memory by unloading tabs you have not used for a while.',
          checked: s.unloadEnabled,
          onChange: (v) => set({ unloadEnabled: v })
        },
        {
          kind: 'field',
          id: 'unload-after',
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
          id: 'unload-excluded',
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
    }
  )
  return groups
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
// Privacy and Security (ad and tracker blocking; the remembered per-site answers are Security's)
// ---------------------------------------------------------------------------

function privacySection({ state, set }: SectionContext): RowGroup[] {
  const b = state.settings.blocking
  const status = state.blocking
  const enabledLists = status.lists.filter((l) => l.enabled)
  const listsDescription = status.updating
    ? 'Updating…'
    : status.lastUpdatedAt
      ? `${enabledLists.length} lists · updated ${relativeTime(status.lastUpdatedAt)}`
      : `${enabledLists.length} lists`
  return [
    {
      id: 'tracking',
      heading: 'Tracking protection',
      rows: [
        {
          kind: 'switch',
          id: 'blocking-enabled',
          label: 'Block ads and trackers',
          description: status.ready
            ? `${status.sessionBlocked.toLocaleString()} blocked since Zenium started.`
            : 'Filter lists are loading.',
          keywords: ['adblock', 'tracking'],
          checked: status.enabled,
          onChange: (v) => run('blocking.setEnabled', { enabled: v })
        },
        choice<TrackingLevel>({
          id: 'blocking-level',
          label: 'Protection level',
          value: b.level,
          disabled: !status.enabled,
          options: (Object.keys(TRACKING_LEVEL_LABELS) as TrackingLevel[]).map((level) => ({
            value: level,
            label: TRACKING_LEVEL_LABELS[level].label,
            description: TRACKING_LEVEL_LABELS[level].description
          })),
          onChange: (level) => set({ blocking: { ...b, level } })
        }),
        {
          kind: 'switch',
          id: 'blocking-auto-update',
          label: 'Update filter lists automatically',
          checked: b.autoUpdate,
          onChange: (v) => set({ blocking: { ...b, autoUpdate: v } })
        },
        {
          kind: 'action',
          id: 'blocking-update-now',
          label: 'Update filter lists now',
          description: listsDescription,
          button: 'Update now',
          busy: status.updating,
          onPress: () => run('blocking.updateLists', {})
        }
      ]
    },
    {
      id: 'blocking-exceptions',
      heading: 'Sites without blocking',
      description: 'Turning protection off for a site in the site information remembers it here.',
      rows: status.siteExceptions.map((site) =>
        item(`blocking:${site}`, site, 'Nothing is blocked on this site', [
          {
            kind: 'action',
            id: `blocking:${site}:block`,
            label: 'Block on this site again',
            onPress: () => run('blocking.setSiteException', { site, excepted: false })
          }
        ])
      ),
      empty: 'No exceptions yet'
    }
  ]
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function searchSection({ state, set }: SectionContext): RowGroup[] {
  const s = state.settings
  const rows: SettingsRow[] = [
    choice({
      id: 'search-engine',
      label: 'Default search engine',
      value: s.searchEngineId,
      options: state.searchEngines.map((e) => ({ value: e.id, label: e.name })),
      onChange: (v) => set({ searchEngineId: v })
    }),
    {
      kind: 'switch',
      id: 'search-suggestions',
      label: 'Show search suggestions',
      description: 'Sends what you type to the search engine as you type.',
      checked: s.searchSuggestions,
      onChange: (v) => set({ searchSuggestions: v })
    }
  ]
  // The desktop URL bar shows the whole URL at rest (§10.1); the phone pill shows hosts only,
  // so the row is the desktop and tablet shells'.
  rows.push({
    kind: 'switch',
    id: 'full-urls',
    label: 'Always show full URLs',
    description: 'Keep the scheme and www. in the address bar instead of hiding them.',
    keywords: ['scheme', 'https', 'www', 'address bar'],
    layouts: ['desktop', 'tablet'],
    checked: Boolean(s.showFullUrls),
    onChange: (v) => set({ showFullUrls: v })
  })
  rows.push({
    kind: 'info',
    id: 'search-keywords',
    label: 'Engine keywords',
    description: `Type a keyword, then a space: ${state.searchEngines.map((e) => e.keyword).join(' · ')}`
  })
  return [{ id: 'search', heading: 'Search', rows }]
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
              confirm: { title: `Remove ${mod.name}?`, action: 'Remove' },
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

function extensionsSection({ state }: SectionContext): RowGroup[] {
  return [
    {
      id: 'extensions',
      heading: 'Extensions',
      description:
        'Chrome extensions from the Chrome Web Store or a folder with a manifest.json. Extensions run in every container.',
      rows: state.extensions.map((ext) =>
        item(
          `extension:${ext.id}`,
          ext.version ? `${ext.name} ${ext.version}` : ext.name,
          ext.error ?? (ext.description || ext.path),
          [
            {
              kind: 'switch',
              id: `extension:${ext.id}:enabled`,
              label: 'Enabled',
              checked: ext.enabled,
              onChange: (v) => run('extension.setEnabled', { id: ext.id, enabled: v })
            },
            {
              kind: 'action',
              id: `extension:${ext.id}:remove`,
              label: 'Remove extension',
              button: 'Remove…',
              destructive: true,
              confirm: { title: `Remove ${ext.name}?`, action: 'Remove' },
              onPress: () => run('extension.remove', { id: ext.id })
            }
          ],
          {
            leading: ext.icon ? (
              <img src={ext.icon} alt="" className="zen-settings-ext-icon" draggable={false} />
            ) : (
              <Puzzle className="zen-settings-glyph" aria-hidden="true" />
            ),
            keywords: ['add-on']
          }
        )
      ),
      empty: 'No extensions yet'
    },
    {
      id: 'install-extension',
      heading: 'Install an extension',
      rows: [
        {
          kind: 'action',
          id: 'install-from-store',
          label: 'From the Chrome Web Store',
          description: 'Paste an extension id, or a Chrome Web Store or Edge Add-ons link.',
          button: 'Install…',
          form: {
            title: 'Install from the Chrome Web Store',
            render: (close) => (
              <UrlForm
                id="store-ref"
                label="Extension id or store link"
                placeholder="https://chromewebstore.google.com/detail/…"
                action="Install"
                onSubmit={(ref) => run('extension.installFromStore', { ref })}
                close={close}
              />
            )
          }
        },
        {
          kind: 'action',
          id: 'install-from-file',
          label: 'From a file',
          description: 'A packed .crx or .zip.',
          button: 'Install…',
          onPress: () => run('extension.installFromFile', undefined)
        },
        {
          kind: 'action',
          id: 'load-unpacked',
          label: 'Load unpacked',
          description: 'A folder with a manifest.json.',
          button: 'Load…',
          onPress: () => run('extension.add', undefined)
        }
      ]
    }
  ]
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
  { key: 'settings', label: 'Settings' },
  { key: 'shortcuts', label: 'Keyboard shortcuts' },
  { key: 'boosts', label: 'Boosts' }
]

/**
 * Zen 1.22's "Sync your Spaces across devices" through a folder a cloud drive or Syncthing
 * keeps in sync, encrypted on this device first. Not set up: the explanation and the one action
 * whose dialog is the setup form. Set up: the status with Sync now, a merge question while the
 * folder held data already, this device's name, the other devices, what to sync, and the two
 * ways off – confirmed, the second destructive.
 */
function syncSection({ state }: SectionContext): RowGroup[] {
  const sync = state.sync
  const intro: RowGroup = {
    id: 'sync',
    heading: 'Sync across devices',
    description:
      'Keep your Spaces, folders, pinned tabs, Essentials and settings the same on every computer. Pick a folder that is already synced between your devices (Dropbox, iCloud Drive, Google Drive, OneDrive, Nextcloud, Syncthing…) and a passphrase. Everything is encrypted on this device before it is written – the folder only ever holds ciphertext.',
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
      description: sync.lastError ?? sync.folder ?? undefined,
      keywords: ['status', 'folder', 'error'],
      trailing: sync.lastError ? (
        <CircleAlert
          className="zen-settings-trailing-glyph zen-settings-danger"
          aria-label="Error"
        />
      ) : undefined
    },
    {
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
