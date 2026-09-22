// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { LongCapture } from '@shared/types'

/*
 * The long-screenshot editor (SH-08, `phone/LongScreenshotSheet.tsx`) rendered for real in
 * happy-dom on the sheet chassis, with the animation frames cranked by hand. What it checks is
 * the picture's fit: computed from the body's box at the sheet's REST (`useSheetRest`), once per
 * picture and detent, never from the body's live height as the chassis animates the sheet's
 * height between its detents – the perf rule (no layout per frame) and §11.1 (the content
 * anchored to the top edge as the sheet rises, not zooming on the way up).
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { LongScreenshotLayer } = await import('../LongScreenshotSheet')
const { fitScale } = await import('../longScreenshotFit')
const { FrameDialogHost } = await import('@renderer/lib/portals')
const { uiStore } = await import('@renderer/lib/ui')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { SHEET_PEEK_FRACTION, SHEET_TOP_MARGIN } = await import('@renderer/lib/motion/sheet')

/** A hand-cranked animation frame: `run(n)` advances the clock 16 ms a frame and runs the callbacks. */
class Frames {
  now = 0
  private queue = new Map<number, (now: number) => void>()
  private seq = 0

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++this.seq
      this.queue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue.delete(id)
    })
    vi.stubGlobal('performance', { now: () => this.now })
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) {
      this.now += 16
      const pending = [...this.queue.values()]
      this.queue.clear()
      for (const cb of pending) cb(this.now)
    }
  }
}

const frames = new Frames()

/** The page the run stitched: a 700 px wide picture of a 1366 px tall viewport, 3.4 screens of it. */
const capture: LongCapture = {
  id: 'long-1',
  preview: 'data:image/jpeg;base64,',
  width: 700,
  height: 4676,
  viewportHeight: 1366
}

/** The layer (the frame) is 800 tall; the sheet's parts around the body: grip 56, footer 64, 8 of padding. */
const LAYER = 800
const GRIP = 56
const FOOTER = 64
const PADDING = 8
const BODY_WIDTH = 360

/**
 * What the chassis's own layout reads see (happy-dom lays nothing out). The body's live height
 * is the sheet's animated height less its parts – the number a fit against the live scroller
 * would take, and the number the fit must not take.
 */
let sheetLive = 0
function stubLayout(): void {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains('zen-sheet-scroll'))
        return Math.max(0, sheetLive - GRIP - FOOTER - PADDING)
      return LAYER
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-sheet-scroll') ? BODY_WIDTH : LAYER
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      // The sheet's intrinsic height: the body asks for the whole viewport (`min-height: 100vh`),
      // so the expanded detent is the chassis's ceiling.
      if (this.classList.contains('zen-sheet')) return 2000
      if (this.classList.contains('zen-sheet-grip')) return GRIP
      if (this.classList.contains('zen-sheet-footer')) return FOOTER
      return 300
    }
  })
}

let root: Root | null = null
let host: HTMLElement | null = null

function render(): void {
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  act(() =>
    root!.render(
      <FrameDialogHost frame>
        <LongScreenshotLayer />
      </FrameDialogHost>
    )
  )
}

/** The editor up on the picture, its wait for the page's cover over (at once, with no page). */
async function open(): Promise<void> {
  uiStore.set({ longScreenshot: { id: 1, tabId: 't1', capture, busy: false } })
  render()
  await act(async () => {
    await Promise.resolve()
  })
}

const q = <T extends HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)
const sheet = (): HTMLElement => q('.zen-sheet')!
const frameEl = (): HTMLElement => q('.zen-longshot-frame')!
/** The frame's box as rendered, `w×h`; '' before the first fit. */
const frameBox = (): string =>
  frameEl().style.width ? `${frameEl().style.width}×${frameEl().style.height}` : ''
const box = (width: number, height: number): string => `${width}px×${height}px`

/** One frame of the sheet's motion, the live layout following the sheet's height. */
function frame(): void {
  act(() => frames.run(1))
  sheetLive = Number.parseFloat(sheet().style.height) || 0
}

/** The frame's boxes over `n` frames of motion, one entry per distinct box in the order seen. */
function boxesOver(n: number): { boxes: string[]; heights: Set<string> } {
  const boxes: string[] = []
  const heights = new Set<string>()
  for (let i = 0; i < n; i++) {
    frame()
    heights.add(sheet().style.height)
    const b = frameBox()
    if (boxes[boxes.length - 1] !== b) boxes.push(b)
  }
  return { boxes, heights }
}

const expanded = LAYER - SHEET_TOP_MARGIN
const collapsed = Math.round(LAYER * SHEET_PEEK_FRACTION)
const bodyAt = (detent: number): number => detent - GRIP - FOOTER - PADDING
const fitAt = (detent: number): string => {
  const scale = fitScale(capture, { bodyWidth: BODY_WIDTH, bodyHeight: bodyAt(detent) })
  return box(Math.round(capture.width * scale), Math.round(capture.height * scale))
}

