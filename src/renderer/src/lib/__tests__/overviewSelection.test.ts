import { describe, expect, it } from 'vitest'
import type { Tab } from '@shared/types'
import { BLANK_URL } from '@shared/url'
import {
  NO_SELECTION,
  allSelected,
  bookmarkFolderTitle,
  bookmarkedMessage,
  deselectAll,
  endSelection,
  groupableTabs,
  isSelected,
  pageTabs,
  pruneSelection,
  selectAll,
  selectedTabs,
  selectionTitle,
  shareTabsPayload,
  startSelection,
  toggleSelected
} from '../overviewSelection'

/*
 * The overview's select-tabs mode (matrix TAB-08, TAB-35, SH-12): the model behind the checkable
 * cards, the header's count and the action row. Enter, toggle, select all, exit, and what each
 * action is handed.
 */

function tab(id: string, url: string, patch: Partial<Tab> = {}): Tab {
  return { id, url, title: id, customTitle: null, pinned: false, essential: false, ...patch } as Tab
}

describe('entering and leaving', () => {
  it('starts empty from the header, or with the held card picked from its sheet', () => {
    expect(startSelection()).toEqual({ on: true, picked: [] })
    expect(startSelection('b')).toEqual({ on: true, picked: ['b'] })
  })

  it('Done ends the mode and forgets the picks', () => {
    expect(endSelection()).toBe(NO_SELECTION)
    expect(NO_SELECTION.on).toBe(false)
  })

  it('unpicking the last card leaves the mode on at zero (Chrome’s Edit mode stays up)', () => {
    const s = toggleSelected(startSelection('a'), 'a')
    expect(s).toEqual({ on: true, picked: [] })
    expect(selectionTitle(s.picked.length)).toBe('Select tabs')
  })

  it('nothing moves while the mode is off', () => {
    expect(toggleSelected(NO_SELECTION, 'a')).toBe(NO_SELECTION)
    expect(selectAll(NO_SELECTION, ['a', 'b'])).toBe(NO_SELECTION)
    expect(deselectAll(NO_SELECTION)).toBe(NO_SELECTION)
    expect(pruneSelection(NO_SELECTION, new Set())).toBe(NO_SELECTION)
  })
})

describe('picking', () => {
  it('a tap picks, a second tap unpicks, in the order tapped', () => {
    let s = startSelection()
    s = toggleSelected(s, 'b')
    s = toggleSelected(s, 'a')
    expect(s.picked).toEqual(['b', 'a'])
    expect(isSelected(s, 'a')).toBe(true)
    s = toggleSelected(s, 'b')
    expect(s.picked).toEqual(['a'])
    expect(isSelected(s, 'b')).toBe(false)
  })

  it('Select all picks every card of the grid, keeping the earlier picks first; Deselect all empties it', () => {
    let s = toggleSelected(startSelection(), 'c')
    s = selectAll(s, ['a', 'b', 'c', 'd'])
    expect(s.picked).toEqual(['c', 'a', 'b', 'd'])
    expect(allSelected(s, ['a', 'b', 'c', 'd'])).toBe(true)
    s = deselectAll(s)
    expect(s).toEqual({ on: true, picked: [] })
    // With nothing to pick there is nothing "all" of.
    expect(allSelected(s, [])).toBe(false)
  })

  it('Deselect all on an empty selection is the same object (no render for nothing)', () => {
    const s = startSelection()
    expect(deselectAll(s)).toBe(s)
  })

  it('the header reads the mode’s name at zero, then the count', () => {
    expect(selectionTitle(0)).toBe('Select tabs')
    expect(selectionTitle(1)).toBe('1 selected')
    expect(selectionTitle(12)).toBe('12 selected')
  })
})

describe('the grid changing under the mode', () => {
  it('a pick whose card left the grid goes; the rest and the mode stay', () => {
    const s = selectAll(startSelection(), ['a', 'b', 'c'])
    const pruned = pruneSelection(s, new Set(['a', 'c']))
    expect(pruned).toEqual({ on: true, picked: ['a', 'c'] })
    expect(pruneSelection(s, new Set())).toEqual({ on: true, picked: [] })
  })

  it('nothing missing: the same object comes back', () => {
    const s = selectAll(startSelection(), ['a', 'b'])
    expect(pruneSelection(s, new Set(['a', 'b', 'z']))).toBe(s)
  })

  it('the actions get the picks in the grid’s order, not the tapping order', () => {
    const ordered = [tab('a', 'https://a/'), tab('b', 'https://b/'), tab('c', 'https://c/')]
    let s = startSelection()
    s = toggleSelected(s, 'c')
    s = toggleSelected(s, 'a')
    expect(selectedTabs(s, ordered).map((t) => t.id)).toEqual(['a', 'c'])
  })
})

describe('the actions’ targets', () => {
  const alpha = tab('a', 'https://a.example/', { title: 'Alpha' })
  const beta = tab('b', 'https://b.example/page', { title: 'Beta', customTitle: 'My Beta' })
  const pinned = tab('p', 'https://p.example/', { title: 'Pinned', pinned: true })
  const essential = tab('e', 'https://e.example/', { title: 'Ess', essential: true })
  const blank = tab('blank', BLANK_URL, { title: 'New tab' })
  const settings = tab('s', 'zen://settings', { title: 'Settings' })

  it('Group takes the picks a group can hold: pinned and essential tabs are left out', () => {
    expect(groupableTabs([alpha, pinned, beta, essential]).map((t) => t.id)).toEqual(['a', 'b'])
    expect(groupableTabs([pinned])).toEqual([])
  })

  it('Bookmark and Share take the pages: blank tabs and the browser’s own pages are left out', () => {
    expect(pageTabs([alpha, blank, settings, beta]).map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('Bookmark all files into "Tabs from <date>", the date in full, and says where it went', () => {
    const title = bookmarkFolderTitle(new Date(2026, 8, 21))
    expect(title).toBe(
      `Tabs from ${new Date(2026, 8, 21).toLocaleDateString(undefined, { dateStyle: 'medium' })}`
    )
    expect(title).toMatch(/^Tabs from .*2026/)
    expect(bookmarkedMessage(3, 'Tabs from 21 Sept 2026')).toBe(
      'Bookmarked 3 tabs in “Tabs from 21 Sept 2026”'
    )
    expect(bookmarkedMessage(1, 'F')).toBe('Bookmarked 1 tab in “F”')
  })

  it('Share hands the sheet a text list, a title line and an address line per tab (SH-12)', () => {
    expect(shareTabsPayload([alpha, beta])).toEqual({
      title: '2 tabs',
      text: 'Alpha\nhttps://a.example/\n\nMy Beta\nhttps://b.example/page'
    })
  })

  it('one tab shares as itself; a tab titled by its address is the address alone', () => {
    expect(shareTabsPayload([alpha])).toEqual({ title: 'Alpha', text: 'Alpha\nhttps://a.example/' })
    const bare = tab('u', 'https://u.example/', { title: 'https://u.example/' })
    expect(shareTabsPayload([bare]).text).toBe('https://u.example/')
  })
})
