import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import { ChevronRight, ExternalLink, Loader2 } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { V2Button } from '../../extensions/v2'
import { V2Menulist } from '../../extensions/V2Menulist'
import { Slider } from '../../ui/slider'
import {
  currentOptionLabel,
  groupShows,
  type ActionRow,
  type FieldRow,
  type RowGroup,
  type SettingsRow,
  type SliderRow,
  type SwitchRow,
  type ValueRow
} from './model'
import { attachLineCount } from './lineCount'
import { useSheetDismiss, type SheetDismiss } from './sheetContext'

/**
 * The Settings rows (design language v2 §10.3–10.5) as React: one flat row per model row, text
 * inset 16, no card, no divider, no background at rest, on the shared `.zen-v2-row` (§9.34).
 *
 * The phone variant (§10.4): 44 tall with one line and 64 with a description; a value row opens
 * a picker sheet, a switch row is the switch, a field row opens a one-field sheet. A row that
 * opens a sheet asks the page for it through `open`; the page owns the sheet stack
 * (`sheets.tsx`) and resolves the row again by id when it draws the sheet.
 *
 * The desktop variant (§10.5, Zen's about:preferences): 32 tall with one line and 52 with a
 * description; a value row trails its 32 px menulist, a boolean is a 16 px checkbox left of its
 * label, a field row holds its field inline, an action with a `button` trails it – the row grows
 * to 40 around a 32 px control (§9.21) – and only a confirmation, a form or an item's rows open
 * a dialog (`dialogs.tsx`), through the same `open`.
 *
 * Whatever trails the text centres on the row (§9.18) – until the text runs to three lines (a
 * description wrapped, or a search result's caption above the label), when the control centres
 * on the label's line instead. The row measures its own text block for that: `data-lines="3"`
 * and `--zen-settings-label-top` (the label line's offset in the block) go on the row.
 */

/** Which of the two row vocabularies a list draws (§10.4 / §10.5). */
export type RowVariant = 'phone' | 'desktop'

/** What a row asks the page to open over it. */
export type SheetRequest =
  | { kind: 'options'; rowId: string }
  | { kind: 'field'; rowId: string }
  | { kind: 'confirm'; rowId: string }
  | { kind: 'form'; rowId: string }
  | { kind: 'item'; rowId: string }
  | { kind: 'detail'; rowId: string }

export interface RowContext {
  open(request: SheetRequest): void
  /**
   * Open the drill-in page an action row names (`ActionRow.page`, §10.2) for the section the
   * row belongs to; the phone layout's (`PhoneSettings`). Absent – the two-pane layout, a test
   * without a page – the row falls back to its `form`.
   */
  openPage?(rowId: string, page: string): void
}

/**
 * The groups of a section (or an item sheet): heading, description, rows, or the empty line.
 * `children` come after the groups, as one more of them (a search's "Other categories").
 */
export function GroupList({
  groups,
  ctx,
  className,
  variant = 'phone',
  children
}: {
  groups: readonly RowGroup[]
  ctx: RowContext
  className?: string
  variant?: RowVariant
  children?: ReactNode
}): JSX.Element {
  return (
    <div className={cn('zen-settings-groups', className)}>
      {groups.filter(groupShows).map((group) => (
        <section
          key={group.id}
          className="zen-settings-group"
          data-group={group.id}
          aria-label={group.heading ?? undefined}
        >
          {group.heading !== null && (
            <h3 className="zen-v2-heading zen-settings-heading">
              {group.heading}
              {group.aside && <span className="zen-settings-heading-aside">{group.aside}</span>}
            </h3>
          )}
          {group.description && (
            <p className="zen-settings-group-description">{group.description}</p>
          )}
          {group.rows.length === 0 ? (
            <p className="zen-settings-empty">{group.empty}</p>
          ) : (
            group.rows.map((row) => <RowView key={row.id} row={row} ctx={ctx} variant={variant} />)
          )}
        </section>
      ))}
      {children}
    </div>
  )
}

