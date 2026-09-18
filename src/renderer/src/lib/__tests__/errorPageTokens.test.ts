import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ERROR_PAGE_TOKENS } from '@shared/zenPages'

/**
 * The zen://error page renders inside the tab's WebView, where the chrome's stylesheet is out of
 * reach, so it carries its own copy of the v2 tokens it reads. main.css stays the source: these
 * tests fail when the copy drifts from the block v2Tokens.test.ts pins.
 */
const css = readFileSync(fileURLToPath(new URL('../../assets/main.css', import.meta.url)), 'utf8')

/** `name → value` of the v2 declarations in the block that starts at `selector {` after `from`. */
function declarations(source: string, selector: string, from = 0): Map<string, string> {
  const start = source.indexOf(`${selector} {`, from)
  expect(start, `block "${selector}"`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  const out = new Map<string, string>()
  for (const m of source.slice(start, end).matchAll(/(--v2-[a-z0-9-]+):\s*([^;]+);/g))
    out.set(m[1], m[2].trim())
  return out
}

const lightStart = css.indexOf('--v2-page:')
const chromeLight = declarations(css, ':root', css.lastIndexOf(':root {', lightStart))
const chromeDark = declarations(css, ":root[data-theme='dark']", lightStart)
const chromePhone = declarations(css, ":root[data-form-factor='phone']", lightStart)
const chromeCoarse = declarations(css, ":root[data-pointer='coarse']", lightStart)

const pageLight = declarations(ERROR_PAGE_TOKENS, ':root')
const pageDark = declarations(
  ERROR_PAGE_TOKENS,
  ':root',
  ERROR_PAGE_TOKENS.indexOf('prefers-color-scheme: dark')
)
const pageCoarse = declarations(
  ERROR_PAGE_TOKENS,
  ':root',
  ERROR_PAGE_TOKENS.indexOf('pointer: coarse')
)

describe('the error page tokens', () => {
  it("are the chrome's values under the chrome's names (main.css is the source; re-tune there)", () => {
    expect(pageLight.size).toBeGreaterThan(10)
    for (const [name, value] of pageLight) expect(chromeLight.get(name), name).toBe(value)
    for (const [name, value] of pageDark) expect(chromeDark.get(name), name).toBe(value)
    for (const [name, value] of pageCoarse)
      expect(chromePhone.get(name) ?? chromeCoarse.get(name), name).toBe(value)
  })

  it('redefine for dark exactly the colour tokens the page reads', () => {
    expect([...pageDark.keys()].sort()).toEqual(
      ['--v2-fill', '--v2-fill-hover', '--v2-page', '--v2-text', '--v2-text-deemphasized'].sort()
    )
  })
})
