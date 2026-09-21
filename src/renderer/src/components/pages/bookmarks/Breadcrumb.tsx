import type { JSX } from 'react'
import { ChevronRight } from 'lucide-react'
import type { BookmarkTree } from '@shared/bookmarks'
import { cn } from '@renderer/lib/utils'

/**
 * The path of the shown folder as the list's heading line (v2 §9.27, §10.1): every ancestor is
 * a 15/400 deemphasised button and a drop-into target, the chevrons between them at 69 %, and
 * the shown folder itself is the group's 15/600 `h2` (`headingId`), so the list is named by the
 * folder it shows.
 */
export function Breadcrumb({
  tree,
  folderId,
  onOpen,
  dropFolderId,
  headingId,
  className
}: {
  tree: BookmarkTree
  folderId: string
  onOpen: (id: string) => void
  dropFolderId: string | null
  headingId?: string
  className?: string
}): JSX.Element {
  const current = tree.get(folderId)
  const ancestors = current ? tree.path(folderId) : []
  return (
    <nav aria-label="Folder path" className={cn('zen-bm-crumbs', className)}>
      {ancestors.map((node) => (
        <span key={node.id} className="zen-bm-crumb-step">
          <button
            type="button"
            data-bm-drop={`into:${node.id}`}
            data-target={dropFolderId === node.id || undefined}
            className="zen-bm-crumb"
            onClick={() => onOpen(node.id)}
          >
            {node.title}
          </button>
          <ChevronRight className="zen-bm-crumb-chevron" aria-hidden />
        </span>
      ))}
      {current && (
        <h2 id={headingId} className="zen-bm-crumb zen-bm-crumb-current" aria-current="location">
          {current.title}
        </h2>
      )}
    </nav>
  )
}
