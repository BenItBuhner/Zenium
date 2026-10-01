import { bandStore, chooseBand, dismissBand, setBandFrame, shownBand } from '@renderer/lib/band'
import type { BandSeam } from '@renderer/lib/motion/band'
import { moveChromePage, seatChromePage } from '@renderer/lib/pageBand'
import { holdPage, setPageHold, type PageHold } from '@renderer/lib/pull'
import { seatDocument } from './seat'
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
 * channel to move. For it the same frame goes to `lib/pageBand.ts`'s CHROME PAGE'S pair instead
 * (`moveChromePage`, `seatChromePage`), which #740's `PageBandLayer` – mounted around those
 * pages on Android too (`ContentArea.tsx`, `source="chrome-page"`) – reads and moves the page
 * by: the one writer, two surfaces, the signals' `chromePage` saying which the front page is
 * (the Design Lead's (B) on #735's question (8): the band stands on the chrome-drawn pages once
 * this layer is there). The core is not told (`layout.pageOffset` is the desktop's seam: it
 * moves placed views, and a chrome page has none – `core/pages.ts`), and the layout report
 * never carries that pair: it is the layer's alone, the desktop's `seatBand`/`movePage` pair
 * untouched on Android, so no report lays a WebView out under a band or shifts one by it.
 *
 * Both surfaces keep the desktop seam's contract (`PageBandHost`, `lib/pageBand.ts`): a travel
 * TRANSLATES, the rest SEATS. `depart` seats the band at the lesser of its seat and the
 * destination before a travel's first frame, the frames write the offset, and `rest` seats the
 * band at its height – the surface's box inset by it with no transform, so a long page
 * (Settings, History, a document) scrolls to its last line above the frame's bottom instead of
 * leaving it under the band (the Design Lead's check on #758, ruled for documents too). A
 * finger's drag announces no destination (`BandSeam.depart`): its first frame below the seat
 * unseats the surface here, so the page's bottom rides past the frame's edge under the finger
 * and never bares it – the one layout the drag costs, where the desktop keeps the seat and bares
 * the strip. The chrome's layer reads its seat from the chrome page's seat store (`top: seat`,
 * `translateY(offset − seat)`); a DOCUMENT's seat goes down a channel of its own beside the pull
 * channel (`lib/band/seat.ts` → the bridge's `view.setBandSeat` → `TabHost.setBandSeat`):
 * Kotlin places the WebView at top = seat, height = frame − seat, and translates it by the pull
 * channel's offset less the seat (`PageSeat.kt`) – the offset still travels the pull channel
 * whole, so a pull's takeover and the classifier's reading are as they were, and the one
 * message that changes the seat changes the layout and the translation together, so no frame
 * shows the page anywhere but where it was. The seat is written only for the surface in front
 * and held; a pull that takes the page over (`displaced`) has the seat written 0 before its
 * first frame and owns the whole displacement. A surface change puts the old surface home
 * (seat 0 first, then offset 0) in the same synchronous subscriber that re-targets the standing
 * band onto the new one (its offset, then its seat) – seated if the band rests, translated if
 * it travels.
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
   * A travel toward `to` begins (0 for a leave): the band is seated at the lesser of its seat
   * and the destination before the first frame, as the desktop host seats it (`PageBandHost`).
   */
  depart(to: number): void
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
  /** The chrome's layer is translated or seated (a frame above 0 written to the offset store). */
  let layerHeld = false
  let offset = 0
  /**
   * The band's seat as the desktop seats it (`PageBandHost`): the height it rests at, the
   * lesser of that and the destination through a travel, 0 shut. Published to the chrome page's
   * seat store while the chrome's layer is the surface in front, and down the seat channel for
   * a WebView the host holds (`publishSeat`).
   */
  let seat = 0
  /** The document the seat channel last carried a seat above 0 for, with that seat (written on change alone). */
  let seated: { tabId: string; seat: number } | null = null
  /** A `depart` was heard and no `rest` yet: the frames are a travel's, not a finger's. */
  let travelling = false

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

  /**
   * The chrome page's seat store carries the band's seat for the chrome's layer alone, and
   * only while the band has the layer (a frame above 0 written); a document in front, or a
   * layer no band stands on, reads 0. The seat channel carries it for the document in front
   * while the host holds its page (a frame above 0 accepted), written when it changes: 0 to a
   * document that was seated and is no longer, the seat to the one that is. The desktop's pair
   * (`seatBand`), the layout report's, is never written here.
   */
  const publishSeat = (): void => {
    seatChromePage(front?.layer && layerHeld ? seat : 0)
    const doc = front !== null && !front.layer && held === front.tabId && seat > 0 ? front.tabId : null
    if (seated !== null && seated.tabId !== doc) seatDocument(seated.tabId, 0)
    if (doc !== null && (seated?.tabId !== doc || seated.seat !== seat)) seatDocument(doc, seat)
    seated = doc === null ? null : { tabId: doc, seat }
  }

  /**
   * `surface` gives its seat up ahead of a write that moves it home: the layer's store reads 0,
   * a seated WebView is placed as reported – translated by the offset it still has, the same
   * picture – before its offset follows. The other way round a WebView would stand a seat
   * above its frame for any frame that fell between the two.
   */
  const unseat = (surface: Surface): void => {
    if (surface.layer) {
      seatChromePage(0)
      return
    }
    if (seated === null || seated.tabId !== surface.tabId) return
    seatDocument(surface.tabId, 0)
    seated = null
  }

  /** Whether a frame moves `surface`: the band holds it already, or a band stands on it (its entrance). */
  const holds = (surface: Surface): boolean => (surface.layer ? layerHeld : held === surface.tabId)

  const home = (): void => {
    seat = 0
    if (seated !== null) unseat({ tabId: seated.tabId, layer: false })
    if (layerHeld) write({ tabId: front?.tabId ?? '', layer: true }, 0)
    if (held !== null) write({ tabId: held, layer: false }, 0)
    publishSeat()
  }

  const hold: PageHold = {
    displaced: (tabId) => {
      if (held === tabId) held = null
      // The pull has the page from where it sits, whole: the seat the layout carried goes back
      // to the translation before the pull's first frame (the same picture), or the pull's
      // return home would carry the view a seat above its frame.
      publishSeat()
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
    // The surface leaving the front comes home at once – its seat first (the layer's seat store
    // reads 0, a seated WebView is placed as reported, before the one arriving is written to),
    // then its offset; the one arriving takes the standing band's offset, and its seat with it
    // (seated where the band rests, translated while it travels). A page changing kind under
    // the band (the new tab page navigating to a web page) is a leave and an arrival on the
    // same tab.
    if (front !== null) unseat(front)
    if (front !== null && holds(front)) write(front, 0)
    front = next
    if (front !== null && offset > 0 && shownBand() !== null) write(front, offset)
    publishSeat()
  })

  return {
    get offset() {
      return offset
    },
    depart: (to) => {
      // The desktop's seat before a travel's first frame: the lesser of the seat and the
      // destination, so the surface's bottom rides past the frame's edge while it travels (a
      // WebView unseated here keeps its place: the seat it gives up goes to its translation).
      travelling = true
      seat = Math.min(seat, to)
      publishSeat()
    },
    translate: (x) => {
      offset = Math.max(0, x)
      // A frame below the seat with no travel announced is a finger's: the surface is unseated
      // for the drag (translated from here on), so the page keeps covering the frame under it.
      if (!travelling && offset < seat) {
        seat = 0
        publishSeat()
      }
      if (front === null) return
      // A frame moves the page the band holds, or the page a band stands on (its entrance);
      // a leave after a tab switch – the band gone from the new page – moves nothing.
      if (!holds(front) && shownBand() === null) return
      write(front, offset)
    },
    rest: (height) => {
      travelling = false
      // At rest the band is seated at its height: the surface in front is laid out under it
      // (its box inset, no transform – the chrome's layer by its store, the WebView by Kotlin's
      // placement), as the desktop lays the page out once per travel. At 0 everything is home
      // and the hold is let go (the pull is free to take the page).
      if (height === 0) {
        home()
        return
      }
      seat = height
      publishSeat()
    },
    paint: () => {
      // The band's content writes its own opacity; the page's chrome has nothing to paint.
    },
    release: () => {
      travelling = false
      home()
      off()
      setPageHold(null)
      setBandFrame({ front: null, ok: false })
    }
  }
}
