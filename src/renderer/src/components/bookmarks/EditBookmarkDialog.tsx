import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { BookmarkNodeType, UIState } from '@shared/types'
import { inputToUrl } from '@shared/url'
import { isBookmarkRoot } from '@shared/bookmarks'
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
 * Chrome's "Edit bookmark" / "Add bookmark" dialog (name and URL) and, for folders, "Rename
 * folder" / "New folder" (name only). `prefill` seeds a new bookmark with the current page, as
 * "Add page…" on the bar does. The star bubble's form on the dialog chassis (v2 draft §9.20,
 * §9.23): a v2 dialog at the form width, 400, on a frame dialog host (TabDialogs, or the
 * manager's own) – centred over its scrim (§9.5), the chrome inert, kept through its exit – with
 * a title block in sentence case and no X, the Name and URL fields (§9.12) and the folder
 * menulist (§9.13), then the §9.11 footer: Cancel, Save as the one primary, disabled while the
 * URL is not one (§9.30). Escape, the scrim and the footer close it; the name field takes focus
 * and Tab wraps (§9.22).
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
  if (gone) return null

  const title = node
    ? folder
      ? 'Rename folder'
      : 'Edit bookmark'
    : folder
      ? 'New folder'
      : 'Add bookmark'
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
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={TITLE_ID}
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
          <V2FormField id={FOLDER_ID} label="Folder">
            {(field) => (
              <FolderField
                id={field.id}
                tree={tree}
                value={tree.get(folderId) ? folderId : edit.parentId}
                onChange={setFolderId}
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
