import type { JSX, MouseEvent, PointerEvent } from 'react'
import { EllipsisVertical } from 'lucide-react'
import type { BookmarkNode } from '@shared/types'
import { displayUrl } from '@shared/url'
import { relativeTime } from '@renderer/lib/utils'
import { BookmarkIcon } from '../../bookmarks/BookmarkIcon'
import { RenameField } from '../../bookmarks/RenameField'
import { nodeLabel } from '../../bookmarks/tree'

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
  onPointerDown: (e: PointerEvent<HTMLLIElement>, node: BookmarkNode) => void
  onClick: (e: MouseEvent<HTMLLIElement>, node: BookmarkNode) => void
  onDoubleClick: (e: MouseEvent<HTMLLIElement>, node: BookmarkNode) => void
  onAuxClick: (e: MouseEvent<HTMLLIElement>, node: BookmarkNode) => void
  onContextMenu: (e: MouseEvent<HTMLLIElement>, node: BookmarkNode) => void
  /** The row's ⋮: the context menu, anchored to the button. */
  onMenu: (e: MouseEvent<HTMLButtonElement>, node: BookmarkNode) => void
  onRenamed: (node: BookmarkNode, title: string) => void
}

/**
 * One row of the manager's list (v2 §9.21, the shared two-line page row): the bookmark's 16
 * favicon or the folder glyph on the first text line, its name 15/20 (or the rename field in
 * its place, §9.12) over its URL – the folder path while searching, "N items" for a folder –
 * 13/20 deemphasised, when it was added at the trailing edge, and the ⋮ that shows on approach
 * and opens the row's menu. The row is the listbox's option: picked on `--v2-selected` (§9.6),
 * the keyboard's cursor ringed while the list has the focus, a drop-into target outlined
 * (§9.4), faded while it travels under the pointer.
 */
export function BookmarkRow({
  node,
  path,
  childCount,
  selected,
  focused,
  renaming,
  lifted,
  dropInto,
  onPointerDown,
  onClick,
  onDoubleClick,
  onAuxClick,
  onContextMenu,
  onMenu,
  onRenamed
}: RowProps): JSX.Element {
  const label = nodeLabel(node)
  const subtitle =
    path ??
    (node.type === 'url'
      ? displayUrl(node.url ?? '')
      : childCount === 0
        ? 'Empty'
        : `${childCount} ${childCount === 1 ? 'item' : 'items'}`)
  return (
    <li
      id={`bm-row-${node.id}`}
      role="option"
      aria-selected={selected}
      data-bm-id={node.id}
      data-bm-drop={`row:${node.id}`}
      data-selected={selected || undefined}
      data-focused={focused || undefined}
      data-target={dropInto || undefined}
      data-lifted={lifted || undefined}
      className="zen-v2-row zen-page-row zen-bm-row"
      title={node.type === 'url' ? node.url : undefined}
      onPointerDown={(e) => onPointerDown(e, node)}
      onClick={(e) => onClick(e, node)}
      onDoubleClick={(e) => onDoubleClick(e, node)}
      onAuxClick={(e) => onAuxClick(e, node)}
      onContextMenu={(e) => onContextMenu(e, node)}
    >
      <span className="zen-page-row-lead" aria-hidden>
        <BookmarkIcon node={node} className="zen-page-row-favicon zen-bm-row-glyph" />
      </span>
      <div className="zen-page-row-text">
        {renaming ? (
          <div className="zen-bm-row-rename">
            <RenameField title={node.title} onDone={(title) => onRenamed(node, title)} />
          </div>
        ) : (
          <span className="zen-page-row-label">{label}</span>
        )}
        <span className="zen-page-row-desc">{subtitle}</span>
      </div>
      <time className="zen-page-row-time" dateTime={new Date(node.dateAdded).toISOString()}>
        {relativeTime(node.dateAdded)}
      </time>
      <button
        type="button"
        tabIndex={-1}
        className="zen-v2-icon-button zen-page-row-reveal"
        title="More actions"
        aria-label={`Actions for ${label}`}
        aria-haspopup="menu"
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onMenu(e, node)
        }}
      >
        <EllipsisVertical aria-hidden />
      </button>
    </li>
  )
}
