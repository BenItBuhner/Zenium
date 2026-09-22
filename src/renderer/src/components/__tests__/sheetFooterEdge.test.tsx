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
})
