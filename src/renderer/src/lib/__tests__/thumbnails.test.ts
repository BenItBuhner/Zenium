import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThumbnailPicture, UIState } from '@shared/types'
import { cmd, run } from '../api'
import {
  CLOSED_GRACE_MS,
  COVERS_MAX,
  THUMBNAIL_BUDGET,
  configureThumbnails,
  hasCard,
  releaseThumbnail,
  rememberCard,
  rememberThumbnail,
  resetThumbnails,
  retainThumbnail,
  thumbnailBytes,
  thumbnailOf,
  thumbnailStore,
  thumbnailWidthFor,
  trackTabs
} from '../thumbnails'

vi.mock('../api', () => ({ cmd: vi.fn(), run: vi.fn(), onEvent: vi.fn(() => () => undefined) }))

/*
 * The tab cards' pictures (lib/thumbnails.ts): the host's card captures, bounded in memory by
 * the bytes of their pixels; read from the host's disk lazily, one per card shown; dropped the
 * moment their tab navigates (BH-14) or, after a grace for an undo, when it is closed; and the
 * host's copies swept once at boot for the tabs that did not come back (BH-33 keeps the rest).
 */

/** A picture `side` px square: `side * side * 4` bytes on the budget, whatever its data says. */
const square = (side: number, tag = 'p'): ThumbnailPicture => ({
  data: `data:image/jpeg;base64,${tag}`,
  width: side,
  height: side
})

/** 4 MB a piece: six fill the 24 MB budget exactly, a seventh goes over. */
const MB4 = square(1024)

function stateOf(tabs: Record<string, string>): UIState {
  const records: Record<string, { id: string; url: string }> = {}
  for (const id in tabs) records[id] = { id, url: tabs[id] ?? '' }
  return { platform: 'android', tabs: records } as unknown as UIState
}

const cards = (): string[] => [...thumbnailStore.get().cards.keys()]
const sent = (name: string): unknown[][] =>
  vi
    .mocked(run)
    .mock.calls.filter(([n]) => n === name)
    .map(([, args]) => [args])
const loads = (): number => vi.mocked(cmd).mock.calls.filter(([n]) => n === 'thumbnail.load').length

beforeEach(() => {
  vi.useFakeTimers()
  resetThumbnails()
  vi.mocked(run).mockReset()
  vi.mocked(cmd).mockReset()
  vi.mocked(cmd).mockResolvedValue(null)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the budget', () => {
  it('counts pixels, not pictures', () => {
    expect(thumbnailBytes(square(1024))).toBe(4 * 1024 * 1024)
    expect(THUMBNAIL_BUDGET).toBe(24 * 1024 * 1024)
  })

  it('evicts the least recently shown once the pixels go over, never the newest', () => {
    trackTabs(stateOf({ a: 'u', b: 'u', c: 'u', d: 'u', e: 'u', f: 'u', g: 'u' }))
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) rememberCard(id, MB4)
    expect(cards()).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    // Showing `a` makes it the most recently used: `b` is now the oldest.
    retainThumbnail('a')
    releaseThumbnail('a')
    rememberCard('g', MB4)
    expect(cards()).toEqual(['c', 'd', 'e', 'f', 'a', 'g'])
  })

  it('keeps many small pictures where it would keep few big ones', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `t${i}`)
    trackTabs(stateOf(Object.fromEntries(ids.map((id) => [id, 'u']))))
    // 300 px wide cards, 640 px tall: 768 KB each, thirty-two of them sit under the budget.
    for (const id of ids) rememberCard(id, { data: 'd', width: 300, height: 640 })
    expect(cards().length).toBe(32)
    expect(cards()[0]).toBe('t8')
  })

  it('never evicts a picture a card is showing, and trims once the card is gone', () => {
    trackTabs(stateOf({ a: 'u', b: 'u', c: 'u', d: 'u', e: 'u', f: 'u', g: 'u', h: 'u' }))
    rememberCard('a', MB4)
    retainThumbnail('a')
    for (const id of ['b', 'c', 'd', 'e', 'f', 'g']) rememberCard(id, MB4)
    // Seven pictures, 28 MB: `a` is the oldest but on screen; `b` went instead.
    expect(cards()).toEqual(['a', 'c', 'd', 'e', 'f', 'g'])
    rememberCard('h', MB4)
    expect(cards()).toEqual(['a', 'd', 'e', 'f', 'g', 'h'])
    // Over budget with only pinned pictures left to evict: they stay, whatever they add up to,
    // and so does the picture just added; an unpinned one from before is what goes.
    for (const id of ['d', 'e', 'f', 'g', 'h']) retainThumbnail(id)
    rememberCard('b', MB4)
    expect(cards()).toEqual(['a', 'd', 'e', 'f', 'g', 'h', 'b'])
    rememberCard('c', MB4)
    expect(cards()).toEqual(['a', 'd', 'e', 'f', 'g', 'h', 'c'])
    // The cards go: the budget is kept again, oldest first.
    for (const id of ['a', 'd', 'e', 'f', 'g', 'h']) releaseThumbnail(id)
    expect(cards()).toEqual(['d', 'e', 'f', 'g', 'h', 'c'])
  })
})

