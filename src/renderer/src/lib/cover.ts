import type { Platform } from '@shared/types'
import { createStore } from './store'

/**
 * The page cover: the picture the chrome paints where the live page is – the snapshot behind a
 * sheet, the hero card of the overview, the card under the finger during a tab switch – so that
 * hiding the page view swaps it for an identical picture.
 *
 * On Android the chrome WebView lies *under* the page WebViews. Nothing the chrome draws is
 * visible until the page is hidden, and the moment it is hidden, whatever the chrome has drawn
 * by then is what shows. A snapshot `<img>` that is in the DOM but not yet decoded and
 * rasterised shows the window's gradient in place of the page for a few frames – a second on a
 * slow device. So covers report themselves here from mount to the frame that carries their
 * pixels, and the layout reporter keeps the page views until the active tab's cover is painted
 * (see `decideHidden`). The host adds its half of the guarantee: it takes a page view down no
 * earlier than with the chrome frame the layout was reported from (`PageVisibility.kt`).
 */
interface CoverState {
  /** Per tab: mounted cover images whose pixels are not on screen yet. */
  loading: ReadonlyMap<string, number>
  /** Per tab: mounted cover images whose pixels are on screen. */
  painted: ReadonlyMap<string, number>
  /**
   * Tabs whose page view a layout just brought back and whose host has not yet said the view is
   * on screen (Q1, the observable landing – the §11 stand-in rule): whatever stands in for the
   * page of such a tab – the cover under a sheet's close, the gesture stage's card where a swipe
   * or the overview lands – stays until the host's answer (`landingAnswered`) or the bound
   * (`SHOWN_WAIT_MS`). Only ever set on a host that answers placements
   * (`HostCapabilities.placementAnswered`); the others' stand-ins leave as they always did.
   */
  awaitingShow: ReadonlySet<string>
}

export const coverStore = createStore<CoverState>(
  { loading: new Map(), painted: new Map(), awaitingShow: new Set() },
  'cover'
)

/**
 * Whether this host's chrome lies under its page views, so that hiding a page shows whatever the
 * chrome has drawn by then. This is a property of the chassis, not of the layout: the Android
 * host (`Host.kt`) stacks its views this way on a phone, on a tablet and in a DeX window with a
 * mouse alike, so a cover stands in for the page at every form factor there. The rest of that
 * chassis's protocol – the capture mounted ahead of the overlay (`coverPrimed`), the page kept
 * until the host has drawn the live view back (`pageOffScreen`), the host's layout and draw
 * events – is Android's alone; the wait for the cover's paint before the hide is every host's
 * (`hideFollowsCover`).
 */
export function chromeUnderPages(platform: Platform): boolean {
  return platform === 'android'
}

/**
 * Whether a page view's hide waits for its cover's paint (`decideHidden`): on every host. On
 * Android it must – the chrome lies under the pages. On Electron the page view composites above
 * the chrome too, and nothing orders the main process's hide of the view after the chrome's next
 * frame: reported the moment it was wanted, the hide left the window's colour where the page was
 * for a frame on 4 of 10 opens of the app menu (Xvfb, 1600×1000, #299 F1) – the frame the
 * display composed between the view's going and the chrome's frame carrying the picture and the
 * menu. Waiting costs the two frames `trackCover` counts on a page that decodes at all,
 * `COVER_WAIT_MS` at most.
 */
export function hideFollowsCover(): boolean {
  return true
}

/**
 * Whether the active tab's capture is to be mounted ahead of anything covering the page: where
 * the chrome lies under the page views, the moment a capture of `tabId` exists. Under the live
 * page nothing of it shows, and it is decoded and painted – `trackCover` has counted it – by the
 * time a sheet asks for the page to go, so `decideHidden` hides at once instead of after the
 * decode and the two frames that carry it. The capture `prepareMenu` takes as the finger lands
 * on the menu button is the case (PERF-2, #269: on the emulator's profile the sheet mounted
 * ~590 ms after the tap and moved ~990 ms after it; the decode and its frames were in between).
 * The desktop hosts mount the capture once something covers the page, as they always have; the
 * hide then waits for its paint (`hideFollowsCover`).
 */
