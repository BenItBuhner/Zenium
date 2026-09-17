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

export function BookmarkIcon({
  node,
  className
}: {
  node: BookmarkNode
  className?: string
}): JSX.Element {
  if (node.type === 'folder') return <Folder className={cn('opacity-70', className)} />
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
  return <Globe className={cn('opacity-50', className)} />
}

/** One line of the manager's list: a bookmark or a folder. */
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
      className={cn(
        'zen-squircle group relative flex select-none items-center gap-3 rounded-lg px-2.5 outline-none transition-[background,box-shadow,opacity] duration-100',
        compact ? 'h-[52px]' : 'h-11',
        selected ? 'bg-[rgb(var(--zen-accent-rgb)/0.14)]' : 'hover:bg-[var(--zen-element-bg)]',
        focused && 'shadow-[inset_0_0_0_1.5px_rgb(var(--zen-accent-rgb)/0.55)]',
        dropInto &&
          'bg-[rgb(var(--zen-accent-rgb)/0.14)] shadow-[inset_0_0_0_1.5px_rgb(var(--zen-accent-rgb)/0.7)]',
        lifted && 'opacity-40'
      )}
      onPointerDown={(e) => onPointerDown(e, node)}
      onClick={(e) => onClick(e, node)}
      onDoubleClick={(e) => onDoubleClick(e, node)}
      onAuxClick={(e) => onAuxClick(e, node)}
      onContextMenu={(e) => onContextMenu(e, node)}
    >
      <BookmarkIcon node={node} className="h-4 w-4 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        {renaming ? (
          <RenameField title={node.title} onDone={(title) => onRenamed(node, title)} />
        ) : (
          <div className="truncate text-[13px]">{nodeLabel(node)}</div>
        )}
        <div className="truncate text-[11.5px] text-[var(--zen-muted)]">{subtitle}</div>
      </div>
      {!compact && (
        <span className="w-[72px] shrink-0 text-right text-[11px] text-[var(--zen-muted)]">
          {relativeTime(node.dateAdded)}
        </span>
      )}
    </div>
  )
}
