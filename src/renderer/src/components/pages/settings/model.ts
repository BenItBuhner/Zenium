import type { ReactNode } from 'react'
import type { InternalPageSection } from '@shared/internalPages'
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
   * The chrome layouts the row exists on, when what it sets is a control one shell alone has:
   * the phone bar's position and its editor are the phone shell's, the URL bar's full addresses
   * the desktop and tablet shells'. `onLayout` leaves the row out of the other layouts' pages –
   * and out of their search, which would otherwise offer a phone's row on a desktop (BUG-055).
   * Absent, the row is on every layout; a context without a form factor keeps every row.
   */
  layouts?: readonly FormFactor[]
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
  /** The confirmation sheet a destructive action shows first; `onPress` runs on its button. */
  confirm?: { title: string; description?: string; action: string }
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
   * The body is a list of rows rather than a form (the site-data viewer): the desktop dialog
   * stands at most 80% of the frame and scrolls under its title block, and its footer takes the
   * list form – a hairline in the gutter, the buttons at 12 (§9.20; `data-body="list"`).
   */
  body?: 'list'
  render(close: () => void): ReactNode
}

/** A text or number the desktop keeps in an input: the row shows it, a one-field sheet edits it. */
export interface FieldRow extends RowBase {
  kind: 'field'
  value: string
  /** The row's description for the value (the value itself when absent). */
  display?: string
  input: 'text' | 'number'
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
 * A bounded number on §10.4's slider row: the value as text beside the label, the slider – the
 * zoom sheet's `zen-zoom-slider` – under the text on a phone and trailing it on the desktop.
 * The slider commits when the thumb is let go; the text follows the drag.
 */
export interface SliderRow extends RowBase {
  kind: 'slider'
  value: number
  min: number
  max: number
  step: number
  /** The value as the row shows it ("70%"). */
  format(value: number): string
  onChange(value: number): void
}

/** A fact: label and description, optionally a leading or trailing glyph or value; nothing to press. */
export interface InfoRow extends RowBase {
  kind: 'info'
  /** A 20 px glyph on the label's line (§9.2): a status glyph in the §1 status ink. */
  leading?: ReactNode
  trailing?: ReactNode
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

/** One thing in a list (a container, a route, a Boost): opens a sheet of rows about it. */
export interface ItemRow extends RowBase {
  kind: 'item'
  leading?: ReactNode
  sheet: ItemSheet
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
