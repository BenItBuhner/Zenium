import { describe, expect, it } from 'vitest'
import type { MenuItemDescriptor } from '@shared/types'
import {
  countedItems,
  editableMenu,
  isChangeMenuItem,
  isManagedMenuItem,
  isUpdateMenuItem,
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

  it('the Update Zenium row under the icon row (TB-12) is structure with its hairline: out of both sections, out of the saved order, back in its seat on the join', () => {
    const items = root()
    const update = [item('Update Zenium', { key: 'menu.update' }), sep()]
    const withUpdate = [...items.slice(0, 4), ...update, ...items.slice(4)]
    const s = splitMenuSections(withUpdate)
    expect(keys(s.row)).toEqual(['icon.forward', 'icon.bookmark', 'icon.reload'])
    expect(s.rowEnd).toBe(withUpdate[3])
    expect(keys(s.update)).toEqual(['menu.update', '(separator)'])
    expect(keys(s.list)[0]).toBe('row.newTab')
    expect(keys(s.list)).toEqual(keys(splitMenuSections(items).list))
    expect(joinMenuSections(s)).toEqual(withUpdate)
    expect(menuSectionOf(s, 'menu.update')).toBeNull()
    expect(menuSectionsOrder(s)).toEqual(menuSectionsOrder(splitMenuSections(items)))
    expect(isUpdateMenuItem(withUpdate[4]!)).toBe(true)
    expect(isUpdateMenuItem(withUpdate[0]!)).toBe(false)
    // A nudge names no section for it: the row does not move.
    expect(nudgeMenuItem(s, 'menu.update', 1)).toBe(s)
    // With no update waiting the section is empty and the split is as before.
    expect(splitMenuSections(items).update).toEqual([])
    // A menu without an icon row seats it first, its hairline with it.
    const bare = [
      ...update,
      item('Open', { key: 'row.open' }),
      sep(),
      item('Change Menu', { key: 'menu.change' })
    ]
    const b = splitMenuSections(bare)
    expect(b.row).toEqual([])
    expect(keys(b.update)).toEqual(['menu.update', '(separator)'])
    expect(keys(b.list)).toEqual(['row.open'])
    expect(joinMenuSections(b)).toEqual(bare)
    // The row's hairline is only ever the unkeyed one under it: a keyed hairline is the list's.
    const keyedUnder = [...items.slice(0, 4), update[0]!, sep('sep.9'), ...items.slice(4)]
    const k = splitMenuSections(keyedUnder)
    expect(keys(k.update)).toEqual(['menu.update'])
    expect(keys(k.list)[0]).toBe('sep.9')
    expect(joinMenuSections(k)).toEqual(keyedUnder)
  })

  it("the sidebar layouts' root on a coarse pointer (W8-F3): no icon row, no Change Menu row, the keyed Update Zenium row at its head splits into `update` with its hairline, the rest the list; unkeyed, it would be a plain list row", () => {
    // The desktop's / the tablet's menu as the core composes it while an update waits: the row
    // and its hairline, then Firefox's groups – some rows keyed for the sheet, most not.
    const sidebar = [
      item('Update Zenium', { key: 'menu.update' }),
      sep(),
      item('New Tab'),
      item('Search Tabs…'),
      item('New Private Tab', { key: 'row.newPrivateTab' }),
      sep(),
      item('Bookmarks'),
      item('Settings')
    ]
    const s = splitMenuSections(sidebar)
    expect(s.row).toEqual([])
    expect(s.rowEnd).toBeNull()
    expect(keys(s.update)).toEqual(['menu.update', '(separator)'])
    expect(s.list).toEqual(sidebar.slice(2))
    expect(s.change).toEqual([])
    expect(editableMenu(sidebar)).toBe(false)
    expect(joinMenuSections(s)).toEqual(sidebar)
    expect(menuSectionOf(s, 'menu.update')).toBeNull()
    expect(nudgeMenuItem(s, 'menu.update', 1)).toBe(s)
    // The same root with the row unkeyed (the desktop's before W8-F3): the row is the list's
    // first item, its hairline the list's first slot – why the key travels with the row.
    const unkeyed = [item('Update Zenium'), ...sidebar.slice(1)]
    const u = splitMenuSections(unkeyed)
    expect(u.update).toEqual([])
    expect(u.list).toEqual(unkeyed)
    expect(joinMenuSections(u)).toEqual(unkeyed)
  })

  it('the Managed Browser row last of all (TB-13) is structure with its hairline: out of both sections and the saved order, after the Change Menu group on the join; the tablet’s root, with no Change Menu row, cuts the same', () => {
    const items = root()
    const managed = [sep(), item('Managed Browser', { key: 'menu.managed', mark: 'managed' })]
    const withManaged = [...items, ...managed]
    const s = splitMenuSections(withManaged)
    expect(keys(s.row)).toEqual(['icon.forward', 'icon.bookmark', 'icon.reload'])
    expect(keys(s.list)).toEqual(keys(splitMenuSections(items).list))
    expect(keys(s.change)).toEqual(['(separator)', 'menu.change'])
    expect(keys(s.managed)).toEqual(['(separator)', 'menu.managed'])
    expect(joinMenuSections(s)).toEqual(withManaged)
    expect(menuSectionOf(s, 'menu.managed')).toBeNull()
    expect(menuSectionsOrder(s)).toEqual(menuSectionsOrder(splitMenuSections(items)))
    expect(nudgeMenuItem(s, 'menu.managed', -1)).toBe(s)
    expect(isManagedMenuItem(managed[1]!)).toBe(true)
    expect(isManagedMenuItem(items[0]!)).toBe(false)
    expect(editableMenu(withManaged)).toBe(true)
    // Unmanaged: the section is empty and the split is as before.
    expect(splitMenuSections(items).managed).toEqual([])
    // The tablet's popover root on a coarse pointer: no icon row, no Change Menu row, the
    // managed row and its hairline at the tail, the rest the list.
    const tablet = [item('New Tab'), sep(), item('Help'), ...managed]
    const t = splitMenuSections(tablet)
    expect(t.row).toEqual([])
    expect(t.change).toEqual([])
    expect(t.list).toEqual(tablet.slice(0, 3))
    expect(keys(t.managed)).toEqual(['(separator)', 'menu.managed'])
    expect(joinMenuSections(t)).toEqual(tablet)
    // The row's hairline is only ever the unkeyed one before it: a keyed hairline is the list's.
    const keyedBefore = [...tablet.slice(0, 3), sep('sep.9'), managed[1]!]
    const k = splitMenuSections(keyedBefore)
    expect(keys(k.managed)).toEqual(['menu.managed'])
    expect(keys(k.list).at(-1)).toBe('sep.9')
    expect(joinMenuSections(k)).toEqual(keyedBefore)
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
