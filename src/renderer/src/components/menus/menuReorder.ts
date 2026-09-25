import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  menuSectionOf,
  moveMenuSectionItem,
  type MenuSection,
  type MenuSections
} from '@renderer/lib/menuEdit'
import { collectCells, FlipTracker, REDUCED_FADE_MS } from '@renderer/lib/motion/flip'
import { reducedMotion, SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { VelocityTracker } from '@renderer/lib/motion/velocity'
import type { LongPressDrag } from '../phone/useLongPress'

/** The item in the hand is drawn at this scale (v2 §11.4, §9.4: the lifted card's). */
export const MENU_LIFT_SCALE = 1.02
/** The lift's ease, 120 ms on `--zen-ease` (v2 §11.1's short transition), written inline while the item is held still. */
const LIFT_TRANSITION = 'transform 120ms cubic-bezier(0.2, 0.8, 0.2, 1)'
/**
 * How far the finger travels from where it last chose a slot before the slot is looked up again
 * (v2 §11.4: the target belongs to the finger, past the 8 px touch slop, never to a reflow).
 */
const RETARGET_SLOP = 8
/** The least distance the release glide runs over, so a drop on the slot still takes the spring's time. */
const MIN_LANDING = 1
/** A finger this close to the sheet body's edge scrolls the body while an item is in the hand. */
const EDGE = 32
/** The fastest edge scroll, px per frame. */
const EDGE_SPEED = 12

/**
 * The edit pose's FLIP set: every `data-cell` under `root` – the rows, the icon row's buttons
 * and the hairlines between the groups – glides to its new slot on the one spring when the
 * draft order changes (v2 §11.4). The positions are read against the sheet body's scroller, so
 * a body scrolled between two commits does not read as a glide. Listening for as long as the
 * pose is mounted (StrictMode's mount, cleanup, mount included), as the tile grid's does.
 */
export function useMenuFlip(root: RefObject<HTMLElement | null>): FlipTracker {
  const tracker = useMemo(() => new FlipTracker(), [])
  useLayoutEffect(() => {
    const el = root.current
    const scroller = el?.closest<HTMLElement>('.zen-sheet-scroll') ?? el
    tracker.commit(collectCells(el), scroller, true)
  })
  useEffect(() => {
    tracker.listen()
    return () => tracker.dispose()
  }, [tracker])
  return tracker
}

export interface MenuReorder {
  /** The key of the item in the hand – lifted by a hold, or dragged – null when none. */
  held: string | null
  /** A hold on the item `key` (the element `el`) was recognised: the item lifts. */
  hold: (key: string, el: HTMLElement) => void
  /** The hold ended without a drag: the item is put down. */
  unhold: () => void
  /** The held item is moved: its drag, or null when the item is not one of the sections'. */
  drag: (key: string, el: HTMLElement, e: PointerEvent) => LongPressDrag | null
}

interface Session {
  key: string
  section: MenuSection
  /** The axis the section lays its slots along: the finger's travel on the other one is ignored. */
  axis: 'x' | 'y'
  /** The item's button, which carries the finger-following transform. */
  el: HTMLElement
  /** The button's cell: the slot the item will land in, moving with the draft. */
  li: HTMLElement
  /** The item's box at the lift, in window coordinates (its own size, the lift's scale taken off). */
  box: DOMRect
  /** Its cell's box at the lift: what its layout position is measured from as the cell moves. */
  origin: DOMRect
  /** The finger where the drag began, and where it last chose a slot. */
  x0: number
  y0: number
  tx: number
  ty: number
  /** The finger now. */
  x: number
  y: number
  /** The sections the drag set out from: what a cancelled drag goes back to. */
  base: MenuSections
  /** The sheet body that scrolls under a finger at its edge, and the frame loop that scrolls it. */
  scroller: HTMLElement | null
  frame: number
  velocity: VelocityTracker
}

/**
 * Reordering the phone app menu's items by hold-and-drag in the sheet's edit pose (TB-22,
 * MOT-23; v2 §11.4). A hold lifts an item (its scale eased up over 120 ms; its cell's
 * `data-held` carries the lifted look and the z-index that keeps it over its neighbours); the
 * finger then carries it – 1:1 along its section's axis, its transform written per move – over
 * its section's slots, and as its centre comes nearest another slot the draft changes: the pose
 * re-renders in the draft, the item's own cell (the hole) moves with it, and the FLIP tracker
 * glides every other cell to its new slot on the one spring. The icon row and the list are
 * separate sections: an item never crosses from one to the other (§9.13). A finger at the
 * body's edge scrolls it under the item, so a row reaches the far end of a list longer than the
 * sheet. On release the item glides home into its slot on `SPRING_SNAPPY` from the finger's
 * velocity; under reduced motion it is at its slot at once and fades in there over 120 ms (v2
 * §11.3). The item is the one in the hand from the hold to the end of that glide; a hold or a
 * drag while the glide runs is refused. A drag the touch loses goes back to the order it set
 * out from, and so does one whose item leaves the DOM under the finger. The draft is the
 * caller's state (`setSections`); nothing is saved here – Done saves.
 */
export function useMenuReorder(
  sections: MenuSections,
  setSections: (next: MenuSections) => void,
  tracker: FlipTracker
): MenuReorder {
  const [held, setHeld] = useState<string | null>(null)
  /** Counts the drops: a drop's commit rides on this when the draft is already the order drawn. */
  const [, setDrops] = useState(0)
  const sectionsRef = useRef(sections)
  const setSectionsRef = useRef(setSections)
  const heldRef = useRef(held)
  useLayoutEffect(() => {
    sectionsRef.current = sections
    setSectionsRef.current = setSections
    heldRef.current = held
  })
  /** The lifted item's button, holding the lift's scale until it is dragged or put down. */
  const lifted = useRef<HTMLElement | null>(null)
  const session = useRef<Session | null>(null)
  /** A drop that has re-rendered the pose in its final order: the item lands in the next commit. */
  const landing = useRef<Session | null>(null)
  const spring = useRef<SpringAnimation | null>(null)

  useEffect(
    () => () => {
      spring.current?.stop()
      const s = session.current
      if (s?.frame) cancelAnimationFrame(s.frame)
      session.current = null
      landing.current = null
    },
    []
  )

  /** The finger's travel since the drag began, along the section's axis alone. */
  const travelOf = (s: Session): { dx: number; dy: number } => ({
    dx: s.axis === 'x' ? s.x - s.x0 : 0,
    dy: s.axis === 'y' ? s.y - s.y0 : 0
  })

  /**
   * How far the held item is drawn from its layout position: where its cell was at the lift plus
   * the finger's travel, less where its cell is now (the hole moves with the draft).
   */
  const offsetOf = (s: Session): { x: number; y: number } => {
    const slot = s.li.getBoundingClientRect()
    const { dx, dy } = travelOf(s)
    return { x: s.origin.left + dx - slot.left, y: s.origin.top + dy - slot.top }
  }

  /** Draw the held item where the finger has carried it. */
  const place = (s: Session): void => {
    const { x, y } = offsetOf(s)
    s.el.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${MENU_LIFT_SCALE})`
  }

  /** The slot of its section the item's centre is nearest to along the axis, by the slots' settled rectangles. */
  const nearestSlot = (s: Session, keys: readonly string[]): number => {
    const { dx, dy } = travelOf(s)
    const cx = s.box.left + s.box.width / 2 + dx
    const cy = s.box.top + s.box.height / 2 + dy
    let best = keys.indexOf(s.key)
    let bestDistance = Infinity
    keys.forEach((key, i) => {
      const rect = key === s.key ? s.li.getBoundingClientRect() : tracker.layoutRect(key)
      if (!rect) return
      // A collapsed hairline (beside another, or at an end) has no extent along the axis: it is
      // not a slot the finger can be nearest to.
      if ((s.axis === 'x' ? rect.width : rect.height) < 1) return
      const d =
        s.axis === 'x'
          ? Math.abs(rect.left + rect.width / 2 - cx)
          : Math.abs(rect.top + rect.height / 2 - cy)
      if (d < bestDistance) {
        bestDistance = d
        best = i
      }
    })
    return best
  }

  /** The draft follows the finger: the item's slot is the one its centre is nearest to. */
  const retarget = (s: Session): void => {
    const current = sectionsRef.current
    const keys = current[s.section].map((item) => item.key ?? '')
    const from = keys.indexOf(s.key)
    if (from < 0) return
    const to = nearestSlot(s, keys)
    if (to === from) return
    setSectionsRef.current(moveMenuSectionItem(current, s.section, from, to))
  }

  /**
   * A finger held at the body's top or bottom edge scrolls the body under the item, faster the
   * nearer the edge, frame by frame while the drag lasts; the item is redrawn under the finger
   * and the slot looked up again after every step, since the slots moved under it.
   */
  const scrollLoop = (s: Session): void => {
    s.frame = requestAnimationFrame(() => {
      if (session.current !== s) return
      const sc = s.scroller
      if (sc && s.axis === 'y') {
        const r = sc.getBoundingClientRect()
        let speed = 0
        if (s.y < r.top + EDGE) speed = -EDGE_SPEED * Math.min(1, (r.top + EDGE - s.y) / EDGE)
        else if (s.y > r.bottom - EDGE)
          speed = EDGE_SPEED * Math.min(1, (s.y - (r.bottom - EDGE)) / EDGE)
        if (speed !== 0) {
          const before = sc.scrollTop
          sc.scrollTop = before + speed
          if (sc.scrollTop !== before) {
            place(s)
            retarget(s)
          }
        }
      }
      scrollLoop(s)
    })
  }

  /** The hand is empty of `key`: its cell's `data-held` goes (unless another item has been taken up since). */
  const putDown = (key: string): void => setHeld((h) => (h === key ? null : h))

  /**
   * The released item glides from the finger into its slot; the transform is gone at the
   * landing, and so is the hand's mark – the item stays over its neighbours to the end of the
   * glide, not to the drop.
   */
  const land = (s: Session): void => {
    const { x, y } = offsetOf(s)
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
            : `translate(${(x * k).toFixed(2)}px, ${(y * k).toFixed(2)}px) scale(${(1 + (MENU_LIFT_SCALE - 1) * k).toFixed(4)})`
      },
      () => {
        el.style.transform = ''
        if (spring.current === anim) spring.current = null
        putDown(s.key)
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

  /** A drag whose item has left the DOM under the finger: no release will come; the drag is over here. */
  const lose = (s: Session): void => {
    session.current = null
    if (s.frame) cancelAnimationFrame(s.frame)
    s.el.style.transform = ''
    s.el.style.transition = ''
    putDown(s.key)
    setSectionsRef.current(s.base)
  }

  // After a commit that moved the held item's cell (the draft changed), the item is drawn where
  // the finger is again before the frame paints; after the commit that dropped it, it lands.
  // A commit that took the item itself out of the DOM ends its drag instead, or its landing.
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
    else putDown(l.key)
  })

  const finish = (e: PointerEvent, cancelled: boolean): void => {
    const s = session.current
    if (!s) return
    session.current = null
    if (s.frame) cancelAnimationFrame(s.frame)
    s.x = e.clientX
    s.y = e.clientY
    s.velocity.add(e.timeStamp, e.clientX, e.clientY)
    // The landing waits for the commit the drop makes (the count is sure to change, where the
    // draft may already be the order drawn); the item stays the one in the hand until it has
    // landed. A cancelled drag is drawn back in the order it set out from.
    landing.current = s
    setDrops((n) => n + 1)
    if (cancelled) setSectionsRef.current(s.base)
  }

  /** Whether the sheet has the touch already: a pan that began before the hold moves the sheet, not a row. */
  const sheetDragging = (el: HTMLElement): boolean =>
    el.closest('.zen-sheet')?.getAttribute('data-dragging') === 'true'

  return useMemo<MenuReorder>(
    () => ({
      held,
      hold: (key, el) => {
        if (session.current || spring.current?.running || sheetDragging(el)) return
        if (!menuSectionOf(sectionsRef.current, key)) return
        lifted.current = el
        el.style.transition = LIFT_TRANSITION
        el.style.transform = `scale(${MENU_LIFT_SCALE})`
        setHeld(key)
      },
      unhold: () => {
        if (session.current) return
        const el = lifted.current
        // Nothing lifted: the hold was refused, and there is nothing to put down.
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
      drag: (key, el, e) => {
        // Refused while a dropped item glides, as the hold is: one item in the hand at a time.
        if (session.current || spring.current?.running || sheetDragging(el)) return null
        const section = menuSectionOf(sectionsRef.current, key)
        const li = el.parentElement
        if (!section || !li) return null
        // The drag writes the transform per move: nothing may ease it after the finger.
        lifted.current = null
        el.style.transition = ''
        // The section's axis: slots side by side lie along x (the icon row at rest), one under
        // another along y (the list, and the row in its list pose).
        const keys = sectionsRef.current[section].map((item) => item.key ?? '')
        const rects = keys
          .filter((k) => k !== key)
          .map((k) => tracker.layoutRect(k))
          .filter((r): r is DOMRect => r !== null)
        const own = li.getBoundingClientRect()
        const axis: Session['axis'] =
          rects.length > 0 && rects.every((r) => Math.abs(r.top - own.top) < 1) ? 'x' : 'y'
        const s: Session = {
          key,
          section,
          axis,
          el,
          li,
          box: el.getBoundingClientRect(),
          origin: own,
          x0: e.clientX,
          y0: e.clientY,
          tx: e.clientX,
          ty: e.clientY,
          x: e.clientX,
          y: e.clientY,
          base: sectionsRef.current,
          scroller: el.closest<HTMLElement>('.zen-sheet-scroll'),
          frame: 0,
          velocity: new VelocityTracker()
        }
        // The box is the item's own, not its lifted scale's: the scale is drawn about its centre.
        const grow = (1 - 1 / MENU_LIFT_SCALE) / 2
        s.box = new DOMRect(
          s.box.left + s.box.width * grow,
          s.box.top + s.box.height * grow,
          s.box.width / MENU_LIFT_SCALE,
          s.box.height / MENU_LIFT_SCALE
        )
        session.current = s
        s.velocity.add(e.timeStamp, e.clientX, e.clientY)
        if (heldRef.current !== key) setHeld(key)
        scrollLoop(s)
        return {
          move: (ev) => {
            if (session.current !== s) return
            // Ours: the sheet's own pan handling, further along the event's path, must not see
            // a move that would otherwise drag the sheet with the row.
            ev.stopPropagation()
            s.x = ev.clientX
            s.y = ev.clientY
            s.velocity.add(ev.timeStamp, ev.clientX, ev.clientY)
            place(s)
            if (Math.hypot(ev.clientX - s.tx, ev.clientY - s.ty) < RETARGET_SLOP) return
            s.tx = ev.clientX
            s.ty = ev.clientY
            retarget(s)
          },
          end: finish
        }
      }
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the callbacks read their refs
    [held, tracker]
  )
}
