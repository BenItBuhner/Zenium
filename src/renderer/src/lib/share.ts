import { Copy, Download, Link, Mail, Share, type LucideIcon } from 'lucide-react'
import type { ShareFileInfo } from '@shared/share'
import type { ShareAnswer, ShareRequest } from '@shared/types'
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
