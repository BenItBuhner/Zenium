// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MenuDescriptor, MenuGlyph, MenuItemDescriptor } from '@shared/types'
import { MenuSheet } from '../MenuSheet'
import { viewportStore } from '@renderer/lib/formFactor'
import { isIconRow } from '@renderer/lib/menuIconRow'
import { SheetPresence } from '@renderer/lib/motion/presence'
import { uiStore } from '@renderer/lib/ui'

/*
 * The phone app menu's icon row (matrix TB-08, TB-16), rendered for real in happy-dom: a group
 * whose items all name a glyph is drawn as Chrome's row of five icon buttons – the shared
 * `.zen-v2-icon-button` (design language v2 §9.3), each a real button named by its label
 * (§9.22), disabled where the core said so (§9.30) – ahead of the rows of text; the star's fill
 * runs on one spring (§11) as the sheet leaves, jumps under reduced motion, and opens at rest
 * where the bookmark is; a press on any button slides the sheet away and then picks the item, as
 * a text row's does. The frame loop is cranked by hand and the layout given sizes (happy-dom
 * lays nothing out).
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
let root: Root | null = null
let mount: HTMLElement | null = null
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => undefined)

function render(el: ReactElement): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
}

/** Let the wait for the page's cover resolve (at once with no page) and the sheet come up. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

const frame = (): void => {
  act(() => frames.run(1))
}

/** Run every scheduled frame to quiet (the sheet's slide, the fill's spring, the pick's wait). */
function runAll(max = 200): number {
  let n = 0
  for (; n < max && frames.scheduled; n++) frame()
  return n
}

// --- the menu ---------------------------------------------------------------------------------

function item(
  id: string,
  label: string,
  patch: Partial<MenuItemDescriptor> & { glyph?: MenuGlyph } = {}
): MenuItemDescriptor {
  return { id, type: 'normal', label, enabled: true, checked: false, submenu: null, ...patch }
}

/** The phone app menu as the core serialises it: the row, a separator, then rows of text. */
function appMenu(
  patch: {
    forward?: boolean
    bookmarked?: boolean
    loading?: boolean
    pageInfo?: boolean
  } = {}
): MenuDescriptor {
  return {
    id: 'menu_1',
    source: 'app',
    x: null,
    y: null,
    items: [
      item('menu_1_1', 'Forward', { glyph: 'forward', enabled: patch.forward ?? false }),
      // The star is a plain item whose `checked` is the fill (a stateful glyph, not a checkbox).
      item('menu_1_2', patch.bookmarked ? 'Edit Bookmark' : 'Bookmark', {
        glyph: 'star',
        checked: patch.bookmarked ?? false
      }),
      item('menu_1_3', 'Download Page', { glyph: 'download' }),
      item('menu_1_4', 'Page Info', { glyph: 'info', enabled: patch.pageInfo ?? true }),
      patch.loading
        ? item('menu_1_5', 'Stop', { glyph: 'stop' })
        : item('menu_1_5', 'Reload', { glyph: 'reload' }),
      item('menu_1_6', '', { type: 'separator' }),
      item('menu_1_7', 'New Tab'),
      item('menu_1_8', 'New Private Tab')
    ]
  }
}

const layer = (m: MenuDescriptor): ReactElement => (
  <SheetPresence>
    <MenuSheet key={m.id} menu={m} />
  </SheetPresence>
)

/** Show the menu as `showMenu` does (the store holds the request `pickMenuItem` answers). */
async function show(m: MenuDescriptor): Promise<void> {
  uiStore.set({ menu: m })
  render(layer(m))
  await settle()
  frames.run(60)
}

const row = (): HTMLElement | null => document.querySelector<HTMLElement>('.zen-menu-icon-row')
const buttons = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('.zen-menu-icon-row .zen-v2-icon-button')
]
const button = (label: string): HTMLButtonElement =>
  buttons().find((b) => b.getAttribute('aria-label') === label)!
const textRows = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('.zen-sheet-item')].map((b) => b.textContent ?? '')
const starFill = (): HTMLElement => document.querySelector<HTMLElement>('.zen-star-glyph-fill')!
const fillOpacity = (): number => Number(starFill().style.opacity)
const fillScale = (): number => parseFloat(/scale\(([\d.]+)\)/.exec(starFill().style.transform)![1])
const click = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
const picks = (): unknown[][] => invoke.mock.calls.filter(([name]) => name === 'menu.click')

beforeEach(() => {
  frames.install()
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-sheet-scroll') ? 300 : 800
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 300
  })
  invoke.mockClear()
  Object.assign(window, { zen: { invoke, on: () => () => undefined } })
  viewportStore.set({ ...viewportStore.get(), coarse: true, formFactor: 'phone' })
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  uiStore.set({ menu: null })
  vi.unstubAllGlobals()
  delete (window as { matchMedia?: unknown }).matchMedia
  frames.now = 0
  act(() => viewportStore.set({ ...viewportStore.get(), coarse: false, formFactor: 'desktop' }))
})

