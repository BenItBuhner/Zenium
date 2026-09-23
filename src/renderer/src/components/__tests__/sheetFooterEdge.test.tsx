// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BottomSheet, SHEET_EDGE_PAD } from '../sheet/BottomSheet'
import { uiStore } from '@renderer/lib/ui'

/*
 * §9.25's one formula for the phone sheet's footer (as amended 2026-09-22, three hosts): the
 * footer's buttons stand 16 above the host's safe-area inset, so the gap from them to the
 * sheet's bottom edge is 16 + the inset the host reports – 16 where it reports none (the preview
 * host), 40 over a 24 gesture bar, 64 over a 48 three-button bar. On the web chassis the 16 is
 * `.zen-sheet-footer`'s 8 under the buttons over `BottomSheet`'s own 8 (`SHEET_EDGE_PAD`), and
 * the inset is ADDED to it – `8 + max(8, inset)` put the inset in place of the 8 (32 over a 24
 * bar, 8 short). The two Settings sheets whose actions draw inline in the body (a prompt's, a
 * field sheet's) stand on the same two 8s: the body's 8 over the chassis's – not a 16 over it
 * (24 at no inset). The native chassis's `PromptSheetSpec.footerToEdge` is pinned to the same
 * numbers (`V2TokensPinTest`). Read from the shipped stylesheet and a real render.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')

/** The declarations of the first top-level `selector {` block, comments stripped. */
function rule(selector: string): string {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const at = bare.indexOf(`\n${selector} {\n`)
  if (at < 0) {
    const nested = bare.indexOf(`\n  ${selector} {\n`)
    if (nested < 0) throw new Error(`main.css has no rule ${selector}`)
    return bare.slice(nested, bare.indexOf('\n  }', nested))
  }
  return bare.slice(at, bare.indexOf('\n}', at))
}

const px = (block: string, property: string): number => {
  const m = new RegExp(`\\n\\s*${property}: ([^;]+);`).exec(block)
  if (!m) throw new Error(`no ${property} in ${block}`)
  return parseFloat(m[1])
}

/** §9.25's formula: 16 + the inset the host reports, its three hosts. */
const HOSTS: Array<[inset: number, edge: number]> = [
  [0, 16],
  [24, 40],
  [48, 64]
]

let root: Root | null = null
let mount: HTMLElement | null = null

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  vi.unstubAllGlobals()
  act(() => uiStore.set({ insets: { top: 0, right: 0, bottom: 0, left: 0 } }))
})

function renderSheet(): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() =>
    root!.render(
      <BottomSheet
        onDismissed={() => undefined}
        footer={
          <>
            <button type="button" className="zen-v2-button">
              Cancel
            </button>
            <button type="button" className="zen-v2-button" data-primary>
              Save
            </button>
          </>
        }
      >
        <p>A notice.</p>
      </BottomSheet>
    )
  )
  return document.querySelector<HTMLElement>('.zen-sheet[role="dialog"]')!
}

