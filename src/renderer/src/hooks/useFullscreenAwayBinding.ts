import { useCallback, useEffect, useRef } from 'react'
import { bindFullscreenAway } from '@renderer/lib/fullscreenMotion'

/**
 * A ref for an element that leaves with the bar around a page's fullscreen
 * (`bindFullscreenAway`, lib/fullscreenMotion.ts): the element carries `--zen-fullscreen-away`
 * – 0 in place … 1 off its edge, written on it per frame – from its mount to its unmount, for
 * its own rule in main.css to compose into its transform. With `active` false nothing is bound
 * (the preview of the bar at the other edge during a carry).
 */
export function useFullscreenAwayBinding(active = true): (el: HTMLElement | null) => void {
  const unbind = useRef<(() => void) | null>(null)
  const ref = useCallback(
    (el: HTMLElement | null) => {
      unbind.current?.()
      unbind.current = el && active ? bindFullscreenAway(el) : null
    },
    [active]
  )
  useEffect(
    () => () => {
      unbind.current?.()
      unbind.current = null
    },
    []
  )
  return ref
}
