import type { ReaderTheme } from '@shared/reader'
import type { Tab, UIState } from '@shared/types'
import { READER_URL_PREFIX } from '@shared/url'
import { cmd, run } from './api'
import { browserStore } from './browserStore'
import { chromeUnderPages, SHOWN_WAIT_MS } from './cover'
import { viewportStore } from './formFactor'
import { pageCovered, pageOffScreen, pageViewStore } from './pageView'
import { activeTab } from './selectors'
import { createStore } from './store'

/*
 * The reader crossing (MOT-36; v2 §11): the phone's way into Reader View and back out. The
 * Android chrome lies under the page views (`lib/cover.ts`), so nothing the chrome draws can
 * fade OVER a live page; what it can do is what every sheet does – swap the page for its
 * picture on a frame where the two are identical, then move the picture. So the crossing, both
 * ways:
 *
 *   1. `covering` – the page's picture is mounted where the page is (`ReaderCrossing`, a
 *      tracked cover: the layout reporter takes the live view down only once the picture is
 *      painted) and, over it, the reader's surface – the colour the reader document paints its
 *      ground – at 0.
 *   2. `loading` – the page is off the screen; the surface fades in over the picture in 120 ms
 *      on `--zen-ease` (§11's state change; §11.3 keeps an opacity fade under reduced motion),
 *      and the core is asked to cross (`reader.toggle`): the extraction and the navigation to
 *      `zen://reader` on the way in, the navigation back to the article on the way out. The
 *      §9.33 load bar at the frame's edge is the sign of life meanwhile, as for any load.
 *   3. `landing` – the destination's document has loaded (or the hold has run its bound): the
 *      view is asked back, and the surface stands until the host has drawn it (`pageOffScreen`,
 *      the cover protocol's close-direction guarantee), so the reader's first frame – its text
 *      on the very ground the surface showed – is what replaces the surface, never a blank.
 *
 * The exit is the same run in the other direction: the reader's picture to its surface, the
 * article's first frame in its place. A crossing the core never completes (an extraction that
 * fails: the core toasts and stays) gives the page back as it was after `START_TIMEOUT_MS`;
 * a destination slow to finish loading is shown live after `LOAD_HOLD_MS` and loads in view
 * (the way out over a slow network is not a blank screen). Off the Android chassis – the
 * desktop, whose frame is not under the pages – `crossReaderView` is `reader.toggle` alone.
 *
 * The picture is the crossing's own (`overlay.snapshot`, the hosts' capture), not the sheets'
 * snapshot in `lib/ui.ts`: a sheet's picture is held and released with the sheet, and this
 * module is `lib/ui.ts`'s to call (the menu's Reader View row), not the other way round.
 */

export type ReaderCrossing = 'enter' | 'exit'
export type ReaderCrossingPhase = 'covering' | 'loading' | 'landing'

export interface ReaderCrossingState {
  tabId: string
  crossing: ReaderCrossing
  phase: ReaderCrossingPhase
  /** The page's picture as the crossing began, or null when none could be taken: the surface then stands alone. */
  picture: string | null
  /** The reader's ground colour, under the picture and over the destination's arrival. */
  surface: string
  /**
   * The surface's opacity held at a value in place of its fade, for a still of the crossing
   * mid-way (the preview host's frames; never set by the crossing itself).
   */
  freezeAt?: number
}

export const readerCrossingStore = createStore<{ crossing: ReaderCrossingState | null }>(
  { crossing: null },
  'reader-crossing'
)

/** The crossing in flight for `tabId`, if any (a component's selector). */
export function readerCrossingOf(
  s: { crossing: ReaderCrossingState | null },
  tabId: string | null | undefined
): ReaderCrossingState | null {
  return s.crossing && s.crossing.tabId === tabId ? s.crossing : null
}

/**
 * Whether a crossing holds `tabId`'s page off the screen (the layout reporter's read): from its
 * start until `landing`, when the destination's view is asked back under the standing surface.
 */
export function readerCrossingHolds(
  s: { crossing: ReaderCrossingState | null },
  tabId: string | null | undefined
): boolean {
  const crossing = readerCrossingOf(s, tabId)
  return crossing !== null && crossing.phase !== 'landing'
}

/** The outgoing fade: the page's picture to the reader's surface (§11's 120 ms on `--zen-ease`). */
export const CROSSING_OUT_MS = 120

