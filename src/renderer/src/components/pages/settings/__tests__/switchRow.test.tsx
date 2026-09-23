// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Bookmark } from 'lucide-react'
import type { SwitchRow } from '../model'
import { RowView } from '../rows'

/*
 * The switch row's `leading` slot (W4-10, the desktop's Customize toolbar rows: the control's
 * own glyph beside the box): the glyph sits in the other kinds' `.zen-settings-leading` span –
 * on the label's line (§9.2), `aria-hidden` – before the label on the phone's `role="switch"`
 * row and between the box and the label on the desktop's check row (§10.5, "the control's 16
 * glyph after the box"), and the control's accessible name stays the label's, glyph or not.
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
})

const ctx = { open: () => undefined }

function rowOf(el: HTMLElement, id: string): HTMLElement {
  const row = el.querySelector<HTMLElement>(`[data-row="${id}"]`)
  if (!row) throw new Error(`no row ${id}`)
  return row
}

/** The children of `row` in document order, by class, for "the glyph comes before the label". */
function order(row: HTMLElement, ...selectors: string[]): number[] {
  const all = Array.from(row.querySelectorAll('*'))
  return selectors.map((selector) => {
    const node = row.querySelector(selector)
    if (!node) throw new Error(`no ${selector}`)
    return all.indexOf(node)
  })
}

const bookmarksBar: SwitchRow = {
  kind: 'switch',
  id: 'toolbar-bookmarks-bar',
  label: 'Show bookmarks bar',
  description: 'Under the address bar, on every tab.',
  leading: <Bookmark data-testid="glyph" aria-hidden="true" />,
  checked: true,
  onChange: () => undefined
}

describe('the switch row’s leading glyph', () => {
  it('phone: the glyph renders in the shared leading slot before the label, hidden from the switch’s name', () => {
    const el = render(<RowView row={bookmarksBar} ctx={ctx} />)
    const row = rowOf(el, 'toolbar-bookmarks-bar')
    expect(row.getAttribute('role')).toBe('switch')
    expect(row.getAttribute('aria-checked')).toBe('true')
    const slot = row.querySelector('.zen-settings-leading')
    expect(slot).not.toBeNull()
    expect(slot?.getAttribute('aria-hidden')).toBe('true')
    expect(slot?.querySelector('[data-testid="glyph"]')).not.toBeNull()
    // Before the label, then the label's text, then the trailing switch (§10.4).
    const [glyph, label, trailing] = order(
      row,
      '.zen-settings-leading',
      '.zen-settings-label',
      '.zen-settings-trailing'
    )
    expect(glyph).toBeLessThan(label)
    expect(label).toBeLessThan(trailing)
    // The row is named by its text alone: no aria-label, the glyph hidden.
    expect(row.hasAttribute('aria-label')).toBe(false)
    expect(row.querySelector('.zen-settings-label')?.textContent).toBe('Show bookmarks bar')
  })

  it('phone: a row without a glyph renders no slot, as before', () => {
    const { leading: _leading, ...plain } = bookmarksBar
    const el = render(<RowView row={plain} ctx={ctx} />)
    const row = rowOf(el, 'toolbar-bookmarks-bar')
    expect(row.querySelector('.zen-settings-leading')).toBeNull()
    expect(row.querySelector('.zen-settings-label')?.textContent).toBe('Show bookmarks bar')
  })

  it('desktop: the glyph sits between the box and the label in the same slot, and the checkbox is still named by the label', () => {
    const el = render(<RowView row={bookmarksBar} ctx={ctx} variant="desktop" />)
    const row = rowOf(el, 'toolbar-bookmarks-bar')
    expect(row.tagName).toBe('LABEL')
    const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(box?.checked).toBe(true)
    const slot = row.querySelector('.zen-settings-leading')
    expect(slot?.getAttribute('aria-hidden')).toBe('true')
    expect(slot?.querySelector('[data-testid="glyph"]')).not.toBeNull()
    const [checkbox, glyph, label] = order(
      row,
      'input[type="checkbox"]',
      '.zen-settings-leading',
      '.zen-settings-label'
    )
    expect(checkbox).toBeLessThan(glyph)
    expect(glyph).toBeLessThan(label)
    // The whole row is the checkbox's <label>: its name is the text, the hidden glyph adds none.
    expect(box?.closest('label')).toBe(row)
    expect(row.querySelector('.zen-settings-label')?.textContent).toBe('Show bookmarks bar')
    expect(row.querySelector('.zen-settings-description')?.textContent).toBe(
      'Under the address bar, on every tab.'
    )
  })

  it('desktop: a row without a glyph renders the box and the text alone', () => {
    const { leading: _leading, ...plain } = bookmarksBar
    const el = render(<RowView row={plain} ctx={ctx} variant="desktop" />)
    const row = rowOf(el, 'toolbar-bookmarks-bar')
    expect(row.querySelector('.zen-settings-leading')).toBeNull()
    expect(row.querySelector('input[type="checkbox"]')).not.toBeNull()
  })
})
