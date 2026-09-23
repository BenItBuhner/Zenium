import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { BookmarkNode, UIState } from '@shared/types'
import { BOOKMARKS_BAR_ID, recentFolders, type BookmarkTree } from '@shared/bookmarks'
import { run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { POPOVER_WIDTH, useFrameDialog } from '@renderer/lib/portals'
import { closeBookmarkChrome } from '@renderer/lib/ui'
import { V2Button, V2Field, V2FormField, V2TitleBlock } from '../extensions/v2'
import { PhoneSheet } from '../phone/PhoneSheet'
import type { BottomSheetHandle } from '../sheet/BottomSheet'
import { FolderField } from './FolderField'
import { useScrolled, wrapTab } from './popover'
import { useBookmarkTree } from './tree'
import { useEscapeTrap } from './escape'

const TITLE_ID = 'zen-bm-all-tabs-title'
const NAME_ID = 'zen-bm-all-tabs-name'
const FOLDER_ID = 'zen-bm-all-tabs-folder'
const FOLDER_LABEL_ID = 'zen-bm-all-tabs-folder-label'

const close = (): void => closeBookmarkChrome({ bookmarkAllTabs: null })

/** The count's sentence: what the form does (Chrome's "Bookmark all tabs" names the new folder). */
function countCopy(count: number): string {
  return count === 1 ? '1 page goes into a new folder' : `${count} pages go into a new folder`
}

/**
 * Chrome's "Bookmark all tabs": the open pages go into a new folder, named here (Chrome suggests
 * "N tabs") and placed in a folder of the user's choosing – the most recently used one first.
 * On a mouse a v2 dialog (draft §9.20, §9.23) at the form width, 400, on the frame dialog host
 * TabDialogs mounts – centred over its scrim (§9.5), the chrome inert, kept through its exit –
 * with a title block ("Bookmark all tabs", the count as its description, no X), the Name field
 * (§9.12) and the folder menulist (§9.13), then the §9.11 footer: Cancel, Save as the one
 * primary. Escape, the scrim and the footer close it; the name field takes focus and Tab wraps
 * (§9.22). On a phone the same form is a §9.16 sheet ({@link BookmarkAllTabsSheet}): the frame
 * dialog host's phone dialogs are sheets, never a floating card.
 */
export function BookmarkAllTabsDialog({
  state,
  request
}: {
  state: UIState
  request: { tabIds: string[]; defaultTitle: string }
}): JSX.Element {
  const phone = useViewport().formFactor === 'phone'
  return phone ? (
    <BookmarkAllTabsSheet state={state} request={request} />
  ) : (
    <BookmarkAllTabsCard state={state} request={request} />
  )
}

/** The form's state, one for both poses: the name, the chosen folder (the bar when it went away), the save. */
function useBookmarkAllTabsForm(
  state: UIState,
  request: { tabIds: string[]; defaultTitle: string }
): {
  tree: BookmarkTree
  name: string
  setName: (name: string) => void
  parentId: string
  setChosenId: (id: string) => void
  count: number
  save: () => void
} {
  const tree = useBookmarkTree(state)
  const [name, setName] = useState(request.defaultTitle)
  const [chosenId, setChosenId] = useState(() => recentFolders(tree, 1)[0]?.id ?? BOOKMARKS_BAR_ID)
  // The chosen folder went away (another window, sync): fall back to the bar.
  const parentId = tree.get(chosenId) ? chosenId : BOOKMARKS_BAR_ID
  const save = (): void => {
    run('bookmark.createFromTabs', {
      tabIds: request.tabIds,
      title: name.trim() || request.defaultTitle,
      parentId
    })
  }
  return { tree, name, setName, parentId, setChosenId, count: request.tabIds.length, save }
}

/** The mouse's dialog card (§9.5, §9.23). */
function BookmarkAllTabsCard({
  state,
  request
}: {
  state: UIState
  request: { tabIds: string[]; defaultTitle: string }
}): JSX.Element {
  const { tree, name, setName, parentId, setChosenId, count, save } = useBookmarkAllTabsForm(
    state,
    request
  )
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

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={TITLE_ID}
      aria-describedby={`${TITLE_ID}-desc`}
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
      <V2TitleBlock
        id={TITLE_ID}
        title="Bookmark all tabs"
        description={countCopy(count)}
        descriptionId={`${TITLE_ID}-desc`}
        scrolled={scrolled}
      />
      <form
        ref={bodyRef}
        className="zen-bm-popover-body zen-bm-form"
        onSubmit={(e) => {
          e.preventDefault()
          save()
          close()
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

/**
 * The phone's pose: the form as a §9.16 sheet on the shared chassis (`PhoneSheet` in the frame
 * dialog host – the grip, edge to edge, its own scrim) with the 48 centred header naming it; the
 * count's sentence is body copy under the header (§9.23: a paragraph that introduces a form is
 * body copy, 15/400 in the text ink, 16 to what it introduces – not a title block's description),
 * then the form in the sheet's one 16 gutter as the bookmark editor's (`zen-phone-form`, §9.12,
 * §9.25): the Name field, the Folder menulist (§9.13) whose popup on a phone is a sheet of radio
 * rows ({@link FolderPickerSheet}, §9.24: this sheet lies under it meanwhile), and the chassis
 * footer at 16 + the inset splitting the width between Cancel and Save, the one primary (§9.11).
 * Save runs once the sheet is gone, as a picked menu row does; the focus lands on the dialog
 * itself (§9.22: a field would bring the keyboard up with the sheet).
 */
function BookmarkAllTabsSheet({
  state,
  request
}: {
  state: UIState
  request: { tabIds: string[]; defaultTitle: string }
}): JSX.Element {
  const { tree, name, setName, parentId, setChosenId, count, save } = useBookmarkAllTabsForm(
    state,
    request
  )
  const sheet = useRef<BottomSheetHandle>(null)
  const [picking, setPicking] = useState(false)
  const folder = tree.get(parentId)
  return (
    <>
      <PhoneSheet
        name="bookmark-all-tabs"
        // A form: the 48 header (§9.16), never a title block – its paragraph is body copy.
        title={{ pose: 'header', text: 'Bookmark all tabs' }}
        focus="dialog"
        onClose={close}
        under={picking}
        sheetRef={sheet}
      >
        <form
          className="zen-phone-form"
          onSubmit={(e) => {
            e.preventDefault()
            sheet.current?.dismiss(save)
          }}
        >
          <p className="zen-phone-form-copy">{countCopy(count)}</p>
          <div className="zen-phone-form-field">
            <label htmlFor={NAME_ID} className="zen-phone-field-label">
              Name
            </label>
            <span className="zen-phone-field">
              <input
                id={NAME_ID}
                value={name}
                placeholder={request.defaultTitle}
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="done"
                onChange={(e) => setName(e.target.value)}
              />
            </span>
          </div>
          <div className="zen-phone-form-field">
            <span id={FOLDER_LABEL_ID} className="zen-phone-field-label">
              Folder
            </span>
            <button
              type="button"
              id={FOLDER_ID}
              className="zen-v2-menulist"
              aria-haspopup="dialog"
              aria-expanded={picking || undefined}
              aria-labelledby={`${FOLDER_LABEL_ID} ${FOLDER_ID}`}
              onClick={() => setPicking(true)}
            >
              <span className="min-w-0 flex-1 truncate">{folder?.title ?? ''}</span>
              <ChevronDown />
            </button>
          </div>
          {/* §9.11: two peers split the width at an 8 gap, the primary trailing. */}
          <div className="zen-sheet-footer">
            <button
              type="button"
              className="zen-v2-button"
              onClick={() => sheet.current?.dismiss()}
            >
              Cancel
            </button>
            <button type="submit" className="zen-v2-button" data-primary>
              Save
            </button>
          </div>
        </form>
      </PhoneSheet>
      {picking && (
        <FolderPickerSheet
          tree={tree}
          value={parentId}
          onPick={setChosenId}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  )
}

/** Every folder of the tree in reading order, with its depth under its root. */
function flattenFolders(tree: BookmarkTree): Array<{ node: BookmarkNode; depth: number }> {
  const out: Array<{ node: BookmarkNode; depth: number }> = []
  const walk = (node: BookmarkNode, depth: number): void => {
    out.push({ node, depth })
    for (const child of tree.children(node.id)) if (child.type === 'folder') walk(child, depth + 1)
  }
  for (const root of tree.roots()) walk(root, 0)
  return out
}

/**
 * The folder menulist's popup on a phone (§9.13): a §9.16 sheet of §9.14 radio rows over the
 * form's sheet – every folder in reading order, each level 16 further in, the chosen one checked
 * and taking the focus as the sheet opens (§9.22). A pick slides the sheet away first and lands
 * once it has gone; the scrim and the back gesture leave the choice as it was.
 */
function FolderPickerSheet({
  tree,
  value,
  onPick,
  onClose
}: {
  tree: BookmarkTree
  value: string
  onPick: (id: string) => void
  onClose: () => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const folders = flattenFolders(tree)
  return (
    <PhoneSheet
      name="bookmark-all-tabs-folder"
      title={{ pose: 'header', text: 'Folder' }}
      focus="checked"
      onClose={onClose}
      body="list"
      sheetRef={sheet}
    >
      <div role="radiogroup" aria-label="Folder" className="pb-2">
        {folders.map(({ node, depth }) => (
          <button
            key={node.id}
            type="button"
            role="radio"
            aria-checked={node.id === value}
            className="zen-v2-row"
            style={depth ? { paddingInlineStart: 16 + depth * 16 } : undefined}
            onClick={() => sheet.current?.dismiss(() => onPick(node.id))}
          >
            <span className="zen-v2-radio" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{node.title}</span>
          </button>
        ))}
      </div>
    </PhoneSheet>
  )
}
