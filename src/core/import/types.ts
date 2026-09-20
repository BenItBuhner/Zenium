import type { HistoryTransition } from '../../shared/types'
import type { NetscapeBookmark, NetscapeFolder, NetscapeItem } from '../../shared/netscape'
import type { ImportRow } from '../credentials/store'
import type { ImportedVisit as HistoryImportedVisit } from '../history'

/**
 * The neutral shapes every importer produces, whatever browser it read. Bookmarks reuse the
 * Netscape document's tree (folders flagged as the source's toolbar / unfiled root, URLs with
 * their add dates) so one planner (`planNetscapeImport`) files them all the way Chrome does.
 */

export type ImportedBookmarkItem = NetscapeItem
export type ImportedFolder = NetscapeFolder
export type ImportedBookmark = NetscapeBookmark

export interface ImportedBookmarks {
  items: ImportedBookmarkItem[]
  /** Entries left out: separators, `place:` queries, unparseable rows. */
  skipped: number
}

/**
 * One page visit of another browser's history, ready for `history.importVisits`: the history
 * model's shape with the title (empty when the source had none) and the transition always set.
 */
export interface ImportedVisit extends HistoryImportedVisit {
  url: string
  title: string
  /** Milliseconds since the epoch. */
  at: number
  transition: HistoryTransition
}

export interface ImportedVisits {
  visits: ImportedVisit[]
  /** Rows left out: subframes, downloads, hidden pages, dates that did not parse. */
  skipped: number
}

/** A login read from another browser, in the credential store's import shape. */
export type ImportedLogin = ImportRow

export interface ImportedLogins {
  logins: ImportedLogin[]
  /** Rows whose password could not be decrypted (no keyring secret, an unknown scheme). */
  unreadable: number
  /** Rows without a usable origin or password, and never-save entries. */
  invalid: number
}

export function folder(
  title: string,
  children: ImportedBookmarkItem[],
  flags: { toolbar?: boolean; unfiled?: boolean; addDate?: number; lastModified?: number } = {}
): ImportedFolder {
  const node: ImportedFolder = {
    type: 'folder',
    title,
    toolbar: flags.toolbar === true,
    unfiled: flags.unfiled === true,
    children
  }
  if (flags.addDate !== undefined) node.addDate = flags.addDate
  if (flags.lastModified !== undefined) node.lastModified = flags.lastModified
  return node
}

export function bookmark(
  title: string,
  url: string,
  dates: { addDate?: number; lastModified?: number } = {},
  icon?: string
): ImportedBookmark {
  const node: ImportedBookmark = { type: 'url', title: title || url, url }
  if (dates.addDate !== undefined) node.addDate = dates.addDate
  if (dates.lastModified !== undefined) node.lastModified = dates.lastModified
  if (icon) node.icon = icon
  return node
}

/** URLs no import brings in: scripts, browser pages, Firefox's saved searches. */
export function isImportableUrl(url: string): boolean {
  return /^(https?|ftp|file):\/\//i.test(url) && url.length <= 8192
}

/**
 * Drop URL entries seen earlier in the same tree (depth first, in order), the way the dialog's
 * counts describe them: duplicates by URL within one import are skipped. Folders stay, empty or not.
 */
export function dedupeByUrl(items: ImportedBookmarkItem[]): {
  items: ImportedBookmarkItem[]
  duplicates: number
  bookmarks: number
} {
  const seen = new Set<string>()
  let duplicates = 0
  let bookmarks = 0
  const walk = (list: ImportedBookmarkItem[]): ImportedBookmarkItem[] => {
    const out: ImportedBookmarkItem[] = []
    for (const item of list) {
      if (item.type === 'folder') {
        out.push({ ...item, children: walk(item.children) })
        continue
      }
      if (seen.has(item.url)) {
        duplicates += 1
        continue
      }
      seen.add(item.url)
      bookmarks += 1
      out.push(item)
    }
    return out
  }
  return { items: walk(items), duplicates, bookmarks }
}

export function countBookmarks(items: ImportedBookmarkItem[]): number {
  let n = 0
  for (const item of items) n += item.type === 'folder' ? countBookmarks(item.children) : 1
  return n
}
