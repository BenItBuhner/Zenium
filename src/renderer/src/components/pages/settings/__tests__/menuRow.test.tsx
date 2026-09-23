// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { closeAllPopovers } from '@renderer/lib/portals'
import { viewportStore } from '@renderer/lib/formFactor'
import { itemMenuItems, type ItemRow, type SliderRow } from '../model'
import { RowView } from '../rows'

/*
 * CT-41's list rows and CT-25's levels on the shared builder, as the #350 lead check ruled
 * them. An item row with several actions and nothing to set (`ItemRow.menu`) is, on a mouse,
 * §10.5's static row (§9.34) trailing the shared 28 icon button – the one target in the row,
 * named for the row, `aria-haspopup="menu"` – which opens the shared `LocalMenu` from itself
 * with the item sheet's action rows as its items (`itemMenuItems`), the inapplicable one listed
 * and disabled (§9.30's .4) rather than left out; a dependent row's button is disabled with the
 * row. On the phone the same row is §10.4's item row – a plain pressable row, no ⋯ and no
 * chevron – whose whole tap opens the item sheet. A slider row on the phone is §10.4's ± form:
 * the value on the label's line in `tabular-nums`, the 44 step buttons at the row's ends with
 * the track between them, no labels under the track's ends; a step button steps once per press
 * and is disabled at its end of the ladder.
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

afterEach(async () => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  document.getElementById('zen-chrome-layer')?.remove()
  closeAllPopovers()
  await new Promise((resolve) => setTimeout(resolve, 0))
})

function rowOf(el: HTMLElement, id: string): HTMLElement {
  const row = el.querySelector<HTMLElement>(`[data-row="${id}"]`)
  if (!row) throw new Error(`no row ${id}`)
  return row
}

function languageRow(patch: Partial<ItemRow> = {}, onPress = vi.fn()): ItemRow {
  return {
    kind: 'item',
    id: 'languages-preferred:en',
    label: 'English',
    menu: 'Options for English',
    sheet: {
      title: 'English',
      groups: [
        {
          id: 'actions',
          heading: null,
          rows: [
            { kind: 'action', id: 'up', label: 'Move Up', disabled: true, onPress },
            { kind: 'action', id: 'down', label: 'Move Down', onPress },
            { kind: 'action', id: 'remove', label: 'Remove', onPress }
          ]
        }
      ]
    },
    ...patch
  }
}

describe('the item row’s ⋯ on a mouse (§10.5)', () => {
  const ctx = { open: vi.fn() }

  it('the menu’s items are the sheet’s action rows in their order, the inapplicable one disabled, a destructive one in the danger ink', () => {
    const items = itemMenuItems(languageRow())
    expect(items.map((i) => i.label)).toEqual(['Move Up', 'Move Down', 'Remove'])
    expect(items.map((i) => i.disabled)).toEqual([true, undefined, undefined])
    expect(items.map((i) => i.danger)).toEqual([undefined, undefined, undefined])
    const destructive = itemMenuItems(
      languageRow({
        sheet: {
          title: 'English',
          groups: [
            {
              id: 'a',
              heading: null,
              rows: [
                { kind: 'info', id: 'note', label: 'A fact, not an item' },
                { kind: 'action', id: 'clear', label: 'Clear', destructive: true }
              ]
            }
          ]
        }
      })
    )
    expect(destructive.map((i) => [i.label, i.danger])).toEqual([['Clear', true]])
  })

  it('stays a static row with the icon button as its one target, a control row on one line', () => {
    const el = render(<RowView row={languageRow()} ctx={ctx} variant="desktop" />)
    const row = rowOf(el, 'languages-preferred:en')
    expect(row.tagName).toBe('DIV')
    expect(row.hasAttribute('data-static')).toBe(true)
    expect(row.hasAttribute('data-control')).toBe(true)
    expect(row.querySelector('.zen-settings-label')?.textContent).toBe('English')
    const button = row.querySelector<HTMLButtonElement>('button.zen-settings-row-menu')
    expect(button).not.toBeNull()
    expect(button!.getAttribute('aria-label')).toBe('Options for English')
    expect(button!.getAttribute('aria-haspopup')).toBe('menu')
    expect(button!.hasAttribute('aria-expanded')).toBe(false)
    expect(button!.closest('.zen-settings-trailing')).not.toBeNull()
    // The button is the row's one button: nothing else in the row is pressable.
    expect(row.querySelectorAll('button').length).toBe(1)
  })

  it('a two-line row holds the button inside its lines rather than as a control row', () => {
    const el = render(
      <RowView
        row={languageRow({ description: 'Pages are translated into this language' })}
        ctx={ctx}
        variant="desktop"
      />
    )
    const row = rowOf(el, 'languages-preferred:en')
    expect(row.hasAttribute('data-control')).toBe(false)
    expect(row.querySelector('.zen-settings-description')?.textContent).toBe(
      'Pages are translated into this language'
    )
  })

  it('opens the shared menu from the button with the sheet’s rows, the inapplicable one listed and disabled; a pick runs it and closes', async () => {
    viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false })
    const onPress = vi.fn()
    const el = render(<RowView row={languageRow({}, onPress)} ctx={ctx} variant="desktop" />)
    const button = rowOf(el, 'languages-preferred:en').querySelector<HTMLButtonElement>(
      'button.zen-settings-row-menu'
    )!
    // The menu holds its first paint until the page's capture is in place (useFloatingChrome):
    // a few microtasks here, where there is no page.
    await act(async () => {
      button.click()
      await Promise.resolve()
    })
    expect(button.getAttribute('aria-expanded')).toBe('true')
    const menu = document.querySelector<HTMLElement>('[role="menu"]')
    expect(menu).not.toBeNull()
    const items = [...menu!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    expect(items.map((i) => i.textContent)).toEqual(['Move Up', 'Move Down', 'Remove'])
    expect(items.map((i) => i.disabled)).toEqual([true, false, false])
    act(() => items[1].click())
    expect(onPress).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(button.hasAttribute('aria-expanded')).toBe(false)
  })

  it('a dependent row disables its button with the row, one .4', () => {
    const el = render(<RowView row={languageRow({ disabled: true })} ctx={ctx} variant="desktop" />)
    const row = rowOf(el, 'languages-preferred:en')
    expect(row.classList.contains('zen-settings-row-disabled')).toBe(true)
    expect(row.querySelector<HTMLButtonElement>('button.zen-settings-row-menu')!.disabled).toBe(
      true
    )
  })

  it('on the phone the same row is §10.4’s item row: pressable whole, no ⋯ and no chevron, the tap opening the item sheet', () => {
    const open = vi.fn()
    const el = render(<RowView row={languageRow()} ctx={{ open }} />)
    const row = rowOf(el, 'languages-preferred:en')
    expect(row.tagName).toBe('BUTTON')
    expect(row.querySelector('.zen-settings-row-menu')).toBeNull()
    expect(row.querySelector('svg')).toBeNull()
    expect(row.querySelector('.zen-settings-label')?.textContent).toBe('English')
    act(() => row.click())
    expect(open).toHaveBeenCalledWith({ kind: 'item', rowId: 'languages-preferred:en' })
  })
})

const STOPS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24]

function size(value: number, onChange = vi.fn()): SliderRow {
  return {
    kind: 'slider',
    id: 'fonts-size',
    label: 'Font size',
    value,
    min: 0,
    max: STOPS.length - 1,
    step: 1,
    format: (i) => `${STOPS[i] ?? i} px`,
    onChange
  }
}

describe('the phone slider row’s ± form (§10.4)', () => {
  const ctx = { open: () => undefined }

  it('the value on the label’s line, the step buttons at the row’s ends with the track between them, no end labels', () => {
    const el = render(<RowView row={size(7)} ctx={ctx} />)
    const row = rowOf(el, 'fonts-size')
    expect(row.hasAttribute('data-static')).toBe(true)
    const head = row.querySelector<HTMLElement>('.zen-settings-slider-head')!
    expect(head.querySelector('.zen-settings-label')?.textContent).toBe('Font size')
    expect(head.querySelector('.zen-settings-slider-value')?.textContent).toBe('16 px')
    const stepper = row.querySelector<HTMLElement>('.zen-settings-slider-stepper')!
    expect(stepper).not.toBeNull()
    const children = [...stepper.children]
    expect(children.length).toBe(3)
    expect(children[0].tagName).toBe('BUTTON')
    expect(children[0].getAttribute('aria-label')).toBe('Decrease Font size')
    expect(children[1].querySelector('[role="slider"]')?.getAttribute('aria-valuetext')).toBe(
      '16 px'
    )
    expect(children[2].tagName).toBe('BUTTON')
    expect(children[2].getAttribute('aria-label')).toBe('Increase Font size')
    expect(row.querySelector('.zen-settings-slider-ends')).toBeNull()
  })

  it('a press steps one stop and commits at once; the button at the ladder’s end is disabled', () => {
    const onChange = vi.fn()
    const el = render(<RowView row={size(7, onChange)} ctx={ctx} />)
    const [minus, plus] = [...rowOf(el, 'fonts-size').querySelectorAll<HTMLButtonElement>('button')]
    expect(minus.getAttribute('aria-label')).toBe('Decrease Font size')
    expect(plus.getAttribute('aria-label')).toBe('Increase Font size')
    act(() => plus.click())
    expect(onChange).toHaveBeenCalledWith(8)
    act(() => minus.click())
    expect(onChange).toHaveBeenCalledWith(6)
    act(() => root?.unmount())
    host?.remove()
    const top = render(<RowView row={size(STOPS.length - 1)} ctx={ctx} />)
    const buttons = [...rowOf(top, 'fonts-size').querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons[0].disabled).toBe(false)
    expect(buttons[1].disabled).toBe(true)
    act(() => root?.unmount())
    host?.remove()
    const bottom = render(<RowView row={size(0)} ctx={ctx} />)
    const ends = [...rowOf(bottom, 'fonts-size').querySelectorAll<HTMLButtonElement>('button')]
    expect(ends[0].disabled).toBe(true)
    expect(ends[1].disabled).toBe(false)
  })

  it('a dependent row disables the whole control with the row', () => {
    const el = render(<RowView row={{ ...size(7), disabled: true }} ctx={ctx} />)
    const row = rowOf(el, 'fonts-size')
    expect(row.classList.contains('zen-settings-row-disabled')).toBe(true)
    expect([...row.querySelectorAll<HTMLButtonElement>('button')].map((b) => b.disabled)).toEqual([
      true,
      true
    ])
    expect(row.querySelector('[role="slider"]')?.getAttribute('data-disabled')).not.toBeNull()
  })
})
