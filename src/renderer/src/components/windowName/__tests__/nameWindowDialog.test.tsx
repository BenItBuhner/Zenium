// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIState } from '@shared/types'

/*
 * Chrome's Name window prompt (shortcuts-menus-121, -149, context-menus-108;
 * components/windowName/NameWindowDialog.tsx): More Tools › Name Window… and the tab strip's row
 * reach the chrome as `windowName.open`, which `openNameWindow` answers with the program's
 * one-field prompt (`PromptDialog`, on the confirmation primitive) at §9.20's 400 (a field's
 * width) on the frame's dialog host, its one field holding the window's current name, focused
 * and selected, its footer the primitive's Cancel · Save at 96 | 8 | 96. Enter in the field is
 * Save – `window.setName` with the trimmed name, null for an emptied field – and Escape, Cancel
 * and the scrim close it with nothing sent; every way out hands the keyboard back to the page.
 * The primitive's own contract is dialogs/__tests__/confirmDialog.test.tsx's.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run = vi.fn()
const cmd = vi.fn<(name: string, args: unknown) => Promise<unknown>>()
vi.mock('@renderer/lib/api', () => ({
  run: (...args: unknown[]) => run(...args),
  cmd: (name: string, args: unknown) => cmd(name, args),
  onEvent: () => () => undefined
}))

const { FrameDialogHost } = await import('@renderer/lib/portals')
const { browserStore, openNameWindow, uiStore } = await import('@renderer/lib/ui')
const { NameWindowDialog } = await import('../NameWindowDialog')

function state(name: string | null): UIState {
  return {
    platform: 'linux',
    tabs: {},
    spaces: [
      {
        id: 's',
        name: 'Work',
        containerId: 'default',
        tabIds: [],
        activeTabId: null,
        pinnedCollapsed: false
      }
    ],
    activeSpaceId: 's',
    folders: {},
    essentialTabIds: [],
    settings: {},
    window: { id: 'w1', kind: 'synced', fullscreen: false, htmlFullscreenTabId: null, name }
  } as unknown as UIState
}

/** TabDialogs' mounting of the prompt: inside the frame's dialog host. */
function Dialogs(): JSX.Element {
  const s = browserStore.use((b) => b.state)
  return <FrameDialogHost frame>{s && <NameWindowDialog state={s} />}</FrameDialogHost>
}

let container: HTMLDivElement
let root: Root

