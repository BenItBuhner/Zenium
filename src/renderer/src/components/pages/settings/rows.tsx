import type {
  FocusEvent,
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode
} from 'react'
import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react'
import { ChevronRight, Ellipsis, ExternalLink, Loader2, Minus, Plus } from 'lucide-react'
import { anchorOf, type Anchor } from '@renderer/lib/anchor'
import { run } from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'
import type { InternalPageQuery } from '@shared/internalPages'
import { V2Button, V2IconButton } from '../../extensions/v2'
import { V2Menulist } from '../../extensions/V2Menulist'
import { LocalMenu } from '../../menus/LocalMenu'
import { useLongPress, type LongPressHandlers } from '../../phone/useLongPress'
import { Slider } from '../../ui/slider'
import {
  controlledRuns,
  currentOptionLabel,
  groupShows,
  itemMenuItems,
  type ActionRow,
  type CustomRow,
  type FieldRow,
  type InfoRow,
  type RowControl,
  type RowCopy,
  type RowGroup,
  type RowMenu,
  type SettingsRow,
  type SliderRow,
  type SwitchRow,
  type ValueRow
} from './model'
import { RadioOption, ValidationMessage } from './blocks'
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
 * description wrapped, or a search result's caption above the label), when the control sits
 * with the label instead: on its line, or, taller than the line, with the label centred on
 * the control's box and the description after it. The row measures its own text block for
 * that: `data-lines="3"` and `--zen-settings-label-top` (the label's offset in the block) go
 * on the row; which box its control is, the row says by its class (main.css).
 */

/** Which of the two row vocabularies a list draws (§10.4 / §10.5). */
export type RowVariant = 'phone' | 'desktop'

/** What a row asks the page to open over it. */
export type SheetRequest =
  | { kind: 'options'; rowId: string }
  | { kind: 'field'; rowId: string }
  /**
   * `from`: the row whose control opened the prompt or the form when that is not the row itself
   * – an item row's ⋯ picking one of its sheet's confirming actions or its form (§10.5); the
   * focus goes back to that row's control, the ⋯, as the dialog leaves (§9.5).
   */
  | { kind: 'confirm'; rowId: string; from?: string }
  | { kind: 'form'; rowId: string; from?: string }
  | { kind: 'item'; rowId: string }
  | { kind: 'detail'; rowId: string }

export interface RowContext {
  open(request: SheetRequest): void
  /**
   * Open the drill-in page an action row names (`ActionRow.page`, §10.2) for the section the
   * row belongs to, with the row's `pageQuery` in the page's address (which list an Add row
   * adds to); the phone layout's (`PhoneSettings`). Absent – the two-pane layout, a test
   * without a page – the row falls back to its `form`.
   */
  openPage?(rowId: string, page: string, query?: InternalPageQuery): void
}

/**
 * The level of a group's heading in the page's outline, which steps by one from the heading
 * above it (axe `heading-order`): `3` under the desktop pane's `h2` section title and under a
 * sheet's or dialog's `h2` title block; `2` on the phone's drill-in page, whose bar is the
 * page's `h1` and which has no section title between the bar and the groups (#391's
 * pre-existing `heading-order` on the phone layout). The styles hang on the class, not the tag.
 */
export type GroupHeadingLevel = 2 | 3

/** A group's heading (§9.27) at its outline level; the classes are the same at either. */
export function GroupHeading({
  level,
  className,
  children
}: {
  level: GroupHeadingLevel
  className?: string
  children: ReactNode
}): JSX.Element {
  const Tag = level === 2 ? 'h2' : 'h3'
  return <Tag className={cn('zen-v2-heading zen-settings-heading', className)}>{children}</Tag>
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
  headingLevel = 3,
  children
}: {
  groups: readonly RowGroup[]
  ctx: RowContext
  className?: string
  variant?: RowVariant
  /** The groups' heading level (`GroupHeadingLevel`); 3 unless the list stands right under a page's `h1`. */
  headingLevel?: GroupHeadingLevel
  children?: ReactNode
}): JSX.Element {
  return (
    <div className={cn('zen-settings-groups', className)}>
      {groups.filter(groupShows).map((group) => (
        // A group is not a landmark: named by its heading, it would be a `region` – one per
        // group, and the Search section's first group, "Search", would double the pane's own
        // (axe `landmark-unique`, the desktop's #358). `group` keeps the name off the landmarks.
        <section
          key={group.id}
          role="group"
          className="zen-settings-group"
          data-group={group.id}
          aria-label={group.heading ?? undefined}
        >
          {group.heading !== null && (
            <GroupHeading level={headingLevel}>
              {group.heading}
              {group.aside && <span className="zen-settings-heading-aside">{group.aside}</span>}
            </GroupHeading>
          )}
          {group.description && (
            <p className="zen-settings-group-description">{group.description}</p>
          )}
          {group.rows.length === 0 ? (
            <p className="zen-settings-empty">{group.empty}</p>
          ) : (
            <GroupRows rows={group.rows} ctx={ctx} variant={variant} />
          )}
        </section>
      ))}
      {children}
    </div>
  )
}

