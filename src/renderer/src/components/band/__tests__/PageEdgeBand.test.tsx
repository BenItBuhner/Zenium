// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Globe, WifiOff } from 'lucide-react'
import type { BandDismissReason, BandEntry } from '@renderer/lib/band'

/*
 * The page-edge band's React content (motion spec §3.1–3.2): `[glyph] Title · detail [Action]
 * [×]` in a `role="status"` region, the page moved through the host's seam on the one clock,
 * the content's opacity written straight to the element, a swap cross-fading over the one
 * before, Escape with focus in the band dismissing it. Host-free: the host here is a trace.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { PageEdgeBand } = await import('../PageEdgeBand')
const { BAND_HEIGHT_ONE_LINE, BAND_HEIGHT_TWO_LINE } = await import('@renderer/lib/motion/band')
const { framesPending } = await import('@renderer/lib/motion/clock')
const { bandHeightOf, bandStore, chooseBand, dismissBand, resetBands, setBandFront, showBand } =
  await import('@renderer/lib/band')

const FRAME_MS = 16

/** The host's animation frame with a clock: `tick()` fires the frames in flight 16 ms later. */
function clockedFrames(): { pending: () => number; tick: (n?: number) => void } {
  const pending = new Map<number, FrameRequestCallback>()
  let id = 0
  let now = 1000
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    pending.set(++id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (n: number) => pending.delete(n))
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  return {
    pending: () => pending.size,
    tick: (n = 1) => {
      for (let i = 0; i < n; i++) {
        now += FRAME_MS
        const batch = [...pending.values()]
        pending.clear()
        act(() => {
          for (const cb of batch) cb(now)
        })
      }
    }
  }
}

interface HostTrace {
  offsets: number[]
  rests: number[]
  departs: number[]
}

let root: Root | null = null
let mount: HTMLDivElement | null = null
let host: HostTrace
let frames: ReturnType<typeof clockedFrames>

function render(entry: BandEntry | null): void {
  act(() => {
    root!.render(
      createElement(PageEdgeBand, {
        entry,
        host: {
          translate: (o) => host.offsets.push(o),
          rest: (h) => host.rests.push(h),
          depart: (to) => host.departs.push(to)
        }
      })
    )
  })
}

/** Run the clock until it goes idle (the spring rested) or `limit` frames pass. */
function settle(limit = 200): number {
  let n = 0
  while (framesPending() > 0 && n < limit) {
    frames.tick()
    n++
  }
  return n
}

const shown = (): BandEntry | null => chooseBand(bandStore.get())
const band = (): HTMLElement | null => mount!.querySelector('.zen-band')
const content = (): HTMLElement | null =>
  mount!.querySelector('.zen-band-content:not([data-leaving])')

const defaultBrowser = (onDismiss?: (r: BandDismissReason) => void): number =>
  showBand({
    key: 'default-browser',
    form: 'state',
    icon: Globe,
    title: 'Make Zenium your default browser',
    action: { label: 'Set as default', onPick: () => undefined, holds: true },
    closeLabel: 'Not now',
    onDismiss
  })

const offline = (): number =>
  showBand({
    key: 'connectivity',
    form: 'state',
    tone: 'warn',
    icon: WifiOff,
    title: 'You are offline',
    detail: 'Pages you open may be out of date'
  })

