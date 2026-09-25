// @vitest-environment happy-dom
import { act, createElement, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  extendRange,
  pruneSelection,
  toggleRow,
  useRowSelection,
  type RowSelection
} from '../useRowSelection'

/*
 * The list pages' selection model (`useRowSelection.ts`; design language v2 §9.6, §10.1 as
 * amended, HB-68): a set of picked row keys over the rows a page shows – toggle, the Shift run
 * from the anchor across the day groups, select all, clear – belonging to the list it was made
 * in, and cut to the rows still shown when a live change takes one.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROWS = ['a', 'b', 'c', 'd', 'e']
const set = (...ids: string[]): ReadonlySet<string> => new Set(ids)
const sorted = (ids: ReadonlySet<string>): string[] => [...ids].sort()

describe('the model', () => {
  it('toggleRow adds or removes one row, and hands the same set back when nothing changes', () => {
    const one = toggleRow(set(), 'a', true)
    expect(sorted(one)).toEqual(['a'])
    expect(toggleRow(one, 'a', true)).toBe(one)
    expect(sorted(toggleRow(one, 'b', true))).toEqual(['a', 'b'])
    const none = toggleRow(one, 'a', false)
    expect(none.size).toBe(0)
    expect(toggleRow(none, 'a', false)).toBe(none)
  })

  it('extendRange joins the run between the anchor and the row, both ends in, either direction, across the groups', () => {
    expect(sorted(extendRange(set('b'), ROWS, 'b', 'd'))).toEqual(['b', 'c', 'd'])
    expect(sorted(extendRange(set('d'), ROWS, 'd', 'b'))).toEqual(['b', 'c', 'd'])
    // Joins the set, never replaces it: a checkbox list's Shift-click (Chrome's), not a file list's.
    expect(sorted(extendRange(set('a', 'e'), ROWS, 'e', 'd'))).toEqual(['a', 'd', 'e'])
    // A run already in the set changes nothing: the same set comes back.
    const run = set('b', 'c', 'd')
    expect(extendRange(run, ROWS, 'b', 'd')).toBe(run)
  })

  it('extendRange with no anchor among the rows, or a row not among them, picks the row alone', () => {
    expect(sorted(extendRange(set(), ROWS, null, 'c'))).toEqual(['c'])
    // The anchor left the list (a live change took it): the row alone joins.
    expect(sorted(extendRange(set('a'), ROWS, 'gone', 'c'))).toEqual(['a', 'c'])
    expect(sorted(extendRange(set('a'), ROWS, 'a', 'gone'))).toEqual(['a', 'gone'])
  })

  it('pruneSelection cuts the set to the rows shown, and hands the same set back when every row is still there', () => {
    const picked = set('a', 'c', 'e')
    expect(pruneSelection(picked, ROWS)).toBe(picked)
    expect(sorted(pruneSelection(picked, ['a', 'b', 'e']))).toEqual(['a', 'e'])
    expect(pruneSelection(picked, []).size).toBe(0)
    const empty = set()
    expect(pruneSelection(empty, ROWS)).toBe(empty)
  })
})

// ---------------------------------------------------------------------------
// The hook in a page's place
// ---------------------------------------------------------------------------

/** What the probe rendered last, and how many times it rendered. */
const seen: { latest: RowSelection | null; renders: number } = { latest: null, renders: 0 }

function Probe({
  scope,
  rows,
  report
}: {
  scope: string
  rows: readonly string[]
  report: (selection: RowSelection) => void
}): JSX.Element {
  const selection = useRowSelection(scope, rows)
  report(selection)
  return createElement('output', { 'data-count': selection.selected.size })
}

const report = (selection: RowSelection): void => {
  seen.latest = selection
  seen.renders++
}

let root: Root
let container: HTMLDivElement

async function render(scope: string, rows: readonly string[]): Promise<void> {
  await act(async () => root.render(createElement(Probe, { scope, rows, report })))
}

const selection = (): RowSelection => {
  if (!seen.latest) throw new Error('not rendered')
  return seen.latest
}

