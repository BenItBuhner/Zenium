import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SPRING_GENTLE as SHARED_GENTLE, SPRING_SNAPPY as SHARED_SNAPPY } from '@shared/spring'
import { TOAST_SHOW_MS, TOAST_UNDO_MS as SHARED_UNDO } from '@shared/toastCard'
import {
  BAND_CLOCK_MS,
  LIFT_OPACITY,
  LIFT_SCALE,
  LIFT_SHADOW_LEVEL,
  MOTION_CAP_MS,
  MOTION_MESSAGE_MS,
  MOTION_POP_MS,
  MOTION_STATE_MS,
  PRESS_SCALE,
  SPRING_FOLLOW,
  SPRING_GENTLE,
  SPRING_SNAPPY,
  SPRING_STEP_CLAMP_MS,
  TOAST_ACTION_MS,
  TOAST_DURATION,
  TOAST_UNDO_MS,
  ZEN_EASE
} from '../motion/tokens'
import { SPRING_STEP_CLAMP_MS as SPRING_CLAMP } from '../motion/spring'

/*
 * The motion tokens (motion-and-interaction-spec §1, W8-M1): the module exports exactly the
 * table, the springs are the shared ones at the table's k / c (and the follow spring the lead
 * added on #734, the dock's value), and the one curve is main.css's `--zen-ease`. A number that
 * drifts from the spec fails here before a surface can inherit it.
 */

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const css = read('../../assets/main.css')

