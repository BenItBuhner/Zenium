import { describe, expect, it } from 'vitest'
import type { MenuItemDescriptor } from '@shared/types'
import {
  countedItems,
  editableMenu,
  isChangeMenuItem,
  joinMenuSections,
  menuSectionOf,
  menuSectionsOrder,
  movedSentence,
  moveMenuSectionItem,
  nudgeMenuItem,
  positionOf,
  sameMenuOrder,
  splitMenuSections
} from '../menuEdit'

/*
 * The edit mode's data (Edge's Change menu, TB-22): the phone app menu's root cut into the icon
 * row and the list – the hairlines between the list's groups slots of the list – with the
 * Change Menu row and the structure's own hairlines kept out; the nudges the accessibility
 * actions reduce to; the saved order and the reader's sentence.
 */

let n = 0
function item(label: string, patch: Partial<MenuItemDescriptor> = {}): MenuItemDescriptor {
  return {
    id: `menu_1_${++n}`,
    type: 'normal',
    label,
    enabled: true,
    checked: false,
    submenu: null,
    ...patch
  }
}
const sep = (key?: string): MenuItemDescriptor =>
  item('', { type: 'separator', ...(key ? { key } : {}) })

/** The root as the core composes it: the row, a hairline, the list with its keyed hairlines, a hairline, Change Menu. */
function root(): MenuItemDescriptor[] {
  return [
    item('Forward', { glyph: 'forward', key: 'icon.forward' }),
    item('Bookmark', { glyph: 'star', key: 'icon.bookmark' }),
    item('Reload', { glyph: 'reload', key: 'icon.reload' }),
    sep(),
    item('New Tab', { key: 'row.newTab' }),
    item('New Private Tab', { key: 'row.newPrivateTab' }),
    sep('sep.1'),
    item('History', { key: 'row.history' }),
    item('Downloads', { key: 'row.downloads' }),
    sep('sep.2'),
    item('Settings', { key: 'row.settings' }),
    sep(),
    item('Change Menu', { key: 'menu.change' })
  ]
}
const keys = (items: readonly MenuItemDescriptor[]): string[] =>
  items.map((i) => i.key ?? `(${i.type})`)

describe('the sections', () => {
  it('cuts the root into the row, its hairline, the list and the Change Menu group, and joins them back in the same order', () => {
    const items = root()
    const s = splitMenuSections(items)
    expect(keys(s.row)).toEqual(['icon.forward', 'icon.bookmark', 'icon.reload'])
    expect(s.rowEnd?.type).toBe('separator')
    expect(s.rowEnd?.key).toBeUndefined()
    expect(keys(s.list)).toEqual([
      'row.newTab',
      'row.newPrivateTab',
      'sep.1',
      'row.history',
      'row.downloads',
      'sep.2',
      'row.settings'
    ])
    expect(keys(s.change)).toEqual(['(separator)', 'menu.change'])
    expect(joinMenuSections(s)).toEqual(items)
    expect(sameMenuOrder(joinMenuSections(s), items)).toBe(true)
  })

  it('a menu without an icon row is all list; one without a Change Menu row has no edit mode to offer', () => {
    const plain = [item('Open'), sep('sep.1'), item('Copy')]
    const s = splitMenuSections(plain)
    expect(s.row).toEqual([])
    expect(s.rowEnd).toBeNull()
    expect(s.list).toEqual(plain)
    expect(s.change).toEqual([])
    expect(editableMenu(plain)).toBe(false)
    expect(editableMenu(root())).toBe(true)
    expect(isChangeMenuItem(root()[root().length - 1])).toBe(true)
    expect(isChangeMenuItem(root()[0])).toBe(false)
  })

  it('a keyed hairline after the row is the list’s first slot, not the structure’s', () => {
    const items = root()
    const keyedEnd = { ...items[3], key: 'sep.9' }
    const s = splitMenuSections([...items.slice(0, 3), keyedEnd, ...items.slice(4)])
    expect(s.rowEnd).toBeNull()
    expect(keys(s.list)[0]).toBe('sep.9')
  })

  it('knows which section a key is in; the structure’s items are in neither', () => {
    const s = splitMenuSections(root())
    expect(menuSectionOf(s, 'icon.reload')).toBe('row')
    expect(menuSectionOf(s, 'sep.2')).toBe('list')
    expect(menuSectionOf(s, 'menu.change')).toBeNull()
    expect(menuSectionOf(s, 'row.nothing')).toBeNull()
  })

  it('the order Done saves is both sections’ keys, the row’s first, hairlines included, the structure left out', () => {
    expect(menuSectionsOrder(splitMenuSections(root()))).toEqual([
      'icon.forward',
      'icon.bookmark',
      'icon.reload',
      'row.newTab',
      'row.newPrivateTab',
      'sep.1',
      'row.history',
      'row.downloads',
      'sep.2',
      'row.settings'
    ])
  })
})

