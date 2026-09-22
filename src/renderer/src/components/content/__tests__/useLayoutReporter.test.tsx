// @vitest-environment happy-dom
import { act, useRef, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Rect, Space, Tab, UIState } from '@shared/types'
import { registerRecedeLayer, recedeScale, type RecedeHandle } from '@renderer/lib/motion/recede'
import { contentAreaStore, uiStore } from '@renderer/lib/ui'
import { useLayoutReporter } from '../useLayoutReporter'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

/*
 * The layout reporter under the recede (v2 §11.1; PERF-4's audit, finding 2). A setting written
 * while a sheet is up – the bar-position picker – has the reporter measure the viewport while
 * the content frame stands at `scale(.97)`; `getBoundingClientRect()` read through that scale
 * laid the page out 20 to 24 CSS px short until the next hide or return, and every bar-hide run's
 * growth claims flaked on the stale `page 783 vs 805`. Two things put it right: the measure is
 * the frame's LAYOUT box (the painted one run back through the frame's computed transform), and
 * the frame is measured once more the moment the recede returns to 0.
 */

const tab = {
  id: 't1',
  spaceId: 'space',
  containerId: 'default',
  url: 'https://example.com/long',
  title: 'Example',
  loading: false
} as unknown as Tab

const space = {
  id: 'space',
  name: 'Work',
  containerId: 'default',
  tabIds: ['t1'],
  activeTabId: 't1'
} as unknown as Space

function state(edge: 'top' | 'bottom'): UIState {
  return {
    platform: 'android',
    tabs: { t1: tab },
    spaces: [space],
    activeSpaceId: 'space',
    essentialTabIds: [],
    folders: [],
    splitGroups: {},
    sidePanel: null,
    glance: null,
    settings: { ...DEFAULT_SETTINGS, phoneBarPosition: edge },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null }
  } as unknown as UIState
}

/** The phone's content frame with the bar at the bottom edge, and the viewport under a 3 px load bar. */
const frameBox: Rect = { x: 8, y: 80, width: 396, height: 715 }
const viewportBox: Rect = { x: 8, y: 83, width: 396, height: 712 }
const centre = { x: frameBox.width / 2, y: frameBox.height / 2 }

/** `rect` as the frame's scale `s` about its centre paints it. */
function paint(rect: Rect, s: number): Rect {
  const ox = frameBox.x + centre.x
  const oy = frameBox.y + centre.y
  return {
    x: ox + (rect.x - ox) * s,
    y: oy + (rect.y - oy) * s,
    width: rect.width * s,
    height: rect.height * s
  }
}

/** What the DOM reports this frame: the painted boxes, and the frame's computed transform. */
const painted = { frame: frameBox, viewport: viewportBox, transform: 'none' }

/** Paint the frame at recede `p` – with, or (a transform the frame does not know of) without, saying so. */
function recedeTo(p: number, declared = true): void {
  const s = recedeScale(p)
  painted.frame = paint(frameBox, s)
  painted.viewport = paint(viewportBox, s)
  painted.transform = declared && s !== 1 ? `matrix(${s}, 0, 0, ${s}, 0, 0)` : 'none'
}

function Probe({ state }: { state: UIState }): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const sidePanelRef = useRef<HTMLDivElement>(null)
  useLayoutReporter(viewportRef, frameRef, sidePanelRef, state, uiStore.get(), false)
  return (
    <div ref={frameRef} data-frame>
      <div>
        <div ref={viewportRef} data-viewport />
      </div>
    </div>
  )
}

const area = (): Rect | null => contentAreaStore.get().area

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): { rerender: (next: ReactElement) => void; unmount: () => void } {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
  return {
    rerender: (next) => act(() => root!.render(next)),
    unmount: () => cleanup()
  }
}

function cleanup(): void {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
}

function close(actual: Rect | null, expected: Rect): void {
  expect(actual).not.toBeNull()
  expect(actual!.x).toBeCloseTo(expected.x, 6)
  expect(actual!.y).toBeCloseTo(expected.y, 6)
  expect(actual!.width).toBeCloseTo(expected.width, 6)
  expect(actual!.height).toBeCloseTo(expected.height, 6)
}

