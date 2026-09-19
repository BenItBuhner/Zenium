import type { JSX, ReactNode, RefCallback } from 'react'
import { ChevronRight, ExternalLink, Loader2 } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import {
  currentOptionLabel,
  groupShows,
  type ActionRow,
  type RowGroup,
  type SettingsRow
} from './model'
import { useSheetDismiss } from './sheetContext'

/**
 * The phone Settings rows (design language v2 §10.3–10.4) as React: one flat row per model row,
 * 44 tall with one line and 64 with a description, text inset 16, no card, no divider, no
 * background at rest. A row that opens a sheet asks the page for it through `open`; the page
 * owns the sheet stack (`sheets.tsx`) and resolves the row again by id when it draws the sheet.
 *
 * Whatever trails the text centres on the row (§9.18) – until the text runs to three lines (a
 * description wrapped, or a search result's caption above the label), when the control centres
 * on the label's line instead. The row measures its own text block for that: `data-lines="3"`
 * and `--zen-settings-label-top` (the label line's offset in the block) go on the row.
 */

/** The row's text block as laid out: three lines or more, and where the label line starts. */
function measureLines(row: HTMLElement): void {
  const text = row.querySelector<HTMLElement>('.zen-settings-row-text')
  const label = text?.querySelector<HTMLElement>('.zen-settings-label')
  if (!text || !label) return
  const line = parseFloat(getComputedStyle(label).lineHeight) || 20
  const block = text.getBoundingClientRect()
  const three = block.height > line * 2.5
  if (three) {
    row.dataset.lines = '3'
    row.style.setProperty(
      '--zen-settings-label-top',
      `${(label.getBoundingClientRect().top - block.top).toFixed(2)}px`
    )
  } else {
    delete row.dataset.lines
    row.style.removeProperty('--zen-settings-label-top')
  }
}

/**
 * Keep a row's line count current: measured once it is on screen and again whenever its text
 * block changes size (the label wraps at a new width, the description changes). Only rows with
 * something trailing the text need it.
 */
const attachLineCount: RefCallback<HTMLElement> = (row) => {
  if (!row) return
  measureLines(row)
  if (typeof ResizeObserver !== 'function') return
  const text = row.querySelector('.zen-settings-row-text')
  if (!text) return
  const observer = new ResizeObserver(() => measureLines(row))
  observer.observe(text)
  return () => observer.disconnect()
}

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
  // The sheet this row sits in, for an action that opens a surface of its own over the page.
  const dismissSheet = useSheetDismiss()
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
          trailing={<span className="zen-v2-switch" aria-hidden="true" />}
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
          busy={row.busy}
          haspopup={row.confirm || row.form ? 'dialog' : undefined}
          trailing={actionGlyph(row)}
          onPress={() => {
            if (row.confirm) ctx.open({ kind: 'confirm', rowId: row.id })
            else if (row.form) ctx.open({ kind: 'form', rowId: row.id })
            else if (row.closesSheet) dismissSheet(() => row.onPress?.())
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
      // Not a target (§9.34): the shared row for its geometry, `data-static` for no fill and no
      // pointer cursor, no role – a div, since static text is not a button.
      return (
        <div
          ref={row.trailing ? attachLineCount : undefined}
          data-row={row.id}
          data-static=""
          className={cn('zen-settings-row zen-v2-row', row.disabled && 'zen-settings-row-disabled')}
        >
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

/** The 16 px glyph that says an action leaves the page (§10.4); nothing for one that stays. */
function actionGlyph(row: ActionRow): JSX.Element | undefined {
  if (row.leaves === 'external') return <ExternalLink aria-hidden="true" />
  if (row.leaves === 'chevron') return <ChevronRight aria-hidden="true" />
  return undefined
}

/**
 * The pressable row: the whole row is the target (§10.4), `role="switch"` for a boolean, a
 * dependent row whose parent is off stays laid out at 40 % and takes no press; a busy action
 * keeps its ink, trails a spinner and takes no press either (§9.30).
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
  busy = false,
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
  busy?: boolean
  onPress: () => void
}): JSX.Element {
  const disabled = row.disabled === true
  const trail = busy ? <Loader2 className="zen-settings-spinner" aria-hidden="true" /> : trailing
  return (
    <button
      ref={trail ? attachLineCount : undefined}
      type="button"
      role={role}
      aria-checked={role === 'switch' ? checked : undefined}
      aria-haspopup={haspopup}
      aria-disabled={disabled || undefined}
      aria-busy={busy || undefined}
      data-row={row.id}
      className={cn(
        'zen-settings-row zen-settings-row-pressable zen-v2-row',
        destructive && 'zen-settings-row-danger',
        disabled && 'zen-settings-row-disabled'
      )}
      onClick={() => {
        if (!disabled && !busy) onPress()
      }}
    >
      {leading && (
        <span className="zen-settings-leading" aria-hidden="true">
          {leading}
        </span>
      )}
      <RowText label={row.label} description={description} caption={caption} />
      {trail && <span className="zen-settings-trailing">{trail}</span>}
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
