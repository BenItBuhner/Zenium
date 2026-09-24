import type { JSX } from 'react'
import { Folder, Globe } from 'lucide-react'
import type { BookmarkNode } from '@shared/types'
import { cn } from '@renderer/lib/utils'

/**
 * A bookmark's glyph: its favicon, else the globe; a folder's the folder. `strokeWidth` is the
 * surface's: the bookmarks bar draws its 16 glyphs at the toolbar stroke (v2 draft §9.3,
 * `TOOLBAR_STROKE`) while the manager's page rows keep the icon's default. The folder is the
 * row's subject and takes the ink of the label it introduces – a chip's, a menu row's, a page
 * row's – never softer (§10.4); the globe stands in for a favicon the page offered none of and
 * draws at 69%, §10.4's one exception, so it reads as the absence it is beside the real
 * favicons around it. The manager's rows restate both in the page's tokens
 * (`.zen-bm-row-glyph`).
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
    return <Folder className={cn('zen-bm-glyph-folder', className)} strokeWidth={strokeWidth} />
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
    <Globe
      className={cn('zen-bm-glyph-globe opacity-[0.69]', className)}
      strokeWidth={strokeWidth}
    />
  )
}
