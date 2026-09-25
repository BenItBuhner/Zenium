// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIState } from '@shared/types'
import { extensionControlled } from '../controlled'
import type { RowControl, SliderRow, ValueRow } from '../model'
import { RowView } from '../rows'

/*
 * A row whose setting an extension holds (`RowBase.controlled`; Chrome's extension-controlled
 * indicator, chrome://settings' `extension-controlled-indicator`): the row is drawn as a
 * dependent row – its control disabled, the row at §9.30's one .4, no press – and the
 * indicator row stands under it in full ink, the way out: "Controlled by <name>", the 16 px
 * puzzle glyph trailing (§10.4: a lone status row trails its glyph, never leading in a group
 * whose other rows carry none) and Disable – the desktop's 32 secondary button after the
 * glyph, the phone's whole row. Disable goes through the host's own path, the one the
 * Extensions page's switch takes (`extension.setEnabled`), and the row re-enables through the
 * same state once the host has dropped the extension's layer. Nothing confirms: disabling an
 * extension destroys nothing, and Chrome's button asks nothing either.
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
})

const ctx = { open: () => undefined }

const EXTENSION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function control(onDisable = (): void => undefined): RowControl {
  return { extensionId: EXTENSION, name: 'Advanced Font Settings', onDisable }
}

function standardFont(controlled?: RowControl): ValueRow {
  return {
    kind: 'value',
    id: 'fonts-standard',
    label: 'Standard font',
    value: 'Inter',
    options: [
      { value: '', label: 'System default' },
      { value: 'Inter', label: 'Inter' }
    ],
    controlled,
    onChange: () => undefined
  }
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

describe('a row an extension holds (RowBase.controlled)', () => {
  it('on the desktop the held row is the dependent row with its menulist disabled, and the indicator row under it names the extension, trails the puzzle glyph and the Disable button', () => {
    const onDisable = vi.fn()
    const el = render(
      <RowView row={standardFont(control(onDisable))} ctx={ctx} variant="desktop" />
    )
    const rows = [...el.querySelectorAll<HTMLElement>('[data-row]')].map((r) =>
      r.getAttribute('data-row')
    )
    expect(rows).toEqual(['fonts-standard', 'fonts-standard-controlled'])

    // The held row: the row's .4 once (§9.30), its control disabled for what it does, the row
    // still the static control row it was, with the user's own value in it.
    const held = el.querySelector<HTMLElement>('[data-row="fonts-standard"]')!
    expect(held.classList.contains('zen-settings-row-disabled')).toBe(true)
    expect(held.classList.contains('zen-settings-control-row')).toBe(true)
    const menulist = held.querySelector<HTMLButtonElement>('.zen-v2-menulist')!
    expect(menulist.disabled).toBe(true)
    expect(menulist.textContent).toContain('Inter')

    // The indicator row: full ink (no disabled class), static, the label the way out.
    const indicator = el.querySelector<HTMLElement>('[data-row="fonts-standard-controlled"]')!
    expect(indicator.classList.contains('zen-settings-row-disabled')).toBe(false)
    expect(indicator.classList.contains('zen-settings-control-row')).toBe(true)
    expect(indicator.hasAttribute('data-static')).toBe(true)
    expect(indicator.querySelector('.zen-settings-label')?.textContent).toBe(
      'Controlled by Advanced Font Settings'
    )
    expect(indicator.querySelector('.zen-settings-description')).toBeNull()
    // The glyph trails in the trailing slot, before the button (§10.4's lone status row): a
    // direct child of the slot, so the slot's 16 px rule sizes it; hidden from readers.
    const trailing = indicator.querySelector<HTMLElement>('.zen-settings-trailing')!
    const parts = [...trailing.children].map((c) => c.tagName.toLowerCase())
    expect(parts).toEqual(['svg', 'button'])
    expect(trailing.children[0].getAttribute('aria-hidden')).toBe('true')
    expect(trailing.children[0].classList.contains('lucide-puzzle')).toBe(true)
    // The button: the 32 secondary, enabled, named for the extension it disables.
    const button = trailing.querySelector<HTMLButtonElement>('button.zen-v2-button')!
    expect(button.textContent).toBe('Disable')
    expect(button.getAttribute('aria-label')).toBe('Disable Advanced Font Settings')
    expect(button.disabled).toBe(false)
    // The secondary form: neither the primary nor the danger ink (disabling destroys nothing).
    expect(button.hasAttribute('data-primary')).toBe(false)
    expect(button.hasAttribute('data-danger')).toBe(false)
    act(() => button.click())
    expect(onDisable).toHaveBeenCalledTimes(1)
  })

  it('on the phone the held row takes no press and the indicator row is the whole-row target, its description saying what the press does', () => {
    const onDisable = vi.fn()
    const el = render(<RowView row={fontSize(control(onDisable))} ctx={ctx} />)
    const held = el.querySelector<HTMLElement>('[data-row="fonts-size-phone"]')!
    expect(held.classList.contains('zen-settings-row-disabled')).toBe(true)
    expect(held.querySelector('.zen-zoom-slider')?.hasAttribute('data-disabled')).toBe(true)

    const indicator = el.querySelector<HTMLButtonElement>(
      '[data-row="fonts-size-phone-controlled"]'
    )!
    expect(indicator.tagName.toLowerCase()).toBe('button')
    expect(indicator.classList.contains('zen-settings-row-pressable')).toBe(true)
    expect(indicator.hasAttribute('aria-disabled')).toBe(false)
    expect(indicator.querySelector('.zen-settings-label')?.textContent).toBe(
      'Controlled by Advanced Font Settings'
    )
    expect(indicator.querySelector('.zen-settings-description')?.textContent).toBe(
      'Disables Advanced Font Settings so you can set this yourself.'
    )
    // No inline button on the phone (§10.4): the glyph alone trails, and the row is the press.
    expect(indicator.querySelector('button')).toBeNull()
    const trailing = indicator.querySelector<HTMLElement>('.zen-settings-trailing')!
    expect([...trailing.children].map((c) => c.tagName.toLowerCase())).toEqual(['svg'])
    act(() => indicator.click())
    expect(onDisable).toHaveBeenCalledTimes(1)
  })

  it('an uncontrolled row is itself: enabled, one row, no indicator', () => {
    const el = render(<RowView row={standardFont()} ctx={ctx} variant="desktop" />)
    expect([...el.querySelectorAll('[data-row]')]).toHaveLength(1)
    const row = el.querySelector<HTMLElement>('[data-row="fonts-standard"]')!
    expect(row.classList.contains('zen-settings-row-disabled')).toBe(false)
    expect(row.querySelector<HTMLButtonElement>('.zen-v2-menulist')?.disabled).toBe(false)
    expect(el.textContent).not.toContain('Controlled by')
    // The phone's form the same.
    act(() => root?.render(<RowView row={fontSize()} ctx={ctx} />))
    expect([...el.querySelectorAll('[data-row]')]).toHaveLength(1)
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

describe('extensionControlled (the state to the row property)', () => {
  function state(controls: UIState['extensionControls']): UIState {
    return { extensionControls: controls } as unknown as UIState
  }

  it('is nothing while no extension holds the key', () => {
    expect(extensionControlled(state({}), 'fonts.standard')).toBeUndefined()
    const held = state({ 'fonts.size': { extensionId: EXTENSION, name: 'Advanced Font Settings' } })
    expect(extensionControlled(held, 'fonts.standard')).toBeUndefined()
  })

  it("carries the extension's id and name, and its Disable takes the Extensions page's path (extension.setEnabled)", () => {
    const held = state({
      'fonts.standard': { extensionId: EXTENSION, name: 'Advanced Font Settings' }
    })
    const control = extensionControlled(held, 'fonts.standard')!
    expect(control).toMatchObject({ extensionId: EXTENSION, name: 'Advanced Font Settings' })
    control.onDisable()
    expect(invoke).toHaveBeenCalledWith('extension.setEnabled', {
      id: EXTENSION,
      enabled: false
    })
  })
})
