import { useEffect, useRef } from 'react'
import type { PhoneBarPosition, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { chromeHover, useChromeHover } from '@renderer/lib/formFactor'
import { pushToast } from '@renderer/lib/ui'

/** The hint waits this long after the chrome settles on a page, and stays this long untouched. */
export const GESTURE_HINT_DELAY_MS = 1200
export const GESTURE_HINT_DURATION_MS = 6000

/** The one sentence, naming the pull's direction from the bar's edge. */
export function gestureHintText(edge: PhoneBarPosition): string {
  const pull = edge === 'bottom' ? 'up' : 'down'
  return `Swipe the address bar to switch tabs, pull it ${pull} to see them all.`
}

/**
 * Whether the hint is still owed: the first run is over, the hint has not had its showing, and
 * the pointer over the chrome is a finger's – a gesture hint is a touch pointer's and does not
 * show under a mouse (§9.36: the phone chrome in a narrow Samsung DeX window; the root's
 * `data-hover`, `chromeHover()`). The showing waits for a finger; it is not spent on a mouse.
 */
export function gestureHintDue(
  settings: Pick<UIState['settings'], 'onboardingDone' | 'gestureHintDone'>,
  hover: 'hover' | 'none' = chromeHover()
): boolean {
  return settings.onboardingDone && !settings.gestureHintDone && hover !== 'hover'
}

/**
 * Arm the hint: after the delay its toast goes up on the shared card and the showing is
 * recorded, once and for all. The returned function cancels a hint that has not gone up yet.
 */
export function armGestureHint(edge: PhoneBarPosition, onShown?: () => void): () => void {
  const timer = setTimeout(() => {
    pushToast(gestureHintText(edge), 'info', { duration: GESTURE_HINT_DURATION_MS })
    run('settings.update', { gestureHintDone: true })
    onShown?.()
  }, GESTURE_HINT_DELAY_MS)
  return () => clearTimeout(timer)
}

/**
 * One-time gesture education (FRE-07): the first time the phone chrome shows a page after the
 * first run, a message (v2 §9.33) – "swipe to switch tabs, pull for all of them" – as a toast
 * without an action on the shared card (components/messages, #72's `MessageLayer`) with a
 * six-second clock. The card does the rest: up from the content frame's bottom edge, a finger on
 * it holds the clock, a swipe on the shared thresholds or the clock sends it off, a 120 ms fade
 * under reduced motion; and the host clips the page out from under it, so it is seen over
 * Android's page view. Shown once: `gestureHintDone` is set as the toast goes up. The wait for a
 * calm chrome (a page in view under nothing, the bar in place, no drag or prompt) starts over
 * whenever the chrome gets busy before the hint is up – and a mouse arriving over the chrome
 * cancels it the same way, a finger after the mouse arming it again.
 */
export function useGestureHint(state: UIState, edge: PhoneBarPosition, calm: boolean): void {
  const hover = useChromeHover()
  const due = gestureHintDue(state.settings, hover) && calm
  // The core echoes `gestureHintDone` back a moment after the toast goes up; a chrome that gets
  // busy and calm again inside that moment must not arm a second showing.
  const shown = useRef(false)
  useEffect(() => {
    if (!due || shown.current) return
    return armGestureHint(edge, () => {
      shown.current = true
    })
  }, [due, edge])
}
