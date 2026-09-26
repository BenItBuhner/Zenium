// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ActionRow, SliderRow, SwitchRow, ValueRow } from '../model'
import { RowView } from '../rows'

/*
 * A dependent row whose parent is off is drawn at §9.30's one number, .4, and takes no press
 * (§10.4). The desktop's control rows render a control that also carries `disabled` – the .4
 * that gives it, on top of the row's, compounded to .16: Settings › Downloads' Use default
 * button in #297's first capture read at .16 in light and could not be found in dark (the
 * independent review's Required 1; that row is no longer ever disabled – it appears only while a
 * folder is picked – but the shortcut rows' Up / Down and any dependent control row still are).
 * The wrapper's rule gives the nested control its 1 back – the control keeps `disabled` for what
 * it does – so every disabled action, value, slider and shortcut row dims once, the way the
 * check-row primitive's `.zen-v2-checkbox:disabled { opacity: 1 }` and the translate pane's rules
 * already do for theirs. The Radix slider says `data-disabled` rather than `:disabled` (the zoom
 * sheet's `.zen-zoom-slider[data-disabled] { opacity: .4 }`), so it is in the list by that name
 * (the desktop coordinator's nit on #297: Performance › Share of installed RAM read at .16).
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
    const dependent: ActionRow = {
      kind: 'action',
      id: 'a-dependent-action',
      label: 'A dependent action',
      button: 'Do it',
      disabled: true,
      onPress: () => undefined
    }
    const el = render(<RowView row={dependent} ctx={ctx} variant="desktop" />)
    const row = el.querySelector<HTMLElement>('[data-row="a-dependent-action"]')!
    expect(row.classList.contains('zen-settings-row-disabled')).toBe(true)
    expect(row.classList.contains('zen-settings-control-row')).toBe(true)
    expect(row.hasAttribute('data-static')).toBe(true)
    const button = row.querySelector<HTMLButtonElement>('button.zen-v2-button')!
    expect(button.textContent).toBe('Do it')
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

  it('a disabled slider row (Performance › Share of installed RAM while a memory budget is set) is the control row with the Radix slider saying data-disabled, on both shells', () => {
    const slider: SliderRow = {
      kind: 'slider',
      id: 'memory-percent',
      label: 'Share of installed RAM',
      description: 'Used when the memory budget above is 0.',
      value: 70,
      min: 5,
      max: 100,
      step: 5,
      format: (v) => `${v}%`,
      disabled: true,
      onChange: () => undefined
    }
    const el = render(<RowView row={slider} ctx={ctx} variant="desktop" />)
    const row = el.querySelector<HTMLElement>('[data-row="memory-percent"]')!
    expect(row.classList.contains('zen-settings-row-disabled')).toBe(true)
    expect(row.classList.contains('zen-settings-control-row')).toBe(true)
    // Radix puts `data-disabled` on the slider's root – what the zoom sheet's rule keys on.
    const track = row.querySelector<HTMLElement>('.zen-zoom-slider')!
    expect(track.hasAttribute('data-disabled')).toBe(true)
    // The phone's slider row is its own block, the same class and the same slider.
    act(() => root?.render(<RowView row={slider} ctx={ctx} />))
    const phoneRow = el.querySelector<HTMLElement>('[data-row="memory-percent"]')!
    expect(phoneRow.classList.contains('zen-settings-row-disabled')).toBe(true)
    expect(phoneRow.classList.contains('zen-settings-slider-row')).toBe(true)
    expect(phoneRow.querySelector('.zen-zoom-slider')?.hasAttribute('data-disabled')).toBe(true)
  })

  it('the stylesheet puts the .4 on the row and gives a disabled control inside it its 1 back, so the two never compound to .16', () => {
    const css = stylesheet()
    expect(declarations(css, ['.zen-settings-row-disabled'])).toBe('opacity: 0.4;')
    // The primitives' own disabled number, which the row's rule must undo underneath it.
    expect(declarations(css, ['.zen-v2-button:disabled'])).toBe('opacity: 0.4;')
    expect(declarations(css, ['.zen-v2-menulist:disabled'])).toBe('opacity: 0.4;')
    // The slider's own rule is a rule of its own (after a `}`), later in the file than the reset.
    expect(css).toContain('} .zen-zoom-slider[data-disabled] { opacity: 0.4; }')
    expect(
      declarations(css, [
        '.zen-settings-row-disabled .zen-v2-button:disabled',
        '.zen-settings-row-disabled .zen-v2-icon-button:disabled',
        '.zen-settings-row-disabled .zen-v2-menulist:disabled',
        '.zen-settings-row-disabled .zen-v2-field:disabled',
        '.zen-settings-row-disabled .zen-v2-switch:disabled',
        '.zen-settings-row-disabled .zen-zoom-slider[data-disabled]'
      ])
    ).toBe('opacity: 1;')
    // The row's rule outranks the slider's own by specificity (three simple selectors to two),
    // not by order: the slider's rule sits later in the file, and both are unlayered.
    const resetAt = css.indexOf('.zen-settings-row-disabled .zen-zoom-slider[data-disabled]')
    const sliderAt = css.indexOf('} .zen-zoom-slider[data-disabled] { opacity: 0.4; }')
    expect(resetAt).toBeGreaterThan(0)
    expect(sliderAt).toBeGreaterThan(resetAt)
    // The desktop's check row is not a `.zen-settings-row-disabled` row: its primitive carries
    // the same shape itself (the row's children at .4, the checkbox's own .4 undone).
    expect(declarations(css, ['.zen-v2-check-row:has(.zen-v2-checkbox:disabled) > *'])).toBe(
      'opacity: 0.4;'
    )
    expect(declarations(css, ['.zen-v2-check-row .zen-v2-checkbox:disabled'])).toBe('opacity: 1;')
  })

  it('gives a disabled row’s deemphasised parts the label’s ink, so under the .4 nothing falls to .276 (§9.30 as amended on #299)', () => {
    const css = stylesheet()
    // A dependent row's description is the way out ("Turn on Open tabs in What you sync to see
    // them."); at the 69 % ink under the row's .4 it read 1.9:1. The trailing summary is the
    // same part.
    expect(
      declarations(css, [
        '.zen-settings-row-disabled .zen-settings-description',
        '.zen-settings-row-disabled .zen-settings-summary'
      ])
    ).toBe('color: var(--v2-text);')
    // The parts' own inks, which the row's rule replaces underneath it: the description's own,
    // the summary's inherited from the trailing slot.
    expect(declarations(css, ['.zen-settings-description'])).toContain(
      'color: var(--v2-text-deemphasized);'
    )
    expect(declarations(css, ['.zen-settings-trailing'])).toContain(
      'color: var(--v2-text-deemphasized);'
    )
    // A toned description keeps its status ink: the row-tone rules are three simple selectors
    // to the disabled rule's two, so they outrank it whatever the order.
    expect(
      declarations(css, [".zen-settings-row[data-tone='warn'] .zen-settings-description"])
    ).toBe('color: var(--v2-warn);')
  })

  it('a held desktop check row (an extension’s homepage) dims once: the description reads at the row’s .4, not .276 (the lead’s rider on #508 at #572)', () => {
    // The held row as `RowView` draws it on the desktop: the check-row primitive disabled –
    // `aria-disabled` on the label, the box `disabled` – and not a `.zen-settings-row-disabled`
    // row, so the amendment above does not reach its description; the check row's own does.
    const held: SwitchRow = {
      kind: 'switch',
      id: 'show-home-button',
      label: 'Show home button',
      description: 'Opens the home page set below.',
      checked: true,
      controlled: {
        extensionId: 'ext',
        name: 'Homepage Keeper',
        value: true,
        onDisable: () => undefined,
        onManage: () => undefined
      },
      onChange: () => undefined
    }
    const css = stylesheet()
    const sheet = document.createElement('style')
    sheet.textContent = [
      ':root { --v2-text: rgb(21 20 26); --v2-text-deemphasized: rgb(21 20 26 / 0.69); }',
      `.zen-v2-check-row:has(.zen-v2-checkbox:disabled) > * { ${declarations(css, ['.zen-v2-check-row:has(.zen-v2-checkbox:disabled) > *'])} }`,
      `.zen-settings-description { ${declarations(css, ['.zen-settings-description'])} }`,
      `.zen-settings-check-row:has(.zen-v2-checkbox:disabled) .zen-settings-description { ${declarations(css, ['.zen-settings-check-row:has(.zen-v2-checkbox:disabled) .zen-settings-description'])} }`
    ].join('\n')
    document.head.appendChild(sheet)
    try {
      const el = render(<RowView row={held} ctx={ctx} variant="desktop" />)
      const row = el.querySelector<HTMLElement>('[data-row="show-home-button"]')!
      expect(row.classList.contains('zen-settings-check-row')).toBe(true)
      expect(row.classList.contains('zen-settings-row-disabled')).toBe(false)
      expect(row.getAttribute('aria-disabled')).toBe('true')
      expect(row.querySelector<HTMLInputElement>('.zen-v2-checkbox')!.disabled).toBe(true)
      const text = row.querySelector<HTMLElement>('.zen-settings-row-text')!
      const description = row.querySelector<HTMLElement>('.zen-settings-description')!
      // One number, the primitive's, on the row's content; the description adds none of its own
      // and its ink is the label's – the 69 % alpha gone – so under the .4 it reads at .4.
      // happy-dom reports a property no rule set as '' – the initial 1 for opacity.
      const opacity = (e: Element): number => parseFloat(getComputedStyle(e).opacity || '1')
      expect(opacity(text)).toBe(0.4)
      expect(opacity(description)).toBe(1)
      const alpha = (color: string): number => {
        const m = color.match(/\/\s*([\d.]+)\s*\)|rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)/)
        return m ? parseFloat(m[1] ?? m[2]) : 1
      }
      const ink = getComputedStyle(description).color
      expect(ink).toMatch(/21[, ]+20[, ]+26/)
      expect(alpha(ink)).toBe(1)
      const effective = opacity(text) * opacity(description) * alpha(ink)
      expect(effective).toBeCloseTo(0.4, 5)
      expect(effective).not.toBeCloseTo(0.276, 2)
      // The indicator row after it is the way out, full ink: its own row, not under the .4.
      const indicator = el.querySelector<HTMLElement>('[data-row="show-home-button-controlled"]')!
      expect(indicator).not.toBeNull()
      expect(indicator.closest('.zen-v2-check-row')).toBeNull()
      expect(opacity(indicator)).toBe(1)
    } finally {
      sheet.remove()
    }
  })

  it('the stylesheet keys the check row’s description rule as the primitive keys its .4, so the two cannot disagree on which row is held', () => {
    const css = stylesheet()
    expect(
      declarations(css, [
        '.zen-settings-check-row:has(.zen-v2-checkbox:disabled) .zen-settings-description'
      ])
    ).toBe('color: var(--v2-text);')
    expect(declarations(css, ['.zen-v2-check-row:has(.zen-v2-checkbox:disabled) > *'])).toBe(
      'opacity: 0.4;'
    )
  })
})
