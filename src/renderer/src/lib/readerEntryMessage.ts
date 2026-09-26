import { useEffect, useRef } from 'react'
import { BookOpenText } from 'lucide-react'
import type { Tab } from '@shared/types'
import { crossReaderView } from '@renderer/lib/readerTransition'
import { dismissBanner, showBanner } from '@renderer/lib/ui'
import {
  READER_ENTRY_ACTION,
  READER_ENTRY_CLOCK_MS,
  READER_ENTRY_TITLE,
  ReaderMuteRecord,
  readerOfOffer,
  readerOfferEndEffect,
  readerOfferFor
} from './readerEntry'

/**
 * The session's muted sites (Chrome's `sMutedSites`, a static): one record for the chrome's
 * life, whichever shell is up – a site refused in the phone layout stays refused after a
 * rotation into the tablet's.
 */
export const readerMutes = new ReaderMuteRecord()

/** The banner's `key`: one reader offer on the stack at a time; a new page's replaces the old. */
export const READER_BANNER_KEY = 'reader'

/** The offer on the stack, and whether it is still waiting for an answer. */
interface Standing {
  id: number
  site: string
  tabId: string
  /** The page the offer was made on, without its fragment: a footnote's hash is the same document. */
  document: string
  live: boolean
}

/** The URL without its fragment: the document a navigation lands on, a hash jump inside it aside. */
function documentOf(url: string): string {
  const hash = url.indexOf('#')
  return hash === -1 ? url : url.slice(0, hash)
}

/**
 * The reader entry's offer (PUI-14; v2 §9.33): an article page in front – the reader core's
 * probe said so at its dom-ready (`tab.readerable`) – puts "Show Reader View?" with its one
 * action on the banner stack at the frame's top, the same §9.33 host the connectivity and
 * default-browser banners use, on the phone and the tablet alike. The action opens Reader View
 * for the tab – through the crossing where it runs, the core's plain `reader.toggle` elsewhere
 * (`crossReaderView`, MOT-36); a swipe or the X refuses it; so does the clock running out – the
 * offer stands about ten seconds (`READER_ENTRY_CLOCK_MS`, the host's clock: armed at the show,
 * paused under a finger) and leaves on its own, §9.33 as amended; and a refusal
 * is remembered per SITE for the session, Chrome's `ReaderModeManager` rule read through the
 * host's dismiss reasons (`readerOfferEndEffect`): every end but the action mutes the host –
 * the timeout and leaving the page with the offer standing included, Chrome's timer and scope
 * destroyed – and the action un-mutes it, as does Reader View entered by another door while the
 * offer stood (the app menu's row, the site-information sheet's). `enabled` is what the shell
 * knows the offer must wait behind (onboarding, a page's fullscreen, the private lock): a gate
 * closing over the page takes the banner down without an answer, and it comes back with the
 * gate's lifting.
 */
export function useReaderEntryMessage(tab: Tab | null, enabled: boolean): void {
  const tabId = tab?.id ?? null
  const document = tab ? documentOf(tab.url) : null
  const site = enabled ? (readerOfferFor(tab, readerMutes)?.site ?? null) : null
  const standing = useRef<Standing | null>(null)
  useEffect(() => {
    // An offer still up as the deps change was left unanswered: the page was left (another
    // document, another tab, the tab gone) and Chrome mutes the site as for a swipe; a gate
    // closing over the same page is no answer and changes nothing; the same tab gone INTO
    // Reader View on the page is the offer taken, by another door, and un-mutes as the action.
    const before = standing.current
    if (before) {
      standing.current = null
      if (before.live) {
        const movedOn = before.tabId !== tabId || before.document !== document
        const toReader =
          before.tabId === tabId && document !== null && readerOfOffer(before.document, document)
        const effect = readerOfferEndEffect({ reason: 'program', movedOn, toReader })
        if (effect === 'mute') readerMutes.mute(before.site)
        else if (effect === 'unmute') readerMutes.unmute(before.site)
      }
    }
    if (site === null || tabId === null || document === null) return undefined
    const current: Standing = { id: 0, site, tabId, document, live: true }
    current.id = showBanner({
      title: READER_ENTRY_TITLE,
      icon: BookOpenText,
      key: READER_BANNER_KEY,
      duration: READER_ENTRY_CLOCK_MS,
      action: {
        label: READER_ENTRY_ACTION,
        onPick: () => void crossReaderView(tabId)
      },
      onDismiss: (reason) => {
        // The effect's own take-down (`program`) is judged above, where the shell knows why.
        if (reason === 'program') return
        current.live = false
        const effect = readerOfferEndEffect({ reason })
        if (effect === 'mute') readerMutes.mute(site)
        else if (effect === 'unmute') readerMutes.unmute(site)
      }
    })
    standing.current = current
    return () => dismissBanner(current.id)
  }, [site, tabId, document])
}
