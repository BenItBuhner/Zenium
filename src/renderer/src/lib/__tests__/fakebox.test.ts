import { describe, expect, it } from 'vitest'
import type { Rect } from '@shared/types'
import {
  backPulled,
  dismissed,
  drawsSurface,
  FAKEBOX_DOCK_RADIUS,
  FAKEBOX_PAGE_GONE_AT,
  FAKEBOX_REST,
  FAKEBOX_REST_RADIUS,
  landed,
  omniboxUp,
  openPose,
  pageOpacity,
  pillLook,
  poseOf,
  progressed,
  restPose,
  scrolled,
  scrubOf,
  scrubTravel,
  segmentTravel,
  showsOmniboxField,
  showsPageField,
  tapped,
  targetPose,
  type FakeboxGeometry,
  type FakeboxState
} from '../motion/fakebox'

// A 412 × 915 phone, the bar docked at the bottom (the default): the field a third of the way
// down the page, the pill's slot between the back button and the three on the right, the
// omnibox's field the whole band.
const rest: Rect = { x: 22, y: 284, width: 368, height: 56 }
const slot: Rect = { x: 56, y: 865, width: 204, height: 44 }
const omnibox: Rect = { x: 8, y: 865, width: 396, height: 44 }
const bottom: FakeboxGeometry = { rest, slot, omnibox, frameTop: 6 }
// The same phone with the bar at the top: the frame starts under the band.
const top: FakeboxGeometry = {
  rest: { ...rest, y: 340 },
  slot: { ...slot, y: 6 },
  omnibox: { ...omnibox, y: 6 },
  frameTop: 62
}

const near = (a: number, b: number): void => expect(Math.abs(a - b)).toBeLessThan(1e-9)

describe('the poses', () => {
  it('rests as the field itself and, scrubbed all the way, as the pill', () => {
    expect(restPose(bottom, 0)).toEqual({
      rect: rest,
      radius: FAKEBOX_REST_RADIUS,
      pill: 0,
      open: 0
    })
    expect(restPose(bottom, 1)).toEqual({
      rect: slot,
      radius: FAKEBOX_DOCK_RADIUS,
      pill: 1,
      open: 0
    })
    expect(openPose(bottom)).toEqual({
      rect: omnibox,
      radius: FAKEBOX_DOCK_RADIUS,
      pill: 0,
      open: 1
    })
  })

  it('moves every edge and the radius on a straight line between the two rests', () => {
    const mid = restPose(bottom, 0.5)
    near(mid.rect.x, (rest.x + slot.x) / 2)
    near(mid.rect.y, (rest.y + slot.y) / 2)
    near(mid.rect.width, (rest.width + slot.width) / 2)
    near(mid.rect.height, (rest.height + slot.height) / 2)
    near(mid.radius, (FAKEBOX_REST_RADIUS + FAKEBOX_DOCK_RADIUS) / 2)
    // The surface keeps the field's look until the last stretch, then takes the pill's.
    expect(mid.pill).toBe(0)
    expect(pillLook(0.7)).toBe(0)
    near(pillLook(0.85), 0.5)
    expect(pillLook(1)).toBe(1)
  })

  it('clamps a spring overshoot: the surface never passes either rest', () => {
    expect(restPose(bottom, 1.3)).toEqual(restPose(bottom, 1))
    expect(restPose(bottom, -0.2)).toEqual(restPose(bottom, 0))
  })

  it('fades the page out by the gone-at mark and back on the same line', () => {
    expect(pageOpacity(0)).toBe(1)
    expect(pageOpacity(FAKEBOX_PAGE_GONE_AT / 2)).toBe(0.5)
    expect(pageOpacity(FAKEBOX_PAGE_GONE_AT)).toBe(0)
    expect(pageOpacity(1)).toBe(0)
  })
})

