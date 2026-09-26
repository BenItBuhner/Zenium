import { useEffect } from 'react'
import { Copy, Download, Link, Mail, Share, type LucideIcon } from 'lucide-react'
import type { ShareFileInfo } from '@shared/share'
import type { ShareAnswer, ShareRequest, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { createStore } from '@renderer/lib/store'
import { formatBytes } from '@renderer/lib/utils'

export interface ShareTarget {
  answer: ShareAnswer
  label: string
  description?: string
  icon: LucideIcon
}

/**
 * The one picture a share carries, when that is all it carries (a capture's Share, a page's
 * `navigator.share({ files: [png] })` with no link or text beside it): Copy is "Copy image"
 * then, and the core's answer puts the picture itself on the clipboard (`shareImage` in
 * `core/share.ts` is the same rule over the bytes).
 */
export function sharedImage(
  request: Pick<ShareRequest, 'files' | 'url' | 'text'>
): ShareFileInfo | null {
  if (request.url || request.text || request.files.length !== 1) return null
  const [file] = request.files
  return /^image\//i.test(file.type) ? file : null
}

/**
 * The targets a share offers, in Chrome's order: copy, QR (drawn above), email, save, the OS's.
 * Email carries the share's link or text in a `mailto:` and so is offered only when there is
 * one to carry – a share of files alone has nothing a mail could take. Save's description is
 * the files' size alone: the preview above names the file, and a screenshot's name beside its
 * size wrapped the row to three lines (pr-543 F5); the row stays the two-line 52.
 */
export function shareTargets(request: ShareRequest): ShareTarget[] {
  const image = sharedImage(request)
  const targets: ShareTarget[] = [
    {
      answer: 'copy',
      label: image ? 'Copy image' : request.url ? 'Copy link' : 'Copy text',
      icon: image ? Copy : Link
    }
  ]
  if (request.url || request.text) targets.push({ answer: 'email', label: 'Email', icon: Mail })
  const files = request.files.length
  if (files > 0) {
    const size = request.files.reduce((sum, f) => sum + f.size, 0)
    targets.push({
      answer: 'save',
      label: files === 1 ? 'Save file' : `Save ${files} files`,
      description: formatBytes(size),
      icon: Download
    })
  } else if (request.imageUrl) {
    targets.push({ answer: 'save', label: 'Save image', icon: Download })
  }
  if (request.system) targets.push({ answer: 'system', label: 'More…', icon: Share })
  return targets
}

/**
 * The address pill's Share chip and the popover it opened (W8-6; the desktop pill's hover-only
 * chip beside Copy URL – Chrome's desktop omnibox carries no share page action any more, its
 * sharing hub is the app menu's, so the chip is the house's seat for `share.open` in the pill).
 * The chip is pressed before the core's request has come back in the state, so the mark is
 * kept here: the tab whose page the chip asked to share, then the request the core raised for
 * it once one has (`requestId`), cleared when that request leaves or the tab is no longer the
 * pill's. The chip reads it for its `aria-expanded` and for the `data-share-anchor` mark the
 * popover hangs from (§9.20: a popover hangs from what opened it); a share a page
 * (`navigator.share`) or a menu raised leaves the mark off and the popover on the pill.
 */
export const shareChip = createStore<{ tabId: string | null; requestId: string | null }>(
  { tabId: null, requestId: null },
  'shareChip'
)

/** The chip's press: mark the tab, then ask the core to share its page. */
export function openShareFromChip(tabId: string): void {
  shareChip.set({ tabId, requestId: null })
  run('share.open', { tabId })
}

/** The share of `tabId`'s own page standing in the state (the menu's or the chip's, not a site's). */
function pageShareRequest(
  state: Pick<UIState, 'shareRequests'>,
  tabId: string
): ShareRequest | null {
  return (state.shareRequests ?? []).find((r) => r.tabId === tabId && r.origin === null) ?? null
}

/**
 * Whether the pill's Share chip for `tabId` has its popover up: the request the chip raised is
 * the one the share layer shows (`shareRequests[0]`). Adopts the request as it arrives and
 * clears the mark once it has gone, or once the pill shows another tab.
 */
export function useShareChip(state: Pick<UIState, 'shareRequests'>, tabId: string | null): boolean {
  const mark = shareChip.use((s) => s)
  const request = tabId ? pageShareRequest(state, tabId) : null
  useEffect(() => {
    if (mark.tabId === null) return
    if (mark.tabId !== tabId) {
      shareChip.set({ tabId: null, requestId: null })
      return
    }
    if (mark.requestId === null) {
      if (request) shareChip.set({ tabId, requestId: request.id })
      return
    }
    if (!request || request.id !== mark.requestId) shareChip.set({ tabId: null, requestId: null })
  }, [mark, tabId, request])
  const shown = (state.shareRequests ?? [])[0]
  return Boolean(
    tabId !== null &&
    mark.tabId === tabId &&
    mark.requestId !== null &&
    shown !== undefined &&
    shown.id === mark.requestId
  )
}

/**
 * What the sheet is sharing, for its preview: the title (else the link, else the text) and under
 * it the link, else the text – whichever the title did not already say.
 */
export function sharePreview(request: ShareRequest): { title: string; detail: string } {
  const title = request.title || request.url || request.text
  let detail = ''
  if (request.url && request.url !== title) detail = request.url
  else if (request.text && request.text !== title) detail = request.text
  return { title, detail }
}
