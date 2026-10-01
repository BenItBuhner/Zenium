// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { dispatchBackEvent, topBackSurface } from '@renderer/lib/back'
import { viewportStore } from '@renderer/lib/formFactor'
import { V2Menulist } from '../V2Menulist'

/*
 * The menulist's popup per form factor (design language v2 §9.13; §9.36 as the lead amended it
 * on #750: an anchored panel that fits is the desktop popover with 44 rows – the split is the
 * form factor's, as `translate/Menulist` draws it). A phone's finger keeps the bottom sheet of
 * radio rows; a tablet's finger, DeX and the desktop get the one anchored listbox in the chrome
 * layer, the tablet's rows at the form factor's menu row token (44) where the mouse's are 28 –
 * read from the shipped stylesheet, since happy-dom lays nothing out. On the tablet the open
 * list is the back registry's top surface, as the sheet it replaces was (§9.24: the top surface
 * answers), so the system back closes the list alone and not every popover under it.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')

/** The declarations of the first `selector {` block at the given indent, comments stripped. */
function rule(selector: string, indent = ''): string {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const at = bare.indexOf(`\n${indent}${selector} {\n`)
  if (at < 0) throw new Error(`main.css has no rule ${selector}`)
  return bare.slice(at, bare.indexOf(`\n${indent}}`, at))
}

const OPTIONS = [
  { value: 'da', label: 'Danish' },
  { value: 'nl', label: 'Dutch' },
  { value: 'en', label: 'English' }
] as const

let root: Root | null = null
let host: HTMLElement | null = null
const changed = vi.fn<(value: string) => void>()

function render(): HTMLButtonElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root!.render(<V2Menulist label="Language" value="en" options={OPTIONS} onChange={changed} />)
  )
  return host.querySelector<HTMLButtonElement>('button.zen-v2-menulist')!
}

/** Press the control and let the popup's wait for the page's cover resolve (at once with no page). */
async function open(control: HTMLElement): Promise<void> {
  await act(async () => {
    control.click()
    await Promise.resolve()
  })
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  host?.remove()
  host = null
  changed.mockClear()
})

const set = (formFactor: 'phone' | 'tablet' | 'desktop', coarse: boolean): void =>
  viewportStore.set({ ...viewportStore.get(), formFactor, coarse })

const listbox = (): HTMLElement | null =>
  document.querySelector<HTMLElement>(
    '.zen-v2-menulist-popup[role="listbox"][aria-label="Language"]'
  )
const radiogroup = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Language"]')

describe('the menulist’s popup per form factor', () => {
  it('a phone’s finger: the bottom sheet of radio rows, the control naming a dialog', async () => {
    set('phone', true)
    const control = render()
    expect(control.getAttribute('aria-haspopup')).toBe('dialog')
    await open(control)
    expect(radiogroup()).not.toBeNull()
    expect(radiogroup()!.closest('.zen-sheet')).not.toBeNull()
    expect(listbox()).toBeNull()
  })

  it.each([
    ['a tablet’s finger', 'tablet', true],
    ['DeX (a tablet with a mouse)', 'tablet', false],
    ['the desktop', 'desktop', false]
  ] as const)(
    '%s: the anchored listbox in the chrome layer, no sheet',
    async (_host, formFactor, coarse) => {
      set(formFactor, coarse)
      const control = render()
      expect(control.getAttribute('aria-haspopup')).toBe('listbox')
      await open(control)
      const list = listbox()
      expect(list).not.toBeNull()
      expect(list!.classList.contains('zen-v2-panel')).toBe(true)
      expect(list!.closest('.zen-sheet')).toBeNull()
      expect(radiogroup()).toBeNull()
      const rows = [
        ...list!.querySelectorAll<HTMLElement>('.zen-v2-menulist-option[role="option"]')
      ]
      expect(rows.map((row) => row.textContent)).toEqual(['Danish', 'Dutch', 'English'])
      expect(rows.filter((row) => row.getAttribute('aria-selected') === 'true').length).toBe(1)
      // A pick closes the list and changes the value, as on every host.
      act(() => rows[0].click())
      expect(changed).toHaveBeenCalledWith('da')
      expect(listbox()).toBeNull()
    }
  )

  it('on the tablet the open list is the back registry’s top surface and the system back closes it alone', async () => {
    set('tablet', true)
    const control = render()
    expect(topBackSurface()).toBeNull()
    await open(control)
    expect(topBackSurface()?.name).toBe('menulist')
    expect(dispatchBackEvent('commit')).toBe(true)
    await act(async () => {
      await Promise.resolve()
    })
    expect(listbox()).toBeNull()
    expect(control.hasAttribute('aria-expanded')).toBe(false)
    expect(changed).not.toHaveBeenCalled()
    expect(topBackSurface()).toBeNull()
  })
})

describe('the popover’s rows per form factor (main.css)', () => {
  it('the mouse’s row is 28; the tablet’s is the form factor’s menu row token, 44 at the 20 body line', () => {
    expect(rule('.zen-v2-menulist-option')).toContain('\n  min-height: 28px;')
    const tablet = rule(":root[data-form-factor='tablet'] .zen-v2-menulist-option")
    expect(tablet).toContain('\n  min-height: var(--v2-menu-row);')
    // The token on the tablet: the body line box plus 24 – 44 (§9.36's rows), as the menus'.
    expect(rule(":root[data-form-factor='tablet']")).toContain(
      '\n  --v2-menu-row: calc(var(--v2-line-body-box) + 24px);'
    )
    expect(css).toContain('\n  --v2-line-body: 20px;')
    // No such override for the phone (its list is the sheet) or the desktop.
    expect(css).not.toMatch(/data-form-factor='phone'\] \.zen-v2-menulist-option/)
    expect(css).not.toMatch(/data-form-factor='desktop'\] \.zen-v2-menulist-option/)
  })
})