describe('the scrub: the page carries the field to the pill slot', () => {
  it('runs over the distance at which the field leaves the viewport', () => {
    // The field's bottom edge passes the frame's top edge.
    expect(scrubTravel(bottom)).toBe(rest.y + rest.height - 6)
    // At a top dock the band and the field are both 56 tall, so that distance is the one the
    // field's natural place takes to reach the slot: it moves one to one with the page.
    expect(scrubTravel(top)).toBe(top.rest.y - top.slot.y)
    expect(scrubOf(0, top)).toBe(0)
    near(scrubOf(scrubTravel(top) / 4, top), 0.25)
    expect(scrubOf(scrubTravel(top), top)).toBe(1)
    expect(scrubOf(scrubTravel(top) * 3, top)).toBe(1)
    const quarter = restPose(top, 0.25)
    near(quarter.rect.y, top.rest.y - scrubTravel(top) / 4)
  })

  it('never divides by nothing when the field is already above the frame', () => {
    const odd: FakeboxGeometry = { ...top, rest: { ...top.rest, y: -100 } }
    expect(scrubTravel(odd)).toBe(1)
    expect(scrubOf(0.5, odd)).toBe(0.5)
  })

  it('draws its own surface only between the two rests', () => {
    const still = scrolled(FAKEBOX_REST, 0, top)
    expect(still).toBe(FAKEBOX_REST)
    expect(drawsSurface(still)).toBe(false)
    expect(showsPageField(still)).toBe(true)
    const part = scrolled(FAKEBOX_REST, 100, top)
    expect(part.phase).toBe('rest')
    expect(drawsSurface(part)).toBe(true)
    expect(showsPageField(part)).toBe(false)
    const docked = scrolled(FAKEBOX_REST, 10_000, top)
    expect(docked.scrub).toBe(1)
    expect(drawsSurface(docked)).toBe(false)
    expect(showsPageField(docked)).toBe(false)
    expect(showsOmniboxField(docked)).toBe(false)
    expect(omniboxUp(docked)).toBe(false)
  })
})

describe('a tap: one spring to the omnibox from wherever the field is', () => {
  it('sets out from the resting field', () => {
    const s = tapped(FAKEBOX_REST, bottom)
    expect(s.phase).toBe('opening')
    expect(s.t).toBe(0)
    expect(s.from).toEqual(restPose(bottom, 0))
    expect(poseOf(s, bottom)).toEqual(restPose(bottom, 0))
    expect(targetPose(s, bottom)).toEqual(openPose(bottom))
    expect(omniboxUp(s)).toBe(true)
    expect(drawsSurface(s)).toBe(true)
    expect(showsPageField(s)).toBe(false)
    expect(showsOmniboxField(s)).toBe(false)
  })

  it('sets out from a scrubbed field without a jump', () => {
    const part = scrolled(FAKEBOX_REST, scrubTravel(top) / 2, top)
    const s = tapped(part, top)
    expect(s.from).toEqual(restPose(top, 0.5))
    expect(poseOf(s, top)).toEqual(restPose(top, 0.5))
    const half = progressed(s, 0.5)
    const pose = poseOf(half, top)
    near(pose.rect.y, (restPose(top, 0.5).rect.y + top.omnibox.y) / 2)
    near(pose.open, 0.5)
    // The scrub is kept for the way back.
    expect(half.scrub).toBe(0.5)
  })

  it('lands as the omnibox, whose own field then draws', () => {
    const s = landed(progressed(tapped(FAKEBOX_REST, bottom), 1))
    expect(s.phase).toBe('open')
    expect(s.from).toBeNull()
    expect(poseOf(s, bottom)).toEqual(openPose(bottom))
    expect(drawsSurface(s)).toBe(false)
    expect(showsOmniboxField(s)).toBe(true)
    expect(omniboxUp(s)).toBe(true)
  })

  it('does nothing to a field already on its way up or open', () => {
    const opening = progressed(tapped(FAKEBOX_REST, bottom), 0.4)
    expect(tapped(opening, bottom)).toBe(opening)
    const open = landed(progressed(opening, 1))
    expect(tapped(open, bottom)).toBe(open)
  })

  it('runs on a distance that is the poses\u2019, never under 120 px', () => {
    const travel = segmentTravel(restPose(bottom, 0), openPose(bottom))
    expect(travel).toBeGreaterThan(500)
    expect(segmentTravel(openPose(bottom), openPose(bottom))).toBe(120)
  })
})

