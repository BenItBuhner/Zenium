import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BookmarkTree } from '@shared/bookmarks'
import { run } from '@renderer/lib/api'
import { SPRING_GENTLE, SpringAnimation } from '@renderer/lib/motion/spring'
import { forbiddenTargets } from './tree'

/**
 * Drop targets are DOM elements carrying `data-bm-drop`:
 *   row:<id>        a list row – before / after / into (folders) depending on the pointer's y
 *   into:<folderId> a folder (tree items, breadcrumb segments)
 *   list:<folderId> the list's empty space – append to that folder
 */
export interface BookmarkDrag {
  ids: string[]
  x: number
  y: number
  /** Pointer offset inside the picked-up row, so the ghost stays under the finger. */
  dx: number
  dy: number
  width: number
  /** Where the ghost springs back to when the drop is cancelled. */
  originX: number
  originY: number
  /** The pointer let go: the ghost is settling (back to its row, or into the drop). */
  settling: boolean
}

export interface DropTarget {
  key: string
  parentId: string
  index?: number
  /** The row being hovered, for the insertion line / folder highlight. */
  rowId: string | null
  position: 'before' | 'after' | 'into' | 'append'
}

interface Options {
  tree: BookmarkTree
  /** Manual order and not searching: rows may be dropped between siblings. */
  canReorder: boolean
}

const DRAG_THRESHOLD = 5

/**
 * Pointer-driven drag and drop for the manager. Position follows the pointer directly (direct
 * manipulation); everything that is not under the finger – the ghost settling, the insertion
 * line gliding between slots, rows making room – runs on springs, so a new grab mid-flight simply
 * takes over the motion.
 */
