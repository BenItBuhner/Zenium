// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Space, Tab, UIState } from '@shared/types'
import type { PillGestureHandlers } from '../usePillGestures'

/*
 * The bar's optional Bookmark (the lead's ruling on #236, for the bar's star as for the menu's):
 * a stateful glyph on `bookmark.star`, not a toggle. Outlined and named "Bookmark" on a page that
 * is not bookmarked, filled and named "Edit Bookmark" once it is, no `aria-pressed`; a press runs
 * `bookmark.star` (the core saves and opens the edit flow; never `bookmark.toggle`, which would
 * remove the bookmark on the second tap), and the state's flip fills the star in place on the
 * menu star's own spring – the one `StarGlyph`, the one stylesheet rule – emptying on the same
 * spring, never a scale pop (design language v2 §11: a glyph's change of state is not an
 * arrival; MOT-20's ruling – Chrome 152 itself fills as a cut), in parallel with what the command
 * opened. Rendered for real in happy-dom with the frame loop cranked by hand, and the fill's
 * frames PINNED: the spring's own figures at 16 ms, so a change to the spring, its thresholds or
 * the glyph's paint shows up here as numbers and not as a feel.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

  get scheduled(): boolean {
    return this.queue.size > 0
  }
}

const frames = new Frames()
const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { PhoneBar } = await import('../PhoneShell')

const tab: Tab = {
  id: 't1',
  spaceId: 'space',
  containerId: 'default',
  url: 'https://example.com/',
  title: 'Example',
  favicon: null,
  pinned: false,
  essential: false,
  pinnedUrl: null,
  customTitle: null,
  customIcon: null,
  windowId: null,
  folderId: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  audible: false,
  muted: false,
  discarded: false,
  frozen: false,
  cpuThrottle: 1,
  zoom: 1,
  splitGroupId: null,
  createdAt: 0,
  lastActiveAt: 0,
  errorCode: null,
  bookmarked: false,
  readerable: false,
  blockedCount: 0
} as Tab

const space: Space = {
  id: 'space',
  name: 'Work',
  icon: '',
  containerId: 'default',
  theme: null,
  tabIds: ['t1'],
  activeTabId: 't1',
  pinnedCollapsed: false
}

/** The bar with the star beside the menu, on a page that is or is not bookmarked. */
function stateWith(bookmarked: boolean): UIState {
  return {
    platform: 'android',
    capabilities: { windowControls: false },
    tabs: { t1: { ...tab, bookmarked } },
    spaces: [space],
    activeSpaceId: 'space',
    essentialTabIds: [],
    folders: [],
    settings: {
      ...DEFAULT_SETTINGS,
      phoneBarPosition: 'bottom',
      phoneBar: { left: ['back'], right: ['bookmark', 'menu'] }
    },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: [],
    translate: { available: true, tabs: {} }
  } as unknown as UIState
}

let root: Root | null = null
let mount: HTMLElement | null = null
const pillHandlers = {} as PillGestureHandlers

const bar = (state: UIState): ReactElement => (
  <PhoneBar
    state={state}
    edge="bottom"
    pill={pillHandlers}
    overviewOpen={false}
    pillLook="docked"
  />
)

function render(el: ReactElement): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
}

/** The core's state push after a command: the same bar, the tab's bookmark flipped. */
function rerender(el: ReactElement): void {
  act(() => root!.render(el))
}

const star = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('.zen-phone-bar [data-bar-item="bookmark"]')!
const starGlyph = (): HTMLElement => star().querySelector<HTMLElement>('.zen-star-glyph')!
const starFill = (): HTMLElement => star().querySelector<HTMLElement>('.zen-star-glyph-fill')!
const fillOpacity = (): number => Number(starFill().style.opacity)
const fillScale = (): number => parseFloat(/scale\(([\d.]+)\)/.exec(starFill().style.transform)![1])
const click = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
const frame = (): void => {
  act(() => frames.run(1))
}
const commands = (): unknown[][] =>
  invoke.mock.calls.filter(([name]) => name.startsWith('bookmark.'))

