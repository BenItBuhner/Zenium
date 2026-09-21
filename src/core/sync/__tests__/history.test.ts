import { describe, expect, it } from 'vitest'
import type { HistoryVisitKey, ImportedVisit } from '../../history'
import { RETENTION_MS } from '../../history'
import {
  HISTORY_OPEN_MAX,
  HISTORY_PAGES_MAX,
  HISTORY_PAGES_PER_ROUND,
  HISTORY_PAGE_ENTRIES,
  HISTORY_SEED_MAX,
  REMOVED_KEYS_PER_ENTRY,
  advanceCursor,
  appendOpen,
  applyEntries,
  emptyDeletions,
  entriesFromEvent,
  entriesFromVisits,
  expiredPages,
  initialHistoryState,
  isDeleted,
  isEntry,
  pagesToRead,
  planWrites,
  pruneDeletions,
  readHistoryPage,
  readHistoryState,
  rememberDeletion,
  seedFloor,
  takeWrites,
  type HistoryApplyTarget,
  type HistoryEntry,
  type HistorySyncState
} from '../history'

const NOW = 1_800_000_000_000
const visit = (i: number, at = NOW - i * 1000): HistoryEntry => ({
  type: 'visit',
  visit: { url: `https://e.example/${i}`, at }
})

/** A history model that records what the stream asked of it. */
function target(): HistoryApplyTarget & {
  imported: ImportedVisit[][]
  deleted: HistoryVisitKey[][]
  ranges: Array<[number, number]>
} {
  const t = {
    imported: [] as ImportedVisit[][],
    deleted: [] as HistoryVisitKey[][],
    ranges: [] as Array<[number, number]>,
    importVisits(visits: ImportedVisit[]) {
      t.imported.push(visits)
      return { imported: visits.length }
    },
    deleteByKeys(keys: HistoryVisitKey[]) {
      t.deleted.push(keys)
      return keys.length
    },
    deleteRange(from: number, to: number) {
      t.ranges.push([from, to])
      return 1
    }
  }
  return t
}

