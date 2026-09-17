import { describe, expect, it } from 'vitest'
import type { ClosedEntry, ClosedTabEntry, ClosedWindowEntry } from '../../shared/types'
import { PRIVATE_CONTAINER_ID } from '../../shared/types'
import { createTabRecord } from '../model'
import {
  closedTabEntry,
  closedWindowEntry,
  pushClosed,
  RECENTLY_CLOSED_MAX,
  sanitizeClosedEntries,
  summarizeClosed
} from '../session'

function tabEntry(url: string, closedAt = 1000, containerId = 'default'): ClosedTabEntry {
  const tab = createTabRecord({ spaceId: 'space_1', containerId, url, title: `Title ${url}` })
  return closedTabEntry(
    tab,
    { spaceId: 'space_1', folderId: null, index: 2, windowId: null },
    {
      entries: [
        { url: 'https://before.test/', title: 'Before' },
        { url, title: tab.title }
      ],
      index: 1
    },
    closedAt
  )
}

describe('closedTabEntry', () => {
  it('captures the tab detached from splits, unloaded, with its placement and stack', () => {
    const tab = createTabRecord({
      spaceId: 'space_1',
      containerId: 'default',
      url: 'https://a.test/',
      discarded: false
    })
    tab.splitGroupId = 'split_1'
    tab.loading = true
    tab.audible = true
    const entry = closedTabEntry(
      tab,
      { spaceId: 'space_1', folderId: 'folder_1', index: 4, windowId: 'window_1' },
      { entries: [{ url: 'https://a.test/', title: 'A' }], index: 0 },
      123
    )
    expect(entry).toMatchObject({
      kind: 'tab',
      closedAt: 123,
      spaceId: 'space_1',
      folderId: 'folder_1',
      index: 4,
      windowId: 'window_1'
    })
    expect(entry.tab).toMatchObject({
      splitGroupId: null,
      discarded: true,
      loading: false,
      audible: false
    })
    expect(entry.navigation?.entries).toHaveLength(1)
    expect(entry.id).toMatch(/^closed_/)
  })
})

describe('pushClosed', () => {
  it('keeps the newest first and never more than the cap', () => {
    let list: ClosedEntry[] = []
    for (let i = 0; i < RECENTLY_CLOSED_MAX + 3; i++)
      list = pushClosed(list, tabEntry(`https://s${i}.test/`, i))
    expect(list).toHaveLength(RECENTLY_CLOSED_MAX)
    expect(list[0].closedAt).toBe(RECENTLY_CLOSED_MAX + 2)
    expect(list[list.length - 1].closedAt).toBe(3)
  })
})

describe('summarizeClosed', () => {
  it('describes a tab by its (custom) title and a window by its active tab and tab count', () => {
    const t = tabEntry('https://a.test/')
    t.tab.customTitle = 'Renamed'
    t.tab.favicon = 'data:icon'
    expect(summarizeClosed(t)).toEqual({
      id: t.id,
      kind: 'tab',
      title: 'Renamed',
      url: 'https://a.test/',
      favicon: 'data:icon',
      closedAt: 1000,
      tabCount: 1
    })
    const other = tabEntry('https://b.test/')
    const win = closedWindowEntry(
      'unsynced',
      { x: 1, y: 2, width: 3, height: 4 },
      other.tab.id,
      [t, other],
      5
    )
    expect(summarizeClosed(win)).toMatchObject({
      kind: 'window',
      title: 'Title https://b.test/',
      url: 'https://b.test/',
      tabCount: 2,
      closedAt: 5
    })
    const noActive = closedWindowEntry('synced', null, 'missing', [t], 6)
    expect(summarizeClosed(noActive).title).toBe('Renamed')
  })
})

describe('sanitizeClosedEntries', () => {
  it('drops garbage, private tabs and windows, and empty windows; keeps navigation snapshots', () => {
    const good = tabEntry('https://a.test/')
    const priv = tabEntry('https://p.test/', 2, PRIVATE_CONTAINER_ID)
    const window: ClosedWindowEntry = closedWindowEntry('unsynced', null, null, [good, priv], 7)
    const privateWindow = closedWindowEntry('private', null, null, [tabEntry('https://x.test/')], 8)
    const emptyWindow = closedWindowEntry('synced', null, null, [priv], 9)
    const out = sanitizeClosedEntries([
      good,
      priv,
      window,
      privateWindow,
      emptyWindow,
      null,
      'x',
      { kind: 'tab', id: 'closed_bad' },
      { ...good, id: 'closed_nonav', navigation: { entries: 'nope' } }
    ])
    expect(out.map((e) => e.kind)).toEqual(['tab', 'window', 'tab'])
    expect((out[0] as ClosedTabEntry).navigation?.index).toBe(1)
    expect((out[1] as ClosedWindowEntry).tabs).toHaveLength(1)
    expect((out[2] as ClosedTabEntry).navigation).toBeNull()
    expect(sanitizeClosedEntries('not a list')).toEqual([])
    expect(sanitizeClosedEntries(undefined)).toEqual([])
  })

  it('caps the list', () => {
    const many = Array.from({ length: RECENTLY_CLOSED_MAX + 5 }, (_, i) =>
      tabEntry(`https://s${i}.test/`, i)
    )
    expect(sanitizeClosedEntries(many)).toHaveLength(RECENTLY_CLOSED_MAX)
  })
})
