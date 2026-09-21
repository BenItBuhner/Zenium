import { useCallback, useEffect, useRef } from 'react'
import { bindBarHide } from '@renderer/lib/barHide'

/**
 * A ref for an element that moves with the bar that hides on scroll (`bindBarHide`,
 * lib/barHide.ts): the element carries `--zen-bar-hide` – 0 shown … 1 hidden, written on it per
 * frame – from its mount to its unmount, for its own rule in main.css to turn into a transform.
 * With `active` false nothing is bound (the preview of the bar at the other edge during a carry).
 */
export function useBarHideBinding(active = true): (el: HTMLElement | null) => void {
  const unbind = useRef<(() => void) | null>(null)
  const ref = useCallback(
    (el: HTMLElement | null) => {
      unbind.current?.()
      unbind.current = el && active ? bindBarHide(el) : null
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
