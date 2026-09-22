import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The chrome's focus ring (design language v2 §1, a11y-10): one ring – 2 px solid in the ring
 * token – on every control of the chrome document, from a base-layer floor that replaces the UA's
 * `outline: auto` (the platform's focus colour, not the token, and not sure to read against the
 * window's gradient). These tests pin the floor and keep the ring from forking: no component
 * draws a ring of another width, style or colour, and none swaps it for a translucent utility ring.
 */
const assets = fileURLToPath(new URL('../../assets/', import.meta.url))
const css = readFileSync(join(assets, 'main.css'), 'utf8')
const sheets = readdirSync(assets)
  .filter((f) => f.endsWith('.css'))
  .map((f) => [f, readFileSync(join(assets, f), 'utf8')] as const)

/**
 * The `:focus-visible` rules of a stylesheet that set an outline, with the declaration's value.
 * A rule for the unfocused state (`:not(:focus-visible)`, a selection outline that steps aside
 * for the ring) is not a ring.
 */
function ringRules(text: string): Array<{ selector: string; value: string }> {
  const out: Array<{ selector: string; value: string }> = []
  const rule = /([^{}]*:focus-visible[^{}]*)\{([^{}]*)\}/g
  for (const m of text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(rule)) {
    if (!/:focus-visible/.test((m[1] ?? '').replace(/:not\([^)]*\)/g, ''))) continue
    const body = m[2] ?? ''
    for (const d of body.matchAll(/(?:^|;)\s*outline\s*:\s*([^;]+)/g))
      out.push({ selector: (m[1] ?? '').trim().replace(/\s+/g, ' '), value: (d[1] ?? '').trim() })
  }
  return out
}

