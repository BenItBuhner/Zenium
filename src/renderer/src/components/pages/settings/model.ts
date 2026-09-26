import type { ReactNode } from 'react'
import type { InternalPageQuery, InternalPageSection } from '@shared/internalPages'
import { matchesQuery } from '@shared/internalPages'
import type { FormFactor } from '@shared/types'

/**
 * The phone Settings page as data (design language v2 §10.3–10.4). A section builder turns the
 * browser state into groups of rows; the page draws them, the landing's search filters the same
 * rows across every section, and tests read them without a DOM. Rows carry their own callbacks,
 * so a builder is a plain function of the state and the commands it may run.
 *
 * Row kinds are the four v2 phone rows – value (opens a picker sheet), switch, action, and the
 * field row that stands in for a desktop text or number input (opens a one-field sheet) – plus
 * an info row (a fact with nothing to do), an item row (one thing in a list, opening a sheet of
 * rows about it), a detail row (a level of an item's sheet – permissions, errors – with a
 * summary trailing, opening the second sheet) and a custom row for the few blocks that are not
 * rows (image radio cards, the zoom stepper).
 */

export interface RowBase {
  /** Stable within its section: the React key and what a search result points at. */
  id: string
  /** 15/400 on the first line; sentence case (§9.1). */
  label: string
  /** 13 at 69% under the label, at most two lines (§9.2). */
  description?: string
  /** The description in a §1 status ink (text only): a load error, a retirement notice. */
  tone?: 'warn' | 'danger'
  /** Terms the search matches besides the visible text. */
  keywords?: readonly string[]
  /** A dependent row whose parent is off: 40%, still laid out, not pressable (§10.4). */
  disabled?: boolean
  /**
   * An extension holds the setting this row sets (`UIState.extensionControls`, Chrome's
   * extension-controlled indicator; §10.5's controlled-setting primitive): the row is drawn
   * as a dependent row – its control disabled showing the value in effect, the row at .4, no
   * press – and the indicator row stands after it, full ink, the way out: "Controlled by
   * <name>" over "An extension sets this. Disable it to use your own value.", trailing one
   * control – the desktop's 32 secondary Disable button; on the phone a §10.4 action row
   * whose chevron opens the extension's own page, where its switch is. Consecutive rows one
   * extension holds share one indicator row after the run (`controlledRuns`).
   * `extensionControlled` builds it from the state for a setting key.
   */
  controlled?: RowControl
  /**
   * The chrome layouts the row exists on, when what it sets is a control one shell alone has:
   * the phone bar's position and its editor are the phone shell's, the URL bar's full addresses
   * the desktop and tablet shells'. `onLayout` leaves the row out of the other layouts' pages –
   * and out of their search, which would otherwise offer a phone's row on a desktop (BUG-055).
   * Absent, the row is on every layout; a context without a form factor keeps every row.
   */
  layouts?: readonly FormFactor[]
  /**
   * A `--v2-border` hairline stands over this row, closing the run of rows above it: the
   * builder's `.zen-settings-hairline`, the landing's run separator, drawn by `GroupList`
   * between the run and the row (Settings › Sync's "Tabs from other devices" under the device
   * run: the glyph-less action row after a run of glyph rows would otherwise read as a ragged
   * edge – the #453 lead check; §10.4). A separator, not an empty leading slot for alignment.
   * Nothing for a group's first row (no run above it) or a row shown alone (a search result).
   */
  hairline?: boolean
}

/**
 * The extension holding a row's setting (`RowBase.controlled`; the shared `ExtensionControl`
 * with the ways out attached): Disable goes through the host's own path, the one the Extensions
 * page's switch takes, and the host drops the extension's layer – the row re-enables through
 * the same state that disabled it.
 */
export interface RowControl {
  extensionId: string
  /** The extension's name as it names itself, the one the Extensions page shows. */
  name: string
  /**
   * The extension's value, in effect over the user's own: the held row shows it in its
   * disabled control, as Chrome's Settings shows the preference's effective value. Absent,
   * the row keeps to the setting's value. A list for a setting that is one (startup pages).
   */
  value?: string | number | boolean | string[]
  /** Disable the extension: the desktop indicator row's button (§10.5). */
  onDisable(): void
  /**
   * Open the extension's own page – Settings › Extensions with its details open, where its
   * switch is (`manageExtension`): the phone indicator row's press (§10.4: an action row with
   * a chevron; a row that disabled on a tap would be too easy to hit, so the phone never
   * disables inline).
   */
  onManage(): void
}

