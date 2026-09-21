import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { UIState } from '@shared/types'
import { BOOKMARKS_BAR_ID, recentFolders } from '@shared/bookmarks'
import { run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import { closeBookmarkChrome } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { V2Button, V2Field, V2FormField, V2TitleBlock } from '../extensions/v2'
import { FolderField } from './FolderField'
import { useScrolled, wrapTab } from './popover'
import { useBookmarkTree } from './tree'
import { useEscapeTrap } from './escape'

const TITLE_ID = 'zen-bm-all-tabs-title'
const NAME_ID = 'zen-bm-all-tabs-name'
const FOLDER_ID = 'zen-bm-all-tabs-folder'

const close = (): void => closeBookmarkChrome({ bookmarkAllTabs: null })

/**
 * Chrome's "Bookmark all tabs": the open pages go into a new folder, named here (Chrome suggests
 * "N tabs") and placed in a folder of the user's choosing – the most recently used one first.
 * A v2 dialog (draft §9.20, §9.23) at the form width, 400, on the frame dialog host TabDialogs
 * mounts – centred over its scrim (§9.5), the chrome inert, kept through its exit – with a title
 * block ("Bookmark all tabs", the count as its description, no X), the Name field (§9.12) and
 * the folder menulist (§9.13), then the §9.11 footer: Cancel, Save as the one primary. Escape,
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
  useFrameDialog({ onScrimPress: close })

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
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={TITLE_ID}
      aria-describedby={`${TITLE_ID}-desc`}
      className={cn(
        'zen-v2 zen-animate-pop flex max-h-[calc(100%-24px)] flex-col',
        phone
          ? 'zen-bm-dialog mx-2 mb-[calc(8px+var(--zen-inset-bottom,0px))] w-auto self-end justify-self-stretch'
          : 'zen-v2-dialog'
      )}
      style={phone ? undefined : { width: POPOVER_WIDTH.form }}
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
      <V2TitleBlock
        id={TITLE_ID}
        title="Bookmark all tabs"
        description={
          count === 1 ? '1 page goes into a new folder' : `${count} pages go into a new folder`
        }
        descriptionId={`${TITLE_ID}-desc`}
        scrolled={scrolled}
      />
      <form
        ref={bodyRef}
        className="zen-bm-popover-body zen-bm-form"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <V2FormField id={NAME_ID} label="Name">
          {(field) => (
            <V2Field
              {...field}
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          )}
        </V2FormField>
        <V2FormField id={FOLDER_ID} label="Folder">
          {(field) => (
            <FolderField
              id={field.id}
              tree={tree}
              value={parentId}
              onChange={setChosenId}
              onNestedChange={setNested}
            />
          )}
        </V2FormField>
        <div className="zen-bm-footer justify-end">
          <V2Button onClick={close}>Cancel</V2Button>
          <V2Button type="submit" variant="primary">
            Save
          </V2Button>
        </div>
      </form>
    </div>
  )
}
