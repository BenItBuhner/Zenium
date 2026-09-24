import { Copy, Printer, QrCode, Scan, Share, type LucideIcon } from 'lucide-react'
import type { SharePanelRequest } from '@shared/types'

/**
 * The browser's own share panel (Android below 14; SH-03): what the sheet draws for a share, as
 * data – the chips the share gets and the two lines of its preview. The sheet
 * (`components/share/SharePanelSheet.tsx`) does the rest; the host (`Share.kt`) found the apps.
 */

/** One of the panel's own chips (Chrome 152's first-party row). */
export type SharePanelChipKind = 'copy' | 'screenshot' | 'print' | 'qr'

export interface SharePanelChip {
  kind: SharePanelChipKind
  label: string
  icon: LucideIcon
}

/**
 * The chips a share gets, in Chrome 152's order (`ChromeProvidedSharingOptionsProvider`): Copy –
 * link, text or image, by what is shared – then Long screenshot, Print and QR code, less Send to
 * your devices, which Zenium has no service for. Long screenshot and Print work on the tab the
 * share started from, so a share without one has neither; Print is a page's, so a selection's
 * text and an image have none. QR code draws the link, so only a link has it, and Chrome hides it
 * in incognito: a private tab's share has none.
 */
export function sharePanelChips(request: SharePanelRequest): SharePanelChip[] {
  const chips: SharePanelChip[] = [
    {
      kind: 'copy',
      label:
        request.kind === 'image'
          ? 'Copy image'
          : request.kind === 'text'
            ? 'Copy text'
            : 'Copy link',
      icon: Copy
    }
  ]
  if (request.tabId) {
    chips.push({ kind: 'screenshot', label: 'Long screenshot', icon: Scan })
    if (request.kind === 'link') chips.push({ kind: 'print', label: 'Print', icon: Printer })
  }
  if (request.kind === 'link' && request.url && !request.private)
    chips.push({ kind: 'qr', label: 'QR code', icon: QrCode })
  return chips
}

/** The row's last cell: the system sheet, for every app the row has no room for. */
export const SHARE_PANEL_MORE = { label: 'More', icon: Share } as const

/**
 * The preview's two lines: the title (else the link, else the text; "Image" for a picture that
 * came without a name) over the link, else the text – whichever the title did not already say.
 */
export function sharePanelPreview(request: SharePanelRequest): { title: string; detail: string } {
  const title =
    request.title || request.url || request.text || (request.kind === 'image' ? 'Image' : '')
  let detail = ''
  if (request.url && request.url !== title) detail = request.url
  else if (request.text && request.text !== title) detail = request.text
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
