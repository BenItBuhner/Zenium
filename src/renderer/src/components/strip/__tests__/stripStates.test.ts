import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { STRIP_FADE, STRIP_GAP } from '@renderer/lib/tabStripLayout'

/*
 * The horizontal strip's states in the sheet (parity tabs-61 / tabs-63; design language v2
 * §9.37, §9.29, §9.19, §11): the sidebar's row laid along the caption band – the active tab the
 * separated pill on `--v2-window-fill` and never Chrome's merged shape, the hover
 * `--v2-window-fill-hover` over §11's 120 ms on `--zen-ease` (a cut under reduced motion), the
 * press §9.29's `--v2-control-fill-hover` at full ink (the window's hover fill) with no scale and
 * never `--v2-selected`, the "separators" the 4 px gaps between the rows and never a hairline,
 * the group's colour a 2 px line in the band's top inset, the overflow's 24 px edge fades – and
 * the whole strip on the window family alone, with no surface and no hairline of its own, so the
 * Space's gradient and the private window's theme with its accent paint every state.
 */

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')
const stripSource = readFileSync(resolve(__dirname, '../TabStrip.tsx'), 'utf8')
const chromeSource = readFileSync(resolve(__dirname, '../HorizontalChrome.tsx'), 'utf8')

function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

/** The strip's own rules: from the §9.37 comment to the split row's. */
const strip = css.slice(
  css.indexOf('The horizontal tab strip (design language v2 §9.37'),
  css.indexOf("The split group's row (design language v2 §9.35")
)
const stripRules = strip.replace(/\/\*[\s\S]*?\*\//g, '')

const PRESSED =
  ".zen-tab-strip .zen-tab:not(.zen-split-seg, [data-active='true']):active,\n  .zen-tab-strip .zen-split-row:not([data-active='true']):active"

describe('the active tab (§9.37: the separated pill, never merged into the toolbar)', () => {
  it('is --v2-window-fill, declared after the hover fill so the active tab takes no hover', () => {
    const active = rule(".zen-tab[data-active='true']")
    expect(active).toContain('background: var(--v2-window-fill);')
    const hover = css.indexOf(":where(:root[data-hover='hover']) .zen-tab:hover")
    expect(hover).toBeGreaterThanOrEqual(0)
    expect(css.indexOf(".zen-tab[data-active='true'] {")).toBeGreaterThan(hover)
  })

  it('the band paints no surface of its own for it to merge into: no fill, no hairline, no shadow on the strip', () => {
    expect(stripRules).not.toMatch(/\.zen-tab-strip\s*\{/)
    expect(stripRules).not.toMatch(/border(-(top|bottom))?:/)
    expect(stripRules).not.toMatch(/box-shadow:/)
    // Nor its markup: the strip's root and the band's header carry no fill, border or shadow
    // utility; the header's `zen-panel` is the hidden chrome's floating reveal alone.
    const root = stripSource.match(/className="zen-tab-strip[^"]*"/)?.[0] ?? ''
    expect(root).not.toMatch(/\b(bg-|border|shadow)/)
    const header = chromeSource.match(/<header[\s\S]*?>/)?.[0] ?? ''
    expect(header).toContain("cn('flex shrink-0 flex-col gap-1', floating && 'zen-panel')")
    expect(header).not.toMatch(/\b(bg-|border|shadow)/)
  })
})

describe('the hover fade (§11: 120 ms on --zen-ease, one curve both ways)', () => {
  it('is the row’s background transition to --v2-window-fill-hover', () => {
    const tab = rule('.zen-tab')
    expect(tab).toMatch(
      /transition:\s*background var\(--zen-motion-state\) var\(--zen-ease\),\s*opacity var\(--zen-motion-state\) var\(--zen-ease\);/
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
    // The one global remover (§11.3: one rule may remove, none may shorten) takes the transition.
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*::before,\s*::after \{\s*transition-property: none !important;\s*animation: none !important;/
    )
  })
})

describe('the pressed tab (§9.29: every window control’s press, --v2-control-fill-hover at full ink)', () => {
  it('takes --v2-window-fill-hover – the window family’s --v2-control-fill-hover – from the pointer-down', () => {
    const pressed = rule(PRESSED)
    expect(pressed).toContain('background: var(--v2-window-fill-hover);')
    expect(pressed).not.toMatch(/transform|scale/)
    expect(rule("[data-surface='window']")).toContain(
      '--v2-control-fill-hover: var(--v2-window-fill-hover)'
    )
  })

  it('reaches every row and the group’s chip – window controls all – and leaves the active pill and a split’s segment out', () => {
    expect(PRESSED).toContain(":not(.zen-split-seg, [data-active='true']):active")
    expect(PRESSED).not.toContain('[data-tab-folder]')
    expect(stripRules).not.toContain('--v2-selected')
    // The row's ink is full at rest (§9.29: labels are full ink), so the press adds no ink step.
    expect(rule('.zen-tab')).toContain('color: var(--zen-fg);')
  })
})

describe('the separators (§9.37: the 4 px gaps between the rows, never a hairline)', () => {
  it('are the strip’s one gap, 4 px, as the layout states it and the lists draw it', () => {
    expect(STRIP_GAP).toBe(4)
    // Every tablist along the band – the pinned rows, the regular rows, their outer run – is a
    // `gap-1` flex row (Tailwind's 0.25rem: the 4).
    const lists = stripSource.match(/className="[^"]*\bgap-1\b[^"]*"/g) ?? []
    expect(lists.length).toBeGreaterThanOrEqual(3)
    expect(stripSource).not.toMatch(/\bgap-(0|0\.5|2|3|4)\b/)
  })

  it('draw no hairline: the strip’s rules paint no ::after separator and read no border token', () => {
    const afters = [...stripRules.matchAll(/([^\n{}]+)::after\s*\{/g)].map((m) => m[1].trim())
    expect(afters).toEqual(['.zen-tab-progress'])
    expect(stripRules).not.toContain('--zen-border')
    expect(stripRules).not.toContain('--v2-window-border')
    expect(stripRules).not.toMatch(/height: 16px/)
  })

  it('leave §9.35’s 1 × 16 hairline to the split row alone, inside its own box', () => {
    const split = rule('.zen-split-hairline')
    expect(split).toContain('width: 1px')
    expect(split).toContain('height: 16px')
    expect(split).toContain('background: var(--zen-border)')
    expect(css.indexOf('.zen-split-hairline {')).toBeGreaterThan(
      css.indexOf("The split group's row (design language v2 §9.35")
    )
  })
})

describe('the group line (§9.37: one continuous 2 px line in the band’s top inset, y 2–4)', () => {
  it('runs the shell’s width at y 2, 2 tall, in the group’s colour, bridging the 4 px gaps', () => {
    const line = rule('.zen-strip-group-line')
    expect(line).toContain('position: absolute')
    expect(line).toContain('left: 0')
    expect(line).toContain('right: 0')
    expect(line).toContain('top: 2px')
    expect(line).toContain('height: 2px')
    expect(line).toContain('background: rgb(var(--zen-group-rgb))')
    expect(line).toContain('pointer-events: none')
  })
})

describe('the edge fades (§9.37: 24 px where the regular region overflows, no arrow buttons)', () => {
  it('are the house fade on the scroller at the strip’s 24, a mask that eases its depth and cuts under reduced motion', () => {
    expect(STRIP_FADE).toBe(24)
    expect(stripSource).toContain("useFadeEdges<HTMLDivElement>({ axis: 'x', size: STRIP_FADE })")
    const fade = rule("[data-fade-axis='x']")
    expect(fade).toMatch(
      /mask-image: linear-gradient\(\s*to right,\s*transparent,\s*#000 var\(--zen-fade-start\),\s*#000 calc\(100% - var\(--zen-fade-end\)\),\s*transparent\s*\)/
    )
    expect(rule('[data-fade-axis]')).toMatch(
      /transition:\s*--zen-fade-start 180ms var\(--zen-ease\),\s*--zen-fade-end 180ms var\(--zen-ease\)/
    )
    // No scrollbar and no arrows: the fades alone say there is more.
    expect(rule('.zen-strip-scroller')).toContain('scrollbar-width: none')
    expect(stripSource).not.toMatch(/ChevronLeft|ChevronRight|ArrowLeft|ArrowRight/)
  })
})

describe('the frame colour and the theme (§9.29: the window family alone; §9.19: the private accent)', () => {
  it('reads window tokens only – the theme’s ink, fills and accent – no page token, no hairline', () => {
    const reads = [...stripRules.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1])
    expect(reads.length).toBeGreaterThan(0)
    const window = new Set([
      '--v2-window-fill',
      '--v2-window-fill-hover',
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

  it('paints the private strip with no rule of its own: the private window’s theme and accent carry it (§9.37, §9.19)', () => {
    expect(stripRules).not.toContain('[data-private]')
    expect(stripRules).not.toContain("data-window-kind='private'")
    // The private window's theme is the root's (`useTheme.ts`) and its accent is the window's
    // rule below: both flow into the window family the strip reads, as into the sidebar's rows.
    const family = rule("[data-surface='window']")
    expect(family).toContain('--v2-control-fill: var(--v2-window-fill)')
    expect(family).toContain('--v2-control-fill-hover: var(--v2-window-fill-hover)')
    expect(family).toContain('--v2-control-accent: var(--zen-accent)')
    const priv = rule(".zen-window[data-window-kind='private']")
    expect(priv).toContain('--zen-accent: #a98bff')
    expect(priv).toContain('--zen-accent-rgb: 169 139 255')
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
