// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useRef, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { slotTravel, useSpaceSwipe } from '../useSpaceSwipe'

/*
 * The overview's SPACE swipe on the DOM (GN-19 under the tab overview cleanup spec §1, §6;
 * `useSpaceSwipe`): what a touch on the grid's background does to the Space's slot while the
 * finger is down – one transform, 1:1 – and what a release does: Chrome's Hub rule from
 * `lib/gestures/paneSwipe.ts` turned to the Spaces (a third of the width or a fling onward picks
 * the neighbour; `onPick` gets the Space and where the drag left the grid; short of it the slot
 * springs back on `SPRING_SNAPPY`). The writes are v2 §11.3's: a transform under the finger, the
 * spring after, and nothing else.
 */

const SPACES: readonly string[] = ['work', 'home', 'reading']
const WIDTH = 360

const onPick = vi.fn()
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Overview({
  space,
  enabled = true,
  rtl = false
}: {
  space: string
  enabled?: boolean
  rtl?: boolean
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const swipe = useSpaceSwipe(rootRef, { spaceId: space, spaceIds: SPACES, enabled, onPick })
  return (
    <div ref={rootRef} data-testid="root" style={{ direction: rtl ? 'rtl' : 'ltr' }} {...swipe}>
      <header data-testid="header">
        <button type="button" data-testid="title">
          {space}
        </button>
      </header>
      <div className="zen-overview-pane" data-testid="pane">
        <div className="zen-overview-space" data-testid="slot">
          <div className="zen-overview-grid" data-testid="background">
            <div data-cell="c1" data-testid="card" />
            <div role="button" data-testid="row" />
            <div className="zen-essential" data-testid="essential" />
          </div>
        </div>
      </div>
    </div>
  )
}

let root: Root | null = null
let mount: HTMLElement | null = null
let queued: Array<(now: number) => void> = []
let now = 1000

/** Lay the test's boxes out: happy-dom measures nothing on its own. */
function layOut(el: HTMLElement): void {
  const slot = el.querySelector<HTMLElement>('[data-testid="slot"]')!
  slot.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 56,
      right: WIDTH,
      bottom: 700,
      width: WIDTH,
      height: 644,
      x: 0,
      y: 56
    }) as DOMRect
}

function render(space: string, enabled = true, rtl = false): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(<Overview space={space} enabled={enabled} rtl={rtl} />))
  const el = mount.querySelector<HTMLElement>('[data-testid="root"]')!
  layOut(el)
  return el
}

const q = (el: HTMLElement, id: string): HTMLElement => el.querySelector(`[data-testid="${id}"]`)!
const slot = (el: HTMLElement): HTMLElement => q(el, 'slot')

/**
 * Every event's time sits on this base: React reads a native `timeStamp` of 0 as "unset" and
 * substitutes the wall clock, which would put a test's first sample after all the others.
 */
const T0 = 5000

const pointer = (target: HTMLElement, type: string, x: number, y: number, t: number): void => {
  const event = new PointerEvent(type, {
    bubbles: true,
    pointerId: 1,
    pointerType: 'touch',
    button: 0,
    clientX: x,
    clientY: y
  })
  Object.defineProperty(event, 'timeStamp', { value: T0 + t })
  act(() => {
    target.dispatchEvent(event)
  })
}

/** Run the queued animation frames until the spring rests (or a cap). */
function runFrames(cap = 400): number {
  let n = 0
  while (queued.length > 0 && n < cap) {
    const frame = queued.shift()!
    now += 16
    frame(now)
    n++
  }
  return n
}

beforeEach(() => {
  queued = []
  now = 1000
  onPick.mockClear()
  vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
    queued.push(cb)
    return queued.length
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queued.splice(id - 1, 1)
  })
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The slot's transform at progress `p` the finger's way. */
const slotAt = (direction: 'left' | 'right', p: number): string =>
  `translate3d(${slotTravel(p, WIDTH, direction)}px, 0, 0)`

describe('slotTravel', () => {
  it('is the finger’s way, signed: a swipe left carries the slot leftwards', () => {
    expect(slotTravel(0.5, 360, 'left')).toBe(-180)
    expect(slotTravel(0.5, 360, 'right')).toBe(180)
    expect(slotTravel(0, 360, 'left')).toBe(-0)
  })
})

