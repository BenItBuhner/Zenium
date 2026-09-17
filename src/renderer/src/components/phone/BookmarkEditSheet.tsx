import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { UIState } from '@shared/types'
import { isBookmarkRoot } from '@shared/bookmarks'
import { inputToUrl } from '@shared/url'
import { run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { closeBookmarkEditor, type BookmarkEditRequest } from '@renderer/lib/bookmarkEdit'
import { useBookmarkTree } from '../bookmarks/tree'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { removeWithUndo } from './phonePanel'

/**
 * The bookmark editor on a phone (HB-16; design-language 8.1, 8.3, 8.6): a bottom sheet with
 * the name and the address as two fields, Save as the one primary button and Delete beside it
 * in the danger ink. It also names a folder (no address field) and creates either when the
 * request has no id. Every way out – Save, Delete, the scrim, the back gesture, Escape – slides
 * the sheet away first and clears the request once it is gone.
 */
export function BookmarkEditSheet({
  state,
  edit
}: {
  state: UIState
  edit: BookmarkEditRequest
}): JSX.Element | null {
  const tree = useBookmarkTree(state)
  const node = edit.id ? tree.get(edit.id) : null
  const folder = edit.type === 'folder'
  const [name, setName] = useState(node?.title ?? '')
  const [url, setUrl] = useState(node?.url ?? '')
  const sheet = useRef<BottomSheetHandle>(null)

  // Removed while open (another window, sync, or a delete that went through): nothing to edit.
  useEffect(() => {
    if (edit.id && !node) closeBookmarkEditor()
  }, [edit.id, node])

  useBackSurface({
    name: 'bookmark-edit',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      sheet.current?.dismiss()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  if (edit.id && !node) return null

  const target = folder ? null : inputToUrl(url.trim())
  const valid = folder ? name.trim().length > 0 : target !== null
  const title = node
    ? folder
      ? 'Rename folder'
      : 'Edit bookmark'
    : folder
      ? 'New folder'
      : 'Add bookmark'

  const save = (): void => {
    const trimmed = name.trim()
    const { parentId } = edit
    let commit: () => void
    if (folder) {
      if (!trimmed) return
      commit = node
        ? () => run('bookmark.update', { id: node.id, title: trimmed })
        : () => run('bookmark.create', { parentId, title: trimmed, type: 'folder' })
    } else {
      if (!target) return
      const address = target
      const label = trimmed || address
      commit = node
        ? () => run('bookmark.update', { id: node.id, title: label, url: address })
        : () => run('bookmark.create', { parentId, title: label, url: address, type: 'url' })
    }
    // The command runs once the sheet is gone, like a picked menu row (see `pickMenuItem`).
    sheet.current?.dismiss(commit)
  }

  const remove = (): void => {
    if (!node || isBookmarkRoot(node.id)) return
    const id = node.id
    sheet.current?.dismiss(() =>
      removeWithUndo([id], folder ? 'Folder deleted' : 'Bookmark deleted', () =>
        run('bookmark.remove', { ids: [id] })
      )
    )
  }

  return (
    <BottomSheet
      ref={sheet}
      onDismissed={closeBookmarkEditor}
      contentKey={`${edit.id ?? 'new'}:${edit.type}`}
      handleLabel="Resize editor"
      header={
        <div className="flex h-9 items-center">
          <span className="zen-title min-w-0 flex-1 truncate px-3">{title}</span>
        </div>
      }
    >
      <form
        className="flex flex-col gap-3 px-1 pb-2 pt-1"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="zen-field-label px-2">Name</span>
          <span className="zen-field">
            <input
              value={name}
              placeholder={folder ? 'Folder name' : 'Name'}
              autoComplete="off"
              spellCheck={false}
              enterKeyHint={folder ? 'done' : 'next'}
              onChange={(e) => setName(e.target.value)}
            />
          </span>
        </label>
        {!folder && (
          <label className="flex flex-col gap-1.5">
            <span className="zen-field-label px-2">Address</span>
            <span className="zen-field">
              <input
                value={url}
                placeholder="https://"
                inputMode="url"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                enterKeyHint="done"
                onChange={(e) => setUrl(e.target.value)}
              />
            </span>
          </label>
        )}
        <div className="mt-1 flex gap-2">
          {node && !isBookmarkRoot(node.id) && (
            <button
              type="button"
              className="zen-sheet-button shrink-0"
              data-variant="danger"
              onClick={remove}
            >
              Delete
            </button>
          )}
          <button
            type="submit"
            className="zen-sheet-button flex-1"
            data-variant="primary"
            disabled={!valid}
          >
            Save
          </button>
        </div>
      </form>
    </BottomSheet>
  )
}
