import { parseBinaryPlist, plistDict, plistString, type PlistValue } from './bplist'
import {
  bookmark,
  folder,
  isImportableUrl,
  type ImportedBookmarkItem,
  type ImportedBookmarks
} from './types'

/**
 * Safari's `Bookmarks.plist`: a binary plist whose root list holds the `BookmarksBar` and
 * `BookmarksMenu` lists, the Reading List and the History proxy. Lists nest as folders
 * (`WebBookmarkTypeList`), pages are leaves (`WebBookmarkTypeLeaf` with `URLString` and the
 * title inside `URIDictionary`). Chrome imports the bar and the menu and leaves the Reading
 * List and the proxies out; so does this.
 */

const TYPE_LIST = 'WebBookmarkTypeList'
const TYPE_LEAF = 'WebBookmarkTypeLeaf'
const READING_LIST = 'com.apple.ReadingList'

export function parseSafariBookmarks(bytes: Uint8Array): ImportedBookmarks {
  return safariBookmarksFromPlist(parseBinaryPlist(bytes))
}

export function safariBookmarksFromPlist(root: PlistValue): ImportedBookmarks {
  const top = plistDict(root)
  if (!top || plistString(top.WebBookmarkType) !== TYPE_LIST)
    throw new Error('Bookmarks.plist has no bookmark list at its root.')
  const out: ImportedBookmarks = { items: [], skipped: 0 }
  const convert = (node: PlistValue): ImportedBookmarkItem | null => {
    const dict = plistDict(node)
    if (!dict) {
      out.skipped += 1
      return null
    }
    const type = plistString(dict.WebBookmarkType)
    if (type === TYPE_LEAF) {
      const url = plistString(dict.URLString).trim()
      if (!isImportableUrl(url)) {
        out.skipped += 1
        return null
      }
      const uri = plistDict(dict.URIDictionary ?? null)
      return bookmark(plistString(uri?.title) || plistString(dict.Title), url)
    }
    if (type === TYPE_LIST) {
      const title = plistString(dict.Title)
      if (title === READING_LIST) {
        out.skipped += Array.isArray(dict.Children) ? dict.Children.length : 0
        return null
      }
      const children: ImportedBookmarkItem[] = []
      for (const child of Array.isArray(dict.Children) ? dict.Children : []) {
        const item = convert(child)
        if (item) children.push(item)
      }
      return folder(title || 'Folder', children)
    }
    // Proxies (History) and anything newer than this parser.
    out.skipped += 1
    return null
  }
  for (const child of Array.isArray(top.Children) ? top.Children : []) {
    const dict = plistDict(child)
    const title = plistString(dict?.Title)
    const item = convert(child)
    if (!item || item.type !== 'folder') continue
    if (title === 'BookmarksBar') {
      item.title = 'Favorites'
      item.toolbar = true
      out.items.push(item)
    } else if (title === 'BookmarksMenu') {
      item.title = 'Bookmarks Menu'
      item.unfiled = true
      out.items.push(item)
    } else if (item.children.length) {
      out.items.push(item)
    }
  }
  if (out.items.length === 0 && out.skipped === 0)
    throw new Error('Bookmarks.plist holds no bookmarks bar or menu.')
  return out
}
