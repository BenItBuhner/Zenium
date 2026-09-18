import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HINT_PALETTE } from '@shared/fullscreenHint'

/**
 * The design-language v2 tokens live in one block of main.css (docs/design-language-v2-draft.md).
 * These tests pin the set so surfaces cannot fork their own copies, and check that nothing reads
 * the tokens except the surfaces deliberately moved to v2, listed below.
 */
const css = readFileSync(fileURLToPath(new URL('../../assets/main.css', import.meta.url)), 'utf8')

/**
 * Surfaces built on v2, each as the pair of markers that brackets its rules in main.css (the
 * first is the start of its block, the second the first text after it). Add a surface here when
 * it is moved to v2 on purpose; anything else reading a v2 token fails the last test.
 */
const V2_SURFACES: ReadonlyArray<readonly [start: string, end: string]> = [
  // The frame dialog host's scrim (lib/portals.tsx), which dims only the content frame (§9.5).
  ['.zen-frame-dialogs {', '.zen-chrome-layer {'],
  // The phone sheet chassis (components/sheet/BottomSheet.tsx): surface, header, grabber, rows
  // and separators shared by every phone sheet (v2 §6, §9.16, §9.25) – the shell pass.
  ['.zen-sheet {', '/*\n   * Bookmarks, built to the v2 draft'],
  // The pull-to-refresh disc (components/content/PullIndicator.tsx).
  ['.zen-ptr-disc {', '.zen-space-strip {'],
  // The v2 button, shared by every v2 surface (today the Settings > Look and Feel > Navigation bar
  // button, components/overlays/SettingsPanel.tsx); its layering is pinned by the tests below.
  ['.zen-v2-button {', '/* Safe-area insets pushed by mobile hosts'],
  // The Tabs button's hold menu (components/phone/TabsQuickMenu.tsx).
  ['.zen-quick-menu {', '/* The chassis sheet is the v2 surface (§6)'],
  // The navigation bar's editor (components/phone/BarEditorSheet.tsx, BarPreview.tsx).
  ['.zen-bar-row {', '/* The editor draws a hairline when its rows scroll under the header'],
  // The zen://error page (shared/zenPages.ts cuts this block, the token block and the v2 button
  // out of the stylesheet's text and writes them into the page, which cannot link main.css).
  ['.zen-error-document {', '@layer base {'],
  // The sidebar tab drag – drop-into targets, the audio indicator, ghost, caret and tear-off card
  // (lib/drag.ts, components/DragLayer.tsx, components/sidebar/TabItem.tsx).
  ['[data-drop-into] {', '.zen-panel {'],
  // The bookmark chrome: bar, panels, star bubble, dialogs, manager (components/bookmarks/*).
  ['.zen-bm-bar {', '/*\n * Fading scroll edges'],
  // Find in page, zoom and fullscreen: the docked find bar (components/content/FindBar.tsx).
  ['.zen-find-bar {', '/*\n * Settings → Default Browser and the'],
  // Settings → Default Browser and the default-browser strip (components/overlays/
  // DefaultBrowserSection.tsx, content/DefaultBrowserBanner.tsx): the flat card and its inks.
  ['.zen-default-browser-card {', '\n@media (prefers-reduced-motion: reduce) {'],
  // The message cards: toast and banner, their action button, glyph and close (components/messages/*).
  ['.zen-message {', '.zen-suggestion {'],
  // The zen-v2-* controls inside the chassis: headings and sections, rows, the switch row
  // (components/sheet/SwitchRow.tsx), radio, image radio card, the presets grid
  // (components/newtab/CustomizeSheet.tsx).
  ['.zen-v2-heading {', '.zen-ntp {'],
  // The new tab page: wallpaper, search field, .zen-v2-shortcut tiles, the customise sheet's
  // preset previews, the grow surface (components/newtab/NewTabPage.tsx).
  ['.zen-ntp {', '/*\n * A sheet coming up pushes the page back']
]

/** The text of the first `selector {` block found after `from`. */
function block(selector: string, from = 0): string {
  const start = css.indexOf(`${selector} {`, from)
  expect(start, `block "${selector}"`).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('\n}', start))
}

/** Custom-property names declared inside the first `selector {` block found after `from`. */
function declared(selector: string, from = 0): Set<string> {
  return new Set(block(selector, from).match(/--v2-[a-z0-9-]+(?=:)/g) ?? [])
}

/**
 * The two §9.29 token families, as the blocks that resolve the shared control roles for a
 * surface root carrying `data-surface="page"` or `"window"` (lib/portals.tsx puts "page" on the
 * frame dialog host and the chrome layer; the window chrome roots carry "window").
 */
const FAMILIES = ["[data-surface='page']", "[data-surface='window']"] as const

