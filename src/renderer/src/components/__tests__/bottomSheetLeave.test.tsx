// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode, act, useState, type JSX, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ExternalProtocolRequest, MenuDescriptor } from '@shared/types'
import { BottomSheet } from '../sheet/BottomSheet'
import { MenuSheet } from '../menus/MenuSheet'
import { ExternalProtocolLayer } from '../protocol/ExternalProtocolSheet'
import { viewportStore } from '@renderer/lib/formFactor'
import { SheetPresence } from '@renderer/lib/motion/presence'
import { recedeDepth } from '@renderer/lib/motion/recede'
import { REDUCED_MOTION_FADE_MS } from '@renderer/lib/motion/sheet'
import { reducedMotion } from '@renderer/lib/motion/spring'
import { cancelExternalProtocol, uiStore } from '@renderer/lib/ui'

// The chassis's one reduced-motion check, wrapped so a test can see who asks it (and force its
// answer); it answers as the real one does until a test says otherwise.
vi.mock('@renderer/lib/motion/spring', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/motion/spring')>()
  return { ...actual, reducedMotion: vi.fn(actual.reducedMotion) }
})

/*
 * A sheet's leave outlives its request (design language v2 draft §11.1: the store's `null` means
 * "leave", never "vanish"). Under `SheetPresence` (lib/motion/presence.tsx) a `BottomSheet` whose
 * request the store has cleared – `menu.hide` from the core, a back delivered as one event, a
 * local menu opening over an open menu – runs its own dismissal from wherever it stands, p 1 → 0
 * over its travel on the sheet spring, inert throughout, and unmounts once it has landed: the
 * recede layer leaves the stack, the page's cover is let go and focus returns to the opener then,
 * not at the store write. A lower sheet closed by the host under an upper at rest runs down while
 * the upper's q, the page's recede and the one scrim hold (§11.2); a new request while one is
 * leaving is a new layer above it; under reduced motion the leave is the 120 ms fade in place
 * (§11.3). Rendered for real in happy-dom, the frame loop cranked by hand, the layout given sizes
 * (happy-dom lays nothing out): the layer is 800 px tall and a sheet's content 300 px, so a
 * sheet's travel is 300 and its p is `1 − translateY / 300`.
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
/** Window chrome with the control that opened the sheet, focused before the sheet mounts. */
let chrome: HTMLElement
let opener: HTMLButtonElement
const TRAVEL = 300

function render(el: ReactElement): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
}

function rerender(el: ReactElement): void {
  act(() => root!.render(el))
}

/** Let the wait for the page's cover resolve (at once with no page) and the sheet come up. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

/** A frame, with whatever React work a landing sets off (the wrapper dropping the sheet). */
const frame = (): void => {
  act(() => frames.run(1))
}

const html = (): HTMLElement => document.documentElement
const recedeVar = (): string => html().style.getPropertyValue('--zen-recede')
const layers = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-sheet-layer]')
]
const sheets = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.zen-sheet')]
const scrims = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.zen-sheet-scrim')]
const opacity = (el: HTMLElement): number => Number(el.style.opacity)
const translateY = (el: HTMLElement): number =>
  parseFloat(/translate3d\(0, ([-\d.]+)px/.exec(el.style.transform)![1])
/** A sheet's presence, read off its slide: p = 1 − translateY / travel, clamped. */
const presence = (el: HTMLElement): number => Math.max(0, Math.min(1, 1 - translateY(el) / TRAVEL))
const layerRecede = (el: HTMLElement): number =>
  Number(el.style.getPropertyValue('--zen-layer-recede'))
const press = (el: Element, type = 'pointerdown'): boolean =>
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0 }))
const active = (): Element | null => document.activeElement
const rows = (...labels: string[]): JSX.Element => (
  <ul>
    {labels.map((label) => (
      <li key={label}>
        <button type="button" className="zen-sheet-item">
          {label}
        </button>
      </li>
    ))}
  </ul>
)
const byText = (text: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent === text)!

