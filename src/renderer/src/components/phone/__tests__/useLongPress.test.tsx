// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useLongPress, type LongPressDrag, type LongPressOptions } from '../useLongPress'

/*
 * `useLongPress` with a drag to hand the touch to (NTP-06, the new tab page's tiles): a hold
 * that lifts without moving is the menu's cue at the lift, as before; a hold that then moves
 * past the slop is a drag – the moves and the lift are the drag's from there, the press callback
 * stays quiet, the click that follows is swallowed and the page under the element does not
 * scroll – and a drag declined leaves the move a scroll.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const POINTER = 3

interface Probe {
  el: HTMLElement
  press: ReturnType<typeof vi.fn>
  hold: ReturnType<typeof vi.fn>
  holdEnd: ReturnType<typeof vi.fn>
  drag: ReturnType<typeof vi.fn>
  clicked: ReturnType<typeof vi.fn>
  swallowed: boolean[]
  moves: PointerEvent[]
  ends: Array<[PointerEvent, boolean]>
}

const mounted: Array<{ root: Root; host: HTMLElement }> = []

/** An element under the hook; `draggable` gives it a drag to hand the touch to (or `null` to decline). */
function mount(draggable: boolean | null = false): Probe {
  const moves: PointerEvent[] = []
  const ends: Array<[PointerEvent, boolean]> = []
  const swallowed: boolean[] = []
  const session: LongPressDrag = {
    move: (e) => void moves.push(e),
    end: (e, cancelled) => void ends.push([e, cancelled])
  }
  const press = vi.fn()
  const hold = vi.fn()
  const holdEnd = vi.fn()
  const drag = vi.fn(() => (draggable ? session : null))
  const clicked = vi.fn()
  const options: LongPressOptions =
    draggable === false
      ? { onHold: hold, onHoldEnd: holdEnd }
      : { onHold: hold, onHoldEnd: holdEnd, onDrag: drag }
  function Held(): React.JSX.Element {
    const lp = useLongPress(press, options)
    return createElement('div', {
      'data-testid': 'held',
      ...lp.handlers,
      onClick: () => {
        const s = lp.swallowsClick()
        swallowed.push(s)
        if (!s) clicked()
      }
    })
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  act(() => root.render(createElement(Held)))
  const el = host.querySelector<HTMLElement>('[data-testid="held"]')!
  el.setPointerCapture = vi.fn()
  return { el, press, hold, holdEnd, drag, clicked, swallowed, moves, ends }
}

function pointer(type: string, target: EventTarget, x: number, y: number): PointerEvent {
  const event = new PointerEvent(type, {
    pointerId: POINTER,
    clientX: x,
    clientY: y,
    button: 0,
    bubbles: true,
    cancelable: true,
    pointerType: 'touch',
    isPrimary: true
  })
  act(() => void target.dispatchEvent(event))
  return event
}

const click = (el: HTMLElement): void => {
  act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}
const contextmenu = (el: HTMLElement): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
}
const elapse = (ms: number): void => {
  act(() => void vi.advanceTimersByTime(ms))
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const { root, host } of mounted.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  vi.useRealTimers()
})

describe('a hold that lifts', () => {
  it('is recognised at 380 ms with the point held at, and the callback comes on the click that follows the lift', () => {
    const p = mount()
    pointer('pointerdown', p.el, 40, 50)
    elapse(379)
    expect(p.hold).not.toHaveBeenCalled()
    elapse(1)
    expect(p.hold).toHaveBeenCalledWith({ x: 40, y: 50 })
    pointer('pointerup', p.el, 41, 51)
    expect(p.holdEnd).toHaveBeenCalledTimes(1)
    expect(p.press).not.toHaveBeenCalled()
    click(p.el)
    expect(p.swallowed).toEqual([true])
    expect(p.clicked).not.toHaveBeenCalled()
    expect(p.press).toHaveBeenCalledWith({ x: 40, y: 50 })
    // The next tap is a tap.
    pointer('pointerdown', p.el, 40, 50)
    pointer('pointerup', p.el, 40, 50)
    click(p.el)
    expect(p.swallowed).toEqual([true, false])
    expect(p.clicked).toHaveBeenCalledTimes(1)
    expect(p.press).toHaveBeenCalledTimes(1)
  })

  it('fires after a moment when no click follows the lift', () => {
    const p = mount()
    pointer('pointerdown', p.el, 10, 10)
    elapse(380)
    pointer('pointerup', p.el, 10, 10)
    elapse(249)
    expect(p.press).not.toHaveBeenCalled()
    elapse(1)
    expect(p.press).toHaveBeenCalledTimes(1)
  })

  it('a finger that moves past the slop before the hold is a scroll: nothing fires', () => {
    const p = mount()
    pointer('pointerdown', p.el, 10, 10)
    elapse(200)
    pointer('pointermove', p.el, 10, 30)
    elapse(400)
    expect(p.hold).not.toHaveBeenCalled()
    pointer('pointerup', p.el, 10, 30)
    elapse(300)
    expect(p.press).not.toHaveBeenCalled()
    expect(p.holdEnd).not.toHaveBeenCalled()
  })
})

