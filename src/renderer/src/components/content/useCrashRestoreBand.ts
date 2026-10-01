import { useEffect } from 'react'
import { TriangleAlert } from 'lucide-react'
import type { CrashRestoreOffer, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { dismissBandByKey, showBand } from '@renderer/lib/band'

export const CRASH_RESTORE_BAND_KEY = 'crash-restore'

/** "Restore 3 pages in 2 windows?" – the strip's count, its singular kept, the window unsaid when one. */
export function crashRestoreQuestion(offer: CrashRestoreOffer): string {
  const pages = offer.tabCount === 1 ? '1 page' : `${offer.tabCount} pages`
  const where = offer.windowCount > 1 ? ` in ${offer.windowCount} windows` : ''
  return `Restore ${pages}${where}?`
}

/**
 * "Restore pages?" after a run that did not shut down cleanly (Chrome's bubble) as the page-edge
 * band's second desktop tenant (motion spec §3.4; the Design Lead's ruling on item 8): a STATE
 * about the browser – the core holds the last session's pages unloaded until the user answers
 * (`UIState.crashRestore`, `SessionService`) – that stands on every page tab of the window, the
 * new tab page included. Its words are the strip's, on the band's two lines in Chrome's order:
 * the question for the title ("Restore 3 pages in 2 windows?", the count and the windows as the
 * strip said them), "Zenium did not shut down correctly." for the detail. The glyph is the alert
 * in the warn ink: the state is a fault, not an offer. The action is "Restore" – it loads the
 * pages that were showing, as the strip's Restore did – and the × is "Dismiss", the strip's
 * Dismiss: a fresh tab, the last session's tabs kept in the sidebar unloaded. The band's own
 * put-aways – a swipe up, Escape, Android's Back – answer as the × does: the state is an answer
 * the session waits on, with nothing remembered beyond it (the next unclean exit asks again),
 * and a band put away unanswered would leave the frame empty and held with no way to the
 * question but another window. The band going for any other reason (the window closing, the
 * offer answered elsewhere) answers nothing: the state stands for the next window. Confirmed
 * by the Design Lead's gate on #754 (§10): the title and detail split and order, the counted
 * title, the alert glyph in the warn ink on the frame's own fill, and the put-aways as the ×.
 *
 * DESKTOP-GATED. This tenant is mounted by the desktop's `PageBandHost` alone and never by
 * Android's band host (#735): the hold is the desktop's – Android's runs end by a kill, their
 * pages just come back, and the core raises no offer there (`platform !== 'android'` in the
 * startup path). It is not to be lifted into a shared tenant without a Lead ruling.
 *
 * The strip across the frame's top (`.zen-frame-strip`, `CrashRestoreBanner.tsx`) retired to
 * this band in W8-M3; the ask / always / never setting still decides whether there is an offer.
 */
export function useCrashRestoreBand(state: UIState): void {
  // The offer by its counts, not its identity: the core's state object is new on every commit.
  const offer = state.crashRestore ?? null
  const offered = offer !== null
  const tabCount = offer?.tabCount ?? 0
  const windowCount = offer?.windowCount ?? 0
  useEffect(() => {
    if (!offered) return
    showBand({
      key: CRASH_RESTORE_BAND_KEY,
      form: 'state',
      icon: TriangleAlert,
      tone: 'warn',
      title: crashRestoreQuestion({ tabCount, windowCount }),
      detail: 'Zenium did not shut down correctly.',
      action: { label: 'Restore', onPick: () => run('session.crashRestore', { restore: true }) },
      onDismiss: (reason) => {
        if (reason === 'close' || reason === 'escape' || reason === 'swipe' || reason === 'back')
          run('session.crashRestore', { restore: false })
      }
    })
    return () => dismissBandByKey(CRASH_RESTORE_BAND_KEY)
  }, [offered, tabCount, windowCount])
}
