import { describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Platform, ReadingListEntry } from '../../shared/types'
import {
  READING_LIST_CAP,
  isReadingListUrl,
  sanitizeReadingList,
  sortReadingList,
  trimReadingList,
  unreadReadingCount
} from '../../shared/readingList'
import type { StoreIO } from '../platform'
import { ReadingListService } from '../readingList'
import { BrowserState, PERSISTED_VERSION } from '../state'

function fakeIo(initial: string | null = null): StoreIO & { writes: string[] } {
  const io = {
    writes: [] as string[],
    readSync: () => initial,
    write: async (_name: string, text: string) => {
      io.writes.push(text)
    },
    writeSync: (_name: string, text: string) => {
      io.writes.push(text)
    }
  }
  return io
}

function setup(
  initial: string | null = null,
  platform: Platform = 'linux'
): { state: BrowserState; service: ReadingListService; io: ReturnType<typeof fakeIo> } {
  const io = fakeIo(initial)
  const state = new BrowserState(io, platform, {} as HostCapabilities, '0.0')
  state.load()
  return { state, service: new ReadingListService(state), io }
}

function entry(over: Partial<ReadingListEntry> & { id: string }): ReadingListEntry {
  return {
    url: `https://example.com/${over.id}`,
    title: over.id,
    addedAt: 1000,
    updatedAt: 1000,
    ...over
  }
}

