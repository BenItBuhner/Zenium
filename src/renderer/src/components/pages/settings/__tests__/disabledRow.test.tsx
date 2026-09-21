// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ActionRow, ValueRow } from '../model'
import { RowView } from '../rows'

/*
 * A dependent row whose parent is off is drawn at §9.30's one number, .4, and takes no press
 * (§10.4). The desktop's control rows render a control that also carries `disabled` – the .4
 * that gives it, on top of the row's, compounded to .16: Settings › Downloads' Use default
 * button in #297's first capture read at .16 in light and could not be found in dark (the
 * independent review's Required 1). The wrapper's rule gives the nested control its 1 back – the
 * control keeps `disabled` for what it does – so every disabled action, value and shortcut row
 * dims once, the way the check-row primitive's `.zen-v2-checkbox:disabled { opacity: 1 }` and
 * the translate pane's rules already do for theirs.
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

describe('a disabled settings row dims once (§9.30)', () => {
  it('a disabled desktop action row carries the row class and its button `disabled` – the behaviour – and the row is still the static control row', () => {
    const useDefault: ActionRow = {
      kind: 'action',
      id: 'download-directory-default',
      label: 'Use the default folder',
      button: 'Use default',
      disabled: true,
      onPress: () => undefined
    }
    const el = render(<RowView row={useDefault} ctx={ctx} variant="desktop" />)
    const row = el.querySelector<HTMLElement>('[data-row="download-directory-default"]')!
    expect(row.classList.contains('zen-settings-row-disabled')).toBe(true)
    expect(row.classList.contains('zen-settings-control-row')).toBe(true)
    expect(row.hasAttribute('data-static')).toBe(true)
    const button = row.querySelector<HTMLButtonElement>('button.zen-v2-button')!
    expect(button.textContent).toBe('Use default')
    expect(button.disabled).toBe(true)
    // The same shape for a disabled menulist row.
    const value: ValueRow = {
      kind: 'value',
      id: 'a-menulist',
      label: 'A choice',
      value: 'a',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' }
      ],
      disabled: true,
      onChange: () => undefined
    }
    act(() => root?.render(<RowView row={value} ctx={ctx} variant="desktop" />))
    const menuRow = el.querySelector<HTMLElement>('[data-row="a-menulist"]')!
    expect(menuRow.classList.contains('zen-settings-row-disabled')).toBe(true)
    expect(menuRow.querySelector<HTMLButtonElement>('.zen-v2-menulist')?.disabled).toBe(true)
  })

  it('the stylesheet puts the .4 on the row and gives a disabled control inside it its 1 back, so the two never compound to .16', () => {
    const css = stylesheet()
    expect(declarations(css, ['.zen-settings-row-disabled'])).toBe('opacity: 0.4;')
    // The primitives' own disabled number, which the row's rule must undo underneath it.
    expect(declarations(css, ['.zen-v2-button:disabled'])).toBe('opacity: 0.4;')
    expect(declarations(css, ['.zen-v2-menulist:disabled'])).toBe('opacity: 0.4;')
    expect(
      declarations(css, [
        '.zen-settings-row-disabled .zen-v2-button:disabled',
        '.zen-settings-row-disabled .zen-v2-icon-button:disabled',
        '.zen-settings-row-disabled .zen-v2-menulist:disabled',
        '.zen-settings-row-disabled .zen-v2-field:disabled',
        '.zen-settings-row-disabled .zen-v2-switch:disabled'
      ])
    ).toBe('opacity: 1;')
    // The desktop's check row is not a `.zen-settings-row-disabled` row: its primitive carries
    // the same shape itself (the row's children at .4, the checkbox's own .4 undone).
    expect(declarations(css, ['.zen-v2-check-row:has(.zen-v2-checkbox:disabled) > *'])).toBe(
      'opacity: 0.4;'
    )
    expect(declarations(css, ['.zen-v2-check-row .zen-v2-checkbox:disabled'])).toBe('opacity: 1;')
  })
})
