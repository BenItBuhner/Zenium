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
 * remove the bookmark on the second tap), and the state's flip fills the star on the menu star's
 * own spring – the one `StarGlyph`, the one stylesheet rule – in parallel with what the command
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
  <PhoneBar state={state} edge="bottom" pill={pillHandlers} overviewOpen={false} pillLook="docked" />
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
const commands = (): unknown[][] => invoke.mock.calls.filter(([name]) => name.startsWith('bookmark.'))

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
    // The menu row's own glyph, at rest where the bookmark is: no fill, the filled star at .6.
    expect(star().querySelector('.zen-star-glyph')).not.toBeNull()
    expect(star().querySelector('.zen-star-glyph')!.getAttribute('data-filled')).toBe('false')
    expect(fillOpacity()).toBe(0)
    expect(fillScale()).toBeCloseTo(0.6)
    // The glyph is drawn, not named twice: nothing for a reader inside the button.
    expect(star().textContent).toBe('')

    act(() => root!.unmount())
    root = null
    // Opened on a bookmarked page: filled and at rest, with no motion of its own.
    render(bar(stateWith(true)))
    expect(star().getAttribute('aria-label')).toBe('Edit Bookmark')
    expect(star().hasAttribute('aria-pressed')).toBe(false)
    expect(star().querySelector('.zen-star-glyph')!.getAttribute('data-filled')).toBe('true')
    expect(fillOpacity()).toBe(1)
    expect(fillScale()).toBeCloseTo(1)
  })

  it('a press runs bookmark.star – never the toggle – and the state’s flip fills the star on one spring to the end, as the menu star does', () => {
    render(bar(stateWith(false)))
    click(star())
    expect(commands()).toEqual([['bookmark.star', { tabId: 't1' }]])
    // Nothing moves on the press itself: the fill is the state's, so the star never tells a
    // bookmark the core did not save. The core's push flips the tab and the fill sets off.
    expect(fillOpacity()).toBe(0)
    rerender(bar(stateWith(true)))
    expect(star().getAttribute('aria-label')).toBe('Edit Bookmark')
    expect(star().hasAttribute('aria-pressed')).toBe(false)
    const seen: number[] = [fillOpacity()]
    const scales: number[] = [fillScale()]
    for (let n = 0; n < 40 && frames.scheduled; n++) {
      frame()
      seen.push(fillOpacity())
      scales.push(fillScale())
    }
    const rest = seen.indexOf(1)
    expect(rest).toBeGreaterThan(0)
    expect(seen.slice(rest).every((o) => o === 1)).toBe(true)
    // One spring to the end, not a ramp and a cut (the menu row test's own bounds): every frame
    // climbs, no frame steps more than the spring's largest 16 ms step, the landing frame closes
    // less than a hundredth, and the motion takes the spring's time, not five frames.
    const path = seen.slice(0, rest + 1)
    const steps = path.slice(1).map((o, i) => o - path[i])
    expect(steps.every((step) => step > 0)).toBe(true)
    expect(Math.max(...steps)).toBeLessThan(0.2)
    expect(steps[steps.length - 1]).toBeLessThan(0.01)
    expect(path.length).toBeGreaterThanOrEqual(15)
    expect(scales[0]).toBeCloseTo(0.6)
    expect(scales[rest]).toBeCloseTo(1)
    for (let i = 1; i <= rest; i++) expect(scales[i]).toBeGreaterThanOrEqual(scales[i - 1])
    // The fill runs on transform and opacity alone (§11: nothing else per frame).
    const style = starFill().getAttribute('style') ?? ''
    expect(
      style
        .replace(/opacity:[^;]*;?/, '')
        .replace(/transform:[^;]*;?/, '')
        .trim()
    ).toBe('')
  })

  it('a press on a filled star runs bookmark.star again (the editor) and the star stays filled: no toggle, no removal', () => {
    render(bar(stateWith(true)))
    expect(fillOpacity()).toBe(1)
    click(star())
    frame()
    frame()
    expect(commands()).toEqual([['bookmark.star', { tabId: 't1' }]])
    expect(invoke.mock.calls.some(([name]) => name === 'bookmark.toggle')).toBe(false)
    expect(fillOpacity()).toBe(1)
    expect(star().getAttribute('aria-label')).toBe('Edit Bookmark')
    // The bookmark's removal is the editor's Remove, not a second tap: the tab still bookmarked
    // after the core's push, the star still filled and still Edit Bookmark.
    rerender(bar(stateWith(true)))
    expect(fillOpacity()).toBe(1)
    expect(star().getAttribute('aria-label')).toBe('Edit Bookmark')
  })

  it('under reduced motion the fill jumps to its end (§11.3)', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({ matches: query.includes('reduce') })
    })
    render(bar(stateWith(false)))
    expect(fillOpacity()).toBe(0)
    rerender(bar(stateWith(true)))
    expect(fillOpacity()).toBe(1)
    expect(fillScale()).toBeCloseTo(1)
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
