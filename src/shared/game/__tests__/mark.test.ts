import { describe, expect, it } from 'vitest'
import chromeCss from '../../../renderer/src/assets/main.css?raw'
import {
  ROLL_MARK,
  ROLL_MARK_CSS_VARIABLE,
  ROLL_MARK_GRID,
  ROLL_MARK_INDIGO,
  rollMarkDot,
  rollMarkPathData
} from '../mark'

/*
 * Roll's picture has ONE source (§9.17, the lead's (β-2) on #607): the numbers in `mark.ts`. The
 * chrome's `--zen-roll-mark` is held to the one indigo pair here; the 1 × 1 widget's vector, the
 * picker's preview copy and the widget's colour resources are held to the same numbers by the
 * Android side's `src/android/__tests__/gameWidgetMark.test.ts`, so the favicon slot
 * (`renderer/lib/pageGlyphs.ts`) and the widget's face can never drift apart.
 */

describe('the geometry', () => {
  it('is the ring mid-roll on a short ground line: the dot on the inner orbit upper right, the ring resting on the line', () => {
    expect(ROLL_MARK_GRID).toBe(24)
    const { ring, dot, ground } = ROLL_MARK
    // The inner orbit is half the ring's radius (the runtime's orbit at this size).
    expect(dot.orbit).toBe(ring.r / 2)
    expect(dot.angle).toBeLessThan(0)
    expect(dot.angle).toBeGreaterThan(-90)
    expect(rollMarkDot()).toEqual({ cx: 14.49, cy: 8.04, r: 2 })
    // The ring's outer edge is the ground's top edge.
    expect(ring.cy + ring.r + ring.stroke / 2).toBe(ground.y - ground.stroke / 2)
    // The line is short: inside the grid's 3-unit margins, wider than the ring.
    expect(ground.x1).toBe(3)
    expect(ground.x2).toBe(ROLL_MARK_GRID - 3)
    expect(ground.x2 - ground.x1).toBeGreaterThan(ring.r * 2)
  })

  it('writes the vector’s three paths in its own words', () => {
    expect(rollMarkPathData()).toEqual({
      ground: 'M3,18.5 H21',
      ring: 'M12,3.625 a6.5,6.5 0 1,0 0.01,0 Z',
      dot: 'M14.49,6.04 a2,2 0 1,0 0.01,0 Z'
    })
  })
})

describe('the chrome’s stylesheet', () => {
  it('sets `--zen-roll-mark` to the same pair, the light value on the root and the dark one under the dark theme', () => {
    expect(ROLL_MARK_CSS_VARIABLE).toBe('--zen-roll-mark')
    const declared = [...chromeCss.matchAll(/--zen-roll-mark:\s*(#[0-9a-f]{6});/g)]
    expect(declared.map((m) => m[1])).toEqual([ROLL_MARK_INDIGO.light, ROLL_MARK_INDIGO.dark])
    const dark = chromeCss.indexOf(":root[data-theme='dark'] {")
    expect(dark).toBeGreaterThan(-1)
    expect(declared[0]!.index).toBeLessThan(dark)
    expect(declared[1]!.index).toBeGreaterThan(dark)
    // Read by the glyph alone; no rule of the chrome paints it as a fill.
    expect(chromeCss.match(/var\(--zen-roll-mark/g)).toBeNull()
  })

  it('centres the game-over card by its auto margins, never by a transform, so the runtime’s pop composes (B1)', () => {
    const rule = chromeCss.match(/\.zen-game-over \{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toContain('right: 0;')
    expect(rule).toContain('left: 0;')
    expect(rule).toContain('width: max-content;')
    expect(rule).toContain('margin-inline: auto;')
    expect(rule).not.toContain('transform')
    expect(rule).not.toContain('left: 50%')
  })
})
