// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A row's focus ring inside a clipped popover (design language v2 §1, §9.20; the #245 review's
 * chassis item (b)). `.zen-bm-popover { overflow: hidden }` and its scrolling body clip at their
 * edges, and a `.zen-v2-row` that runs edge to edge has its ring's sides cut off. The chassis
 * rule: the list leaves the ring its room – a row in the shared popover body stands
 * `--v2-ring-room` in from each side and gives that much back from its gutter, so its text stays
 * at 16 – and a list whose first row touches the body's edge (the downloads bubble's) leaves the
 * same room above it. These tests pin the token, the rule's place and shape, and model the
 * geometry the way a reviewer measures it (box to box, §5) as far as a DOM without layout goes;
 * the pixels are the Xvfb drive's (`harness/linux/chassis-primitives.js`).
 */
const css = readFileSync(resolvePath(__dirname, '../../assets/main.css'), 'utf8')
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Where the rule `selector {` starts its own line (indented or not) after `from`. */
function ruleAt(selector: string, from = 0): number {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`(?<=^|\\n) *${escaped} \\{`).exec(bare.slice(from))
  expect(m, `rule "${selector}"`).not.toBeNull()
  return from + m!.index
}

/** The declarations of the rule `selector {`, as `[property, value]` pairs. */
function declarations(selector: string): Array<[string, string]> {
  const start = ruleAt(selector)
  const body = bare.slice(bare.indexOf('{', start) + 1, bare.indexOf('}', start))
  return [...body.matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()])
}
const value = (selector: string, property: string): string => {
  const found = declarations(selector).find(([p]) => p === property)
  expect(found, `${selector} { ${property} }`).toBeDefined()
  return found![1]
}

