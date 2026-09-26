/**
 * The custom tab's bookmark inbox, drained into the browser's bookmarks.
 *
 * A custom tab (`CustomTabActivity.kt`) runs without the core: its star files the page into
 * `bookmarks-inbox.json` (`CustomTabBookmarks.kt`, `{"version":1,"entries":[{url,title,at}]}`)
 * and reads back as "Remove Bookmark" from that inbox until the browser has made the bookmark;
 * a second press before then withdraws the entry, and the inbox never sees it. This module is
 * the browser's half: once the core is up (a startup sweep, off the boot path) and whenever the
 * app comes back to the front (a custom tab in front was the one writing), the inbox is read
 * from the disk – never a mirror, the writer is another activity (`storeIo.ts`); off the main
 * thread, so a return to the front pays no bridge hop for it – and every entry whose URL the
 * tree does not hold is created through the core's public `bookmark.create` command, into the
 * star's default folder, in filing order (`at`). The URLs of the entries read are then emptied
 * from a fresh read of the inbox, so an entry filed meanwhile stays; the custom tab's star reads
 * "Edit Bookmark" from the browser's store on its next open.
 *
 * Idempotent: the tree is asked before each create, so a pass cut short between its creates and
 * its emptying (the process killed) makes no second bookmark on the next pass, which only
 * empties. An entry the tree already held (starred in the browser and filed in the custom tab
 * both) creates nothing and is emptied too. Two entries of one URL make one bookmark.
 */

/** The inbox document, as `CustomTabBookmarks.INBOX` names it; a root document of the profile. */
export const BOOKMARKS_INBOX_FILE = 'bookmarks-inbox.json'

/** A filed page, as the custom tab wrote it. */
export interface InboxEntry {
  url: string
  title: string
  /** When it was filed (epoch milliseconds); the drain creates in this order. */
  at: number
}

/** What the drain reaches for: the inbox on the disk, and the core's bookmarks. */
export interface InboxDrainHost {
  /**
   * The inbox's text, fresh from the disk – read off the main thread where the host can
   * (`AndroidStoreIO.read`), so the caller's turn is not held for it; null when there is no
   * such document.
   */
  readInbox(): Promise<string | null>
  /** Replace the inbox's text. */
  writeInbox(text: string): Promise<void>
  /** Whether the tree holds a bookmark of this exact URL (`browser.bookmarks.has`). */
  has(url: string): boolean
  /** Create the bookmark through the core's public command; whether the core made it. */
  create(entry: InboxEntry): boolean
}

/** The inbox's entries; a malformed document, or one without entries, reads as none. */
export function parseInbox(text: string | null): InboxEntry[] {
  if (!text) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const { entries } = parsed as { entries?: unknown }
  if (!Array.isArray(entries)) return []
  const out: InboxEntry[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const { url, title, at } = entry as { url?: unknown; title?: unknown; at?: unknown }
    // As `CustomTabBookmarks.entries` reads it: an entry without a URL is not one.
    if (typeof url !== 'string' || url === '') continue
    out.push({
      url,
      title: typeof title === 'string' ? title : '',
      at: typeof at === 'number' && Number.isFinite(at) ? at : 0
    })
  }
  return out
}

/** The inbox's text for these entries, in the shape `CustomTabBookmarks.serialize` writes. */
export function serializeInbox(entries: readonly InboxEntry[]): string {
  return JSON.stringify({
    version: 1,
    entries: entries.map(({ url, title, at }) => ({ url, title, at }))
  })
}

/**
 * The entries to create, in filing order: one per URL (the first filed), none the tree holds.
 * `has` is the tree's word on a URL; it is asked once per distinct URL.
 */
export function planDrain(
  entries: readonly InboxEntry[],
  has: (url: string) => boolean
): InboxEntry[] {
  // A stable sort: entries filed in the same millisecond keep the file's order.
  const ordered = entries.map((entry, i) => ({ entry, i }))
  ordered.sort((a, b) => a.entry.at - b.entry.at || a.i - b.i)
  const seen = new Set<string>()
  const planned: InboxEntry[] = []
  for (const { entry } of ordered) {
    if (seen.has(entry.url)) continue
    seen.add(entry.url)
    if (has(entry.url)) continue
    planned.push(entry)
  }
  return planned
}

/**
 * The inbox after a pass: `current` (a fresh read, taken after the creates) less every entry of
 * a URL the pass read (`drained`). Null when nothing is to be written – the pass read nothing
 * still there.
 */
export function drainedInbox(
  current: readonly InboxEntry[],
  drained: ReadonlySet<string>
): InboxEntry[] | null {
  const kept = current.filter((entry) => !drained.has(entry.url))
  return kept.length === current.length ? null : kept
}

/**
 * The drain itself: one pass at a time, and a request made while a pass runs has one more pass
 * follow it (the inbox may have changed under the first). The returned promise settles when the
 * requested pass – and the one it may have been folded into – is done.
 */
export class BookmarkInboxDrain {
  private running: Promise<void> | null = null
  private again = false

  constructor(private readonly host: InboxDrainHost) {}

  request(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    // The pass over, the one asked for meanwhile follows; a pass that failed (the host could
    // not write) still lets it, and the failure is the requester's to hear of.
    const settle = (): Promise<void> => {
      this.running = null
      if (!this.again) return Promise.resolve()
      this.again = false
      return this.request()
    }
    this.running = this.pass().then(settle, (error: unknown) =>
      settle().then(() => {
        throw error
      })
    )
    return this.running
  }

  private async pass(): Promise<void> {
    const read = parseInbox(await this.host.readInbox())
    if (read.length === 0) return
    for (const entry of planDrain(read, (url) => this.host.has(url))) {
      if (!this.host.create(entry)) {
        console.warn(`[zen] the core refused a bookmark the custom tab filed: ${entry.url}`)
      }
    }
    // Emptied from the inbox as it is now, not as it was read: an entry filed since stays.
    const drained = new Set(read.map((entry) => entry.url))
    const kept = drainedInbox(parseInbox(await this.host.readInbox()), drained)
    if (kept !== null) await this.host.writeInbox(serializeInbox(kept))
  }
}
