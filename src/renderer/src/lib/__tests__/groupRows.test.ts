import { describe, expect, it } from 'vitest'
import type { Folder, Tab } from '@shared/types'
import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID } from '@shared/types'
import { groupRowOf, groupRows, regularMembers } from '../groupRows'

/*
 * The one builder every surface reads a group through (lib/groupRows.ts; TAB-16 and its desktop
 * half): a group with live members is OPEN, one whose tabs all closed but which kept their pages
 * is SAVED, one with neither is EMPTY; the count and the moment of last use with each.
 */

const tab = (id: string, over: Partial<Tab> = {}): Tab =>
  ({
    id,
    spaceId: 's',
    containerId: DEFAULT_CONTAINER_ID,
    url: `https://${id}.example/`,
    title: id,
    folderId: 'g',
    lastActiveAt: 0,
    ...over
  }) as Tab

const folder = (over: Partial<Folder> = {}): Folder => ({
  id: 'g',
  spaceId: 's',
  name: 'Research',
  icon: '📁',
  color: 'blue',
  collapsed: false,
  ...over
})

const PAGES = [
  { url: 'https://alpha.example/', title: 'Alpha' },
  { url: 'https://beta.example/', title: 'Beta' },
  { url: 'https://gamma.example/', title: 'Gamma' }
]

describe('groupRowOf', () => {
  it('names a folder with live members an OPEN row counted by them, whatever it kept saved', () => {
    const row = groupRowOf(folder({ savedTabs: PAGES }), [tab('a'), tab('b')])
    expect(row.kind).toBe('open')
    expect(row.count).toBe(2)
    expect(row.folder.id).toBe('g')
  })

  it("dates an open row by the core's lastUsedAt, else by its newest activation, else not at all", () => {
    expect(
      groupRowOf(folder({ lastUsedAt: 5_000 }), [tab('a', { lastActiveAt: 9_000 })]).lastUsedAt
    ).toBe(5_000)
    expect(
      groupRowOf(folder(), [tab('a', { lastActiveAt: 3_000 }), tab('b', { lastActiveAt: 7_000 })])
        .lastUsedAt
    ).toBe(7_000)
    expect(groupRowOf(folder(), [tab('a')]).lastUsedAt).toBeNull()
  })

  it('names a folder whose tabs all closed but which kept their pages a SAVED row counted by the pages', () => {
    const row = groupRowOf(folder({ savedTabs: PAGES, lastUsedAt: 1_000 }), [])
    expect(row.kind).toBe('saved')
    expect(row.count).toBe(3)
    expect(row.lastUsedAt).toBe(1_000)
    expect(groupRowOf(folder({ savedTabs: PAGES }), []).lastUsedAt).toBeNull()
  })

  it('names a folder with neither an EMPTY row of no tabs', () => {
    expect(groupRowOf(folder(), [])).toEqual({
      folder: folder(),
      kind: 'empty',
      count: 0,
      lastUsedAt: null
    })
    expect(groupRowOf(folder({ savedTabs: [] }), []).kind).toBe('empty')
    expect(groupRowOf(folder({ savedTabs: null }), []).kind).toBe('empty')
  })

  it("counts the members its caller hands it – a regular surface's regular ones", () => {
    const live = [
      tab('a'),
      tab('p', { containerId: PRIVATE_CONTAINER_ID }),
      tab('q', { containerId: PRIVATE_CONTAINER_ID })
    ]
    expect(groupRowOf(folder(), regularMembers(live)).count).toBe(1)
    // Private tabs alone, pages saved: a saved group, its private members no part of the count.
    const saved = groupRowOf(folder({ savedTabs: PAGES }), regularMembers(live.slice(1)))
    expect(saved.kind).toBe('saved')
    expect(saved.count).toBe(3)
    // Private mode itself lists every member.
    expect(groupRowOf(folder(), live).count).toBe(3)
  })

  it('is what groupRows sorts into its lists', () => {
    const open = folder({ id: 'open' })
    const saved = folder({ id: 'saved', savedTabs: PAGES, lastUsedAt: 2_000 })
    const older = folder({ id: 'older', savedTabs: PAGES.slice(0, 1), lastUsedAt: 1_000 })
    const empty = folder({ id: 'empty' })
    const live = [tab('a', { folderId: 'open' })]
    const rows = groupRows([open, saved, older, empty], (id) =>
      live.filter((t) => t.folderId === id)
    )
    expect(rows.open).toEqual([groupRowOf(open, live), groupRowOf(empty, [])])
    expect(rows.saved).toEqual([groupRowOf(saved, []), groupRowOf(older, [])])
  })
})