describe('useLayoutReporter under the recede', () => {
  const handles: RecedeHandle[] = []
  let frames: Array<() => void>

  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    // happy-dom has no ResizeObserver; the transform is not a resize, so none is needed here.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn()
        disconnect = vi.fn()
        unobserve = vi.fn()
      }
    )
    recedeTo(0)
    const rect = (r: Rect): DOMRect =>
      ({
        left: r.x,
        top: r.y,
        width: r.width,
        height: r.height,
        right: r.x + r.width,
        bottom: r.y + r.height,
        x: r.x,
        y: r.y
      }) as DOMRect
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      if (this.hasAttribute('data-frame')) return rect(painted.frame)
      if (this.hasAttribute('data-viewport')) return rect(painted.viewport)
      return rect({ x: 0, y: 0, width: 0, height: 0 })
    })
    const computed = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) =>
      el.hasAttribute('data-frame')
        ? ({
            transform: painted.transform,
            transformOrigin: `${centre.x}px ${centre.y}px`
          } as unknown as CSSStyleDeclaration)
        : computed(el)
    )
    contentAreaStore.set({ area: null })
  })

  afterEach(() => {
    for (const h of handles.splice(0)) h.release()
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    contentAreaStore.set({ area: null })
  })

  const sheetUp = (): RecedeHandle => {
    const h = registerRecedeLayer()
    handles.push(h)
    act(() => {
      h.progress(1)
      recedeTo(1)
    })
    return h
  }

  it('measures the layout box at rest', () => {
    render(<Probe state={state('bottom')} />)
    close(area(), viewportBox)
    act(() => frames.splice(0).forEach((f) => f()))
    act(() => frames.splice(0).forEach((f) => f()))
    close(area(), viewportBox)
  })

  it('a setting written with a sheet up (the bar-position picker) measures through the receded frame and still reports the layout box', () => {
    const { rerender } = render(<Probe state={state('bottom')} />)
    close(area(), viewportBox)
    const h = sheetUp()
    // What the DOM paints: 3 percent short, the frame's 21 px – PERF-4's `page 783 vs 805`.
    expect(viewportBox.height - painted.viewport.height).toBeGreaterThan(20)
    // The picker writes the bar to the top edge: the reporter measures again, the sheet still up.
    rerender(<Probe state={state('top')} />)
    close(area(), viewportBox)
    act(() => frames.splice(0).forEach((f) => f()))
    close(area(), viewportBox)
    // To the bit, not within ε: the run-back answers on the layout grid, so the re-measure at
    // the recede's rest finds the same rect and reports nothing more – the store keeps the very
    // object (an ε-different answer would cost one more `layout.report`, and the host a 1 px
    // relayout, at the rest).
    const under = area()
    expect(under).toEqual(viewportBox)
    act(() => {
      recedeTo(0)
      h.progress(0)
    })
    expect(area()).toBe(under)
  })

  it('measures once more the moment the recede returns to 0: a measure that missed a transform is put right at the rest', () => {
    const { rerender } = render(<Probe state={state('bottom')} />)
    const h = registerRecedeLayer()
    handles.push(h)
    // A scale the frame does not declare (the case the transform read cannot see): the painted
    // box is all the measure has while the sheet is up.
    act(() => {
      h.progress(1)
      recedeTo(1, false)
    })
    rerender(<Probe state={state('top')} />)
    close(area(), paint(viewportBox, recedeScale(1)))
    // The sheet on its way down: nothing measures at .5.
    act(() => {
      recedeTo(0.5, false)
      h.progress(0.5)
    })
    close(area(), paint(viewportBox, recedeScale(1)))
    // Landed: the frame is measured again at its rest, and the page has its whole height back.
    act(() => {
      recedeTo(0)
      h.progress(0)
    })
    close(area(), viewportBox)
  })

  it('the rest re-measure stops with the hook', () => {
    const { unmount } = render(<Probe state={state('bottom')} />)
    unmount()
    contentAreaStore.set({ area: null })
    const h = registerRecedeLayer()
    handles.push(h)
    act(() => {
      h.progress(1)
      h.progress(0)
    })
    expect(area()).toBeNull()
  })
})
