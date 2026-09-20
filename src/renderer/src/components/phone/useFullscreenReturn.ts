import { useLayoutEffect, useRef, type RefObject } from 'react'

/** The chrome's return from a page's fullscreen: an opacity fade over this long (v2 §11.3). */
export const FULLSCREEN_RETURN_MS = 120

/** Fade `el` in over the return's time; null where the Web Animations API is missing (tests). */
export function fadeInChrome(el: HTMLElement): Animation | null {
  if (typeof el.animate !== 'function') return null
  return el.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: FULLSCREEN_RETURN_MS,
    easing: 'ease-out'
  })
}

/**
 * The chrome comes back from a page's fullscreen (MED-01) on a 120 ms opacity fade in place –
 * §11.3's fade is the reduced-motion form of every appearance, and with nothing to spring (the
 * bar and the pill return to where they were) full motion has no other form – so the page is
 * laid out once, as the chrome's frames are placed, and nothing but opacity moves. A layout
 * effect: the fade is started before the returned chrome's first paint, so it is never seen at
 * full strength first. The first showing of the chrome (no fullscreen before it) is not a
 * return and does not fade.
 */
export function useFullscreenReturn(
  root: RefObject<HTMLElement | null>,
  htmlFullscreen: boolean
): void {
  const wasFullscreen = useRef(false)
  useLayoutEffect(() => {
    if (htmlFullscreen) {
      wasFullscreen.current = true
      return
    }
    if (!wasFullscreen.current) return
    wasFullscreen.current = false
    const el = root.current
    if (!el) return
    const animation = fadeInChrome(el)
    return () => animation?.cancel()
  }, [htmlFullscreen, root])
}
