// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { V2CheckRow } from '../../../extensions/v2'
import { Checkbox } from '../../../siteControls/primitives'
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
 * check-row primitive does for a box nested in its dimmed content (`.zen-v2-check-row > *
 * .zen-v2-checkbox:disabled { opacity: 1 }`) and the translate pane's rules do for theirs. A box
 * that is the check row's own child is the other way round: it is one of the children the row's
 * rule dims, so it goes to .4 with its label and no rule holds it at 1 – the lead's 15 on #572,
 * §9.30 as amended there; the blanket `.zen-v2-check-row .zen-v2-checkbox:disabled { opacity: 1 }`
 * that did is gone, and the pins below hold both forms at .4 exactly once. The Radix slider says
 * `data-disabled` rather than `:disabled` (the zoom
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

/**
 * Every rule, in file order, whose selector matches `selector` and whose declarations set
 * `property` – so a pin that injects them meets the cascade as the stylesheet has it, and a rule
 * added to it later (or one put back) reaches the pin rather than slipping past a list the pin
 * named itself.
 */
function rulesSetting(
  css: string,
  selector: RegExp,
  property: string
): { selector: string; declarations: string }[] {
  const rules: { selector: string; declarations: string }[] = []
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim()
    if (selector.test(sel) && new RegExp(`(?:^|;)\\s*${property}\\s*:`).test(m[2].trim()))
      rules.push({ selector: sel, declarations: m[2].trim() })
  }
  return rules
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
    // The desktop's check row is not a `.zen-settings-row-disabled` row: its primitive puts the
    // .4 on the row's children – the box among them, when it is the row's own child – and undoes
    // the box's own .4 only where the box sits inside a dimmed child (§9.30 as amended at #572).
    expect(declarations(css, ['.zen-v2-checkbox:disabled'])).toBe('opacity: 0.4;')
    expect(declarations(css, ['.zen-v2-check-row:has(.zen-v2-checkbox:disabled) > *'])).toBe(
      'opacity: 0.4;'
    )
    expect(declarations(css, ['.zen-v2-check-row > * .zen-v2-checkbox:disabled'])).toBe(
      'opacity: 1;'
    )
    // No rule holds a box that is the row's own child at 1 beside its label at .4 (the lead's
    // 15 on #572): the blanket descendant override is gone.
    expect(() => declarations(css, ['.zen-v2-check-row .zen-v2-checkbox:disabled'])).toThrow(
      /no rule/
    )
  })

  it('a disabled desktop check row’s box dims with its label exactly once – .4 beside .4, not 1 and not a stacked .16 – whether the box is the row’s own child or sits inside a dimmed one (§9.30, the lead’s 15 on #572)', () => {
    const css = stylesheet()
    // Every opacity rule the stylesheet keys on the check row or its box, in the file's order –
    // the three of the primitive today; one added or put back would land here too.
    const rules = rulesSetting(css, /zen-v2-check(box|-row)|zen-settings-check-row/, 'opacity')
    expect(rules.map((r) => `${r.selector} { ${r.declarations} }`)).toEqual([
      '.zen-v2-checkbox:disabled { opacity: 0.4; }',
      '.zen-v2-check-row:has(.zen-v2-checkbox:disabled) > * { opacity: 0.4; }',
      '.zen-v2-check-row > * .zen-v2-checkbox:disabled { opacity: 1; }'
    ])
    const sheet = document.createElement('style')
    sheet.textContent = rules.map((r) => `${r.selector} { ${r.declarations} }`).join('\n')
    document.head.appendChild(sheet)
    // happy-dom reports a property no rule set as '' – the initial 1 for opacity.
    const opacity = (e: Element): number => parseFloat(getComputedStyle(e).opacity || '1')
    // The opacity each rule that reaches `e` declares. happy-dom ranks the row's `:has()` rule
    // above a descendant rule of the same class count, where Chromium ties them at (0,3,0) and
    // lets the later one win – how the blanket override held the box at 1 in the stills – so the
    // computed number alone would not see that override put back; the rules that match the
    // element, read by `matches()`, do, in either engine.
    const reaching = (e: Element): string[] =>
      rules.filter((r) => e.matches(r.selector)).map((r) => r.declarations)
    // What the eye gets: the element's opacity multiplied up the tree to the row, inclusive.
    const effective = (e: Element, row: Element): number => {
      let product = 1
      for (let node: Element | null = e; node; node = node.parentElement) {
        product *= opacity(node)
        if (node === row) break
      }
      return product
    }
    try {
      // The form the settings page draws (Appearance › Expand on hover while Expanded sidebar
      // is on; every dependent check row): the box is the label's own child, beside the text.
      const dependent: SwitchRow = {
        kind: 'switch',
        id: 'sidebar-hover-expand',
        label: 'Expand on hover',
        description: 'Widens the collapsed sidebar while the pointer rests on it.',
        checked: true,
        disabled: true,
        onChange: () => undefined
      }
      const el = render(<RowView row={dependent} ctx={ctx} variant="desktop" />)
      const row = el.querySelector<HTMLElement>('[data-row="sidebar-hover-expand"]')!
      expect(row.classList.contains('zen-v2-check-row')).toBe(true)
      const box = row.querySelector<HTMLInputElement>('.zen-v2-checkbox')!
      const text = row.querySelector<HTMLElement>('.zen-settings-row-text')!
      expect(box.disabled).toBe(true)
      expect(box.parentElement).toBe(row)
      // The box's own number and the label's are the same .4, each set once on its own element.
      expect(opacity(box)).toBe(0.4)
      expect(opacity(text)).toBe(0.4)
      expect(opacity(row)).toBe(1)
      expect(effective(box, row)).toBeCloseTo(0.4, 5)
      expect(effective(text, row)).toBeCloseTo(0.4, 5)
      expect(effective(box, row)).not.toBe(1)
      expect(effective(box, row)).not.toBeCloseTo(0.16, 2)
      // Two rules reach the row's own box – its own and the row's – and both say .4: whichever
      // an engine lets win, the box resolves to .4, and none holds it at 1 beside the label.
      expect(reaching(box)).toEqual(['opacity: 0.4;', 'opacity: 0.4;'])
      expect(reaching(text)).toEqual(['opacity: 0.4;'])
      expect(reaching(row)).toEqual([])
      // An enabled row dims nothing.
      act(() =>
        root?.render(
          <RowView row={{ ...dependent, disabled: false }} ctx={ctx} variant="desktop" />
        )
      )
      const liveRow = el.querySelector<HTMLElement>('[data-row="sidebar-hover-expand"]')!
      const liveBox = liveRow.querySelector<HTMLInputElement>('.zen-v2-checkbox')!
      expect(liveBox.disabled).toBe(false)
      expect(effective(liveBox, liveRow)).toBe(1)
      expect(effective(liveRow.querySelector('.zen-settings-row-text')!, liveRow)).toBe(1)

      // The nested form (the extensions' options rows, the sync turn-off prompt, the site
      // controls' `Checkbox`): the box sits inside the row's one content child. The child carries
      // the .4 and the box stays at 1 underneath it, so the box still reads at .4 – not .16.
      act(() =>
        root?.render(
          <V2CheckRow
            label="Allow in private windows"
            description="Held by policy."
            checked={false}
            disabled
            onChange={() => undefined}
          />
        )
      )
      const nestedRow = el.querySelector<HTMLElement>('.zen-v2-check-row')!
      const nestedBox = nestedRow.querySelector<HTMLInputElement>('.zen-v2-checkbox')!
      const nestedLabel = nestedRow.querySelector<HTMLElement>('.zen-v2-label')!
      expect(nestedBox.disabled).toBe(true)
      expect(nestedBox.parentElement).not.toBe(nestedRow)
      expect(nestedBox.parentElement!.parentElement).toBe(nestedRow)
      expect(opacity(nestedBox.parentElement!)).toBe(0.4)
      expect(opacity(nestedBox)).toBe(1)
      expect(effective(nestedBox, nestedRow)).toBeCloseTo(0.4, 5)
      expect(effective(nestedLabel, nestedRow)).toBeCloseTo(0.4, 5)
      expect(effective(nestedBox, nestedRow)).not.toBeCloseTo(0.16, 2)
      // The wrapper takes the row's .4; the box takes its own .4 and the scoped 1 that outranks
      // it (three simple selectors to two, in either engine).
      expect(reaching(nestedBox.parentElement!)).toEqual(['opacity: 0.4;'])
      expect(reaching(nestedBox)).toEqual(['opacity: 0.4;', 'opacity: 1;'])

      // The site controls' `Checkbox` (Delete browsing data's types a range cannot delete) is the
      // same nested form under a different wrapper class.
      act(() =>
        root?.render(
          <Checkbox
            label="Cached images and files"
            disabled
            data-type="cache"
            onChange={() => undefined}
          />
        )
      )
      const siteRow = el.querySelector<HTMLElement>('.zen-v2-check-row')!
      const siteBox = siteRow.querySelector<HTMLInputElement>('.zen-v2-checkbox')!
      expect(siteBox.disabled).toBe(true)
      expect(siteBox.parentElement!.parentElement).toBe(siteRow)
      expect(opacity(siteBox.parentElement!)).toBe(0.4)
      expect(opacity(siteBox)).toBe(1)
      expect(effective(siteBox, siteRow)).toBeCloseTo(0.4, 5)
      expect(effective(siteBox, siteRow)).not.toBeCloseTo(0.16, 2)
    } finally {
      sheet.remove()
    }
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