/** The layer a request renders: `MenuLayer`'s shape, the sheet keyed by the request. */
function Layer({
  request,
  children
}: {
  request: string | null
  children?: ReactNode
}): JSX.Element {
  return (
    <SheetPresence>
      {request ? (
        <BottomSheet key={request} onDismissed={() => undefined}>
          {children ?? rows('Copy', 'Share')}
        </BottomSheet>
      ) : null}
    </SheetPresence>
  )
}

/** Run the leave to its landing, judging every frame with `each`; returns the frames it took. */
function runLeave(each?: (p: number) => void, max = 120): number {
  let n = 0
  for (; n < max && frames.scheduled; n++) {
    frame()
    each?.(Number(recedeVar()))
  }
  return n
}

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
  chrome = document.createElement('nav')
  chrome.dataset.shellChrome = ''
  opener = document.createElement('button')
  opener.textContent = 'Menu'
  chrome.appendChild(opener)
  document.body.appendChild(chrome)
  opener.focus()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  chrome.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.mocked(reducedMotion).mockReset()
  frames.now = 0
  act(() => viewportStore.set({ ...viewportStore.get(), coarse: false, formFactor: 'desktop' }))
})

describe('a sheet whose request the store has cleared (§11.1: a leave, never a vanish)', () => {
  it('stays mounted, inert, and runs p 1 → 0 over its travel on every frame of the way down; the layer leaves the stack and the page comes back only on landing', async () => {
    render(<Layer request="menu" />)
    await settle()
    frames.run(60)
    expect(recedeVar()).toBe('1.0000')
    expect(uiStore.get().frameSheetOpen).toBe(true)
    const sheet = sheets()[0]
    const layer = layers()[0]
    expect(sheet.hasAttribute('inert')).toBe(false)

    // `menu.hide` from the core (or a back delivered as one event): the store's `null`.
    rerender(<Layer request={null} />)
    // The next frame does not show a page without its sheet: the sheet is still there, told
    // it is leaving – inert, its layer marked – and the page is still receded under its cover.
    expect(sheets()).toHaveLength(1)
    expect(sheets()[0]).toBe(sheet)
    expect(sheet.hasAttribute('inert')).toBe(true)
    expect(layer.hasAttribute('data-leaving')).toBe(true)
    expect(recedeVar()).toBe('1.0000')
    expect(uiStore.get().frameSheetOpen).toBe(true)
    expect(recedeDepth()).toBe(1)
    expect(frames.scheduled).toBe(true)

    // Every frame: the recede is the sheet's own presence over its travel, monotone, no step;
    // never a frame with the sheet gone and the page still receded.
    let last = 1
    let judged = 0
    const n = runLeave((p) => {
      if (sheets().length === 0) {
        expect(p).toBe(0)
        return
      }
      expect(p).toBeCloseTo(presence(sheet), 3)
      expect(p).toBeCloseTo(opacity(scrims()[0]), 4)
      expect(p).toBeLessThanOrEqual(last + 1e-9)
      expect(last - p).toBeLessThan(0.25)
      expect(sheet.hasAttribute('inert')).toBe(true)
      expect(uiStore.get().frameSheetOpen).toBe(true)
      last = p
      judged++
    })
    expect(n).toBeGreaterThan(5)
    expect(judged).toBeGreaterThan(5)
    // Landed: unmounted, the stack empty, the root released, the page let back.
    expect(sheets()).toHaveLength(0)
    expect(recedeDepth()).toBe(0)
    expect(html().dataset.receding).toBeUndefined()
    expect(recedeVar()).toBe('')
    expect(uiStore.get().frameSheetOpen).toBe(false)
  })

  it('does not report a dismissal for a leave – the request is gone already – and a sheet landing on its own, whose landing clears the request, is not left behind', async () => {
    const onDismissed = vi.fn()
    // The surface's shape: the request stands until the sheet reports its dismissal.
    function Surface(): JSX.Element {
      const [up, setUp] = useState(true)
      return (
        <SheetPresence>
          {up ? (
            <BottomSheet
              key="menu"
              onDismissed={() => {
                onDismissed()
                setUp(false)
              }}
            >
              {rows('Copy')}
            </BottomSheet>
          ) : null}
        </SheetPresence>
      )
    }
    render(<Surface />)
    await settle()
    frames.run(60)
    act(() => {
      press(scrims()[0])
    })
    runLeave()
    expect(onDismissed).toHaveBeenCalledTimes(1)
    // The write that followed the landing found a sheet that had landed already: gone at once.
    expect(sheets()).toHaveLength(0)
    expect(recedeDepth()).toBe(0)
    expect(recedeVar()).toBe('')
  })

  it('a request cleared while the sheet still waits for the page’s cover takes it down without a slide', () => {
    render(<Layer request="menu" />)
    expect(sheets()[0].style.opacity).toBe('0')
    rerender(<Layer request={null} />)
    expect(sheets()).toHaveLength(0)
    expect(recedeDepth()).toBe(0)
    expect(frames.scheduled).toBe(false)
  })

  it('a request cleared mid-rise turns the sheet round from where it is', async () => {
    render(<Layer request="menu" />)
    await settle()
    frames.run(3)
    const sheet = sheets()[0]
    const midway = presence(sheet)
    expect(midway).toBeGreaterThan(0)
    expect(midway).toBeLessThan(1)
    rerender(<Layer request={null} />)
    frame()
    // No jump: the way down starts within a frame of where the rise had got to.
    expect(Math.abs(presence(sheet) - midway)).toBeLessThan(0.2)
    runLeave()
    expect(sheets()).toHaveLength(0)
  })
})

