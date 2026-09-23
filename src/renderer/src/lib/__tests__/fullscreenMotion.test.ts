// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bindFullscreenAway,
  bringChromeBack,
  FULLSCREEN_AWAY_TRAVEL,
  fullscreenAwayStore,
  settleChromeAway,
  slideChromeAway
} from '../fullscreenMotion'
import { SPRING_SNAPPY } from '../motion/spring'

/*
 * The phone bar around a page's fullscreen (MOT-32, design language v2 §11.5): the chrome stays
 * mounted and the bar translates off its edge as the system bars slide away, and back onto it
 * as they return, on one spring – `SPRING_SNAPPY`, the bar hide's snap, the one the host's
 * reveal of the fullscreen layer runs on too. The value is written per frame on the bound bar
 * element itself as `--zen-fullscreen-away`, never on the root (PERF-2's H3), where main.css
 * registers it as the element's own property and composes it into the bar's transform with the
 * hide's. Under reduced motion the spring jumps: the bar is off, or back, at once.
 */

const VAR = '--zen-fullscreen-away'
const root = (): HTMLElement => document.documentElement
const read = (el: HTMLElement): string => el.style.getPropertyValue(VAR)

let frames: Array<(now: number) => void> = []
let now = 1000
const tick = (): void => {
  now += 16
  for (const cb of frames.splice(0)) cb(now)
}
/** Runs the spring to its rest: the phase leaves `leaving` / `returning`. Returns the frames it took. */
function settle(): number {
  let n = 0
  const moving = (): boolean => ['leaving', 'returning'].includes(fullscreenAwayStore.get().phase)
  while (moving() && n < 200) {
    tick()
    n++
  }
  expect(moving(), 'the spring came to rest').toBe(false)
  return n
}

function mountBar(): { bar: HTMLElement; release: () => void } {
  const bar = document.createElement('nav')
  bar.className = 'zen-phone-bar'
  document.body.appendChild(bar)
  const unbind = bindFullscreenAway(bar)
  return {
    bar,
    release: () => {
      unbind()
      bar.remove()
    }
  }
}

describe('the bar around a page’s fullscreen', () => {
  const releases: Array<() => void> = []

  beforeEach(() => {
    frames = []
    now = 1000
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.splice(id - 1, 1)
    })
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    settleChromeAway(false)
  })

  afterEach(() => {
    settleChromeAway(false)
    for (const r of releases.splice(0)) r()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    expect(fullscreenAwayStore.get()).toEqual({ progress: 0, phase: 'home' })
  })

  it('slides off on the spring, the value on the bar alone and monotonic, and rests away at 1', () => {
    const { bar, release } = mountBar()
    releases.push(release)
    expect(read(bar)).toBe('')
    slideChromeAway()
    expect(fullscreenAwayStore.get()).toEqual({ progress: 0, phase: 'leaving' })
    let last = 0
    let moved = 0
    while (fullscreenAwayStore.get().phase === 'leaving' && moved < 200) {
      tick()
      moved++
      const value = Number(read(bar))
      expect(value).toBeGreaterThanOrEqual(last)
      expect(value).toBeLessThanOrEqual(1)
      expect(root().style.getPropertyValue(VAR), 'the root carries nothing').toBe('')
      last = value
    }
    // A spring, not a cut: several frames on the way.
    expect(moved).toBeGreaterThan(3)
    expect(fullscreenAwayStore.get()).toEqual({ progress: 1, phase: 'away' })
    expect(read(bar)).toBe('1.0000')
    // Away is a rest: no frame is asked for.
    expect(frames).toEqual([])
  })

  it('comes back on the same spring and leaves the bar bare at home', () => {
    const { bar, release } = mountBar()
    releases.push(release)
    slideChromeAway()
    settle()
    bringChromeBack()
    expect(fullscreenAwayStore.get().phase).toBe('returning')
    let last = 1
    while (fullscreenAwayStore.get().phase === 'returning') {
      tick()
      const value = Number(read(bar) || '0')
      expect(value).toBeLessThanOrEqual(last)
      last = value
    }
    expect(fullscreenAwayStore.get()).toEqual({ progress: 0, phase: 'home' })
    // At home the property is gone from the element: the stylesheet's initial 0 stands.
    expect(read(bar)).toBe('')
  })

  it('turns back mid-flight from where it is, keeping its motion', () => {
    const { bar, release } = mountBar()
    releases.push(release)
    slideChromeAway()
    tick()
    tick()
    tick()
    const partWay = Number(read(bar))
    expect(partWay).toBeGreaterThan(0)
    expect(partWay).toBeLessThan(1)
    bringChromeBack()
    // No jump at the turn: the first frame back sets out from the part way (the spring still
    // carries its outward velocity, so it may go on a hair before it turns).
    expect(fullscreenAwayStore.get().progress).toBeCloseTo(partWay, 4)
    tick()
    expect(Math.abs(Number(read(bar)) - partWay)).toBeLessThan(0.2)
    settle()
    expect(fullscreenAwayStore.get()).toEqual({ progress: 0, phase: 'home' })
  })

  it('asks the way it is already going for nothing more', () => {
    const { release } = mountBar()
    releases.push(release)
    slideChromeAway()
    tick()
    const before = fullscreenAwayStore.get()
    slideChromeAway()
    expect(fullscreenAwayStore.get()).toBe(before)
    settle()
    bringChromeBack()
    bringChromeBack()
    settle()
    bringChromeBack()
    expect(fullscreenAwayStore.get()).toEqual({ progress: 0, phase: 'home' })
  })

  it('an element bound mid-flight carries the value at once, and an unbound one is left bare', () => {
    const { bar, release } = mountBar()
    releases.push(release)
    slideChromeAway()
    tick()
    tick()
    const late = document.createElement('div')
    const unbindLate = bindFullscreenAway(late)
    expect(read(late)).toBe(read(bar))
    tick()
    expect(read(late)).toBe(read(bar))
    unbindLate()
    expect(read(late)).toBe('')
    tick()
    expect(read(late)).toBe('')
    settle()
  })

  it('a settle puts the bar where it is told at once, mid-flight too', () => {
    const { bar, release } = mountBar()
    releases.push(release)
    slideChromeAway()
    tick()
    settleChromeAway(false)
    expect(fullscreenAwayStore.get()).toEqual({ progress: 0, phase: 'home' })
    expect(read(bar)).toBe('')
    expect(frames).toEqual([])
    settleChromeAway(true)
    expect(fullscreenAwayStore.get()).toEqual({ progress: 1, phase: 'away' })
    expect(read(bar)).toBe('1.0000')
  })

  it('runs over the spring’s px-sized rest so the curve is the bar hide snap’s', () => {
    // The progress is the spring's share of a fixed travel: its rest thresholds are in px, and
    // a linear spring's curve from rest is the same over any distance – the host's reveal, on
    // the same stiffness and damping over its own device px, keeps pace.
    expect(FULLSCREEN_AWAY_TRAVEL).toBe(100)
    expect(SPRING_SNAPPY).toMatchObject({ stiffness: 420, damping: 40 })
  })
})