/**
 * A group's rows in order, each under the builder's hairline where it has one
 * (`RowBase.hairline`: the landing's run separator, never over a group's first row), and the
 * rows an extension holds followed by their indicator – one per run of consecutive rows the
 * same extension holds (`controlledRuns`), after the run, so an extension that holds every
 * font row does not double the group (§10.3's density; the §10.5 primitive's rule).
 */
function GroupRows({
  rows,
  ctx,
  variant
}: {
  rows: readonly SettingsRow[]
  ctx: RowContext
  variant: RowVariant
}): JSX.Element {
  const runs = controlledRuns(rows)
  return (
    <>
      {rows.map((row, index) => (
        <Fragment key={row.id}>
          {index > 0 && row.hairline && <hr className="zen-settings-hairline" />}
          <RowView row={row} ctx={ctx} variant={variant} indicator={runs[index]} />
        </Fragment>
      ))}
    </>
  )
}

/**
 * One row of any kind; `caption` is the search result's "Category › Group" line above it. A row
 * an extension holds (`RowBase.controlled`) is drawn as a dependent row – its control disabled
 * showing the value in effect, at .4, no press (§10.4) – with the indicator row after it, the
 * way out, for the run of held rows it closes: `indicator` is that run's length as
 * `controlledRuns` counts it (0 inside a run that goes on, so the run's last row carries the
 * one indicator); left out, the row stands alone – a search result, a form's list – and the
 * indicator is its own.
 */
export function RowView({
  indicator,
  ...props
}: {
  row: SettingsRow
  ctx: RowContext
  caption?: string
  variant?: RowVariant
  indicator?: number
}): JSX.Element {
  const control = props.row.controlled
  if (!control) return <PlainRowView {...props} />
  const held: SettingsRow = { ...props.row, controlled: undefined, disabled: true }
  const count = indicator ?? 1
  return (
    <>
      <PlainRowView {...props} row={held} />
      {count > 0 && (
        <ControlledRow
          row={props.row}
          control={control}
          count={count}
          variant={props.variant ?? 'phone'}
        />
      )}
    </>
  )
}

/**
 * The indicator after a row – or a run of rows – an extension holds (Chrome's
 * extension-controlled indicator in the settings rows' own form; §10.5's controlled-setting
 * primitive): "Controlled by <name>" as the row's 15/400 label in the text ink – full ink,
 * since it is the way out and never under the held row's .4 (§9.30 as amended on #299) – the
 * extension's name as it names itself; under it "An extension sets this. Disable it to use
 * your own value." ("An extension sets these." after a run of more than one); and one trailing
 * control (§9.18 centres one thing in the trailing slot; §10.4 gives a row one control – so
 * no glyph beside it, the words carry what a puzzle glyph said). On the desktop the control is
 * the 32 secondary button reading Disable – its object is the row's subject and the
 * description's "it", so never "Disable extension" – named "Disable <name>" for a reader,
 * since a page may hold several; disabling an extension destroys nothing – the Extensions
 * page turns it back on – so nothing confirms, as Chrome's button asks nothing. On the phone
 * the row is a §10.4 action row with a chevron opening the extension's own page, where its
 * switch is (`RowControl.onManage`): no inline button, and no row that disables on a tap,
 * which would be too easy to hit. The row is the twin in id of the held row it follows
 * (`<id>-controlled`) and comes back with it.
 */