/**
 * How long the crossing waits for the core to reach the destination at all – the extraction
 * and the navigation on the way in, the navigation on the way out – before the page is given
 * back as it was (an extraction that failed toasts and never navigates).
 */
export const START_TIMEOUT_MS = 2500

/**
 * How long, once the destination's document is loading, the surface holds for the load to end
 * before the live page is shown as it loads: brief on the way in (a `zen://reader` document is
 * the core's own, rendered at once), briefer still on the way out, where the article comes off
 * the network and a blank surface for seconds would be the wrong trade.
 */
export const LOAD_HOLD_MS: Readonly<Record<ReaderCrossing, number>> = { enter: 2500, exit: 1500 }

/**
 * The reader document's ground per theme (`core/readerPage.ts`'s `--bg`; services' page, read
 * here so the surface the crossing shows is the ground the reader then paints – the test pins
 * them to the page's stylesheet). `auto` follows the chrome's resolved scheme.
 */
export const READER_SURFACE = {
  light: '#fbfbfd',
  dark: '#18181c',
  sepia: '#f4ecd8'
} as const

export function readerSurfaceColor(theme: ReaderTheme, darkScheme: boolean): string {
  switch (theme) {
    case 'light':
      return READER_SURFACE.light
    case 'dark':
      return READER_SURFACE.dark
    case 'sepia':
      return READER_SURFACE.sepia
    default:
      return darkScheme ? READER_SURFACE.dark : READER_SURFACE.light
  }
}

export function isReaderUrl(url: string): boolean {
  return url.startsWith(READER_URL_PREFIX)
}

/** Which way a crossing from `url` goes. */
export function crossingFrom(url: string): ReaderCrossing {
  return isReaderUrl(url) ? 'exit' : 'enter'
}

/** What the crossing sees of its tab, for the verdict. */
export interface CrossingObservation {
  url: string
  loading: boolean
  /** The destination's document has been seen loading since it was reached. */
  sawLoading: boolean
  /** ms since the crossing began. */
  sinceStartMs: number
  /** ms since the destination was reached (the URL crossed), or null before it. */
  sinceArrivedMs: number | null
}

export type CrossingVerdict = 'hold' | 'land' | 'abort'

/** Whether `url` is on the destination's side of the crossing. */
export function arrived(crossing: ReaderCrossing, url: string): boolean {
  return crossing === 'enter' ? isReaderUrl(url) : !isReaderUrl(url)
}

/**
 * The surface's verdict on one observation: hold, land (the destination is there to show), or
 * abort (the destination was never reached: give the page back). Pure; the controller polls it
 * on every state change and at each bound.
 */
export function crossingVerdict(crossing: ReaderCrossing, o: CrossingObservation): CrossingVerdict {
  if (!arrived(crossing, o.url)) return o.sinceStartMs >= START_TIMEOUT_MS ? 'abort' : 'hold'
  if (o.sawLoading && !o.loading) return 'land'
  if ((o.sinceArrivedMs ?? 0) >= LOAD_HOLD_MS[crossing]) return 'land'
  return 'hold'
}

/** The next bound (ms from now) at which the verdict can change on time alone, for the controller's timer. */
export function nextBoundMs(crossing: ReaderCrossing, o: CrossingObservation): number {
  if (!arrived(crossing, o.url)) return Math.max(0, START_TIMEOUT_MS - o.sinceStartMs)
  return Math.max(0, LOAD_HOLD_MS[crossing] - (o.sinceArrivedMs ?? 0))
}

/**
 * Whether the crossing runs here: the phone layout on the chassis whose chrome lies under the
 * pages (the Android host and its preview stand-in). The tablet and the desktop cross on the
 * core's cut, as before.
 */
export function crossingAvailable(state: UIState): boolean {
  return chromeUnderPages(state.platform) && viewportStore.get().formFactor === 'phone'
}

function darkScheme(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Resolves when the store no longer holds this crossing, or the page is shown again, or the bound passes. */
function landed(tabId: string): Promise<void> {
  if (!pageOffScreen(pageViewStore.get(), tabId)) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      unsubscribe()
      clearTimeout(bound)
      resolve()
    }
    const unsubscribe = pageViewStore.subscribe(() => {
      if (!pageOffScreen(pageViewStore.get(), tabId)) finish()
    })
    const bound = setTimeout(finish, SHOWN_WAIT_MS)
  })
}

