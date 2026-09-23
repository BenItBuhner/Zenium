// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { viewportStore } from '@renderer/lib/formFactor'
import { browserStore, uiStore } from '@renderer/lib/ui'
import { SpacePanel } from '../SpacePanel'

/*
 * The desktop sidebar's folder as a tab group (TAB-16's desktop half, matrix rows tabs-15 and
 * split-33; Chrome's saved tab groups and group colours): a folder whose tabs all closed but
 * which kept their pages stays in the strip as a SAVED group – a disclosure header with the
 * saved ring in the glyph slot and the saved count, folded by default, its pages as rows under
 * it while it is unfolded (deemphasised: a page, not a live tab) whose press opens the folder;
 * the group's colour as a 3 px bar down the block's leading edge and in the header's glyph;
 * the count as §9.19's badge in the window family while the header is folded (full ink, never
 * dimmed with the row – #287's rule) and as the 13 aside while open; the header a disclosure
 * for the keyboard (aria-expanded; Enter, Space fold it through the strip), the page rows in
 * the roving tab order, Shift+F10 and the Menu key opening the folder's menu in keyboard mode.
 */

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')

/** The text of the first `selector {` rule in the stylesheet. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** happy-dom lays nothing out: every connected element is "on screen" for the strip. */
Element.prototype.getClientRects = (() => [
  new DOMRect(0, 0, 10, 10)
]) as unknown as typeof Element.prototype.getClientRects

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 'space',
    containerId: DEFAULT_CONTAINER_ID,
    url: `https://${id}.example/`,
    title: id.toUpperCase(),
    favicon: null,
    pinned: false,
    essential: false,
    pinnedUrl: null,
    customTitle: null,
    customIcon: null,
    windowId: null,
    folderId: null,
    loading: false,
    progress: 0,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: false,
    discarded: false,
    frozen: false,
    cpuThrottle: 1,
    zoom: 1,
    splitGroupId: null,
    createdAt: 0,
    lastActiveAt: 0,
    ...over
  } as Tab
}

function folder(over: Partial<Folder> = {}): Folder {
  return {
    id: 'g',
    spaceId: 'space',
    name: 'Trip',
    icon: '📁',
    color: 'green',
    collapsed: false,
    ...over
  } as Folder
}

const PAGES = [
  { url: 'https://alpha.example/path', title: 'Alpha' },
  { url: 'https://beta.example/', title: '' },
  { url: 'https://gamma.example/', title: '  Gamma  ' }
]

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): void {
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(el))
}

/** The desktop panel with the space's tabs and folders; re-rendered with new state by the next call. */
function panel(tabs: Tab[], folders: Folder[]): void {
  const space: Space = {
    id: 'space',
    name: 'Work',
    icon: '',
    containerId: DEFAULT_CONTAINER_ID,
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId: tabs[0]?.id ?? null,
    pinnedCollapsed: false
  }
  const state = {
    platform: 'linux',
    window: { kind: 'synced' },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [space],
    activeSpaceId: 'space',
    folders: Object.fromEntries(folders.map((f) => [f.id, f])),
    liveFolders: {},
    splitGroups: {},
    essentialTabIds: [],
    foreignTabIds: [],
    agents: [],
    containers: [],
    media: [],
    settings: { showTabSeparator: false }
  } as unknown as UIState
  browserStore.set({ state })
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false, hover: true })
  render(
    <aside data-pane="tabs" data-surface="window">
      <div data-tab-scroller data-active="true">
        <SpacePanel state={state} space={space} isActive compact={false} />
      </div>
    </aside>
  )
}

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  browserStore.set({ state: null })
  uiStore.set({ selectedTabIds: [], drag: null, renamingFolderId: null, stripFocus: null })
  vi.mocked(run).mockClear()
})

const q = <T extends HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)
const header = (): HTMLElement => q<HTMLElement>('[data-tab-folder="g"]')!
const shell = (): HTMLElement => header().parentElement!
const pageRows = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-saved-page]')
]

const key = (el: HTMLElement, k: string): void => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
}