const initialViewport = viewportStore.get()

beforeEach(() => {
  frames.install()
  sheetLive = 0
  stubLayout()
  viewportStore.set({ ...viewportStore.get(), coarse: true, hover: false, formFactor: 'phone' })
  uiStore.set({ longScreenshot: null, toasts: [], screenshotCards: [] })
  invoke.mockClear()
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  viewportStore.set(initialViewport)
  uiStore.set({ longScreenshot: null })
  vi.unstubAllGlobals()
  frames.now = 0
})

describe('the picture fitted to the sheet at rest, once per detent', () => {
  it('is fitted to the expanded detent before the sheet has risen, and holds through the rise', async () => {
    await open()
    // Before any frame the sheet stands below the screen; the fit is already the one for where
    // it is going – the body at the expanded detent – not the body's live (empty) height.
    expect(frameBox()).toBe(fitAt(expanded))
    // 3.4 screens of page at that scale: taller than the body, so the body scrolls the rest.
    const { boxes, heights } = boxesOver(90)
    // The sheet did rise, over many frames of changing height...
    expect(heights.size).toBeGreaterThan(20)
    expect(Number.parseFloat(sheet().style.height)).toBeCloseTo(expanded, 0)
    // ...and the picture's frame was one box throughout: no fit per frame, no zoom on the way up.
    expect(boxes).toEqual([fitAt(expanded)])
  })

  it('the live body height is not what the fit reads', async () => {
    await open()
    // Half way up the rise the body is far shorter than at rest; a fit to it would be smaller.
    boxesOver(6)
    const live = Number.parseFloat(sheet().style.height)
    expect(live).toBeGreaterThan(0)
    expect(live).toBeLessThan(expanded - 100)
    const toLive = fitScale(capture, { bodyWidth: BODY_WIDTH, bodyHeight: bodyAt(live) })
    const toRest = fitScale(capture, { bodyWidth: BODY_WIDTH, bodyHeight: bodyAt(expanded) })
    expect(toLive).toBeLessThan(toRest)
    expect(frameBox()).toBe(fitAt(expanded))
  })

  it('a collapse to the peek fits the picture once more, at the start of the motion, for the peek', async () => {
    await open()
    boxesOver(90)
    expect(frameBox()).toBe(fitAt(expanded))
    // The handle's tap: the sheet heads for the peek. The body hears of its box there at the
    // first frame of the motion – the picture is laid out for the peek and the sheet closes over it.
    act(() => q<HTMLButtonElement>('.zen-sheet-handle-hit')!.click())
    const { boxes, heights } = boxesOver(90)
    expect(heights.size).toBeGreaterThan(20)
    expect(Number.parseFloat(sheet().style.height)).toBeCloseTo(collapsed, 0)
    expect(boxes).toEqual([fitAt(collapsed)])
    expect(fitAt(collapsed)).not.toBe(fitAt(expanded))
    // And back up: one fit again, the expanded one.
    act(() => q<HTMLButtonElement>('.zen-sheet-handle-hit')!.click())
    expect(boxesOver(90).boxes).toEqual([fitAt(expanded)])
  })

  it('the fit itself: the body between the gutters, or the first screen with both bands in view, whichever is less', () => {
    // A phone body: the first screen (1366 picture px) with two 44 bands must fit the height.
    const phone = fitScale(capture, { bodyWidth: 360, bodyHeight: 700 })
    expect(phone).toBeCloseTo((700 - 88) / 1366, 6)
    // A wide, short body: the width between the 16 gutters is the limit.
    const wide = fitScale(capture, { bodyWidth: 200, bodyHeight: 5000 })
    expect(wide).toBeCloseTo((200 - 32) / 700, 6)
    // No height to speak of (before a real measure): the width decides, and never below 5 %.
    expect(fitScale(capture, { bodyWidth: 360, bodyHeight: 0 })).toBeCloseTo(328 / 700, 6)
    expect(fitScale(capture, { bodyWidth: 40, bodyHeight: 0 })).toBe(0.05)
  })

  it('Save is the primary in the chassis busy form: the label stays and names it while the host writes', async () => {
    await open()
    const save = q<HTMLButtonElement>('[data-testid="longshot-save"]')!
    expect(save.hasAttribute('data-primary')).toBe(true)
    expect(save.textContent).toBe('Save')
    expect(save.hasAttribute('aria-label')).toBe(false)
    act(() =>
      uiStore.set((s) => ({
        longScreenshot: s.longScreenshot && { ...s.longScreenshot, busy: true }
      }))
    )
    expect(save.getAttribute('aria-busy')).toBe('true')
    expect(save.textContent).toBe('Save')
    expect(save.querySelector('.zen-v2-spinner')).not.toBeNull()
  })
})
