// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIState } from '@shared/types'
import { browserStore } from '@renderer/lib/browserStore'
import { extensionRevealStore } from '@renderer/lib/extensions/manage'
import { extensionControlled } from '../controlled'
import {
  controlledRuns,
  type RowControl,
  type RowGroup,
  type SliderRow,
  type ValueRow
} from '../model'
import { GroupList, RowView } from '../rows'

/*
 * A row whose setting an extension holds (`RowBase.controlled`; Chrome's extension-controlled
 * indicator, chrome://settings' `extension-controlled-indicator`; the design language's §10.5
 * controlled-setting primitive, minted on #500's gate): the row is drawn as a dependent row –
 * its control disabled showing the value in effect, the row at §9.30's one .4, no press – and
 * the indicator row stands after it in full ink, the way out: "Controlled by <name>" over "An
 * extension sets this. Disable it to use your own value.", trailing ONE control (§9.18, §10.4:
 * no glyph beside it – the words carry what the puzzle glyph said). On the desktop the control
 * is the 32 secondary button reading Disable, which goes through the host's own path, the one
 * the Extensions page's switch takes (`extension.setEnabled`); on the phone the row is a §10.4
 * action row with a chevron opening the extension's own page, where its switch is
 * (`manageExtension`) – never an inline button, never a row that disables on a tap. Consecutive
 * rows the same extension holds share one indicator after the run, its words "An extension
 * sets these."; a held row an unheld one separates from the run gets its own. The row
 * re-enables through the same state once the host has dropped the extension's layer. Nothing
 * confirms: disabling an extension destroys nothing, and Chrome's button asks nothing either.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

let root: Root | null = null
let host: HTMLElement | null = null

function render(element: ReactElement): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root?.render(element))
  return host
}

beforeEach(() => invoke.mockClear())

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  browserStore.set({ state: null })
  extensionRevealStore.set({ id: null })
})

const ctx = { open: () => undefined }

const EXTENSION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const SINGLE = 'An extension sets this. Disable it to use your own value.'
const RUN = 'An extension sets these.'

function control(
  onDisable = (): void => undefined,
  onManage = (): void => undefined,
  extensionId = EXTENSION,
  name = 'Advanced Font Settings'
): RowControl {
  return { extensionId, name, onDisable, onManage }
}

function family(id: string, label: string, controlled?: RowControl): ValueRow {
  return {
    kind: 'value',
    id,
    label,
    value: 'Inter',
    options: [
      { value: '', label: 'System default' },
      { value: 'Inter', label: 'Inter' }
    ],
    controlled,
    onChange: () => undefined
  }
}

function standardFont(controlled?: RowControl): ValueRow {
  return family('fonts-standard', 'Standard font', controlled)
}

function fontSize(controlled?: RowControl): SliderRow {
  return {
    kind: 'slider',
    id: 'fonts-size-phone',
    label: 'Font size',
    value: 3,
    min: 0,
    max: 10,
    step: 1,
    format: (v) => `${12 + v} px`,
    controlled,
    onChange: () => undefined
  }
}

function rowIds(el: HTMLElement): string[] {
  return [...el.querySelectorAll<HTMLElement>('[data-row]')].map((r) => r.getAttribute('data-row')!)
}

describe('a row an extension holds (RowBase.controlled)', () => {
  it('on the desktop the held row is the dependent row with its menulist disabled, and the indicator row after it names the extension, says what an extension does and trails the Disable button alone', () => {
    const onDisable = vi.fn()
    const onManage = vi.fn()
    const el = render(
      <RowView row={standardFont(control(onDisable, onManage))} ctx={ctx} variant="desktop" />
    )
    expect(rowIds(el)).toEqual(['fonts-standard', 'fonts-standard-controlled'])

    // The held row: the row's .4 once (§9.30), its control disabled for what it does, the row
    // still the static control row it was, with the value in effect in it.
    const held = el.querySelector<HTMLElement>('[data-row="fonts-standard"]')!
    expect(held.classList.contains('zen-settings-row-disabled')).toBe(true)
    expect(held.classList.contains('zen-settings-control-row')).toBe(true)
    const menulist = held.querySelector<HTMLButtonElement>('.zen-v2-menulist')!
    expect(menulist.disabled).toBe(true)
    expect(menulist.textContent).toContain('Inter')

    // The indicator row: full ink (no disabled class), static, the label the way out and the
    // description saying what an extension does – the word extension in the description, the
    // name as the extension names itself in the label, sentence case throughout.
    const indicator = el.querySelector<HTMLElement>('[data-row="fonts-standard-controlled"]')!
    expect(indicator.classList.contains('zen-settings-row-disabled')).toBe(false)
    expect(indicator.classList.contains('zen-settings-control-row')).toBe(true)
    expect(indicator.hasAttribute('data-static')).toBe(true)
    expect(indicator.querySelector('.zen-settings-label')?.textContent).toBe(
      'Controlled by Advanced Font Settings'
    )
    expect(indicator.querySelector('.zen-settings-description')?.textContent).toBe(SINGLE)
    // One trailing control (§9.18, §10.4): the button alone in the slot – no glyph before it.
    const trailing = indicator.querySelector<HTMLElement>('.zen-settings-trailing')!
    expect([...trailing.children].map((c) => c.tagName.toLowerCase())).toEqual(['button'])
    expect(indicator.querySelector('svg')).toBeNull()
    expect(el.querySelector('.lucide-puzzle')).toBeNull()
    // The button: the 32 secondary reading Disable – its object is the row's subject and the
    // description's "it" – named for the extension for a reader, since a page may hold several.
    const button = trailing.querySelector<HTMLButtonElement>('button.zen-v2-button')!
    expect(button.textContent).toBe('Disable')
    expect(button.getAttribute('aria-label')).toBe('Disable Advanced Font Settings')
    expect(button.disabled).toBe(false)
    // The secondary form: neither the primary nor the danger ink (disabling destroys nothing).
    expect(button.hasAttribute('data-primary')).toBe(false)
    expect(button.hasAttribute('data-danger')).toBe(false)
    act(() => button.click())
    expect(onDisable).toHaveBeenCalledTimes(1)
    expect(onManage).not.toHaveBeenCalled()
  })

  it('on the phone the held row takes no press and the indicator row is a §10.4 action row with a chevron, opening the extension’s own page – no inline button, no disabling on a tap', () => {
    const onDisable = vi.fn()
    const onManage = vi.fn()
    const el = render(<RowView row={fontSize(control(onDisable, onManage))} ctx={ctx} />)
    expect(rowIds(el)).toEqual(['fonts-size-phone', 'fonts-size-phone-controlled'])
    const held = el.querySelector<HTMLElement>('[data-row="fonts-size-phone"]')!
    expect(held.classList.contains('zen-settings-row-disabled')).toBe(true)
    expect(held.querySelector('.zen-zoom-slider')?.hasAttribute('data-disabled')).toBe(true)
    // The value in effect stays on the row's label line.
    expect(held.querySelector('.zen-settings-slider-value')?.textContent).toBe('15 px')

    const indicator = el.querySelector<HTMLButtonElement>(
      '[data-row="fonts-size-phone-controlled"]'
    )!
    expect(indicator.tagName.toLowerCase()).toBe('button')
    expect(indicator.classList.contains('zen-settings-row-pressable')).toBe(true)
    expect(indicator.hasAttribute('aria-disabled')).toBe(false)
    expect(indicator.querySelector('.zen-settings-label')?.textContent).toBe(
      'Controlled by Advanced Font Settings'
    )
    expect(indicator.querySelector('.zen-settings-description')?.textContent).toBe(SINGLE)
    // The row leaves for the extension's page: the 16 px chevron alone trails (§10.4), no
    // inline button, no puzzle glyph.
    expect(indicator.querySelector('button')).toBeNull()
    const trailing = indicator.querySelector<HTMLElement>('.zen-settings-trailing')!
    const glyphs = [...trailing.children]
    expect(glyphs.map((c) => c.tagName.toLowerCase())).toEqual(['svg'])
    expect(glyphs[0]!.classList.contains('lucide-chevron-right')).toBe(true)
    expect(glyphs[0]!.getAttribute('aria-hidden')).toBe('true')
    expect(el.querySelector('.lucide-puzzle')).toBeNull()
    // The press opens the extension's page, where its switch is; it disables nothing itself.
    act(() => indicator.click())
    expect(onManage).toHaveBeenCalledTimes(1)
    expect(onDisable).not.toHaveBeenCalled()
  })

  it('an uncontrolled row is itself: enabled, one row, no indicator', () => {
    const el = render(<RowView row={standardFont()} ctx={ctx} variant="desktop" />)
    expect(rowIds(el)).toEqual(['fonts-standard'])
    const row = el.querySelector<HTMLElement>('[data-row="fonts-standard"]')!
    expect(row.classList.contains('zen-settings-row-disabled')).toBe(false)
    expect(row.querySelector<HTMLButtonElement>('.zen-v2-menulist')?.disabled).toBe(false)
    expect(el.textContent).not.toContain('Controlled by')
    // The phone's form the same.
    act(() => root?.render(<RowView row={fontSize()} ctx={ctx} />))
    expect(rowIds(el)).toEqual(['fonts-size-phone'])
    expect(el.querySelector('.zen-zoom-slider')?.hasAttribute('data-disabled')).toBe(false)
  })

  it('a row held and let go re-enables through the same property: the indicator goes with it', () => {
    const el = render(<RowView row={standardFont(control())} ctx={ctx} variant="desktop" />)
    expect(el.querySelector('[data-row="fonts-standard-controlled"]')).not.toBeNull()
    act(() => root?.render(<RowView row={standardFont()} ctx={ctx} variant="desktop" />))
    expect(el.querySelector('[data-row="fonts-standard-controlled"]')).toBeNull()
    expect(
      el
        .querySelector<HTMLElement>('[data-row="fonts-standard"]')
        ?.classList.contains('zen-settings-row-disabled')
    ).toBe(false)
  })
})

describe('one indicator row per run (controlledRuns, GroupList)', () => {
  const a = control(undefined, undefined, EXTENSION, 'Advanced Font Settings')
  const b = control(undefined, undefined, OTHER, 'Font Fingerprint Defender')

  /**
   * The fonts group with a run: the size, the minimum size and the standard face held by one
   * extension, the serif face free, the sans-serif face held by the same extension again but
   * separated from the run by the serif row, and the fixed-width face held by another.
   */
  function rows(): RowGroup['rows'] {
    return [
      family('fonts-size', 'Font size', a),
      family('fonts-minimum-size', 'Minimum font size', a),
      family('fonts-standard', 'Standard font', a),
      family('fonts-serif', 'Serif font'),
      family('fonts-sansSerif', 'Sans-serif font', a),
      family('fonts-fixed', 'Fixed-width font', b)
    ]
  }

  it('counts, per row, the run it closes: consecutive rows one extension holds are one, an unheld row or another extension’s ends a run', () => {
    expect(controlledRuns(rows())).toEqual([0, 0, 3, 0, 1, 1])
    // No held row, no indicator; one held row, its own; two extensions side by side, one each.
    expect(controlledRuns([family('x', 'X'), family('y', 'Y')])).toEqual([0, 0])
    expect(controlledRuns([family('x', 'X', a)])).toEqual([1])
    expect(controlledRuns([family('x', 'X', a), family('y', 'Y', b)])).toEqual([1, 1])
    expect(controlledRuns([family('x', 'X', a), family('y', 'Y', a)])).toEqual([0, 2])
    expect(controlledRuns([])).toEqual([])
  })

  it('draws one "Controlled by" row after the run, its words plural, and a row of its own for a held row an unheld one separates from the run or another extension holds', () => {
    const group: RowGroup = { id: 'fonts', heading: 'Customise fonts', rows: rows() }
    const el = render(<GroupList groups={[group]} ctx={ctx} variant="desktop" />)
    expect(rowIds(el)).toEqual([
      'fonts-size',
      'fonts-minimum-size',
      'fonts-standard',
      'fonts-standard-controlled',
      'fonts-serif',
      'fonts-sansSerif',
      'fonts-sansSerif-controlled',
      'fonts-fixed',
      'fonts-fixed-controlled'
    ])
    // Every held row is the dependent row, the free one and the indicators in full ink.
    const disabled = [...el.querySelectorAll<HTMLElement>('.zen-settings-row-disabled')].map((r) =>
      r.getAttribute('data-row')
    )
    expect(disabled).toEqual([
      'fonts-size',
      'fonts-minimum-size',
      'fonts-standard',
      'fonts-sansSerif',
      'fonts-fixed'
    ])
    const text = (id: string, part: 'label' | 'description'): string | undefined =>
      el.querySelector(`[data-row="${id}"] .zen-settings-${part}`)?.textContent ?? undefined
    // The run's one row, after its last row, in the plural.
    expect(text('fonts-standard-controlled', 'label')).toBe('Controlled by Advanced Font Settings')
    expect(text('fonts-standard-controlled', 'description')).toBe(RUN)
    // The separated row's own, in the singular; the other extension's, under its own name.
    expect(text('fonts-sansSerif-controlled', 'label')).toBe('Controlled by Advanced Font Settings')
    expect(text('fonts-sansSerif-controlled', 'description')).toBe(SINGLE)
    expect(text('fonts-fixed-controlled', 'label')).toBe('Controlled by Font Fingerprint Defender')
    expect(text('fonts-fixed-controlled', 'description')).toBe(SINGLE)
    // Three indicators, three Disable buttons, each named for its extension; no glyph anywhere.
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('button.zen-v2-button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['Disable', 'Disable', 'Disable'])
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Disable Advanced Font Settings',
      'Disable Advanced Font Settings',
      'Disable Font Fingerprint Defender'
    ])
    expect(el.querySelector('.lucide-puzzle')).toBeNull()
    // (The menulists' own chevrons are the held rows'; the indicator rows carry no glyph.)
    expect(el.querySelectorAll('[data-row$="-controlled"] svg')).toHaveLength(0)
  })

  it('on the phone the run’s one row is the chevron row too', () => {
    const group: RowGroup = { id: 'fonts', heading: 'Customise fonts', rows: rows() }
    const el = render(<GroupList groups={[group]} ctx={ctx} />)
    const indicators = [...el.querySelectorAll<HTMLElement>('[data-row$="-controlled"]')]
    expect(indicators.map((r) => r.getAttribute('data-row'))).toEqual([
      'fonts-standard-controlled',
      'fonts-sansSerif-controlled',
      'fonts-fixed-controlled'
    ])
    for (const indicator of indicators) {
      expect(indicator.tagName.toLowerCase()).toBe('button')
      expect(indicator.querySelector('button')).toBeNull()
      expect(
        indicator.querySelector('.zen-settings-trailing svg.lucide-chevron-right')
      ).not.toBeNull()
    }
    expect(indicators[0]!.querySelector('.zen-settings-description')?.textContent).toBe(RUN)
    expect(indicators[1]!.querySelector('.zen-settings-description')?.textContent).toBe(SINGLE)
  })

  it('a row drawn alone (a search result) carries its own indicator whatever its neighbours were', () => {
    const el = render(
      <RowView
        row={family('fonts-size', 'Font size', a)}
        ctx={ctx}
        caption="Appearance › Customise fonts"
        variant="desktop"
      />
    )
    expect(rowIds(el)).toEqual(['fonts-size', 'fonts-size-controlled'])
    expect(
      el.querySelector('[data-row="fonts-size-controlled"] .zen-settings-description')?.textContent
    ).toBe(SINGLE)
  })
})