beforeEach(() => {
  vi.useFakeTimers()
  frames = clockedFrames()
  host = { offsets: [], rests: [], departs: [] }
  resetBands()
  setBandFront('t1', true)
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  mount?.remove()
  resetBands()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('PageEdgeBand – the band’s content and its seam (motion spec §3)', () => {
  it('draws nothing with no prompt; with one, a role="status" region of the page family carrying the form and the height', () => {
    render(null)
    expect(band()).toBeNull()
    expect(host.offsets).toEqual([])
    defaultBrowser()
    render(shown())
    const el = band()!
    expect(el.getAttribute('role')).toBe('status')
    expect(el.dataset.surface).toBe('page')
    expect(el.dataset.form).toBe('state')
    expect(el.dataset.tone).toBeUndefined()
    expect(el.style.getPropertyValue('--zen-band-height')).toBe(`${BAND_HEIGHT_ONE_LINE}px`)
    expect(el.querySelector('.zen-band-title')!.textContent).toBe(
      'Make Zenium your default browser'
    )
    expect(el.querySelector('.zen-band-detail')).toBeNull()
    expect(el.querySelector('.zen-band-button')!.textContent).toBe('Set as default')
    expect(el.querySelector('.zen-band-close')!.getAttribute('aria-label')).toBe('Not now')
    expect(el.querySelector('.zen-band-glyph')!.getAttribute('aria-hidden')).toBe('true')
  })

  it('a two-line prompt is the 76 band with its detail; a state’s tone reaches the glyph’s ink; the × says "Dismiss" unless told', () => {
    offline()
    render(shown())
    const el = band()!
    expect(bandHeightOf(shown()!)).toBe(BAND_HEIGHT_TWO_LINE)
    expect(el.style.getPropertyValue('--zen-band-height')).toBe(`${BAND_HEIGHT_TWO_LINE}px`)
    expect(el.dataset.detail).toBe('')
    expect(el.dataset.tone).toBe('warn')
    expect(el.querySelector('.zen-band-detail')!.textContent).toBe(
      'Pages you open may be out of date'
    )
    expect(el.querySelector('.zen-band-button')).toBeNull()
    expect(el.querySelector('.zen-band-close')!.getAttribute('aria-label')).toBe('Dismiss')
  })

  it('opens through the host: depart(height) before the first frame, the page’s offset per frame on the clock, the content from 0 to 1 over the last of the travel, one rest at the height', () => {
    defaultBrowser()
    render(shown())
    expect(host.departs).toEqual([BAND_HEIGHT_ONE_LINE])
    expect(host.offsets).toEqual([])
    expect(content()!.style.opacity).toBe('0.000')
    frames.tick(4)
    expect(host.offsets).toHaveLength(4)
    expect(host.offsets[3]).toBeGreaterThan(host.offsets[0])
    expect(content()!.style.opacity).toBe('0.000')
    settle()
    expect(host.rests).toEqual([BAND_HEIGHT_ONE_LINE])
    expect(host.offsets.at(-1)).toBe(BAND_HEIGHT_ONE_LINE)
    expect(content()!.style.opacity).toBe('1.000')
    expect(band()).not.toBeNull()
  })

  it('the prompt going: depart(0), the page travels back up, the content fades first, and the band is gone at the rest', () => {
    const id = defaultBrowser()
    render(shown())
    settle()
    dismissBand(id)
    render(shown())
    expect(host.departs.at(-1)).toBe(0)
    expect(band()).not.toBeNull()
    frames.tick(8)
    expect(content()!.style.opacity).toBe('0.000')
    expect(band()).not.toBeNull()
    settle()
    expect(host.rests.at(-1)).toBe(0)
    expect(host.offsets.at(-1)).toBe(0)
    expect(band()).toBeNull()
  })

  it('a new tenant on an open band: the old content leaves (aria-hidden, inert) under the new one’s cross-fade, the height re-targets through the host, and the page never travels twice', () => {
    defaultBrowser()
    render(shown())
    settle()
    const restsBefore = host.rests.length
    const offsetsBefore = host.offsets.length
    offline()
    render(shown())
    const el = band()!
    expect(el.dataset.form).toBe('state')
    expect(el.style.getPropertyValue('--zen-band-height')).toBe(`${BAND_HEIGHT_TWO_LINE}px`)
    expect(content()!.querySelector('.zen-band-title')!.textContent).toBe('You are offline')
    // The one leaving is drawn first, under the one arriving.
    const leaving = el.firstElementChild as HTMLElement
    expect(leaving.dataset.leaving).toBe('')
    expect(leaving.getAttribute('aria-hidden')).toBe('true')
    expect(leaving.querySelector('.zen-band-title')!.textContent).toBe(
      'Make Zenium your default browser'
    )
    expect(leaving.querySelector('button')!.tabIndex).toBe(-1)
    expect(content()!.dataset.swap).toBe('')
    expect(content()!.style.opacity).toBe('1.000')
    expect(host.departs.at(-1)).toBe(BAND_HEIGHT_TWO_LINE)
    settle()
    expect(host.rests.slice(restsBefore)).toEqual([BAND_HEIGHT_TWO_LINE])
    // From 56 straight to 76: the page never came back toward the edge for the second tenant.
    const travel = host.offsets.slice(offsetsBefore)
    expect(travel.length).toBeGreaterThan(0)
    expect(Math.min(...travel)).toBeGreaterThanOrEqual(BAND_HEIGHT_ONE_LINE - 1)
    expect(travel.at(-1)).toBe(BAND_HEIGHT_TWO_LINE)
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(band()!.querySelector('.zen-band-content[data-leaving]')).toBeNull()
  })

  it('the × dismisses on "close", the action on "action" (held through an act that holds); Escape with focus in the band dismisses on "escape"', () => {
    const reasons: BandDismissReason[] = []
    defaultBrowser((r) => reasons.push(r))
    render(shown())
    settle()
    act(() => {
      band()!.querySelector<HTMLButtonElement>('.zen-band-button')!.click()
    })
    expect(reasons).toEqual([])
    expect(shown()).not.toBeNull()
    act(() => {
      const close = band()!.querySelector<HTMLButtonElement>('.zen-band-close')!
      close.focus()
      close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(reasons).toEqual(['escape'])
    expect(shown()).toBeNull()
    render(shown())
    settle()
    expect(band()).toBeNull()

    const again: BandDismissReason[] = []
    defaultBrowser((r) => again.push(r))
    render(shown())
    settle()
    act(() => {
      band()!.querySelector<HTMLButtonElement>('.zen-band-close')!.click()
    })
    expect(again).toEqual(['close'])
  })

  it('unmounting disposes the motion: the clock goes idle and the host hears nothing more', () => {
    defaultBrowser()
    render(shown())
    frames.tick(2)
    const heard = host.offsets.length
    act(() => root!.unmount())
    root = createRoot(mount!)
    expect(framesPending()).toBe(0)
    frames.tick(3)
    expect(host.offsets).toHaveLength(heard)
  })
})
