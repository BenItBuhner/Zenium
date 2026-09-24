import type { Tab } from '@shared/types'
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
