import type { JSX } from 'react'
import { ChevronRight } from 'lucide-react'
import type { BookmarkTree } from '@shared/bookmarks'
import { cn } from '@renderer/lib/utils'

/** The path of the shown folder; every ancestor is a button and a drop target. */
export function Breadcrumb({
  tree,
  folderId,
  onOpen,
  dropFolderId,
  className
}: {
  tree: BookmarkTree
  folderId: string
  onOpen: (id: string) => void
  dropFolderId: string | null
  className?: string
}): JSX.Element {
  const current = tree.get(folderId)
  const segments = current ? [...tree.path(folderId), current] : []
  return (
    <nav
      aria-label="Folder path"
      className={cn('flex min-w-0 items-center gap-0.5 overflow-x-auto', className)}
    >
      {segments.map((node, i) => {
        const last = i === segments.length - 1
        return (
          <span
            key={node.id}
            className="flex min-w-0 shrink-0 items-center gap-0.5 last:min-w-0 last:shrink"
          >
            {i > 0 && <ChevronRight className="zen-bm-dim h-4 w-4 shrink-0" />}
            <button
              type="button"
              data-bm-drop={last ? undefined : `into:${node.id}`}
              data-target={dropFolderId === node.id || undefined}
              aria-current={last ? 'location' : undefined}
              disabled={last}
              className="zen-bm-crumb"
              onClick={() => onOpen(node.id)}
            >
              {node.title}
            </button>
          </span>
        )
      })}
    </nav>
  )
}
