// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { QuitHoldState } from '@shared/types'
import { QUIT_HOLD_PANEL } from '@shared/quitHoldPanel'
import { CRASH_ERROR_CODE } from '@shared/zenPages'
import { pageCanPaint } from '@renderer/lib/quitHoldRoute'
import { QuitHoldNotice } from '../QuitHold'

/*
 * The chrome's own "Hold ⌘Q to quit" (session-08): the notice the page script paints over a
 * live page, drawn by the chrome where no live page is in the frame – a status block with the
 * ring and the chord's key cap, stepped from the hold's clock, kept 120 ms for its fade out.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Frames under the test's hand. */
class Frames {
  private queue: Array<{ id: number; cb: (now: number) => void }> = []
  private seq = 0
  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++this.seq
      this.queue.push({ id, cb })
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue = this.queue.filter((f) => f.id !== id)
    })
  }
  tick(): void {
    const due = this.queue
    this.queue = []
    for (const f of due) f.cb(Date.now())
  }
  get pending(): number {
    return this.queue.length
  }
}

let frames: Frames
let root: Root
let container: HTMLDivElement

function reduceMotion(on: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: on && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined
    })
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(50_000)
  frames = new Frames()
  frames.install()
  reduceMotion(false)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const hold = (startedAt = Date.now()): QuitHoldState => ({
  startedAt,
  durationMs: 1500,
  chord: '⌘Q'
})

function render(props: { hold: QuitHoldState | null; show: boolean }): void {
  act(() => root.render(createElement(QuitHoldNotice, props)))
}

const notice = (): HTMLElement | null => container.querySelector<HTMLElement>('.zen-quit-hold')

