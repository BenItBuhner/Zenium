import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BookmarkTree } from '@shared/bookmarks'
import { run } from '@renderer/lib/api'
import { SPRING_GENTLE, SpringAnimation } from '@renderer/lib/motion/spring'
import { VelocityTracker } from '@renderer/lib/motion/velocity'
import { forbiddenTargets } from '../../bookmarks/tree'

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
  /** The scrolling list: it autoscrolls while the pointer drags within 32px of its edges. */
  scrollRef?: React.RefObject<HTMLElement | null>
}

const DRAG_THRESHOLD = 5
/** Autoscroll band at the list's top and bottom edges, and the fastest scroll per frame. */
const AUTOSCROLL_EDGE = 32
const AUTOSCROLL_MAX_STEP = 14

/**
 * Pointer-driven drag and drop for the manager. Position follows the pointer directly (direct
 * manipulation); everything that is not under the finger – the ghost settling, the insertion
 * line gliding between slots, rows making room – runs on springs, so a new grab mid-flight simply
 * takes over the motion.
 */
export function useBookmarkDrag({ tree, canReorder, scrollRef }: Options): {
  drag: BookmarkDrag | null
  target: DropTarget | null
  startDrag: (e: React.PointerEvent, ids: string[], rowEl: HTMLElement) => void
  ghostRef: React.RefObject<HTMLDivElement | null>
} {
  const [drag, setDrag] = useState<BookmarkDrag | null>(null)
  const [target, setTarget] = useState<DropTarget | null>(null)
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const settle = useRef<SpringAnimation | null>(null)
  const live = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const pointer = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const velocity = useRef(new VelocityTracker())
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

  const stopSettle = useCallback((): void => {
    settle.current?.stop()
    settle.current = null
  }, [])

  useEffect(() => () => stopSettle(), [stopSettle])

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

  /**
   * The ghost glides to where it belongs – its origin (cancelled) or the drop slot – on one
   * spring along the straight path, launched with the pointer's release velocity.
   */
  const finish = useCallback(
    (settleTo: { x: number; y: number } | null): void => {
      const current = dragRef.current
      if (!current) return
      const settled = (): void => {
        if (dragRef.current !== current) return
        dragRef.current = null
        setDrag(null)
      }
      const ghost = ghostRef.current
      const from = live.current
      const dx = settleTo ? settleTo.x - from.x : 0
      const dy = settleTo ? settleTo.y - from.y : 0
      const distance = Math.hypot(dx, dy)
      if (!settleTo || distance < 0.5) {
        settled()
        return
      }
      const ux = dx / distance
      const uy = dy / distance
      const { vx, vy } = velocity.current.velocity(performance.now())
      const spring = new SpringAnimation(
        SPRING_GENTLE,
        (s) => placeGhost(from.x + ux * s, from.y + uy * s),
        () => {
          if (ghost) ghost.style.opacity = '0'
          setTimeout(settled, 120)
        }
      )
      settle.current = spring
      if (ghost) ghost.style.transition = 'opacity 120ms ease-out'
      spring.start(0, vx * ux + vy * uy, distance)
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
      let frame: number | null = null
      // Grabbing while a previous ghost is still settling takes over from its motion.
      stopSettle()
      if (dragRef.current) {
        dragRef.current = null
        setDrag(null)
      }
      velocity.current.reset()
      velocity.current.add(e.timeStamp, startX, startY)

      // Near the list's top or bottom edge the list scrolls under the pointer, faster the
      // closer to the edge, and the target under the (still) pointer is re-read as it does.
      const autoscroll = (): void => {
        frame = null
        const el = scrollRef?.current
        const current = dragRef.current
        if (!el || !current || current.settling) return
        const box = el.getBoundingClientRect()
        const { x, y } = pointer.current
        let step = 0
        if (x >= box.left && x <= box.right) {
          if (y < box.top + AUTOSCROLL_EDGE)
            step = -((box.top + AUTOSCROLL_EDGE - y) / AUTOSCROLL_EDGE)
          else if (y > box.bottom - AUTOSCROLL_EDGE)
            step = (y - (box.bottom - AUTOSCROLL_EDGE)) / AUTOSCROLL_EDGE
        }
        if (step !== 0) {
          const before = el.scrollTop
          el.scrollTop += Math.max(-1, Math.min(1, step)) * AUTOSCROLL_MAX_STEP
          if (el.scrollTop !== before) setTarget(resolveTarget(x, y, ids))
        }
        frame = requestAnimationFrame(autoscroll)
      }

      const onMove = (ev: PointerEvent): void => {
        if (ev.pointerId !== pointerId) return
        pointer.current = { x: ev.clientX, y: ev.clientY }
        velocity.current.add(ev.timeStamp, ev.clientX, ev.clientY)
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
          if (frame === null) frame = requestAnimationFrame(autoscroll)
        }
        placeGhost(ev.clientX - (startX - rect.left), ev.clientY - (startY - rect.top))
        setTarget(resolveTarget(ev.clientX, ev.clientY, ids))
      }

      const cleanup = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        window.removeEventListener('keydown', onKey, true)
        if (frame !== null) cancelAnimationFrame(frame)
        frame = null
        document.body.style.cursor = ''
      }

      const letGo = (): void => {
        setTarget(null)
        const current = dragRef.current
        if (!current) return
        setDrag({ ...current, settling: true })
        finish({ x: current.originX, y: current.originY })
      }

      const onUp = (ev: PointerEvent): void => {
        if (ev.pointerId !== pointerId) return
        cleanup()
        if (!dragging) return
        velocity.current.add(ev.timeStamp, ev.clientX, ev.clientY)
        const drop = resolveTarget(ev.clientX, ev.clientY, ids)
        if (!drop) {
          letGo()
          return
        }
        setTarget(null)
        const current = dragRef.current
        if (!current) return
        run('bookmark.move', { ids, parentId: drop.parentId, index: drop.index })
        const slot = document.querySelector<HTMLElement>(`[data-bm-drop="row:${drop.rowId}"]`)
        const to = slot?.getBoundingClientRect()
        setDrag({ ...current, settling: true })
        finish(to ? { x: to.left, y: to.top } : null)
      }

      const onCancel = (ev: PointerEvent): void => {
        if (ev.pointerId !== pointerId) return
        cleanup()
        letGo()
      }

      const onKey = (ev: KeyboardEvent): void => {
        // Escape lets go without dropping: the ghost returns to its row.
        if (ev.key !== 'Escape') return
        ev.preventDefault()
        ev.stopPropagation()
        cleanup()
        letGo()
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
      window.addEventListener('keydown', onKey, true)
    },
    [finish, placeGhost, resolveTarget, scrollRef, stopSettle]
  )

  // The ghost mounts after the first move: put it under the pointer right away.
  useEffect(() => {
    if (drag && !drag.settling) placeGhost(live.current.x, live.current.y)
  }, [drag, placeGhost])

  return { drag, target, startDrag, ghostRef }
}
