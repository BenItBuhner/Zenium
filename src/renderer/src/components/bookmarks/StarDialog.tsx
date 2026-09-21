import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { BookmarkNode, Rect, UIState } from '@shared/types'
import type { BookmarkTree } from '@shared/bookmarks'
import { run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import {
  ChromePortal,
  POPOVER_MARGIN,
  POPOVER_WIDTH,
  placePopover,
  popoverStyle,
  useFrameDialog,
  useLightDismiss,
  viewportSize,
  type DismissReason
} from '@renderer/lib/portals'
import { browserStore, closeBookmarkChrome } from '@renderer/lib/ui'
import { V2Button, V2Field, V2FormField, V2TitleBlock } from '../extensions/v2'
import { FolderField } from './FolderField'
import { useScrolled, wrapTab } from './popover'
import { useBookmarkTree } from './tree'
import { useEscapeTrap } from './escape'

export interface StarTarget {
  tabId: string
  nodeId: string
  created: boolean
  /** The star chip the bubble hangs from; null when the pill is not on screen. */
  anchor: Rect | null
  /** The address pill the chip sits in: the bubble's top edge is the pill's bottom edge. */
  pill: Rect | null
}

/** The form width (§9.20): the bubble is a form – a field, a menulist and a footer. */
const WIDTH = POPOVER_WIDTH.form
const TITLE_ID = 'zen-bm-star-title'
const NAME_ID = 'zen-bm-star-name'
const FOLDER_ID = 'zen-bm-star-folder'
/** How long a bubble waits for the node its event names before giving up on it. */
const ARRIVAL_GRACE_MS = 2000

const close = (): void => closeBookmarkChrome({ starDialog: null })
const starChip = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-bm-star]')
/** Escape or the star's own press: the bubble goes and the star takes the focus back (§9.22). */
const closeToAnchor = (): void => {
  closeBookmarkChrome({ starDialog: null }, { keepFocus: true })
  starChip()?.focus({ preventScroll: true })
}

/**
 * Chrome's star bubble: the page was bookmarked the moment the star was pressed; this names and
 * files it. "Remove" takes the bookmark back; "Done", Escape, a click outside or the star itself
 * keep it, with whatever name is in the field. The URL and a folder's rename are the Edit
 * bookmark dialog's (the bar's and the manager's "Edit…"), as in Chrome's bubble.
 *
 * The `bookmark.star` event and the state push that carries a new node are separate messages
 * from the main process and can arrive in either order, so the bubble waits for the node to show
 * up rather than reading a missing one as removed; only a node that was there and went away
 * (deleted elsewhere, sync) closes it, and one that never comes closes it after a grace period.
 */
export function StarDialog({
  state,
  star
}: {
  state: UIState
  star: StarTarget
}): JSX.Element | null {
  const tree = useBookmarkTree(state)
  const node = tree.get(star.nodeId)
  const seen = useRef(node !== undefined)

  useEffect(() => {
    if (node) {
      seen.current = true
      return
    }
    if (seen.current) {
      close()
      return
    }
    const timer = window.setTimeout(close, ARRIVAL_GRACE_MS)
    return () => window.clearTimeout(timer)
  }, [node])

  if (!node) return null
  return <StarBubble tree={tree} node={node} star={star} />
}

/**
 * A desktop popover (v2 draft §9.20) at the form width, 400: its top border on the pill's
 * bottom edge, end-aligned with the star (the star sits in the pill's trailing half), placed by
 * `placePopover` (flip, slide, shrink, 8px inside the window), no taller than 60% of it; the
 * popover chrome (`--v2-panel`, radius 8, `--v2-shadow-panel`, no arrow). Inside, a §9.23 title
 * block – "Bookmark added" / "Edit bookmark" – over the form (§9.12): the Name field, focused
 * and selected on open, and the folder menulist (§9.13, whose "Choose another folder…" swaps in
 * the tree as rows), then the §9.11 footer at the 32 control height – Remove in the danger ink,
 * then Done as the one primary, Chrome's order. It renders through the chrome layer
 * (`ChromePortal`), never inside the frame, and the layer's light dismiss puts it away: a press
 * anywhere else keeps the bookmark and closes it (the press goes no further), the star's own
 * press closes it and hands it the focus, scroll and resize close it; Escape too returns the
 * focus to the star (§9.22). On phones it is a sheet placed through the `FrameDialogHost`
 * TabDialogs mounts, over that host's scrim.
 */
