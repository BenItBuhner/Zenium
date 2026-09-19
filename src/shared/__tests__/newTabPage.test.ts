import { describe, expect, it } from 'vitest'
import mainCss from '../../renderer/src/assets/main.css?raw'
import {
  chromeTokenCss,
  NEW_TAB_PAGE_STYLE,
  NEW_TAB_RULES_END,
  NEW_TAB_RULES_START,
  PRIVATE_EXPLAINER,
  newTabPageHtml,
  newTabSharedCss
} from '../newTabPage'
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
  const shared = newTabSharedCss()

  it("cuts the one .zen-ntp-* vocabulary out of main.css, up to the phone page's additions", () => {
    // The block the phone page draws with (§9.29: one vocabulary on both platforms): the field's
    // surface, the tile's fill and states, the caption's and fallbacks' ink, the scrim.
    expect(mainCss.indexOf(NEW_TAB_RULES_START)).toBeGreaterThan(0)
    expect(mainCss.indexOf(NEW_TAB_RULES_END)).toBeGreaterThan(mainCss.indexOf(NEW_TAB_RULES_START))
    expect(shared.startsWith(NEW_TAB_RULES_START)).toBe(true)
    expect(shared).toMatch(
      /\.zen-ntp-field \{\n\s+border: 0;\n\s+border-radius: var\(--v2-radius-sheet\);\n\s+background: var\(--v2-urlbar\);\n\s+box-shadow: var\(--v2-shadow-panel\);\n\s+color: var\(--v2-text\);\n\s+\}/
    )
    expect(shared).toMatch(
      /\.zen-ntp-tile \{\n\s+border-radius: var\(--v2-radius-card\);\n\s+background: var\(--v2-control-fill\);/
    )
    expect(shared).toMatch(
      /@media \(hover: hover\) \{\n\s+\.zen-v2-shortcut:hover \.zen-ntp-tile \{\n\s+background: var\(--v2-control-fill-hover\);/
    )
    expect(shared).toMatch(
      /\.zen-v2-shortcut:active \.zen-ntp-tile \{[^}]*transform: scale\(0\.96\);/
    )
    expect(shared).toMatch(/\.zen-ntp-caption \{[^}]*color: var\(--v2-control-text-deemphasized\);/)
    expect(shared).toMatch(/\.zen-ntp-letter \{[^}]*font-size: var\(--v2-font-heading\);/)
    expect(shared).toMatch(/\.zen-ntp-empty \{[^}]*font-size: var\(--v2-font-body\);/)
    expect(shared).toMatch(
      /\.zen-ntp-scrim \{\n\s+background: linear-gradient\(180deg, rgb\(0 0 0 \/ 0\.1\), rgb\(0 0 0 \/ 0\.45\)\);/
    )
    // Nothing of the phone's: no size, no form-factor gate, no wallpaper, no stagger, no preview.
    expect(shared).not.toContain('data-form-factor')
    expect(shared).not.toMatch(/(?<![a-z-])(height|width): \d/)
    expect(shared).not.toMatch(
      /zen-ntp-(site|preview|grow|placeholder|preset|icon-loaded|field-main)/
    )
    expect(shared).not.toContain('--zen-bg')
    expect(shared).not.toContain('/*')
    expect(shared).not.toContain('@layer')
    // Gone markers degrade to no shared rules rather than a broken cut.
    expect(newTabSharedCss('')).toBe('')
    expect(newTabSharedCss(mainCss.replace(NEW_TAB_RULES_END, '/* gone */'))).toBe('')
  })

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
    // Only `:root` and `data-surface` token blocks: no chrome rule leaks into the page.
    for (const block of blocks)
      expect(block).toMatch(/^(:root(\[[^\]]*\])?|\[data-surface='(window|page)'\]) \{ [^{}]* \}$/)
    expect(tokens).toMatch(/^\[data-surface='page'\] \{ --v2-control-text: var\(--v2-text\);/m)
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
    // Over a picture the page re-declares the window's ink and fills (white, §9.29) – existing
    // names with the picture's values, as the phone page does – and nothing else.
    expect([...declared(NEW_TAB_PAGE_STYLE)].sort()).toEqual([
      '--v2-window-fill',
      '--v2-window-fill-hover',
      '--zen-fg',
      '--zen-fg-rgb'
    ])
    for (const name of declared(NEW_TAB_PAGE_STYLE)) expect(declared(mainCss)).toContain(name)
    const imageBlock = NEW_TAB_PAGE_STYLE.slice(
      NEW_TAB_PAGE_STYLE.indexOf("body[data-bg='image'] {")
    )
    expect(imageBlock.slice(0, imageBlock.indexOf('}'))).toContain('--zen-fg: #fff;')
    const provided = new Set([
      ...declared(tokens),
      ...Object.keys(themeCssVariables(resolveTheme(null, false)))
    ])
    const pageCss = shared + NEW_TAB_PAGE_STYLE
    expect(declared(shared).size).toBe(0)
    for (const name of read(pageCss)) expect(provided, name).toContain(name)
    // And every token the page reads it reads from the v2 set or the theme, never a v1 surface colour.
    for (const name of read(pageCss))
      expect(name, name).toMatch(/^--(v2-|zen-(fg|fg-rgb|ease|shadow-2)$)/)
  })

  it('serves the tokens, then the shared rules, then the page rules in one inline stylesheet', () => {
    const html = newTabPageHtml()
    const style = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'))
    expect(style.startsWith(tokens)).toBe(true)
    expect(style.endsWith(NEW_TAB_PAGE_STYLE)).toBe(true)
    expect(style.slice(tokens.length, style.length - NEW_TAB_PAGE_STYLE.length).trim()).toBe(shared)
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

  it('hides with the attribute whatever display a class sets (the grid is a grid)', () => {
    expect(NEW_TAB_PAGE_STYLE).toMatch(/^\s*\[hidden\] \{ display: none !important; \}$/m)
    expect(NEW_TAB_PAGE_STYLE).toMatch(/\.zen-grid \{\s*display: grid;/)
    // The grid, the empty sentence and the explainer start hidden; the script shows one of them.
    const html = newTabPageHtml()
    expect(html).toMatch(/<div class="zen-grid" id="zen-grid" role="list"[^>]* hidden>/)
    expect(html).toMatch(/<p class="zen-ntp-empty" id="zen-empty" hidden>/)
    expect(html).toMatch(/<section class="zen-ntp-private" id="zen-private"[^>]* hidden>/)
  })

  it('is the window (§9.29): a window-family root, the field and toast page surfaces on it', () => {
    const html = newTabPageHtml()
    expect(html).toContain('<body data-surface="window">')
    expect(html).toMatch(/<form class="zen-ntp-field" id="zen-search"[^>]* data-surface="page">/)
    expect(html).toMatch(
      /<div class="zen-toast" id="zen-toast" role="status" data-surface="page" hidden>/
    )
    // One vocabulary with the phone page (the shared rules give the look, the page its sizes):
    // tiles, captions and Customize in the window family, the field a page surface.
    expect(NEW_TAB_PAGE_STYLE).toMatch(/\.zen-ntp-tile \{[^}]*width: 64px; height: 64px;/)
    expect(shared).toMatch(/\.zen-ntp-tile \{[^}]*background: var\(--v2-control-fill\);/)
    expect(NEW_TAB_PAGE_STYLE).toMatch(/\.zen-ntp-icon \{ width: 32px; height: 32px; \}/)
    expect(shared).toMatch(
      /\.zen-v2-shortcut:hover \.zen-ntp-tile \{\n\s+background: var\(--v2-control-fill-hover\);/
    )
    expect(shared).toMatch(/\.zen-ntp-caption \{[^}]*color: var\(--v2-control-text-deemphasized\);/)
    expect(NEW_TAB_PAGE_STYLE).toMatch(
      /\.zen-grid \{[^}]*repeat\(4, minmax\(0, 104px\)\); gap: 12px;/
    )
    expect(NEW_TAB_PAGE_STYLE).toMatch(/\.zen-ntp-field \{[^}]*height: 48px;/)
    expect(shared).toMatch(
      /\.zen-ntp-field \{[^}]*border: 0;[^}]*border-radius: var\(--v2-radius-sheet\);[^}]*background: var\(--v2-urlbar\);[^}]*box-shadow: var\(--v2-shadow-panel\);/
    )
    // The page's layout repeats none of the shared look, so the two never disagree.
    expect(NEW_TAB_PAGE_STYLE).not.toMatch(
      /^\s*\.zen-ntp-(field|tile|caption|empty|letter|scrim) \{[^}]*(background|color|border-radius|box-shadow|font-size):/m
    )
    expect(NEW_TAB_PAGE_STYLE).not.toMatch(/\.zen-v2-shortcut:(hover|active) \.zen-ntp-tile/)
    expect(NEW_TAB_PAGE_STYLE).toMatch(
      /\.zen-customize \{ position: fixed; right: 12px; bottom: 12px;/
    )
    expect(html).toMatch(
      /<button type="button" class="zen-v2-button zen-customize" id="zen-customize"/
    )
    // No card, no hairline around a tile, no label inside the square.
    expect(shared + NEW_TAB_PAGE_STYLE).not.toMatch(/\.zen-ntp-tile \{[^}]*border: 1px/)
    expect(shared + NEW_TAB_PAGE_STYLE).not.toContain('--v2-card')
  })

  it('says what a private window keeps, where the tiles would be (§9.23 title block)', () => {
    const html = newTabPageHtml()
    expect(html).toContain(`<h2 id="zen-private-title">${PRIVATE_EXPLAINER.title}</h2>`)
    expect(html).toContain(`<p>${PRIVATE_EXPLAINER.description}</p>`)
    expect(PRIVATE_EXPLAINER.title).toBe("You're in a private window")
    expect(PRIVATE_EXPLAINER.description).not.toMatch(/[—–]/)
    expect(NEW_TAB_PAGE_STYLE).toMatch(
      /\.zen-ntp-private h2 \{[^}]*font-size: var\(--v2-font-heading\); line-height: 22px; font-weight: var\(--v2-weight-heading\);/
    )
    expect(NEW_TAB_PAGE_STYLE).toMatch(
      /\.zen-ntp-private p \{ margin: 4px 0 0; color: var\(--v2-control-text-deemphasized\); \}/
    )
  })
})
