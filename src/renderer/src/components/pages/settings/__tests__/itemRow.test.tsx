// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ItemRow, RowGroup } from '../model'
import { GroupList, type SheetRequest } from '../rows'

/*
 * An item row that exists to be acted on (§10.5, the #322 lead check): its one `action` trails
 * the row as the desktop's 32 button – Remove in the danger ink, pressed at once, no dialog to
 * hold it – while the phone's row opens its sheet, the finger's form of the same row, and holds
 * the action as a row of its own.
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

function pattern(onPress: () => void, description?: string): ItemRow {
  return {
    kind: 'item',
    id: 'site-data-site:[*.]tracker.example',
    label: '[*.]tracker.example',
    description,
    action: { label: 'Remove', destructive: true, onPress },
    sheet: {
      title: '[*.]tracker.example',
      description: 'Sites that can never use cookies',
      groups: [
        {
          id: 'site-data-site:[*.]tracker.example:actions',
          heading: null,
          rows: [
            {
              kind: 'action',
              id: 'site-data-site:[*.]tracker.example:remove',
              label: 'Remove from the list',
              description: 'The site follows the default again.',
              button: 'Remove',
              onPress
            }
          ]
        }
      ]
    }
  }
}

describe('an item row with its one inline action (§10.5)', () => {
  it('on the desktop trails the action as a 32 secondary in the danger ink, named for the row, pressed at once, and opens no dialog', () => {
    const onPress = vi.fn()
    const open = vi.fn<(request: SheetRequest) => void>()
    const row = pattern(onPress)
    const groups: RowGroup[] = [{ id: 'site-data-block', heading: 'Never', rows: [row] }]
    const h = render(<GroupList groups={groups} ctx={{ open }} variant="desktop" />)
    const el = h.querySelector<HTMLElement>('[data-row="site-data-site:[*.]tracker.example"]')!
    // The §9.21 control row: static text, the control the target and not the row.
    expect(el.tagName).toBe('DIV')
    expect(el.hasAttribute('data-static')).toBe(true)
    expect(el.classList.contains('zen-settings-control-row')).toBe(true)
    expect(el.getAttribute('role')).toBeNull()
    expect(el.querySelector('.zen-settings-label')?.textContent).toBe('[*.]tracker.example')
    const button = el.querySelector<HTMLButtonElement>(
      '.zen-settings-trailing.zen-settings-control > button.zen-v2-button'
    )!
    expect(button).not.toBeNull()
    expect(button.textContent).toBe('Remove')
    expect(button.getAttribute('aria-label')).toBe('Remove [*.]tracker.example')
    // The secondary in the danger ink: never the accent fill, never a confirmation.
    expect(button.hasAttribute('data-danger')).toBe(true)
    expect(button.hasAttribute('data-primary')).toBe(false)
    expect(button.getAttribute('aria-haspopup')).toBeNull()
    act(() => button.click())
    expect(onPress).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
    // The sheet's own Remove row is not on the page: the button is the row's one action here.
    expect(h.querySelector('[data-row="site-data-site:[*.]tracker.example:remove"]')).toBeNull()
  })

  it('keeps the description as the second line of the control row (the clear-on-exit list’s timing)', () => {
    const h = render(
      <GroupList
        groups={[
          {
            id: 'site-data-clearOnExit',
            heading: 'Exit',
            rows: [pattern(() => undefined, 'Cleared the next time Zenium starts')]
          }
        ]}
        ctx={{ open: () => undefined }}
        variant="desktop"
      />
    )
    const el = h.querySelector<HTMLElement>('[data-row="site-data-site:[*.]tracker.example"]')!
    expect(el.querySelector('.zen-settings-description')?.textContent).toBe(
      'Cleared the next time Zenium starts'
    )
    expect(el.querySelector('button.zen-v2-button')?.textContent).toBe('Remove')
  })

  it('on the phone is the pressable row opening its sheet, the action a row of the sheet', () => {
    const onPress = vi.fn()
    const open = vi.fn<(request: SheetRequest) => void>()
    const row = pattern(onPress)
    const h = render(
      <GroupList
        groups={[{ id: 'site-data-block', heading: 'Never', rows: [row] }]}
        ctx={{ open }}
      />
    )
    const el = h.querySelector<HTMLElement>('[data-row="site-data-site:[*.]tracker.example"]')!
    expect(el.tagName).toBe('BUTTON')
    expect(el.getAttribute('aria-haspopup')).toBe('dialog')
    expect(el.querySelector('.zen-v2-button')).toBeNull()
    act(() => el.click())
    expect(open).toHaveBeenCalledWith({
      kind: 'item',
      rowId: 'site-data-site:[*.]tracker.example'
    })
    expect(onPress).not.toHaveBeenCalled()
    // The sheet's rows, drawn as the phone draws them: the Remove row in the text ink.
    const sheet = render(<GroupList groups={row.sheet.groups} ctx={{ open }} />)
    const remove = sheet.querySelector<HTMLElement>(
      '[data-row="site-data-site:[*.]tracker.example:remove"]'
    )!
    expect(remove.tagName).toBe('BUTTON')
    expect(remove.classList.contains('zen-settings-row-danger')).toBe(false)
    act(() => remove.click())
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('an item row without an action stays the phone’s pressable row on the desktop too, opening its dialog', () => {
    const open = vi.fn<(request: SheetRequest) => void>()
    const row: ItemRow = { ...pattern(() => undefined), action: undefined }
    const h = render(
      <GroupList
        groups={[{ id: 'site-data-block', heading: 'Never', rows: [row] }]}
        ctx={{ open }}
        variant="desktop"
      />
    )
    const el = h.querySelector<HTMLElement>('[data-row="site-data-site:[*.]tracker.example"]')!
    expect(el.tagName).toBe('BUTTON')
    act(() => el.click())
    expect(open).toHaveBeenCalledWith({
      kind: 'item',
      rowId: 'site-data-site:[*.]tracker.example'
    })
  })
})
