/**
 * Long-press multi-select for phone lists (history, bookmarks). A long press on a row enters
 * selection mode with that row picked; taps then toggle rows; deselecting the last row leaves
 * the mode, as does the header's close. Pure and immutable so panels can hold it in state.
 */

export interface Selection {
  /** Selection mode is on: the header shows the count and the rows show their checks. */
  readonly active: boolean
  readonly ids: ReadonlySet<string>
}

export const NO_SELECTION: Selection = { active: false, ids: new Set() }

/** A long press: enter selection mode with `id` picked. */
export function startSelection(id: string): Selection {
  return { active: true, ids: new Set([id]) }
}

/** Tap in selection mode: pick or unpick `id`; unpicking the last row ends the mode. */
export function toggleSelected(selection: Selection, id: string): Selection {
  const ids = new Set(selection.ids)
  if (ids.has(id)) ids.delete(id)
  else ids.add(id)
  return { active: ids.size > 0, ids }
}

/** Pick every listed row (keeps the mode on even for an empty list, so "Select all" of nothing is harmless). */
export function selectAll(ids: Iterable<string>): Selection {
  return { active: true, ids: new Set(ids) }
}

/**
 * Rows that were selected but no longer exist (deleted elsewhere, filtered by a search) drop
 * out; an emptied selection ends the mode. Returns the same object when nothing changed.
 */
export function pruneSelection(selection: Selection, existing: Iterable<string>): Selection {
  if (!selection.active) return selection
  const keep = new Set(existing)
  const ids = new Set([...selection.ids].filter((id) => keep.has(id)))
  if (ids.size === selection.ids.size) return selection
  return { active: ids.size > 0, ids }
}

/** The picked rows in list order, ready for a command. */
export function orderedSelection(selection: Selection, order: readonly string[]): string[] {
  return order.filter((id) => selection.ids.has(id))
}
