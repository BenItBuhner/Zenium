import { cmd } from './api'
import { createStore } from './store'

/** How many tab thumbnails to keep (each is a small JPEG data URL). */
const MAX_THUMBNAILS = 16

interface ThumbnailState {
  /** Latest capture per tab; insertion order doubles as the eviction order. */
  byTab: ReadonlyMap<string, string>
}

/**
 * The last thing each tab looked like. Hosts can only capture a page while it is on screen
 * (Android's PixelCopy needs a visible view), so every capture the chrome makes – before an
 * overlay hides the page, when a gesture begins – is remembered here and reused later for the
 * cards of tabs that are currently hidden: the neighbour peeking in during a swipe, the grid of
 * the tab overview.
 */
export const thumbnailStore = createStore<ThumbnailState>({ byTab: new Map() }, 'thumbnails')

export function rememberThumbnail(tabId: string, dataUrl: string): void {
  const next = new Map(thumbnailStore.get().byTab)
  next.delete(tabId)
  next.set(tabId, dataUrl)
  while (next.size > MAX_THUMBNAILS) {
    const oldest = next.keys().next().value
    if (oldest === undefined) break
    next.delete(oldest)
  }
  thumbnailStore.set({ byTab: next })
}

export function thumbnailOf(tabId: string | null | undefined): string | null {
  return tabId ? (thumbnailStore.get().byTab.get(tabId) ?? null) : null
}

export function useThumbnail(tabId: string | null | undefined): string | null {
  return thumbnailStore.use((s) => (tabId ? (s.byTab.get(tabId) ?? null) : null))
}

/**
 * Capture `tabId` if its page is on screen and remember the result. Resolves with the newest
 * thumbnail available (the fresh capture, or the remembered one when the page is hidden).
 */
export async function captureThumbnail(tabId: string): Promise<string | null> {
  const data = await cmd('overlay.snapshot', { tabId }).catch(() => null)
  if (data) rememberThumbnail(tabId, data)
  return data ?? thumbnailOf(tabId)
}

/** Forget the thumbnails of tabs that no longer exist (closed tabs must not keep their pixels). */
export function pruneThumbnails(keep: (tabId: string) => boolean): void {
  const { byTab } = thumbnailStore.get()
  if (byTab.size === 0) return
  let stale = false
  for (const id of byTab.keys()) if (!keep(id)) stale = true
  if (!stale) return
  const next = new Map<string, string>()
  for (const [id, data] of byTab) if (keep(id)) next.set(id, data)
  thumbnailStore.set({ byTab: next })
}
