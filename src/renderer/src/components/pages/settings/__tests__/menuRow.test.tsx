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
import type { InfoRow, SliderRow } from '../model'
import { RowView } from '../rows'

/*
 * CT-41's list rows and CT-25's sliders on the shared builder: an info row with a `menu` stays
 * the static row (§9.34) and holds the shared icon button in its trailing slot – the one target
 * in the row, named for the row, `aria-haspopup="menu"` – which opens the shared `LocalMenu`
 * from itself with the row's items, the inapplicable one listed and disabled (§9.30's .4) rather
 * than left out; a dependent row's button is disabled with the row. A slider row's `ends` are
 * Chrome's end labels under the track, `aria-hidden` – the value beside the label is what the
 * row says – on the phone's block and in the desktop's trailing stack alike.
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

const ctx = { open: () => undefined }

function rowOf(el: HTMLElement, id: string): HTMLElement {
  const row = el.querySelector<HTMLElement>(`[data-row="${id}"]`)
  if (!row) throw new Error(`no row ${id}`)
  return row
}

function languageRow(patch: Partial<InfoRow> = {}, onSelect = vi.fn()): InfoRow {
  return {
    kind: 'info',
    id: 'languages-preferred:en',
    label: 'English',
    menu: {
      label: 'Options for English',
      items: [
        { id: 'up', label: 'Move Up', disabled: true, onSelect },
        { id: 'down', label: 'Move Down', onSelect },
        { id: 'remove', label: 'Remove', onSelect }
      ]
    },
    ...patch
  }
}

describe('the info row’s ⋯ menu (§10.4)', () => {
  it('stays a static row with the icon button as its one target, a control row on one line', () => {
    const el = render(<RowView row={languageRow()} ctx={ctx} />)
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
      <RowView row={languageRow({ description: 'Pages are translated into this language' })} ctx={ctx} />
    )
    const row = rowOf(el, 'languages-preferred:en')
    expect(row.hasAttribute('data-control')).toBe(false)
    expect(row.querySelector('.zen-settings-description')?.textContent).toBe(
      'Pages are translated into this language'
    )
  })

  it('opens the shared menu from the button with the row’s items, the inapplicable one listed and disabled; a pick runs it and closes', async () => {
    viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false })
    const onSelect = vi.fn()
    const el = render(<RowView row={languageRow({}, onSelect)} ctx={ctx} />)
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
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(button.hasAttribute('aria-expanded')).toBe(false)
  })

  it('a dependent row disables its button with the row, one .4', () => {
    const el = render(<RowView row={languageRow({ disabled: true })} ctx={ctx} />)
    const row = rowOf(el, 'languages-preferred:en')
    expect(row.classList.contains('zen-settings-row-disabled')).toBe(true)
    expect(row.querySelector<HTMLButtonElement>('button.zen-settings-row-menu')!.disabled).toBe(
      true
    )
  })
})

const size: SliderRow = {
  kind: 'slider',
  id: 'fonts-size',
  label: 'Font size',
  value: 7,
  min: 0,
  max: 24,
  step: 1,
  ends: ['Very small', 'Very large'],
  format: (i) => `${[9, 10, 11, 12, 13, 14, 15, 16][i] ?? i} px`,
  onChange: () => undefined
}

describe('the slider row’s end labels (§9.21, Chrome’s fonts page)', () => {
  it('the phone block draws them under the track, hidden from the reader, the value beside the label', () => {
    const el = render(<RowView row={size} ctx={ctx} />)
    const row = rowOf(el, 'fonts-size')
    const ends = row.querySelector<HTMLElement>('.zen-settings-slider-ends')
    expect(ends).not.toBeNull()
    expect(ends!.getAttribute('aria-hidden')).toBe('true')
    expect([...ends!.children].map((c) => c.textContent)).toEqual(['Very small', 'Very large'])
    expect(row.querySelector('.zen-settings-slider-value')?.textContent).toBe('16 px')
    expect(row.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')).toBe('16 px')
  })

  it('the desktop stacks the track over them in the trailing slot; a row without ends stacks nothing', () => {
    const el = render(<RowView row={size} ctx={ctx} variant="desktop" />)
    const row = rowOf(el, 'fonts-size')
    const stack = row.querySelector<HTMLElement>('.zen-settings-slider-stack')
    expect(stack).not.toBeNull()
    expect(stack!.querySelector('.zen-settings-slider')).not.toBeNull()
    expect(stack!.querySelector('.zen-settings-slider-ends')).not.toBeNull()
    act(() => root?.unmount())
    host?.remove()
    const plain = render(
      <RowView row={{ ...size, id: 'zoom', ends: undefined }} ctx={ctx} variant="desktop" />
    )
    expect(plain.querySelector('.zen-settings-slider-stack')).toBeNull()
    expect(plain.querySelector('.zen-settings-slider-ends')).toBeNull()
  })
})
