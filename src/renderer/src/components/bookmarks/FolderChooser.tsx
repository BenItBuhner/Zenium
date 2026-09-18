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

/**
 * The nested folder chooser of the star bubble and the dialogs (Chrome's "Choose another
 * folder"): a tree of folders in place of the menulist. Keyboard (v2 draft §9.22): the current
 * folder's row takes focus when the tree appears; Up and Down walk the rows on screen, Right
 * opens a folder or steps into it, Left closes one or steps out, Enter or Space picks.
 */
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
  const treeRef = useRef<HTMLUListElement>(null)
  const selectedRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])
  useEffect(() => {
    selectedRef.current?.querySelector<HTMLElement>('[data-pick-name]')?.focus()
  }, [])

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

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (renaming) return
    const rows = [...(treeRef.current?.querySelectorAll<HTMLElement>('[data-pick-name]') ?? [])]
    const at = rows.findIndex((r) => r === document.activeElement)
    if (at === -1) return
    const row = rows[at]
    const id = row?.dataset.pickName ?? ''
    const open = expanded.has(id)
    const hasChildren = tree.children(id).some((c) => c.type === 'folder')
    switch (e.key) {
      case 'ArrowDown':
        rows[Math.min(at + 1, rows.length - 1)]?.focus()
        break
      case 'ArrowUp':
        rows[Math.max(at - 1, 0)]?.focus()
        break
      case 'Home':
        rows[0]?.focus()
        break
      case 'End':
        rows[rows.length - 1]?.focus()
        break
      case 'ArrowRight':
        if (hasChildren && !open) toggle(id)
        else if (hasChildren) rows[at + 1]?.focus()
        break
      case 'ArrowLeft': {
        if (hasChildren && open) {
          toggle(id)
          break
        }
        const parentId = tree.get(id)?.parentId
        const parent = parentId ? rows.find((r) => r.dataset.pickName === parentId) : undefined
        parent?.focus()
        break
      }
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
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
          data-off={off || undefined}
          className="zen-bm-pick-row"
          style={{ paddingLeft: 2 + depth * 14 }}
        >
          <button
            type="button"
            tabIndex={-1}
            aria-label={open ? 'Collapse' : 'Expand'}
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] opacity-60 hover:opacity-100',
              !children.length && 'invisible'
            )}
            onClick={() => toggle(node.id)}
          >
            <ChevronRight
              className={cn('h-4 w-4 transition-transform duration-150', open && 'rotate-90')}
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
              tabIndex={selected ? 0 : -1}
              data-pick-name={node.id}
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
      <ul
        ref={treeRef}
        role="tree"
        className="min-h-0 flex-1 overflow-y-auto p-1"
        onKeyDown={onKeyDown}
      >
        {tree.roots().map((r) => renderFolder(r, 0))}
      </ul>
      {allowCreate && (
        <button type="button" className="zen-button mt-2 self-start" onClick={() => void create()}>
          <FolderPlus className="h-4 w-4" />
          New folder
        </button>
      )}
    </div>
  )
}