/**
 * Where the indicator rows stand among a group's rows (§10.5's controlled-setting primitive,
 * one row per run): consecutive rows the same extension holds are one run and share one
 * "Controlled by <name>" row after it – a run of one is the row's own – and a held row an
 * unheld row (or another extension's) separates from the run begins a run of its own. Per row,
 * the length of the run the row closes, 0 for every other row; a drawer puts the indicator
 * after each row whose count is not 0, its words plural past 1.
 */
export function controlledRuns(rows: readonly SettingsRow[]): number[] {
  const out: number[] = rows.map(() => 0)
  let length = 0
  rows.forEach((row, index) => {
    const control = row.controlled
    if (!control) {
      length = 0
      return
    }
    length += 1
    const next = rows[index + 1]?.controlled
    if (!next || next.extensionId !== control.extensionId) {
      out[index] = length
      length = 0
    }
  })
  return out
}

export interface RowOption {
  value: string
  label: string
  /** 13/69% under the option's label in the picker sheet. */
  description?: string
  /** A 16 px glyph between the radio and the label (a search engine's favicon). */
  leading?: ReactNode
  /**
   * A §10.3 heading the option sits under in the picker sheet ("Recently visited"): options
   * without one come first, then each heading's options in the order the headings first appear.
   */
  group?: string
  /**
   * The option's font family as a CSS value (a font picker's rows – the face is the choice, so
   * the row shows it): the desktop's menulist popover draws an "Aa" specimen in it after the
   * label (`MenulistOption.font`; the label stays in the chrome's type, since a symbol face
   * drawn in itself writes its name as dingbats); the phone's picker rows, the platform's word
   * aliases, draw their labels in it themselves (`fontBlocks.tsx`).
   */
  font?: string
}

/** The picker sheet's option groups: the ungrouped options first (heading null), then each heading's. */
export function optionGroups(
  options: readonly RowOption[]
): Array<{ heading: string | null; options: RowOption[] }> {
  const groups: Array<{ heading: string | null; options: RowOption[] }> = [
    { heading: null, options: [] }
  ]
  for (const option of options) {
    const heading = option.group ?? null
    let group = groups.find((g) => g.heading === heading)
    if (!group) {
      group = { heading, options: [] }
      groups.push(group)
    }
    group.options.push(option)
  }
  return groups.filter((g) => g.options.length > 0)
}

/** A choice: the current option's label is the row's description; tapping opens the §9.13 sheet. */
export interface ValueRow extends RowBase {
  kind: 'value'
  value: string
  options: readonly RowOption[]
  onChange(value: string): void
  /** The picker sheet's description: what the desktop row explained beside its menulist. */
  sheetDescription?: string
}

/** A boolean: the whole row toggles the trailing 36 × 20 switch (§10.4). */
export interface SwitchRow extends RowBase {
  kind: 'switch'
  checked: boolean
  onChange(checked: boolean): void
  /**
   * The control's own glyph in the row's leading slot on the label's line (§9.2; `--v2-icon`:
   * 16 on the desktop, 20 on the phone) – a Customise toolbar row showing the button it stands
   * for (§10.5, W4-10). The other kinds' slot, before the label: on the desktop after the box.
   */
  leading?: ReactNode
}

