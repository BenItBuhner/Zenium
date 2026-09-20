/**
 * The keyboard's walk through a sidebar list (§9.22): one tab stop per list – the active row, or
 * the header of the collapsed folder holding it – and the arrows move the focus through every
 * row of the list in the order they stand, tab rows and folder headers alike, Home and End to
 * its ends. Shared by the tab row (TabItem) and the folder header (SpacePanel's FolderRow).
 */
export const ROW_SELECTOR = '.zen-tab[data-tab-id], .zen-tab[data-tab-folder]'

const WALK: Record<string, (rows: HTMLElement[], at: number) => HTMLElement | undefined> = {
  ArrowDown: (rows, at) => rows[at + 1],
  ArrowUp: (rows, at) => rows[at - 1],
  Home: (rows) => rows[0],
  End: (rows) => rows[rows.length - 1]
}

/** Move the focus from `row` for `key`; true when the key was one of the walk's. */
export function walkRows(row: HTMLElement, key: string): boolean {
  const to = WALK[key]
  if (!to) return false
  const scroller = row.closest<HTMLElement>('[data-tab-scroller]')
  if (!scroller) return true
  const rows = [...scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)]
  to(rows, rows.indexOf(row))?.focus()
  return true
}
