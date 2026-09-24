import { Copy, Printer, QrCode, Scan, Share, type LucideIcon } from 'lucide-react'
import type { SharePanelRequest } from '@shared/types'
import { COVERED_TIMEOUT_MS, pageOffScreen, pageViewStore } from './pageView'

/**
 * The browser's own share panel (Android below 14; SH-03): what the sheet draws for a share, as
 * data – the chips the share gets and the two lines of its preview. The sheet
 * (`components/share/SharePanelSheet.tsx`) does the rest; the host (`Share.kt`) found the apps.
 */

/** One of the panel's own chips (the Android 14 action row's four, `Share.browserActions`). */
export type SharePanelChipKind = 'copy' | 'qr' | 'screenshot' | 'print'

export interface SharePanelChip {
  kind: SharePanelChipKind
  label: string
  icon: LucideIcon
}

/**
 * The chips a share gets, in the Android 14 action row's order (`Share.browserActions`, SH-02;
 * v2 draft §9.38 – one order for one object, the panel being the row's stand-in below 14): Copy
 * link, QR code, Long screenshot, Print – the link's two forms, then the page's two – less Send
 * to your devices, which Zenium has no service for. The chips are the subject's alone: a
 * selection's are Copy text and Long screenshot (the quote's page is its picture; no link to
 * draw, no page to print), an image's is Copy image and nothing of the page's. Long screenshot
 * and Print work on the tab the share started from, so a share without one has neither. A
 * private tab's panel draws every chip, QR code with them: private governs what is recorded
 * (`SharePanelRequest.private`, the host's history), not what is shown – the link already stands
 * on the preview, and a code is the link drawn, not a record of it.
 */
export function sharePanelChips(request: SharePanelRequest): SharePanelChip[] {
  if (request.kind === 'image') return [{ kind: 'copy', label: 'Copy image', icon: Copy }]
  const chips: SharePanelChip[] = [
    { kind: 'copy', label: request.kind === 'text' ? 'Copy text' : 'Copy link', icon: Copy }
  ]
  if (request.kind === 'link' && request.url)
    chips.push({ kind: 'qr', label: 'QR code', icon: QrCode })
  if (request.tabId) {
    chips.push({ kind: 'screenshot', label: 'Long screenshot', icon: Scan })
    if (request.kind === 'link') chips.push({ kind: 'print', label: 'Print', icon: Printer })
  }
  return chips
}

/** The row's last cell: the system sheet, for every app the row has no room for. */
export const SHARE_PANEL_MORE = { label: 'More', icon: Share } as const

/**
 * A link as the preview's line shows it: without a text-fragment directive (`#:~:text=…`, SH-11's
 * link to a highlight). The directive says how the page is to be shown, not where it is, and
 * travels in the payload – the share carries the whole link; only the displayed line drops it,
 * and a plain fragment before it (`#section`) stays.
 */
export function displayedLink(url: string): string {
  const hash = url.indexOf('#')
  if (hash < 0) return url
  const directive = url.indexOf(':~:', hash)
  if (directive < 0) return url
  const kept = url.slice(0, directive)
  return kept.endsWith('#') ? kept.slice(0, -1) : kept
}

/**
 * The preview's two lines, by what is shared. A page or a link: its title over its link (the link
 * alone, once, when it came without a title). A selection: the selected text leads, as Chrome's
 * hub puts the text first, and the page's link is the line beneath, shown without the
 * `#:~:text=` fragment the share carries to the highlight (§9.38) – the host sends no title and
 * no favicon for one (`Share.shareText`). An image: its name, or "Image" for a picture that came
 * without one; the host sends no link with it.
 */
export function sharePanelPreview(request: SharePanelRequest): { title: string; detail: string } {
  const title =
    request.kind === 'text'
      ? request.text || request.url || ''
      : request.title || (request.kind === 'image' ? 'Image' : request.url || '')
  const detail = request.url && request.url !== title ? displayedLink(request.url) : ''
  return { title, detail }
}

/** What Copy puts on the clipboard, and what the confirmation says where the chrome is the one to. */
export function sharePanelCopy(
  request: SharePanelRequest
): { text: string; confirmation: string } | null {
  if (request.kind === 'text') {
    return request.text ? { text: request.text, confirmation: 'Text copied' } : null
  }
  return request.url ? { text: request.url, confirmation: 'Link copied' } : null
}

/**
 * Run `then` once `tabId`'s live page is back on the screen – or at once where it never left.
 *
 * The sheet's `dismiss(then)` runs its callback with the sheet gone from the screen but still
 * mounted: the layout the chrome reports without it, the core's `layout.applied` and the host's
 * frame with the page view back (`view.drawn`) all come after. A capture asked for in between
 * meets a page view the host holds `GONE` under the sheet's cover and is refused on the spot
 * (`PageCapture.runBitmap`): Long screenshot waits for the page as `pageCovered` waits for the
 * cover on the way in, and gives up waiting after `COVERED_TIMEOUT_MS` – a host that never
 * answers has the capture asked for regardless, and its own answer says whether it could.
 */
export function afterPageShown(tabId: string, then: () => void): void {
  if (!pageOffScreen(pageViewStore.get(), tabId)) {
    then()
    return
  }
  let done = false
  let unsubscribe: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const finish = (): void => {
    if (done) return
    done = true
    unsubscribe?.()
    unsubscribe = null
    if (timer !== null) clearTimeout(timer)
    timer = null
    then()
  }
  unsubscribe = pageViewStore.subscribe(() => {
    if (!done && !pageOffScreen(pageViewStore.get(), tabId)) finish()
  })
  timer = setTimeout(finish, COVERED_TIMEOUT_MS)
}
