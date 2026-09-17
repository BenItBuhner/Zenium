import type { BookmarkNode } from './types'
import {
  BOOKMARKS_BAR_ID,
  MAX_FAVICON_DATA_URI,
  MOBILE_BOOKMARKS_ID,
  OTHER_BOOKMARKS_ID,
  type BookmarkTree
} from './bookmarks'

/**
 * The Netscape bookmark file format (`<!DOCTYPE NETSCAPE-Bookmark-file-1>`) every browser
 * imports and exports. The grammar is loose and real files are frequently malformed, so this is
 * a forgiving tag scanner rather than an HTML parser: it understands the `DL` / `DT` / `H3` / `A`
 * skeleton Chrome, Edge, Firefox and Safari write, tolerates missing closing tags, anonymous
 * `DL`s and headings that never got their list, and ignores everything else (`DD` descriptions,
 * `HR` separators, Firefox `place:` queries).
 */

export interface NetscapeBookmark {
  type: 'url'
  title: string
  url: string
  addDate?: number
  lastModified?: number
  /** `ICON="data:…"` (Chrome, Edge, Firefox) or `ICON_URI="https://…"` (Firefox). */
  icon?: string
}

export interface NetscapeFolder {
  type: 'folder'
  title: string
  addDate?: number
  lastModified?: number
  /** `PERSONAL_TOOLBAR_FOLDER="true"`: the exporting browser's bookmarks bar. */
  toolbar: boolean
  /** `UNFILED_BOOKMARKS_FOLDER="true"`: Firefox's "Other Bookmarks". */
  unfiled: boolean
  children: NetscapeItem[]
}

export type NetscapeItem = NetscapeBookmark | NetscapeFolder

export interface NetscapeDocument {
  title: string
  items: NetscapeItem[]
}

export function isNetscapeBookmarkFile(text: string): boolean {
  const head = text.slice(0, 4096).toUpperCase()
  return head.includes('NETSCAPE-BOOKMARK-FILE') || (head.includes('<DL>') && head.includes('<DT>'))
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0'
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

function parseAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>()
  const re = /([A-Za-z_][\w.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    attrs.set(m[1].toUpperCase(), decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''))
  }
  return attrs
}

/**
 * Netscape files carry Unix seconds; some tools write milliseconds or Chrome's internal
 * microseconds. Normalise everything to milliseconds; zero / garbage means "unknown".
 */
export function parseNetscapeDate(value: string | undefined): number | undefined {
  if (!value) return undefined
  const n = Number(value.trim())
  if (!Number.isFinite(n) || n <= 0) return undefined
  if (n > 1e15) return Math.round(n / 1000)
  if (n > 1e11) return Math.round(n)
  return Math.round(n * 1000)
}

function flag(attrs: Map<string, string>, name: string): boolean {
  const v = attrs.get(name)
  return v !== undefined && v.toLowerCase() !== 'false'
}

/** Text up to the closing tag (or the next structural tag when the closing tag is missing). */
function readText(html: string, from: number, closing: string): { text: string; end: number } {
  const lower = html.toLowerCase()
  let end = lower.indexOf(`</${closing}`, from)
  const nextTag = lower.slice(from).search(/<\s*\/?\s*(dt|dl|h3|a|dd|hr|p)\b/)
  if (nextTag !== -1 && (end === -1 || from + nextTag < end)) end = from + nextTag
  if (end === -1) end = html.length
  const text = decodeEntities(html.slice(from, end).replace(/<[^>]*>/g, '')).trim()
  // Skip the closing tag itself when we stopped at it.
  const close = lower.indexOf(`</${closing}`, end)
  const after = close === end ? html.indexOf('>', end) + 1 : end
  return { text, end: after > 0 ? after : end }
}

