import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * The content frame's strips (`DefaultBrowserBanner.tsx`, `CrashRestoreBanner.tsx`; design
 * language v2 §9.29 on the window tokens): the band paints no fill of its own – its secondary
 * button is `--v2-control-fill`, the window fill on this surface, and a band of the same fill
 * under it stacked the fill on itself (the button's rest a doubled tint over the frame, its
 * hover a step of ~30 from that rest: the fill-on-fill shell pass 7(a) captured for the lead).
 * On the frame's solid the secondary is one fill and its hover the token's own step; the strip
 * keeps §9.7's hairline at its foot as the one line it draws.
 */

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')

function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

describe('the frame strips (§9.29)', () => {
  it('paint no band of their own: the secondary’s fill is one fill on the frame’s solid', () => {
    const strip = rule('.zen-frame-strip')
    expect(strip).not.toMatch(/background/)
    expect(strip).toContain('color: var(--v2-control-text)')
    expect(strip).toContain('min-height: calc(var(--v2-control) + 8px)')
    expect(rule('.zen-frame-strip::after')).toContain('background: var(--v2-border)')
    expect(rule('.zen-content-frame')).toContain('background: var(--zen-bg-solid)')
  })

  it('keep the secondary on the window roles with the window hover fill', () => {
    const secondary = rule(
      '.zen-firstrun .zen-v2-button:not([data-primary]),\n.zen-overview .zen-v2-button:not([data-primary]),\n.zen-frame-strip .zen-v2-button:not([data-primary])'
    )
    expect(secondary).toContain('background: var(--v2-control-fill)')
    expect(css).toMatch(
      /\.zen-frame-strip \.zen-v2-button:not\(\[data-primary\]\):hover:not\(:disabled\),\n\.zen-frame-strip \.zen-v2-button:not\(\[data-primary\]\):active:not\(:disabled\) \{\n {2}background: var\(--v2-control-fill-hover\);/
    )
  })
})
