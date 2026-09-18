import type { JSX } from 'react'
import { useState } from 'react'
import { ArrowDown, ArrowUp, Check, FolderOpen, Sparkles, Trash2 } from 'lucide-react'
import type {
  BookmarksBarMode,
  ColorScheme,
  ContainerColor,
  ContainerIcon as ContainerIconName,
  CrashRestoreMode,
  DownloadSettings,
  GlanceTrigger,
  HostCapabilities,
  NewTabPosition,
  PhoneBarPosition,
  PinnedCloseBehavior,
  Platform,
  Settings,
  SidebarSide,
  ThirdPartyPinnedBehavior,
  ToolbarLayout,
  UIState,
  UrlbarBehavior,
  WindowSyncMode
} from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'
import { CONTAINER_COLORS, CONTAINER_ICONS, spaceLabel } from '@shared/defaults'
import { resolveDownloadSettings } from '@shared/downloads'
import { useFadeEdges } from '@renderer/hooks/useFadeEdges'
import { run } from '@renderer/lib/api'
import { downloadsEngine } from '@renderer/lib/downloadsEngine'
import { activeTab } from '@renderer/lib/selectors'
import { useChord } from '@renderer/lib/shortcuts'
import { openOverlay, uiStore } from '@renderer/lib/ui'
import { cn, relativeTime } from '@renderer/lib/utils'
import { ContainerIcon } from '../ContainerIcon'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'
import { AgentsSection } from './AgentsSection'
import { AppIconGroup } from './AppIconPicker'
import { AutofillSection } from './AutofillSection'
import { ExtensionsSection, ModsSection } from './AddonsPanel'
import { DefaultBrowserSection } from './DefaultBrowserSection'
import { NewTabSection } from './NewTabSection'
import { OverlayShell } from './OverlayShell'
import {
  AccessibilitySection,
  PageZoomRow,
  SiteZoomsGroup,
  SitesGroups
} from './PageControlsSettings'
import { PasswordsSection } from './PasswordsSection'
import { ResourcesSection } from './ResourcesSection'
import { Choice, Group, MENULIST_HEIGHT, Row, SWITCH_HEIGHT, Segmented } from './SettingsPrimitives'
import { ShortcutsSection } from './ShortcutsSection'
import { SyncSection } from './SyncSection'
import { UpdatesSection } from './UpdatesSection'

export type SettingsSection =
  | 'look'
  | 'accessibility'
  | 'compact'
  | 'newtab'
  | 'tabs'
  | 'downloads'
  | 'resources'
  | 'search'
  | 'autofill'
  | 'spaces'
  | 'containers'
  | 'boosts'
  | 'mods'
  | 'extensions'
  | 'agents'
  | 'passwords'
  | 'sync'
  | 'shortcuts'
  | 'default-browser'
  | 'updates'
  | 'about'

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: 'look', label: 'Look and Feel' },
  { id: 'accessibility', label: 'Accessibility' },
  { id: 'compact', label: 'Compact Mode' },
  { id: 'newtab', label: 'New Tab' },
  { id: 'tabs', label: 'Tab Management' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'resources', label: 'Resources' },
  { id: 'search', label: 'Search' },
  { id: 'autofill', label: 'Autofill' },
  { id: 'spaces', label: 'Space Routing' },
  { id: 'containers', label: 'Containers' },
  { id: 'boosts', label: 'Boosts' },
  { id: 'mods', label: 'Mods' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'agents', label: 'AI Agents' },
  { id: 'passwords', label: 'Passwords' },
  { id: 'sync', label: 'Sync' },
  { id: 'shortcuts', label: 'Keyboard Shortcuts' },
  { id: 'default-browser', label: 'Default Browser' },
  { id: 'updates', label: 'Updates' },
  { id: 'about', label: 'About' }
]

/** Sections that only make sense on hosts with the matching feature. */
const SECTION_CAPABILITY: Partial<Record<SettingsSection, keyof HostCapabilities>> = {
  accessibility: 'pageControls',
  newtab: 'newTabPage',
  resources: 'resourceGovernor',
  extensions: 'extensions',
  agents: 'agents',
  passwords: 'passwords',
  sync: 'sync',
  'default-browser': 'defaultBrowser',
  updates: 'updates'
}

/**
 * The browser role has its own section on the desktop OSes (registration, status and the way to
 * Windows Settings need the room); Android keeps the one row under About.
 */
function hasDefaultBrowserSection(platform: Platform): boolean {
  return platform !== 'android'
}

