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
 * before, Escape with focus in the band dismissing it. It reads the model's choice and the
 * frame's scene from the one store; the tests drive the model as a host and its tenants would.
 * Host-free: the host here is a trace.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { PageEdgeBand } = await import('../PageEdgeBand')
const { BAND_HEIGHT_ONE_LINE, BAND_HEIGHT_TWO_LINE } = await import('@renderer/lib/motion/band')
const { framesPending } = await import('@renderer/lib/motion/clock')
const {
  bandHeightOf,
  bandStore,
  chooseBand,
  dismissBand: dismiss,
  resetBands,
  setBandFrame,
  showBand: show
} = await import('@renderer/lib/band')
type BandOptions = Parameters<typeof show>[0]

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
  /** Take-holds heard, each with how many offsets had arrived by then. */
  dragStarts: number[]
}

let root: Root | null = null
let mountEl: HTMLDivElement | null = null
let host: HostTrace
let frames: ReturnType<typeof clockedFrames>

/** Mount the band on the trace host; from here the model drives it. */
function mount(wordless = false): void {
  act(() => {
    root!.render(
      createElement(PageEdgeBand, {
        host: {
          translate: (o) => host.offsets.push(o),
          rest: (h) => host.rests.push(h),
          depart: (to) => host.departs.push(to),
          // A host with the optional words left out (Android's today) is served the same.
          ...(wordless ? {} : { dragStart: () => host.dragStarts.push(host.offsets.length) })
        }
      })
    )
  })
}

const MOUSE = 7
const HOLD = { x: 200, y: 30 }

/**
 * A mouse on the band, as `useSwipeDismiss` hears it: `down` takes hold where the band is,
 * `move(dy)` is the pointer `dy` px (negative up) from there, `up` lets go. happy-dom has no
 * pointer capture, so the band's take and release of it are stubbed not to throw.
 */
function mouse(): { down: () => void; move: (dy: number) => void; up: (dy: number) => void } {
  const captured = new Set<number>()
  const at = (type: string, dy: number): void => {
    const el = band()!
    el.setPointerCapture = (id: number) => {
      captured.add(id)
    }
    el.releasePointerCapture = (id: number) => {
      captured.delete(id)
    }
    el.hasPointerCapture = (id: number) => captured.has(id)
    act(() => {
      el.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: MOUSE,
          pointerType: 'mouse',
          button: 0,
          clientX: HOLD.x,
          clientY: HOLD.y + dy
        })
      )
    })
  }
  return {
    down: () => at('pointerdown', 0),
    move: (dy) => at('pointermove', dy),
    up: (dy) => at('pointerup', dy)
  }
}

