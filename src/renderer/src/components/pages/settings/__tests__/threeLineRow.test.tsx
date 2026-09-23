// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ValueRow } from '../model'
import { RowView } from '../rows'

/*
 * The three-line row's trailing control (§9.18): a label whose description wraps to a second
 * line makes three text lines, and the control leaves the row's centre for the label's line.
 * The row measures its text block (`lineCount.ts`: `data-lines="3"`, `--zen-settings-label-top`)
 * and the stylesheet seats the trailing box on the label's line box. That box has to *be* the
 * line box: as a minimum of it, a 32 px menulist, button or field grew the box to itself and
 * sat with its top on the label's top – its centre 6 low of the label's (a 28 icon button 4),
 * measured on the desktop's Privacy pane (Tracking level, Cookies' default, HTTPS-Only mode).
 * With the box the line's height and the trailing flex centring its content, the taller
 * control overhangs the line evenly – (line − control) / 2 without stating either.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null

function render(element: ReactElement): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(element))
  return host
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  vi.restoreAllMocks()
})

const ctx = { open: () => undefined }

/** main.css without its comments, one space for every run of whitespace. */
function stylesheet(): string {
  return readFileSync(resolve(__dirname, '../../../../assets/main.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
}

/** The declarations of the first rule whose selector list is exactly `selectors`. */
function declarations(css: string, selectors: string[]): string {
  const list = selectors.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(',\\s*')
  const m = css.match(new RegExp(`(?:^|[}\\s])${list}\\s*\\{([^}]*)\\}`))
  if (!m) throw new Error(`no rule for ${selectors.join(', ')}`)
  return m[1].trim()
}

/** A desktop value row – a menulist trailing a label and a description that will wrap. */
const level: ValueRow = {
  kind: 'value',
  id: 'tracking-level',
  label: 'Tracking protection',
  description:
    'Standard blocks known trackers and cryptominers on every site; Strict blocks more and may break some sites.',
  value: 'standard',
  options: [
    { value: 'standard', label: 'Standard' },
    { value: 'strict', label: 'Strict' }
  ],
  onChange: () => undefined
}

/** A DOMRect of `height` starting `top` down; happy-dom lays nothing out, so the row is told. */
function rect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    width: 600,
    height,
    right: 600,
    bottom: top + height,
    toJSON: () => ({})
  } as DOMRect
}

describe('a three-line row seats its trailing control on the label line (§9.18)', () => {
  it('marks itself data-lines="3" with the label line’s offset once its text block runs past two lines, the control the row’s own trailing child', () => {
    // The text block three lines tall (60 at the 20 line), the label its first line.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      if (this.classList.contains('zen-settings-row-text')) return rect(100, 60)
      if (this.classList.contains('zen-settings-label')) return rect(100, 20)
      return rect(0, 0)
    })
    const h = render(<RowView row={level} ctx={ctx} variant="desktop" />)
    const row = h.querySelector<HTMLElement>('[data-row="tracking-level"]')!
    expect(row.getAttribute('data-lines')).toBe('3')
    expect(row.style.getPropertyValue('--zen-settings-label-top')).toBe('0.00px')
    // The shape the stylesheet keys on: the trailing box is the row's direct child and holds
    // the control, so `[data-lines='3'] > .zen-settings-trailing` reaches it.
    const trailing = row.querySelector<HTMLElement>(':scope > .zen-settings-trailing')
    expect(trailing).not.toBeNull()
    expect(trailing!.querySelector('.zen-v2-menulist')).not.toBeNull()
  })

  it('a two-line row carries no line count: the control centres on the row', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      if (this.classList.contains('zen-settings-row-text')) return rect(100, 40)
      if (this.classList.contains('zen-settings-label')) return rect(100, 20)
      return rect(0, 0)
    })
    const h = render(<RowView row={level} ctx={ctx} variant="desktop" />)
    const row = h.querySelector<HTMLElement>('[data-row="tracking-level"]')!
    expect(row.hasAttribute('data-lines')).toBe(false)
    expect(row.style.getPropertyValue('--zen-settings-label-top')).toBe('')
  })

  it('the stylesheet makes the trailing box the label’s line box – its height, not a minimum – with the control centred in it', () => {
    const css = stylesheet()
    const seat = declarations(css, [".zen-settings-row[data-lines='3'] > .zen-settings-trailing"])
    // Off the row's centre, on the label's line, the line's height exactly: a `min-height`
    // here grew to the control and seated a 32 menulist 6 low.
    expect(seat).toBe(
      'align-self: flex-start; height: var(--v2-line-body-box); margin-top: var(--zen-settings-label-top, 0px);'
    )
    expect(seat).not.toContain('min-height')
    // The trailing flex centres its content, so a control taller than the box overhangs it
    // evenly – the (line − control) / 2 of §9.18.
    expect(declarations(css, ['.zen-settings-trailing'])).toContain('align-items: center')
    // The box is the label's line box: the body line at the text zoom, the label's own line.
    expect(css).toContain('--v2-line-body-box: calc(var(--v2-line-body) * var(--zen-text-zoom));')
    expect(declarations(css, ['.zen-v2-row'])).toContain('line-height: var(--v2-line-body)')
  })
})
