// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UIState, WindowPrompt } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

/*
 * The window prompts (components/dialogs/WindowPromptDialog.tsx; lib/windowPrompt.ts has the
 * words): "Quit Zenium?" and "Close N tabs?" on the shared §9.23 confirmation
 * (components/dialogs/ConfirmDialog.tsx) – the title, one description, the tabs warning's
 * checkbox as the body's one element, Cancel and the primary verb; Enter from the container
 * answers with the verb, Escape and the scrim with Cancel, each answer once. The checkbox
 * turns the warning off only with an answer that goes ahead. The page takes the keyboard back
 * as the prompt goes – unless a keyboard-focused control of the chrome asked, whose one-hop
 * return is the primitive's. The smoke's handles stay: `data-window-prompt`, the heading, the
 * verb's exact name.
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
const { uiStore } = await import('@renderer/lib/ui')
const { WindowPromptDialog } = await import('../WindowPromptDialog')

function state(prompt: WindowPrompt | null): UIState {
  return {
    platform: 'linux',
    tabs: {
      a: {
        id: 'a',
        spaceId: 's',
        containerId: DEFAULT_CONTAINER_ID,
        url: 'https://a.example/',
        title: 'A'
      }
    },
    spaces: [
      {
        id: 's',
        name: 'Work',
        containerId: DEFAULT_CONTAINER_ID,
        tabIds: ['a'],
        activeTabId: 'a',
        pinnedCollapsed: false
      }
    ],
    activeSpaceId: 's',
    folders: {},
    essentialTabIds: [],
    settings: {},
    window: { kind: 'normal', fullscreen: false, prompt }
  } as unknown as UIState
}

const quit = (over: Partial<WindowPrompt> = {}): WindowPrompt => ({
  id: 'p1',
  kind: 'quit',
  count: 3,
  downloads: null,
  ...over
})

function Dialogs({ prompt }: { prompt: WindowPrompt | null }): JSX.Element {
  return (
    <FrameDialogHost frame>
      <WindowPromptDialog state={state(prompt)} />
    </FrameDialogHost>
  )
}

let container: HTMLDivElement
let root: Root

function render(el: ReactElement): void {
  act(() => root.render(el))
}

/** The snapshot race resolves and the dialog's effects settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="alertdialog"]:not([data-leaving])')
const buttons = (scope: ParentNode): HTMLButtonElement[] => [
  ...scope.querySelectorAll<HTMLButtonElement>('button')
]
const click = (el: Element | null | undefined): void => {
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
const press = (from: Element, key: string): void => {
  act(() => {
    from.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  run.mockClear()
  cmd.mockReset()
  cmd.mockResolvedValue(null)
  uiStore.set({ windowPromptOpen: false, snapshot: null, snapshotTabId: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  uiStore.set({ windowPromptOpen: false })
})

describe('the window prompt', () => {
  it('is the shared confirmation with the smoke’s handles: data-window-prompt, the heading, the tabs sentence, the exact verb; the checkbox is the body’s one element', async () => {
    render(<Dialogs prompt={quit()} />)
    await settle()
    const d = dialog()!
    expect(d).not.toBeNull()
    expect(d.classList.contains('zen-confirm-dialog')).toBe(true)
    expect(d.dataset.confirm).toBe('window-prompt')
    expect(d.dataset.windowPrompt).toBe('quit')
    expect(d.hasAttribute('data-downloads')).toBe(false)
    expect(d.style.width).toBe('320px')
    expect(d.querySelector('h2')!.textContent).toBe('Quit Zenium?')
    expect(d.querySelector('.zen-v2-title-block-description')!.textContent).toBe(
      'You are about to quit with 3 tabs open.'
    )
    // The quit prompt carries no glyph (§9.23).
    expect(d.querySelector('h2 svg')).toBeNull()
    const body = d.querySelector('.zen-confirm-dialog-body')!
    expect(body.children).toHaveLength(2)
    const row = body.firstElementChild!
    expect(row.classList.contains('zen-confirm-dialog-check')).toBe(true)
    expect(row.querySelector('.zen-v2-label')!.textContent).toBe(
      'Warn before closing a window with multiple tabs'
    )
    expect(row.querySelector<HTMLInputElement>('input')!.checked).toBe(true)
    const [cancel, verb] = buttons(d)
    expect(cancel.textContent).toBe('Cancel')
    expect(verb.textContent).toBe('Quit')
    expect(verb.hasAttribute('data-primary')).toBe(true)
    // The container holds the focus; the page is hidden under its picture once the race resolves.
    expect(document.activeElement).toBe(d)
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
    expect(uiStore.get().windowPromptOpen).toBe(true)
  })

  it('says the downloads sentence in the one paragraph and marks their count; alone it is the description and no checkbox is asked', async () => {
    render(<Dialogs prompt={quit({ downloads: { count: 2, end: 'quit' } })} />)
    await settle()
    let d = dialog()!
    expect(d.dataset.downloads).toBe('2')
    expect(d.querySelectorAll('.zen-v2-title-block-description')).toHaveLength(1)
    expect(d.querySelector('.zen-v2-title-block-description')!.textContent).toBe(
      'You are about to quit with 3 tabs open. 2 downloads are in progress; quitting interrupts them.'
    )
    expect(d.querySelector('.zen-confirm-dialog-check')).not.toBeNull()

    render(<Dialogs prompt={quit({ id: 'p2', count: 0, downloads: { count: 1, end: 'quit' } })} />)
    await settle()
    d = dialog()!
    expect(d.querySelector('.zen-v2-title-block-description')!.textContent).toBe(
      '1 download is in progress; quitting interrupts it.'
    )
    expect(d.querySelector('.zen-confirm-dialog-check')).toBeNull()
    expect(buttons(d)[1].textContent).toBe('Quit')

    render(
      <Dialogs
        prompt={quit({
          id: 'p3',
          kind: 'close-tabs',
          count: 0,
          downloads: { count: 1, end: 'private-window' }
        })}
      />
    )
    await settle()
    d = dialog()!
    expect(d.dataset.windowPrompt).toBe('close-tabs')
    expect(d.querySelector('h2')!.textContent).toBe('Close private window?')
    expect(buttons(d)[1].textContent).toBe('Close window')
  })

  it('Enter from the container answers with the verb, once; the checkbox left on changes no setting', async () => {
    render(<Dialogs prompt={quit()} />)
    await settle()
    const d = dialog()!
    press(d, 'Enter')
    press(d, 'Enter')
    expect(run).toHaveBeenCalledWith('window.respondPrompt', { id: 'p1', accepted: true })
    expect(run.mock.calls.filter(([name]) => name === 'window.respondPrompt')).toHaveLength(1)
    expect(run).not.toHaveBeenCalledWith('settings.update', expect.anything())
  })

  it('the verb with the checkbox cleared turns the warning off for good; Cancel with it cleared changes nothing', async () => {
    render(<Dialogs prompt={quit()} />)
    await settle()
    let d = dialog()!
    click(d.querySelector('input[type="checkbox"]'))
    expect(d.querySelector<HTMLInputElement>('input')!.checked).toBe(false)
    click(buttons(d)[1])
    expect(run).toHaveBeenCalledWith('settings.update', { warnOnCloseWindow: false })
    expect(run).toHaveBeenCalledWith('window.respondPrompt', { id: 'p1', accepted: true })

    run.mockClear()
    render(<Dialogs prompt={quit({ id: 'p2' })} />)
    await settle()
    d = dialog()!
    click(d.querySelector('input[type="checkbox"]'))
    click(buttons(d)[0])
    expect(run).not.toHaveBeenCalledWith('settings.update', expect.anything())
    expect(run).toHaveBeenCalledWith('window.respondPrompt', { id: 'p2', accepted: false })
  })

  it('Escape and the scrim are Cancel', async () => {
    render(<Dialogs prompt={quit()} />)
    await settle()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(run).toHaveBeenCalledWith('window.respondPrompt', { id: 'p1', accepted: false })
    run.mockClear()
    render(<Dialogs prompt={quit({ id: 'p2' })} />)
    await settle()
    act(() => {
      document
        .querySelector('.zen-frame-scrim')!
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    })
    expect(run).toHaveBeenCalledWith('window.respondPrompt', { id: 'p2', accepted: false })
  })

  it('hands the page the keyboard back as the prompt goes, its picture dropped', async () => {
    render(<Dialogs prompt={quit()} />)
    await settle()
    expect(uiStore.get().windowPromptOpen).toBe(true)
    run.mockClear()
    render(<Dialogs prompt={null} />)
    await settle()
    expect(dialog()).toBeNull()
    expect(uiStore.get().windowPromptOpen).toBe(false)
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
  })

  it('leaves the keyboard with a chrome control that asked with its ring showing: the prompt’s own one-hop return governs, the page is not asked', async () => {
    const chrome = document.createElement('div')
    chrome.setAttribute('data-surface', 'window')
    const menu = document.createElement('button')
    chrome.appendChild(menu)
    document.body.appendChild(chrome)
    menu.focus()
    // happy-dom matches `:focus-visible` on a focused control; the chassis reads the ring the
    // browser shows for a keyboard's focus (lib/popover.ts `openedFromKeyboard`).
    expect(menu.matches(':focus-visible')).toBe(true)
    render(<Dialogs prompt={quit()} />)
    await settle()
    expect(document.activeElement).toBe(dialog())
    run.mockClear()
    render(<Dialogs prompt={null} />)
    await settle()
    expect(run).not.toHaveBeenCalledWith('focus.content', undefined)
    // The chrome is held through the exit; as it lifts the control takes the focus back.
    act(() => {
      for (const panel of document.querySelectorAll('.zen-frame-dialogs-slot > [data-leaving]'))
        panel.dispatchEvent(new Event('animationend'))
    })
    await settle()
    expect(document.activeElement).toBe(menu)
  })
})
