// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIState } from '@shared/types'

/*
 * The gesture hint under a pointer that can hover (§9.36): the phone chrome in a narrow Samsung
 * DeX window is driven by a mouse, and "swipe the address bar" is a finger's sentence. The hook
 * reads the chrome's hover live – the root's `data-hover`, the live pointer's word on a touch
 * screen – so a mouse over the chrome arms nothing, a mouse arriving inside the wait cancels
 * an armed hint, and a finger after the mouse arms it again; the showing is never spent on a
 * mouse.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const invoke = vi.fn(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { run } = await import('@renderer/lib/api')
const { GESTURE_HINT_DELAY_MS, gestureHintText, useGestureHint } = await import('../useGestureHint')
const { claimMessageCards, uiStore } = await import('@renderer/lib/ui')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { notePointer, resetLivePointer } = await import('@renderer/lib/livePointer')

const STATE = {
  settings: { onboardingDone: true, gestureHintDone: false }
} as unknown as UIState

function Hint(): null {
  useGestureHint(STATE, 'bottom', true)
  return null
}

let root: Root | null = null
let host: HTMLDivElement | null = null
let releaseCards: (() => void) | null = null

const mouse = (): void => notePointer({ type: 'pointermove', pointerType: 'mouse' })
const finger = (): void => notePointer({ type: 'pointerdown', pointerType: 'touch' })
const wait = (ms: number): void => {
  act(() => vi.advanceTimersByTime(ms))
}
const toasts = (): number => uiStore.get().toasts.length

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(run).mockClear()
  uiStore.set({ toasts: [], banners: [] })
  // A phone's touch screen: the `(hover: hover)` query says no, the live pointer decides.
  viewportStore.set({ hover: false })
  resetLivePointer()
  releaseCards = claimMessageCards()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  releaseCards?.()
  releaseCards = null
  resetLivePointer()
  vi.useRealTimers()
})

const mount = (): void => {
  act(() => root!.render(createElement(Hint)))
}

describe('the gesture hint and the pointer', () => {
  it('arms nothing while a mouse is over the chrome, and arms for the finger that follows', () => {
    act(mouse)
    mount()
    wait(GESTURE_HINT_DELAY_MS + 100)
    expect(toasts()).toBe(0)
    expect(run).not.toHaveBeenCalledWith('settings.update', { gestureHintDone: true })

    act(finger)
    wait(GESTURE_HINT_DELAY_MS - 1)
    expect(toasts()).toBe(0)
    wait(1)
    expect(toasts()).toBe(1)
    expect(uiStore.get().toasts[0].message).toBe(gestureHintText('bottom'))
    expect(run).toHaveBeenCalledWith('settings.update', { gestureHintDone: true })
  })

  it('a mouse arriving inside the wait cancels the armed hint: nothing shown, the showing not spent', () => {
    mount()
    wait(GESTURE_HINT_DELAY_MS - 100)
    act(mouse)
    wait(10_000)
    expect(toasts()).toBe(0)
    expect(run).not.toHaveBeenCalledWith('settings.update', { gestureHintDone: true })
  })
})
