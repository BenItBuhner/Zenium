// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIState } from '@shared/types'
import { defaultScope } from '@core/sync/records'

/*
 * The forms inside Settings › Sync's sheets (ID-08). The passphrase form checks its two fields
 * before anything is sent (§9.12), is a §9.30 busy form while the engine derives the key, and
 * turns the engine's refusal – an error toast, which would land under the sheet – into its
 * validation line; the merge question answers `sync.confirmMerge`; Turn off sync submits the
 * wipe-remote checkbox with its action and nothing before (§9.23).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const { SyncDisconnectForm, SyncMergeForm, SyncPassphraseForm } = await import('../syncForms')
const { syncSetupStore } = await import('@renderer/lib/syncSetup')
const { browserStore, pushToast, uiStore } = await import('@renderer/lib/ui')

const TREE = 'content://com.android.externalstorage.documents/tree/primary%3AZenium'

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: React.ReactElement): HTMLElement {
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() => root!.render(el))
  return mount
}

/** Let the pending promises of a submit settle, a couple of turns deep. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
  })
}

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!found) throw new Error(`no button ${label}`)
  return found
}

function syncOn(enabled: boolean): void {
  browserStore.set({ state: { sync: { enabled } } as unknown as UIState })
}

beforeEach(() => {
  invoke.mockClear()
  invoke.mockImplementation(async () => null)
  syncSetupStore.set({ folder: TREE })
  uiStore.set({ toasts: [] })
  syncOn(false)
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  mount?.remove()
  root = null
  mount = null
})

describe('the passphrase form', () => {
  function form(close = vi.fn()): { el: HTMLElement; close: ReturnType<typeof vi.fn> } {
    const el = render(
      createElement(SyncPassphraseForm, {
        folder: TREE,
        deviceName: 'Pixel 8',
        scope: defaultScope(),
        close
      })
    )
    return { el, close }
  }

  it('two secret fields in the platform monospace, the action off until both are filled', () => {
    const { el } = form()
    const fields = el.querySelectorAll<HTMLInputElement>('input[type="password"]')
    expect(fields).toHaveLength(2)
    for (const f of fields) {
      expect(f.classList.contains('zen-settings-secret')).toBe(true)
      expect(f.classList.contains('zen-v2-field')).toBe(true)
      expect(f.autocomplete).toBe('new-password')
    }
    expect(el.querySelector('label[for="sync-passphrase"]')?.textContent).toBe('Passphrase')
    expect(el.querySelector('label[for="sync-confirm"]')?.textContent).toBe('Confirm passphrase')
    expect(button(el, 'Turn on sync').disabled).toBe(true)
    type(fields[0]!, 'correct horse')
    expect(button(el, 'Turn on sync').disabled).toBe(true)
    type(fields[1]!, 'correct horse')
    expect(button(el, 'Turn on sync').disabled).toBe(false)
  })

  it('refuses a short passphrase and an unequal confirmation under the field at fault, sending nothing', () => {
    const { el } = form()
    const [first, second] = Array.from(el.querySelectorAll<HTMLInputElement>('input'))
    type(first!, 'short')
    type(second!, 'short')
    act(() => button(el, 'Turn on sync').click())
    expect(first!.getAttribute('aria-invalid')).toBe('true')
    expect(el.textContent).toContain('Use at least 8 characters')
    expect(invoke).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(first)

    type(first!, 'correct horse battery')
    expect(el.textContent).not.toContain('Use at least 8 characters')
    type(second!, 'correct horse batter')
    act(() => button(el, 'Turn on sync').click())
    expect(second!.getAttribute('aria-invalid')).toBe('true')
    expect(first!.getAttribute('aria-invalid')).toBeNull()
    expect(el.textContent).toContain('Passphrases do not match')
    expect(invoke).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(second)
  })

  it('is a busy form while the engine works – fields read-only with their values, the primary busy – and closes once sync is on, the draft cleared', async () => {
    let finish: (value: unknown) => void = () => undefined
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const { el, close } = form()
    const [first, second] = Array.from(el.querySelectorAll<HTMLInputElement>('input'))
    type(first!, 'correct horse battery')
    type(second!, 'correct horse battery')
    act(() => button(el, 'Turn on sync').click())
    expect(invoke).toHaveBeenCalledWith('sync.setup', {
      folder: TREE,
      passphrase: 'correct horse battery',
      deviceName: 'Pixel 8',
      scope: defaultScope()
    })
    const body = el.querySelector('[data-testid="sync-passphrase-form"]')
    expect(body?.getAttribute('aria-busy')).toBe('true')
    expect(first!.readOnly).toBe(true)
    expect(first!.value).toBe('correct horse battery')
    expect(button(el, 'Turn on sync').getAttribute('aria-busy')).toBe('true')
    expect(close).not.toHaveBeenCalled()

    syncOn(true)
    finish(null)
    await settle()
    expect(close).toHaveBeenCalledTimes(1)
    expect(syncSetupStore.get().folder).toBeNull()
  })

  it('turns the engine’s error toast into the validation line: the toast leaves the message layer, both fields clear, the first takes the focus', async () => {
    invoke.mockImplementationOnce(async () => {
      pushToast(
        'This passphrase does not match the one used to encrypt this folder’s data.',
        'error'
      )
      return null
    })
    const { el, close } = form()
    const [first, second] = Array.from(el.querySelectorAll<HTMLInputElement>('input'))
    type(first!, 'correct horse battery')
    type(second!, 'correct horse battery')
    act(() => button(el, 'Turn on sync').click())
    await settle()
    expect(close).not.toHaveBeenCalled()
    expect(uiStore.get().toasts).toEqual([])
    expect(el.textContent).toContain(
      'This passphrase does not match the one used to encrypt this folder’s data.'
    )
    expect(first!.getAttribute('aria-invalid')).toBe('true')
    expect(first!.value).toBe('')
    expect(second!.value).toBe('')
    expect(first!.readOnly).toBe(false)
    expect(document.activeElement).toBe(first)
    expect(syncSetupStore.get().folder).toBe(TREE)
  })

  it('says sync could not be turned on when the engine answers without turning it on or raising a toast', async () => {
    const { el, close } = form()
    const [first, second] = Array.from(el.querySelectorAll<HTMLInputElement>('input'))
    type(first!, 'correct horse battery')
    type(second!, 'correct horse battery')
    act(() => button(el, 'Turn on sync').click())
    await settle()
    expect(close).not.toHaveBeenCalled()
    expect(el.textContent).toContain('Sync could not be turned on')
  })
})

describe('the merge question', () => {
  it('two radio rows with Merge picked; Continue answers sync.confirmMerge and closes; Cancel only closes', () => {
    const close = vi.fn()
    const el = render(createElement(SyncMergeForm, { close }))
    const radios = el.querySelectorAll('[role="radio"]')
    expect(radios).toHaveLength(2)
    expect(radios[0]?.getAttribute('aria-checked')).toBe('true')
    expect(radios[0]?.textContent).toContain('Merge')
    expect(radios[1]?.textContent).toContain('Keep only this device’s data')
    act(() => button(el, 'Cancel').click())
    expect(close).toHaveBeenCalledTimes(1)
    expect(invoke).not.toHaveBeenCalled()

    act(() => (radios[1] as HTMLElement).click())
    expect(radios[1]?.getAttribute('aria-checked')).toBe('true')
    act(() => button(el, 'Continue').click())
    expect(invoke).toHaveBeenCalledWith('sync.confirmMerge', { merge: false })
    expect(close).toHaveBeenCalledTimes(2)
  })
})

describe('Turn off sync', () => {
  it('the wipe-remote choice is a checkbox row submitted with the destructive action; nothing happens before Turn off', () => {
    const close = vi.fn()
    const el = render(createElement(SyncDisconnectForm, { close }))
    const box = el.querySelector<HTMLInputElement>('input[type="checkbox"].zen-v2-checkbox')
    expect(box).toBeTruthy()
    expect(box!.checked).toBe(false)
    expect(el.querySelector('.zen-v2-check-row')?.textContent).toContain(
      'Also remove this device’s data from the folder'
    )
    act(() => box!.click())
    expect(box!.checked).toBe(true)
    expect(invoke).not.toHaveBeenCalled()
    const turnOff = button(el, 'Turn off')
    expect(turnOff.classList.contains('zen-settings-danger-button')).toBe(true)
    act(() => turnOff.click())
    expect(invoke).toHaveBeenCalledWith('sync.disconnect', { wipeRemote: true })
    expect(close).toHaveBeenCalledTimes(1)
    expect(syncSetupStore.get().folder).toBeNull()
  })
})
