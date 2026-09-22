import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  atBar,
  backPulled,
  dismissed,
  FOCUS_MIN_TRAVEL,
  focusTarget,
  focusTravel,
  focusValue,
  holdsChrome,
  landed,
  OMNIBOX_FOCUS_REST,
  omniboxUp,
  progressed,
  slotGrowth,
  slotOf,
  tapped
} from '../motion/omniboxFocus'

/** A 360 band with one 44 button and a 4 gap either side of the pill (the phone bar's layout). */
const band = { x: 8, y: 700, width: 344, height: 44 }
const pill = { x: 56, y: 700, width: 248, height: 44 }

describe('the pill’s slot (MOT-07)', () => {
  it('reads the two slots the buttons leave and the pill’s share of the band', () => {
    const slot = slotOf(band, pill)
    expect(slot).toEqual({ left: 48, right: 48, scale: 248 / 344 })
    expect(slotGrowth(slot!)).toBe(96)
  })

  it('a pill filling the band (no buttons) grows by nothing but still has a slot', () => {
    const slot = slotOf(band, { ...pill, x: band.x, width: band.width })
    expect(slot).toEqual({ left: 0, right: 0, scale: 1 })
    expect(slotGrowth(slot!)).toBe(0)
  })

  it('an empty band or pill, or a pill outside the band, is no slot: the tap opens without the motion', () => {
    expect(slotOf({ ...band, width: 0 }, pill)).toBeNull()
    expect(slotOf(band, { ...pill, width: 0 })).toBeNull()
    expect(slotOf(band, { ...pill, x: 0 })).toBeNull()
    expect(slotOf(band, { ...pill, width: 400 })).toBeNull()
  })
})

describe('the spring’s travel', () => {
  it('is the field’s growth over the part of the way left, never under the minimum', () => {
    expect(focusTravel(0, 1, 96)).toBe(FOCUS_MIN_TRAVEL)
    expect(focusTravel(0, 1, 200)).toBe(200)
    expect(focusTravel(0.5, 1, 200)).toBe(100)
    expect(focusTravel(0.25, 0, 200)).toBe(50)
    // A short growth still reads: a one-button bar's 48 px is the minimum's 120.
    expect(focusTravel(0, 1, 48)).toBe(120)
  })
})

describe('the machine: the pill tapped, the spring, the landing', () => {
  it('rests at the bar’s pose with nothing up', () => {
    expect(focusValue(OMNIBOX_FOCUS_REST)).toBe(0)
    expect(omniboxUp(OMNIBOX_FOCUS_REST)).toBe(false)
    expect(holdsChrome(OMNIBOX_FOCUS_REST)).toBe(false)
  })

  it('a tap sets out for the omnibox from the bar; the bar is held mounted on the way', () => {
    const opening = tapped(OMNIBOX_FOCUS_REST)
    expect(opening.phase).toBe('opening')
    expect(focusValue(opening)).toBe(0)
    expect(focusTarget(opening)).toBe(1)
    expect(omniboxUp(opening)).toBe(true)
    expect(holdsChrome(opening)).toBe(true)
  })

  it('the spring’s progress moves the value from where the segment set out', () => {
    const half = progressed(tapped(OMNIBOX_FOCUS_REST), 0.5)
    expect(focusValue(half)).toBe(0.5)
    // Clamped: a spring's overshoot past the target is the target.
    expect(focusValue(progressed(half, 1.2))).toBe(1)
    expect(focusValue(progressed(half, -0.1))).toBe(0)
    // The same progress is the same state (no churn for the store).
    expect(progressed(half, 0.5)).toBe(half)
  })

  it('landing an opening is open at 1, with the bar released', () => {
    const open = landed(progressed(tapped(OMNIBOX_FOCUS_REST), 1))
    expect(open).toEqual({ phase: 'open', from: 1, t: 0, back: 0 })
    expect(focusValue(open)).toBe(1)
    expect(holdsChrome(open)).toBe(false)
    expect(omniboxUp(open)).toBe(true)
  })

  it('a tap while opening or open changes nothing', () => {
    const opening = tapped(OMNIBOX_FOCUS_REST)
    expect(tapped(opening)).toBe(opening)
    const open = landed(opening)
    expect(tapped(open)).toBe(open)
  })

  it('progress and landing mean nothing at rest or open', () => {
    expect(progressed(OMNIBOX_FOCUS_REST, 0.5)).toBe(OMNIBOX_FOCUS_REST)
    expect(landed(OMNIBOX_FOCUS_REST)).toBe(OMNIBOX_FOCUS_REST)
    const open = landed(tapped(OMNIBOX_FOCUS_REST))
    expect(progressed(open, 0.5)).toBe(open)
    expect(landed(open)).toBe(open)
  })
})

