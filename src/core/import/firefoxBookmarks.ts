import type { ImportDatabase } from '../platform'
import { decodeMozLz4, isMozLz4 } from './mozlz4'
import { prTimeToEpochMs } from './time'
import {
  bookmark,
  folder,
  isImportableUrl,
  type ImportedBookmarkItem,
  type ImportedBookmarks
} from './types'

/**
 * Firefox's bookmarks: `moz_bookmarks` joined to `moz_places` in `places.sqlite`, or – when the
 * database cannot be read – the newest `bookmarkbackups/bookmarks-*.jsonlz4` Firefox writes on
 * its own. Both give the four roots (toolbar, menu, unfiled, mobile); Chrome's rule files the
 * toolbar as the bar and everything else as loose entries of Other bookmarks, mobile as a folder.
 */

const ROOT_GUIDS = {
  root: 'root________',
  toolbar: 'toolbar_____',
  menu: 'menu________',
  unfiled: 'unfiled_____',
  mobile: 'mobile______',
  tags: 'tags________'
} as const

const TYPE_BOOKMARK = 1
const TYPE_FOLDER = 2

interface Row {
  id: number
  type: number
  parent: number
  position: number
  title: string
  dateAdded: number | undefined
  lastModified: number | undefined
  guid: string
  url: string
}

export const FIREFOX_BOOKMARKS_SQL = `SELECT b.id AS id, b.type AS type, b.parent AS parent, b.position AS position,
  b.title AS title, b.dateAdded AS dateAdded, b.lastModified AS lastModified, b.guid AS guid, p.url AS url
FROM moz_bookmarks b LEFT JOIN moz_places p ON b.fk = p.id
ORDER BY b.parent, b.position, b.id`

function num(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function firefoxBookmarksFromPlaces(db: ImportDatabase, now: number = Date.now()): ImportedBookmarks {
  const rows: Row[] = db.all(FIREFOX_BOOKMARKS_SQL).map((r) => ({
    id: num(r.id),
    type: num(r.type),
    parent: num(r.parent),
    position: num(r.position),
    title: str(r.title),
    dateAdded: prTimeToEpochMs(r.dateAdded, now),
    lastModified: prTimeToEpochMs(r.lastModified, now),
    guid: str(r.guid),
    url: str(r.url)
  }))
  const byParent = new Map<number, Row[]>()
  const byGuid = new Map<string, Row>()
  for (const row of rows) {
    byGuid.set(row.guid, row)
    const list = byParent.get(row.parent)
    if (list) list.push(row)
    else byParent.set(row.parent, [row])
  }
  const out: ImportedBookmarks = { items: [], skipped: 0 }
  const children = (parentId: number): ImportedBookmarkItem[] => {
    const items: ImportedBookmarkItem[] = []
    for (const row of byParent.get(parentId) ?? []) {
      if (row.type === TYPE_FOLDER) {
        items.push(
          folder(row.title || 'Folder', children(row.id), {
            addDate: row.dateAdded,
            lastModified: row.lastModified
          })
        )
      } else if (row.type === TYPE_BOOKMARK && isImportableUrl(row.url)) {
        items.push(bookmark(row.title, row.url, { addDate: row.dateAdded }))
      } else {
        out.skipped += 1
      }
    }
    return items
  }
  const rootOf = (guid: string): Row | undefined => byGuid.get(guid)
  const toolbar = rootOf(ROOT_GUIDS.toolbar)
  const menu = rootOf(ROOT_GUIDS.menu)
  const unfiled = rootOf(ROOT_GUIDS.unfiled)
  const mobile = rootOf(ROOT_GUIDS.mobile)
  if (!toolbar && !menu && !unfiled) throw new Error('places.sqlite has no bookmark roots.')
  if (toolbar) out.items.push(folder('Bookmarks Toolbar', children(toolbar.id), { toolbar: true }))
  if (menu) out.items.push(folder('Bookmarks Menu', children(menu.id), { unfiled: true }))
  if (unfiled) out.items.push(folder('Other Bookmarks', children(unfiled.id), { unfiled: true }))
  if (mobile) {
    const items = children(mobile.id)
    if (items.length) out.items.push(folder('Mobile Bookmarks', items))
  }
  return out
}

// ---------------------------------------------------------------------------
// bookmarkbackups
// ---------------------------------------------------------------------------

/** Newest first: the names carry a zero-padded date, so text order is date order. */
export function newestFirefoxBackup(names: string[]): string | null {
  const backups = names.filter((n) => /^bookmarks-\d{4}-\d{2}-\d{2}.*\.json(lz4)?$/.test(n)).sort()
  return backups.length ? backups[backups.length - 1] : null
}

/** A `.jsonlz4` (mozlz4) or plain `.json` backup as text. */
export function decodeFirefoxBackup(bytes: Uint8Array): string {
  if (isMozLz4(bytes)) return decodeMozLz4(bytes)
  return new TextDecoder().decode(bytes)
}

export function firefoxBookmarksFromBackup(text: string, now: number = Date.now()): ImportedBookmarks {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('The bookmark backup is not valid JSON.')
  }
  const root = record(data)
  if (!root || !Array.isArray(root.children)) throw new Error('The bookmark backup has no roots.')
  const out: ImportedBookmarks = { items: [], skipped: 0 }
  const convert = (node: Record<string, unknown>): ImportedBookmarkItem | null => {
    const typeCode = num(node.typeCode) || (node.type === 'text/x-moz-place-container' ? TYPE_FOLDER : node.type === 'text/x-moz-place' ? TYPE_BOOKMARK : 0)
    const title = str(node.title)
    const addDate = prTimeToEpochMs(node.dateAdded, now)
    if (typeCode === TYPE_FOLDER) {
      const children: ImportedBookmarkItem[] = []
      for (const child of Array.isArray(node.children) ? node.children : []) {
        const rec = record(child)
        if (!rec) {
          out.skipped += 1
          continue
        }
        const item = convert(rec)
        if (item) children.push(item)
      }
      return folder(title || 'Folder', children, {
        addDate,
        lastModified: prTimeToEpochMs(node.lastModified, now)
      })
    }
    if (typeCode === TYPE_BOOKMARK) {
      const url = str(node.uri).trim()
      if (!isImportableUrl(url)) {
        out.skipped += 1
        return null
      }
      const icon = str(node.iconUri)
      return bookmark(title, url, { addDate }, icon && !icon.startsWith('fake-favicon-uri:') ? icon : undefined)
    }
    out.skipped += 1
    return null
  }
  for (const child of root.children) {
    const rec = record(child)
    if (!rec) continue
    const role = str(rec.root) || str(rec.guid)
    const item = convert(rec)
    if (!item || item.type !== 'folder') continue
    switch (role) {
      case 'toolbarFolder':
      case ROOT_GUIDS.toolbar:
        item.title = 'Bookmarks Toolbar'
        item.toolbar = true
        out.items.push(item)
        break
      case 'bookmarksMenuFolder':
      case ROOT_GUIDS.menu:
        item.title = 'Bookmarks Menu'
        item.unfiled = true
        out.items.push(item)
        break
      case 'unfiledBookmarksFolder':
      case ROOT_GUIDS.unfiled:
        item.title = 'Other Bookmarks'
        item.unfiled = true
        out.items.push(item)
        break
      case 'mobileFolder':
      case ROOT_GUIDS.mobile:
        item.title = 'Mobile Bookmarks'
        if (item.children.length) out.items.push(item)
        break
      case 'tagsFolder':
      case ROOT_GUIDS.tags:
        break
      default:
        if (item.children.length) out.items.push(item)
    }
  }
  return out
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