describe('extensionControlled (the state to the row property)', () => {
  function state(controls: UIState['extensionControls']): UIState {
    return { extensionControls: controls } as unknown as UIState
  }

  it('is nothing while no extension holds the key', () => {
    expect(extensionControlled(state({}), 'fonts.standard')).toBeUndefined()
    const held = state({ 'fonts.size': { extensionId: EXTENSION, name: 'Advanced Font Settings' } })
    expect(extensionControlled(held, 'fonts.standard')).toBeUndefined()
  })

  it("carries the extension's id, name and value, and its Disable takes the Extensions page's path (extension.setEnabled)", () => {
    const held = state({
      'fonts.standard': { extensionId: EXTENSION, name: 'Advanced Font Settings', value: 'Inter' }
    })
    const control = extensionControlled(held, 'fonts.standard')!
    expect(control).toMatchObject({
      extensionId: EXTENSION,
      name: 'Advanced Font Settings',
      value: 'Inter'
    })
    control.onDisable()
    expect(invoke).toHaveBeenCalledWith('extension.setEnabled', {
      id: EXTENSION,
      enabled: false
    })
  })

  it("its Manage is “Manage extension”: Settings › Extensions with the extension's details – its switch – asked for (extensionRevealStore)", () => {
    // A phone's browser state: Settings is a page tab there (`capabilities.pageTabs`).
    browserStore.set({
      state: {
        capabilities: { pageTabs: true },
        tabs: {},
        spaces: [{ id: 's', tabIds: [], activeTabId: null }],
        activeSpaceId: 's'
      } as unknown as UIState
    })
    const held = state({
      'fonts.standard': { extensionId: EXTENSION, name: 'Advanced Font Settings' }
    })
    extensionControlled(held, 'fonts.standard')!.onManage()
    expect(invoke).toHaveBeenCalledWith('page.open', { id: 'settings', section: 'extensions' })
    expect(invoke).not.toHaveBeenCalledWith('extension.setEnabled', expect.anything())
    expect(extensionRevealStore.get().id).toBe(EXTENSION)
  })
})
