import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { BookmarkNodeType, UIState } from '@shared/types'
import { inputToUrl } from '@shared/url'
import { isBookmarkRoot } from '@shared/bookmarks'
import { run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { closeBookmarkChrome } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { FolderField } from './FolderField'
import { useBookmarkTree } from './tree'
import { useEscapeTrap } from './escape'

const close = (): void => closeBookmarkChrome({ bookmarkEdit: null })

export interface EditRequest {
  /** The node to edit, or null to create one inside `parentId`. */
  id: string | null
  parentId: string
  type: BookmarkNodeType
}

/**
 * Chrome's "Edit bookmark" / "Add bookmark" dialog (name and URL) and, for folders, "Rename
 * folder" / "New folder" (name only). `prefill` seeds a new bookmark with the current page, as
 * "Add page…" on the bar does.
 */
export function EditBookmarkDialog({
  state,
  edit,
  prefill
}: {
  state: UIState
  edit: EditRequest
  prefill?: { title: string; url: string } | null
}): JSX.Element | null {
  const tree = useBookmarkTree(state)
  const node = edit.id ? tree.get(edit.id) : null
  const folder = edit.type === 'folder'
  const phone = useViewport().formFactor === 'phone'
  const [name, setName] = useState(node?.title ?? (folder ? 'New folder' : (prefill?.title ?? '')))
  const [url, setUrl] = useState(node?.url ?? prefill?.url ?? '')
  const [folderId, setFolderId] = useState(node?.parentId ?? edit.parentId)
  const [nested, setNested] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [])

  useEffect(() => {
    if (edit.id && !node) close()
  }, [edit.id, node])
  useEscapeTrap(!nested, close)
  if (edit.id && !node) return null

  const title = node
    ? folder
      ? 'Rename Folder'
      : 'Edit Bookmark'
    : folder
      ? 'New Folder'
      : 'Add Bookmark'
  const target = folder ? null : inputToUrl(url.trim())
  const valid = folder ? name.trim().length > 0 : Boolean(target)
  const save = (): void => {
    if (!valid) return
    if (folder) {
      const t = name.trim()
      if (node) {
        run('bookmark.update', { id: node.id, title: t })
        if (folderId !== node.parentId) run('bookmark.move', { ids: [node.id], parentId: folderId })
      } else run('bookmark.create', { parentId: folderId, title: t, type: 'folder' })
    } else if (target) {
      const t = name.trim() || target
      if (node) {
        run('bookmark.update', { id: node.id, title: t, url: target })
        if (folderId !== node.parentId) run('bookmark.move', { ids: [node.id], parentId: folderId })
      } else run('bookmark.create', { parentId: folderId, title: t, url: target, type: 'url' })
    }
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
      <form
        role="dialog"
        aria-label={title}
        className={cn(
          'zen-animate-pop zen-bm-dialog flex flex-col gap-3',
          phone ? 'mx-2 mb-[calc(8px+var(--zen-inset-bottom,0px))] w-auto flex-1' : 'w-[400px]'
        )}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close()
          }
        }}
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <h2 className="zen-bm-dialog-title">{title}</h2>
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
        {!folder && (
          <label className="zen-bm-label">
            URL
            <input
              className="zen-field"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              inputMode="url"
              placeholder="https://"
            />
          </label>
        )}
        {!(node && isBookmarkRoot(node.id)) && (
          <div className="zen-bm-label min-h-0">
            Folder
            <FolderField
              tree={tree}
              value={tree.get(folderId) ? folderId : edit.parentId}
              onChange={setFolderId}
              onNestedChange={setNested}
            />
          </div>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <button type="button" className="zen-button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="zen-button" data-variant="primary" disabled={!valid}>
            Save
          </button>
        </div>
      </form>
    </div>
  )
}