describe('the chrome’s Hold ⌘Q to quit', () => {
  it('draws nothing without a hold, and nothing while a live page draws the panel itself', () => {
    render({ hold: null, show: true })
    expect(notice()).toBeNull()
    render({ hold: hold(), show: false })
    expect(notice()).toBeNull()
  })

  it('draws over a page whose renderer is gone or hung – the page cannot paint, so the twin takes its position and the hold has its notice (C4)', () => {
    const crashed = { url: 'https://example.com/a', errorCode: CRASH_ERROR_CODE }
    const hung = { url: 'https://example.com/a', errorCode: null, unresponsive: true as const }
    for (const tab of [crashed, hung]) {
      // `ContentArea`: the page route holds only while the page can paint.
      const pageLive = pageCanPaint(tab)
      render({ hold: hold(), show: !pageLive })
      expect(notice()).not.toBeNull()
      expect(notice()!.getAttribute('aria-label')).toBe('Hold ⌘Q to quit')
      render({ hold: null, show: !pageLive })
      act(() => vi.advanceTimersByTime(QUIT_HOLD_PANEL.fadeMs))
      expect(notice()).toBeNull()
    }
  })

  it('draws over a hung page after the prompt’s Wait – Wait dismisses the prompt, it un-hangs nothing – and leaves as the page answers again (C4)', () => {
    // `Tabs.waitUnresponsive` deleted the prompt's mark; the monitor's own reading stands.
    const afterWait = { url: 'https://example.com/a', errorCode: null, hung: true as const }
    expect(pageCanPaint(afterWait)).toBe(false)
    render({ hold: hold(), show: !pageCanPaint(afterWait) })
    expect(notice()).not.toBeNull()
    expect(notice()!.querySelector('.zen-quit-hold-panel')).not.toBeNull()
    expect(notice()!.getAttribute('aria-label')).toBe('Hold ⌘Q to quit')
    // `Tabs.onResponsive`: the reading goes, the page paints its own notice, the twin fades.
    const answering = { url: 'https://example.com/a', errorCode: null }
    expect(pageCanPaint(answering)).toBe(true)
    render({ hold: hold(), show: !pageCanPaint(answering) })
    expect(notice()!.querySelector('.zen-quit-hold-panel')!.hasAttribute('data-leaving')).toBe(true)
    act(() => vi.advanceTimersByTime(QUIT_HOLD_PANEL.fadeMs))
    expect(notice()).toBeNull()
  })

  it('is a status block with the ring and the chord as a key cap, stepped from the hold’s clock', () => {
    render({ hold: hold(), show: true })
    const el = notice()!
    expect(el).not.toBeNull()
    expect(el.getAttribute('role')).toBe('status')
    expect(el.getAttribute('aria-live')).toBe('polite')
    expect(el.getAttribute('aria-label')).toBe('Hold ⌘Q to quit')
    expect(el.getAttribute('data-chord')).toBe('⌘Q')
    expect(el.textContent).toBe('Hold⌘Qto quit')
    expect(el.querySelector('kbd.zen-quit-hold-key')?.textContent).toBe('⌘Q')
    const ring = el.querySelector('svg.zen-quit-hold-ring')!
    expect(ring.getAttribute('width')).toBe(`${QUIT_HOLD_PANEL.glyphPx}`)
    expect(ring.getAttribute('aria-hidden')).toBe('true')
    expect(ring.querySelector('[data-track]')).not.toBeNull()
    const sweep = ring.querySelector('[data-sweep]')!
    const circumference = Number(sweep.getAttribute('stroke-dasharray'))
    expect(el.getAttribute('data-progress')).toBe('0.000')
    expect(Number(sweep.getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference, 6)
    vi.setSystemTime(50_000 + 750)
    act(() => frames.tick())
    expect(el.getAttribute('data-progress')).toBe('0.500')
    expect(Number(sweep.getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference / 2, 6)
    vi.setSystemTime(50_000 + 1500)
    act(() => frames.tick())
    expect(el.getAttribute('data-progress')).toBe('1.000')
    expect(frames.pending).toBe(0)
  })

  it('under reduced motion the ring still reads the live fraction: a readout of the key held, not an animation (§11.3)', () => {
    reduceMotion(true)
    render({ hold: hold(), show: true })
    const el = notice()!
    const sweep = el.querySelector('[data-sweep]')!
    const circumference = Number(sweep.getAttribute('stroke-dasharray'))
    vi.setSystemTime(50_000 + 750)
    act(() => frames.tick())
    expect(el.getAttribute('data-progress')).toBe('0.500')
    expect(Number(sweep.getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference / 2, 6)
    vi.setSystemTime(50_000 + 1200)
    act(() => frames.tick())
    expect(el.getAttribute('data-progress')).toBe('0.800')
  })

  it('stays 120 ms for its fade when the hold ends, then goes', () => {
    render({ hold: hold(), show: true })
    const panel = notice()!.querySelector('.zen-quit-hold-panel')!
    expect(panel.hasAttribute('data-leaving')).toBe(false)
    render({ hold: null, show: true })
    expect(notice()).not.toBeNull()
    expect(notice()!.querySelector('.zen-quit-hold-panel')!.hasAttribute('data-leaving')).toBe(true)
    act(() => vi.advanceTimersByTime(QUIT_HOLD_PANEL.fadeMs - 1))
    expect(notice()).not.toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(notice()).toBeNull()
  })

  it('a new hold during the fade stands at once, no longer leaving', () => {
    render({ hold: hold(), show: true })
    render({ hold: null, show: true })
    act(() => vi.advanceTimersByTime(60))
    vi.setSystemTime(Date.now() + 60)
    render({ hold: hold(), show: true })
    const panel = notice()!.querySelector('.zen-quit-hold-panel')!
    expect(panel.hasAttribute('data-leaving')).toBe(false)
    act(() => vi.advanceTimersByTime(QUIT_HOLD_PANEL.fadeMs))
    expect(notice()).not.toBeNull()
  })

  it('the page taking the panel over mid-hold ends the chrome’s copy with its fade', () => {
    const h = hold()
    render({ hold: h, show: true })
    render({ hold: h, show: false })
    expect(notice()!.querySelector('.zen-quit-hold-panel')!.hasAttribute('data-leaving')).toBe(true)
    act(() => vi.advanceTimersByTime(QUIT_HOLD_PANEL.fadeMs))
    expect(notice()).toBeNull()
  })
})
