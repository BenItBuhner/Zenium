// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import type { RowGroup, ValueRow } from '../model'
import { GroupList, RowView } from '../rows'

/*
 * The two-pane radio form (`ValueRow.radios`, `rows.tsx`'s `RadioListRow`; §9.14, §10.5; W8-2,
 * pr-584 R2 / N2): the option rows on the page's row chassis under a `radiogroup` the row's
 * label names for assistive technology alone – no legend drawn over the options (N2, the lead's
 * ruling: the page has three text levels and the options are the group's visible text; Chrome's
 * `cr-radio-group` under the Memory Saver toggle draws none) – while what the row has to say in
 * sight, a description or a search hit's caption, stays in the text block above the list. The
 * keyboard is a native group's: one tab stop on the checked option, the arrows moving choice and
 * focus together, wrapping.
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

function tierRow(patch: Partial<ValueRow> = {}, onChange = vi.fn()): ValueRow {
  return {
    kind: 'value',
    id: 'memory-saver-tier',
    label: 'Memory Saver options',
    value: '240',
    options: [
      { value: '360', label: 'Moderate', description: 'Six hours.' },
      { value: '240', label: 'Balanced (recommended)', description: 'Four hours.' },
      { value: '120', label: 'Maximum', description: 'Two hours.' }
    ],
    onChange,
    radios: true,
    ...patch
  }
}

const radios = (el: HTMLElement): HTMLButtonElement[] => [
  ...el.querySelectorAll<HTMLButtonElement>('[role="radio"]')
]

describe('the two-pane radio form (§9.14, §10.5; pr-584 N2)', () => {
  it('names the radiogroup by the row’s label for assistive technology alone and draws no legend: the options are the row’s visible text', () => {
    const el = render(<RowView row={tierRow()} ctx={ctx} variant="desktop" />)
    const row = el.querySelector<HTMLElement>('[data-row="memory-saver-tier"]')!
    expect(row.hasAttribute('data-static')).toBe(true)
    expect(row.className.split(' ')).toEqual(
      expect.arrayContaining([
        'zen-settings-row',
        'zen-settings-stacked-row',
        'zen-settings-radios-row',
        'zen-v2-row'
      ])
    )
    const group = row.querySelector<HTMLElement>('[role="radiogroup"]')!
    expect(group.getAttribute('aria-label')).toBe('Memory Saver options')
    expect(group.hasAttribute('aria-labelledby')).toBe(false)
    expect(group.className).toBe('zen-settings-radio-list zen-settings-radios')
    // No visible legend – no text block of the row's own over the list (the options' labels
    // are the only `.zen-settings-label`s), and the row's text is the options' alone.
    const block = row.querySelector<HTMLElement>('.zen-settings-field-block')!
    expect(block.querySelector(':scope > .zen-settings-row-text')).toBeNull()
    expect(row.textContent).not.toContain('Memory Saver options')
    // The list is the field block's one child: nothing stands between the row's edge and it.
    expect([...block.children]).toEqual([group])
    // The options, on the page's row chassis, checked and labelled as the model says.
    const options = radios(el)
    expect(options.map((o) => o.textContent)).toEqual([
      'ModerateSix hours.',
      'Balanced (recommended)Four hours.',
      'MaximumTwo hours.'
    ])
    expect(options.map((o) => o.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    expect(options.every((o) => o.classList.contains('zen-settings-radio-row'))).toBe(true)
    expect(options.every((o) => o.classList.contains('zen-v2-row'))).toBe(true)
  })

  it('keeps what the row has to say in sight – a description and a search hit’s caption – in the text block over the options, without the label', () => {
    const el = render(
      <RowView
        row={tierRow({ description: 'How soon an inactive tab is put to sleep.' })}
        ctx={ctx}
        caption="Tabs › Memory Saver"
        variant="desktop"
      />
    )
    const row = el.querySelector<HTMLElement>('[data-row="memory-saver-tier"]')!
    const block = row.querySelector<HTMLElement>('.zen-settings-field-block')!
    const text = block.querySelector<HTMLElement>(':scope > .zen-settings-row-text')!
    expect([...text.children].map((c) => [c.className, c.textContent])).toEqual([
      ['zen-settings-caption', 'Tabs › Memory Saver'],
      ['zen-settings-description', 'How soon an inactive tab is put to sleep.']
    ])
    expect(text.querySelector('.zen-settings-label')).toBeNull()
    expect([...block.children].map((c) => c.className)).toEqual([
      'zen-settings-row-text',
      'zen-settings-radio-list zen-settings-radios'
    ])
    // The group is still named, by the label the search matched on.
    expect(row.querySelector('[role="radiogroup"]')!.getAttribute('aria-label')).toBe(
      'Memory Saver options'
    )
  })

  it('is one tab stop on the checked option; the arrows move the choice and the focus together, wrapping; a press on an option picks it once', () => {
    const onChange = vi.fn()
    const el = render(<RowView row={tierRow({}, onChange)} ctx={ctx} variant="desktop" />)
    const options = radios(el)
    expect(options.map((o) => o.tabIndex)).toEqual([-1, 0, -1])
    const group = el.querySelector<HTMLElement>('[role="radiogroup"]')!
    const key = (k: string): void =>
      act(() => {
        group.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
      })
    key('ArrowDown')
    expect(onChange).toHaveBeenLastCalledWith('120')
    expect(document.activeElement).toBe(options[2])
    // From the model's checked option (unchanged here: the model is the test's), up wraps to
    // the last option; the choice the row would land on is what the arrow reports.
    key('ArrowUp')
    expect(onChange).toHaveBeenLastCalledWith('360')
    expect(document.activeElement).toBe(options[0])
    // A press on the checked option writes nothing; on another, that value once.
    act(() => options[1].click())
    expect(onChange).toHaveBeenCalledTimes(2)
    act(() => options[0].click())
    expect(onChange).toHaveBeenLastCalledWith('360')
    expect(onChange).toHaveBeenCalledTimes(3)
  })

  it('disabled as a dependent row: the row carries the .4 class, the group says so, the options are disabled and the arrows do nothing', () => {
    const onChange = vi.fn()
    const el = render(
      <RowView row={tierRow({ disabled: true }, onChange)} ctx={ctx} variant="desktop" />
    )
    const row = el.querySelector<HTMLElement>('[data-row="memory-saver-tier"]')!
    expect(row.classList.contains('zen-settings-row-disabled')).toBe(true)
    const group = row.querySelector<HTMLElement>('[role="radiogroup"]')!
    expect(group.getAttribute('aria-disabled')).toBe('true')
    expect(radios(el).every((o) => o.disabled)).toBe(true)
    act(() => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('a dependent list dims as one group (§9.17, §9.30, §10.4; pr-584’s re-read, NEW 2 as ruled)', () => {
  const list = (disabled: boolean, rows: RowGroup['rows'] = []): RowGroup => ({
    id: 'keep-active',
    heading: 'Always keep these sites active',
    description: 'Sites you add will always stay active.',
    rows,
    empty: 'No sites yet',
    disabled
  })

  it('the group carries the dim and says aria-disabled while the list’s control is off – heading, sentence and empty line inside it, none marked on its own – and stands at rest while it is on', () => {
    const off = render(<GroupList groups={[list(true)]} ctx={ctx} variant="desktop" />)
    const group = off.querySelector<HTMLElement>('[data-group="keep-active"]')!
    expect(group.getAttribute('role')).toBe('group')
    expect(group.hasAttribute('data-disabled')).toBe(true)
    expect(group.getAttribute('aria-disabled')).toBe('true')
    // One register: the parts under the group take no mark of their own.
    const empty = group.querySelector<HTMLElement>('.zen-settings-empty')!
    expect(empty.textContent).toBe('No sites yet')
    expect(empty.hasAttribute('data-disabled')).toBe(false)
    expect(group.querySelector('.zen-settings-heading')?.textContent).toBe(
      'Always keep these sites active'
    )
    expect(
      group.querySelector('.zen-settings-group-description')!.hasAttribute('data-disabled')
    ).toBe(false)
    act(() => root?.unmount())
    const on = render(<GroupList groups={[list(false)]} ctx={ctx} variant="desktop" />)
    const rested = on.querySelector<HTMLElement>('[data-group="keep-active"]')!
    expect(rested.hasAttribute('data-disabled')).toBe(false)
    expect(rested.hasAttribute('aria-disabled')).toBe(false)
  })

  it('the rows inside a dimmed group keep `disabled` for what it does – no press – and the group’s attribute stands over them', () => {
    const onChange = vi.fn()
    const el = render(
      <GroupList
        groups={[list(true, [tierRow({ disabled: true }, onChange)])]}
        ctx={ctx}
        variant="desktop"
      />
    )
    const group = el.querySelector<HTMLElement>('[data-group="keep-active"]')!
    expect(group.getAttribute('aria-disabled')).toBe('true')
    const row = group.querySelector<HTMLElement>('[data-row="memory-saver-tier"]')!
    expect(row.classList.contains('zen-settings-row-disabled')).toBe(true)
    expect(radios(el).every((o) => o.disabled)).toBe(true)
    act(() => radios(el)[0].click())
    expect(onChange).not.toHaveBeenCalled()
  })
})
