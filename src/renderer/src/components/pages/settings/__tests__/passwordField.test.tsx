// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { viewportStore } from '@renderer/lib/formFactor'
import { FrameDialogHost } from '@renderer/lib/portals'
import { DialogStack } from '../dialogs'
import { fieldInputType, rowText, type FieldRow, type RowGroup } from '../model'
import { RowView, type RowContext } from '../rows'
import { SheetStack } from '../sheets'

/*
 * A field row whose value is a secret to keep hidden (`FieldRow.input: 'password'`; ID-32's app
 * password): the three field renderers – the phone's one-field sheet, the desktop's inline and
 * stacked field, the desktop's field dialog – draw it as a masked field (`type="password"`) in
 * the platform monospace the `secret` flag gives, the row shows its `display` in the value's
 * place, and the landing's search never reads the value.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
  return mount
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const ctx: RowContext = { open: () => undefined }

const appPassword: FieldRow = {
  kind: 'field',
  id: 'sync-webdav-password',
  label: 'App password',
  description: 'Create one under Security in the server’s personal settings.',
  display: '••••••••',
  value: 'app-pass',
  input: 'password',
  secret: true,
  onCommit: () => undefined
}

const groups: RowGroup[] = [{ id: 'sync-setup', heading: 'Set up sync', rows: [appPassword] }]

beforeEach(() => {
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

describe('a password field row (FieldRow.input: password)', () => {
  it('is the masked input type where the other kinds are text or number', () => {
    expect(fieldInputType(appPassword)).toBe('password')
    expect(fieldInputType({ ...appPassword, input: 'text' })).toBe('text')
    expect(fieldInputType({ ...appPassword, input: 'url' })).toBe('text')
    expect(fieldInputType({ ...appPassword, input: 'number' })).toBe('number')
  })

  it('the phone row shows the display in the value’s place and the search reads the display, never the value', () => {
    const el = render(<RowView row={appPassword} ctx={ctx} variant="phone" />)
    expect(el.textContent).toContain('App password')
    expect(el.textContent).toContain('••••••••')
    expect(el.textContent).not.toContain('app-pass')
    expect(rowText(appPassword)).toContain('••••••••')
    expect(rowText(appPassword)).not.toContain('app-pass')
    // Without a display – a row that holds no value yet shows its hint there – the search
    // still has the label, the description and the keywords, and the value is never read.
    const empty: FieldRow = { ...appPassword, display: undefined, value: 'app-pass' }
    expect(rowText(empty)).toContain('App password')
    expect(rowText(empty)).not.toContain('app-pass')
    // A text field's value is what the search reads, as before.
    expect(rowText({ ...appPassword, input: 'text', display: undefined })).toContain('app-pass')
  })

  it('the phone’s one-field sheet edits it in a masked field, in the platform monospace', async () => {
    act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' }))
    render(
      <FrameDialogHost frame>
        <SheetStack
          requests={[{ kind: 'field', rowId: appPassword.id }]}
          groups={groups}
          ctx={ctx}
          closeTop={() => undefined}
        />
      </FrameDialogHost>
    )
    await settle()
    const sheet = document.querySelector<HTMLElement>('.zen-sheet[role="dialog"]')!
    const field = sheet.querySelector<HTMLInputElement>('.zen-settings-form input')!
    expect(field.type).toBe('password')
    expect(field.value).toBe('app-pass')
    expect(field.classList.contains('zen-settings-secret')).toBe(true)
    expect(field.classList.contains('zen-v2-field')).toBe(true)
    expect(field.getAttribute('inputmode')).toBe('text')
    expect(sheet.querySelector('h2.zen-sheet-title')?.textContent).toBe('App password')
  })

  it('the desktop’s inline and stacked fields are masked and secret, the label for the field', () => {
    const inline = render(<RowView row={appPassword} ctx={ctx} variant="desktop" />)
    const input = inline.querySelector<HTMLInputElement>('input')!
    expect(input.type).toBe('password')
    expect(input.value).toBe('app-pass')
    expect(input.classList.contains('zen-settings-field-secret')).toBe(true)
    expect(input.classList.contains('zen-settings-field-text')).toBe(true)
    expect(inline.querySelector<HTMLLabelElement>('label.zen-settings-label')?.htmlFor).toBe(
      input.id
    )
    // The row's text is the label and the description: the value stands in the field alone.
    expect(inline.querySelector('.zen-settings-row-text')?.textContent).not.toContain('app-pass')
    act(() => root!.unmount())
    mount?.remove()

    const stacked = render(
      <RowView row={{ ...appPassword, form: 'stacked' }} ctx={ctx} variant="desktop" />
    )
    const stackedInput = stacked.querySelector<HTMLInputElement>('input')!
    expect(stackedInput.type).toBe('password')
    expect(stackedInput.classList.contains('zen-settings-field-secret')).toBe(true)
    expect(stacked.querySelector('.zen-settings-stacked-row')).not.toBeNull()
  })

  it('the desktop’s field dialog edits it in a masked field', async () => {
    render(
      <FrameDialogHost>
        <DialogStack
          requests={[{ kind: 'field', rowId: appPassword.id }]}
          groups={groups}
          ctx={ctx}
          closeTop={() => undefined}
        />
      </FrameDialogHost>
    )
    await settle()
    const dialog = document.querySelector<HTMLElement>('.zen-settings-dialog')!
    expect(dialog).not.toBeNull()
    const field = dialog.querySelector<HTMLInputElement>('input')!
    expect(field.type).toBe('password')
    expect(field.value).toBe('app-pass')
    expect(field.classList.contains('zen-settings-secret')).toBe(true)
  })
})