describe('the wire shape', () => {
  it('turns the model events into entries, splitting large removals', () => {
    expect(
      entriesFromEvent(
        {
          type: 'added',
          visits: [
            { url: 'https://a.example/', title: 'A', at: 5, transition: 'link', favicon: null },
            { url: 'https://b.example/', title: '', at: 6, transition: 'typed', favicon: 'i' }
          ]
        },
        NOW
      )
    ).toEqual([
      { type: 'visit', visit: { url: 'https://a.example/', title: 'A', at: 5 } },
      {
        type: 'visit',
        visit: { url: 'https://b.example/', at: 6, transition: 'typed', favicon: 'i' }
      }
    ])
    const keys = Array.from({ length: REMOVED_KEYS_PER_ENTRY + 1 }, (_, i) => ({
      url: `https://k.example/${i}`,
      at: i
    }))
    const removed = entriesFromEvent({ type: 'removed', keys }, NOW)
    expect(removed).toHaveLength(2)
    expect(removed[0]).toMatchObject({ type: 'removed', at: NOW })
    expect((removed[0] as { keys: unknown[] }).keys).toHaveLength(REMOVED_KEYS_PER_ENTRY)
    expect((removed[1] as { keys: unknown[] }).keys).toHaveLength(1)
    expect(entriesFromEvent({ type: 'range-removed', from: 1, to: 2 }, NOW)).toEqual([
      { type: 'range-removed', at: NOW, from: 1, to: 2 }
    ])
    expect(entriesFromEvent({ type: 'cleared' }, NOW)).toEqual([{ type: 'cleared', at: NOW }])
    expect(entriesFromVisits([{ url: 'https://a.example/', at: 1 }])).toEqual([
      { type: 'visit', visit: { url: 'https://a.example/', at: 1 } }
    ])
  })

  it('reads a page from another device, dropping garbage entries and refusing garbage pages', () => {
    expect(readHistoryPage(null)).toBeNull()
    expect(readHistoryPage({ v: 2, seq: 0, entries: [] })).toBeNull()
    expect(readHistoryPage({ v: 1, seq: 'x', entries: [] })).toBeNull()
    const page = readHistoryPage({
      v: 1,
      seq: 3,
      sealed: 'yes',
      entries: [
        { type: 'visit', visit: { url: 'https://a.example/', at: 1 } },
        { type: 'visit', visit: { url: 'https://a.example/', at: 'now' } },
        { type: 'removed', at: 2, keys: [{ url: 'https://a.example/', at: 1 }] },
        { type: 'removed', at: 2, keys: [{ url: 1 }] },
        { type: 'range-removed', at: 3, from: 0, to: 1 },
        { type: 'cleared', at: 4 },
        { type: 'mystery' },
        'nonsense'
      ]
    })
    expect(page).toMatchObject({ v: 1, seq: 3, sealed: false })
    expect(page!.entries).toHaveLength(4)
    expect(isEntry({ type: 'cleared' })).toBe(false)
  })

  it('completes and sanitises a persisted state from any build', () => {
    expect(readHistoryState(undefined)).toEqual(initialHistoryState())
    const state = readHistoryState({
      seq: 4.7,
      written: 9,
      open: [visit(1), 'junk'],
      pages: [{ seq: 0, to: 10 }, { seq: 'x' }],
      cursors: { dev: { seq: 1, index: 2, updatedAt: 7 }, bad: { seq: 'a' } },
      seed: { since: 5, until: 9, cursor: 'c' },
      publishedUntil: 12,
      deletions: {
        keys: { '1\nhttps://a.example/': 3, bad: 'x' },
        ranges: [{ from: 1, to: 2, at: 3 }, {}],
        clearedAt: 2
      }
    })
    expect(state.seq).toBe(4)
    expect(state.open).toEqual([visit(1)])
    // `written` can never exceed what the buffer holds.
    expect(state.written).toBe(1)
    expect(state.pages).toEqual([{ seq: 0, to: 10 }])
    expect(state.cursors).toEqual({ dev: { seq: 1, index: 2, updatedAt: 7 } })
    expect(state.seed).toEqual({ since: 5, until: 9, cursor: 'c' })
    expect(state.publishedUntil).toBe(12)
    expect(state.deletions).toEqual({
      keys: { '1\nhttps://a.example/': 3 },
      ranges: [{ from: 1, to: 2, at: 3 }],
      clearedAt: 2
    })
  })
})

