import { Download, Link, Mail, Share, type LucideIcon } from 'lucide-react'
import type { ShareAnswer, ShareRequest } from '@shared/types'
import { formatBytes } from '@renderer/lib/utils'

export interface ShareTarget {
  answer: ShareAnswer
  label: string
  description?: string
  icon: LucideIcon
}

/** The targets a share offers, in Chrome's order: copy, QR (drawn above), email, save, the OS's. */
export function shareTargets(request: ShareRequest): ShareTarget[] {
  const targets: ShareTarget[] = [
    {
      answer: 'copy',
      label: request.url ? 'Copy link' : 'Copy text',
      icon: Link
    },
    { answer: 'email', label: 'Email', icon: Mail }
  ]
  const files = request.files.length
  if (files > 0) {
    const size = request.files.reduce((sum, f) => sum + f.size, 0)
    targets.push({
      answer: 'save',
      label: files === 1 ? 'Save file' : `Save ${files} files`,
      description: `${files === 1 ? request.files[0].name : `${files} files`} · ${formatBytes(size)}`,
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