describe('the covers', () => {
  it('keeps the last few full covers and prefers them for a card standing in for the live page', () => {
    trackTabs(stateOf({ a: 'u', b: 'u', c: 'u', d: 'u' }))
    rememberCard('a', square(300, 'card'))
    rememberThumbnail('a', 'data:cover-a')
    expect(thumbnailOf('a', true)).toBe('data:cover-a')
    expect(thumbnailOf('a', false)).toBe('data:image/jpeg;base64,card')
    // Either kind stands in for the other when it is all there is.
    rememberThumbnail('b', 'data:cover-b')
    expect(thumbnailOf('b', false)).toBe('data:cover-b')
    expect(thumbnailOf('c', true)).toBeNull()
    rememberThumbnail('c', 'data:cover-c')
    rememberThumbnail('d', 'data:cover-d')
    expect(thumbnailStore.get().covers.size).toBe(COVERS_MAX)
    expect(thumbnailOf('a', true)).toBe('data:image/jpeg;base64,card')
  })
})

describe('a navigation (BH-14)', () => {
  it('drops the pictures of the tab the moment its URL changes, here and on the host', () => {
    trackTabs(stateOf({ a: 'https://one.example/', b: 'https://two.example/' }))
    rememberCard('a', MB4)
    rememberThumbnail('a', 'data:cover-a')
    rememberCard('b', MB4)
    trackTabs(stateOf({ a: 'https://one.example/next', b: 'https://two.example/' }))
    expect(hasCard('a')).toBe(false)
    expect(thumbnailOf('a')).toBeNull()
    expect(hasCard('b')).toBe(true)
    expect(sent('thumbnail.drop')).toEqual([[{ tabId: 'a' }]])
  })

  it('shows the placeholder, not a stale read, until the host captures the new page', async () => {
    trackTabs(stateOf({ a: 'https://one.example/' }))
    rememberCard('a', MB4)
    trackTabs(stateOf({ a: 'https://one.example/next' }))
    // A card mounting now does not go back to disk for the picture that was just dropped.
    retainThumbnail('a')
    await vi.advanceTimersByTimeAsync(0)
    expect(loads()).toBe(0)
    expect(thumbnailOf('a')).toBeNull()
    // The host's next capture is the new page.
    rememberCard('a', square(300, 'next'))
    expect(thumbnailOf('a', false)).toBe('data:image/jpeg;base64,next')
  })

  it('leaves a tab alone whose state changed without its URL', () => {
    trackTabs(stateOf({ a: 'https://one.example/' }))
    rememberCard('a', MB4)
    trackTabs(stateOf({ a: 'https://one.example/' }))
    expect(hasCard('a')).toBe(true)
    expect(sent('thumbnail.drop')).toEqual([])
  })
})

