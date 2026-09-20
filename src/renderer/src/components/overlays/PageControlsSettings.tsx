import type { JSX, ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import type {
  DesktopSiteDefault,
  HostCapabilities,
  PageControlsSettings,
  Settings,
  UIState
} from '@shared/types'
import { formatZoom, zoomChoices, zoomKey } from '@shared/pageControls'
import { run } from '@renderer/lib/api'
import { EmptyRow } from '../siteControls/pane'
import { Switch } from '../ui/switch'
import { ZoomStepper } from '../ZoomStepper'
import { Choice, Group, MENULIST_HEIGHT, Row } from './SettingsPrimitives'

/**
 * Settings rows for the page controls (hosts with `capabilities.pageControls`): the site
 * defaults under Look and Feel, and the Accessibility section with the default zoom. Built from
 * the shared `Group` / `Row` primitives; the per-site lists show only real exceptions, which the
 * menu's Desktop Site, Dark Theme for This Site and Zoom… (the phone's zoom sheet) items create.
 *
 * The desktop has zoom memory without the rest of the page controls: its default zoom is
 * Chrome's "Page zoom" menulist under Appearance (`PageZoomRow`), and the sites that were
 * zoomed away from it are listed under it (`SiteZoomsGroup`, shared with Accessibility). It
 * darkens pages too (`capabilities.darkenSites`), so `SitesGroups` shows the dark theme switch
 * and its exceptions there without the desktop-site rows.
 */

type SetSettings = (patch: Partial<Settings>) => void

function patcher(s: Settings, set: SetSettings): (patch: Partial<PageControlsSettings>) => void {
  return (patch) => set({ pageControls: { ...s.pageControls, ...patch } })
}

function sorted<T>(map: Record<string, T>): Array<[string, T]> {
  return Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
}

/** Chrome's "Page zoom" menulist (Settings > Appearance): the zoom pages open at, 25 to 500 percent. */
export function PageZoomRow({ s, set }: { s: Settings; set: SetSettings }): JSX.Element {
  const pc = s.pageControls
  const patch = patcher(s, set)
  return (
    <Row
      label="Page zoom"
      hint="Sites without a zoom of their own open at this size."
      control={MENULIST_HEIGHT}
    >
      <Choice
        value={zoomKey(pc.zoom)}
        onChange={(v) => patch({ zoom: Number(v) / 100 })}
        options={zoomChoices(pc.zoom)}
      />
    </Row>
  )
}

/** The sites zoomed away from the default, each with its factor and a way to forget it. */
export function SiteZoomsGroup({ s }: { s: Settings }): JSX.Element {
  const zooms = sorted(s.pageControls.siteZooms)
  return (
    <Group title="Sites with their own zoom">
      {zooms.length === 0 && <Empty>No sites yet</Empty>}
      {zooms.map(([domain, factor]) => (
        <SiteRow
          key={domain}
          domain={domain}
          value={formatZoom(factor)}
          removeLabel="Remove zoom"
          onRemove={() => run('pageControls.forgetSite', { kind: 'zoom', domain })}
        />
      ))}
    </Group>
  )
}

/**
 * The Sites group and its exceptions, by what the host does: the desktop-site default is the
 * page-controls host's (Android's WebView asks for a layout), the dark theme for sites is any
 * host that can darken pages (Chrome Android's "Auto-darken web content"; the desktop through
 * Chromium's auto dark mode, CT-18). Each list shows only the exceptions of the rows above it,
 * so a desktop profile with a darkened site from an Android device never lists a desktop-site
 * exception it cannot change.
 */
export function SitesGroups({
  s,
  set,
  caps
}: {
  s: Settings
  set: SetSettings
  caps: Pick<HostCapabilities, 'pageControls' | 'darkenSites'>
}): JSX.Element {
  const pc = s.pageControls
  const patch = patcher(s, set)
  const desktop = caps.pageControls ? sorted(pc.desktopSites) : []
  const darken = caps.darkenSites ? sorted(pc.darkenSiteExceptions) : []
  return (
    <>
      <Group title="Sites">
        {caps.pageControls && (
          <>
            <Row label="Desktop site">
              <Choice<DesktopSiteDefault>
                value={pc.desktopSite}
                onChange={(v) => patch({ desktopSite: v })}
                options={[
                  { value: 'auto', label: 'Automatic' },
                  { value: 'on', label: 'Always' },
                  { value: 'off', label: 'Never' }
                ]}
              />
            </Row>
            <Note>
              Automatic asks sites for their desktop layout on large screens, or when a keyboard and
              mouse are attached.
            </Note>
          </>
        )}
        {caps.darkenSites && (
          <Row
            label="Apply dark theme to sites"
            hint="Sites without a dark theme get one while Zenium is dark. Dark Theme for This Site in the menu turns it off for one site."
          >
            <Switch
              aria-label="Apply dark theme to sites"
              checked={pc.darkenSites}
              onCheckedChange={(v) => patch({ darkenSites: v })}
            />
          </Row>
        )}
      </Group>
      <Group title="Site exceptions">
        {desktop.length + darken.length === 0 && <Empty>No exceptions yet</Empty>}
        {desktop.map(([domain, on]) => (
          <SiteRow
            key={`desktop:${domain}`}
            domain={domain}
            value={on ? 'Desktop site on' : 'Desktop site off'}
            removeLabel="Remove exception"
            onRemove={() => run('pageControls.forgetSite', { kind: 'desktop', domain })}
          />
        ))}
        {darken.map(([domain, on]) => (
          <SiteRow
            key={`darken:${domain}`}
            domain={domain}
            value={on ? 'Dark theme on' : 'Dark theme off'}
            removeLabel="Remove exception"
            onRemove={() => run('pageControls.forgetSite', { kind: 'darken', domain })}
          />
        ))}
      </Group>
    </>
  )
}

export function AccessibilitySection({
  state,
  set
}: {
  state: UIState
  set: SetSettings
}): JSX.Element {
  const s = state.settings
  const pc = s.pageControls
  const patch = patcher(s, set)
  const fontScale = state.pageEnvironment.fontScale || 1
  const scale = pc.zoomIncludesOsFontSize ? fontScale : 1
  const fontHint =
    fontScale === 1
      ? 'Follow the font size chosen in the system settings; it is at 100% now.'
      : `The system font size is ${formatZoom(fontScale)}; with it, pages open at ${formatZoom(pc.zoom * scale)}.`
  return (
    <>
      <Group title="Page zoom">
        <Row label="Default zoom" hint="Sites without a zoom of their own open at this size.">
          <span className="text-[13px] font-medium tabular-nums">{formatZoom(pc.zoom)}</span>
        </Row>
        <div className="border-b border-[var(--zen-border)] px-3 py-1">
          <ZoomStepper value={pc.zoom} onChange={(factor) => patch({ zoom: factor })} />
        </div>
        <div className="border-b border-[var(--zen-border)] px-4 py-3">
          <div
            className="rounded-lg border border-[var(--zen-border)] bg-[var(--zen-element-bg)] px-4 py-3 [overflow-wrap:anywhere]"
            aria-hidden="true"
          >
            <p style={{ fontSize: `${15 * pc.zoom * scale}px`, lineHeight: 1.35 }}>
              Text on pages will be this size.
            </p>
          </div>
        </div>
        <Row label="Include system font size" hint={fontHint}>
          <Switch
            aria-label="Include system font size"
            checked={pc.zoomIncludesOsFontSize}
            onCheckedChange={(v) => patch({ zoomIncludesOsFontSize: v })}
          />
        </Row>
        <Row
          label="Force enable zoom"
          hint="Pinch to zoom on every page, even where a site turns it off."
        >
          <Switch
            aria-label="Force enable zoom"
            checked={pc.forceZoom}
            onCheckedChange={(v) => patch({ forceZoom: v })}
          />
        </Row>
      </Group>
      <SiteZoomsGroup s={s} />
    </>
  )
}

function SiteRow({
  domain,
  value,
  removeLabel,
  onRemove
}: {
  domain: string
  value: string
  removeLabel: string
  onRemove: () => void
}): JSX.Element {
  return (
    <Row label={domain} hint={value}>
      <button
        type="button"
        className="zen-toolbar-button zen-row-action h-7 w-7"
        title={removeLabel}
        aria-label={`${removeLabel}: ${domain}`}
        onClick={onRemove}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </Row>
  )
}

/**
 * An empty list in one of the pane's cards (§9.17): the shared plain row – 32 tall at the card's
 * 16 gutter, one sentence 15 at 69% left-aligned like a row's label, no full stop. Which menu
 * item fills the list (Desktop Site, Dark Theme for This Site, Zoom) has no line of its own until
 * the legacy `Group` grows a description; the menu items are the only way in.
 */
function Empty({ children }: { children: string }): JSX.Element {
  return <EmptyRow className="px-4">{children}</EmptyRow>
}

/** A description that belongs to the row above it but needs the group's full width. */
function Note({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="border-b border-[var(--zen-border)] px-4 py-2 text-[11.5px] text-[var(--zen-muted)] last:border-b-0">
      {children}
    </div>
  )
}
