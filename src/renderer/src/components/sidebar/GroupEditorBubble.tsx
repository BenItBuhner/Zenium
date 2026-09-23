import type { CSSProperties, JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { FolderOpen, Plus, Trash2, Ungroup, X } from 'lucide-react'
import type { Folder, FolderColor, UIState } from '@shared/types'
import { FOLDER_COLORS } from '@shared/defaults'
import { run } from '@renderer/lib/api'
import { useBackSurface } from '@renderer/lib/back'
import { requestFolderDelete } from '@renderer/lib/folderDelete'
import { closeGroupEditor } from '@renderer/lib/groupEditor'
import { GROUP_PALETTE } from '@renderer/lib/groups'
import { measureRow, placeHoverCard } from '@renderer/lib/hoverCard'
import { openedFromKeyboard } from '@renderer/lib/popover'
import {
  ChromePortal,
  POPOVER_MARGIN,
  POPOVER_WIDTH,
  type PopoverBox,
  popoverStyle,
  toRect,
  useLightDismiss,
  viewportSize
} from '@renderer/lib/portals'
import { activeTab } from '@renderer/lib/selectors'
import { browserStore, holdFloatingChrome, returnFocusToPage, uiStore } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { usePopover } from '@renderer/hooks/usePopover'
import { V2_GLYPH } from '../v2/controls'

/** A form: a field, the swatches and rows with a leading glyph (§9.20). */
const WIDTH = POPOVER_WIDTH.form

/** The header row of a folder in the sidebar, the bubble's anchor. */
const headerOf = (folderId: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-tab-folder="${folderId}"]`)

/** The bubble, while a request is up and its folder exists. */
export function GroupEditorLayer(): JSX.Element | null {
  const request = uiStore.use((s) => s.groupEditor)
  const state = browserStore.use((s) => s.state)
  const folder = request && state ? state.folders[request.folderId] : undefined
  // The folder went (unpacked, closed, deleted in another window): the request goes with it.
  useEffect(() => {
    if (request && state && !folder) closeGroupEditor()
  }, [request, state, folder])
  if (!request || !state || !folder) return null
  return (
    <GroupEditorBubble
      key={folder.id}
      state={state}
      folder={folder}
      count={Object.values(state.tabs).filter((t) => t.folderId === folder.id).length}
      keyboard={request.keyboard}
    />
  )
}

/**
 * Chrome's tab group editor bubble (tabs-13) for a Zenium folder – the sidebar's tab group – as
 * a desktop popover (v2 draft §9.20) 400 wide beside the sidebar, flush against its inner edge
 * and start-aligned with the folder's header row (`placeHoverCard`, the tab hover card's
 * placement, clamped to the window with the 8 px margin and flipped above when the row is
 * near the bottom); on the 180 ms pop, radius 8, the panel shadow, no scrim (§9.5). Its title
 * block (§9.23) reads "Edit folder"; the form under it (§9.12) is the name field – live, the
 * header follows every keystroke as Chrome's group chip does – and the nine colours as a row of
 * round swatches, a radio group (§9.14's swatch form: the picked one wears the 2 px accent
 * outline 2 px outside its edge). Under a hairline, the group's actions as `.zen-v2-row` rows
 * with a leading 16 px glyph (§9.34): New tab in folder, Unpack folder (Chrome's Ungroup), Close
 * folder with its tab count (Chrome's Close group – the tabs close and the folder stays SAVED
 * with their pages, TAB-16, so the plain ink) and Delete folder in the danger ink, which asks
 * first when the folder holds anything (`requestFolderDelete`); a saved folder – its tabs
 * closed, its pages kept – has Open folder with its page count and Delete folder alone (New
 * tab in folder would forget its pages, so it waits for Open). It renders through
 * the chrome layer (`ChromePortal`) over a picture of the page (`holdFloatingChrome`) and the
 * layer's light dismiss puts it away: a press anywhere else closes it on `pointerdown` and
 * reaches nothing beneath – the header's own press closes it and does not fold the folder – and
 * a scroll of the list, a resize or another popover opening close it too.
 *
 * The keyboard (§9.22): focus lands in the name field with the name selected; Enter there
 * closes the bubble (the name is already saved); Left and Right walk the swatches and pick as
 * they go, one swatch in the tab order; Tab wraps inside; Escape closes it and hands the
 * keyboard to the header row it hangs from. A press elsewhere or an action gives the page the
 * keyboard back, unless a chrome control had it when the bubble opened.
 */
function GroupEditorBubble({
  state,
  folder,
  count,
  keyboard
}: {
  state: UIState
  folder: Folder
  count: number
  keyboard: boolean
}): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const nameId = useId()
  const colourId = useId()
  const [name, setName] = useState(folder.name)
  const [box, setBox] = useState<PopoverBox | null>(null)
  /** Where the keyboard goes when the bubble leaves: the page, or nowhere (Escape, a chrome opener). */
  const focusOnClose = useRef<'page' | 'chrome'>(keyboard ? 'chrome' : 'page')
  /** The header row the bubble hangs from, for Escape (§9.22: focus returns to the anchor). */
  const [anchor] = useState<HTMLElement | null>(() => headerOf(folder.id))

  // The page's view gives way to its picture while the bubble overhangs it; the bubble holds
  // its first paint until the picture is in place. On release the page gets the keyboard back
  // unless Escape left it in the chrome or a chrome control opened the bubble (§9.22).
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const current = browserStore.get().state
    const hold = holdFloatingChrome(current ? (activeTab(current)?.id ?? null) : null, {
      pageHadFocus: false
    })
    void hold.ready.then((held) => {
      if (held) setReady(true)
    })
    return () => {
      hold.release()
      if (focusOnClose.current === 'page') returnFocusToPage()
    }
  }, [])

  // The bubble's own height decides where it fits, measured once it has rendered (a height cap
  // from the last placement is lifted for the reading) and again on every state push, so it
  // keeps its place on a header that moved when rows came or went.
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!ready || !el) return
    const measure = (): void => {
      const capped = el.style.maxHeight
      el.style.maxHeight = 'none'
      const size = { width: WIDTH, height: el.offsetHeight }
      el.style.maxHeight = capped
      const next = place(headerOf(folder.id), size)
      setBox((prev) => (prev && sameBox(prev, next) ? prev : next))
    }
    measure()
  }, [ready, state, folder.id])

  const update = (patch: Partial<Pick<Folder, 'name' | 'color' | 'collapsed'>>): void =>
    run('folder.update', { folderId: folder.id, patch })
  // The name follows the field as it is typed (Chrome's chip does); a blank field commits when
  // it is left – or when the bubble goes with it blank – so the folder falls back to a name
  // ("Folder", the core's) rather than keeping one the user deleted.
  const edit = useRef({ name, committed: folder.name, folderId: folder.id })
  useEffect(() => {
    edit.current.name = name
  }, [name])
  const commitName = (value: string): void => {
    const next = value.trim()
    if (next === edit.current.committed) return
    edit.current.committed = next
    update({ name: next })
  }
  useEffect(
    () => () => {
      const { name: last, committed, folderId } = edit.current
      if (!last.trim() && committed !== '') run('folder.update', { folderId, patch: { name: '' } })
    },
    []
  )

  const close = (): void => closeGroupEditor()
  const act = (command: () => void): void => {
    close()
    command()
  }

  const onFieldKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitName(name)
      focusOnClose.current = 'chrome'
      anchor?.focus({ preventScroll: true })
      close()
    }
  }

  // Escape puts the bubble away and the chrome keeps the keyboard, which `usePopover` hands to
  // the header row the bubble hangs from (§9.22). The keyboard moves in once the bubble is
  // placed: until then it is painted hidden for the measurement, and a hidden field takes no
  // focus.
  const placed = ready && box !== null
  usePopover(panelRef, {
    onClose: () => {
      focusOnClose.current = 'chrome'
      close()
    },
    active: placed,
    initial: () => fieldRef.current,
    returnTo: anchor
  })
  useEffect(() => {
    if (placed) fieldRef.current?.select()
  }, [placed])
  // The chrome layer's light dismiss (§9.20): a press anywhere else puts the bubble away – the
  // header's own press included, which then does not fold the folder – and the page gets the
  // keyboard back on release.
  useLightDismiss(panelRef, close, { anchor: () => headerOf(folder.id) })
  // A tablet's system back gesture closes it as Escape does.
  useBackSurface({ name: 'group-editor', onCommit: close })

  if (!ready) return null
  // A SAVED folder (TAB-16's desktop half): its tabs closed, its pages kept. Its actions are
  // Open folder – the pages come back as its tabs – and Delete folder; an open folder's are
  // New tab, Unpack, Close (the tabs close, the folder stays saved with their pages) and
  // Delete. New tab in folder is the open folder's alone: on a saved one the first tab it
  // holds again forgets its pages (the model's `folderOpened` rule), a loss no plain-ink row
  // may carry (§5, §9.1) – Open folder brings them back first.
  const saved = count === 0 && Boolean(folder.savedTabs?.length)
  const pages = folder.savedTabs?.length ?? 0
  const tabsLabel = `${count} ${count === 1 ? 'tab' : 'tabs'}`
  const pagesLabel = `${pages} ${pages === 1 ? 'page' : 'pages'}`
  const deleteFolder = (): void => {
    // The prompt's Cancel hands the keyboard back to the header when the bubble had it (§9.22);
    // read before the bubble goes, since the prompt takes its place (§9.20).
    const fromKeyboard = keyboard || openedFromKeyboard()
    close()
    requestFolderDelete(folder.id, fromKeyboard)
  }
  return (
    <ChromePortal>
      {/* A page surface (§9.29): the field, the swatches and the rows draw in the page family. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-labelledby={titleId}
        data-group-editor={folder.id}
        data-side={box?.side}
        data-surface="page"
        className="zen-animate-pop zen-bm-popover zen-group-editor fixed z-[70] flex flex-col outline-none"
        style={{
          width: WIDTH,
          ...(box ? popoverStyle(box) : { left: 0, top: 0 }),
          visibility: box ? 'visible' : 'hidden'
        }}
        tabIndex={-1}
      >
        <div className="zen-bm-title-block">
          <h2 id={titleId} className="zen-bm-title">
            Edit folder
          </h2>
        </div>
        <div className="zen-bm-popover-body flex flex-col">
          <div className="zen-bm-form zen-group-editor-form">
            <label className="zen-bm-label" htmlFor={nameId}>
              Name
              <input
                ref={fieldRef}
                id={nameId}
                type="text"
                className="zen-v2-field"
                placeholder="Name this folder"
                autoComplete="off"
                spellCheck={false}
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  if (e.target.value.trim()) commitName(e.target.value)
                }}
                onBlur={() => commitName(name)}
                onKeyDown={onFieldKeyDown}
              />
            </label>
            <div className="zen-bm-label">
              <span id={colourId}>Colour</span>
              <ColorSwatches
                labelledBy={colourId}
                value={folder.color ?? null}
                onPick={(color) => update({ color })}
              />
            </div>
          </div>
          <div className="zen-group-editor-actions" role="group" aria-label="Folder actions">
            {saved && (
              <button
                type="button"
                className="zen-v2-row zen-group-editor-action"
                data-action="open"
                onClick={() => act(() => run('folder.open', { folderId: folder.id }))}
              >
                <FolderOpen className={V2_GLYPH} aria-hidden />
                <span className="zen-v2-label truncate">Open folder</span>
                <span className="zen-v2-description zen-group-editor-count">{pagesLabel}</span>
              </button>
            )}
            {!saved && (
              <button
                type="button"
                className="zen-v2-row zen-group-editor-action"
                data-action="new-tab"
                onClick={() => act(() => run('folder.newTab', { folderId: folder.id }))}
              >
                <Plus className={V2_GLYPH} aria-hidden />
                <span className="zen-v2-label truncate">New tab in folder</span>
              </button>
            )}
            {count > 0 && (
              <>
                <button
                  type="button"
                  className="zen-v2-row zen-group-editor-action"
                  data-action="unpack"
                  onClick={() =>
                    act(() => run('folder.delete', { folderId: folder.id, unpack: true }))
                  }
                >
                  <Ungroup className={V2_GLYPH} aria-hidden />
                  <span className="zen-v2-label truncate">Unpack folder</span>
                </button>
                {/* Chrome's Close group: the tabs close, the folder stays saved with their
                    pages – it destroys nothing the saved folder does not keep, so the plain
                    ink (§6); Delete alone takes the danger ink. */}
                <button
                  type="button"
                  className="zen-v2-row zen-group-editor-action"
                  data-action="close"
                  onClick={() => act(() => run('folder.close', { folderId: folder.id }))}
                >
                  <X className={V2_GLYPH} aria-hidden />
                  <span className="zen-v2-label truncate">Close folder</span>
                  <span className="zen-v2-description zen-group-editor-count">{tabsLabel}</span>
                </button>
              </>
            )}
            <button
              type="button"
              className="zen-v2-row zen-group-editor-action"
              data-action="delete"
              data-danger=""
              onClick={deleteFolder}
            >
              <Trash2 className={V2_GLYPH} aria-hidden />
              <span className="zen-v2-label truncate">Delete folder</span>
            </button>
          </div>
        </div>
      </div>
    </ChromePortal>
  )
}

/**
 * The nine colours as a radio group of round swatches (§9.14's swatch form): 28 px targets
 * touching in a row – the 20 px discs 8 apart on a 28 pitch, the nine discs 244 wide from the
 * first's left edge to the ninth's right (the targets 252) – the colour the disc inside, the
 * picked one with the 2 px accent outline 2 px outside its edge. One swatch is
 * in the tab order (the picked one); Left, Right, Up and Down move and pick, Home and End jump,
 * as native radios do.
 */
function ColorSwatches({
  labelledBy,
  value,
  onPick
}: {
  labelledBy: string
  value: FolderColor | null
  onPick: (color: FolderColor) => void
}): JSX.Element {
  const groupRef = useRef<HTMLDivElement>(null)
  const pickedIndex = Math.max(
    0,
    GROUP_PALETTE.findIndex((entry) => entry.color === value)
  )
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }
    let next: number
    if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = GROUP_PALETTE.length - 1
    else if (e.key in step)
      next = (pickedIndex + step[e.key] + GROUP_PALETTE.length) % GROUP_PALETTE.length
    else return
    e.preventDefault()
    const entry = GROUP_PALETTE[next]
    onPick(entry.color)
    groupRef.current
      ?.querySelector<HTMLElement>(`[data-color="${entry.color}"]`)
      ?.focus({ preventScroll: true })
  }
  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-labelledby={labelledBy}
      className="zen-group-editor-swatches"
      onKeyDown={onKeyDown}
    >
      {GROUP_PALETTE.map((entry, index) => {
        const checked = index === pickedIndex && value !== null
        return (
          <button
            key={entry.color}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={entry.name}
            title={entry.name}
            data-color={entry.color}
            tabIndex={index === pickedIndex ? 0 : -1}
            className={cn('zen-v2-card-radio zen-group-editor-swatch')}
            style={{ '--zen-swatch': FOLDER_COLORS[entry.color] } as CSSProperties}
            onClick={() => onPick(entry.color)}
          >
            <span className="zen-group-editor-swatch-disc" aria-hidden />
          </button>
        )
      })}
    </div>
  )
}

/**
 * Where the bubble goes: beside the sidebar, flush against its inner edge and start-aligned
 * with the folder's header row – the tab hover card's placement. Without the header on screen
 * (the folder folded into a compact sidebar, another space in front) it hangs at the sidebar's
 * edge from the window's top margin; without a sidebar, in the window's top leading corner.
 */
function place(header: HTMLElement | null, size: { width: number; height: number }): PopoverBox {
  const viewport = viewportSize()
  const measured = header ? measureRow(header) : null
  if (measured) return placeHoverCard(measured.anchor, measured.sidebar, viewport, size)
  const aside = document.querySelector('aside')
  const sidebar = aside
    ? toRect(aside.getBoundingClientRect())
    : { x: POPOVER_MARGIN, y: POPOVER_MARGIN, width: 0, height: 0 }
  const anchor = {
    x: sidebar.x,
    y: Math.max(POPOVER_MARGIN, sidebar.y),
    width: sidebar.width,
    height: 0
  }
  return placeHoverCard(anchor, sidebar, viewport, size)
}

function sameBox(a: PopoverBox, b: PopoverBox): boolean {
  if (a.left !== b.left || a.width !== b.width || a.maxHeight !== b.maxHeight) return false
  return a.side === 'below'
    ? b.side === 'below' && a.top === b.top
    : b.side === 'above' && a.bottom === b.bottom
}
