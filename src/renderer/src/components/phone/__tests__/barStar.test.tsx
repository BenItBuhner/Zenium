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
 * remove the bookmark on the second tap), and the state's flip pops the star (MOT-20: its scale
 * 1.0 → 1.2 → 1.0 on one spring struck once, the fill riding the return) on the menu star's own
 * spring – the one `StarGlyph`, the one stylesheet rule – in parallel with what the command
 * opened. Rendered for real in happy-dom with the frame loop cranked by hand.
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
const glyphScale = (): number =>
  parseFloat(/scale\(([\d.]+)\)/.exec(starGlyph().style.transform)![1])
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

/** The frames of a pop from the flip to the spring's rest: the glyph's scale and the fill's opacity. */
function popFrames(): { scales: number[]; opacities: number[] } {
  const scales: number[] = [glyphScale()]
  const opacities: number[] = [fillOpacity()]
  for (let n = 0; n < 60 && frames.scheduled; n++) {
    frame()
    scales.push(glyphScale())
    opacities.push(fillOpacity())
  }
  return { scales, opacities }
}

/**
 * The house pop, measured (MOT-20): the scale rises from 1 to its top of 1.2 in the spring's
 * first frames and settles back to exactly 1 over the spring's time (21 frames at 16 ms, not
 * five); no frame steps the scale further than the spring's largest 16 ms step (under a fifth);
 * the fill is still `from` at the top and follows the scale home, every frame climbing (or
 * falling) towards `to` by less than the same fifth, landing on the frame the scale does, the
 * landing frame closing only the rest threshold's remainder (`restDelta` .004 of the .2 pop).
 */
function expectPop(
  { scales, opacities }: { scales: number[]; opacities: number[] },
  from: number,
  to: number
): void {
  const rest = scales.length - 1
  expect(rest).toBeGreaterThanOrEqual(15)
  expect(scales[0]).toBe(1)
  expect(scales[rest]).toBe(1)
  const top = scales.indexOf(Math.max(...scales))
  expect(Math.max(...scales)).toBeCloseTo(1.2, 2)
  expect(top).toBeGreaterThan(1)
  expect(top).toBeLessThanOrEqual(4)
  for (let i = 1; i <= top; i++) expect(scales[i]).toBeGreaterThan(scales[i - 1])
  for (let i = top + 1; i <= rest; i++) expect(scales[i]).toBeLessThan(scales[i - 1])
  const scaleSteps = scales.slice(1).map((s, i) => Math.abs(s - scales[i]))
  expect(Math.max(...scaleSteps)).toBeLessThan(0.2)
  // The fill: `from` through the rise, `to` at the rest, one way between.
  for (let i = 0; i <= top; i++) expect(opacities[i]).toBe(from)
  expect(opacities[rest]).toBe(to)
  expect(opacities.indexOf(to)).toBe(rest)
  const way = Math.sign(to - from)
  const fillSteps = opacities.slice(top + 1).map((o, i) => (o - opacities[top + i]) * way)
  expect(fillSteps.every((step) => step > 0)).toBe(true)
  expect(Math.max(...fillSteps)).toBeLessThan(0.2)
  expect(fillSteps[fillSteps.length - 1]).toBeLessThan(0.03)
}