describe('the stack (§11.2)', () => {
  const both = (lower: string | null, upper: string | null): ReactElement => (
    <>
      <Layer request={lower}>{rows('Copy', 'Share')}</Layer>
      <Layer request={upper}>{rows('Open', 'Cancel')}</Layer>
    </>
  )

  it('the lower sheet closed by the host under an upper at rest runs down while the upper’s q, the page’s recede and the one scrim hold; the upper follows the shorter stack only once the lower has landed', async () => {
    render(both('menu', null))
    await settle()
    frames.run(60)
    rerender(both('menu', 'confirm'))
    await settle()
    frames.run(60)
    const [lower, upper] = sheets()
    expect(recedeVar()).toBe('1.0000')
    expect(layerRecede(lower)).toBe(1)
    expect(lower.hasAttribute('inert')).toBe(true)
    expect(upper.hasAttribute('inert')).toBe(false)
    expect(opacity(scrims()[0])).toBe(0)
    expect(opacity(scrims()[1])).toBe(1)

    // The host closes the lower one (the protocol confirm's menu hidden by the core).
    rerender(both(null, 'confirm'))
    expect(sheets()).toHaveLength(2)
    let lastY = 0
    let judged = 0
    runLeave(() => {
      if (sheets().length < 2) return
      // The page and the upper sheet do not move: q holds at 1, the recede at 1, the upper's
      // scrim is the stack's one scrim and the lower's hands over nothing new.
      expect(recedeVar()).toBe('1.0000')
      expect(presence(upper)).toBe(1)
      expect(opacity(scrims()[1])).toBe(1)
      expect(opacity(scrims()[0])).toBe(0)
      expect(layerRecede(upper)).toBe(0)
      expect(upper.hasAttribute('inert')).toBe(false)
      // The lower one runs its own way down, still receded under the upper and inert.
      const y = translateY(lower)
      expect(y).toBeGreaterThanOrEqual(lastY - 1e-6)
      expect(layerRecede(lower)).toBe(1)
      expect(lower.hasAttribute('inert')).toBe(true)
      lastY = y
      judged++
    })
    expect(judged).toBeGreaterThan(5)
    // Landed: the shorter stack; the upper as it was, the page still under it.
    expect(sheets()).toHaveLength(1)
    expect(sheets()[0]).toBe(upper)
    expect(recedeDepth()).toBe(1)
    expect(recedeVar()).toBe('1.0000')
    expect(opacity(scrims()[0])).toBe(1)
    expect(upper.hasAttribute('inert')).toBe(false)
  })

  it('a new request while one is leaving is a new layer above it: the new one comes up as the old one finishes down behind it, the page held by the two together', async () => {
    render(<Layer request="first" />)
    await settle()
    frames.run(60)
    rerender(<Layer request={null} />)
    frame()
    frame()
    const first = sheets()[0]
    const partway = presence(first)
    expect(partway).toBeLessThan(1)
    expect(partway).toBeGreaterThan(0)

    // A menu popping while one is up: the new request, keyed apart.
    rerender(<Layer request="second" />)
    expect(sheets()).toHaveLength(2)
    expect(sheets()[0]).toBe(first)
    const second = sheets()[1]
    expect(layers()[0].hasAttribute('data-leaving')).toBe(true)
    expect(layers()[1].hasAttribute('data-leaving')).toBe(false)
    expect(recedeDepth()).toBe(2)
    // Registered above but held for the cover: the leaving one is receded by nothing yet.
    expect(layerRecede(first)).toBe(0)
    await settle()

    let judged = 0
    let seenBoth = 0
    runLeave(() => {
      if (!first.isConnected) return
      const p = presence(first)
      const q = presence(second)
      if (q > 0 && p > 0) seenBoth++
      // The page is receded by the two together, capped at a sheet's worth (the number their
      // scrims compound to), never by the larger one alone; the old sheet is receded by the new
      // one and inert; the new one is live.
      expect(Number(recedeVar())).toBeCloseTo(Math.min(1, p + q), 3)
      expect(layerRecede(first)).toBeCloseTo(q, 3)
      expect(first.hasAttribute('inert')).toBe(true)
      expect(second.hasAttribute('inert')).toBe(false)
      judged++
    })
    expect(judged).toBeGreaterThan(3)
    expect(seenBoth).toBeGreaterThan(0)
    // The old one is gone, the new one at rest above the page.
    expect(sheets()).toHaveLength(1)
    expect(sheets()[0]).toBe(second)
    expect(recedeDepth()).toBe(1)
    expect(recedeVar()).toBe('1.0000')
    expect(layerRecede(second)).toBe(0)
  })
})

