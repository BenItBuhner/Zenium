import type { JSX } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import type { BookmarkNode, UIState } from '@shared/types'
import { isBookmarkRoot } from '@shared/bookmarks'
import { inputToUrl } from '@shared/url'
import { run } from '@renderer/lib/api'
import { closeBookmarkEditor, type BookmarkEditRequest } from '@renderer/lib/bookmarkEdit'
import type { BottomSheetHandle } from '../sheet/BottomSheet'
import { PhoneSheet } from './PhoneSheet'
import { removeWithUndo, useBookmarkTree } from './phonePanel'

/**
 * The bookmark editor on a phone (HB-16): a sheet in the frame's dialog host (`PhoneSheet`, the
 * 48 header naming it) with the name and the address as two fields, Save as the one primary
 * button and Delete beside it in the danger ink, the two splitting the footer (v2 draft §9.11).
 * It also names a folder (no address field) and creates either when the request has no id.
 * Every way out – Save, Delete, the scrim, the back gesture, Escape – slides the sheet away
 * first and clears the request once it is gone. Focus moves to the dialog itself as it opens,
 * not into a field (§9.22: the keyboard would come up with the sheet).
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

  if (gone) return null

  // Sheet titles are sentence case like the labels and buttons (v2 draft 9.1, corrected: only
  // menu items, nav categories and window titles keep Title Case).
  const title = edit.id
    ? folder
      ? 'Rename folder'
      : 'Edit bookmark'
    : folder
      ? 'New folder'
      : 'Add bookmark'

  return (
    <PhoneSheet
      name="bookmark-edit"
      title={title}
      focus="dialog"
      onClose={closeBookmarkEditor}
      contentKey={`${edit.id ?? 'new'}:${folder ? 'folder' : 'url'}:${waiting ? 'waiting' : 'ready'}`}
      handleLabel="Resize editor"
      sheetRef={sheet}
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
    </PhoneSheet>
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
  const nameId = useId()
  const urlId = useId()

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
      className="zen-phone-form"
      aria-busy={waiting}
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <div className="zen-phone-form-field">
        <label htmlFor={nameId} className="zen-phone-field-label">
          Name
        </label>
        <span className="zen-phone-field">
          <input
            id={nameId}
            value={name}
            placeholder={folder ? 'Folder name' : 'Name'}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint={folder ? 'done' : 'next'}
            disabled={waiting}
            onChange={(e) => setName(e.target.value)}
          />
        </span>
      </div>
      {!folder && (
        <div className="zen-phone-form-field">
          <label htmlFor={urlId} className="zen-phone-field-label">
            Address
          </label>
          <span className="zen-phone-field">
            <input
              id={urlId}
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
        </div>
      )}
      {/* §9.11: two peers split the width at an 8 gap, the primary trailing. */}
      <div className="zen-sheet-footer">
        {node && !isBookmarkRoot(node.id) && (
          <button type="button" className="zen-v2-button" data-danger onClick={remove}>
            Delete
          </button>
        )}
        <button type="submit" className="zen-v2-button" data-primary disabled={!valid}>
          Save
        </button>
      </div>
    </form>
  )
}
