// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIState } from '@shared/types'

/*
 * Chrome's Name window prompt (shortcuts-menus-121, -149, context-menus-108;
 * components/windowName/NameWindowDialog.tsx): More Tools › Name Window… and the tab strip's row
 * reach the chrome as `windowName.open`, which `openNameWindow` answers with a §9.23 dialog at
 * §9.20's 320 on the frame's dialog host, its one field holding the window's current name,
 * focused and selected. Enter is Save – `window.setName` with the trimmed name, null for an
 * emptied field – and Escape, Cancel and the scrim close it with nothing sent; every way out
 * hands the keyboard back to the page.
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
const submit = (): void => {
  act(() => {
    dialog()!
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

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
  it('is the §9.23 composition at 320 on the frame’s host: the title, one line on where the name shows, the field with the current name selected, Cancel then Save as the primary', async () => {
    await open('Research')
    const d = dialog()!
    expect(d).not.toBeNull()
    expect(d.getAttribute('role')).toBe('dialog')
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.style.width).toBe('320px')
    expect(d.classList.contains('zen-bm-dialog')).toBe(true)
    const title = d.querySelector('.zen-bm-title')!
    expect(title.textContent).toBe('Name window')
    expect(d.getAttribute('aria-labelledby')).toBe(title.id)
    const desc = d.querySelector('.zen-bm-title-desc')!
    expect(desc.textContent).toBe(
      'The name stands in the title bar and in tab search in place of the active tab’s title.'
    )
    expect(d.getAttribute('aria-describedby')).toBe(desc.id)
    const input = field()
    expect(input.value).toBe('Research')
    expect(input.maxLength).toBe(120)
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('Research'.length)
    const [cancel, save] = buttons()
    expect(buttons()).toHaveLength(2)
    expect(cancel.textContent).toBe('Cancel')
    expect(cancel.hasAttribute('data-variant')).toBe(false)
    expect(save.textContent).toBe('Save')
    expect(save.dataset.variant).toBe('primary')
    expect(save.type).toBe('submit')
    // The chrome took the keyboard for the field.
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
  })

  it('starts empty for a window without a name', async () => {
    await open(null)
    expect(field().value).toBe('')
    expect(field().placeholder).toBe('Window name')
  })

  it('Enter saves the trimmed name through window.setName and closes, the page taking the keyboard back', async () => {
    await open(null)
    run.mockClear()
    type('  Work  ')
    submit()
    expect(run).toHaveBeenCalledWith('window.setName', { name: 'Work' })
    expect(uiStore.get().nameWindowOpen).toBe(false)
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
    await settle()
    expect(dialog()).toBeNull()
  })

  it('an emptied field clears the name (Chrome’s prompt): window.setName with null', async () => {
    await open('Research')
    run.mockClear()
    type('   ')
    submit()
    expect(run).toHaveBeenCalledWith('window.setName', { name: null })
    expect(uiStore.get().nameWindowOpen).toBe(false)
  })

  it('Cancel and Escape send nothing and close; the page takes the keyboard back', async () => {
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
  })
})
