import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { NewTabShortcut } from '@shared/types'
import { run } from '@renderer/lib/api'
import { collectCells, FlipTracker, REDUCED_FADE_MS } from '@renderer/lib/motion/flip'
import { reducedMotion, SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { VelocityTracker } from '@renderer/lib/motion/velocity'
import type { LongPressDrag } from '../phone/useLongPress'

/** The tile in the hand is drawn at this scale (v2 §11.4: the lifted card's). */
export const TILE_LIFT_SCALE = 1.02
/** The lift's ease, 120 ms on `--zen-ease` (v2 §11.1's short transition), written inline while the tile is held still. */
const LIFT_TRANSITION = 'transform 120ms cubic-bezier(0.2, 0.8, 0.2, 1)'
/**
 * How far the finger travels from where it last chose a slot before the slot is looked up again
 * (v2 §11.4: the target belongs to the finger, past the 8 px touch slop, never to a reflow).
 */
const RETARGET_SLOP = 8
/** The least distance the release glide runs over, so a drop on the slot still takes the spring's time. */
const MIN_LANDING = 1

/**
 * The tile grid's FLIP set: every `data-cell` under the grid glides to its new slot on the one
 * spring when the grid re-lays itself out (a drag's draft, a pin, a removal). The scroller the
 * positions are read against is the page's column, which the grid sits in, so a page scrolled
 * between two commits does not read as a glide. Listening for as long as the grid is mounted
 * (StrictMode's mount, cleanup, mount included), as the overview's `useFlip` does.
 */
export function useTileFlip(grid: RefObject<HTMLElement | null>): FlipTracker {
  const tracker = useMemo(() => new FlipTracker(), [])
  useLayoutEffect(() => {
    const root = grid.current
    const scroller = root?.closest<HTMLElement>('.zen-ntp-scroll') ?? root
    tracker.commit(collectCells(root), scroller, true)
  })
  useEffect(() => {
    tracker.listen()
    return () => tracker.dispose()
  }, [tracker])
  return tracker
}

export interface TileReorder {
  /**
   * The pinned tiles' addresses in the order drawn: the draft a drag is making (kept until the
   * core's list has it), or null for the list's own order.
   */
  order: readonly string[] | null
  /** The address of the tile in the hand – lifted by a hold, or dragged – null when none. */
  held: string | null
  /**
   * What the grid drew this render: its pinned tiles' addresses, first to last, so the drag knows
   * the slots it may aim at. Called from the grid's render.
   */
  observe: (pinned: readonly string[]) => void
  /** A hold on the tile `url` (the button `el`) was recognised: a pinned tile lifts. */
  hold: (url: string, el: HTMLElement) => void
  /** The hold ended without a drag: the tile is put down. */
  unhold: () => void
  /** The held tile is moved: its drag, or null when `url` is not a pinned tile. */
  drag: (url: string, el: HTMLElement, e: PointerEvent) => LongPressDrag | null
}

interface Session {
  url: string
  /** The tile's button, which carries the finger-following transform. */
  el: HTMLElement
  /** The button's cell: the slot the tile will land in, moving with the draft. */
  li: HTMLElement
  /** The tile's box at the lift, in window coordinates. */
  box: DOMRect
  /** The finger where the drag began, and where it last chose a slot. */
  x0: number
  y0: number
  tx: number
  ty: number
  /** The finger now. */
  x: number
  y: number
  /** The pinned order the drag set out from: what a cancelled drag goes back to. */
  base: readonly string[]
  velocity: VelocityTracker
}

/**
 * Reordering the new tab page's pinned shortcuts by hold-and-drag on the grid (NTP-06, v2
 * §11.4). A hold lifts a pinned tile (its scale eased up over 120 ms); the finger then carries it
 * – 1:1, its transform written per move – over the pinned slots, and as its centre comes nearest
 * another slot the draft order changes: the grid re-renders in the draft, the tile's own cell
 * (the hole) moves with it, and the FLIP tracker glides every other tile to its new slot on the
 * one spring. Only the pinned tiles are slots – the most visited ones follow them, ranked by the
 * history, and are not moved. On release the draft goes to the core (`newtab.reorderShortcuts`;
 * the shared device list `newTabDevice` is the store) and is drawn until the list comes back
 * with it, while the tile glides home into its slot on `SPRING_SNAPPY` from the finger's
 * velocity; under reduced motion it is at its slot at once and fades in there over 120 ms (v2
 * §11.3, #311). The tile is the one in the hand (`held`: its cell's `data-held`, the z-index
 * that keeps it over its neighbours and the lifted look) from the hold to the end of that
 * glide, as the overview's card is its ghost until the ghost has landed; a hold or a drag while
 * the glide runs is refused. A drag the touch loses goes back to the order it set out from, and
 * so does one whose tile leaves the DOM under the finger (its pin removed meanwhile): the
 * touch's listeners went with the tile's element, so no release will come, and the session
 * ends at that commit.
 */
export function useTileReorder(
  shortcuts: readonly NewTabShortcut[],
  tracker: FlipTracker
): TileReorder {
  /** The pinned order the last drag wrote (its draft, moving as the finger does); null for the list's. */
  const [written, setOrder] = useState<readonly string[] | null>(null)
  const [held, setHeld] = useState<string | null>(null)
  /** Counts the drops: a drop's commit rides on this when the draft is already the order drawn. */
  const [, setDrops] = useState(0)
  const grid = useRef<readonly string[]>([])
  /** The lifted tile's button, holding the lift's scale until it is dragged or put down. */
  const lifted = useRef<HTMLElement | null>(null)
  const session = useRef<Session | null>(null)
  /** A drop that has re-rendered the grid in its final order: the tile lands in the next commit. */
  const landing = useRef<Session | null>(null)
  const spring = useRef<SpringAnimation | null>(null)

  // The draft stands until the core's list is in that order – or has changed hands meanwhile
  // (a pin, a removal, another device), when the list's own order is the one to draw.
  const order = useMemo(() => {
    if (!written) return null
    const urls = shortcuts.map((s) => s.url)
    const same = urls.length === written.length && urls.every((u, i) => u === written[i])
    const sameSet = written.every((u) => urls.includes(u))
    return same || !sameSet ? null : written
  }, [written, shortcuts])
  const orderRef = useRef(order)
  const heldRef = useRef(held)
  useLayoutEffect(() => {
    orderRef.current = order
    heldRef.current = held
  })

  useEffect(
    () => () => {
      spring.current?.stop()
      session.current = null
      landing.current = null
    },
    []
  )

  /** Draw the held tile where the finger has carried it: its box at the lift plus the finger's travel, less its cell's place. */
  const place = (s: Session): void => {
    const slot = s.li.getBoundingClientRect()
    const x = s.box.left + (s.x - s.x0) - slot.left
    const y = s.box.top + (s.y - s.y0) - slot.top
    s.el.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${TILE_LIFT_SCALE})`
  }

  /** The pinned slot the tile's centre is nearest to, by the slots' settled rectangles. */
  const nearestSlot = (s: Session, shown: readonly string[]): number => {
    const cx = s.box.left + s.box.width / 2 + (s.x - s.x0)
    const cy = s.box.top + s.box.height / 2 + (s.y - s.y0)
    let best = shown.indexOf(s.url)
    let bestDistance = Infinity
    shown.forEach((url, i) => {
      const rect = url === s.url ? s.li.getBoundingClientRect() : tracker.layoutRect(url)
      if (!rect) return
      const d = Math.hypot(rect.left + rect.width / 2 - cx, rect.top + rect.height / 2 - cy)
      if (d < bestDistance) {
        bestDistance = d
        best = i
      }
    })
    return best
  }

  /** The hand is empty of `url`: its cell's `data-held` goes (unless another tile has been taken up since). */
  const putDown = (url: string): void => setHeld((h) => (h === url ? null : h))

  /**
   * The released tile glides from the finger into its slot; the transform is gone at the
   * landing, and so is the hand's mark – the tile stays over its neighbours to the end of the
   * glide, not to the drop.
   */
  const land = (s: Session): void => {
    const slot = s.li.getBoundingClientRect()
    const x = s.box.left + (s.x - s.x0) - slot.left
    const y = s.box.top + (s.y - s.y0) - slot.top
    const travel = Math.max(MIN_LANDING, Math.hypot(x, y))
    const { vx, vy } = s.velocity.velocity(performance.now())
    // The finger's speed along the way home (positive: still moving away from it).
    const v = travel > MIN_LANDING ? (vx * x + vy * y) / travel : 0
    spring.current?.stop()
    const el = s.el
    const anim = new SpringAnimation(
      SPRING_SNAPPY,
      (p) => {
        const k = Math.max(0, p / travel)
        el.style.transform =
          k < 0.001
            ? ''
            : `translate(${(x * k).toFixed(2)}px, ${(y * k).toFixed(2)}px) scale(${(1 + (TILE_LIFT_SCALE - 1) * k).toFixed(4)})`
      },
      () => {
        el.style.transform = ''
        if (spring.current === anim) spring.current = null
        putDown(s.url)
      }
    )
    spring.current = anim
    if (reducedMotion()) {
      // No glide: at its slot at once, arriving on the 120 ms fade every glide becomes (§11.3).
      anim.start(travel, 0, 0)
      el.animate?.([{ opacity: 0 }, { opacity: 1 }], {
        duration: REDUCED_FADE_MS,
        easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)'
      })
      return
    }
    anim.start(travel, v, 0)
  }

  /**
   * A drag whose tile has left the DOM under the finger (its pin removed by another device or
   * a hidden host meanwhile, the grid re-keyed): the touch's listeners went with the element,
   * so the release will never come – the drag is over here, back to the order it set out from.
   */
  const lose = (s: Session): void => {
    session.current = null
    s.el.style.transform = ''
    s.el.style.transition = ''
    putDown(s.url)
    setOrder(s.base)
  }

  // After a commit that moved the held tile's cell (the draft changed), the tile is drawn where
  // the finger is again before the frame paints; after the commit that dropped it, it lands.
  // A commit that took the tile itself out of the DOM ends its drag instead, or its landing.
  useLayoutEffect(() => {
    const s = session.current
    if (s) {
      if (s.el.isConnected) place(s)
      else lose(s)
    }
    const l = landing.current
    if (!l) return
    landing.current = null
    if (l.el.isConnected) land(l)
    else putDown(l.url)
  })

  const finish = (e: PointerEvent, cancelled: boolean): void => {
    const s = session.current
    if (!s) return
    session.current = null
    s.x = e.clientX
    s.y = e.clientY
    s.velocity.add(e.timeStamp, e.clientX, e.clientY)
    const draft = orderRef.current ?? grid.current
    const changed =
      !cancelled && !(draft.length === s.base.length && draft.every((u, i) => u === s.base[i]))
    if (changed) {
      const byUrl = new Map(shortcuts.map((sc) => [sc.url, sc]))
      const ids = [
        ...draft.map((url) => byUrl.get(url)?.id ?? ''),
        ...shortcuts.filter((sc) => !draft.includes(sc.url)).map((sc) => sc.id)
      ].filter((id) => id !== '')
      void run('newtab.reorderShortcuts', { ids })
    }
    // The landing waits for the commit the drop makes (the count is sure to change, where the
    // draft may already be the order drawn); the tile stays the one in the hand until it has
    // landed. A cancelled drag is drawn back in the order it set out from (the list's own, when
    // that is what it was, which the derivation above reads as no draft).
    landing.current = s
    setDrops((n) => n + 1)
    setOrder(cancelled ? s.base : changed ? draft : null)
  }

  return useMemo<TileReorder>(
    () => ({
      order,
      held,
      observe: (pinned) => {
        grid.current = pinned
      },
      hold: (url, el) => {
        if (session.current || spring.current?.running) return
        if (!grid.current.includes(url)) return
        lifted.current = el
        el.style.transition = LIFT_TRANSITION
        el.style.transform = `scale(${TILE_LIFT_SCALE})`
        setHeld(url)
      },
      unhold: () => {
        if (session.current) return
        const el = lifted.current
        // Nothing lifted: the hold was refused (a glide still running, whose tile the hand's
        // mark belongs to until it lands), and there is nothing to put down.
        if (!el) return
        lifted.current = null
        // Eased back down on the lift's own transition, which goes with it.
        el.style.transform = ''
        const clear = (): void => {
          el.style.transition = ''
          el.removeEventListener('transitionend', clear)
        }
        el.addEventListener('transitionend', clear)
        setHeld(null)
      },
      drag: (url, el, e) => {
        // Refused while a dropped tile glides, as the hold is: one tile in the hand at a time.
        if (session.current || spring.current?.running || !grid.current.includes(url)) return null
        const li = el.parentElement
        if (!li) return null
        // The drag writes the transform per move: nothing may ease it after the finger.
        lifted.current = null
        el.style.transition = ''
        const base = orderRef.current ?? grid.current
        const s: Session = {
          url,
          el,
          li,
          box: el.getBoundingClientRect(),
          x0: e.clientX,
          y0: e.clientY,
          tx: e.clientX,
          ty: e.clientY,
          x: e.clientX,
          y: e.clientY,
          base,
          velocity: new VelocityTracker()
        }
        // The box is the tile's own, not its lifted scale's: the scale is drawn about its centre.
        const grow = (1 - 1 / TILE_LIFT_SCALE) / 2
        s.box = new DOMRect(
          s.box.left + s.box.width * grow,
          s.box.top + s.box.height * grow,
          s.box.width / TILE_LIFT_SCALE,
          s.box.height / TILE_LIFT_SCALE
        )
        session.current = s
        s.velocity.add(e.timeStamp, e.clientX, e.clientY)
        if (heldRef.current !== url) setHeld(url)
        return {
          move: (ev) => {
            if (session.current !== s) return
            s.x = ev.clientX
            s.y = ev.clientY
            s.velocity.add(ev.timeStamp, ev.clientX, ev.clientY)
            place(s)
            if (Math.hypot(ev.clientX - s.tx, ev.clientY - s.ty) < RETARGET_SLOP) return
            s.tx = ev.clientX
            s.ty = ev.clientY
            const shown = orderRef.current ?? grid.current
            const from = shown.indexOf(s.url)
            if (from < 0) return
            const to = nearestSlot(s, shown)
            if (to === from) return
            const next = shown.filter((u) => u !== s.url)
            next.splice(to, 0, s.url)
            setOrder(next)
          },
          end: finish
        }
      }
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the callbacks read their refs
    [order, held, shortcuts, tracker]
  )
}
