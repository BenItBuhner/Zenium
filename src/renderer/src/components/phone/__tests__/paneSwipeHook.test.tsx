// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useRef, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { OverviewPane } from '@renderer/lib/privateTabs'
import { SEGMENT_LINE_CLASS, usePaneSwipe } from '../usePaneSwipe'

/*
 * The switcher's pane swipe on the DOM (GN-19, `usePaneSwipe`): what a touch on the pane's
 * background does to the segment's line and the pane's opacity while the finger is down, and
 * what a release does – Chrome's Hub rule from `lib/gestures/paneSwipe.ts`, the writes v2
 * §11.3's (a transform and an opacity, input under the finger, the spring after).
 */

const PANES: readonly OverviewPane[] = ['tabs', 'groups', 'private']
const WIDTH = 360
/** Each label's box in the tablist: 56 wide at 8, 72, 136. */
const TAB_LEFT: Record<OverviewPane, number> = { tabs: 8, groups: 72, private: 136 }
const TAB_WIDTH = 56

const onPick = vi.fn()
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Overview({
  pane,
  enabled = true
}: {
  pane: OverviewPane
  enabled?: boolean
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const swipe = usePaneSwipe(rootRef, { pane, panes: PANES, enabled, onPick })
  return (
    <div ref={rootRef} data-testid="root" {...swipe}>
      <header data-testid="header" />
      <div role="tablist" className="zen-v2-segment zen-overview-segment">
        {PANES.map((id) => (
          <button key={id} type="button" role="tab" aria-selected={pane === id} data-pane={id}>
            {id}
          </button>
        ))}
        <span className={SEGMENT_LINE_CLASS} data-testid="line" />
      </div>
      <div className="zen-overview-pane" data-testid="pane">
        <div data-testid="background" />
        <div data-cell="c1" data-testid="card" />
        <div role="button" data-testid="row" />
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
  const pane = el.querySelector<HTMLElement>('[data-testid="pane"]')!
  pane.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 100,
      right: WIDTH,
      bottom: 700,
      width: WIDTH,
      height: 600,
      x: 0,
      y: 100
    }) as DOMRect
  for (const tab of el.querySelectorAll<HTMLElement>('[role="tab"]')) {
    const id = tab.dataset.pane as OverviewPane
    Object.defineProperty(tab, 'offsetLeft', { value: TAB_LEFT[id], configurable: true })
    Object.defineProperty(tab, 'offsetWidth', { value: TAB_WIDTH, configurable: true })
  }
}

function render(pane: OverviewPane, enabled = true): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(<Overview pane={pane} enabled={enabled} />))
  const el = mount.querySelector<HTMLElement>('[data-testid="root"]')!
  layOut(el)
  return el
}

const q = (el: HTMLElement, id: string): HTMLElement => el.querySelector(`[data-testid="${id}"]`)!
const tablist = (el: HTMLElement): HTMLElement => el.querySelector('[role="tablist"]')!

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

/** From the label at `from` to the label at `to`: the line's transform at progress `p`. */
const lineAt = (from: OverviewPane, to: OverviewPane, p: number): string =>
  `translate3d(${(TAB_LEFT[to] - TAB_LEFT[from]) * p}px, 0, 0) scaleX(1)`

