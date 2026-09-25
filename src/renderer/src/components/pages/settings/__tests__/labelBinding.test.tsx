// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import axe from 'axe-core'
import type { FieldRow, RowGroup, SliderRow, SwitchRow, ValueRow } from '../model'
import { GroupList, RowView } from '../rows'
import { V2Menulist } from '../../../extensions/V2Menulist'

/*
 * The `<label for>` sweep of the settings builder's controls (§9.12: a form control is
 * associated with its visible label; the #453 lead check, taken for the stacked field there and
 * for the builder's other controls here). A control that trails its row's text was named by an
 * `aria-label` of the same words while the label stood beside it as a span; now one element
 * names it: a native field by the label's `<label for>` (a click on the label lands in the
 * field), a control that is a button – the menulist, the slider's thumb – by `aria-labelledby`
 * on the label's id. The name is the label's text as before; every class stays where it was.
 * The phone's slider row renders the same control under its own head label, so it binds there
 * too; the phone's field row opens the field sheet, which binds its field already (#448).
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

function rowOf(el: HTMLElement, id: string): HTMLElement {
  const row = el.querySelector<HTMLElement>(`[data-row="${id}"]`)
  if (!row) throw new Error(`no row ${id}`)
  return row
}

/**
 * The name the accessible-name computation gives the control, as far as these controls go:
 * the elements `aria-labelledby` names, else its `aria-label`, else the `<label>`s of a native
 * field, else its contents. What a reader speaks; the tests pin it to the row's label.
 */
function nameOf(el: HTMLElement): string {
  const ids = el.getAttribute('aria-labelledby')
  if (ids) {
    return ids
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => {
        const named = document.getElementById(id)
        if (!named) throw new Error(`aria-labelledby names no element: ${id}`)
        return named.textContent ?? ''
      })
      .join(' ')
  }
  const label = el.getAttribute('aria-label')
  if (label !== null) return label
  if (el instanceof HTMLInputElement && el.labels && el.labels.length > 0)
    return Array.from(el.labels, (l) => l.textContent ?? '').join(' ')
  return el.textContent ?? ''
}