describe('the publisher', () => {
  it('queues entries, keeps deletions when the buffer overflows and tracks the newest published visit', () => {
    const state = initialHistoryState()
    appendOpen(state, [visit(1, 100), visit(2, 300), visit(3, 200)])
    expect(state.open).toHaveLength(3)
    expect(state.publishedUntil).toBe(300)
    // Over the cap the oldest queued visits go, the written prefix and every deletion stay.
    const big = initialHistoryState()
    big.open = [visit(0, 1)]
    big.written = 1
    const many: HistoryEntry[] = []
    for (let i = 1; i <= HISTORY_OPEN_MAX + 2; i += 1) many.push(visit(i, i + 1))
    many.push({ type: 'cleared', at: NOW })
    appendOpen(big, many)
    expect(big.open).toHaveLength(HISTORY_OPEN_MAX)
    expect(big.open[0]).toEqual(visit(0, 1))
    expect(big.open.at(-1)).toEqual({ type: 'cleared', at: NOW })
    // Four over the cap (the written one, the two extra visits, the clear): visits 1-4 went.
    expect(big.open[1]).toEqual(visit(5, 6))
  })

  it('plans full pages as sealed, the rest as the open page, and only what is not yet in the folder', () => {
    const state = initialHistoryState()
    for (let i = 0; i < HISTORY_PAGE_ENTRIES * 2 + 10; i += 1) appendOpen(state, [visit(i, i + 1)])
    const { writes, after } = planWrites(state)
    expect(writes.map((w) => [w.seq, w.page.sealed, w.page.entries.length])).toEqual([
      [0, true, HISTORY_PAGE_ENTRIES],
      [1, true, HISTORY_PAGE_ENTRIES],
      [2, false, 10]
    ])
    // Pure: the state is untouched until the writes are taken.
    expect(state.seq).toBe(0)
    expect(state.open).toHaveLength(HISTORY_PAGE_ENTRIES * 2 + 10)
    expect(after).toMatchObject({ seq: 2, written: 10 })
    expect(after.pages).toEqual([
      { seq: 0, to: HISTORY_PAGE_ENTRIES },
      { seq: 1, to: HISTORY_PAGE_ENTRIES * 2 }
    ])
    // Entries that arrived while the writes were in flight are queued behind.
    const planned = state.open.length
    appendOpen(state, [visit(9_999, NOW)])
    takeWrites(state, after, planned)
    expect(state.seq).toBe(2)
    expect(state.written).toBe(10)
    expect(state.open).toHaveLength(11)
    expect(state.open.at(-1)).toEqual(visit(9_999, NOW))
    // Nothing new: nothing to write. One more entry: the open page again, in full.
    expect(planWrites({ ...state, open: state.open.slice(0, 10) }).writes).toEqual([])
    const again = planWrites(state)
    expect(again.writes.map((w) => [w.seq, w.page.sealed, w.page.entries.length])).toEqual([
      [2, false, 11]
    ])
  })

  it('expires sealed pages past the retention window and beyond the count cap', () => {
    const state = initialHistoryState()
    state.pages = [
      { seq: 0, to: NOW - RETENTION_MS - 1 },
      { seq: 1, to: NOW - RETENTION_MS + 1000 },
      { seq: 2, to: NOW }
    ]
    expect(expiredPages(state, NOW)).toEqual([0])
    const crowded = initialHistoryState()
    for (let i = 0; i < HISTORY_PAGES_MAX + 3; i += 1) crowded.pages.push({ seq: i, to: NOW })
    expect(expiredPages(crowded, NOW)).toEqual([0, 1, 2])
  })

  it('starts a backlog at the newest HISTORY_SEED_MAX visits', () => {
    const times = Array.from({ length: HISTORY_SEED_MAX + 50 }, (_, i) => 1_000 + i)
    const history = {
      exportVisits: ({ cursor, since }: { since: number; cursor?: string | null }) => {
        const start = cursor ? Number(cursor) : 0
        const page = times.filter((t) => t >= since).slice(start, start + 500)
        const next =
          start + 500 < times.filter((t) => t >= since).length ? String(start + 500) : null
        return { visits: page.map((at) => ({ url: 'https://s.example/', at })), next }
      }
    }
    expect(seedFloor(history, 0, NOW)).toBe(1_050)
    expect(seedFloor(history, 1_060, NOW)).toBe(1_060)
    expect(seedFloor({ exportVisits: () => ({ visits: [], next: null }) }, 7, NOW)).toBe(7)
  })
})

