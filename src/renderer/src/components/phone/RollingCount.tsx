import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'

/** How far (px) a value travels between out of view and in place: the digits' own height. */
const TRAVEL = 14

/**
 * A number that rolls like an odometer when it changes: the new value comes in from below when
 * it went up, from above when it went down, the old one leaving the same way, on the snappy
 * spring. Written to the DOM per frame; a change mid-roll starts the next roll from wherever
 * the digits are. `prefers-reduced-motion` swaps the values in place.
 */
export function RollingCount({ value }: { value: string }): JSX.Element {
  const currentRef = useRef<HTMLSpanElement>(null)
  const previousRef = useRef<HTMLSpanElement>(null)
  const spring = useRef<SpringAnimation | null>(null)
  const shown = useRef(value)
  const dir = useRef<1 | -1>(1)

  useLayoutEffect(() => {
    const before = shown.current
    if (before === value) return
    shown.current = value
    dir.current = direction(before, value)
    const prev = previousRef.current
    if (prev) {
      prev.textContent = before
      prev.style.visibility = ''
    }
    const paint = (p: number): void => {
      const cur = currentRef.current
      if (cur) cur.style.transform = `translateY(${((1 - p) * TRAVEL * dir.current).toFixed(2)}px)`
      if (prev) prev.style.transform = `translateY(${(-p * TRAVEL * dir.current).toFixed(2)}px)`
    }
    const anim = (spring.current ??= new SpringAnimation(
      SPRING_SNAPPY,
      (x) => paint(x / TRAVEL),
      () => {
        paint(1)
        if (prev) prev.style.visibility = 'hidden'
      }
    ))
    // A roll already under way carries on from where its digits are.
    const from = anim.running ? anim.current : { x: 0, v: 0 }
    paint(from.x / TRAVEL)
    anim.start(from.x, from.v, TRAVEL)
  }, [value])

  useEffect(
    () => () => {
      spring.current?.stop()
    },
    []
  )

  return (
    <span className="zen-rolling-count relative inline-flex h-[14px] items-center justify-center overflow-hidden leading-none">
      <span ref={currentRef} className="inline-block">
        {value}
      </span>
      <span
        ref={previousRef}
        className="absolute inset-0 inline-flex items-center justify-center"
        style={{ visibility: 'hidden' }}
        aria-hidden
      />
    </span>
  )
}

/** Up (1) when the value grew, down (-1) when it shrank; non-numbers roll up. */
function direction(from: string, to: string): 1 | -1 {
  const a = Number(from)
  const b = Number(to)
  if (Number.isFinite(a) && Number.isFinite(b)) return b >= a ? 1 : -1
  return 1
}