describe('ReadingListService: add, dedupe, read state', () => {
  it('starts empty and adds a page unread, newest first', () => {
    const { service } = setup()
    expect(service.list()).toEqual([])
    expect(service.unreadCount).toBe(0)
    const a = service.add('https://a.example/', 'A', 'data:image/png;base64,AA==')!
    const b = service.add('https://b.example/', 'B')!
    expect(a.id.startsWith('rl_')).toBe(true)
    expect(a.readAt).toBeUndefined()
    expect(a.favicon).toBe('data:image/png;base64,AA==')
    expect(b.favicon).toBeUndefined()
    expect(b.addedAt).toBeGreaterThan(a.addedAt)
    expect(service.list().map((e) => e.id)).toEqual([b.id, a.id])
    expect(service.unreadCount).toBe(2)
    expect(service.has('https://a.example/')).toBe(true)
    expect(service.has('https://c.example/')).toBe(false)
  })

  it('dedupes by URL: re-adding marks the entry unread again and brings it to the top', () => {
    const { service } = setup()
    const a = service.add('https://a.example/', 'A')!
    const b = service.add('https://b.example/', 'B')!
    expect(service.setRead(a.id, true)).toBe(true)
    expect(service.list().map((e) => e.id)).toEqual([b.id, a.id])
    expect(service.unreadCount).toBe(1)
    const again = service.add('https://a.example/', 'A (updated)', 'data:,f')!
    expect(again.id).toBe(a.id)
    expect(again.readAt).toBeUndefined()
    expect(again.title).toBe('A (updated)')
    expect(again.favicon).toBe('data:,f')
    expect(again.addedAt).toBeGreaterThan(b.addedAt)
    expect(service.list().map((e) => e.id)).toEqual([a.id, b.id])
    expect(service.list()).toHaveLength(2)
    expect(service.unreadCount).toBe(2)
  })

  it('keeps the favicon it had when a re-add brings none, and falls back to the host for an empty title', () => {
    const { service } = setup()
    const a = service.add('https://news.example/story', 'Story', 'data:,icon')!
    const again = service.add('https://news.example/story', '   ')!
    expect(again.favicon).toBe('data:,icon')
    expect(again.title).toBe('news.example')
  })

  it("refuses the browser's own pages and blank tabs", () => {
    const { service } = setup()
    expect(service.add('zen://settings', 'Settings')).toBeNull()
    expect(service.add('about:blank', '')).toBeNull()
    expect(service.add('file:///tmp/a.html', 'a')).toBeNull()
    expect(service.canAdd('https://a.example/')).toBe(true)
    expect(service.canAdd('http://a.example/')).toBe(true)
    expect(isReadingListUrl('zen://reading-list')).toBe(false)
    expect(service.list()).toEqual([])
  })

  it('setRead / toggleRead / markAllRead flip the state and report what changed', () => {
    const { service } = setup()
    const a = service.add('https://a.example/', 'A')!
    const b = service.add('https://b.example/', 'B')!
    const c = service.add('https://c.example/', 'C')!
    expect(service.setRead(a.id, false)).toBe(false)
    expect(service.setRead(a.id, true)).toBe(true)
    expect(service.get(a.id)!.readAt).toBeGreaterThan(0)
    expect(service.get(a.id)!.updatedAt).toBe(service.get(a.id)!.readAt)
    expect(service.setRead(a.id, true)).toBe(false)
    expect(service.toggleRead(a.id)).toBe(true)
    expect(service.get(a.id)!.readAt).toBeUndefined()
    expect(service.toggleRead('rl_missing')).toBe(false)
    expect(service.setRead('rl_missing', true)).toBe(false)
    expect(service.unreadCount).toBe(3)
    expect(service.markAllRead()).toBe(3)
    expect(service.unreadCount).toBe(0)
    expect(service.markAllRead()).toBe(0)
    // Read entries keep the newest-first order among themselves.
    expect(service.list().map((e) => e.id)).toEqual([c.id, b.id, a.id])
  })

  it('remove takes an entry by id, removeUrl by address; a miss is reported', () => {
    const { service } = setup()
    const a = service.add('https://a.example/', 'A')!
    const b = service.add('https://b.example/', 'B')!
    expect(service.remove(a.id)).toBe(true)
    expect(service.remove(a.id)).toBe(false)
    expect(service.removeUrl('https://b.example/')).toBe(true)
    expect(service.removeUrl('https://b.example/')).toBe(false)
    expect(service.get(b.id)).toBeNull()
    expect(service.list()).toEqual([])
  })

  it('orders the unread first, newest first within each half, whatever the array order', () => {
    const { service, state } = setup()
    state.readingList = [
      entry({ id: 'r-old', addedAt: 1, readAt: 5 }),
      entry({ id: 'u-old', addedAt: 2 }),
      entry({ id: 'r-new', addedAt: 3, readAt: 9 }),
      entry({ id: 'u-new', addedAt: 4 })
    ]
    expect(service.list().map((e) => e.id)).toEqual(['u-new', 'u-old', 'r-new', 'r-old'])
    expect(unreadReadingCount(state.readingList)).toBe(2)
    // Ties on the time fall back to the id, so the order is total.
    expect(
      sortReadingList([entry({ id: 'b', addedAt: 1 }), entry({ id: 'a', addedAt: 1 })]).map(
        (e) => e.id
      )
    ).toEqual(['a', 'b'])
  })

  it('tells its subscribers after every write and lets them go', () => {
    const { service } = setup()
    const heard = vi.fn()
    const off = service.subscribe(heard)
    const a = service.add('https://a.example/', 'A')!
    service.setRead(a.id, true)
    service.setRead(a.id, true) // no change: no write
    service.remove(a.id)
    expect(heard).toHaveBeenCalledTimes(3)
    off()
    service.add('https://b.example/', 'B')
    expect(heard).toHaveBeenCalledTimes(3)
  })
})

