import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { SPRING_GENTLE, SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'

/** The spring runs in percent so the motion constants tuned for pixels keep their feel. */
const SHOWN = 100

/**
 * Enter and exit motion for a panel on a damped spring: progress runs to 100 on mount and back to
 * 0 when `close()` is called, after which `onClosed` fires (unmount it then). Closing mid-flight
 * turns the motion around from where it is instead of restarting it, and a second `close()` is a
 * no-op. Reduced-motion users get the end states at once (the spring does that itself).
 */
export function useSpringPresence(
  onClosed: () => void,
  transformOrigin = '50% 0%'
): { style: CSSProperties; close: () => void; closing: boolean } {
  const [progress, setProgress] = useState(0)
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const closedRef = useRef(onClosed)
  const animation = useRef<SpringAnimation | null>(null)

  useEffect(() => {
    closedRef.current = onClosed
  }, [onClosed])

  useEffect(() => {
    const spring = new SpringAnimation(
      SPRING_GENTLE,
      (x) => setProgress(Math.max(0, x)),
      (x) => {
        if (closingRef.current && x === 0) closedRef.current()
      }
    )
    animation.current = spring
    spring.start(0, 0, SHOWN)
    return () => {
      spring.stop()
      animation.current = null
    }
  }, [])

  const close = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    const spring = animation.current
    if (!spring) {
      closedRef.current()
      return
    }
    // Leave faster than we came, carrying whatever velocity the entrance still has.
    const { x, v } = spring.stop()
    spring.start(x, v, 0, SPRING_SNAPPY)
  }, [])

  const t = progress / SHOWN
  return {
    style: {
      opacity: t,
      transform: `scale(${0.94 + 0.06 * t}) translateY(${(1 - t) * -6}px)`,
      transformOrigin,
      pointerEvents: closing ? 'none' : undefined
    },
    close,
    closing
  }
}
