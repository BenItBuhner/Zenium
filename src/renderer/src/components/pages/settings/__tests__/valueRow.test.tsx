// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ActionRow, SwitchRow, ValueRow } from '../model'
import { GroupList, RowView, type SheetRequest } from '../rows'

/*
 * The phone value row's accessible name (#237's audit, the four Look rows left with the owner):
 * TalkBack read "Colour scheme Light", the label and the value run together from the row's
 * contents. The row now names itself once, "label, value" – and with the search result's
 * caption first where it shows one, as its contents read – while the label and the value stay
 * on screen as they were. The other pressable rows keep their names from their contents.
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

const scheme: ValueRow = {
  kind: 'value',
  id: 'look:scheme',
  label: 'Colour scheme',
  value: 'light',
  options: [
    { value: 'system', label: 'Follow system' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' }
  ],
  onChange: () => undefined
}

const layout: ValueRow = {
  kind: 'value',
  id: 'look:layout',
  label: 'Toolbar layout',
  value: 'single',
  options: [
    { value: 'single', label: 'Single toolbar' },
    { value: 'double', label: 'Two toolbars' }
  ],
  onChange: () => undefined
}

const right: SwitchRow = {
  kind: 'switch',
  id: 'look:right',
  label: 'Tabs on the right',
  checked: false,
  onChange: () => undefined
}

const reset: ActionRow = {
  kind: 'action',
  id: 'look:reset',
  label: 'Reset appearance',
  description: 'Back to the defaults',
  onPress: () => undefined
}

const row = (h: HTMLElement, id: string): HTMLButtonElement =>
  h.querySelector<HTMLButtonElement>(`[data-row="${id}"]`)!

describe('the value row’s name (A11Y, #237’s audit)', () => {
  it('is spoken once as "label, value", the label and the value shown as before', () => {
    const open = vi.fn<(request: SheetRequest) => void>()
    const h = render(
      <GroupList
        groups={[{ id: 'look-appearance', heading: 'Appearance', rows: [scheme, layout, right] }]}
        ctx={{ open }}
      />
    )
    const button = row(h, 'look:scheme')
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('aria-label')).toBe('Colour scheme, Light')
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button.querySelector('.zen-settings-label')?.textContent).toBe('Colour scheme')
    expect(button.querySelector('.zen-settings-description')?.textContent).toBe('Light')
    expect(row(h, 'look:layout').getAttribute('aria-label')).toBe('Toolbar layout, Single toolbar')
    // The row is still the picker's opener.
    act(() => button.click())
    expect(open).toHaveBeenCalledWith({ kind: 'options', rowId: 'look:scheme' })
  })

  it('follows the value: a change of option renames the row, an unlisted value is read as it is', () => {
    const h = render(<RowView row={{ ...scheme, value: 'dark' }} ctx={{ open: () => undefined }} />)
    expect(row(h, 'look:scheme').getAttribute('aria-label')).toBe('Colour scheme, Dark')
    act(() => root?.unmount())
    host?.remove()
    const raw = render(
      <RowView row={{ ...scheme, value: 'sepia' }} ctx={{ open: () => undefined }} />
    )
    expect(row(raw, 'look:scheme').getAttribute('aria-label')).toBe('Colour scheme, sepia')
  })

  it('puts a search result’s caption first, as the row shows it', () => {
    const h = render(
      <RowView row={scheme} ctx={{ open: () => undefined }} caption="Look and Feel › Appearance" />
    )
    const button = row(h, 'look:scheme')
    expect(button.getAttribute('aria-label')).toBe(
      'Look and Feel › Appearance, Colour scheme, Light'
    )
    expect(button.querySelector('.zen-settings-caption')?.textContent).toBe(
      'Look and Feel › Appearance'
    )
  })

  it('leaves the switch and the action rows named by their contents', () => {
    const h = render(
      <GroupList
        groups={[{ id: 'look-more', heading: null, rows: [right, reset] }]}
        ctx={{ open: () => undefined }}
      />
    )
    expect(row(h, 'look:right').hasAttribute('aria-label')).toBe(false)
    expect(row(h, 'look:right').getAttribute('role')).toBe('switch')
    expect(row(h, 'look:reset').hasAttribute('aria-label')).toBe(false)
  })

  it('the desktop’s value row is its menulist, no row label over it', () => {
    const h = render(<RowView row={scheme} ctx={{ open: () => undefined }} variant="desktop" />)
    expect(h.querySelector('[data-row="look:scheme"]')?.hasAttribute('aria-label')).toBe(false)
    expect(h.querySelector('.zen-settings-menulist')).not.toBeNull()
  })
})
