import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BAND_FADE_MS,
  BAND_HEIGHT_ONE_LINE,
  BAND_HEIGHT_TWO_LINE,
  BandMotion,
  remainingMs,
  type BandSeam
} from '../motion/band'
import { framesPending } from '../motion/clock'
import { MOTION_STATE_MS } from '../motion/tokens'
import { SPRING_GENTLE, isAtRest, stepSpring } from '../motion/spring'
import { SWIPE_THRESHOLDS } from '../gestures/swipe'

const FRAME_MS = 16

/** The host's animation frame with a clock: `tick()` fires the frame in flight 16 ms later. */
function clockedFrames(reduced = false): {
  pending: () => number
  tick: (n?: number) => void
  now: () => number
} {
  const pending = new Map<number, FrameRequestCallback>()
  let id = 0
  let now = 1000
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    pending.set(++id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (n: number) => pending.delete(n))
  vi.stubGlobal('performance', { now: () => now })
  vi.stubGlobal('window', {
    matchMedia: (q: string) => ({ matches: reduced && q === '(prefers-reduced-motion: reduce)' })
  })
  return {
    pending: () => pending.size,
    now: () => now,
    tick: (n = 1) => {
      for (let i = 0; i < n; i++) {
        now += FRAME_MS
        const batch = [...pending.values()]
        pending.clear()
        for (const cb of batch) cb(now)
      }
    }
  }
}

interface Trace {
  offsets: number[]
  rests: number[]
  paints: number[]
  seam: BandSeam
}

function trace(): Trace {
  const t: Trace = {
    offsets: [],
    rests: [],
    paints: [],
    seam: {
      translate: (o) => t.offsets.push(o),
      rest: (h) => t.rests.push(h),
      paint: (o) => t.paints.push(o)
    }
  }
  return t
}

/** Run frames until the band's spring rests (the clock goes idle) or `limit` frames pass. */
function settle(frames: ReturnType<typeof clockedFrames>, limit = 200): number {
  let n = 0
  while (framesPending() > 0 && n < limit) {
    frames.tick()
    n++
  }
  return n
}

const monotone = (xs: number[], dir: 1 | -1, slack = 0): boolean =>
  xs.every((x, i) => i === 0 || (x - xs[i - 1]) * dir >= -slack)

describe('remainingMs', () => {
  it('reads the spring’s own time to rest, frame by frame, and is 0 at rest', () => {
    const whole = remainingMs({ x: 0, v: 0 }, BAND_HEIGHT_ONE_LINE)
    expect(whole).toBeGreaterThan(200)
    expect(whole).toBeLessThan(600)
    // Along the trajectory the estimate falls by a frame a frame.
    let s = { x: 0, v: 0 }
    let last = whole
    while (!isAtRest(s, BAND_HEIGHT_ONE_LINE)) {
      s = stepSpring(s, BAND_HEIGHT_ONE_LINE, 1 / 60, SPRING_GENTLE)
      const left = remainingMs(s, BAND_HEIGHT_ONE_LINE)
      expect(left).toBeLessThan(last)
      last = left
    }
    expect(remainingMs(s, BAND_HEIGHT_ONE_LINE)).toBe(0)
  })
})

