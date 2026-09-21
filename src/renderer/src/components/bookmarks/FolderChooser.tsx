import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Folder } from 'lucide-react'
import type { BookmarkNode } from '@shared/types'
import type { BookmarkTree } from '@shared/bookmarks'
import { cmd, run } from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'
import { V2Button } from '../extensions/v2'
import { RenameField } from './RenameField'
import { useEscapeTrap } from './escape'

interface Props {
  tree: BookmarkTree
  selectedId: string
  onSelect: (id: string) => void
  /** Folders that cannot be chosen (a folder being moved, and everything below it). */
  disabled?: Set<string>
  /** Offer "New folder" (created inside the selected folder, named in place). */
  allowCreate?: boolean
  /** Escape in the tree (not while a new folder is being named): the caller puts the tree away. */
  onEscape?: () => void
  className?: string
}

/**
 * The nested folder chooser of the star bubble and the dialogs (Chrome's "Choose another
 * folder"): the folder tree in the menulist's place, as shared rows (`.zen-v2-row`, v2 draft
 * §9.21) – 32 tall, the whole row the target with the hover fill, the chosen one on
 * `--v2-selected` (§9.6), the ones that cannot be chosen at 40% (§9.30) – a 20 twisty and the
 * 16 folder glyph leading the name, each level 16 further in. The tree runs edge to edge under
 * its label (out of the form's gutter, so the rows sit where a popover's rows sit and leave the
 * ring its room, §9.20) and scrolls past eight rows; under it "New folder" as a secondary button.
 * Keyboard (§9.22): the current folder's row takes focus when the tree appears; Up and Down walk
 * the rows on screen, Right opens a folder or steps into it, Left closes one or steps out, Enter
 * or Space picks, Escape hands the tree back to the caller.
 */
export function FolderChooser({
  tree,
  selectedId,
  onSelect,
  disabled,
  allowCreate,
  onEscape,
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
    selectedRef.current?.focus()
  }, [])
  // The name being typed for a new folder takes Escape first (its own trap restores the title).
  useEscapeTrap(onEscape !== undefined && renaming === null, onEscape ?? (() => undefined))

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
      case 'Enter':
      case ' ':
        if (!disabled?.has(id)) onSelect(id)
        break
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
      <li key={node.id} role="none">
        <div
          ref={selected ? selectedRef : undefined}
          role="treeitem"
          tabIndex={selected ? 0 : -1}
          aria-selected={selected}
          aria-expanded={children.length ? open : undefined}
          aria-disabled={off || undefined}
          aria-level={depth + 1}
          data-pick-name={node.id}
          className="zen-v2-row zen-bm-pick-row"
          onClick={() => !off && onSelect(node.id)}
          onDoubleClick={() => children.length && toggle(node.id)}
        >
          <span className="zen-bm-pick-lead" style={{ paddingLeft: depth * 16 }}>
            <button
              type="button"
              tabIndex={-1}
              aria-label={open ? 'Collapse' : 'Expand'}
              className={cn('zen-bm-pick-twisty', !children.length && 'invisible')}
              onClick={(e) => {
                e.stopPropagation()
                toggle(node.id)
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <ChevronRight data-open={open || undefined} />
            </button>
            <Folder />
          </span>
          {renaming === node.id ? (
            <RenameField
              title={node.title}
              className="zen-bm-pick-rename"
              onDone={(title) => {
                if (title && title !== node.title) run('bookmark.update', { id: node.id, title })
                setRenaming(null)
                selectedRef.current?.focus()
              }}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate">{node.title}</span>
          )}
        </div>
        {open && children.length > 0 && (
          <ul role="group">{children.map((c) => renderFolder(c, depth + 1))}</ul>
        )}
      </li>
    )
  }

  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', className)}>
      <ul
        ref={treeRef}
        role="tree"
        aria-label="Folder"
        className="zen-bm-pick-tree"
        onKeyDown={onKeyDown}
      >
        {tree.roots().map((r) => renderFolder(r, 0))}
      </ul>
      {allowCreate && (
        <V2Button className="mt-3 self-start" onClick={() => void create()}>
          New folder
        </V2Button>
      )}
    </div>
  )
}