describe('ReadingListService: the cap', () => {
  it('holds a thousand entries and drops the oldest read one first past it', () => {
    const { service, state } = setup()
    const entries: ReadingListEntry[] = []
    for (let i = 0; i < READING_LIST_CAP; i++) {
      entries.push(entry({ id: `e${i}`, addedAt: 10 + i, readAt: i % 2 === 0 ? 5000 : undefined }))
    }
    state.readingList = entries
    const added = service.add('https://new.example/', 'New')!
    expect(state.readingList).toHaveLength(READING_LIST_CAP)
    expect(service.get(added.id)).not.toBeNull()
    // e0 is the oldest read entry: it went. e1, the oldest unread, stays.
    expect(service.get('e0')).toBeNull()
    expect(service.get('e1')).not.toBeNull()
    expect(service.get('e2')).not.toBeNull()
  })

  it('drops the oldest unread entry only when every entry is unread', () => {
    const all = Array.from({ length: 5 }, (_, i) => entry({ id: `e${i}`, addedAt: i }))
    expect(trimReadingList(all, 4).map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4'])
    const mixed = [
      entry({ id: 'u0', addedAt: 0 }),
      entry({ id: 'r9', addedAt: 9, readAt: 10 }),
      entry({ id: 'r1', addedAt: 1, readAt: 10 }),
      entry({ id: 'u2', addedAt: 2 })
    ]
    // The oldest READ (r1) goes before the oldest unread (u0); the input order is kept.
    expect(trimReadingList(mixed, 3).map((e) => e.id)).toEqual(['u0', 'r9', 'u2'])
    expect(trimReadingList(mixed, 2).map((e) => e.id)).toEqual(['u0', 'u2'])
    // Within the cap the same array comes back: a caller can tell a no-op.
    expect(trimReadingList(mixed, 4)).toBe(mixed)
  })
})

describe('ReadingListService: persistence', () => {
  it('writes the list into state.json and loads it back, unread state and all', async () => {
    const { service, state, io } = setup()
    const a = service.add('https://a.example/', 'A', 'data:,a')!
    const b = service.add('https://b.example/', 'B')!
    service.setRead(b.id, true)
    await state.flush()
    const written = JSON.parse(io.writes.at(-1)!)
    expect(written.version).toBe(PERSISTED_VERSION)
    expect(written.readingList).toHaveLength(2)

    const reloaded = setup(io.writes.at(-1)!)
    const list = reloaded.service.list()
    expect(list.map((e) => e.id)).toEqual([a.id, b.id])
    expect(list[0]).toEqual(a)
    expect(list[1].readAt).toBe(reloaded.service.get(b.id)!.readAt)
    expect(reloaded.service.unreadCount).toBe(1)
    expect(reloaded.state.snapshot).toBeDefined()
  })

  it('loads a profile from before the list existed with an empty list', () => {
    const { service } = setup(JSON.stringify({ version: 6, settings: {} }))
    expect(service.list()).toEqual([])
    expect(service.unreadCount).toBe(0)
  })

  it('sanitises what it loads: malformed entries, duplicate ids and URLs, the cap', () => {
    const loaded = sanitizeReadingList([
      { id: 'ok', url: 'https://ok.example/', title: 'OK', addedAt: 10, updatedAt: 10 },
      { id: 'no-url', title: 'x', addedAt: 10, updatedAt: 10 },
      { id: 'bad-time', url: 'https://t.example/', title: 't', addedAt: 'yesterday' },
      { url: 'https://no-id.example/', title: 'x', addedAt: 10, updatedAt: 10 },
      { id: 'ok', url: 'https://dup-id.example/', title: 'dup', addedAt: 11, updatedAt: 11 },
      { id: 'later', url: 'https://ok.example/', title: 'Later', addedAt: 12, updatedAt: 12 },
      { id: 'untitled', url: 'https://u.example/', title: '', addedAt: 3, readAt: 4 },
      'nonsense',
      null
    ])
    // The later entry for the same URL wins; the duplicate id is dropped; the untitled entry
    // takes its URL for a title and its updatedAt from the times it has.
    expect(loaded.map((e) => e.id)).toEqual(['later', 'untitled'])
    expect(loaded[1]).toEqual({
      id: 'untitled',
      url: 'https://u.example/',
      title: 'https://u.example/',
      addedAt: 3,
      readAt: 4,
      updatedAt: 4
    })
    expect(sanitizeReadingList(undefined)).toEqual([])
    expect(sanitizeReadingList({ not: 'a list' })).toEqual([])
    const many = Array.from({ length: READING_LIST_CAP + 5 }, (_, i) =>
      entry({ id: `e${i}`, url: `https://e.example/${i}`, addedAt: i })
    )
    expect(sanitizeReadingList(many)).toHaveLength(READING_LIST_CAP)
  })

  it('shows the sorted list in every window snapshot', () => {
    const { service, state } = setup()
    const a = service.add('https://a.example/', 'A')!
    const b = service.add('https://b.example/', 'B')!
    service.setRead(b.id, true)
    const win = state.liveWindows()[0]
    if (win) {
      expect(state.snapshot(win).readingList.map((e) => e.id)).toEqual([a.id, b.id])
    }
    // The order is computed once per write: the same array comes back while nothing changed.
    const first = state['readingListFor']()
    expect(state['readingListFor']()).toBe(first)
    service.setRead(a.id, true)
    expect(state['readingListFor']()).not.toBe(first)
  })
})
