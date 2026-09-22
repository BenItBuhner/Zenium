import { useCallback, useEffect, useRef } from 'react'
import { bindFullscreenHide } from '@renderer/lib/fullscreenHide'

/**
 * A ref for an element that translates off around a page's fullscreen (`bindFullscreenHide`,
 * lib/fullscreenHide.ts, MOT-32): the element carries `--zen-fullscreen-hide` – 0 in place …
 * 1 off, written on it per frame – from its mount to its unmount, for its rule in main.css to
 * add to its transform. With `active` false nothing is bound (the preview of the bar at the
 * other edge during a carry).
 */
export function useFullscreenHideBinding(active = true): (el: HTMLElement | null) => void {
  const unbind = useRef<(() => void) | null>(null)
  const ref = useCallback(
    (el: HTMLElement | null) => {
      unbind.current?.()
      unbind.current = el && active ? bindFullscreenHide(el) : null
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
