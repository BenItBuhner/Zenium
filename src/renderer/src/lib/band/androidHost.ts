import { bandStore, chooseBand, dismissBand, setBandFront, shownBand } from '@renderer/lib/band'
import type { BandSeam } from '@renderer/lib/motion/band'
import { holdPage, setPageHold, type PageHold } from '@renderer/lib/pull'
import { bandMayShow, subscribeBandSignals } from './signals'

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
 * where it sits – the model hears the frame is not the band's (`pulling` → not eligible), the
 * shown offer is taken down as the chrome's doing (`program`: no tenant counts it as the user's
 * refusal), and a state waits for the pull to end and returns on its own entrance. No per-frame
 * work of the host's own: the driver calls {@link BandSeam.translate} per frame, the stores
 * publish at rest.
 *
 * The page the band stands on is the front tab's. A tab leaving the front with its page held
 * has it put home at once – a view in the back must not keep its translation for its return –
 * and the page coming to the front is put where the band stands if the band stands on it (a
 * window-wide band stands on every page tab, §3.2); a leave the model asks for after the switch
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

/**
 * The one Android host; the touch shell creates it when the band's layer mounts and
 * {@link AndroidBandHost.release releases} it when the layer goes.
 */
export function createAndroidBandHost(): AndroidBandHost {
  let front: string | null = null
  /** The tab whose page the host holds translated (an accepted frame above 0). */
  let held: string | null = null
  let offset = 0

  const write = (tabId: string, x: number): boolean => {
    if (!holdPage(tabId, x)) return false
    if (x > 0) held = tabId
    else if (held === tabId) held = null
    return true
  }

  const hold: PageHold = {
    displaced: (tabId) => {
      if (held === tabId) held = null
      // §3.4 Android: a pull while a band stands dismisses the band first – an offer goes (not
      // the user's answer: `program`); a state holds and waits for the pull to end. The pull
      // has already told the model the frame is not the band's, so the band that stood is read
      // as if it were.
      const stood = chooseBand({ ...bandStore.get(), eligible: true })
      if (stood?.form === 'offer') dismissBand(stood.id, 'program')
    }
  }
  setPageHold(hold)

  const off = subscribeBandSignals((signals) => {
    // The model first: it decides whether a band stands on the page coming to the front.
    setBandFront(signals.tabId, bandMayShow(signals, 'state'))
    if (signals.tabId === front) return
    if (front !== null && held === front) write(front, 0)
    front = signals.tabId
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
      if (held !== front && shownBand() === null) return
      write(front, offset)
    },
    rest: (height) => {
      // Android lays nothing out at rest: the page stays where the hold has it. At 0 the hold
      // is let go (the page is home; the pull is free to take it).
      if (height === 0 && held !== null) write(held, 0)
    },
    paint: () => {
      // The band's content writes its own opacity; the page's chrome has nothing to paint.
    },
    release: () => {
      if (held !== null) write(held, 0)
      off()
      setPageHold(null)
      setBandFront(null, false)
    }
  }
}
