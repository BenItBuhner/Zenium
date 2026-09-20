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

/** The `:focus-visible` rules of a stylesheet that set an outline, with the declaration's value. */
function ringRules(text: string): Array<{ selector: string; value: string }> {
  const out: Array<{ selector: string; value: string }> = []
  const rule = /([^{}]*:focus-visible[^{}]*)\{([^{}]*)\}/g
  for (const m of text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(rule)) {
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
      /@layer base \{\s*:focus-visible \{\s*outline: 2px solid var\(--v2-ring\);\s*outline-offset: -2px;\s*\}\s*\}/
    )
    // Before the first components layer, so every component rule can still speak over it.
    expect(at).toBeLessThan(css.indexOf('@layer components {'))
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
