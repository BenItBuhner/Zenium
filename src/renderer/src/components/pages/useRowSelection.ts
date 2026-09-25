import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

/*
 * The selection mode of a list page's rows (design language v2 §9.6, §10.1 as amended; Chrome's
 * history page and bookmarks manager): a set of picked row keys over the rows the page shows,
 * in their shown order. The page owns what a pick means for its rows (a checkbox, a plain click
 * inside the mode, Space on the focused row, "Select" in the row's menu) and what the mode's bar
 * does with the set; this hook owns the set – toggle, the Shift run from the anchor, select all,
 * clear – and two rules the pages share:
 *
 * - The selection belongs to the list it was made in (`scope`: the search text): a new search –
 *   typed or brought by the URL – starts over with nothing picked.
 * - A row the list no longer shows is not picked: a visit removed by another window, a Clear
 *   browsing data, a sync tombstone – the live list updates through the page's subscription and
 *   the row falls out of the set here, so the bar's count and a Delete's ids are the rows on
 *   screen and never a stale key (Chrome's history page drops a deleted item from its selection
 *   the same way).
 *
 * The pure functions beside the hook are the model, tested on their own; the hook holds them in
 * React state for one page. The phone's long-press mode (§9.6's contextual bar) is the same set
 * over the same rows and can hold this hook when the phone program builds it.
 */

const EMPTY: ReadonlySet<string> = new Set()

/** A row joins (`checked`) or leaves the set; the set itself comes back when nothing changes. */
export function toggleRow(
  ids: ReadonlySet<string>,
  id: string,
  checked: boolean
): ReadonlySet<string> {
  if (ids.has(id) === checked) return ids
  const next = new Set(ids)
  if (checked) next.add(id)
  else next.delete(id)
  return next
}

/**
 * Shift-click: the run from the anchor to `id` – both ends in, in the rows' shown order, across
 * the day groups as Chrome's history page extends – joins the set (never replaces it, as a
 * file list's Shift-click would: the page's model is a checkbox list, Chrome's). Without an
 * anchor among the rows, or with `id` not among them, the row alone joins.
 */
export function extendRange(
  ids: ReadonlySet<string>,
  rows: readonly string[],
  anchor: string | null,
  id: string
): ReadonlySet<string> {
  const from = anchor === null ? -1 : rows.indexOf(anchor)
  const to = rows.indexOf(id)
  if (from === -1 || to === -1) return toggleRow(ids, id, true)
  const span = rows.slice(Math.min(from, to), Math.max(from, to) + 1)
  if (span.every((row) => ids.has(row))) return ids
  return new Set([...ids, ...span])
}

/** The set cut to the rows shown; the set itself when every picked row is still there. */
export function pruneSelection(
  ids: ReadonlySet<string>,
  rows: readonly string[]
): ReadonlySet<string> {
  if (ids.size === 0) return ids
  const shown = new Set(rows)
  const kept = [...ids].filter((id) => shown.has(id))
  return kept.length === ids.size ? ids : new Set(kept)
}

/** What a page reads and does with its selection. */
export interface RowSelection {
  /** The picked rows shown now. */
  selected: ReadonlySet<string>
  /** The mode lasts while anything is picked. */
  selecting: boolean
  /** The picked rows in the list's shown order (a Delete's ids). */
  ordered: () => string[]
  /** A row joins or leaves the set; it becomes the anchor a Shift run starts from. */
  toggle: (id: string, checked: boolean) => void
  /** Shift-click or Shift+arrow: the run from the anchor to this row joins the set. */
  extend: (id: string) => void
  /** Every row shown joins the set (Ctrl+A). */
  selectAll: () => void
  /** Nothing picked: Cancel, Escape, the selection deleted. */
  clear: () => void
  /** Rows the page removed itself leave the set at once, before the list answers. */
  drop: (ids: readonly string[]) => void
}

interface Picked {
  scope: string
  ids: ReadonlySet<string>
}

/**
 * The selection of a list page's rows: `rows` are the keys of the rows the page shows, in
 * order (`rowKeys.ts` is the pages' key scheme), `scope` the list they belong to – the search
 * text, so a new search starts over. See the file's comment for the two rules.
 */
export function useRowSelection(scope: string, rows: readonly string[]): RowSelection {
  const [picked, setPicked] = useState<Picked>({ scope, ids: EMPTY })
  /** The last row picked or dropped: where a Shift run starts. */
  const anchor = useRef<string | null>(null)
  const latest = useRef({ scope, rows })
  useLayoutEffect(() => {
    latest.current = { scope, rows }
  }, [scope, rows])

  // The set the page reads, in the very render the rows change: cut to the rows shown, none
  // for another list's – so no render shows a stale row picked.
  const selected = useMemo(
    () => (picked.scope === scope ? pruneSelection(picked.ids, rows) : EMPTY),
    [picked, scope, rows]
  )
  // What the list changed is committed to the state as well (React's adjust-on-change pattern:
  // a set during the render re-runs it before anything is committed), so a row that fell out
  // stays out should it come back, and a search left behind takes its picks with it. The next
  // render finds the state and the cut set one and the same, and sets nothing.
  if (selected !== picked.ids && (picked.scope === scope || picked.ids.size > 0)) {
    setPicked({ scope, ids: selected })
  }

  /**
   * A change to the set, read against the list of the moment: another list's set counts as
   * none, and a row the list no longer shows is not in the set the change starts from.
   */
  const update = useCallback(
    (change: (current: ReadonlySet<string>) => ReadonlySet<string>): void =>
      setPicked((current) => {
        const { scope: scopeNow, rows: rowsNow } = latest.current
        const base = current.scope === scopeNow ? pruneSelection(current.ids, rowsNow) : EMPTY
        const ids = change(base)
        return ids === current.ids && current.scope === scopeNow
          ? current
          : { scope: scopeNow, ids }
      }),
    []
  )

  const toggle = useCallback(
    (id: string, checked: boolean): void => {
      anchor.current = id
      update((current) => toggleRow(current, id, checked))
    },
    [update]
  )
  const extend = useCallback(
    (id: string): void => {
      const from = anchor.current
      update((current) => extendRange(current, latest.current.rows, from, id))
      // The anchor stands (a second Shift-click runs from the same row, as Chrome's does); a
      // run with none to start from makes this row the anchor, as a plain pick would.
      if (from === null || !latest.current.rows.includes(from)) anchor.current = id
    },
    [update]
  )
  const selectAll = useCallback((): void => {
    const shown = latest.current.rows
    if (shown.length === 0) return
    anchor.current = null
    update((current) => (shown.every((id) => current.has(id)) ? current : new Set(shown)))
  }, [update])
  const clear = useCallback((): void => {
    anchor.current = null
    update((current) => (current.size === 0 ? current : EMPTY))
  }, [update])
  const drop = useCallback(
    (ids: readonly string[]): void =>
      update((current) => {
        if (!ids.some((id) => current.has(id))) return current
        const next = new Set(current)
        for (const id of ids) next.delete(id)
        return next
      }),
    [update]
  )
  const ordered = useCallback(
    (): string[] => latest.current.rows.filter((id) => selected.has(id)),
    [selected]
  )

  return {
    selected,
    selecting: selected.size > 0,
    ordered,
    toggle,
    extend,
    selectAll,
    clear,
    drop
  }
}