/**
 * The fill's frames from the flip to the spring's rest at 16 ms a frame: the fill's opacity and
 * its scale, frame 0 the state before the first frame runs.
 */
function fillFrames(): { opacities: number[]; scales: number[] } {
  const opacities: number[] = [fillOpacity()]
  const scales: number[] = [fillScale()]
  for (let n = 0; n < 60 && frames.scheduled; n++) {
    frame()
    opacities.push(fillOpacity())
    scales.push(fillScale())
  }
  return { opacities, scales }
}

/** The fill's largest step in one 16 ms frame: the spring's own (.121 on `SPRING_FILL`), under a fifth. */
const FIFTH = 0.2
/** v1 §7's cap on a fixed-duration transition, 300 ms: the frame the fill has to be as good as done by. */
const CAP_FRAME = Math.floor(300 / 16)

/**
 * The house fill, PINNED (MOT-20): one `SPRING_FILL` from `from` to `to`, run to the rest its
 * thresholds set (`restDelta` .004, `restSpeed` .08 on the unit's scale) – 23 frames at 16 ms,
 * 368 ms, the spring's own figure and not a five-frame ramp; every frame moves one way; no frame
 * steps the opacity further than the spring's largest 16 ms step (.121, under the fifth – a
 * bigger step is the px-scaled thresholds snapping the motion to its end); the landing frame
 * closes only the threshold's remainder (under a hundredth); and within v1 §7's 300 ms cap
 * (frame 18) the fill is within two hundredths of its end – the tail past it is the thresholds'
 * hair, not motion the eye reads. The filled star's scale rides the same value, .6 + .4 · x, so
 * its steps are two fifths of the opacity's. Reduced motion is the cut (§11.3), tested apart.
 */
function expectFill(
  { opacities, scales }: { opacities: number[]; scales: number[] },
  from: number,
  to: number
): void {
  const rest = opacities.length - 1
  expect(opacities[0]).toBe(from)
  expect(opacities[rest]).toBe(to)
  expect(opacities.indexOf(to)).toBe(rest)
  expect(rest).toBe(23)
  const way = Math.sign(to - from)
  const steps = opacities.slice(1).map((o, i) => (o - opacities[i]) * way)
  expect(steps.every((step) => step > 0)).toBe(true)
  expect(Math.max(...steps)).toBeLessThan(FIFTH)
  expect(Math.max(...steps)).toBeCloseTo(0.121, 2)
  expect(steps[steps.length - 1]).toBeLessThan(0.01)
  expect(Math.abs(opacities[CAP_FRAME] - to)).toBeLessThan(0.02)
  expect(scales[0]).toBeCloseTo(0.6 + 0.4 * from, 6)
  expect(scales[rest]).toBeCloseTo(0.6 + 0.4 * to, 6)
  const scaleSteps = scales.slice(1).map((s, i) => (s - scales[i]) * way)
  expect(scaleSteps.every((step) => step > 0)).toBe(true)
  expect(Math.max(...scaleSteps)).toBeLessThan(FIFTH * 0.4)
}

/** The fill writes the filled star's opacity and transform, nothing else (§11); the glyph itself holds still. */
function expectOpacityAndTransformOnly(): void {
  const fillStyle = starFill().getAttribute('style') ?? ''
  expect(fillStyle).toMatch(/opacity/)
  expect(fillStyle).toMatch(/transform/)
  expect(
    fillStyle
      .replace(/opacity:[^;]*;?/, '')
      .replace(/transform:[^;]*;?/, '')
      .trim()
  ).toBe('')
  // No pop: the glyph around the two stars is never scaled – it has no inline style at all.
  expect(starGlyph().getAttribute('style')).toBeNull()
}

beforeEach(() => {
  frames.install()
  invoke.mockClear()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  vi.unstubAllGlobals()
  delete (window as { matchMedia?: unknown }).matchMedia
  frames.now = 0
})

/**
 * Mounts the bar and settles the glyph's opening: `StarGlyph` paints its rest state in a layout
 * effect and books one frame that rests on the spot (the spring started at its destination), so
 * the star opens at rest where the bookmark is, with no motion of its own – the one frame moves
 * nothing and asks for no next one.
 */