describe('motion tokens (§1)', () => {
  it('the four durations and the cap', () => {
    expect(MOTION_STATE_MS).toBe(120)
    expect(MOTION_POP_MS).toBe(180)
    expect(MOTION_MESSAGE_MS).toBe(200)
    expect(MOTION_CAP_MS).toBe(300)
  })

  it('the two springs are the shared ones, at the table’s k and c', () => {
    expect(SPRING_SNAPPY).toBe(SHARED_SNAPPY)
    expect(SPRING_GENTLE).toBe(SHARED_GENTLE)
    expect(SPRING_SNAPPY).toMatchObject({ stiffness: 420, damping: 40, mass: 1 })
    expect(SPRING_GENTLE).toMatchObject({ stiffness: 300, damping: 31, mass: 1 })
    // ζ = c / (2 √(k m)): snappy ≈ .98 (no visible overshoot), gentle ≈ .9 (a hair of it).
    const zeta = (s: { stiffness: number; damping: number; mass: number }): number =>
      s.damping / (2 * Math.sqrt(s.stiffness * s.mass))
    expect(zeta(SPRING_SNAPPY)).toBeCloseTo(0.976, 2)
    expect(zeta(SPRING_GENTLE)).toBeCloseTo(0.895, 2)
  })

  it('the follow spring is the dock’s value (k 1200, c 68), and the dock and the card lift read it', () => {
    expect(SPRING_FOLLOW).toMatchObject({ stiffness: 1200, damping: 68, mass: 1 })
    expect(SPRING_FOLLOW).toMatchObject({ restDelta: 0.2, restSpeed: 4 })
    const zeta =
      SPRING_FOLLOW.damping / (2 * Math.sqrt(SPRING_FOLLOW.stiffness * SPRING_FOLLOW.mass))
    expect(zeta).toBeCloseTo(0.981, 2)
    // Neither reader writes a follow spring of its own any more: the dock (outside the
    // vocabulary pin's walk) imports the token, and so does the overview's card in the hand.
    const dock = read('../gestures/dock.ts')
    expect(dock).toMatch(/import \{ SPRING_FOLLOW \} from '\.\.\/motion\/tokens'/)
    expect(dock).not.toMatch(/const SPRING_FOLLOW\b/)
    expect(dock).not.toMatch(/stiffness: 1200/)
    const lift = read('../../components/phone/useCardLift.ts')
    expect(lift).toMatch(/SPRING_FOLLOW \} from '@renderer\/lib\/motion\/tokens'/)
    expect(lift).not.toMatch(/const SPRING_FOLLOW\b/)
  })

  it('the stepped motion clamp is the spring module’s one figure', () => {
    expect(SPRING_STEP_CLAMP_MS).toBe(64)
    expect(SPRING_STEP_CLAMP_MS).toBe(SPRING_CLAMP)
  })

  it('the clocks: the toast card’s owned values re-exported, the band’s 10 s', () => {
    expect(TOAST_UNDO_MS).toBe(8000)
    expect(TOAST_UNDO_MS).toBe(SHARED_UNDO)
    // The shipped plain toast is v2 §9.33's 2.8 s (§1's table says 4 s; the gap is the lead's).
    expect(TOAST_DURATION).toBe(TOAST_SHOW_MS)
    expect(TOAST_DURATION).toBe(2800)
    expect(TOAST_ACTION_MS).toBe(5000)
    expect(BAND_CLOCK_MS).toBe(10_000)
  })

  it('`lib/ui.ts` hands out the same TOAST_DURATION, and its action clock is TOAST_ACTION_MS', async () => {
    const ui = await import('../ui')
    expect(ui.TOAST_DURATION).toBe(TOAST_DURATION)
    expect(ui.TOAST_ACTION_DURATION).toBe(TOAST_ACTION_MS)
    // The digits stay on the export's line (Android's `V2TokensPinTest` reads them from this
    // file), bound to the token by `satisfies`.
    expect(read('../ui.ts')).toMatch(
      /^export const TOAST_ACTION_DURATION = 5000 satisfies typeof TOAST_ACTION_MS$/m
    )
  })

  it('the curve is main.css’s --zen-ease', () => {
    const declared = [...css.matchAll(/--zen-ease:\s*([^;]+);/g)].map((m) => m[1].trim())
    expect(declared.length).toBeGreaterThan(0)
    for (const value of declared) expect(value).toBe(ZEN_EASE)
  })

  it('the durations are main.css’s --zen-motion-* custom properties, beside --zen-ease', () => {
    const durations = {
      state: MOTION_STATE_MS,
      pop: MOTION_POP_MS,
      message: MOTION_MESSAGE_MS
    }
    // Every declaration in the stylesheet reads the token's value …
    for (const [name, ms] of Object.entries(durations)) {
      const declared = [...css.matchAll(new RegExp(`--zen-motion-${name}:\\s*([^;]+);`, 'g'))]
      expect(
        declared.map((m) => m[1].trim()),
        name
      ).toEqual([`${ms}ms`, `${ms}ms`])
    }
    // … once in each block that declares `--zen-ease`: the chrome's `:root` and the served
    // documents' `.zen-error-document`, which restates the chrome's tokens for the pages that
    // cannot link main.css.
    const blocks = css.split('}').filter((block) => block.includes('--zen-ease:'))
    expect(blocks).toHaveLength(2)
    for (const block of blocks)
      for (const [name, ms] of Object.entries(durations))
        expect(block).toContain(`--zen-motion-${name}: ${ms}ms;`)
    // The Tailwind seats – a class string cannot read a TS token – read the property, not digits.
    for (const seat of [
      '../../components/print/PreviewPane.tsx',
      '../../components/security/BlockedPopupsPanel.tsx',
      '../../components/siteControls/primitives.tsx'
    ]) {
      const text = read(seat)
      expect(text, seat).toContain('duration-[var(--zen-motion-state)]')
      expect(text, seat).not.toMatch(/duration-\[\d/)
    }
  })

  it('press and lift', () => {
    expect(PRESS_SCALE).toBe(0.98)
    expect(LIFT_SCALE).toBe(1.02)
    expect(LIFT_OPACITY).toBe(0.9)
    expect(LIFT_SHADOW_LEVEL).toBe(2)
    // The tab drag's ghost is the lift's stylesheet form (main.css `.zen-tab-ghost-row`).
    const ghost = css.match(/\.zen-tab-ghost-row\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(ghost).toContain(`transform: scale(${LIFT_SCALE})`)
    expect(ghost).toContain(`opacity: ${LIFT_OPACITY}`)
    expect(ghost).toContain(`box-shadow: var(--zen-shadow-${LIFT_SHADOW_LEVEL})`)
    expect(ghost).toContain(`transform ${MOTION_STATE_MS}ms var(--zen-ease)`)
    // The overview's card in the hand (`.zen-overview-ghost`, stepped by `useCardLift`): the
    // same rise, no scale spring (the lead's call on #734).
    const card = css.match(/\.zen-overview-ghost\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(card).toContain(`opacity: ${LIFT_OPACITY}`)
    expect(card).toContain(`box-shadow: var(--zen-shadow-${LIFT_SHADOW_LEVEL})`)
    expect(card).toContain(`transform ${MOTION_STATE_MS}ms var(--zen-ease)`)
    // The follow is a translate on the card's seat (§0.4): neither element promises `left`/`top`.
    expect(card).not.toMatch(/left|top/)
    const seat = css.match(/\.zen-overview-ghost-seat\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(seat).toContain('will-change: transform')
    expect(seat).not.toMatch(/transition/)
    const cardLift = read('../../components/phone/useCardLift.ts')
    expect(cardLift).not.toMatch(/scaleSpring/)
    expect(cardLift).toMatch(/scale: reduced \? LIFT_SCALE : 1/)
    // The carried pill (the bar dock's ghost in PhoneShell) rises to the same lift: its scale is
    // derived from the token over `dock.lift` 0…1, no figure of its own – at lift 1 it reads 1.02.
    const shell = read('../../components/phone/PhoneShell.tsx')
    expect(shell).toMatch(/import \{ LIFT_SCALE \} from '@renderer\/lib\/motion\/tokens'/)
    expect(shell).toMatch(/const scale = 1 \+ \(LIFT_SCALE - 1\) \* dock\.lift/)
    expect(shell).not.toMatch(/0\.04 \* dock\.lift/)
    expect(1 + (LIFT_SCALE - 1) * 1).toBeCloseTo(1.02, 10)
    expect(1 + (LIFT_SCALE - 1) * 0).toBe(1)
  })

  it('exports exactly §1’s names', async () => {
    const tokens = await import('../motion/tokens')
    expect(Object.keys(tokens).sort()).toEqual(
      [
        'BAND_CLOCK_MS',
        'LIFT_OPACITY',
        'LIFT_SCALE',
        'LIFT_SHADOW_LEVEL',
        'MOTION_CAP_MS',
        'MOTION_MESSAGE_MS',
        'MOTION_POP_MS',
        'MOTION_STATE_MS',
        'PRESS_SCALE',
        'SPRING_FOLLOW',
        'SPRING_GENTLE',
        'SPRING_SNAPPY',
        'SPRING_STEP_CLAMP_MS',
        'TOAST_ACTION_MS',
        'TOAST_DURATION',
        'TOAST_SHOW_MS',
        'TOAST_UNDO_MS',
        'ZEN_EASE'
      ].sort()
    )
  })
})