function ControlledRow({
  row,
  control,
  count,
  variant
}: {
  row: SettingsRow
  control: RowControl
  /** The rows of the run this indicator stands for: the words are plural past 1. */
  count: number
  variant: RowVariant
}): JSX.Element {
  const indicator: InfoRow = {
    kind: 'info',
    id: `${row.id}-controlled`,
    label: `Controlled by ${control.name}`
  }
  const description =
    count > 1
      ? 'An extension sets these.'
      : 'An extension sets this. Disable it to use your own value.'
  if (variant === 'desktop') {
    return (
      <ControlRow row={indicator} description={description}>
        <V2Button
          variant="secondary"
          aria-label={`Disable ${control.name}`}
          onClick={control.onDisable}
        >
          Disable
        </V2Button>
      </ControlRow>
    )
  }
  return (
    <PressableRow
      row={indicator}
      description={description}
      trailing={<ChevronRight aria-hidden="true" />}
      onPress={control.onManage}
    />
  )
}

function PlainRowView({
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
          leading={row.leading}
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
            if (opensPage) ctx.openPage!(row.id, row.page!, row.pageQuery)
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
      return <InfoRowView row={row} caption={caption} />
    case 'slider':
      // §10.4's slider row: the value on the label's line, the description, then the 44 px step
      // buttons with the track between them; the block is the row's, so it keeps its 16 px gutter.
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
      return <CustomRowView row={row} caption={caption} />
  }
}

/**
 * A long-press on a row copies its text (`RowCopy`, SET-54): the hold's handlers for the row's
 * element, or none when the row copies nothing – and the click the release raises, swallowed,
 * so a row that is also a target does not fire on the lift. The copy is the core's
 * (`clipboard.writeText`), whose toast – or Android 13's clipboard chip – says the word.
 */
function useCopyOnHold(copy: RowCopy | undefined): {
  handlers: Partial<LongPressHandlers>
  onClick?: (e: ReactMouseEvent<HTMLElement>) => void
} {
  const press = useLongPress(() => {
    if (copy) run('clipboard.writeText', { text: copy.text, confirmation: copy.confirmation })
  })
  if (!copy) return { handlers: {} }
  return {
    handlers: press.handlers,
    onClick: (e) => {
      if (press.swallowsClick()) e.preventDefault()
    }
  }
}

/**
 * The info row: not a target (§9.34) – the shared row for its geometry, `data-static` for no
 * fill and no pointer cursor, no role – a div, since static text is not a button. A row whose
 * label is the status takes the danger row class the destructive action has: its label rule
 * puts the ink on the sentence, the description keeps its 69%. A row with a `copy` copies it
 * on a long-press; `data-copies` marks it for the readers that need to find such a row – the
 * preview host's `hold:` finder and the tests – and no style hangs on it (the chrome root's
 * `user-select: none` already keeps the hold from raising a selection).
 */
