// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

/*
 * "Delete <folder>?" (TAB-16's desktop half; components/sidebar/FolderDeleteDialog.tsx and
 * lib/folderDelete.ts): the desktop's folder menu and the group editor bubble both ask through
 * `requestFolderDelete` – an empty folder goes at once, one holding tabs or saved pages only
 * through the §9.23 prompt (components/dialogs/ConfirmDialog.tsx) at §9.20's 320 on the frame's
 * dialog host, the dialog itself holding the focus as it opens (§9.22 as the #340 verdict reads
 * it: no verb preselected, no ring; Tab enters at Cancel, Shift+Tab at Delete, the keys wrap at
 * the ends), Escape and the scrim as Cancel, the danger verb running `folder.delete` without
 * unpacking; a Cancel from the keyboard hands the keyboard back to the folder's header (§9.5) –
 * once the window chrome's `inert`, held through the prompt's way out, lifts (lib/popover.ts
 * `returnFocusTo`). The primitive's own contract is confirmDialog.test.tsx's; this file holds
 * the folder prompt's words, its wiring and its way back.
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
const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { folderDeleteWords, folderHoldsAnything, requestFolderDelete } =
  await import('@renderer/lib/folderDelete')
const { FolderDeleteDialog } = await import('../FolderDeleteDialog')

const tab = (id: string, folderId: string | null): Tab =>
  ({
    id,
    spaceId: 's',
    containerId: DEFAULT_CONTAINER_ID,
    url: `https://${id}.example/`,
    title: id,
    folderId
  }) as unknown as Tab

const folder = (over: Partial<Folder> = {}): Folder =>
  ({
    id: 'g',
    spaceId: 's',
    name: 'Trip planning',
    icon: '📁',
    color: 'green',
    collapsed: true,
    ...over
  }) as Folder

function state(tabs: Tab[], folders: Folder[]): UIState {
  return {
    platform: 'linux',
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [
      {
        id: 's',
        name: 'Work',
        containerId: DEFAULT_CONTAINER_ID,
        tabIds: tabs.map((t) => t.id),
        activeTabId: tabs[0]?.id ?? null,
        pinnedCollapsed: false
      }
    ],
    activeSpaceId: 's',
    folders: Object.fromEntries(folders.map((f) => [f.id, f])),
    essentialTabIds: [],
    settings: {},
    window: { kind: 'normal', fullscreen: false }
  } as unknown as UIState
}

/** TabDialogs' mounting of the prompt: inside the frame's dialog host while the request stands. */
function Dialogs(): JSX.Element {
  const s = browserStore.use((b) => b.state)
  const request = uiStore.use((u) => u.folderDeleteConfirm)
  return (
    <FrameDialogHost frame>
      {s && request && <FolderDeleteDialog key={request.folderId} state={s} request={request} />}
    </FrameDialogHost>
  )
}

let container: HTMLDivElement
let root: Root

function render(el: ReactElement): void {
  act(() => root.render(el))
}

/** Let the prompt's wait for the page's picture resolve and the dialog come up. */
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
const click = (el: Element | null): void => {
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
/** A Tab press on `from`; the event comes back, `defaultPrevented` when the dialog moved the focus itself. */
function pressTab(from: Element, shift = false): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: shift,
    bubbles: true,
    cancelable: true
  })
  act(() => {
    from.dispatchEvent(e)
  })
  return e
}

