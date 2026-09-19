import { useEffect, useRef } from 'react'
import type { PhoneBarPosition, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { pushToast } from '@renderer/lib/ui'

/** The hint waits this long after the chrome settles on a page, and stays this long untouched. */
export const GESTURE_HINT_DELAY_MS = 1200
export const GESTURE_HINT_DURATION_MS = 6000

/** The one sentence, naming the pull's direction from the bar's edge. */
export function gestureHintText(edge: PhoneBarPosition): string {
  const pull = edge === 'bottom' ? 'up' : 'down'
  return `Swipe the address bar to switch tabs, pull it ${pull} to see them all.`
}

/** Whether the hint is still owed: the first run is over and the hint has not had its showing. */
export function gestureHintDue(
  settings: Pick<UIState['settings'], 'onboardingDone' | 'gestureHintDone'>
): boolean {
  return settings.onboardingDone && !settings.gestureHintDone
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
 * whenever the chrome gets busy before the hint is up.
 */
export function useGestureHint(state: UIState, edge: PhoneBarPosition, calm: boolean): void {
  const due = gestureHintDue(state.settings) && calm
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