describe("the footer's edge (§9.25)", () => {
  it("the chassis's 8 under `.zen-sheet-footer`'s 8 make the 16, and the inset is added to it: 16 / 40 / 64 over the three hosts", () => {
    const footer = rule('.zen-sheet-footer')
    const padding = /\n\s*padding: (\d+)px (\d+)px (\d+)px;/.exec(footer)!
    const [top, sides, bottom] = padding.slice(1).map(Number)
    expect([top, sides]).toEqual([16, 16])
    expect(bottom + SHEET_EDGE_PAD).toBe(16)
    for (const [inset, edge] of HOSTS) {
      act(() => uiStore.set({ insets: { top: 0, right: 0, bottom: inset, left: 0 } }))
      const sheet = renderSheet()
      // The sheet pads for the inset in full over its own 8: never an 8 floor the inset replaces.
      expect(parseFloat(sheet.style.paddingBottom)).toBe(SHEET_EDGE_PAD + inset)
      expect(bottom + parseFloat(sheet.style.paddingBottom)).toBe(edge)
      act(() => root!.unmount())
      root = null
      mount?.remove()
      mount = null
    }
  })

  it("a Settings sheet's inline actions stand on the body's 8 over the chassis's 8, not a 16 (24 at no inset)", () => {
    const body = rule('.zen-settings-sheet-body')
    expect(px(body, 'padding-bottom')).toBe(16 - SHEET_EDGE_PAD)
    // The actions themselves bring no bottom padding of their own (`padding: 0 16px`).
    expect(rule('.zen-settings-sheet-body > .zen-settings-sheet-actions')).toContain(
      'padding: 0 16px;'
    )
    for (const [inset, edge] of HOSTS) {
      expect(px(body, 'padding-bottom') + SHEET_EDGE_PAD + inset).toBe(edge)
    }
  })

  it("the New Tab page's Customize sheet, ending on a control row, stands the row's 4 and the body's 4 on the chassis's 8: 16 + inset, not 28", () => {
    // The sheet has no footer slot: its last control is the Choose-picture button in a
    // `.zen-v2-control-row`, whose own 4 below the 40 button (§9.21: the row is the control plus
    // 8) is the first of the three. The body brings 4 (`pb-1`), the chassis its 8 – a `pb-4`
    // there stacked a 16 on the row's 4 and stood 28 + inset off the edge.
    const source = readFileSync(resolve(__dirname, '../newtab/CustomizeSheet.tsx'), 'utf8')
    const body = /className="zen-ntp-customize ([^"]*)"/.exec(source)
    expect(body, 'the customize body').not.toBeNull()
    const pad = body![1].split(/\s+/).filter((c) => /^pb-/.test(c))
    expect(pad).toEqual(['pb-1'])
    const BODY = 4
    const row = rule('.zen-v2-control-row')
    const rowPad = /\n\s*padding: (\d+)px 16px;/.exec(row)
    expect(rowPad, 'the control row pads 4 above and below').not.toBeNull()
    const ROW = Number(rowPad![1])
    expect(ROW).toBe(4)
    for (const [inset, edge] of HOSTS) {
      expect(ROW + BODY + SHEET_EDGE_PAD + inset).toBe(edge)
    }
  })

  it("a sheet whose body ends on a row stands the body's 8 on the chassis's 8: 16 + inset to the row's box, one gutter and nothing nesting a second", () => {
    // §9.25 gives every sheet one 16 gutter; a menu is a sheet of rows, and §6's 4 px margins
    // are between groups, not at the sheet's edge – so the body under the last row brings 8
    // (`pb-2`), where a `pb-1` stood the row's box 12 + inset off the edge. The rows bring no
    // margin of their own: `.zen-sheet-item` and `.zen-v2-row` pad inside their box.
    const components = resolve(__dirname, '..')
    const BODIES: Array<[file: string, body: RegExp]> = [
      ['menus/MenuSheet.tsx', /'(flex flex-col pb-\d)',\n\s*nav\.direction > 0/],
      ['menus/LocalMenu.tsx', /<div className="(zen-v2 flex flex-col pb-\d)">/],
      [
        'extensions/V2Menulist.tsx',
        /<div className="(zen-v2 flex flex-col pb-\d)" role="radiogroup"/
      ],
      [
        'translate/Menulist.tsx',
        /<div ref=\{rows\} className="(zen-v2 flex flex-col pb-\d)" role="radiogroup"/
      ],
      ['phone/OverviewSheet.tsx', /<ul className="(flex flex-col pb-\d)">/],
      ['phone/ExtensionsSheet.tsx', /<div className="(zen-ext-action-menu flex flex-col pb-\d)">/],
      ['phone/BarEditorSheet.tsx', /className="(relative flex flex-col pb-\d pt-1)"/],
      ['reader/ReaderPreferencesPanel.tsx', /<div data-reader-prefs-panel="" className="(pb-\d)">/]
    ]
    const BODY = 8
    for (const [file, body] of BODIES) {
      const source = readFileSync(resolve(components, file), 'utf8')
      const found = body.exec(source)
      expect(found, `${file}: the sheet's body`).not.toBeNull()
      const pad = found![1].split(/\s+/).filter((c) => /^pb-/.test(c))
      expect(pad, `${file}: the body under its last row`).toEqual(['pb-2'])
      for (const [inset, edge] of HOSTS) {
        expect(BODY + SHEET_EDGE_PAD + inset).toBe(edge)
      }
    }
    for (const row of ['.zen-sheet-item', '.zen-v2-row']) {
      expect(rule(row), `${row} brings no margin to the edge`).not.toMatch(/\n\s*margin/)
    }
    // A body that ends on its own `.zen-sheet-footer` (the external-protocol sheet's two peers
    // inline) brings nothing: the footer's 8 stands on the chassis's 8 as the chassis's own does.
    const protocol = readFileSync(resolve(components, 'protocol/ExternalProtocolSheet.tsx'), 'utf8')
    const phoneBody = /className=\{phone \? '([^']*)' : '[^']*'\}/.exec(protocol)
    expect(phoneBody, "the external-protocol sheet's phone body").not.toBeNull()
    expect(phoneBody![1].split(/\s+/).filter((c) => /^pb-/.test(c))).toEqual([])
    expect(protocol).toMatch(/className="zen-sheet-footer"/)
    const footer = rule('.zen-sheet-footer')
    const bottom = Number(/\n\s*padding: \d+px \d+px (\d+)px;/.exec(footer)![1])
    for (const [inset, edge] of HOSTS) {
      expect(bottom + SHEET_EDGE_PAD + inset).toBe(edge)
    }
  })
})