describe('moving items', () => {
  it('moves within a section by index, and never across sections', () => {
    const s = splitMenuSections(root())
    const moved = moveMenuSectionItem(s, 'row', 2, 0)
    expect(keys(moved.row)).toEqual(['icon.reload', 'icon.forward', 'icon.bookmark'])
    expect(moved.list).toBe(s.list)
    expect(moved.change).toBe(s.change)
    expect(keys(moveMenuSectionItem(s, 'list', 0, 6).list).at(-1)).toBe('row.newTab')
  })

  it('a nudge is one slot up or down – a hairline is a slot, so a row nudged past one changes groups – or to the start', () => {
    const s = splitMenuSections(root())
    const up = nudgeMenuItem(s, 'row.history', -1)
    expect(keys(up.list)).toEqual([
      'row.newTab',
      'row.newPrivateTab',
      'row.history',
      'sep.1',
      'row.downloads',
      'sep.2',
      'row.settings'
    ])
    const down = nudgeMenuItem(s, 'row.downloads', 1)
    expect(keys(down.list).slice(3)).toEqual([
      'row.history',
      'sep.2',
      'row.downloads',
      'row.settings'
    ])
    const start = nudgeMenuItem(s, 'row.settings', 'start')
    expect(keys(start.list)[0]).toBe('row.settings')
    const rowStart = nudgeMenuItem(s, 'icon.reload', 'start')
    expect(keys(rowStart.row)).toEqual(['icon.reload', 'icon.forward', 'icon.bookmark'])
  })

  it('a nudge off either end, of the first item to the start, or of a key of neither section leaves the sections as they are', () => {
    const s = splitMenuSections(root())
    expect(nudgeMenuItem(s, 'row.newTab', -1)).toBe(s)
    expect(nudgeMenuItem(s, 'row.settings', 1)).toBe(s)
    expect(nudgeMenuItem(s, 'row.newTab', 'start')).toBe(s)
    expect(nudgeMenuItem(s, 'icon.forward', -1)).toBe(s)
    expect(nudgeMenuItem(s, 'menu.change', 1)).toBe(s)
    expect(nudgeMenuItem(s, 'nowhere', 1)).toBe(s)
  })
})

describe('positions and the reader’s sentence', () => {
  it('counts rows, not hairlines: "3 of 5" reads over what the eye sees', () => {
    const s = splitMenuSections(root())
    expect(countedItems(s.list).map((i) => i.label)).toEqual([
      'New Tab',
      'New Private Tab',
      'History',
      'Downloads',
      'Settings'
    ])
    expect(positionOf(s.list, 'row.history')).toBe(3)
    expect(positionOf(s.list, 'row.settings')).toBe(5)
    expect(positionOf(s.list, 'sep.1')).toBe(0)
    expect(positionOf(s.row, 'icon.reload')).toBe(3)
  })

  it('says where the item went: its new place, the group it joined when its place did not change, or the start', () => {
    const s = splitMenuSections(root())
    const settings = s.list.find((i) => i.key === 'row.settings')!
    const history = s.list.find((i) => i.key === 'row.history')!
    const downloads = s.list.find((i) => i.key === 'row.downloads')!
    const reload = s.row.find((i) => i.key === 'icon.reload')!
    expect(movedSentence(s, nudgeMenuItem(s, 'row.downloads', -1), downloads, -1)).toBe(
      'Downloads moved to 3 of 5.'
    )
    expect(movedSentence(s, nudgeMenuItem(s, 'row.settings', -1), settings, -1)).toBe(
      'Settings moved to the group above, 5 of 5.'
    )
    expect(movedSentence(s, nudgeMenuItem(s, 'row.history', -1), history, -1)).toBe(
      'History moved to the group above, 3 of 5.'
    )
    expect(movedSentence(s, nudgeMenuItem(s, 'row.newPrivateTab', 1), s.list[1], 1)).toBe(
      'New Private Tab moved to the group below, 2 of 5.'
    )
    expect(movedSentence(s, nudgeMenuItem(s, 'row.settings', 'start'), settings, 'start')).toBe(
      'Settings moved to the start, 1 of 5.'
    )
    expect(movedSentence(s, nudgeMenuItem(s, 'icon.reload', -1), reload, -1)).toBe(
      'Reload moved to 2 of 3.'
    )
    expect(movedSentence(s, s, s.change[1], 1)).toBe('')
  })
})
