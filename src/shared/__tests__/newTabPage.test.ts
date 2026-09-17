import { describe, expect, it } from 'vitest'
import mainCss from '../../renderer/src/assets/main.css?raw'
import { chromeTokenCss, NEW_TAB_PAGE_STYLE, newTabPageHtml } from '../newTabPage'
import { PRIVATE_ACCENT, PRIVATE_ACCENT_RGB } from '../newTabPageScript'
import { PRIVATE_THEME, resolveTheme, themeCssVariables } from '../theme'

/** Custom-property names declared (`--x:`) in `css`. */
function declared(css: string): Set<string> {
  return new Set(css.match(/--[a-z0-9-]+(?=\s*:)/g) ?? [])
}

/** Custom-property names read (`var(--x`) in `css`. */
function read(css: string): Set<string> {
  return new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]))
}

describe('zen://newtab tokens', () => {
  const tokens = chromeTokenCss()

  it('takes the chrome token blocks from main.css, light and dark, comments dropped', () => {
    const blocks = tokens.split('\n')
    expect(blocks.length).toBeGreaterThanOrEqual(4)
    expect(blocks[0]).toMatch(/^:root \{ .*--zen-bg: #f2f1f5;.*--zen-ease: /)
    expect(blocks[1]).toMatch(/^:root\[data-theme='dark'\] \{ .*--zen-danger: #ff8080;/)
    expect(tokens).toMatch(/^:root \{ .*--v2-page: #fbfbfe;/m)
    expect(tokens).toMatch(/^:root\[data-theme='dark'\] \{ .*--v2-page: #1c1b22;/m)
    expect(tokens).not.toContain('/*')
    // Every v2 token main.css defines is there, so the page can read any of them.
    for (const name of declared(mainCss))
      if (name.startsWith('--v2-')) expect(tokens).toContain(name)
    // Only `:root` blocks: no chrome rule leaks into the page.
    for (const block of blocks) expect(block).toMatch(/^:root(\[[^\]]*\])? \{ [^{}]* \}$/)
    expect(tokens).not.toContain('zen-v2-')
    expect(tokens).not.toContain('@')
  })

  it('stops at the first rule that is not a token block', () => {
    const css =
      ':root {\n  --v2-a: 1;\n}\n:root[data-x] {\n  --v2-b: 2;\n}\n.zen-thing {\n  color: red;\n}\n:root {\n  --late: 3;\n}\n'
    expect(chromeTokenCss(css)).toBe(':root { --v2-a: 1; }\n:root[data-x] { --v2-b: 2; }')
    expect(() => chromeTokenCss('.a { color: red }')).toThrow(/:root/)
  })

  it('defines no token of its own and reads only tokens main.css or the theme provides', () => {
    expect([...declared(NEW_TAB_PAGE_STYLE)]).toEqual([])
    const provided = new Set([
      ...declared(tokens),
      ...Object.keys(themeCssVariables(resolveTheme(null, false)))
    ])
    for (const name of read(NEW_TAB_PAGE_STYLE)) expect(provided, name).toContain(name)
    // And every token the page reads it reads from the v2 set or the theme, never a v1 surface colour.
    for (const name of read(NEW_TAB_PAGE_STYLE))
      expect(name, name).toMatch(/^--(v2-|zen-(fg|fg-rgb|ease|shadow-2)$)/)
  })

  it('serves the tokens before the page rules in one inline stylesheet', () => {
    const html = newTabPageHtml()
    const style = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'))
    expect(style.startsWith(tokens)).toBe(true)
    expect(style.endsWith(NEW_TAB_PAGE_STYLE)).toBe(true)
    expect(html).toContain("default-src 'none'")
    expect(html).not.toContain('<script')
  })

  it('carries the private accent the chrome sets on a private window', () => {
    const rule = mainCss.slice(mainCss.indexOf(".zen-window[data-window-kind='private'] {"))
    const body = rule.slice(0, rule.indexOf('}'))
    expect(body).toContain(`--zen-accent: ${PRIVATE_ACCENT};`)
    expect(body).toContain(`--zen-accent-rgb: ${PRIVATE_ACCENT_RGB};`)
    // The private theme itself is dark in both schemes, so the page's dark tokens apply over it.
    expect(resolveTheme(PRIVATE_THEME, false).isDark).toBe(true)
    expect(resolveTheme(PRIVATE_THEME, true).isDark).toBe(true)
  })
})
