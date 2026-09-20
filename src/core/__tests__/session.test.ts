import { describe, expect, it } from 'vitest'
import type { ClosedEntry, ClosedTabEntry, ClosedWindowEntry } from '../../shared/types'
import { PRIVATE_CONTAINER_ID } from '../../shared/types'
import { createTabRecord } from '../model'
import {
  closedTabEntry,
  closedWindowEntry,
  isKeepableHostState,
  NAVIGATION_ENTRIES_MAX,
  NAVIGATION_HOST_STATE_MAX_CHARS,
  pushClosed,
  RECENTLY_CLOSED_MAX,
  sanitizeClosedEntries,
  sanitizeSnapshot,
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

describe('sanitizeSnapshot', () => {
  it('keeps well-formed entries with their page state and clamps the index', () => {
    expect(
      sanitizeSnapshot({
        entries: [
          { url: 'https://a.test/', title: 'A', pageState: 'c2Nyb2xs' },
          { url: 'https://b.test/', title: 7, pageState: '' },
          { url: '', title: 'no url' },
          null,
          'x'
        ],
        index: 9
      })
    ).toEqual({
      entries: [
        { url: 'https://a.test/', title: 'A', pageState: 'c2Nyb2xs' },
        { url: 'https://b.test/', title: '' }
      ],
      index: 1
    })
    expect(sanitizeSnapshot({ entries: [], index: 0 })).toBeNull()
    expect(sanitizeSnapshot({ entries: 'nope', index: 0 })).toBeNull()
    expect(sanitizeSnapshot({ entries: [{ url: 'https://a.test/' }] })).toBeNull()
    expect(sanitizeSnapshot(null)).toBeNull()
  })

  it('cuts a long stack to the newest entries and moves the index with them', () => {
    const entries = Array.from({ length: NAVIGATION_ENTRIES_MAX + 10 }, (_, i) => ({
      url: `https://s${i}.test/`,
      title: ''
    }))
    const out = sanitizeSnapshot({ entries, index: entries.length - 3 })
    expect(out?.entries).toHaveLength(NAVIGATION_ENTRIES_MAX)
    expect(out?.entries[0].url).toBe('https://s10.test/')
    expect(out?.index).toBe(NAVIGATION_ENTRIES_MAX - 3)
    // An index that pointed into the dropped part lands on the oldest kept entry.
    expect(sanitizeSnapshot({ entries, index: 2 })?.index).toBe(0)
  })

  describe('hostState (the host’s own serialisation of the whole stack)', () => {
    const entries = [
      { url: 'https://a.test/', title: 'A' },
      { url: 'https://b.test/', title: 'B' }
    ]
    const blob = 'AAAAB'.repeat(200)

    it('stays when it is a string within the cap and every entry survived', () => {
      expect(sanitizeSnapshot({ entries, index: 1, hostState: blob })).toEqual({
        entries,
        index: 1,
        hostState: blob
      })
      const atCap = 'x'.repeat(NAVIGATION_HOST_STATE_MAX_CHARS)
      expect(sanitizeSnapshot({ entries, index: 0, hostState: atCap })?.hostState).toBe(atCap)
    })

    it('goes when it is not a string, empty or over 64 KB', () => {
      const without = { entries, index: 1 }
      expect(sanitizeSnapshot({ ...without, hostState: 42 })).toEqual(without)
      expect(sanitizeSnapshot({ ...without, hostState: { bundle: blob } })).toEqual(without)
      expect(sanitizeSnapshot({ ...without, hostState: '' })).toEqual(without)
      expect(sanitizeSnapshot({ ...without, hostState: null })).toEqual(without)
      const over = 'x'.repeat(NAVIGATION_HOST_STATE_MAX_CHARS + 1)
      expect(sanitizeSnapshot({ ...without, hostState: over })).toEqual(without)
      expect(sanitizeSnapshot(without)).not.toHaveProperty('hostState')
    })

    it('goes with a stack cut to NAVIGATION_ENTRIES_MAX: it described the whole list', () => {
      const long = Array.from({ length: NAVIGATION_ENTRIES_MAX + 1 }, (_, i) => ({
        url: `https://s${i}.test/`,
        title: ''
      }))
      const out = sanitizeSnapshot({ entries: long, index: long.length - 1, hostState: blob })
      expect(out?.entries).toHaveLength(NAVIGATION_ENTRIES_MAX)
      expect(out).not.toHaveProperty('hostState')
      // Exactly the cap is not a cut.
      const full = long.slice(1)
      expect(sanitizeSnapshot({ entries: full, index: 3, hostState: blob })?.hostState).toBe(blob)
    })

    it('goes when a malformed entry was left out of the list', () => {
      const out = sanitizeSnapshot({
        entries: [...entries, { url: '', title: 'no url' }],
        index: 1,
        hostState: blob
      })
      expect(out?.entries).toEqual(entries)
      expect(out).not.toHaveProperty('hostState')
    })

    it('rides through a stored recently-closed entry', () => {
      const stored = sanitizeClosedEntries([
        { ...tabEntry('https://a.test/'), navigation: { entries, index: 1, hostState: blob } }
      ])
      expect(stored[0]?.kind === 'tab' && stored[0].navigation?.hostState).toBe(blob)
    })

    it('isKeepableHostState is the one rule for the blob', () => {
      expect(isKeepableHostState(blob)).toBe(true)
      expect(isKeepableHostState('')).toBe(false)
      expect(isKeepableHostState(undefined)).toBe(false)
      expect(isKeepableHostState(null)).toBe(false)
      expect(isKeepableHostState(['x'])).toBe(false)
      expect(isKeepableHostState('x'.repeat(NAVIGATION_HOST_STATE_MAX_CHARS + 1))).toBe(false)
      expect(NAVIGATION_HOST_STATE_MAX_CHARS).toBe(64 * 1024)
    })
  })
})
