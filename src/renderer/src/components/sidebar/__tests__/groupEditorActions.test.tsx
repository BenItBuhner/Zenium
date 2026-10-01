// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'
import { FOLDER_COLOR_ORDER } from '@shared/defaults'
import { TOAST_UNDO_MS } from '@shared/toastCard'

/*
 * The group editor bubble's actions and swatch row on a saved group (TAB-16's desktop half;
 * components/sidebar/GroupEditorBubble.tsx): an open folder's rows are New tab, Unpack, Close
 * (Chrome's Close group – the folder stays saved with its pages, so the plain ink) and Delete in
 * the danger ink; a saved folder's are Open folder with its page count and Delete alone – New
 * tab in folder would forget the pages it kept (the model's `folderOpened` rule), so the row
 * waits for Open; Delete goes through the "Delete <folder>?" prompt when the folder holds anything
 * and deletes an empty folder outright. The colour row is §9.14's swatch form: the nine colours
 * in Chrome's order as a radio group of 28 px round targets touching (the 20 px discs 8 apart
 * on a 28 pitch, the nine discs 244 wide), the picked one ringed. On the touch layout (the
 * tablet; TABLET-22) the nouns read Group and Close goes the undoable way, the group row menu's
 * – the desktop's bubble byte for byte as before.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const run = vi.fn()
const cmd = vi.fn<(name: string, args: unknown) => Promise<unknown>>()
vi.mock('@renderer/lib/api', () => ({
  run: (...args: unknown[]) => run(...args),
  cmd: (name: string, args: unknown) => cmd(name, args),
  onEvent: () => () => undefined
}))

const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { CLOSE_SETTLE_MS } = await import('@renderer/lib/closeUndo')
const { GroupEditorLayer } = await import('../GroupEditorBubble')

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')

/** The text of the first `selector {` rule in the stylesheet. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

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
    name: 'Research',
    icon: '📁',
    color: 'blue',
    collapsed: false,
    ...over
  }) as Folder

const PAGES = [
  { url: 'https://a.example/', title: 'A' },
  { url: 'https://b.example/', title: 'B' },
  { url: 'https://c.example/', title: 'C' }
]

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

let container: HTMLDivElement
let root: Root

/**
 * The bubble up for folder `g` over `tabs`: the page's picture taken, the panel placed. The
 * layout is set after the state: the viewport store re-derives it from this document (a desktop)
 * on every state push, so the touch layout under test must be the last word.
 */
async function bubble(
  tabs: Tab[],
  f: Folder,
  layout: 'desktop' | 'tablet' = 'desktop'
): Promise<HTMLElement> {
  browserStore.set({ state: state(tabs, [f]) })
  viewportStore.set({
    ...viewportStore.get(),
    formFactor: layout,
    coarse: layout === 'tablet',
    hover: layout === 'desktop'
  })
  act(() => root.render(<GroupEditorLayer />))
  act(() => uiStore.set({ groupEditor: { folderId: 'g', keyboard: false } }))
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  const el = document.querySelector<HTMLElement>('[data-group-editor="g"]')
  expect(el).not.toBeNull()
  return el!
}

