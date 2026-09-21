import type { JSX } from 'react'
import { Folder, Globe } from 'lucide-react'
import type { BookmarkNode } from '@shared/types'
import { cn } from '@renderer/lib/utils'

/**
 * A bookmark's glyph: its favicon, else the globe; a folder's the folder. `strokeWidth` is the
 * surface's: the bookmarks bar draws its 16 glyphs at the toolbar stroke (v2 draft §9.3,
 * `TOOLBAR_STROKE`) while the manager's page rows keep the icon's default. The folder and the
 * globe are drawn softer than a favicon – the bar's chips at 70 %, the manager's rows in the
 * page's deemphasised ink – so a folder reads as a kind, not a picture.
 */
export function BookmarkIcon({
  node,
  className,
  strokeWidth
}: {
  node: BookmarkNode
  className?: string
  strokeWidth?: number
}): JSX.Element {
  if (node.type === 'folder')
    return (
      <Folder
        className={cn('zen-bm-glyph-folder opacity-70', className)}
        strokeWidth={strokeWidth}
      />
    )
  if (node.favicon)
    return (
      <img
        src={node.favicon}
        alt=""
        draggable={false}
        referrerPolicy="no-referrer"
        className={cn('rounded-[3px]', className)}
      />
    )
  return (
    <Globe className={cn('zen-bm-glyph-globe opacity-50', className)} strokeWidth={strokeWidth} />
  )
}