describe('reduced motion (§11.3)', () => {
  /** The user prefers reduced motion: what the chassis's `reducedMotion()` reads. */
  const preferReducedMotion = (): void => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false
    }))
  }

  it('the leave is the 120 ms fade in place, then the unmount: no recede runs', async () => {
    preferReducedMotion()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    render(<Layer request="menu" />)
    await settle()
    // The spring jumps under reduced motion: at rest at once.
    expect(recedeVar()).toBe('1.0000')
    const sheet = sheets()[0]
    expect(sheet.style.opacity).toBe('1')

    rerender(<Layer request={null} />)
    // Faded in place: the sheet and its scrim step to 0 on main.css's transition, still mounted,
    // nothing moving and the recede value untouched until the fade is over.
    expect(sheets()).toHaveLength(1)
    expect(sheet.style.opacity).toBe('0')
    expect(scrims()[0].style.opacity).toBe('0')
    expect(sheet.hasAttribute('inert')).toBe(true)
    expect(sheet.getAttribute('aria-hidden')).toBe('true')
    expect(frames.scheduled).toBe(false)
    expect(recedeVar()).toBe('1.0000')
    expect(presence(sheet)).toBe(1)
    act(() => {
      vi.advanceTimersByTime(REDUCED_MOTION_FADE_MS - 1)
    })
    expect(sheets()).toHaveLength(1)
    expect(recedeVar()).toBe('1.0000')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(sheets()).toHaveLength(0)
    expect(recedeDepth()).toBe(0)
    expect(recedeVar()).toBe('')
  })

  it('the dismissal and the leave fade through the one check and the one length – the chassis’s `reducedMotion()` and `REDUCED_MOTION_FADE_MS` – with no check or length of the leave’s own', async () => {
    // The chassis's check is forced, and the media query stubbed with it so that the spring,
    // which asks the same question from inside its own module, jumps as it does for the user.
    preferReducedMotion()
    const check = vi.mocked(reducedMotion)
    check.mockReturnValue(true)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    // The dismissal: a press on a live sheet's scrim (§9.20); the surface's write follows the
    // landing. The sheet and its scrim step to 0 at once, and the sheet is gone at 120 ms – not
    // a millisecond before – the slide having been skipped.
    function Surface(): JSX.Element {
      const [up, setUp] = useState(true)
      return (
        <SheetPresence>
          {up ? (
            <BottomSheet key="menu" onDismissed={() => setUp(false)}>
              {rows('Copy')}
            </BottomSheet>
          ) : null}
        </SheetPresence>
      )
    }
    render(<Surface />)
    await settle()
    const dismissed = sheets()[0]
    check.mockClear()
    act(() => {
      press(scrims()[0])
    })
    expect(check).toHaveBeenCalled()
    expect(dismissed.style.opacity).toBe('0')
    expect(scrims()[0].style.opacity).toBe('0')
    expect(frames.scheduled).toBe(false)
    act(() => {
      vi.advanceTimersByTime(REDUCED_MOTION_FADE_MS - 1)
    })
    expect(sheets()).toEqual([dismissed])
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(sheets()).toHaveLength(0)
    expect(recedeDepth()).toBe(0)

    // The leave: the request goes from under a sheet at rest. The same function is asked and
    // the same 120 ms pass, the recede untouched, before the unmount.
    rerender(<Layer request="menu" />)
    await settle()
    expect(recedeVar()).toBe('1.0000')
    const left = sheets()[0]
    check.mockClear()
    rerender(<Layer request={null} />)
    expect(check).toHaveBeenCalled()
    expect(sheets()).toEqual([left])
    expect(left.style.opacity).toBe('0')
    expect(scrims()[0].style.opacity).toBe('0')
    expect(left.hasAttribute('inert')).toBe(true)
    expect(left.getAttribute('aria-hidden')).toBe('true')
    expect(frames.scheduled).toBe(false)
    act(() => {
      vi.advanceTimersByTime(REDUCED_MOTION_FADE_MS - 1)
    })
    expect(sheets()).toEqual([left])
    expect(recedeVar()).toBe('1.0000')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(sheets()).toHaveLength(0)
    expect(recedeDepth()).toBe(0)
    expect(recedeVar()).toBe('')
  })
})