const actions = (el: HTMLElement): HTMLButtonElement[] => [
  ...el.querySelectorAll<HTMLButtonElement>('.zen-group-editor-action')
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
  uiStore.set({ groupEditor: null, folderDeleteConfirm: null, snapshot: null, snapshotTabId: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  uiStore.set({ groupEditor: null, folderDeleteConfirm: null })
  browserStore.set({ state: null })
})

describe('the bubble’s actions', () => {
  it('for an open folder: New tab, Unpack, Close with the tab count in the plain ink, Delete in the danger ink', async () => {
    const el = await bubble([tab('home', null), tab('a', 'g'), tab('b', 'g')], folder())
    const rows = actions(el)
    expect(rows.map((r) => r.dataset.action)).toEqual(['new-tab', 'unpack', 'close', 'delete'])
    expect(rows.map((r) => r.querySelector('.zen-v2-label')!.textContent)).toEqual([
      'New tab in folder',
      'Unpack folder',
      'Close folder',
      'Delete folder'
    ])
    const close = rows[2]!
    expect(close.querySelector('.zen-group-editor-count')!.textContent).toBe('2 tabs')
    expect(close.hasAttribute('data-danger')).toBe(false)
    expect(rows[3]!.hasAttribute('data-danger')).toBe(true)
    for (const r of rows) {
      expect(r.classList.contains('zen-v2-row')).toBe(true)
      expect(r.querySelector('svg')).not.toBeNull()
    }
    expect(rule('.zen-v2-row.zen-group-editor-action[data-danger]')).toContain(
      'color: var(--v2-danger)'
    )
    // Close keeps the folder: Chrome's Close group through the core, the bubble away. The
    // desktop's close is the core's alone – no undoable intent, no toast (TABLET-22's route is
    // the touch layout's).
    click(close)
    expect(run).toHaveBeenCalledWith('folder.close', { folderId: 'g' })
    expect(run).not.toHaveBeenCalledWith('folder.delete', expect.anything())
    expect(uiStore.get().groupEditor).toBeNull()
    expect(cmd).not.toHaveBeenCalledWith('session.recentlyClosed', expect.anything())
    expect(uiStore.get().toasts).toEqual([])
  })

  it('for a saved folder: Open folder with its count in the menu’s noun (N tabs), New tab in folder (the core opens the folder first, then adds) and Delete – no Unpack or Close; Open brings the pages back', async () => {
    let el = await bubble([tab('home', null)], folder({ savedTabs: PAGES, collapsed: true }))
    let rows = actions(el)
    expect(rows.map((r) => r.dataset.action)).toEqual(['open', 'new-tab', 'delete'])
    const open = rows[0]!
    expect(open.querySelector('.zen-v2-label')!.textContent).toBe('Open folder')
    // One noun for one number: the menu's Open Folder (3 Tabs), the bubble's "3 tabs".
    expect(open.querySelector('.zen-group-editor-count')!.textContent).toBe('3 tabs')
    expect(open.hasAttribute('data-danger')).toBe(false)
    expect(open.querySelector('svg.lucide-folder-open')).not.toBeNull()
    // New tab in folder in the plain ink, with no count of its own: the core's `folder.newTab`
    // brings the pages back before it adds the tab, so the row loses nothing.
    const newTab = rows[1]!
    expect(newTab.querySelector('.zen-v2-label')!.textContent).toBe('New tab in folder')
    expect(newTab.querySelector('.zen-group-editor-count')).toBeNull()
    expect(newTab.hasAttribute('data-danger')).toBe(false)
    click(newTab)
    expect(run).toHaveBeenCalledWith('folder.newTab', { folderId: 'g' })
    expect(run).not.toHaveBeenCalledWith('folder.open', expect.anything())
    expect(uiStore.get().groupEditor).toBeNull()
    run.mockClear()
    el = await bubble([tab('home', null)], folder({ savedTabs: PAGES, collapsed: true }))
    rows = actions(el)
    click(rows[0]!)
    expect(run).toHaveBeenCalledWith('folder.open', { folderId: 'g' })
    expect(uiStore.get().groupEditor).toBeNull()
    // The singular, as the menu's Open Folder (1 Tab).
    el = await bubble(
      [tab('home', null)],
      folder({ savedTabs: PAGES.slice(0, 1), collapsed: true })
    )
    expect(actions(el)[0]!.querySelector('.zen-group-editor-count')!.textContent).toBe('1 tab')
  })

  it('Delete asks first for a folder holding tabs or pages – the prompt taking the bubble’s place – and deletes an empty one outright', async () => {
    let el = await bubble([tab('home', null), tab('a', 'g')], folder())
    click(actions(el).find((r) => r.dataset.action === 'delete')!)
    expect(run).not.toHaveBeenCalledWith('folder.delete', expect.anything())
    expect(uiStore.get().groupEditor).toBeNull()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    // (Whether the header had the keyboard is the focus ring's word – folderDelete.test.tsx.)
    expect(uiStore.get().folderDeleteConfirm?.folderId).toBe('g')
    uiStore.set({ folderDeleteConfirm: null })
    run.mockClear()

    el = await bubble([tab('home', null)], folder({ savedTabs: PAGES }))
    click(actions(el).find((r) => r.dataset.action === 'delete')!)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(run).not.toHaveBeenCalledWith('folder.delete', expect.anything())
    expect(uiStore.get().folderDeleteConfirm?.folderId).toBe('g')
    uiStore.set({ folderDeleteConfirm: null })
    run.mockClear()

    el = await bubble([tab('home', null)], folder())
    expect(actions(el).map((r) => r.dataset.action)).toEqual(['new-tab', 'delete'])
    click(actions(el).find((r) => r.dataset.action === 'delete')!)
    expect(run).toHaveBeenCalledWith('folder.delete', { folderId: 'g', unpack: false })
    expect(uiStore.get().folderDeleteConfirm).toBeNull()
  })
})

describe('the colour row (§9.14’s swatch form)', () => {
  it('is the nine colours in Chrome’s order as a radio group, the folder’s checked and alone in the tab order, a click recolouring through the core', async () => {
    const el = await bubble([tab('home', null), tab('a', 'g')], folder({ color: 'blue' }))
    const group = el.querySelector<HTMLElement>('[role="radiogroup"]')!
    expect(group.classList.contains('zen-group-editor-swatches')).toBe(true)
    const swatches = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(swatches.map((s) => s.dataset.color)).toEqual([...FOLDER_COLOR_ORDER])
    expect(swatches).toHaveLength(9)
    const checked = swatches.filter((s) => s.getAttribute('aria-checked') === 'true')
    expect(checked.map((s) => s.dataset.color)).toEqual(['blue'])
    expect(swatches.filter((s) => s.tabIndex === 0).map((s) => s.dataset.color)).toEqual(['blue'])
    for (const s of swatches) {
      expect(s.getAttribute('aria-label')).toMatch(/^[A-Z][a-z]+$/)
      expect(s.classList.contains('zen-group-editor-swatch')).toBe(true)
      expect(s.querySelector('.zen-group-editor-swatch-disc')).not.toBeNull()
      // Each swatch carries its colour as §9.14's pair, both schemes' channels, and the marker
      // the stylesheet picks `--zen-group-rgb` from by the root's theme – the disc follows a
      // theme flip live. No single-set value, no pick of its own.
      expect(s.hasAttribute('data-group-rgb')).toBe(true)
      expect(s.style.getPropertyValue('--zen-group-rgb-light')).toMatch(/^\d+ \d+ \d+$/)
      expect(s.style.getPropertyValue('--zen-group-rgb-dark')).toMatch(/^\d+ \d+ \d+$/)
      expect(s.style.getPropertyValue('--zen-group-rgb')).toBe('')
      expect(s.style.getPropertyValue('--zen-swatch')).toBe('')
    }
    // The light set for the light scheme, the dark set for the dark: two different values.
    const blue = swatches.find((s) => s.dataset.color === 'blue')!
    expect(blue.style.getPropertyValue('--zen-group-rgb-light')).toBe('22 108 221')
    expect(blue.style.getPropertyValue('--zen-group-rgb-dark')).toBe('138 180 248')
    click(swatches.find((s) => s.dataset.color === 'green')!)
    expect(run).toHaveBeenCalledWith('folder.update', { folderId: 'g', patch: { color: 'green' } })
    // A saved folder's row is the same: its colour is its header's ring's.
    const savedEl = await bubble([tab('home', null)], folder({ savedTabs: PAGES, color: 'pink' }))
    expect(
      [...savedEl.querySelectorAll<HTMLButtonElement>('[role="radio"][aria-checked="true"]')].map(
        (s) => s.dataset.color
      )
    ).toEqual(['pink'])
  })

  it('draws 28 px round targets touching – the 20 px discs 8 apart on a 28 pitch, the nine discs 244 wide – the picked disc ringed 2 px outside', () => {
    // §9.14 to the letter: no gap between the targets, so the pitch is the target's own 28 and
    // the discs (20 inside 28: 4 each side) stand 8 apart; the nine discs run 8 × 28 + 20 = 244
    // from the first's left edge to the ninth's right (the targets themselves 9 × 28 = 252).
    const row = rule('.zen-group-editor-swatches')
    expect(row).toContain('display: flex')
    expect(row).toContain('gap: 0')
    expect(row).not.toContain('gap: 8px')
    const target = rule('.zen-v2-card-radio.zen-group-editor-swatch')
    expect(target).toContain('width: 28px')
    expect(target).toContain('height: 28px')
    expect(target).toContain('border-radius: 50%')
    expect(target).not.toContain('margin')
    const disc = rule('.zen-group-editor-swatch-disc')
    expect(disc).toContain('width: 20px')
    expect(disc).toContain('height: 20px')
    expect(disc).toContain('border-radius: 50%')
    // The disc's fill is the theme's pick of the swatch's pair (§9.14), never a single value.
    expect(disc).toContain('background: rgb(var(--zen-group-rgb))')
    expect(disc).not.toContain('--zen-swatch')
    const ring = rule(
      ".zen-group-editor-swatch[aria-checked='true'] > .zen-group-editor-swatch-disc"
    )
    expect(ring).toContain('0 0 0 2px var(--v2-panel)')
    expect(ring).toContain('0 0 0 4px var(--v2-accent)')
  })
})

describe('on the touch layout (TABLET-22: the tablet shows the bubble once after a group is made from its tab menu)', () => {
  beforeEach(() => {
    uiStore.set({ toasts: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
    viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false, hover: true })
    uiStore.set({ toasts: [] })
  })

  const labelsOf = (el: HTMLElement): string[] =>
    actions(el).map((r) => r.querySelector('.zen-v2-label')!.textContent!)

  it('says Group where the desktop says Folder (§6): the title, the field’s placeholder, the actions’ name and every row, open and saved alike; the counts keep the bubble’s register', async () => {
    let el = await bubble([tab('home', null), tab('a', 'g'), tab('b', 'g')], folder(), 'tablet')
    expect(el.querySelector('.zen-bm-title')!.textContent).toBe('Edit group')
    expect(el.querySelector<HTMLInputElement>('.zen-v2-field')!.placeholder).toBe('Name this group')
    expect(el.querySelector('.zen-group-editor-actions')!.getAttribute('aria-label')).toBe(
      'Group actions'
    )
    expect(labelsOf(el)).toEqual([
      'New tab in group',
      'Unpack group',
      'Close group',
      'Delete group'
    ])
    expect(actions(el)[2]!.querySelector('.zen-group-editor-count')!.textContent).toBe('2 tabs')
    expect(actions(el)[3]!.hasAttribute('data-danger')).toBe(true)
    expect(el.textContent).not.toMatch(/folder/i)
    el = await bubble([tab('home', null)], folder({ savedTabs: PAGES, collapsed: true }), 'tablet')
    expect(labelsOf(el)).toEqual(['Open group', 'New tab in group', 'Delete group'])
    expect(actions(el)[0]!.querySelector('.zen-group-editor-count')!.textContent).toBe('3 tabs')
    expect(el.textContent).not.toMatch(/folder/i)
  })

  it('Close group takes the group row menu’s route (folder.closeUndoable’s, #721): the core’s folder.close at once, the bubble away, and once the core has filed the tabs a toast in the group’s words whose Undo brings them back newest first', async () => {
    const el = await bubble([tab('home', null), tab('a', 'g'), tab('b', 'g')], folder(), 'tablet')
    // The core's recently closed list, as it reads once the two tabs are filed.
    const filed = [
      {
        id: 'closed:b',
        kind: 'tab',
        title: 'b',
        url: 'https://b.example/',
        closedAt: 0,
        tabCount: 1
      },
      {
        id: 'closed:a',
        kind: 'tab',
        title: 'a',
        url: 'https://a.example/',
        closedAt: 0,
        tabCount: 1
      }
    ]
    cmd.mockImplementation(async (name) => (name === 'session.recentlyClosed' ? filed : null))
    // The intent's settle wait starts at the click: the clock is faked from here.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const close = actions(el).find((r) => r.dataset.action === 'close')!
    click(close)
    for (const e of filed) e.closedAt = Date.now()
    expect(run).toHaveBeenCalledWith('folder.close', { folderId: 'g' })
    expect(run).not.toHaveBeenCalledWith('folder.delete', expect.anything())
    expect(uiStore.get().groupEditor).toBeNull()
    // Nothing is up until the core has filed the tabs.
    expect(uiStore.get().toasts).toEqual([])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + 1)
    })
    const toasts = uiStore.get().toasts
    expect(toasts.map((t) => [t.message, t.action?.label, t.duration])).toEqual([
      ['Research tab group closed and saved', 'Undo', TOAST_UNDO_MS]
    ])
    cmd.mockClear()
    await act(async () => {
      toasts[0]!.action!.onPick()
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })
    const restored = cmd.mock.calls.filter(([n]) => n === 'session.restoreClosed').map(([, a]) => a)
    expect(restored).toEqual([{ id: 'closed:b' }, { id: 'closed:a' }])
    expect(cmd).toHaveBeenCalledWith('tab.activate', { tabId: 'home' })
  })
})
