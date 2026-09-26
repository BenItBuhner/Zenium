// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { FieldRow } from '../model'
import { RowView } from '../rows'

/*
 * The desktop's inline field (`InlineField`, §9.12): Enter commits, blur commits, Escape puts
 * the row's value back and leaves the field – and leaves it clean. The W8-3 drive caught the
 * Address field (Settings › Appearance › Home page) keeping `aria-invalid` and its error line
 * after Escape: the key restored the value and cleared the error, then blurred the field, and
 * that blur's commit ran with the render's stale closure – the refused text – and raised the
 * error again; on an edit not yet committed, the same blur committed the text Escape had just
 * put away. Escape's own blur must not commit; a later, real blur still does.
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

/** Focus the field and type `value` (React's tracked value must differ from what the change reports). */
function type(input: HTMLInputElement, value: string): void {
  act(() => {
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function key(input: HTMLInputElement, name: string): void {
  act(() => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
    )
  })
}

function address(onCommit: FieldRow['onCommit']): FieldRow {
  return {
    kind: 'field',
    id: 'home-page-address',
    label: 'Address',
    value: 'https://news.example/',
    input: 'url',
    placeholder: 'example.com',
    onCommit
  }
}

const inputOf = (el: HTMLElement): HTMLInputElement =>
  el.querySelector<HTMLInputElement>('[data-row="home-page-address"] input')!
const errorOf = (el: HTMLElement): HTMLElement | null =>
  el.querySelector<HTMLElement>('[data-row="home-page-address"] .zen-settings-inline-error')

describe('the desktop inline field’s Escape (§9.12)', () => {
  it('after a refused commit, Escape restores the row’s value and takes the error and aria-invalid with it – its blur commits nothing', () => {
    const onCommit = vi.fn((value: string) =>
      value.startsWith('http') ? undefined : 'Enter a web address.'
    )
    const el = render(<RowView row={address(onCommit)} ctx={ctx} variant="desktop" />)
    const input = inputOf(el)
    expect(input.getAttribute('inputmode')).toBe('url')

    type(input, 'zenium://settings')
    key(input, 'Enter')
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenLastCalledWith('zenium://settings')
    expect(errorOf(el)?.textContent).toBe('Enter a web address.')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(errorOf(el)!.id)
    // Refused, the field keeps focus and the typed text for another try.
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('zenium://settings')

    key(input, 'Escape')
    expect(input.value).toBe('https://news.example/')
    expect(errorOf(el)).toBeNull()
    expect(input.hasAttribute('aria-invalid')).toBe(false)
    expect(input.hasAttribute('aria-describedby')).toBe(false)
    // The key left the field, and the blur it fired did not commit the text just put away.
    expect(document.activeElement).not.toBe(input)
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('Escape on an uncommitted edit puts the value back without committing; a real blur afterwards still commits', () => {
    const onCommit = vi.fn(() => undefined)
    const el = render(<RowView row={address(onCommit)} ctx={ctx} variant="desktop" />)
    const input = inputOf(el)

    type(input, 'example.com')
    key(input, 'Escape')
    expect(input.value).toBe('https://news.example/')
    expect(onCommit).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(input)

    // The flag Escape raised for its own blur is down again: leaving the field the ordinary
    // way commits, as before.
    type(input, 'https://other.example/')
    act(() => input.blur())
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenLastCalledWith('https://other.example/')
    expect(errorOf(el)).toBeNull()
  })
})
