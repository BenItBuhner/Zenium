// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useRef, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fadeInChrome, FULLSCREEN_RETURN_MS, useFullscreenReturn } from '../useFullscreenReturn'
import {
  LANDING_TIMEOUT_MS,
  landingStore,
  noteInsetsSettling,
  notePlacements,
  noteViewSized
} from '@renderer/lib/fullscreenLanding'

/*
 * MED-01: the chrome back from a page's fullscreen fades in over 120 ms, opacity alone (v2
 * §11.3's fade; with nothing to spring, full motion has the same form), once the page's view
 * has landed (§11.5): held at nothing while the host's bars settle and the page is laid out,
 * the fade from the landing. Its first showing is not a return and does not fade.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Call = { keyframes: unknown; options: unknown }
const calls: Call[] = []
const cancel = vi.fn()

function Shell({ fullscreenTabId }: { fullscreenTabId: string | null }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  useFullscreenReturn(ref, fullscreenTabId)
  if (fullscreenTabId) return <div data-black />
  return (
    <div
      ref={(el) => {
        ref.current = el
        if (el)
          Object.assign(el, {
            animate: (keyframes: unknown, options: unknown) => {
              calls.push({ keyframes, options })
              return { cancel }
            }
          })
      }}
      data-chrome
    />
  )
}

let root: Root | null = null
let mountPoint: HTMLElement | null = null

function render(fullscreenTabId: string | null): void {
  if (!root) {
    mountPoint = document.createElement('div')
    document.body.appendChild(mountPoint)
    root = createRoot(mountPoint)
  }
  act(() => root!.render(<Shell fullscreenTabId={fullscreenTabId} />))
}

const chrome = (): HTMLElement | null => document.querySelector('[data-chrome]')
const inline = { x: 6, y: 48, width: 399, height: 756 }

beforeEach(() => {
  landingStore.set({ settling: undefined, placed: new Map(), sized: new Map() })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  mountPoint?.remove()
  mountPoint = null
  calls.length = 0
  cancel.mockClear()
  vi.useRealTimers()
})

describe('the chrome back from fullscreen', () => {
  it('fades in over 120 ms of opacity once fullscreen ends, and not on its first showing', () => {
    render(null)
    expect(calls).toEqual([])
    render('t1')
    expect(chrome()).toBeNull()
    render(null)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }])
    expect(calls[0]?.options).toEqual({ duration: FULLSCREEN_RETURN_MS, easing: 'ease-out' })
    expect(FULLSCREEN_RETURN_MS).toBe(120)
    // Staying out of fullscreen fades nothing more.
    render(null)
    expect(calls).toHaveLength(1)
  })

  it('cancels a fade cut short by fullscreen again', () => {
    render('t1')
    render(null)
    expect(calls).toHaveLength(1)
    render('t1')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('does without the Web Animations API', () => {
    const el = document.createElement('div')
    Object.defineProperty(el, 'animate', { value: undefined, configurable: true })
    expect(fadeInChrome(el)).toBeNull()
  })
})

describe('the chrome back from fullscreen on a host that reports landings', () => {
  it('holds at nothing until the page has landed, then fades', () => {
    // Before the fullscreen: the view inline, landed.
    noteInsetsSettling(false)
    notePlacements([{ tabId: 't1', rect: inline }], false)
    noteViewSized('t1', 399, 756)
    render('t1')
    // The exit: the bars on their way back, said before the chrome hears of the exit.
    act(() => noteInsetsSettling(true))
    render(null)
    expect(calls).toEqual([])
    expect(chrome()?.style.opacity).toBe('0')
    // The chrome's first inline layout, on the bars' way: no landing.
    act(() => notePlacements([{ tabId: 't1', rect: { ...inline, height: 804 } }], true))
    act(() => noteViewSized('t1', 399, 804))
    expect(calls).toEqual([])
    // The bars at rest, the layout following them, the host's frame at the size: the landing.
    act(() => noteInsetsSettling(false))
    act(() => notePlacements([{ tabId: 't1', rect: inline }], false))
    expect(calls).toEqual([])
    act(() => noteViewSized('t1', 399, 756))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }])
    // The hold is released with the fade, whose first keyframe is the same nothing.
    expect(chrome()?.style.opacity).toBe('')
    // Nothing more moves it.
    act(() => noteViewSized('t1', 399, 756))
    expect(calls).toHaveLength(1)
  })

  it('does not take the placement from before the fullscreen for the landing', () => {
    noteInsetsSettling(false)
    notePlacements([{ tabId: 't1', rect: inline }], false)
    noteViewSized('t1', 399, 756)
    render('t1')
    // A host whose exit finds the bars where they were (Zen's own fullscreen kept them hidden):
    // nothing settles, yet the chrome has not laid the page out inline yet.
    render(null)
    expect(calls).toEqual([])
    expect(chrome()?.style.opacity).toBe('0')
    act(() => notePlacements([{ tabId: 't1', rect: inline }], false))
    // The host's view stands at that size already: the report itself is the landing.
    expect(calls).toHaveLength(1)
  })

  it('fades at the timeout when the landing never comes', () => {
    vi.useFakeTimers()
    noteInsetsSettling(true)
    render('t1')
    render(null)
    expect(calls).toEqual([])
    act(() => void vi.advanceTimersByTime(LANDING_TIMEOUT_MS - 1))
    expect(calls).toEqual([])
    act(() => void vi.advanceTimersByTime(1))
    expect(calls).toHaveLength(1)
    expect(chrome()?.style.opacity).toBe('')
  })

  it('releases the hold, fading nothing, when fullscreen comes again meanwhile', () => {
    vi.useFakeTimers()
    noteInsetsSettling(true)
    render('t1')
    render(null)
    const held = chrome()
    expect(held?.style.opacity).toBe('0')
    render('t1')
    expect(held?.style.opacity).toBe('')
    act(() => void vi.advanceTimersByTime(LANDING_TIMEOUT_MS))
    expect(calls).toEqual([])
    expect(cancel).not.toHaveBeenCalled()
    // The landing arriving late is no one's.
    act(() => noteInsetsSettling(false))
    act(() => notePlacements([{ tabId: 't1', rect: inline }], false))
    act(() => noteViewSized('t1', 399, 756))
    expect(calls).toEqual([])
  })
})
