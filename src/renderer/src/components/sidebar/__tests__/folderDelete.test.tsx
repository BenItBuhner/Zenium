// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type JSX, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

/*
 * "Delete <folder>?" (TAB-16's desktop half; components/sidebar/FolderDeleteDialog.tsx and
 * lib/folderDelete.ts): the desktop's folder menu and the group editor bubble both ask through
 * `requestFolderDelete` – an empty folder goes at once, one holding tabs or saved pages only
 * through the §9.23 prompt at §9.20's 320 on the frame's dialog host, Cancel focused (§9.22),
 * Escape and the scrim as Cancel, the danger verb running `folder.delete` without unpacking; a
 * Cancel from the keyboard hands the keyboard back to the folder's header (§9.5).
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
  it('is the §9.23 composition at 320 on the frame’s host: the question with the trash glyph, one line on what goes, Cancel focused then Delete in the danger ink', async () => {
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
    expect(d.style.width).toBe('320px')
    expect(d.classList.contains('zen-bm-dialog')).toBe(true)
    const title = d.querySelector('.zen-bm-title')!
    expect(title.textContent).toBe('Delete Trip planning?')
    expect(title.querySelector('svg.lucide-trash-2')).not.toBeNull()
    expect(d.getAttribute('aria-labelledby')).toBe(title.id)
    const detail = d.querySelector('.zen-bm-title-desc')!
    expect(detail.textContent).toBe('Its 2 tabs close with it; Recently Closed keeps their pages.')
    expect(d.getAttribute('aria-describedby')).toBe(detail.id)
    const [cancel, del] = buttons(d)
    expect(buttons(d)).toHaveLength(2)
    expect(cancel.textContent).toBe('Cancel')
    expect(cancel.hasAttribute('data-variant')).toBe(false)
    expect(del.textContent).toBe('Delete')
    expect(del.dataset.variant).toBe('danger')
    expect(del.dataset.action).toBe('delete')
    expect(d.querySelector('[data-primary]')).toBeNull()
    expect(document.activeElement).toBe(cancel)
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
    expect(dialog()!.querySelector('.zen-bm-title-desc')!.textContent).toBe(
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
