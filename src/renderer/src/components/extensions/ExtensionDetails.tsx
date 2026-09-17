import type { JSX } from 'react'
import { ArrowUpRight, ChevronLeft, Ellipsis } from 'lucide-react'
import type { ExtensionInfo, Rect } from '@shared/types'
import { anchorOf } from '@renderer/lib/anchor'
import { run } from '@renderer/lib/api'
import { formatBytes, formatDate } from '@renderer/lib/extensions/format'
import { sourceLabel, storePageUrl } from '@renderer/lib/extensions/storeInput'
import { closeOverlay } from '@renderer/lib/ui'
import { Group, Note, Row } from '../overlays/SettingsPrimitives'
import { Switch } from '../ui/switch'
import { ExtensionIcon } from './ExtensionIcon'
import { WarningRow } from './WarningRow'

/**
 * One extension, pushed in over the list (design-language.md §8.7 back header, §8.2 groups):
 * the description, then Permissions, Source and Options as groups 16px apart.
 */
export function ExtensionDetails({
  ext,
  onBack,
  onMenu
}: {
  ext: ExtensionInfo
  onBack: () => void
  onMenu: (anchor: Rect) => void
}): JSX.Element {
  const warnings = ext.warnings ?? []
  const store = storePageUrl(ext.source, ext.id)
  return (
    <div className="zen-drawer-right flex flex-col gap-4">
      <header className="zen-ext-header">
        <button
          type="button"
          className="zen-toolbar-button -ml-1"
          title="Back"
          aria-label="Back to extensions"
          onClick={onBack}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <ExtensionIcon icon={ext.icon} size={20} box={28} />
        <h3 className="zen-ext-title">{ext.name || ext.id}</h3>
        <Switch
          checked={ext.enabled}
          aria-label={`${ext.name} enabled`}
          onCheckedChange={(v) => run('extension.setEnabled', { id: ext.id, enabled: v })}
        />
        <button
          type="button"
          className="zen-toolbar-button"
          title="More"
          aria-label="More actions"
          aria-haspopup="menu"
          onClick={(e) => onMenu(anchorOf(e.currentTarget))}
        >
          <Ellipsis className="h-4 w-4" />
        </button>
      </header>
      {ext.error ? (
        <p className="px-2.5 text-[13px] leading-[1.4] text-[var(--zen-danger)]">{ext.error}</p>
      ) : (
        ext.description && <p className="zen-ext-description px-2.5">{ext.description}</p>
      )}
      {ext.manifestVersion === 2 && (
        <p className="zen-ext-caption-warn px-2.5">
          Manifest V2 extensions are being retired; check the store for a newer version.
        </p>
      )}

      <Group title="Permissions">
        {warnings.length === 0 ? (
          <Note>This extension requires no special permissions</Note>
        ) : (
          warnings.map((warning) => <WarningRow key={warning} warning={warning} />)
        )}
      </Group>

      <Group title="Source">
        {store ? (
          <a
            className="zen-settings-row zen-ext-link"
            href={store}
            onClick={(e) => {
              e.preventDefault()
              run('tab.create', { url: store, active: true })
              closeOverlay()
            }}
          >
            <span className="zen-settings-text">
              <span className="zen-settings-label">{sourceLabel(ext.source)}</span>
            </span>
            <ArrowUpRight className="h-4 w-4 shrink-0 text-[var(--zen-muted)]" />
          </a>
        ) : (
          <ValueRow label="Source" value={sourceLabel(ext.source)} title={ext.path} />
        )}
        <ValueRow label="Id" value={ext.id} tabular />
        <ValueRow label="Version" value={ext.version} tabular />
        {ext.installedAt !== undefined && (
          <ValueRow label="Installed" value={formatDate(ext.installedAt)} />
        )}
        {ext.sizeBytes !== undefined && ext.sizeBytes > 0 && (
          <ValueRow label="Size" value={formatBytes(ext.sizeBytes)} tabular />
        )}
      </Group>

      <Group title="Options">
        <Row label="Allow access to file URLs">
          <Switch
            checked={Boolean(ext.allowFileAccess)}
            disabled={Boolean(ext.error)}
            onCheckedChange={(v) => run('extension.setAllowFileAccess', { id: ext.id, allow: v })}
          />
        </Row>
        <Row label="Allow in private windows" hint="Not available yet">
          <Switch checked={false} disabled />
        </Row>
      </Group>
    </div>
  )
}

/** A label with a value at the right (§8.2 trailing value 13 fg 60%). */
function ValueRow({
  label,
  value,
  tabular,
  title
}: {
  label: string
  value: string
  tabular?: boolean
  title?: string
}): JSX.Element {
  return (
    <div className="zen-settings-row">
      <span className="zen-settings-text">
        <span className="zen-settings-label">{label}</span>
      </span>
      <span
        className={`zen-ext-value truncate${tabular ? ' tabular-nums' : ''}`}
        title={title ?? value}
      >
        {value}
      </span>
    </div>
  )
}
