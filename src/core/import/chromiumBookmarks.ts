import { webkitToEpochMs } from './time'
import {
  bookmark,
  folder,
  isImportableUrl,
  type ImportedBookmarkItem,
  type ImportedBookmarks
} from './types'

/**
 * Chrome's and Edge's `Bookmarks` file: JSON with `roots.bookmark_bar`, `roots.other` and
 * `roots.synced` ("Mobile bookmarks"), each a folder of `url` and `folder` nodes stamped with
 * `date_added` in WebKit microseconds. Newer Chrome adds account roots (`account_bookmark_bar`…)
 * when the signed-in account keeps its own; they come along as plain folders under their names.
 */

const ROOT_ORDER = ['bookmark_bar', 'other', 'synced'] as const

export function parseChromiumBookmarks(text: string, now: number = Date.now()): ImportedBookmarks {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('The Bookmarks file is not valid JSON.')
  }
  const roots = record(record(data)?.roots)
  if (!roots) throw new Error('The Bookmarks file has no roots.')
  const out: ImportedBookmarks = { items: [], skipped: 0 }
  const convert = (node: Record<string, unknown>): ImportedBookmarkItem | null => {
    const type = node.type
    const title = typeof node.name === 'string' ? node.name : ''
    const addDate = webkitToEpochMs(node.date_added, now)
    if (type === 'url') {
      const url = typeof node.url === 'string' ? node.url.trim() : ''
      if (!isImportableUrl(url)) {
        out.skipped += 1
        return null
      }
      return bookmark(title, url, { addDate })
    }
    if (type === 'folder') {
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
        lastModified: webkitToEpochMs(node.date_modified, now)
      })
    }
    out.skipped += 1
    return null
  }
  const seen = new Set<string>()
  const addRoot = (key: string, flags: { toolbar?: boolean; unfiled?: boolean }, title?: string): void => {
    const root = record(roots[key])
    if (!root) return
    seen.add(key)
    const item = convert({ ...root, type: 'folder' })
    if (!item || item.type !== 'folder') return
    if (title) item.title = title
    item.toolbar = flags.toolbar === true
    item.unfiled = flags.unfiled === true
    // A root that holds nothing adds nothing (Chrome does not create an empty "Mobile bookmarks").
    if (item.children.length === 0 && !flags.toolbar && !flags.unfiled) return
    out.items.push(item)
  }
  addRoot(ROOT_ORDER[0], { toolbar: true })
  addRoot(ROOT_ORDER[1], { unfiled: true })
  addRoot(ROOT_ORDER[2], {}, 'Mobile bookmarks')
  for (const key of Object.keys(roots)) {
    if (seen.has(key)) continue
    const root = record(roots[key])
    if (!root || !Array.isArray(root.children)) continue
    addRoot(key, {}, typeof root.name === 'string' && root.name ? root.name : key)
  }
  return out
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
