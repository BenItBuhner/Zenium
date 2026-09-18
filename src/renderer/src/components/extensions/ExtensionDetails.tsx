import type { JSX, ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  Ellipsis,
  Info,
  ShieldCheck,
  SlidersHorizontal
} from 'lucide-react'
import type { ExtensionInfo } from '@shared/types'
import { anchorOf, type Anchor } from '@renderer/lib/anchor'
import { run } from '@renderer/lib/api'
import { formatDate } from '@renderer/lib/extensions/format'
import { sourceLabel, storePageUrl } from '@renderer/lib/extensions/storeInput'
import { closeOverlay } from '@renderer/lib/ui'
import { ExtensionIcon } from './ExtensionIcon'
import { PageHeader } from './PageHeader'
import { V2Card, V2CheckRow, V2IconButton, V2Row, V2Switch } from './v2'
import { WarningRow } from './WarningRow'

/**
 * One extension, pushed in over the list: a back header with the name as the page title, the
 * description, then Permissions, Source and Options as bordered cards with 17/600 titles (v2
 * draft §6) whose rows are parted by hairlines, as Zen's add-on detail rows are.
 */
export function ExtensionDetails({
  ext,
  scrolled,
  menuOpen,
  onBack,
  onMenu
}: {
  ext: ExtensionInfo
  scrolled: boolean
  /** The header's `⋯` menu is open: its anchor shows it (§9.20). */
  menuOpen: boolean
  onBack: () => void
  onMenu: (anchor: Anchor) => void
}): JSX.Element {
  const warnings = ext.warnings
  const pending = ext.pendingWarnings ?? []
  const store = storePageUrl(ext.source, ext.id)
  return (
    <>
      <PageHeader scrolled={scrolled}>
        <V2IconButton icon={ArrowLeft} label="Back to extensions" title="Back" onClick={onBack} />
        <ExtensionIcon icon={ext.icon} size={24} box={28} />
        <h1 className="zen-v2-title">{ext.name || ext.id}</h1>
        <V2Switch
          checked={ext.enabled}
          label={`${ext.name} enabled`}
          onChange={(v) => run('extension.setEnabled', { id: ext.id, enabled: v })}
        />
        <V2IconButton
          icon={Ellipsis}
          label="More actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => onMenu(anchorOf(e.currentTarget))}
        />
      </PageHeader>
      <div className="zen-v2-column flex flex-col pb-8">
        {/*
          The page title's description (§9.26): the extension's own line (or its error) 15 at 69%
          under the header's 16, a caption 4 under that, then 16 from the block to the first card.
        */}
        {(ext.error || ext.description || ext.manifestVersion === 2) && (
          <div className="zen-ext-intro">
            {ext.error ? (
              <p className="zen-v2-body text-[var(--v2-danger)]">{ext.error}</p>
            ) : (
              ext.description && (
                <p className="zen-v2-body zen-v2-deemphasized">{ext.description}</p>
              )
            )}
            {ext.manifestVersion === 2 && (
              <p className="zen-v2-caption" data-tone="warn">
                Manifest V2 extensions are being retired; check the store for a newer version.
              </p>
            )}
          </div>
        )}

        {/* The cards, 24 apart (§5 card gap). */}
        <div className="flex flex-col gap-6">
          <V2Card title="Permissions" icon={ShieldCheck}>
            <div className="zen-v2-rows">
              {warnings.length === 0 ? (
                <V2Row
                  label={
                    <span className="zen-v2-deemphasized">
                      This extension requires no special permissions
                    </span>
                  }
                />
              ) : (
                warnings.map((warning) => <WarningRow key={warning} warning={warning} />)
              )}
            </div>
            {pending.length > 0 && (
              <p className="zen-v2-caption mt-3" data-tone="warn">
                The last update added {pending.length === 1 ? 'a permission' : 'permissions'}; turn
                the extension on to review {pending.length === 1 ? 'it' : 'them'}.
              </p>
            )}
          </V2Card>

          <V2Card title="Source" icon={Info}>
            <div className="zen-v2-rows">
              <V2Row label="Source">
                {store ? (
                  <a
                    className="zen-v2-link"
                    href={store}
                    title={store}
                    onClick={(e) => {
                      e.preventDefault()
                      run('tab.create', { url: store, active: true })
                      closeOverlay()
                    }}
                  >
                    {sourceLabel(ext.source)}
                    <ArrowUpRight />
                  </a>
                ) : (
                  <Value title={ext.path}>{sourceLabel(ext.source)}</Value>
                )}
              </V2Row>
              <V2Row label="ID">
                <Value tabular>{ext.id}</Value>
              </V2Row>
              <V2Row label="Version">
                <Value tabular>{ext.version}</Value>
              </V2Row>
              <V2Row label="Installed">
                <Value>{formatDate(ext.installedAt)}</Value>
              </V2Row>
              {ext.updatedAt > ext.installedAt && (
                <V2Row label="Updated">
                  <Value>{formatDate(ext.updatedAt)}</Value>
                </V2Row>
              )}
            </div>
          </V2Card>

          <V2Card title="Options" icon={SlidersHorizontal}>
            <div className="zen-v2-rows">
              <V2CheckRow
                label="Allow access to file URLs"
                checked={Boolean(ext.allowFileAccess)}
                disabled={Boolean(ext.error)}
                onChange={(v) => run('extension.setAllowFileAccess', { id: ext.id, allow: v })}
              />
              <V2CheckRow
                label="Allow in private windows"
                description="Not available yet"
                checked={false}
                disabled
                onChange={() => undefined}
              />
            </div>
          </V2Card>
        </div>
      </div>
    </>
  )
}

/** A value at the row's end, deemphasised; ids and versions in tabular figures (no monospace). */
function Value({
  children,
  tabular,
  title
}: {
  children: ReactNode
  tabular?: boolean
  title?: string
}): JSX.Element {
  return (
    <span
      className={`zen-v2-value${tabular ? ' tabular-nums' : ''}`}
      title={title ?? (typeof children === 'string' ? children : undefined)}
    >
      {children}
    </span>
  )
}