/** The pop writes the glyph's transform and the fill's opacity, nothing else (§11). */
function expectTransformAndOpacityOnly(): void {
  const glyphStyle = starGlyph().getAttribute('style') ?? ''
  expect(glyphStyle).toMatch(/transform/)
  expect(glyphStyle.replace(/transform:[^;]*;?/, '').trim()).toBe('')
  const fillStyle = starFill().getAttribute('style') ?? ''
  expect(fillStyle).toMatch(/opacity/)
  expect(fillStyle.replace(/opacity:[^;]*;?/, '').trim()).toBe('')
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

describe('the bar’s Bookmark star', () => {
  it('is outlined and named Bookmark on a page that is not bookmarked, filled and named Edit Bookmark on one that is – a stateful glyph, no aria-pressed', () => {
    render(bar(stateWith(false)))
    expect(star()).not.toBeNull()
    expect(star().getAttribute('aria-label')).toBe('Bookmark')
    expect(star().hasAttribute('aria-pressed')).toBe(false)
    // The menu row's own glyph, at rest where the bookmark is: no fill, the star at its size.
    expect(starGlyph()).not.toBeNull()
    expect(starGlyph().getAttribute('data-filled')).toBe('false')
    expect(fillOpacity()).toBe(0)
    expect(glyphScale()).toBe(1)
    expect(frames.scheduled).toBe(false)
    // The glyph is drawn, not named twice: nothing for a reader inside the button.
    expect(star().textContent).toBe('')

    act(() => root!.unmount())
    root = null
    // Opened on a bookmarked page: filled and at rest, with no motion of its own.
    render(bar(stateWith(true)))
    expect(star().getAttribute('aria-label')).toBe('Edit Bookmark')
    expect(star().hasAttribute('aria-pressed')).toBe(false)
    expect(starGlyph().getAttribute('data-filled')).toBe('true')
    expect(fillOpacity()).toBe(1)
    expect(glyphScale()).toBe(1)
    expect(frames.scheduled).toBe(false)
  })

  it('a press runs bookmark.star – never the toggle – and the state’s flip pops the star 1.0 → 1.2 → 1.0 on one spring, the fill riding the return, as the menu star does', () => {
    render(bar(stateWith(false)))
    click(star())
    expect(commands()).toEqual([['bookmark.star', { tabId: 't1' }]])
    // Nothing moves on the press itself: the pop is the state's, so the star never tells a
    // bookmark the core did not save. The core's push flips the tab and the pop sets off.
    expect(fillOpacity()).toBe(0)
    expect(glyphScale()).toBe(1)
    expect(frames.scheduled).toBe(false)
    rerender(bar(stateWith(true)))
    expect(star().getAttribute('aria-label')).toBe('Edit Bookmark')
    expect(star().hasAttribute('aria-pressed')).toBe(false)
    expect(frames.scheduled).toBe(true)
    const pop = popFrames()
    expectPop(pop, 0, 1)
    // The spring's own figures at 16 ms: the top on the third frame, at rest on the 21st.
    expect(pop.scales.indexOf(Math.max(...pop.scales))).toBe(3)
    expect(pop.scales.length - 1).toBe(21)
    expectTransformAndOpacityOnly()
    // At rest the loop is off the books: nothing runs on a star that is not changing.
    expect(frames.scheduled).toBe(false)
  })

  it('the bookmark’s removal pops the star the same way, the fill draining as it settles', () => {
    render(bar(stateWith(true)))
    expect(fillOpacity()).toBe(1)
    rerender(bar(stateWith(false)))
    expect(star().getAttribute('aria-label')).toBe('Bookmark')
    expectPop(popFrames(), 1, 0)
    expectTransformAndOpacityOnly()
  })

  it('a change of mind mid-pop strikes the same spring again from where it is: no jump in the scale, the fill carrying on from its own', () => {
    render(bar(stateWith(false)))
    rerender(bar(stateWith(true)))
    for (let i = 0; i < 8; i++) frame()
    const scaleBefore = glyphScale()
    const opacityBefore = fillOpacity()
    expect(scaleBefore).toBeGreaterThan(1.05)
    expect(opacityBefore).toBeGreaterThan(0.3)
    expect(opacityBefore).toBeLessThan(0.7)
    // The bookmark is gone again (the editor's Remove) while the star is still settling.
    rerender(bar(stateWith(false)))
    expect(glyphScale()).toBe(scaleBefore)
    expect(fillOpacity()).toBe(opacityBefore)
    const scales: number[] = [glyphScale()]
    const opacities: number[] = [fillOpacity()]
    for (let n = 0; n < 60 && frames.scheduled; n++) {
      frame()
      scales.push(glyphScale())
      opacities.push(fillOpacity())
    }
    const steps = scales.slice(1).map((s, i) => Math.abs(s - scales[i]))
    expect(Math.max(...steps)).toBeLessThan(0.2)
    // A second impulse on a star already out: the pop rises again from where it stood, past its
    // usual top but never past a third, and comes home to 1.
    expect(Math.max(...scales)).toBeGreaterThan(scaleBefore)
    expect(Math.max(...scales)).toBeLessThan(1.34)
    expect(scales[scales.length - 1]).toBe(1)
    expect(scales.length - 1).toBeGreaterThanOrEqual(15)
    // The fill: where it was through the rise, then down to nothing with the return, one way.
    const top = scales.indexOf(Math.max(...scales))
    for (let i = 0; i <= top; i++) expect(opacities[i]).toBe(opacityBefore)
    const fillSteps = opacities.slice(top + 1).map((o, i) => opacities[top + i] - o)
    expect(fillSteps.every((step) => step > 0)).toBe(true)
    expect(Math.max(...fillSteps)).toBeLessThan(0.2)
    expect(opacities[opacities.length - 1]).toBe(0)
    expect(frames.scheduled).toBe(false)
  })

  it('a press on a filled star runs bookmark.star again (the editor) and the star stays filled: no toggle, no removal, no motion', () => {
    render(bar(stateWith(true)))
    expect(fillOpacity()).toBe(1)
    click(star())
    frame()
    frame()
    expect(commands()).toEqual([['bookmark.star', { tabId: 't1' }]])
    expect(invoke.mock.calls.some(([name]) => name === 'bookmark.toggle')).toBe(false)
    expect(fillOpacity()).toBe(1)
    expect(glyphScale()).toBe(1)
    expect(star().getAttribute('aria-label')).toBe('Edit Bookmark')
    // The bookmark's removal is the editor's Remove, not a second tap: the tab still bookmarked
    // after the core's push, the star still filled and still Edit Bookmark, and nothing pops.
    rerender(bar(stateWith(true)))
    expect(fillOpacity()).toBe(1)
    expect(glyphScale()).toBe(1)
    expect(frames.scheduled).toBe(false)
    expect(star().getAttribute('aria-label')).toBe('Edit Bookmark')
  })

  it('under reduced motion the pop is a cut: the star fills at its size, no frame runs (§11.3)', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({ matches: query.includes('reduce') })
    })
    render(bar(stateWith(false)))
    expect(fillOpacity()).toBe(0)
    rerender(bar(stateWith(true)))
    expect(fillOpacity()).toBe(1)
    expect(glyphScale()).toBe(1)
    expect(frames.scheduled).toBe(false)
    rerender(bar(stateWith(false)))
    expect(fillOpacity()).toBe(0)
    expect(glyphScale()).toBe(1)
    expect(frames.scheduled).toBe(false)
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