function setPhase(tabId: string, phase: ReaderCrossingPhase): void {
  readerCrossingStore.set((s) =>
    s.crossing && s.crossing.tabId === tabId ? { crossing: { ...s.crossing, phase } } : {}
  )
}

export interface CrossOptions {
  /** The core's crossing; `reader.toggle` unless a host stands one in (the preview's article). */
  cross?: () => void
  /**
   * A picture of the page already in hand – the sheet's, when the crossing is a menu row's pick
   * and the page is under the sheet's picture already (`lib/ui.ts` `pickMenuItem`): the
   * crossing begins on it in the same turn, so the page is never let back between the sheet's
   * going and the surface's coming. Absent, the crossing takes its own.
   */
  picture?: string | null
}

/**
 * Cross into or out of Reader View for `tabId` with the transition where it runs, and with the
 * core's plain toggle where it does not. One crossing at a time: a second call while one is in
 * flight is the plain toggle too.
 */
export function crossReaderView(tabId: string, opts: CrossOptions = {}): Promise<void> {
  const cross = opts.cross ?? ((): void => run('reader.toggle', { tabId }))
  const state = browserStore.get().state
  const tab = state?.tabs[tabId]
  if (!state || !tab || readerCrossingStore.get().crossing !== null || !crossingAvailable(state)) {
    cross()
    return Promise.resolve()
  }
  const crossing = crossingFrom(tab.url)
  const startedAt = performance.now()
  const surface = readerSurfaceColor(state.settings.reader.theme, darkScheme())
  const begin = (picture: string | null): void => {
    readerCrossingStore.set({ crossing: { tabId, crossing, phase: 'covering', picture, surface } })
  }
  // A picture in hand begins the crossing in this very turn (see `CrossOptions.picture`).
  if (opts.picture !== undefined) begin(opts.picture)
  return (async (): Promise<void> => {
    // Else the picture where the page is, now: the swap must be invisible.
    if (opts.picture === undefined) begin(await takePicture(tabId))
    const mine = (): boolean => readerCrossingStore.get().crossing?.tabId === tabId
    // The layout reporter takes the live view down once the picture is painted; the fade waits
    // for the frame that has the picture alone.
    await pageCovered(tabId, state.platform).promise
    if (!mine()) return
    setPhase(tabId, 'loading')
    cross()
    await settled(tabId, crossing, startedAt)
    if (!mine()) return
    setPhase(tabId, 'landing')
    // A frame for the report that brings the view back, then the host's word that it is drawn.
    await wait(0)
    await landed(tabId)
    if (mine()) readerCrossingStore.set({ crossing: null })
  })()
}

/** The hosts' capture of the page as it is; null where none can be had (the surface then stands alone). */
async function takePicture(tabId: string): Promise<string | null> {
  try {
    return await cmd('overlay.snapshot', { tabId })
  } catch {
    return null
  }
}

/** Watch the tab until the verdict is land or abort. */
function settled(tabId: string, crossing: ReaderCrossing, startedAt: number): Promise<void> {
  return new Promise((resolve) => {
    let sawLoading = false
    let arrivedAt: number | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
      resolve()
    }
    const observe = (): void => {
      if (done) return
      const state = browserStore.get().state
      const tab: Tab | undefined = state?.tabs[tabId]
      // The tab gone, or another in front: nothing to hold the frame for.
      if (
        !state ||
        !tab ||
        activeTab(state)?.id !== tabId ||
        readerCrossingStore.get().crossing?.tabId !== tabId
      ) {
        finish()
        return
      }
      const now = performance.now()
      if (arrived(crossing, tab.url)) {
        arrivedAt ??= now
        if (tab.loading) sawLoading = true
      }
      const observation: CrossingObservation = {
        url: tab.url,
        loading: tab.loading,
        sawLoading,
        sinceStartMs: now - startedAt,
        sinceArrivedMs: arrivedAt === null ? null : now - arrivedAt
      }
      if (crossingVerdict(crossing, observation) !== 'hold') {
        finish()
        return
      }
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(observe, nextBoundMs(crossing, observation) + 1)
    }
    const unsubscribe = browserStore.subscribe(observe)
    observe()
  })
}