describe('the saved group on the desktop sidebar (TAB-16’s desktop half)', () => {
  it('stays in the strip as a folded disclosure header with the saved ring, the saved count as the badge and no page rows', () => {
    // As the core leaves it: folded shut when it saved the group.
    panel([tab('home')], [folder({ savedTabs: PAGES, collapsed: true })])
    const row = header()
    expect(row.className).toContain('zen-tab')
    expect(row.className).not.toContain('zen-group-row')
    expect(row.getAttribute('role')).toBe('button')
    expect(row.hasAttribute('aria-haspopup')).toBe(false)
    expect(row.getAttribute('aria-label')).toBe('Trip')
    expect(row.getAttribute('aria-description')).toBe('Folder, saved, 3 tabs')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(row.hasAttribute('data-saved')).toBe(true)
    expect(shell().dataset.groupKind).toBe('saved')
    const glyph = row.querySelector<HTMLElement>('[data-testid="group-row-glyph"]')!
    expect(glyph.hasAttribute('data-saved')).toBe(true)
    expect(glyph.querySelector('.zen-group-row-dot')).not.toBeNull()
    expect(row.textContent).not.toContain('📁')
    const badge = row.querySelector<HTMLElement>('[data-testid="group-count-badge"]')!
    expect(badge.textContent).toBe('3')
    expect(badge.className).toContain('zen-v2-badge')
    expect(badge.className).toContain('zen-group-count-badge')
    expect(row.querySelector('[data-testid="group-count"]')).toBeNull()
    expect(row.querySelector('svg.lucide-chevron-right')).not.toBeNull()
    expect(pageRows()).toEqual([])
    expect(shell().querySelectorAll('[data-tab-id]')).toHaveLength(0)
    // Not a live tab's row: nothing to close, nothing audible.
    expect(row.querySelector('.zen-tab-close')).toBeNull()
  })

  it('lists the pages it kept as deemphasised rows under the unfolded header – favicon and title, no close – in the strip’s tab order', () => {
    panel([tab('home')], [folder({ savedTabs: PAGES })])
    expect(header().getAttribute('aria-expanded')).toBe('true')
    expect(header().querySelector('[data-testid="group-count"]')?.textContent).toBe('3')
    expect(header().querySelector('[data-testid="group-count-badge"]')).toBeNull()
    const rows = pageRows()
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.dataset.savedPage)).toEqual(['0', '1', '2'])
    expect(rows.map((r) => r.dataset.stripItem)).toEqual(['saved:g:0', 'saved:g:1', 'saved:g:2'])
    for (const r of rows) {
      expect(r.className).toContain('zen-tab')
      expect(r.className).toContain('zen-saved-page')
      expect(r.className).toContain('ml-5')
      expect(r.getAttribute('role')).toBe('button')
      expect(r.dataset.stripParent).toBe('folder:g')
      expect(r.tabIndex).toBe(-1)
      expect(r.querySelector('.zen-tab-favicon')).not.toBeNull()
      expect(r.querySelector('.zen-tab-close')).toBeNull()
      expect(r.querySelector('.zen-tab-audio')).toBeNull()
      expect(r.hasAttribute('data-tab-id')).toBe(false)
      // The live row's trailing slot – its close control's 24 – reserved and empty, last in the
      // row, so the title's edge holds as the folder closes and opens (no control in it).
      const slot = r.querySelector<HTMLElement>('[data-testid="saved-page-slot"]')!
      expect(slot).not.toBeNull()
      expect(r.lastElementChild).toBe(slot)
      expect(slot.className.split(' ')).toEqual(expect.arrayContaining(['h-6', 'w-6', 'shrink-0']))
      expect(slot.getAttribute('aria-hidden')).toBe('true')
      expect(slot.children).toHaveLength(0)
      expect(r.querySelectorAll('button, [role="button"]')).toHaveLength(0)
    }
    // The title, or the host where the page had none; trimmed.
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Alpha',
      'beta.example',
      'Gamma'
    ])
    expect(rows[0]!.querySelector('[data-testid="saved-page-title"]')?.textContent).toBe('Alpha')
    expect(rows[1]!.getAttribute('aria-description')).toBe('Saved page 2 of 3, opens the folder')
    // The rows are drawn inside the fold block after the header, so the bar runs beside them –
    // as a run of their own, outside any tablist (a11y-02: a tablist holds tabs alone, and a
    // saved page is a button that opens the folder).
    expect(shell().firstElementChild).toBe(header())
    const run = shell().querySelector<HTMLElement>('[data-saved-pages="g"]')!
    expect(shell().children).toHaveLength(2)
    expect(shell().lastElementChild).toBe(run)
    expect(run.hasAttribute('role')).toBe(false)
    expect(run.closest('[role="tablist"]')).toBeNull()
    expect(shell().querySelector('[role="tablist"]')).toBeNull()
    expect([...run.children]).toEqual(rows)
    // The page, not a tab: the sleeping row's fade on the glyph and the title.
    expect(rule('.zen-saved-page .zen-tab-favicon,\n.zen-saved-page .zen-tab-title')).toContain(
      'opacity: 0.69'
    )
  })

  it('opens the folder on a page row’s click, Enter or Space; its context menu is the folder’s', () => {
    panel([tab('home')], [folder({ savedTabs: PAGES })])
    const rows = pageRows()
    act(() => rows[1]!.click())
    expect(run).toHaveBeenCalledWith('folder.open', { folderId: 'g' })
    expect(run).not.toHaveBeenCalledWith('tab.activate', expect.anything())
    vi.mocked(run).mockClear()
    act(() => rows[2]!.focus())
    key(rows[2]!, 'Enter')
    expect(run).toHaveBeenCalledWith('folder.open', { folderId: 'g' })
    vi.mocked(run).mockClear()
    key(rows[2]!, ' ')
    expect(run).toHaveBeenCalledWith('folder.open', { folderId: 'g' })
    vi.mocked(run).mockClear()
    // Delete closes nothing on a page.
    key(rows[2]!, 'Delete')
    expect(run).not.toHaveBeenCalled()
    // Its menu is the folder's, in keyboard mode when the keyboard asked (Chromium raises the
    // event with no button for Shift+F10 and the Menu key).
    act(() => {
      rows[0]!.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 40,
          clientY: 60
        })
      )
    })
    expect(run).toHaveBeenCalledWith('folder.contextMenu', {
      folderId: 'g',
      x: 40,
      y: 60,
      keyboard: true
    })
  })

  it('folds and unfolds on the header’s click, Enter and Space; Down walks from the header to its first page and Left comes back', () => {
    panel([tab('home')], [folder({ savedTabs: PAGES })])
    act(() => header().click())
    expect(run).toHaveBeenCalledWith('folder.update', { folderId: 'g', patch: { collapsed: true } })
    expect(run).not.toHaveBeenCalledWith('folder.open', expect.anything())
    vi.mocked(run).mockClear()
    act(() => header().focus())
    key(header(), 'Enter')
    expect(run).toHaveBeenCalledWith('folder.update', { folderId: 'g', patch: { collapsed: true } })
    vi.mocked(run).mockClear()
    key(header(), 'ArrowDown')
    expect(document.activeElement).toBe(pageRows()[0])
    key(pageRows()[0]!, 'ArrowLeft')
    expect(document.activeElement).toBe(header())
    // Folded, Space unfolds it again.
    panel([tab('home')], [folder({ savedTabs: PAGES, collapsed: true })])
    act(() => header().focus())
    key(header(), ' ')
    expect(run).toHaveBeenLastCalledWith('folder.update', {
      folderId: 'g',
      patch: { collapsed: false }
    })
    // Shift+F10 / the Menu key on the header: the folder's menu in keyboard mode.
    vi.mocked(run).mockClear()
    act(() => {
      header().dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 30,
          clientY: 20
        })
      )
    })
    expect(run).toHaveBeenCalledWith('folder.contextMenu', {
      folderId: 'g',
      x: 30,
      y: 20,
      keyboard: true
    })
    // A right-click's is the pointer's.
    vi.mocked(run).mockClear()
    act(() => {
      header().dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 31,
          clientY: 21
        })
      )
    })
    expect(run).toHaveBeenCalledWith('folder.contextMenu', { folderId: 'g', x: 31, y: 21 })
  })

  it('is a live folder again in place once opened: the same header with its tabs as rows, no page rows, not saved', () => {
    panel([tab('home')], [folder({ savedTabs: PAGES, collapsed: true })])
    expect(header().hasAttribute('data-saved')).toBe(true)
    // The core opened it: the pages are tabs of the folder, `savedTabs` cleared, the fold undone.
    panel(
      [
        tab('home'),
        tab('alpha', { folderId: 'g' }),
        tab('beta', { folderId: 'g' }),
        tab('gamma', { folderId: 'g' })
      ],
      [folder({ savedTabs: null, collapsed: false })]
    )
    const row = header()
    expect(row.hasAttribute('data-saved')).toBe(false)
    expect(row.getAttribute('aria-description')).toBe('Folder, 3 tabs')
    expect(shell().dataset.groupKind).toBe('open')
    expect(
      row.querySelector<HTMLElement>('[data-testid="group-row-glyph"]')!.hasAttribute('data-saved')
    ).toBe(false)
    expect(pageRows()).toEqual([])
    expect(
      [...shell().querySelectorAll<HTMLElement>('[data-tab-id]')].map((r) => r.dataset.tabId)
    ).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('reads an empty folder as one of no tabs, folded or not, with no bar of a saved group', () => {
    panel([tab('home')], [folder({ collapsed: true })])
    expect(header().getAttribute('aria-description')).toBe('Folder, 0 tabs')
    expect(header().hasAttribute('data-saved')).toBe(false)
    expect(shell().dataset.groupKind).toBe('empty')
    expect(header().querySelector('[data-testid="group-count-badge"]')?.textContent).toBe('0')
  })
})