export function parseNetscapeHtml(html: string): NetscapeDocument {
  const doc: NetscapeDocument = { title: 'Bookmarks', items: [] }
  const root: NetscapeFolder = {
    type: 'folder',
    title: '',
    toolbar: false,
    unfiled: false,
    children: doc.items
  }
  // Stack frames: a folder that owns items, or `null` for a DL that opened no folder (the root
  // list, or an anonymous nested list whose items simply belong to the enclosing folder).
  const stack: Array<NetscapeFolder | null> = []
  let current = root
  let pending: NetscapeFolder | null = null

  const container = (): NetscapeFolder => current
  const flushPending = (): void => {
    // An H3 that never got its DL is still a (now empty) folder.
    if (pending) {
      container().children.push(pending)
      pending = null
    }
  }
  const push = (folder: NetscapeFolder | null): void => {
    stack.push(folder)
    if (folder) current = folder
  }
  const pop = (): void => {
    const frame = stack.pop()
    if (!frame) return
    // Back to the nearest folder still open below this one.
    let owner: NetscapeFolder = root
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i]
      if (f) {
        owner = f
        break
      }
    }
    current = owner
  }

  const tagRe =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\s*(\/?)\s*([A-Za-z][A-Za-z0-9]*)([^>]*)>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(html))) {
    if (m[0].startsWith('<!')) continue
    const closing = m[1] === '/'
    const name = m[2].toUpperCase()
    const attrs = parseAttributes(m[3] ?? '')
    const after = tagRe.lastIndex

    if (closing) {
      if (name === 'DL') {
        flushPending()
        pop()
      }
      continue
    }

    switch (name) {
      case 'TITLE': {
        const { text, end } = readText(html, after, 'title')
        if (text) doc.title = text
        tagRe.lastIndex = end
        break
      }
      case 'H1': {
        const { end } = readText(html, after, 'h1')
        tagRe.lastIndex = end
        break
      }
      case 'H3': {
        flushPending()
        const { text, end } = readText(html, after, 'h3')
        tagRe.lastIndex = end
        pending = {
          type: 'folder',
          title: text,
          addDate: parseNetscapeDate(attrs.get('ADD_DATE')),
          lastModified: parseNetscapeDate(attrs.get('LAST_MODIFIED')),
          toolbar: flag(attrs, 'PERSONAL_TOOLBAR_FOLDER'),
          unfiled: flag(attrs, 'UNFILED_BOOKMARKS_FOLDER'),
          children: []
        }
        break
      }
      case 'DL': {
        if (pending) {
          const folder = pending
          pending = null
          container().children.push(folder)
          push(folder)
        } else {
          push(null)
        }
        break
      }
      case 'A': {
        flushPending()
        const { text, end } = readText(html, after, 'a')
        tagRe.lastIndex = end
        const href = (attrs.get('HREF') ?? '').trim()
        if (!href || /^(javascript|place|about|chrome|edge|data|vbscript):/i.test(href)) break
        const icon = attrs.get('ICON') || attrs.get('ICON_URI')
        const bookmark: NetscapeBookmark = {
          type: 'url',
          title: text || href,
          url: href,
          addDate: parseNetscapeDate(attrs.get('ADD_DATE')),
          lastModified: parseNetscapeDate(attrs.get('LAST_MODIFIED'))
        }
        if (icon) bookmark.icon = icon
        container().children.push(bookmark)
        break
      }
      case 'DT':
        // A heading without a list followed by another entry: close the empty folder.
        if (pending) flushPending()
        break
      case 'DD': {
        // Descriptions are not part of the model; consume so their text is not mistaken for titles.
        const { end } = readText(html, after, 'dd')
        tagRe.lastIndex = end
        break
      }
      default:
        break
    }
  }
  flushPending()
  return doc
}

// ---------------------------------------------------------------------------
// Serialising
// ---------------------------------------------------------------------------

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const seconds = (ms: number | undefined): string => String(Math.floor((ms ?? 0) / 1000))

export interface NetscapeExportOptions {
  /** Shown in the header comment, e.g. `Zenium 0.2.0`. */
  product: string
  now: number
}

function serializeItems(tree: BookmarkTree, parentId: string, depth: number, out: string[]): void {
  const pad = '    '.repeat(depth)
  for (const node of tree.children(parentId)) {
    if (node.type === 'folder') {
      out.push(
        `${pad}<DT><H3 ADD_DATE="${seconds(node.dateAdded)}" LAST_MODIFIED="${seconds(node.dateGroupModified ?? node.dateAdded)}">${escapeText(node.title)}</H3>`
      )
      out.push(`${pad}<DL><p>`)
      serializeItems(tree, node.id, depth + 1, out)
      out.push(`${pad}</DL><p>`)
    } else {
      const attrs = [
        `HREF="${escapeAttr(node.url ?? '')}"`,
        `ADD_DATE="${seconds(node.dateAdded)}"`
      ]
      if (node.favicon) {
        attrs.push(
          node.favicon.startsWith('data:')
            ? `ICON="${escapeAttr(node.favicon)}"`
            : `ICON_URI="${escapeAttr(node.favicon)}"`
        )
      }
      out.push(`${pad}<DT><A ${attrs.join(' ')}>${escapeText(node.title)}</A>`)
    }
  }
}

/**
 * Chrome's layout: the bookmarks bar as the `PERSONAL_TOOLBAR_FOLDER`, "Other bookmarks" spread
 * at the top level, and "Mobile bookmarks" as a plain folder when it has anything in it.
 */
