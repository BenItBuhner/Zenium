import type { ReactNode } from 'react'
import { Check, Puzzle } from 'lucide-react'
import type { InternalPageSection } from '@shared/internalPages'
import type {
  ColorScheme,
  ContainerColor,
  ContainerIcon as ContainerIconName,
  CrashRestoreMode,
  DesktopSiteDefault,
  DownloadSettings,
  GlanceTrigger,
  NewTabBackgroundKind,
  NewTabPosition,
  NewTabPreset,
  NewTabSettings,
  NewTabShortcutsMode,
  PhoneBarPosition,
  PinnedCloseBehavior,
  Settings,
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
import { formatZoom } from '@shared/pageControls'
import { describeUpdateTarget, type UpdateChannel } from '@shared/updates'
import { inputToUrl } from '@shared/url'
import { run } from '@renderer/lib/api'
import { downloadFolderLabel } from '@renderer/lib/downloadText'
import { downloadsEngine } from '@renderer/lib/downloadsEngine'
import {
  NEW_TAB_LAYOUT_HINT,
  NEW_TAB_PRESET_DESCRIPTIONS,
  NEW_TAB_PRESET_LABELS,
  newTabBackgroundValue
} from '@renderer/lib/newTabSettings'
import { describePermissionRule } from '@renderer/lib/security'
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
  ShortcutForm,
  UpdateStatusBlock,
  UrlForm,
  ZoomBlock
} from './blocks'
import { choice, type RowGroup, type SectionModel, type SettingsRow } from './model'

/**
 * The phone Settings sections as data: one builder per category turns the browser state into
 * the groups and rows of `model.ts`. Every row of the desktop panel (`SettingsPanel.tsx`,
 * `PageControlsSettings.tsx`, `AgentsSection.tsx`, `UpdatesSection.tsx`, `AddonsPanel.tsx`) is
 * here in its v2 phone form – a menulist is a value row, a checkbox a switch row, a button an
 * action row, an input a field row, a list a group of item rows – reading the same settings and
 * running the same commands, so nothing is reachable on one platform only.
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
  return { section, groups: builder ? builder(ctx) : [] }
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
  accessibility: accessibilitySection,
  newtab: newTabSection,
  tabs: tabsSection,
  downloads: downloadsSection,
  privacy: privacySection,
  search: searchSection,
  spaces: spaceRoutingSection,
  containers: containersSection,
  boosts: boostsSection,
  mods: modsSection,
  extensions: extensionsSection,
  agents: agentsSection,
  passwords: passwordsSection,
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
        {
          kind: 'action',
          id: 'newtab-remove-image',
          label: 'Remove background image',
          disabled: !image,
          onPress: () => run('newtab.clearBackgroundImage', undefined)
        },
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
            disabled: i === 0,
            onPress: () => move(-1)
          },
          {
            kind: 'action',
            id: `shortcut:${shortcut.id}:down`,
            label: 'Move down',
            disabled: i === shortcuts.length - 1,
            onPress: () => move(1)
          },
          {
            kind: 'action',
            id: `shortcut:${shortcut.id}:remove`,
            label: 'Remove shortcut',
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
  if (d.autoOpenTypes.length > 0) {
    saving.push({
      kind: 'action',
      id: 'download-auto-open',
      label: 'Open certain file types automatically',
      description: types,
      keywords: ['auto open', 'always open'],
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
// Privacy and Security (ad and tracker blocking, site permissions)
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
          disabled: status.updating,
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
    },
    {
      id: 'permissions',
      heading: 'Site permissions',
      description: 'Answers you gave sites asking for the camera, location and more.',
      rows: [
        ...state.permissionRules.map((rule) =>
          item(
            `permission:${rule.origin}:${rule.permission}`,
            rule.origin.replace(/^https?:\/\//, ''),
            `${rule.decision === 'allow' ? 'May' : 'May not'} ${describePermissionRule(rule).replace(/^may (not )?/, '')}`,
            [
              {
                kind: 'action',
                id: `permission:${rule.origin}:${rule.permission}:forget`,
                label: 'Forget this answer',
                description: 'The site asks again the next time it needs it.',
                onPress: () =>
                  run('permissions.forget', { origin: rule.origin, permission: rule.permission })
              }
            ]
          )
        ),
        ...(state.permissionRules.length > 0
          ? [
              {
                kind: 'action',
                id: 'permissions-reset',
                label: 'Forget all site permissions',
                destructive: true,
                confirm: {
                  title: 'Forget all site permissions?',
                  description: 'Every site asks again the next time it needs a permission.',
                  action: 'Forget all'
                },
                onPress: () => run('permissions.reset', undefined)
              } satisfies SettingsRow
            ]
          : [])
      ],
      empty: 'No site has asked for a permission yet'
    }
  ]
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function searchSection({ state, set }: SectionContext): RowGroup[] {
  const s = state.settings
  return [
    {
      id: 'search',
      heading: 'Search',
      rows: [
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
        },
        {
          kind: 'info',
          id: 'search-keywords',
          label: 'Engine keywords',
          description: `Type a keyword, then a space: ${state.searchEngines.map((e) => e.keyword).join(' · ')}`
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
                disabled: i <= 1,
                onPress: () => run('container.reorder', { id: c.id, index: i - 1 })
              },
              {
                kind: 'action',
                id: `container:${c.id}:down`,
                label: 'Move down',
                disabled: i >= containers.length - 1,
                onPress: () => run('container.reorder', { id: c.id, index: i + 1 })
              },
              {
                kind: 'action',
                id: `container:${c.id}:delete`,
                label: 'Delete container',
                description: 'Its cookies and site data are cleared.',
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
          onPress: () => run('mod.add', { name: 'New Mod', css: '/* your CSS */\n' })
        },
        {
          kind: 'action',
          id: 'import-mod-url',
          label: 'Import from URL',
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
          onPress: () => run('extension.installFromFile', undefined)
        },
        {
          kind: 'action',
          id: 'load-unpacked',
          label: 'Load unpacked',
          description: 'A folder with a manifest.json.',
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
          label: 'mcp.json',
          render: () => <CodeBlock label="mcp.json" value={httpConfig} />
        },
        {
          kind: 'action',
          id: 'mcp-regenerate',
          label: 'Regenerate token',
          description: 'Agents using the old token must reconnect.',
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
          onPress: () => run('updates.cancel', undefined)
        }
      : u.phase === 'ready'
        ? {
            kind: 'action',
            id: 'update-install',
            label: inPlace ? 'Restart to update' : 'Install',
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
              onPress: () => run('updates.download', undefined)
            }
          : {
              kind: 'action',
              id: 'update-check',
              label: 'Check now',
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
  if (state.capabilities.defaultBrowser) {
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
