import { describe, expect, it } from 'vitest'
import {
  SPACE_EASE,
  SPACE_FADE_MS,
  SPACE_SLIDE_MS,
  SPACE_SLIDE_PX,
  indicatorFrame,
  planSpaceSwitch,
  slideSign,
  switchDirection
} from '../motion/spaceSwitch'
import { REDUCED_FADE_MS } from '../motion/fade'

const ORDER = ['work', 'home', 'reading']

describe('the space switch direction', () => {
  it('reads the strip order: later is forward, earlier is back', () => {
    expect(switchDirection(ORDER, 'work', 'reading')).toBe('forward')
    expect(switchDirection(ORDER, 'home', 'reading')).toBe('forward')
    expect(switchDirection(ORDER, 'reading', 'work')).toBe('back')
    expect(switchDirection(ORDER, 'home', 'work')).toBe('back')
  })

  it('claims no direction without an outgoing space to relate to (§11.4)', () => {
    expect(switchDirection(ORDER, null, 'home')).toBe('none')
    expect(switchDirection(ORDER, undefined, 'home')).toBe('none')
    expect(switchDirection(ORDER, 'gone', 'home')).toBe('none')
    expect(switchDirection(ORDER, 'home', 'gone')).toBe('none')
    expect(switchDirection(ORDER, 'home', 'home')).toBe('none')
  })

  it('comes from the trailing side, mirrored under a right-to-left layout', () => {
    expect(slideSign('forward')).toBe(1)
    expect(slideSign('back')).toBe(-1)
    expect(slideSign('none')).toBe(0)
    expect(slideSign('forward', true)).toBe(-1)
    expect(slideSign('back', true)).toBe(1)
    expect(slideSign('none', true)).toBe(0)
  })
})

describe('the space switch plan', () => {
  it('slides the incoming grid 250 ms on the standard curve from the switch side and fades the outgoing 120 ms', () => {
    const plan = planSpaceSwitch('forward', { reduced: false })
    expect(plan.slide).toBe(SPACE_SLIDE_PX)
    expect(plan.incoming.duration).toBe(SPACE_SLIDE_MS)
    expect(plan.incoming.duration).toBe(250)
    expect(plan.incoming.easing).toBe(SPACE_EASE)
    expect(plan.incoming.easing).toBe('cubic-bezier(0.2, 0.8, 0.2, 1)')
    expect(plan.incoming.keyframes[0]).toMatchObject({
      transform: `translate3d(${SPACE_SLIDE_PX}px, 0, 0)`,
      opacity: 0,
      offset: 0
    })
    expect(plan.incoming.keyframes.at(-1)).toMatchObject({
      transform: 'translate3d(0, 0, 0)',
      opacity: 1,
      offset: 1
    })
    expect(plan.outgoing.duration).toBe(SPACE_FADE_MS)
    expect(plan.outgoing.duration).toBe(120)
    expect(plan.blend).toBe(true)
    expect(plan.indicatorGlides).toBe(true)
  })

  it('is solid by the slide first half, so the tail draws the cards at their landing', () => {
    const plan = planSpaceSwitch('back', { reduced: false })
    expect(plan.slide).toBe(-SPACE_SLIDE_PX)
    const solid = plan.incoming.keyframes.find(
      (k) => k.opacity === 1 && k.offset !== 1 && k.offset !== 0
    )
    expect(solid).toBeDefined()
    expect(solid!.offset).toBeLessThanOrEqual(0.5)
    expect(solid!.offset).toBeCloseTo(SPACE_FADE_MS / SPACE_SLIDE_MS)
  })

  it('travels §11 short distance, not the pane width', () => {
    expect(SPACE_SLIDE_PX).toBeGreaterThan(0)
    expect(SPACE_SLIDE_PX).toBeLessThan(360)
  })

  it('fades in place with no direction to claim', () => {
    const plan = planSpaceSwitch('none', { reduced: false })
    expect(plan.slide).toBe(0)
    expect(plan.incoming.duration).toBe(REDUCED_FADE_MS)
    expect(plan.incoming.keyframes.every((k) => k.transform === undefined)).toBe(true)
    expect(plan.blend).toBe(true)
    expect(plan.indicatorGlides).toBe(true)
  })

  it('under reduced motion nothing travels: a 120 ms fade, the indicator a jump, the blend kept (§11.3; §11.6 as amended)', () => {
    for (const direction of ['forward', 'back', 'none'] as const) {
      const plan = planSpaceSwitch(direction, { reduced: true, rtl: direction === 'back' })
      expect(plan.slide).toBe(0)
      expect(plan.incoming.duration).toBe(120)
      expect(plan.incoming.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }])
      expect(plan.outgoing.duration).toBe(120)
      // A colour blend is a fade in colour and moves no pixel; a whole window cutting from one
      // Space's colour to another's is a flash (#497's design gate).
      expect(plan.blend).toBe(true)
      expect(plan.indicatorGlides).toBe(false)
    }
  })

  it('mirrors the side under a right-to-left layout', () => {
    expect(planSpaceSwitch('forward', { reduced: false, rtl: true }).slide).toBe(-SPACE_SLIDE_PX)
    expect(planSpaceSwitch('back', { reduced: false, rtl: true }).slide).toBe(SPACE_SLIDE_PX)
  })
})

describe('the strip indicator frame', () => {
  const from = { left: 12, width: 80 }
  const to = { left: 140, width: 120 }

  it('stands on the old chip at 0 and rests on the new one at 1', () => {
    expect(indicatorFrame(from, to, 0)).toEqual({ dx: -128, scale: 80 / 120 })
    expect(indicatorFrame(from, to, 1)).toEqual({ dx: 0, scale: 1 })
  })

  it('moves linearly in the progress (the spring shapes the time)', () => {
    const half = indicatorFrame(from, to, 0.5)
    expect(half.dx).toBeCloseTo(-64)
    expect(half.scale).toBeCloseTo(1 + (80 / 120 - 1) / 2)
  })

  it('does not divide by a chip of no width', () => {
    expect(indicatorFrame(from, { left: 0, width: 0 }, 0).scale).toBe(1)
  })
})