export function serializeNetscapeHtml(tree: BookmarkTree, options: NetscapeExportOptions): string {
  const bar = tree.get(BOOKMARKS_BAR_ID)
  const mobile = tree.get(MOBILE_BOOKMARKS_ID)
  const out: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    `<!-- Exported by ${escapeText(options.product)} on ${new Date(options.now).toISOString()} -->`,
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>'
  ]
  if (bar) {
    out.push(
      `    <DT><H3 ADD_DATE="${seconds(bar.dateAdded)}" LAST_MODIFIED="${seconds(bar.dateGroupModified ?? bar.dateAdded)}" PERSONAL_TOOLBAR_FOLDER="true">${escapeText(bar.title)}</H3>`
    )
    out.push('    <DL><p>')
    serializeItems(tree, BOOKMARKS_BAR_ID, 2, out)
    out.push('    </DL><p>')
  }
  serializeItems(tree, OTHER_BOOKMARKS_ID, 1, out)
  if (mobile && tree.children(MOBILE_BOOKMARKS_ID).length) {
    out.push(
      `    <DT><H3 ADD_DATE="${seconds(mobile.dateAdded)}" LAST_MODIFIED="${seconds(mobile.dateGroupModified ?? mobile.dateAdded)}">${escapeText(mobile.title)}</H3>`
    )
    out.push('    <DL><p>')
    serializeItems(tree, MOBILE_BOOKMARKS_ID, 2, out)
    out.push('    </DL><p>')
  }
  out.push('</DL><p>', '')
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Turning a parsed document into nodes
// ---------------------------------------------------------------------------

export interface ImportPlan {
  nodes: BookmarkNode[]
  bookmarks: number
  folders: number
  /** The folder that received the import (a root, or the new "Imported" folder). */
  folderId: string
}

export interface ImportTarget {
  /** Chrome merges into the roots when the bookmarks bar is still empty. */
  barIsEmpty: boolean
  /** Next free index in each root the import may append to. */
  nextIndex: (parentId: string) => number
  newId: () => string
  now: number
  /** Title for the container folder when not merging into roots. */
  importedFolderTitle: string
}

/**
 * Chrome's import rule: with an empty bookmarks bar the exporting browser's toolbar folder
 * becomes our bar and everything else lands in Other bookmarks; otherwise the whole file goes
 * into one "Imported" folder on the bar, with the foreign toolbar's contents at its top level.
 */
export function planNetscapeImport(doc: NetscapeDocument, target: ImportTarget): ImportPlan {
  const nodes: BookmarkNode[] = []
  let bookmarks = 0
  let folders = 0
  const counters = new Map<string, number>()
  const next = (parentId: string): number => {
    const n = counters.get(parentId) ?? target.nextIndex(parentId)
    counters.set(parentId, n + 1)
    return n
  }
  const add = (item: NetscapeItem, parentId: string): void => {
    if (item.type === 'url') {
      const node: BookmarkNode = {
        id: target.newId(),
        parentId,
        index: next(parentId),
        type: 'url',
        title: item.title,
        url: item.url,
        dateAdded: item.addDate ?? target.now
      }
      if (item.icon && (!item.icon.startsWith('data:') || item.icon.length <= MAX_FAVICON_DATA_URI))
        node.favicon = item.icon
      nodes.push(node)
      bookmarks += 1
      return
    }
    const folder: BookmarkNode = {
      id: target.newId(),
      parentId,
      index: next(parentId),
      type: 'folder',
      title: item.title || 'Folder',
      dateAdded: item.addDate ?? target.now
    }
    if (item.lastModified) folder.dateGroupModified = item.lastModified
    nodes.push(folder)
    folders += 1
    for (const child of item.children) add(child, folder.id)
  }

  if (target.barIsEmpty) {
    for (const item of doc.items) {
      if (item.type === 'folder' && item.toolbar) {
        for (const child of item.children) add(child, BOOKMARKS_BAR_ID)
      } else if (item.type === 'folder' && item.unfiled) {
        for (const child of item.children) add(child, OTHER_BOOKMARKS_ID)
      } else {
        add(item, OTHER_BOOKMARKS_ID)
      }
    }
    // Show the root that received something (the bar when the file had a toolbar folder).
    const barGotNodes = nodes.some((n) => n.parentId === BOOKMARKS_BAR_ID)
    return { nodes, bookmarks, folders, folderId: barGotNodes ? BOOKMARKS_BAR_ID : OTHER_BOOKMARKS_ID }
  }

  const imported: BookmarkNode = {
    id: target.newId(),
    parentId: BOOKMARKS_BAR_ID,
    index: next(BOOKMARKS_BAR_ID),
    type: 'folder',
    title: target.importedFolderTitle,
    dateAdded: target.now,
    dateGroupModified: target.now
  }
  nodes.push(imported)
  for (const item of doc.items) {
    if (item.type === 'folder' && (item.toolbar || item.unfiled)) {
      for (const child of item.children) add(child, imported.id)
    } else {
      add(item, imported.id)
    }
  }
  return { nodes, bookmarks, folders, folderId: imported.id }
}
