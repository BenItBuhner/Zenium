import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(async () => null)
vi.stubGlobal('window', { zen: { invoke, on: () => () => undefined } })

const {
  GESTURE_HINT_DELAY_MS,
  GESTURE_HINT_DURATION_MS,
  armGestureHint,
  gestureHintDue,
  gestureHintText
} = await import('../useGestureHint')
const { TOAST_DURATION, claimMessageCards, uiStore } = await import('@renderer/lib/ui')

/** The phone shell is up: messages are on the cards (the hint is only ever shown there). */
let releaseCards: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers()
  invoke.mockClear()
  uiStore.set({ toasts: [], banners: [] })
  releaseCards = claimMessageCards()
})
afterEach(() => {
  releaseCards?.()
  releaseCards = null
  vi.useRealTimers()
})

describe('the one-time gesture hint (FRE-07) as a toast on the shared card', () => {
  it('is owed once the first run is over, until it has had its showing', () => {
    expect(gestureHintDue({ onboardingDone: false, gestureHintDone: false })).toBe(false)
    expect(gestureHintDue({ onboardingDone: true, gestureHintDone: false })).toBe(true)
    expect(gestureHintDue({ onboardingDone: true, gestureHintDone: true })).toBe(false)
  })

  it('names the pull from the bar it is on', () => {
    expect(gestureHintText('bottom')).toBe(
      'Swipe the address bar to switch tabs, pull it up to see them all.'
    )
    expect(gestureHintText('top')).toBe(
      'Swipe the address bar to switch tabs, pull it down to see them all.'
    )
  })

  it('goes up after its wait as a plain toast on the six-second clock, and records the showing', () => {
    const shown = vi.fn()
    armGestureHint('bottom', shown)
    vi.advanceTimersByTime(GESTURE_HINT_DELAY_MS - 1)
    expect(uiStore.get().toasts).toHaveLength(0)
    expect(shown).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    const toasts = uiStore.get().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({
      message: gestureHintText('bottom'),
      kind: 'info',
      duration: GESTURE_HINT_DURATION_MS
    })
    expect(toasts[0].action).toBeUndefined()
    expect(toasts[0].icon).toBeUndefined()
    expect(GESTURE_HINT_DURATION_MS).toBeGreaterThan(TOAST_DURATION)
    expect(invoke).toHaveBeenCalledWith('settings.update', { gestureHintDone: true })
    expect(shown).toHaveBeenCalledTimes(1)

    // The card's clock, not one of the hint's own: it leaves when the six seconds are up.
    vi.advanceTimersByTime(GESTURE_HINT_DURATION_MS - 1)
    expect(uiStore.get().toasts[0].leaving).toBeFalsy()
    vi.advanceTimersByTime(1)
    expect(uiStore.get().toasts[0].leaving).toBe(true)
  })

  it('a chrome that gets busy before the wait is up cancels it: nothing shown, nothing recorded', () => {
    const cancel = armGestureHint('top')
    vi.advanceTimersByTime(GESTURE_HINT_DELAY_MS - 100)
    cancel()
    vi.advanceTimersByTime(10_000)
    expect(uiStore.get().toasts).toHaveLength(0)
    expect(invoke).not.toHaveBeenCalled()
  })
})