describe('assistive technology (§11.2, Leaving)', () => {
  it('the leaving sheet is `inert` and `aria-hidden` from the commit that took its request – before the first frame of its leave – and stays so to the unmount', async () => {
    render(<Layer request="menu" />)
    await settle()
    frames.run(60)
    const sheet = sheets()[0]
    expect(sheet.hasAttribute('inert')).toBe(false)
    expect(sheet.hasAttribute('aria-hidden')).toBe(false)

    // The store's write: the same commit marks the sheet, and no frame of the way down has run.
    rerender(<Layer request={null} />)
    expect(sheets()).toEqual([sheet])
    expect(presence(sheet)).toBe(1)
    expect(sheet.hasAttribute('inert')).toBe(true)
    expect(sheet.getAttribute('aria-hidden')).toBe('true')

    // Never taken off on the way down; gone only with the sheet.
    let judged = 0
    runLeave(() => {
      if (!sheet.isConnected) return
      expect(sheet.hasAttribute('inert')).toBe(true)
      expect(sheet.getAttribute('aria-hidden')).toBe('true')
      judged++
    })
    expect(judged).toBeGreaterThan(5)
    expect(sheets()).toHaveLength(0)
    expect(sheet.isConnected).toBe(false)
  })
})

describe('focus (§9.22)', () => {
  it('a leaving sheet is inert and the chrome stays inert; focus returns to the opener when the leave lands, not at the store write', async () => {
    render(<Layer request="menu" />)
    await settle()
    frames.run(60)
    expect(active()).toBe(byText('Copy'))
    expect(chrome.hasAttribute('inert')).toBe(true)

    rerender(<Layer request={null} />)
    const sheet = sheets()[0]
    expect(sheet.hasAttribute('inert')).toBe(true)
    expect(chrome.hasAttribute('inert')).toBe(true)
    expect(active()).not.toBe(opener)
    frame()
    frame()
    expect(chrome.hasAttribute('inert')).toBe(true)
    expect(active()).not.toBe(opener)
    runLeave()
    expect(sheets()).toHaveLength(0)
    expect(chrome.hasAttribute('inert')).toBe(false)
    expect(active()).toBe(opener)
  })

  it('a finger catching a leaving sheet holds it; the leave resumes with the finger when it lets go', async () => {
    render(<Layer request="menu" />)
    await settle()
    frames.run(60)
    rerender(<Layer request={null} />)
    const sheet = sheets()[0]
    frame()
    frame()
    const caught = presence(sheet)
    expect(caught).toBeLessThan(1)
    expect(caught).toBeGreaterThan(0)
    // The finger lands on the layer's scrim share – the sheet itself is inert, so no hit-test
    // reaches it; a press on the scrim over a moving sheet is the catch: the spring stops where
    // it is.
    const scrim = scrims()[0]
    act(() => {
      scrim.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerId: 1,
          pointerType: 'touch',
          clientY: 500
        })
      )
    })
    expect(frames.scheduled).toBe(false)
    expect(presence(sheet)).toBeCloseTo(caught, 4)
    // Under the finger the sheet is still on its way out – inert and hidden from assistive
    // technology as before (§11.2, Leaving); the finger holds it by the layer's capture.
    expect(sheet.hasAttribute('inert')).toBe(true)
    expect(sheet.getAttribute('aria-hidden')).toBe('true')
    expect(layers()[0].hasAttribute('data-leaving')).toBe(true)
    // It lets go: the leave goes on to its landing and the sheet unmounts; there is no detent
    // to come back to.
    act(() => {
      scrim.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerId: 1,
          pointerType: 'touch',
          clientY: 500
        })
      )
    })
    expect(frames.scheduled).toBe(true)
    runLeave()
    expect(sheets()).toHaveLength(0)
    expect(recedeVar()).toBe('')
  })
})