/** The one element `aria-labelledby` names, which must be the row's own visible label. */
function labelNamedBy(control: HTMLElement, row: HTMLElement): HTMLElement {
  const ids = (control.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
  expect(ids).toHaveLength(1)
  const named = document.getElementById(ids[0]!)
  expect(named).not.toBeNull()
  expect(named!.classList.contains('zen-settings-label')).toBe(true)
  expect(row.contains(named)).toBe(true)
  return named!
}

const ram: SliderRow = {
  kind: 'slider',
  id: 'performance-ram-share',
  label: 'Share of installed RAM',
  description: 'How much of the memory sleeping tabs may keep.',
  value: 40,
  min: 10,
  max: 90,
  step: 10,
  format: (v) => `${v} %`,
  onChange: () => undefined
}

const fontSize: SliderRow = {
  kind: 'slider',
  id: 'fonts-size',
  label: 'Font size',
  value: 16,
  min: 9,
  max: 72,
  step: 1,
  format: (v) => `${v} px`,
  onChange: () => undefined
}

const homepage: FieldRow = {
  kind: 'field',
  id: 'startup-homepage',
  label: 'Homepage',
  description: 'Opened by the Home button.',
  value: 'https://example.com/',
  input: 'url',
  onCommit: () => undefined
}

const limit: FieldRow = {
  kind: 'field',
  id: 'downloads-limit',
  label: 'Parallel downloads',
  value: '4',
  input: 'number',
  min: 1,
  max: 8,
  onCommit: () => undefined
}

const scheme: ValueRow = {
  kind: 'value',
  id: 'look-scheme',
  label: 'Colour scheme',
  description: 'Light, dark, or as the system says.',
  value: 'light',
  options: [
    { value: 'system', label: 'Follow system' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' }
  ],
  onChange: () => undefined
}

const bar: SwitchRow = {
  kind: 'switch',
  id: 'toolbar-bookmarks-bar',
  label: 'Show bookmarks bar',
  description: 'Under the address bar, on every tab.',
  checked: true,
  onChange: () => undefined
}

const groups: RowGroup[] = [
  {
    id: 'sweep',
    heading: 'Controls beside their text',
    rows: [scheme, bar, homepage, limit, ram, fontSize]
  }
]

describe('the desktop slider row (§9.21): the thumb is named by the row’s label through aria-labelledby', () => {
  it('names the visible label, and the name is the label’s text as it was', () => {
    const el = render(<RowView row={ram} ctx={ctx} variant="desktop" />)
    const row = rowOf(el, 'performance-ram-share')
    const thumb = row.querySelector<HTMLElement>('[role="slider"]')!
    expect(thumb).not.toBeNull()
    expect(thumb.hasAttribute('aria-label')).toBe(false)
    const label = labelNamedBy(thumb, row)
    // The row's own label, in the text block that trails nothing else: not the value's text.
    expect(label.parentElement!.classList.contains('zen-settings-row-text')).toBe(true)
    expect(label.textContent).toBe('Share of installed RAM')
    expect(nameOf(thumb)).toBe('Share of installed RAM')
    // The spoken value is the row's format still; the description is not part of the name.
    expect(thumb.getAttribute('aria-valuetext')).toBe('40 %')
    expect(row.querySelector('.zen-settings-slider-value')!.textContent).toBe('40 %')
  })

  it('keeps every class: the control row, the trailing control slot, the shared slider and its label', () => {
    const el = render(<RowView row={ram} ctx={ctx} variant="desktop" />)
    const row = rowOf(el, 'performance-ram-share')
    expect(row.className).toBe('zen-settings-row zen-settings-control-row zen-v2-row')
    expect(row.hasAttribute('data-static')).toBe(true)
    const slot = row.querySelector<HTMLElement>(':scope > .zen-settings-trailing')!
    expect(slot.className).toBe('zen-settings-trailing zen-settings-control')
    const control = slot.querySelector<HTMLElement>(':scope > .zen-settings-slider-control')!
    expect(control).not.toBeNull()
    expect(control.querySelector('.zen-zoom-slider.zen-settings-slider')).not.toBeNull()
    // The label is a span still – a slider is no native field for a `<label for>` – on its class.
    const label = row.querySelector<HTMLElement>('.zen-settings-label')!
    expect(label.tagName.toLowerCase()).toBe('span')
    expect(label.className).toBe('zen-settings-label')
  })
})

describe('the phone slider row (§10.4): the same control under the head’s label binds there too', () => {
  it('the thumb names the head’s label; the ± buttons keep their own names', () => {
    const el = render(<RowView row={fontSize} ctx={ctx} />)
    const row = rowOf(el, 'fonts-size')
    expect(row.classList.contains('zen-settings-slider-row')).toBe(true)
    const thumb = row.querySelector<HTMLElement>('[role="slider"]')!
    expect(thumb.hasAttribute('aria-label')).toBe(false)
    const label = labelNamedBy(thumb, row)
    expect(label.parentElement!.classList.contains('zen-settings-slider-head')).toBe(true)
    expect(label.tagName.toLowerCase()).toBe('span')
    expect(label.className).toBe('zen-settings-label')
    expect(nameOf(thumb)).toBe('Font size')
    expect(thumb.getAttribute('aria-valuetext')).toBe('16 px')
    const [minus, plus] = row.querySelectorAll<HTMLButtonElement>('button')
    expect(nameOf(minus!)).toBe('Decrease Font size')
    expect(nameOf(plus!)).toBe('Increase Font size')
  })

  it('two slider rows in one list are each named by their own label', () => {
    const el = render(
      <GroupList groups={[{ id: 'two', heading: null, rows: [ram, fontSize] }]} ctx={ctx} />
    )
    const first = rowOf(el, 'performance-ram-share').querySelector<HTMLElement>('[role="slider"]')!
    const second = rowOf(el, 'fonts-size').querySelector<HTMLElement>('[role="slider"]')!
    expect(first.getAttribute('aria-labelledby')).not.toBe(second.getAttribute('aria-labelledby'))
    expect(nameOf(first)).toBe('Share of installed RAM')
    expect(nameOf(second)).toBe('Font size')
  })
})

describe('the inline field row (§9.12, §10.5): the label is the field’s <label for>, as the stacked row’s is', () => {
  it('a text field: label.control is the input, no aria-label, the name the label’s text', () => {
    const el = render(<RowView row={homepage} ctx={ctx} variant="desktop" />)
    const row = rowOf(el, 'startup-homepage')
    const input = row.querySelector<HTMLInputElement>('input')!
    const label = row.querySelector<HTMLLabelElement>('.zen-settings-label')!
    expect(label.tagName.toLowerCase()).toBe('label')
    expect(label.className).toBe('zen-settings-label')
    expect(input.id).not.toBe('')
    expect(label.htmlFor).toBe(input.id)
    expect(label.control).toBe(input)
    expect(input.hasAttribute('aria-label')).toBe(false)
    expect(nameOf(input)).toBe('Homepage')
    // The description is the row's, not the label's: it does not join the name.
    expect(row.querySelector('.zen-settings-description')!.textContent).toBe(
      'Opened by the Home button.'
    )
    // The field's own classes and the row's stay.
    expect(input.className).toBe('zen-settings-input zen-v2-field zen-settings-field-text')
    expect(row.className).toBe('zen-settings-row zen-settings-control-row zen-v2-row')
  })

  it('a number field the same, its own class kept', () => {
    const el = render(<RowView row={limit} ctx={ctx} variant="desktop" />)
    const row = rowOf(el, 'downloads-limit')
    const input = row.querySelector<HTMLInputElement>('input')!
    const label = row.querySelector<HTMLLabelElement>('.zen-settings-label')!
    expect(label.control).toBe(input)
    expect(input.hasAttribute('aria-label')).toBe(false)
    expect(nameOf(input)).toBe('Parallel downloads')
    expect(input.type).toBe('number')
    expect(input.className).toBe('zen-settings-input zen-v2-field zen-settings-field-number')
  })

  it('the association reads from both sides (the DOM’s own, which the browser’s label click follows)', () => {
    // happy-dom lays out and activates nothing: a click on the label focusing the field is the
    // browser's behaviour for a `<label for>` whose `control` is the field, pinned here as the
    // association itself – `label.control` and `input.labels` agree.
    const el = render(<RowView row={homepage} ctx={ctx} variant="desktop" />)
    const row = rowOf(el, 'startup-homepage')
    const input = row.querySelector<HTMLInputElement>('input')!
    const label = row.querySelector<HTMLLabelElement>('.zen-settings-label')!
    expect(label.control).toBe(input)
    expect(Array.from(input.labels ?? [])).toEqual([label])
    expect(document.getElementById(label.htmlFor)).toBe(input)
  })
})

describe('the desktop value row (§10.5): the menulist is named by the row’s label through aria-labelledby', () => {
  it('names the visible label; the current option stays its contents, the name the label’s text', () => {
    const el = render(<RowView row={scheme} ctx={ctx} variant="desktop" />)
    const row = rowOf(el, 'look-scheme')
    const button = row.querySelector<HTMLButtonElement>('.zen-settings-menulist')!
    expect(button.tagName).toBe('BUTTON')
    expect(button.hasAttribute('aria-label')).toBe(false)
    const label = labelNamedBy(button, row)
    expect(label.textContent).toBe('Colour scheme')
    expect(label.tagName.toLowerCase()).toBe('span')
    expect(nameOf(button)).toBe('Colour scheme')
    expect(button.textContent).toBe('Light')
    expect(button.className).toBe('zen-v2-menulist zen-settings-menulist')
  })

  it('a menulist elsewhere, with no visible label to point at, keeps its own aria-label', () => {
    const el = render(
      <V2Menulist
        label="Sort by"
        value="name"
        options={[{ value: 'name', label: 'Name' }]}
        onChange={() => undefined}
      />
    )
    const button = el.querySelector<HTMLButtonElement>('.zen-v2-menulist')!
    expect(button.getAttribute('aria-label')).toBe('Sort by')
    expect(button.hasAttribute('aria-labelledby')).toBe(false)
  })
})

describe('the controls that were already right', () => {
  it('the desktop check row: the row is the checkbox’s <label>, the input its control', () => {
    const el = render(<RowView row={bar} ctx={ctx} variant="desktop" />)
    const row = rowOf(el, 'toolbar-bookmarks-bar') as HTMLLabelElement
    expect(row.tagName.toLowerCase()).toBe('label')
    const input = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(row.control).toBe(input)
    expect(Array.from(input.labels ?? [])).toEqual([row])
    expect(input.hasAttribute('aria-label')).toBe(false)
  })

  it('the phone switch row is itself the control, named by its contents', () => {
    const el = render(<RowView row={bar} ctx={ctx} />)
    const row = rowOf(el, 'toolbar-bookmarks-bar')
    expect(row.getAttribute('role')).toBe('switch')
    expect(row.hasAttribute('aria-label')).toBe(false)
    expect(row.hasAttribute('aria-labelledby')).toBe(false)
    expect(row.querySelector('.zen-settings-label')!.textContent).toBe('Show bookmarks bar')
  })
})

describe('axe over the bound rows', () => {
  /** The rules that read a control's binding: a label for every field, a name for every ARIA control, ids that resolve. */
  async function violations(el: HTMLElement): Promise<string[]> {
    const results = await axe.run(el, {
      runOnly: {
        type: 'rule',
        values: [
          'label',
          'aria-input-field-name',
          'aria-toggle-field-name',
          'aria-valid-attr-value',
          'button-name'
        ]
      },
      resultTypes: ['violations']
    })
    return results.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${String(n.target[0])}`))
  }

  it('the desktop rows: menulist, check row, text and number fields, slider – no violations', async () => {
    const el = render(<GroupList groups={groups} ctx={ctx} variant="desktop" />)
    expect(el.querySelectorAll('[role="slider"]')).toHaveLength(2)
    expect(el.querySelectorAll('input')).toHaveLength(3)
    expect(await violations(el)).toEqual([])
  })

  it('the phone rows: the slider rows with their head labels, the switch row – no violations', async () => {
    const el = render(
      <GroupList groups={[{ id: 'phone', heading: null, rows: [bar, ram, fontSize] }]} ctx={ctx} />
    )
    expect(el.querySelectorAll('[role="slider"]')).toHaveLength(2)
    expect(await violations(el)).toEqual([])
  })
})
