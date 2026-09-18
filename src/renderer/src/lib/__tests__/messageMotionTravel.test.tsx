// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  useMessageMotion,
  type MessageMotionOptions
} from '@renderer/components/messages/useMessageMotion'
import { MESSAGE_INSET } from '@renderer/components/messages/stack'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The travel a message card reports on its way out of its slot (v2 §9.33): 0 in the slot, 1
 * gone, following the finger, running back with a spring-back and clearing at rest, reaching 1
 * on a committed exit. The stack rounds the corners a banner uncovers on it from this value, so
 * it must be the drag's own progress and nothing else. The frame clock is driven by hand.
 */

const WIDTH = 360
const HEIGHT = 56

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

/** Run frames at 60 Hz until the springs rest (or `limit` frames pass). */
function settle(limit = 240): void {
  for (let i = 0; i < limit && frames.length > 0; i++) frame(16)
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
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  })) as unknown as typeof window.matchMedia
  // The card has a box: its extent along each axis is the distance at which it is gone.
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => WIDTH
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => HEIGHT
  })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  mount?.remove()
  root = null
  mount = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight
})

function Card({ options }: { options: MessageMotionOptions }): JSX.Element {
  const { ref, handlers } = useMessageMotion(options)
  return (
    <div data-card ref={ref} {...handlers}>
      <span data-text>Zenium can be your default browser</span>
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

type Travel = { progress: number; axis: 'x' | 'y' }

/** A banner in the middle of a stack: it goes up or off to either side. */
function banner(over: Partial<MessageMotionOptions> = {}): MessageMotionOptions & {
  calls: string[]
  travel: Travel[]
} {
  const calls: string[] = []
  const travel: Travel[] = []
  return {
    calls,
    travel,
    home: -1,
    slot: 68,
    dirs: { x: [-1, 1], y: [-1] },
    leaving: false,
    onHold: (held) => calls.push(`hold:${held}`),
    onSwipe: () => calls.push('swipe'),
    onGone: () => calls.push('gone'),
    onTravel: (progress, axis) => travel.push({ progress, axis }),
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

const last = (travel: Travel[]): Travel | undefined => travel[travel.length - 1]

describe('the travel a message card reports', () => {
  it('is silent on the way in and at rest', () => {
    const opts = banner()
    const { card } = render(opts)
    settle()
    expect(card.dataset.moving).toBeUndefined()
    expect(card.dataset.uncover).toBeUndefined()
    expect(opts.travel).toEqual([])
  })

  it('follows the finger sideways as the fraction of the card that has left', () => {
    const opts = banner()
    const { card } = render(opts)
    settle()
    pointer(card, 'pointerdown', 100, 30)
    pointer(card, 'pointermove', 112, 30)
    expect(card.dataset.uncover).toBe('x')
    pointer(card, 'pointermove', 190, 30)
    // 90 px of a 360 px card: a quarter of the way out, and the card thins by the same amount.
    expect(last(opts.travel)).toEqual({ progress: 0.25, axis: 'x' })
    expect(card.style.opacity).toBe('0.750')
    pointer(card, 'pointermove', 280, 30)
    expect(last(opts.travel)!.progress).toBeCloseTo(0.5)
  })

  it('follows the finger upwards against the card and the inset it must clear', () => {
    const opts = banner()
    const { card } = render(opts)
    settle()
    pointer(card, 'pointerdown', 100, 40)
    pointer(card, 'pointermove', 100, 28)
    expect(card.dataset.uncover).toBe('y')
    pointer(card, 'pointermove', 100, 40 - (HEIGHT + MESSAGE_INSET) / 2)
    expect(last(opts.travel)!.progress).toBeCloseTo(0.5)
    expect(last(opts.travel)!.axis).toBe('y')
  })

  it('does not count a pull the card cannot follow', () => {
    const opts = banner()
    const { card } = render(opts)
    settle()
    // A banner does not go down: the pull rubber-bands and uncovers nothing.
    pointer(card, 'pointerdown', 100, 40)
    pointer(card, 'pointermove', 100, 52)
    pointer(card, 'pointermove', 100, 120)
    expect(card.dataset.uncover).toBe('y')
    expect(last(opts.travel)).toEqual({ progress: 0, axis: 'y' })
    expect(card.style.opacity).toBe('')
  })

  it('runs back to 0 with the spring-back and clears once the card rests', () => {
    const opts = banner()
    const { card } = render(opts)
    settle()
    pointer(card, 'pointerdown', 100, 30)
    pointer(card, 'pointermove', 112, 30)
    pointer(card, 'pointermove', 160, 30)
    const held = last(opts.travel)!.progress
    expect(held).toBeCloseTo(60 / WIDTH)
    // Let go short of the line at no speed: back it goes.
    pointer(card, 'pointerup', 160, 30)
    expect(opts.calls).toEqual(['hold:true', 'hold:false'])
    const before = opts.travel.length
    frame(16)
    frame(16)
    // Both springs paint (the y one rests at once), so a frame may report its value twice.
    const during = opts.travel
      .slice(before)
      .map((t) => t.progress)
      .filter((p, i, all) => i === 0 || p !== all[i - 1])
    expect(during.length).toBeGreaterThan(0)
    // Un-rounding along the same path: every frame reports less than the one before.
    for (let i = 1; i < during.length; i++) expect(during[i]).toBeLessThan(during[i - 1]!)
    expect(during[0]).toBeLessThan(held)
    expect(card.dataset.uncover).toBe('x')
    settle()
    expect(last(opts.travel)).toEqual({ progress: 0, axis: 'x' })
    expect(card.dataset.uncover).toBeUndefined()
    expect(card.dataset.moving).toBeUndefined()
    expect(card.style.opacity).toBe('')
    expect(card.style.transform).toBe('translate3d(0.00px, 68.00px, 0)')
  })

  it('reaches 1 as a committed swipe carries the card off, then the card is gone', () => {
    const opts = banner()
    const { card } = render(opts)
    settle()
    pointer(card, 'pointerdown', 100, 30)
    pointer(card, 'pointermove', 112, 30)
    pointer(card, 'pointermove', 300, 30)
    pointer(card, 'pointerup', 300, 30)
    expect(opts.calls).toEqual(['hold:true', 'swipe', 'hold:false'])
    expect(card.dataset.uncover).toBe('x')
    const released = last(opts.travel)!.progress
    settle()
    expect(opts.calls).toEqual(['hold:true', 'swipe', 'hold:false', 'gone'])
    const final = last(opts.travel)!
    expect(final.axis).toBe('x')
    expect(final.progress).toBeGreaterThan(released)
    expect(final.progress).toBeCloseTo(1, 1)
  })

  it('reports the exit of a card dismissed from outside by its home edge', () => {
    const opts = banner()
    const { card, rerender } = render(opts)
    settle()
    rerender({ ...opts, leaving: true })
    frame(16)
    expect(card.dataset.uncover).toBe('y')
    expect(last(opts.travel)!.axis).toBe('y')
    expect(last(opts.travel)!.progress).toBeGreaterThan(0)
    settle()
    expect(opts.calls).toEqual(['gone'])
    expect(last(opts.travel)!.progress).toBeCloseTo(1, 1)
  })

  it('leaves no travel behind when the card unmounts mid-way', () => {
    const opts = banner()
    const { card } = render(opts)
    settle()
    pointer(card, 'pointerdown', 100, 30)
    pointer(card, 'pointermove', 112, 30)
    pointer(card, 'pointermove', 200, 30)
    expect(last(opts.travel)!.progress).toBeGreaterThan(0)
    act(() => root!.unmount())
    root = null
    expect(last(opts.travel)).toEqual({ progress: 0, axis: 'x' })
  })
})