function InfoRowView({ row, caption }: { row: InfoRow; caption?: string }): JSX.Element {
  const hold = useCopyOnHold(row.copy)
  return (
    <div
      ref={row.trailing ? attachLineCount : undefined}
      data-row={row.id}
      data-static=""
      data-tone={row.tone}
      data-copies={row.copy ? '' : undefined}
      className={cn(
        'zen-settings-row zen-v2-row',
        row.danger && 'zen-settings-row-danger',
        row.disabled && 'zen-settings-row-disabled',
        row.clamp && 'zen-settings-row-clamp'
      )}
      {...hold.handlers}
      onClick={hold.onClick}
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
}

/** A custom block, in its padding unless `bare`; with a `copy`, wrapped for the hold either way. */
function CustomRowView({ row, caption }: { row: CustomRow; caption?: string }): JSX.Element {
  const hold = useCopyOnHold(row.copy)
  if (row.bare && !caption && !row.copy) return <>{row.render()}</>
  return (
    <div
      className={cn(
        row.bare ? 'zen-settings-custom-bare' : 'zen-settings-custom',
        row.disabled && 'zen-settings-row-disabled'
      )}
      data-row={row.id}
      data-copies={row.copy ? '' : undefined}
      {...hold.handlers}
      onClick={hold.onClick}
    >
      {caption && <span className="zen-settings-caption">{caption}</span>}
      {row.render()}
    </div>
  )
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
 * row unless it carries its one `action`, which then trails it as a button in place of a dialog,
 * or its `menu`, the 28 ⋯ over its sheet's actions; a value row trails a menulist, a switch row
 * is a check row, a field row holds its field, an action with a `button` trails it and any
 * other action is the whole-row target with its leaving glyph.
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
      if (row.radios) return <RadioListRow row={row} caption={caption} />
      return <MenulistRow row={row} caption={caption} />
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
      if (row.form === 'stacked') return <StackedFieldRow row={row} caption={caption} />
      return <InlineFieldRow row={row} caption={caption} />
    case 'slider':
      return <DesktopSliderRow row={row} caption={caption} />
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
      // Several actions and nothing to set (§10.5): the row is static and trails the 28 ⋯ whose
      // menu is its sheet's action rows; on one line it is a control row (§9.21: the button plus
      // 8 – `data-control`, as `ListRow control` marks it); `zen-settings-menu-row` names the
      // button's box for the three-line seat (§9.18, main.css).
      if (row.menu !== undefined) {
        return (
          <div
            ref={attachLineCount}
            data-row={row.id}
            data-static=""
            data-tone={row.tone}
            data-control={!row.description && !caption ? '' : undefined}
            className={cn(
              'zen-settings-row zen-settings-menu-row zen-v2-row',
              row.disabled && 'zen-settings-row-disabled'
            )}
          >
            {row.leading && (
              <span className="zen-settings-leading" aria-hidden="true">
                {row.leading}
              </span>
            )}
            <RowText label={row.label} description={row.description} caption={caption} />
            <span className="zen-settings-trailing zen-settings-control">
              <RowMenuButton
                menu={{
                  label: row.menu,
                  // A confirming action opens its prompt over the page, a form its dialog; the
                  // ⋯ is the way back from either.
                  items: itemMenuItems(
                    row,
                    (action) => ctx.open({ kind: 'confirm', rowId: action.id, from: row.id }),
                    (action) => ctx.open({ kind: 'form', rowId: action.id, from: row.id })
                  )
                }}
                title={row.label}
                disabled={row.disabled}
              />
            </span>
          </div>
        )
      }
      return <RowView row={row} ctx={ctx} caption={caption} />
    default:
      return <RowView row={row} ctx={ctx} caption={caption} />
  }
}

/*
 * A control beside its text is bound to the row's visible label (§9.12's association, the
 * #453 lead check's sweep): a native field by the label's `<label for>`, a control that is a
 * button – the menulist, the slider's thumb – by `aria-labelledby` on the label's id. The
 * control's name is the label's text as it was under its `aria-label`; what changes is that
 * one element names it, so a reader reads one name and a click on a native field's label lands
 * in the field. The rows below hold the ids (`useId`) the row and its control share.
 */

/** A value row on the desktop (§10.5): the text, then its 32 px menulist named by the label. */
function MenulistRow({ row, caption }: { row: ValueRow; caption?: string }): JSX.Element {
  const labelId = `${useId()}-label`
  return (
    <ControlRow
      row={row}
      caption={caption}
      description={row.sheetDescription ?? row.description}
      labelId={labelId}
    >
      <V2Menulist
        label={row.label}
        labelledBy={labelId}
        value={row.value}
        options={row.options}
        onChange={row.onChange}
        disabled={row.disabled}
        className="zen-settings-menulist"
      />
    </ControlRow>
  )
}

/**
 * A value row in the radio form (`ValueRow.radios`; §9.14, §10.5): the text block – the label,
 * the description – then under it a `radiogroup` of the picker's radio rows (`RadioOption`)
 * across the row's content width, named by the row's label (`aria-labelledby`), as Chrome's
 * Performance page seats Memory Saver's tiers under its toggle. The keyboard is a native
 * group's: the checked option is the group's one tab stop (roving `tabIndex`; the first option
 * where none is checked) and the arrow keys move the choice to the next or previous option,
 * wrapping, and the focus with it. The row is a column as the stacked field row is
 * (`.zen-settings-stacked-row`, its block's 4 between the text and the list), `data-static`
 * since the options are the targets, and disabled as a dependent row at .4 with its options
 * taking no press (§10.4).
 */
