import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { UIState } from '@shared/types'
import { BOOKMARKS_BAR_ID, recentFolders } from '@shared/bookmarks'
import { run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { closeBookmarkChrome } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { FolderField } from './FolderField'
import { POPOVER_WIDTH, useScrolled, wrapTab } from './popover'
import { useBookmarkTree } from './tree'
import { useEscapeTrap } from './escape'

const close = (): void => closeBookmarkChrome({ bookmarkAllTabs: null })

/**
 * Chrome's "Bookmark all tabs": the open pages go into a new folder, named here (Chrome suggests
 * "N tabs") and placed in a folder of the user's choosing – the most recently used one first.
 * A v2 dialog (draft §9.23): a title block with the count as its description, no X; Escape,
 * the scrim and the footer close it; the name field takes focus and Tab wraps (§9.22).
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
  const dialogRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLFormElement>(null)
  const scrolled = useScrolled(bodyRef)

  useEffect(() => {
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [])
  useEscapeTrap(!nested, close)

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
        'zen-animate-in zen-bm-scrim absolute inset-0 z-50 flex',
        phone ? 'items-end' : 'items-center justify-center'
      )}
      onMouseDown={close}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-labelledby="zen-bm-all-tabs-title"
        aria-describedby="zen-bm-all-tabs-desc"
        className={cn(
          'zen-animate-pop zen-bm-dialog flex max-h-[calc(100%-24px)] flex-col',
          phone && 'mx-2 mb-[calc(8px+var(--zen-inset-bottom,0px))] w-auto flex-1'
        )}
        style={phone ? undefined : { width: POPOVER_WIDTH.form }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            if (!nested) close()
            return
          }
          wrapTab(e, dialogRef.current)
        }}
      >
        <div className="zen-bm-title-block" data-scrolled={scrolled || undefined}>
          <h2 id="zen-bm-all-tabs-title" className="zen-bm-title">
            Bookmark All Tabs
          </h2>
          <p id="zen-bm-all-tabs-desc" className="zen-bm-title-desc">
            {count === 1 ? '1 page goes into a new folder' : `${count} pages go into a new folder`}
          </p>
        </div>
        <form
          ref={bodyRef}
          className="zen-bm-popover-body zen-bm-form"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
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
          <div className="zen-bm-footer justify-end">
            <button type="button" className="zen-button" onClick={close}>
              Cancel
            </button>
            <button type="submit" className="zen-button" data-variant="primary">
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
