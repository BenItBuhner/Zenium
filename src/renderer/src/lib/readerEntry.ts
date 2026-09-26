import type { Tab } from '@shared/types'
import { READER_URL_PREFIX, readerSourceUrl } from '@shared/url'

/*
 * The reader entry's offer on the phone (PUI-14; v2 §9.33): when an article page has loaded and
 * the reader core's probe says it reads (`tab.readerable`, decided at the document's dom-ready by
 * `core/reader.ts` – services' extraction, consumed here and never re-run), the chrome offers
 * Reader View on a §9.33 banner – the sentence and one action – and remembers a refusal the way
 * Chrome's `ReaderModeManager` does: a message dismissed by anything but its action MUTES THE
 * SITE (its host) for the rest of the session, so the same site never asks twice; the action
 * un-mutes it (Chrome's `removeUrlFromMutedSites` on activation); the record is capped at a
 * hundred hosts, the oldest forgotten first (`MAX_SIZE_OF_DECLINED_SITES`). Chrome keys the set
 * by the host's hash; the host itself serves here. The offer stands on Chrome's clock too: an
 * offer banner – information the user did not ask for – leaves on its own after about ten
 * seconds (§9.33 as amended on the design gate for PUI-14), and the timeout is a refusal
 * remembered for the site this session exactly as the X and a swipe are, since a reader who has
 * read that long has answered. This module is the rule, pure and testable;
 * `lib/readerEntryMessage.ts` shows the banner from it.
 */

/** The banner's words: the sentence as its title, the one action's label (gate question (a)). */
export const READER_ENTRY_TITLE = 'Show Reader View?'
export const READER_ENTRY_ACTION = 'Show'

/**
 * How long the offer stands unanswered before it leaves on its own (§9.33 as amended: "about
 * 10 s" – the Messages autodismiss Chrome's reader message stands on, `TIMER` being one of the
 * dismissals `ReaderModeManager.onMessageDismissed` mutes for). The §9.33 host runs the clock:
 * armed as the banner is shown – its paint follows on the next frame – paused while a finger or
 * pointer holds the card and resumed with at least a second left on its release (`lib/ui.ts`
 * `holdBanner`), and its running out is the `timeout` end below. Motion has no part in it: the
 * clock runs the same under reduced motion.
 */
export const READER_ENTRY_CLOCK_MS = 10_000

/** Chrome's cap on the declined-sites record (`ReaderModeManager.MAX_SIZE_OF_DECLINED_SITES`). */
export const READER_MUTE_CAP = 100

/** The site a page belongs to for the mute record: its host, lower-cased; null for a URL without one. */
export function readerSiteOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host.length > 0 ? host : null
  } catch {
    return null
  }
}

/**
 * The session's muted sites in Chrome's shape: insertion-ordered, capped, the oldest dropped
 * when the cap is passed; a site muted again moves nothing (a set), as Chrome's does.
 */
export class ReaderMuteRecord {
  private readonly hosts = new Set<string>()

  constructor(private readonly cap = READER_MUTE_CAP) {}

  has(site: string | null): boolean {
    return site !== null && this.hosts.has(site)
  }

  mute(site: string | null): void {
    if (site === null) return
    this.hosts.add(site)
    while (this.hosts.size > this.cap) {
      const oldest = this.hosts.values().next().value
      if (oldest === undefined) break
      this.hosts.delete(oldest)
    }
  }

  unmute(site: string | null): void {
    if (site !== null) this.hosts.delete(site)
  }

  get size(): number {
    return this.hosts.size
  }

  clear(): void {
    this.hosts.clear()
  }
}

/** Whether the tab's page is one Reader View could be offered for at all: a web page the probe read as an article. */
export function readerArticleTab(
  tab: Pick<Tab, 'url' | 'readerable' | 'discarded'> | null
): boolean {
  return (
    tab !== null &&
    tab.readerable &&
    !tab.discarded &&
    /^https?:/i.test(tab.url) &&
    !tab.url.startsWith(READER_URL_PREFIX)
  )
}

/**
 * The offer due for a tab, or null: an article page whose site the session has not muted. The
 * caller adds what the shell knows (onboarding, a page's fullscreen, the private lock) and
 * shows one banner per document: the `key` on the banner de-duplicates, the tab's URL in the
 * effect's dependencies takes it down on navigation (Chrome's `MessageScopeType.NAVIGATION`).
 */
export function readerOfferFor(
  tab: Pick<Tab, 'url' | 'readerable' | 'discarded'> | null,
  muted: Pick<ReaderMuteRecord, 'has'>
): { site: string } | null {
  if (!readerArticleTab(tab)) return null
  const site = readerSiteOf(tab!.url)
  if (site === null || muted.has(site)) return null
  return { site }
}

/**
 * How an offer ended, in the banner host's words (`BannerDismissReason`) plus what the shell
 * knows of a `program` end: `movedOn` says the page was left – a navigation, another tab in
 * front, the tab closed – while the offer stood, as against a gate closing over it (a page's
 * fullscreen, the private lock, onboarding), which is no answer; `toReader` says the page was
 * left FOR Reader View on itself – the app menu's row, the site-information sheet's, the page
 * menu's – which is the offer accepted by another door.
 */
export interface ReaderOfferEnd {
  reason: 'action' | 'swipe' | 'close' | 'timeout' | 'replaced' | 'program'
  movedOn?: boolean
  toReader?: boolean
}

/**
 * Whether `next` is Reader View on the offer's own page – the reader URL naming `page` (its
 * fragment aside, as a footnote's hash is the same document) as the page it stands in for.
 */
export function readerOfOffer(page: string, next: string): boolean {
  const source = readerSourceUrl(next)
  return source !== null && withoutFragment(source) === withoutFragment(page)
}

function withoutFragment(url: string): string {
  const hash = url.indexOf('#')
  return hash === -1 ? url : url.slice(0, hash)
}

/**
 * What an offer's end does to the site's mute: Chrome's `onMessageDismissed` mutes the host on
 * EVERY dismissal but the primary action – the gesture, the timer, the scope destroyed by a
 * navigation or the tab's going – and the action un-mutes it (`removeUrlFromMutedSites`). Here
 * the same, read through the §9.33 host's reasons: the swipe, the X and the clock running out
 * ({@link READER_ENTRY_CLOCK_MS}; §9.33 as amended – a reader who has read that long has
 * answered) mute; the action un-mutes; a `program` end mutes when the page was left with the
 * offer standing and not when a gate closed over it – and un-mutes, as the action does, when
 * the page was left for Reader View on itself (`toReader`): the offer answered by another door
 * is no refusal; `replaced` – a third banner pushing this one off the stack – is the chrome's
 * doing, not the user's, and changes nothing.
 */
export function readerOfferEndEffect(end: ReaderOfferEnd): 'mute' | 'unmute' | 'none' {
  switch (end.reason) {
    case 'action':
      return 'unmute'
    case 'swipe':
    case 'close':
    case 'timeout':
      return 'mute'
    case 'program':
      if (end.toReader) return 'unmute'
      return end.movedOn ? 'mute' : 'none'
    case 'replaced':
      return 'none'
  }
}
