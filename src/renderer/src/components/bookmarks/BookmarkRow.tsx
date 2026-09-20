import type { JSX } from 'react'
import { Folder, Globe } from 'lucide-react'
import type { BookmarkNode } from '@shared/types'
import { displayUrl } from '@shared/url'
import { cn, relativeTime } from '@renderer/lib/utils'
import { RenameField } from './RenameField'
import { nodeLabel } from './tree'

export interface RowProps {
  node: BookmarkNode
  /** Folder path shown under the title while searching (results come from every folder). */
  path: string | null
  /** Direct children, for the folder subtitle. */
  childCount: number
  selected: boolean
  focused: boolean
  renaming: boolean
  /** Part of the selection being dragged: the row stays as a faded placeholder. */
  lifted: boolean
  /** A drag hovers over this folder. */
  dropInto: boolean
  compact: boolean
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>, node: BookmarkNode) => void
  onClick: (e: React.MouseEvent<HTMLDivElement>, node: BookmarkNode) => void
  onDoubleClick: (e: React.MouseEvent<HTMLDivElement>, node: BookmarkNode) => void
  onAuxClick: (e: React.MouseEvent<HTMLDivElement>, node: BookmarkNode) => void
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>, node: BookmarkNode) => void
  onRenamed: (node: BookmarkNode, title: string) => void
}

/**
 * A bookmark's glyph: its favicon, else the globe; a folder's the folder. `strokeWidth` is the
 * surface's: the bookmarks bar draws its 16 glyphs at the toolbar stroke (v2 draft §9.3,
 * `TOOLBAR_STROKE`) while the manager's page rows keep the icon's default.
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
    return <Folder className={cn('opacity-70', className)} strokeWidth={strokeWidth} />
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
  return <Globe className={cn('opacity-50', className)} strokeWidth={strokeWidth} />
}

/** One line of the manager's list: a bookmark or a folder, its URL or size under the name. */
export function BookmarkRow({
  node,
  path,
  childCount,
  selected,
  focused,
  renaming,
  lifted,
  dropInto,
  compact,
  onPointerDown,
  onClick,
  onDoubleClick,
  onAuxClick,
  onContextMenu,
  onRenamed
}: RowProps): JSX.Element {
  const subtitle =
    path ??
    (node.type === 'url'
      ? displayUrl(node.url ?? '')
      : childCount === 0
        ? 'Empty'
        : `${childCount} ${childCount === 1 ? 'item' : 'items'}`)
  return (
    <div
      id={`bm-row-${node.id}`}
      role="option"
      aria-selected={selected}
      data-bm-id={node.id}
      data-bm-drop={`row:${node.id}`}
      data-focused={focused || undefined}
      data-target={dropInto || undefined}
      data-lifted={lifted || undefined}
      className="zen-bm-row group"
      onPointerDown={(e) => onPointerDown(e, node)}
      onClick={(e) => onClick(e, node)}
      onDoubleClick={(e) => onDoubleClick(e, node)}
      onAuxClick={(e) => onAuxClick(e, node)}
      onContextMenu={(e) => onContextMenu(e, node)}
    >
      <BookmarkIcon node={node} className="zen-bm-row-icon" />
      <div className="flex min-w-0 flex-1 flex-col">
        {renaming ? (
          <div className="flex h-5 items-center">
            <RenameField title={node.title} onDone={(title) => onRenamed(node, title)} />
          </div>
        ) : (
          <div className="zen-bm-row-title">{nodeLabel(node)}</div>
        )}
        <div className="zen-bm-row-desc">{subtitle}</div>
      </div>
      {!compact && <span className="zen-bm-row-meta">{relativeTime(node.dateAdded)}</span>}
    </div>
  )
}
