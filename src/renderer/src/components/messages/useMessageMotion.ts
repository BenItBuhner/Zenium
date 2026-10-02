import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import {
  allowedAlong,
  dismissPresence,
  dismissSign,
  dragOffset,
  type Axis,
  type DismissDirections
} from '@renderer/lib/gestures/dismiss'
import { cancelFrame, requestFrame } from '@renderer/lib/motion/clock'
import {
  reducedMotion,
  SPRING_GENTLE,
  SPRING_SNAPPY,
  SpringAnimation
} from '@renderer/lib/motion/spring'
import { REDUCED_FADE_MS } from '@shared/toastCard'
import { MESSAGE_INSET } from './stack'
import { useSwipeDismiss, type SwipeDismissHandlers } from './useSwipeDismiss'

export interface MessageMotionOptions {
  /** The edge the card lives at: `1` the bottom (it comes up from below), `-1` the top. */
  home: -1 | 1
  /** Where the card rests along y, from the layer's anchor: its slot in a stack. */
  slot: number
  /** Which ways a swipe may take the card off. */
  dirs: DismissDirections
  /** The message is on its way out: the card leaves by its home edge. */
  leaving: boolean
  /**
   * The card is under a cover (the open tab overview on a touch host, §9.33): it folds away by
   * its home edge – the way it leaves, without going – and comes back to its slot when the cover
   * lifts; one that arrives under a cover waits at its edge and comes in when the cover lifts.
   * Its clock is the caller's to pause (`lib/ui.ts` `coverBanners`).
   */
  hidden?: boolean
  /** A finger is on the card (its clock pauses) or has left it. */
  onHold(held: boolean): void
  /** A swipe committed: the card is on its way off; the message should be marked leaving. */
  onSwipe(): void
  /** The card is out of sight and can go. */
  onGone(): void
  /**
   * How far out of its slot the card is on its way off along `axis` – 0 in the slot, 1 gone –
   * once per frame while a finger has it, while it springs back from one, and while it leaves;
   * 0 once more when it is back at rest. The stack rounds the corners a card uncovers on it
   * (v2 §9.33).
   */
  onTravel?(progress: number, axis: Axis): void
}

type Phase = 'entering' | 'resting' | 'dragging' | 'leaving' | 'hidden'

/**
 * Motion of one message card: it springs in from its home edge (`SPRING_GENTLE`, a hair of
 * overshoot), slides to a new slot when the stack shifts, follows a finger along the axis the
 * swipe settles on – rubber-banding where it may not leave – and springs off (`SPRING_SNAPPY`)
 * when let go past the threshold, flung, timed out or dismissed. Two springs, one per axis, own
 * the transform, and a finger can catch either. The layer clips the cards to the content frame,
 * so arriving and leaving cards emerge from and vanish at its edge. Opacity follows the card's
 * travel towards the way out – a finger thins it, a spring-back restores it along the same path
 * – and that one travel value (§11: never a second timer) is what `onTravel` reports and what
 * `data-uncover` marks on the card. With motion reduced (v2 §11.3) nothing travels: the card
 * appears in its slot and leaves from it on a 120 ms opacity fade, a finger still drags it 1:1
 * and a release jumps to its outcome.
 *
 * Under a cover (`hidden`) the card folds away by its home edge on the exit spring and stays
 * there, its travel held at the far end (thinned to nothing, the corners it uncovered rounded,
 * `data-covered` on it); the cover lifting brings it back to its slot on the arrival spring,
 * the travel running back with it. A card that arrives under a cover is parked at its edge
 * from the first frame and comes in when the cover lifts. With motion reduced it fades in
 * place instead, as it arrives and leaves.
 */