describe('the machine: dismissed, reversed, pulled', () => {
  const open = landed(tapped(OMNIBOX_FOCUS_REST))

  it('a dismissal runs back to the pill from the omnibox, the bar mounted again beneath', () => {
    const closing = dismissed(open)
    expect(closing.phase).toBe('closing')
    expect(focusValue(closing)).toBe(1)
    expect(focusTarget(closing)).toBe(0)
    expect(holdsChrome(closing)).toBe(true)
    expect(focusValue(progressed(closing, 0.75))).toBe(0.25)
    expect(landed(progressed(closing, 1))).toBe(OMNIBOX_FOCUS_REST)
  })

  it('a dismissal mid-flight runs back from where the field is', () => {
    const closing = dismissed(progressed(tapped(OMNIBOX_FOCUS_REST), 0.6))
    expect(closing.phase).toBe('closing')
    expect(focusValue(closing)).toBeCloseTo(0.6)
    expect(atBar(closing)).toBe(false)
  })

  it('a tap while closing turns round from where the field is', () => {
    const closing = progressed(dismissed(open), 0.7)
    const again = tapped(closing)
    expect(again.phase).toBe('opening')
    expect(focusValue(again)).toBeCloseTo(0.3)
    expect(focusValue(progressed(again, 0.5))).toBeCloseTo(0.65)
  })

  it('a dismissal at rest or while closing changes nothing', () => {
    expect(dismissed(OMNIBOX_FOCUS_REST)).toBe(OMNIBOX_FOCUS_REST)
    const closing = dismissed(open)
    expect(dismissed(closing)).toBe(closing)
  })

  it('the back gesture pulls an open field toward the pill and a cancel runs it back', () => {
    const pulled = backPulled(open, 0.4)
    expect(pulled.phase).toBe('open')
    expect(focusValue(pulled)).toBeCloseTo(0.6)
    expect(focusValue(backPulled(pulled, 0))).toBe(1)
    expect(focusValue(backPulled(pulled, 2))).toBe(0)
    expect(backPulled(pulled, 0.4)).toBe(pulled)
    // The bar is mounted under a pulled field, so its buttons are seen coming back; released
    // again when the pull is cancelled.
    expect(holdsChrome(pulled)).toBe(true)
    expect(holdsChrome(backPulled(pulled, 0))).toBe(false)
  })

  it('only an open field follows a pull; one on its spring keeps flying', () => {
    const opening = progressed(tapped(OMNIBOX_FOCUS_REST), 0.3)
    expect(backPulled(opening, 0.5)).toBe(opening)
    expect(backPulled(OMNIBOX_FOCUS_REST, 0.5)).toBe(OMNIBOX_FOCUS_REST)
  })

  it('a commit after the pull’s spring has finished has nothing to run back: the close goes through', () => {
    const home = backPulled(open, 1)
    expect(atBar(dismissed(home))).toBe(true)
    // A dismissal before the bar came up (the spring never started) likewise.
    expect(atBar(dismissed(tapped(OMNIBOX_FOCUS_REST)))).toBe(true)
    // A pull let go part way is the segment's to run.
    expect(atBar(dismissed(backPulled(open, 0.5)))).toBe(false)
  })
})