/** The number of `{` still open at `index` of the comment-free text: 0 is outside every layer. */
function nesting(index: number): number {
  const before = bare.slice(0, index)
  return (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length
}

const px = (s: string): number => {
  const m = /^(-?\d+(?:\.\d+)?)(?:px)?$/.exec(s.trim())
  expect(m, `a length: "${s}"`).not.toBeNull()
  return Number(m![1])
}

/** The body's inner width the row's `100%` stands for: a 320 panel inside its 1 px border. */
const BODY_WIDTH = 318

/**
 * A length over the room token, in px: `var(--v2-ring-room)`, `calc(100% - 2 * var(…))` or
 * `calc(16px - var(…))` – the three forms the rule uses – resolved with the token's value.
 */
function resolve(expression: string, room: number): number {
  const term = (t: string): number => {
    const s = t.trim()
    if (s === '100%') return BODY_WIDTH
    if (s === 'var(--v2-ring-room)') return room
    const product = /^(\d+(?:\.\d+)?) \* var\(--v2-ring-room\)$/.exec(s)
    if (product) return Number(product[1]) * room
    return px(s)
  }
  const calc = /^calc\((.+) - (.+)\)$/.exec(expression.trim())
  return calc ? term(calc[1]!) - term(calc[2]!) : term(expression)
}

// The light token block is the first `:root {` that declares a v2 token.
const lightBlock = bare.slice(
  bare.lastIndexOf(':root {', bare.indexOf('--v2-page:')),
  bare.indexOf('\n}', bare.indexOf('--v2-page:'))
)
const ROOM = px(/--v2-ring-room:\s*([^;]+);/.exec(lightBlock)?.[1] ?? '')
const ROW = '.zen-bm-popover-body .zen-v2-row'

describe('a row’s ring inside a clipped popover (§1, §9.20; chassis (b))', () => {
  it('has one token for the room, in the light block only: the ring’s 2 px past the row at the shared offset 0', () => {
    expect(ROOM).toBe(2)
    expect(bare.match(/--v2-ring-room:/g) ?? []).toHaveLength(1)
    // The shared ring the room is measured against: 2 px, offset 0 in light, −2 (inside) in dark.
    const shared = bare.indexOf("[class^='zen-v2-']:focus-visible")
    expect(shared).toBeGreaterThan(0)
    const ring = bare.slice(shared, bare.indexOf('}', shared))
    expect(ring).toMatch(/outline: 2px solid var\(--v2-ring\)/)
    expect(ring).toMatch(/outline-offset: 0;/)
    const dark = bare.slice(
      bare.indexOf(":root[data-theme='dark'] [class^='zen-v2-']:focus-visible"),
      bare.indexOf('}', bare.indexOf(":root[data-theme='dark'] [class^='zen-v2-']:focus-visible"))
    )
    expect(dark).toMatch(/outline-offset: -2px;/)
    const lightReach = 0 + 2
    const darkReach = -2 + 2
    expect(ROOM).toBeGreaterThanOrEqual(lightReach)
    expect(ROOM).toBeGreaterThanOrEqual(darkReach)
  })

  it('is one unlayered rule beside the row primitive, tokens only: the row stands in by the room and gives it back from its gutter', () => {
    expect(bare.match(/\.zen-bm-popover-body \.zen-v2-row \{/g) ?? []).toHaveLength(1)
    const at = ruleAt(ROW)
    expect(nesting(at)).toBe(0)
    expect(at).toBeGreaterThan(ruleAt('.zen-v2-row'))
    expect(at).toBeLessThan(ruleAt('.zen-v2-field'))
    expect(declarations(ROW)).toEqual([
      ['width', 'calc(100% - 2 * var(--v2-ring-room))'],
      ['margin-inline', 'var(--v2-ring-room)'],
      ['padding-inline', 'calc(16px - var(--v2-ring-room))']
    ])
    // The primitive keeps its own gutter and box, and the body pads nothing: nothing else moves.
    expect(value('.zen-v2-row', 'padding')).toBe('var(--v2-row-pad) 16px')
    expect(value('.zen-v2-row', 'width')).toBe('100%')
    expect(declarations('.zen-bm-popover-body').map(([p]) => p)).toEqual([
      'min-height',
      'flex',
      'overflow-y'
    ])
  })

  it('models the geometry: a 320 popover’s first and last row show the ring on all four sides, their text at the 16 gutter', () => {
    // The panel: 320 wide with a 1 px border, so its clip – and the body's – runs x 1 → 319.
    const clip = { x0: 1, x1: 1 + BODY_WIDTH }
    const inset = resolve(value(ROW, 'margin-inline'), ROOM)
    const width = resolve(value(ROW, 'width'), ROOM)
    const gutter = resolve(value(ROW, 'padding-inline'), ROOM)
    const row = { x0: clip.x0 + inset, x1: clip.x0 + inset + width }
    expect(row).toEqual({ x0: 3, x1: 317 })
    // The light ring, 2 px outside the row at offset 0: its outer edge on both sides lies on or
    // inside the clip, so both sides paint – no longer two horizontal bars.
    const reach = 0 + 2
    expect(row.x0 - reach).toBeGreaterThanOrEqual(clip.x0)
    expect(row.x1 + reach).toBeLessThanOrEqual(clip.x1)
    // Box to box (§5): the row's text starts 16 from the panel's inner edge, where the title
    // block's padding and the heading's gutter put theirs.
    expect(inset + gutter).toBe(16)
    expect(value('.zen-bm-title-block', 'padding')).toBe('16px')
    expect(value('.zen-v2-heading', 'padding')).toBe('0 16px')
    // The row's height is untouched: the rule states no block padding, no height.
    for (const [property] of declarations(ROW))
      expect(property).not.toMatch(/height|padding-block|padding-top|padding-bottom|margin-block/)
    // Top and bottom. The downloads list's first row is the first thing under the title block:
    // the list leaves the room above it, and 8 under the last row to the footer's hairline.
    const list = value('.zen-dl-bubble .zen-dl-list', 'padding').split(/\s+/)
    expect(list).toEqual(['var(--v2-ring-room)', '0', '8px'])
    expect(resolve(list[0]!, ROOM)).toBeGreaterThanOrEqual(reach)
    expect(px(list[2]!)).toBeGreaterThanOrEqual(reach)
    // The folder editor's action rows sit under a hairline with 4 and end 4 above the panel's
    // edge; tab search's first heading stands 4 under the title block (§9.20's 4 px insets).
    expect(px(value('.zen-group-editor-actions', 'padding-bottom'))).toBeGreaterThanOrEqual(reach)
    const hairline = value('.zen-group-editor-actions::before', 'margin').split(/\s+/)
    expect(px(hairline[2]!)).toBeGreaterThanOrEqual(reach)
    const heading = value('.zen-v2-heading.zen-tab-search-heading:first-child', 'margin-top')
    expect(px(heading)).toBeGreaterThanOrEqual(reach)
  })

  it('reaches every row form the popovers use – a list item, a button, a div – and no row outside a popover body', () => {
    document.body.innerHTML = `
      <div class="zen-bm-popover">
        <div class="zen-bm-title-block"><h2 class="zen-bm-title">Downloads</h2></div>
        <div class="zen-bm-popover-body">
          <div class="zen-v2-heading zen-tab-search-heading">Open tabs</div>
          <div class="zen-v2-row zen-tab-search-row" role="option" id="div-row"></div>
          <ul class="zen-dl-list"><li class="zen-v2-row zen-dl-row" tabindex="0" id="li-row"></li></ul>
          <div class="zen-group-editor-actions"><button class="zen-v2-row zen-group-editor-action" id="button-row"></button></div>
          <div class="zen-v2-control-row" id="control-row"></div>
        </div>
      </div>
      <div class="zen-page-host"><button class="zen-v2-row" id="page-row"></button></div>
      <div class="zen-bm-listbox"><button class="zen-bm-option" id="option"></button></div>`
    for (const id of ['div-row', 'li-row', 'button-row'])
      expect(document.getElementById(id)!.matches(ROW), id).toBe(true)
    // A settings page's row keeps the primitive's edge-to-edge box; a control row (blocked
    // pop-ups' entries, whose Open button carries the ring) and a listbox option are not rows.
    for (const id of ['page-row', 'control-row', 'option'])
      expect(document.getElementById(id)!.matches(ROW), id).toBe(false)
    document.body.innerHTML = ''
  })
})
