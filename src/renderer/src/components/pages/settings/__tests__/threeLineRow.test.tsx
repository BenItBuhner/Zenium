// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { FieldRow, ItemRow, RowGroup, SwitchRow, ValueRow } from '../model'
import { GroupList, RowView } from '../rows'

/*
 * The three-line row's trailing control (§9.18, the lead's #391 ruling 4): a label whose
 * description wraps to a second line makes three text lines, and the control leaves the row's
 * centre to sit with the label. The row measures its text block (`lineCount.ts`: `data-lines="3"`,
 * `--zen-settings-label-top`) and the stylesheet seats the trailing box where the label starts,
 * the label's box tall. A control never leaves its row's box: one that fits the line (the phone's
 * 20 switch) centres on the line and grows nothing – the row stays 84; one taller than the line
 * (the desktop's 32 menulist, button or field, an item row's 28 ⋯) keeps §9.21's 4 above, the
 * label's line box grows to the control's box with the label centred in it, and the description
 * follows the control's box – 4 + 32 + 20 + 20 + 4 = 80, the next row's control 8 below. Which
 * box a row's control is, the row says by its class (`.zen-settings-control-row`, `.zen-settings-
 * menu-row` → `--zen-settings-control-box`); the seat reads it or falls back to the line.
 *
 * happy-dom lays nothing out, so the geometry here is pinned three ways and not measured: the
 * rules' declarations as written; the rules as happy-dom applies them to the rows the builder
 * renders (an injected sheet of the tokens and the very declarations from main.css, read back
 * through `getComputedStyle`, its `var()`s resolved and its `calc()` left textual); and the
 * arithmetic at the tokens. The real-layout measure is the preview host's still with the PR.
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

/** The seat's selectors, as main.css has them. */
const ROW = ".zen-settings-row[data-lines='3']"
const TRAILING = `${ROW} > .zen-settings-trailing`
const LABEL = `${ROW} > .zen-settings-row-text > .zen-settings-label`
const REFUSED = `${TRAILING} > .zen-settings-inline-field:has(.zen-settings-inline-error)`

/** The tokens the seat reads, at the desktop's values (§10.5) or the phone's (§10.4). */
const TOKENS = {
  desktop:
    '--zen-text-zoom: 1; --v2-line-body: 20px; --v2-line-body-box: calc(var(--v2-line-body) * var(--zen-text-zoom)); --v2-control: 32px; --v2-icon-button: 28px;',
  phone:
    '--zen-text-zoom: 1; --v2-line-body: 20px; --v2-line-body-box: calc(var(--v2-line-body) * var(--zen-text-zoom)); --v2-control: 40px; --v2-icon-button: 44px;'
}

/**
 * A sheet of the tokens and main.css's own seat rules, so happy-dom applies to the rendered row
 * what the product's stylesheet would; removed by the caller.
 */
