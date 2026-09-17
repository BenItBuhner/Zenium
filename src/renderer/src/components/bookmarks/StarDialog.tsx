import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BookmarkNode, Rect, UIState } from '@shared/types'
import type { BookmarkTree } from '@shared/bookmarks'
import { run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { browserStore, closeBookmarkChrome, openBookmarkChrome } from '@renderer/lib/ui'
import { cn } from '@renderer/lib/utils'
import { FolderField } from './FolderField'
import { useBookmarkTree } from './tree'
import { useEscapeTrap } from './escape'

export interface StarTarget {
  tabId: string
  nodeId: string
  created: boolean
  /** The star chip the bubble hangs from; null when the pill is not on screen. */
  anchor: Rect | null
}

const WIDTH = 340
const MARGIN = 8
/** How long a bubble waits for the node its event names before giving up on it. */
const ARRIVAL_GRACE_MS = 2000

const close = (): void => closeBookmarkChrome({ starDialog: null })

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
  const removed = useRef(false)

  useEscapeTrap(!nested, close)

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
  // the bubble itself.
  useEffect(() => {
    if (phone) return
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Element | null
      if (!target || panelRef.current?.contains(target) || target.closest('[data-bm-star]')) return
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
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
  }

  const body = (
    <>
      <h2 className="zen-bm-dialog-title">{title}</h2>
      <form
        className="mt-3 flex min-h-0 flex-col gap-3"
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
        <div className="mt-1 flex items-center gap-2">
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
        className="zen-animate-in zen-bm-scrim absolute inset-0 z-50 flex items-end"
        onMouseDown={close}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-label={title}
          className="zen-animate-pop zen-bm-dialog mx-2 mb-[calc(8px+var(--zen-inset-bottom,0px))] flex max-h-[calc(100%-24px)] w-auto flex-1 flex-col"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={onKeyDown}
        >
          {body}
        </div>
      </div>
    )
  }

  // 8px under the star, the star's centre inside the panel's first 40px – or its last 40px when
  // the panel would otherwise leave the window on the right.
  const a = star.anchor
  const centre = a ? a.x + a.width / 2 : window.innerWidth - MARGIN - 20
  let left = centre - 32
  if (left + WIDTH > window.innerWidth - MARGIN) left = centre + 32 - WIDTH
  left = Math.min(Math.max(MARGIN, left), window.innerWidth - WIDTH - MARGIN)
  const top = a ? a.y + a.height + 8 : 56

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={title}
      className={cn(
        'zen-animate-pop zen-bm-bubble fixed z-[70] flex flex-col',
        'max-h-[calc(100vh-72px)]'
      )}
      style={{ left, top, width: WIDTH }}
      onKeyDown={onKeyDown}
    >
      {body}
    </div>,
    document.body
  )
}
