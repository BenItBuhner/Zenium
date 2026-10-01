/**
 * The tab overview's ⋯ menu on the touch hosts (`docs/tab-overview-cleanup-spec.md` §4, §5):
 * while the overview stands the BAR's ⋯ opens this menu instead of the app menu – the overview
 * draws no ⋯ of its own – so the rows are a template the core's `Menus` pops through the bar's
 * own surface (the phone's sheet, the tablet's popover anchored at the button). This module is
 * the template's words and its visibility rules alone, pure, so the core and the chrome agree
 * on them and a test can read every rule; the clicks are the caller's.
 *
 * The rows, in §4's order and no other: New Tab; New Private Tab; Private Tabs (N) – only while
 * private tabs exist, "Tabs (N)" from the private view; Select Tabs; Search Tabs; Inactive Tabs
 * (N) – only while any; Recently Closed (N) – only while any; a hairline; Close All Tabs (N) /
 * Close Private Tabs (N) in danger ink; Switch Space ▸ with the spaces as rows, the current one
 * checked. Title Case (§9.1), the counts in parentheses as the overview's sheet wrote them.
 * In SELECTION MODE (§5) the menu is Select All, Deselect All, Close Selected (N) instead.
 */

/**
 * The overview's two views (§3): the space's regular tabs, or the private session's tabs under
 * the mask – never mixed into one grid.
 */
export type OverviewView = 'tabs' | 'private'

export interface OverviewMenuSpace {
  id: string
  /** The space's name as a row reads it (the core's `spaceLabel`). */
  label: string
  /** The space the overview stands on: checked, and still a row. */
  current: boolean
}

export interface OverviewMenuCounts {
  /** Tabs "Close All Tabs" / "Close Private Tabs" would close: the view's unpinned tabs. */
  closable: number
  /** Tabs a selection could take in this view (the overview's cards). */
  selectable: number
  /** The space's regular tabs ("Tabs (N)" from the private view). */
  regular: number
  /** The private session's tabs ("Private Tabs (N)" from the regular view). */
  private: number
  /** Inactive (archived) tabs: TAB-20's sheet. */
  inactive: number
  /** The recently closed list's tabs. */
  recentlyClosed: number
}

export interface OverviewMenuSelection {
  selected: number
  /** How many cards the selection could hold. */
  total: number
}

export interface OverviewMenuContext {
  view: OverviewView
  /** The host keeps private browsing in tabs (`capabilities.privateTabs`): the private rows exist. */
  privateTabs: boolean
  counts: OverviewMenuCounts
  /** The window's spaces in their order; "Switch Space ▸" lists them while there are two or more. */
  spaces: readonly OverviewMenuSpace[]
  /** Selection mode (§5): the menu is the selection's. */
  selection: OverviewMenuSelection | null
}

/** What a row does; the caller maps each to its click. */
export type OverviewMenuCommand =
  | 'new-tab'
  | 'new-private-tab'
  | 'switch-view'
  | 'select-tabs'
  | 'search-tabs'
  | 'inactive-tabs'
  | 'recently-closed'
  | 'close-all'
  | 'switch-space'
  | 'select-all'
  | 'deselect-all'
  | 'close-selected'

/**
 * The rows the CHROME acts on – the overview's own state: its view, its selection, its search,
 * its sheets. The core runs the other three itself (New Tab, New Private Tab, a space switch:
 * tabs it opens or switches, as the app menu's rows do) and hands these to the chrome as one
 * `overview.command` event.
 */
export type OverviewChromeCommand = Exclude<
  OverviewMenuCommand,
  'new-tab' | 'new-private-tab' | 'switch-space'
>

const CHROME_COMMANDS: ReadonlySet<OverviewMenuCommand> = new Set<OverviewMenuCommand>([
  'switch-view',
  'select-tabs',
  'search-tabs',
  'inactive-tabs',
  'recently-closed',
  'close-all',
  'select-all',
  'deselect-all',
  'close-selected'
])