function RadioListRow({ row, caption }: { row: ValueRow; caption?: string }): JSX.Element {
  const labelId = `${useId()}-label`
  const group = useRef<HTMLDivElement>(null)
  const checkedAt = Math.max(
    0,
    row.options.findIndex((option) => option.value === row.value)
  )
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (row.disabled) return
    const step =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? 1
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? -1
          : 0
    if (step === 0 || row.options.length === 0) return
    e.preventDefault()
    const at = (checkedAt + step + row.options.length) % row.options.length
    const next = row.options[at]
    if (!next) return
    if (next.value !== row.value) row.onChange(next.value)
    group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[at]?.focus()
  }
  return (
    <div
      data-row={row.id}
      data-static=""
      data-tone={row.tone}
      className={cn(
        'zen-settings-row zen-settings-stacked-row zen-settings-radios-row zen-v2-row',
        row.disabled && 'zen-settings-row-disabled'
      )}
    >
      <div className="zen-settings-field-block">
        <RowText
          label={row.label}
          labelId={labelId}
          description={row.sheetDescription ?? row.description}
          caption={caption}
        />
        <div
          ref={group}
          role="radiogroup"
          aria-labelledby={labelId}
          aria-disabled={row.disabled || undefined}
          className="zen-settings-radio-list zen-settings-radios"
          onKeyDown={onKeyDown}
        >
          {row.options.map((option, index) => (
            <RadioOption
              key={option.value}
              label={option.label}
              description={option.description}
              leading={option.leading}
              font={option.font}
              checked={option.value === row.value}
              tabIndex={index === checkedAt ? 0 : -1}
              disabled={row.disabled}
              onSelect={() => {
                if (option.value !== row.value) row.onChange(option.value)
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/** A field row in the inline form (§9.12, §10.5): the field trails the text as the label's `<label for>`. */
function InlineFieldRow({ row, caption }: { row: FieldRow; caption?: string }): JSX.Element {
  const fieldId = `${useId()}-field`
  return (
    <ControlRow row={row} caption={caption} description={row.description} labelFor={fieldId}>
      <InlineField row={row} fieldId={fieldId} />
    </ControlRow>
  )
}

/** A slider row on the desktop: the slider trails the text (§9.21), the value as text at its end. */
function DesktopSliderRow({ row, caption }: { row: SliderRow; caption?: string }): JSX.Element {
  const labelId = `${useId()}-label`
  return (
    <ControlRow row={row} caption={caption} description={row.description} labelId={labelId}>
      <SliderControl row={row} labelledBy={labelId} />
    </ControlRow>
  )
}

/** A held step button (§10.4) waits this long before it repeats, then steps at this interval. */
const HOLD_REPEAT_DELAY_MS = 400
const HOLD_REPEAT_INTERVAL_MS = 100

/**
 * The slider of a slider row: the zoom sheet's `zen-zoom-slider` with the value as text, the
 * text following the drag and the row's `onChange` running when the thumb is let go. `labelled`
 * draws §10.4's phone row – the label with the value on its line in `tabular-nums`, the
 * description, then the 44 px − and + step buttons with the track between them (the Default
 * zoom block's stepper form, one step of the row's `step` per press, a hold repeating it), no
 * labels under the track's ends – where the desktop's control sits in its row's trailing slot.
 *
 * The control tells the row when it is left (`SliderRow.onLeave`): the focus moving out of it
 * – to another row's button, as a finger lands there – and its unmount, the sheet closing or
 * the drill-in leaving with it. A builder that coalesces the row's steps commits on either
 * (the fonts group's draft), so a close inside the quiet window loses no step.
 *
 * The slider's thumb (`role="slider"`) is named by the row's visible label through
 * `aria-labelledby` (§9.12's association): `labelled`, the head's own label; on the desktop,
 * the row's label by `labelledBy` (`DesktopSliderRow`). The name is the label's text either way.
 */
function SliderControl({
  row,
  caption,
  labelled = false,
  labelledBy
}: {
  row: SliderRow
  caption?: string
  labelled?: boolean
  /** The id of the row's label, for the desktop's control in the row's trailing slot. */
  labelledBy?: string
}): JSX.Element {
  const headLabelId = `${useId()}-label`
  const [local, setLocal] = useState(row.value)
  // The row's value moved under the slider (another window, a reset): follow it.
  const [seen, setSeen] = useState(row.value)
  if (row.value !== seen) {
    setSeen(row.value)
    setLocal(row.value)
  }
  const leave = useRef(row.onLeave)
  useEffect(() => {
    leave.current = row.onLeave
  })
  useEffect(() => () => leave.current?.(), [])
  // The focus left the control for somewhere outside it; − to + within it is not a leave.
  const onBlur = (e: FocusEvent<HTMLElement>): void => {
    const to = e.relatedTarget
    if (!(to instanceof Node) || !e.currentTarget.contains(to)) row.onLeave?.()
  }
  const slider = (
    <Slider
      className={cn('zen-zoom-slider zen-settings-slider', labelled && 'min-w-0 flex-1')}
      aria-labelledby={labelled ? headLabelId : labelledBy}
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
      <span className="zen-settings-slider-control" onBlur={onBlur}>
        {slider}
        <span className="zen-settings-slider-value">{row.format(local)}</span>
      </span>
    )
  }
  return (
    <span className="zen-settings-row-text zen-settings-slider-block" onBlur={onBlur}>
      {caption && <span className="zen-settings-caption">{caption}</span>}
      <span className="zen-settings-slider-head">
        <span id={headLabelId} className="zen-settings-label">
          {row.label}
        </span>
        <span className="zen-settings-slider-value">{row.format(local)}</span>
      </span>
      {row.description && <span className="zen-settings-description">{row.description}</span>}
      <span className="zen-zoom-stepper zen-settings-slider-stepper flex items-center">
        <StepButton row={row} value={local} direction={-1} />
        {slider}
        <StepButton row={row} value={local} direction={1} />
      </span>
    </span>
  )
}

/**
 * One of the phone slider row's two 44 px step buttons (§10.4): the shared icon button, named
 * for what it does to the row ("Decrease Font size"), disabled at the ladder's end with the
 * row's own .4 rule keeping one opacity. A press steps once (`row.onChange` with the next stop:
 * a commit at once for a row like the zoom block's, a step of the page's draft for a row that
 * coalesces – the fonts rows, whose commit follows the quiet after the sequence); a hold
 * repeats the step (`HOLD_REPEAT_*`) until the finger lifts or leaves, each repeat the same
 * `onChange`, so a coalescing row commits a hold once, at its end. The pointer's press is the
 * step, so the `click` a pointer sends after it – `detail`
 * 1, its tap or click count – is not one: on Android a tap's click is the gesture detector's
 * own event, arriving after `pointerup` by as much as the WebView's frame allows, so nothing
 * that keys off time may stand between them (emulator run 35815936330 read three taps of seven
 * twice). The keyboard's press (Enter, Space) and an assistive technology's activation are the
 * click with no pointer before it – `detail` 0 – and step once.
 */
function StepButton({
  row,
  value,
  direction
}: {
  row: SliderRow
  value: number
  direction: -1 | 1
}): JSX.Element {
  const step = (): void => {
    const next = Math.min(row.max, Math.max(row.min, value + direction * row.step))
    if (next !== row.value) row.onChange(next)
  }
  // The hold's timers step from the latest value, not the one the press rendered with.
  const latest = useRef(step)
  useEffect(() => {
    latest.current = step
  })
  const timer = useRef<{ kind: 'delay' | 'repeat'; id: number } | null>(null)
  const hold = useRef(row.onHold)
  useEffect(() => {
    hold.current = row.onHold
  })
  // The release (up, cancel, leave, unmount) ends the hold: the row hears it once per press.
  const stop = useCallback((): void => {
    const t = timer.current
    if (t) {
      if (t.kind === 'delay') window.clearTimeout(t.id)
      else window.clearInterval(t.id)
      timer.current = null
      hold.current?.(false)
    }
  }, [])
  useEffect(() => stop, [stop])
  const atEnd = direction < 0 ? value <= row.min : value >= row.max
  const disabled = row.disabled === true || atEnd
  // The ladder's end reached under a held finger disables the button, and a disabled control
  // need not hear the pointer's up: the hold ends here.
  useEffect(() => {
    if (disabled) stop()
  }, [disabled, stop])
  return (
    <V2IconButton
      icon={direction < 0 ? Minus : Plus}
      label={`${direction < 0 ? 'Decrease' : 'Increase'} ${row.label}`}
      className="shrink-0"
      disabled={disabled}
      onPointerDown={(e) => {
        if (e.button !== 0 || disabled) return
        stop()
        hold.current?.(true)
        latest.current()
        timer.current = {
          kind: 'delay',
          id: window.setTimeout(() => {
            timer.current = {
              kind: 'repeat',
              id: window.setInterval(() => latest.current(), HOLD_REPEAT_INTERVAL_MS)
            }
          }, HOLD_REPEAT_DELAY_MS)
        }
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onClick={(e) => {
        if (e.detail === 0) latest.current()
      }}
    />
  )
}

/**
 * An item row's ⋯ on the desktop (§10.5): the shared 28 px icon button in the row's trailing
 * slot, in the row's full ink, opening the shared `LocalMenu` from it – a popover flush under
 * the button (§9.20) – with the row's items, a disabled one listed at .4 (§9.30: Move Up on
 * the first row stays where the eye expects it). The button is the one target in a static row,
 * so it rings at its own offset; a dependent row's button is disabled with the row
 * (`aria-disabled` on the row, `disabled` on the button, one .4 – the
 * `.zen-settings-row-disabled` rule keeps the button's own off).
 */
function RowMenuButton({
  menu,
  title,
  disabled
}: {
  menu: RowMenu
  title: string
  disabled?: boolean
}): JSX.Element {
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  return (
    <>
      <V2IconButton
        icon={Ellipsis}
        label={menu.label}
        className="zen-settings-row-menu"
        aria-haspopup="menu"
        aria-expanded={anchor !== null || undefined}
        disabled={disabled}
        onClick={(e) => setAnchor(anchorOf(e.currentTarget))}
      />
      {anchor && (
        <LocalMenu
          anchor={anchor}
          title={title}
          items={menu.items.map((item) => ({
            id: item.id,
            label: item.label,
            disabled: item.disabled,
            danger: item.danger,
            onSelect: item.onSelect
          }))}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
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
 * the Share of installed RAM slider reads at .4, not .16. The label binds the control where the
 * control is a form control (§9.12): `labelFor` makes it the `<label for>` of a native field,
 * `labelId` gives it the id a button-like control's `aria-labelledby` names (`RowText`).
 */
function ControlRow({
  row,
  caption,
  description,
  labelFor,
  labelId,
  children
}: {
  row: SettingsRow
  caption?: string
  description?: string
  labelFor?: string
  labelId?: string
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
      <RowText
        label={row.label}
        labelFor={labelFor}
        labelId={labelId}
        description={description}
        caption={caption}
      />
      <span className="zen-settings-trailing zen-settings-control">{children}</span>
    </div>
  )
}

/**
 * A field row in the stacked form (`FieldRow.form: 'stacked'`, §9.12's form in a row): the text
 * block – the label, the description on its lines – then the field UNDER it across the row's
 * content width, 32 tall (`.zen-v2-field`), and a commit the row refuses puts §9.12's validation
 * line under the field, spanning the field's box. The row is a column of one block, the form's
 * own (`.zen-settings-field-block`: its 4 from the text to the field), holding the text and
 * `InlineField`'s column (its 4 from the field to the message), so a stacked row stands
 * 6 + 20 + 20 n + 4 + 32 + 6 = 68 + 20 n tall at rest for n lines of description (108 with
 * two) and a line of validation adds 4 + 20. No control trails the text, so nothing is seated
 * (§9.18) and the row counts no lines; it keeps `.zen-v2-row`'s own `--v2-row-pad` above and
 * below as a plain row does, `data-static` as the control row has it, and the disabled .4 the
 * same way. The label is the field's `<label for>` (§9.12's association for the label-above
 * form; the #453 lead check): a click on the label lands in the field under it, and the label
 * names the field in place of the inline form's `aria-label`. The phone is unchanged: its field
 * row shows the value and opens the field sheet.
 */
function StackedFieldRow({ row, caption }: { row: FieldRow; caption?: string }): JSX.Element {
  const fieldId = `${useId()}-field`
  return (
    <div
      data-row={row.id}
      data-static=""
      data-tone={row.tone}
      className={cn(
        'zen-settings-row zen-settings-stacked-row zen-v2-row',
        row.disabled && 'zen-settings-row-disabled'
      )}
    >
      <div className="zen-settings-field-block">
        <RowText
          label={row.label}
          labelFor={fieldId}
          description={row.description}
          caption={caption}
        />
        <InlineField row={row} stacked fieldId={fieldId} />
      </div>
    </div>
  )
}

/**
 * A boolean on the desktop (§10.5, §6): Zen's 16 px checkbox left of the label, the description
 * under the label; the whole row is the checkbox's label, so a press anywhere on it toggles.
 * A row with a `leading` glyph seats it between the box and the label in the shared slot
 * (§10.5's Customise toolbar rows: the control's glyph after the box), on the label's line as
 * the box is (§9.2), hidden from the name the label gives the checkbox. Disabled as a dependent
 * row, the check-row primitive puts the .4 on the row's content (§9.30) and `aria-disabled`
 * keeps the row's fill off.
 */
function CheckRow({ row, caption }: { row: SwitchRow; caption?: string }): JSX.Element {
  const disabled = row.disabled === true
  return (
    <label
      data-row={row.id}
      data-tone={row.tone}
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
      {row.leading && (
        <span className="zen-settings-leading" aria-hidden="true">
          {row.leading}
        </span>
      )}
      <RowText label={row.label} description={row.description} caption={caption} />
    </label>
  )
}

/**
 * A desktop input in its row (§9.12): the row's value edited in place and committed on Enter
 * or when the field loses focus; Escape puts the row's value back. A commit the row refuses
 * keeps the typed value, marks the field and shows the message under it as §9.12's validation
 * line (`ValidationMessage`: 13 in the danger ink with its 16 glyph), which the field names
 * (`aria-describedby`) so a reader on the field hears the error. Trailing the text (the inline
 * form) the column hugs the field's width, 160 or 96, the message capped near it; `stacked`
 * (`StackedFieldRow`) the column spans the row's content width and the field and its message
 * with it. In either form the row's visible label is the field's `<label for>` (§9.12's
 * association; #453 for the stacked row, the sweep for the inline one): the input carries
 * `fieldId`, the id the label names, and no `aria-label` to override the name it gives.
 */
function InlineField({
  row,
  stacked,
  fieldId
}: {
  row: FieldRow
  stacked?: boolean
  /** The id the row's `<label for>` names (`RowText`'s `labelFor`). */
  fieldId: string
}): JSX.Element {
  const errorId = `${useId()}-error`
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
    <span className={cn('zen-settings-inline-field', stacked && 'zen-settings-stacked-field')}>
      <input
        id={fieldId}
        className={cn(
          'zen-settings-input zen-v2-field',
          row.input === 'number' ? 'zen-settings-field-number' : 'zen-settings-field-text',
          row.secret && 'zen-settings-field-secret'
        )}
        type={row.input === 'number' ? 'number' : 'text'}
        inputMode={row.input === 'number' ? 'numeric' : row.input === 'url' ? 'url' : 'text'}
        min={row.min}
        max={row.max}
        placeholder={row.placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
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
        <ValidationMessage id={errorId} message={error} className="zen-settings-inline-error" />
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
 * attribute; the description's rule reads it through the row). With `labelFor` the label is a
 * `<label for>` of the control with that id (a field row's, §9.12), the same class and so the
 * same line; every style hangs on the class, so the element makes no difference. With `labelId`
 * the label carries that id, for a button-like control's `aria-labelledby` (a menulist, a
 * slider's thumb) to name itself by the visible label.
 */
export function RowText({
  label,
  labelFor,
  labelId,
  description,
  caption
}: {
  label: string
  labelFor?: string
  labelId?: string
  description?: string
  caption?: string
}): JSX.Element {
  return (
    <span className="zen-settings-row-text">
      {caption && <span className="zen-settings-caption">{caption}</span>}
      {labelFor ? (
        <label id={labelId} className="zen-settings-label" htmlFor={labelFor}>
          {label}
        </label>
      ) : (
        <span id={labelId} className="zen-settings-label">
          {label}
        </span>
      )}
      {description && <span className="zen-settings-description">{description}</span>}
    </span>
  )
}