beforeEach(() => {
  seen.latest = null
  seen.renders = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useRowSelection', () => {
  it('toggles rows in and out; the mode lasts while anything is picked; ordered() follows the list', async () => {
    await render('', ROWS)
    expect(selection().selecting).toBe(false)
    await act(async () => selection().toggle('d', true))
    await act(async () => selection().toggle('b', true))
    expect(selection().selecting).toBe(true)
    expect(sorted(selection().selected)).toEqual(['b', 'd'])
    // The list's order, not the picking order.
    expect(selection().ordered()).toEqual(['b', 'd'])
    await act(async () => selection().toggle('d', false))
    expect(selection().ordered()).toEqual(['b'])
    await act(async () => selection().toggle('b', false))
    expect(selection().selecting).toBe(false)
    expect(selection().selected.size).toBe(0)
  })

  it('extend runs from the last toggled row (the anchor) and the anchor stands for a second run', async () => {
    await render('', ROWS)
    await act(async () => selection().toggle('b', true))
    await act(async () => selection().extend('d'))
    expect(selection().ordered()).toEqual(['b', 'c', 'd'])
    // A second Shift-click runs from the same anchor, as Chrome's does.
    await act(async () => selection().extend('a'))
    expect(selection().ordered()).toEqual(['a', 'b', 'c', 'd'])
    // A toggle moves the anchor.
    await act(async () => selection().clear())
    await act(async () => selection().toggle('e', true))
    await act(async () => selection().extend('c'))
    expect(selection().ordered()).toEqual(['c', 'd', 'e'])
  })

  it('extend with no anchor picks the row alone and makes it the anchor (Shift-click entering the mode)', async () => {
    await render('', ROWS)
    await act(async () => selection().extend('c'))
    expect(selection().ordered()).toEqual(['c'])
    await act(async () => selection().extend('e'))
    expect(selection().ordered()).toEqual(['c', 'd', 'e'])
  })

  it('selectAll picks every row shown; clear empties the set and the anchor', async () => {
    await render('', ROWS)
    await act(async () => selection().selectAll())
    expect(selection().ordered()).toEqual(ROWS)
    const all = selection().selected
    // Select all over a full set changes nothing.
    await act(async () => selection().selectAll())
    expect(selection().selected).toBe(all)
    await act(async () => selection().clear())
    expect(selection().selecting).toBe(false)
    // The anchor went with the set: the next run starts at its own row.
    await act(async () => selection().extend('b'))
    expect(selection().ordered()).toEqual(['b'])
    // Nothing shown, nothing to pick.
    await render('', [])
    await act(async () => selection().selectAll())
    expect(selection().selecting).toBe(false)
  })

  it('a row the list no longer shows falls out of the set; one that comes back is not picked again', async () => {
    await render('', ROWS)
    await act(async () => selection().selectAll())
    expect(selection().selected.size).toBe(5)
    await render('', ['a', 'c', 'e'])
    expect(selection().ordered()).toEqual(['a', 'c', 'e'])
    await render('', ['a', 'b', 'c', 'd', 'e'])
    expect(selection().ordered()).toEqual(['a', 'c', 'e'])
    await render('', [])
    expect(selection().selecting).toBe(false)
  })

  it('drop takes rows out at once (the page removed them itself), before the list answers', async () => {
    await render('', ROWS)
    await act(async () => selection().selectAll())
    await act(async () => selection().drop(['b', 'c']))
    expect(selection().ordered()).toEqual(['a', 'd', 'e'])
    const before = selection().selected
    // Rows not in the set change nothing.
    await act(async () => selection().drop(['b', 'zzz']))
    expect(selection().selected).toBe(before)
  })

  it('the selection belongs to the list it was made in: a new scope starts over, the old set does not come back', async () => {
    await render('', ROWS)
    await act(async () => selection().toggle('a', true))
    await act(async () => selection().toggle('b', true))
    // A search: the rows change with the scope, nothing is picked.
    await render('zen', ['b', 'c'])
    expect(selection().selecting).toBe(false)
    await act(async () => selection().toggle('c', true))
    expect(selection().ordered()).toEqual(['c'])
    // Back to the empty search: the earlier picks are gone for good.
    await render('', ROWS)
    expect(selection().selecting).toBe(false)
  })

  it('hands the same set back across renders that change nothing (a row re-renders on a pick alone)', async () => {
    await render('', ROWS)
    await act(async () => selection().toggle('a', true))
    const picked = selection().selected
    const before = seen.renders
    await render('', ROWS)
    expect(selection().selected).toBe(picked)
    expect(seen.renders).toBe(before + 1)
  })
})