export function isOverviewChromeCommand(
  command: OverviewMenuCommand
): command is OverviewChromeCommand {
  return CHROME_COMMANDS.has(command)
}

export interface OverviewMenuSpaceRow {
  spaceId: string
  label: string
  checked: boolean
}

export interface OverviewMenuRow {
  command: OverviewMenuCommand
  label: string
  /** Danger ink (the destructive rows). */
  destructive?: boolean
  disabled?: boolean
  /** Switch Space ▸: the spaces as rows, the current one checked. */
  spaces?: OverviewMenuSpaceRow[]
}

export type OverviewMenuEntry = OverviewMenuRow | { separator: true }

export function isOverviewMenuSeparator(entry: OverviewMenuEntry): entry is { separator: true } {
  return 'separator' in entry
}

/** "Label (N)": the count in parentheses, as the overview's sheet wrote it (TAB-16, TAB-21). */
export function counted(label: string, n: number): string {
  return `${label} (${n})`
}

/** The view the "Private Tabs (N)" / "Tabs (N)" row switches to. */
export function otherOverviewView(view: OverviewView): OverviewView {
  return view === 'private' ? 'tabs' : 'private'
}

/**
 * The row that switches views, or none: from the regular view "Private Tabs (N)" while private
 * tabs exist (and the host has them); from the private view "Tabs (N)" always – the way back
 * stands even when the space has no regular tab (its empty grid is a place to go).
 */
export function switchViewRow(
  ctx: Pick<OverviewMenuContext, 'view' | 'privateTabs' | 'counts'>
): OverviewMenuRow | null {
  if (!ctx.privateTabs) return null
  if (ctx.view === 'private')
    return { command: 'switch-view', label: counted('Tabs', ctx.counts.regular) }
  if (ctx.counts.private === 0) return null
  return { command: 'switch-view', label: counted('Private Tabs', ctx.counts.private) }
}

function selectionMenu(selection: OverviewMenuSelection): OverviewMenuEntry[] {
  return [
    { command: 'select-all', label: 'Select All', disabled: selection.selected >= selection.total },
    { command: 'deselect-all', label: 'Deselect All', disabled: selection.selected === 0 },
    {
      command: 'close-selected',
      label: counted('Close Selected', selection.selected),
      destructive: true,
      disabled: selection.selected === 0
    }
  ]
}

/** The menu's rows for `ctx`, in §4's order, with its visibility rules applied. */
export function overviewMenu(ctx: OverviewMenuContext): OverviewMenuEntry[] {
  if (ctx.selection) return selectionMenu(ctx.selection)
  const privateView = ctx.view === 'private'
  const rows: OverviewMenuEntry[] = [{ command: 'new-tab', label: 'New Tab' }]
  if (ctx.privateTabs) rows.push({ command: 'new-private-tab', label: 'New Private Tab' })
  const view = switchViewRow(ctx)
  if (view) rows.push(view)
  rows.push({ command: 'select-tabs', label: 'Select Tabs', disabled: ctx.counts.selectable === 0 })
  rows.push({ command: 'search-tabs', label: 'Search Tabs' })
  if (!privateView && ctx.counts.inactive > 0)
    rows.push({ command: 'inactive-tabs', label: counted('Inactive Tabs', ctx.counts.inactive) })
  if (!privateView && ctx.counts.recentlyClosed > 0)
    rows.push({
      command: 'recently-closed',
      label: counted('Recently Closed', ctx.counts.recentlyClosed)
    })
  rows.push({ separator: true })
  rows.push({
    command: 'close-all',
    label: counted(privateView ? 'Close Private Tabs' : 'Close All Tabs', ctx.counts.closable),
    destructive: true,
    disabled: ctx.counts.closable === 0
  })
  // The private session is one across the spaces (§3): the private view has no space to switch.
  if (!privateView && ctx.spaces.length > 1)
    rows.push({
      command: 'switch-space',
      label: 'Switch Space',
      spaces: ctx.spaces.map((s) => ({ spaceId: s.id, label: s.label, checked: s.current }))
    })
  return rows
}
