// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { FieldRow, ValueRow } from '../model'
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

/*
 * The one trailing content taller than its control: an inline field with the message of a
 * refused commit (`InlineField` draws the field and its `role="alert"` line in one column).
 * Centred as a pair in the line's box, the 32 field and its two-line message put the field's
 * top 24 over the row above and the message beside the description – the independent pass on
 * #391 measured it on the desktop's Privacy pane (the API key row, `not a valid key!!`). The
 * field alone is seated on the label's line and the message follows under it (§9.12). happy-dom
 * lays nothing out, so the seat is pinned as the rule – matched against the row the refusal
 * produces, its `var()`s resolved from the sheet's tokens – and its arithmetic; the real-layout
 * measure is the still with the PR.
 */
describe('a three-line field row whose commit is refused keeps the field on the label line, the message under it (§9.12, §9.18)', () => {
  const SEAT =
    ".zen-settings-row[data-lines='3'] > .zen-settings-trailing > .zen-settings-inline-field:has(.zen-settings-inline-error)"

  /** The desktop's API key row: a field whose description wraps, and a commit it refuses. */
  const apiKey: FieldRow = {
    kind: 'field',
    id: 'safe-browsing-api-key',
    label: 'Google Safe Browsing API key',
    description:
      'Optional. With a key, every page you open is also looked up in Google Safe Browsing (v5, hash prefixes only).',
    value: '',
    input: 'text',
    secret: true,
    onCommit: (value) => (value.startsWith('AIza') ? undefined : 'Keys start with AIza.')
  }

  function threeLines(): void {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      if (this.classList.contains('zen-settings-row-text')) return rect(100, 60)
      if (this.classList.contains('zen-settings-label')) return rect(100, 20)
      return rect(0, 0)
    })
  }

  /** Type `value` into the row's field and press Enter. */
  function commit(row: HTMLElement, value: string): void {
    const input = row.querySelector<HTMLInputElement>('input')!
    act(() => {
      input.focus()
      // React's tracked value must differ from what the change reports.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
  }

  it('the refusal puts the message under the field in the trailing column, and only then does the seat’s selector reach the column', () => {
    threeLines()
    const h = render(<RowView row={apiKey} ctx={ctx} variant="desktop" />)
    const row = h.querySelector<HTMLElement>('[data-row="safe-browsing-api-key"]')!
    expect(row.getAttribute('data-lines')).toBe('3')
    const field = row.querySelector<HTMLElement>(
      ':scope > .zen-settings-trailing > .zen-settings-inline-field'
    )!
    expect(field).not.toBeNull()
    // Idle: no message, and the rule does not apply – the field centres in the box as any control.
    expect(field.querySelector('.zen-settings-inline-error')).toBeNull()
    expect(h.querySelector(SEAT)).toBeNull()

    commit(row, 'not a valid key!!')
    const message = field.querySelector<HTMLElement>('.zen-settings-inline-error')!
    expect(message.getAttribute('role')).toBe('alert')
    expect(message.textContent).toBe('Keys start with AIza.')
    // The column's order is field, then message: the message is below the field.
    expect(field.children[0]).toBe(field.querySelector('input'))
    expect(field.children[1]).toBe(message)
    expect(h.querySelector(SEAT)).toBe(field)
  })

  it('the stylesheet seats the column by the field alone: its top at the field’s overhang above the line, the message following', () => {
    const css = stylesheet()
    const seat = declarations(css, [SEAT])
    expect(seat).toBe(
      'align-self: flex-start; margin-top: calc((var(--v2-line-body-box) - var(--v2-control)) / 2);'
    )
    // The column stacks the field over the message, so the message can only follow the field.
    const column = declarations(css, ['.zen-settings-inline-field'])
    expect(column).toContain('flex-direction: column')
    expect(column).toContain('gap: 4px')
    // The arithmetic at the desktop's tokens (20 line, 32 control): the column starts 6 above
    // the line's box, the field's centre lands on the line's – the seat every 32 control takes
    // there – and the message starts 4 under the field's 32, past the box, not beside the text.
    expect(css).toContain('--v2-line-body: 20px;')
    expect(css).toContain('--v2-control: 32px;')
    const line = 20
    const control = 32
    const top = (line - control) / 2
    expect(top).toBe(-6)
    expect(top + control / 2).toBe(line / 2)
    expect(top + control + 4).toBeGreaterThan(line)
  })

  it('happy-dom applies the rule to the refused row, and to no field without a message', () => {
    threeLines()
    const sheet = document.createElement('style')
    sheet.textContent =
      ':root { --zen-text-zoom: 1; --v2-line-body: 20px; --v2-line-body-box: calc(var(--v2-line-body) * var(--zen-text-zoom)); --v2-control: 32px; }\n' +
      `${SEAT} { ${declarations(stylesheet(), [SEAT])} }`
    document.head.appendChild(sheet)
    try {
      const h = render(<RowView row={apiKey} ctx={ctx} variant="desktop" />)
      const row = h.querySelector<HTMLElement>('[data-row="safe-browsing-api-key"]')!
      const field = row.querySelector<HTMLElement>('.zen-settings-inline-field')!
      expect(getComputedStyle(field).alignSelf).toBe('')
      expect(getComputedStyle(field).marginTop).toBe('')
      commit(row, 'not a valid key!!')
      expect(getComputedStyle(field).alignSelf).toBe('flex-start')
      // `var()`s resolved from the tokens; `calc()` is left for the layout engine.
      expect(getComputedStyle(field).marginTop).toBe('calc((calc(20px * 1) - 32px) / 2)')
      // An accepted commit takes the message, and the seat, away again.
      commit(row, 'AIzaSyExample')
      expect(field.querySelector('.zen-settings-inline-error')).toBeNull()
      expect(getComputedStyle(field).alignSelf).toBe('')
    } finally {
      sheet.remove()
    }
  })
})
