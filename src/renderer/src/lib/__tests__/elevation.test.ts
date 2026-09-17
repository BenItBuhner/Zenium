import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CARD_SHADOW,
  FRAME_SHADOW,
  LIFTED_SHADOW,
  lerpShadow,
  shadowCss
} from '../motion/elevation'

/** The value of a `--zen-*` custom property declared in the stylesheet, whitespace collapsed. */
function cssVariable(name: string): string {
  const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')
  const match = css.match(new RegExp(`${name}:\\s*([^;]+);`))
  if (!match) throw new Error(`${name} is not declared in main.css`)
  return match[1].replace(/\s+/g, ' ').trim()
}

describe('elevation', () => {
  it('matches the stylesheet at both ends of the page ↔ card morph', () => {
    expect(cssVariable('--zen-frame-shadow')).toBe(shadowCss(FRAME_SHADOW))
    expect(cssVariable('--zen-card-shadow')).toBe(shadowCss(CARD_SHADOW))
    expect(cssVariable('--zen-lifted-shadow')).toBe(shadowCss(LIFTED_SHADOW))
  })

  it('interpolates layer by layer and lands exactly on either look', () => {
    expect(shadowCss(lerpShadow(FRAME_SHADOW, CARD_SHADOW, 0))).toBe(shadowCss(FRAME_SHADOW))
    expect(shadowCss(lerpShadow(FRAME_SHADOW, CARD_SHADOW, 1))).toBe(shadowCss(CARD_SHADOW))
    const half = lerpShadow(FRAME_SHADOW, CARD_SHADOW, 0.5)
    expect(half[0].alpha).toBeCloseTo(0.04)
    expect(half[2].y).toBeCloseTo(5)
    expect(half[2].blur).toBeCloseTo(19)
  })

  it('clamps the progress so rubber-banded drags cannot invert a shadow', () => {
    expect(shadowCss(lerpShadow(FRAME_SHADOW, CARD_SHADOW, -0.3))).toBe(shadowCss(FRAME_SHADOW))
    expect(shadowCss(lerpShadow(FRAME_SHADOW, CARD_SHADOW, 1.4))).toBe(shadowCss(CARD_SHADOW))
  })
})
