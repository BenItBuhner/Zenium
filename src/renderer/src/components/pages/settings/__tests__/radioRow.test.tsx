// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ValueRow } from '../model'
import { RowView } from '../rows'

/*
 * The desktop's radio row (`ValueRow.form: 'radios'`, `RadioListRow`; §9.14 in a row, §10.4's
 * "2–4 radios on desktop"): the lead's Q7 ruling on #572 – Appearance › Home page's "New Tab
 * page" / "Enter custom web address" as the page's radios under the row's text, the menulist
 * gone. One `radiogroup` the label names, one `role="radio"` row per option, the checked one
 * `aria-checked`; a press on another option is the row's `onChange`, a press on the checked
 * one nothing; a held row (an extension's homepage) lists its options at the row's .4 with no
 * press. The phone keeps its value row and picker sheet whatever the form.
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

const ctx = { open: vi.fn() }

function homePage(onChange: (value: string) => void, patch: Partial<ValueRow> = {}): ValueRow {
  return {
    kind: 'value',
    id: 'home-page',
    label: 'Home page',
    value: 'newtab',
    form: 'radios',
    sheetDescription: 'Where the Home button goes.',
    options: [
      { value: 'newtab', label: 'New Tab page' },
      { value: 'url', label: 'Enter custom web address' }
    ],
    onChange,
    ...patch
  }
}

const rowOf = (el: HTMLElement): HTMLElement =>
  el.querySelector<HTMLElement>('[data-row="home-page"]')!
const radios = (el: HTMLElement): HTMLButtonElement[] =>
  Array.from(rowOf(el).querySelectorAll<HTMLButtonElement>('[role="radio"]'))

describe('the desktop radio row (ValueRow.form: "radios", §9.14 / §10.4)', () => {
  it('draws the row’s text and one radiogroup named by its label, an option row per choice with the current one checked – no menulist', () => {
    const el = render(<RowView row={homePage(() => undefined)} ctx={ctx} variant="desktop" />)
    const row = rowOf(el)
    expect(row.classList.contains('zen-settings-radios-row')).toBe(true)
    expect(row.classList.contains('zen-v2-row')).toBe(true)
    expect(row.hasAttribute('data-static')).toBe(true)
    expect(row.querySelector('.zen-settings-label')?.textContent).toBe('Home page')
    expect(row.querySelector('.zen-settings-description')?.textContent).toBe(
      'Where the Home button goes.'
    )
    expect(row.querySelector('.zen-v2-menulist, .zen-settings-menulist')).toBeNull()
    const group = row.querySelector<HTMLElement>('[role="radiogroup"]')!
    expect(group.classList.contains('zen-settings-radio-list')).toBe(true)
    const labelId = group.getAttribute('aria-labelledby')!
    expect(document.getElementById(labelId)?.textContent).toBe('Home page')
    const options = radios(el)
    expect(options.map((o) => o.textContent)).toEqual(['New Tab page', 'Enter custom web address'])
    expect(options.map((o) => o.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    for (const option of options) {
      expect(option.classList.contains('zen-settings-radio-row')).toBe(true)
      expect(option.querySelector('.zen-v2-radio')).not.toBeNull()
      expect(option.disabled).toBe(false)
    }
  })

  it('a press on another option is the row’s onChange with that value; a press on the checked one changes nothing', () => {
    const onChange = vi.fn()
    const el = render(<RowView row={homePage(onChange)} ctx={ctx} variant="desktop" />)
    const [newtab, url] = radios(el)
    act(() => newtab.click())
    expect(onChange).not.toHaveBeenCalled()
    act(() => url.click())
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('url')
    expect(ctx.open).not.toHaveBeenCalled()
  })

  it('held by an extension the row lists its options at the row’s .4 with no press, the checked one still marked, and the "Controlled by" row follows it', () => {
    const onChange = vi.fn()
    const el = render(
      <RowView
        row={homePage(onChange, {
          value: 'url',
          controlled: {
            extensionId: 'a'.repeat(32),
            name: 'Bing Homepage & Search',
            onDisable: () => undefined,
            onManage: () => undefined
          }
        })}
        ctx={ctx}
        variant="desktop"
      />
    )
    const row = rowOf(el)
    expect(row.classList.contains('zen-settings-row-disabled')).toBe(true)
    expect(row.querySelector('[role="radiogroup"]')?.getAttribute('aria-disabled')).toBe('true')
    const options = radios(el)
    expect(options.map((o) => o.getAttribute('aria-checked'))).toEqual(['false', 'true'])
    for (const option of options) {
      expect(option.disabled).toBe(true)
      expect(option.getAttribute('aria-disabled')).toBe('true')
    }
    act(() => options[0].click())
    expect(onChange).not.toHaveBeenCalled()
    expect(el.querySelector('[data-row="home-page-controlled"]')?.textContent).toContain(
      'Controlled by Bing Homepage & Search'
    )
  })

  it('the phone keeps its value row – the label with the value, opening the picker sheet – whatever the form', () => {
    const el = render(<RowView row={homePage(() => undefined)} ctx={ctx} variant="phone" />)
    expect(el.querySelector('[role="radiogroup"]')).toBeNull()
    const row = rowOf(el)
    expect(row.textContent).toContain('New Tab page')
    act(() => row.click())
    expect(ctx.open).toHaveBeenCalledWith({ kind: 'options', rowId: 'home-page' })
  })
})
