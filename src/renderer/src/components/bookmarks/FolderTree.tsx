import type { JSX } from 'react'
import { useState } from 'react'
import { ChevronRight, Folder, FolderOpen } from 'lucide-react'
import type { BookmarkNode } from '@shared/types'
import type { BookmarkTree } from '@shared/bookmarks'
import { cn } from '@renderer/lib/utils'

interface Props {
  tree: BookmarkTree
  currentId: string
  onOpen: (id: string) => void
  onContextMenu: (id: string, e: React.MouseEvent) => void
  /** Folder a drag is about to drop into (highlighted). */
  dropFolderId: string | null
  className?: string
}

/** The manager's left pane: folders only, roots first, the shown folder highlighted. */
export function FolderTree({
  tree,
  currentId,
  onOpen,
  onContextMenu,
  dropFolderId,
  className
}: Props): JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const path = new Set(tree.path(currentId).map((n) => n.id))

  const toggle = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const renderFolder = (node: BookmarkNode, depth: number): JSX.Element => {
    const children = tree.children(node.id).filter((c) => c.type === 'folder')
    // Ancestors of the shown folder stay open so it is always visible.
    const open = !collapsed.has(node.id) || path.has(node.id)
    const current = node.id === currentId
    const Icon = current ? FolderOpen : Folder
    return (
      <li key={node.id}>
        <div
          role="treeitem"
          aria-selected={current}
          aria-expanded={children.length ? open : undefined}
          data-bm-drop={`into:${node.id}`}
          className={cn(
            'zen-squircle flex h-8 items-center gap-0.5 rounded-lg pr-2 text-[13px] transition-[background,box-shadow] duration-100',
            current ? 'bg-[var(--zen-element-bg-active)]' : 'hover:bg-[var(--zen-element-bg)]',
            dropFolderId === node.id &&
              'bg-[rgb(var(--zen-accent-rgb)/0.14)] shadow-[inset_0_0_0_1.5px_rgb(var(--zen-accent-rgb)/0.7)]'
          )}
          style={{ paddingLeft: 2 + depth * 14 }}
          onContextMenu={(e) => onContextMenu(node.id, e)}
        >
          <button
            type="button"
            tabIndex={-1}
            aria-label={open ? 'Collapse' : 'Expand'}
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:opacity-100',
              !children.length && 'invisible'
            )}
            onClick={(e) => {
              e.stopPropagation()
              toggle(node.id)
            }}
          >
            <ChevronRight
              className={cn('h-3.5 w-3.5 transition-transform duration-150', open && 'rotate-90')}
            />
          </button>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
            onClick={() => onOpen(node.id)}
          >
            <Icon className="h-4 w-4 shrink-0 opacity-70" />
            <span className="truncate">{node.title}</span>
          </button>
        </div>
        {open && children.length > 0 && <ul>{children.map((c) => renderFolder(c, depth + 1))}</ul>}
      </li>
    )
  }

  return (
    <ul role="tree" aria-label="Folders" className={cn('flex flex-col gap-px', className)}>
      {tree.roots().map((r) => renderFolder(r, 0))}
    </ul>
  )
}
