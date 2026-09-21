import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TOOLBAR_STROKE } from '../../v2/controls'

/*
 * The bookmarks bar's chrome (#271, verified by shell pass 7(a) against design language v2 §9.3
 * and §9.29 on the window tokens): 28 px chips at radius 6 in the theme's ink at the sidebar's
 * size, hover on the window fill and the pressed fill while a chip's panel is open, the » as the
 * toolbar button at its own radius 6 in the chips' fills, and every glyph on the bar – the
 * folder, the globe, the » – at the toolbar row's one stroke (the shared `BookmarkIcon` takes
 * the stroke from the bar; the manager's page rows keep the icon's default).
 */

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')
const bar = readFileSync(resolve(__dirname, '../BookmarksBar.tsx'), 'utf8')

function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

describe('the bookmarks bar chrome (§9.3, §9.29)', () => {
  it('draws 28 px chips at radius 6 in the window family', () => {
    const chip = rule('.zen-bm-chip')
    expect(chip).toContain('height: 28px')
    expect(chip).toContain('border-radius: 6px')
    expect(chip).toContain('color: var(--zen-fg)')
    expect(chip).toContain('font-size: var(--zen-sidebar-font)')
    expect(rule('.zen-bm-chip-icon')).toContain('width: 16px')
    expect(rule('.zen-bm-chip:hover')).toContain('background: var(--v2-window-fill)')
    expect(rule(".zen-bm-chip:active,\n  .zen-bm-chip[aria-expanded='true']")).toContain(
      'background: var(--v2-window-fill-hover)'
    )
  })

  it('gives the » the toolbar button’s own radius 6 and the chips’ fills', () => {
    expect(rule('.zen-toolbar-button')).toContain('border-radius: 6px')
    // No radius of its own: the button's 6 is §9.3's since the shell pass.
    expect(css).not.toMatch(/\.zen-bm-overflow \{/)
    const hover = '.zen-bm-overflow:hover:not(:disabled)'
    expect(rule(hover)).toContain('background: var(--v2-window-fill)')
    // The open state (`aria-expanded`) is written at the hover's specificity (0,3,0) and after
    // it, so the pressed fill holds while the pointer is still on the » that opened the panel –
    // `[aria-expanded='true']` alone (0,2,0) lost to the hover (the Xvfb drive's finding).
    const open =
      ".zen-bm-overflow:active:not(:disabled),\n  .zen-bm-overflow[aria-expanded='true']:not(:disabled)"
    expect(rule(open)).toContain('background: var(--v2-window-fill-hover)')
    expect(css.indexOf(`${open} {`)).toBeGreaterThan(css.indexOf(`${hover} {`))
    expect(css).not.toMatch(/\.zen-bm-overflow\[aria-expanded='true'\] \{/)
  })

  it('draws every glyph on the bar at the toolbar stroke', () => {
    const icons = bar.match(/<BookmarkIcon\b[\s\S]*?\/>/g) ?? []
    expect(icons.length).toBeGreaterThanOrEqual(3)
    for (const icon of icons) expect(icon).toContain('strokeWidth={TOOLBAR_STROKE}')
    expect(bar).toMatch(/<ChevronsRight[^>]*strokeWidth=\{TOOLBAR_STROKE\}/)
    expect(TOOLBAR_STROKE).toBe(1.5)
  })
})
