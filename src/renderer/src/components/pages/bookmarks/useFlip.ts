import { useLayoutEffect, useRef } from 'react'
import { SPRING_SNAPPY, SpringAnimation, reducedMotion } from '@renderer/lib/motion/spring'

/**
 * Rows that changed place between two renders (a drop, a sort, a paste) slide from where they
 * were to where they are on a spring instead of jumping – the FLIP technique with physics. Rows
 * are identified by `data-bm-id`; a row mid-slide that moves again is retargeted, not restarted.
 */
export function useFlip(container: React.RefObject<HTMLElement | null>, orderKey: string): void {
  const previous = useRef(new Map<string, number>())
  const animations = useRef(new Map<string, SpringAnimation>())

  useLayoutEffect(() => {
    const root = container.current
    if (!root) return
    const rows = [...root.querySelectorAll<HTMLElement>('[data-bm-id]')]
    const next = new Map<string, number>()
    for (const row of rows) {
      const id = row.dataset.bmId ?? ''
      // Measure the resting position: strip any in-flight offset first.
      const running = animations.current.get(id)
      const offset = running?.running ? running.current.x : 0
      const top = row.getBoundingClientRect().top - offset
      next.set(id, top)
      const was = previous.current.get(id)
      if (was === undefined || reducedMotion()) continue
      const delta = was - top + offset
      if (Math.abs(delta) < 0.5) continue
      let spring = running
      if (!spring) {
        spring = new SpringAnimation(
          SPRING_SNAPPY,
          (x) => {
            row.style.transform = x === 0 ? '' : `translateY(${x}px)`
          },
          () => {
            row.style.transform = ''
            animations.current.delete(id)
          }
        )
        animations.current.set(id, spring)
      }
      const wasRunning = spring.running
      const state = spring.stop()
      spring.start(delta, wasRunning ? state.v : 0, 0)
    }
    previous.current = next
  }, [container, orderKey])

  useLayoutEffect(
    () => () => {
      for (const a of animations.current.values()) a.stop()
      animations.current.clear()
    },
    []
  )
}
