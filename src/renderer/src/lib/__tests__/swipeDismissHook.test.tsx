// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  useSwipeDismiss,
  type SwipeDismissCallbacks
} from '@renderer/components/messages/useSwipeDismiss'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The card's pointer handling against a touch, as the WebView delivers it: the touch is
 * implicitly captured by the element it lands on (here the card's text), and the card taking
 * the capture for itself fires `lostpointercapture` on that child, which bubbles to the card.
 */

let root: Root | null = null
let mount: HTMLElement | null = null

function Card({ callbacks }: { callbacks: SwipeDismissCallbacks }): JSX.Element {
  const handlers = useSwipeDismiss(callbacks)
  return (
    <div data-card {...handlers}>
      <span data-text>Tab closed</span>
      <button type="button">Undo</button>
    </div>
  )
}

function render(callbacks: SwipeDismissCallbacks): { card: HTMLElement; text: HTMLElement } {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(<Card callbacks={callbacks} />))
  const card = mount.querySelector('[data-card]') as HTMLElement
  const text = mount.querySelector('[data-text]') as HTMLElement
  // happy-dom has no pointer capture: the card's own release path must not throw without it.
  const captured = new Set<number>()
  card.setPointerCapture = (id: number) => {
    captured.add(id)
  }
  card.releasePointerCapture = (id: number) => {
    captured.delete(id)
  }
  card.hasPointerCapture = (id: number) => captured.has(id)
  return { card, text }
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  mount?.remove()
  root = null
  mount = null
})

function pointer(
  target: HTMLElement,
  type: string,
  x: number,
  y: number,
  init: Partial<PointerEventInit> = {}
): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 7,
        pointerType: 'touch',
        clientX: x,
        clientY: y,
        button: 0,
        ...init
      })
    )
  })
}

function callbacks(): SwipeDismissCallbacks & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    dirs: { x: [-1, 1], y: [1] },
    onHold: (held) => calls.push(`hold:${held}`),
    onDragStart: (axis) => calls.push(`start:${axis}`),
    onDrag: (axis, delta) => calls.push(`drag:${axis}:${Math.round(delta)}`),
    onRelease: (axis, delta, velocity) =>
      calls.push(
        `release:${axis}:${Math.round(delta)}:${velocity > 0 ? '+' : velocity < 0 ? '-' : '0'}`
      )
  }
}

describe('useSwipeDismiss under a touch', () => {
  it('keeps the drag when the child the touch landed on loses its implicit capture to the card', () => {
    const cb = callbacks()
    const { card, text } = render(cb)
    pointer(text, 'pointerdown', 40, 20)
    pointer(text, 'pointermove', 52, 20)
    // The card took the capture: the browser reports the child's loss, and it bubbles up.
    pointer(text, 'lostpointercapture', 52, 20)
    pointer(card, 'pointermove', 120, 20)
    pointer(card, 'pointerup', 200, 20)
    expect(cb.calls).toEqual([
      'hold:true',
      'start:x',
      'drag:x:12',
      'drag:x:80',
      'release:x:160:+',
      'hold:false'
    ])
  })

  it('still ends the drag when the card itself loses the capture', () => {
    const cb = callbacks()
    const { card, text } = render(cb)
    pointer(text, 'pointerdown', 40, 20)
    pointer(text, 'pointermove', 60, 20)
    pointer(card, 'lostpointercapture', 60, 20)
    pointer(card, 'pointermove', 120, 20)
    pointer(card, 'pointerup', 200, 20)
    // Cancelled at 20 px along: the release reports where the finger was when the capture went.
    expect(cb.calls).toEqual(['hold:true', 'start:x', 'drag:x:20', 'release:x:20:0', 'hold:false'])
  })

  it('swallows the click that follows a drag, and lets a tap through', () => {
    const cb = callbacks()
    const { card, text } = render(cb)
    const clicks = vi.fn()
    card.addEventListener('click', clicks)
    pointer(text, 'pointerdown', 40, 20)
    pointer(text, 'pointermove', 90, 20)
    pointer(card, 'pointerup', 90, 20)
    act(() => {
      text.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(clicks).not.toHaveBeenCalled()
    pointer(text, 'pointerdown', 40, 20)
    pointer(text, 'pointerup', 41, 20)
    act(() => {
      text.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(clicks).toHaveBeenCalledTimes(1)
    expect(cb.calls.filter((c) => c.startsWith('start'))).toHaveLength(1)
  })
})
