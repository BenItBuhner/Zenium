import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * The horizontal strip's states in the sheet (parity tabs-61 / tabs-63; design language v2
 * §9.37, §9.29, §11; Chromium `horizontal_tab_style_views.cc`, `tab.cc`, `tab_style.cc`): the
 * active tab the separated pill on `--v2-window-fill` and never Chrome's merged shape, the hover
 * `--v2-window-fill-hover` over §11's 120 ms on `--zen-ease` (a cut under reduced motion), the
 * press the pill's fill from the pointer-down with no scale and never `--v2-selected`, the
 * separators the split row's 1 × 16 hairline in `--zen-border` – hidden on and beside a lit row,
 * faded with the hover, none on a chip and none before the + – and the whole strip on the window
 * family alone, so the Space's theme and the private window's dark theme paint every state.
 */

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')

function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

/** The block a rule with `selector` among its selectors declares (the first such rule). */
function ruleWith(selector: string): string {
  const at = css.indexOf(selector)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', at)
  return css.slice(at, css.indexOf('}', open))
}

/** The strip's own rules: from the §9.37 comment to the split row's. */
const strip = css.slice(
  css.indexOf('The horizontal tab strip (design language v2 §9.37'),
  css.indexOf("The split group's row (design language v2 §9.35")
)
const stripRules = strip.replace(/\/\*[\s\S]*?\*\//g, '')

const SEPARATOR =
  '.zen-tab-strip :is([data-tab-list], .zen-group-rows) > :is(.zen-tab, .zen-split-row)::after'

describe('the active tab (§9.37: the separated pill, never merged into the toolbar)', () => {
  it('is --v2-window-fill, declared after the hover fill so the active tab takes no hover', () => {
    const active = rule(".zen-tab[data-active='true']")
    expect(active).toContain('background: var(--v2-window-fill);')
    const hover = css.indexOf(":where(:root[data-hover='hover']) .zen-tab:hover")
    expect(hover).toBeGreaterThanOrEqual(0)
    expect(css.indexOf(".zen-tab[data-active='true'] {")).toBeGreaterThan(hover)
  })

  it('the band paints no surface of its own for it to merge into: no fill, no hairline on the strip', () => {
    expect(stripRules).not.toMatch(/\.zen-tab-strip\s*\{/)
    expect(stripRules).not.toMatch(/border(-(top|bottom))?:/)
    expect(stripRules).not.toMatch(/box-shadow:/)
  })
})

describe('the hover fade (§11: 120 ms on --zen-ease, one curve both ways)', () => {
  it('is the row’s background transition to --v2-window-fill-hover', () => {
    const tab = rule('.zen-tab')
    expect(tab).toMatch(
      /transition:\s*background 120ms var\(--zen-ease\),\s*opacity 120ms var\(--zen-ease\);/
    )
    expect(
      rule(
        ":where(:root[data-hover='hover']) .zen-tab:hover,\n  .zen-tab[data-editing]:not([data-active='true'])"
      )
    ).toContain('background: var(--v2-window-fill-hover);')
  })

  it('re-declares nothing under reduced motion: the fill change is a cut (§11.3 keeps opacity fades alone)', () => {
    for (const m of css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{/g)) {
      let depth = 1
      let i = m.index + m[0].length
      while (i < css.length && depth > 0) {
        if (css[i] === '{') depth++
        else if (css[i] === '}') depth--
        i++
      }
      expect(css.slice(m.index, i)).not.toContain('.zen-tab-strip')
    }
  })
})

describe('the pressed tab (Chrome selects on the press; the strip wears the state the release commits)', () => {
  it('takes --v2-window-fill from the pointer-down on an inactive tab row or split row', () => {
    const pressed = rule(
      ".zen-tab-strip .zen-tab:not(.zen-split-seg, [data-tab-folder], [data-active='true']):active,\n  .zen-tab-strip .zen-split-row:not([data-active='true']):active"
    )
    expect(pressed).toContain('background: var(--v2-window-fill);')
    expect(pressed).not.toMatch(/transform|scale/)
  })

  it('never --v2-selected, and the active tab and the chip are left out', () => {
    expect(stripRules).not.toContain('--v2-selected')
    expect(stripRules).toContain(
      ":not(.zen-split-seg, [data-tab-folder], [data-active='true']):active"
    )
  })
})

describe('the separators (Chrome’s GetSeparatorOpacity rules in §9.35’s hairline)', () => {
  it('are 1 × 16 in --zen-border, centred on the row, in the third pixel of the 4 gap, fading over 120 ms', () => {
    const sep = rule(SEPARATOR)
    expect(sep).toContain("content: ''")
    expect(sep).toContain('position: absolute')
    expect(sep).toContain('top: calc(50% - 8px)')
    expect(sep).toContain('right: -3px')
    expect(sep).toContain('width: 1px')
    expect(sep).toContain('height: 16px')
    expect(sep).toContain('background: var(--zen-border)')
    expect(sep).not.toContain('--v2-border')
    expect(sep).toContain('pointer-events: none')
    expect(sep).toContain('transition: opacity 120ms var(--zen-ease)')
  })

  it('are drawn by tab rows alone – the list’s and a group’s member rows – never by a chip', () => {
    // The selector reaches rows as direct children of a tablist or a group's rows; a chip is the
    // shell's child (tabStripStates.test.tsx pins the DOM), so nothing here paints one on it.
    expect(SEPARATOR).toContain(
      ':is([data-tab-list], .zen-group-rows) > :is(.zen-tab, .zen-split-row)::after'
    )
    expect(stripRules).not.toMatch(/\[data-tab-folder\](:[\w-]+(\([^)]*\))?)*::after/)
  })

  it('hide on and beside a lit row: active, selected, pressed, a drop target, the editor’s anchor', () => {
    const hidden = ruleWith(
      ".zen-tab-strip\n    :is([data-tab-list], .zen-group-rows)\n    > :is(.zen-tab, .zen-split-row):is(\n      [data-active='true'],"
    )
    expect(hidden).toContain('opacity: 0')
    for (const state of [
      "[data-active='true']",
      '[data-selected]',
      '[data-editing]',
      '[data-drop-into]',
      ':active'
    ])
      expect(hidden).toContain(state)
    // The neighbour's shape hides this row's trailing separator (the next row, a group's chip
    // after it, the row after a group's last member, the regular list's first row after the pinned).
    expect(hidden).toMatch(/:has\(\s*\+ :is\(\.zen-tab, \.zen-split-row\):is\(/)
    expect(hidden).toMatch(
      /\+ \.zen-strip-group\s*> \[data-tab-folder\]:is\(\[data-active='true'\]/
    )
    expect(hidden).toMatch(
      /\.zen-strip-group:has\([\s\S]*?\)\s*\.zen-group-rows\s*> :last-child::after/
    )
    expect(hidden).toMatch(/\[data-strip-pinned\]:has\(\s*\+ \.zen-strip-scroller/)
  })

  it('fade with the hover of the row or its neighbour, for a pointer that can hover', () => {
    const faded = ruleWith(
      ":where(:root[data-hover='hover'])\n    .zen-tab-strip\n    :is([data-tab-list], .zen-group-rows)\n    > :is(.zen-tab, .zen-split-row):hover::after"
    )
    expect(faded).toContain('opacity: 0')
    expect(faded).toMatch(
      /:has\(\s*\+ :is\(\.zen-tab, \.zen-split-row\):hover,\s*\+ \.zen-strip-group > \[data-tab-folder\]:hover\s*\)::after/
    )
    expect(faded).toMatch(
      /\[data-strip-pinned\]:has\(\s*\+ \.zen-strip-scroller \[data-tab-list\] > :first-child:hover/
    )
  })

  it('draw none from the regular list’s last row before the +', () => {
    const last = rule(
      ".zen-tab-strip [data-tab-list='regular'] > :last-child::after,\n  .zen-tab-strip\n    [data-tab-list='regular']\n    > .zen-strip-group:last-child\n    .zen-group-rows\n    > :last-child::after"
    )
    expect(last).toContain('display: none')
  })

  it('are the split row’s hairline: the same 1 × 16 in --zen-border (§9.35)', () => {
    const split = rule('.zen-split-hairline')
    expect(split).toContain('width: 1px')
    expect(split).toContain('height: 16px')
    expect(split).toContain('background: var(--zen-border)')
  })
})

describe('the frame colour and the theme (§9.29: the window family alone)', () => {
  it('reads window tokens only – the theme’s ink and fills, the window hairline – no page token', () => {
    const reads = [...stripRules.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1])
    expect(reads.length).toBeGreaterThan(0)
    const window = new Set([
      '--v2-window-fill',
      '--v2-window-fill-hover',
      '--zen-border',
      '--zen-ease',
      '--zen-tab-row',
      '--zen-strip-tab-width',
      '--zen-group-rgb',
      '--zen-accent',
      '--zen-accent-rgb'
    ])
    for (const token of reads) expect(window.has(token), `${token} is a window token`).toBe(true)
    for (const page of [
      '--v2-fill',
      '--v2-fill-hover',
      '--v2-text',
      '--v2-border',
      '--v2-accent',
      '--v2-selected',
      '--v2-panel',
      '--zen-bg-solid'
    ])
      expect(stripRules, `${page} on the window`).not.toContain(page)
  })

  it('declares no hex of its own: every colour is a token', () => {
    expect(stripRules).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })

  it('paints the private strip with no rule of its own: the private theme’s tokens carry it (§9.37)', () => {
    expect(stripRules).not.toContain('[data-private]')
    expect(stripRules).not.toContain("data-window-kind='private'")
    // The private window's theme is the root's (`useTheme.ts`): its ink and accent flow into the
    // window family the strip reads, as into the sidebar's rows.
    const family = rule("[data-surface='window']")
    expect(family).toContain('--v2-control-fill: var(--v2-window-fill)')
    expect(family).toContain('--v2-control-fill-hover: var(--v2-window-fill-hover)')
    expect(family).toContain('--v2-control-accent: var(--zen-accent)')
  })

  it('the window fills are alphas of the theme’s ink in both schemes, the hairline the window border', () => {
    const lightStart = css.indexOf(':root {')
    const light = css.slice(lightStart, css.indexOf("/* Zen clamps its primary colour's lightness"))
    expect(light).toContain('--v2-window-fill: rgb(var(--zen-fg-rgb) / 0.08)')
    expect(light).toContain('--v2-window-fill-hover: rgb(var(--zen-fg-rgb) / 0.14)')
    expect(light).toContain('--v2-window-fill: rgb(var(--zen-fg-rgb) / 0.15)')
    expect(light).toContain('--v2-window-fill-hover: rgb(var(--zen-fg-rgb) / 0.2)')
    expect(light).toContain('--zen-border: var(--v2-window-border)')
  })
})
