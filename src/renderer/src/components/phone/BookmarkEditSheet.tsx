import type { JSX } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import type { BookmarkNode, UIState } from '@shared/types'
import { isBookmarkRoot } from '@shared/bookmarks'
import { inputToUrl } from '@shared/url'
import { cmd, run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { closeBookmarkEditor, type BookmarkEditRequest } from '@renderer/lib/bookmarkEdit'
import { moveTargets } from '@renderer/lib/bookmarkList'
import type { BottomSheetHandle } from '../sheet/BottomSheet'
import { ListRow, SwitchRow } from '../siteControls/primitives'
import { BookmarkFolderList, NewFolderSheet } from './BookmarkFolderPicker'
import { PhoneSheet } from './PhoneSheet'
import { removeWithUndo, useBookmarkTree } from './phonePanel'
import { readingListToggle } from './readingListToggle'

/**
 * The bookmark editor on a phone (HB-16): a sheet in the frame's dialog host (`PhoneSheet`, the
 * 48 header naming it) with the name and the address as two fields, under them the Folder row
 * (Chrome 152's `BookmarkEditActivity` l.268-290: the parent folder's title with a chevron, the
 * label `Folder` – `Parent folder` for a folder – above it), Save as the one primary button and
 * Delete beside it in the danger ink, the two splitting the footer (v2 draft §9.11). It also
 * names a folder (no address field) and creates either when the request has no id. Under a
 * bookmark's fields stands the page's Reading list switch (HB-20, `readingListToggle`), the
 * star's second save, flipped in place.
 *
 * The Folder row steps the sheet into its folder pane – the same sheet, its header now the
 * row's label with Back leading and `New folder` trailing, its body the shared folder picker
 * (`BookmarkFolderList`, the form #570 built for Move to…): every folder the node can enter,
 * the one Save would put it in checked, the one it stands in now saying `Current`. A tap picks
 * a folder and steps back to the form (§9.13: picking closes the picker – nothing is written
 * by the pick, unlike Move to…'s footer, whose Move is the act itself). `New folder` opens the
 * shared §9.12 one-field sheet over this one (§9.24, depth two: the pane keeps the picker in
 * the editor's own sheet so the naming sheet is the second, not a third): the folder is made
 * at once inside the checked one through `bookmark.create` (Chrome's dialog writes on Add too),
 * picked, and the form comes back with its title in the row. Chrome writes the title and the
 * URL as its page is left and moves in the picker's own `Move here`; here nothing but New
 * folder is written until Save, which runs `bookmark.update` and then `bookmark.move` when the
 * folder changed, in the one commit after the sheet has gone – the desktop editor's order. A
 * new node is created straight into the picked folder.
 *
 * Every way out – Save, Delete, the scrim, the back gesture, Escape – slides the sheet away
 * first and clears the request once it is gone; in the pane the back gesture is the header's
 * Back instead and steps to the form, as Chrome's back climbs out of its picker onto the edit
 * page. Focus moves to the dialog itself as it opens,
 * not into a field (§9.22: the keyboard would come up with the sheet); stepping into the pane
 * puts it on the checked folder, stepping back on the Folder row that opened the pane.
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

  // What Save writes: the fields and the folder. Starts from the node when it is here (again
  // when it arrives under a waiting sheet), then follows the typing and the pane's pick.
  const [draft, setDraft] = useState<Draft>(() => draftOf(node, edit))
  const [draftFor, setDraftFor] = useState(node?.id ?? null)
  if (node && draftFor !== node.id) {
    setDraftFor(node.id)
    setDraft(draftOf(node, edit))
  }
  const [pane, setPane] = useState<'form' | 'folder'>('form')
  const [naming, setNaming] = useState(false)
  // The system back in the pane steps back to the form, as the header's Back does (Chrome's
  // back climbs out of its picker onto the edit page): a surface over the sheet's own for as
  // long as the pane is up, a cut rather than a slide – the form's back still slides the sheet
  // away, and the naming sheet's own surface stands over this one while it is up.
  useBackSurface(
    pane === 'folder' ? { name: 'bookmark-edit-folder', onCommit: () => setPane('form') } : null
  )
  // The sheet's own focus pass runs as it opens; a pane change swaps its content from under the
  // focused control, so the focus is moved by hand: into the pane onto the checked folder (a
  // picker's first focus, the list scrolled to show it), back onto the Folder row that opened
  // the pane (§9.24: focus returns to the control that opened what has gone).
  const content = useRef<HTMLDivElement>(null)
  const shownPane = useRef(pane)
  useEffect(() => {
    if (shownPane.current === pane) return
    shownPane.current = pane
    const root = content.current
    if (!root) return
    if (pane === 'folder') {
      const radio =
        root.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ??
        root.querySelector<HTMLElement>('[role="radio"]')
      radio?.focus()
    } else {
      root
        .querySelector<HTMLElement>('[data-testid="bookmark-folder"]')
        ?.focus({ preventScroll: true })
    }
  }, [pane])

  useEffect(() => {
    if (gone) closeBookmarkEditor()
  }, [gone])

  if (gone) return null

  // Where the node stands now (a new one: where the request would put it), and where Save
  // puts it – the pick, unless that folder has gone since, then the present one.
  const origin = node?.parentId ?? edit.parentId
  const parentId = tree.get(draft.parentId)?.type === 'folder' ? draft.parentId : origin
  const parentTitle = tree.get(parentId)?.title ?? ''
  // A root cannot move or be named: its sheet has no Folder row, as Chrome edits no root.
  const canPickFolder = !waiting && !(node !== null && isBookmarkRoot(node.id))
  // Every folder the node can enter: the node's own subtree left out, as Chrome's picker
  // greys the moved folder and its descendants (`isValidFolderForMovedBookmarks`).
  const targets = pane === 'folder' ? moveTargets(tree, node ? [node.id] : [], state.platform) : []
  const checked = targets.some((t) => t.node.id === parentId) ? parentId : null
  const folderLabel = folder ? 'Parent folder' : 'Folder'

  const pick = (id: string): void => {
    setDraft((d) => ({ ...d, parentId: id }))
    setPane('form')
  }

  const create = async (title: string): Promise<void> => {
    if (checked === null) return
    const made = await cmd('bookmark.create', { parentId: checked, title, type: 'folder' })
    if (made) pick(made.id)
  }

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
    <>
      <PhoneSheet
        name="bookmark-edit"
        // A form: the 48 header (§9.16), never a title block – a form has no description. In
        // the folder pane the header is the row's label, Back leading, New folder trailing –
        // disabled (§9.30, laid out at .4) while no folder is checked to hold the new one.
        title={
          pane === 'folder'
            ? {
                pose: 'header',
                text: folderLabel,
                leading: (
                  <button
                    type="button"
                    className="zen-sheet-header-control"
                    data-side="leading"
                    aria-label="Back"
                    onClick={() => setPane('form')}
                  >
                    <ChevronLeft className="h-5 w-5" strokeWidth={1.75} />
                  </button>
                ),
                trailing: (
                  <button
                    type="button"
                    className="zen-sheet-header-control disabled:opacity-40"
                    data-side="trailing"
                    data-text
                    disabled={checked === null}
                    onClick={() => setNaming(true)}
                  >
                    New folder
                  </button>
                )
              }
            : { pose: 'header', text: title }
        }
        focus="dialog"
        onClose={closeBookmarkEditor}
        contentKey={`${edit.id ?? 'new'}:${folder ? 'folder' : 'url'}:${waiting ? 'waiting' : 'ready'}:${pane}`}
        body={pane === 'folder' ? 'list' : undefined}
        under={naming}
        handleLabel={pane === 'folder' ? 'Resize folder list' : 'Resize editor'}
        sheetRef={sheet}
      >
        <div ref={content} className="contents">
          {pane === 'folder' ? (
            <BookmarkFolderList
              rows={targets}
              checked={checked}
              current={node ? node.parentId : null}
              onPick={pick}
            />
          ) : (
            <EditorForm
              node={node}
              draft={draft}
              onDraft={setDraft}
              parentId={parentId}
              folderRow={
                canPickFolder
                  ? { label: folderLabel, title: parentTitle, open: () => setPane('folder') }
                  : null
              }
              folder={folder}
              waiting={waiting}
              readingList={readingListToggle(state, node)}
              dismiss={(then) => sheet.current?.dismiss(then)}
            />
          )}
        </div>
      </PhoneSheet>
      {naming && (
        <NewFolderSheet
          name="bookmark-edit-new-folder"
          parentTitle={checked !== null ? (tree.get(checked)?.title ?? '') : ''}
          onClose={() => setNaming(false)}
          onCreate={(name) => void create(name)}
        />
      )}
    </>
  )
}

/** The editor's unsaved state: the two fields and the folder Save puts the node in. */
interface Draft {
  name: string
  url: string
  parentId: string
}

function draftOf(node: BookmarkNode | null, edit: BookmarkEditRequest): Draft {
  return {
    name: node?.title ?? '',
    url: node?.url ?? '',
    parentId: node?.parentId ?? edit.parentId
  }
}

function EditorForm({
  node,
  draft,
  onDraft,
  parentId,
  folderRow,
  folder,
  waiting,
  readingList,
  dismiss
}: {
  node: BookmarkNode | null
  draft: Draft
  onDraft: (update: (draft: Draft) => Draft) => void
  /** The folder Save puts the node in (the draft's, checked against the tree). */
  parentId: string
  /** The Folder row: its label, the folder's title, and the step into the pane; none for a root. */
  folderRow: { label: string; title: string; open: () => void } | null
  folder: boolean
  /** The node was asked for but is not here yet. */
  waiting: boolean
  /** The page's Reading list switch (`readingListToggle`); none for a folder or a node not here. */
  readingList: ReturnType<typeof readingListToggle>
  dismiss: (then?: () => void) => void
}): JSX.Element {
  const nameId = useId()
  const urlId = useId()
  const { name, url } = draft

  const target = folder ? null : inputToUrl(url.trim())
  const valid = !waiting && (folder ? name.trim().length > 0 : target !== null)

  const save = (): void => {
    const trimmed = name.trim()
    // The move, when the picked folder is not the one the node stands in: run after the update
    // in the same commit, as the desktop editor orders them.
    const move = node && parentId !== node.parentId ? { ids: [node.id], parentId } : null
    let commit: () => void
    if (folder) {
      if (!trimmed) return
      commit = node
        ? () => {
            run('bookmark.update', { id: node.id, title: trimmed })
            if (move) run('bookmark.move', move)
          }
        : () => run('bookmark.create', { parentId, title: trimmed, type: 'folder' })
    } else {
      if (!target) return
      const address = target
      const label = trimmed || address
      commit = node
        ? () => {
            run('bookmark.update', { id: node.id, title: label, url: address })
            if (move) run('bookmark.move', move)
          }
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
        run('bookmark.remove', { ids: [id], quiet: true })
      )
    )
  }

  // The Reading list switch takes effect as it is flipped (§10.4), the sheet staying up: the
  // page into the list by its tab (the core's toast says so), or its entry out by id. The
  // switch's state is the list's as the core last pushed it – an entry that goes elsewhere
  // turns the switch off on the next state.
  const listed = readingList?.entry ?? null
  const canAdd = readingList?.tabId !== null && readingList?.tabId !== undefined
  const toggleReadingList = (): void => {
    if (!readingList) return
    if (listed) run('readingList.remove', { id: listed.id })
    else if (readingList.tabId) run('readingList.add', { tabId: readingList.tabId })
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
            onChange={(e) => {
              const value = e.target.value
              onDraft((d) => ({ ...d, name: value }))
            }}
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
              onChange={(e) => {
                const value = e.target.value
                onDraft((d) => ({ ...d, url: value }))
              }}
            />
          </span>
        </div>
      )}
      {folderRow && (
        // Chrome's folder row (`BookmarkEditActivity` l.268-290): the parent's title under the
        // label, a chevron trailing since it opens a level – the §10.4 value row's two lines.
        <ListRow
          label={folderRow.label}
          description={folderRow.title || 'Folder'}
          chevron
          disabled={waiting}
          onClick={folderRow.open}
          data-testid="bookmark-folder"
        />
      )}
      {readingList && (
        // The star sheet's Reading list row (HB-20): the toggle for this page, on while the
        // list holds it. Disabled – laid out, at §9.30's one number – when nothing shows the
        // page and the list lacks it, with the reason under the label.
        <SwitchRow
          label="Reading list"
          description={
            !listed && !canAdd ? 'Open the page to add it to your reading list' : undefined
          }
          checked={listed !== null}
          disabled={!listed && !canAdd}
          onChange={toggleReadingList}
          data-testid="bookmark-reading-list"
        />
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
