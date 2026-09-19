import { useEffect } from 'react'
import type { ThumbnailPicture, UIState } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import { cmd, run } from './api'
import { overviewColumns } from './layout'
import { createStore } from './store'

/**
 * The last thing each tab looked like, for the cards that stand in for pages that are not on
 * screen: the grid of the tab overview, the neighbours peeking in during a swipe, the card under
 * the finger on its way to the dock. Two kinds of picture live here.
 *
 *  - Cards: the host's thumbnails (`thumbnail.captured`, `ThumbnailHost`) – the page scaled to a
 *    card's width, one per tab, kept on disk by the host across restarts (`cacheDir/zen-thumbs`
 *    on Android) and read from there lazily, one per card on screen, a few reads in flight at a
 *    time (`LOADS_IN_FLIGHT`), never through the boot payload. In memory they are bounded by the
 *    bytes of their pixels, not their number (`THUMBNAIL_BUDGET`): the least recently shown go
 *    first, and a card that is on screen keeps its picture from under its `<img>` – up to a hard
 *    cap (`THUMBNAIL_HARD_CAP`) past which the least recently shown goes whatever shows it, and
 *    is read again when it comes back into view.
 *  - Covers: the full-size captures the chrome takes of the active page before it hides it
 *    (`overlay.snapshot`, `lib/ui.ts`) – what a card that is swapped for the live page paints
 *    (`TabPreview` with `cover`, `lib/cover.ts`). A handful, for the tab a gesture just left.
 *
 * A picture is dropped the moment its tab navigates (the core's `tab.navigated` reaches the
 * chrome as the tab's `url`): a card never shows the previous page, it shows the placeholder
 * until the host captures the new one. A closed tab keeps its picture for a while, so an undo
 * brings the tab back with it; then it goes for good, here and on disk. A private tab's picture
 * is in memory alone – the host writes none (`Thumbnails.kt`), nothing is read for it, and it
 * goes the moment the tab does.
 */

export type Thumbnail = ThumbnailPicture

/** Bytes of decoded pixels the card pictures may take together: a dozen phone cards and more. */
export const THUMBNAIL_BUDGET = 24 * 1024 * 1024
/**
 * Past this many bytes a picture goes even from under a card that shows it (the least recently
 * shown first): the budget's backstop for a grid whose visible cards alone add up to more.
 */
export const THUMBNAIL_HARD_CAP = 2 * THUMBNAIL_BUDGET
/** Reads of the host's disk in flight at a time; the rest wait their turn, in the order asked. */
export const LOADS_IN_FLIGHT = 4
/** Full covers kept: the tab a gesture just left and its neighbours. */
export const COVERS_MAX = 3
/** How long a closed tab's picture waits for an undo before it goes for good. */
export const CLOSED_GRACE_MS = 60_000
/** The overview grid's gutter and gap, in CSS px (`TabOverview`: `px-3`, `gap-3`). */
const GRID_GUTTER = 12
const GRID_GAP = 12

interface ThumbnailState {
  /** Card pictures by tab, least recently shown first (the eviction order). */
  cards: ReadonlyMap<string, Thumbnail>
  /** Full covers by tab, oldest first. */
  covers: ReadonlyMap<string, string>
}

export const thumbnailStore = createStore<ThumbnailState>(
  { cards: new Map(), covers: new Map() },
  'thumbnails'
)

/** Per tab: how many cards on screen show its picture (kept while above zero, up to the cap). */
const pinned = new Map<string, number>()
/** Tabs whose picture the host has none of, until it captures one (saves a read per card). */
const missing = new Set<string>()
/** Reads in flight, per tab. */
const loading = new Set<string>()
/** Tabs waiting for a read, in the order their cards asked. */
const queued: string[] = []
/** Closed tabs whose picture waits for an undo. */
const graces = new Map<string, ReturnType<typeof setTimeout>>()
/** The URL each tab was last seen at (a change is a navigation). */
const urls = new Map<string, string>()
/** The tabs of the private container: nothing of theirs on the host's disk. */
const privateTabs = new Set<string>()
let swept = false
let configuredWidth = 0

