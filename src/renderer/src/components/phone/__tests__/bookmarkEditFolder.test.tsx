// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { BookmarkNode, Space, Tab, UIState } from '@shared/types'
import {
  BOOKMARKS_BAR_ID,
  createBookmarkRoots,
  MOBILE_BOOKMARKS_ID,
  OTHER_BOOKMARKS_ID
} from '@shared/bookmarks'
import { DEFAULT_SETTINGS } from '@shared/defaults'

/*
 * The bookmark editor's Folder row and its folder pane (HB-16; Chrome 152's
 * `BookmarkEditActivity` folder row → `BookmarkFolderPickerMediator`; v2 draft §9.13, §9.24,
 * §10.4): under Name and Address the row is §10.4's value row – the parent folder's title as
 * the 13/69 % description under its label (`Folder`, `Parent folder` for a folder; the folder's
 * own editor titled `Edit folder`), no chevron; a tap steps the sheet into the folder pane – the
 * picker's radio list of every folder the node can enter (never the edited folder or its
 * subtree), the folder Save would use checked, the folder it stands in now saying `Current` –
 * with Back leading and `New folder` trailing in the header, each swap riding the 120 ms
 * `--zen-ease` state change (`data-from` on the pane names the side it comes from). A pick
 * steps back to the form with the row reading the picked folder; nothing is written by the
 * pick; the system back and Escape in the pane are the header's Back, one hop. Save runs
 * `bookmark.update` and then `bookmark.move` in the one commit once the sheet is gone; a new
 * node is created into the picked folder. `New folder` makes a folder at once inside the
 * checked one (`bookmark.create`) and picks it – the pick standing on the created node until
 * the state carries it. Rendered for real on the frame's dialog host, the frame loop cranked by
 * hand.
 */

const SPACE = 'space'
const NOW = 1_700_000_000_000

let created: BookmarkNode | null = null
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name) =>
  name === 'bookmark.create' ? created : null
)
Object.assign(window, {
  zen: {
    invoke,
    on: () => () => undefined
  }
})
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { BookmarkEditSheet } = await import('../BookmarkEditSheet')
const { FrameDialogHost } = await import('@renderer/lib/portals')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { dispatchBackEvent } = await import('@renderer/lib/back')

// --- a profile ---------------------------------------------------------------------------------

function tab(id: string, url: string): Tab {
  return {
    id,
    spaceId: SPACE,
    containerId: 'default',
    url,
    title: id,
    favicon: null,
    pinned: false,
    essential: false,
    loading: false,
    canGoBack: false,
    canGoForward: false
  } as unknown as Tab
}

function url(id: string, parentId: string, index: number, title: string): BookmarkNode {
  return { id, parentId, index, type: 'url', title, url: `https://${id}.example/`, dateAdded: NOW }
}
function folder(id: string, parentId: string, index: number, title: string): BookmarkNode {
  return { id, parentId, index, type: 'folder', title, dateAdded: NOW }
}

/**
 * Mobile bookmarks: the page News, the folder Work (holding Jira and the folder Specs) and the
 * folder Home (empty). Other bookmarks: the page Docs.
 */
const profile = (): BookmarkNode[] => [
  ...createBookmarkRoots(NOW),
  url('news', MOBILE_BOOKMARKS_ID, 0, 'News'),
  folder('work', MOBILE_BOOKMARKS_ID, 1, 'Work'),
  url('jira', 'work', 0, 'Jira'),
  folder('specs', 'work', 1, 'Specs'),
  folder('home', MOBILE_BOOKMARKS_ID, 2, 'Home'),
  url('docs', OTHER_BOOKMARKS_ID, 0, 'Docs')
]

function stateOf(bookmarks: BookmarkNode[] = profile()): UIState {
  const tabs = [tab('t1', 'https://example.com/')]
  const space: Space = {
    id: SPACE,
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId: 't1',
    pinnedCollapsed: false
  }
  return {
    platform: 'android',
    capabilities: { windowControls: false, extensions: false, pageTabs: true },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [space],
    activeSpaceId: SPACE,
    folders: {},
    essentialTabIds: [],
    containers: [],
    settings: { ...DEFAULT_SETTINGS },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks,
    recentlyClosed: [],
    readingList: []
  } as unknown as UIState
}

