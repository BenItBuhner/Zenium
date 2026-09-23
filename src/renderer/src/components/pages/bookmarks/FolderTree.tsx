import type { JSX, KeyboardEvent, MouseEvent, Ref } from 'react'
import { useCallback, useImperativeHandle, useRef, useState } from 'react'
import { ChevronRight, Folder, FolderOpen } from 'lucide-react'
import type { BookmarkNode } from '@shared/types'
import type { BookmarkTree } from '@shared/bookmarks'
import { cn } from '@renderer/lib/utils'

/** What the manager asks of the tree from outside its rows. */
export interface FolderTreeHandle {
  /**
   * Open a folder's branch – a drag held over its row (bookmarks-26) – with the tree's own fold
   * (a cut, as the twisty's is); a branch already open, or a folder with none, is left as it is.
   */
  expand: (id: string) => void
}

interface Props {
  tree: BookmarkTree
  /** The shown folder; none while a search shows every folder's matches. */
  currentId: string
  onOpen: (id: string) => void
  onContextMenu: (id: string, e: MouseEvent) => void
  /** Folder a drag is about to drop into (highlighted). */
  dropFolderId: string | null
  className?: string
  ref?: Ref<FolderTreeHandle>
}

/** Each level of the tree steps its rows this much further in (the folder chooser's step). */
const INDENT = 16

/**
 * The manager's folder column (v2 §10.5, the Settings nav's rows): folders only, the roots
 * first, each row 34 tall edge to edge in the column – a 20 twisty round a 16 chevron that turns
 * down while the folder is open, the 16 folder glyph in the deemphasised ink (the bar's chips'
 * folder), the name 15/400 – the shown folder on `--v2-nav-active` with the 3 px accent bar
 * down the column's edge, a folder a drag hovers with the drop-into outline (§9.4). The
 * ancestors of the shown folder stay open so it is always in view.
 *
 * One tab stop (§9.22, the tree pattern): the shown folder's row, or the first root's; the
 * arrows walk the visible rows, Right opens a closed folder's branch and Left closes it (or
 * steps to the parent), Enter and Space show the folder, Home and End jump.
 *
 * A drag held over a closed branch opens it (bookmarks-26, Chrome's manager): the row carries
 * `data-bm-hold` while it folds, the manager's drag hook times the hold (`HOLD_TO_OPEN_MS`) and
 * asks `expand` through the handle; the branch opens with the tree's own fold – a cut, the
 * twisty's turn its one motion (§11.3: nothing to slow under reduced motion) – and stays open
 * after the drop, as Chrome leaves it: the drag showed the user where the folder's children
 * are, and folding them back would take that away.
 */
export function FolderTree({
  tree,
  currentId,
  onOpen,
  onContextMenu,
  dropFolderId,
  className,
  ref
}: Props): JSX.Element {
  const root = useRef<HTMLUListElement>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const path = new Set(tree.path(currentId).map((n) => n.id))
  const roots = tree.roots()
  const tabStop = tree.get(currentId)?.type === 'folder' ? currentId : (roots[0]?.id ?? '')

  const toggle = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const setOpen = useCallback(
    (id: string, open: boolean): void =>
      setCollapsed((prev) => {
        if (prev.has(id) === !open) return prev
        const next = new Set(prev)
        if (open) next.delete(id)
        else next.add(id)
        return next
      }),
    []
  )
  useImperativeHandle(ref, () => ({ expand: (id) => setOpen(id, true) }), [setOpen])

  const rows = (): HTMLElement[] => [
    ...(root.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])
  ]
  const focusRow = (el: HTMLElement | undefined): void => el?.focus()

  const onKey = (
    e: KeyboardEvent<HTMLDivElement>,
    node: BookmarkNode,
    open: boolean,
    branch: boolean
  ): void => {
    const all = rows()
    const at = all.indexOf(e.currentTarget)
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        focusRow(all[at + 1])
        return
      case 'ArrowUp':
        e.preventDefault()
        focusRow(all[at - 1])
        return
      case 'Home':
        e.preventDefault()
        focusRow(all[0])
        return
      case 'End':
        e.preventDefault()
        focusRow(all[all.length - 1])
        return
      case 'ArrowRight':
        if (!branch) return
        e.preventDefault()
        if (open) focusRow(all[at + 1])
        else setOpen(node.id, true)
        return
      case 'ArrowLeft': {
        e.preventDefault()
        if (branch && open && !path.has(node.id)) {
          setOpen(node.id, false)
          return
        }
        const parent = node.parentId
          ? all.find((el) => el.dataset.bmDrop === `into:${node.parentId}`)
          : undefined
        focusRow(parent)
        return
      }
      case 'Enter':
      case ' ':
        e.preventDefault()
        onOpen(node.id)
        return
      default:
        return
    }
  }

  const renderFolder = (node: BookmarkNode, depth: number): JSX.Element => {
    const children = tree.children(node.id).filter((c) => c.type === 'folder')
    const branch = children.length > 0
    const open = !collapsed.has(node.id) || path.has(node.id)
    const current = node.id === currentId
    const Icon = current ? FolderOpen : Folder
    return (
      <li key={node.id} role="none">
        <div
          role="treeitem"
          tabIndex={node.id === tabStop ? 0 : -1}
          aria-selected={current}
          aria-expanded={branch ? open : undefined}
          aria-level={depth + 1}
          data-bm-drop={`into:${node.id}`}
          data-bm-hold={(branch && !open) || undefined}
          data-target={dropFolderId === node.id || undefined}
          className="zen-bm-tree-row"
          style={{ paddingLeft: 16 + depth * INDENT }}
          onClick={() => onOpen(node.id)}
          onContextMenu={(e) => onContextMenu(node.id, e)}
          onKeyDown={(e) => onKey(e, node, open, branch)}
        >
          <span
            className={cn('zen-bm-tree-twisty', !branch && 'zen-bm-tree-twisty-none')}
            aria-hidden
            onClick={(e) => {
              e.stopPropagation()
              if (branch) toggle(node.id)
            }}
          >
            <ChevronRight data-open={open || undefined} />
          </span>
          <Icon className="zen-bm-tree-glyph" aria-hidden />
          <span className="zen-bm-tree-label">{node.title}</span>
        </div>
        {open && branch && <ul role="group">{children.map((c) => renderFolder(c, depth + 1))}</ul>}
      </li>
    )
  }

  return (
    <ul ref={root} role="tree" aria-label="Folders" className={cn('zen-bm-tree', className)}>
      {roots.map((r) => renderFolder(r, 0))}
    </ul>
  )
}