function mountBar(bookmarked: boolean): void {
  render(bar(stateWith(bookmarked)))
  const opening = fillOpacity()
  expect(frames.scheduled).toBe(true)
  frame()
  expect(fillOpacity()).toBe(opening)
  expect(frames.scheduled).toBe(false)
}

describe('the bar’s Bookmark star', () => {
  it('is outlined and named Bookmark on a page that is not bookmarked, filled and named Edit Bookmark on one that is – a stateful glyph, no aria-pressed', () => {
    mountBar(false)
    expect(star()).not.toBeNull()
    expect(star().getAttribute('aria-label')).toBe('Bookmark')
    expect(star().hasAttribute('aria-pressed')).toBe(false)
    // The one `StarGlyph`, at rest where the bookmark is: the filled star at nothing and at the
    // small end of its scale, the glyph around the two stars untouched.
    expect(starGlyph()).not.toBeNull()
    expect(starGlyph().getAttribute('data-filled')).toBe('false')
    expect(fillOpacity()).toBe(0)
    expect(fillScale()).toBeCloseTo(0.6, 6)
    expect(starGlyph().getAttribute('style')).toBeNull()
    // The glyph is drawn, not named twice: nothing for a reader inside the button.
    expect(star().textContent).toBe('')

    act(() => root!.unmount())
    root = null
    // Opened on a bookmarked page: filled and at rest, with no motion of its own.
    mountBar(true)
    expect(star().getAttribute('aria-label')).toBe('Edit Bookmark')
    expect(star().hasAttribute('aria-pressed')).toBe(false)
    expect(starGlyph().getAttribute('data-filled')).toBe('true')
    expect(fillOpacity()).toBe(1)
    expect(fillScale()).toBe(1)
  })

  it('a press runs bookmark.star – never the toggle – and the state’s flip fills the star in place on the one spring, the frames the spring’s own (MOT-20)', () => {
    mountBar(false)
    click(star())
    expect(commands()).toEqual([['bookmark.star', { tabId: 't1' }]])
    // Nothing moves on the press itself: the fill is the state's, so the star never tells a
    // bookmark the core did not save. The core's push flips the tab and the fill sets off.
    expect(fillOpacity()).toBe(0)
    expect(fillScale()).toBeCloseTo(0.6, 6)
    expect(frames.scheduled).toBe(false)
    rerender(bar(stateWith(true)))
    expect(star().getAttribute('aria-label')).toBe('Edit Bookmark')
    expect(star().hasAttribute('aria-pressed')).toBe(false)
    expect(frames.scheduled).toBe(true)
    expectFill(fillFrames(), 0, 1)
    expectOpacityAndTransformOnly()
    // At rest the loop is off the books: nothing runs on a star that is not changing.
    expect(frames.scheduled).toBe(false)
  })

  it('the bookmark’s removal empties the star on the same spring, the same frames the other way', () => {
    mountBar(true)
    rerender(bar(stateWith(false)))
    expect(star().getAttribute('aria-label')).toBe('Bookmark')
    expect(frames.scheduled).toBe(true)
    expectFill(fillFrames(), 1, 0)
    expectOpacityAndTransformOnly()
    expect(frames.scheduled).toBe(false)
  })

  it('a change of mind mid-fill retargets the same spring from where it is: no jump, one frame of carry, then one way down to nothing', () => {
    mountBar(false)
    rerender(bar(stateWith(true)))
    for (let i = 0; i < 8; i++) frame()
    const opacityBefore = fillOpacity()
    const scaleBefore = fillScale()
    // Eight frames in the fill is three quarters of the way (.748 on `SPRING_FILL`).
    expect(opacityBefore).toBeGreaterThan(0.7)
    expect(opacityBefore).toBeLessThan(0.8)
    // The bookmark is gone again (the editor's Remove) while the star is still filling: the
    // spring's destination changes, its motion does not – nothing is painted on the retarget.
    rerender(bar(stateWith(false)))
    expect(star().getAttribute('aria-label')).toBe('Bookmark')
    expect(fillOpacity()).toBe(opacityBefore)
    expect(fillScale()).toBe(scaleBefore)
    const { opacities, scales } = fillFrames()
    const rest = opacities.length - 1
    // The velocity it had carries it on for one frame – by less than two hundredths – and from
    // there every frame falls, none by more than the spring's largest step, to exactly nothing,
    // in the spring's own time from the turn (22 frames at 16 ms).
    expect(opacities[1]).toBeGreaterThan(opacityBefore)
    expect(opacities[1] - opacityBefore).toBeLessThan(0.02)
    const fall = opacities.slice(1)
    const steps = fall.slice(1).map((o, i) => fall[i] - o)
    expect(steps.every((step) => step > 0)).toBe(true)
    expect(Math.max(...steps)).toBeLessThan(FIFTH)
    expect(opacities[rest]).toBe(0)
    expect(opacities.indexOf(0)).toBe(rest)
    expect(rest).toBe(22)
    // The scale rides the same value the whole way: no pop, no second spring.
    for (let i = 0; i <= rest; i++) expect(scales[i]).toBeCloseTo(0.6 + 0.4 * opacities[i], 6)
    expect(frames.scheduled).toBe(false)
  })

  it('a press on a filled star runs bookmark.star again (the editor) and the star stays filled: no toggle, no removal, no motion', () => {
    mountBar(true)
    expect(fillOpacity()).toBe(1)
    click(star())
    expect(frames.scheduled).toBe(false)
    frame()
    frame()
    expect(commands()).toEqual([['bookmark.star', { tabId: 't1' }]])
    expect(invoke.mock.calls.some(([name]) => name === 'bookmark.toggle')).toBe(false)
    expect(fillOpacity()).toBe(1)
    expect(fillScale()).toBe(1)
    expect(star().getAttribute('aria-label')).toBe('Edit Bookmark')
    // The bookmark's removal is the editor's Remove, not a second tap: the tab still bookmarked
    // after the core's push, the star still filled and still Edit Bookmark, and nothing moves.
    rerender(bar(stateWith(true)))
    expect(fillOpacity()).toBe(1)
    expect(fillScale()).toBe(1)
    expect(frames.scheduled).toBe(false)
    expect(star().getAttribute('aria-label')).toBe('Edit Bookmark')
  })

  it('under reduced motion the fill is a cut, both ways: the star fills or empties at its end, no frame runs (§11.3)', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({ matches: query.includes('reduce') })
    })
    // The opening too jumps to its rest: not even the one settling frame.
    render(bar(stateWith(false)))
    expect(fillOpacity()).toBe(0)
    expect(frames.scheduled).toBe(false)
    rerender(bar(stateWith(true)))
    expect(fillOpacity()).toBe(1)
    expect(fillScale()).toBe(1)
    expect(frames.scheduled).toBe(false)
    rerender(bar(stateWith(false)))
    expect(fillOpacity()).toBe(0)
    expect(fillScale()).toBeCloseTo(0.6, 6)
    expect(frames.scheduled).toBe(false)
    expectOpacityAndTransformOnly()
  })

  it('is dimmed with nothing to save on a page that is not a web page, and does nothing pressed there', () => {
    const state = stateWith(false)
    ;(state.tabs as Record<string, Tab>).t1 = { ...tab, url: 'about:blank' }
    render(bar(state))
    expect(star().hasAttribute('data-disabled')).toBe(true)
    click(star())
    expect(commands()).toEqual([])
  })

  it('draws the one star: the stylesheet sizes the shared glyph’s stars from the icon token, so the bar needs no second rule', () => {
    const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')
    const glyph = /\.zen-star-glyph \{([^}]*)\}/.exec(css)![1]
    expect(glyph).toContain('width: var(--v2-icon)')
    expect(glyph).toContain('height: var(--v2-icon)')
    const svg = /\.zen-star-glyph svg \{([^}]*)\}/.exec(css)![1]
    expect(svg).toContain('width: var(--v2-icon)')
    expect(svg).toContain('height: var(--v2-icon)')
    // One implementation: no star rule of the menu's own is left behind.
    expect(css).not.toContain('.zen-menu-star')
  })
})
