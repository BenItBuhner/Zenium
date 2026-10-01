import {
  heldPageOffset,
  holdPage,
  pageHeldByPull,
  setPageHold,
  type PageHold
} from '@renderer/lib/pull'
import { bandSignals, subscribeBandSignals, type BandSignals } from './signals'

/**
 * The page-edge band's host on Android (motion spec §3.4 Android): the seam the band's shared
 * model drives, implemented over the pull-to-refresh channel. The band's spring writes the
 * page's offset here; it travels the one channel the pull uses (`lib/pull.ts` → the bridge's
 * `view.setPullOffset` → `Host.kt` → `TabWebView.setPullOffset`), so Kotlin moves the page the
 * same way for both and one source has it at a time: a hold is refused while a pull has the
 * page, and a pull that begins on the held page takes it over where it sits – the band is
 * {@link BandHost.onDisplaced told} and lets go without the page moving. No per-frame work of
 * the host's own: the model's driver calls {@link BandHost.setOffset} per frame and the stores
 * publish at rest.
 */
export interface BandHost {
  /**
   * Put `tabId`'s page `offset` CSS px below the frame's top edge (0: home). False when the
   * page is not the band's to move right now – a pull has it, or another tab's page is held;
   * the band waits (`signals().pulling`, {@link BandHost.subscribe}).
   */
  setOffset(tabId: string, offset: number): boolean
  /** Where the band has `tabId`'s page right now (0 when it holds nothing of it). */
  offset(tabId: string): number
  /** The chrome around the page: the front tab, the page's kind, what stands over it. */
  signals(): BandSignals
  /** Hear the signals change (once at once with the current reading); returns the unsubscribe. */
  subscribe(listener: (signals: BandSignals) => void): () => void
  /**
   * A pull-to-refresh began on the held page and carries on from `offset`: the band lets go –
   * its content fades, its spring stops – and must not move the page. Returns the unsubscribe.
   */
  onDisplaced(listener: (tabId: string, offset: number) => void): () => void
  /**
   * The band left the host (unmounted): the page comes home at once and the host stops
   * listening. Not for a dismissal – the band's own spring brings the page home for those.
   */
  release(): void
}

/**
 * The one Android host. A tab leaving the front with its page held has the page put home at
 * once – a view in the back must not keep its translation for its return (the band comes back
 * on its own terms, §3.2) – whether or not the model asks for it.
 */
export function createAndroidBandHost(): BandHost {
  const displaced = new Set<(tabId: string, offset: number) => void>()
  const listeners = new Set<(signals: BandSignals) => void>()
  let held: string | null = null
  let front: string | null = null

  const hold: PageHold = {
    displaced: (tabId, offset) => {
      if (held === tabId) held = null
      for (const listener of displaced) listener(tabId, offset)
    }
  }
  setPageHold(hold)

  const setOffset = (tabId: string, offset: number): boolean => {
    const ok = holdPage(tabId, offset)
    if (ok) held = offset > 0 ? tabId : null
    return ok
  }

  // One reading of the signals for the host's own rule and every listener of the model's.
  const off = subscribeBandSignals((signals) => {
    if (signals.tabId !== front) {
      if (front !== null && held === front) setOffset(front, 0)
      front = signals.tabId
    }
    for (const listener of listeners) listener(signals)
  })

  return {
    setOffset,
    offset: (tabId) => heldPageOffset(tabId),
    signals: bandSignals,
    subscribe: (listener) => {
      listeners.add(listener)
      listener(bandSignals())
      return () => {
        listeners.delete(listener)
      }
    },
    onDisplaced: (listener) => {
      displaced.add(listener)
      return () => {
        displaced.delete(listener)
      }
    },
    release: () => {
      if (held !== null) setOffset(held, 0)
      off()
      listeners.clear()
      displaced.clear()
      setPageHold(null)
    }
  }
}

/** Whether a pull has the page right now (the band's driver waits before its first frame). */
export function pageBusy(): boolean {
  return pageHeldByPull()
}