/*
 * What the value moves (main.css, not loaded here): one variable, `--zen-omnibox-focus`, on
 * transform and opacity alone, in the rides §11.8 fixed for the field morph – the bar's buttons
 * and the pill's words gone by half way, the sheet in from four tenths, the field's backdrop
 * arriving over the first half on top of the pill's fill (which leaves beneath it over the
 * second) and the field's contents over the second half. The omnibox's own entrance animations
 * yield while the motion owns the bar, and nothing under the flying field takes a tap.
 */
describe('the rides (main.css): one value, transform and opacity only', () => {
  // Whitespace collapsed, and none kept inside a bracket: the formatter wraps a long transform
  // across lines, and what is read here is the value, not its layout.
  const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
  const rule = (selector: string): string => {
    const at = css.indexOf(`${selector} {`)
    expect(at, `a rule for ${selector}`).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('}', at))
  }
  const moving = (selector: string): string =>
    rule(
      `:root[data-omnibox-focus='opening'] ${selector}, :root[data-omnibox-focus='pulled'] ${selector}, :root[data-omnibox-focus='closing'] ${selector}`
    )

  it('the bar’s buttons are pushed off by the widening field and gone by half way', () => {
    const left = moving('.zen-phone-bar-row > [data-bar-item]:not(.zen-phone-pill ~ *)')
    expect(left).toContain(
      'transform: translateX(calc(-1 * var(--zen-omnibox-slot-left, 48px) * var(--zen-omnibox-focus, 0)))'
    )
    const right = moving('.zen-phone-bar-row > .zen-phone-pill ~ [data-bar-item]')
    expect(right).toContain(
      'transform: translateX(calc(var(--zen-omnibox-slot-right, 48px) * var(--zen-omnibox-focus, 0)))'
    )
    // Their resting 85 % (a disabled one's 30 %) kept in the ride; their own transitions off.
    const all = moving('.zen-phone-bar-row > [data-bar-item]')
    expect(all).toContain('opacity: calc(0.85 * clamp(0, 1 - 2 * var(--zen-omnibox-focus, 0), 1))')
    expect(all).toContain('transition: background 120ms var(--zen-ease)')
    expect(moving('.zen-phone-bar-row > [data-bar-item][data-disabled]')).toContain(
      'opacity: calc(0.3 * clamp(0, 1 - 2 * var(--zen-omnibox-focus, 0), 1))'
    )
  })

  it('the pill’s words go with the buttons; its fill leaves under the field’s backdrop over the second half', () => {
    expect(moving('.zen-phone-pill > *')).toContain(
      'opacity: clamp(0, 1 - 2 * var(--zen-omnibox-focus, 0), 1)'
    )
    expect(moving('.zen-phone-pill')).toContain(
      'opacity: clamp(0, 2 - 2 * var(--zen-omnibox-focus, 0), 1)'
    )
    expect(moving('.zen-phone-bar')).toContain('pointer-events: none')
  })

  it('the field’s backdrop grows out of the slot on transform, arriving over the first half', () => {
    const backdrop = moving('.zen-omnibox-field::before')
    expect(backdrop).toContain('opacity: clamp(0, 2 * var(--zen-omnibox-focus, 0), 1)')
    expect(backdrop).toContain(
      'transform: translateX(calc(var(--zen-omnibox-slot-left, 48px) * (1 - var(--zen-omnibox-focus, 0)))) scaleX(calc(var(--zen-omnibox-slot-scale, 0.5) + (1 - var(--zen-omnibox-slot-scale, 0.5)) * var(--zen-omnibox-focus, 0)))'
    )
    expect(backdrop).not.toMatch(/\b(width|left|right|inset|padding|margin):/)
  })

  it('the field’s contents arrive over the second half riding the backdrop’s edges', () => {
    const contents = moving('.zen-omnibox-field > *')
    expect(contents).toContain('opacity: clamp(0, 2 * var(--zen-omnibox-focus, 0) - 1, 1)')
    expect(contents).toContain(
      'transform: translateX(calc(var(--zen-omnibox-slot-left, 48px) * (1 - var(--zen-omnibox-focus, 0))))'
    )
    expect(contents).toContain('transition: none')
    expect(moving('.zen-omnibox-field > input ~ *')).toContain(
      'transform: translateX(calc(-1 * var(--zen-omnibox-slot-right, 48px) * (1 - var(--zen-omnibox-focus, 0))))'
    )
  })

  it('the sheet fades in from four tenths of the way; nothing in it takes a tap on the way', () => {
    expect(moving('.zen-omnibox-sheet')).toContain(
      'opacity: clamp(0, (var(--zen-omnibox-focus, 0) - 0.4) / 0.6, 1)'
    )
    expect(
      rule(
        ":root[data-omnibox-focus='opening'] .zen-omnibox-sheet > *, :root[data-omnibox-focus='closing'] .zen-omnibox-sheet > *"
      )
    ).toContain('pointer-events: none')
    expect(rule(":root[data-omnibox-focus='closing'] .zen-omnibox-field")).toContain(
      'pointer-events: none'
    )
  })

  it('the omnibox’s own one-shot entrance yields while the motion owns the bar, at the landing too', () => {
    const own = rule(
      ':root[data-omnibox-focus] .zen-omnibox-sheet, :root[data-omnibox-focus] .zen-omnibox-field::before, :root[data-omnibox-focus] .zen-omnibox-field > *'
    )
    expect(own).toContain('animation: none')
  })

  it('under reduced motion the spring’s part is a 120 ms fade in place and the push is off', () => {
    // The fades live beside the motion's rules, in their layer under the same media query (v2
    // §11.3 as amended: the remover at the foot is unlayered, so a layered !important beats it;
    // reducedMotion.test.ts holds them to opacity alone at 120 ms).
    const motion = css.indexOf(":root[data-omnibox-focus='closing'] .zen-phone-bar {")
    expect(motion, 'the motion’s rules').toBeGreaterThan(-1)
    const media = css.indexOf('@media (prefers-reduced-motion: reduce) {', motion)
    expect(media, 'a reduced-motion block after the motion’s rules').toBeGreaterThan(motion)
    const reduced = css.slice(media, css.indexOf('@media (forced-colors: active)', media))
    const at = (selector: string): string => {
      const i = reduced.indexOf(`${selector} {`)
      expect(i, `a reduced-motion rule for ${selector}`).toBeGreaterThan(-1)
      return reduced.slice(i, reduced.indexOf('}', i))
    }
    expect(
      at(
        ":root[data-omnibox-focus='opening'] .zen-omnibox-sheet, :root[data-omnibox-focus='opening'] .zen-omnibox-field::before, :root[data-omnibox-focus='opening'] .zen-omnibox-field > *"
      )
    ).toContain('animation: zen-fade 120ms var(--zen-ease) both !important')
    expect(
      at(
        ":root[data-omnibox-focus='closing'] .zen-omnibox-sheet, :root[data-omnibox-focus='closing'] .zen-omnibox-field::before, :root[data-omnibox-focus='closing'] .zen-omnibox-field > *"
      )
    ).toContain('animation: zen-fade-out 120ms var(--zen-ease) both !important')
    const bar = at(
      ":root[data-omnibox-focus] .zen-phone-bar-row > [data-bar-item], :root[data-omnibox-focus] .zen-omnibox-field > *, :root[data-form-factor='phone'][data-omnibox-focus] .zen-phone-pill, :root[data-form-factor='phone'][data-omnibox-focus] .zen-phone-pill > *"
    )
    expect(bar).toContain('transform: none !important')
    expect(bar).toContain('transition: opacity 120ms var(--zen-ease) !important')
    expect(at(':root[data-omnibox-focus] .zen-omnibox-field::before')).toContain(
      'transform: none !important'
    )
  })
})