export function useBookmarkDrag({ tree, canReorder }: Options): {
  drag: BookmarkDrag | null
  target: DropTarget | null
  startDrag: (e: React.PointerEvent, ids: string[], rowEl: HTMLElement) => void
  ghostRef: React.RefObject<HTMLDivElement | null>
} {
  const [drag, setDrag] = useState<BookmarkDrag | null>(null)
  const [target, setTarget] = useState<DropTarget | null>(null)
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const springs = useRef<{ x: SpringAnimation; y: SpringAnimation } | null>(null)
  const live = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const dragRef = useRef<BookmarkDrag | null>(null)
  const treeRef = useRef(tree)
  const reorderRef = useRef(canReorder)
  useLayoutEffect(() => {
    treeRef.current = tree
    reorderRef.current = canReorder
  }, [tree, canReorder])

  const placeGhost = useCallback((x: number, y: number): void => {
    live.current = { x, y }
    const el = ghostRef.current
    if (el) el.style.transform = `translate3d(${x}px, ${y}px, 0)`
  }, [])

  const stopSprings = useCallback((): void => {
    springs.current?.x.stop()
    springs.current?.y.stop()
    springs.current = null
  }, [])

  useEffect(() => () => stopSprings(), [stopSprings])

  const resolveTarget = useCallback((x: number, y: number, ids: string[]): DropTarget | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-bm-drop]')
    if (!el) return null
    const key = el.dataset.bmDrop ?? ''
    const [kind, id] = key.split(':')
    const t = treeRef.current
    const forbidden = forbiddenTargets(t, ids)
    const selected = new Set(ids)
    if (kind === 'into' || kind === 'list') {
      const folder = t.get(id)
      if (!folder || folder.type !== 'folder' || forbidden.has(id)) return null
      return {
        key,
        parentId: id,
        rowId: kind === 'into' ? id : null,
        position: kind === 'into' ? 'into' : 'append'
      }
    }
    if (kind !== 'row') return null
    const row = t.get(id)
    if (!row || selected.has(id)) return null
    const rect = el.getBoundingClientRect()
    const frac = (y - rect.top) / Math.max(1, rect.height)
    if (row.type === 'folder') {
      // A wide middle band drops into the folder; the edges slot beside it.
      const band = reorderRef.current ? 0.25 : 0
      if (frac >= band && frac <= 1 - band) {
        if (forbidden.has(id)) return null
        return { key: `into:${id}`, parentId: id, rowId: id, position: 'into' }
      }
    }
    if (!reorderRef.current || row.parentId === null) return null
    const after = frac > 0.5
    // Index among the siblings once the moving rows are taken out.
    const siblings = t.children(row.parentId).filter((n) => !selected.has(n.id))
    const at = siblings.findIndex((n) => n.id === id)
    const index = at === -1 ? siblings.length : at + (after ? 1 : 0)
    return {
      key: `row:${id}:${after ? 'after' : 'before'}`,
      parentId: row.parentId,
      index,
      rowId: id,
      position: after ? 'after' : 'before'
    }
  }, [])

  const finish = useCallback(
    (settleTo: { x: number; y: number } | null): void => {
      const current = dragRef.current
      if (!current) return
      const settled = (): void => {
        if (dragRef.current !== current) return
        dragRef.current = null
        setDrag(null)
      }
      if (!settleTo) {
        settled()
        return
      }
      // The ghost glides to where it belongs: its origin (cancelled) or the drop slot.
      const ghost = ghostRef.current
      const from = live.current
      const x = new SpringAnimation(
        SPRING_GENTLE,
        (v) => placeGhost(v, live.current.y),
        () => undefined
      )
      const y = new SpringAnimation(
        SPRING_GENTLE,
        (v) => placeGhost(live.current.x, v),
        () => {
          if (ghost) ghost.style.opacity = '0'
          setTimeout(settled, 120)
        }
      )
      springs.current = { x, y }
      x.start(from.x, 0, settleTo.x)
      y.start(from.y, 0, settleTo.y)
      if (ghost) ghost.style.transition = 'opacity 120ms ease-out'
    },
    [placeGhost]
  )

  const startDrag = useCallback(
    (e: React.PointerEvent, ids: string[], rowEl: HTMLElement): void => {
      if (e.button !== 0 || e.pointerType !== 'mouse' || ids.length === 0) return
      const startX = e.clientX
      const startY = e.clientY
      const rect = rowEl.getBoundingClientRect()
      const pointerId = e.pointerId
      let dragging = false
      // Grabbing while a previous ghost is still settling takes over from its motion.
      stopSprings()
      if (dragRef.current) {
        dragRef.current = null
        setDrag(null)
      }

      const onMove = (ev: PointerEvent): void => {
        if (ev.pointerId !== pointerId) return
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return
          dragging = true
          document.body.style.cursor = 'grabbing'
          const next: BookmarkDrag = {
            ids,
            x: ev.clientX,
            y: ev.clientY,
            dx: startX - rect.left,
            dy: startY - rect.top,
            width: rect.width,
            originX: rect.left,
            originY: rect.top,
            settling: false
          }
          dragRef.current = next
          setDrag(next)
        }
        placeGhost(ev.clientX - (startX - rect.left), ev.clientY - (startY - rect.top))
        setTarget(resolveTarget(ev.clientX, ev.clientY, ids))
      }

      const cleanup = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        window.removeEventListener('keydown', onKey, true)
        document.body.style.cursor = ''
      }

      const onUp = (ev: PointerEvent): void => {
        if (ev.pointerId !== pointerId) return
        cleanup()
        if (!dragging) return
        const drop = resolveTarget(ev.clientX, ev.clientY, ids)
        setTarget(null)
        const current = dragRef.current
        if (!current) return
        if (drop) {
          run('bookmark.move', { ids, parentId: drop.parentId, index: drop.index })
          const slot = document.querySelector<HTMLElement>(`[data-bm-drop="row:${drop.rowId}"]`)
          const to = slot?.getBoundingClientRect()
          setDrag({ ...current, settling: true })
          finish(to ? { x: to.left, y: to.top } : null)
        } else {
          setDrag({ ...current, settling: true })
          finish({ x: current.originX, y: current.originY })
        }
      }

      const onCancel = (ev: PointerEvent): void => {
        if (ev.pointerId !== pointerId) return
        cleanup()
        setTarget(null)
        const current = dragRef.current
        if (!current) return
        setDrag({ ...current, settling: true })
        finish({ x: current.originX, y: current.originY })
      }

      const onKey = (ev: KeyboardEvent): void => {
        // Escape lets go without dropping: the ghost returns to its row.
        if (ev.key !== 'Escape') return
        ev.preventDefault()
        ev.stopPropagation()
        cleanup()
        setTarget(null)
        const current = dragRef.current
        if (!current) return
        setDrag({ ...current, settling: true })
        finish({ x: current.originX, y: current.originY })
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
      window.addEventListener('keydown', onKey, true)
    },
    [finish, placeGhost, resolveTarget, stopSprings]
  )

  // The ghost mounts after the first move: put it under the pointer right away.
  useEffect(() => {
    if (drag && !drag.settling) placeGhost(live.current.x, live.current.y)
  }, [drag, placeGhost])

  return { drag, target, startDrag, ghostRef }
}
