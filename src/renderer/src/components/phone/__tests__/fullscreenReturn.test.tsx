// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, useRef, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fadeInChrome, FULLSCREEN_RETURN_MS, useFullscreenReturn } from '../useFullscreenReturn'

/*
 * MED-01: the chrome back from a page's fullscreen fades in over 120 ms, opacity alone (v2
 * §11.3's fade; with nothing to spring, full motion has the same form). Its first showing is
 * not a return and does not fade.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Call = { keyframes: unknown; options: unknown }
const calls: Call[] = []
const cancel = vi.fn()

function Shell({ fullscreen }: { fullscreen: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  useFullscreenReturn(ref, fullscreen)
  if (fullscreen) return <div data-black />
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

function render(fullscreen: boolean): void {
  if (!root) {
    mountPoint = document.createElement('div')
    document.body.appendChild(mountPoint)
    root = createRoot(mountPoint)
  }
  act(() => root!.render(<Shell fullscreen={fullscreen} />))
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  mountPoint?.remove()
  mountPoint = null
  calls.length = 0
  cancel.mockClear()
})

describe('the chrome back from fullscreen', () => {
  it('fades in over 120 ms of opacity once fullscreen ends, and not on its first showing', () => {
    render(false)
    expect(calls).toEqual([])
    render(true)
    expect(document.querySelector('[data-chrome]')).toBeNull()
    render(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }])
    expect(calls[0]?.options).toEqual({ duration: FULLSCREEN_RETURN_MS, easing: 'ease-out' })
    expect(FULLSCREEN_RETURN_MS).toBe(120)
    // Staying out of fullscreen fades nothing more.
    render(false)
    expect(calls).toHaveLength(1)
  })

  it('cancels a fade cut short by fullscreen again', () => {
    render(true)
    render(false)
    expect(calls).toHaveLength(1)
    render(true)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('does without the Web Animations API', () => {
    const el = document.createElement('div')
    Object.defineProperty(el, 'animate', { value: undefined, configurable: true })
    expect(fadeInChrome(el)).toBeNull()
  })
})
