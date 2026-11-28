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
 * split-33; group colours): the group's colour in the header's glyph alone, the rows' indent the bracket that says which
 * rows are the group's (§9.36: no bar down the block, no fill across the row); the count as
 * the tablet row's 13 tabular aside at 69%, folded and open alike – never a badge (§9.36) – the
 * tabs the folder holds; the header a disclosure
 * for the keyboard (aria-expanded; Enter, Space fold it through the strip), Shift+F10 and the Menu key opening the folder's menu in keyboard mode.
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
    awayAgents: [],
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

describe('an empty folder on the desktop sidebar', () => {
  it('reads an empty folder as one of no tabs, folded or not', () => {
    panel([tab('home')], [folder({ collapsed: true })])
    expect(header().getAttribute('aria-description')).toBe('Folder, 0 tabs')
    expect(shell().dataset.groupKind).toBe('empty')
    expect(header().querySelector('[data-testid="group-count"]')?.textContent).toBe('0')
  })
})

describe('the group’s colour (M2) and the count aside (M3)', () => {
  it('draws the folder’s colour in the glyph alone – no bar down the fold block, never a fill across the row', () => {
    panel([tab('home'), tab('a', { folderId: 'g' })], [folder({ color: 'green' })])
    const block = shell()
    expect(block.className).toContain('zen-group-fold')
    const glyph = header().querySelector<HTMLElement>('[data-testid="group-row-glyph"]')!
    // The colour as §9.14's pair – both schemes' channels on the glyph, the marker the
    // stylesheet picks `--zen-group-rgb` from by the root's theme, no pick written inline.
    expect(glyph.hasAttribute('data-group-rgb')).toBe(true)
    expect(glyph.style.getPropertyValue('--zen-group-rgb-light')).toMatch(/^\d+ \d+ \d+$/)
    expect(glyph.style.getPropertyValue('--zen-group-rgb-dark')).toMatch(/^\d+ \d+ \d+$/)
    expect(glyph.style.getPropertyValue('--zen-group-rgb-light')).not.toBe(
      glyph.style.getPropertyValue('--zen-group-rgb-dark')
    )
    expect(glyph.style.getPropertyValue('--zen-group-rgb')).toBe('')
    expect(glyph.querySelector('.zen-group-row-dot')).not.toBeNull()
    // The block carries no colour and no bar (§9.36: the rows' indent is the bracket); the
    // header's own background is the row's: no colour of the group on it.
    expect(block.hasAttribute('data-group-bar')).toBe(false)
    expect(block.hasAttribute('data-group-rgb')).toBe(false)
    expect(block.style.getPropertyValue('--zen-group-rgb')).toBe('')
    expect(block.getAttribute('style')).toBeNull()
    expect(header().style.background).toBe('')
    expect(header().style.backgroundColor).toBe('')
    // The stylesheet knows no bar and gives the header no layering for a ring over one: the §1
    // ring – 2 px, 2 inside the header's edge – paints whole on its own (§9.20).
    expect(css).not.toContain('data-group-bar')
    expect(css).not.toMatch(/\.zen-group-fold[^{]*::before/)
    expect(css).not.toMatch(/\.zen-group-fold[^{]*:focus-visible/)
    // A colourless folder's dot is the grey default, never none – in both schemes.
    panel([tab('home'), tab('a', { folderId: 'g' })], [folder({ color: undefined })])
    const bare = header().querySelector<HTMLElement>('[data-testid="group-row-glyph"]')!
    expect(bare.style.getPropertyValue('--zen-group-rgb-light')).toMatch(/^\d+ \d+ \d+$/)
    expect(bare.style.getPropertyValue('--zen-group-rgb-dark')).toMatch(/^\d+ \d+ \d+$/)
  })

  it('shows the count as the 13 tabular aside at 69 %, folded and open alike – never a badge', () => {
    const asideOf = (): { aside: HTMLElement; before: number; last: string } => {
      const aside = header().querySelector<HTMLElement>('[data-testid="group-count"]')!
      expect(aside).not.toBeNull()
      // The aside before the chevron, at the row's trailing end.
      const children = [...header().children]
      return {
        aside,
        before: children.length - 1 - children.indexOf(aside),
        last: children[children.length - 1]!.tagName.toLowerCase()
      }
    }
    panel(
      [tab('home'), tab('a', { folderId: 'g' }), tab('b', { folderId: 'g' })],
      [folder({ collapsed: true })]
    )
    const folded = asideOf()
    expect(folded.aside.textContent).toBe('2')
    expect(folded.aside.className).toContain('text-[13px]')
    expect(folded.aside.className).toContain('tabular-nums')
    expect(folded.aside.className).toContain('text-[var(--v2-control-text-deemphasized)]')
    expect(folded.before).toBe(1)
    expect(folded.last).toBe('svg')
    // No pill anywhere in the header, folded: the badge is not the count's form (§9.36).
    expect(header().querySelector('.zen-v2-badge')).toBeNull()
    expect(header().querySelector('[data-testid="group-count-badge"]')).toBeNull()
    expect(css).not.toContain('.zen-group-count-badge')
    // Open, the very same aside – one element, one class list, the same place before the chevron.
    panel([tab('home'), tab('a', { folderId: 'g' }), tab('b', { folderId: 'g' })], [folder()])
    const open = asideOf()
    expect(open.aside.textContent).toBe('2')
    expect(open.aside.className).toBe(folded.aside.className)
    expect(open.before).toBe(1)
    expect(open.last).toBe('svg')
    expect(header().querySelector('.zen-v2-badge')).toBeNull()
    // The tablet row's aside is the same 13 tabular figure in the deemphasised ink (§9.36).
    const tabletAside = rule('.zen-group-row-count')
    expect(tabletAside).toContain('font-size: 13px')
    expect(tabletAside).toContain('font-variant-numeric: tabular-nums')
    expect(tabletAside).toContain('color: var(--v2-control-text-deemphasized')
  })

  it('keeps the folder’s own icon in the glyph slot, in place of the dot', () => {
    panel([tab('home'), tab('a', { folderId: 'g' })], [folder({ icon: '🔬' })])
    const glyph = header().querySelector<HTMLElement>('[data-testid="group-row-glyph"]')!
    expect(glyph.querySelector('.zen-group-row-icon')?.getAttribute('data-icon')).toBe('🔬')
    expect(glyph.querySelector('.zen-group-row-dot')).toBeNull()
  })
})