function availableSections(caps: HostCapabilities, platform: Platform): typeof SECTIONS {
  return SECTIONS.filter((s) => {
    if (s.id === 'default-browser' && !hasDefaultBrowserSection(platform)) return false
    const cap = SECTION_CAPABILITY[s.id]
    return !cap || caps[cap]
  })
}

function resolveSection(
  value: string | null | undefined,
  sections: typeof SECTIONS
): SettingsSection {
  return sections.some((s) => s.id === value) ? (value as SettingsSection) : 'look'
}

export function SettingsPanel({
  state,
  initialSection
}: {
  state: UIState
  /** Section to show when the UI store does not name one (e.g. the Shortcuts / Sync overlays). */
  initialSection?: SettingsSection
}): JSX.Element {
  // The open section lives in the UI store so main-process events can retarget the panel while
  // it stays mounted (e.g. "Resource Settings…" from a menu).
  const stored = uiStore.use((u) => u.overlaySection)
  return (
    <OverlayShell title="Settings" variant="full" className="zen-settings" testId="settings-panel">
      <SettingsBody
        state={state}
        section={stored ?? initialSection}
        onSection={(id) => uiStore.set({ overlaySection: id })}
      />
    </OverlayShell>
  )
}

/**
 * The panel's nav and content, without the overlay around them: the desktop overlay's body, and
 * what the Settings tab shows inside the content area where two panes fit (`pages/settings`).
 * `section` may name a section this host lacks (a page-tab section id): the first one shows.
 */
