// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FULLSCREEN_EXIT_HINT,
  fullscreenExitHint,
  TOAST_SHOW_MS,
  type PageHint
} from '../fullscreenHint'
import {
  fadeTo,
  installHint,
  renderHint,
  springTo,
  TOAST_INSET_PX,
  TOAST_REDUCED_FADE_MS,
  toastPresence
} from '../pageHint'
import { SPRING_GENTLE } from '../spring'

/*
 * The fullscreen hint's toast kind (GN-20): the phone chrome's §9.33 card drawn in the page,
 * along the bottom edge, moving on the shared springs – in on the gentle one, out on the
 * snappy one thinning with its travel – or fading in place under reduced motion (§11.3).
 */

/** Frames under the test's hand: each `tick` runs the callbacks queued so far at `now`. */
class Frames {
  private queue: Array<{ id: number; cb: (now: number) => void }> = []
  private seq = 0
  now = 1000
  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++this.seq
      this.queue.push({ id, cb })
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue = this.queue.filter((f) => f.id !== id)
    })
    vi.stubGlobal('performance', { now: () => this.now })
  }
  tick(ms = 16): void {
    this.now += ms
    const due = this.queue
    this.queue = []
    for (const f of due) f.cb(this.now)
  }
  get pending(): number {
    return this.queue.length
  }
}

let frames: Frames

beforeEach(() => {
  // The stand's timers are faked; the frames stay the test's own (a fake rAF would take them).
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  frames = new Frames()
  frames.install()
  document.documentElement.querySelectorAll('zenium-fullscreen-hint').forEach((el) => el.remove())
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function reduceMotion(on: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: on && query.includes('prefers-reduced-motion'),
      media: query
    })
  })
}

