// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { viewportStore } from '@renderer/lib/formFactor'
import { FrameDialogHost } from '@renderer/lib/portals'
import type { FieldRow, RowGroup } from '../model'
import { SheetStack } from '../sheets'

/*
 * The one-field sheet a field row opens (`FieldSheet`, §9.12 as the #348 design gate read it):
 * the sheet's header reads the field's name, so the field draws no label of its own – the title
 * is the label, `aria-labelledby` on the field – and the field is the form's first content,
 * straight under the 48 header at §9.16's 68; the row's description, or the validation message,
 * keeps its place under the field, and the footer's Cancel | Save is untouched.
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

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function groups(onCommit: FieldRow['onCommit'], description?: string): RowGroup[] {
  const row: FieldRow = {
    kind: 'field',
    id: 'homepage.url',
    label: 'Address',
    value: 'https://news.example/',
    input: 'url',
    placeholder: 'example.com',
    description,
    onCommit
  }
  return [{ id: 'home', heading: 'Home', rows: [row] }]
}

const q = <T extends HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)
const sheet = (): HTMLElement => q('.zen-sheet[role="dialog"]')!
const form = (): HTMLElement => sheet().querySelector<HTMLElement>('.zen-settings-form')!
const input = (): HTMLInputElement => form().querySelector<HTMLInputElement>('input')!
const click = (el: Element | null): void => {
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

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
  act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' }))
})

describe('the one-field sheet (§9.12)', () => {
  it('draws no label: the header title is the label, named on the field, and the field is the form’s first content', async () => {
    render(
      <FrameDialogHost frame>
        <SheetStack
          requests={[{ kind: 'field', rowId: 'homepage.url' }]}
          groups={groups(() => undefined, 'Where the Home button goes.')}
          ctx={{ open: () => undefined }}
          closeTop={() => undefined}
        />
      </FrameDialogHost>
    )
    await settle()
    const title = sheet().querySelector<HTMLElement>('.zen-sheet-header h2.zen-sheet-title')!
    expect(title.textContent).toBe('Address')
    expect(title.id).not.toBe('')
    expect(sheet().getAttribute('aria-labelledby')).toBe(title.id)
    // No label anywhere in the form; the field names the title instead.
    expect(form().querySelector('label')).toBeNull()
    expect(form().querySelector('.zen-settings-label')).toBeNull()
    const field = input()
    expect(field.getAttribute('aria-labelledby')).toBe(title.id)
    expect(field.id).toBe('settings-field-homepage-url')
    expect(field.value).toBe('https://news.example/')
    expect(field.getAttribute('inputmode')).toBe('url')
    // The field block is the form's first child and the field the block's first: nothing above
    // it in the body, so it starts at §9.16's 68 under the grip and header.
    const block = form().firstElementChild as HTMLElement
    expect(block.classList.contains('zen-settings-field-block')).toBe(true)
    expect(block.firstElementChild).toBe(field)
    const body = sheet().querySelector<HTMLElement>('.zen-settings-sheet-body')!
    expect(body.firstElementChild).toBe(form())
    // The row's description stays under the field.
    expect(block.querySelector('.zen-settings-description')?.textContent).toBe(
      'Where the Home button goes.'
    )
    // The footer is the chassis's: Cancel | Save, the primary trailing, untouched.
    const actions = [
      ...form().querySelectorAll<HTMLButtonElement>('.zen-settings-sheet-actions > button')
    ]
    expect(actions.map((b) => b.textContent)).toEqual(['Cancel', 'Save'])
    expect(actions[1].hasAttribute('data-primary')).toBe(true)
  })

  it('a refused value shows the validation line under the field in the description’s place, still with no label', async () => {
    render(
      <FrameDialogHost frame>
        <SheetStack
          requests={[{ kind: 'field', rowId: 'homepage.url' }]}
          groups={groups(() => 'Enter a web address', 'Where the Home button goes.')}
          ctx={{ open: () => undefined }}
          closeTop={() => undefined}
        />
      </FrameDialogHost>
    )
    await settle()
    const save = [...form().querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Save'
    )!
    click(save)
    const block = input().closest<HTMLElement>('.zen-settings-field-block')!
    expect(block.querySelector('.zen-settings-validation')?.textContent).toBe('Enter a web address')
    expect(block.querySelector('.zen-settings-description')).toBeNull()
    expect(form().querySelector('label')).toBeNull()
    expect(input().getAttribute('aria-invalid')).toBe('true')
    expect(input().getAttribute('aria-labelledby')).toBe(
      sheet().querySelector('h2.zen-sheet-title')!.id
    )
  })
})