beforeEach(() => {
  run.mockClear()
  cmd.mockReset()
  cmd.mockResolvedValue(null)
  uiStore.set({ folderDeleteConfirm: null, groupEditor: null, snapshot: null, snapshotTabId: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  // The folder's header row in the strip, for the keyboard's way back.
  const header = document.createElement('div')
  header.setAttribute('data-tab-folder', 'g')
  header.tabIndex = 0
  document.body.appendChild(header)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  uiStore.set({ folderDeleteConfirm: null, groupEditor: null })
  browserStore.set({ state: null })
})

describe('folderDeleteWords', () => {
  it('asks with the folder’s name and says what goes: an open folder’s tabs to Recently Closed, a saved one’s pages for good', () => {
    expect(folderDeleteWords('Trip planning', 3, false)).toEqual({
      title: 'Delete Trip planning?',
      detail: 'Its 3 tabs close with it; Recently Closed keeps their pages.'
    })
    expect(folderDeleteWords('Trip planning', 1, false)).toEqual({
      title: 'Delete Trip planning?',
      detail: 'Its 1 tab closes with it; Recently Closed keeps its page.'
    })
    expect(folderDeleteWords('Trip planning', 3, true)).toEqual({
      title: 'Delete Trip planning?',
      detail: 'Its 3 saved pages are forgotten with it. There is no undo.'
    })
    expect(folderDeleteWords('  ', 1, true)).toEqual({
      title: 'Delete folder?',
      detail: 'Its 1 saved page is forgotten with it. There is no undo.'
    })
  })
})

describe('requestFolderDelete', () => {
  it('deletes an empty folder outright and asks for one holding tabs or pages', async () => {
    browserStore.set({ state: state([tab('home', null)], [folder()]) })
    expect(folderHoldsAnything('g')).toBe(false)
    requestFolderDelete('g', false)
    expect(run).toHaveBeenCalledWith('folder.delete', { folderId: 'g', unpack: false })
    expect(uiStore.get().folderDeleteConfirm).toBeNull()
    run.mockClear()

    browserStore.set({ state: state([tab('home', null), tab('a', 'g')], [folder()]) })
    expect(folderHoldsAnything('g')).toBe(true)
    requestFolderDelete('g', false)
    await settle()
    expect(run).not.toHaveBeenCalledWith('folder.delete', expect.anything())
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
    expect(uiStore.get().folderDeleteConfirm).toEqual({ folderId: 'g', keyboard: false })
    uiStore.set({ folderDeleteConfirm: null })

    const saved = folder({ savedTabs: [{ url: 'https://t.example/', title: 'T' }] })
    browserStore.set({ state: state([tab('home', null)], [saved]) })
    expect(folderHoldsAnything('g')).toBe(true)
    requestFolderDelete('g', true)
    await settle()
    expect(uiStore.get().folderDeleteConfirm).toEqual({ folderId: 'g', keyboard: true })
    // The prompt takes the bubble's place (§9.20: one popover at a time).
    expect(uiStore.get().groupEditor).toBeNull()
  })

  it('keeps the bubble’s word on the keyboard when the ask comes from it, and ignores a folder that is gone', async () => {
    browserStore.set({ state: state([tab('home', null), tab('a', 'g')], [folder()]) })
    uiStore.set({ groupEditor: { folderId: 'g', keyboard: true } })
    requestFolderDelete('g', false)
    await settle()
    expect(uiStore.get().folderDeleteConfirm).toEqual({ folderId: 'g', keyboard: true })
    uiStore.set({ folderDeleteConfirm: null, groupEditor: null })
    requestFolderDelete('nowhere', false)
    expect(run).not.toHaveBeenCalledWith('folder.delete', expect.anything())
    expect(uiStore.get().folderDeleteConfirm).toBeNull()
  })
})

describe('the "Delete <folder>?" prompt', () => {
  it('is the §9.23 composition at 320 on the frame’s host: the question with the trash glyph, one line on what goes, Cancel then Delete in the danger ink, the dialog itself focused', async () => {
    browserStore.set({
      state: state([tab('home', null), tab('a', 'g'), tab('b', 'g')], [folder()])
    })
    render(<Dialogs />)
    requestFolderDelete('g', false)
    await settle()
    const d = dialog()!
    expect(d).not.toBeNull()
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.dataset.folderDelete).toBe('g')
    expect(d.dataset.confirm).toBe('folder-delete')
    expect(d.style.width).toBe('320px')
    // The shared primitive, not a dialog of the folder's own.
    expect(d.classList.contains('zen-confirm-dialog')).toBe(true)
    expect(d.classList.contains('zen-v2-dialog')).toBe(true)
    expect(d.closest('.zen-frame-dialogs-slot')).not.toBeNull()
    const title = d.querySelector('.zen-v2-title-block-title')!
    expect(title.textContent).toBe('Delete Trip planning?')
    expect(title.querySelector('svg.lucide-trash-2')).not.toBeNull()
    expect(d.getAttribute('aria-labelledby')).toBe(title.id)
    const detail = d.querySelector('.zen-v2-title-block-description')!
    expect(detail.textContent).toBe('Its 2 tabs close with it; Recently Closed keeps their pages.')
    expect(d.getAttribute('aria-describedby')).toBe(detail.id)
    // One paragraph and the footer: no body element of its own (no checkbox to ask with).
    expect(d.querySelector('.zen-confirm-dialog-check')).toBeNull()
    const [cancel, del] = buttons(d)
    expect(buttons(d)).toHaveLength(2)
    expect(cancel.textContent).toBe('Cancel')
    expect(cancel.dataset.action).toBe('cancel')
    expect(cancel.hasAttribute('data-danger')).toBe(false)
    expect(del.textContent).toBe('Delete')
    expect(del.dataset.action).toBe('confirm')
    expect(del.hasAttribute('data-danger')).toBe(true)
    expect(d.dataset.destructive).toBe('true')
    // A destructive prompt has no primary (§6).
    expect(d.querySelector('[data-primary]')).toBeNull()
    // The container holds the focus, not Cancel (§9.22 as the #340 verdict reads it).
    expect(d.tabIndex).toBe(-1)
    expect(document.activeElement).toBe(d)
    expect(document.activeElement).not.toBe(cancel)
  })

  it('draws no ring on itself: the chassis’s no-ring rule for a container that focuses itself by design covers an alertdialog at tabindex −1', () => {
    const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
    expect(css).toContain(
      ":root [role='dialog'][tabindex='-1']:focus-visible, :root [role='alertdialog'][tabindex='-1']:focus-visible { outline: none; }"
    )
    // And nothing of the prompt's own chrome draws one over it.
    expect(css).not.toMatch(/\.zen-confirm-dialog[^{,]*:focus/)
    expect(css).not.toMatch(/\.zen-v2-dialog[^{,]*:focus/)
  })

  it('Tab from the container enters at Cancel, Shift+Tab at Delete, and the keys wrap at the ends (lib/popover.ts wrapTab)', async () => {
    browserStore.set({ state: state([tab('home', null), tab('a', 'g')], [folder()]) })
    render(<Dialogs />)
    requestFolderDelete('g', true)
    await settle()
    const d = dialog()!
    const [cancel, del] = buttons(d)
    expect(document.activeElement).toBe(d)
    // From the container, Tab enters at the first control: the dialog's own move.
    expect(pressTab(d).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(cancel)
    // A step within the dialog is the browser's (Cancel to Delete): the key is left to it.
    expect(pressTab(cancel!).defaultPrevented).toBe(false)
    act(() => del!.focus())
    // At the last control Tab wraps to the first; Shift+Tab at the first wraps to the last.
    expect(pressTab(del!).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(cancel)
    expect(pressTab(cancel!, true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(del)
    // From the container again: Shift+Tab enters at the end – Delete – and never leaves the
    // dialog for the header row that stands before the host in the document.
    act(() => d.focus())
    expect(document.activeElement).toBe(d)
    expect(pressTab(d, true).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(del)
    // Nothing was deleted by the walk.
    expect(run).not.toHaveBeenCalledWith('folder.delete', expect.anything())
    expect(uiStore.get().folderDeleteConfirm).toEqual({ folderId: 'g', keyboard: true })
  })

  it('Enter from the container answers with Delete – the primitive’s default button, in the destructive form too (the named question) – and the page takes the keyboard back', async () => {
    browserStore.set({ state: state([tab('home', null), tab('a', 'g')], [folder()]) })
    render(<Dialogs />)
    requestFolderDelete('g', true)
    await settle()
    const d = dialog()!
    expect(document.activeElement).toBe(d)
    run.mockClear()
    act(() => {
      d.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })
    expect(run).toHaveBeenCalledWith('folder.delete', { folderId: 'g', unpack: false })
    expect(uiStore.get().folderDeleteConfirm).toBeNull()
    // The header went with the folder: not the keyboard's way back, even from the keyboard.
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
    await settle()
    expect(document.activeElement).not.toBe(document.querySelector('[data-tab-folder="g"]'))
  })

  it('says of a saved folder that its pages are forgotten', async () => {
    const saved = folder({
      savedTabs: [
        { url: 'https://a.example/', title: 'A' },
        { url: 'https://b.example/', title: 'B' },
        { url: 'https://c.example/', title: 'C' }
      ]
    })
    browserStore.set({ state: state([tab('home', null)], [saved]) })
    render(<Dialogs />)
    requestFolderDelete('g', false)
    await settle()
    expect(dialog()!.querySelector('.zen-v2-title-block-description')!.textContent).toBe(
      'Its 3 saved pages are forgotten with it. There is no undo.'
    )
  })

  it('Delete runs folder.delete without unpacking and closes; the page takes the keyboard back', async () => {
    browserStore.set({ state: state([tab('home', null), tab('a', 'g')], [folder()]) })
    render(<Dialogs />)
    requestFolderDelete('g', true)
    await settle()
    run.mockClear()
    click(buttons(dialog()!)[1])
    expect(run).toHaveBeenCalledWith('folder.delete', { folderId: 'g', unpack: false })
    expect(uiStore.get().folderDeleteConfirm).toBeNull()
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
    await settle()
    expect(dialog()).toBeNull()
  })

  it('Cancel and Escape delete nothing; a keyboard’s Cancel hands the keyboard back to the folder’s header, a pointer’s to the page', async () => {
    browserStore.set({ state: state([tab('home', null), tab('a', 'g')], [folder()]) })
    render(<Dialogs />)
    requestFolderDelete('g', true)
    await settle()
    run.mockClear()
    click(buttons(dialog()!)[0])
    expect(run).not.toHaveBeenCalledWith('folder.delete', expect.anything())
    expect(run).not.toHaveBeenCalledWith('focus.content', undefined)
    expect(uiStore.get().folderDeleteConfirm).toBeNull()
    expect(document.activeElement).toBe(document.querySelector('[data-tab-folder="g"]'))
    await settle()

    requestFolderDelete('g', false)
    await settle()
    run.mockClear()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(run).not.toHaveBeenCalledWith('folder.delete', expect.anything())
    expect(uiStore.get().folderDeleteConfirm).toBeNull()
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
  })

  it('a keyboard’s Cancel waits for the chrome’s inert to lift before the header takes the focus (lib/popover.ts returnFocusTo)', async () => {
    // The strip's header stands in the window chrome, which the frame's host keeps inert through
    // the prompt's way out (§9.5); an inert control refuses `focus()`, as the header does here
    // while its chrome is marked.
    const header = document.querySelector<HTMLElement>('[data-tab-folder="g"]')!
    const chrome = document.createElement('aside')
    chrome.setAttribute('inert', '')
    chrome.appendChild(header)
    document.body.appendChild(chrome)
    const focus = header.focus.bind(header)
    header.focus = (options) => {
      if (!header.closest('[inert]')) focus(options)
    }
    browserStore.set({ state: state([tab('home', null), tab('a', 'g')], [folder()]) })
    render(<Dialogs />)
    requestFolderDelete('g', true)
    await settle()
    run.mockClear()
    click(buttons(dialog()!)[0])
    expect(uiStore.get().folderDeleteConfirm).toBeNull()
    expect(document.activeElement).not.toBe(header)
    await settle()
    expect(document.activeElement).not.toBe(header)
    act(() => chrome.removeAttribute('inert'))
    await settle()
    expect(document.activeElement).toBe(header)
    expect(run).not.toHaveBeenCalledWith('focus.content', undefined)
  })

  it('goes with the folder when it is deleted or emptied under the question', async () => {
    browserStore.set({ state: state([tab('home', null), tab('a', 'g')], [folder()]) })
    render(<Dialogs />)
    requestFolderDelete('g', false)
    await settle()
    expect(dialog()).not.toBeNull()
    act(() => browserStore.set({ state: state([tab('home', null)], []) }))
    await settle()
    expect(uiStore.get().folderDeleteConfirm).toBeNull()
    expect(dialog()).toBeNull()
  })
})
