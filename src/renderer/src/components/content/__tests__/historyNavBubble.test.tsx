// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { HistoryNavHostFrame } from '@renderer/lib/historyNav'

/*
 * The history navigation bubble (GN-04) on the two kinds of host. Where the chrome is on top
 * the disc is the DOM's, moved on transform and opacity through refs. Where a host draws the
 * disc itself (Android, whose pages are layered above the chrome) the component renders no
 * disc and hands the host the same frames as the disc's box in window px with the viewport's
 * box as the clip – once per frame, and `null` as the bubble goes down – while the root stays
 * on the DOM as the drag's state.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run = vi.fn()
vi.mock('@renderer/lib/api', () => ({
  run: (...args: unknown[]) => run(...args),
  cmd: vi.fn(),
  onEvent: () => () => undefined
}))

const {
  abortHistoryNav,
  BUBBLE_SIZE,
  dispatchHistoryNavEvent,
  NAV_STEP_CLAMP,
  NAV_THRESHOLD,
  setHistoryNavHost
} = await import('@renderer/lib/historyNav')
const { HistoryNavBubble } = await import('../HistoryNavBubble')

/** The content frame the root is laid along: 360 wide from x 6 (a gutter to the window's edge), from y 100 to 700. */
const FRAME = { left: 6, right: 366, top: 100, bottom: 700 }

let container: HTMLDivElement
let root: Root
const applied: Array<HistoryNavHostFrame | null> = []

const rootEl = (): HTMLElement | null => document.querySelector('[data-testid="history-nav"]')
const disc = (): HTMLElement | null => document.querySelector('[data-testid="history-nav-bubble"]')

/** `count` samples of the finger, each one step clamp further in: the motion follows exactly. */
function drag(count: number, edge: 'left' | 'right' = 'left'): void {
  act(() => dispatchHistoryNavEvent('t1', 'start', { edge }))
  for (let i = 1; i <= count; i++) {
    act(() => dispatchHistoryNavEvent('t1', 'move', { travel: NAV_STEP_CLAMP * i, time: i * 16 }))
  }
}

beforeEach(() => {
  applied.length = 0
  run.mockReset()
  // The springs never advance here: the frames under test are the finger's.
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  // The root has no width of its own: its box is the frame's side it is laid along; its
  // parent (the viewport that clips the disc) is the whole frame.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const isRoot = this.getAttribute('data-testid') === 'history-nav'
    const x = this.getAttribute('data-edge') === 'right' ? FRAME.right : FRAME.left
    const left = isRoot ? x : FRAME.left
    const right = isRoot ? x : FRAME.right
    return {
      left,
      right,
      top: FRAME.top,
      bottom: FRAME.bottom,
      width: right - left,
      height: FRAME.bottom - FRAME.top,
      x: left,
      y: FRAME.top,
      toJSON: () => ({})
    } as DOMRect
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(createElement(HistoryNavBubble)))
})

afterEach(() => {
  act(() => abortHistoryNav())
  act(() => root.unmount())
  container.remove()
  setHistoryNavHost(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('HistoryNavBubble', () => {
  it('draws nothing while idle', () => {
    expect(rootEl()).toBeNull()
    expect(disc()).toBeNull()
  })

  describe('with the chrome on top (no host)', () => {
    it('moves the DOM disc on transform and opacity and flags armed on it and the root', () => {
      drag(3)
      const el = disc()
      expect(el).not.toBeNull()
      expect(rootEl()?.dataset.hosted).toBeUndefined()
      expect(el!.style.transform.startsWith('translate3d(')).toBe(true)
      expect(el!.style.transform).toContain(`${NAV_STEP_CLAMP * 3 - BUBBLE_SIZE}px`)
      expect(el!.style.opacity).toBe('1')
      expect(el!.dataset.armed).toBeUndefined()
      expect(rootEl()?.dataset.armed).toBeUndefined()
      // Ten steps of a third of a drag distance are the least that arm.
      for (let i = 4; i <= 10; i++) {
        act(() =>
          dispatchHistoryNavEvent('t1', 'move', { travel: NAV_STEP_CLAMP * i, time: i * 16 })
        )
      }
      expect(rootEl()?.dataset.phase).toBe('dragging')
      expect(disc()!.dataset.armed).toBe('')
      expect(rootEl()?.dataset.armed).toBe('')
      expect(run).toHaveBeenCalledWith('haptic', { kind: 'tick' })
    })
  })

  describe('with a host drawing the disc', () => {
    beforeEach(() => {
      setHistoryNavHost({ apply: (frame) => applied.push(frame) })
    })

    it('renders the root as the state and no disc, and lays the host its disc against the frame', () => {
      drag(0)
      expect(rootEl()?.dataset.hosted).toBe('true')
      expect(rootEl()?.dataset.phase).toBe('dragging')
      expect(rootEl()?.dataset.edge).toBe('left')
      expect(disc()).toBeNull()
      // The rest: a whole disc out beyond the frame's left side, centred on its height, clipped
      // to the frame – over the gutter to the window's edge nothing of it shows.
      expect(applied).toEqual([
        {
          edge: 'left',
          left: FRAME.left - BUBBLE_SIZE,
          top: (FRAME.top + FRAME.bottom) / 2 - BUBBLE_SIZE / 2,
          size: BUBBLE_SIZE,
          scale: 1,
          opacity: 0,
          armed: false,
          reduced: false,
          clip: { left: FRAME.left, top: FRAME.top, right: FRAME.right, bottom: FRAME.bottom }
        }
      ])
    })

    it('hands the host a frame per sample, the leading edge riding the finger, and the armed flag at the threshold', () => {
      drag(10)
      expect(applied).toHaveLength(11)
      const third = applied[3]!
      expect(third.left + third.size).toBeCloseTo(FRAME.left + NAV_STEP_CLAMP * 3, 9)
      expect(third.opacity).toBe(1)
      expect(third.armed).toBe(false)
      const last = applied[10]!
      expect(last.armed).toBe(true)
      expect(last.left + last.size).toBeGreaterThan(FRAME.left + NAV_THRESHOLD)
      // The clip is measured with the side, once: every frame carries the same box.
      expect(applied.every((f) => f !== null && f.clip.left === FRAME.left)).toBe(true)
      expect(rootEl()?.dataset.armed).toBe('')
      expect(run).toHaveBeenCalledWith('haptic', { kind: 'tick' })
    })

    it('measures the frame once per drag – the side and the clip box in one frame – and never per sample', () => {
      drag(6)
      const reads = vi.mocked(Element.prototype.getBoundingClientRect).mock.calls.length
      expect(reads).toBe(2)
    })

    it('lays a right-edge drag against the right side', () => {
      drag(3, 'right')
      expect(applied[0]).toMatchObject({ edge: 'right', left: FRAME.right, opacity: 0 })
      // The leading (left) edge stands three steps in from the right side.
      expect(applied[3]!.left).toBeCloseTo(FRAME.right - NAV_STEP_CLAMP * 3, 9)
    })

    it('takes the disc down with null as the bubble goes idle', () => {
      drag(3)
      applied.length = 0
      act(() => abortHistoryNav())
      expect(rootEl()).toBeNull()
      // The machine's last paint puts the disc at rest, then the component lets the host go.
      expect(applied[applied.length - 1]).toBeNull()
      expect(applied[applied.length - 2]).toMatchObject({
        opacity: 0,
        left: FRAME.left - BUBBLE_SIZE
      })
    })
  })
})