describe('the chrome focus ring (§1, a11y-10)', () => {
  it('is the floor under every control: a base-layer :focus-visible rule in the ring token, inset 2px', () => {
    const at = css.indexOf(" * The chrome's focus ring (v2 §1, a11y-10)")
    expect(at).toBeGreaterThan(0)
    const block = css.slice(at, css.indexOf('@layer components {', at))
    expect(block).toMatch(
      /@layer base \{\s*\* \{\s*outline-color: var\(--v2-ring\);\s*outline-width: 2px;\s*outline-offset: -2px;\s*\}\s*:focus-visible \{\s*outline: 2px solid var\(--v2-ring\);\s*outline-offset: -2px;\s*\}\s*\}/
    )
    // Before the first components layer, so every component rule can still speak over it.
    expect(at).toBeLessThan(css.indexOf('@layer components {'))
  })

  it('snaps on: every standing outline sets its own offset, so the at-rest values animate nothing and move nothing', () => {
    // A rule drawing an outline that is not a focus ring (a card's hairline, a picked tile's
    // accent) must say where it sits, or the at-rest `outline-offset: -2px` would pull it inward.
    const rule = /([^{}]+)\{([^{}]*)\}/g
    for (const [file, text] of sheets) {
      for (const m of text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(rule)) {
        const selector = (m[1] ?? '').trim().replace(/\s+/g, ' ')
        const body = m[2] ?? ''
        if (!/(?:^|;)\s*outline\s*:(?!\s*none\s*(?:;|$))/.test(body)) continue
        expect(body, `${file}: ${selector} draws an outline without an outline-offset`).toMatch(
          /(?:^|;)\s*outline-offset\s*:/
        )
      }
    }
  })

  it('is one ring: every :focus-visible outline in the stylesheets is 2px solid in an accent token, or none', () => {
    const accent = /^2px solid var\(--v2-(?:ring|accent|control-accent)\)$/
    for (const [file, text] of sheets) {
      for (const { selector, value } of ringRules(text)) {
        if (value === 'none') continue
        expect(value, `${file}: ${selector}`).toMatch(accent)
      }
    }
  })

  it('has the shared v2 ring and the pill ring reading the ring token itself', () => {
    expect(ringRules(css)).toEqual(
      expect.arrayContaining([
        {
          selector: expect.stringContaining("[class^='zen-v2-']:focus-visible"),
          value: '2px solid var(--v2-ring)'
        },
        {
          selector: expect.stringContaining('.zen-pill:has(> button:focus-visible)'),
          value: '2px solid var(--v2-ring)'
        }
      ])
    )
  })

  it('draws none round a dialog container that holds the focus by design: one shared rule on [role=dialog][tabindex=-1], over the v2 ring at every pointer (§9.22)', () => {
    // The one rule, unlayered, `:root`-weighted to (0,4,0) so it also beats the v2 ring's
    // coarse-pointer form on a phone, where it wins the tie by standing after it.
    const rule = css.match(
      /:root \[role='dialog'\]\[tabindex='-1'\]:focus-visible,\n:root \[role='alertdialog'\]\[tabindex='-1'\]:focus-visible \{\n {2}outline: none;\n\}/
    )
    expect(rule).not.toBeNull()
    const at = rule!.index!
    expect(at).toBeGreaterThan(
      css.indexOf(":root[data-pointer='coarse'] [class^='zen-v2-']:focus-visible")
    )
    expect(at).toBeLessThan(css.indexOf('@layer components {'))
    // The rule reaches the container alone: no `[tabindex='-1']` exclusion widens onto the
    // controls (a roving list's options carry it too), and no stylesheet keeps a per-dialog
    // `outline: none` for a sheet root the shared rule now covers.
    expect(ringRules(css).filter((r) => r.selector.includes("[tabindex='-1']"))).toEqual([
      {
        selector:
          ":root [role='dialog'][tabindex='-1']:focus-visible, :root [role='alertdialog'][tabindex='-1']:focus-visible",
        value: 'none'
      }
    ])
    expect(css).not.toMatch(/\.zen-sheet:focus\b/)
  })

  it('keeps the phone’s keyboard ring: the coarse-pointer suppressor stands down while the keyboard is the last input, and the phone pill rings as the desktop’s (A11Y-09)', () => {
    // The suppressor hides the legacy buttons' rings under a finger (a script-moved focus
    // matches `:focus-visible` before any pointer has been used); a hardware keyboard's Tab
    // must still ring the pill and the bar's buttons. `:where()` keeps the rule's specificity
    // where it was, beneath every component's own ring rule.
    const suppressor = ringRules(css).filter(
      (r) => r.value === 'none' && r.selector.includes("[data-pointer='coarse']")
    )
    expect(suppressor.map((r) => r.selector)).toEqual([
      ":root[data-pointer='coarse']:where(:not([data-input='keyboard'])) button:focus-visible, :root[data-pointer='coarse']:where(:not([data-input='keyboard'])) [role='button']:focus-visible"
    ])
    expect(css).not.toMatch(/:root\[data-pointer='coarse'\] button:focus-visible/)
    // The phone pill rings as a whole for the keyboard on its address or a chip, and none of
    // its buttons rings on its own – the desktop pill's rule, keyed on the keyboard's input.
    expect(ringRules(css)).toEqual(
      expect.arrayContaining([
        {
          selector: ":root[data-input='keyboard'] .zen-phone-pill:has(button:focus-visible)",
          value: '2px solid var(--v2-ring)'
        },
        { selector: '.zen-phone-pill button:focus-visible', value: 'none' }
      ])
    )
  })

  it('is not forked into translucent utility rings in the components', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .map((f) => f.split('\\').join('/'))
      .filter((f) => /\.tsx?$/.test(f) && !f.includes('__tests__'))
    for (const file of files) {
      const text = readFileSync(join(root, file), 'utf8')
      // Tailwind's `ring-*` on focus is a box-shadow in a faded accent: not the §1 ring.
      expect(text, `${file} draws a utility focus ring`).not.toMatch(
        /focus(?:-visible|-within)?:ring-/
      )
      // Radix / shadcn primitives switch the outline off and never draw one: the base ring is lost.
      expect(text, `${file} switches the ring off on focus`).not.toMatch(
        /focus(?:-visible)?:outline-none/
      )
    }
  })
})
