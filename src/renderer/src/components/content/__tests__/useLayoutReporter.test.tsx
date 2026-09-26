// @vitest-environment happy-dom
import { act, useRef, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Rect, Space, Tab, UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { landingStore } from '@renderer/lib/fullscreenLanding'
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

  /*
   * A page's element in fullscreen (MOT-32): the chrome stays mounted under the host's
   * fullscreen layer, so the reporter is mounted too – and reports nothing meanwhile: the core
   * lays the fullscreen view over the window itself and keeps the layout from before the
   * fullscreen to put the page back by. The first layout after the exit is reported whatever
   * the last one said: the return fade waits on that report's placement (lib/fullscreenLanding.ts).
   */
  const fullscreen = (s: UIState, tabId: string | null): UIState =>
    ({ ...s, window: { ...s.window, htmlFullscreenTabId: tabId } }) as UIState
  const reports = (): number =>
    vi.mocked(run).mock.calls.filter(([c]) => c === 'layout.report').length

  it('reports no layout while a page is fullscreen, and the first one after it even when nothing changed', () => {
    vi.mocked(run).mockClear()
    landingStore.set({ settling: undefined, placed: new Map(), sized: new Map(), reports: 0 })
    const { rerender } = render(<Probe state={state('bottom')} />)
    expect(reports()).toBe(1)
    const noted = landingStore.get().reports
    expect(noted).toBeGreaterThan(0)
    // The fullscreen: whatever the chrome lays out under the layer is no placement.
    rerender(<Probe state={fullscreen(state('bottom'), 't1')} />)
    act(() => frames.splice(0).forEach((f) => f()))
    expect(reports()).toBe(1)
    expect(landingStore.get().reports).toBe(noted)
    // The exit: the layout is the one from before, and it is reported – and noted for the
    // landing – all the same.
    rerender(<Probe state={fullscreen(state('bottom'), null)} />)
    expect(reports()).toBe(2)
    expect(landingStore.get().reports).toBe(noted + 1)
    const [, first] = vi.mocked(run).mock.calls.filter(([c]) => c === 'layout.report')[0]!
    const [, after] = vi.mocked(run).mock.calls.filter(([c]) => c === 'layout.report')[1]!
    expect(after).toEqual(first)
    // Out of fullscreen an unchanged layout is not reported twice.
    rerender(<Probe state={fullscreen(state('bottom'), null)} />)
    expect(reports()).toBe(2)
  })

  /*
   * "Hold ⌘Q to quit" over a hung page (session-08; the design lead's C4 on #486): the view
   * gives way to its picture for the hold (`lib/quitHoldCover.ts` sets `quitHoldCover`), so the
   * chrome's twin of the notice is seen over a frame the hung renderer keeps painted – the host
   * hears it as `contentHidden`, the same word the "Page unresponsive" prompt hides the view by.
   */
  const lastReport = (): { contentHidden: boolean } =>
    vi
      .mocked(run)
      .mock.calls.filter(([c]) => c === 'layout.report')
      .at(-1)![1] as {
      contentHidden: boolean
    }

  it('the hold’s cover over a hung page reports the views hidden, and their return with its close', () => {
    vi.mocked(run).mockClear()
    const desktop = { ...state('bottom'), platform: 'linux' } as UIState
    const { rerender } = render(<Probe state={desktop} />)
    expect(lastReport().contentHidden).toBe(false)
    // A hold begins over the hung page: the cover stands (no picture to wait for here, so the
    // hide is at once).
    uiStore.set({ quitHoldCover: true })
    rerender(<Probe state={{ ...desktop }} />)
    expect(lastReport().contentHidden).toBe(true)
    // The key is released: the cover goes and the live view comes back.
    uiStore.set({ quitHoldCover: false })
    rerender(<Probe state={{ ...desktop }} />)
    expect(lastReport().contentHidden).toBe(false)
  })

  /*
   * The first-run tour stands opaque over the whole window, and the page views composite above
   * the chrome: the New Tab's view the window has from creation (#490) stood over the tour's
   * panel once the bar stopped opening under the tour (#347) and its cover no longer hid the
   * page. The tour reports the views hidden for as long as it stands (`firstRunCovers`; nothing
   * to wait for – no picture is taken), and its end brings them back with the layout that follows.
   */
  const firstRun = (done: boolean, kind = 'synced'): UIState =>
    ({
      ...state('bottom'),
      platform: 'linux',
      settings: { ...DEFAULT_SETTINGS, onboardingDone: done },
      window: { kind, chrome: 'full', fullscreen: false, htmlFullscreenTabId: null }
    }) as unknown as UIState

  it('the tour reports the views hidden until it ends, and their return with its end', () => {
    vi.mocked(run).mockClear()
    const { rerender } = render(<Probe state={firstRun(false)} />)
    expect(lastReport().contentHidden).toBe(true)
    // The tour's last click: the views come back with the layout that follows.
    rerender(<Probe state={firstRun(true)} />)
    expect(lastReport().contentHidden).toBe(false)
  })

  it('a window that never shows the tour (a blank or private one) reports its views as before', () => {
    vi.mocked(run).mockClear()
    render(<Probe state={firstRun(false, 'normal')} />)
    expect(lastReport().contentHidden).toBe(false)
  })
})
