// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  useMessageMotion,
  type MessageMotionOptions
} from '@renderer/components/messages/useMessageMotion'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * A message card under `prefers-reduced-motion: reduce` (v2 §11.3): it appears in its slot and
 * leaves from it on a 120 ms opacity fade, never travelling; a finger still moves it and a
 * release jumps to its outcome. The frame clock is driven by hand.
 */

let root: Root | null = null
let mount: HTMLElement | null = null
let now = 0
let frames: Array<(t: number) => void> = []

/** Run the pending animation frames once, `ms` later. */
function frame(ms: number): void {
  now += ms
  const due = frames
  frames = []
  act(() => {
    for (const cb of due) cb(now)
  })
}

beforeEach(() => {
  now = 1000
  frames = []
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    frames.push(cb)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduce'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  })) as unknown as typeof window.matchMedia
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  mount?.remove()
  root = null
  mount = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function Card({ options }: { options: MessageMotionOptions }): JSX.Element {
  const { ref, handlers } = useMessageMotion(options)
  return (
    <div data-card ref={ref} {...handlers}>
      <span data-text>Tab closed</span>
    </div>
  )
}

function render(options: MessageMotionOptions): {
  card: HTMLElement
  rerender: (next: MessageMotionOptions) => void
} {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(<Card options={options} />))
  const card = mount.querySelector('[data-card]') as HTMLElement
  const captured = new Set<number>()
  card.setPointerCapture = (id: number) => {
    captured.add(id)
  }
  card.releasePointerCapture = (id: number) => {
    captured.delete(id)
  }
  card.hasPointerCapture = (id: number) => captured.has(id)
  return { card, rerender: (next) => act(() => root!.render(<Card options={next} />)) }
}

function options(over: Partial<MessageMotionOptions> = {}): MessageMotionOptions & {
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    home: 1,
    slot: 0,
    dirs: { x: [-1, 1], y: [1] },
    leaving: false,
    onHold: (held) => calls.push(`hold:${held}`),
    onSwipe: () => calls.push('swipe'),
    onGone: () => calls.push('gone'),
    ...over
  }
}

function pointer(target: HTMLElement, type: string, x: number, y: number): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 7,
        pointerType: 'touch',
        clientX: x,
        clientY: y,
        button: 0
      })
    )
  })
}

describe('a message card with motion reduced', () => {
  it('appears in its slot on a 120 ms fade instead of sliding in', () => {
    const opts = options({ slot: 56 })
    const { card } = render(opts)
    // In place from the first paint, at nothing.
    expect(card.style.transform).toBe('translate3d(0.00px, 56.00px, 0)')
    expect(card.style.opacity).toBe('0.000')
    expect(card.dataset.moving).toBe('')
    frame(60)
    expect(Number(card.style.opacity)).toBeCloseTo(0.5, 1)
    expect(card.style.transform).toBe('translate3d(0.00px, 56.00px, 0)')
    frame(60)
    // Settled: the inline opacity is cleared and the card is at rest.
    expect(card.style.opacity).toBe('')
    expect(card.dataset.moving).toBeUndefined()
    expect(opts.calls).toEqual([])
  })

  it('fades out where it stands when dismissed, then reports itself gone', () => {
    const opts = options({ slot: 20 })
    const { card, rerender } = render(opts)
    frame(120)
    expect(card.style.opacity).toBe('')
    rerender({ ...opts, leaving: true })
    expect(card.style.transform).toBe('translate3d(0.00px, 20.00px, 0)')
    expect(card.style.opacity).toBe('1.000')
    frame(60)
    expect(Number(card.style.opacity)).toBeCloseTo(0.5, 1)
    expect(opts.calls).toEqual([])
    frame(60)
    expect(card.style.opacity).toBe('0.000')
    expect(card.style.transform).toBe('translate3d(0.00px, 20.00px, 0)')
    expect(opts.calls).toEqual(['gone'])
  })

  it('still follows a finger 1:1, and a committed release is gone at once', () => {
    const opts = options()
    const { card } = render(opts)
    frame(120)
    pointer(card, 'pointerdown', 100, 20)
    pointer(card, 'pointermove', 112, 20)
    pointer(card, 'pointermove', 200, 20)
    // The drag is input, not animation: the card is where the finger put it.
    expect(card.style.transform).toBe('translate3d(100.00px, 0.00px, 0)')
    pointer(card, 'pointerup', 260, 20)
    // No exit spring and no fade: swiped, then gone in the same release.
    expect(opts.calls).toEqual(['hold:true', 'swipe', 'gone', 'hold:false'])
    expect(frames).toHaveLength(0)
  })
})