describe('the reader', () => {
  it('applies runs of visits as one import each, deletions through the delete paths, in stream order', () => {
    const t = target()
    const memory = emptyDeletions()
    // A day ago: inside the retention window the deletion memory keeps.
    const T = NOW - 86_400_000
    const entries: HistoryEntry[] = [
      visit(1, T + 10),
      visit(2, T + 20),
      { type: 'removed', at: T + 25, keys: [{ url: 'https://e.example/1', at: T + 10 }] },
      visit(3, T + 30),
      { type: 'range-removed', at: T + 35, from: T, to: T + 15 },
      { type: 'cleared', at: T + 40 },
      visit(4, T + 50)
    ]
    const result = applyEntries(t, entries, 0, memory, NOW)
    expect(t.imported.map((b) => b.map((v) => v.url))).toEqual([
      ['https://e.example/1', 'https://e.example/2'],
      ['https://e.example/3'],
      ['https://e.example/4']
    ])
    expect(t.deleted).toEqual([[{ url: 'https://e.example/1', at: T + 10 }]])
    expect(t.ranges).toEqual([
      [T, T + 15],
      [0, T + 41]
    ])
    expect(result).toEqual({ imported: 4, deleted: 3 })
    // Every deletion is remembered: a visit an older page brings later stays deleted.
    expect(isDeleted(memory, { url: 'https://e.example/1', at: T + 10 })).toBe(true)
    expect(isDeleted(memory, { url: 'https://e.example/9', at: T + 12 })).toBe(true)
    expect(isDeleted(memory, { url: 'https://e.example/9', at: T + 40 })).toBe(true)
    expect(isDeleted(memory, { url: 'https://e.example/9', at: T + 41 })).toBe(false)
    const late = target()
    expect(applyEntries(late, [visit(7, T + 12), visit(8, T + 60)], 0, memory, NOW)).toEqual({
      imported: 1,
      deleted: 0
    })
    expect(late.imported).toEqual([[{ url: 'https://e.example/8', at: T + 60 }]])
  })

  it('resumes a page from the cursor and skips nothing before it', () => {
    const t = target()
    applyEntries(t, [visit(1), visit(2), visit(3)], 2, emptyDeletions(), NOW)
    expect(t.imported).toEqual([[{ url: 'https://e.example/3', at: NOW - 3000 }]])
  })

  it('prunes the deletion memory to the retention window and its caps', () => {
    const memory = emptyDeletions()
    rememberDeletion(
      memory,
      { type: 'removed', at: NOW - RETENTION_MS - 5, keys: [{ url: 'https://o.example/', at: 1 }] },
      NOW - RETENTION_MS
    )
    rememberDeletion(
      memory,
      { type: 'range-removed', at: NOW - RETENTION_MS - 5, from: 0, to: 1 },
      NOW - RETENTION_MS
    )
    rememberDeletion(memory, { type: 'cleared', at: NOW - RETENTION_MS - 5 }, NOW - RETENTION_MS)
    expect(Object.keys(memory.keys)).toHaveLength(1)
    expect(memory.ranges).toHaveLength(1)
    expect(memory.clearedAt).toBe(NOW - RETENTION_MS - 5)
    pruneDeletions(memory, NOW)
    expect(memory).toEqual(emptyDeletions())
    for (let i = 0; i < 5_200; i += 1) memory.keys[`${i}\nhttps://k.example/`] = NOW - 5_200 + i
    pruneDeletions(memory, NOW)
    expect(Object.keys(memory.keys)).toHaveLength(5_000)
    expect(memory.keys['0\nhttps://k.example/']).toBeUndefined()
    expect(memory.keys['5199\nhttps://k.example/']).toBeDefined()
  })

  it('reads a stream from its cursor on, so many pages a round, from the oldest page left', () => {
    expect(pagesToRead([2, 0, 1], undefined)).toEqual([0, 1, 2])
    expect(pagesToRead([0, 1, 2, 3], { seq: 2, index: 5 })).toEqual([2, 3])
    // The owner removed pages 0-1 since: the cursor at 0 starts at what is left.
    expect(pagesToRead([2, 3], { seq: 0, index: 0 })).toEqual([2, 3])
    const many = Array.from({ length: 30 }, (_, i) => i)
    expect(pagesToRead(many, { seq: 3, index: 0 })).toHaveLength(HISTORY_PAGES_PER_ROUND)
    expect(pagesToRead(many, { seq: 3, index: 0 })[0]).toBe(3)
    expect(advanceCursor({ v: 1, seq: 4, sealed: true, entries: [visit(1)] })).toEqual({
      seq: 5,
      index: 0
    })
    expect(advanceCursor({ v: 1, seq: 4, sealed: false, entries: [visit(1), visit(2)] })).toEqual({
      seq: 4,
      index: 2
    })
  })
})

export type { HistorySyncState }