// --- a clock and a frame loop ------------------------------------------------------------------

/** A hand-cranked animation frame: `run(n)` advances the clock 16 ms a frame and runs the callbacks. */
class Frames {
  now = 0
  private queue = new Map<number, (now: number) => void>()
  private seq = 0

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++this.seq
      this.queue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue.delete(id)
    })
    vi.spyOn(performance, 'now').mockImplementation(() => this.now)
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) {
      this.now += 16
      const pending = [...this.queue.values()]
      this.queue.clear()
      for (const cb of pending) cb(this.now)
    }
  }
}

const frames = new Frames()
let root: Root | null = null
let host: HTMLElement | null = null
let sizes: Array<[string, PropertyDescriptor | undefined]> = []

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

/** Run the springs out: the sheet lands, or leaves. */
async function land(): Promise<void> {
  await act(async () => {
    frames.run(150)
  })
  await settle()
}

type Edit = { id: string | null; parentId: string; type: 'url' | 'folder' }

function render(state: UIState, edit: Edit): void {
  act(() =>
    root!.render(
      createElement(FrameDialogHost, null, createElement(BookmarkEditSheet, { state, edit }))
    )
  )
}

/** The editor is up for `edit` over `state`. */
async function show(state: UIState, edit: Edit): Promise<void> {
  act(() => browserStore.set({ state }))
  if (!root) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  act(() => uiStore.set({ bookmarkEdit: edit }))
  render(state, edit)
  await settle()
  await land()
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  })
  vi.setSystemTime(NOW)
  frames.install()
  invoke.mockClear()
  created = null
  viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
  sizes = ['clientHeight', 'offsetHeight'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  ])
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('zen-sheet-scroll') ? 300 : 800
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 300
  })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  host?.remove()
  host = null
  uiStore.set({ bookmarkEdit: null, toasts: [] })
  browserStore.set({ state: null })
  for (const [name, descriptor] of sizes) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  frames.now = 0
})

// --- helpers -----------------------------------------------------------------------------------

const of = (name: string): unknown[] =>
  invoke.mock.calls.filter(([n]) => n === name).map(([, args]) => args)
const calls = (): string[] =>
  invoke.mock.calls.map(([n]) => n).filter((n) => n.startsWith('bookmark.'))
const dialogs = (): HTMLElement =>
  document.querySelector<HTMLElement>('.zen-frame-dialogs') ?? document.body
const sheetTitle = (): string =>
  dialogs().querySelector('.zen-sheet-title')?.textContent?.trim() ?? ''
const folderRow = (): HTMLButtonElement | null =>
  dialogs().querySelector<HTMLButtonElement>('[data-testid="bookmark-folder"]')
/** The pane in view – the form or the folder list – the element whose entrance is the swap's. */
const pane = (): HTMLElement | null =>
  dialogs().querySelector<HTMLElement>('.zen-bookmark-edit-pane')
const radiogroup = (): HTMLElement | null =>
  dialogs().querySelector<HTMLElement>('[role="radiogroup"]')
const radios = (): HTMLButtonElement[] => [
  ...dialogs().querySelectorAll<HTMLButtonElement>('[role="radio"]')
]
const radioTitle = (radio: HTMLElement): string =>
  radio.querySelector('.min-w-0')?.textContent?.trim() ?? ''
const rowTitles = (): string[] => radios().map(radioTitle)
const checkedTitle = (): string | null => {
  const checked = radios().find((r) => r.getAttribute('aria-checked') === 'true')
  return checked ? radioTitle(checked) : null
}
const currentTitles = (): string[] =>
  radios()
    .filter((r) => r.querySelector('.zen-list-value')?.textContent?.trim() === 'Current')
    .map(radioTitle)
const button = (text: string): HTMLButtonElement => {
  const found = [...dialogs().querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text
  )
  if (!found) throw new Error(`no button "${text}"`)
  return found
}
const inputs = (): HTMLInputElement[] => [...dialogs().querySelectorAll<HTMLInputElement>('input')]

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

// --- the row and the pane ----------------------------------------------------------------------

