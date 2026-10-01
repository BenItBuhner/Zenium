import { bandStore, chooseBand, dismissBand, setBandFrame, shownBand } from '@renderer/lib/band'
import type { BandSeam } from '@renderer/lib/motion/band'
import { moveChromePage } from '@renderer/lib/pageBand'
import { holdPage, setPageHold, type PageHold } from '@renderer/lib/pull'
import { bandFrameOf, subscribeBandSignals, type BandSignals } from './signals'

/**
 * The page-edge band's host on Android (motion spec §3.4 Android): the {@link BandSeam} the
 * band's motion driver (`lib/motion/band.ts`) writes to, implemented over the pull-to-refresh
 * channel, and the host's word to the band's model (`lib/band.ts`) on which tab is in front and
 * whether a band may show on it.
 *
 * The band's spring writes the page's offset here; it travels the one channel the pull uses
 * (`lib/pull.ts` → the bridge's `view.setPullOffset` → `Host.kt` → `TabWebView.setPullOffset`),
 * so Kotlin moves the page the same way for both and one source has it at a time: a frame is
 * refused while a pull has the page, and a pull that begins on the held page takes it over
 * where it sits – the model hears the frame is not the band's (`pulling` → the frame not `ok`), the
 * shown offer is taken down as the chrome's doing (`program`: no tenant counts it as the user's
 * refusal), and a state waits for the pull to end and returns on its own entrance. No per-frame
 * work of the host's own: the driver calls {@link BandSeam.translate} per frame, the stores
 * publish at rest.
 *
 * A page the CHROME DRAWS itself – a `render: 'chrome'` page under `InternalPageHost` (Settings,
 * History, …) or the phone's new tab page over `zen://blank` – has no view under it for the pull
 * channel to move. For it the same frame goes to `lib/pageBand.ts`'s offset store instead
 * (`moveChromePage`), which #740's `PageBandLayer` – mounted around those pages on Android too
 * (`ContentArea.tsx`) – reads without React and translates the page by: the one writer, two
 * surfaces, the signals' `chromePage` saying which the front page is (the Design Lead's (B) on
 * #735's question (8): the band stands on the chrome-drawn pages once this layer is there). The
 * core is not told (`layout.pageOffset` is the desktop's seam: it moves placed views, and a
 * chrome page has none – `core/pages.ts`); the seat stays 0 – a translation, clipped by the
 * frame, as the WebView is under the pull channel.
 *
 * The page the band stands on is the front tab's. A tab leaving the front with its page held
 * has it put home at once – a view in the back must not keep its translation for its return –
 * and the page coming to the front is put where the band stands if the band stands on it (a
 * window-wide band stands on every page tab, §3.2); the same when the front tab's page changes
 * kind under a standing band (the new tab page navigating to a web page: the chrome's layer
 * comes home, the WebView takes the band's offset). A leave the model asks for after the switch
 * (a tab-scoped band's, or the new page's being no place for a band) moves no page the band
 * does not hold.
 */
export interface AndroidBandHost extends BandSeam {
  /** The page's offset the band last asked for (0 shut) – what a tab change re-targets. */
  readonly offset: number
  /**
   * The band left the host (unmounted): the held page comes home at once, the model hears no
   * front, and the host stops listening. Not for a dismissal – the band's own spring brings the
   * page home for those.
   */
  release(): void
}

/** The surface a frame moves: the front tab's WebView, or the chrome's own layer for a page it draws. */
type Surface = { tabId: string; layer: boolean }

function surfaceOf(signals: BandSignals): Surface | null {
  if (signals.tabId === null) return null
  return { tabId: signals.tabId, layer: signals.chromePage }
}

function sameSurface(a: Surface | null, b: Surface | null): boolean {
  return a === b || (a !== null && b !== null && a.tabId === b.tabId && a.layer === b.layer)
}

/**
 * The one Android host; the touch shell creates it when the band's layer mounts and
 * {@link AndroidBandHost.release releases} it when the layer goes.
 */
export function createAndroidBandHost(): AndroidBandHost {
  let front: Surface | null = null
  /** The tab whose WebView the host holds translated through the pull channel (an accepted frame above 0). */
  let held: string | null = null
  /** The chrome's layer is translated (a frame above 0 written to the offset store). */
  let layerHeld = false
  let offset = 0

  const write = (surface: Surface, x: number): boolean => {
    if (surface.layer) {
      moveChromePage(x)
      layerHeld = x > 0
      return true
    }
    if (!holdPage(surface.tabId, x)) return false
    if (x > 0) held = surface.tabId
    else if (held === surface.tabId) held = null
    return true
  }

  /** Whether a frame moves `surface`: the band holds it already, or a band stands on it (its entrance). */
  const holds = (surface: Surface): boolean => (surface.layer ? layerHeld : held === surface.tabId)

  const home = (): void => {
    if (layerHeld) write({ tabId: front?.tabId ?? '', layer: true }, 0)
    if (held !== null) write({ tabId: held, layer: false }, 0)
  }

  const hold: PageHold = {
    displaced: (tabId) => {
      if (held === tabId) held = null
      // §3.4 Android: a pull while a band stands dismisses the band first – an offer goes (not
      // the user's answer: `program`); a state holds and waits for the pull to end. The pull
      // has already told the model the frame is not the band's, so the band that stood is read
      // as if it were. Only the band that STOOD is judged: an offer waiting behind a standing
      // state (the state > offer priority, §3.2) is not dismissed and shows after the pull ends,
      // when its turn comes – it was never up to be taken down.
      const stood = chooseBand({ ...bandStore.get(), ok: true })
      if (stood?.form === 'offer') dismissBand(stood.id, 'program')
    }
  }
  setPageHold(hold)

  const off = subscribeBandSignals((signals) => {
    // The model first: it decides whether a band stands on the page coming to the front, whether
    // an offer may (not on a private tab, whose offers Chrome withholds too; §3.2) and whether a
    // cover holds an arriving prompt back.
    setBandFrame(bandFrameOf(signals))
    const next = surfaceOf(signals)
    if (sameSurface(next, front)) return
    // The surface leaving the front comes home at once; the one arriving takes the standing
    // band's offset. A page changing kind under the band (the new tab page navigating to a web
    // page) is a leave and an arrival on the same tab.
    if (front !== null && holds(front)) write(front, 0)
    front = next
    if (front !== null && offset > 0 && shownBand() !== null) write(front, offset)
  })

  return {
    get offset() {
      return offset
    },
    translate: (x) => {
      offset = Math.max(0, x)
      if (front === null) return
      // A frame moves the page the band holds, or the page a band stands on (its entrance);
      // a leave after a tab switch – the band gone from the new page – moves nothing.
      if (!holds(front) && shownBand() === null) return
      write(front, offset)
    },
    rest: (height) => {
      // Android lays nothing out at rest: the page stays where the hold has it. At 0 the hold
      // is let go (the page is home; the pull is free to take it).
      if (height === 0) home()
    },
    paint: () => {
      // The band's content writes its own opacity; the page's chrome has nothing to paint.
    },
    release: () => {
      home()
      off()
      setPageHold(null)
      setBandFrame({ front: null, ok: false })
    }
  }
}
