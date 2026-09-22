import { useLayoutEffect, useRef, type RefObject } from 'react'
import { REDUCED_FADE_MS } from '@shared/toastCard'
import {
  fullscreenHideStore,
  hideForFullscreen,
  showAfterFullscreen,
  snapFullscreenHide
} from '@renderer/lib/fullscreenHide'
import {
  beginLanding,
  hasLanded,
  LANDING_TIMEOUT_MS,
  landingLost,
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

/** What the return is told about its host and its shell. */
export interface ReturnOptions {
  /** The bar comes back: the shell's `showAfterFullscreen` (the tests their own). */
  onReturn?: () => void
  /**
   * The placement kept from before the fullscreen is where the view goes now: the chrome lay
   * under the page's layer as it was (Android, MOT-32) and the host held its view there, so a
   * layout that did not change reports nothing new and the landing stands on what was kept.
   * Elsewhere the fullscreen laid the view out at the window and the kept placement is stale.
   */
  keepPlacement?: boolean
}

/**
 * The chrome `el` is back from `tabId`'s fullscreen: held at nothing until the page's view has
 * landed (`lib/fullscreenLanding.ts`: the bars at rest, the chrome's placement laid out on them,
 * the host's frame at that size), then the fade. A host without a word on landings (no
 * `settling` on its insets) has the fade at once; so has a tab whose landing is not coming – the
 * chrome's first placements since the exit leave it out, because the page closed itself while
 * fullscreen or was closed at the exit, or another tab has the screen (`landingLost`); a landing
 * that never comes has it at `LANDING_TIMEOUT_MS`. The bar, off its edge since the enter
 * (`lib/fullscreenHide.ts`), springs back the frame the fade begins (`onReturn`): the two run
 * together, so the bar is seen to come back as the chrome does and never slides in at nothing.
 * Returns what ends the return: the hold released, the fade cancelled.
 */
export function returnChrome(
  el: HTMLElement,
  tabId: string,
  options: ReturnOptions = {}
): () => void {
  const onReturn = options.onReturn ?? showAfterFullscreen
  const since = beginLanding(tabId, options.keepPlacement === true)
  let animation: Animation | null = null
  let unsubscribe: (() => void) | null = null
  let deadline: ReturnType<typeof setTimeout> | null = null
  const due = (): boolean => {
    const state = landingStore.get()
    return !landingReported(state) || hasLanded(state, tabId) || landingLost(state, tabId, since)
  }
  const fade = (): void => {
    unsubscribe?.()
    unsubscribe = null
    if (deadline !== null) clearTimeout(deadline)
    deadline = null
    // The fade's first keyframe is the hold's opacity: nothing shows between the two.
    el.style.opacity = ''
    animation = fadeInChrome(el)
    onReturn()
  }
  if (due()) fade()
  else {
    el.style.opacity = '0'
    unsubscribe = landingStore.subscribe(() => {
      if (due()) fade()
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
 * The chrome `el` is going under `tabId`'s fullscreen layer: the bar sets out off its edge
 * (`lib/fullscreenHide.ts`), and once it is off – the layer covers the whole chrome by then –
 * the chrome goes to nothing, so the exit finds it at the hold its return starts from
 * (`returnChrome`) and never shows it whole for a frame. Returns what ends the wait for the bar
 * (the opacity stays: the return takes it from here).
 */
export function coverChrome(el: HTMLElement): () => void {
  hideForFullscreen()
  const hold = (): boolean => {
    if (fullscreenHideStore.get().phase !== 'hidden') return false
    el.style.opacity = '0'
    return true
  }
  if (hold()) return () => {}
  const unsubscribe = fullscreenHideStore.subscribe(() => {
    if (hold()) unsubscribe()
  })
  return unsubscribe
}

/**
 * The chrome around a page's fullscreen (MED-01, MOT-32). It stays mounted, its state kept: at
 * the enter the bar translates off its edge on one spring (`lib/fullscreenHide.ts`) as the
 * system bars slide away, seen through the host's reveal of the page's layer from the page's
 * card outward; the chrome's layout is not touched (the host holds its insets meanwhile,
 * `lib/insets.ts`). Once the bar is off – the layer covers the whole chrome by then – the
 * chrome goes to nothing under it, so the exit, which takes the layer down at once, finds the
 * chrome already at the hold its return starts from and never shows it whole for a frame. The
 * return is a 120 ms opacity fade in place – §11.3's fade is the reduced-motion form of every
 * appearance – with the bar springing back through it, so the page is laid out once, as the
 * chrome's frames are placed, and nothing but transform and opacity moves. The fade runs once
 * the page's view has landed (§11.5: on the landing, not over the platform's shrink), the
 * chrome held at nothing until then – or at once when the page is gone at the exit and no
 * landing is coming (`returnChrome`). A layout effect: the hold is on before the returned
 * chrome's first paint, so it is never seen at full strength first. The first showing of the
 * chrome (no fullscreen before it) is not a return and does not fade; a shell mounting after a
 * fullscreen another shell saw out (the layout changed under it) finds the bar off and puts it
 * back at once.
 */
export function useFullscreenReturn(
  root: RefObject<HTMLElement | null>,
  fullscreenTabId: string | null,
  keepPlacement = false
): void {
  const wasFullscreen = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (fullscreenTabId !== null) {
      wasFullscreen.current = fullscreenTabId
      const el = root.current
      if (!el) {
        hideForFullscreen()
        return
      }
      return coverChrome(el)
    }
    const tabId = wasFullscreen.current
    if (tabId === null) {
      if (fullscreenHideStore.get().phase !== 'shown') snapFullscreenHide(false)
      return
    }
    wasFullscreen.current = null
    const el = root.current
    if (!el) {
      snapFullscreenHide(false)
      return
    }
    return returnChrome(el, tabId, { keepPlacement })
  }, [fullscreenTabId, root, keepPlacement])
}