/** The decoded size of a picture: what the budget counts. */
export function thumbnailBytes(picture: Thumbnail): number {
  return picture.width * picture.height * 4
}

function totalBytes(cards: ReadonlyMap<string, Thumbnail>): number {
  let bytes = 0
  for (const picture of cards.values()) bytes += thumbnailBytes(picture)
  return bytes
}

/**
 * Keep `cards` within the budget, oldest unpinned first. The pictures on screen stay whatever
 * they add up to – up to the hard cap, past which the oldest of them go too (a card that is
 * still up reads its picture again the next time it comes into view); the picture just added
 * stays either way – a card without one is worth less than a budget kept to the byte.
 */
function withinBudget(
  cards: ReadonlyMap<string, Thumbnail>,
  budget = THUMBNAIL_BUDGET,
  cap = THUMBNAIL_HARD_CAP
): ReadonlyMap<string, Thumbnail> {
  let bytes = totalBytes(cards)
  if (bytes <= budget) return cards
  const next = new Map(cards)
  const newest = [...cards.keys()].pop()
  for (const [id, picture] of cards) {
    if (bytes <= budget) break
    if ((pinned.get(id) ?? 0) > 0 || id === newest) continue
    next.delete(id)
    bytes -= thumbnailBytes(picture)
  }
  for (const [id, picture] of cards) {
    if (bytes <= cap) break
    if (!next.has(id) || id === newest) continue
    next.delete(id)
    bytes -= thumbnailBytes(picture)
  }
  return next
}

/**
 * A card picture from the host (`thumbnail.captured`, or a lazy read). Of a tab the chrome
 * knows – one in the state, or one closed within its grace – so a capture that lands after its
 * tab went for good is not kept for nobody.
 */
export function rememberCard(tabId: string, picture: Thumbnail): void {
  if (!urls.has(tabId) && !graces.has(tabId)) return
  missing.delete(tabId)
  thumbnailStore.set((s) => {
    const next = new Map(s.cards)
    next.delete(tabId)
    next.set(tabId, picture)
    return { cards: withinBudget(next) }
  })
}

/** A full cover of the page the chrome just captured (`overlay.snapshot`). */
export function rememberThumbnail(tabId: string, dataUrl: string): void {
  thumbnailStore.set((s) => {
    const next = new Map(s.covers)
    next.delete(tabId)
    next.set(tabId, dataUrl)
    while (next.size > COVERS_MAX) {
      const oldest = next.keys().next().value
      if (oldest === undefined) break
      next.delete(oldest)
    }
    return { covers: next }
  })
}

function pick(s: ThumbnailState, tabId: string | null | undefined, cover: boolean): string | null {
  if (!tabId) return null
  const card = s.cards.get(tabId)?.data ?? null
  const full = s.covers.get(tabId) ?? null
  return cover ? (full ?? card) : (card ?? full)
}

/**
 * The best picture of a tab: its full cover when `cover` (a card standing in for the live page
 * wants the page's own resolution), else its card picture, either falling back to the other.
 */
export function thumbnailOf(tabId: string | null | undefined, cover = true): string | null {
  return pick(thumbnailStore.get(), tabId, cover)
}

/** Whether a card picture (the host's kind) of the tab is in memory. */
export function hasCard(tabId: string): boolean {
  return thumbnailStore.get().cards.has(tabId)
}

/**
 * Read the tab's persisted picture unless one is in memory, known to be missing, on its way or
 * waiting its turn. Of a tab the chrome knows the URL of, which the host compares with the
 * picture's own (a picture of a page the tab has left is not answered); never of a private tab
 * (the host keeps none). A capture that lands meanwhile is newer than anything on disk and is
 * kept over it.
 */
export function loadThumbnail(tabId: string): void {
  if (hasCard(tabId) || missing.has(tabId) || loading.has(tabId) || queued.includes(tabId)) return
  if (!urls.has(tabId)) return
  if (privateTabs.has(tabId)) {
    missing.add(tabId)
    return
  }
  queued.push(tabId)
  pumpLoads()
}