describe('a dismissal: the same value runs back into the field', () => {
  it('turns round mid-flight from exactly where the surface is', () => {
    const mid = progressed(tapped(FAKEBOX_REST, bottom), 0.3)
    const there = poseOf(mid, bottom)
    const back = dismissed(mid, bottom)
    expect(back.phase).toBe('closing')
    expect(back.t).toBe(0)
    expect(back.from).toEqual(there)
    expect(poseOf(back, bottom)).toEqual(there)
    expect(targetPose(back, bottom)).toEqual(restPose(bottom, 0))
    // The omnibox stays mounted (fading on the value) until the field has landed.
    expect(omniboxUp(back)).toBe(true)
    expect(showsOmniboxField(back)).toBe(false)
    const home = landed(progressed(back, 1))
    expect(home.phase).toBe('rest')
    expect(home).toEqual(FAKEBOX_REST)
    expect(showsPageField(home)).toBe(true)
  })

  it('returns to the scrubbed pose when the page was scrolled, not to the top', () => {
    const part = scrolled(FAKEBOX_REST, scrubTravel(top) / 2, top)
    const open = landed(progressed(tapped(part, top), 1))
    const back = dismissed(open, top)
    expect(targetPose(back, top)).toEqual(restPose(top, 0.5))
    const home = landed(progressed(back, 1))
    expect(home.phase).toBe('rest')
    expect(home.scrub).toBe(0.5)
    expect(drawsSurface(home)).toBe(true)
  })

  it('is caught by a tap and goes up again from where it is', () => {
    const open = landed(progressed(tapped(FAKEBOX_REST, bottom), 1))
    const back = progressed(dismissed(open, bottom), 0.6)
    const there = poseOf(back, bottom)
    const again = tapped(back, bottom)
    expect(again.phase).toBe('opening')
    expect(again.from).toEqual(there)
    expect(poseOf(again, bottom)).toEqual(there)
  })

  it('does nothing at rest or when already closing', () => {
    expect(dismissed(FAKEBOX_REST, bottom)).toBe(FAKEBOX_REST)
    const closing = dismissed(landed(progressed(tapped(FAKEBOX_REST, bottom), 1)), bottom)
    expect(dismissed(closing, bottom)).toBe(closing)
  })
})

describe('the predictive back gesture', () => {
  const open = landed(progressed(tapped(FAKEBOX_REST, bottom), 1))

  it('pulls the open field back toward the page with the finger, and the surface draws again', () => {
    const pulled = backPulled(open, 0.4)
    expect(pulled.phase).toBe('open')
    expect(pulled.back).toBe(0.4)
    expect(drawsSurface(pulled)).toBe(true)
    expect(showsOmniboxField(pulled)).toBe(false)
    const pose = poseOf(pulled, bottom)
    near(pose.open, 0.6)
    near(pose.rect.y, omnibox.y + (rest.y - omnibox.y) * 0.4)
    // Cancelled: back to 0, the omnibox's field draws once more.
    const released = backPulled(pulled, 0)
    expect(released.back).toBe(0)
    expect(showsOmniboxField(released)).toBe(true)
    expect(drawsSurface(released)).toBe(false)
  })

  it('commits into a closing run from the pulled pose', () => {
    const pulled = backPulled(open, 0.4)
    const there = poseOf(pulled, bottom)
    const closing = dismissed(pulled, bottom)
    expect(closing.phase).toBe('closing')
    expect(closing.from).toEqual(there)
    expect(closing.back).toBe(0)
  })

  it('leaves a field still on its spring alone', () => {
    const opening = progressed(tapped(FAKEBOX_REST, bottom), 0.5)
    expect(backPulled(opening, 0.5)).toBe(opening)
  })
})

describe('interruptions resolve to one state', () => {
  it('a rotation or the keyboard: new geometry, same phase and progress, the target follows', () => {
    const half = progressed(tapped(FAKEBOX_REST, bottom), 0.5)
    // The keyboard arrived: the bottom band rides its inset.
    const raised: FakeboxGeometry = {
      ...bottom,
      omnibox: { ...omnibox, y: 565 },
      slot: { ...slot, y: 565 }
    }
    expect(targetPose(half, raised).rect.y).toBe(565)
    const pose = poseOf(half, raised)
    near(pose.rect.y, (rest.y + 565) / 2)
    // No state changed for it: the same segment keeps running.
    expect(half.phase).toBe('opening')
    expect(half.t).toBe(0.5)
  })

  it('a scroll under a running segment only moves the way back', () => {
    const opening = progressed(tapped(FAKEBOX_REST, top), 0.5)
    const scrolledUnder = scrolled(opening, scrubTravel(top) / 2, top)
    expect(scrolledUnder.phase).toBe('opening')
    expect(scrolledUnder.t).toBe(0.5)
    expect(scrolledUnder.scrub).toBe(0.5)
    expect(targetPose(scrolledUnder, top)).toEqual(openPose(top))
    expect(targetPose(dismissed(scrolledUnder, top), top)).toEqual(restPose(top, 0.5))
  })

  it('progress is only heard while a segment runs, and is clamped', () => {
    expect(progressed(FAKEBOX_REST, 0.5)).toBe(FAKEBOX_REST)
    const s = tapped(FAKEBOX_REST, bottom)
    expect(progressed(s, 1.4).t).toBe(1)
    expect(progressed(s, -1).t).toBe(0)
    const open = landed(progressed(s, 1))
    expect(landed(open)).toBe(open)
    const rested: FakeboxState = FAKEBOX_REST
    expect(landed(rested)).toBe(rested)
  })
})
