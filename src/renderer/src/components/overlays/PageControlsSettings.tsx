import type { JSX, ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import type { DesktopSiteDefault, PageControlsSettings, Settings, UIState } from '@shared/types'
import { formatZoom } from '@shared/pageControls'
import { run } from '@renderer/lib/api'
import { Switch } from '../ui/switch'
import { ZoomStepper } from '../ZoomStepper'
import { Choice, Group, Row } from './SettingsPrimitives'

/**
 * Settings rows for the page controls (hosts with `capabilities.pageControls`): the site
 * defaults under Look and Feel, and the Accessibility section with the default zoom. Built from
 * the shared `Group` / `Row` primitives; the per-site lists show only real exceptions, which the
 * menu's Desktop Site, Dark Theme for This Site and Zoom items create.
 */

type SetSettings = (patch: Partial<Settings>) => void

function patcher(s: Settings, set: SetSettings): (patch: Partial<PageControlsSettings>) => void {
  return (patch) => set({ pageControls: { ...s.pageControls, ...patch } })
}

function sorted<T>(map: Record<string, T>): Array<[string, T]> {
  return Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
}

export function SitesGroups({ s, set }: { s: Settings; set: SetSettings }): JSX.Element {
  const pc = s.pageControls
  const patch = patcher(s, set)
  const desktop = sorted(pc.desktopSites)
  const darken = sorted(pc.darkenSiteExceptions)
  return (
    <>
      <Group title="Sites">
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
        <Row
          label="Apply dark theme to sites"
          hint="Sites without a dark theme get one while Zenium is dark."
        >
          <Switch
            aria-label="Apply dark theme to sites"
            checked={pc.darkenSites}
            onCheckedChange={(v) => patch({ darkenSites: v })}
          />
        </Row>
      </Group>
      <Group title="Site exceptions">
        {desktop.length + darken.length === 0 && (
          <Empty>
            No exceptions yet. Desktop Site and Dark Theme for This Site in the menu remember a
            site&apos;s choice here.
          </Empty>
        )}
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
  const zooms = sorted(pc.siteZooms)
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
      <Group title="Sites with their own zoom">
        {zooms.length === 0 && (
          <Empty>
            No sites yet. Zoom In and Zoom Out in the menu remember a site&apos;s zoom here.
          </Empty>
        )}
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

function Empty({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="px-4 py-6 text-center text-[12.5px] text-[var(--zen-muted)]">{children}</div>
  )
}

/** A description that belongs to the row above it but needs the group's full width. */
function Note({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="border-b border-[var(--zen-border)] px-4 py-2 text-[11.5px] text-[var(--zen-muted)] last:border-b-0">
      {children}
    </div>
  )
}
