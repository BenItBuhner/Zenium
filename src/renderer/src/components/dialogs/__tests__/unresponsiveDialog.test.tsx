// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

/*
 * The "Page unresponsive" prompt (components/dialogs/UnresponsiveDialog.tsx; lib/unresponsive.ts
 * has the facts and the words; tabs-45): Chrome's hung-renderer dialog on the shared §9.23
 * confirmation – the question, one description, Cancel and the danger verb "Exit page", no
 * primary and no default key – for the window looking at a page whose renderer stopped
 * answering. Cancel is the wait (`tab.waitUnresponsive`), the verb ends the pages
 * (`tab.exitUnresponsive`), each with every hung page's id; several pages are one prompt with
 * their titles in the description; the prompt goes by itself when the mark goes. The page in
 * front gives way to its picture while the prompt is up (`unresponsivePromptOpen`, the view
 * composites above the chrome) and comes back live as it leaves. The drive's handles:
 * `data-confirm="unresponsive"`, `data-unresponsive` listing the tabs.
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
const { overlayCoversContent, uiStore } = await import('@renderer/lib/ui')
const { UnresponsiveDialog } = await import('../UnresponsiveDialog')

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 's',
    containerId: DEFAULT_CONTAINER_ID,
    url: `https://${id}.example/`,
    title: id.toUpperCase(),
    discarded: false,
    splitGroupId: null,
    ...over
  } as Tab
}

function state(tabs: Tab[], activeTabId: string): UIState {
  return {
    platform: 'linux',
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [
      {
        id: 's',
        name: 'Work',
        containerId: DEFAULT_CONTAINER_ID,
        tabIds: tabs.map((t) => t.id),
        activeTabId,
        pinnedCollapsed: false
      }
    ],
    activeSpaceId: 's',
    folders: {},
    essentialTabIds: [],
    settings: {},
    window: { kind: 'normal', fullscreen: false, prompt: null }
  } as unknown as UIState
}

function Dialogs({ state: s }: { state: UIState }): JSX.Element {
  return (
    <FrameDialogHost frame>
      <UnresponsiveDialog state={s} />
    </FrameDialogHost>
  )
}

let container: HTMLDivElement
let root: Root

function render(el: ReactElement): void {
  act(() => root.render(el))
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

/** The answers given: the tab commands, apart from the keyboard's moves the cover makes. */
const answers = (): unknown[][] =>
  run.mock.calls.filter(([name]) => typeof name === 'string' && name.startsWith('tab.'))