describe("the bookmark editor's Folder row (HB-16)", () => {
  it('reads the parent folder as the 13/69 % value under its label – §10.4’s value row, no chevron, named "label, value" – under the Address field, and steps into the folder pane on a tap – every folder the bookmark can enter, its own folder checked and marked Current', async () => {
    await show(stateOf(), { id: 'jira', parentId: 'work', type: 'url' })
    expect(sheetTitle()).toBe('Edit bookmark')
    const row = folderRow()!
    expect(row).not.toBeNull()
    expect(row.textContent).toContain('Folder')
    // The value row's second line: 13 on the small line in the deemphasised (69 %) ink.
    const value = row.querySelector('.text-\\[13px\\]')!
    expect(value.textContent?.trim()).toBe('Work')
    expect(value.classList.contains('text-[var(--v2-text-deemphasized)]')).toBe(true)
    expect(value.classList.contains('leading-[var(--v2-line-small)]')).toBe(true)
    // No control drawn, no chevron: the tap itself opens the pane.
    expect(row.querySelector('svg')).toBeNull()
    expect(row.getAttribute('aria-label')).toBe('Folder, Work')
    // No `data-from` on the sheet's first open: the entrance is the sheet's own slide.
    expect(pane()!.hasAttribute('data-from')).toBe(false)
    // Under the two fields, above the Reading list row (HB-20) and the footer.
    const form = row.closest('form')!
    const kinds = [...form.children].map((el) =>
      el === row
        ? 'folder'
        : el.matches('[data-testid="bookmark-reading-list"]')
          ? 'reading-list'
          : el.classList.contains('zen-sheet-footer')
            ? 'footer'
            : 'field'
    )
    expect(kinds).toEqual(['field', 'field', 'folder', 'reading-list', 'footer'])

    act(() => row.click())
    await settle()
    // The pane: the row's label as the header, Back leading, New folder trailing; the whole
    // tree in reading order with its depth; the bookmark's folder checked and Current.
    expect(sheetTitle()).toBe('Folder')
    expect(button('Back')).not.toBeNull()
    expect(button('New folder').disabled).toBe(false)
    // The roots as the panel lists them (`topLevelRoots`): the empty Bookmarks bar left out.
    expect(rowTitles()).toEqual(['Mobile bookmarks', 'Work', 'Specs', 'Home', 'Other bookmarks'])
    expect(checkedTitle()).toBe('Work')
    expect(currentTitles()).toEqual(['Work'])
    expect(radios()[2]!.style.paddingInlineStart).toBe('48px')
    expect(inputs()).toEqual([])
    // The group is named by the header it stands under; each row by its title, its parent and
    // its standing, so the indent's depth reaches a screen reader too.
    expect(radiogroup()!.getAttribute('aria-label')).toBe('Folder')
    expect(radios().map((r) => r.getAttribute('aria-label'))).toEqual([
      'Mobile bookmarks',
      'Work, in Mobile bookmarks, current folder',
      'Specs, in Work',
      'Home, in Mobile bookmarks',
      'Other bookmarks'
    ])
    // Nothing written by stepping in.
    expect(calls()).toEqual([])
  })

  it('swaps its panes on the 120 ms --zen-ease state change, the pane naming the side it comes from – form going in, folder coming back – and cut, not re-declared, under reduced motion', async () => {
    await show(stateOf(), { id: 'jira', parentId: 'work', type: 'url' })
    const first = pane()!
    expect(first.hasAttribute('data-from')).toBe(false)
    act(() => folderRow()!.click())
    await settle()
    // A new element each swap, so the entrance plays again.
    expect(pane()).not.toBe(first)
    expect(pane()!.getAttribute('data-from')).toBe('form')
    act(() => button('Back').click())
    await settle()
    expect(pane()!.getAttribute('data-from')).toBe('folder')
    act(() => folderRow()!.click())
    await settle()
    expect(pane()!.getAttribute('data-from')).toBe('form')

    // The sheet's motion: `data-from` starts the 120 ms `--zen-ease` entrance, the back swap on
    // its own keyframes from the start edge; both `transform` and `opacity` alone (v2 §11), and
    // nothing under `prefers-reduced-motion` – the global remover cuts it (§11.3).
    const css = readFileSync(resolve(__dirname, '../phonePanels.css'), 'utf8')
    expect(css).toMatch(
      /\.zen-bookmark-edit-pane\[data-from\] \{\n\s+animation: zen-bookmark-edit-pane-in 120ms var\(--zen-ease\);\n\s+\}/
    )
    expect(css).toMatch(
      /\.zen-bookmark-edit-pane\[data-from='folder'\] \{\n\s+animation-name: zen-bookmark-edit-pane-back;\n\s+\}/
    )
    for (const [name, from] of [
      ['zen-bookmark-edit-pane-in', 'translateX(24px)'],
      ['zen-bookmark-edit-pane-back', 'translateX(-24px)']
    ]) {
      const steps = css.match(new RegExp(`@keyframes ${name} \\{([^@]*?)\\n {2}\\}`))?.[1] ?? ''
      expect(steps, name).toContain(`transform: ${from};`)
      expect(
        steps
          .match(/^\s+([a-z-]+):/gm)
          ?.map((m) => m.trim().slice(0, -1))
          .sort()
      ).toEqual(['opacity', 'opacity', 'transform', 'transform'])
    }
    expect(css).not.toMatch(/prefers-reduced-motion[^}]*zen-bookmark-edit-pane/s)
  })

  it('names a folder’s row Parent folder under the Edit folder title and lists neither the folder itself nor its descendants', async () => {
    await show(stateOf(), { id: 'work', parentId: MOBILE_BOOKMARKS_ID, type: 'folder' })
    // Chrome 152's `IDS_EDIT_FOLDER` (android_chrome_strings.grd l.4628-4630): the sheet moves
    // the folder as well as renaming it.
    expect(sheetTitle()).toBe('Edit folder')
    const row = folderRow()!
    expect(row.textContent).toContain('Parent folder')
    expect(row.textContent).toContain('Mobile bookmarks')
    expect(row.getAttribute('aria-label')).toBe('Parent folder, Mobile bookmarks')
    // A folder has no Address field: Name, the row, the footer.
    expect(inputs().length).toBe(1)

    act(() => row.click())
    await settle()
    expect(sheetTitle()).toBe('Parent folder')
    expect(radiogroup()!.getAttribute('aria-label')).toBe('Parent folder')
    expect(rowTitles()).toEqual(['Mobile bookmarks', 'Home', 'Other bookmarks'])
    expect(checkedTitle()).toBe('Mobile bookmarks')
    expect(currentTitles()).toEqual(['Mobile bookmarks'])
  })

  it('says none of the strings the lead ruled out – Rename folder, Move to…, Location – anywhere in the editor or its pane', async () => {
    const seen: string[] = []
    const collect = (): void => {
      seen.push(dialogs().textContent ?? '')
      for (const el of dialogs().querySelectorAll('[aria-label], [placeholder]'))
        seen.push(el.getAttribute('aria-label') ?? '', el.getAttribute('placeholder') ?? '')
    }
    await show(stateOf(), { id: 'work', parentId: MOBILE_BOOKMARKS_ID, type: 'folder' })
    collect()
    act(() => folderRow()!.click())
    await settle()
    collect()
    act(() => button('New folder').click())
    await settle()
    await land()
    collect()
    for (const text of seen) {
      expect(text).not.toContain('Rename folder')
      expect(text).not.toContain('Move to')
      expect(text).not.toContain('Location')
    }
  })

  it('has no Folder row for a root, which cannot move', async () => {
    await show(stateOf(), { id: MOBILE_BOOKMARKS_ID, parentId: '0', type: 'folder' })
    expect(folderRow()).toBeNull()
  })

  it('picks a folder on a tap and steps back to the form, the row reading the pick and nothing written; Back steps back with nothing picked', async () => {
    await show(stateOf(), { id: 'jira', parentId: 'work', type: 'url' })
    act(() => folderRow()!.click())
    await settle()
    act(() => button('Back').click())
    await settle()
    expect(sheetTitle()).toBe('Edit bookmark')
    expect(folderRow()!.textContent).toContain('Work')

    act(() => folderRow()!.click())
    await settle()
    act(() =>
      radios()
        .find((r) => radioTitle(r) === 'Home')!
        .click()
    )
    await settle()
    expect(sheetTitle()).toBe('Edit bookmark')
    expect(folderRow()!.textContent).toContain('Home')
    expect(inputs()[0]!.value).toBe('Jira')
    expect(calls()).toEqual([])

    // Stepping in again: the pick is checked, the folder it stands in still Current.
    act(() => folderRow()!.click())
    await settle()
    expect(checkedTitle()).toBe('Home')
    expect(currentTitles()).toEqual(['Work'])
  })

  it('moves the focus onto the checked folder as the pane opens and back onto the Folder row as it closes', async () => {
    await show(stateOf(), { id: 'jira', parentId: 'work', type: 'url' })
    act(() => folderRow()!.click())
    await settle()
    const checked = radios().find((r) => r.getAttribute('aria-checked') === 'true')!
    expect(document.activeElement).toBe(checked)

    act(() => button('Back').click())
    await settle()
    expect(document.activeElement).toBe(folderRow())

    act(() => folderRow()!.click())
    await settle()
    act(() =>
      radios()
        .find((r) => radioTitle(r) === 'Home')!
        .click()
    )
    await settle()
    expect(document.activeElement).toBe(folderRow())
  })

  it('takes the system back in the pane as the header’s Back – the form comes back with the editor still up – and from the form as the sheet’s dismissal', async () => {
    await show(stateOf(), { id: 'jira', parentId: 'work', type: 'url' })
    act(() => folderRow()!.click())
    await settle()
    expect(sheetTitle()).toBe('Folder')
    act(() => {
      dispatchBackEvent('start', { edge: 'left' })
      dispatchBackEvent('commit')
    })
    await settle()
    await land()
    expect(sheetTitle()).toBe('Edit bookmark')
    expect(uiStore.get().bookmarkEdit).not.toBeNull()
    expect(calls()).toEqual([])

    act(() => {
      dispatchBackEvent('start', { edge: 'left' })
      dispatchBackEvent('commit')
    })
    await settle()
    await land()
    expect(uiStore.get().bookmarkEdit).toBeNull()
    expect(calls()).toEqual([])
  })

  it('takes Escape in the pane as the header’s Back too – the form back, the draft kept – and from the form as the sheet’s dismissal', async () => {
    const escape = (): void => {
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
        )
      })
    }
    await show(stateOf(), { id: 'jira', parentId: 'work', type: 'url' })
    type(inputs()[0]!, 'Jira board')
    act(() => folderRow()!.click())
    await settle()
    expect(sheetTitle()).toBe('Folder')
    escape()
    await settle()
    await land()
    expect(sheetTitle()).toBe('Edit bookmark')
    expect(uiStore.get().bookmarkEdit).not.toBeNull()
    expect(inputs()[0]!.value).toBe('Jira board')
    expect(calls()).toEqual([])

    // With the naming sheet over the pane, Escape is that sheet's: the pane stays.
    act(() => folderRow()!.click())
    await settle()
    act(() => button('New folder').click())
    await settle()
    await land()
    escape()
    await settle()
    await land()
    expect(sheetTitle()).toBe('Folder')
    expect([...dialogs().querySelectorAll('.zen-sheet-title')].map((t) => t.textContent)).toEqual([
      'Folder'
    ])

    // From the form, the sheet's own Escape: its dismissal.
    escape()
    await settle()
    await land()
    expect(sheetTitle()).toBe('Edit bookmark')
    escape()
    await settle()
    await land()
    expect(uiStore.get().bookmarkEdit).toBeNull()
    expect(calls()).toEqual([])
  })
})

