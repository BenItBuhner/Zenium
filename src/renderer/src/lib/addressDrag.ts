import type { BookmarkNode, Tab } from '@shared/types'
import { isEmptyTabUrl, isInternalUrl, presentedUrl } from '@shared/url'

/*
 * The address dragged out of the URL pill (omnibox-43, dnd-11; Chrome's location-icon drag):
 * the pill's site-information slot is the drag's handle – a press that moves past Chromium's
 * drag threshold lifts the page's address, a press that does not is the slot's click (the site
 * information). What the drag carries is decided here, without a DOM: the link (`text/uri-list`),
 * the address as text (`text/plain`) and an anchor with the page's title (`text/html`), so a
 * drop on the bookmarks bar files a bookmark named for the page (`droppedBookmark` reads the
 * anchor's text), a drop on a tab row navigates that tab and a drop on the pill of another
 * window goes as typed text (`lib/dropIntent.ts`), and the OS gets the URL in its own forms
 * through Chromium's drag data providers – Explorer's `.url` internet shortcut
 * (`OSExchangeDataProviderWin::SetURL` adds one for the URL), Finder's `.webloc` (the `NSURL`
 * pasteboard type), a file manager's `.desktop` link (`_NETSCAPE_URL` on X11) – with no file of
 * ours written anywhere. The dragged item is Chrome's: copy or link, never a move.
 *
 * A bookmark dragged off the bookmarks bar (bookmarks-15, dnd-13) is the same drag with the
 * chip's own mark on it (`writeBookmarkDrag`): the OS and a tab take the link as above – the
 * link file, the navigation – while the bar and its panels read the mark and move the chip
 * rather than file it twice.
 */

/** What the slot lifts: the address as the user sees it, and the page's name for the ghost. */
export interface AddressDrag {
  url: string
  title: string
}

/** The part of a `DataTransfer` the drag writes (the real one, or a stand-in in tests). */
export interface TransferWriter {
  effectAllowed: string
  setData(type: string, data: string): void
}

/**
 * The drag the slot offers for the tab, or null where there is nothing to lift: an empty tab, a
 * Zenium page (its `zen://` address is not a link for anything outside – `droppedBookmark`
 * refuses it too), or no tab. A masked private tab shows no page and offers nothing; the caller
 * passes none for it. The title falls back to the address, so the ghost never reads blank.
 */
export function addressDragOf(tab: Tab | null | undefined, title: string): AddressDrag | null {
  if (!tab || !tab.url || isEmptyTabUrl(tab.url) || isInternalUrl(tab.url)) return null
  const url = presentedUrl(tab.url)
  const name = title.trim()
  return { url, title: name || url }
}

/**
 * Write the address into the drag's transfer: the link, the text, the anchor. `copyLink` is
 * what the drag allows (Chrome's `DRAG_COPY | DRAG_LINK` for the omnibox): a target that would
 * move it refuses the drop, and the chrome's own targets badge it as a copy.
 */
export function writeAddressDrag(dt: TransferWriter, drag: AddressDrag): void {
  dt.effectAllowed = 'copyLink'
  dt.setData('text/uri-list', drag.url)
  dt.setData('text/plain', drag.url)
  dt.setData('text/html', anchorMarkup(drag))
}

/** An anchor for the address with the page's title as its text, escaped for markup. */
export function anchorMarkup({ url, title }: AddressDrag): string {
  return `<a href="${escapeHtml(url)}">${escapeHtml(title)}</a>`
}

/**
 * The mark a bookmark dragged off the bar carries beside the link: the chip's id under a type
 * of our own. The bar and its panels read it at the drop and move the chip; the OS, a page and
 * the tab strip never look for it and take the link.
 */
export const BOOKMARK_DRAG_TYPE = 'application/x-zenium-bookmark'

/**
 * The drag a chip of the bookmarks bar offers (bookmarks-15; Chrome's bookmark-bar drag), or
 * null where there is nothing to lift as a link: a folder (its contents are its panel's), a
 * bookmarklet (`javascript:` is no link for a file manager, and a page it landed on would run
 * it), a Zenium page (as `addressDragOf` refuses one). The title falls back to the address, so
 * the card in the hand never reads blank.
 */
export function bookmarkDragOf(node: BookmarkNode): AddressDrag | null {
  const url = node.type === 'url' ? node.url : undefined
  if (!url || /^javascript:/i.test(url) || isEmptyTabUrl(url) || isInternalUrl(url)) return null
  const name = node.title.trim()
  return { url, title: name || url }
}

/**
 * Write a bookmark's drag: the address drag's three forms, then the chip's mark. Every
 * operation is allowed, as Chrome's bookmark drag allows copy, move and link: a drop back on
 * the bar or into a panel badges as the move it is, while the OS still takes the link as a copy.
 */
export function writeBookmarkDrag(dt: TransferWriter, node: BookmarkNode, drag: AddressDrag): void {
  writeAddressDrag(dt, drag)
  dt.effectAllowed = 'all'
  dt.setData(BOOKMARK_DRAG_TYPE, node.id)
}

/** Whether a drag is a chip of the bar's, from its types alone (all `dragover` may read). */
export function carriesBookmark(types: readonly string[]): boolean {
  return types.includes(BOOKMARK_DRAG_TYPE)
}

/**
 * The id of the chip a drag lifted, read at the drop (the data is sealed before it), or null
 * for any other drag: a link from a page, a file, text.
 */
export function draggedBookmarkId(dt: {
  types: readonly string[]
  getData(type: string): string
}): string | null {
  if (!carriesBookmark(dt.types)) return null
  return dt.getData(BOOKMARK_DRAG_TYPE) || null
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
