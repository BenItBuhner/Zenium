import { describe, expect, it } from 'vitest'
import type { HostCapabilities, ReadingListEntry } from '../types'
import type { StoreIO } from '../../core/platform'
import { ReadingListService } from '../../core/readingList'
import { BrowserState } from '../../core/state'
import {
  READING_LIST_CAP,
  compareReadAge,
  isUnread,
  sanitizeReadingList,
  trimReadingList
} from '../readingList'

/**
 * The cap's rule (services pass 11, item 4 – the root's ruling, the mechanism agreed with
 * desktop): `READING_LIST_CAP` bounds the READ half alone, the oldest by `readAt` go first (a
 * tie by the id), an unread entry is never trimmed – and the one trim serves the write, the
 * load and the apply paths, so every device keeps the same survivors.
 */

/** An entry in the normal form (`sanitizeReadingEntry`'s field order). */
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

function unread(n: number, from = 0): ReadingListEntry[] {
  return Array.from({ length: n }, (_, i) =>
    normal({ id: `u${String(from + i).padStart(5, '0')}`, addedAt: 10_000 + from + i })
  )
}

/** `n` read entries with distinct `readAt`s, `readAt` rising with the index. */
function read(n: number, from = 0): ReadingListEntry[] {
  return Array.from({ length: n }, (_, i) =>
    normal({
      id: `r${String(from + i).padStart(5, '0')}`,
      addedAt: from + i,
      readAt: 100_000 + from + i
    })
  )
}

/** A deterministic shuffle (the same permutation every run). */
function shuffled<T>(items: readonly T[], seed = 7): T[] {
  const out = [...items]
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1_103_515_245 + 12_345) & 0x7fff_ffff
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

const ids = (entries: readonly ReadingListEntry[]): string[] => entries.map((e) => e.id).sort()

function fakeIo(): StoreIO {
  return {
    readSync: () => null,
    write: async () => undefined,
    writeSync: () => undefined
  }
}

function withList(initial: ReadingListEntry[]): {
  state: BrowserState
  service: ReadingListService
} {
  const state = new BrowserState(fakeIo(), 'linux', {} as HostCapabilities, '0.0')
  state.load()
  state.readingList = initial
  return { state, service: new ReadingListService(state) }
}

describe('trimReadingList: the cap bounds the read half alone', () => {
  it('all unread over the cap: nothing dropped – the same array back', () => {
    const list = unread(READING_LIST_CAP + 200)
    expect(trimReadingList(list)).toBe(list)
    expect(trimReadingList(list, 4)).toBe(list)
    expect(trimReadingList(list, 0)).toBe(list)
  })

  it('1 200 read + N unread: 1 000 read, the 200 oldest by readAt gone, all N unread kept', () => {
    const readEntries = read(1200)
    const unreadEntries = unread(37)
    const list = shuffled([...readEntries, ...unreadEntries])
    const kept = trimReadingList(list)
    expect(kept).not.toBe(list)
    expect(kept.filter((e) => !isUnread(e))).toHaveLength(READING_LIST_CAP)
    expect(kept.filter(isUnread)).toHaveLength(37)
    // The 200 with the earliest `readAt` – r00000 … r00199 – went; every other read entry stays.
    const gone = readEntries.slice(0, 200)
    for (const e of gone) expect(kept.some((k) => k.id === e.id)).toBe(false)
    expect(ids(kept)).toEqual(ids([...readEntries.slice(200), ...unreadEntries]))
    // The survivors are the input's own objects, in the input's order: no byte of any moves.
    expect(kept).toEqual(list.filter((e) => kept.includes(e)))
    for (const e of kept) expect(list.includes(e)).toBe(true)
  })

  it('the oldest by readAt goes, not by addedAt', () => {
    // r-late was ADDED first but READ last: under the cap of one it stays; r-early goes.
    const list = [
      normal({ id: 'r-late', addedAt: 1, readAt: 900 }),
      normal({ id: 'r-early', addedAt: 500, readAt: 600 }),
      normal({ id: 'u', addedAt: 2 })
    ]
    expect(trimReadingList(list, 1).map((e) => e.id)).toEqual(['r-late', 'u'])
  })

  it('equal readAt: the id decides – the lexically smaller goes first – and a shuffled input keeps the same survivors', () => {
    const tied = Array.from({ length: READING_LIST_CAP + 50 }, (_, i) =>
      normal({ id: `t${String(i).padStart(5, '0')}`, addedAt: 5000 - i, readAt: 777 })
    )
    const kept = trimReadingList(tied)
    expect(kept).toHaveLength(READING_LIST_CAP)
    // t00000 … t00049 – the smallest ids – went, whatever their `addedAt`.
    expect(ids(kept)).toEqual(ids(tied.slice(50)))
    expect(ids(trimReadingList(shuffled(tied)))).toEqual(ids(kept))
    expect(ids(trimReadingList(shuffled(tied, 99)))).toEqual(ids(kept))
    // Mixed: the id breaks the tie only among equal `readAt`s.
    const mixed = [
      normal({ id: 'b', addedAt: 1, readAt: 10 }),
      normal({ id: 'a', addedAt: 1, readAt: 10 }),
      normal({ id: 'c', addedAt: 1, readAt: 9 })
    ]
    expect(trimReadingList(mixed, 2).map((e) => e.id)).toEqual(['b', 'a'])
    expect(trimReadingList(mixed, 1).map((e) => e.id)).toEqual(['b'])
    expect([...mixed].sort(compareReadAge).map((e) => e.id)).toEqual(['c', 'a', 'b'])
  })

  it('exactly 1 000 read is unchanged – the same array back – and 1 001 drops one', () => {
    const atCap = [...read(READING_LIST_CAP), ...unread(3)]
    expect(trimReadingList(atCap)).toBe(atCap)
    const over = [...read(READING_LIST_CAP + 1), ...unread(3)]
    const kept = trimReadingList(over)
    expect(kept).toHaveLength(READING_LIST_CAP + 3)
    expect(kept.some((e) => e.id === 'r00000')).toBe(false)
    expect(kept.filter(isUnread)).toHaveLength(3)
  })

  it('compareReadAge is a total order: earlier readAt first, then the smaller id', () => {
    const a = normal({ id: 'a', addedAt: 1, readAt: 5 })
    const b = normal({ id: 'b', addedAt: 1, readAt: 5 })
    const c = normal({ id: 'c', addedAt: 1, readAt: 4 })
    expect(compareReadAge(c, a)).toBeLessThan(0)
    expect(compareReadAge(a, c)).toBeGreaterThan(0)
    expect(compareReadAge(a, b)).toBeLessThan(0)
    expect(compareReadAge(b, a)).toBeGreaterThan(0)
    expect(compareReadAge(a, a)).toBe(0)
  })
})