/** One row of any kind; `caption` is the search result's "Category › Group" line above it. */
export function RowView({
  row,
  ctx,
  caption,
  variant = 'phone'
}: {
  row: SettingsRow
  ctx: RowContext
  caption?: string
  variant?: RowVariant
}): JSX.Element {
  // The sheet this row sits in, for an action that opens a surface of its own over the page.
  const dismissSheet = useSheetDismiss()
  if (variant === 'desktop')
    return <DesktopRowView row={row} ctx={ctx} caption={caption} dismissSheet={dismissSheet} />
  switch (row.kind) {
    case 'value':
      return (
        <PressableRow
          row={row}
          caption={caption}
          description={currentOptionLabel(row)}
          name={valueRowName(row, caption)}
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
    case 'action': {
      // A row that names a drill-in page leaves for it on the phone layout (§10.2), the chevron
      // saying so; where the page has no way to open one it opens its form as the desktop does.
      const opensPage = row.page !== undefined && ctx.openPage !== undefined
      return (
        <PressableRow
          row={row}
          caption={caption}
          description={row.description}
          leading={row.leading}
          destructive={row.destructive}
          busy={row.busy}
          truncate={row.truncate}
          haspopup={!opensPage && (row.confirm || row.form || row.prompts) ? 'dialog' : undefined}
          trailing={opensPage ? <ChevronRight aria-hidden="true" /> : actionGlyph(row)}
          onPress={() => {
            if (opensPage) ctx.openPage!(row.id, row.page!)
            else if (row.confirm) ctx.open({ kind: 'confirm', rowId: row.id })
            else if (row.form) ctx.open({ kind: 'form', rowId: row.id })
            else if (row.closesSheet) dismissSheet(() => row.onPress?.())
            else row.onPress?.()
          }}
        />
      )
    }
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
    case 'detail':
      // §10.4's detail row: the summary in 13 at 69 % then the 16 px chevron, both trailing.
      return (
        <PressableRow
          row={row}
          caption={caption}
          description={row.description}
          leading={row.leading}
          haspopup="dialog"
          trailing={
            <>
              {row.summary && <span className="zen-settings-summary">{row.summary}</span>}
              <ChevronRight aria-hidden="true" />
            </>
          }
          onPress={() => ctx.open({ kind: 'detail', rowId: row.id })}
        />
      )
    case 'info':
      // Not a target (§9.34): the shared row for its geometry, `data-static` for no fill and no
      // pointer cursor, no role – a div, since static text is not a button. A row whose label
      // is the status takes the danger row class the destructive action has: its label rule
      // puts the ink on the sentence, the description keeps its 69%.
      return (
        <div
          ref={row.trailing ? attachLineCount : undefined}
          data-row={row.id}
          data-static=""
          data-tone={row.tone}
          className={cn(
            'zen-settings-row zen-v2-row',
            row.danger && 'zen-settings-row-danger',
            row.disabled && 'zen-settings-row-disabled',
            row.clamp && 'zen-settings-row-clamp'
          )}
        >
          {row.leading && (
            <span className="zen-settings-leading" aria-hidden="true">
              {row.leading}
            </span>
          )}
          <RowText label={row.label} description={row.description} caption={caption} />
          {row.trailing && <span className="zen-settings-trailing">{row.trailing}</span>}
        </div>
      )
    case 'slider':
      // §10.4's slider row: the value beside the label on the text's first line, the slider on
      // the 40 px line under the text; the block is the row's, so it keeps its 16 px gutter.
      return (
        <div
          className={cn(
            'zen-settings-row zen-settings-slider-row zen-v2-row',
            row.disabled && 'zen-settings-row-disabled'
          )}
          data-row={row.id}
          data-static=""
        >
          <SliderControl row={row} caption={caption} labelled />
        </div>
      )
    case 'custom':
      if (row.bare && !caption) return <>{row.render()}</>
      return (
        <div
          className={cn(
            row.bare ? 'zen-settings-custom-bare' : 'zen-settings-custom',
            row.disabled && 'zen-settings-row-disabled'
          )}
          data-row={row.id}
        >
          {caption && <span className="zen-settings-caption">{caption}</span>}
          {row.render()}
        </div>
      )
  }
}

// ---------------------------------------------------------------------------
// Desktop rows (§10.5)
// ---------------------------------------------------------------------------

/**
 * What pressing an action row (or its button) does: its dialog first, else the action itself –
 * after the sheet it sits in has gone, for an action that opens a surface of its own.
 */
function pressAction(row: ActionRow, ctx: RowContext, dismissSheet: SheetDismiss): void {
  if (row.confirm) ctx.open({ kind: 'confirm', rowId: row.id })
  else if (row.form) ctx.open({ kind: 'form', rowId: row.id })
  else if (row.closesSheet) dismissSheet(() => row.onPress?.())
  else row.onPress?.()
}

/**
 * A model row in the desktop vocabulary. Info and custom rows are the phone's, and so is an item
 * row unless it carries its one `action`, which then trails it as a button in place of a dialog;
 * a value row trails a menulist, a switch row is a check row, a field row holds its field, an
 * action with a `button` trails it and any other action is the whole-row target with its
 * leaving glyph.
 */
function DesktopRowView({
  row,
  ctx,
  caption,
  dismissSheet
}: {
  row: SettingsRow
  ctx: RowContext
  caption?: string
  dismissSheet: SheetDismiss
}): JSX.Element {
  switch (row.kind) {
    case 'value':
      return (
        <ControlRow
          row={row}
          caption={caption}
          description={row.sheetDescription ?? row.description}
        >
          <V2Menulist
            label={row.label}
            value={row.value}
            options={row.options}
            onChange={row.onChange}
            disabled={row.disabled}
            className="zen-settings-menulist"
          />
        </ControlRow>
      )
    case 'switch':
      return <CheckRow row={row} caption={caption} />
    case 'action':
      if (row.button && !row.leaves) {
        return (
          <ControlRow row={row} caption={caption} description={row.description}>
            <V2Button
              variant={row.destructive ? 'danger' : 'secondary'}
              busy={row.busy}
              disabled={row.disabled}
              aria-haspopup={row.confirm || row.form || row.prompts ? 'dialog' : undefined}
              onClick={() => pressAction(row, ctx, dismissSheet)}
            >
              {row.button}
            </V2Button>
          </ControlRow>
        )
      }
      return (
        <PressableRow
          row={row}
          caption={caption}
          description={row.description}
          leading={row.leading}
          destructive={row.destructive}
          busy={row.busy}
          truncate={row.truncate}
          haspopup={row.confirm || row.form || row.prompts ? 'dialog' : undefined}
          trailing={actionGlyph(row)}
          onPress={() => pressAction(row, ctx, dismissSheet)}
        />
      )
    case 'field':
      return (
        <ControlRow row={row} caption={caption} description={row.description}>
          <InlineField row={row} />
        </ControlRow>
      )
    case 'slider':
      // The slider trails the text on the desktop (§9.21), the value as text at its end.
      return (
        <ControlRow row={row} caption={caption} description={row.description}>
          <SliderControl row={row} />
        </ControlRow>
      )
    case 'item':
      // A row that exists to be acted on carries its one action as the trailing 32 button on a
      // mouse and opens no dialog (§10.5); the button is named for the row it acts on, as the
      // viewer's Clear is, since a list of them reads "Remove" many times over.
      if (row.action) {
        const action = row.action
        return (
          <ControlRow row={row} caption={caption} description={row.description}>
            <V2Button
              variant={action.destructive ? 'danger' : 'secondary'}
              busy={action.busy}
              disabled={row.disabled}
              aria-label={`${action.label} ${row.label}`}
              onClick={action.onPress}
            >
              {action.label}
            </V2Button>
          </ControlRow>
        )
      }
      return <RowView row={row} ctx={ctx} caption={caption} />
    default:
      return <RowView row={row} ctx={ctx} caption={caption} />
  }
}

/**
 * The slider of a slider row: the zoom sheet's `zen-zoom-slider` (§10.4) with the value as text
 * beside it, the text following the drag and the row's `onChange` running when the thumb is let
 * go. `labelled` draws the phone block – label and value on the first line, the description,
 * then the slider – where the desktop's control sits in its row's trailing slot.
 */
function SliderControl({
  row,
  caption,
  labelled = false
}: {
  row: SliderRow
  caption?: string
  labelled?: boolean
}): JSX.Element {
  const [local, setLocal] = useState(row.value)
  // The row's value moved under the slider (another window, a reset): follow it.
  const [seen, setSeen] = useState(row.value)
  if (row.value !== seen) {
    setSeen(row.value)
    setLocal(row.value)
  }
  const slider = (
    <Slider
      className="zen-zoom-slider zen-settings-slider"
      aria-label={row.label}
      aria-valuetext={row.format(local)}
      min={row.min}
      max={row.max}
      step={row.step}
      value={[local]}
      disabled={row.disabled}
      onValueChange={([v]) => v !== undefined && setLocal(v)}
      onValueCommit={([v]) => v !== undefined && v !== row.value && row.onChange(v)}
    />
  )
  if (!labelled) {
    return (
      <span className="zen-settings-slider-control">
        {slider}
        <span className="zen-settings-slider-value">{row.format(local)}</span>
      </span>
    )
  }
  return (
    <span className="zen-settings-row-text zen-settings-slider-block">
      {caption && <span className="zen-settings-caption">{caption}</span>}
      <span className="zen-settings-slider-head">
        <span className="zen-settings-label">{row.label}</span>
        <span className="zen-settings-slider-value">{row.format(local)}</span>
      </span>
      {row.description && <span className="zen-settings-description">{row.description}</span>}
      {slider}
    </span>
  )
}

/**
 * A static row that carries a control (§9.21): label and description as the text block, the
 * 32 px control trailing, centred; the row is 40 around it – 4 px of its own padding above and
 * below rather than a list gap, so rows still touch. `data-static` keeps the row's fill off: the
 * control is the target, not the row. Disabled as a dependent row, the row takes §9.30's one .4
 * and its control keeps `disabled` for what it does but not its own .4 on top
 * (`.zen-settings-row-disabled .zen-v2-button:disabled { opacity: 1 }` and its siblings in
 * main.css, the Radix slider's `[data-disabled]` among them), so a shortcut row's Up button or
 * the Share of installed RAM slider reads at .4, not .16.
 */
function ControlRow({
  row,
  caption,
  description,
  children
}: {
  row: SettingsRow
  caption?: string
  description?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div
      ref={attachLineCount}
      data-row={row.id}
      data-static=""
      data-tone={row.tone}
      className={cn(
        'zen-settings-row zen-settings-control-row zen-v2-row',
        row.disabled && 'zen-settings-row-disabled'
      )}
    >
      <RowText label={row.label} description={description} caption={caption} />
      <span className="zen-settings-trailing zen-settings-control">{children}</span>
    </div>
  )
}

/**
 * A boolean on the desktop (§10.5, §6): Zen's 16 px checkbox left of the label, the description
 * under the label; the whole row is the checkbox's label, so a press anywhere on it toggles.
 * Disabled as a dependent row, the check-row primitive puts the .4 on the row's content (§9.30)
 * and `aria-disabled` keeps the row's fill off.
 */
function CheckRow({ row, caption }: { row: SwitchRow; caption?: string }): JSX.Element {
  const disabled = row.disabled === true
  return (
    <label
      data-row={row.id}
      className="zen-settings-row zen-settings-check-row zen-v2-row zen-v2-check-row"
      aria-disabled={disabled || undefined}
    >
      <input
        type="checkbox"
        className="zen-v2-checkbox"
        checked={row.checked}
        disabled={disabled}
        onChange={(e) => row.onChange(e.target.checked)}
      />
      <RowText label={row.label} description={row.description} caption={caption} />
    </label>
  )
}

/**
 * A desktop input in its row (§9.12): the row's value edited in place and committed on Enter
 * or when the field loses focus; Escape puts the row's value back. A commit the row refuses
 * keeps the typed value, marks the field and shows the message where the description was.
 */
function InlineField({ row }: { row: FieldRow }): JSX.Element {
  const [value, setValue] = useState(row.value)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  // A commit that settles later (§9.30): the field keeps the typed value, read-only, until it does.
  const [busy, setBusy] = useState(false)
  // The row's value moved under the field (another window, a reset): follow it unless typing.
  const [seen, setSeen] = useState(row.value)
  if (row.value !== seen) {
    setSeen(row.value)
    if (!editing) setValue(row.value)
  }
  const settle = (message: string | undefined): void => {
    setError(message ?? null)
    if (message) setEditing(true)
  }
  const commit = (): void => {
    if (busy) return
    setEditing(false)
    if (value === row.value) {
      setError(null)
      return
    }
    const result = row.onCommit(value)
    if (result instanceof Promise) {
      setBusy(true)
      void result.then(settle, (e: unknown) => settle(String(e))).finally(() => setBusy(false))
    } else settle(result)
  }
  return (
    <span className="zen-settings-inline-field">
      <input
        className={cn(
          'zen-settings-input zen-v2-field',
          row.input === 'number' ? 'zen-settings-field-number' : 'zen-settings-field-text',
          row.secret && 'zen-settings-field-secret'
        )}
        type={row.input === 'number' ? 'number' : 'text'}
        inputMode={row.input === 'number' ? 'numeric' : 'text'}
        min={row.min}
        max={row.max}
        placeholder={row.placeholder}
        aria-label={row.label}
        aria-invalid={error ? true : undefined}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={row.disabled}
        readOnly={busy}
        aria-busy={busy || undefined}
        value={value}
        onFocus={() => setEditing(true)}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            setValue(row.value)
            setError(null)
            setEditing(false)
            e.currentTarget.blur()
          }
        }}
      />
      {error && (
        <span className="zen-settings-inline-error" role="alert">
          {error}
        </span>
      )}
    </span>
  )
}

