// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createRef, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { recedeDepth } from '@renderer/lib/motion/recede'
import { uiStore } from '@renderer/lib/ui'

/*
 * The sheet chassis as the home of the recede (design language v2 draft §11): a `BottomSheet`
 * recedes the page by its own progress – the one value that moves it and fades its scrim –
 * reversibly, from the moment it comes up to the moment it is gone; a second sheet recedes the
 * first and pushes the page no further; a press on the scrim dismisses on `pointerdown` (§9.20);
 * predictive back drives the same value. Rendered for real in happy-dom, the frame loop cranked
 * by hand, the layout given sizes (happy-dom lays nothing out).
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

const html = (): HTMLElement => document.documentElement
const recedeVar = (): string => html().style.getPropertyValue('--zen-recede')
const sheets = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.zen-sheet')]
const scrims = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.zen-sheet-scrim')]
const opacity = (el: HTMLElement): number => Number(el.style.opacity)
const press = (el: Element, type = 'pointerdown'): boolean =>
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0 }))

beforeEach(() => {
  frames.install()
  // The layer is 800 px tall and a sheet's content 300 px: an expanded detent above the peek.
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
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  vi.unstubAllGlobals()
  frames.now = 0
})

describe('BottomSheet on the recede chassis', () => {
  it('is on the stack from mount, comes up once the page is covered, and recedes the page by its own progress', async () => {
    render(<BottomSheet onDismissed={() => undefined}>rows</BottomSheet>)
    // Mounted: on the stack at 0, laid out but not yet shown – the wait for the cover – held at
    // opacity 0 and out of the pointer's way, never `visibility: hidden` (that would refuse the
    // focus the chassis moves in on mount, §9.22).
    expect(html().dataset.receding).toBe('true')
    expect(recedeVar()).toBe('0.0000')
    expect(sheets()[0].style.opacity).toBe('0')
    expect(sheets()[0].style.pointerEvents).toBe('none')
    expect(sheets()[0].style.visibility).toBe('')
    await settle()
    expect(sheets()[0].style.opacity).toBe('1')
    expect(sheets()[0].style.pointerEvents).toBe('')
    expect(frames.scheduled).toBe(true)

    // Every frame: the scrim's share and the page's recede are the same number.
    let last = 0
    for (let i = 0; i < 40 && frames.scheduled; i++) {
      frames.run(1)
      const scrim = opacity(scrims()[0])
      expect(Number(recedeVar())).toBeCloseTo(scrim, 4)
      expect(scrim).toBeGreaterThanOrEqual(last - 1e-9)
      last = scrim
    }
    expect(frames.scheduled).toBe(false)
    expect(recedeVar()).toBe('1.0000')
    expect(opacity(scrims()[0])).toBe(1)
    expect(sheets()[0].style.transform).toContain('scale(var(--zen-layer-scale, 1))')
  })

  it('a press on the scrim dismisses on pointerdown, the recede reverses on the same spring, and the layer leaves the stack', async () => {
    const onDismissed = vi.fn()
    render(<BottomSheet onDismissed={onDismissed}>rows</BottomSheet>)
    await settle()
    frames.run(60)
    expect(recedeVar()).toBe('1.0000')

    act(() => {
      press(scrims()[0])
    })
    // The click that follows the press reaches nothing.
    const clickAllowed = scrims()[0].dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    )
    expect(clickAllowed).toBe(false)
    expect(onDismissed).not.toHaveBeenCalled()

    let last = 1
    for (let i = 0; i < 60 && frames.scheduled; i++) {
      act(() => frames.run(1))
      const scrim = opacity(scrims()[0])
      // On its way down: the page comes back with the scrim, never jumping.
      expect(Number(recedeVar())).toBeCloseTo(scrim, 4)
      expect(scrim).toBeLessThanOrEqual(last + 1e-9)
      expect(last - scrim).toBeLessThan(0.25)
      last = scrim
    }
    expect(onDismissed).toHaveBeenCalledTimes(1)
    expect(recedeVar()).toBe('0.0000')

    // The host unmounts the sheet on `onDismissed`: the stack empties and the root is released.
    rerender(<div />)
    expect(recedeDepth()).toBe(0)
    expect(html().dataset.receding).toBeUndefined()
    expect(recedeVar()).toBe('')
  })

  it('a second sheet recedes the first and makes it inert, pushes the page no further, and shows the one scrim', async () => {
    render(
      <>
        <BottomSheet onDismissed={() => undefined}>lower</BottomSheet>
      </>
    )
    await settle()
    frames.run(60)
    expect(recedeVar()).toBe('1.0000')
    const [lower] = sheets()
    expect(lower.hasAttribute('inert')).toBe(false)

    const upperRef = createRef<BottomSheetHandle>()
    rerender(
      <>
        <BottomSheet onDismissed={() => undefined}>lower</BottomSheet>
        <BottomSheet ref={upperRef} onDismissed={() => undefined}>
          upper
        </BottomSheet>
      </>
    )
    // Registered above but held for the cover: the lower content stays live until the upper
    // sheet shows something of itself (§11.2: inert from q > 0), receded not at all yet.
    expect(lower.hasAttribute('inert')).toBe(false)
    expect(lower.style.getPropertyValue('--zen-layer-recede')).toBe('0.0000')
    await settle()
    frames.run(1)
    expect(lower.hasAttribute('inert')).toBe(true)
    expect(lower.hasAttribute('data-recessed')).toBe(true)
    for (let i = 0; i < 60 && frames.scheduled; i++) {
      frames.run(1)
      const [lowerScrim, upperScrim] = scrims()
      // The page never recedes past 1 and never comes back while a sheet stands …
      expect(recedeVar()).toBe('1.0000')
      // … the lower sheet recedes by the upper one's progress …
      expect(Number(lower.style.getPropertyValue('--zen-layer-recede'))).toBeCloseTo(
        opacity(upperScrim),
        4
      )
      // … and the two scrims add up to one scrim.
      expect(opacity(lowerScrim) + opacity(upperScrim)).toBeCloseTo(1, 4)
    }
    expect(lower.style.getPropertyValue('--zen-layer-recede')).toBe('1.0000')
    expect(opacity(scrims()[0])).toBe(0)
    expect(opacity(scrims()[1])).toBe(1)

    // The upper sheet leaves: the lower one comes back, live again; the page stays put.
    act(() => upperRef.current!.dismiss())
    for (let i = 0; i < 60 && frames.scheduled; i++) {
      act(() => frames.run(1))
      expect(recedeVar()).toBe('1.0000')
    }
    rerender(
      <>
        <BottomSheet onDismissed={() => undefined}>lower</BottomSheet>
      </>
    )
    expect(lower.hasAttribute('inert')).toBe(false)
    expect(lower.style.getPropertyValue('--zen-layer-recede')).toBe('0.0000')
    expect(opacity(scrims()[0])).toBe(1)
    expect(recedeVar()).toBe('1.0000')
  })

  it('predictive back drives the same value: the page un-recedes with the finger and comes back on cancel', async () => {
    const ref = createRef<BottomSheetHandle>()
    const onDismissed = vi.fn()
    render(
      <BottomSheet ref={ref} onDismissed={onDismissed}>
        rows
      </BottomSheet>
    )
    await settle()
    frames.run(60)
    expect(recedeVar()).toBe('1.0000')

    act(() => ref.current!.backProgress(0.5))
    const half = Number(recedeVar())
    expect(half).toBeLessThan(1)
    expect(half).toBeGreaterThan(0)
    expect(half).toBeCloseTo(opacity(scrims()[0]), 4)
    act(() => ref.current!.backProgress(0.8))
    expect(Number(recedeVar())).toBeLessThan(half)

    act(() => ref.current!.cancelBack())
    frames.run(60)
    expect(recedeVar()).toBe('1.0000')
    expect(onDismissed).not.toHaveBeenCalled()

    act(() => ref.current!.backProgress(0.6))
    act(() => ref.current!.commitBack())
    for (let i = 0; i < 60 && frames.scheduled; i++) act(() => frames.run(1))
    expect(onDismissed).toHaveBeenCalledTimes(1)
    expect(recedeVar()).toBe('0.0000')
  })

  it('the keyboard raises the detent: the sheet grows on its own value with the recede held at 1, and a dismissal from the raised pose runs p over the actual travel', async () => {
    // The sheet pads for the bottom inset (the gesture bar, or the keyboard while it is up), so
    // its content stands taller by the keyboard – the peek is measured above the keys (§11.1).
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return 300 + (parseFloat(this.style.paddingBottom) || 0)
      }
    })
    const insets = uiStore.get().insets
    uiStore.set({ insets: { ...insets, bottom: 48 } })
    const onDismissed = vi.fn()
    render(<BottomSheet onDismissed={onDismissed}>rows</BottomSheet>)
    await settle()
    frames.run(120)
    expect(recedeVar()).toBe('1.0000')
    const rested = parseFloat(sheets()[0].style.height)
    expect(rested).toBe(348)

    // The keyboard comes up: the host reports it as the bottom inset.
    act(() => uiStore.set({ insets: { ...insets, bottom: 356 } }))
    expect(frames.scheduled).toBe(true)
    let judged = 0
    for (let i = 0; i < 200 && frames.scheduled; i++) {
      act(() => frames.run(1))
      // Every frame of the growth: the page does not move, the scrim does not thin.
      expect(recedeVar()).toBe('1.0000')
      expect(opacity(scrims()[0])).toBe(1)
      judged++
    }
    expect(judged).toBeGreaterThan(5)
    const raised = parseFloat(sheets()[0].style.height)
    expect(raised).toBe(656)
    expect(sheets()[0].style.transform).toContain('translate3d(0, 0px, 0)')

    // Dismissed from the raised pose: p runs 1 → 0 over the 656 px the sheet stands at.
    act(() => {
      press(scrims()[0])
    })
    let last = 1
    let pastTheOldDetent = 0
    for (let i = 0; i < 200 && frames.scheduled; i++) {
      act(() => frames.run(1))
      const p = Number(recedeVar())
      const translateY = parseFloat(
        /translate3d\(0, ([-\d.]+)px/.exec(sheets()[0].style.transform)![1]
      )
      expect(p).toBeCloseTo(Math.max(0, 1 - translateY / 656), 3)
      expect(p).toBeLessThanOrEqual(last + 1e-9)
      expect(last - p).toBeLessThan(0.25)
      if (translateY > 348 && p > 0) pastTheOldDetent++
      last = p
    }
    // Still on its way down past the height it had before the keyboard: the old detent is
    // not where the recede's travel starts.
    expect(pastTheOldDetent).toBeGreaterThan(0)
    expect(onDismissed).toHaveBeenCalledTimes(1)
    expect(recedeVar()).toBe('0.0000')
    uiStore.set({ insets })
  })

  it('dismissed while still waiting for the page to be covered, the sheet is simply gone', () => {
    const ref = createRef<BottomSheetHandle>()
    const onDismissed = vi.fn()
    render(
      <BottomSheet ref={ref} onDismissed={onDismissed}>
        rows
      </BottomSheet>
    )
    // No frame has run: the sheet has not come up.
    expect(sheets()[0].style.opacity).toBe('0')
    act(() => ref.current!.dismiss())
    expect(onDismissed).toHaveBeenCalledTimes(1)
    expect(frames.scheduled).toBe(false)
  })
})