const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-confirm="unresponsive"]:not([data-leaving])')
const button = (scope: ParentNode, action: 'cancel' | 'confirm'): HTMLButtonElement =>
  scope.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)!
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
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('the Page unresponsive prompt', () => {
  it("is the shared confirmation, destructive, with Chrome's words and the drive's handles", async () => {
    render(<Dialogs state={state([tab('a', { unresponsive: true }), tab('b')], 'a')} />)
    await settle()
    const d = dialog()!
    expect(d).not.toBeNull()
    expect(d.getAttribute('role')).toBe('alertdialog')
    expect(d.classList.contains('zen-confirm-dialog')).toBe(true)
    expect(d.dataset.destructive).toBe('true')
    expect(d.dataset.unresponsive).toBe('a')
    // A title block and two buttons: §9.20's 320 notice.
    expect(d.style.width).toBe('320px')
    expect(d.querySelector('h2')!.textContent).toBe('Page unresponsive')
    expect(d.querySelector('p')!.textContent).toBe(
      'You can wait for it to become responsive or exit the page.'
    )
    const cancel = button(d, 'cancel')
    const verb = button(d, 'confirm')
    expect(cancel.textContent).toBe('Cancel')
    expect(verb.textContent).toBe('Exit page')
    // The danger verb, no primary (§6): the app recommends neither answer.
    expect(verb.hasAttribute('data-danger')).toBe(true)
    expect(verb.hasAttribute('data-primary')).toBe(false)
    expect(d.querySelector('input')).toBeNull()
    // The container holds the keyboard as the prompt opens (§9.22).
    expect(document.activeElement).toBe(d)
  })

  it('waits on Cancel and on Escape, ends the pages on the verb – each with the hung pages’ ids', async () => {
    render(<Dialogs state={state([tab('a', { unresponsive: true }), tab('b')], 'a')} />)
    await settle()
    click(button(dialog()!, 'cancel'))
    expect(run).toHaveBeenLastCalledWith('tab.waitUnresponsive', { tabIds: ['a'] })

    press(dialog()!, 'Escape')
    expect(run).toHaveBeenLastCalledWith('tab.waitUnresponsive', { tabIds: ['a'] })
    expect(answers()).toHaveLength(2)

    click(button(dialog()!, 'confirm'))
    expect(run).toHaveBeenLastCalledWith('tab.exitUnresponsive', { tabIds: ['a'] })
    // Enter from the held container answers nothing on a destructive prompt (§9.22 as amended).
    press(dialog()!, 'Enter')
    expect(answers()).toHaveLength(3)
  })

  it('is one prompt for several pages sharing the hung renderer, their titles in the description', async () => {
    const s = state(
      [
        tab('a', { unresponsive: true, title: 'Docs' }),
        tab('b'),
        tab('c', { unresponsive: true, customTitle: 'My sheet' })
      ],
      'a'
    )
    render(<Dialogs state={s} />)
    await settle()
    const d = dialog()!
    expect(d.dataset.unresponsive).toBe('a c')
    expect(d.querySelector('h2')!.textContent).toBe('Pages unresponsive')
    expect(d.querySelector('p')!.textContent).toBe(
      '“Docs”, “My sheet” are not responding. You can wait for them to become responsive or exit the pages.'
    )
    expect(button(d, 'confirm').textContent).toBe('Exit pages')
    click(button(d, 'confirm'))
    expect(run).toHaveBeenLastCalledWith('tab.exitUnresponsive', { tabIds: ['a', 'c'] })
  })

  it('stands only in the window looking at a hung page, and goes by itself when the mark goes', async () => {
    // Hung out of sight: this window's front page answers, so it asks nothing.
    render(<Dialogs state={state([tab('a', { unresponsive: true }), tab('b')], 'b')} />)
    await settle()
    expect(dialog()).toBeNull()

    // The hung page comes to the front: the prompt opens.
    render(<Dialogs state={state([tab('a', { unresponsive: true }), tab('b')], 'a')} />)
    await settle()
    expect(dialog()).not.toBeNull()

    // The page answers (the core clears the mark): the prompt leaves without an answer.
    render(<Dialogs state={state([tab('a'), tab('b')], 'a')} />)
    await settle()
    expect(dialog()).toBeNull()
    expect(answers()).toEqual([])
  })

  it('hides the page in front behind its picture while it is up, and brings it back live as it leaves', async () => {
    expect(uiStore.get().unresponsivePromptOpen).toBe(false)
    render(<Dialogs state={state([tab('a', { unresponsive: true }), tab('b')], 'a')} />)
    await settle()
    // The prompt captured the page (`overlay.snapshot`), took the keyboard and raised its flag:
    // the view hides and the frame shows the picture (the prompt is over it, not under it).
    expect(cmd).toHaveBeenCalledWith('overlay.snapshot', { tabId: 'a' })
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
    expect(uiStore.get().unresponsivePromptOpen).toBe(true)
    expect(overlayCoversContent(uiStore.get())).toBe(true)

    // A second page of the renderer joins the prompt: the words change, the cover holds.
    cmd.mockClear()
    render(
      <Dialogs
        state={state([tab('a', { unresponsive: true }), tab('b', { unresponsive: true })], 'a')}
      />
    )
    await settle()
    expect(dialog()!.dataset.unresponsive).toBe('a b')
    expect(uiStore.get().unresponsivePromptOpen).toBe(true)
    expect(cmd).not.toHaveBeenCalledWith('overlay.snapshot', expect.anything())

    // The pages answer: the prompt goes, the flag clears, the page gets the keyboard back.
    run.mockClear()
    render(<Dialogs state={state([tab('a'), tab('b')], 'a')} />)
    await settle()
    expect(dialog()).toBeNull()
    expect(uiStore.get().unresponsivePromptOpen).toBe(false)
    expect(overlayCoversContent(uiStore.get())).toBe(false)
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
  })

  it('covers the page of a split pane’s hung neighbour: the page in front is the one pictured', async () => {
    render(
      <Dialogs
        state={state(
          [tab('a', { splitGroupId: 'g' }), tab('b', { splitGroupId: 'g', unresponsive: true })],
          'a'
        )}
      />
    )
    await settle()
    expect(dialog()!.dataset.unresponsive).toBe('b')
    expect(cmd).toHaveBeenCalledWith('overlay.snapshot', { tabId: 'a' })
    expect(uiStore.get().unresponsivePromptOpen).toBe(true)
  })
})