/** Opens or does something. Destructive actions confirm in a sheet, never inline (§10.4). */
export interface ActionRow extends RowBase {
  kind: 'action'
  /** What the row does; with `form`, what its sheet's primary button does is the form's own. */
  onPress?(): void
  /** A 20 px glyph on the label's line (§9.2): a status the row acts on (Safety check's rows). */
  leading?: ReactNode
  /** A trailing 16 px glyph, only when the action leaves the page (§10.4). */
  leaves?: 'external' | 'chevron'
  /**
   * The label is a page's title (a tab of another device): one line, truncating from the end
   * (§6, as the History rows and Chrome's synced-tab lists; the #314 ruling) – a title names a
   * target and is not read whole, and the host under it disambiguates a cut one. Never a row
   * grown for a title.
   */
  truncate?: boolean
  /**
   * The desktop's 32 px button (§10.5, Zen's about:preferences: "Check for updates", "Clear
   * Data…"): the row keeps its label and description and trails this button, which runs the
   * action – its confirmation dialog first for a destructive one. Without it a desktop action
   * row is the whole-row target the phone draws, with its leaving glyph; a phone never reads it.
   */
  button?: string
  /**
   * The action is running (§9.30): the row keeps its ink, trails a 16 px spinner in place of
   * its glyph, is `aria-busy` and takes no press – busy is not disabled.
   */
  busy?: boolean
  destructive?: boolean
  /**
   * The confirmation sheet a destructive action shows first; `onPress` runs on its button.
   * `verbTone: 'plain'` is the desktop prompt's third form (the primitive's `verbTone`): the
   * verb a second secondary in the plain ink with no default key – §9.23's notice for an act
   * that costs a window but no data (Settings › Apps' Uninstall with a window of the app open;
   * the #435 lead check). The phone's sheet keeps its two forms: no phone row names it.
   */
  confirm?: { title: string; description?: string; action: string; verbTone?: 'plain' }
  /**
   * `onPress` opens a confirmation the builder draws itself (the site-data page's prompts, whose
   * container takes the focus, §9.22): the row says so as one with `confirm` does
   * (`aria-haspopup="dialog"`).
   */
  prompts?: boolean
  /** A sheet holding a small form (add a route, create a container) instead of a plain press. */
  form?: FormSheet
  /**
   * The section's drill-in page the row opens on the phone layout (§10.2, `InternalPageSection.
   * pages`: a list that runs long or whose rows have their own actions – the sites that stored
   * data – is a page, `zen://settings/<section>/<page>`, reached through `RowContext.openPage`),
   * where the two-pane layout opens the row's `form` as a dialog instead (§10.5). The row draws
   * the leaving chevron on the phone; the desktop keeps its `button`.
   */
  page?: string
  /**
   * The query the drill-in page opens with (`zen://settings/languages/add?list=always`): what
   * of the row's context the page needs – which list an Add row adds to, so one page serves
   * every Add row of the section (§10.2). Only with `page`.
   */
  pageQuery?: InternalPageQuery
  /**
   * `onPress` opens a surface of its own over the page (an editor sheet): inside an item's sheet
   * the row dismisses that sheet first and presses once it has gone, so the editor is the one
   * sheet over the page and may open its own pickers (§9.24: a sheet opens one sheet, and that
   * one opens nothing). On the page itself the press is immediate.
   */
  closesSheet?: boolean
}

/** A sheet with a §9.12 form in it; `render` gets the function that closes the sheet. */
export interface FormSheet {
  title: string
  description?: string
  /**
   * The body is a list of rows rather than a form (the site-data viewer, the Add language
   * dialog with its filter field): the desktop dialog stands at most 80% of the frame and
   * scrolls under its title block, and its footer takes the list form – a hairline in the
   * gutter, the buttons at 12 (§9.20; `data-body="list"`); the phone sheet takes the same cap
   * at its expanded detent (`BottomSheet`'s `body`). `picker` is a list whose rows are the
   * options of the row's current value (the Standard font's families): the same dialog on the
   * desktop, and on the phone a §9.13 picker sheet – expanded and scrolled to the checked
   * option when its rows exceed the peek (`sheets.tsx`), under the same cap.
   */
  body?: 'list' | 'picker'
  render(close: () => void): ReactNode
}

/** A text or number the desktop keeps in an input: the row shows it, a one-field sheet edits it. */
export interface FieldRow extends RowBase {
  kind: 'field'
  value: string
  /** The row's description for the value (the value itself when absent). */
  display?: string
  /** `url`: a text field that brings up the address keyboard (§9.12; `inputMode="url"`). */
  input: 'text' | 'number' | 'url'
  /**
   * The desktop row's form. `inline` (the default, §9.21): the field trails the text block at
   * its width – 160 for text, 96 for a number – with a refused commit's validation line under
   * it in the trailing column. `stacked` (§9.12's form in a row): the label and description
   * keep their lines and the field stands UNDER them across the row's content width, the
   * validation line under the field spanning the field's box – for a value that is long (an
   * API key) and unreadable at 160. The phone has one form for both: the row shows the value
   * (`display`) and a field sheet edits it.
   */
  form?: 'inline' | 'stacked'
  placeholder?: string
  min?: number
  max?: number
  /** A secret (an API key): the platform monospace in the field (§4), never shown on the row. */
  secret?: boolean
  /**
   * Commit an edited value; a returned string is a validation message that keeps the sheet up.
   * A promise makes the sheet a §9.30 busy form while it settles: the field read-only with the
   * typed value, Save busy, Cancel at .4; a message refuses (the field clears, takes the focus
   * and shows it), `undefined` accepts and closes the sheet.
   */
  onCommit(value: string): string | undefined | Promise<string | undefined>
}