describe('the group’s colour (M2) and the folded count badge (M3)', () => {
  it('draws the folder’s colour as the 3 px bar on the fold block’s leading edge and in the glyph, never as a fill across the row', () => {
    panel([tab('home'), tab('a', { folderId: 'g' })], [folder({ color: 'green' })])
    const block = shell()
    expect(block.className).toContain('zen-group-fold')
    expect(block.hasAttribute('data-group-bar')).toBe(true)
    expect(block.style.getPropertyValue('--zen-group-rgb')).toMatch(/^\d+ \d+ \d+$/)
    const glyph = header().querySelector<HTMLElement>('[data-testid="group-row-glyph"]')!
    expect(glyph.style.getPropertyValue('--zen-group-rgb')).toBe(
      block.style.getPropertyValue('--zen-group-rgb')
    )
    // The header's own background is the row's: no colour of the group on it.
    expect(header().style.background).toBe('')
    expect(header().style.backgroundColor).toBe('')
    // The stylesheet: the block positioned for the bar; the bar 3 wide at radius 1.5, 8 in from
    // the block's ends, on the leading edge, over the rows' fills, not for the pointer.
    expect(rule('.zen-group-fold[data-group-bar]')).toContain('position: relative')
    const bar = rule('.zen-group-fold[data-group-bar]::before')
    expect(bar).toContain('position: absolute')
    expect(bar).toContain('top: 8px')
    expect(bar).toContain('bottom: 8px')
    expect(bar).toContain('left: 0')
    expect(bar).toContain('width: 3px')
    expect(bar).toContain('border-radius: 1.5px')
    expect(bar).toContain('background: rgb(var(--zen-group-rgb))')
    expect(bar).toContain('pointer-events: none')
    expect(bar).toContain('z-index: 1')
    // The bar shares the header's first 3 px, where the §1 ring (2 px, 2 inside the edge) would
    // stand under it: the header rises over the bar while it wears the ring, so the ring paints
    // whole (§9.20) – a positioned `.zen-tab`, one level above the bar's, and only then.
    expect(rule('.zen-tab')).toContain('position: relative')
    const ringed = rule('.zen-group-fold[data-group-bar] > .zen-tab:focus-visible')
    expect(ringed).toContain('z-index: 2')
    expect(ringed).not.toContain('outline')
    expect(css).not.toMatch(/\.zen-group-fold\[data-group-bar\] > \.zen-tab \{/)
    // A colourless folder's bar is the grey default, never none.
    panel([tab('home'), tab('a', { folderId: 'g' })], [folder({ color: undefined })])
    expect(shell().hasAttribute('data-group-bar')).toBe(true)
    expect(shell().style.getPropertyValue('--zen-group-rgb')).toMatch(/^\d+ \d+ \d+$/)
  })

  it('shows the folded header’s count as §9.19’s badge in the window family – full ink, tabular – and the open header’s as the 13 aside', () => {
    panel(
      [tab('home'), tab('a', { folderId: 'g' }), tab('b', { folderId: 'g' })],
      [folder({ collapsed: true })]
    )
    const badge = header().querySelector<HTMLElement>('[data-testid="group-count-badge"]')!
    expect(badge.textContent).toBe('2')
    expect(badge.className).toContain('zen-v2-badge')
    expect(badge.className).not.toContain('opacity-')
    expect(badge.className).not.toContain('text-[var(--v2-control-text-deemphasized)]')
    // The badge before the chevron, at the row's trailing end.
    const children = [...header().children]
    expect(children.indexOf(badge)).toBe(children.length - 2)
    expect(children[children.length - 1]!.tagName.toLowerCase()).toBe('svg')
    // The shared pill: the small line box (20), 13/600, 0 8, the control fill and ink – which the
    // sidebar's window surface maps to the window family (§9.29).
    const pill = rule('.zen-v2-badge')
    expect(pill).toContain('height: var(--v2-line-small-box)')
    expect(pill).toContain('padding: 0 8px')
    expect(pill).toContain('border-radius: 999px')
    expect(pill).toContain('background: var(--v2-control-fill, var(--v2-fill))')
    expect(pill).toContain('font-size: var(--v2-font-small)')
    expect(pill).toContain('font-weight: var(--v2-weight-heading)')
    expect(css).toMatch(/--v2-line-small: 20px/)
    expect(css).toMatch(
      /--v2-line-small-box: calc\(var\(--v2-line-small\) \* var\(--zen-text-zoom\)\)/
    )
    expect(css).toMatch(/--v2-font-small: 13px/)
    expect(css).toMatch(
      /--v2-weight-heading: min\(900, calc\(600 \+ var\(--zen-font-weight-adjustment\)\)\)/
    )
    expect(rule("[data-surface='window']")).toContain('--v2-control-fill: var(--v2-window-fill)')
    // Never dimmed with the row: the badge's own opacity is 1 and its figures tabular.
    const own = rule('.zen-group-count-badge')
    expect(own).toContain('opacity: 1')
    expect(own).toContain('font-variant-numeric: tabular-nums')
    // Open, the count is the 13 deemphasised aside and there is no badge.
    panel([tab('home'), tab('a', { folderId: 'g' }), tab('b', { folderId: 'g' })], [folder()])
    expect(header().querySelector('[data-testid="group-count-badge"]')).toBeNull()
    const aside = header().querySelector<HTMLElement>('[data-testid="group-count"]')!
    expect(aside.textContent).toBe('2')
    expect(aside.className).toContain('text-[13px]')
    expect(aside.className).toContain('tabular-nums')
    expect(aside.className).toContain('text-[var(--v2-control-text-deemphasized)]')
  })

  it('keeps the folder’s own icon in the glyph slot, in place of the dot', () => {
    panel([tab('home'), tab('a', { folderId: 'g' })], [folder({ icon: '🔬' })])
    const glyph = header().querySelector<HTMLElement>('[data-testid="group-row-glyph"]')!
    expect(glyph.querySelector('.zen-group-row-icon')?.textContent).toBe('🔬')
    expect(glyph.querySelector('.zen-group-row-dot')).toBeNull()
    expect(shell().hasAttribute('data-group-bar')).toBe(true)
  })
})