describe('BandMotion – the page-edge band’s travel (motion spec §2, §3.1–3.2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens: the page travels down to the height on SPRING_GENTLE, the content fades in over the last 120 ms, one rest at the height', () => {
    const frames = clockedFrames()
    const t = trace()
    const band = new BandMotion(t.seam)
    expect(band.phase).toBe('closed')
    band.open(BAND_HEIGHT_ONE_LINE)
    expect(band.phase).toBe('opening')
    expect(band.height).toBe(BAND_HEIGHT_ONE_LINE)
    // One frame on the host's books, whatever moves (§6).
    expect(frames.pending()).toBe(1)
    const paintsAt: Array<[number, number]> = []
    let n = 0
    while (framesPending() > 0 && n < 200) {
      frames.tick()
      n++
      if (t.paints.length > 0 && t.paints[t.paints.length - 1] > 0 && paintsAt.length === 0)
        paintsAt.push([n, t.paints[t.paints.length - 1]])
      expect(frames.pending()).toBeLessThanOrEqual(1)
    }
    expect(band.phase).toBe('open')
    expect(t.rests).toEqual([BAND_HEIGHT_ONE_LINE])
    expect(band.offset).toBe(BAND_HEIGHT_ONE_LINE)
    // A travel, not a cut: many frames, monotone down (a hair of overshoot allowed), to the height.
    expect(n).toBeGreaterThan(10)
    expect(monotone(t.offsets, 1, 0.5)).toBe(true)
    expect(Math.max(...t.offsets)).toBeLessThan(BAND_HEIGHT_ONE_LINE + 1)
    expect(t.offsets[t.offsets.length - 1]).toBe(BAND_HEIGHT_ONE_LINE)
    // The content: unseen for most of the travel, then in over the last 120 ms, never back.
    expect(paintsAt).toHaveLength(1)
    const [firstShownFrame] = paintsAt[0]
    const fadeFrames = n - firstShownFrame + 1
    expect(fadeFrames).toBeGreaterThanOrEqual(Math.floor(BAND_FADE_MS / FRAME_MS) - 1)
    expect(fadeFrames).toBeLessThanOrEqual(Math.ceil(BAND_FADE_MS / FRAME_MS) + 2)
    expect(monotone(t.paints, 1)).toBe(true)
    expect(band.opacity).toBe(1)
    expect(t.paints[t.paints.length - 1]).toBe(1)
  })

  it('closes: the content fades over the first 120 ms while the page travels up; one rest at 0; never below the edge', () => {
    const frames = clockedFrames()
    const t = trace()
    const band = new BandMotion(t.seam)
    band.open(BAND_HEIGHT_ONE_LINE)
    settle(frames)
    t.offsets.length = 0
    t.paints.length = 0
    t.rests.length = 0
    band.close()
    expect(band.phase).toBe('closing')
    let gonAt = -1
    let n = 0
    while (framesPending() > 0 && n < 200) {
      frames.tick()
      n++
      if (gonAt < 0 && band.opacity === 0) gonAt = n
    }
    expect(band.phase).toBe('closed')
    expect(t.rests).toEqual([0])
    expect(band.offset).toBe(0)
    expect(band.height).toBe(0)
    expect(t.offsets[t.offsets.length - 1]).toBe(0)
    expect(Math.min(...t.offsets)).toBeGreaterThanOrEqual(0)
    expect(monotone(t.offsets, -1, 0.5)).toBe(true)
    // The content is gone within the fade, well before the page is back.
    expect(gonAt).toBeGreaterThan(0)
    expect(gonAt).toBeLessThanOrEqual(Math.ceil(BAND_FADE_MS / FRAME_MS) + 1)
    expect(gonAt).toBeLessThan(n)
    expect(monotone(t.paints, -1)).toBe(true)
  })

  it('a new height on an open band re-targets the one spring at full opacity (§3.2); the same height is nothing', () => {
    const frames = clockedFrames()
    const t = trace()
    const band = new BandMotion(t.seam)
    band.open(BAND_HEIGHT_ONE_LINE)
    settle(frames)
    t.offsets.length = 0
    t.paints.length = 0
    t.rests.length = 0
    band.open(BAND_HEIGHT_ONE_LINE)
    expect(band.phase).toBe('open')
    expect(frames.pending()).toBe(0)
    band.open(BAND_HEIGHT_TWO_LINE)
    expect(band.phase).toBe('resizing')
    expect(frames.pending()).toBe(1)
    settle(frames)
    expect(band.phase).toBe('open')
    expect(t.rests).toEqual([BAND_HEIGHT_TWO_LINE])
    expect(t.offsets[t.offsets.length - 1]).toBe(BAND_HEIGHT_TWO_LINE)
    expect(monotone(t.offsets, 1, 0.5)).toBe(true)
    expect(t.paints).toEqual([])
    expect(band.opacity).toBe(1)
  })

  it('a new height during the entrance re-targets it and the fade-in keeps its rule: what has shown is not taken back', () => {
    const frames = clockedFrames()
    const t = trace()
    const band = new BandMotion(t.seam)
    band.open(BAND_HEIGHT_ONE_LINE)
    // Into the fade-in.
    let guard = 0
    while (band.opacity < 0.3 && guard++ < 100) frames.tick()
    expect(band.phase).toBe('opening')
    const shown = band.opacity
    band.open(BAND_HEIGHT_TWO_LINE)
    expect(band.phase).toBe('opening')
    expect(frames.pending()).toBe(1)
    frames.tick()
    expect(band.opacity).toBeGreaterThanOrEqual(shown)
    settle(frames)
    expect(band.phase).toBe('open')
    expect(t.rests).toEqual([BAND_HEIGHT_TWO_LINE])
    expect(monotone(t.paints, 1)).toBe(true)
    expect(band.opacity).toBe(1)
  })

  it('a close during the entrance reverses the one spring (never a second motion); an open during the leave reverses it back', () => {
    const frames = clockedFrames()
    const t = trace()
    const band = new BandMotion(t.seam)
    band.open(BAND_HEIGHT_ONE_LINE)
    frames.tick(4)
    const midway = band.offset
    expect(midway).toBeGreaterThan(0)
    expect(midway).toBeLessThan(BAND_HEIGHT_ONE_LINE)
    band.close()
    expect(band.phase).toBe('closing')
    expect(frames.pending()).toBe(1)
    frames.tick(3)
    const turning = band.offset
    // The velocity carried: it ran on a little before turning back.
    expect(Math.max(...t.offsets)).toBeGreaterThanOrEqual(midway)
    band.open(BAND_HEIGHT_ONE_LINE)
    expect(band.phase).toBe('opening')
    expect(frames.pending()).toBe(1)
    settle(frames)
    expect(band.phase).toBe('open')
    expect(t.rests).toEqual([BAND_HEIGHT_ONE_LINE])
    expect(band.offset).toBe(BAND_HEIGHT_ONE_LINE)
    expect(turning).toBeGreaterThan(0)
  })

  it('a finger takes the page 1:1 (clamped to the band), a release short of half springs back, a release past half dismisses', () => {
    const frames = clockedFrames()
    const t = trace()
    const band = new BandMotion(t.seam)
    band.open(BAND_HEIGHT_ONE_LINE)
    settle(frames)
    band.dragStart()
    expect(band.phase).toBe('dragging')
    expect(frames.pending()).toBe(0)
    t.offsets.length = 0
    band.drag(-20)
    expect(t.offsets).toEqual([36])
    expect(band.opacity).toBeCloseTo(36 / 56, 5)
    band.drag(-80)
    expect(t.offsets[t.offsets.length - 1]).toBe(0)
    band.drag(30)
    expect(t.offsets[t.offsets.length - 1]).toBe(BAND_HEIGHT_ONE_LINE)
    band.drag(-20)
    t.rests.length = 0
    band.release(0)
    expect(band.phase).toBe('returning')
    settle(frames)
    expect(band.phase).toBe('open')
    expect(t.rests).toEqual([BAND_HEIGHT_ONE_LINE])
    expect(band.offset).toBe(BAND_HEIGHT_ONE_LINE)
    expect(band.opacity).toBe(1)
    // Past half: gone.
    band.dragStart()
    band.drag(-30)
    expect(band.offset).toBe(26)
    t.rests.length = 0
    band.release(0)
    expect(band.phase).toBe('closing')
    settle(frames)
    expect(band.phase).toBe('closed')
    expect(t.rests).toEqual([0])
    expect(band.offset).toBe(0)
    expect(band.opacity).toBe(0)
  })

  it('a fling up dismisses from anywhere, carrying the hand’s velocity', () => {
    const frames = clockedFrames()
    const t = trace()
    const band = new BandMotion(t.seam)
    band.open(BAND_HEIGHT_ONE_LINE)
    settle(frames)
    band.dragStart()
    band.drag(-4)
    band.release(-SWIPE_THRESHOLDS.flingVelocity)
    expect(band.phase).toBe('closing')
    const slow = new BandMotion(trace().seam)
    const n = settle(frames)
    expect(band.phase).toBe('closed')
    expect(t.rests[t.rests.length - 1]).toBe(0)
    // Slower than a flung one would be: the same leave from rest takes more frames.
    slow.open(BAND_HEIGHT_ONE_LINE)
    settle(frames)
    slow.close()
    const m = settle(frames)
    expect(n).toBeLessThan(m)
  })

  it('a drag while opening catches the spring where it is; an open under a finger only moves where the release returns to', () => {
    const frames = clockedFrames()
    const t = trace()
    const band = new BandMotion(t.seam)
    band.open(BAND_HEIGHT_ONE_LINE)
    frames.tick(5)
    const caught = band.offset
    band.dragStart()
    expect(band.phase).toBe('dragging')
    expect(frames.pending()).toBe(0)
    expect(band.offset).toBe(caught)
    band.open(BAND_HEIGHT_TWO_LINE)
    expect(band.phase).toBe('dragging')
    expect(band.height).toBe(BAND_HEIGHT_TWO_LINE)
    expect(frames.pending()).toBe(0)
    band.drag(-5)
    expect(band.offset).toBe(BAND_HEIGHT_TWO_LINE - 5)
    band.release(0)
    expect(band.phase).toBe('returning')
    settle(frames)
    expect(band.offset).toBe(BAND_HEIGHT_TWO_LINE)
    expect(t.rests).toEqual([BAND_HEIGHT_TWO_LINE])
  })

  it('under reduced motion the page jumps to the height and the content fades in 120 ms; leaving fades out, then jumps', () => {
    const frames = clockedFrames(true)
    const t = trace()
    const band = new BandMotion(t.seam)
    band.open(BAND_HEIGHT_ONE_LINE)
    // The jump and the rest are at once; the fade is on the clock.
    expect(t.offsets).toEqual([BAND_HEIGHT_ONE_LINE])
    expect(t.rests).toEqual([BAND_HEIGHT_ONE_LINE])
    expect(band.phase).toBe('open')
    expect(band.opacity).toBe(0)
    expect(frames.pending()).toBe(1)
    const n = settle(frames)
    expect(n).toBeGreaterThanOrEqual(Math.floor(MOTION_STATE_MS / FRAME_MS))
    expect(n).toBeLessThanOrEqual(Math.ceil(MOTION_STATE_MS / FRAME_MS) + 1)
    expect(band.opacity).toBe(1)
    expect(monotone(t.paints, 1)).toBe(true)
    expect(t.offsets).toEqual([BAND_HEIGHT_ONE_LINE])
    t.offsets.length = 0
    t.rests.length = 0
    band.close()
    expect(band.phase).toBe('closing')
    // Nothing moves until the content has gone.
    frames.tick(3)
    expect(t.offsets).toEqual([])
    expect(band.opacity).toBeLessThan(1)
    expect(band.opacity).toBeGreaterThan(0)
    settle(frames)
    expect(band.phase).toBe('closed')
    expect(band.opacity).toBe(0)
    expect(t.offsets).toEqual([0])
    expect(t.rests).toEqual([0])
  })

  it('under reduced motion a finger still drags 1:1 and a release jumps to its outcome', () => {
    const frames = clockedFrames(true)
    const t = trace()
    const band = new BandMotion(t.seam)
    band.open(BAND_HEIGHT_ONE_LINE)
    settle(frames)
    band.dragStart()
    band.drag(-10)
    expect(band.offset).toBe(46)
    t.offsets.length = 0
    t.rests.length = 0
    band.release(0)
    expect(band.phase).toBe('open')
    expect(t.offsets).toEqual([BAND_HEIGHT_ONE_LINE])
    expect(t.rests).toEqual([BAND_HEIGHT_ONE_LINE])
    expect(band.opacity).toBe(1)
    band.dragStart()
    band.drag(-40)
    t.offsets.length = 0
    t.rests.length = 0
    band.release(0)
    expect(band.phase).toBe('closed')
    expect(t.offsets).toEqual([0])
    expect(t.rests).toEqual([0])
    expect(band.opacity).toBe(0)
  })

  it('names every travel’s destination to the seam before its first frame (depart): the open’s height, a re-target’s, 0 for a leave, the height for a spring-back; a finger’s drag names none', () => {
    const frames = clockedFrames()
    const t = trace()
    const departs: number[] = []
    const band = new BandMotion({ ...t.seam, depart: (to) => departs.push(to) })
    band.open(BAND_HEIGHT_ONE_LINE)
    expect(departs).toEqual([BAND_HEIGHT_ONE_LINE])
    expect(t.offsets).toEqual([])
    settle(frames)
    band.open(BAND_HEIGHT_TWO_LINE)
    expect(departs).toEqual([BAND_HEIGHT_ONE_LINE, BAND_HEIGHT_TWO_LINE])
    settle(frames)
    band.dragStart()
    band.drag(-10)
    expect(departs).toHaveLength(2)
    band.release(0)
    expect(departs.at(-1)).toBe(BAND_HEIGHT_TWO_LINE)
    settle(frames)
    band.close()
    expect(departs.at(-1)).toBe(0)
    expect(t.rests).toEqual([BAND_HEIGHT_ONE_LINE, BAND_HEIGHT_TWO_LINE, BAND_HEIGHT_TWO_LINE])
    settle(frames)
    expect(t.rests.at(-1)).toBe(0)
    // A seam without the hook is served the same.
    const plain = new BandMotion(trace().seam)
    plain.open(BAND_HEIGHT_ONE_LINE)
    settle(frames)
    expect(plain.phase).toBe('open')
  })

  it('tells the seam a hand took hold (dragStart) once per take-hold, before the drag’s first frame – on a band at rest and on one caught mid-travel alike; not on a shut or leaving band, where the drag is refused; a seam without the word is served the same', () => {
    const frames = clockedFrames()
    const heard: string[] = []
    const band = new BandMotion({
      translate: (o) => heard.push(`translate ${o}`),
      rest: (h) => heard.push(`rest ${h}`),
      depart: (to) => heard.push(`depart ${to}`),
      dragStart: () => heard.push('dragStart'),
      paint: () => undefined
    })
    // Shut: the drag is refused and the seam hears nothing of it.
    band.dragStart()
    expect(band.phase).toBe('closed')
    expect(heard).toEqual([])
    band.open(BAND_HEIGHT_ONE_LINE)
    settle(frames)
    heard.length = 0
    // At rest: the take-hold once, then the drag's frames – no second word within the drag.
    band.dragStart()
    band.drag(-10)
    band.drag(-20)
    expect(heard).toEqual(['dragStart', 'translate 46', 'translate 36'])
    // The release names its destination as any travel does: the seam's next word is a depart.
    band.release(0)
    expect(heard[3]).toBe(`depart ${BAND_HEIGHT_ONE_LINE}`)
    settle(frames)
    expect(heard.at(-1)).toBe(`rest ${BAND_HEIGHT_ONE_LINE}`)
    // Mid-travel: a re-target toward 76 departs and runs three frames; the hand takes it between
    // the travel's last frame and the drag's first – the spring stopped, the clock idle.
    heard.length = 0
    band.open(BAND_HEIGHT_TWO_LINE)
    frames.tick(3)
    expect(heard).toHaveLength(4)
    expect(heard[0]).toBe(`depart ${BAND_HEIGHT_TWO_LINE}`)
    expect(heard.slice(1).every((w) => w.startsWith('translate '))).toBe(true)
    band.dragStart()
    expect(frames.pending()).toBe(0)
    band.drag(-30)
    expect(heard.slice(4)).toEqual(['dragStart', `translate ${BAND_HEIGHT_TWO_LINE - 30}`])
    band.release(0)
    settle(frames)
    expect(heard.at(-1)).toBe(`rest ${BAND_HEIGHT_TWO_LINE}`)
    // Leaving: refused – the frames stay the leave's, and the seam hears no take-hold.
    band.close()
    heard.length = 0
    band.dragStart()
    expect(band.phase).toBe('closing')
    expect(heard).toEqual([])
    settle(frames)
    expect(heard.at(-1)).toBe('rest 0')
    expect(heard).not.toContain('dragStart')
    // A seam without the word is served the same.
    const plain = new BandMotion(trace().seam)
    plain.open(BAND_HEIGHT_ONE_LINE)
    settle(frames)
    plain.dragStart()
    plain.drag(-10)
    expect(plain.phase).toBe('dragging')
    expect(plain.offset).toBe(46)
  })

  it('dispose() stops the motion and the clock hears nothing more; close() on a shut band is nothing', () => {
    const frames = clockedFrames()
    const t = trace()
    const band = new BandMotion(t.seam)
    band.close()
    expect(t.rests).toEqual([])
    band.open(BAND_HEIGHT_ONE_LINE)
    frames.tick(2)
    const before = t.offsets.length
    band.dispose()
    expect(frames.pending()).toBe(0)
    expect(framesPending()).toBe(0)
    frames.tick(5)
    expect(t.offsets).toHaveLength(before)
    expect(t.rests).toEqual([])
  })
})