describe('a hold handed to a drag (NTP-06)', () => {
  it('the finger moving past the slop while held begins the drag: the moves and the lift are its, the callback stays quiet, the click is swallowed', () => {
    const p = mount(true)
    pointer('pointerdown', p.el, 100, 100)
    elapse(380)
    expect(p.hold).toHaveBeenCalledTimes(1)
    // Within the slop: still a hold.
    pointer('pointermove', p.el, 104, 103)
    expect(p.drag).not.toHaveBeenCalled()
    // Past it: the drag begins with this very move.
    const first = pointer('pointermove', p.el, 112, 100)
    expect(p.drag).toHaveBeenCalledTimes(1)
    expect(p.moves).toEqual([first])
    expect(p.el.setPointerCapture).toHaveBeenCalledWith(POINTER)
    const second = pointer('pointermove', p.el, 160, 120)
    expect(p.moves).toEqual([first, second])
    // The finger lifts: the drag ends, not cancelled; no menu, no hold-end (the drag took over).
    const up = pointer('pointerup', p.el, 160, 120)
    expect(p.ends).toEqual([[up, false]])
    expect(p.holdEnd).not.toHaveBeenCalled()
    click(p.el)
    expect(p.swallowed).toEqual([true])
    expect(p.clicked).not.toHaveBeenCalled()
    elapse(1000)
    expect(p.press).not.toHaveBeenCalled()
  })

  it('a drag declined leaves the move a scroll: the hold ends, nothing fires', () => {
    const p = mount(null)
    pointer('pointerdown', p.el, 100, 100)
    elapse(380)
    pointer('pointermove', p.el, 100, 120)
    expect(p.drag).toHaveBeenCalledTimes(1)
    expect(p.holdEnd).toHaveBeenCalledTimes(1)
    pointer('pointermove', p.el, 100, 140)
    expect(p.moves).toEqual([])
    pointer('pointerup', p.el, 100, 140)
    elapse(1000)
    expect(p.press).not.toHaveBeenCalled()
    expect(p.ends).toEqual([])
  })

  it('the touch taken away mid-drag ends it cancelled', () => {
    const p = mount(true)
    pointer('pointerdown', p.el, 100, 100)
    elapse(380)
    pointer('pointermove', p.el, 120, 100)
    const cancel = pointer('pointercancel', p.el, 120, 100)
    expect(p.ends).toEqual([[cancel, true]])
    elapse(1000)
    expect(p.press).not.toHaveBeenCalled()
  })

  it('while a draggable element is held the touch may not scroll the page; the block goes with the hold', () => {
    const p = mount(true)
    pointer('pointerdown', p.el, 100, 100)
    elapse(380)
    const scroll = new Event('touchmove', { cancelable: true, bubbles: true })
    p.el.dispatchEvent(scroll)
    expect(scroll.defaultPrevented).toBe(true)
    pointer('pointerup', p.el, 100, 100)
    const after = new Event('touchmove', { cancelable: true, bubbles: true })
    p.el.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
    // Without a drag to hand to, a hold never blocks the scroll.
    const plain = mount(false)
    pointer('pointerdown', plain.el, 100, 100)
    elapse(380)
    const free = new Event('touchmove', { cancelable: true, bubbles: true })
    plain.el.dispatchEvent(free)
    expect(free.defaultPrevented).toBe(false)
  })

  it('the contextmenu a touch hold raises is not the menu’s cue on a draggable element: the callback waits for the lift', () => {
    const p = mount(true)
    pointer('pointerdown', p.el, 100, 100)
    elapse(380)
    contextmenu(p.el)
    expect(p.press).not.toHaveBeenCalled()
    // The finger may still go on to drag…
    pointer('pointermove', p.el, 130, 100)
    expect(p.drag).toHaveBeenCalledTimes(1)
    pointer('pointerup', p.el, 130, 100)
    elapse(1000)
    expect(p.press).not.toHaveBeenCalled()
    // …or lift, and the menu comes then.
    const q = mount(true)
    pointer('pointerdown', q.el, 100, 100)
    elapse(380)
    contextmenu(q.el)
    pointer('pointerup', q.el, 100, 100)
    expect(q.holdEnd).toHaveBeenCalledTimes(1)
    elapse(250)
    expect(q.press).toHaveBeenCalledTimes(1)
  })

  it('without a drag the contextmenu is the menu at once, as for the mouse', () => {
    const p = mount(false)
    pointer('pointerdown', p.el, 100, 100)
    elapse(380)
    contextmenu(p.el)
    expect(p.press).toHaveBeenCalledTimes(1)
    pointer('pointerup', p.el, 100, 100)
    elapse(1000)
    expect(p.press).toHaveBeenCalledTimes(1)
  })
})
