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
  useFrameDialog,
  viewportSize
} from '@renderer/lib/portals'
import { browserStore, closeBookmarkChrome, openBookmarkChrome } from '@renderer/lib/ui'
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

const WIDTH = POPOVER_WIDTH.list
/** How long a bubble waits for the node its event names before giving up on it. */
const ARRIVAL_GRACE_MS = 2000

const close = (): void => closeBookmarkChrome({ starDialog: null })
/** Escape: the bubble goes and the star it hung from takes the focus back (§9.22). */
const closeToAnchor = (): void => {
  closeBookmarkChrome({ starDialog: null }, { keepFocus: true })
  document.querySelector<HTMLElement>('[data-bm-star]')?.focus({ preventScroll: true })
}

/**
 * Chrome's star bubble: the page was bookmarked the moment the star was pressed; this names and
 * files it. "Remove" takes the bookmark back; "Done", Escape, a click outside or the star itself
 * keep it, with whatever name is in the field.
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
 * A desktop popover (v2 draft §9.20): 320 wide, its top border on the pill's bottom edge,
 * end-aligned with the star (the star sits in the pill's trailing half), clamped 8px inside the
 * window, no taller than 60% of it; a §9.23 title block over a body that scrolls under it. It
 * renders through the chrome layer (`ChromePortal`), never inside the frame. On phones it is a
 * sheet placed through the `FrameDialogHost` TabDialogs mounts, over that host's scrim.
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

  // A click anywhere else keeps the bookmark and puts the bubble away; the star chip toggles
  // the bubble itself, and the folder field's popup is part of the bubble though portalled out.
  useEffect(() => {
    if (phone) return
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Element | null
      if (
        !target ||
        panelRef.current?.contains(target) ||
        target.closest('[data-bm-star], [data-bm-listbox]')
      )
        return
      close()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [phone])

  const title = star.created ? 'Bookmark Added' : 'Edit Bookmark'
  const remove = (): void => {
    removed.current = true
    run('bookmark.remove', { ids: [node.id] })
    close()
  }
  const moveTo = (folderId: string): void => {
    if (folderId !== node.parentId) run('bookmark.move', { ids: [node.id], parentId: folderId })
  }
  const more = (): void => {
    void openBookmarkChrome(
      {
        starDialog: null,
        bookmarkEdit: { id: node.id, parentId: node.parentId ?? '', type: 'url' }
      },
      star.tabId
    )
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
      <div className="zen-bm-title-block" data-scrolled={scrolled || undefined}>
        <h2 id="zen-bm-star-title" className="zen-bm-title">
          {title}
        </h2>
      </div>
      <form
        ref={bodyRef}
        className="zen-bm-popover-body zen-bm-form"
        onSubmit={(e) => {
          e.preventDefault()
          close()
        }}
      >
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
        <div className="zen-bm-label min-h-0">
          Folder
          <FolderField
            tree={tree}
            value={node.parentId ?? ''}
            onChange={moveTo}
            onNestedChange={setNested}
          />
        </div>
        <div className="zen-bm-footer">
          <button
            type="button"
            className="zen-button mr-auto"
            data-variant="danger"
            onClick={remove}
          >
            Remove
          </button>
          <button type="button" className="zen-button" onClick={more}>
            More
          </button>
          <button type="submit" className="zen-button" data-variant="primary">
            Done
          </button>
        </div>
      </form>
    </>
  )

  if (phone) {
    return (
      <div
        ref={panelRef}
        role="dialog"
        aria-labelledby="zen-bm-star-title"
        className="zen-animate-pop zen-bm-dialog mx-2 mb-[calc(8px+var(--zen-inset-bottom,0px))] flex max-h-[calc(100%-24px)] w-auto flex-col self-end justify-self-stretch"
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
        aria-labelledby="zen-bm-star-title"
        className="zen-animate-pop zen-bm-popover fixed z-[70] flex flex-col"
        style={{ left: box.left, top: box.top, width: box.width, maxHeight: box.maxHeight }}
        onKeyDown={onKeyDown}
      >
        {body}
      </div>
    </ChromePortal>
  )
}