describe('the menu (MenuLayer’s shape: the sheet keyed by the menu’s id)', () => {
  const menu = (id: string): MenuDescriptor => ({
    id,
    source: 'page',
    x: null,
    y: null,
    items: [
      {
        id: `${id}-copy`,
        type: 'normal',
        label: 'Copy',
        enabled: true,
        checked: false,
        submenu: null
      },
      {
        id: `${id}-share`,
        type: 'normal',
        label: 'Share',
        enabled: true,
        checked: false,
        submenu: null
      }
    ]
  })
  const layer = (m: MenuDescriptor | null): ReactElement => (
    <SheetPresence>{m ? <MenuSheet key={m.id} menu={m} /> : null}</SheetPresence>
  )

  beforeEach(() => {
    viewportStore.set({ ...viewportStore.get(), coarse: true, formFactor: 'phone' })
    vi.stubGlobal('zen', { invoke: async () => undefined, on: () => () => undefined })
    Object.assign(window, { zen: { invoke: async () => undefined, on: () => () => undefined } })
  })

  it('a menu popping over an open one rises above the one on its way out, and Escape goes to the new one, not the leaving one', async () => {
    render(layer(menu('a')))
    await settle()
    frames.run(60)
    expect(recedeVar()).toBe('1.0000')
    // The core hides menu a and shows menu b: the layer keys the sheet by id.
    rerender(layer(menu('b')))
    expect(sheets()).toHaveLength(2)
    const [a, b] = sheets()
    expect(layers()[0].hasAttribute('data-leaving')).toBe(true)
    expect(a.hasAttribute('inert')).toBe(true)
    await settle()
    frame()
    frame()
    const rising = presence(b)
    expect(rising).toBeGreaterThan(0)
    expect(presence(a)).toBeLessThan(1)

    // Escape: the leaving menu lets it by; the new one answers with its own dismissal.
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    frame()
    frame()
    expect(presence(b)).toBeLessThan(rising)
  })

  it('a menu popped over a leaving one takes over its opener (§9.22): when the new menu closes, focus is back on the control that opened the first, not on a row of the sheet that went', async () => {
    render(layer(menu('a')))
    await settle()
    frames.run(60)
    // Focus is in the first menu, on its first row.
    expect(active()).toBe(byText('Copy'))
    expect(active()).not.toBe(opener)

    // `menu.hide` and the new menu land in one commit: the new sheet mounts while the focus
    // still sits in a row of the one on its way out (inert from this commit on) – what it finds
    // as its opener – and then takes the focus itself, being on top.
    rerender(layer(menu('b')))
    const [a, b] = sheets()
    expect(a.hasAttribute('inert')).toBe(true)
    expect(b.contains(active())).toBe(true)
    await settle()
    runLeave()
    // The first has landed and gone; the second stands at rest and holds the focus.
    expect(sheets()).toEqual([b])
    expect(b.contains(active())).toBe(true)
    expect(recedeVar()).toBe('1.0000')

    // The second menu is dismissed (a scrim press); its landing clears the request.
    act(() => {
      press(scrims()[0])
    })
    runLeave()
    rerender(layer(null))
    expect(sheets()).toHaveLength(0)
    expect(active()).toBe(opener)
  })

  it('the same when the new menu comes in a later commit, after the leaving row lost the focus (an element gone inert is blurred): a sheet mounted with the focus on nothing takes the leaving sheet’s opener', async () => {
    render(layer(menu('a')))
    await settle()
    frames.run(60)
    rerender(layer(null))
    frame()
    frame()
    // What the browser does to a focused element that went inert.
    act(() => {
      ;(active() as HTMLElement).blur()
    })
    expect(active()).toBe(document.body)

    rerender(layer(menu('b')))
    expect(sheets()).toHaveLength(2)
    const b = sheets()[1]
    await settle()
    runLeave()
    expect(sheets()).toEqual([b])
    expect(b.contains(active())).toBe(true)

    act(() => {
      press(scrims()[0])
    })
    runLeave()
    rerender(layer(null))
    expect(sheets()).toHaveLength(0)
    expect(active()).toBe(opener)
  })

  it('a leaving menu whose sheet is swapped for the popover by a live pointer flip – the reader unmounts without landing – is dropped: no popover is retained for a menu with no request', async () => {
    render(layer(menu('a')))
    await settle()
    frames.run(60)
    rerender(layer(null))
    frame()
    frame()
    expect(sheets()).toHaveLength(1)
    expect(presence(sheets()[0])).toBeLessThan(1)

    // A mouse arrives mid-leave (`(pointer: coarse)` no longer matches): `MenuSheet` renders
    // the popover in place of the sheet, and the popover reads no leave.
    act(() => viewportStore.set({ ...viewportStore.get(), coarse: false, formFactor: 'desktop' }))
    expect(sheets()).toHaveLength(0)
    expect(recedeDepth()).toBe(0)
    // Nothing is left to answer `onLeft` for the sheet that went: once the commit is over the
    // wrapper drops the generation, and the popover with it.
    await settle()
    expect(mount!.childElementCount).toBe(0)
    expect(recedeVar()).toBe('')
    expect(chrome.hasAttribute('inert')).toBe(false)
  })
})

