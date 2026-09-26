/**
 * The `automatic-downloads` site setting (PS-71), Chrome's `DownloadRequestLimiter`: a page may
 * start one download per user gesture without a word – the first one of a document is free as
 * well – and the next one without a gesture of its own asks the site's row: allowed sites go
 * on, blocked sites lose the transfer without a row, and a site with no answer asks the user
 * ("Allow <site> to download multiple files?", the permission prompt, whose answer the store
 * remembers for the site as Chrome's bubble does). The count is per tab and per site: another
 * site's document in the tab starts over, a same-site one carries the count (Chrome keeps the
 * state across same-origin navigations too).
 *
 * The gesture is the core's own activation clock (`PopupBlocker.activation`: trusted input from
 * the host's input pipeline and the page script, kept for `ACTIVATION_LIFESPAN_MS`), read
 * against the activation the last counted download spent: a click that starts three downloads
 * at once frees the first alone, as in Chrome, where the interaction resets the limiter to "one
 * more". A host's own gesture flag is not consulted – Chromium's `has_user_gesture` is true for
 * every request within the transient window, which would free the whole burst. Pure but for its
 * deps; unit-tested in `__tests__/downloadLimiter.test.ts`.
 */
import type { PermissionRequestDetails } from './permissions'
import type { ContentDefault } from '../shared/contentSettings'

export const AUTOMATIC_DOWNLOADS_PERMISSION = 'automatic-downloads'

/** What the limiter says of a transfer: go, drop it, or ask the user first. */
export type DownloadLimit = 'allow' | 'refuse' | 'ask'

export interface DownloadLimiterDeps {
  /** The page in `tabId` – its URL and, for a private tab, its container – or null for no such tab. */
  page(tabId: string): { url: string; privateContainerId?: string } | null
  /** When trusted input last reached the page in `tabId` (the activation clock); -Infinity for never. */
  activatedAt(tabId: string): number
  /** The site's `automatic-downloads` row as the store resolves it. */
  setting(url: string, details: PermissionRequestDetails): ContentDefault
  /** Ask the user (the permission prompt, remembered by the store); resolves whether allowed. */
  ask(url: string, details: PermissionRequestDetails): Promise<boolean>
}

/** A limiter's answer for one transfer, with the question ready to ask. */
export interface DownloadJudgement {
  limit: DownloadLimit
  ask: () => Promise<boolean>
}

interface TabDownloads {
  /** The permission site the count belongs to (null: a page without one). */
  site: string | null
  /** Downloads since the last gesture (or since the document, for its first). */
  count: number
  /** The activation the last counted download spent; a newer one frees one more. */
  gestureAt: number
}

export class DownloadLimiter {
  private readonly tabs = new Map<string, TabDownloads>()

  constructor(private readonly deps: DownloadLimiterDeps) {}

  /**
   * A new transfer from the page in `tabId` (resumes and retries never come here, as Chrome
   * always lets a resumption through). Null when there is no page to count against.
   */
  judge(tabId: string): DownloadJudgement | null {
    const page = this.deps.page(tabId)
    if (!page) return null
    const site = siteOf(page.url)
    let state = this.tabs.get(tabId)
    if (!state || state.site !== site) {
      state = { site, count: 0, gestureAt: -Infinity }
      this.tabs.set(tabId, state)
    }
    const activatedAt = this.deps.activatedAt(tabId)
    // Trusted input since the last download that counted: the interaction resets the limiter to
    // one more free download, as Chrome's does.
    if (activatedAt > state.gestureAt) {
      state.count = 0
      state.gestureAt = activatedAt
    }
    state.count++
    const details: PermissionRequestDetails = { tabId }
    if (page.privateContainerId) details.privateContainerId = page.privateContainerId
    const ask = (): Promise<boolean> => this.deps.ask(page.url, details)
    if (state.count <= 1) return { limit: 'allow', ask }
    const setting = this.deps.setting(page.url, details)
    if (setting === 'allow') return { limit: 'allow', ask }
    if (setting === 'deny') return { limit: 'refuse', ask }
    return { limit: 'ask', ask }
  }

  /** The tab closed: its count goes with it. */
  onTabGone(tabId: string): void {
    this.tabs.delete(tabId)
  }
}

function siteOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') return 'file://'
    return parsed.origin && parsed.origin !== 'null' ? parsed.origin : null
  } catch {
    return null
  }
}