function seatSheet(family: keyof typeof TOKENS): HTMLStyleElement {
  const css = stylesheet()
  const sheet = document.createElement('style')
  sheet.textContent = [
    `:root { ${TOKENS[family]} }`,
    `.zen-settings-control-row { ${declarations(css, ['.zen-settings-control-row'])} }`,
    `.zen-settings-menu-row { ${declarations(css, ['.zen-settings-menu-row'])} }`,
    `${ROW} { ${declarations(css, [ROW])} }`,
    `${TRAILING} { ${declarations(css, [TRAILING])} }`,
    `${LABEL} { ${declarations(css, [LABEL])} }`,
    `${REFUSED} { ${declarations(css, [REFUSED])} }`
  ].join('\n')
  document.head.appendChild(sheet)
  return sheet
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

/** A one-line desktop value row: the row above `level` in a group. */
const scheme: ValueRow = {
  kind: 'value',
  id: 'colour-scheme',
  label: 'Colour scheme',
  value: 'system',
  options: [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' }
  ],
  onChange: () => undefined
}

/** A phone switch row whose description wraps (Search's suggestion rows). */
const suggest: SwitchRow = {
  kind: 'switch',
  id: 'search-suggestions',
  label: 'Search suggestions',
  description:
    'What you type in the address bar is sent to your search engine as you type, so it can suggest searches.',
  checked: true,
  onChange: () => undefined
}

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

/** An item row with a ⋯ on the desktop and a description that wraps. */
const language: ItemRow = {
  kind: 'item',
  id: 'languages-preferred:en',
  label: 'English',
  description:
    'Pages offered in more than one language are shown in this one first, then in the languages under it.',
  menu: 'Options for English',
  sheet: {
    title: 'English',
    groups: [
      {
        id: 'actions',
        heading: null,
        rows: [{ kind: 'action', id: 'remove', label: 'Remove', onPress: () => undefined }]
      }
    ]
  }
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

/**
 * Every row's text block laid out `lines` lines tall – one count for all, or a count per
 * `data-row` (one line for a row not named) – its label `labelHeight` (the line, or its box).
 */
function laidOut(lines: number | Record<string, number>, labelHeight = 20): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('zen-settings-row-text')) {
      const count =
        typeof lines === 'number'
          ? lines
          : (lines[this.closest('[data-row]')?.getAttribute('data-row') ?? ''] ?? 1)
      return rect(100, count * 20)
    }
    if (this.classList.contains('zen-settings-label')) return rect(100, labelHeight)
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

const style = (el: Element): CSSStyleDeclaration => getComputedStyle(el)
const property = (el: Element, name: string): string => style(el).getPropertyValue(name).trim()

describe('a three-line row seats its trailing control with the label (§9.18)', () => {
  it('marks itself data-lines="3" with the label’s offset once its text block runs past two lines, the control the row’s own trailing child', () => {
    // The text block three lines tall (60 at the 20 line), the label its first line.
    laidOut(3)
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
    laidOut(2)
    const h = render(<RowView row={level} ctx={ctx} variant="desktop" />)
    const row = h.querySelector<HTMLElement>('[data-row="tracking-level"]')!
    expect(row.hasAttribute('data-lines')).toBe(false)
    expect(row.style.getPropertyValue('--zen-settings-label-top')).toBe('')
  })

  it('measured again with its seat on, the row counts its lines without the seat’s padding, so the count cannot stick', () => {
    // The label seated on a 32 control carries 6 of padding above and below (the rule below):
    // its box is 32 and a three-line block measures 72; a block whose description went back
    // to one line measures 52 – past 2.5 lines of 20 if the padding counted as text, which
    // would keep a seat that grew for lines no longer there.
    vi.spyOn(globalThis, 'getComputedStyle').mockImplementation(
      (el: Element) =>
        ({
          lineHeight: '20px',
          paddingTop: el.classList.contains('zen-settings-label') ? '6px' : '0px',
          paddingBottom: el.classList.contains('zen-settings-label') ? '6px' : '0px'
        }) as CSSStyleDeclaration
    )
    laidOut(3.6, 32)
    const three = render(<RowView row={level} ctx={ctx} variant="desktop" />)
    expect(three.querySelector('[data-row="tracking-level"]')!.getAttribute('data-lines')).toBe('3')
    act(() => root?.unmount())
    laidOut(2.6, 32)
    const two = render(<RowView row={level} ctx={ctx} variant="desktop" />)
    expect(two.querySelector('[data-row="tracking-level"]')!.hasAttribute('data-lines')).toBe(false)
  })

  it('the stylesheet: the trailing box is the label’s box – the line, or the control’s box a row names – and the label grows to it', () => {
    const css = stylesheet()
    // The box: the control's where the row names one, the line otherwise.
    expect(declarations(css, [ROW])).toBe(
      '--zen-settings-label-box: var(--zen-settings-control-box, var(--v2-line-body-box));'
    )
    // Off the row's centre, at the label, the box's height exactly: neither a minimum (which
    // grew to the control and seated it 6 low) nor the line alone (which let a 32 control
    // overhang the row by 2).
    const seat = declarations(css, [TRAILING])
    expect(seat).toBe(
      'align-self: flex-start; height: var(--zen-settings-label-box); margin-top: var(--zen-settings-label-top, 0px);'
    )
    expect(seat).not.toContain('min-height')
    // The label's line box grown to the control's box with its line centred: (box − line) / 2
    // above and below – nothing when the box is the line.
    expect(declarations(css, [LABEL])).toBe(
      'padding-block: calc((var(--zen-settings-label-box) - var(--v2-line-body-box)) / 2);'
    )
    // The trailing flex centres its content in the box.
    expect(declarations(css, ['.zen-settings-trailing'])).toContain('align-items: center')
    // The rows that name their control's box, in the tokens the controls are drawn at.
    const controlRow = declarations(css, ['.zen-settings-control-row'])
    expect(controlRow).toContain('--zen-settings-control-box: var(--v2-control);')
    expect(controlRow).toContain('padding-top: 4px; padding-bottom: 4px;')
    expect(declarations(css, ['.zen-settings-menu-row'])).toBe(
      '--zen-settings-control-box: var(--v2-icon-button);'
    )
    expect(declarations(css, ['.zen-v2-menulist'])).toContain('height: var(--v2-control);')
    expect(declarations(css, ['.zen-v2-field'])).toContain('height: var(--v2-control);')
    expect(declarations(css, ['.zen-v2-icon-button'])).toContain('height: var(--v2-icon-button);')
    expect(declarations(css, ['.zen-v2-switch'])).toContain('height: 20px;')
    // The tokens: the body line at the text zoom; 32 and 28 on a mouse, the phone's 40 and 44.
    expect(css).toContain('--v2-line-body: 20px;')
    expect(css).toContain('--v2-line-body-box: calc(var(--v2-line-body) * var(--zen-text-zoom));')
    expect(css).toContain('--v2-control: 32px;')
    expect(css).toContain('--v2-icon-button: 28px;')
    const phone = declarations(css, [":root[data-form-factor='phone']"])
    expect(phone).toContain('--v2-row: calc(var(--v2-line-body-box) + 24px);')
    expect(phone).toContain('--v2-control: 40px;')
    expect(declarations(css, ['.zen-v2-row'])).toContain('line-height: var(--v2-line-body)')
  })

  it('an item row’s ⋯ names its 28 box', () => {
    laidOut(3)
    const h = render(<RowView row={language} ctx={ctx} variant="desktop" />)
    const row = h.querySelector<HTMLElement>('[data-row="languages-preferred:en"]')!
    expect(row.classList.contains('zen-settings-menu-row')).toBe(true)
    expect(row.classList.contains('zen-settings-control-row')).toBe(false)
    expect(row.getAttribute('data-lines')).toBe('3')
    expect(
      row.querySelector(':scope > .zen-settings-trailing > .zen-v2-icon-button')
    ).not.toBeNull()
    const sheet = seatSheet('desktop')
    try {
      expect(property(row, '--zen-settings-control-box')).toBe('28px')
      expect(style(row.querySelector(':scope > .zen-settings-trailing')!).height).toBe('28px')
    } finally {
      sheet.remove()
    }
  })
})

describe('a control never leaves its row’s box (the lead’s #391 ruling 4)', () => {
  it('(a) the phone’s 20 switch fits the label’s line: the box is the line, nothing grows, the row stays 84', () => {
    laidOut(3)
    const sheet = seatSheet('phone')
    try {
      const h = render(<RowView row={suggest} ctx={ctx} variant="phone" />)
      const row = h.querySelector<HTMLElement>('[data-row="search-suggestions"]')!
      expect(row.getAttribute('data-lines')).toBe('3')
      // A pressable row names no control box, so the seat falls back to the line.
      expect(row.classList.contains('zen-settings-control-row')).toBe(false)
      expect(property(row, '--zen-settings-control-box')).toBe('')
      expect(property(row, '--zen-settings-label-box')).toBe('calc(20px * 1)')
      const trailing = row.querySelector<HTMLElement>(':scope > .zen-settings-trailing')!
      expect(trailing.querySelector('.zen-v2-switch')).not.toBeNull()
      expect(style(trailing).height).toBe('calc(20px * 1)')
      expect(style(trailing).alignSelf).toBe('flex-start')
      // The label's offset in its block (`--zen-settings-label-top`, 0.00px here) resolved.
      expect(style(trailing).marginTop).toBe('0px')
      const label = row.querySelector<HTMLElement>('.zen-settings-label')!
      expect(property(label, 'padding-block')).toBe('calc((calc(20px * 1) - calc(20px * 1)) / 2)')
    } finally {
      sheet.remove()
    }
    // At the phone's tokens: the row pads (44 − 20) / 2 = 12, the label's box is the 20 line
    // with no padding, the 20 switch centres in it – offset 0 – and the description's two lines
    // follow the label's line: 12 + 20 + 20 + 20 + 12 = 84, as before this ruling.
    const pad = (44 - 20) / 2
    const line = 20
    const box = Math.max(line, 0)
    const labelPad = (box - line) / 2
    const switchHeight = 20
    expect(labelPad).toBe(0)
    expect(pad + (box - switchHeight) / 2 + switchHeight / 2 - (pad + line / 2)).toBe(0)
    expect(pad + box + 2 * line + pad).toBe(84)
  })

  it('(b) a desktop three-line menulist row: the menulist at the row’s 4, the label centred on its 32, the description after it, the row 80', () => {
    laidOut(3)
    const sheet = seatSheet('desktop')
    try {
      const h = render(<RowView row={level} ctx={ctx} variant="desktop" />)
      const row = h.querySelector<HTMLElement>('[data-row="tracking-level"]')!
      expect(row.classList.contains('zen-settings-control-row')).toBe(true)
      expect(property(row, '--zen-settings-control-box')).toBe('32px')
      expect(property(row, '--zen-settings-label-box')).toBe('32px')
      expect(style(row).paddingTop).toBe('4px')
      expect(style(row).paddingBottom).toBe('4px')
      const trailing = row.querySelector<HTMLElement>(':scope > .zen-settings-trailing')!
      expect(style(trailing).height).toBe('32px')
      expect(style(trailing).alignSelf).toBe('flex-start')
      expect(style(trailing).marginTop).toBe('0px')
      const label = row.querySelector<HTMLElement>('.zen-settings-label')!
      expect(property(label, 'padding-block')).toBe('calc((32px - calc(20px * 1)) / 2)')
      // The label is the first thing in the text block and the description the next, so the
      // description can only start where the label's grown box ends.
      const text = row.querySelector<HTMLElement>('.zen-settings-row-text')!
      expect(text.children[0]).toBe(label)
      expect(text.children[1]!.classList.contains('zen-settings-description')).toBe(true)
    } finally {
      sheet.remove()
    }
    // At the desktop's tokens: the control row pads 4, the box is the 32 control, the label's
    // line takes 6 above and below and sits 10–30 – its centre the control's – and the
    // description's two lines start at the control's bottom: 4 + 32 + 20 + 20 + 4 = 80.
    const pad = 4
    const line = 20
    const control = 32
    const labelPad = (control - line) / 2
    const controlTop = pad
    const labelLineTop = pad + labelPad
    const descriptionTop = pad + control
    expect(labelPad).toBe(6)
    expect(controlTop).toBe(4)
    expect(controlTop).toBeGreaterThanOrEqual(0)
    expect(labelLineTop + line / 2).toBe(controlTop + control / 2)
    expect(descriptionTop).toBe(controlTop + control)
    expect(pad + control + 2 * line + pad).toBe(80)
  })

  it('(c) a field whose commit is refused sits on the control’s line, its message beneath, the row above uncovered', () => {
    laidOut(3)
    const sheet = seatSheet('desktop')
    try {
      const h = render(<RowView row={apiKey} ctx={ctx} variant="desktop" />)
      const row = h.querySelector<HTMLElement>('[data-row="safe-browsing-api-key"]')!
      expect(row.getAttribute('data-lines')).toBe('3')
      const field = row.querySelector<HTMLElement>(
        ':scope > .zen-settings-trailing > .zen-settings-inline-field'
      )!
      // Idle: no message; the column is not seated and centres in the box as the field alone.
      expect(field.querySelector('.zen-settings-inline-error')).toBeNull()
      expect(h.querySelector(REFUSED)).toBeNull()
      expect(style(field).alignSelf).toBe('')

      commit(row, 'not a valid key!!')
      const message = field.querySelector<HTMLElement>('.zen-settings-inline-error')!
      expect(message.getAttribute('role')).toBe('alert')
      expect(message.textContent).toBe('Keys start with AIza.')
      // The column's order is field, then message: the message is beneath the field.
      expect(field.children[0]).toBe(field.querySelector('input'))
      expect(field.children[1]).toBe(message)
      expect(h.querySelector(REFUSED)).toBe(field)
      // Seated: the column starts at the box's top, which is the field's own box on a control
      // row, so nothing offsets it – the rule is the alignment alone.
      expect(style(field).alignSelf).toBe('flex-start')
      expect(style(field).marginTop).toBe('')
      expect(declarations(stylesheet(), [REFUSED])).toBe('align-self: flex-start;')
      expect(style(row.querySelector(':scope > .zen-settings-trailing')!).height).toBe('32px')
      // An accepted commit takes the message, and the seat, away again.
      commit(row, 'AIzaSyExample')
      expect(field.querySelector('.zen-settings-inline-error')).toBeNull()
      expect(style(field).alignSelf).toBe('')
    } finally {
      sheet.remove()
    }
    // At the desktop's tokens: the field 4–36 (on the control's line, as (b)'s menulist), the
    // column's 4 gap, the message from 40 – under the field, not beside the description – and
    // its two lines end at 80, the row's own bottom. The field's top is the row's padding, so
    // no part of it is above the row's box: the row above is untouched, and its control, 4
    // above the rows' edge, is 8 from the field.
    const pad = 4
    const control = 32
    const gap = 4
    const fieldTop = pad
    const messageTop = fieldTop + control + gap
    expect(fieldTop).toBeGreaterThanOrEqual(0)
    expect(messageTop).toBeGreaterThan(fieldTop + control)
    expect(messageTop + 2 * 20).toBe(80)
    expect(fieldTop + pad).toBe(8)
    expect(declarations(stylesheet(), ['.zen-settings-inline-field'])).toContain('gap: 4px')
  })

  it('(d) two adjacent desktop control rows keep 8 between their controls', () => {
    // The colour-scheme row's text is its one label line; the tracking-level row's runs to three.
    laidOut({ 'tracking-level': 3 })
    const groups: RowGroup[] = [
      { id: 'privacy-protection', heading: 'Protection', rows: [scheme, level] }
    ]
    const sheet = seatSheet('desktop')
    try {
      const h = render(<GroupList groups={groups} ctx={ctx} variant="desktop" />)
      const first = h.querySelector<HTMLElement>('[data-row="colour-scheme"]')!
      const second = h.querySelector<HTMLElement>('[data-row="tracking-level"]')!
      // The rows are siblings in the group's column with nothing between them, and the group
      // stacks them with no gap: the rows touch.
      expect(first.nextElementSibling).toBe(second)
      expect(first.parentElement!.classList.contains('zen-settings-group')).toBe(true)
      expect(declarations(stylesheet(), ['.zen-settings-group'])).toBe(
        'display: flex; flex-direction: column;'
      )
      // Both are control rows: 4 of their own padding above and below the control.
      for (const row of [first, second]) {
        expect(row.classList.contains('zen-settings-control-row')).toBe(true)
        expect(style(row).paddingTop).toBe('4px')
        expect(style(row).paddingBottom).toBe('4px')
        expect(style(row).marginTop).toBe('')
        expect(style(row).marginBottom).toBe('')
      }
      // The first row is the one-line row; the second's control is seated at its own 4.
      expect(first.hasAttribute('data-lines')).toBe(false)
      expect(second.getAttribute('data-lines')).toBe('3')
      expect(style(second.querySelector(':scope > .zen-settings-trailing')!).marginTop).toBe('0px')
    } finally {
      sheet.remove()
    }
    // At the desktop's tokens: the one-line control row is 40 with its control 4–36; the row
    // under it starts at 40 and its control at 44 – 8 apart, the two paddings, whatever the
    // lower row's line count, since its control sits at its own 4. A control never leaves its
    // box, so no pairing brings two closer: a three-line row's control ends at 36 of its 80,
    // and the next control is 48 below it. The nearest two adjacent controls come is 8.
    const pad = 4
    const control = 32
    const oneLine = pad + control + pad
    const threeLine = pad + control + 20 + 20 + pad
    expect(oneLine).toBe(40)
    expect(threeLine).toBe(80)
    const afterOneLine = oneLine + pad - (pad + control)
    const afterThreeLine = threeLine + pad - (pad + control)
    expect(afterOneLine).toBe(8)
    expect(afterThreeLine).toBe(48)
    expect(Math.min(afterOneLine, afterThreeLine)).toBe(8)
  })
})
