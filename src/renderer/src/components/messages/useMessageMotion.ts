import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import {
  allowedAlong,
  dismissPresence,
  dismissSign,
  dragOffset,
  type Axis,
  type DismissDirections
} from '@renderer/lib/gestures/dismiss'
import { SPRING_GENTLE, SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'
import { MESSAGE_GAP } from './stack'
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
  /** A finger is on the card (its clock pauses) or has left it. */
  onHold(held: boolean): void
  /** A swipe committed: the card is on its way off; the message should be marked leaving. */
  onSwipe(): void
  /** The card is out of sight and can go. */
  onGone(): void
}

type Phase = 'entering' | 'resting' | 'dragging' | 'leaving'

/**
 * Motion of one message card: it springs in from its home edge (`SPRING_GENTLE`, a hair of
 * overshoot), slides to a new slot when the stack shifts, follows a finger along the axis the
 * swipe settles on – rubber-banding where it may not leave – and springs off (`SPRING_SNAPPY`)
 * when let go past the threshold, flung, timed out or dismissed. Two springs, one per axis, own
 * the transform, and a finger can catch either. The layer clips the cards to the content frame,
 * so arriving and leaving cards emerge from and vanish at its edge; opacity only follows a
 * finger, thinning the card as it is pulled towards the way out.
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
  const dragAxis = useRef<Axis | null>(null)
  const springs = useRef<{ x: SpringAnimation; y: SpringAnimation } | null>(null)

  /** Distance along `axis` at which the card is out of sight: its own extent (plus the gap). */
  const reach = (axis: Axis): number =>
    axis === 'x' ? Math.max(1, size.current.width) : Math.max(1, size.current.height + MESSAGE_GAP)

  const paint = (): void => {
    const el = ref.current
    if (!el) return
    const { x, y } = pos.current
    el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`
    const axis = phase.current === 'dragging' ? dragAxis.current : exitAxis.current
    if (axis && (phase.current === 'dragging' || phase.current === 'leaving')) {
      const d = axis === 'x' ? x : y - latest.current.slot
      // Only travel that could take the card off thins it; a rubber-banded pull does not.
      const outward = allowedAlong(d, axis, latest.current.dirs)
      el.style.opacity = outward ? dismissPresence(d, reach(axis)).toFixed(3) : ''
    }
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
      setPhase('resting')
      const el = ref.current
      if (el) el.style.opacity = ''
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

  /** Send the card off along `axis` towards `sign`, from where it is at `velocity` px/s. */
  const leave = (axis: Axis, sign: -1 | 1, velocity: number): void => {
    const s = ensureSprings()
    exitAxis.current = axis
    setPhase('leaving')
    if (axis === 'x') {
      s.y.stop()
      s.x.start(pos.current.x, velocity, sign * reach('x'), SPRING_SNAPPY)
    } else {
      s.x.stop()
      const slot = latest.current.slot
      s.y.start(pos.current.y, velocity, slot + sign * reach('y'), SPRING_SNAPPY)
    }
  }

  // Arrival: measured before the first paint, the card starts a card's length off its edge.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    size.current = { width: el.offsetWidth, height: el.offsetHeight }
    const { home, slot } = latest.current
    const s = ensureSprings()
    pos.current = { x: 0, y: slot + home * reach('y') }
    paint()
    setPhase('entering')
    s.y.start(pos.current.y, 0, slot, SPRING_GENTLE)
    return () => {
      s.x.stop()
      s.y.stop()
    }
    // Mount only: everything later is a retarget.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The stack shifted under the card: slide to the new slot (after the drag, if one is on).
  useEffect(() => {
    if (phase.current === 'dragging' || phase.current === 'leaving') return
    const s = ensureSprings()
    if (pos.current.y === options.slot && !s.y.running) return
    if (phase.current === 'resting') setPhase('entering')
    s.y.retarget(options.slot)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.slot])

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
      if (phase.current === 'leaving') return
      const s = ensureSprings()
      s.x.stop()
      s.y.stop()
      dragAxis.current = axis
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
        leave(axis, sign, velocity)
        latest.current.onSwipe()
        return
      }
      if (leaving) {
        // It timed out while held: it goes now, by its own edge.
        leave('y', home, 0)
        return
      }
      const s = ensureSprings()
      setPhase('entering')
      const el = ref.current
      if (el) el.style.opacity = ''
      s.x.start(pos.current.x, axis === 'x' ? velocity : 0, 0, SPRING_SNAPPY)
      s.y.start(pos.current.y, axis === 'y' ? velocity : 0, slot, SPRING_SNAPPY)
    }
  })

  return { ref, handlers }
}