export function coverPrimed(
  platform: Platform,
  snapshotTabId: string | null,
  tabId: string | null | undefined
): boolean {
  return chromeUnderPages(platform) && snapshotTabId !== null && snapshotTabId === tabId
}

/**
 * How long a hide waits for a cover that is on its way. A decode that never finishes must not
 * keep a sheet under the live page; on any device that paints at all the wait ends far sooner.
 */
export const COVER_WAIT_MS = 2500

/**
 * How long a stand-in waits for the host's answer to the placement that brought the page back
 * (`awaitingShow`). The host bounds its own answer by the view's frame deadline
 * (`PageVisibility.DRAWN_DEADLINE_MS`, 600 ms – a renderer that never draws is not waited on
 * past it, and the answer is then `false`), so the answer comes within that; this is the
 * chrome's patience for a host that never answers at all – a call lost with its port, a view
 * host torn down – and it is the chrome's patience for the host's `view.drawn`
 * (`ACK_TIMEOUT_MS`, `lib/pageView.ts`) for the same frame, above the host's bound so the
 * host's word is heard first. The safe side is overlap – a stand-in a frame too long over a
 * page that is there – and a wait this long is still the safe side; the forbidden side, a gap,
 * is what the answer removes.
 */
export const SHOWN_WAIT_MS = 1000

/** Whether `tabId`'s page view was just brought back and its host has not yet said it is on screen. */
export function awaitingShow(state: CoverState, tabId: string | null | undefined): boolean {
  return tabId ? state.awaitingShow.has(tabId) : false
}

const shownBounds = new Map<string, ReturnType<typeof setTimeout>>()

function stopAwaiting(tabId: string): void {
  const bound = shownBounds.get(tabId)
  if (bound !== undefined) {
    clearTimeout(bound)
    shownBounds.delete(tabId)
  }
  coverStore.set((s) => {
    if (!s.awaitingShow.has(tabId)) return s
    const next = new Set(s.awaitingShow)
    next.delete(tabId)
    return { awaitingShow: next }
  })
}

/**
 * A layout the core applied brought these tabs' page views back (`layout.applied`'s `shown`):
 * their stand-ins now wait for the host's answer to the placement. Called before the page-view
 * phases take the same event (`lib/pageView.ts`), so whoever watches both sees the wait begin
 * with the placement, not after it.
 */
export function landingsSent(tabIds: readonly string[]): void {
  if (tabIds.length === 0) return
  coverStore.set((s) => {
    const next = new Set(s.awaitingShow)
    for (const tabId of tabIds) next.add(tabId)
    return { awaitingShow: next }
  })
  for (const tabId of tabIds) {
    const previous = shownBounds.get(tabId)
    if (previous !== undefined) clearTimeout(previous)
    shownBounds.set(
      tabId,
      setTimeout(() => {
        shownBounds.delete(tabId)
        stopAwaiting(tabId)
      }, SHOWN_WAIT_MS)
    )
  }
}

/**
 * The host answered the placement that brought `tabId`'s view back (`view.shown`): the page is
 * on screen, or it is not and nothing is coming – a view the host does not have or does not
 * show, a frame that never came within the host's bound (the event's `shown` tells which; the
 * bridge marks it). Either way the stand-in has nothing left to wait for and leaves.
 */
export function landingAnswered(tabId: string): void {
  stopAwaiting(tabId)
}

/**
 * The moment a stand-in for `tabId`'s live page actually leaves the chrome's state (the next
 * frame draws without it), marked in the performance timeline under the bridge's trace flag
 * (`bridge.ts`), so a scene's trace reads the landing's sequence – the placement's batch, the
 * view's frame, the host's answer, this drop – and the overlap between the page's frame and the
 * stand-in's last one is counted, never a gap.
 */
export function markCoverDrop(tabId: string): void {
  if ((globalThis as { __zenBridgeTrace?: unknown }).__zenBridgeTrace === true)
    performance.mark(`cover:drop:${tabId}`)
}

export interface CoverStatus {
  /** A cover for the tab is mounted and its picture is still loading or decoding. */
  loading: boolean
  /** A cover for the tab has its pixels on screen. */
  painted: boolean
}