function render(el: ReactElement): void {
  act(() => root.render(el))
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-name-window-dialog]:not([data-leaving])')
const field = (): HTMLInputElement => dialog()!.querySelector<HTMLInputElement>('input')!
const buttons = (): HTMLButtonElement[] => [
  ...dialog()!.querySelectorAll<HTMLButtonElement>('button')
]
const click = (el: Element | null): void => {
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
const type = (text: string): void => {
  act(() => {
    const input = field()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
/** A key on `from`; the event comes back, `defaultPrevented` when the prompt answered it. */
function press(from: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => {
    from.dispatchEvent(e)
  })
  return e
}
/** Enter in the field: the prompt's default, Save. */
const enter = (): KeyboardEvent => press(field(), 'Enter')

async function open(name: string | null): Promise<void> {
  browserStore.set({ state: state(name) })
  render(<Dialogs />)
  await openNameWindow(null)
  await settle()
}

beforeEach(() => {
  run.mockClear()
  cmd.mockReset()
  cmd.mockResolvedValue(null)
  uiStore.set({ nameWindowOpen: false, snapshot: null, snapshotTabId: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  uiStore.set({ nameWindowOpen: false })
  browserStore.set({ state: null })
})

describe('the Name window prompt', () => {
  it('is the one-field prompt (PromptDialog) at §9.20’s 400 on the frame’s host: the title block, the sentence on where the name shows, the v2 field with the current name selected as the body’s first element, Cancel then Save as the primary at the primitive’s 96s', async () => {
    await open('Research')
    const d = dialog()!
    expect(d).not.toBeNull()
    // A prompt asking for a value is a dialog with a form, not an alertdialog.
    expect(d.getAttribute('role')).toBe('dialog')
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.dataset.confirm).toBe('name-window')
    expect(d.closest('.zen-frame-dialogs-slot')).not.toBeNull()
    // A field takes the `form` width (400): the description wraps to two lines at 368 where 288
    // ran it to three (the #396 review's A2, the lead's ruling 2); the primitive's rule now.
    expect(d.style.width).toBe('400px')
    for (const cls of ['zen-v2-dialog', 'zen-confirm-dialog', 'zen-animate-pop'])
      expect(d.classList.contains(cls), cls).toBe(true)
    const title = d.querySelector('.zen-v2-title-block-title')!
    expect(title.textContent).toBe('Name window')
    expect(d.getAttribute('aria-labelledby')).toBe(title.id)
    const desc = d.querySelector('.zen-v2-title-block-description')!
    expect(desc.textContent).toBe(
      'The name stands in the title bar and in tab search in place of the active tab’s title.'
    )
    expect(d.getAttribute('aria-describedby')).toBe(desc.id)
    const input = field()
    expect(input.classList.contains('zen-v2-field')).toBe(true)
    expect(input.value).toBe('Research')
    expect(input.maxLength).toBe(120)
    expect(input.getAttribute('autocomplete')).toBe('off')
    expect(input.getAttribute('spellcheck')).toBe('false')
    // A form focuses its first field, the value selected so typing replaces it.
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('Research'.length)
    // The body: the field, then the footer – nothing else.
    const body = d.querySelector('.zen-confirm-dialog-body')!
    expect(body.children).toHaveLength(2)
    expect(body.firstElementChild).toBe(input)
    const [cancel, save] = buttons()
    expect(buttons()).toHaveLength(2)
    expect(cancel.textContent).toBe('Cancel')
    expect(cancel.hasAttribute('data-primary')).toBe(false)
    expect(save.textContent).toBe('Save')
    expect(save.hasAttribute('data-primary')).toBe(true)
    expect(save.hasAttribute('data-danger')).toBe(false)
    // No form element: Enter in the field is the primitive's default key, not a submit.
    expect(d.querySelector('form')).toBeNull()
    expect(save.type).toBe('button')
    // The footer is the primitive's 96 | 8 | 96 (`.zen-v2-button`'s min-width 96, the footer's
    // 8 gap), not the buttons' intrinsic widths.
    for (const button of [cancel, save])
      expect(button.classList.contains('zen-v2-button')).toBe(true)
    expect(cancel.parentElement).toBe(body.lastElementChild)
    expect(cancel.parentElement!.classList.contains('zen-confirm-dialog-footer')).toBe(true)
    // The chrome took the keyboard for the field.
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
  })

  it('Tab from the field goes to Cancel, then Save, then wraps to the field; Shift+Tab from the field lands on Save', async () => {
    await open('Research')
    const input = field()
    const [cancel, save] = buttons()
    expect(document.activeElement).toBe(input)
    // A step within the prompt is the browser's (happy-dom does not run it: walked by hand).
    expect(press(input, 'Tab').defaultPrevented).toBe(false)
    act(() => cancel.focus())
    expect(press(cancel, 'Tab').defaultPrevented).toBe(false)
    act(() => save.focus())
    expect(press(save, 'Tab').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(press(input, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(save)
  })

  it('starts empty for a window without a name – no placeholder, as Chrome’s field; the aria-label names it', async () => {
    await open(null)
    expect(field().value).toBe('')
    expect(field().hasAttribute('placeholder')).toBe(false)
    expect(field().getAttribute('aria-label')).toBe('Window name')
  })

  it('Enter in the field saves the trimmed name through window.setName and closes, the page taking the keyboard back; Save’s click does the same', async () => {
    await open(null)
    run.mockClear()
    type('  Work  ')
    expect(enter().defaultPrevented).toBe(true)
    expect(run).toHaveBeenCalledWith('window.setName', { name: 'Work' })
    expect(uiStore.get().nameWindowOpen).toBe(false)
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
    await settle()
    expect(dialog()).toBeNull()

    await open(null)
    run.mockClear()
    type('Notes')
    click(buttons()[1])
    expect(run).toHaveBeenCalledWith('window.setName', { name: 'Notes' })
    expect(uiStore.get().nameWindowOpen).toBe(false)
  })

  it('an emptied field clears the name (Chrome’s prompt): window.setName with null', async () => {
    await open('Research')
    run.mockClear()
    type('   ')
    enter()
    expect(run).toHaveBeenCalledWith('window.setName', { name: null })
    expect(uiStore.get().nameWindowOpen).toBe(false)
  })

  it('Cancel, Escape and the scrim send nothing and close; the page takes the keyboard back', async () => {
    await open('Research')
    run.mockClear()
    type('Changed')
    click(buttons()[0])
    expect(run).not.toHaveBeenCalledWith('window.setName', expect.anything())
    expect(uiStore.get().nameWindowOpen).toBe(false)
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
    await settle()
    expect(dialog()).toBeNull()

    await open('Research')
    run.mockClear()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(run).not.toHaveBeenCalledWith('window.setName', expect.anything())
    expect(uiStore.get().nameWindowOpen).toBe(false)
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
    await settle()

    await open('Research')
    run.mockClear()
    act(() => {
      document
        .querySelector('.zen-frame-scrim')!
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    })
    expect(run).not.toHaveBeenCalledWith('window.setName', expect.anything())
    expect(uiStore.get().nameWindowOpen).toBe(false)
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
  })
})