/**
 * A bounded number over a ladder of stops as the phone's §10.4 slider row: the value in
 * `tabular-nums` on the label's line, the description, then the 44 px − and + step buttons with
 * the track (the zoom sheet's `zen-zoom-slider`) between them; a press steps once, a hold
 * repeats, the thumb commits when it is let go and the text follows the drag. No labels under
 * the track's ends: the value on the label's line is what the row says. The desktop has no
 * slider on a page (§10.5): a level in Settings is a menulist of its stops (a `value` row over
 * them, as Default zoom's 100% – the fonts group's sizes), so a builder that keeps a slider row
 * on the two-pane layout as well (the Resources budgets) draws the phone's control trailing its
 * text there, with the value at its end, until that group moves to the menulist too.
 */
export interface SliderRow extends RowBase {
  kind: 'slider'
  value: number
  min: number
  max: number
  step: number
  /** The value as the row shows it ("70%", "16 px"). */
  format(value: number): string
  /**
   * A step (a press, one of a hold's repeats) or the thumb let go. A row whose builder
   * coalesces its steps (the fonts group's draft, the Android performance gate's ruling for
   * #350) moves its own value here and commits once the sequence is quiet; any other commits
   * at once.
   */
  onChange(value: number): void
  /**
   * The row is left: its focus moves out of the control (a finger on another row), or the
   * control goes (its sheet closes, its drill-in is left). A coalescing builder commits what
   * this row's steps have pending, so no step is lost to a close inside the quiet window –
   * and only this row's: the blur a finger on another row's button causes is no end to the
   * sequence that finger begins.
   */
  onLeave?(): void
  /**
   * A step button is held: `true` at the pointer's down, `false` at its up, cancel or leave.
   * A coalescing builder waits with its commit while the button is down – the hold's repeats
   * are steps – and starts its quiet window at the release (the ruling's "the hold's end"), so
   * a hold commits once, whatever its length.
   */
  onHold?(held: boolean): void
}

/** One entry of an item row's desktop ⋯ menu; Title Case, as Zen's menu items are (§9.1). */
export interface RowMenuItem {
  id: string
  label: string
  /** Not applicable now (Move Up on the first row): the item stays listed at §9.30's .4. */
  disabled?: boolean
  /** A destructive item, in the danger ink. */
  danger?: boolean
  onSelect(): void
}

/**
 * An item row's ⋯ on the desktop (§10.5): a row with several actions and nothing to set trails
 * the 28 px icon button in the full ink, whose menu – the shared `LocalMenu`, a popover flush
 * under the button (§9.20) – lists the item sheet's action rows (`itemMenuItems`). The phone
 * never draws it: there the row is the item row, and the whole row opens the sheet (§10.4).
 */
export interface RowMenu {
  /** The button's accessible name ("Options for English"). */
  label: string
  items: readonly RowMenuItem[]
}

/**
 * What a long-press on a row copies (SET-54; Chrome for Android's About copies the version on a
 * hold): the text, and the toast's word for it ("Version copied"). A touch layout's gesture on
 * a row whose text is the one thing to copy; the row stays static otherwise.
 */
export interface RowCopy {
  text: string
  confirmation: string
}

/** A fact: label and description, optionally a leading or trailing glyph or value; nothing to press. */
export interface InfoRow extends RowBase {
  kind: 'info'
  /** A 20 px glyph on the label's line (§9.2): a status glyph in the §1 status ink. */
  leading?: ReactNode
  trailing?: ReactNode
  /** A long-press copies this (the version row); the row is still not a target. */
  copy?: RowCopy
  /** The label is a line of prose (an error message): two lines, then an ellipsis (§9.2). */
  clamp?: boolean
  /**
   * The label is the status – a failure's sentence stands as the row's first line, the way a
   * result's headline does – so the label takes the danger ink and the description stays at
   * 69% (§9.33: the status ink on the text that reports the status, one ink per row). `tone`
   * is for a row whose second line is the status; a row sets one of the two.
   */
  danger?: boolean
}

/**
 * One thing in a list (a container, a route, a Boost, a preferred language): on the phone a
 * plain row – no control, no chevron, no ⋯ – whose whole tap opens a sheet of rows about it
 * (§10.4); on the desktop the same row unless it names its one `action` or its `menu`.
 */
