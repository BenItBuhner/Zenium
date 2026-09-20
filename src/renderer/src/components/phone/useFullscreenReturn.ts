import { useLayoutEffect, useRef, type RefObject } from 'react'
import { REDUCED_FADE_MS } from '@shared/toastCard'
import {
  beginLanding,
  hasLanded,
  LANDING_TIMEOUT_MS,
  landingReported,
  landingStore
} from '@renderer/lib/fullscreenLanding'

/** The chrome's return from a page's fullscreen (v2 §11.5): an opacity fade as long as §11.3's, one number with it. */
export const FULLSCREEN_RETURN_MS: number = REDUCED_FADE_MS

/** Fade `el` in over the return's time; null where the Web Animations API is missing (tests). */
export function fadeInChrome(el: HTMLElement): Animation | null {
  if (typeof el.animate !== 'function') return null
  return el.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: FULLSCREEN_RETURN_MS,
    easing: 'ease-out'
  })
}

/**
 * The chrome `el` is back from `tabId`'s fullscreen: held at nothing until the page's view has
 * landed (`lib/fullscreenLanding.ts`: the bars at rest, the chrome's placement laid out on them,
 * the host's frame at that size), then the fade. A host without a word on landings (no
 * `settling` on its insets) has the fade at once; a landing that never comes has it at
 * `LANDING_TIMEOUT_MS`. Returns what ends the return: the hold released, the fade cancelled.
 */
export function returnChrome(el: HTMLElement, tabId: string): () => void {
  beginLanding(tabId)
  let animation: Animation | null = null
  let unsubscribe: (() => void) | null = null
  let deadline: ReturnType<typeof setTimeout> | null = null
  const landed = (): boolean => {
    const state = landingStore.get()
    return !landingReported(state) || hasLanded(state, tabId)
  }
  const fade = (): void => {
    unsubscribe?.()
    unsubscribe = null
    if (deadline !== null) clearTimeout(deadline)
    deadline = null
    // The fade's first keyframe is the hold's opacity: nothing shows between the two.
    el.style.opacity = ''
    animation = fadeInChrome(el)
  }
  if (landed()) fade()
  else {
    el.style.opacity = '0'
    unsubscribe = landingStore.subscribe(() => {
      if (landed()) fade()
    })
    deadline = setTimeout(fade, LANDING_TIMEOUT_MS)
  }
  return () => {
    unsubscribe?.()
    if (deadline !== null) clearTimeout(deadline)
    el.style.opacity = ''
    animation?.cancel()
  }
}

/**
 * The chrome comes back from a page's fullscreen (MED-01) on a 120 ms opacity fade in place –
 * §11.3's fade is the reduced-motion form of every appearance, and with nothing to spring (the
 * bar and the pill return to where they were) full motion has no other form – so the page is
 * laid out once, as the chrome's frames are placed, and nothing but opacity moves. The fade runs
 * once the page's view has landed (§11.5: on the landing, not over the platform's shrink), the
 * chrome held at nothing until then. A layout effect: the hold is on before the returned
 * chrome's first paint, so it is never seen at full strength first. The first showing of the
 * chrome (no fullscreen before it) is not a return and does not fade.
 */
export function useFullscreenReturn(
  root: RefObject<HTMLElement | null>,
  fullscreenTabId: string | null
): void {
  const wasFullscreen = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (fullscreenTabId !== null) {
      wasFullscreen.current = fullscreenTabId
      return
    }
    const tabId = wasFullscreen.current
    if (tabId === null) return
    wasFullscreen.current = null
    const el = root.current
    if (!el) return
    return returnChrome(el, tabId)
  }, [fullscreenTabId, root])
}
