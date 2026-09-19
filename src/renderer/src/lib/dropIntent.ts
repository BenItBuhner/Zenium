import type { TabSection } from '@shared/types'
import { pathToFileUrl } from '@shared/launchArgs'
import { inputToUrl } from '@shared/url'

/**
 * What a drop from outside the tab strip does (HTML5 drag and drop): a link or a selection
 * dragged out of a page, an address from another window, files from the OS, landing on the
 * chrome. Pure: what the drag carries (`payloadKind`, `readInputs`), where in a list of rows the
 * pointer is (`slotInRows`), and what a payload dropped on a target does (`dropKeyFor`) or shows
 * (`feedbackKeyFor`). `lib/dnd.ts` wires it to the document.
 *
 * Chrome's drop semantics are the reference: on the tab strip a drop between rows opens a new
 * foreground tab in that slot and a drop on a row navigates that tab; the address pill takes
 * the drop as typed text (paste and go); a file dropped anywhere on the window's chrome opens in
 * a tab; the bookmarks bar and its folder panels file a bookmark (`droppedBookmark`).
 */

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/** What a drag carries, by precedence: the link(s), else the files, else the text. */
export type PayloadKind = 'urls' | 'files' | 'text'

/** The types a chrome drop reads; a drag carrying none of them is not a drop for the chrome. */
export function payloadKind(types: readonly string[]): PayloadKind | null {
  if (types.includes('text/uri-list')) return 'urls'
  if (types.includes('Files')) return 'files'
  if (types.includes('text/plain')) return 'text'
  return null
}

/** A `DataTransfer` as read here (the real one, or a stand-in in tests). */
export interface TransferLike {
  types: readonly string[]
  getData(type: string): string
  files: ArrayLike<File>
}

/** Where a dropped `File` is on disk (Electron's `webUtils.getPathForFile` through the preload). */
export type PathForFile = (file: File) => string | null | undefined

/**
 * The inputs a drop opens, each as typed text would be: the drag's links (`text/uri-list`,
 * comments dropped); failing those its files, as `file:` URLs of their paths (a file the host
 * cannot place is skipped); failing those its text, whitespace collapsed to one line the way
 * Chrome's omnibox takes a drop (a selection that is not an address is searched). The data is
 * sealed until the drop: this reads a `drop` event's transfer, never a `dragover`'s.
 */
export function readInputs(dt: TransferLike, pathForFile: PathForFile): string[] {
  const urls = dt
    .getData('text/uri-list')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  if (urls.length) return urls
  const files: string[] = []
  for (const file of Array.from(dt.files)) {
    const path = pathForFile(file)
    if (path) files.push(pathToFileUrl(path))
  }
  if (files.length) return files
  const text = dt.getData('text/plain').replace(/\s+/g, ' ').trim()
  return text ? [text] : []
}

/**
 * The URL and a name for a bookmark of what a drag (or the clipboard) carried: its link, a file,
 * or text that reads as an address (other text is not a bookmark, and Zenium's own pages are
 * not bookmarked). The name is the link's text (`text/html`), the file's name, the text when it
 * is not the address itself, else the host.
 */
export function droppedBookmark(
  dt: TransferLike,
  pathForFile: PathForFile
): { url: string; title: string } | null {
  const first = readInputs(dt, pathForFile)[0]
  if (!first) return null
  const text = dt.getData('text/plain').trim()
  const url = first.startsWith('file:') ? first : inputToUrl(first)
  if (!url || url.startsWith('zen://')) return null
  let title = ''
  const html = dt.getData('text/html')
  if (html && typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    title = (doc.body.textContent ?? '').trim()
  }
  if (!title && url.startsWith('file:')) title = dt.files[0]?.name ?? ''
  if (!title && text && text !== first && text !== url) title = text
  if (!title) {
    try {
      title = new URL(url).hostname.replace(/^www\./, '') || url
    } catch {
      title = url
    }
  }
  return { url, title }
}

/**
 * The cursor badge for a drop the chrome takes, within what the source allows (a drop effect
 * the source forbids cancels the drop): Chrome's copy badge for a link or text, else link, else
 * move. `effectAllowed` is `uninitialized` for most page drags.
 */
