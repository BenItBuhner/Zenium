// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PhoneSheet, type SheetFocus, type SheetTitle } from '../PhoneSheet'
import { PhoneListRow } from '../PhoneList'
import { FrameDialogHost } from '@renderer/lib/portals'
import { viewportStore } from '@renderer/lib/formFactor'

/*
 * Where the focus lands as a phone sheet opens (design language v2 draft §9.22): a list sheet on
 * its first row – `PhoneListRow`'s accessible `div[role="button"]`, which `focus="first"` reaches
 * through the mode itself, never the row's trailing `button`; a title-and-notice sheet on its
 * container (`focus="dialog"`: `role="dialog"`, `tabindex -1`, named by the title, described by
 * the paragraph), landing on Cancel being the failure the section names; a form whose first
 * control is a text field on its container too, the chassis's own exception (the keyboard must
 * not come up with the sheet), with no `focus` prop needed; a sheet whose first control is a
 * checkbox on that checkbox; a list with a current entry (`focus="checked"`) on that entry, else
 * its first row. And the container that holds the focus draws no ring: it carries the two marks
 * the shared no-ring rule keys on. Rendered for real in happy-dom on the frame's dialog host.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): void {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
}

const HEADER: SheetTitle = { pose: 'header', text: 'Recently closed' }
const BLOCK: SheetTitle = {
  pose: 'block',
  text: 'Clear all history?',
  description: '12 visits will be removed.'
}

const sheet = (title: SheetTitle, focus: SheetFocus | undefined, body: ReactNode): ReactElement => (
  <>
    <FrameDialogHost frame />
    <PhoneSheet name="test" title={title} focus={focus} onClose={() => undefined}>
      {body}
    </PhoneSheet>
  </>
)

const footer = (
  <div className="zen-sheet-footer">
    <button type="button" className="zen-v2-button">
      Cancel
    </button>
    <button type="button" className="zen-v2-button" data-primary>
      Clear all
    </button>
  </div>
)

const dialog = (): HTMLElement => document.querySelector<HTMLElement>('.zen-sheet[role="dialog"]')!
const active = (): Element | null => document.activeElement
const byText = (text: string): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent === text)!

beforeEach(() => {
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  root = null
  mount?.remove()
  mount = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
})

describe('a list sheet opens on its first row (§9.22)', () => {
  it('`first` lands on the first PhoneListRow’s accessible div[role="button"] through the mode – not on the row’s trailing button, which is the first <button> of the body', () => {
    render(
      sheet(
        HEADER,
        'first',
        <>
          <PhoneListRow
            title="Cats – Wikipedia"
            subtitle="en.wikipedia.org"
            trailing={
              <button type="button" className="zen-v2-button">
                Restore
              </button>
            }
            onTap={() => undefined}
          />
          <PhoneListRow title="Zen" subtitle="zen-browser.app" onTap={() => undefined} />
        </>
      )
    )
    const rows = [...document.querySelectorAll<HTMLElement>('.zen-list-main')]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.getAttribute('role')).toBe('button')
    expect(rows[0]!.tagName).toBe('DIV')
    expect(active()).toBe(rows[0])
    expect(active()).not.toBe(byText('Restore'))
    // The dialog's title is what the reader says ahead of the row.
    expect(dialog().getAttribute('aria-labelledby')).toBe(
      document.querySelector('h2.zen-sheet-title')!.id
    )
  })

  it('`first` passes a disabled row by (aria-disabled) for the first one that can take a press', () => {
    render(
      sheet(
        HEADER,
        'first',
        <>
          <PhoneListRow title="Gone" onTap={() => undefined} disabled />
          <PhoneListRow title="Zen" onTap={() => undefined} />
        </>
      )
    )
    const rows = [...document.querySelectorAll<HTMLElement>('.zen-list-main')]
    expect(rows[0]!.getAttribute('aria-disabled')).toBe('true')
    expect(active()).toBe(rows[1])
  })

  it('`checked` opens a list on its current entry (the PDF outline’s aria-current row), else its first row', () => {
    const outline = (current: number | null): ReactNode => (
      <div>
        {['Cover', 'Chapter 1', 'Chapter 2'].map((title, i) => (
          <button
            key={title}
            type="button"
            className="zen-v2-row"
            aria-current={current === i ? 'page' : undefined}
          >
            {title}
          </button>
        ))}
      </div>
    )
    render(sheet({ pose: 'header', text: 'Contents' }, 'checked', outline(1)))
    expect(active()).toBe(byText('Chapter 1'))
    act(() => root!.unmount())
    root = null
    render(sheet({ pose: 'header', text: 'Contents' }, 'checked', outline(null)))
    expect(active()).toBe(byText('Cover'))
  })
})

describe('a title-and-notice sheet holds its container (§9.22)', () => {
  it('`dialog` lands on the sheet itself – role dialog, tabindex −1, named by the title, described by the paragraph – never on Cancel', () => {
    render(sheet(BLOCK, 'dialog', footer))
    const el = dialog()
    expect(active()).toBe(el)
    expect(el.getAttribute('role')).toBe('dialog')
    expect(el.tabIndex).toBe(-1)
    const block = el.querySelector<HTMLElement>('.zen-sheet-title-block')!
    expect(el.getAttribute('aria-labelledby')).toBe(block.querySelector('h2')!.id)
    expect(el.getAttribute('aria-describedby')).toBe(block.querySelector('p')!.id)
    expect(active()).not.toBe(byText('Cancel'))
  })

  it('a prompt that names no focus lands on its container too: the chassis’s order knows a footer’s buttons are the way out, never the landing', () => {
    render(sheet(BLOCK, undefined, footer))
    expect(active()).toBe(dialog())
    expect(active()).not.toBe(byText('Cancel'))
  })
})

describe('the chassis’s own order for a sheet that names no focus (§9.22)', () => {
  it('a form whose first control is a text field lands on the container: the keyboard must not come up with the sheet', () => {
    render(
      sheet(
        { pose: 'header', text: 'Rename' },
        undefined,
        <>
          <div className="zen-settings-form">
            <input className="zen-v2-field" aria-label="Name" defaultValue="Zen" />
          </div>
          {footer}
        </>
      )
    )
    expect(active()).toBe(dialog())
    expect(active()).not.toBe(byText('Cancel'))
  })

  it('a sheet whose first control is a checkbox opens on it (the overview’s Close all)', () => {
    render(
      sheet(
        { pose: 'block', text: 'Close 3 tabs?', description: 'Every open tab closes.' },
        undefined,
        <>
          <label className="zen-v2-row zen-v2-check-row">
            <input type="checkbox" className="zen-v2-checkbox" />
            <span>{"Don't ask again"}</span>
          </label>
          {footer}
        </>
      )
    )
    expect(active()).toBe(document.querySelector('input[type="checkbox"]'))
  })
})

describe('the container that holds the focus draws no ring (§1, §9.22)', () => {
  it('the sheet carries the two marks the shared no-ring rule keys on, and the rule stands in main.css', () => {
    render(sheet(BLOCK, 'dialog', footer))
    const el = dialog()
    expect(el.getAttribute('role')).toBe('dialog')
    expect(el.getAttribute('tabindex')).toBe('-1')
    const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      ''
    )
    const rule =
      /:root \[role='dialog'\]\[tabindex='-1'\]:focus-visible,\s*:root \[role='alertdialog'\]\[tabindex='-1'\]:focus-visible\s*\{\s*outline: none;\s*\}/.exec(
        css
      )
    expect(rule, 'the shared no-ring rule for a container that holds the focus').not.toBeNull()
    // No sheet rule draws a ring of its own on the container: the ring is for what Tab reaches.
    expect(css).not.toMatch(/\.zen-sheet(?:\[[^\]]*\])?:focus(?:-visible)?\s*[,{]/)
  })
})
