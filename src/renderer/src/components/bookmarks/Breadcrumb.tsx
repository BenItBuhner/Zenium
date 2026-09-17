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
      className={cn('flex min-w-0 items-center gap-0.5 overflow-x-auto text-[13px]', className)}
    >
      {segments.map((node, i) => {
        const last = i === segments.length - 1
        return (
          <span
            key={node.id}
            className="flex min-w-0 shrink-0 items-center gap-0.5 last:min-w-0 last:shrink"
          >
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-40" />}
            <button
              type="button"
              data-bm-drop={last ? undefined : `into:${node.id}`}
              aria-current={last ? 'location' : undefined}
              disabled={last}
              className={cn(
                'zen-squircle max-w-[220px] truncate rounded-md px-1.5 py-0.5 transition-[background,box-shadow] duration-100',
                last
                  ? 'font-semibold'
                  : 'text-[var(--zen-muted)] hover:bg-[var(--zen-element-bg)] hover:text-[var(--zen-fg)]',
                dropFolderId === node.id &&
                  'bg-[rgb(var(--zen-accent-rgb)/0.14)] text-[var(--zen-fg)] shadow-[inset_0_0_0_1.5px_rgb(var(--zen-accent-rgb)/0.7)]'
              )}
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
