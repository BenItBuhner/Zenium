// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { uiStore } from '@renderer/lib/ui'
import type { ActionRow } from '../model'
import { RowView, type RowContext } from '../rows'

/*
 * The desktop action button that hangs a popover from itself (`ActionRow.popover`; W8-3's theme
 * row, the lead's ruling on #572's notes 16–19): the anchor of a dialog popup –
 * `aria-haspopup="dialog"` – whose `aria-expanded` is true for as long as its overlay is open
 * from an anchor and false otherwise, so the chassis's `[aria-haspopup][aria-expanded='true']`
 * keeps the pressed fill on it while the popover hangs there (§9.20; main.css beside the
 * primitive). The same overlay open at its seat – the space menu's, the palette's – expands no
 * button. A button without `popover` is as it was: `aria-haspopup` for a confirmation, a form
 * or a prompting action, no `aria-expanded` on any of them.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const css = readFileSync(resolve(__dirname, '../../../../assets/main.css'), 'utf8')

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
  uiStore.set({ overlay: 'none', overlaySpaceId: null, overlayAnchor: null })
})

const ctx: RowContext = { open: vi.fn() }
const anchor = {
  x: 1000,
  y: 240,
  width: 88,
  height: 32,
  column: { x: 400, y: 0, width: 1200, height: 1000 }
}

function themeRow(patch: Partial<ActionRow> = {}): ActionRow {
  return {
    kind: 'action',
    id: 'theme',
    label: 'Theme',
    description: 'Default · Personal space',
    button: 'Change…',
    popover: 'theme',
    onPress: vi.fn(),
    ...patch
  }
}

const button = (el: HTMLElement): HTMLButtonElement =>
  el.querySelector<HTMLButtonElement>('button.zen-v2-button')!

describe('the popover anchor button (ActionRow.popover, §9.20)', () => {
  it('is a dialog popup’s anchor at rest – aria-haspopup="dialog", aria-expanded="false" – on the row’s trailing 32 button', () => {
    const el = render(<RowView row={themeRow()} ctx={ctx} variant="desktop" />)
    const b = button(el)
    expect(b.textContent).toBe('Change…')
    expect(b.getAttribute('aria-haspopup')).toBe('dialog')
    expect(b.getAttribute('aria-expanded')).toBe('false')
    expect(b.classList.contains('zen-v2-button')).toBe(true)
  })

  it('expands while its overlay is open from an anchor, and only then: the picker open at its seat (no anchor) or another overlay leaves it collapsed', () => {
    const el = render(<RowView row={themeRow()} ctx={ctx} variant="desktop" />)
    const b = button(el)
    act(() => uiStore.set({ overlay: 'theme', overlaySpaceId: 'space', overlayAnchor: anchor }))
    expect(b.getAttribute('aria-expanded')).toBe('true')
    act(() => uiStore.set({ overlay: 'none', overlayAnchor: null }))
    expect(b.getAttribute('aria-expanded')).toBe('false')
    // Seated – opened from the space menu or the palette – the picker hangs from nothing.
    act(() => uiStore.set({ overlay: 'theme', overlayAnchor: null }))
    expect(b.getAttribute('aria-expanded')).toBe('false')
    // Another overlay's anchor is not this button's.
    act(() => uiStore.set({ overlay: 'space-editor', overlayAnchor: anchor }))
    expect(b.getAttribute('aria-expanded')).toBe('false')
  })

  it('presses as the row’s button always did – onPress with the button’s own anchor (its box and column) – and keeps the row’s disabled and busy states', () => {
    const onPress = vi.fn()
    const el = render(<RowView row={themeRow({ onPress })} ctx={ctx} variant="desktop" />)
    act(() => button(el).click())
    expect(onPress).toHaveBeenCalledTimes(1)
    const passed = onPress.mock.calls[0][0]
    expect(passed).toMatchObject({ element: button(el) })
    expect(typeof passed.x).toBe('number')
    expect(typeof passed.width).toBe('number')
    act(() => root?.unmount())
    const disabled = render(
      <RowView row={themeRow({ disabled: true })} ctx={ctx} variant="desktop" />
    )
    expect(button(disabled).disabled).toBe(true)
    act(() => root?.unmount())
    const busy = render(<RowView row={themeRow({ busy: true })} ctx={ctx} variant="desktop" />)
    expect(button(busy).getAttribute('aria-busy')).toBe('true')
  })

  it('a button without popover is as it was: aria-haspopup for a confirmation, none for a plain action, and never aria-expanded', () => {
    const plain = render(
      <RowView
        row={themeRow({ popover: undefined, button: 'Reset to default' })}
        ctx={ctx}
        variant="desktop"
      />
    )
    expect(button(plain).getAttribute('aria-haspopup')).toBeNull()
    expect(button(plain).hasAttribute('aria-expanded')).toBe(false)
    act(() => root?.unmount())
    const confirming = render(
      <RowView
        row={themeRow({
          popover: undefined,
          button: 'Clear…',
          confirm: { title: 'Clear?', action: 'Clear' }
        })}
        ctx={ctx}
        variant="desktop"
      />
    )
    expect(button(confirming).getAttribute('aria-haspopup')).toBe('dialog')
    expect(button(confirming).hasAttribute('aria-expanded')).toBe(false)
    act(() => uiStore.set({ overlay: 'theme', overlayAnchor: anchor }))
    expect(button(confirming).hasAttribute('aria-expanded')).toBe(false)
  })

  it("the chassis paints the anchor’s pressed fill while it is expanded: .zen-v2-button[aria-haspopup][aria-expanded='true'] takes the primitive’s pressed --v2-fill-hover, unlayered beside the primitive, with the phone keeping the rest fill", () => {
    const rule = css.match(
      /\n\.zen-v2-button\[aria-haspopup\]\[aria-expanded='true'\] \{([^}]*)\}/
    )?.[1]
    expect(rule).toBeDefined()
    expect(rule).toMatch(/background: var\(--v2-fill-hover\);/)
    expect(rule).not.toMatch(/transform/)
    const phone = css.match(
      /\n\[data-form-factor='phone'\] \.zen-v2-button\[aria-haspopup\]\[aria-expanded='true'\] \{([^}]*)\}/
    )?.[1]
    expect(phone).toMatch(/background: var\(--v2-fill\);/)
    // The primitive's own pressed fill is the same token: the lit anchor reads as a held press.
    const pressed = css.match(/\n\.zen-v2-button:active:not\(:disabled\) \{([^}]*)\}/)?.[1]
    expect(pressed).toMatch(/background: var\(--v2-fill-hover\);/)
    // Both rules stand at column 0 – outside every @layer, as the primitive's note demands.
    expect(css).toMatch(/\n\.zen-v2-button\[aria-haspopup\]\[aria-expanded='true'\] \{/)
  })
})
