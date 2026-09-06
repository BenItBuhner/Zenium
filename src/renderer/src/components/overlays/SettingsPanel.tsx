import type { JSX } from 'react'
import { useState, type ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import type {
  ColorScheme,
  ContainerColor,
  ContainerIcon,
  GlanceTrigger,
  NewTabPosition,
  PinnedCloseBehavior,
  Settings,
  SidebarSide,
  ThirdPartyPinnedBehavior,
  ToolbarLayout,
  UIState,
  UrlbarBehavior
} from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'
import { CONTAINER_COLORS } from '@shared/defaults'
import { run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { cn } from '@renderer/lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { OverlayShell } from './OverlayShell'
import { ShortcutsSection } from './ShortcutsSection'

type Section =
  'look' | 'compact' | 'tabs' | 'search' | 'spaces' | 'containers' | 'shortcuts' | 'about'

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'look', label: 'Look and Feel' },
  { id: 'compact', label: 'Compact Mode' },
  { id: 'tabs', label: 'Tab Management' },
  { id: 'search', label: 'Search' },
  { id: 'spaces', label: 'Space Routing' },
  { id: 'containers', label: 'Containers' },
  { id: 'shortcuts', label: 'Keyboard Shortcuts' },
  { id: 'about', label: 'About' }
]

const CONTAINER_ICONS: ContainerIcon[] = [
  'fingerprint',
  'briefcase',
  'dollar',
  'cart',
  'circle',
  'gift',
  'vacation',
  'food',
  'fruit',
  'pet',
  'tree',
  'chill',
  'fence'
]

export function SettingsPanel({
  state,
  initialSection = 'look'
}: {
  state: UIState
  initialSection?: Section
}): JSX.Element {
  const [section, setSection] = useState<Section>(initialSection)
  const s = state.settings
  const set = (patch: Partial<Settings>): void => run('settings.update', patch)
  const phone = useViewport().formFactor === 'phone'
  // Desktop/DeX: about-line mentions the engine host; phones run the system WebView.
  const engineHost = state.platform === 'android' ? 'Android System WebView' : 'Electron'

  return (
    <OverlayShell title="Settings" variant="full">
      <div className={cn('flex h-full', phone && 'flex-col')}>
        <nav
          className={cn(
            'shrink-0 border-[var(--zen-border)] p-2',
            phone ? 'flex gap-1 overflow-x-auto border-b [scrollbar-width:none]' : 'w-52 border-r'
          )}
        >
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cn(
                'flex h-9 items-center rounded-lg px-3 text-left text-[13px] hover:bg-[var(--zen-element-bg)]',
                phone ? 'shrink-0 whitespace-nowrap' : 'w-full',
                section === item.id && 'bg-[var(--zen-element-bg-active)] font-medium'
              )}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className={cn('min-w-0 flex-1 overflow-y-auto', phone ? 'p-3' : 'p-6')}>
          <div className="mx-auto flex max-w-2xl flex-col gap-6">
            {section === 'look' && <LookSection s={s} set={set} />}
            {section === 'compact' && <CompactSection s={s} set={set} />}
            {section === 'tabs' && <TabsSection s={s} set={set} />}
            {section === 'search' && <SearchSection state={state} set={set} />}
            {section === 'spaces' && <SpaceRoutingSection state={state} set={set} />}
            {section === 'containers' && <ContainersSection state={state} />}
            {section === 'shortcuts' && <ShortcutsSection state={state} />}
            {section === 'about' && <AboutSection state={state} engineHost={engineHost} />}
          </div>
        </div>
      </div>
    </OverlayShell>
  )
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Group({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section>
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--zen-muted)]">
        {title}
      </h3>
      <div className="overflow-hidden rounded-xl border border-[var(--zen-border)]">{children}</div>
    </section>
  )
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex min-h-12 items-center gap-4 border-b border-[var(--zen-border)] px-4 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13px]">{label}</div>
        {hint && <div className="text-[11.5px] text-[var(--zen-muted)]">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

function Choice<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
}): JSX.Element {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger className="w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function LookSection({
  s,
  set
}: {
  s: Settings
  set: (p: Partial<Settings>) => void
}): JSX.Element {
  return (
    <>
      <Group title="Appearance">
        <Row label="Colour scheme">
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
      </Group>
      <Group title="Zen URL Bar">
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
      </Group>
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
  return (
    <Group title="Compact Mode">
      <Row
        label="Enable compact mode"
        hint="Ctrl+S. Hidden bars reappear when you hover the window edge."
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

function TabsSection({
  s,
  set
}: {
  s: Settings
  set: (p: Partial<Settings>) => void
}): JSX.Element {
  const [domains, setDomains] = useState(s.unloadExcludedDomains.join(', '))
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
        <Row label="Always ask where to save downloads">
          <Switch checked={s.askWhereToSave} onCheckedChange={(v) => set({ askWhereToSave: v })} />
        </Row>
      </Group>
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
          hint="Frees memory by unloading tabs you haven't used for a while."
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
            <Row
              key={d}
              label={d}
              hint={
                space
                  ? `${space.icon ? `${space.icon} ` : ''}${space.name}`
                  : 'Space no longer exists'
              }
            >
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
              label: `${s.icon ? `${s.icon} ` : ''}${s.name}`
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
  const [icon, setIcon] = useState<ContainerIcon>('circle')
  return (
    <>
      <p className="text-[13px] text-[var(--zen-muted)]">
        Containers keep cookies and site data separate, so you can stay logged into several accounts
        on the same site. Assign a container to a space to isolate it.
      </p>
      <Group title="Containers">
        {state.containers.map((c) => (
          <Row
            key={c.id}
            label={c.name}
            hint={
              c.id === DEFAULT_CONTAINER_ID ? 'Tabs without a container' : `${c.icon} · ${c.color}`
            }
          >
            <span
              className="h-3 w-3 rounded-full"
              style={{ background: CONTAINER_COLORS[c.color] }}
            />
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
          <Choice<ContainerIcon>
            value={icon}
            onChange={setIcon}
            options={CONTAINER_ICONS.map((i) => ({ value: i, label: i }))}
          />
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

function AboutSection({ state, engineHost }: { state: UIState; engineHost: string }): JSX.Element {
  return (
    <Group title="About">
      <Row
        label="Zen (Chromium port)"
        hint={`Version ${state.version} · running on Chromium via ${engineHost}`}
      >
        <span />
      </Row>
      <Row
        label="Engine"
        hint="Blink / V8 — the same engine as Chrome. UI reimplements Zen Browser's Spaces, Essentials, Glance, Split View and Compact Mode."
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
