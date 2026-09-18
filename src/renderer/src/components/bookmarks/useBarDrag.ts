import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { BookmarkNode } from '@shared/types'
import type { BookmarkTree } from '@shared/bookmarks'
import { run } from '@renderer/lib/api'
import { SPRING_GENTLE, SpringAnimation } from '@renderer/lib/motion/spring'
import type { ChipMotion } from './chipMotion'
import { forbiddenTargets } from './tree'

export interface BarDrag {
  node: BookmarkNode
  /** Size of the chip in the hand (the ghost is drawn at the same size). */
  width: number
  height: number
  /** Pointer offset inside the chip, so the ghost stays under the pointer. */
  dx: number
  dy: number
  /** Where the ghost springs back to when the drop is cancelled. */
  originX: number
  originY: number
  /** The pointer let go: the ghost is settling into the drop (or back to its slot). */
  settling: boolean
}

export type BarDropTarget =
  /** Between two chips of the bar: `index` among the siblings once the chip is taken out. */
  | { kind: 'slot'; index: number; lineX: number }
  /** Onto a folder chip or a folder row: append inside it. */
  | { kind: 'folder'; folderId: string }
  /** Beside a row of an open folder panel. */
  | { kind: 'row'; parentId: string; index: number; rowId: string; position: 'before' | 'after' }
  /** The empty space of an open folder panel. */
  | { kind: 'append'; parentId: string }

interface Options {
  tree: BookmarkTree
  barId: string
  /** The bar's children in order; the first `visibleCount` have a chip on screen. */
  items: readonly BookmarkNode[]
  visibleCount: number
  stripRef: RefObject<HTMLElement | null>
  motion: ChipMotion
  /** The pointer has rested on a folder chip: open it (null once it moved on). */
  onHoldFolder: (folderId: string | null) => void
}

const DRAG_THRESHOLD = 5
const HOLD_TO_OPEN_MS = 500

/**
 * Dragging a chip along the bookmarks bar (or into one of its folders). The chip's slot stays
 * where it is while a ghost follows the pointer; the neighbours slide on springs to open the
 * gap where the chip would land, marked by the insertion line; resting on a folder chip opens
 * its panel so the chip can be filed at a precise spot inside.
 */