/** The control roles a chip, badge or icon button reads to draw in its surface's family. */
const CONTROL_ROLES = ['text', 'text-deemphasized', 'fill', 'fill-hover', 'accent'].map(
  (n) => `--v2-control-${n}`
)

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

  it('is read only by the surfaces deliberately moved to v2', () => {
    const blockEnd = css.indexOf("/* Zen clamps its primary colour's lightness")
    expect(blockEnd).toBeGreaterThan(lightStart)
    let outside = css.slice(0, lightBlockStart) + css.slice(blockEnd)
    for (const [start, end] of V2_SURFACES) {
      const from = outside.indexOf(start)
      const to = outside.indexOf(end, from)
      expect(from, `v2 surface "${start}"`).toBeGreaterThanOrEqual(0)
      expect(to, `end of v2 surface "${start}"`).toBeGreaterThan(from)
      expect(outside.slice(from, to), `"${start}" reads v2 tokens`).toMatch(/var\(--v2-/)
      outside = outside.slice(0, from) + outside.slice(to)
    }
    expect(outside.match(/var\(--v2-/g) ?? []).toHaveLength(0)
    const inside = css.slice(lightBlockStart, blockEnd)
    // Inside: the ring and selection derive from the accent, the shared focus-ring rule reads the
    // ring, the chassis scrim alias `--zen-scrim` reads the v2 scrim (§9.28), and the two §9.29
    // family blocks map the tokens onto the control roles.
    const familyReads = FAMILIES.map((f) => block(f).match(/var\(--v2-/g)?.length ?? 0)
    expect((inside.match(/var\(--v2-/g) ?? []).length).toBe(
      4 + familyReads.reduce((a, b) => a + b, 0)
    )
    expect(inside).toMatch(/--zen-scrim: var\(--v2-scrim\)/)
    expect(inside).toMatch(/\[class\^='zen-v2-'\]:focus-visible/)
  })
})

describe('token families (§9.29)', () => {
  const pageFamily = block(FAMILIES[0])
  const windowFamily = block(FAMILIES[1])
  const reads = (body: string): string[] => body.match(/var\(--[a-z0-9-]+\)/g) ?? []

  it('resolve the same control roles for a page surface and a window surface, inside the token block', () => {
    for (const family of FAMILIES) {
      expect(declared(family)).toEqual(new Set(CONTROL_ROLES))
      const at = css.indexOf(`${family} {`)
      expect(at).toBeGreaterThan(lightBlockStart)
      expect(at).toBeLessThan(css.indexOf("/* Zen clamps its primary colour's lightness"))
    }
  })

  it('never mixes them: page roles read the page tokens only, window roles the theme foreground and window fills only', () => {
    expect(reads(pageFamily)).toEqual([
      'var(--v2-text)',
      'var(--v2-text-deemphasized)',
      'var(--v2-fill)',
      'var(--v2-fill-hover)',
      'var(--v2-accent)'
    ])
    expect(pageFamily).not.toMatch(/--zen-|--v2-window-/)
    // Window ink is the theme's foreground, deemphasised at 69% of it.
    expect(reads(windowFamily)).toEqual([
      'var(--zen-fg)',
      'var(--zen-fg-rgb)',
      'var(--v2-window-fill)',
      'var(--v2-window-fill-hover)',
      'var(--zen-accent)'
    ])
    expect(windowFamily).toMatch(
      /--v2-control-text-deemphasized: rgb\(var\(--zen-fg-rgb\) \/ 0\.69\)/
    )
  })
})

/**
 * The stylesheet without its comments, so braces in prose do not count, and the number of
 * `{` blocks still open at `index` in it: 0 means the rule sits outside every `@layer`.
 */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
function nesting(index: number): number {
  const before = bare.slice(0, index)
  return (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length
}
function ruleAt(selector: string): number {
  const at = bare.indexOf(`\n${selector} {`)
  expect(at, `rule "${selector}"`).toBeGreaterThanOrEqual(0)
  return at + 1
}

describe('the v2 button', () => {
  it('is one rule, secondary by default with a data-primary variant', () => {
    expect(bare.match(/\.zen-v2-button \{/g) ?? []).toHaveLength(1)
    const base = ruleAt('.zen-v2-button')
    const primary = ruleAt('.zen-v2-button[data-primary]')
    expect(bare.slice(base, bare.indexOf('\n}', base))).toMatch(/background: var\(--v2-fill\)/)
    const primaryBody = bare.slice(primary, bare.indexOf('\n}', primary))
    expect(primaryBody).toMatch(/background: var\(--v2-accent\)/)
    expect(primaryBody).toMatch(/color: var\(--v2-on-accent\)/)
    // Same layer, so the variant's higher specificity is what makes it win – it must not rely on
    // coming later, but it does come later, as a variant reads.
    expect(primary).toBeGreaterThan(base)
  })

  it('sits outside the cascade layers, where it beats a Button’s utilities and no layered copy can beat it', () => {
    // Unlayered declarations win over every `@layer` (utilities included) whatever their order
    // or specificity: the rule must be unlayered to style a `Button` that carries the class, and
    // a second, layered copy of the class would lose all of its declarations to this one.
    for (const selector of [
      '.zen-v2-button',
      '.zen-v2-button:active:not(:disabled)',
      '.zen-v2-button:disabled',
      '.zen-v2-button[data-primary]',
      '.zen-v2-button[data-primary]:active:not(:disabled)'
    ])
      expect(nesting(ruleAt(selector)), `"${selector}" is inside a block`).toBe(0)
    // And no `@layer` block anywhere restates the class.
    for (const match of bare.matchAll(/\.zen-v2-button[^{]*\{/g))
      expect(nesting(match.index), `"${match[0].trim()}" is layered`).toBe(0)
  })
})

describe('the fullscreen hint palette', () => {
  /** The value a token is declared with in the first `selector {` block after `from`. */
  const value = (selector: string, from: number, name: string): string => {
    const match = block(selector, from).match(new RegExp(`${name}:\\s*([^;]+);`))
    expect(match, `${name} in ${selector}`).not.toBeNull()
    return match?.[1].trim() ?? ''
  }

  it('is the v2 panel, border, text and fill by value, one family per scheme (the page script cannot read main.css)', () => {
    const schemes = [
      [HINT_PALETTE.light, ':root', lightBlockStart],
      [HINT_PALETTE.dark, ":root[data-theme='dark']", lightStart]
    ] as const
    for (const [palette, selector, from] of schemes) {
      expect(palette.panel).toBe(value(selector, from, '--v2-panel'))
      expect(palette.border).toBe(value(selector, from, '--v2-border'))
      expect(palette.text).toBe(value(selector, from, '--v2-text'))
      expect(palette.fill).toBe(value(selector, from, '--v2-fill'))
    }
  })
})