export function SettingsBody({
  state,
  section: wanted,
  onSection
}: {
  state: UIState
  section: string | null | undefined
  onSection: (id: SettingsSection) => void
}): JSX.Element {
  const sections = availableSections(state.capabilities, state.platform)
  const section = resolveSection(wanted, sections)
  const setSection = onSection
  const s = state.settings
  const set = (patch: Partial<Settings>): void => run('settings.update', patch)
  // The section list scrolls down beside the content; on a phone Settings is its own tab
  // (`pages/settings`), never this panel.
  const fadeNav = useFadeEdges<HTMLElement>({ axis: 'y', size: 24 })
  const fadeContent = useFadeEdges<HTMLDivElement>({ axis: 'y' })
  return (
    <div className="flex h-full">
      <nav
        ref={fadeNav}
        className="w-52 shrink-0 overflow-y-auto border-r border-[var(--zen-border)] p-2"
      >
        {sections.map((item) => (
          <button
            key={item.id}
            type="button"
            className={cn(
              'zen-squircle flex h-9 w-full items-center rounded-lg px-3 text-left text-[13px] hover:bg-[var(--zen-element-bg)]',
              section === item.id && 'bg-[var(--zen-element-bg-active)] font-medium'
            )}
            onClick={() => setSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div ref={fadeContent} className="min-w-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-6">
          {section === 'look' && (
            <LookSection s={s} set={set} platform={state.platform} caps={state.capabilities} />
          )}
          {section === 'accessibility' && <AccessibilitySection state={state} set={set} />}
          {section === 'compact' && <CompactSection s={s} set={set} />}
          {section === 'newtab' && <NewTabSection state={state} set={set} />}
          {section === 'tabs' && (
            <TabsSection s={s} set={set} windows={state.capabilities.windows} />
          )}
          {section === 'downloads' && <DownloadsSection state={state} set={set} />}
          {section === 'resources' && <ResourcesSection state={state} set={set} />}
          {section === 'search' && <SearchSection state={state} set={set} />}
          {section === 'autofill' && <AutofillSection state={state} set={set} />}
          {section === 'spaces' && <SpaceRoutingSection state={state} set={set} />}
          {section === 'containers' && <ContainersSection state={state} />}
          {section === 'boosts' && <BoostsSection state={state} />}
          {section === 'mods' && <ModsSection state={state} />}
          {section === 'extensions' && <ExtensionsSection state={state} />}
          {section === 'agents' && <AgentsSection state={state} set={set} />}
          {section === 'passwords' && <PasswordsSection state={state} set={set} />}
          {section === 'sync' && <SyncSection state={state} />}
          {section === 'shortcuts' && <ShortcutsSection state={state} />}
          {section === 'default-browser' && <DefaultBrowserSection state={state} />}
          {section === 'updates' && <UpdatesSection state={state} set={set} />}
          {section === 'about' && <AboutSection state={state} setSection={setSection} />}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function LookSection({
  s,
  set,
  platform,
  caps
}: {
  s: Settings
  set: (p: Partial<Settings>) => void
  platform: Platform
  caps: HostCapabilities
}): JSX.Element {
  return (
    <>
      <Group title="Appearance">
        <Row label="Colour scheme" control={MENULIST_HEIGHT}>
          <Choice<ColorScheme>
            value={s.colorScheme}
            onChange={(v) => set({ colorScheme: v })}
            options={[
              { value: 'system', label: 'Follow system' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' }
            ]}
          />
        </Row>
        <Row
          label="Toolbar layout"
          hint="Single: everything lives in the sidebar. Multiple: a top toolbar holds navigation."
        >
          <Choice<ToolbarLayout>
            value={s.toolbarLayout}
            onChange={(v) => set({ toolbarLayout: v })}
            options={[
              { value: 'single', label: 'Single toolbar' },
              { value: 'multiple', label: 'Multiple toolbars' },
              { value: 'collapsed', label: 'Collapsed toolbar' }
            ]}
          />
        </Row>
        <Row label="Tabs on the right">
          <Switch
            checked={s.sidebarSide === 'right'}
            onCheckedChange={(v) => set({ sidebarSide: (v ? 'right' : 'left') as SidebarSide })}
          />
        </Row>
        <Row
          label="Expanded sidebar"
          hint="Show tab titles next to their icons. Double-click the sidebar edge to toggle."
        >
          <Switch
            checked={s.sidebarExpanded}
            onCheckedChange={(v) => set({ sidebarExpanded: v })}
          />
        </Row>
        <Row label="Remove browser padding" hint="Hide the rounded frame around web content.">
          <Switch checked={s.borderless} onCheckedChange={(v) => set({ borderless: v })} />
        </Row>
        {caps.windowMaterial && (
          <Row
            label="Use Windows transparency effects"
            hint="Let the desktop show through the window frame (Mica). Applies to new windows."
            control={SWITCH_HEIGHT}
          >
            <Switch
              checked={s.windowMaterial === 'mica'}
              onCheckedChange={(v) => set({ windowMaterial: v ? 'mica' : 'none' })}
            />
          </Row>
        )}
        {/* Chrome's Page zoom menulist; the host with the page-controls sheet has the zoom under Accessibility. */}
        {!caps.pageControls && <PageZoomRow s={s} set={set} />}
      </Group>
      {!caps.pageControls && <SiteZoomsGroup s={s} />}
      {caps.pageControls && <SitesGroups s={s} set={set} />}
      <AppIconGroup value={s.appIcon} platform={platform} onChange={(id) => set({ appIcon: id })} />
      <Group title="Bookmarks">
        <Row
          label="Show bookmarks bar"
          hint="Always, only on the new tab page, or never. Compact mode hides it with the toolbar."
        >
          <Choice<BookmarksBarMode>
            value={s.bookmarksBar}
            onChange={(v) => set({ bookmarksBar: v })}
            options={[
              { value: 'always', label: 'Always' },
              { value: 'newtab', label: 'Only on new tab page' },
              { value: 'never', label: 'Never' }
            ]}
          />
        </Row>
        <Row
          label="Import and export"
          hint="Netscape HTML files that Chrome, Edge and Firefox share."
        >
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => void run('bookmark.import', undefined)}>
              Import
            </Button>
            <Button variant="secondary" onClick={() => void run('bookmark.export', undefined)}>
              Export
            </Button>
          </div>
        </Row>
      </Group>
      <Group title="URL Bar">
        <Row label="Floating behaviour">
          <Choice<UrlbarBehavior>
            value={s.urlbarBehavior}
            onChange={(v) => set({ urlbarBehavior: v })}
            options={[
              { value: 'float-typing', label: 'Floating only when typing' },
              { value: 'always-float', label: 'Always floating' },
              { value: 'normal', label: 'Normal (attached to top)' }
            ]}
          />
        </Row>
        <Row label="Position on phones" hint="Hold the address bar to carry it to the other edge.">
          <Segmented<PhoneBarPosition>
            label="Position on phones"
            value={s.phoneBarPosition}
            onChange={(v) => set({ phoneBarPosition: v })}
            options={[
              { value: 'bottom', label: 'Bottom' },
              { value: 'top', label: 'Top' }
            ]}
          />
        </Row>
      </Group>
      {caps.pullToRefresh && (
        <Group title="Pages">
          <Row label="Pull to refresh" hint="Drag down from the top of a page to reload it.">
            <Switch
              aria-label="Pull to refresh"
              checked={s.pullToRefresh}
              onCheckedChange={(v) => set({ pullToRefresh: v })}
            />
          </Row>
        </Group>
      )}
      <Group title="Glance">
        <Row
          label="Enable Glance"
          hint="Preview links on top of the current tab without leaving it."
        >
          <Switch checked={s.glanceEnabled} onCheckedChange={(v) => set({ glanceEnabled: v })} />
        </Row>
        <Row label="Trigger">
          <Choice<GlanceTrigger>
            value={s.glanceTrigger}
            onChange={(v) => set({ glanceTrigger: v })}
            options={[
              { value: 'alt', label: 'Alt + Click' },
              { value: 'ctrl', label: 'Ctrl + Click' },
              { value: 'shift', label: 'Shift + Click' }
            ]}
          />
        </Row>
      </Group>
    </>
  )
}

function CompactSection({
  s,
  set
}: {
  s: Settings
  set: (p: Partial<Settings>) => void
}): JSX.Element {
  const cm = s.compactMode
  const chord = useChord('compact.toggle')
  return (
    <Group title="Compact Mode">
      <Row
        label="Enable compact mode"
        hint={`${chord ? `${chord}. ` : ''}Hidden bars reappear when you hover the window edge.`}
      >
        <Switch
          checked={cm.enabled}
          onCheckedChange={(v) => set({ compactMode: { ...cm, enabled: v } })}
        />
      </Row>
      <Row label="Hide sidebar">
        <Switch
          checked={cm.hideSidebar}
          onCheckedChange={(v) =>
            set({ compactMode: { ...cm, hideSidebar: v, hideToolbar: v ? cm.hideToolbar : true } })
          }
        />
      </Row>
      <Row
        label="Hide top toolbar"
        hint="Only applies to the Multiple / Collapsed toolbar layouts."
      >
        <Switch
          checked={cm.hideToolbar}
          disabled={s.toolbarLayout === 'single'}
          onCheckedChange={(v) =>
            set({ compactMode: { ...cm, hideToolbar: v, hideSidebar: v ? cm.hideSidebar : true } })
          }
        />
      </Row>
    </Group>
  )
}

/**
 * Settings > Downloads, bound to the engine's `Settings.downloads` (PR #69): the folder through
 * the engine's picker, the panel switches and the completion notification. `askWhereToSave`
 * stays at the top level of Settings, where the engine reads it.
 */
function DownloadsSection({
  state,
  set
}: {
  state: UIState
  set: (p: Partial<Settings>) => void
}): JSX.Element {
  const d = resolveDownloadSettings(state.settings)
  const patch = (p: Partial<DownloadSettings>): void => set({ downloads: p })
  const files = state.platform !== 'android'
  const engine = downloadsEngine
  return (
    <>
      <Group title="Saving">
        <Row label="Save files to" hint={d.directory ?? 'The system Downloads folder'}>
          {d.directory !== null && (
            <Button variant="ghost" size="sm" onClick={() => patch({ directory: null })}>
              Use default
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void engine.chooseDirectory().then((dir) => {
                if (dir !== null) patch({ directory: dir })
              })
            }}
          >
            Change
          </Button>
          {files && (
            <Button
              variant="secondary"
              size="sm"
              title="Open downloads folder"
              aria-label="Open downloads folder"
              onClick={() => engine.openFolder()}
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
          )}
        </Row>
        <Row label="Always ask where to save files">
          <Switch checked={d.askWhereToSave} onCheckedChange={(v) => set({ askWhereToSave: v })} />
        </Row>
        {d.autoOpenTypes.length > 0 && (
          <Row
            label="Open certain file types automatically"
            hint={d.autoOpenTypes.map((t) => `.${t}`).join(', ')}
          >
            <Button variant="secondary" size="sm" onClick={() => patch({ autoOpenTypes: [] })}>
              Clear
            </Button>
          </Row>
        )}
      </Group>
      <Group title="Downloads panel">
        <Row
          label="Show the downloads when a download finishes"
          hint="The bubble opens by itself once the last download in progress is done and leaves again after five seconds."
        >
          <Switch
            checked={d.openPanelOnComplete}
            onCheckedChange={(v) => patch({ openPanelOnComplete: v })}
          />
        </Row>
        <Row
          label="Show the downloads when a download starts"
          hint="Off, the toolbar button animates instead."
        >
          <Switch
            checked={d.openPanelOnStart}
            onCheckedChange={(v) => patch({ openPanelOnStart: v })}
          />
        </Row>
        <Row
          label="Always show the downloads button"
          hint="Keep the button in the toolbar when nothing is downloading."
        >
          <Switch
            checked={d.alwaysShowButton}
            onCheckedChange={(v) => patch({ alwaysShowButton: v })}
          />
        </Row>
      </Group>
      <Group title="Notifications">
        <Row
          label="Notify when a download finishes"
          hint="A system notification while no Zenium window has focus; clicking it shows the file."
        >
          <Switch
            checked={d.notifyOnComplete}
            onCheckedChange={(v) => patch({ notifyOnComplete: v })}
          />
        </Row>
      </Group>
    </>
  )
}

function TabsSection({
  s,
  set,
  windows
}: {
  s: Settings
  set: (p: Partial<Settings>) => void
  /** Whether the host can open more than one window. */
  windows: boolean
}): JSX.Element {
  const [domains, setDomains] = useState(s.unloadExcludedDomains.join(', '))
  const blankChord = useChord('window.newUnsynced')
  return (
    <>
      <Group title="Tabs">
        <Row label="Open new tabs">
          <Choice<NewTabPosition>
            value={s.newTabPosition}
            onChange={(v) => set({ newTabPosition: v })}
            options={[
              { value: 'end', label: 'At the end of the list' },
              { value: 'after-current', label: 'Below the current tab' }
            ]}
          />
        </Row>
        <Row label="Show separator between pinned and regular tabs">
          <Switch
            checked={s.showTabSeparator}
            onCheckedChange={(v) => set({ showTabSeparator: v })}
          />
        </Row>
        <Row label="Ctrl+Tab stays within Essentials / regular tabs">
          <Switch
            checked={s.ctrlTabCyclesWithinSection}
            onCheckedChange={(v) => set({ ctrlTabCyclesWithinSection: v })}
          />
        </Row>
        <Row label="Restore previous session on startup">
          <Switch checked={s.restoreSession} onCheckedChange={(v) => set({ restoreSession: v })} />
        </Row>
        {windows && (
          <Row
            label="Restore pages after a crash"
            hint="What happens to the open pages when Zenium did not shut down correctly."
          >
            <Choice<CrashRestoreMode>
              value={s.crashRestore}
              onChange={(v) => set({ crashRestore: v })}
              options={[
                { value: 'ask', label: 'Ask first' },
                { value: 'always', label: 'Restore them' },
                { value: 'never', label: 'Start fresh' }
              ]}
            />
          </Row>
        )}
        {windows && (
          <Row
            label="Warn before closing a window with multiple tabs"
            hint="Also asks before quitting with more than one tab open."
          >
            <Switch
              checked={s.warnOnCloseWindow}
              onCheckedChange={(v) => set({ warnOnCloseWindow: v })}
            />
          </Row>
        )}
      </Group>
      {windows && (
        <Group title="Window Sync">
          <Row
            label="Tabs across windows"
            hint="Zenium mirrors your spaces and tabs in every window. Choose 'pinned only' to keep unpinned tabs per window."
          >
            <Choice<WindowSyncMode>
              value={s.windowSync}
              onChange={(v) => set({ windowSync: v })}
              options={[
                { value: 'all', label: 'Sync all tabs' },
                { value: 'pinned', label: 'Sync only pinned tabs in spaces' },
                { value: 'off', label: 'Off – windows are independent' }
              ]}
            />
          </Row>
          <Row
            label="Blank windows"
            hint={`${blankChord ? `${blankChord} opens` : 'Opens'} a window without spaces, pinned tabs or Essentials. Its tabs are temporary.`}
          >
            <Button
              variant="secondary"
              size="sm"
              onClick={() => run('window.newUnsynced', undefined)}
            >
              Open one
            </Button>
          </Row>
        </Group>
      )}
      <Group title="Pinned Tabs & Essentials">
        <Row label="When closing a pinned tab">
          <Choice<PinnedCloseBehavior>
            value={s.pinnedCloseBehavior}
            onChange={(v) => set({ pinnedCloseBehavior: v })}
            options={[
              { value: 'reset-unload-switch', label: 'Reset, unload and switch to next' },
              { value: 'reset-unload', label: 'Reset and unload' },
              { value: 'reset', label: 'Reset to pinned URL' },
              { value: 'unload', label: 'Unload' },
              { value: 'unload-switch', label: 'Unload and switch to next' },
              { value: 'switch', label: 'Switch to next tab' },
              { value: 'close', label: 'Close the tab' }
            ]}
          />
        </Row>
        <Row label="Restore pinned tabs to their pinned URL on startup">
          <Switch
            checked={s.pinnedResetOnStartup}
            onCheckedChange={(v) => set({ pinnedResetOnStartup: v })}
          />
        </Row>
        <Row label="Third-party links on pinned & essential tabs">
          <Choice<ThirdPartyPinnedBehavior>
            value={s.thirdPartyOnPinned}
            onChange={(v) => set({ thirdPartyOnPinned: v })}
            options={[
              { value: 'new-tab', label: 'Open in their own tab' },
              { value: 'glance', label: 'Open in Glance' },
              { value: 'same-tab', label: 'Open in the same tab' }
            ]}
          />
        </Row>
        <Row
          label="Container-specific Essentials"
          hint="Each container gets its own set of Essentials."
        >
          <Switch
            checked={s.containerSpecificEssentials}
            onCheckedChange={(v) => set({ containerSpecificEssentials: v })}
          />
        </Row>
        <Row label="Maximum number of Essentials">
          <Input
            type="number"
            min={1}
            max={24}
            className="w-20"
            value={s.essentialsMax}
            onChange={(e) => set({ essentialsMax: Number(e.target.value) || 12 })}
          />
        </Row>
      </Group>
      <Group title="Tab Unloading">
        <Row
          label="Unload inactive tabs"
          hint="Frees memory by unloading tabs you haven't used for a while. Freezing, budgets and the live-page cap live under Resources."
        >
          <Switch checked={s.unloadEnabled} onCheckedChange={(v) => set({ unloadEnabled: v })} />
        </Row>
        <Row label="Unload after (minutes)">
          <Input
            type="number"
            min={1}
            max={1440}
            className="w-24"
            value={s.unloadTimeoutMinutes}
            onChange={(e) => set({ unloadTimeoutMinutes: Number(e.target.value) || 20 })}
          />
        </Row>
        <Row
          label="Never unload these domains"
          hint="Comma separated, e.g. mail.google.com, notion.so"
        >
          <Input
            className="w-64"
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
            onBlur={() =>
              set({
                unloadExcludedDomains: domains
                  .split(',')
                  .map((d) => d.trim().toLowerCase())
                  .filter(Boolean)
              })
            }
          />
        </Row>
      </Group>
    </>
  )
}

function SearchSection({
  state,
  set
}: {
  state: UIState
  set: (p: Partial<Settings>) => void
}): JSX.Element {
  return (
    <Group title="Search">
      <Row label="Default search engine">
        <Choice
          value={state.settings.searchEngineId}
          onChange={(v) => set({ searchEngineId: v })}
          options={state.searchEngines.map((e) => ({ value: e.id, label: e.name }))}
        />
      </Row>
      <Row
        label="Show search suggestions"
        hint="Sends what you type to the search engine as you type."
      >
        <Switch
          checked={state.settings.searchSuggestions}
          onCheckedChange={(v) => set({ searchSuggestions: v })}
        />
      </Row>
      <Row
        label="Always show full URLs"
        hint="Keep the scheme and www. in the address bar instead of hiding them."
      >
        <Switch
          checked={Boolean(state.settings.showFullUrls)}
          onCheckedChange={(v) => set({ showFullUrls: v })}
        />
      </Row>
      <Row label="Engine keywords" hint={state.searchEngines.map((e) => e.keyword).join(' · ')}>
        <span className="text-[11.5px] text-[var(--zen-muted)]">Type a keyword, then a space</span>
      </Row>
    </Group>
  )
}

function SpaceRoutingSection({
  state,
  set
}: {
  state: UIState
  set: (p: Partial<Settings>) => void
}): JSX.Element {
  const [domain, setDomain] = useState('')
  const [spaceId, setSpaceId] = useState(state.spaces[0]?.id ?? '')
  const routing = state.settings.spaceRouting
  const add = (): void => {
    const d = domain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
    if (!d || !spaceId) return
    set({ spaceRouting: { ...routing, [d]: spaceId } })
    setDomain('')
  }
  return (
    <>
      <p className="text-[13px] text-[var(--zen-muted)]">
        Space Routing opens links from the listed domains in a specific space, wherever you click
        them.
      </p>
      <Group title="Routes">
        {Object.keys(routing).length === 0 && (
          <div className="px-4 py-6 text-center text-[12.5px] text-[var(--zen-muted)]">
            No routes yet.
          </div>
        )}
        {Object.entries(routing).map(([d, sid]) => {
          const space = state.spaces.find((s) => s.id === sid)
          return (
            <Row key={d} label={d} hint={space ? spaceLabel(space) : 'Space no longer exists'}>
              <button
                type="button"
                className="zen-toolbar-button h-7 w-7"
                title="Remove route"
                onClick={() => {
                  const next = { ...routing }
                  delete next[d]
                  set({ spaceRouting: next })
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </Row>
          )
        })}
      </Group>
      <Group title="Add route">
        <div className="flex items-center gap-2 p-3">
          <Input
            placeholder="domain.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <Choice
            value={spaceId}
            onChange={setSpaceId}
            options={state.spaces.map((s) => ({
              value: s.id,
              label: spaceLabel(s)
            }))}
          />
          <Button onClick={add}>Add</Button>
        </div>
      </Group>
    </>
  )
}

function ContainersSection({ state }: { state: UIState }): JSX.Element {
  const [name, setName] = useState('')
  const [color, setColor] = useState<ContainerColor>('blue')
  const [icon, setIcon] = useState<ContainerIconName>('circle')
  const editable = state.containers.filter((c) => c.id !== DEFAULT_CONTAINER_ID)
  return (
    <>
      <p className="text-[13px] text-[var(--zen-muted)]">
        Containers keep cookies and site data separate, so you can stay logged into several accounts
        on the same site. Assign a container to a space to isolate it. The order here is used
        wherever containers are listed.
      </p>
      <Group title="Containers">
        {state.containers.map((c, i) => (
          <Row
            key={c.id}
            label={c.name}
            hint={c.id === DEFAULT_CONTAINER_ID ? 'Tabs without a container' : undefined}
          >
            <ContainerIcon container={c} size={16} />
            {c.id !== DEFAULT_CONTAINER_ID && (
              <>
                <Choice<ContainerColor>
                  value={c.color}
                  onChange={(v) => run('container.update', { id: c.id, patch: { color: v } })}
                  options={Object.keys(CONTAINER_COLORS).map((k) => ({
                    value: k as ContainerColor,
                    label: k
                  }))}
                />
                <Choice<ContainerIconName>
                  value={c.icon}
                  onChange={(v) => run('container.update', { id: c.id, patch: { icon: v } })}
                  options={CONTAINER_ICONS.map((k) => ({ value: k, label: k }))}
                />
                <button
                  type="button"
                  className="zen-toolbar-button h-7 w-7"
                  title="Move up"
                  disabled={i <= 1}
                  onClick={() => run('container.reorder', { id: c.id, index: i - 1 })}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="zen-toolbar-button h-7 w-7"
                  title="Move down"
                  disabled={i >= state.containers.length - 1}
                  onClick={() => run('container.reorder', { id: c.id, index: i + 1 })}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="zen-toolbar-button h-7 w-7"
                  title="Delete container and clear its data"
                  onClick={() => run('container.delete', { id: c.id })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </>
            )}
          </Row>
        ))}
        {editable.length === 0 && (
          <div className="px-4 py-4 text-center text-[12.5px] text-[var(--zen-muted)]">
            Only the default container exists.
          </div>
        )}
      </Group>
      <Group title="New container">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <Input
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-40"
          />
          <Choice<ContainerColor>
            value={color}
            onChange={setColor}
            options={Object.keys(CONTAINER_COLORS).map((k) => ({
              value: k as ContainerColor,
              label: k
            }))}
          />
          <Choice<ContainerIconName>
            value={icon}
            onChange={setIcon}
            options={CONTAINER_ICONS.map((i) => ({ value: i, label: i }))}
          />
          <ContainerIcon container={{ color, icon }} size={18} />
          <Button
            disabled={!name.trim()}
            onClick={() => {
              run('container.create', { name: name.trim(), color, icon })
              setName('')
            }}
          >
            Create
          </Button>
        </div>
      </Group>
    </>
  )
}

/** Zen's about:preferences#zen-boosts: every active Boost, with edit / delete. */
function BoostsSection({ state }: { state: UIState }): JSX.Element {
  const tab = activeTab(state)
  const canBoostCurrent = Boolean(
    tab && /^https?:/.test(tab.url) && state.window.kind !== 'private'
  )
  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <p className="text-[13px] text-[var(--zen-muted)]">
          Boosts change how a website looks: tint its colours, swap fonts, zap elements away or
          force dark mode. They apply to every page of the site and stay until you remove them.
        </p>
        <Button
          size="sm"
          disabled={!canBoostCurrent}
          onClick={() => tab && void openOverlay('boosts', tab.id)}
        >
          <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Boost current site
        </Button>
      </div>
      <Group title="Active boosts">
        {state.boosts.length === 0 && (
          <div className="px-4 py-6 text-center text-[12.5px] text-[var(--zen-muted)]">
            No boosts yet. Open a site and click the sparkle in the address bar.
          </div>
        )}
        {state.boosts.map((b) => {
          const parts = [
            b.tint && 'tint',
            b.font && 'font',
            b.fontSize !== 100 && `${b.fontSize}% text`,
            b.darkMode && 'dark mode',
            b.zapped.length > 0 && `${b.zapped.length} zapped`,
            b.css.trim() && 'custom CSS'
          ].filter(Boolean)
          return (
            <Row
              key={b.domain}
              label={b.domain}
              hint={`${parts.join(' · ') || 'Nothing configured'} · ${relativeTime(b.updatedAt)}`}
            >
              {b.tint && (
                <span
                  className="h-3 w-3 rounded-full ring-1 ring-black/10"
                  style={{ background: b.tint }}
                />
              )}
              <Switch
                checked={b.enabled}
                onCheckedChange={(v) =>
                  run('boost.update', { domain: b.domain, patch: { enabled: v } })
                }
              />
              <button
                type="button"
                className="zen-toolbar-button h-7 w-7"
                title="Remove boost"
                onClick={() => run('boost.remove', { domain: b.domain })}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </Row>
          )
        })}
      </Group>
    </>
  )
}

/**
 * The browser role (DEF-03), on hosts that have one to give: either the fact that Zenium holds it
 * or the button that asks the system for it. `null` is a host that has not answered yet; the
 * button is offered then too, and the request re-reads the role afterwards.
 */
function DefaultBrowserRow({ isDefault }: { isDefault: boolean | null }): JSX.Element {
  if (isDefault) {
    return (
      <Row label="Default browser" hint="Zenium is your default browser.">
        <span
          className="flex h-8 w-8 items-center justify-center text-[var(--zen-ok)]"
          aria-label="Zenium is the default browser"
          role="img"
        >
          <Check className="h-5 w-5" strokeWidth={2} />
        </span>
      </Row>
    )
  }
  return (
    <Row label="Default browser" hint="Open links from other apps in Zenium.">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => run('defaultBrowser.request', { source: 'settings' })}
      >
        Set as default
      </Button>
    </Row>
  )
}

function AboutSection({
  state,
  setSection
}: {
  state: UIState
  setSection: (id: SettingsSection) => void
}): JSX.Element {
  // Desktop/DeX: the engine host is Electron; phones and tablets run the system WebView.
  const engineHost = state.platform === 'android' ? 'Android System WebView' : 'Electron'
  const update = state.updates
  const newer = update.phase === 'available' || update.phase === 'ready' ? update.release : null
  return (
    <Group title="About">
      <Row
        label="Zenium"
        hint={`Version ${state.version} · running on Chromium via ${engineHost}${
          newer ? ` · ${newer.version} is available` : ''
        }`}
      >
        {state.capabilities.updates ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setSection('updates')
              if (!newer) run('updates.check', undefined)
            }}
          >
            {newer ? `Update to ${newer.version}` : 'Check for updates'}
          </Button>
        ) : (
          <span />
        )}
      </Row>
      {state.capabilities.defaultBrowser && !hasDefaultBrowserSection(state.platform) && (
        <DefaultBrowserRow isDefault={state.defaultBrowser.isDefault} />
      )}
      <Row
        label="Engine"
        hint="Blink / V8 — the same engine as Chrome. The chrome reimplements Zen Browser 1.22: Spaces, Essentials, Glance, Split View, Compact Mode, window sync, Boosts, Live Folders, Reader View, Mods and cross-device sync."
      >
        <span />
      </Row>
      <Row
        label="Upstream project"
        hint="zen-browser.app — this port is not affiliated with the Zen team."
      >
        <Button
          variant="secondary"
          size="sm"
          onClick={() => run('app.openExternal', { url: 'https://zen-browser.app' })}
        >
          Open website
        </Button>
      </Row>
    </Group>
  )
}
