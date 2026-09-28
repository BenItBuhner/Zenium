import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { BookmarkNodeType, UIState } from '@shared/types'
import { inputToUrl } from '@shared/url'
import { isBookmarkRoot } from '@shared/bookmarks'
import { run } from '@renderer/lib/api'
import { POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import { closeBookmarkChrome } from '@renderer/lib/ui'
import { V2Button, V2Field, V2FormField, V2TitleBlock } from '../extensions/v2'
import { FolderField } from './FolderField'
import { useScrolled, wrapTab } from './popover'
import { forbiddenTargets, useBookmarkTree } from './tree'
import { useEscapeTrap } from './escape'

const TITLE_ID = 'zen-bm-edit-title'
const NAME_ID = 'zen-bm-edit-name'
const URL_ID = 'zen-bm-edit-url'
const FOLDER_ID = 'zen-bm-edit-folder'

const close = (): void => closeBookmarkChrome({ bookmarkEdit: null })

export interface EditRequest {
  /** The node to edit, or null to create one inside `parentId`. */
  id: string | null
  parentId: string
  type: BookmarkNodeType
}

/**
 * Chrome's "Edit bookmark" / "Add bookmark" dialog (name, URL and the folder) and the folder's
 * own editor, "Edit folder" / "New folder" (name and the parent folder). One object on both
 * hosts, as the phone's `BookmarkEditSheet`: a folder's editor moves the folder as well as
 * renaming it, so it is titled "Edit folder" (Chrome 152's `IDS_EDIT_FOLDER`, the phone's word)
 * and its folder row reads "Parent folder" (Chrome's `BookmarkEditActivity`; the phone's pair),
 * "Folder" on a bookmark's – the house owns the move here where Chrome desktop's Rename… dialog
 * is name-only (W8-F13, the lead's ruling on the HB-16 twin brief). The folder being edited and
 * every folder below it are `FolderField`'s `disabled` set (the core's own rule: `move` refuses
 * a folder into itself or its subtree, `core/bookmarks.ts`) – absent from the recent list, at
 * §9.30's 40 % and unpickable in the chooser; a pick that lands in the set anyway falls back to
 * the folder's present parent, so Save never asks for a move the core would refuse. `prefill`
 * seeds a new bookmark with the current page, as "Add page…" on the bar does. The star
 * bubble's form on the dialog chassis (v2 draft §9.20, §9.23): a v2 dialog at the form width,
 * 400, on a frame dialog host (TabDialogs, or the manager's own) – centred over its scrim (§9.5),
 * the chrome inert, kept through its exit – with a title block in sentence case and no X, the
 * Name and URL fields (§9.12) and the folder menulist (§9.13), then the §9.11 footer: Cancel,
 * Save as the one primary, disabled while the URL is not one (§9.30). Escape, the scrim and the
 * footer close it; the name field takes focus and Tab wraps (§9.22). A phone never mounts it:
 * every edit there is the editor sheet (`BookmarkEditSheet`, TabDialogs); a tablet mounts this
 * one, so its words are Android-visible too.
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
  const [name, setName] = useState(node?.title ?? (folder ? 'New folder' : (prefill?.title ?? '')))
  const [url, setUrl] = useState(node?.url ?? prefill?.url ?? '')
  const [folderId, setFolderId] = useState(node?.parentId ?? edit.parentId)
  const [nested, setNested] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLFormElement>(null)
  const scrolled = useScrolled(bodyRef)

  useEffect(() => {
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [])

  const gone = Boolean(edit.id) && !node
  useEffect(() => {
    if (gone) close()
  }, [gone])
  useEscapeTrap(!nested, close)
  useFrameDialog({ onScrimPress: close, active: !gone })
  // The folder being edited and every folder below it: where it cannot go (`forbiddenTargets`,
  // the bar's and the manager's drag rule; the core's `move` refuses the same set).
  const excluded = useMemo(
    () => (node?.type === 'folder' ? forbiddenTargets(tree, [node.id]) : new Set<string>()),
    [node, tree]
  )
  if (gone) return null

  const title = node
    ? folder
      ? 'Edit folder'
      : 'Edit bookmark'
    : folder
      ? 'New folder'
      : 'Add bookmark'
  // The folder Save files into: the pick while it stands and can be entered, else the node's
  // own parent (or the request's) – a pick that went (deleted meanwhile) or one inside the
  // excluded set, which no real tree produces but nothing here relies on.
  const chosen =
    tree.get(folderId) && !excluded.has(folderId) ? folderId : (node?.parentId ?? edit.parentId)
  const target = folder ? null : inputToUrl(url.trim())
  const valid = folder ? name.trim().length > 0 : Boolean(target)
  const save = (): void => {
    if (!valid) return
    if (folder) {
      const t = name.trim()
      if (node) {
        run('bookmark.update', { id: node.id, title: t })
        if (chosen !== node.parentId) run('bookmark.move', { ids: [node.id], parentId: chosen })
      } else run('bookmark.create', { parentId: chosen, title: t, type: 'folder' })
    } else if (target) {
      const t = name.trim() || target
      if (node) {
        run('bookmark.update', { id: node.id, title: t, url: target })
        if (chosen !== node.parentId) run('bookmark.move', { ids: [node.id], parentId: chosen })
      } else run('bookmark.create', { parentId: chosen, title: t, url: target, type: 'url' })
    }
    close()
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={TITLE_ID}
      className="zen-v2 zen-v2-dialog zen-animate-pop flex max-h-[calc(100%-24px)] flex-col"
      style={{ width: POPOVER_WIDTH.form }}
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
      <V2TitleBlock id={TITLE_ID} title={title} scrolled={scrolled} />
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
        {!folder && (
          <V2FormField id={URL_ID} label="URL">
            {(field) => (
              <V2Field
                {...field}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                inputMode="url"
                placeholder="https://"
              />
            )}
          </V2FormField>
        )}
        {!(node && isBookmarkRoot(node.id)) && (
          <V2FormField id={FOLDER_ID} label={folder ? 'Parent folder' : 'Folder'}>
            {(field) => (
              <FolderField
                id={field.id}
                label={folder ? 'Parent folder' : 'Folder'}
                tree={tree}
                value={chosen}
                onChange={setFolderId}
                disabled={excluded}
                onNestedChange={setNested}
              />
            )}
          </V2FormField>
        )}
        <div className="zen-bm-footer justify-end">
          <V2Button onClick={close}>Cancel</V2Button>
          <V2Button type="submit" variant="primary" disabled={!valid}>
            Save
          </V2Button>
        </div>
      </form>
    </div>
  )
}
