import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { FolderPlus } from 'lucide-react'
import type { UIState } from '@shared/types'
import { BOOKMARKS_BAR_ID, recentFolders } from '@shared/bookmarks'
import { run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { closeBookmarkChrome } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { FolderField } from './FolderField'
import { useBookmarkTree } from './tree'

const close = (): void => closeBookmarkChrome({ bookmarkAllTabs: null })

/**
 * Chrome's "Bookmark all tabs": the open pages go into a new folder, named here (Chrome suggests
 * "N tabs") and placed in a folder of the user's choosing – the most recently used one first.
 */
export function BookmarkAllTabsDialog({
  state,
  request
}: {
  state: UIState
  request: { tabIds: string[]; defaultTitle: string }
}): JSX.Element {
  const tree = useBookmarkTree(state)
  const phone = useViewport().formFactor === 'phone'
  const [name, setName] = useState(request.defaultTitle)
  const [chosenId, setChosenId] = useState(() => recentFolders(tree, 1)[0]?.id ?? BOOKMARKS_BAR_ID)
  const [nested, setNested] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [])

  // The chosen folder went away (another window, sync): fall back to the bar.
  const parentId = tree.get(chosenId) ? chosenId : BOOKMARKS_BAR_ID

  const count = request.tabIds.length
  const save = (): void => {
    run('bookmark.createFromTabs', {
      tabIds: request.tabIds,
      title: name.trim() || request.defaultTitle,
      parentId
    })
    close()
  }

  return (
    <div
      className={cn(
        'zen-animate-in absolute inset-0 z-50 flex bg-[var(--zen-scrim)]',
        phone ? 'items-end' : 'items-center justify-center'
      )}
      onMouseDown={close}
    >
      <form
        role="dialog"
        aria-label="Bookmark all tabs"
        className={cn(
          'zen-panel zen-animate-pop zen-bm-dialog flex max-h-[calc(100%-24px)] flex-col gap-3',
          phone ? 'mx-2 mb-[calc(8px+var(--zen-inset-bottom,0px))] w-auto flex-1' : 'w-[400px]'
        )}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          e.stopPropagation()
          if (!nested) close()
        }}
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--zen-accent-rgb)/0.16)] text-[var(--zen-accent-ink)]">
            <FolderPlus className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="zen-bm-dialog-title">Bookmark all tabs</h2>
            <p className="text-[12.5px] text-[var(--zen-muted)]">
              {count === 1
                ? '1 page goes into a new folder'
                : `${count} pages go into a new folder`}
            </p>
          </div>
        </div>
        <label className="zen-bm-label">
          Name
          <input
            ref={nameRef}
            className="zen-field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <div className="zen-bm-label min-h-0">
          Folder
          <FolderField
            tree={tree}
            value={parentId}
            onChange={setChosenId}
            onNestedChange={setNested}
          />
        </div>
        <div className="mt-1 flex justify-end gap-2">
          <button type="button" className="zen-button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="zen-button" data-variant="primary">
            Save
          </button>
        </div>
      </form>
    </div>
  )
}