describe('the pane swipe (GN-19)', () => {
  it('a touch on the pane’s background is nothing under the slop, then a swipe left claims it and rides the finger', () => {
    const el = render('tabs')
    const bg = q(el, 'background')
    pointer(bg, 'pointerdown', 180, 400, 0)
    pointer(bg, 'pointermove', 174, 402, 16)
    expect(tablist(el).dataset.swipe).toBeUndefined()
    expect(q(el, 'line').style.transform).toBe('')
    // Past the slop, leftwards: Groups is the neighbour; the line is laid out under Tabs and
    // the frame is written for 20 px of 360.
    pointer(bg, 'pointermove', 160, 404, 32)
    expect(tablist(el).dataset.swipe).toBe('')
    expect(q(el, 'line').style.left).toBe(`${TAB_LEFT.tabs + 8}px`)
    expect(q(el, 'line').style.width).toBe(`${TAB_WIDTH - 16}px`)
    expect(q(el, 'line').style.transform).toBe(lineAt('tabs', 'groups', 20 / WIDTH))
    expect(q(el, 'pane').style.opacity).toBe(String(1 - 20 / WIDTH))
    expect(Element.prototype.setPointerCapture).toHaveBeenCalledWith(1)
    // Half way: the line half way to Groups, the pane half gone – the leaving half of the
    // cross-fade under the finger.
    pointer(el, 'pointermove', 0, 404, 48)
    expect(q(el, 'line').style.transform).toBe(lineAt('tabs', 'groups', 0.5))
    expect(q(el, 'pane').style.opacity).toBe('0.5')
    // Nothing is on a spring while the finger is down.
    expect(queued).toHaveLength(0)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('a release past a third picks the neighbour and springs the line the rest of the way; the pane keeps the drag’s opacity for its still', () => {
    const el = render('tabs')
    const bg = q(el, 'background')
    pointer(bg, 'pointerdown', 300, 400, 0)
    pointer(bg, 'pointermove', 280, 400, 16)
    pointer(el, 'pointermove', 200, 400, 200)
    pointer(el, 'pointermove', 150, 400, 400)
    pointer(el, 'pointermove', 150, 400, 600)
    pointer(el, 'pointerup', 150, 400, 800)
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith('groups')
    // The swipe stays live over the spring, the line heading to Groups from 150 / 360.
    expect(tablist(el).dataset.swipe).toBe('')
    expect(queued.length).toBeGreaterThan(0)
    const frames = runFrames()
    expect(frames).toBeGreaterThan(1)
    expect(q(el, 'line').style.transform).toBe(lineAt('tabs', 'groups', 1))
    expect(tablist(el).dataset.swipe).toBeUndefined()
    // The slot is the switch's now: its opacity is left where the drag had it, for the still.
    expect(q(el, 'pane').style.opacity).toBe(String(1 - 150 / WIDTH))
  })

  it('a release short of a third springs the line and the pane back and picks nothing', () => {
    const el = render('groups')
    const bg = q(el, 'background')
    pointer(bg, 'pointerdown', 100, 400, 0)
    pointer(bg, 'pointermove', 120, 400, 16)
    pointer(el, 'pointermove', 160, 400, 300)
    pointer(el, 'pointermove', 160, 400, 500)
    // Rightwards from Groups: Tabs is the neighbour.
    expect(q(el, 'line').style.transform).toBe(lineAt('groups', 'tabs', 60 / WIDTH))
    pointer(el, 'pointerup', 160, 400, 700)
    expect(onPick).not.toHaveBeenCalled()
    runFrames()
    expect(q(el, 'line').style.transform).toBe(lineAt('groups', 'tabs', 0))
    expect(q(el, 'pane').style.opacity).toBe('')
    expect(tablist(el).dataset.swipe).toBeUndefined()
  })

  it('a fling onward picks the neighbour from a short distance', () => {
    const el = render('groups')
    const bg = q(el, 'background')
    pointer(bg, 'pointerdown', 180, 400, 0)
    pointer(bg, 'pointermove', 165, 400, 16)
    pointer(el, 'pointermove', 150, 400, 32)
    pointer(el, 'pointermove', 135, 400, 48)
    pointer(el, 'pointerup', 135, 400, 48)
    expect(onPick).toHaveBeenCalledWith('private')
    runFrames()
    expect(q(el, 'line').style.transform).toBe(lineAt('groups', 'private', 1))
  })

  it('a cancel mid-drag springs back', () => {
    const el = render('tabs')
    const bg = q(el, 'background')
    pointer(bg, 'pointerdown', 300, 400, 0)
    pointer(bg, 'pointermove', 200, 400, 16)
    expect(tablist(el).dataset.swipe).toBe('')
    pointer(el, 'pointercancel', 200, 400, 32)
    expect(onPick).not.toHaveBeenCalled()
    runFrames()
    expect(q(el, 'pane').style.opacity).toBe('')
    expect(tablist(el).dataset.swipe).toBeUndefined()
  })

  it('a vertical-first move is the scroller’s: nothing is claimed for the rest of the touch', () => {
    const el = render('tabs')
    const bg = q(el, 'background')
    pointer(bg, 'pointerdown', 180, 400, 0)
    pointer(bg, 'pointermove', 182, 420, 16)
    pointer(bg, 'pointermove', 100, 430, 32)
    expect(tablist(el).dataset.swipe).toBeUndefined()
    expect(q(el, 'pane').style.opacity).toBe('')
    pointer(bg, 'pointerup', 100, 430, 48)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('a touch on a card or a row is theirs, and one in the edge gutters is the system’s', () => {
    const el = render('tabs')
    for (const [target, x] of [
      [q(el, 'card'), 180],
      [q(el, 'row'), 180],
      [q(el, 'background'), 20],
      [q(el, 'background'), WIDTH - 20]
    ] as const) {
      pointer(target, 'pointerdown', x, 400, 0)
      pointer(target, 'pointermove', x - 60, 400, 16)
      expect(tablist(el).dataset.swipe).toBeUndefined()
      pointer(target, 'pointerup', x - 60, 400, 32)
    }
    expect(onPick).not.toHaveBeenCalled()
  })

  it('a swipe with no pane that way is nothing', () => {
    const el = render('tabs')
    const bg = q(el, 'background')
    pointer(bg, 'pointerdown', 100, 400, 0)
    pointer(bg, 'pointermove', 200, 400, 16)
    expect(tablist(el).dataset.swipe).toBeUndefined()
    pointer(bg, 'pointerup', 260, 400, 32)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('the header is not the pane: a drag there is not a swipe', () => {
    const el = render('tabs')
    const header = q(el, 'header')
    pointer(header, 'pointerdown', 180, 20, 0)
    pointer(header, 'pointermove', 100, 20, 16)
    expect(tablist(el).dataset.swipe).toBeUndefined()
    pointer(header, 'pointerup', 100, 20, 32)
  })

  it('takes nothing while disabled', () => {
    const el = render('tabs', false)
    const bg = q(el, 'background')
    pointer(bg, 'pointerdown', 180, 400, 0)
    pointer(bg, 'pointermove', 100, 400, 16)
    expect(tablist(el).dataset.swipe).toBeUndefined()
    pointer(bg, 'pointerup', 100, 400, 32)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('under reduced motion the drag still rides the finger and the release jumps', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }))
    const el = render('tabs')
    const bg = q(el, 'background')
    pointer(bg, 'pointerdown', 300, 400, 0)
    pointer(bg, 'pointermove', 280, 400, 16)
    pointer(el, 'pointermove', 120, 400, 200)
    expect(q(el, 'line').style.transform).toBe(lineAt('tabs', 'groups', 0.5))
    expect(q(el, 'pane').style.opacity).toBe('0.5')
    pointer(el, 'pointermove', 120, 400, 400)
    pointer(el, 'pointerup', 120, 400, 600)
    expect(onPick).toHaveBeenCalledWith('groups')
    // No frame was asked for: the line is under Groups at once and the swipe is over.
    expect(queued).toHaveLength(0)
    expect(q(el, 'line').style.transform).toBe(lineAt('tabs', 'groups', 1))
    expect(tablist(el).dataset.swipe).toBeUndefined()
  })
})