/** The model's mutations, as the tenants and the host make them, flushed into the band. */
function showBand(opts: BandOptions): number {
  let id = 0
  act(() => {
    id = show(opts)
  })
  return id
}
function dismissBand(id: number, reason?: BandDismissReason): void {
  act(() => dismiss(id, reason))
}
function frame(front: string, ok: boolean): void {
  act(() => setBandFrame({ front, ok }))
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
const band = (): HTMLElement | null => mountEl!.querySelector('.zen-band')
const content = (): HTMLElement | null =>
  mountEl!.querySelector('.zen-band-content:not([data-leaving])')

const defaultBrowser = (onDismiss?: (r: BandDismissReason) => void): number =>
  showBand({
    key: 'default-browser',
    form: 'state',
    icon: Globe,
    title: 'Make Zenium your default browser',
    action: { label: 'Set as default', onPick: () => undefined, holds: true },
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
  host = { offsets: [], rests: [], departs: [], dragStarts: [] }
  resetBands()
  setBandFrame({ front: 't1', ok: true })
  mountEl = document.createElement('div')
  document.body.appendChild(mountEl)
  root = createRoot(mountEl)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  mountEl?.remove()
  resetBands()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('PageEdgeBand – the band’s content and its seam (motion spec §3)', () => {
  it('draws nothing with no prompt; with one, a role="status" region of the page family carrying the form and the height', () => {
    mount()
    expect(band()).toBeNull()
    expect(host.offsets).toEqual([])
    defaultBrowser()
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
    // The × is "Dismiss" on every band, a prompt's too (the lead's ruling on #740).
    expect(el.querySelector('.zen-band-close')!.getAttribute('aria-label')).toBe('Dismiss')
    expect(el.querySelector('.zen-band-glyph')!.getAttribute('aria-hidden')).toBe('true')
  })

  it('a two-line prompt is the 76 band with its detail; a state’s tone reaches the glyph’s ink; the × says "Dismiss", as on every band', () => {
    mount()
    offline()
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
    mount()
    defaultBrowser()
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
    mount()
    const id = defaultBrowser()
    settle()
    dismissBand(id)
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
    mount()
    defaultBrowser()
    settle()
    const restsBefore = host.rests.length
    const offsetsBefore = host.offsets.length
    offline()
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
    mount()
    defaultBrowser((r) => reasons.push(r))
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
    settle()
    expect(band()).toBeNull()

    const again: BandDismissReason[] = []
    defaultBrowser((r) => again.push(r))
    settle()
    act(() => {
      band()!.querySelector<HTMLButtonElement>('.zen-band-close')!.click()
    })
    expect(again).toEqual(['close'])
  })

  it('the scene changing under the band is a cut, not a travel: the band stands or goes at once, the seam hearing depart, translate, paint, rest in order', () => {
    // A window-wide state stands on t1; the frame switches to a tab without one (a chrome
    // page, say): the band is gone at once, the page of the next tab never travelling for it.
    mount()
    defaultBrowser()
    settle()
    expect(host.rests).toEqual([BAND_HEIGHT_ONE_LINE])
    const heard = host.offsets.length
    frame('t2', false)
    expect(band()).toBeNull()
    expect(host.departs.at(-1)).toBe(0)
    expect(host.offsets.slice(heard)).toEqual([0])
    expect(host.rests.at(-1)).toBe(0)
    expect(framesPending()).toBe(0)
    // Back to t1: the band stands again at once, its content fully present, no travel.
    frame('t1', true)
    expect(band()).not.toBeNull()
    expect(host.departs.at(-1)).toBe(BAND_HEIGHT_ONE_LINE)
    expect(host.offsets.at(-1)).toBe(BAND_HEIGHT_ONE_LINE)
    expect(host.rests.at(-1)).toBe(BAND_HEIGHT_ONE_LINE)
    expect(content()!.style.opacity).toBe('1.000')
    expect(framesPending()).toBe(0)
    // The same scene, a new tenant: that is a travel again (the re-target through the host).
    offline()
    expect(framesPending()).toBeGreaterThan(0)
    settle()
    expect(host.rests.at(-1)).toBe(BAND_HEIGHT_TWO_LINE)
  })

  it('a mouse taking hold of the band reaches the host as dragStart once, before the drag’s first frame – mid-travel too – and the release names its destination (depart) as any travel does; a host without the word is served the same', () => {
    mount()
    defaultBrowser()
    settle()
    const m = mouse()
    // Taking hold moves nothing: the pointer has not left the slop circle.
    m.down()
    expect(host.dragStarts).toEqual([])
    const heard = host.offsets.length
    // The first frame: the take-hold first, then the frame – one word for the whole drag.
    m.move(-20)
    expect(host.dragStarts).toEqual([heard])
    expect(host.offsets.slice(heard)).toEqual([BAND_HEIGHT_ONE_LINE - 20])
    m.move(-25)
    expect(host.dragStarts).toEqual([heard])
    expect(host.offsets.at(-1)).toBe(BAND_HEIGHT_ONE_LINE - 25)
    // Let go at 31 of 56, short of half: the return departs toward the height, and rests there.
    const departs = host.departs.length
    m.up(-25)
    expect(host.departs.slice(departs)).toEqual([BAND_HEIGHT_ONE_LINE])
    settle()
    expect(host.rests.at(-1)).toBe(BAND_HEIGHT_ONE_LINE)
    // Mid-travel: a taller tenant re-targets the band toward 76; the hand takes it after three
    // frames – the word between the travel's last frame and the drag's first.
    offline()
    frames.tick(3)
    const caught = host.offsets.length
    expect(framesPending()).toBeGreaterThan(0)
    m.down()
    m.move(-20)
    expect(framesPending()).toBe(0)
    expect(host.dragStarts).toEqual([heard, caught])
    expect(host.offsets.slice(caught)).toEqual([BAND_HEIGHT_TWO_LINE - 20])
    m.up(-20)
    settle()
    expect(host.rests.at(-1)).toBe(BAND_HEIGHT_TWO_LINE)
    // Without the word on the host: the same drag, nothing thrown, nothing heard of it.
    act(() => root!.unmount())
    resetBands()
    setBandFrame({ front: 't1', ok: true })
    root = createRoot(mountEl!)
    host = { offsets: [], rests: [], departs: [], dragStarts: [] }
    mount(true)
    defaultBrowser()
    settle()
    const w = mouse()
    w.down()
    w.move(-20)
    expect(host.dragStarts).toEqual([])
    expect(host.offsets.at(-1)).toBe(BAND_HEIGHT_ONE_LINE - 20)
    w.up(-20)
    settle()
    expect(host.rests.at(-1)).toBe(BAND_HEIGHT_ONE_LINE)
  })

  it('a tab-scoped band goes with its tab and stands again with it at once; a band arriving on the next tab travels in; a window-wide one stays through the switch', () => {
    mount()
    const t1 = showBand({
      key: 'install',
      form: 'offer',
      tabId: 't1',
      icon: Globe,
      title: 'Install Example'
    })
    settle()
    expect(host.rests).toEqual([BAND_HEIGHT_ONE_LINE])
    // t2 to the front: t1's offer is cut away, t2 has nothing.
    frame('t2', true)
    expect(band()).toBeNull()
    expect(host.rests.at(-1)).toBe(0)
    expect(framesPending()).toBe(0)
    // A prompt arriving on t2 is a travel: this page has not moved for it yet.
    const t2 = showBand({ key: 'reader', form: 'offer', tabId: 't2', icon: Globe, title: 'Reader' })
    expect(framesPending()).toBeGreaterThan(0)
    settle()
    expect(host.rests.at(-1)).toBe(BAND_HEIGHT_ONE_LINE)
    // Back to t1: t1's offer stands again at once (the model keeps it; its scene changed).
    const heard = host.offsets.length
    frame('t1', true)
    expect(chooseBand(bandStore.get())!.id).toBe(t1)
    expect(content()!.querySelector('.zen-band-title')!.textContent).toBe('Install Example')
    expect(host.offsets.slice(heard)).toEqual([BAND_HEIGHT_ONE_LINE])
    expect(framesPending()).toBe(0)
    // A window-wide state arrives (a travel to 76), then the switch to t2: the same prompt stands
    // on both – no cut, no travel, nothing heard.
    offline()
    settle()
    const before = { offsets: host.offsets.length, rests: host.rests.length }
    frame('t2', true)
    expect(content()!.querySelector('.zen-band-title')!.textContent).toBe('You are offline')
    expect(host.offsets).toHaveLength(before.offsets)
    expect(host.rests).toHaveLength(before.rests)
    expect(framesPending()).toBe(0)
    // Dismissed here, it leaves with a travel: the page is this one all along.
    dismissBand(chooseBand(bandStore.get())!.id)
    expect(framesPending()).toBeGreaterThan(0)
    settle()
    // t2's own offer stands again under it – the one travel's rest is its height.
    expect(chooseBand(bandStore.get())!.id).toBe(t2)
    expect(host.rests.at(-1)).toBe(BAND_HEIGHT_ONE_LINE)
  })

  it('unmounting disposes the motion: the clock goes idle and the host hears nothing more', () => {
    mount()
    defaultBrowser()
    frames.tick(2)
    const heard = host.offsets.length
    act(() => root!.unmount())
    root = createRoot(mountEl!)
    expect(framesPending()).toBe(0)
    frames.tick(3)
    expect(host.offsets).toHaveLength(heard)
  })
})