/** Send the next reads, as many as may be in flight at once. */
function pumpLoads(): void {
  while (loading.size < LOADS_IN_FLIGHT && queued.length > 0) {
    const tabId = queued.shift()
    if (tabId === undefined) break
    const url = urls.get(tabId)
    if (url === undefined || hasCard(tabId) || missing.has(tabId)) continue
    loading.add(tabId)
    cmd('thumbnail.load', { tabId, url })
      .then((picture) => {
        if (!picture) {
          if (!hasCard(tabId)) missing.add(tabId)
        } else if (!hasCard(tabId) && !missing.has(tabId)) {
          rememberCard(tabId, picture)
        }
      })
      .catch(() => {
        if (!hasCard(tabId)) missing.add(tabId)
      })
      .finally(() => {
        loading.delete(tabId)
        pumpLoads()
      })
  }
}

function unqueue(tabId: string): void {
  const at = queued.indexOf(tabId)
  if (at >= 0) queued.splice(at, 1)
}

/** A card on screen shows the tab: its picture counts as used and stays while the card is up. */
export function retainThumbnail(tabId: string): void {
  pinned.set(tabId, (pinned.get(tabId) ?? 0) + 1)
  const { cards } = thumbnailStore.get()
  const picture = cards.get(tabId)
  if (picture && [...cards.keys()].pop() !== tabId) {
    const next = new Map(cards)
    next.delete(tabId)
    next.set(tabId, picture)
    thumbnailStore.set({ cards: next })
  }
  loadThumbnail(tabId)
}

/**
 * The card is off screen or gone: the picture may be evicted, its decoded pixels are the
 * browser's to free, and a read it was waiting for is not sent.
 */
export function releaseThumbnail(tabId: string): void {
  const count = (pinned.get(tabId) ?? 0) - 1
  if (count > 0) pinned.set(tabId, count)
  else {
    pinned.delete(tabId)
    unqueue(tabId)
  }
  const { cards } = thumbnailStore.get()
  const trimmed = withinBudget(cards)
  if (trimmed !== cards) thumbnailStore.set({ cards: trimmed })
}

/** How many tabs' cards are on screen (tests). */
export function pinnedCount(): number {
  return pinned.size
}

/** What the module holds and has in flight, for the tests and the preview host's measurements. */
export function thumbnailStats(): {
  pictures: number
  bytes: number
  pinned: number
  loading: number
  queued: number
} {
  const { cards } = thumbnailStore.get()
  return {
    pictures: cards.size,
    bytes: totalBytes(cards),
    pinned: pinned.size,
    loading: loading.size,
    queued: queued.length
  }
}

export interface UseThumbnailOptions {
  /** The card stands in for the live page: the full cover first (see `thumbnailOf`). */
  cover?: boolean
  /**
   * The card is drawn at the page's size without standing in for it (the swipe track's
   * neighbours): the full cover first when there is one, so the card picture is not scaled up.
   */
  sharp?: boolean
  /**
   * The card is on screen (or about to be). Off screen it holds no picture and reads none: the
   * overview grid tells each card so, from an observer on its scroller.
   */
  visible?: boolean
}

/**
 * The picture of a tab for a card. While `visible`, reads the persisted one when nothing is in
 * memory (the overview grid: a read per card on screen, never before), and keeps it from
 * eviction while the card is up. With `cover` or `sharp` the full capture is preferred.
 */
export function useThumbnail(
  tabId: string | null | undefined,
  { cover = false, sharp = false, visible = true }: UseThumbnailOptions = {}
): string | null {
  const picture = thumbnailStore.use((s) => pick(s, tabId, cover || sharp))
  useEffect(() => {
    if (!tabId || !visible) return
    retainThumbnail(tabId)
    return () => releaseThumbnail(tabId)
  }, [tabId, visible])
  return picture
}

/**
 * Capture `tabId` if its page is on screen and remember the result as its cover. Resolves with
 * the newest picture available (the fresh capture, or the remembered one when the page is
 * hidden). The host derives the tab's card picture from the same capture.
 */
export async function captureThumbnail(tabId: string): Promise<string | null> {
  const data = await cmd('overlay.snapshot', { tabId }).catch(() => null)
  if (data) rememberThumbnail(tabId, data)
  return data ?? thumbnailOf(tabId)
}