describe('the external-protocol confirm (ExternalProtocolLayer: the core’s question, withdrawn by the core)', () => {
  const request = (id: string): ExternalProtocolRequest => ({
    requestId: id,
    url: 'tel:5550100',
    scheme: 'tel',
    appName: 'Phone',
    site: 'news.example',
    canRemember: true
  })

  beforeEach(() => {
    viewportStore.set({ ...viewportStore.get(), coarse: true, formFactor: 'phone' })
    Object.assign(window, { zen: { invoke: async () => undefined, on: () => () => undefined } })
  })

  afterEach(() => {
    uiStore.set({ externalProtocol: null })
  })

  it('`externalProtocol.cancel` from the core (the tab gone, a newer request) is a leave: the sheet runs down inert, its request already gone, and unmounts on landing', async () => {
    render(<ExternalProtocolLayer />)
    act(() => uiStore.set({ externalProtocol: request('r1') }))
    await settle()
    frames.run(60)
    expect(sheets()).toHaveLength(1)
    expect(recedeVar()).toBe('1.0000')
    const sheet = sheets()[0]

    act(() => cancelExternalProtocol('r1'))
    expect(uiStore.get().externalProtocol).toBeNull()
    expect(sheets()).toHaveLength(1)
    expect(sheets()[0]).toBe(sheet)
    expect(sheet.hasAttribute('inert')).toBe(true)
    expect(layers()[0].hasAttribute('data-leaving')).toBe(true)
    let last = 1
    let judged = 0
    runLeave((p) => {
      if (sheets().length === 0) return
      expect(p).toBeCloseTo(presence(sheet), 3)
      expect(p).toBeLessThanOrEqual(last + 1e-9)
      last = p
      judged++
    })
    expect(judged).toBeGreaterThan(5)
    expect(sheets()).toHaveLength(0)
    expect(recedeDepth()).toBe(0)
    expect(recedeVar()).toBe('')
  })

  it('a newer request taking the sheet over rises above the one on its way out; Escape reaches the new one', async () => {
    render(<ExternalProtocolLayer />)
    act(() => uiStore.set({ externalProtocol: request('r1') }))
    await settle()
    frames.run(60)
    // The core cancels r1 and asks r2 (one question per tab): two writes, two sheets.
    act(() => {
      cancelExternalProtocol('r1')
      uiStore.set({ externalProtocol: request('r2') })
    })
    expect(sheets()).toHaveLength(2)
    const [old, next] = sheets()
    expect(layers()[0].hasAttribute('data-leaving')).toBe(true)
    expect(old.hasAttribute('inert')).toBe(true)
    await settle()
    frame()
    frame()
    const rising = presence(next)
    expect(rising).toBeGreaterThan(0)
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    frame()
    frame()
    expect(presence(next)).toBeLessThan(rising)
    runLeave()
    expect(sheets()).toHaveLength(0)
  })
})