export function useBarDrag({
  tree,
  barId,
  items,
  visibleCount,
  stripRef,
  motion,
  onHoldFolder
}: Options): {
  drag: BarDrag | null
  target: BarDropTarget | null
  startDrag: (e: React.PointerEvent, node: BookmarkNode, chipEl: HTMLElement) => void
  ghostRef: RefObject<HTMLDivElement | null>
  /** True for a moment after a drag ended, so the chip's click does not fire as well. */
  justDragged: () => boolean
} {
  const [drag, setDrag] = useState<BarDrag | null>(null)
  const [target, setTarget] = useState<BarDropTarget | null>(null)
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<BarDrag | null>(null)
  const live = useRef({ x: 0, y: 0 })
  const springs = useRef<{ x: SpringAnimation; y: SpringAnimation } | null>(null)
  const endedAt = useRef(0)
  const hold = useRef<{ folderId: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const heldOpen = useRef<string | null>(null)

  const latest = useRef({ tree, items, visibleCount, onHoldFolder })
  useLayoutEffect(() => {
    latest.current = { tree, items, visibleCount, onHoldFolder }
  }, [tree, items, visibleCount, onHoldFolder])

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

  const clearHold = useCallback((): void => {
    if (hold.current) clearTimeout(hold.current.timer)
    hold.current = null
  }, [])

  useEffect(
    () => () => {
      stopSprings()
      clearHold()
    },
    [stopSprings, clearHold]
  )

  /** The chips on screen other than the one in the hand, with the slots they rest in. */
  const restingChips = useCallback(
    (
      liftedId: string
    ): { others: Array<{ node: BookmarkNode; rect: DOMRect }>; liftedAt: number } => {
      const { items: all, visibleCount: shown } = latest.current
      const others: Array<{ node: BookmarkNode; rect: DOMRect }> = []
      let liftedAt = 0
      all.slice(0, shown).forEach((node) => {
        if (node.id === liftedId) {
          liftedAt = others.length
          return
        }
        const rect = motion.restingRect(node.id)
        if (rect) others.push({ node, rect })
      })
      return { others, liftedAt }
    },
    [motion]
  )

  const resolveTarget = useCallback(
    (x: number, y: number, current: BarDrag): BarDropTarget | null => {
      const { tree: t } = latest.current
      const forbidden = forbiddenTargets(t, [current.node.id])
      const under = document.elementFromPoint(x, y)
      // Inside an open folder panel: its rows and empty space take the drop.
      const panel = under?.closest<HTMLElement>('[data-bar-panel]')
      if (panel) {
        const el = under?.closest<HTMLElement>('[data-bar-drop]')
        if (!el) return null
        const [kind, id] = (el.dataset.barDrop ?? '').split(':')
        if (kind === 'list') {
          const folder = t.get(id)
          if (!folder || folder.type !== 'folder' || forbidden.has(id)) return null
          return { kind: 'append', parentId: id }
        }
        if (kind !== 'row') return null
        const row = t.get(id)
        if (!row || row.id === current.node.id || row.parentId === null) return null
        const rect = el.getBoundingClientRect()
        const frac = (y - rect.top) / Math.max(1, rect.height)
        if (row.type === 'folder' && frac >= 0.25 && frac <= 0.75) {
          if (forbidden.has(id)) return null
          return { kind: 'folder', folderId: id }
        }
        const after = frac > 0.5
        const siblings = t.children(row.parentId).filter((n) => n.id !== current.node.id)
        const at = siblings.findIndex((n) => n.id === id)
        return {
          kind: 'row',
          parentId: row.parentId,
          index: at === -1 ? siblings.length : at + (after ? 1 : 0),
          rowId: id,
          position: after ? 'after' : 'before'
        }
      }
      const strip = stripRef.current
      if (!strip) return null
      const band = strip.getBoundingClientRect()
      if (y < band.top - 8 || y > band.bottom + 8) return null
      const { others, liftedAt } = restingChips(current.node.id)
      // The middle of a folder chip (where it is drawn, mid-slide) files the drop inside it; its
      // edges slot beside it.
      for (const { node, rect } of others) {
        if (node.type !== 'folder' || forbidden.has(node.id)) continue
        const visual = motion.visualRect(node.id) ?? rect
        const inset = visual.width * 0.25
        if (x >= visual.left + inset && x <= visual.right - inset)
          return { kind: 'folder', folderId: node.id }
      }
      // The slot is read off the chips as drawn: crossing a chip's midpoint sends it to the
      // other side of the pointer, never through it, so the gap keeps following the pointer.
      let index = 0
      for (const { node, rect } of others) {
        const visual = motion.visualRect(node.id) ?? rect
        if (x > visual.left + visual.width / 2) index++
      }
      let lineX: number
      if (index > liftedAt) lineX = others[index - 1].rect.right - current.width / 2
      else if (index < liftedAt) lineX = others[index].rect.left + current.width / 2
      else {
        const own = motion.restingRect(current.node.id)
        lineX = own ? own.left + own.width / 2 : band.left
      }
      return { kind: 'slot', index, lineX }
    },
    [motion, restingChips, stripRef]
  )

  /** Neighbours make room: chips between the slot and the gap shift by the chip's width. */
  const slideFor = useCallback(
    (current: BarDrag, next: BarDropTarget | null): void => {
      // Resting on a folder chip (or inside its panel) keeps the strip as it is: a chip the
      // pointer has just reached must not slide back out from under it.
      if (next && next.kind !== 'slot') return
      const offsets = new Map<string, number>()
      if (next) {
        const strip = stripRef.current
        const gap = strip ? parseFloat(getComputedStyle(strip).columnGap) || 0 : 0
        const shift = current.width + gap
        const { others, liftedAt } = restingChips(current.node.id)
        others.forEach(({ node }, j) => {
          if (j >= liftedAt && j < next.index) offsets.set(node.id, -shift)
          else if (j >= next.index && j < liftedAt) offsets.set(node.id, shift)
        })
      }
      motion.slide(offsets)
    },
    [motion, restingChips, stripRef]
  )

  /** Resting on a folder for half a second opens it; moving back onto the strip closes it. */
  const trackHold = useCallback(
    (next: BarDropTarget | null): void => {
      const folderId = next?.kind === 'folder' ? next.folderId : null
      if (folderId && folderId === heldOpen.current) return
      if (hold.current && hold.current.folderId !== folderId) clearHold()
      if (folderId && !hold.current) {
        hold.current = {
          folderId,
          timer: setTimeout(() => {
            hold.current = null
            heldOpen.current = folderId
            latest.current.onHoldFolder(folderId)
          }, HOLD_TO_OPEN_MS)
        }
      }
      if (next?.kind === 'slot' && heldOpen.current) {
        heldOpen.current = null
        latest.current.onHoldFolder(null)
      }
    },
    [clearHold]
  )

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
      if (!settleTo) {
        // Into a folder: the ghost dissolves where it is.
        if (ghost) {
          ghost.style.transition = 'opacity 120ms var(--zen-ease)'
          ghost.style.opacity = '0'
        }
        setTimeout(settled, 130)
        return
      }
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
          setTimeout(settled, 100)
        }
      )
      springs.current = { x, y }
      x.start(from.x, 0, settleTo.x)
      y.start(from.y, 0, settleTo.y)
      if (ghost) ghost.style.transition = 'opacity 100ms var(--zen-ease)'
    },
    [placeGhost]
  )

  const startDrag = useCallback(
    (e: React.PointerEvent, node: BookmarkNode, chipEl: HTMLElement): void => {
      if (e.button !== 0 || e.pointerType !== 'mouse') return
      const startX = e.clientX
      const startY = e.clientY
      const rect = chipEl.getBoundingClientRect()
      const pointerId = e.pointerId
      let dragging = false
      stopSprings()
      clearHold()
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
          const next: BarDrag = {
            node,
            width: rect.width,
            height: rect.height,
            dx: startX - rect.left,
            dy: startY - rect.top,
            originX: rect.left,
            originY: rect.top,
            settling: false
          }
          dragRef.current = next
          setDrag(next)
        }
        const current = dragRef.current
        if (!current) return
        placeGhost(ev.clientX - current.dx, ev.clientY - current.dy)
        const next = resolveTarget(ev.clientX, ev.clientY, current)
        setTarget(next)
        slideFor(current, next)
        trackHold(next)
      }

      const cleanup = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        window.removeEventListener('keydown', onKey, true)
        document.body.style.cursor = ''
        clearHold()
        heldOpen.current = null
      }

      const cancel = (): void => {
        setTarget(null)
        const current = dragRef.current
        if (!current) return
        endedAt.current = performance.now()
        motion.slide(new Map())
        setDrag({ ...current, settling: true })
        finish({ x: current.originX, y: current.originY })
      }

      const onUp = (ev: PointerEvent): void => {
        if (ev.pointerId !== pointerId) return
        cleanup()
        if (!dragging) return
        const current = dragRef.current
        if (!current) return
        endedAt.current = performance.now()
        const drop = resolveTarget(ev.clientX, ev.clientY, current)
        setTarget(null)
        if (!drop) {
          cancel()
          return
        }
        setDrag({ ...current, settling: true })
        const ids = [current.node.id]
        switch (drop.kind) {
          case 'slot': {
            run('bookmark.move', { ids, parentId: barId, index: drop.index })
            const strip = stripRef.current?.getBoundingClientRect()
            finish({ x: drop.lineX - current.width / 2, y: strip ? strip.top : current.originY })
            return
          }
          case 'folder':
            run('bookmark.move', { ids, parentId: drop.folderId })
            break
          case 'row':
            run('bookmark.move', { ids, parentId: drop.parentId, index: drop.index })
            break
          case 'append':
            run('bookmark.move', { ids, parentId: drop.parentId })
            break
        }
        latest.current.onHoldFolder(null)
        finish(null)
      }

      const onCancel = (ev: PointerEvent): void => {
        if (ev.pointerId !== pointerId) return
        cleanup()
        cancel()
      }

      const onKey = (ev: KeyboardEvent): void => {
        // Escape lets go without dropping: the ghost returns to its slot.
        if (ev.key !== 'Escape') return
        ev.preventDefault()
        ev.stopPropagation()
        cleanup()
        latest.current.onHoldFolder(null)
        cancel()
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
      window.addEventListener('keydown', onKey, true)
    },
    [
      barId,
      clearHold,
      finish,
      motion,
      placeGhost,
      resolveTarget,
      slideFor,
      stopSprings,
      stripRef,
      trackHold
    ]
  )

  // The ghost mounts after the first move: put it under the pointer right away.
  useEffect(() => {
    if (drag && !drag.settling) placeGhost(live.current.x, live.current.y)
  }, [drag, placeGhost])

  const justDragged = useCallback(() => performance.now() - endedAt.current < 250, [])

  return { drag, target, startDrag, ghostRef, justDragged }
}
