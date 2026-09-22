import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { argb, KOTLIN_PATH, kotlinSource, readTokens } from './v2-tokens-kotlin'

/**
 * The Kotlin table of v2 inks the native page-unresponsive prompt draws with (v2 §9.23: every
 * value read from the token block of the theme in force and pinned by a test against the CSS,
 * never retyped) is generated from `main.css`; this pins the checked-in file to a fresh
 * generation, so a token change in the CSS fails here until the table is regenerated.
 */
describe('V2Tokens.kt', () => {
  it('is what main.css generates today (run `node --experimental-strip-types --no-warnings scripts/v2-tokens-kotlin.ts`)', () => {
    expect(fs.readFileSync(KOTLIN_PATH, 'utf8')).toBe(kotlinSource())
  })

  it("reads the chassis's numbers: the panel, the hairline, the inks at 69 / 10 / 16 %, the scrim's .4 / .55, the danger ink, the grabber's 25 %", () => {
    const tokens = readTokens()
    expect(tokens.light).toEqual({
      panel: '#fff4f4f4',
      border: '#26000000',
      text: '#ff15141a',
      textDeemphasized: '#b015141a',
      fill: '#1a15141a',
      fillHover: '#2915141a',
      scrim: '#66000000',
      danger: '#ffc43434',
      scrimAlpha: 0.4
    })
    expect(tokens.dark).toEqual({
      panel: '#ff1f1f1f',
      border: '#1fffffff',
      text: '#fffbfbfe',
      textDeemphasized: '#b0fbfbfe',
      fill: '#1afbfbfe',
      fillHover: '#29fbfbfe',
      scrim: '#8c000000',
      danger: '#ffff8080',
      scrimAlpha: 0.55
    })
    expect(tokens.handleAlpha).toBe(0.25)
  })

  it('converts the CSS colour forms the block uses', () => {
    expect(argb('#15141a')).toBe('#ff15141a')
    expect(argb('rgb(0 0 0 / 0.15)')).toBe('#26000000')
    expect(argb('rgb(21 20 26 / 0.69)')).toBe('#b015141a')
    expect(argb('rgb(255 255 255)')).toBe('#ffffffff')
    expect(() => argb('color-mix(in srgb, red 40%, #000)')).toThrow()
  })

  it('fails when the block changes shape rather than carrying a wrong value', () => {
    const css = fs.readFileSync(
      new URL('../src/renderer/src/assets/main.css', import.meta.url),
      'utf8'
    )
    expect(() => readTokens(css.replace('--v2-panel: #f4f4f4;', ''))).toThrow(/--v2-panel/)
    expect(() =>
      readTokens(
        css.replace('--v2-scrim: rgb(0 0 0 / var(--zen-scrim-alpha));', '--v2-scrim: red;')
      )
    ).toThrow(/--v2-scrim/)
  })
})