export function dropEffectFor(effectAllowed: string): 'copy' | 'link' | 'move' {
  const allowed = effectAllowed.toLowerCase()
  if (allowed === 'uninitialized' || allowed === 'all' || allowed.includes('copy')) return 'copy'
  if (allowed.includes('link')) return 'link'
  return 'move'
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export type RowPosition = 'before' | 'after' | 'into'

/** A row of a list along its axis: a tab row's top and bottom, an Essentials tile's left and right. */
export interface RowSpan {
  id: string
  start: number
  end: number
}

/**
 * Chrome's tab strip rule for a drop on a list, read off the rows as drawn: a row's outer
 * quarters are the slots beside it and its middle half is the row itself (the drop goes into
 * that tab); in a gap the slot is the nearer row's edge, so the caret follows the pointer
 * through the gap; ahead of the first row is before it, past the last is after it.
 */
export function slotInRows(
  pointer: number,
  rows: readonly RowSpan[]
): { id: string; position: RowPosition } | null {
  if (!rows.length) return null
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (pointer < row.start) {
      if (i === 0) return { id: row.id, position: 'before' }
      const prev = rows[i - 1]
      return pointer - prev.end <= row.start - pointer
        ? { id: prev.id, position: 'after' }
        : { id: row.id, position: 'before' }
    }
    if (pointer < row.end) {
      const quarter = (row.end - row.start) / 4
      if (pointer < row.start + quarter) return { id: row.id, position: 'before' }
      if (pointer >= row.end - quarter) return { id: row.id, position: 'after' }
      return { id: row.id, position: 'into' }
    }
  }
  return { id: rows[rows.length - 1].id, position: 'after' }
}

/** What lies under a chrome drop, as the classifier sees it. */
export type ChromeDropTarget =
  /** A tab row (or an Essentials tile): the slots beside it, or the tab itself. */
  | { kind: 'tab'; tabId: string; position: RowPosition }
  /** The end of a section: the free space of a tab list, the Essentials grid. */
  | { kind: 'section'; section: TabSection; spaceId: string }
  /** The new-tab button of a space's list. */
  | { kind: 'newTab'; spaceId: string }
  | { kind: 'folder'; folderId: string }
  | { kind: 'space'; spaceId: string }
  /**
   * The address pill, or the open URL bar's field: the tab it stands for takes the drop as typed
   * text (Chrome's paste and go), a new tab when it stands for none. A popup's location bar is
   * read-only; the URL bar's own text dropped back on it is the field's to move (`own`).
   */
  | {
      kind: 'address'
      tabId: string | null
      spaceId: string
      readOnly: boolean
      own: boolean
    }
  /** The rest of the window's chrome: a file opens in a tab, anything else has no target here. */
  | { kind: 'chrome'; spaceId: string }

/**
 * What a drop of a payload on a target does: the `drop.open` key the core acts on, or null
 * when nothing happens (and `dragover` is left alone, so the drop is refused).
 */
export function dropKeyFor(kind: PayloadKind, target: ChromeDropTarget | null): string | null {
  if (!target) return null
  switch (target.kind) {
    case 'tab':
      return `tab:${target.tabId}:${target.position}`
    case 'section':
      return `section:${target.section}:${target.spaceId}`
    case 'newTab':
      return `section:regular:${target.spaceId}`
    case 'folder':
      return `folder:${target.folderId}`
    case 'space':
      return `space:${target.spaceId}`
    case 'address':
      if (target.readOnly || target.own) return null
      return target.tabId ? `tab:${target.tabId}:into` : `section:regular:${target.spaceId}`
    case 'chrome':
      return kind === 'files' ? `section:regular:${target.spaceId}` : null
  }
}

/**
 * What the chrome lights up for the target (`dropStore.key`): the drop-into targets by their
 * key – the pill and the URL bar's field as `address:`, the new-tab button as
 * `newtab:<spaceId>` – and a tab row by its position, which the row (`into`) or the caret (a
 * slot) answers; nothing for a target the drop is refused on, or for the bare chrome.
 */
export function feedbackKeyFor(kind: PayloadKind, target: ChromeDropTarget | null): string | null {
  if (!target || dropKeyFor(kind, target) === null) return null
  switch (target.kind) {
    case 'address':
      return 'address:'
    case 'newTab':
      return `newtab:${target.spaceId}`
    case 'chrome':
      return null
    default:
      return dropKeyFor(kind, target)
  }
}
