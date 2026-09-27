import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ROLL_MARK,
  ROLL_MARK_GRID,
  ROLL_MARK_INDIGO,
  rollMarkPathData
} from '../../shared/game/mark'

/*
 * Roll's picture has ONE source (§9.17, the lead's (β-2) on #607): `shared/game/mark.ts`, which
 * the game tab's favicon glyph is drawn from (`renderer/lib/pageGlyphs.ts`). The 1 × 1 widget's
 * vector (WID-04), the picker's pre-31 preview copy and the widget's colour resources are held to
 * the paths and the indigo pair those numbers write, so the face and the glyph can never drift
 * apart; `GameWidgetFaceTest.kt` reads the same vector for the face's chassis.
 */

const RES = resolve(__dirname, '../../../android/app/src/main/res')
const read = (path: string): string => readFileSync(resolve(RES, path), 'utf8')
const attribute = (xml: string, name: string): string[] =>
  [...xml.matchAll(new RegExp(`android:${name}="([^"]+)"`, 'g'))].map((m) => m[1]!)

describe('the widget’s vector (ic_widget_roll.xml) is the module’s numbers', () => {
  it('draws the ground, the ring and the dot from the module’s paths, at the module’s strokes, on the 24 grid', () => {
    const glyph = read('drawable/ic_widget_roll.xml')
    const paths = rollMarkPathData()
    expect(attribute(glyph, 'pathData')).toEqual([paths.ground, paths.ring, paths.dot])
    expect(attribute(glyph, 'strokeWidth')).toEqual([
      String(ROLL_MARK.ground.stroke),
      String(ROLL_MARK.ring.stroke)
    ])
    expect(attribute(glyph, 'viewportWidth')).toEqual([String(ROLL_MARK_GRID)])
    expect(attribute(glyph, 'viewportHeight')).toEqual([String(ROLL_MARK_GRID)])
    // The ring and the dot in the mark colour, the ground in the ink; nothing else coloured.
    expect(attribute(glyph, 'strokeColor')).toEqual([
      '@color/widget_search_ink',
      '@color/widget_search_mark'
    ])
    expect(attribute(glyph, 'fillColor')).toEqual([
      '#00000000',
      '#00000000',
      '@color/widget_search_mark'
    ])
    // The picker's pre-31 preview repeats the picture whole.
    const preview = read('drawable/widget_game_preview.xml')
    for (const path of Object.values(paths)) expect(preview).toContain(`android:pathData="${path}"`)
  })

  it('takes the brand indigo from the one pair, lifted for the night', () => {
    const colour = (xml: string): string | undefined =>
      xml.match(/<color name="widget_search_mark">([^<]+)<\/color>/)?.[1]?.toLowerCase()
    expect(colour(read('values/colors.xml'))).toBe(ROLL_MARK_INDIGO.light)
    expect(colour(read('values-night/colors.xml'))).toBe(ROLL_MARK_INDIGO.dark)
  })
})
