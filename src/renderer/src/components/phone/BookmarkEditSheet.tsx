import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { BookmarkNode, UIState } from '@shared/types'
import { isBookmarkRoot } from '@shared/bookmarks'
import { inputToUrl } from '@shared/url'
import { run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { closeBookmarkEditor, type BookmarkEditRequest } from '@renderer/lib/bookmarkEdit'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { removeWithUndo, useBookmarkTree } from './phonePanel'

/**
 * The bookmark editor on a phone (HB-16): a bottom sheet with the name and the address as two
 * fields, Save as the one primary button and Delete beside it in the danger ink. It also names
 * a folder (no address field) and creates either when the request has no id. Every way out –
 * Save, Delete, the scrim, the back gesture, Escape – slides the sheet away first and clears
 * the request once it is gone.
 *
 * A request for a node that has not reached the renderer yet (the star's event can overtake
 * the state push) keeps the sheet open with its fields waiting; only a node that was here and
 * then went (deleted elsewhere, or a delete that went through) closes it.
 */
export function BookmarkEditSheet({
  state,
  edit
}: {
  state: UIState
  edit: BookmarkEditRequest
}): JSX.Element | null {
  const tree = useBookmarkTree(state)
  const node = edit.id ? (tree.get(edit.id) ?? null) : null
  // Whether the node has been here during this editor's life (derived from the props as they go by).
  const [seen, setSeen] = useState(node !== null)
  if (node && !seen) setSeen(true)
  const gone = edit.id !== null && !node && seen
  const waiting = edit.id !== null && !node && !seen
  const folder = (node?.type ?? edit.type) === 'folder'
  const sheet = useRef<BottomSheetHandle>(null)

  useEffect(() => {
    if (gone) closeBookmarkEditor()
  }, [gone])

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

  if (gone) return null

  // A dialog title is Title Case (v2 draft 9.1); the labels and buttons below stay sentence case.
  const title = edit.id
    ? folder
      ? 'Rename Folder'
      : 'Edit Bookmark'
    : folder
      ? 'New Folder'
      : 'Add Bookmark'

  return (
    <BottomSheet
      ref={sheet}
      onDismissed={closeBookmarkEditor}
      contentKey={`${edit.id ?? 'new'}:${folder ? 'folder' : 'url'}:${waiting ? 'waiting' : 'ready'}`}
      handleLabel="Resize editor"
      className="zen-phone-editor"
      header={
        <div className="zen-phone-sheet-header">
          <span className="zen-phone-sheet-title">{title}</span>
        </div>
      }
    >
      <EditorForm
        // Remounts when the node arrives, so the fields start from its title and address.
        key={node ? node.id : edit.id ? 'waiting' : 'new'}
        node={node}
        parentId={node?.parentId ?? edit.parentId}
        folder={folder}
        waiting={waiting}
        dismiss={(then) => sheet.current?.dismiss(then)}
      />
    </BottomSheet>
  )
}

function EditorForm({
  node,
  parentId,
  folder,
  waiting,
  dismiss
}: {
  node: BookmarkNode | null
  parentId: string
  folder: boolean
  /** The node was asked for but is not here yet. */
  waiting: boolean
  dismiss: (then?: () => void) => void
}): JSX.Element {
  const [name, setName] = useState(node?.title ?? '')
  const [url, setUrl] = useState(node?.url ?? '')

  const target = folder ? null : inputToUrl(url.trim())
  const valid = !waiting && (folder ? name.trim().length > 0 : target !== null)

  const save = (): void => {
    const trimmed = name.trim()
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
    dismiss(commit)
  }

  const remove = (): void => {
    if (!node || isBookmarkRoot(node.id)) return
    const id = node.id
    dismiss(() =>
      removeWithUndo([id], folder ? 'Folder deleted' : 'Bookmark deleted', () =>
        run('bookmark.remove', { ids: [id] })
      )
    )
  }

  return (
    <form
      className="flex flex-col gap-3 px-1 pb-2"
      aria-busy={waiting}
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
            disabled={waiting}
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
              disabled={waiting}
              onChange={(e) => setUrl(e.target.value)}
            />
          </span>
        </label>
      )}
      <div className="mt-1 flex gap-2">
        {node && !isBookmarkRoot(node.id) && (
          <button
            type="button"
            className="zen-sheet-button zen-v2-sheet-button shrink-0"
            data-variant="danger"
            onClick={remove}
          >
            Delete
          </button>
        )}
        <button
          type="submit"
          className="zen-sheet-button zen-v2-sheet-button flex-1"
          data-variant="primary"
          disabled={!valid}
        >
          Save
        </button>
      </div>
    </form>
  )
}
