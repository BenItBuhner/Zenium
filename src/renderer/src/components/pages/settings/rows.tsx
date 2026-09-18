import type { JSX, ReactNode } from 'react'
import { ChevronRight, ExternalLink } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import {
  currentOptionLabel,
  groupShows,
  type ActionRow,
  type RowGroup,
  type SettingsRow
} from './model'

/**
 * The phone Settings rows (design language v2 §10.3–10.4) as React: one flat row per model row,
 * 44 tall with one line and 64 with a description, text inset 16, no card, no divider, no
 * background at rest. A row that opens a sheet asks the page for it through `open`; the page
 * owns the sheet stack (`sheets.tsx`) and resolves the row again by id when it draws the sheet.
 */

/** What a row asks the page to open over it. */
export type SheetRequest =
  | { kind: 'options'; rowId: string }
  | { kind: 'field'; rowId: string }
  | { kind: 'confirm'; rowId: string }
  | { kind: 'form'; rowId: string }
  | { kind: 'item'; rowId: string }

export interface RowContext {
  open(request: SheetRequest): void
}

/** The groups of a section (or an item sheet): heading, description, rows, or the empty line. */
export function GroupList({
  groups,
  ctx,
  className
}: {
  groups: readonly RowGroup[]
  ctx: RowContext
  className?: string
}): JSX.Element {
  return (
    <div className={cn('zen-settings-groups', className)}>
      {groups.filter(groupShows).map((group) => (
        <section
          key={group.id}
          className="zen-settings-group"
          aria-label={group.heading ?? undefined}
        >
          {group.heading !== null && <h3 className="zen-settings-heading">{group.heading}</h3>}
          {group.description && (
            <p className="zen-settings-group-description">{group.description}</p>
          )}
          {group.rows.length === 0 ? (
            <p className="zen-settings-empty">{group.empty}</p>
          ) : (
            group.rows.map((row) => <RowView key={row.id} row={row} ctx={ctx} />)
          )}
        </section>
      ))}
    </div>
  )
}

/** One row of any kind; `caption` is the search result's "Category › Group" line above it. */
export function RowView({
  row,
  ctx,
  caption
}: {
  row: SettingsRow
  ctx: RowContext
  caption?: string
}): JSX.Element {
  switch (row.kind) {
    case 'value':
      return (
        <PressableRow
          row={row}
          caption={caption}
          description={currentOptionLabel(row)}
          haspopup="dialog"
          onPress={() => ctx.open({ kind: 'options', rowId: row.id })}
        />
      )
    case 'switch':
      return (
        <PressableRow
          row={row}
          caption={caption}
          description={row.description}
          role="switch"
          checked={row.checked}
          trailing={<span className="zen-settings-switch" aria-hidden="true" />}
          onPress={() => row.onChange(!row.checked)}
        />
      )
    case 'action':
      return (
        <PressableRow
          row={row}
          caption={caption}
          description={row.description}
          destructive={row.destructive}
          haspopup={row.confirm || row.form ? 'dialog' : undefined}
          trailing={<ActionGlyph row={row} />}
          onPress={() => {
            if (row.confirm) ctx.open({ kind: 'confirm', rowId: row.id })
            else if (row.form) ctx.open({ kind: 'form', rowId: row.id })
            else row.onPress?.()
          }}
        />
      )
    case 'field':
      return (
        <PressableRow
          row={row}
          caption={caption}
          description={row.display ?? row.value}
          haspopup="dialog"
          onPress={() => ctx.open({ kind: 'field', rowId: row.id })}
        />
      )
    case 'item':
      return (
        <PressableRow
          row={row}
          caption={caption}
          description={row.description}
          leading={row.leading}
          haspopup="dialog"
          onPress={() => ctx.open({ kind: 'item', rowId: row.id })}
        />
      )
    case 'info':
      return (
        <div className={cn('zen-settings-row', row.disabled && 'zen-settings-row-disabled')}>
          <RowText label={row.label} description={row.description} caption={caption} />
          {row.trailing && <span className="zen-settings-trailing">{row.trailing}</span>}
        </div>
      )
    case 'custom':
      return (
        <div
          className={cn('zen-settings-custom', row.disabled && 'zen-settings-row-disabled')}
          data-row={row.id}
        >
          {caption && <span className="zen-settings-caption">{caption}</span>}
          {row.render()}
        </div>
      )
  }
}

function ActionGlyph({ row }: { row: ActionRow }): JSX.Element | null {
  if (row.leaves === 'external') return <ExternalLink aria-hidden="true" />
  if (row.leaves === 'chevron') return <ChevronRight aria-hidden="true" />
  return null
}

/**
 * The pressable row: the whole row is the target (§10.4), `role="switch"` for a boolean, a
 * dependent row whose parent is off stays laid out at 40 % and takes no press.
 */
function PressableRow({
  row,
  caption,
  description,
  leading,
  trailing,
  role,
  checked,
  haspopup,
  destructive = false,
  onPress
}: {
  row: SettingsRow
  caption?: string
  description?: string
  leading?: ReactNode
  trailing?: ReactNode
  role?: 'switch'
  checked?: boolean
  haspopup?: 'dialog'
  destructive?: boolean
  onPress: () => void
}): JSX.Element {
  const disabled = row.disabled === true
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === 'switch' ? checked : undefined}
      aria-haspopup={haspopup}
      aria-disabled={disabled || undefined}
      data-row={row.id}
      className={cn(
        'zen-settings-row zen-settings-row-pressable zen-v2-row',
        destructive && 'zen-settings-row-danger',
        disabled && 'zen-settings-row-disabled'
      )}
      onClick={() => {
        if (!disabled) onPress()
      }}
    >
      {leading && (
        <span className="zen-settings-leading" aria-hidden="true">
          {leading}
        </span>
      )}
      <RowText label={row.label} description={description} caption={caption} />
      {trailing && <span className="zen-settings-trailing">{trailing}</span>}
    </button>
  )
}

/** Label on the first line, the description under it at 13/69 %, at most two lines (§9.2). */
export function RowText({
  label,
  description,
  caption
}: {
  label: string
  description?: string
  caption?: string
}): JSX.Element {
  return (
    <span className="zen-settings-row-text">
      {caption && <span className="zen-settings-caption">{caption}</span>}
      <span className="zen-settings-label">{label}</span>
      {description && <span className="zen-settings-description">{description}</span>}
    </span>
  )
}
