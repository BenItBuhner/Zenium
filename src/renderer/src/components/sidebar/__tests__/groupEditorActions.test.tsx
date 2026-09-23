// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'
import { FOLDER_COLOR_ORDER } from '@shared/defaults'

/*
 * The group editor bubble's actions and swatch row on a saved group (TAB-16's desktop half;
 * components/sidebar/GroupEditorBubble.tsx): an open folder's rows are New tab, Unpack, Close
 * (Chrome's Close group – the folder stays saved with its pages, so the plain ink) and Delete in
 * the danger ink; a saved folder's are Open folder with its page count and Delete alone – New
 * tab in folder would forget the pages it kept (the model's `folderOpened` rule), so the row
 * waits for Open; Delete goes through the "Delete <folder>?" prompt when the folder holds anything
 * and deletes an empty folder outright. The colour row is §9.14's swatch form: the nine colours
 * in Chrome's order as a radio group of 28 px round targets touching (the 20 px discs 8 apart
 * on a 28 pitch, the nine discs 244 wide), the picked one ringed.
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

/** The bubble up for folder `g` over `tabs`: the page's picture taken, the panel placed. */
async function bubble(tabs: Tab[], f: Folder): Promise<HTMLElement> {
  browserStore.set({ state: state(tabs, [f]) })
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
    // Close keeps the folder: Chrome's Close group through the core, the bubble away.
    click(close)
    expect(run).toHaveBeenCalledWith('folder.close', { folderId: 'g' })
    expect(run).not.toHaveBeenCalledWith('folder.delete', expect.anything())
    expect(uiStore.get().groupEditor).toBeNull()
  })

  it('for a saved folder: Open folder with its page count and Delete alone – no New tab (it would forget the pages), no Unpack or Close; Open brings the pages back', async () => {
    const el = await bubble([tab('home', null)], folder({ savedTabs: PAGES, collapsed: true }))
    const rows = actions(el)
    expect(rows.map((r) => r.dataset.action)).toEqual(['open', 'delete'])
    expect(el.textContent).not.toContain('New tab in folder')
    const open = rows[0]!
    expect(open.querySelector('.zen-v2-label')!.textContent).toBe('Open folder')
    expect(open.querySelector('.zen-group-editor-count')!.textContent).toBe('3 pages')
    expect(open.hasAttribute('data-danger')).toBe(false)
    expect(open.querySelector('svg.lucide-folder-open')).not.toBeNull()
    click(open)
    expect(run).toHaveBeenCalledWith('folder.open', { folderId: 'g' })
    expect(uiStore.get().groupEditor).toBeNull()
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