describe('a closed tab', () => {
  it('keeps its picture for an undo, then lets it go for good', () => {
    trackTabs(stateOf({ a: 'u', b: 'u' }))
    rememberCard('a', MB4)
    trackTabs(stateOf({ b: 'u' }))
    expect(hasCard('a')).toBe(true)
    expect(sent('thumbnail.drop')).toEqual([])
    vi.advanceTimersByTime(CLOSED_GRACE_MS - 1)
    expect(hasCard('a')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(hasCard('a')).toBe(false)
    expect(sent('thumbnail.drop')).toEqual([[{ tabId: 'a' }]])
  })

  it('brought back within the grace keeps its picture', () => {
    trackTabs(stateOf({ a: 'u' }))
    rememberCard('a', MB4)
    trackTabs(stateOf({}))
    vi.advanceTimersByTime(CLOSED_GRACE_MS / 2)
    trackTabs(stateOf({ a: 'u' }))
    vi.advanceTimersByTime(CLOSED_GRACE_MS)
    expect(hasCard('a')).toBe(true)
    expect(sent('thumbnail.drop')).toEqual([])
  })

  it('may still have its last capture land, but not after it is gone for good', () => {
    trackTabs(stateOf({ a: 'u' }))
    trackTabs(stateOf({}))
    // The capture the host took as the page went: kept for the undo card.
    rememberCard('a', MB4)
    expect(hasCard('a')).toBe(true)
    vi.advanceTimersByTime(CLOSED_GRACE_MS)
    expect(hasCard('a')).toBe(false)
    rememberCard('a', MB4)
    expect(hasCard('a')).toBe(false)
    // Nor is a picture of a tab the chrome never heard of kept.
    rememberCard('nobody', MB4)
    expect(hasCard('nobody')).toBe(false)
  })
})

describe('boot', () => {
  it('sweeps the host once, keeping the pictures of the restored tabs only', () => {
    trackTabs(null)
    expect(sent('thumbnail.sweep')).toEqual([])
    trackTabs(stateOf({ a: 'u', b: 'u' }))
    trackTabs(stateOf({ a: 'u', b: 'u', c: 'u' }))
    expect(sent('thumbnail.sweep')).toEqual([[{ keep: ['a', 'b'] }]])
  })

  it('reads a restored tab’s picture once its card shows, never before, and once only', async () => {
    trackTabs(stateOf({ a: 'u', b: 'u' }))
    expect(loads()).toBe(0)
    vi.mocked(cmd).mockResolvedValueOnce(square(300, 'disk'))
    retainThumbnail('a')
    retainThumbnail('a')
    expect(loads()).toBe(1)
    expect(cmd).toHaveBeenCalledWith('thumbnail.load', { tabId: 'a' })
    await vi.advanceTimersByTimeAsync(0)
    expect(thumbnailOf('a', false)).toBe('data:image/jpeg;base64,disk')
    releaseThumbnail('a')
    releaseThumbnail('a')
    retainThumbnail('a')
    expect(loads()).toBe(1)
  })

  it('remembers a tab the host has no picture of, until it captures one', async () => {
    trackTabs(stateOf({ a: 'u' }))
    retainThumbnail('a')
    await vi.advanceTimersByTimeAsync(0)
    releaseThumbnail('a')
    retainThumbnail('a')
    expect(loads()).toBe(1)
    expect(thumbnailOf('a')).toBeNull()
    rememberCard('a', square(300, 'fresh'))
    expect(thumbnailOf('a', false)).toBe('data:image/jpeg;base64,fresh')
  })

  it('keeps a capture that lands while the disk is read', async () => {
    trackTabs(stateOf({ a: 'u' }))
    let answer: ((picture: ThumbnailPicture | null) => void) | null = null
    vi.mocked(cmd).mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve as typeof answer)) as never
    )
    retainThumbnail('a')
    rememberCard('a', square(300, 'fresh'))
    answer!(square(300, 'disk'))
    await vi.advanceTimersByTimeAsync(0)
    expect(thumbnailOf('a', false)).toBe('data:image/jpeg;base64,fresh')
  })
})

describe('the card width', () => {
  it('is an overview cell’s, in device pixels', () => {
    // A 390 px phone at 3x: two columns, 12 px gutters and gap → 177 CSS px → 531 px.
    expect(thumbnailWidthFor(390, 3)).toBe(531)
    // A 700 px tablet at 2x: three columns → 217.33 CSS px → 435 px.
    expect(thumbnailWidthFor(700, 2)).toBe(435)
    expect(thumbnailWidthFor(0, 3)).toBe(0)
  })

  it('is told to the host once per width', () => {
    configureThumbnails(531)
    configureThumbnails(531)
    configureThumbnails(0)
    configureThumbnails(435)
    expect(sent('thumbnail.configure')).toEqual([[{ width: 531 }], [{ width: 435 }]])
  })
})