// --- Save and New folder -----------------------------------------------------------------------

describe("the bookmark editor's Save with a picked folder (HB-16)", () => {
  it('runs bookmark.update and then bookmark.move in the one commit once the sheet is gone, and clears the request', async () => {
    await show(stateOf(), { id: 'jira', parentId: 'work', type: 'url' })
    type(inputs()[0]!, 'Jira board')
    act(() => folderRow()!.click())
    await settle()
    act(() =>
      radios()
        .find((r) => radioTitle(r) === 'Specs')!
        .click()
    )
    await settle()
    act(() => button('Save').click())
    await land()
    expect(calls()).toEqual(['bookmark.update', 'bookmark.move'])
    expect(of('bookmark.update')).toEqual([
      { id: 'jira', title: 'Jira board', url: 'https://jira.example/' }
    ])
    expect(of('bookmark.move')).toEqual([{ ids: ['jira'], parentId: 'specs' }])
    expect(uiStore.get().bookmarkEdit).toBeNull()
  })

  it('moves nothing when the folder was not changed', async () => {
    await show(stateOf(), { id: 'jira', parentId: 'work', type: 'url' })
    act(() => folderRow()!.click())
    await settle()
    act(() =>
      radios()
        .find((r) => radioTitle(r) === 'Work')!
        .click()
    )
    await settle()
    act(() => button('Save').click())
    await land()
    expect(calls()).toEqual(['bookmark.update'])
  })

  it('moves a renamed folder too, after its update', async () => {
    await show(stateOf(), { id: 'work', parentId: MOBILE_BOOKMARKS_ID, type: 'folder' })
    act(() => folderRow()!.click())
    await settle()
    act(() =>
      radios()
        .find((r) => radioTitle(r) === 'Other bookmarks')!
        .click()
    )
    await settle()
    act(() => button('Save').click())
    await land()
    expect(calls()).toEqual(['bookmark.update', 'bookmark.move'])
    expect(of('bookmark.update')).toEqual([{ id: 'work', title: 'Work' }])
    expect(of('bookmark.move')).toEqual([{ ids: ['work'], parentId: OTHER_BOOKMARKS_ID }])
  })

  it('creates a new bookmark straight into the picked folder', async () => {
    await show(stateOf(), { id: null, parentId: MOBILE_BOOKMARKS_ID, type: 'url' })
    expect(sheetTitle()).toBe('Add bookmark')
    expect(folderRow()!.textContent).toContain('Mobile bookmarks')
    type(inputs()[1]!, 'https://new.example/')
    act(() => folderRow()!.click())
    await settle()
    // A new node stands nowhere yet: no row says Current; every folder is open to it.
    expect(currentTitles()).toEqual([])
    expect(rowTitles()).toEqual(['Mobile bookmarks', 'Work', 'Specs', 'Home', 'Other bookmarks'])
    act(() =>
      radios()
        .find((r) => radioTitle(r) === 'Specs')!
        .click()
    )
    await settle()
    act(() => button('Save').click())
    await land()
    expect(calls()).toEqual(['bookmark.create'])
    expect(of('bookmark.create')).toEqual([
      { parentId: 'specs', title: 'https://new.example/', url: 'https://new.example/', type: 'url' }
    ])
  })

  it('New folder names a folder in a second sheet, makes it at once inside the checked folder and picks it, the form coming back with its title', async () => {
    await show(stateOf(), { id: 'jira', parentId: 'work', type: 'url' })
    act(() => folderRow()!.click())
    await settle()
    act(() =>
      radios()
        .find((r) => radioTitle(r) === 'Home')!
        .click()
    )
    await settle()
    act(() => folderRow()!.click())
    await settle()
    expect(checkedTitle()).toBe('Home')
    act(() => button('New folder').click())
    await settle()
    await land()
    // The one-field sheet over the editor: named by its header, no label, the field's
    // placeholder saying where the folder goes; Create disabled until a name.
    const titles = [...dialogs().querySelectorAll('.zen-sheet-title')].map((t) => t.textContent)
    expect(titles).toEqual(['Folder', 'New folder'])
    const field = inputs()[0]!
    expect(field.getAttribute('aria-labelledby')).toBeTruthy()
    expect(field.placeholder).toBe('Folder in Home')
    expect(button('Create').disabled).toBe(true)
    created = folder('made', 'home', 0, 'Reads')
    type(field, 'Reads')
    expect(button('Create').disabled).toBe(false)
    act(() => button('Create').click())
    await land()
    expect(of('bookmark.create')).toEqual([{ parentId: 'home', title: 'Reads', type: 'folder' }])
    // Picked: the form is back, its row reading the new folder once the tree holds it.
    const state = stateOf([...profile(), created])
    render(state, { id: 'jira', parentId: 'work', type: 'url' })
    await settle()
    expect(sheetTitle()).toBe('Edit bookmark')
    expect(folderRow()!.textContent).toContain('Reads')
    act(() => button('Save').click())
    await land()
    expect(of('bookmark.move')).toEqual([{ ids: ['jira'], parentId: 'made' }])
  })

  it('stands the pick on the created folder in the tick before the state carries it – the row reading its title, Save moving into it', async () => {
    await show(stateOf(), { id: 'jira', parentId: 'work', type: 'url' })
    act(() => folderRow()!.click())
    await settle()
    act(() => button('New folder').click())
    await settle()
    await land()
    created = folder('made', 'work', 2, 'Reads')
    type(inputs()[0]!, 'Reads')
    act(() => button('Create').click())
    await land()
    expect(of('bookmark.create')).toEqual([{ parentId: 'work', title: 'Reads', type: 'folder' }])
    // `bookmark.create` has answered; no state carries the folder yet. The form is back on the
    // created folder, not the one the bookmark stands in.
    expect(sheetTitle()).toBe('Edit bookmark')
    expect(folderRow()!.textContent).toContain('Reads')
    expect(folderRow()!.getAttribute('aria-label')).toBe('Folder, Reads')
    // Stepping in before the state arrives: the created folder is not among the rows, so none
    // is checked and New folder waits; Back keeps the pick.
    act(() => folderRow()!.click())
    await settle()
    expect(checkedTitle()).toBeNull()
    expect(button('New folder').disabled).toBe(true)
    act(() => button('Back').click())
    await settle()
    expect(folderRow()!.textContent).toContain('Reads')
    act(() => button('Save').click())
    await land()
    expect(calls()).toEqual(['bookmark.create', 'bookmark.update', 'bookmark.move'])
    expect(of('bookmark.move')).toEqual([{ ids: ['jira'], parentId: 'made' }])
  })

  it('falls back to the folder the bookmark stands in when the picked one has gone from the tree – that folder checked again, Save moving nowhere', async () => {
    await show(stateOf(), { id: 'jira', parentId: 'work', type: 'url' })
    act(() => folderRow()!.click())
    await settle()
    act(() =>
      radios()
        .find((r) => radioTitle(r) === 'Home')!
        .click()
    )
    await settle()
    expect(folderRow()!.textContent).toContain('Home')
    // Home is deleted elsewhere: the state arrives without it.
    const state = stateOf(profile().filter((n) => n.id !== 'home'))
    act(() => browserStore.set({ state }))
    render(state, { id: 'jira', parentId: 'work', type: 'url' })
    await settle()
    expect(folderRow()!.textContent).toContain('Work')
    expect(folderRow()!.textContent).not.toContain('Home')
    act(() => folderRow()!.click())
    await settle()
    expect(rowTitles()).toEqual(['Mobile bookmarks', 'Work', 'Specs', 'Other bookmarks'])
    expect(checkedTitle()).toBe('Work')
    expect(currentTitles()).toEqual(['Work'])
    expect(button('New folder').disabled).toBe(false)
    act(() => button('Back').click())
    await settle()
    act(() => button('Save').click())
    await land()
    expect(calls()).toEqual(['bookmark.update'])
  })

  it('checks nothing and holds New folder when the folder the request names is not one the pane lists – a new bookmark into the empty Bookmarks bar', async () => {
    await show(stateOf(), { id: null, parentId: BOOKMARKS_BAR_ID, type: 'url' })
    expect(folderRow()!.textContent).toContain('Bookmarks bar')
    act(() => folderRow()!.click())
    await settle()
    // The empty, non-default root is not among the rows (`topLevelRoots`): no row is checked,
    // and New folder – which creates inside the checked folder – waits for a pick.
    expect(rowTitles()).toEqual(['Mobile bookmarks', 'Work', 'Specs', 'Home', 'Other bookmarks'])
    expect(checkedTitle()).toBeNull()
    expect(currentTitles()).toEqual([])
    expect(button('New folder').disabled).toBe(true)
    act(() =>
      radios()
        .find((r) => radioTitle(r) === 'Home')!
        .click()
    )
    await settle()
    act(() => folderRow()!.click())
    await settle()
    expect(checkedTitle()).toBe('Home')
    expect(button('New folder').disabled).toBe(false)
  })
})