describe('the phone toast as a page hint', () => {
  it("is Chrome's exit hint, a toast without an action, standing for the chrome's 2.8 s", () => {
    expect(fullscreenExitHint(true)).toEqual({
      text: FULLSCREEN_EXIT_HINT,
      exit: null,
      duration: TOAST_SHOW_MS,
      dark: true,
      kind: 'toast'
    })
    expect(TOAST_SHOW_MS).toBe(2800)
    expect(FULLSCREEN_EXIT_HINT).toBe('Swipe down or press back to exit full screen')
  })

  it("lies 8 px inside the bottom edge and both sides, over everything, in no one's way", () => {
    const el = renderHint(fullscreenExitHint(false))
    expect(el.tagName.toLowerCase()).toBe('zenium-fullscreen-hint')
    expect(el.getAttribute('role')).toBe('status')
    expect(el.getAttribute('popover')).toBe('manual')
    expect(el.style.position).toBe('fixed')
    expect(el.style.top).toBe('auto')
    expect(el.style.bottom).toContain(`${TOAST_INSET_PX}px`)
    expect(el.style.bottom).toContain('safe-area-inset-bottom')
    expect(el.style.left).toBe(`${TOAST_INSET_PX}px`)
    expect(el.style.right).toBe(`${TOAST_INSET_PX}px`)
    expect(el.style.pointerEvents).toBe('none')
    expect(el.style.opacity).toBe('0')
    // The bubble keeps its place at the top and its fade.
    const bubble = renderHint({ text: 'a', exit: null, duration: 1, dark: false })
    expect(bubble.style.top).toBe('24px')
    expect(bubble.style.bottom).toBe('auto')
    expect(bubble.style.transition).toContain('opacity')
  })

  it("thins with its travel out, as the chrome's cards do", () => {
    expect(toastPresence(0, 52)).toBe(1)
    expect(toastPresence(26, 52)).toBe(0.5)
    expect(toastPresence(52, 52)).toBe(0)
    expect(toastPresence(60, 52)).toBe(0)
    expect(toastPresence(10, 0)).toBe(1)
  })

  it('springs from where it starts to its target and says when it is there', () => {
    const seen: number[] = []
    let done = 0
    springTo(
      100,
      0,
      SPRING_GENTLE,
      (x) => seen.push(x),
      () => done++
    )
    for (let i = 0; i < 200 && frames.pending > 0; i++) frames.tick()
    expect(done).toBe(1)
    expect(seen[0]).toBeLessThan(100)
    expect(seen.at(-1)).toBe(0)
    // Towards the target from the first frame; the gentle spring's hair of overshoot is allowed.
    expect(Math.min(...seen)).toBeGreaterThan(-5)
    expect(seen.length).toBeGreaterThan(10)
  })

  it('a cancelled spring stops where it is', () => {
    const seen: number[] = []
    let done = 0
    const cancel = springTo(
      100,
      0,
      SPRING_GENTLE,
      (x) => seen.push(x),
      () => done++
    )
    frames.tick()
    frames.tick()
    cancel()
    frames.tick()
    expect(seen).toHaveLength(2)
    expect(done).toBe(0)
  })

  it('fades over its time per frame', () => {
    const el = document.createElement('div')
    let done = 0
    fadeTo(el, 0, 1, TOAST_REDUCED_FADE_MS, () => done++)
    expect(el.style.opacity).toBe('0.000')
    frames.tick(60)
    expect(Number.parseFloat(el.style.opacity)).toBeCloseTo(0.5, 1)
    frames.tick(60)
    expect(el.style.opacity).toBe('1.000')
    expect(done).toBe(1)
  })

  it('comes in across the bottom edge, stands, goes back out thinning, and is gone', () => {
    reduceMotion(false)
    let listener: ((hint: PageHint | null) => void) | null = null
    installHint((l) => {
      listener = l
    })
    listener!(fullscreenExitHint(false))
    const el = document.documentElement.querySelector<HTMLElement>('zenium-fullscreen-hint')
    expect(el).not.toBeNull()
    // Off its edge by a card's length (its height, none in this DOM, plus the inset), fully opaque.
    expect(el!.style.transform).toBe(`translateY(${TOAST_INSET_PX.toFixed(2)}px)`)
    expect(el!.style.opacity).toBe('1')
    expect(el!.style.willChange).toContain('transform')
    for (let i = 0; i < 200 && frames.pending > 0; i++) frames.tick()
    expect(el!.style.transform).toBe('translateY(0.00px)')
    expect(el!.style.willChange).toBe('')
    // Its stand.
    vi.advanceTimersByTime(TOAST_SHOW_MS - 1)
    expect(el!.isConnected).toBe(true)
    vi.advanceTimersByTime(1)
    frames.tick()
    expect(el!.isConnected).toBe(true)
    expect(Number.parseFloat(el!.style.opacity)).toBeLessThan(1)
    for (let i = 0; i < 200 && frames.pending > 0; i++) frames.tick()
    expect(el!.isConnected).toBe(false)
  })

  it('takes its leave at the first touch on the page, from where it stands (MED-03)', () => {
    reduceMotion(false)
    let listener: ((hint: PageHint | null) => void) | null = null
    installHint((l) => {
      listener = l
    })
    const touch = (): void => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    }
    // A touch before any toast stands is nobody's.
    touch()
    listener!(fullscreenExitHint(false))
    const el = document.documentElement.querySelector<HTMLElement>('zenium-fullscreen-hint')!
    for (let i = 0; i < 200 && frames.pending > 0; i++) frames.tick()
    expect(el.style.transform).toBe('translateY(0.00px)')
    // Well inside its stand, the first touch starts the way out: the stand's timer is dropped.
    vi.advanceTimersByTime(TOAST_SHOW_MS / 2)
    touch()
    expect(vi.getTimerCount()).toBe(0)
    frames.tick()
    expect(Number.parseFloat(el.style.opacity)).toBeLessThan(1)
    expect(el.style.willChange).toContain('transform')
    // A second touch on the way out changes nothing.
    touch()
    for (let i = 0; i < 200 && frames.pending > 0; i++) frames.tick()
    expect(el.isConnected).toBe(false)
  })

  it('a touch on the way in turns it round where it is', () => {
    reduceMotion(false)
    let listener: ((hint: PageHint | null) => void) | null = null
    installHint((l) => {
      listener = l
    })
    listener!(fullscreenExitHint(false))
    const el = document.documentElement.querySelector<HTMLElement>('zenium-fullscreen-hint')!
    frames.tick()
    frames.tick()
    const partWay = Number.parseFloat(el.style.transform.slice('translateY('.length))
    expect(partWay).toBeGreaterThan(0)
    expect(partWay).toBeLessThan(TOAST_INSET_PX)
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    frames.tick()
    // Out again from part way, not from its rest: never past its landing first.
    const turned = Number.parseFloat(el.style.transform.slice('translateY('.length))
    expect(turned).toBeGreaterThan(partWay)
    expect(turned).toBeLessThan(TOAST_INSET_PX)
    for (let i = 0; i < 200 && frames.pending > 0; i++) frames.tick()
    expect(el.isConnected).toBe(false)
  })

  it('fades in place under reduced motion', () => {
    reduceMotion(true)
    let listener: ((hint: PageHint | null) => void) | null = null
    installHint((l) => {
      listener = l
    })
    listener!(fullscreenExitHint(true))
    const el = document.documentElement.querySelector<HTMLElement>('zenium-fullscreen-hint')!
    expect(el.style.transform).toBe('')
    expect(el.style.opacity).toBe('0.000')
    frames.tick(TOAST_REDUCED_FADE_MS)
    expect(el.style.opacity).toBe('1.000')
    vi.advanceTimersByTime(TOAST_SHOW_MS)
    frames.tick(TOAST_REDUCED_FADE_MS / 2)
    expect(Number.parseFloat(el.style.opacity)).toBeCloseTo(0.5, 1)
    frames.tick(TOAST_REDUCED_FADE_MS / 2)
    expect(el.isConnected).toBe(false)
  })

  it('a touch under reduced motion fades it out from where its fade in stands', () => {
    reduceMotion(true)
    let listener: ((hint: PageHint | null) => void) | null = null
    installHint((l) => {
      listener = l
    })
    listener!(fullscreenExitHint(true))
    const el = document.documentElement.querySelector<HTMLElement>('zenium-fullscreen-hint')!
    frames.tick(TOAST_REDUCED_FADE_MS / 2)
    expect(Number.parseFloat(el.style.opacity)).toBeCloseTo(0.5, 1)
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    frames.tick(TOAST_REDUCED_FADE_MS / 2)
    expect(Number.parseFloat(el.style.opacity)).toBeCloseTo(0.25, 1)
    frames.tick(TOAST_REDUCED_FADE_MS / 2)
    expect(el.isConnected).toBe(false)
  })

  it('a null hint takes it down at once, motion and all', () => {
    reduceMotion(false)
    let listener: ((hint: PageHint | null) => void) | null = null
    installHint((l) => {
      listener = l
    })
    listener!(fullscreenExitHint(false))
    const el = document.documentElement.querySelector('zenium-fullscreen-hint')!
    frames.tick()
    listener!(null)
    expect(el.isConnected).toBe(false)
    expect(frames.pending).toBe(0)
  })
})
