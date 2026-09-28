// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { viewportStore } from '@renderer/lib/formFactor'
import { FrameDialogHost } from '@renderer/lib/portals'
import { DialogStack } from '../dialogs'
import type { FieldRow, RowGroup } from '../model'
import { RowView, type RowContext } from '../rows'
import { SheetStack } from '../sheets'

/*
 * A field row's `warning` (ID-32's `http://` server address): §9.12's line under the field in
 * the warn ink for a value the row keeps at a cost – not a refusal, so the field is not marked
 * invalid and the value stands – drawn while the field holds the value the row committed and
 * never while the text differs from it (typing), never beside a refusal. The three field
 * renderers draw it the same way; the phone's row, the field's stand-in, draws it under the
 * value it shows.
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

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const ctx: RowContext = { open: () => undefined }

const WARNING = 'Over http:// the app password is sent unprotected.'
const HINT = 'For Nextcloud: https://cloud.example.com/remote.php/dav/files/USERNAME/'

const address: FieldRow = {
  kind: 'field',
  id: 'sync-webdav-url',
  label: 'Server address',
  description: HINT,
  display: 'http://192.168.1.10:8080/dav/',
  value: 'http://192.168.1.10:8080/dav/',
  input: 'url',
  form: 'stacked',
  warning: WARNING,
  onCommit: (value) =>
    value.startsWith('ftp:') ? 'Enter an address that starts with https:// or http://' : undefined
}

const groups: RowGroup[] = [{ id: 'sync-setup', heading: 'Set up sync', rows: [address] }]

const warnLine = (scope: ParentNode): HTMLElement | null =>
  scope.querySelector<HTMLElement>('.zen-settings-validation[data-tone="warn"]')

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

describe('a field row’s warning (FieldRow.warning)', () => {
  it('the desktop’s stacked field draws it under the field in the warn ink as a status the field names, the field not invalid; typing takes it away, putting the value back brings it back, a refusal has the line instead', () => {
    const el = render(<RowView row={address} ctx={ctx} variant="desktop" />)
    const input = el.querySelector<HTMLInputElement>('input')!
    const line = warnLine(el)!
    expect(line).not.toBeNull()
    expect(line.textContent).toBe(WARNING)
    expect(line.getAttribute('role')).toBe('status')
    expect(line.classList.contains('zen-settings-inline-error')).toBe(true)
    expect(input.getAttribute('aria-describedby')).toBe(line.id)
    expect(input.getAttribute('aria-invalid')).toBeNull()
    // The hint keeps its place over the field: the warning is a line of its own, not the description.
    expect(el.querySelector('.zen-settings-description')?.textContent).toBe(HINT)
    expect(el.querySelector('.zen-settings-validation:not([data-tone])')).toBeNull()

    // Typing: the text differs from the row's value, so the line goes.
    act(() => input.focus())
    type(input, 'http://192.168.1.10:8080/dav')
    expect(warnLine(el)).toBeNull()
    expect(input.getAttribute('aria-describedby')).toBeNull()
    // Escape puts the row's value back, and the line with it.
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(input.value).toBe(address.value)
    expect(warnLine(el)).not.toBeNull()

    // A refused commit: the error line in the danger ink, the warning not beside it.
    type(input, 'ftp://192.168.1.10/')
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    const error = el.querySelector<HTMLElement>('.zen-settings-validation:not([data-tone])')!
    expect(error.textContent).toBe('Enter an address that starts with https:// or http://')
    expect(error.getAttribute('role')).toBe('alert')
    expect(warnLine(el)).toBeNull()
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe(error.id)
  })

  it('a row without a warning draws no such line, in either form', () => {
    const plain = { ...address, warning: undefined }
    const stacked = render(<RowView row={plain} ctx={ctx} variant="desktop" />)
    expect(warnLine(stacked)).toBeNull()
    act(() => root!.unmount())
    mount?.remove()
    const inline = render(
      <RowView row={{ ...plain, form: 'inline' }} ctx={ctx} variant="desktop" />
    )
    expect(warnLine(inline)).toBeNull()
    expect(inline.querySelector('input')?.getAttribute('aria-describedby')).toBeNull()
  })

  it('the phone row – the field’s stand-in – draws it under the value it shows, a line of the text block after the description', () => {
    const el = render(<RowView row={address} ctx={ctx} variant="phone" />)
    const text = el.querySelector<HTMLElement>('.zen-settings-row-text')!
    expect(text.querySelector('.zen-settings-description')?.textContent).toBe(address.display)
    const line = warnLine(text)!
    expect(line).not.toBeNull()
    expect(line.textContent).toBe(WARNING)
    expect(line.getAttribute('role')).toBe('status')
    expect(text.lastElementChild).toBe(line)
    act(() => root!.unmount())
    mount?.remove()
    const without = render(
      <RowView row={{ ...address, warning: undefined }} ctx={ctx} variant="phone" />
    )
    expect(warnLine(without)).toBeNull()
  })

  it('the phone’s one-field sheet opens with it under the field in the description’s place; typing brings the description back', async () => {
    act(() => viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' }))
    render(
      <FrameDialogHost frame>
        <SheetStack
          requests={[{ kind: 'field', rowId: address.id }]}
          groups={groups}
          ctx={ctx}
          closeTop={() => undefined}
        />
      </FrameDialogHost>
    )
    await settle()
    const sheet = document.querySelector<HTMLElement>('.zen-sheet[role="dialog"]')!
    const field = sheet.querySelector<HTMLInputElement>('.zen-settings-form input')!
    const line = warnLine(sheet)!
    expect(line).not.toBeNull()
    expect(line.textContent).toBe(WARNING)
    expect(field.getAttribute('aria-describedby')).toBe(line.id)
    expect(field.getAttribute('aria-invalid')).toBeNull()
    expect(sheet.querySelector('.zen-settings-form .zen-settings-description')).toBeNull()
    type(field, 'https://192.168.1.10:8080/dav/')
    expect(warnLine(sheet)).toBeNull()
    expect(sheet.querySelector('.zen-settings-form .zen-settings-description')?.textContent).toBe(
      HINT
    )
  })

  it('the desktop’s field dialog draws it the same way', async () => {
    render(
      <FrameDialogHost>
        <DialogStack
          requests={[{ kind: 'field', rowId: address.id }]}
          groups={groups}
          ctx={ctx}
          closeTop={() => undefined}
        />
      </FrameDialogHost>
    )
    await settle()
    const dialog = document.querySelector<HTMLElement>('.zen-settings-dialog')!
    const field = dialog.querySelector<HTMLInputElement>('input')!
    const line = warnLine(dialog)!
    expect(line).not.toBeNull()
    expect(line.textContent).toBe(WARNING)
    expect(field.getAttribute('aria-describedby')).toBe(line.id)
    expect(dialog.querySelector('.zen-settings-description')).toBeNull()
    type(field, 'https://192.168.1.10:8080/dav/')
    expect(warnLine(dialog)).toBeNull()
    expect(dialog.querySelector('.zen-settings-description')?.textContent).toBe(HINT)
  })
})
