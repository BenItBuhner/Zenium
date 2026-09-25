import type { Tab } from '@shared/types'
import { READER_URL_PREFIX } from '@shared/url'

/*
 * The reader entry's offer on the phone (PUI-14; v2 §9.33): when an article page has loaded and
 * the reader core's probe says it reads (`tab.readerable`, decided at the document's dom-ready by
 * `core/reader.ts` – services' extraction, consumed here and never re-run), the chrome offers
 * Reader View on a §9.33 banner – the sentence and one action – and remembers a refusal the way
 * Chrome's `ReaderModeManager` does: a message dismissed by anything but its action MUTES THE
 * SITE (its host) for the rest of the session, so the same site never asks twice; the action
 * un-mutes it (Chrome's `removeUrlFromMutedSites` on activation); the record is capped at a
 * hundred hosts, the oldest forgotten first (`MAX_SIZE_OF_DECLINED_SITES`). Chrome keys the set
 * by the host's hash; the host itself serves here. This module is the rule, pure and testable;
 * `lib/readerEntryMessage.ts` shows the banner from it.
 */

/** The banner's words: the sentence as its title, the one action's label (gate question (a)). */
export const READER_ENTRY_TITLE = 'Show Reader View?'
export const READER_ENTRY_ACTION = 'Show'

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
export function readerArticleTab(tab: Pick<Tab, 'url' | 'readerable' | 'discarded'> | null): boolean {
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