/**
 * Forget every picture of a tab, here and on the host's disk. The host is told once per picture
 * it may have: not again while the tab is known to have none there (a page that rewrites its
 * URL as it scrolls is one drop, not one per step) – and told which page the tab left (the URL
 * on record here, the one before the change), so a drop that lands after the host's capture of
 * the next page does not take that one. Unless the tab is gone for good, when the host's file
 * goes whatever the chrome knows of it. Never for a private tab: nothing is there.
 */
export function dropThumbnail(tabId: string, gone = false): void {
  const had = missing.has(tabId)
  const left = urls.get(tabId)
  thumbnailStore.set((s) => {
    if (!s.cards.has(tabId) && !s.covers.has(tabId)) return {}
    const cards = new Map(s.cards)
    const covers = new Map(s.covers)
    cards.delete(tabId)
    covers.delete(tabId)
    return { cards, covers }
  })
  unqueue(tabId)
  missing.add(tabId)
  if (privateTabs.has(tabId) || (had && !gone)) return
  run('thumbnail.drop', gone || left === undefined ? { tabId } : { tabId, url: left })
}

/**
 * Follow the tabs through every state the core sends. A tab whose URL changed navigated: its
 * pictures go now, whatever the card shows until the host captures the new page (BH-14). A tab
 * that left the state closed: its pictures stay `CLOSED_GRACE_MS` for an undo, then go for good;
 * a tab back before that keeps them. A private tab's go the moment it does. The first state is
 * the restored session: the host sweeps the pictures of every tab that is not in it (their tabs
 * are not coming back).
 */
export function trackTabs(state: UIState | null): void {
  if (!state) return
  if (!swept) {
    swept = true
    run('thumbnail.sweep', { keep: Object.keys(state.tabs) })
  }
  for (const id in state.tabs) {
    const tab = state.tabs[id]
    if (!tab) continue
    if (tab.containerId === PRIVATE_CONTAINER_ID) privateTabs.add(id)
    else privateTabs.delete(id)
    const last = urls.get(id)
    if (last !== undefined && last !== tab.url) dropThumbnail(id)
    urls.set(id, tab.url)
    const grace = graces.get(id)
    if (grace !== undefined) {
      clearTimeout(grace)
      graces.delete(id)
    }
  }
  for (const id of [...urls.keys()]) {
    if (id in state.tabs) continue
    urls.delete(id)
    if (privateTabs.has(id)) {
      dropThumbnail(id)
      privateTabs.delete(id)
      missing.delete(id)
      continue
    }
    if (graces.has(id)) continue
    graces.set(
      id,
      setTimeout(() => {
        graces.delete(id)
        dropThumbnail(id, true)
        missing.delete(id)
      }, CLOSED_GRACE_MS)
    )
  }
}

/**
 * How wide a card's picture is to be, in device pixels, for a viewport `width` CSS px wide on a
 * screen of `dpr`: the width of an overview grid cell there, the widest card any consumer draws
 * at its own size (the swipe track's page-sized cards scale it up for the moment they move).
 */
export function thumbnailWidthFor(width: number, dpr: number): number {
  if (!(width > 0)) return 0
  const columns = overviewColumns(width)
  const cell = (width - 2 * GRID_GUTTER - (columns - 1) * GRID_GAP) / columns
  return Math.max(1, Math.round(cell * Math.max(1, dpr || 1)))
}

/** Tell the host the card width once it is known and whenever it changes (a rotation, a resize). */
export function configureThumbnails(width: number): void {
  if (width <= 0 || width === configuredWidth) return
  configuredWidth = width
  run('thumbnail.configure', { width })
}

/** Everything the module remembers, back to the start (tests). */
export function resetThumbnails(): void {
  for (const grace of graces.values()) clearTimeout(grace)
  graces.clear()
  pinned.clear()
  missing.clear()
  loading.clear()
  queued.length = 0
  urls.clear()
  privateTabs.clear()
  swept = false
  configuredWidth = 0
  thumbnailStore.set({ cards: new Map(), covers: new Map() })
}
