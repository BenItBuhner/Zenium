import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Folder, FolderPlus } from 'lucide-react'
import type { BookmarkNode } from '@shared/types'
import type { BookmarkTree } from '@shared/bookmarks'
import { cmd, run } from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'
import { RenameField } from './RenameField'

interface Props {
  tree: BookmarkTree
  selectedId: string
  onSelect: (id: string) => void
  /** Folders that cannot be chosen (a folder being moved, and everything below it). */
  disabled?: Set<string>
  /** Offer "New folder" (created inside the selected folder, named in place). */
  allowCreate?: boolean
  className?: string
}

/** The nested folder chooser of the star dialog and the edit dialog (Chrome's "Choose another folder"). */
export function FolderChooser({
  tree,
  selectedId,
  onSelect,
  disabled,
  allowCreate,
  className
}: Props): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // Roots and the ancestors of the current choice start open.
    const open = new Set(tree.roots().map((r) => r.id))
    for (const p of tree.path(selectedId)) open.add(p.id)
    return open
  })
  const [renaming, setRenaming] = useState<string | null>(null)
  const selectedRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const toggle = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const create = async (): Promise<void> => {
    const node = await cmd('bookmark.create', {
      parentId: selectedId,
      title: 'New folder',
      type: 'folder'
    })
    if (!node) return
    setExpanded((prev) => new Set(prev).add(selectedId))
    onSelect(node.id)
    setRenaming(node.id)
  }

  const renderFolder = (node: BookmarkNode, depth: number): JSX.Element => {
    const children = tree.children(node.id).filter((c) => c.type === 'folder')
    const open = expanded.has(node.id)
    const off = Boolean(disabled?.has(node.id))
    const selected = node.id === selectedId
    return (
      <li key={node.id}>
        <div
          ref={selected ? selectedRef : undefined}
          role="treeitem"
          aria-selected={selected}
          aria-expanded={children.length ? open : undefined}
          className={cn(
            'flex h-8 items-center gap-0.5 rounded-lg pr-2 text-[13px]',
            selected ? 'bg-[var(--zen-element-bg-active)]' : 'hover:bg-[var(--zen-element-bg)]',
            off && 'opacity-40'
          )}
          style={{ paddingLeft: 2 + depth * 14 }}
        >
          <button
            type="button"
            tabIndex={-1}
            aria-label={open ? 'Collapse' : 'Expand'}
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:opacity-100',
              !children.length && 'invisible'
            )}
            onClick={() => toggle(node.id)}
          >
            <ChevronRight
              className={cn('h-3.5 w-3.5 transition-transform duration-150', open && 'rotate-90')}
            />
          </button>
          <Folder className="h-4 w-4 shrink-0 opacity-70" />
          {renaming === node.id ? (
            <RenameField
              title={node.title}
              onDone={(title) => {
                if (title && title !== node.title) run('bookmark.update', { id: node.id, title })
                setRenaming(null)
              }}
            />
          ) : (
            <button
              type="button"
              disabled={off}
              className="min-w-0 flex-1 truncate py-1 text-left"
              onClick={() => onSelect(node.id)}
              onDoubleClick={() => children.length && toggle(node.id)}
            >
              {node.title}
            </button>
          )}
        </div>
        {open && children.length > 0 && <ul>{children.map((c) => renderFolder(c, depth + 1))}</ul>}
      </li>
    )
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <ul role="tree" className="min-h-0 flex-1 overflow-y-auto p-1">
        {tree.roots().map((r) => renderFolder(r, 0))}
      </ul>
      {allowCreate && (
        <button
          type="button"
          className="mt-1 flex h-8 items-center gap-2 self-start rounded-lg px-2.5 text-[12.5px] hover:bg-[var(--zen-element-bg)]"
          onClick={() => void create()}
        >
          <FolderPlus className="h-4 w-4 opacity-70" />
          New folder
        </button>
      )}
    </div>
  )
}