describe('the icon row', () => {
  it('is a group whose items all name a glyph; a group with a text row among them is rows', () => {
    const glyphs = appMenu().items.slice(0, 5)
    expect(isIconRow(glyphs)).toBe(true)
    expect(isIconRow([...glyphs, item('x', 'New Tab')])).toBe(false)
    expect(isIconRow([])).toBe(false)
  })

  it("draws the five as icon buttons in Chrome's order ahead of the rows of text, each named by its label, disabled where the core said so", async () => {
    await show(appMenu({ forward: false, pageInfo: false }))
    expect(row()).not.toBeNull()
    // The row is the sheet's first group; the text rows follow it, no row of text for a glyph.
    expect(row()!.parentElement!.firstElementChild).toBe(row())
    expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Forward',
      'Bookmark',
      'Download Page',
      'Page Info',
      'Reload'
    ])
    expect(buttons().map((b) => b.dataset.glyph)).toEqual([
      'forward',
      'star',
      'download',
      'info',
      'reload'
    ])
    expect(textRows()).toEqual(['New Tab', 'New Private Tab'])
    // Real buttons (§9.22), the shared v2 icon button (§9.3), `disabled` – not `aria-disabled` –
    // where the action has nowhere to go (§9.30): the .4 is the primitive's one rule.
    for (const b of buttons()) {
      expect(b.tagName).toBe('BUTTON')
      expect(b.getAttribute('type')).toBe('button')
    }
    expect(button('Forward').disabled).toBe(true)
    expect(button('Page Info').disabled).toBe(true)
    expect(button('Bookmark').disabled).toBe(false)
    expect(button('Download Page').disabled).toBe(false)
    expect(button('Reload').disabled).toBe(false)
    // The glyphs are drawn, not named twice: no text inside the buttons for a reader to read.
    for (const b of buttons()) expect(b.textContent).toBe('')
  })

  it('Forward comes alive with a forward entry; the last slot is Stop while the page loads, with the bar’s own Reload / Stop glyph', async () => {
    await show(appMenu({ forward: true, loading: true }))
    expect(button('Forward').disabled).toBe(false)
    const stop = button('Stop')
    expect(stop).toBeDefined()
    expect(stop.dataset.glyph).toBe('stop')
    expect(stop.querySelector('.zen-glyph-swap')).not.toBeNull()
    expect(buttons().some((b) => b.getAttribute('aria-label') === 'Reload')).toBe(false)
  })

  it('a press slides the sheet away and then picks the item, as a text row does', async () => {
    const menu = appMenu()
    await show(menu)
    click(button('Reload'))
    // Nothing is picked while the sheet is still on its way down.
    expect(picks()).toEqual([])
    runAll()
    expect(picks()).toEqual([['menu.click', { menuId: 'menu_1', itemId: 'menu_1_5' }]])
    expect(uiStore.get().menu).toBeNull()
  })

  it('a disabled button takes no press', async () => {
    await show(appMenu({ forward: false }))
    click(button('Forward'))
    runAll()
    expect(picks()).toEqual([])
    expect(uiStore.get().menu).not.toBeNull()
  })

  it('the row’s rule draws in tokens alone: the row height, the gutter and the glyph sizes are the density tokens, no literal hue', () => {
    const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')
    const rule = /\.zen-menu-icon-row \{([^}]*)\}/.exec(css)![1]
    expect(rule).toContain('height: var(--v2-row)')
    expect(rule).toContain('padding: 0 16px')
    expect(rule).toContain('justify-content: space-between')
    const glyph = /\.zen-menu-icon-row svg \{([^}]*)\}/.exec(css)![1]
    expect(glyph).toContain('width: var(--v2-icon)')
    expect(glyph).toContain('stroke-width: var(--v2-icon-stroke)')
    const block = css.slice(
      css.indexOf('.zen-menu-icon-row {'),
      css.indexOf('.zen-star-glyph > span')
    )
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    // The disabled look is the primitive's one rule (§9.30), not a second one on the row.
    expect(css).toMatch(/\.zen-v2-icon-button:disabled \{\s*opacity: 0\.4;/)
  })
})