describe('the bar around a page’s fullscreen under reduced motion', () => {
  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) => ({ matches: query.includes('reduce') }) as MediaQueryList
    )
    settleChromeAway(false)
  })

  afterEach(() => {
    settleChromeAway(false)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('jumps: off at once, back at once, no frame asked for', () => {
    const bar = document.createElement('nav')
    const unbind = bindFullscreenAway(bar)
    slideChromeAway()
    expect(fullscreenAwayStore.get()).toEqual({ progress: 1, phase: 'away' })
    expect(read(bar)).toBe('1.0000')
    expect(frames).toEqual([])
    bringChromeBack()
    expect(fullscreenAwayStore.get()).toEqual({ progress: 0, phase: 'home' })
    expect(read(bar)).toBe('')
    expect(frames).toEqual([])
    unbind()
  })
})

describe('the stylesheet', () => {
  it('registers the value as the bar’s own property and sums it into the bar’s one transform', () => {
    const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8').replace(
      /\s+/g,
      ' '
    )
    // `inherits: false`: a frame's write recalculates the bar's style and nothing else's.
    expect(css).toContain(
      "@property --zen-fullscreen-away { syntax: '<number>'; inherits: false; initial-value: 0; }"
    )
    // 100 % of the bar's own box – which hangs its inset padding past the clip line – is the
    // whole bar past that line, whatever the inset stands at while the system bars move.
    expect(css).toContain(
      ".zen-phone-bar[data-edge='bottom'] { transform: translate3d( 0, calc(var(--zen-bar-hide) * var(--zen-bar-hide-travel) + var(--zen-fullscreen-away) * 100%), 0 ); }"
    )
    expect(css).toContain(
      ".zen-phone-bar[data-edge='top'] { transform: translate3d( 0, calc(-1 * var(--zen-bar-hide) * var(--zen-bar-hide-travel) - var(--zen-fullscreen-away) * 100%), 0 ); }"
    )
    // No rule reads the value off anything but the bar: nothing else recalculates on a frame.
    const readers = css.match(/[^{}]*\{[^}]*var\(--zen-fullscreen-away\)[^}]*\}/g) ?? []
    expect(readers.length).toBeGreaterThan(0)
    for (const rule of readers) expect(rule).toMatch(/\.zen-phone-bar\[data-edge='(bottom|top)'\]/)
  })
})
