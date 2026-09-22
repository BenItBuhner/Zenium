import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Rect } from '@shared/types'
import {
  backPulled,
  dismissed,
  dockBelow,
  drawsSurface,
  drawsSurfaceReduced,
  FAKEBOX_DOCK_RADIUS,
  FAKEBOX_PAGE_GONE_AT,
  FAKEBOX_REST,
  FAKEBOX_REST_RADIUS,
  FAKEBOX_SHEET_FROM,
  fakeboxContentWidth,
  landed,
  omniboxContentWidth,
  omniboxUp,
  openPose,
  pageFieldAtRest,
  pageOpacity,
  pillLook,
  poseOf,
  posesCoincide,
  progressed,
  reducedPose,
  restPose,
  scrolled,
  scrubOf,
  scrubTravel,
  segmentDistance,
  segmentTravel,
  sheetOpacity,
  showsOmniboxField,
  showsPageField,
  tapped,
  targetPose,
  widestPoseWidth,
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
  it('rests as the field itself and, scrubbed all the way at a top dock, as the pill', () => {
    expect(restPose(top, 0)).toEqual({
      rect: top.rest,
      radius: FAKEBOX_REST_RADIUS,
      pill: 0,
      open: 0
    })
    expect(restPose(top, 1)).toEqual({
      rect: top.slot,
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

  it('moves every edge and the radius on a straight line between the two rests at a top dock', () => {
    const mid = restPose(top, 0.5)
    near(mid.rect.x, (top.rest.x + top.slot.x) / 2)
    near(mid.rect.y, (top.rest.y + top.slot.y) / 2)
    near(mid.rect.width, (top.rest.width + top.slot.width) / 2)
    near(mid.rect.height, (top.rest.height + top.slot.height) / 2)
    near(mid.radius, (FAKEBOX_REST_RADIUS + FAKEBOX_DOCK_RADIUS) / 2)
    // The surface keeps the field's look until the last stretch, then takes the pill's.
    expect(mid.pill).toBe(0)
    expect(pillLook(0.7)).toBe(0)
    near(pillLook(0.85), 0.5)
    expect(pillLook(1)).toBe(1)
  })

  it('knows which side of the page the bar is on', () => {
    expect(dockBelow(bottom)).toBe(true)
    expect(dockBelow(top)).toBe(false)
  })

  it('at a bottom dock rides up with the page as content, never against the finger (v2 §11.8)', () => {
    // Exactly as far as the page has scrolled, the same size and corners …
    const travel = scrubTravel(bottom)
    const part = restPose(bottom, 0.5)
    expect(part.rect).toEqual({ ...rest, y: rest.y - travel / 2 })
    expect(part.radius).toBe(FAKEBOX_REST_RADIUS)
    expect(part.pill).toBe(0)
    // … until its bottom edge has cleared the frame's top, when the scrub is done and the pill
    // whole: the handover is the fade over the last three tenths, the same as the well's.
    const gone = restPose(bottom, 1)
    near(gone.rect.y + gone.rect.height, bottom.frameTop)
    expect(gone.pill).toBe(1)
    near(restPose(bottom, 0.85).pill, 0.5)
    // Only the tap's spring travels toward the dock: from the ridden pose down to the band.
    const s = tapped(scrolled(FAKEBOX_REST, travel / 2, bottom), bottom)
    expect(s.from).toEqual(part)
    expect(targetPose(s, bottom).rect.y).toBe(omnibox.y)
  })

  it('clamps a spring overshoot: the surface never passes either rest', () => {
    expect(restPose(top, 1.3)).toEqual(restPose(top, 1))
    expect(restPose(top, -0.2)).toEqual(restPose(top, 0))
    expect(restPose(bottom, 1.3)).toEqual(restPose(bottom, 1))
  })

  it('fades the page out by the gone-at mark and back on the same line', () => {
    expect(pageOpacity(0)).toBe(1)
    expect(pageOpacity(FAKEBOX_PAGE_GONE_AT / 2)).toBe(0.5)
    expect(pageOpacity(FAKEBOX_PAGE_GONE_AT)).toBe(0)
    expect(pageOpacity(1)).toBe(0)
  })

  it('brings the sheet in from the sheet-from mark, whole at the landing, under a receding page', () => {
    expect(sheetOpacity(0)).toBe(0)
    expect(sheetOpacity(FAKEBOX_SHEET_FROM)).toBe(0)
    expect(sheetOpacity((FAKEBOX_SHEET_FROM + 1) / 2)).toBe(0.5)
    expect(sheetOpacity(1)).toBe(1)
    // The page is on its way out before the sheet shows, so no frame has both whole.
    expect(FAKEBOX_SHEET_FROM).toBeLessThan(FAKEBOX_PAGE_GONE_AT)
    expect(pageOpacity(FAKEBOX_SHEET_FROM)).toBeLessThan(0.5)
  })

  it('lays the words out once, at the widest pose, less the room the page field gives its glyphs', () => {
    // The omnibox's field is the widest pose on a phone (the band edge to edge); the rest is on a
    // wide page in landscape, where the field is capped and the omnibox is not.
    expect(widestPoseWidth(bottom)).toBe(omnibox.width)
    expect(widestPoseWidth({ ...bottom, rest: { ...rest, width: 520 } })).toBe(520)
    // pl-4, then the mic and the camera (44 each, gap 2) and their pr-1.5 …
    expect(fakeboxContentWidth(396, 2)).toBe(396 - 16 - (44 + 2 + 44 + 6))
    expect(fakeboxContentWidth(396, 1)).toBe(396 - 16 - (44 + 6))
    // … or the field's own pr-4 with neither.
    expect(fakeboxContentWidth(396, 0)).toBe(396 - 16 - 16)
    expect(fakeboxContentWidth(10, 2)).toBe(0)
    // The omnibox field's content the same way: pl-2, then a gap-2.5 and 44 for each control
    // (flush with the end, no padding after).
    expect(omniboxContentWidth(396, 2)).toBe(396 - 8 - 2 * (10 + 44))
    expect(omniboxContentWidth(396, 1)).toBe(396 - 8 - (10 + 44))
    expect(omniboxContentWidth(396, 0)).toBe(396 - 8)
    expect(omniboxContentWidth(4, 2)).toBe(0)
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

  it('draws its own surface only between the two rests at a top dock', () => {
    const still = scrolled(FAKEBOX_REST, 0, top)
    expect(still).toBe(FAKEBOX_REST)
    expect(drawsSurface(still, top)).toBe(false)
    expect(showsPageField(still, top)).toBe(true)
    const part = scrolled(FAKEBOX_REST, 100, top)
    expect(part.phase).toBe('rest')
    expect(drawsSurface(part, top)).toBe(true)
    expect(showsPageField(part, top)).toBe(false)
    const docked = scrolled(FAKEBOX_REST, 10_000, top)
    expect(docked.scrub).toBe(1)
    expect(drawsSurface(docked, top)).toBe(false)
    expect(showsPageField(docked, top)).toBe(false)
    expect(showsOmniboxField(docked)).toBe(false)
    expect(omniboxUp(docked)).toBe(false)
  })

  it('at a bottom dock leaves the page its own field until it has left the frame', () => {
    // Content rides and fades where it is: nothing for a double to add.
    const part = scrolled(FAKEBOX_REST, 100, bottom)
    expect(drawsSurface(part, bottom)).toBe(false)
    expect(showsPageField(part, bottom)).toBe(true)
    expect(pageFieldAtRest(0.99, bottom)).toBe(true)
    const docked = scrolled(FAKEBOX_REST, 10_000, bottom)
    expect(drawsSurface(docked, bottom)).toBe(false)
    expect(showsPageField(docked, bottom)).toBe(false)
    // The tap's spring draws the double either way.
    expect(drawsSurface(tapped(part, bottom), bottom)).toBe(true)
    expect(showsPageField(tapped(part, bottom), bottom)).toBe(false)
  })
})

describe('reduced motion: the spring is a fade in place, the double only where it is what fades', () => {
  it('draws the double for a segment leaving or returning to a scrubbed field at a top dock', () => {
    const part = scrolled(FAKEBOX_REST, scrubTravel(top) / 2, top)
    const up = tapped(part, top)
    expect(drawsSurfaceReduced(up, top)).toBe(true)
    // Where it was, not where the machine (which jumped) says.
    expect(reducedPose(progressed(up, 1), top)).toEqual(restPose(top, 0.5))
    const back = dismissed(landed(progressed(up, 1)), top)
    expect(drawsSurfaceReduced(back, top)).toBe(true)
    expect(reducedPose(back, top)).toEqual(restPose(top, 0.5))
  })

  it('draws nothing where the page field or the omnibox field fades itself', () => {
    expect(drawsSurfaceReduced(tapped(FAKEBOX_REST, top), top)).toBe(false)
    const part = scrolled(FAKEBOX_REST, 100, bottom)
    expect(drawsSurfaceReduced(tapped(part, bottom), bottom)).toBe(false)
    const open = landed(progressed(tapped(FAKEBOX_REST, top), 1))
    expect(drawsSurfaceReduced(open, top)).toBe(false)
    expect(drawsSurfaceReduced(part, bottom)).toBe(false)
    expect(reducedPose(open, top)).toEqual(openPose(top))
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
    expect(drawsSurface(s, bottom)).toBe(true)
    expect(showsPageField(s, bottom)).toBe(false)
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
    expect(drawsSurface(s, bottom)).toBe(false)
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
    expect(segmentDistance(openPose(bottom), openPose(bottom))).toBe(0)
  })

  it('knows when two poses are the same place, so a segment between them lands at once', () => {
    const home = restPose(bottom, 0)
    expect(posesCoincide(home, home)).toBe(true)
    expect(posesCoincide(home, { ...home, rect: { ...home.rect, y: home.rect.y + 0.4 } })).toBe(
      true
    )
    expect(posesCoincide(home, { ...home, rect: { ...home.rect, y: home.rect.y + 2 } })).toBe(false)
    // The same rectangle as another pose is not the same pose while the fades differ.
    expect(posesCoincide(home, { ...home, open: 1 })).toBe(false)
    expect(posesCoincide(restPose(top, 1), openPose(top))).toBe(false)
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
    expect(showsPageField(home, bottom)).toBe(true)
  })

  it('returns to the scrubbed pose when the page was scrolled, not to the top', () => {
    const part = scrolled(FAKEBOX_REST, scrubTravel(top) / 2, top)
    const open = landed(progressed(tapped(part, top), 1))
    const back = dismissed(open, top)
    expect(targetPose(back, top)).toEqual(restPose(top, 0.5))
    const home = landed(progressed(back, 1))
    expect(home.phase).toBe('rest')
    expect(home.scrub).toBe(0.5)
    expect(drawsSurface(home, top)).toBe(true)
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
    expect(drawsSurface(pulled, bottom)).toBe(true)
    expect(showsOmniboxField(pulled)).toBe(false)
    const pose = poseOf(pulled, bottom)
    near(pose.open, 0.6)
    near(pose.rect.y, omnibox.y + (rest.y - omnibox.y) * 0.4)
    // Cancelled: back to 0, the omnibox's field draws once more.
    const released = backPulled(pulled, 0)
    expect(released.back).toBe(0)
    expect(showsOmniboxField(released)).toBe(true)
    expect(drawsSurface(released, bottom)).toBe(false)
  })

  it('commits into a closing run from the pulled pose', () => {
    const pulled = backPulled(open, 0.4)
    const there = poseOf(pulled, bottom)
    const closing = dismissed(pulled, bottom)
    expect(closing.phase).toBe('closing')
    expect(closing.from).toEqual(there)
    expect(closing.back).toBe(0)
  })

  it('a commit after the gesture has pulled the field all the way home has nothing left to run', () => {
    // The gesture's own driver takes its value to 1 before it commits: the field is at the
    // page's pose already, and the closing segment is the same place to the same place.
    const home = backPulled(open, 1)
    expect(poseOf(home, bottom)).toEqual(restPose(bottom, 0))
    const closing = dismissed(home, bottom)
    expect(posesCoincide(poseOf(closing, bottom), targetPose(closing, bottom))).toBe(true)
    // Whereas a commit mid-pull has the rest of the way to go.
    const midway = dismissed(backPulled(open, 0.4), bottom)
    expect(posesCoincide(poseOf(midway, bottom), targetPose(midway, bottom))).toBe(false)
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

/*
 * The pill's slot while the field is the page's (main.css, not loaded here): its words draw by
 * the handover alone. The shell takes the bar down while the omnibox is open and mounts it again
 * as a closing or a pull begins, so the pill's content replays its entrance fade under the field
 * coming home; an animation's value outranks a plain declaration, an important one outranks
 * the animation (run 3's `top-rest`: the well's words at .15 over a handover of 0 for a frame).
 */
describe('the well (main.css): the words on the handover alone', () => {
  const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8').replace(/\s+/g, ' ')
  const rule = (selector: string): string => {
    const at = css.indexOf(`${selector} {`)
    expect(at, `a rule for ${selector}`).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('}', at))
  }

  it('the away pill’s children take their opacity from --zen-ntp-pill over any animation of their own', () => {
    const words = rule(":root[data-form-factor='phone'] .zen-phone-pill.zen-pill-away > *")
    expect(words).toContain('opacity: var(--zen-ntp-pill, 0) !important')
    expect(words).toContain('pointer-events: none')
    // The entrance fade that made the rule important: the pill's content class is an animation.
    expect(rule('.zen-animate-fade')).toMatch(/animation: zen-fade \d+ms/)
  })
})

/** The style rules of main.css under a `prefers-reduced-motion: reduce` media query: selectors and body. */
function reducedMotionRules(css: string): Array<{ selectors: string[]; body: string }> {
  const rules: Array<{ selectors: string[]; body: string }> = []
  const open: string[] = []
  let buffer = ''
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') {
      open.push(buffer.trim().replace(/\s+/g, ' '))
      buffer = ''
    } else if (ch === '}') {
      const prelude = open.pop()!
      if (
        !prelude.startsWith('@') &&
        open.some((p) => p.includes('prefers-reduced-motion: reduce'))
      )
        rules.push({
          selectors: prelude.split(',').map((s) => s.trim()),
          body: buffer.trim().replace(/\s+/g, ' ')
        })
      buffer = ''
    } else buffer += ch
  }
  return rules
}

/*
 * What the morph measures against is laid out, never transitioned (main.css, not loaded here).
 * Under the old reduced-motion rule every property change became a 0.01 ms transition the
 * compositor starts a frame late – frames late on a slow one – and the controller measured the
 * pill's slot and the page's frame the frame the layout reporter said the frame had moved: a box
 * still on its way from the old dock's values was measured where it was not (run 2's
 * reduced-top-scrub: the content column's padding; run 3's: the bar clip's edge and the bar's
 * inset paddings, the slot read 48 px above its rest). #243 cut the column, the clip, the bar and
 * the page to `transition-property: none` one by one; v2 §11.3 as amended makes that the rule for
 * everything (reducedMotion.test.ts): ONE global rule at the foot removes every transition and
 * animation, and the morph's fades – the bar's and the page's opacity over the value's jump – are
 * the only rules on those elements under reduced motion, opacity alone at 120 ms, `!important`.
 */
describe('the layout the morph measures (main.css): no transition under reduced motion', () => {
  const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')
  const reduced = reducedMotionRules(css)
  // The class itself, whole: `.zen-phone-bar` is not `.zen-phone-bar-row`, whose items' opacity
  // fade under the pill's focus motion (MOT-07, lib/omniboxFocus.ts) is their own and lays out
  // nothing the morph measures.
  const names = (selector: string, className: string): boolean =>
    new RegExp(`${className.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![\\w-])`).test(selector)
  const on = (className: string): Array<{ selectors: string[]; body: string }> =>
    reduced.filter((r) => r.selectors.some((s) => names(s, className)))

  it('one global rule removes every transition and animation, pseudo-elements included', () => {
    const removers = reduced.filter((r) => r.selectors.includes('*'))
    expect(removers).toHaveLength(1)
    expect(removers[0].selectors).toEqual(['*', '::before', '::after'])
    expect(removers[0].body).toBe(
      'transition-property: none !important; animation: none !important;'
    )
  })

  it('the content column, the bar clip and the bar cut to the new dock: nothing re-declares theirs', () => {
    expect(on('.zen-content-column')).toEqual([])
    expect(on('.zen-phone-bar-clip')).toEqual([])
    // The bar has rules under reduced motion for the morph's two phases alone: its fade.
    const bar = on('.zen-phone-bar')
    expect(bar.flatMap((r) => r.selectors.filter((s) => names(s, '.zen-phone-bar')))).toEqual([
      ":root[data-fakebox='closing'] .zen-phone-bar",
      ":root[data-fakebox='opening'] .zen-phone-bar"
    ])
  })

  it('the bar’s opacity fade over the value’s jump is written out, opacity alone at 120 ms and !important', () => {
    const [fade] = on(":root[data-fakebox='opening'] .zen-phone-bar")
    expect(fade.selectors).toEqual([
      ":root[data-fakebox='opening'] .zen-phone-bar",
      ":root[data-fakebox='opening'] .zen-ntp-fades",
      ":root[data-fakebox='closing'] .zen-ntp-fades"
    ])
    expect(fade.body).toBe('transition: opacity 120ms var(--zen-ease) !important;')
  })
})

/*
 * The page under the omnibox is kept mounted and unpainted (`visibility: hidden` on
 * `.zen-ntp[data-hidden]`, ContentArea.tsx) and comes back the frame the closing begins.
 * `visibility` transitions, and under the old reduced-motion rule's 0.01 ms that change was a
 * transition too: play-pending until the compositor starts its batch, and a pending transition
 * draws its start value, so the page stayed hidden past the commit that showed it (run 3's
 * reduced-bottom on the emulator: blank at rest for 0.7 to 1.1 s with nothing pending on anything
 * the sampler watched; a frame on a phone). It inherits, so each descendant would take its own
 * when the page cuts. The global rule removes them all; nothing in the page transitions but the
 * page's own fades, on opacity alone.
 */
describe('the page under the omnibox (main.css): its visibility cuts under reduced motion', () => {
  const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')
  const folded = css.replace(/\s+/g, ' ')
  const reduced = reducedMotionRules(css)

  it('the page and everything in it transition nothing: no rule of theirs under reduced motion', () => {
    // The property that made the rule necessary: the page waits under the omnibox unpainted.
    const hidden = folded.indexOf(":root[data-form-factor='phone'] .zen-ntp[data-hidden] {")
    expect(hidden).toBeGreaterThan(-1)
    expect(folded.slice(hidden, folded.indexOf('}', hidden))).toContain('visibility: hidden')
    // Neither the page, nor its descendants as a class, nor its hidden state re-declare a
    // transition: the one global rule cuts them (the tiles' own fade is paused while hidden).
    const page = reduced.filter((r) =>
      r.selectors.some((s) => /\.zen-ntp(\[data-hidden\])?( \*)?$/.test(s))
    )
    expect(page).toEqual([])
  })

  it('the page’s fades keep opacity, their one property, at v2 §11.3’s 120 ms', () => {
    const fades = reduced.filter((r) => r.selectors.some((s) => s.endsWith('.zen-ntp-fades')))
    expect(fades).toHaveLength(1)
    expect(fades[0].selectors).toContain(":root[data-fakebox='closing'] .zen-ntp-fades")
    expect(fades[0].selectors).toContain(":root[data-fakebox='opening'] .zen-ntp-fades")
    expect(fades[0].body).toBe('transition: opacity 120ms var(--zen-ease) !important;')
  })
})
