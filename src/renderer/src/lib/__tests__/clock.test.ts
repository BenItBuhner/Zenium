import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelFrame, framesPending, requestFrame } from '../motion/clock'
import { SPRING_GENTLE, SPRING_SNAPPY, SpringAnimation } from '../motion/spring'
import { fadeOpacity } from '../motion/fade'

/**
 * The host's animation frame, held for the test to fire by hand: every request is recorded with
 * the function it was handed; `fire()` calls the ones on the books and clears them.
 */
function hostFrames(): {
  requested: () => number
  fire: (now?: number) => void
  raf: ReturnType<typeof vi.fn>
  caf: ReturnType<typeof vi.fn>
} {
  const pending = new Map<number, FrameRequestCallback>()
  let id = 0
  let now = 1000
  const raf = vi.fn((cb: FrameRequestCallback) => {
    pending.set(++id, cb)
    return id
  })
  const caf = vi.fn((n: number) => {
    pending.delete(n)
  })
  vi.stubGlobal('requestAnimationFrame', raf)
  vi.stubGlobal('cancelAnimationFrame', caf)
  vi.stubGlobal('performance', { now: () => now })
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
  return {
    requested: () => pending.size,
    raf,
    caf,
    fire: (at?: number) => {
      now = at ?? now + 16
      const batch = [...pending.values()]
      pending.clear()
      for (const cb of batch) cb(now)
    }
  }
}

describe('the one animation clock (motion spec §6)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks the host for one frame however many callbacks wait, and runs them all at the one now', () => {
    const host = hostFrames()
    const seen: Array<[string, number]> = []
    requestFrame((now) => seen.push(['a', now]))
    requestFrame((now) => seen.push(['b', now]))
    requestFrame((now) => seen.push(['c', now]))
    expect(framesPending()).toBe(3)
    expect(host.requested()).toBe(1)
    expect(host.raf).toHaveBeenCalledTimes(1)
    host.fire(1016)
    expect(seen).toEqual([
      ['a', 1016],
      ['b', 1016],
      ['c', 1016]
    ])
    // A frame is one run: nothing asked for the next.
    expect(framesPending()).toBe(0)
    expect(host.requested()).toBe(0)
    expect(host.raf).toHaveBeenCalledTimes(1)
  })

  it('a callback that asks again from inside its run gets the frame after – one host frame for the batch', () => {
    const host = hostFrames()
    let runs = 0
    const loop = (): void => {
      if (++runs < 3) requestFrame(loop)
    }
    requestFrame(loop)
    requestFrame(() => undefined)
    host.fire()
    expect(runs).toBe(1)
    expect(framesPending()).toBe(1)
    expect(host.requested()).toBe(1)
    expect(host.raf).toHaveBeenCalledTimes(2)
    host.fire()
    host.fire()
    expect(runs).toBe(3)
    expect(framesPending()).toBe(0)
    expect(host.requested()).toBe(0)
    expect(host.raf).toHaveBeenCalledTimes(3)
  })

  it('cancelling the last callback gives the host its frame back; cancelling one of several keeps it', () => {
    const host = hostFrames()
    const a = requestFrame(() => undefined)
    const b = requestFrame(() => undefined)
    cancelFrame(a)
    expect(framesPending()).toBe(1)
    expect(host.requested()).toBe(1)
    expect(host.caf).not.toHaveBeenCalled()
    cancelFrame(b)
    expect(framesPending()).toBe(0)
    expect(host.requested()).toBe(0)
    expect(host.caf).toHaveBeenCalledTimes(1)
    // A handle no longer on the clock is nothing.
    cancelFrame(b)
    cancelFrame(a)
    expect(host.caf).toHaveBeenCalledTimes(1)
  })

  it('a callback cancelled by an earlier one in the same frame does not run', () => {
    const host = hostFrames()
    const ran: string[] = []
    let later = 0
    requestFrame(() => {
      ran.push('first')
      cancelFrame(later)
    })
    later = requestFrame(() => ran.push('cancelled'))
    requestFrame(() => ran.push('third'))
    host.fire()
    expect(ran).toEqual(['first', 'third'])
    expect(framesPending()).toBe(0)
  })

  it('a throw in one callback robs no other of its frame, nor the clock of its next; the first error comes out of the frame', () => {
    const host = hostFrames()
    const ran: string[] = []
    requestFrame(() => {
      throw new Error('one consumer’s bug')
    })
    requestFrame(() => {
      ran.push('second')
      requestFrame(() => ran.push('second again'))
    })
    requestFrame(() => {
      throw new Error('another’s')
    })
    expect(() => host.fire()).toThrow('one consumer’s bug')
    expect(ran).toEqual(['second'])
    expect(framesPending()).toBe(1)
    expect(host.requested()).toBe(1)
    host.fire()
    expect(ran).toEqual(['second', 'second again'])
  })

  it('a frame of an arming since let go is not the clock’s tick – a cancel the host did not honour fires nothing twice', () => {
    // A host whose `cancelAnimationFrame` cancels nothing (a test harness, say): the clock lets
    // its frame go when the last callback is cancelled, then arms again for a new one. The old
    // frame still fires; it must not run the new batch a second time in the same frame.
    const pending: FrameRequestCallback[] = []
    let now = 1000
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => pending.push(cb))
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    vi.stubGlobal('performance', { now: () => now })
    const a = requestFrame(() => undefined)
    cancelFrame(a)
    let runs = 0
    requestFrame(() => {
      runs++
    })
    expect(pending).toHaveLength(2)
    now += 16
    const batch = pending.splice(0)
    for (const cb of batch) cb(now)
    expect(runs).toBe(1)
  })

  it('a host swapped out from under it (a stub, fake timers) is a fresh clock: the frame asked of the old one is let go with what waited on it', () => {
    const first = hostFrames()
    requestFrame(() => undefined)
    expect(first.requested()).toBe(1)
    expect(framesPending()).toBe(1)
    const second = hostFrames()
    const ran = vi.fn()
    requestFrame(ran)
    expect(framesPending()).toBe(1)
    expect(second.requested()).toBe(1)
    second.fire()
    expect(ran).toHaveBeenCalledTimes(1)
    expect(framesPending()).toBe(0)
  })

  it('two springs and a fade in flight step on the one host frame, at the one now', () => {
    const host = hostFrames()
    const a = new SpringAnimation(
      SPRING_SNAPPY,
      () => undefined,
      () => undefined
    )
    const b = new SpringAnimation(
      SPRING_GENTLE,
      () => undefined,
      () => undefined
    )
    const el = { style: { opacity: '' } } as unknown as HTMLElement
    a.start(0, 0, 300)
    b.start(0, 0, 56)
    const cancelFade = fadeOpacity(el, 1)
    expect(framesPending()).toBe(3)
    expect(host.requested()).toBe(1)
    expect(host.raf).toHaveBeenCalledTimes(1)
    host.fire()
    expect(a.current.x).toBeGreaterThan(0)
    expect(b.current.x).toBeGreaterThan(0)
    expect(Number(el.style.opacity)).toBeGreaterThan(0)
    expect(framesPending()).toBe(3)
    expect(host.requested()).toBe(1)
    expect(host.raf).toHaveBeenCalledTimes(2)
    // One frame per step for all three, until each rests on its own.
    let guard = 0
    while (framesPending() > 0 && guard++ < 300) {
      expect(host.requested()).toBe(1)
      host.fire()
    }
    expect(a.running).toBe(false)
    expect(b.running).toBe(false)
    expect(el.style.opacity).toBe('1.000')
    expect(host.requested()).toBe(0)
    cancelFade()
  })
})