/**
 * The one name a phone value row speaks: "label, value" (#237's audit had TalkBack run the two
 * together, "Colour scheme Light"), the search result's caption first where the row shows one,
 * as its contents read. Set as the button's label rather than left to its contents: a name from
 * an attribute on a button – which an `aria-haspopup="dialog"` row stays – is the content
 * description on Android's bridge, over the child text, so the row is spoken once and with the
 * pause; a toggle or menu button would have it in the supplemental description instead
 * (`barItems.tsx`, the Tabs button's note).
 */
function valueRowName(row: ValueRow, caption?: string): string {
  return [caption, row.label, currentOptionLabel(row)].filter(Boolean).join(', ')
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
 * keeps its ink, trails a spinner and takes no press either (§9.30). The row is named by its
 * contents unless `name` says otherwise (a value row's "label, value").
 */
function PressableRow({
  row,
  caption,
  description,
  name,
  leading,
  trailing,
  role,
  checked,
  haspopup,
  destructive = false,
  busy = false,
  truncate = false,
  onPress
}: {
  row: SettingsRow
  caption?: string
  description?: string
  name?: string
  leading?: ReactNode
  trailing?: ReactNode
  role?: 'switch'
  checked?: boolean
  haspopup?: 'dialog'
  destructive?: boolean
  busy?: boolean
  truncate?: boolean
  onPress: () => void
}): JSX.Element {
  const disabled = row.disabled === true
  const trail = busy ? <Loader2 className="zen-settings-spinner" aria-hidden="true" /> : trailing
  return (
    <button
      ref={trail ? attachLineCount : undefined}
      type="button"
      role={role}
      aria-label={name}
      aria-checked={role === 'switch' ? checked : undefined}
      aria-haspopup={haspopup}
      aria-disabled={disabled || undefined}
      aria-busy={busy || undefined}
      data-row={row.id}
      data-tone={row.tone}
      className={cn(
        'zen-settings-row zen-settings-row-pressable zen-v2-row',
        destructive && 'zen-settings-row-danger',
        disabled && 'zen-settings-row-disabled',
        truncate && 'zen-settings-row-truncate'
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

/**
 * Label on the first line, the description under it at 13/69 %, at most two lines (§9.2) – in
 * a §1 status ink when the row carries a `tone` (`data-tone` on the row, the primitive's one
 * attribute; the description's rule reads it through the row).
 */
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