describe('the space swipe (GN-19)', () => {
  it('a touch on the grid’s background is nothing under the slop, then a swipe left claims it and the slot rides the finger 1:1', () => {
    const el = render('work')
    const bg = q(el, 'background')
    pointer(bg, 'pointerdown', 180, 400, 0)
    pointer(bg, 'pointermove', 174, 402, 16)
    expect(slot(el).dataset.swipe).toBeUndefined()
    expect(slot(el).style.transform).toBe('')
    // Past the slop, leftwards: Home is the neighbour; the frame is written for 20 px of 360.
    pointer(bg, 'pointermove', 160, 404, 32)
    expect(slot(el).dataset.swipe).toBe('')
    expect(slot(el).style.transform).toBe(slotAt('left', 20 / WIDTH))
    expect(Element.prototype.setPointerCapture).toHaveBeenCalledWith(1)
    // Half way: the slot half a width on, under the finger.
    pointer(el, 'pointermove', 0, 404, 48)
    expect(slot(el).style.transform).toBe(slotAt('left', 0.5))
    // Nothing is on a spring while the finger is down; nothing but the transform is written.
    expect(queued).toHaveLength(0)
    expect(slot(el).style.opacity).toBe('')
    expect(onPick).not.toHaveBeenCalled()
  })

  it('a release past a third picks the neighbour and hands over where the drag left the grid; the slot stands there for the still', () => {
    const el = render('work')
    const bg = q(el, 'background')
    pointer(bg, 'pointerdown', 300, 400, 0)
    pointer(bg, 'pointermove', 280, 400, 16)
    pointer(el, 'pointermove', 200, 400, 200)
    pointer(el, 'pointermove', 150, 400, 400)
    pointer(el, 'pointermove', 150, 400, 600)
    pointer(el, 'pointerup', 150, 400, 800)
    expect(onPick).toHaveBeenCalledTimes(1)
    const [picked, handoff] = onPick.mock.calls[0] as [string, Record<string, unknown>]
    expect(picked).toBe('home')
    expect(handoff).toMatchObject({ direction: 'left', progress: 150 / WIDTH, width: WIDTH })
    expect(handoff.velocity).toBe(0)
    // The switch takes the slot from here: no spring of the swipe's own, the transform left
    // where the drag had it (the still `PaneSlot` takes measures it into its box).
    expect(queued).toHaveLength(0)
    expect(slot(el).style.transform).toBe(slotAt('left', 150 / WIDTH))
    expect(slot(el).dataset.swipe).toBe('')
  })

  it('a release short of a third springs the slot back and picks nothing', () => {
    const el = render('home')
    const bg = q(el, 'background')
    pointer(bg, 'pointerdown', 100, 400, 0)
    pointer(bg, 'pointermove', 120, 400, 16)
    pointer(el, 'pointermove', 160, 400, 300)
    pointer(el, 'pointermove', 160, 400, 500)
    // Rightwards from Home: Work is the neighbour; the slot is carried right.
    expect(slot(el).style.transform).toBe(slotAt('right', 60 / WIDTH))
    pointer(el, 'pointerup', 160, 400, 700)
    expect(onPick).not.toHaveBeenCalled()
    // The spring carries it back over frames – in pixels, so the 60 px here is a spring and not,
    // as a 0.167 of progress inside the 0.4 rest delta would be, a snap on the first frame –
    // then the slot's transform is its own again.
    expect(queued.length).toBeGreaterThan(0)
    expect(runFrames()).toBeGreaterThan(1)
    expect(slot(el).style.transform).toBe('')
    expect(slot(el).dataset.swipe).toBeUndefined()
  })

  it('a fling onward picks the neighbour from a short distance, the handoff carrying the speed', () => {
    const el = render('home')
    const bg = q(el, 'background')
    pointer(bg, 'pointerdown', 180, 400, 0)
    pointer(bg, 'pointermove', 165, 400, 16)
    pointer(el, 'pointermove', 150, 400, 32)
    pointer(el, 'pointermove', 135, 400, 48)
    pointer(el, 'pointerup', 135, 400, 48)
    expect(onPick).toHaveBeenCalledTimes(1)
    const [picked, handoff] = onPick.mock.calls[0] as [string, Record<string, unknown>]
    expect(picked).toBe('reading')
    expect(handoff).toMatchObject({ direction: 'left', progress: 45 / WIDTH, width: WIDTH })
    expect(handoff.velocity as number).toBeGreaterThan(0)
  })

  it('a cancel mid-drag springs back', () => {
    const el = render('work')
    const bg = q(el, 'background')
    pointer(bg, 'pointerdown', 300, 400, 0)
    pointer(bg, 'pointermove', 200, 400, 16)
    expect(slot(el).dataset.swipe).toBe('')
    pointer(el, 'pointercancel', 200, 400, 32)
    expect(onPick).not.toHaveBeenCalled()
    runFrames()
    expect(slot(el).style.transform).toBe('')
    expect(slot(el).dataset.swipe).toBeUndefined()
  })

  it('a vertical-first move is the scroller’s: nothing is claimed for the rest of the touch', () => {
    const el = render('work')
    const bg = q(el, 'background')
    pointer(bg, 'pointerdown', 180, 400, 0)
    pointer(bg, 'pointermove', 182, 420, 16)
    pointer(bg, 'pointermove', 100, 430, 32)
    expect(slot(el).dataset.swipe).toBeUndefined()
    expect(slot(el).style.transform).toBe('')
    pointer(bg, 'pointerup', 100, 430, 48)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('a touch on a card, a row or an essential is theirs, and one in the edge gutters is the system’s', () => {
    const el = render('work')
    for (const [target, x] of [
      [q(el, 'card'), 180],
      [q(el, 'row'), 180],
      [q(el, 'essential'), 180],
      [q(el, 'background'), 20],
      [q(el, 'background'), WIDTH - 20]
    ] as const) {
      pointer(target, 'pointerdown', x, 400, 0)
      pointer(target, 'pointermove', x - 60, 400, 16)
      expect(slot(el).dataset.swipe).toBeUndefined()
      pointer(target, 'pointerup', x - 60, 400, 32)
    }
    expect(onPick).not.toHaveBeenCalled()
  })

  it('a swipe towards no Space is nothing: the grid’s touch stays the scroller’s', () => {
    const el = render('work')
    const bg = q(el, 'background')
    pointer(bg, 'pointerdown', 100, 400, 0)
    pointer(bg, 'pointermove', 200, 400, 16)
    expect(slot(el).dataset.swipe).toBeUndefined()
    pointer(bg, 'pointerup', 260, 400, 32)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('the header is not the slot: a drag on the title row is not a swipe', () => {
    const el = render('work')
    const header = q(el, 'header')
    pointer(header, 'pointerdown', 180, 20, 0)
    pointer(header, 'pointermove', 100, 20, 16)
    expect(slot(el).dataset.swipe).toBeUndefined()
    pointer(header, 'pointerup', 100, 20, 32)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('takes nothing while disabled', () => {
    const el = render('work', false)
    const bg = q(el, 'background')
    pointer(bg, 'pointerdown', 180, 400, 0)
    pointer(bg, 'pointermove', 100, 400, 16)
    expect(slot(el).dataset.swipe).toBeUndefined()
    pointer(bg, 'pointerup', 100, 400, 32)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('in a right-to-left layout the order runs the other way: a swipe left goes to the previous Space', () => {
    const el = render('home', true, true)
    const bg = q(el, 'background')
    pointer(bg, 'pointerdown', 300, 400, 0)
    pointer(bg, 'pointermove', 280, 400, 16)
    pointer(el, 'pointermove', 150, 400, 300)
    pointer(el, 'pointermove', 150, 400, 500)
    pointer(el, 'pointerup', 150, 400, 700)
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0]).toBe('work')
  })

  it('under reduced motion the drag still rides the finger and a short release rests at once', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }))
    const el = render('work')
    const bg = q(el, 'background')
    pointer(bg, 'pointerdown', 300, 400, 0)
    pointer(bg, 'pointermove', 280, 400, 16)
    pointer(el, 'pointermove', 240, 400, 200)
    expect(slot(el).style.transform).toBe(slotAt('left', 60 / WIDTH))
    pointer(el, 'pointermove', 240, 400, 400)
    pointer(el, 'pointerup', 240, 400, 600)
    expect(onPick).not.toHaveBeenCalled()
    // No frame was asked for: the slot is at rest at once and the swipe is over.
    expect(queued).toHaveLength(0)
    expect(slot(el).style.transform).toBe('')
    expect(slot(el).dataset.swipe).toBeUndefined()
  })
})