describe('under <StrictMode> (effects mounted, torn down and mounted again before the first paint)', () => {
  it('the sheet still comes up after the rehearsed unmount – its cover taken again, not left for gone – and its leave still lands', async () => {
    render(
      <StrictMode>
        <Layer request="menu" />
      </StrictMode>
    )
    await settle()
    frames.run(60)
    // Caught by the preview host, not the suite: the rehearsed cleanup marked the sheet presented
    // and the real mount then never brought it up (opacity 0, p 0, the page held under a cover).
    const sheet = sheets()[0]
    expect(sheet.style.opacity).toBe('1')
    expect(presence(sheet)).toBe(1)
    expect(recedeVar()).toBe('1.0000')
    expect(recedeDepth()).toBe(1)
    expect(uiStore.get().frameSheetOpen).toBe(true)

    rerender(
      <StrictMode>
        <Layer request={null} />
      </StrictMode>
    )
    expect(sheets()[0]).toBe(sheet)
    expect(sheet.hasAttribute('inert')).toBe(true)
    let judged = 0
    runLeave((p) => {
      if (sheets().length === 0) return
      expect(p).toBeCloseTo(presence(sheet), 3)
      judged++
    })
    expect(judged).toBeGreaterThan(5)
    expect(sheets()).toHaveLength(0)
    expect(recedeDepth()).toBe(0)
    expect(recedeVar()).toBe('')
    expect(uiStore.get().frameSheetOpen).toBe(false)
  })
})
