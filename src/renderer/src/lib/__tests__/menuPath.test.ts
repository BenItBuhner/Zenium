import { describe, expect, it } from 'vitest'
import { closedTo, focusAfterClose, focusAfterOpen, openedAt, openerOf } from '../menuPath'

/*
 * The open path of the bar's cascading folder panels (`BarMenu`): `path[d]` is the folder whose
 * panel stands as level `d + 1`. These are the moves the keyboard and the pointer make through
 * the cascade (design-language-v2-draft §9.22), as the Xvfb drive of PR #271 exercises them:
 * Work (root, level 0) > Specs (level 1) > Drafts (level 2).
 */

describe('openedAt', () => {
  it('opens a folder beside the root: one level', () => {
    expect(openedAt([], 0, 'specs')).toEqual(['specs'])
  })

  it('opens a folder beside a nested level: the path grows by one', () => {
    expect(openedAt(['specs'], 1, 'drafts')).toEqual(['specs', 'drafts'])
  })

  it('another folder of the same level takes the place of what stood beside it, and of everything deeper', () => {
    expect(openedAt(['specs', 'drafts'], 0, 'archive')).toEqual(['archive'])
    expect(openedAt(['specs', 'drafts'], 1, 'notes')).toEqual(['specs', 'notes'])
  })

  it('opening the folder already open there changes nothing, its own cascade included (the same array back)', () => {
    const path = ['specs', 'drafts']
    expect(openedAt(path, 0, 'specs')).toBe(path)
    expect(openedAt(path, 1, 'drafts')).toBe(path)
  })

  it('from the keyboard the new level’s first row takes the focus', () => {
    expect(focusAfterOpen(0)).toEqual({ depth: 1, target: 'first' })
    expect(focusAfterOpen(1)).toEqual({ depth: 2, target: 'first' })
  })
})

describe('closedTo', () => {
  it('ArrowLeft in level 1 closes it and leaves the root: closedTo(0)', () => {
    expect(closedTo(['specs'], 0)).toEqual([])
  })

  it('Escape closes the deepest level only: closedTo(path.length - 1)', () => {
    const path = ['specs', 'drafts']
    expect(closedTo(path, path.length - 1)).toEqual(['specs'])
  })

  it('a plain row hovered in level d closes what is deeper than d and keeps d itself', () => {
    expect(closedTo(['specs', 'drafts'], 1)).toEqual(['specs'])
    expect(closedTo(['specs', 'drafts'], 0)).toEqual([])
  })

  it('closing at or past the deepest level changes nothing (the same array back)', () => {
    const path = ['specs']
    expect(closedTo(path, 1)).toBe(path)
    expect(closedTo(path, 5)).toBe(path)
    const none: string[] = []
    expect(closedTo(none, 0)).toBe(none)
  })
})

describe('the row the focus goes back to', () => {
  it('is the folder row of the level that stays, the one that had opened what closed', () => {
    expect(openerOf(['specs', 'drafts'], 0)).toBe('specs')
    expect(openerOf(['specs', 'drafts'], 1)).toBe('drafts')
  })

  it('ArrowLeft from level 1 lands on the Specs row of the root', () => {
    expect(focusAfterClose(['specs'], 0)).toEqual({ depth: 0, target: { id: 'specs' } })
  })

  it('Escape with two levels open lands on the Drafts row of level 1, the root untouched', () => {
    const path = ['specs', 'drafts']
    expect(focusAfterClose(path, path.length - 1)).toEqual({
      depth: 1,
      target: { id: 'drafts' }
    })
  })

  it('is nothing when no deeper level was open: Escape at the root closes the panel instead', () => {
    expect(openerOf([], 0)).toBeNull()
    expect(focusAfterClose([], 0)).toBeNull()
    expect(focusAfterClose(['specs'], 1)).toBeNull()
  })
})
