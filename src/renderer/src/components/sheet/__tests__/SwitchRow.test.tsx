// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SwitchRow } from '../SwitchRow'

/*
 * The switch row (design language v2 §10.4): on a phone a boolean is the whole row with a
 * trailing switch, `role="switch"` and `aria-checked`, never a leading checkbox; a reason for a
 * disabled row is its description (§9.2), not a trailing caption, and the row keeps
 * `aria-disabled` so the reason can still be reached and read while the press does nothing
 * (§9.30). Rendered for real.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement | null = null

function render(element: ReactElement): HTMLDivElement {
  host = document.createElement('div')
  document.body.append(host)
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

function row(container: HTMLElement): HTMLButtonElement {
  const found = container.querySelector('[role="switch"]')
  if (!(found instanceof HTMLButtonElement)) throw new Error('no switch row')
  return found
}

describe('SwitchRow (v2 §10.4)', () => {
  it('is one switch: the whole row, aria-checked, with its label and description as the row text', () => {
    const onChange = vi.fn()
    const container = render(
      createElement(SwitchRow, {
        label: 'Shortcuts',
        description: 'The sites you go to most',
        checked: true,
        onChange
      })
    )
    const button = row(container)
    expect(button.getAttribute('aria-checked')).toBe('true')
    expect(button.hasAttribute('aria-disabled')).toBe(false)
    expect(button.querySelector('.zen-v2-row-text .zen-v2-label')?.textContent).toBe('Shortcuts')
    expect(button.querySelector('.zen-v2-row-text .zen-v2-description')?.textContent).toBe(
      'The sites you go to most'
    )
    expect(button.querySelector('.zen-v2-switch')?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(0)

    act(() => button.click())
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('has no description line when none is given', () => {
    const container = render(
      createElement(SwitchRow, { label: 'Search field', checked: false, onChange: () => undefined })
    )
    const button = row(container)
    expect(button.getAttribute('aria-checked')).toBe('false')
    expect(button.querySelector('.zen-v2-description')).toBeNull()
  })

  it('disabled: stays in the tree with its reason as the description, aria-disabled, and takes no press (§9.30)', () => {
    const onChange = vi.fn()
    const container = render(
      createElement(SwitchRow, {
        label: 'Feed',
        description: 'Not available',
        checked: false,
        disabled: true,
        onChange
      })
    )
    const button = row(container)
    expect(button.getAttribute('aria-disabled')).toBe('true')
    // Not the `disabled` attribute: the row stays focusable so the reason is read.
    expect(button.disabled).toBe(false)
    expect(button.querySelector('.zen-v2-row-text .zen-v2-description')?.textContent).toBe(
      'Not available'
    )

    act(() => button.click())
    expect(onChange).not.toHaveBeenCalled()
  })
})