export interface ItemRow extends RowBase {
  kind: 'item'
  leading?: ReactNode
  sheet: ItemSheet
  /**
   * The row exists to be acted on (a site exception, a saved item) and this is its one action:
   * on a mouse it trails the row as the desktop's 32 secondary button – `destructive` for the
   * danger ink – and runs at once, and the row opens no dialog, since a dialog opened to hold
   * one action is a surface for nothing (§10.5, the #322 lead check); a confirmation is the
   * bulk action's, never a row's. The phone's item sheet is the finger's form of the same row
   * and holds the action as a row of its own, so `sheet` stays what it is.
   */
  action?: InlineAction
  /**
   * The row has several actions and nothing to set (a preferred language's Move Up / Move Down
   * / Remove, a startup page's Edit… / Remove): on a mouse it is static and trails the 28 px ⋯
   * named by this label ("Options for English"), whose menu is the sheet's action rows
   * (`itemMenuItems`, §10.5) – no dialog opens to hold a list of actions; an action that is a
   * form opens its own form dialog from the menu, as it would from the sheet. The phone keeps
   * the item row and its sheet. Not with `action`.
   */
  menu?: string
}

/**
 * The desktop ⋯ menu of an item row (`ItemRow.menu`, §10.5): the action rows of its sheet, in
 * their order, each an item – disabled where the row is (Move Up on the first row, at .4),
 * in the danger ink where the row is destructive – running the row's press; a row with a
 * `confirm` opens its prompt through `confirm` instead, and one with a `form` opens its form
 * through `openForm` (both the desktop rows' `ctx.open`, naming the item row as the way back
 * for the focus: its ⋯ is the control that opened the dialog, §9.5), as the phone's item sheet
 * opens the same row's sheet. An item reads the desktop's word for the row where it has one
 * (`button`: "Edit…", the ellipsis of a row that opens a dialog, §9.1), else the row's label.
 * Rows of other kinds (a value to set) take the row out of the menu's form; a builder that has
 * them keeps the item's dialog instead.
 */
export function itemMenuItems(
  row: ItemRow,
  confirm: (action: ActionRow) => void,
  openForm?: (action: ActionRow) => void
): RowMenuItem[] {
  return allRows(row.sheet.groups).flatMap((r) =>
    r.kind === 'action'
      ? [
          {
            id: r.id,
            label: r.button ?? r.label,
            disabled: r.disabled,
            danger: r.destructive,
            onSelect: r.confirm
              ? () => confirm(r)
              : r.form && openForm
                ? () => openForm(r)
                : () => r.onPress?.()
          }
        ]
      : []
  )
}

/** An item row's one action as the desktop's trailing button (`ItemRow.action`, §10.5). */
export interface InlineAction {
  /** The button's label ("Remove", "Clear"); its name for a reader is this and the row's label. */
  label: string
  /** The danger ink, where the action removes what the row stands for. */
  destructive?: boolean
  /** The action is running (§9.30): the button is busy, not disabled. */
  busy?: boolean
  onPress(): void
}

/**
 * A level of an item's sheet (§10.4 detail row): 44 tall, a summary of what is inside trailing
 * in 13 at 69% before a 16 px chevron, opening the second sheet (§9.24: the item's sheet is
 * depth one, this one depth two, and nothing opens over it).
 */
export interface DetailRow extends RowBase {
  kind: 'detail'
  /** "4 permissions", "2 errors", "None": what the sheet holds, at a glance. */
  summary?: string
  leading?: ReactNode
  sheet: ItemSheet
}

export interface ItemSheet {
  title: string
  description?: string
  /** The description reports a status (an extension's load error): the §1 status ink. */
  descriptionTone?: 'warn' | 'danger'
  groups: RowGroup[]
}

/** A block that is not a row (image radio cards, a stepper). Searched by its label. */
export interface CustomRow extends RowBase {
  kind: 'custom'
  render(): ReactNode
  /** The block is a row of its own (it draws `.zen-v2-row` itself): no block padding around it. */
  bare?: boolean
  /** A long-press on the block copies this (a version block); the block's own controls are left out. */
  copy?: RowCopy
}

export type SettingsRow =
  | ValueRow
  | SwitchRow
  | ActionRow
  | FieldRow
  | SliderRow
  | InfoRow
  | ItemRow
  | DetailRow
  | CustomRow

export interface RowGroup {
  id: string
  /** 15/600 sentence-case heading, 20 above and 4 below (§10.3); null for rows without one. */
  heading: string | null
  /** A count or size trailing on the heading's line at the gutter, 13 at 69% (§10.3). */
  aside?: string
  /** 13/69% under the heading: the section's introductory paragraph. */
  description?: string
  rows: SettingsRow[]
  /** The §9.17 one-line empty state, when the group's rows come from a list that is empty. */
  empty?: string
  /** As a row's `layouts`: the whole group is one shell's (the bookmarks bar's rows). */
  layouts?: readonly FormFactor[]
}

