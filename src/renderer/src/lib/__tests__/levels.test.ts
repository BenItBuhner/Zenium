import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEVEL_BACK_PEEK, LevelMotion, type LevelState } from '../motion/levels'

/** A hand-cranked animation frame (see sheet.test.ts): 16 ms a step, springs followed to rest. */
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
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false, addEventListener: () => undefined })
    })
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

describe('LevelMotion', () => {
  const frames = new Frames()
  let states: LevelState[]
  let levels: LevelMotion

  beforeEach(() => {
    frames.install()
    states = []
    levels = new LevelMotion('main', (s) => states.push(s))
  })
  afterEach(() => vi.unstubAllGlobals())

  const last = (): LevelState => states[states.length - 1]

  it('rests on the root', () => {
    expect(levels.depth).toBe(0)
    expect(levels.level).toBe('main')
    expect(levels.current).toEqual({
      stack: ['main'],
      from: 'main',
      to: 'main',
      t: 1,
      phase: 'rest'
    })
  })

  it('pushes a level in on a spring and rests on it', () => {
    levels.push('cookies')
    expect(levels.depth).toBe(1)
    expect(levels.pushing).toBe(true)
    expect(last()).toMatchObject({ from: 'main', to: 'cookies', t: 0, phase: 'moving' })
    frames.run(3)
    const mid = last()
    expect(mid.t).toBeGreaterThan(0)
    expect(mid.t).toBeLessThan(1)
    frames.run(120)
    expect(last()).toEqual({
      stack: ['main', 'cookies'],
      from: 'cookies',
      to: 'cookies',
      t: 1,
      phase: 'rest'
    })
  })

  it('pops back to the parent and only then shortens the stack', () => {
    levels.push('cookies')
    frames.run(120)
    expect(levels.pop()).toBe(true)
    expect(levels.pushing).toBe(false)
    expect(last()).toMatchObject({ stack: ['main', 'cookies'], from: 'cookies', to: 'main', t: 0 })
    frames.run(120)
    expect(last()).toEqual({ stack: ['main'], from: 'main', to: 'main', t: 1, phase: 'rest' })
    expect(levels.pop()).toBe(false)
  })

  it('a pop during a push reverses from where the push was', () => {
    levels.push('permissions')
    frames.run(4)
    const arrived = last().t
    expect(arrived).toBeGreaterThan(0)
    levels.pop()
    // The incoming level had come `arrived` of the way; going back it is `1 - arrived` gone.
    expect(last()).toMatchObject({ from: 'permissions', to: 'main', phase: 'moving' })
    expect(last().t).toBeCloseTo(1 - arrived, 5)
    frames.run(120)
    expect(last()).toEqual({ stack: ['main'], from: 'main', to: 'main', t: 1, phase: 'rest' })
  })

  it('the back gesture peeks the level away, then commits or springs back', () => {
    levels.push('connection')
    frames.run(120)
    levels.backProgress(0.5)
    expect(last()).toMatchObject({
      from: 'connection',
      to: 'main',
      t: 0.5 * LEVEL_BACK_PEEK,
      phase: 'back'
    })
    levels.backProgress(1)
    expect(last().t).toBeCloseTo(LEVEL_BACK_PEEK)
    levels.backCancel()
    frames.run(120)
    expect(last()).toEqual({
      stack: ['main', 'connection'],
      from: 'connection',
      to: 'connection',
      t: 1,
      phase: 'rest'
    })
    levels.backProgress(0.8)
    levels.backCommit()
    frames.run(120)
    expect(last()).toEqual({ stack: ['main'], from: 'main', to: 'main', t: 1, phase: 'rest' })
  })

  it('does nothing for a back gesture at the root, and pop during a back preview commits it', () => {
    levels.backProgress(0.7)
    expect(states).toHaveLength(0)
    levels.push('cookies')
    frames.run(120)
    levels.backProgress(0.4)
    expect(levels.pop()).toBe(true)
    expect(last().phase).toBe('moving')
    frames.run(120)
    expect(levels.depth).toBe(0)
  })

  it('pushing while a pop is under way leaves from the level being popped to', () => {
    levels.push('cookies')
    frames.run(120)
    levels.pop()
    frames.run(2)
    levels.push('permissions')
    expect(last()).toMatchObject({
      stack: ['main', 'permissions'],
      from: 'main',
      to: 'permissions',
      t: 0
    })
    frames.run(120)
    expect(levels.level).toBe('permissions')
  })
})
