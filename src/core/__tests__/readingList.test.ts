import { describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Platform, ReadingListEntry } from '../../shared/types'
import {
  READING_LIST_CAP,
  filterReadingList,
  isReadingListUrl,
  sanitizeReadingEntry,
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

/** An entry in the list's normal form: the field order every write and the sanitiser produce. */
function normal(
  over: Partial<ReadingListEntry> & { id: string; addedAt: number }
): ReadingListEntry {
  const e: ReadingListEntry = {
    id: over.id,
    url: over.url ?? `https://example.com/${over.id}`,
    title: over.title ?? over.id,
    addedAt: over.addedAt,
    updatedAt: over.updatedAt ?? Math.max(over.addedAt, over.readAt ?? 0)
  }
  if (over.favicon) e.favicon = over.favicon
  if (over.readAt !== undefined) e.readAt = over.readAt
  return e
}

/** The bytes the profile writes: what the sync engine's diff would see change. */
function bytes(value: unknown): string {
  return JSON.stringify(value)
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
    service.add('https://news.example/story', 'Story', 'data:,icon')
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

/**
 * The cap (services pass 11, item 4; the root's ruling, the mechanism agreed with desktop):
 * `READING_LIST_CAP` bounds the READ half alone – the oldest by `readAt` go first, a tie by the
 * id – and an unread entry is never trimmed, on any path (`trimReadingList`, the one trim the
 * write, the load and the apply take).
 */
describe('ReadingListService: the cap', () => {
  /** `n` read entries with rising `readAt`s and `n` unread ones, ids padded so they sort as numbers. */
  function readAndUnread(readN: number, unreadN: number): ReadingListEntry[] {
    const list: ReadingListEntry[] = []
    for (let i = 0; i < readN; i++) {
      list.push(normal({ id: `r${String(i).padStart(4, '0')}`, addedAt: 10 + i, readAt: 5000 + i }))
    }
    for (let i = 0; i < unreadN; i++) {
      list.push(normal({ id: `u${String(i).padStart(4, '0')}`, addedAt: 10 + i }))
    }
    return list
  }

  it('the 1 001st unread save keeps every entry: an unread entry never counts against the cap', () => {
    const { service, state } = setup()
    state.readingList = readAndUnread(0, READING_LIST_CAP)
    const added = service.add('https://new.example/', 'New')!
    expect(state.readingList).toHaveLength(READING_LIST_CAP + 1)
    expect(service.get(added.id)).not.toBeNull()
    expect(service.get('u0000')).not.toBeNull()
    expect(service.unreadCount).toBe(READING_LIST_CAP + 1)
    // Nor with the read half full: 1 000 read + 1 000 unread, another unread save keeps all.
    state.readingList = readAndUnread(READING_LIST_CAP, READING_LIST_CAP)
    service.add('https://another.example/', 'Another')
    expect(state.readingList).toHaveLength(2 * READING_LIST_CAP + 1)
    expect(service.get('r0000')).not.toBeNull()
  })

  it('with 1 000 read + 1 unread, marking one more read drops the oldest-readAt read entry and never the unread', () => {
    const { service, state } = setup()
    state.readingList = readAndUnread(READING_LIST_CAP, 1)
    const extra = service.add('https://extra.example/', 'Extra')!
    expect(state.readingList).toHaveLength(READING_LIST_CAP + 2)
    // The unread page is read: the read half runs to 1 001 and its oldest by `readAt` goes.
    expect(service.setRead('u0000', true)).toBe(true)
    expect(state.readingList).toHaveLength(READING_LIST_CAP + 1)
    expect(service.get('r0000')).toBeNull()
    expect(service.get('r0001')).not.toBeNull()
    expect(service.get('u0000')?.readAt).toBeDefined()
    expect(service.get(extra.id)).not.toBeNull()
    expect(service.unreadCount).toBe(1)
    // Read again over the cap: the next oldest goes – r0001 – the unread one still never.
    expect(service.setRead(extra.id, true)).toBe(true)
    expect(service.get('r0001')).toBeNull()
    expect(service.get('r0002')).not.toBeNull()
    expect(state.readingList).toHaveLength(READING_LIST_CAP)
  })

  it('trims read entries only, oldest readAt first, and hands the same array back when nothing had to go', () => {
    // Five unread over a cap of four: nothing goes, the same array.
    const all = Array.from({ length: 5 }, (_, i) => entry({ id: `e${i}`, addedAt: i }))
    expect(trimReadingList(all, 4)).toBe(all)
    const mixed = [
      entry({ id: 'u0', addedAt: 0 }),
      entry({ id: 'r9', addedAt: 9, readAt: 10 }),
      entry({ id: 'r1', addedAt: 1, readAt: 12 }),
      entry({ id: 'u2', addedAt: 2 })
    ]
    // Two read under a cap of two: the same array back. One: the oldest READ by `readAt` (r9,
    // read at 10, though added later than r1) goes; the input order is kept.
    expect(trimReadingList(mixed, 2)).toBe(mixed)
    expect(trimReadingList(mixed, 1).map((e) => e.id)).toEqual(['u0', 'r1', 'u2'])
    // A cap of none: every read entry goes, every unread stays.
    expect(trimReadingList(mixed, 0).map((e) => e.id)).toEqual(['u0', 'u2'])
  })

  it('never rewrites an entry it keeps: the trim hands back the very objects, the cap in the sanitiser the same bytes', () => {
    const list = [
      normal({ id: 'u0', addedAt: 0 }),
      normal({ id: 'r1', addedAt: 1, readAt: 10, favicon: 'data:,r1' }),
      normal({ id: 'r3', addedAt: 3, readAt: 4 }),
      normal({ id: 'u2', addedAt: 2 })
    ]
    const kept = trimReadingList(list, 1)
    expect(kept.map((e) => e.id)).toEqual(['u0', 'r1', 'u2'])
    // The survivors are the input's own objects, not copies: no `updatedAt` bump, no field moved.
    for (const e of kept) expect(list.includes(e)).toBe(true)
    const many = Array.from({ length: READING_LIST_CAP + 5 }, (_, i) =>
      normal({
        id: `e${String(i).padStart(4, '0')}`,
        url: `https://e.example/${i}`,
        addedAt: i,
        updatedAt: i + 1,
        favicon: 'data:,x',
        readAt: i + 1
      })
    )
    const loaded = sanitizeReadingList(many)
    expect(loaded).toHaveLength(READING_LIST_CAP)
    expect(loaded.map((e) => e.id).slice(0, 2)).toEqual(['e0005', 'e0006'])
    const byId = new Map(many.map((e) => [e.id, e]))
    for (const e of loaded) expect(bytes(e)).toBe(bytes(byId.get(e.id)))
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
    // The cap at load is the shared trim's: read entries past it go (oldest `readAt` first), an
    // unread entry never – a profile with 1 005 unread pages loads all 1 005.
    const manyUnread = Array.from({ length: READING_LIST_CAP + 5 }, (_, i) =>
      entry({ id: `e${i}`, url: `https://e.example/${i}`, addedAt: i })
    )
    expect(sanitizeReadingList(manyUnread)).toHaveLength(READING_LIST_CAP + 5)
    const manyRead = Array.from({ length: READING_LIST_CAP + 5 }, (_, i) =>
      entry({ id: `e${i}`, url: `https://e.example/${i}`, addedAt: i, readAt: 10_000 + i })
    )
    const loadedRead = sanitizeReadingList(manyRead)
    expect(loadedRead).toHaveLength(READING_LIST_CAP)
    for (let i = 0; i < 5; i++) expect(loadedRead.some((e) => e.id === `e${i}`)).toBe(false)
  })

  it('is idempotent on a clean profile: a load rewrites no byte of the service’s own writes', async () => {
    const { service, state, io } = setup()
    // Every write path once: a new entry with and without a favicon, read, read and back,
    // a re-add of a read entry (favicon refreshed), mark all, unread again.
    const a = service.add('https://a.example/', 'A', 'data:,a')!
    const b = service.add('https://b.example/', 'B')!
    service.add('https://c.example/', 'C')
    service.setRead(a.id, true)
    service.setRead(b.id, true)
    service.setRead(b.id, false)
    service.add('https://a.example/', 'A again', 'data:,a2')
    service.markAllRead()
    service.setRead(a.id, false)
    const written = bytes(state.readingList)
    // Each write left the fields in the normal form's order, whichever path it took.
    expect(written).toBe(bytes(state.readingList.map((e) => normal(e))))
    // The sanitiser's normal form is what the writes left: same bytes, same order, twice over.
    expect(bytes(sanitizeReadingList(JSON.parse(written)))).toBe(written)
    expect(bytes(sanitizeReadingList(sanitizeReadingList(state.readingList)))).toBe(written)
    await state.flush()
    const reloaded = setup(io.writes.at(-1)!)
    expect(bytes(reloaded.state.readingList)).toBe(written)
    expect(bytes(reloaded.state.readingList)).toBe(bytes(JSON.parse(io.writes.at(-1)!).readingList))
  })

  it('imposes the normal form once on an entry written in another order, and drops what it does not know', () => {
    const scrambled = {
      readAt: 4,
      extra: 'not a field',
      updatedAt: 4,
      title: 'T',
      url: 'https://t.example/',
      id: 'rl_t',
      addedAt: 3,
      favicon: 'data:,t'
    }
    const once = sanitizeReadingEntry(scrambled)!
    expect(bytes(once)).toBe(
      bytes(
        normal({
          id: 'rl_t',
          url: 'https://t.example/',
          title: 'T',
          addedAt: 3,
          updatedAt: 4,
          favicon: 'data:,t',
          readAt: 4
        })
      )
    )
    expect(bytes(sanitizeReadingEntry(once))).toBe(bytes(once))
    expect(sanitizeReadingEntry({ id: 'x', title: 'no url', addedAt: 1 })).toBeNull()
    expect(sanitizeReadingEntry({ id: 'x', url: 'https://x.example/', addedAt: -1 })).toBeNull()
    expect(sanitizeReadingEntry('nonsense')).toBeNull()
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

describe('the page search (filterReadingList)', () => {
  const list = [
    entry({ id: 'essay', url: 'https://long.read/essay', title: 'A long essay' }),
    entry({ id: 'guide', url: 'https://docs.example.org/guide', title: 'The guide' }),
    entry({ id: 'story', url: 'https://news.example.com/story', title: 'Yesterday’s story' })
  ]

  it('matches every word against the title, the host and the address, case-folded, in the order given', () => {
    expect(filterReadingList(list, '').map((e) => e.id)).toEqual(['essay', 'guide', 'story'])
    expect(filterReadingList(list, '  ').map((e) => e.id)).toEqual(['essay', 'guide', 'story'])
    expect(filterReadingList(list, 'GUIDE').map((e) => e.id)).toEqual(['guide'])
    expect(filterReadingList(list, 'example').map((e) => e.id)).toEqual(['guide', 'story'])
    expect(filterReadingList(list, 'example news').map((e) => e.id)).toEqual(['story'])
    expect(filterReadingList(list, 'long.read').map((e) => e.id)).toEqual(['essay'])
    expect(filterReadingList(list, 'nothing here')).toEqual([])
  })

  it('hands back a copy, never the list itself', () => {
    expect(filterReadingList(list, '')).not.toBe(list)
  })
})

/**
 * The sync seam (services pass 11, ID-48): `applySynced` / `removeSynced` land the other
 * devices' records (`sync/apply.ts`), commit nothing themselves and keep one entry per URL by
 * the pure rule `readingListSurvivor` – the later `addedAt`, a tie the greater id – so every
 * device picks the same survivor.
 */
describe('ReadingListService: sync (applySynced / removeSynced)', () => {
  it('lands an entry under its id – new, or over the local copy keeping this device’s favicon – and commits nothing', () => {
    const { service, state, io } = setup()
    const local = service.add('https://a.example/', 'A here', 'data:,mine')!
    const writes = io.writes.length
    const listeners = vi.fn()
    service.subscribe(listeners)
    // The peer marked A read (its record carries no favicon) and saved a page of its own.
    service.applySynced([
      normal({ id: local.id, url: local.url, title: 'A there', addedAt: 50, readAt: 60 }),
      normal({ id: 'rl_peer', url: 'https://p.example/', title: 'P', addedAt: 70 })
    ])
    expect(service.get(local.id)).toEqual(
      normal({
        id: local.id,
        url: local.url,
        title: 'A there',
        addedAt: 50,
        readAt: 60,
        favicon: 'data:,mine'
      })
    )
    expect(bytes(service.get(local.id))).toBe(
      bytes(
        normal({
          id: local.id,
          url: local.url,
          title: 'A there',
          addedAt: 50,
          readAt: 60,
          favicon: 'data:,mine'
        })
      )
    )
    expect(service.get('rl_peer')).toEqual(
      normal({ id: 'rl_peer', url: 'https://p.example/', title: 'P', addedAt: 70 })
    )
    expect(service.get('rl_peer')).not.toHaveProperty('favicon')
    // A batch is the engine's to commit and the chrome reads the state: no write, no listener.
    expect(io.writes.length).toBe(writes)
    expect(listeners).not.toHaveBeenCalled()
    expect(state.readingList).toHaveLength(2)
  })

  it('one URL, one entry: the later addedAt survives whichever side it is on, a tie the lexically greater id, and the loser leaves the list', () => {
    const { service, state } = setup()
    // The same page saved on both devices while apart, the peer's later: the peer's stays.
    state.readingList = [normal({ id: 'rl_here1', url: 'https://same.example/', addedAt: 100 })]
    service.applySynced([normal({ id: 'rl_there1', url: 'https://same.example/', addedAt: 200 })])
    expect(state.readingList.map((e) => e.id)).toEqual(['rl_there1'])
    // This device's later: the peer's entry never joins.
    state.readingList = [normal({ id: 'rl_here2', url: 'https://other.example/', addedAt: 300 })]
    service.applySynced([normal({ id: 'rl_there2', url: 'https://other.example/', addedAt: 250 })])
    expect(state.readingList.map((e) => e.id)).toEqual(['rl_here2'])
    // A tie: the lexically greater id, from either side.
    state.readingList = [normal({ id: 'rl_aaa', url: 'https://tie.example/', addedAt: 400 })]
    service.applySynced([normal({ id: 'rl_zzz', url: 'https://tie.example/', addedAt: 400 })])
    expect(state.readingList.map((e) => e.id)).toEqual(['rl_zzz'])
    state.readingList = [normal({ id: 'rl_zzz', url: 'https://tie.example/', addedAt: 400 })]
    service.applySynced([normal({ id: 'rl_aaa', url: 'https://tie.example/', addedAt: 400 })])
    expect(state.readingList.map((e) => e.id)).toEqual(['rl_zzz'])
    // A record for an id this device holds under the same URL is that entry's newer state, not
    // a rival: it replaces the copy.
    state.readingList = [normal({ id: 'rl_x', url: 'https://x.example/', addedAt: 10 })]
    service.applySynced([
      normal({ id: 'rl_x', url: 'https://x.example/', addedAt: 20, readAt: 30 })
    ])
    expect(state.readingList).toEqual([
      normal({ id: 'rl_x', url: 'https://x.example/', addedAt: 20, readAt: 30 })
    ])
    // Two peers' entries for one URL in one batch: the rule holds across the batch.
    state.readingList = []
    service.applySynced([
      normal({ id: 'rl_p1', url: 'https://batch.example/', addedAt: 5 }),
      normal({ id: 'rl_p2', url: 'https://batch.example/', addedAt: 9 }),
      normal({ id: 'rl_p3', url: 'https://batch.example/', addedAt: 7 })
    ])
    expect(state.readingList.map((e) => e.id)).toEqual(['rl_p2'])
  })

  it('removeSynced takes the tombstoned ids out and ignores the rest; the cap trims after a batch by the same rule – read entries only', () => {
    const { service, state } = setup()
    const a = service.add('https://a.example/', 'A')!
    const b = service.add('https://b.example/', 'B')!
    const before = state.readingList
    service.removeSynced(['rl_unknown'])
    expect(state.readingList).toBe(before)
    service.removeSynced([a.id, 'rl_unknown'])
    expect(state.readingList.map((e) => e.id)).toEqual([b.id])
    // 1 000 read at the cap, one of them read earliest (rl_0003): landed READ entries run the
    // read half over, and the oldest by `readAt` go – a deletion made here, on purpose, which the
    // engine's re-snapshot tombstones for the fleet. The unread entry among them never counts.
    const atCap = (): ReadingListEntry[] => [
      ...Array.from({ length: READING_LIST_CAP }, (_, i) =>
        normal({
          id: `rl_${String(i).padStart(4, '0')}`,
          url: `https://cap.example/${i}`,
          addedAt: 1000 + i,
          readAt: i === 3 ? 1500 : 2000 + i
        })
      ),
      normal({ id: 'rl_unread', url: 'https://cap.example/unread', addedAt: 1 })
    ]
    state.readingList = atCap()
    service.applySynced([
      normal({ id: 'rl_new1', url: 'https://cap.example/new1', addedAt: 5000, readAt: 9000 }),
      normal({ id: 'rl_new2', url: 'https://cap.example/new2', addedAt: 5001, readAt: 9001 })
    ])
    expect(state.readingList).toHaveLength(READING_LIST_CAP + 1)
    expect(state.readingList.filter((e) => e.readAt === undefined).map((e) => e.id)).toEqual([
      'rl_unread'
    ])
    expect(state.readingList.some((e) => e.id === 'rl_new1')).toBe(true)
    expect(state.readingList.some((e) => e.id === 'rl_new2')).toBe(true)
    expect(state.readingList.some((e) => e.id === 'rl_0003')).toBe(false)
    expect(state.readingList.some((e) => e.id === 'rl_0000')).toBe(false)
    expect(state.readingList.some((e) => e.id === 'rl_0001')).toBe(true)
    // Landed UNREAD entries over the cap: nothing goes, however many – the unread half is unbounded.
    state.readingList = atCap()
    service.applySynced(
      Array.from({ length: 300 }, (_, i) =>
        normal({ id: `rl_peer_${i}`, url: `https://peer.example/${i}`, addedAt: 7000 + i })
      )
    )
    expect(state.readingList).toHaveLength(READING_LIST_CAP + 1 + 300)
    expect(state.readingList.some((e) => e.id === 'rl_0003')).toBe(true)
    expect(unreadReadingCount(state.readingList)).toBe(301)
  })
})
