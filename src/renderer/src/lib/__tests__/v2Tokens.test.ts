import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The design-language v2 tokens live in one block of main.css (docs/design-language-v2-draft.md).
 * These tests pin the set so surfaces cannot fork their own copies, and check that the block is
 * definitions only until a surface is deliberately moved to v2.
 */
const css = readFileSync(fileURLToPath(new URL('../../assets/main.css', import.meta.url)), 'utf8')

/** Custom-property names declared inside the first `selector {` block found after `from`. */
function declared(selector: string, from = 0): Set<string> {
  const start = css.indexOf(`${selector} {`, from)
  expect(start, `block "${selector}"`).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('\n}', start)
  const names = css.slice(start, end).match(/--v2-[a-z0-9-]+(?=:)/g) ?? []
  return new Set(names)
}

// The light block is the first `:root {` that declares a v2 token.
const lightStart = css.indexOf('--v2-page:')
const lightBlockStart = css.lastIndexOf(':root {', lightStart)
const light = declared(':root', lightBlockStart)
const dark = declared(":root[data-theme='dark']", lightStart)
const phone = declared(":root[data-form-factor='phone']", lightStart)

const SURFACE = [
  'page',
  'card',
  'card-border',
  'panel',
  'border',
  'urlbar',
  'text',
  'text-rgb',
  'text-deemphasized',
  'fill',
  'fill-hover',
  'accent',
  'on-accent',
  'scrim',
  'scrim-modal',
  'sidebar-neutral',
  'tab-active',
  'urlpill',
  'nav-active',
  'window-fill',
  'window-fill-hover'
].map((n) => `--v2-${n}`)

const SCALE = [
  'radius-control',
  'radius-card',
  'radius-sheet',
  'radius-checkbox',
  'radius-inner',
  'shadow-panel',
  'shadow-sheet',
  'shadow-urlbar',
  'shadow-frame',
  'font-title',
  'font-heading',
  'font-body',
  'font-small',
  'line-body',
  'line-small',
  'weight-body',
  'weight-button',
  'weight-heading',
  'row',
  'row-two-line',
  'control',
  'checkbox',
  'nav-item',
  'menu-row',
  'icon-button',
  'icon',
  'icon-stroke',
  'card-padding',
  'content-max',
  'ring',
  'selection',
  'ok',
  'warn',
  'danger'
].map((n) => `--v2-${n}`)

describe('design language v2 tokens', () => {
  it('defines every surface and scale token in the light block', () => {
    for (const name of [...SURFACE, ...SCALE]) expect(light, name).toContain(name)
  })

  it('redefines every colour surface for dark, and nothing that is not a colour', () => {
    const colourOnly = SURFACE.filter(
      (n) => !['--v2-window-fill', '--v2-window-fill-hover'].includes(n)
    )
    for (const name of colourOnly) expect(dark, name).toContain(name)
    for (const name of dark)
      expect(light, `${name} declared for dark but not light`).toContain(name)
    for (const name of dark)
      expect(
        SCALE.filter((s) => !s.startsWith('--v2-shadow-urlbar')),
        `${name} is not a colour`
      ).not.toContain(name)
  })

  it('scales hit targets on phones without touching the vocabulary', () => {
    for (const name of [
      '--v2-row',
      '--v2-control',
      '--v2-checkbox',
      '--v2-menu-row',
      '--v2-icon-button',
      '--v2-icon'
    ])
      expect(phone, name).toContain(name)
    for (const name of phone)
      expect(SURFACE, `${name} must not change per form factor`).not.toContain(name)
  })

  it('is defined, not consumed: no rule outside the token block reads a v2 token yet', () => {
    const blockEnd = css.indexOf("/* Zen clamps its primary colour's lightness")
    expect(blockEnd).toBeGreaterThan(lightStart)
    const outside = css.slice(0, lightBlockStart) + css.slice(blockEnd)
    expect(outside.match(/var\(--v2-/g) ?? []).toHaveLength(0)
    const inside = css.slice(lightBlockStart, blockEnd)
    // Only token-to-token references inside the block: the ring and selection derive from the accent.
    expect((inside.match(/var\(--v2-/g) ?? []).length).toBe(2)
  })
})