export function useMessageMotion(options: MessageMotionOptions): {
  ref: RefObject<HTMLDivElement | null>
  handlers: SwipeDismissHandlers
} {
  const ref = useRef<HTMLDivElement>(null)
  const latest = useRef(options)
  useLayoutEffect(() => {
    latest.current = options
  })
  const phase = useRef<Phase>('entering')
  const pos = useRef({ x: 0, y: 0 })
  const size = useRef({ width: 0, height: 0 })
  const exitAxis = useRef<Axis | null>(null)
  /**
   * The axis of the card's excursion out of its slot – a drag, the spring back from one, or the
   * exit – while one is on; null in the slot and on the way in.
   */
  const travelAxis = useRef<Axis | null>(null)
  const springs = useRef<{ x: SpringAnimation; y: SpringAnimation } | null>(null)
  const fadeFrame = useRef<number | null>(null)

  const cancelFade = (): void => {
    if (fadeFrame.current !== null) cancelFrame(fadeFrame.current)
    fadeFrame.current = null
  }

  /**
   * The reduced-motion fade (§11.3), written per frame: the reduced-motion stylesheet cuts
   * every CSS transition to nothing, so a transition could not carry it. Runs from the card's
   * present opacity so a card thinned by a finger does not brighten first – on the chrome's one
   * animation clock, with the springs (motion spec §6).
   */
  const fade = (to: 0 | 1, done: () => void): void => {
    cancelFade()
    const el = ref.current
    if (!el) {
      done()
      return
    }
    const from = to === 1 ? 0 : Number.parseFloat(el.style.opacity) || 1
    const startedAt = performance.now()
    el.style.opacity = from.toFixed(3)
    const step = (now: number): void => {
      const t = Math.min(1, (now - startedAt) / REDUCED_FADE_MS)
      el.style.opacity = (from + (to - from) * t).toFixed(3)
      if (t < 1) {
        fadeFrame.current = requestFrame(step)
        return
      }
      fadeFrame.current = null
      done()
    }
    fadeFrame.current = requestFrame(step)
  }

  /** Distance along `axis` at which the card is out of sight: its own extent (plus the inset). */
  const reach = (axis: Axis): number =>
    axis === 'x'
      ? Math.max(1, size.current.width)
      : Math.max(1, size.current.height + MESSAGE_INSET)

  const paint = (): void => {
    const el = ref.current
    if (!el) return
    const { x, y } = pos.current
    el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`
    const axis = travelAxis.current
    if (!axis) return
    const d = axis === 'x' ? x : y - latest.current.slot
    // Only travel that could take the card off counts; a rubber-banded pull is not on its way.
    const outward = allowedAlong(d, axis, latest.current.dirs)
    const presence = outward ? dismissPresence(d, reach(axis)) : 1
    el.style.opacity = outward ? presence.toFixed(3) : ''
    if (el.dataset.uncover !== axis) el.dataset.uncover = axis
    latest.current.onTravel?.(1 - presence, axis)
  }

  /** The excursion is over: the card is back in its slot (or gone). */
  const settled = (): void => {
    const axis = travelAxis.current
    travelAxis.current = null
    const el = ref.current
    if (el) {
      el.style.opacity = ''
      delete el.dataset.uncover
    }
    if (axis) latest.current.onTravel?.(0, axis)
  }

  const setPhase = (next: Phase): void => {
    phase.current = next
    const el = ref.current
    if (!el) return
    if (next === 'resting') delete el.dataset.moving
    else el.dataset.moving = ''
  }

  const rested = (axis: Axis): void => {
    if (phase.current === 'leaving') {
      if (axis === exitAxis.current) latest.current.onGone()
      return
    }
    if (phase.current === 'dragging') return
    const other = axis === 'x' ? 'y' : 'x'
    if (!ensureSprings()[other].running) {
      if (phase.current === 'hidden') {
        // Folded away: its travel stays at the far end until the cover lifts; nothing promotes it.
        const el = ref.current
        if (el) delete el.dataset.moving
        return
      }
      setPhase('resting')
      settled()
    }
  }

  const ensureSprings = (): { x: SpringAnimation; y: SpringAnimation } => {
    springs.current ??= {
      x: new SpringAnimation(
        SPRING_SNAPPY,
        (x) => {
          pos.current.x = x
          paint()
        },
        () => rested('x')
      ),
      y: new SpringAnimation(
        SPRING_GENTLE,
        (y) => {
          pos.current.y = y
          paint()
        },
        () => rested('y')
      )
    }
    return springs.current
  }

  /**
   * Send the card off along `axis` towards `sign`, from where it is at `velocity` px/s. With
   * motion reduced it does not travel: a `jump` (a release's outcome) is gone at once, anything
   * else fades in place.
   */
  const leave = (axis: Axis, sign: -1 | 1, velocity: number, jump = false): void => {
    const s = ensureSprings()
    exitAxis.current = axis
    setPhase('leaving')
    if (reducedMotion()) {
      s.x.stop()
      s.y.stop()
      if (jump) latest.current.onGone()
      else fade(0, () => latest.current.onGone())
      return
    }
    travelAxis.current = axis
    if (axis === 'x') {
      s.y.stop()
      s.x.start(pos.current.x, velocity, sign * reach('x'), SPRING_SNAPPY)
    } else {
      s.x.stop()
      const slot = latest.current.slot
      s.y.start(pos.current.y, velocity, slot + sign * reach('y'), SPRING_SNAPPY)
    }
  }

  /** Where the card is out of sight by its home edge, for a given slot. */
  const edgeOf = (slot: number): number => slot + latest.current.home * reach('y')

  /**
   * Under the cover: fold away by the home edge and stay there (the way `leave` goes, without
   * going). The travel runs out with it – opacity to nothing, the stack's corners rounded – and
   * holds at the far end. With motion reduced the card fades in place.
   */
  const hide = (): void => {
    const s = ensureSprings()
    cancelFade()
    const el = ref.current
    if (el) el.dataset.covered = ''
    setPhase('hidden')
    if (reducedMotion()) {
      s.x.stop()
      s.y.stop()
      settled()
      fade(0, () => {
        const card = ref.current
        if (card) delete card.dataset.moving
      })
      return
    }
    travelAxis.current = 'y'
    // A card caught sideways (mid spring-back from a swipe) straightens as it folds.
    if (pos.current.x !== 0) s.x.start(pos.current.x, 0, 0, SPRING_SNAPPY)
    else s.x.stop()
    s.y.start(pos.current.y, 0, edgeOf(latest.current.slot), SPRING_SNAPPY)
  }

  /** The cover lifted: back to the slot on the arrival spring, the travel running back with it. */
  const show = (): void => {
    const s = ensureSprings()
    cancelFade()
    const el = ref.current
    if (el) delete el.dataset.covered
    setPhase('entering')
    if (reducedMotion()) {
      s.x.stop()
      s.y.stop()
      pos.current = { x: 0, y: latest.current.slot }
      paint()
      fade(1, () => {
        const card = ref.current
        if (card) card.style.opacity = ''
        if (phase.current === 'entering' && !s.y.running) setPhase('resting')
      })
      return
    }
    travelAxis.current ??= 'y'
    s.y.start(pos.current.y, 0, latest.current.slot, SPRING_GENTLE)
  }

  // Arrival: measured before the first paint, the card starts a card's length off its edge.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    size.current = { width: el.offsetWidth, height: el.offsetHeight }
    const { home, slot, hidden } = latest.current
    const s = ensureSprings()
    if (hidden) {
      // Under the cover from the first frame: parked at its edge (in its slot unseen, with
      // motion reduced), nothing moving until the cover lifts.
      el.dataset.covered = ''
      phase.current = 'hidden'
      if (reducedMotion()) {
        pos.current = { x: 0, y: slot }
        paint()
        el.style.opacity = '0'
      } else {
        travelAxis.current = 'y'
        pos.current = { x: 0, y: slot + home * reach('y') }
        paint()
      }
    } else if (reducedMotion()) {
      setPhase('entering')
      // §11.3: in its slot from the first frame, fading in.
      pos.current = { x: 0, y: slot }
      paint()
      fade(1, () => {
        el.style.opacity = ''
        if (phase.current === 'entering' && !s.y.running) setPhase('resting')
      })
    } else {
      setPhase('entering')
      pos.current = { x: 0, y: slot + home * reach('y') }
      paint()
      s.y.start(pos.current.y, 0, slot, SPRING_GENTLE)
    }
    return () => {
      cancelFade()
      s.x.stop()
      s.y.stop()
      // A card that goes mid-travel (gone, or the layer unmounting) leaves no travel behind.
      const axis = travelAxis.current
      travelAxis.current = null
      if (axis) latest.current.onTravel?.(0, axis)
    }
    // Mount only: everything later is a retarget.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The stack shifted under the card: slide to the new slot (after the drag, if one is on).
  useEffect(() => {
    if (phase.current === 'dragging' || phase.current === 'leaving') return
    const s = ensureSprings()
    if (phase.current === 'hidden') {
      // Folded away (or on its way): the edge it waits at moves with the slot, unseen.
      if (reducedMotion()) {
        pos.current.y = options.slot
        paint()
      } else if (s.y.running) {
        s.y.retarget(edgeOf(options.slot))
      } else {
        pos.current.y = edgeOf(options.slot)
        paint()
      }
      return
    }
    if (pos.current.y === options.slot && !s.y.running) return
    if (phase.current === 'resting') setPhase('entering')
    s.y.retarget(options.slot)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.slot])

  // The cover came over the stack (the open overview on a touch host), or lifted.
  useEffect(() => {
    if (phase.current === 'leaving') return
    if (options.hidden) {
      if (phase.current === 'hidden') return
      if (phase.current === 'dragging') return // the release folds it away
      hide()
    } else if (phase.current === 'hidden') {
      show()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.hidden])

  // Dismissed from outside (timed out, replaced, programmatic): off by the home edge.
  useEffect(() => {
    if (!options.leaving || phase.current === 'leaving') return
    if (phase.current === 'dragging') return // the release decides
    leave('y', options.home, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.leaving])

  const handlers = useSwipeDismiss({
    dirs: options.dirs,
    onHold: (held) => latest.current.onHold(held),
    onDragStart: (axis) => {
      if (phase.current === 'leaving' || phase.current === 'hidden') return
      const s = ensureSprings()
      s.x.stop()
      s.y.stop()
      cancelFade()
      travelAxis.current = axis
      setPhase('dragging')
    },
    onDrag: (axis, delta) => {
      if (phase.current !== 'dragging') return
      const { dirs, slot } = latest.current
      const offset = dragOffset(delta, axis, dirs)
      if (axis === 'x') pos.current.x = offset
      else pos.current.y = slot + offset
      paint()
    },
    onRelease: (axis, _delta, velocity) => {
      if (phase.current !== 'dragging') return
      const { dirs, slot, leaving, home } = latest.current
      const offset = axis === 'x' ? pos.current.x : pos.current.y - slot
      const sign = dismissSign(offset, velocity, reach(axis), axis, dirs)
      if (sign !== 0) {
        latest.current.onSwipe()
        leave(axis, sign, velocity, true)
        return
      }
      if (leaving) {
        // It timed out while held: it goes now, by its own edge.
        leave('y', home, 0)
        return
      }
      if (latest.current.hidden) {
        // The cover came over the stack while the finger had it: it folds away now.
        hide()
        return
      }
      // Back to the slot along the way it came: the travel (opacity, uncovered corners) runs
      // back with it and clears once it rests.
      const s = ensureSprings()
      setPhase('entering')
      s.x.start(pos.current.x, axis === 'x' ? velocity : 0, 0, SPRING_SNAPPY)
      s.y.start(pos.current.y, axis === 'y' ? velocity : 0, slot, SPRING_SNAPPY)
    }
  })

  return { ref, handlers }
}
