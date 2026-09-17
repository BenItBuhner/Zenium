import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Star } from 'lucide-react'
import type { Rect, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { useViewport } from '@renderer/lib/formFactor'
import { closeBookmarkChrome, openBookmarkChrome } from '@renderer/lib/ui'
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

/**
 * Chrome's star bubble: the page was bookmarked the moment the star was pressed; this names and
 * files it. "Remove" takes the bookmark back; "Done", Escape, a click outside or the star itself
 * keep it, with whatever name is in the field.
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
  const phone = useViewport().formFactor === 'phone'
  const [name, setName] = useState(node?.title ?? '')
  const [nested, setNested] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [])

  // Whatever closes the bubble, the name in the field is kept: a rename is committed as the
  // bubble unmounts, unless the bookmark itself was removed.
  const pending = useRef<{ id: string; title: string; original: string } | null>(null)
  useEffect(() => {
    pending.current = node ? { id: node.id, title: name, original: node.title } : null
  }, [name, node])
  const removed = useRef(false)
  useEffect(
    () => () => {
      const p = pending.current
      if (!p || removed.current) return
      const title = p.title.trim()
      if (title && title !== p.original) run('bookmark.update', { id: p.id, title })
    },
    []
  )

  const close = useCallback((): void => closeBookmarkChrome({ starDialog: null }), [])
  useEscapeTrap(!nested, close)

  // Removed elsewhere (another window, sync) while open: nothing left to edit.
  useEffect(() => {
    if (!node) {
      removed.current = true
      close()
    }
  }, [close, node])

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
  }, [close, phone])

  if (!node) return null

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
      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--zen-accent-rgb)/0.16)] text-[var(--zen-accent-ink)]">
          <Star className="h-4 w-4" fill="currentColor" />
        </span>
        <h2 className="zen-bm-dialog-title">{star.created ? 'Bookmark added' : 'Edit bookmark'}</h2>
      </div>
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
        <div className="zen-bm-label">
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
        className="zen-animate-in absolute inset-0 z-50 flex items-end bg-[var(--zen-scrim)]"
        onMouseDown={close}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-label={star.created ? 'Bookmark added' : 'Edit bookmark'}
          className="zen-panel zen-animate-pop zen-bm-dialog mx-2 mb-[calc(8px+var(--zen-inset-bottom,0px))] flex max-h-[calc(100%-24px)] w-auto flex-1 flex-col"
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
      aria-label={star.created ? 'Bookmark added' : 'Edit bookmark'}
      className={cn(
        'zen-panel zen-animate-pop zen-bm-dialog fixed z-[70] flex flex-col',
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
