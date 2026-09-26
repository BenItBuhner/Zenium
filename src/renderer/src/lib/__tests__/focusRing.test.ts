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
  it('is the floor under every control: a base-layer :focus-visible rule in the ring token, inset 2px, drawn for the pane chord’s mark too', () => {
    const at = css.indexOf(" * The chrome's focus ring (v2 §1, a11y-10)")
    expect(at).toBeGreaterThan(0)
    const block = css.slice(at, css.indexOf('@layer components {', at))
    // The ring's two triggers (§1 as amended with #400): `:focus-visible`, and the
    // `data-keyboard-focus` mark a pane chord's landing carries (lib/panes.ts) where Chromium's
    // heuristic reads the script-moved focus as the mouse's.
    expect(block).toMatch(
      /@layer base \{\s*\* \{\s*outline-color: var\(--v2-ring\);\s*outline-width: 2px;\s*outline-offset: -2px;\s*\}\s*:focus-visible,\s*\[data-keyboard-focus\]:focus \{\s*outline: 2px solid var\(--v2-ring\);\s*outline-offset: -2px;\s*\}\s*\}/
    )
    // Before the first components layer, so every component rule can still speak over it.
    expect(at).toBeLessThan(css.indexOf('@layer components {'))
  })

  it('rings a pane chord’s landing as a Tab’s: every ring rule in main.css carries `[data-keyboard-focus]:focus` beside its `:focus-visible` – in the same rule, or as the rule right under a form another suite pins by name – never one override – save the phone’s (§1 as amended, a11y-09)', () => {
    // The chords (F6, Shift+F6, Shift+Alt+T, Shift+Alt+B) are the desktop main process's; the
    // mark never appears in a phone's document, and the coarse-pointer suppressor must not learn
    // to hide a keyboard-made ring, so those forms stand as they are: the phone pill's, the
    // phone zoom slider's, the phone group strip's chip (PhoneShell's alone).
    const PHONES_OWN = [
      ":root[data-input='keyboard'] .zen-phone-pill:has(button:focus-visible)",
      '.zen-phone-pill button:focus-visible',
      ":root[data-pointer='coarse']:where(:not([data-input='keyboard'])) button:focus-visible, :root[data-pointer='coarse']:where(:not([data-input='keyboard'])) [role='button']:focus-visible",
      ":root[data-form-factor='phone'] .zen-zoom-slider [role='slider']:focus-visible",
      ":root[data-form-factor='phone'] .zen-zoom-slider [role='slider']:focus-visible::before",
      '.zen-group-chip:focus-visible',
      '.zen-group-chip:focus-visible .zen-group-chip-face'
    ]
    // Two forms other suites pin by their text (the confirm chassis's and the phone sheet's on
    // the dialog root's none, the confirm chassis's on the legacy button's ring): their twin is
    // the rule right under them, its selector the twin of each form and its body the same.
    const TWIN_UNDER = [
      ":root [role='dialog'][tabindex='-1']:focus-visible, :root [role='alertdialog'][tabindex='-1']:focus-visible",
      '.zen-button:focus-visible'
    ]
    const twinOf = (selector: string): string =>
      selector
        .split(/,\s*/)
        .filter((f) => f.includes(':focus-visible'))
        .map((f) => f.replace(/:focus-visible/g, '[data-keyboard-focus]:focus'))
        .join(', ')
    const bare = new Set(ringRules(css).map((r) => r.selector))
    expect([...bare].filter((s) => !s.includes('[data-keyboard-focus]:focus')).sort()).toEqual(
      [...PHONES_OWN, ...TWIN_UNDER].sort()
    )
    // The twin is the `:focus-visible` form's own shape with the mark in its place: the same
    // compound (so the same specificity class), `:focus` not `:focus-visible`, and one per form.
    for (const selector of bare) {
      if (PHONES_OWN.includes(selector) || TWIN_UNDER.includes(selector)) continue
      const forms = selector.split(/,\s*/)
      const marked = forms.filter((f) => f.includes('[data-keyboard-focus]:focus'))
      expect(marked.join(', '), selector).toBe(twinOf(selector))
    }
    // Every rule of the sheet in order (a wrapper such as `@layer` or `@media` is skipped, its
    // rules read): the pinned forms' twins stand right under them, the body the same to the byte.
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)].map(
      (m) => ({
        selector: (m[1] ?? '').trim().replace(/\s+/g, ' '),
        body: (m[2] ?? '').trim().replace(/\s+/g, ' ')
      })
    )
    const twinsUnder = TWIN_UNDER.map(twinOf)
    for (const [i, pinned] of TWIN_UNDER.entries()) {
      const at = rules.findIndex((r) => r.selector === pinned)
      expect(at, pinned).toBeGreaterThanOrEqual(0)
      expect(rules[at + 1], `the twin under ${pinned}`).toEqual({
        selector: twinsUnder[i],
        body: rules[at]!.body
      })
    }
    // And no rule reads the mark on its own: it is the ring's second trigger, not a state of
    // its own, so nothing styles it that does not style `:focus-visible` the same way – the two
    // twins under their pinned forms, checked above to the byte, are that same way written twice.
    for (const { selector } of rules) {
      if (!selector.includes('[data-keyboard-focus]') || twinsUnder.includes(selector)) continue
      expect(selector, 'reads the mark without :focus-visible beside it').toMatch(/:focus-visible/)
    }
    // The toolbar glyph's full ink under the keyboard (a11y-10: the ring is not drawn at the
    // resting 85 %) lists the mark beside `:focus-visible` in its `:is()`; the hover branch is
    // the same rule's second selector, gated on the root's live `data-hover` (OS-12).
    expect(css.replace(/\s+/g, ' ')).toContain(
      ".zen-toolbar-button:is( :focus-visible, [data-keyboard-focus]:focus, [aria-expanded='true'], :disabled, [data-disabled] ) > :is(svg:not(.zen-dl-ring), .zen-glyph-swap, .zen-dl-glyph-body), :where(:root[data-hover='hover']) .zen-toolbar-button:hover:not(:disabled) > :is(svg:not(.zen-dl-ring), .zen-glyph-swap, .zen-dl-glyph-body) { opacity: 1; }"
    )
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
    // The pane chord's twin (§1 as amended) is the rule right under it – the form's own text is
    // pinned by the confirm chassis's and the phone sheet's suites.
    const rule = css.match(
      /:root \[role='dialog'\]\[tabindex='-1'\]:focus-visible,\n:root \[role='alertdialog'\]\[tabindex='-1'\]:focus-visible \{\n {2}outline: none;\n\}\n:root \[role='dialog'\]\[tabindex='-1'\]\[data-keyboard-focus\]:focus,\n:root \[role='alertdialog'\]\[tabindex='-1'\]\[data-keyboard-focus\]:focus \{\n {2}outline: none;\n\}/
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
      // The menu container's exemption (§9.22; v2Tokens.test.ts pins its text, order and
      // weight): not a suppressor – a container that holds the focus by design draws no ring,
      // as the dialog root draws none – its `:root[data-pointer='coarse']` form is the weight
      // of the v2 ring rule's coarse form, which its plain form could not beat on a phone.
      ".zen-v2-menu:focus-visible, :root[data-pointer='coarse'] .zen-v2-menu:focus-visible, .zen-v2-menu[data-keyboard-focus]:focus, :root[data-pointer='coarse'] .zen-v2-menu[data-keyboard-focus]:focus",
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
