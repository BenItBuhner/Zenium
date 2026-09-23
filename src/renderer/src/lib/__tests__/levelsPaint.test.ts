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

  it('at rest shows the current pane alone, the others hidden and inert', () => {
    const main = panes.get('main')!
    const connection = panes.get('connection')!
    expect(main.style.display).toBe('')
    expect(main.style.opacity).toBe('')
    expect(main.style.transform).toBe('')
    expect(main.getAttribute('aria-hidden')).toBe('false')
    expect(main.hasAttribute('inert')).toBe(false)
    expect(connection.style.display).toBe('none')
    expect(connection.getAttribute('aria-hidden')).toBe('true')
    expect(connection.hasAttribute('inert')).toBe(true)
  })

  it('paints the arriving pane with its content from the first frame of a push (seed 51)', () => {
    const connection = panes.get('connection')!
    levels.push('connection')
    // The synchronous first frame: t = 0, the pane parked at the trailing edge – and opaque.
    expect(levels.current.t).toBe(0)
    expect(connection.style.display).toBe('')
    expect(connection.style.opacity).toBe('')
    expect(x(connection)).toBe(WIDTH)
    expect(connection.textContent).toBe('Certificate')
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

  it('lays the leaving pane over the track, shifts it a third and dims it, never to nothing', () => {
    const main = panes.get('main')!
    levels.push('connection')
    expect(main.hasAttribute('data-leaving')).toBe(true)
    expect(main.style.opacity).toBe('1.000')
    frames.run(60)
    expect(levels.current.phase).toBe('rest')
    // Mid-way the pane under is shifted at most a third of the width and still half visible.
    levels.pop()
    frames.run(3)
    const shift = -x(main)
    expect(shift).toBeGreaterThan(0)
    expect(shift).toBeLessThanOrEqual(0.3 * WIDTH + 0.01)
    expect(Number(main.style.opacity)).toBeGreaterThanOrEqual(0.5)
  })

  it('keeps the covered pane out of reach while it is mostly gone, and restores it at rest', () => {
    const main = panes.get('main')!
    const connection = panes.get('connection')!
    levels.push('connection')
    expect(connection.getAttribute('aria-hidden')).toBe('true')
    expect(connection.hasAttribute('inert')).toBe(true)
    expect(main.getAttribute('aria-hidden')).toBe('false')
    frames.run(60)
    expect(levels.current.phase).toBe('rest')
    expect(connection.getAttribute('aria-hidden')).toBe('false')
    expect(connection.hasAttribute('inert')).toBe(false)
    expect(connection.style.transform).toBe('')
    expect(connection.style.willChange).toBe('')
    expect(main.style.display).toBe('none')
    expect(main.hasAttribute('inert')).toBe(true)
    expect(main.hasAttribute('data-leaving')).toBe(false)
  })

  it('a pop travels the deeper pane out on top, opaque, over the pane it reveals', () => {
    const main = panes.get('main')!
    const connection = panes.get('connection')!
    levels.push('connection')
    frames.run(60)
    levels.pop()
    expect(connection.hasAttribute('data-leaving')).toBe(true)
    expect(connection.style.opacity).toBe('')
    expect(main.hasAttribute('data-leaving')).toBe(false)
    expect(main.style.display).toBe('')
    frames.run(2)
    expect(x(connection)).toBeGreaterThan(0)
    expect(connection.style.opacity).toBe('')
    expect(Number(main.style.opacity)).toBeGreaterThanOrEqual(0.5)
    frames.run(60)
    expect(levels.current.phase).toBe('rest')
    expect(main.style.opacity).toBe('')
    expect(connection.style.display).toBe('none')
  })
})