describe('the star', () => {
  it('opens unfilled on a page that is not bookmarked and fills on the press, on one spring to the end, as the sheet leaves; the core’s save follows once the sheet is gone', async () => {
    await show(appMenu({ bookmarked: false }))
    const star = button('Bookmark')
    expect(star.dataset.filled).toBe('false')
    expect(fillOpacity()).toBe(0)
    expect(fillScale()).toBeCloseTo(0.6)

    click(star)
    expect(star.dataset.filled).toBe('true')
    // The fill is under way before the sheet has landed: opacity climbs frame by frame, the
    // filled star growing with it, and nothing is picked yet.
    const seen: number[] = [fillOpacity()]
    const scales: number[] = [fillScale()]
    let landed = false
    for (let n = 0; n < 40 && !landed; n++) {
      frame()
      seen.push(fillOpacity())
      scales.push(fillScale())
      landed = picks().length > 0
    }
    // The fill comes to rest before the sheet lands (the same spring over 1 rests before the
    // same spring over the sheet's height does), and stays there.
    const rest = seen.indexOf(1)
    expect(rest).toBeGreaterThan(0)
    expect(seen.slice(rest).every((o) => o === 1)).toBe(true)
    // One spring to the end, not a ramp and a cut: every frame climbs; no frame steps more than
    // the spring's own largest 16 ms step (.12 – the px-scaled rest thresholds snapped .52 → 1 in
    // one frame); the frame that lands closes less than a hundredth (the unit-scaled restDelta);
    // and the motion takes the spring's time (22 frames at 16 ms), not five.
    const path = seen.slice(0, rest + 1)
    const steps = path.slice(1).map((o, i) => o - path[i])
    expect(steps.every((step) => step > 0)).toBe(true)
    expect(Math.max(...steps)).toBeLessThan(0.2)
    expect(steps[steps.length - 1]).toBeLessThan(0.01)
    expect(path.length).toBeGreaterThanOrEqual(15)
    // The scale rides the same value: .6 at the start, 1 at rest, climbing with the opacity.
    expect(scales[0]).toBeCloseTo(0.6)
    expect(scales[rest]).toBeCloseTo(1)
    for (let i = 1; i <= rest; i++) expect(scales[i]).toBeGreaterThanOrEqual(scales[i - 1])
    runAll()
    expect(fillOpacity()).toBe(1)
    expect(fillScale()).toBeCloseTo(1, 1)
    expect(picks()).toEqual([['menu.click', { menuId: 'menu_1', itemId: 'menu_1_2' }]])
  })

  it('opens filled and at rest on a bookmarked page, with no motion of its own; a press keeps the fill and picks (the editor)', async () => {
    await show(appMenu({ bookmarked: true }))
    const star = button('Edit Bookmark')
    expect(star.dataset.filled).toBe('true')
    expect(fillOpacity()).toBe(1)
    expect(fillScale()).toBeCloseTo(1)
    click(star)
    frame()
    frame()
    expect(fillOpacity()).toBe(1)
    runAll()
    expect(star.dataset.filled).toBe('true')
    expect(picks()).toEqual([['menu.click', { menuId: 'menu_1', itemId: 'menu_1_2' }]])
  })

  it('under reduced motion the fill jumps to its end (§11.3)', async () => {
    // The spring's own check (`reducedMotion()` inside `SpringAnimation.start`) reads the media
    // query; the system says reduce.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({ matches: query.includes('reduce') })
    })
    await show(appMenu({ bookmarked: false }))
    expect(fillOpacity()).toBe(0)
    click(button('Bookmark'))
    expect(fillOpacity()).toBe(1)
    expect(fillScale()).toBeCloseTo(1)
  })

  it('the fill runs on transform and opacity alone (§11: nothing else per frame)', async () => {
    await show(appMenu({ bookmarked: false }))
    click(button('Bookmark'))
    frame()
    frame()
    const style = starFill().getAttribute('style') ?? ''
    expect(style).toMatch(/opacity/)
    expect(style).toMatch(/transform/)
    expect(
      style
        .replace(/opacity:[^;]*;?/, '')
        .replace(/transform:[^;]*;?/, '')
        .trim()
    ).toBe('')
  })
})

describe('on a mouse (the popover)', () => {
  it('the same items are rows of text with their labels – the glyph is the sheet’s drawing', async () => {
    viewportStore.set({ ...viewportStore.get(), coarse: false, formFactor: 'phone' })
    uiStore.set({ menu: appMenu() })
    render(layer(appMenu()))
    await settle()
    expect(row()).toBeNull()
    const labels = [...document.querySelectorAll<HTMLElement>('button')].map((b) => b.textContent)
    expect(labels).toEqual([
      'Forward',
      'Bookmark',
      'Download Page',
      'Page Info',
      'Reload',
      'New Tab',
      'New Private Tab'
    ])
  })

  it('a bookmarked page’s star is a row without a check mark – the fill is state, not a ticked option', async () => {
    viewportStore.set({ ...viewportStore.get(), coarse: false, formFactor: 'phone' })
    const m: MenuDescriptor = {
      ...appMenu({ bookmarked: true }),
      items: [
        ...appMenu({ bookmarked: true }).items,
        item('menu_1_9', 'Desktop Site', { type: 'checkbox', checked: true })
      ]
    }
    uiStore.set({ menu: m })
    render(layer(m))
    await settle()
    const rows = [...document.querySelectorAll<HTMLElement>('button')]
    const byText = (text: string): HTMLElement => rows.find((b) => b.textContent === text)!
    // The popover's leading slot holds a check for a checked checkbox item alone: the per-site
    // toggle gets one, the star – a plain item whose `checked` is the sheet's fill – does not.
    expect(byText('Desktop Site').querySelector('svg')).not.toBeNull()
    expect(byText('Edit Bookmark').querySelector('svg')).toBeNull()
  })
})
