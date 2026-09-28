/**
 * Roll's picture (§9.17): what stands for the game wherever a glyph does – the 1 × 1 widget's
 * face (`ic_widget_roll.xml`), the quick actions widget's fourth button, the game tab's favicon
 * slot on both hosts (`renderer/lib/pageGlyphs.ts`). "The ring mid-roll, its dot on the inner
 * orbit, resting on a short ground line, the widget's mark rule giving the ring the brand indigo,
 * never the mark alone, which is the app's icon and not the game's." This module is the ONE
 * source of the numbers: the Android vector is checked against `rollMarkPathData()` and the
 * colour resources against `ROLL_MARK_INDIGO` (`__tests__/mark.test.ts`), the web glyph is
 * built from `ROLL_MARK` and `rollMarkDot()`, so a change here is the picture's everywhere.
 *
 * Keep it free of imports: the numbers are read by tests, the renderer and the asset checks.
 */

/** The grid the picture is drawn on: 24 units, the widget vector's viewport and Lucide's. */
export const ROLL_MARK_GRID = 24

/**
 * The ring, its dot and the ground on the 24 grid. The ring's outer edge meets the ground's top
 * (`cy + r + stroke / 2 === ground.y − ground.stroke / 2`, 17.625): the runner rests on the line.
 * The dot rides the inner orbit – half the ring's radius, the runtime's orbit at this size
 * (`drawPlayer`) – at −40°, upper right: the run caught mid-roll.
 */
export const ROLL_MARK = {
  ring: { cx: 12, cy: 10.125, r: 6.5, stroke: 2 },
  dot: { orbit: 3.25, angle: -40, r: 2 },
  ground: { x1: 3, x2: 21, y: 18.5, stroke: 1.75 }
} as const

/**
 * The widget's mark rule: the ring and its dot in the brand indigo – the app icon's default
 * accent (`appIcon.ts`, `indigo`), lifted for the dark theme – never the page's or the space's
 * accent; the ground in the ink beside it. The Android resources (`widget_search_mark`,
 * `values/colors.xml` and `values-night/colors.xml`) and the chrome's `--zen-roll-mark`
 * (`main.css`) carry these two values, and the tests hold them to this pair.
 */
export const ROLL_MARK_INDIGO = { light: '#6264dc', dark: '#8284f0' } as const

/** The chrome's custom property the glyph's ring and dot draw in (`main.css` sets it per theme). */
export const ROLL_MARK_CSS_VARIABLE = '--zen-roll-mark'

/** A derived grid coordinate to two decimals, as the vector writes the dot's. */
function grid(n: number): number {
  return Math.round(n * 100) / 100
}

/** A coordinate as the vector writes it: the number itself, free of a float's tail. */
function exact(n: number): string {
  return String(Number(n.toFixed(3)))
}

/** The dot's centre: on the inner orbit at the mark's angle. */
export function rollMarkDot(): { cx: number; cy: number; r: number } {
  const { ring, dot } = ROLL_MARK
  const theta = (dot.angle * Math.PI) / 180
  return {
    cx: grid(ring.cx + Math.cos(theta) * dot.orbit),
    cy: grid(ring.cy + Math.sin(theta) * dot.orbit),
    r: dot.r
  }
}

/** A circle as the vector writes one: from its top, one arc all the way round. */
function circlePath(cx: number, cy: number, r: number): string {
  return `M${exact(cx)},${exact(cy - r)} a${r},${r} 0 1,0 0.01,0 Z`
}

/**
 * The three paths of the Android vector (`ic_widget_roll.xml`, and the picker preview's copy),
 * in the drawable's own words, so the resource can be held to the numbers above.
 */
export function rollMarkPathData(): { ground: string; ring: string; dot: string } {
  const { ring, ground } = ROLL_MARK
  const dot = rollMarkDot()
  return {
    ground: `M${ground.x1},${ground.y} H${ground.x2}`,
    ring: circlePath(ring.cx, ring.cy, ring.r),
    dot: circlePath(dot.cx, dot.cy, dot.r)
  }
}