export interface SectionModel {
  section: InternalPageSection
  groups: RowGroup[]
}

/** A matching row of a search: which section and group it sits in, and its caption (§10.2). */
export interface SearchHit {
  section: InternalPageSection
  group: RowGroup
  row: SettingsRow
  /** "Category › Group", or the category alone for a group without a heading. */
  caption: string
}

/** Build a value row from a typed choice without losing the option type at the call site. */
export function choice<T extends string>(
  row: Omit<ValueRow, 'kind' | 'value' | 'options' | 'onChange'> & {
    value: T
    options: ReadonlyArray<RowOption & { value: T }>
    onChange: (value: T) => void
  }
): ValueRow {
  return { ...row, kind: 'value', onChange: (value) => row.onChange(value as T) }
}

/** The label the row shows for its current value. */
export function currentOptionLabel(row: ValueRow): string {
  return row.options.find((o) => o.value === row.value)?.label ?? row.value
}

/** Everything the search reads of a row: label, description, keywords and a value row's options. */
export function rowText(row: SettingsRow): string {
  const parts = [row.label, row.description ?? '', ...(row.keywords ?? [])]
  if (row.kind === 'value') parts.push(...row.options.map((o) => o.label))
  if (row.kind === 'field') parts.push(row.display ?? row.value)
  if (row.kind === 'slider') parts.push(row.format(row.value))
  return parts.join(' ')
}

/**
 * The rows of every section that match `query` (each term somewhere in the row's text, any order,
 * case-insensitive), in nav order, with their "Category › Group" caption. An empty query has no
 * hits: the landing shows its category list instead.
 */
export function searchRows(sections: readonly SectionModel[], query: string): SearchHit[] {
  if (query.trim() === '') return []
  const hits: SearchHit[] = []
  for (const model of sections) {
    for (const group of model.groups) {
      for (const row of group.rows) {
        if (!matchesQuery(rowText(row), query)) continue
        hits.push({
          section: model.section,
          group,
          row,
          caption: group.heading ? `${model.section.label} › ${group.heading}` : model.section.label
        })
      }
    }
  }
  return hits
}

/** Whether a group draws anything: rows, or an empty state standing in for them. */
export function groupShows(group: RowGroup): boolean {
  return group.rows.length > 0 || group.empty !== undefined
}

/**
 * The groups as the `layout` shell draws them: a group or row whose `layouts` leave the layout
 * out goes, item sheets included, and a group left with no rows and no empty state goes with
 * them. Without a layout (a test, a page that has not measured its host) every group stays.
 */
export function onLayout(groups: readonly RowGroup[], layout: FormFactor | undefined): RowGroup[] {
  if (layout === undefined) return [...groups]
  const on = (layouts: readonly FormFactor[] | undefined): boolean =>
    layouts === undefined || layouts.includes(layout)
  const out: RowGroup[] = []
  for (const group of groups) {
    if (!on(group.layouts)) continue
    const rows = group.rows
      .filter((row) => on(row.layouts))
      .map((row) =>
        row.kind === 'item' || row.kind === 'detail'
          ? { ...row, sheet: { ...row.sheet, groups: onLayout(row.sheet.groups, layout) } }
          : row
      )
    if (rows.length < group.rows.length && !groupShows({ ...group, rows })) continue
    out.push({ ...group, rows })
  }
  return out
}

/**
 * The row with `id` among the groups, looking inside item and detail sheets too (a sheet over
 * an item's sheet names a row of the inner one). A model is rebuilt from the state on every
 * render, so a sheet keeps a row id and resolves it here to draw the row's current value.
 */
export function findRow(groups: readonly RowGroup[], id: string): SettingsRow | null {
  for (const group of groups) {
    for (const row of group.rows) {
      if (row.id === id) return row
      if (row.kind === 'item' || row.kind === 'detail') {
        const inner = findRow(row.sheet.groups, id)
        if (inner) return inner
      }
    }
  }
  return null
}

/** Every row of the groups, item and detail sheets included, in reading order (what a test walks). */
export function allRows(groups: readonly RowGroup[]): SettingsRow[] {
  const out: SettingsRow[] = []
  for (const group of groups) {
    for (const row of group.rows) {
      out.push(row)
      if (row.kind === 'item' || row.kind === 'detail') out.push(...allRows(row.sheet.groups))
    }
  }
  return out
}