describe('one trim for every path', () => {
  it('the load path (sanitizeReadingList) keeps exactly the survivors trimReadingList keeps, byte for byte', () => {
    const list = shuffled([...read(READING_LIST_CAP + 120), ...unread(80)])
    const loaded = sanitizeReadingList(list)
    const trimmed = trimReadingList(list)
    expect(ids(loaded)).toEqual(ids(trimmed))
    expect(loaded.filter(isUnread)).toHaveLength(80)
    expect(loaded.filter((e) => !isUnread(e))).toHaveLength(READING_LIST_CAP)
    expect(JSON.stringify(loaded)).toBe(JSON.stringify(trimmed))
    // All unread, however many: the load keeps every one.
    const pile = unread(READING_LIST_CAP + 500)
    expect(sanitizeReadingList(pile)).toHaveLength(READING_LIST_CAP + 500)
  })

  it('the write path (ReadingListService.write) keeps exactly the survivors trimReadingList keeps', () => {
    // 1 000 read + 400 unread in the state; marking one more unread entry read runs the write
    // path over the cap, and the list is what the shared trim says it is.
    const initial = shuffled([...read(READING_LIST_CAP), ...unread(400)])
    const { state, service } = withList(initial)
    const target = initial.find(isUnread)!
    expect(service.setRead(target.id, true)).toBe(true)
    const written = state.readingList
    const marked = written.find((e) => e.id === target.id)!
    expect(marked.readAt).toBeDefined()
    // What the trim would do to the same list with the same entry read: the same survivors.
    const expected = trimReadingList(
      initial.map((e) => (e.id === target.id ? marked : e)),
      READING_LIST_CAP
    )
    expect(ids(written)).toEqual(ids(expected))
    expect(written).toHaveLength(READING_LIST_CAP + 399)
    // r00000 – the earliest `readAt` – went; every unread entry stays.
    expect(written.some((e) => e.id === 'r00000')).toBe(false)
    expect(written.filter(isUnread)).toHaveLength(399)
    // An unread save over the cap drops nothing at all.
    expect(service.add('https://one-more.example/', 'One more')).not.toBeNull()
    expect(state.readingList).toHaveLength(READING_LIST_CAP + 400)
    expect(state.readingList.filter(isUnread)).toHaveLength(400)
  })
})
