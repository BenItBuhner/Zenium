// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LevelMotion, paintLevels } from '../motion/levels'

/** A hand-cranked animation frame: 16 ms a step, the spring followed to rest. */
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
    vi.spyOn(performance, 'now').mockImplementation(() => this.now)
    window.matchMedia = () =>
      ({ matches: false, addEventListener: () => undefined }) as unknown as MediaQueryList
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) {
      this.now += 16
      const pending = [...this.queue.values()]
      this.queue.clear()
      for (const cb of pending) cb(this.now)
    }
  }
}

const WIDTH = 360

/**
 * The painter alone, on real elements (the sheet's own test, `siteInfoLevels.test.tsx`, drives
 * it through the component): seed 51's contract is that the pane travelling on top is painted
 * whole from its first frame, and that nothing the panes carry is reachable while it is away.
 */
describe('paintLevels', () => {
  const frames = new Frames()
  let levels: LevelMotion
  let panes: Map<string, HTMLElement>

  const pane = (id: string, text: string): HTMLElement => {
    const el = document.createElement('section')
    el.dataset.level = id
    const button = document.createElement('button')
    button.textContent = text
    el.append(button)
    document.body.append(el)
    return el
  }
  const paint = (): void => paintLevels(levels, panes, WIDTH)
  const x = (el: HTMLElement): number => {
    const m = /translate3d\((-?[\d.]+)px/.exec(el.style.transform)
    return m ? Number(m[1]) : 0
  }

  beforeEach(() => {
    frames.install()
    document.body.innerHTML = ''
    panes = new Map([
      ['main', pane('main', 'Connection')],
      ['connection', pane('connection', 'Certificate')]
    ])
    levels = new LevelMotion('main', paint)
    paint()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('at rest shows the current pane alone; every other pane is hidden and bare', () => {
    const main = panes.get('main')!
    const connection = panes.get('connection')!
    expect(main.hidden).toBe(false)
    expect(main.style.opacity).toBe('')
    expect(main.style.transform).toBe('')
    expect(main.hasAttribute('aria-hidden')).toBe(false)
    expect(main.hasAttribute('data-over')).toBe(false)
    expect(connection.hidden).toBe(true)
    expect(connection.hasAttribute('aria-hidden')).toBe(false)
    expect(connection.hasAttribute('data-leaving')).toBe(false)
  })

  it('paints the arriving pane whole, with its content, from the first frame of a push (seed 51)', () => {
    const connection = panes.get('connection')!
    levels.push('connection')
    // The synchronous first frame: t = 0, the pane parked at the trailing edge – on top, opaque.
    expect(levels.current.t).toBe(0)
    expect(connection.hidden).toBe(false)
    expect(connection.hasAttribute('data-over')).toBe(true)
    expect(connection.style.opacity).toBe('')
    expect(x(connection)).toBe(WIDTH)
    expect(connection.textContent).toBe('Certificate')
    expect(connection.hasAttribute('aria-hidden')).toBe(false)
    // Every frame of the travel keeps it opaque; it only moves.
    const seen: number[] = []
    for (let i = 0; i < 6; i++) {
      frames.run(1)
      expect(connection.style.opacity).toBe('')
      seen.push(x(connection))
    }
    expect(seen.every((v, i) => i === 0 || v < seen[i - 1])).toBe(true)
    expect(connection.hasAttribute('data-leaving')).toBe(false)
  })

  it('lays the leaving pane over the track, out of the reader from its first frame, shifted a third at most and dimmed no lower than half', () => {
    const main = panes.get('main')!
    levels.push('connection')
    expect(main.hasAttribute('data-leaving')).toBe(true)
    expect(main.getAttribute('aria-hidden')).toBe('true')
    expect(Number(main.style.opacity)).toBe(1)
    let lowest = 1
    let farthest = 0
    for (let i = 0; i < 40; i++) {
      frames.run(1)
      if (main.hidden) break
      lowest = Math.min(lowest, Number(main.style.opacity))
      farthest = Math.max(farthest, -x(main))
    }
    expect(lowest).toBeGreaterThanOrEqual(0.5)
    expect(farthest).toBeGreaterThan(0)
    // The shift follows the spring, overshoot and all (§11); the dim alone is bounded.
    expect(farthest).toBeLessThanOrEqual(0.3 * WIDTH * 1.02)
  })

  it('at rest on the new level the pane that left is hidden and bare, the one shown untouched', () => {
    const main = panes.get('main')!
    const connection = panes.get('connection')!
    levels.push('connection')
    frames.run(80)
    expect(levels.current.phase).toBe('rest')
    expect(connection.hidden).toBe(false)
    expect(connection.hasAttribute('data-over')).toBe(false)
    expect(connection.style.transform).toBe('')
    expect(connection.style.willChange).toBe('')
    expect(main.hidden).toBe(true)
    expect(main.hasAttribute('data-leaving')).toBe(false)
    expect(main.hasAttribute('aria-hidden')).toBe(false)
    expect(main.style.opacity).toBe('')
  })

  it('a pop travels the deeper pane out on top, opaque, and the pane it reveals is in the reader from the first frame', () => {
    const main = panes.get('main')!
    const connection = panes.get('connection')!
    levels.push('connection')
    frames.run(80)
    levels.pop()
    expect(connection.hasAttribute('data-leaving')).toBe(true)
    expect(connection.hasAttribute('data-over')).toBe(true)
    expect(connection.getAttribute('aria-hidden')).toBe('true')
    expect(connection.style.opacity).toBe('')
    expect(main.hidden).toBe(false)
    expect(main.hasAttribute('aria-hidden')).toBe(false)
    expect(main.hasAttribute('data-leaving')).toBe(false)
    frames.run(2)
    expect(x(connection)).toBeGreaterThan(0)
    expect(connection.style.opacity).toBe('')
    expect(Number(main.style.opacity)).toBeGreaterThanOrEqual(0.5)
    frames.run(80)
    expect(levels.current.phase).toBe('rest')
    expect(main.style.opacity).toBe('')
    expect(connection.hidden).toBe(true)
  })
})