export function coverStatus(state: CoverState, tabId: string | null | undefined): CoverStatus {
  if (!tabId) return { loading: false, painted: false }
  return {
    loading: (state.loading.get(tabId) ?? 0) > 0,
    painted: (state.painted.get(tabId) ?? 0) > 0
  }
}

/**
 * Whether the page views are to be hidden now. `wantsHidden` is what the chrome's state asks
 * for (`overlayCoversContent`), `hidden` what the previous report said, `cover` the state of the
 * active tab's cover and `waitedOut` whether the current wait has run past `COVER_WAIT_MS`.
 *
 *  - A show is honoured at once. (The cover's unmount against the page view's return is the
 *    close direction's own ordering; it is not decided here.)
 *  - A hidden page stays hidden while wanted, even while a fresher cover is still decoding;
 *    showing it for a frame would gain nothing.
 *  - A hide waits while a cover is on its way, until the cover is painted or the wait ran out.
 *  - With nothing to wait for – no cover mounted for this tab: an empty space, a page without a
 *    picture, the phone URL bar over the whole frame – it hides at once.
 */
export function decideHidden(
  wantsHidden: boolean,
  hidden: boolean,
  cover: CoverStatus,
  waitedOut: boolean
): boolean {
  if (!wantsHidden) return false
  if (hidden || cover.painted) return true
  if (cover.loading && !waitedOut) return false
  return true
}

function bump(
  map: ReadonlyMap<string, number>,
  tabId: string,
  by: number
): ReadonlyMap<string, number> {
  const next = new Map(map)
  const count = (next.get(tabId) ?? 0) + by
  if (count > 0) next.set(tabId, count)
  else next.delete(tabId)
  return next
}

/** The subset of `HTMLImageElement` a cover is followed through (a plain object in tests). */
export interface CoverImageLike {
  complete: boolean
  naturalWidth: number
  decode?: () => Promise<void>
  addEventListener(type: 'load' | 'error', listener: () => void): void
  removeEventListener(type: 'load' | 'error', listener: () => void): void
}

/**
 * Follow a mounted cover image for `tabId` from its mount to the frame that has its pixels,
 * counting it in the store as loading, then as painted. Returns the release to call when the
 * image unmounts or changes its source.
 *
 * "Painted" is two animation frames after the picture is decoded: the frame after the decode is
 * the first the compositor produces with the pixels, and when the frame after that one begins,
 * that frame has been drawn. An image that fails to load is nothing to wait for.
 */
export function trackCover(tabId: string, img: CoverImageLike): () => void {
  let released = false
  let frame = 0
  let phase: 'loading' | 'painted' | 'failed' = 'loading'
  coverStore.set((s) => ({ loading: bump(s.loading, tabId, 1) }))

  const onDecoded = (): void => {
    if (released) return
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (released) return
        phase = 'painted'
        coverStore.set((s) => ({
          loading: bump(s.loading, tabId, -1),
          painted: bump(s.painted, tabId, 1)
        }))
      })
    })
  }
  const onError = (): void => {
    if (released || phase !== 'loading') return
    phase = 'failed'
    coverStore.set((s) => ({ loading: bump(s.loading, tabId, -1) }))
  }
  const onLoad = (): void => {
    if (released) return
    // A loaded image may still be undecoded; `decode()` resolves once its pixels are ready to
    // paint. Where it is missing, `decoding="sync"` on the element does the work at raster time.
    const decoded = typeof img.decode === 'function' ? img.decode() : Promise.resolve()
    decoded.then(onDecoded, onDecoded)
  }

  if (img.complete && img.naturalWidth > 0) {
    // Already in the browser's image cache (a thumbnail shown before): no load event will come.
    onLoad()
  } else if (img.complete) {
    onError()
  } else {
    img.addEventListener('load', onLoad)
    img.addEventListener('error', onError)
  }

  return () => {
    if (released) return
    released = true
    cancelAnimationFrame(frame)
    img.removeEventListener('load', onLoad)
    img.removeEventListener('error', onError)
    if (phase === 'loading') coverStore.set((s) => ({ loading: bump(s.loading, tabId, -1) }))
    else if (phase === 'painted') coverStore.set((s) => ({ painted: bump(s.painted, tabId, -1) }))
  }
}