function StarBubble({
  tree,
  node,
  star
}: {
  tree: BookmarkTree
  node: BookmarkNode
  star: StarTarget
}): JSX.Element {
  const phone = useViewport().formFactor === 'phone'
  const [name, setName] = useState(node.title)
  const [nested, setNested] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLFormElement>(null)
  const scrolled = useScrolled(bodyRef)
  const removed = useRef(false)

  useEscapeTrap(!nested, phone ? close : closeToAnchor)
  useFrameDialog({ onScrimPress: close, active: phone })

  useEffect(() => {
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [])

  // Whatever closes the bubble, the name in the field is kept: a rename is committed as the
  // bubble unmounts, unless the bookmark itself was removed (here or elsewhere).
  const pending = useRef({ id: node.id, title: name, original: node.title })
  useEffect(() => {
    pending.current = { id: node.id, title: name, original: node.title }
  }, [name, node])
  useEffect(
    () => () => {
      const p = pending.current
      if (removed.current) return
      const title = p.title.trim()
      const alive = (browserStore.get().state?.bookmarks ?? []).some((n) => n.id === p.id)
      if (alive && title && title !== p.original) run('bookmark.update', { id: p.id, title })
    },
    []
  )

  // The chrome layer's light dismiss (§9.20 amended): a press anywhere else keeps the bookmark
  // and puts the bubble away – the star's own press hands it the focus back, as Escape does –
  // and so do a scroll, a resize and another popover opening. The folder field's list is the
  // bubble's child popover (its anchor is inside), so a press in it leaves the bubble alone.
  useLightDismiss(
    panelRef,
    (reason: DismissReason) => (reason === 'anchor' ? closeToAnchor() : close()),
    { anchor: starChip, disabled: phone }
  )

  const title = star.created ? 'Bookmark added' : 'Edit bookmark'
  const remove = (): void => {
    removed.current = true
    run('bookmark.remove', { ids: [node.id] })
    close()
  }
  const moveTo = (folderId: string): void => {
    if (folderId !== node.parentId) run('bookmark.move', { ids: [node.id], parentId: folderId })
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    wrapTab(e, panelRef.current)
  }

  const body = (
    <>
      <V2TitleBlock id={TITLE_ID} title={title} scrolled={scrolled} />
      <form
        ref={bodyRef}
        className="zen-bm-popover-body zen-bm-form"
        onSubmit={(e) => {
          e.preventDefault()
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
              value={node.parentId ?? ''}
              onChange={moveTo}
              onNestedChange={setNested}
            />
          )}
        </V2FormField>
        <div className="zen-bm-footer justify-end">
          <V2Button variant="danger" onClick={remove}>
            Remove
          </V2Button>
          <V2Button type="submit" variant="primary">
            Done
          </V2Button>
        </div>
      </form>
    </>
  )

  if (phone) {
    return (
      <div
        ref={panelRef}
        role="dialog"
        aria-labelledby={TITLE_ID}
        className="zen-v2 zen-animate-pop zen-bm-dialog mx-2 mb-[calc(8px+var(--zen-inset-bottom,0px))] flex max-h-[calc(100%-24px)] w-auto flex-col self-end justify-self-stretch"
        onKeyDown={onKeyDown}
      >
        {body}
      </div>
    )
  }

  // With no pill on screen (compact mode) the bubble stands in the window's top trailing corner.
  const viewport = viewportSize()
  const anchor = star.anchor ?? {
    x: viewport.width - POPOVER_MARGIN - 28,
    y: 28,
    width: 28,
    height: 28
  }
  const box = placePopover(anchor, star.pill ?? anchor, viewport, WIDTH)

  return (
    <ChromePortal>
      <div
        ref={panelRef}
        role="dialog"
        aria-labelledby={TITLE_ID}
        className="zen-v2 zen-animate-pop zen-bm-popover fixed z-[70] flex flex-col"
        style={popoverStyle(box)}
        onKeyDown={onKeyDown}
      >
        {body}
      </div>
    </ChromePortal>
  )
}
