import { afterEach, describe, expect, it } from 'vitest'
import {
  OVERVIEW_UI_OFF,
  backFoldTarget,
  noteGroupFolded,
  noteGroupUnfolded,
  overviewUiStore,
  resetOverviewUi
} from '../overviewUi'

/*
 * The groups the user unfolded in this overview (tab overview cleanup spec §2: "tap the header
 * or the back gesture to fold"): the store keeps them in the order unfolded, the back folds the
 * latest one still open, and the next overview starts with none.
 */

afterEach(() => resetOverviewUi())

describe('the unfolded groups the back folds (§2)', () => {
  it('a fresh overview has none unfolded, and the back has nothing to fold', () => {
    expect(OVERVIEW_UI_OFF.unfolded).toEqual([])
    expect(backFoldTarget([], new Set(['a', 'b']))).toBeNull()
  })

  it('an unfold goes to the end of the list, once; a fold takes it out; a re-unfold is latest again', () => {
    noteGroupUnfolded('a')
    noteGroupUnfolded('b')
    expect(overviewUiStore.get().unfolded).toEqual(['a', 'b'])
    noteGroupUnfolded('a')
    expect(overviewUiStore.get().unfolded).toEqual(['b', 'a'])
    noteGroupFolded('b')
    expect(overviewUiStore.get().unfolded).toEqual(['a'])
    // A fold of a group never unfolded here changes nothing (no listener woken).
    const before = overviewUiStore.get()
    noteGroupFolded('zzz')
    expect(overviewUiStore.get()).toBe(before)
  })

  it('the back folds the latest unfolded group that still stands open, passing over the ones folded, gone or off the grid', () => {
    expect(backFoldTarget(['a', 'b', 'c'], new Set(['a', 'b', 'c']))).toBe('c')
    // `c` was folded by its header (or closed, or shows no card under a query): `b` is next.
    expect(backFoldTarget(['a', 'b', 'c'], new Set(['a', 'b']))).toBe('b')
    expect(backFoldTarget(['a', 'b', 'c'], new Set(['a']))).toBe('a')
    // A group open as the overview came up was never unfolded here: not the back's.
    expect(backFoldTarget(['a'], new Set(['b']))).toBeNull()
    expect(backFoldTarget(['a', 'b', 'c'], new Set())).toBeNull()
  })

  it('the stage’s reset forgets them with the rest of the overview’s state', () => {
    noteGroupUnfolded('a')
    resetOverviewUi()
    expect(overviewUiStore.get()).toEqual(OVERVIEW_UI_OFF)
  })
})
