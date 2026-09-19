// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/*
 * The extension surfaces' rows against §9.34's two forms of the shared row: a row that is not a
 * target (a permission warning, a Source value, an "It can:" line) is `.zen-v2-row` with
 * `data-static` and no role, so main.css's gates give it no hover fill, no press fill and no
 * pointer cursor; a row that toggles or picks stays the plain primitive, whose fill says it is a
 * target. Rendered for real, no styling asserted here – the fill and cursor gates are pinned in
 * `lib/__tests__/v2Tokens.test.ts`; the Xvfb probe measures the paint.
 */
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { V2CheckRow, V2Row } = await import('../v2')
const { WarningRow } = await import('../WarningRow')

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

const rows = (h: HTMLElement): HTMLElement[] => [...h.querySelectorAll<HTMLElement>('.zen-v2-row')]

/** Static (§9.34): the shared row for geometry, `data-static`, no role, not focusable itself. */
function expectStatic(row: HTMLElement): void {
  expect(row.tagName).toBe('DIV')
  expect(row.hasAttribute('data-static')).toBe(true)
  expect(row.hasAttribute('role')).toBe(false)
  expect(row.hasAttribute('tabindex')).toBe(false)
  expect(row.onclick).toBeNull()
}

describe('static rows (§9.34)', () => {
  it('V2Row is the static form of the row: data-static, no role, no tab stop', () => {
    const h = render(
      createElement(
        V2Row,
        { label: 'Version' },
        createElement('span', { className: 'zen-v2-value' }, '4.9.132')
      )
    )
    const [row] = rows(h)
    expectStatic(row)
    expect(h.querySelectorAll('.zen-v2-row').length).toBe(1)
    expect(h.querySelector('.zen-v2-label')?.textContent).toBe('Version')
    expect(h.querySelector('.zen-v2-value')?.textContent).toBe('4.9.132')
  })

  it('a link inside a static row is the target, not the row: the only focusable thing in it', () => {
    const h = render(
      createElement(
        V2Row,
        { label: 'Source' },
        createElement(
          'a',
          { className: 'zen-v2-link', href: 'https://example.test/' },
          'Chrome Web Store'
        )
      )
    )
    const [row] = rows(h)
    expectStatic(row)
    const focusable = [...row.querySelectorAll<HTMLElement>('a[href], button, input, [tabindex]')]
    expect(focusable.map((el) => el.tagName)).toEqual(['A'])
  })

  it('a permission warning row (details and the "It can:" list of the dialogs) is static', () => {
    const h = render(
      createElement(WarningRow, { warning: 'Read and change all your data on all websites' })
    )
    const [row] = rows(h)
    expectStatic(row)
    expect(row.querySelector('.zen-v2-row-lead')).not.toBeNull()
    expect(row.querySelector('.zen-v2-label')?.textContent).toBe(
      'Read and change all your data on all websites'
    )
  })

  it('a two-line static row keeps data-lines for its description', () => {
    const h = render(createElement(V2Row, { label: 'Updated', description: 'from the store' }))
    const [row] = rows(h)
    expectStatic(row)
    expect(row.getAttribute('data-lines')).toBe('2')
  })

  it('a check row is a target and is not static: the label toggles its box', () => {
    const h = render(
      createElement(V2CheckRow, {
        label: 'Allow access to file URLs',
        checked: false,
        onChange: () => undefined
      })
    )
    const [row] = rows(h)
    expect(row.tagName).toBe('LABEL')
    expect(row.hasAttribute('data-static')).toBe(false)
    expect(row.querySelector('input[type="checkbox"]')).not.toBeNull()
  })

  it('a disabled check row says aria-disabled (the fill gate) and still is not static', () => {
    const h = render(
      createElement(V2CheckRow, {
        label: 'Allow in private windows',
        checked: false,
        disabled: true,
        onChange: () => undefined
      })
    )
    const [row] = rows(h)
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(row.hasAttribute('data-static')).toBe(false)
  })
})
