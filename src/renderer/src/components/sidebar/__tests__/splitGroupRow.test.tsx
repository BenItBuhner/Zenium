// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Space, SplitGroup, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { browserStore, uiStore } from '@renderer/lib/ui'
import { SpacePanel } from '../SpacePanel'

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')

/*
 * The split group's row in the sidebar (components/sidebar/SplitGroupRow.tsx, design language v2
 * §9.35; Zen's `zen-split-view.css`): a split is one row of the list, its panes side by side as
 * segments in the split's own order, wherever the list holds them, with a hairline on each shared
 * edge; the row takes the active state as one; a segment keeps the favicon, the title and the
 * close and drops the trailing slot's other buttons; a split with one pane in the list is a plain
 * row; the icon rail stacks the group in a column. The stylesheet's numbers are §9.35's.
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
    ...over
  } as Tab
}

function split(id: string, tabIds: string[]): SplitGroup {
  return {
    id,
    spaceId: 'space',
    tabIds,
    layout: 'vertical',
    sizes: tabIds.map(() => 1 / tabIds.length)
  }
}

/** One space whose tabs are `tabs` in that order, the splits among them, `activeTabId` on top. */
function fixture(
  tabs: Tab[],
  groups: SplitGroup[],
  activeTabId: string
): { state: UIState; space: Space } {
  const space: Space = {
    id: 'space',
    name: 'Home',
    icon: '',
    containerId: DEFAULT_CONTAINER_ID,
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId,
    pinnedCollapsed: false
  }
  // A pane carries its split's id, as the model's does.
  const groupOf = (id: string): string | null =>
    groups.find((g) => g.tabIds.includes(id))?.id ?? null
  const state = {
    platform: 'linux',
    window: { kind: 'synced' },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, { ...t, splitGroupId: groupOf(t.id) }])),
    spaces: [space],
    activeSpaceId: 'space',
    folders: {},
    liveFolders: {},
    splitGroups: Object.fromEntries(groups.map((g) => [g.id, g])),
    essentialTabIds: [],
    foreignTabIds: [],
    agents: [],
    containers: [],
    media: [],
    settings: { showTabSeparator: false }
  } as unknown as UIState
  return { state, space }
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

function panel(tabs: Tab[], groups: SplitGroup[], activeTabId: string, compact = false): void {
  const { state, space } = fixture(tabs, groups, activeTabId)
  browserStore.set({ state })
  render(<SpacePanel state={state} space={space} isActive compact={compact} />)
}

const list = (name: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-tab-list="${name}"]`)!
const rows = (name: string): HTMLElement[] =>
  [...list(name).children].filter((el): el is HTMLElement => el instanceof HTMLElement)
const segments = (row: HTMLElement): HTMLElement[] => [
  ...row.querySelectorAll<HTMLElement>('.zen-tab')
]

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  browserStore.set({ state: null })
  uiStore.set({ selectedTabIds: [], drag: null })
})

describe('the split group row', () => {
  it('folds the split into one row at its first pane, the segments in the split order, a hairline between', () => {
    // The list holds a, d, b, c; the split is b | a | c – the panes as they stand on screen.
    panel([tab('a'), tab('d'), tab('b'), tab('c')], [split('g1', ['b', 'a', 'c'])], 'd')
    const regular = rows('regular')
    expect(regular.map((r) => r.dataset.tabId)).toEqual(['a', 'd'])
    const row = regular[0]!
    expect(row.dataset.splitRow).toBe('g1')
    expect(row.dataset.splitLayout).toBe('vertical')
    expect(row.classList.contains('zen-split-row')).toBe(true)
    expect(row.classList.contains('zen-split-row-column')).toBe(false)
    expect(row.getAttribute('role')).toBe('presentation')
    expect(segments(row).map((s) => s.dataset.tabId)).toEqual(['b', 'a', 'c'])
    // Segment, hairline, segment, hairline, segment: the hairline centred on each shared edge.
    expect([...row.children].map((el) => el.className.split(' ')[0])).toEqual([
      'zen-tab',
      'zen-split-hairline',
      'zen-tab',
      'zen-split-hairline',
      'zen-tab'
    ])
    // The plain row after it is no segment.
    expect(regular[1]!.classList.contains('zen-tab')).toBe(true)
    expect(regular[1]!.classList.contains('zen-split-seg')).toBe(false)
  })

  it('names each segment as a pane of the split and keeps the strip items for the keyboard', () => {
    panel([tab('a'), tab('b'), tab('c')], [split('g1', ['a', 'b'])], 'c')
    const [row] = rows('regular')
    const segs = segments(row!)
    expect(segs.map((s) => s.getAttribute('aria-description'))).toEqual([
      'Split view, pane 1 of 2',
      'Split view, pane 2 of 2'
    ])
    expect(segs.every((s) => s.classList.contains('zen-split-seg'))).toBe(true)
    expect(segs.every((s) => s.getAttribute('role') === 'tab')).toBe(true)
    expect(segs.map((s) => s.dataset.stripItem)).toEqual(['tab:a', 'tab:b'])
    // Arrow keys walk the segments in drawn order: the loose row is after both panes.
    const items = [...document.querySelectorAll<HTMLElement>('[data-strip-item^="tab:"]')].map(
      (el) => el.dataset.stripItem
    )
    expect(items).toEqual(['tab:a', 'tab:b', 'tab:c'])
  })

  it('takes the active state as one row while any pane is the active tab', () => {
    panel([tab('a'), tab('b'), tab('c')], [split('g1', ['a', 'b'])], 'b')
    const [row, loose] = rows('regular')
    expect(row!.dataset.active).toBe('true')
    const segs = segments(row!)
    expect(segs.map((s) => s.getAttribute('aria-selected'))).toEqual(['false', 'true'])
    expect(loose!.dataset.active).toBe('false')

    panel([tab('a'), tab('b'), tab('c')], [split('g1', ['a', 'b'])], 'c')
    expect(rows('regular')[0]!.dataset.active).toBe('false')
  })

  it('keeps the favicon, title and close in a segment and drops the trailing slot', () => {
    // A sleeping pane and a sleeping loose row: the row shows the Moon, the segment does not.
    panel(
      [tab('a', { discarded: true }), tab('b'), tab('c', { discarded: true })],
      [split('g1', ['a', 'b'])],
      'b'
    )
    const [row, loose] = rows('regular')
    const [a] = segments(row!)
    expect(a!.querySelector('[data-testid="tab-title"]')?.textContent).toBe('A')
    expect(a!.querySelector('.zen-tab-close')).not.toBeNull()
    expect(a!.querySelector('.zen-tab-sleeping')).toBeNull()
    expect(a!.dataset.discarded).toBe('true')
    expect(loose!.querySelector('.zen-tab-sleeping')).not.toBeNull()
  })

  it('shows a split with one pane in the list as a plain row', () => {
    // b is pinned: the pinned list has one pane of the split and the loose list the other.
    panel([tab('b', { pinned: true }), tab('a'), tab('c')], [split('g1', ['a', 'b'])], 'c')
    expect(document.querySelector('[data-split-row]')).toBeNull()
    expect(rows('pinned').map((r) => r.dataset.tabId)).toEqual(['b'])
    expect(rows('regular').map((r) => r.dataset.tabId)).toEqual(['a', 'c'])
    expect(rows('regular')[0]!.classList.contains('zen-split-seg')).toBe(false)
  })

  it('stacks the group in a column in the icon rail', () => {
    panel([tab('a'), tab('b'), tab('c')], [split('g1', ['a', 'b', 'c'])], 'a', true)
    const [row] = rows('regular')
    expect(row!.classList.contains('zen-split-row-column')).toBe(true)
    expect(segments(row!)).toHaveLength(3)
    expect(row!.querySelectorAll('.zen-split-hairline')).toHaveLength(2)
    // Rail segments are the compact row: favicon only.
    expect(row!.querySelector('[data-testid="tab-title"]')).toBeNull()
  })
})

describe('the split group row stylesheet (§9.35)', () => {
  const block = css.slice(css.indexOf('  .zen-split-row {'), css.indexOf('  .zen-essential {'))
  const rule = (selector: string): string => {
    const at = block.indexOf(`${selector} {`)
    expect(at, selector).toBeGreaterThanOrEqual(0)
    return block.slice(at, block.indexOf('}', at))
  }

  it('is one container at the tab row height, radius 10 over segments at 8 with 2 px padding', () => {
    const row = rule('.zen-split-row')
    expect(row).toContain('height: var(--zen-tab-row)')
    expect(row).toContain('padding: 2px')
    expect(row).toContain('border-radius: 10px')
    const seg = rule('.zen-split-row > .zen-tab')
    expect(seg).toContain('flex: 1 1 0')
    expect(seg).toContain('border-radius: 8px')
    expect(seg).toContain('container-type: inline-size')
    // The tab row's height is one token, read by the row and raised for a coarse pointer.
    expect(css).toContain('--zen-tab-row: 36px')
    expect(css).toMatch(/:root\[data-pointer='coarse'\] \{\n\s+--zen-tab-row: 42px;/)
    expect(css).toMatch(/\.zen-tab \{[^}]*height: var\(--zen-tab-row\)/)
  })

  it('fills the group as one shape in the window family and the segments at 60 % when active', () => {
    expect(rule('.zen-split-row:hover')).toContain('background: var(--v2-window-fill-hover)')
    expect(rule(".zen-split-row[data-active='true']")).toContain(
      'background: var(--v2-window-fill)'
    )
    expect(rule(".zen-split-row[data-active='true'] > .zen-tab")).toContain(
      'color-mix(in srgb, var(--v2-window-fill) 60%, transparent)'
    )
    // A segment has no fill of its own: the row's hover and selected fills are the group's.
    expect(rule('.zen-split-row > .zen-tab:hover')).toContain('background: transparent')
    expect(rule(".zen-split-row > .zen-tab[data-active='true']")).toContain(
      'background: transparent'
    )
  })

  it('draws a 1 × 16 window hairline on each shared edge, hidden while the group is active', () => {
    const hairline = rule('.zen-split-hairline')
    expect(hairline).toContain('width: 1px')
    expect(hairline).toContain('height: 16px')
    expect(hairline).toContain('background: var(--zen-border)')
    expect(hairline).not.toContain('--v2-border')
    expect(rule(".zen-split-row[data-active='true'] .zen-split-hairline")).toContain(
      'visibility: hidden'
    )
  })

  it('hides the close under 70 px a segment and stacks the rail form with a 2 px inset outline', () => {
    expect(block).toContain('@container (width < 70px)')
    expect(block).toMatch(
      /@container \(width < 70px\) \{\s+\.zen-split-row > \.zen-tab \.zen-tab-close \{\s+display: none;/
    )
    const column = rule('.zen-split-row-column')
    expect(column).toContain('flex-direction: column')
    expect(column).toContain('box-shadow: inset 0 0 0 2px var(--zen-border)')
    const columnHairline = rule('.zen-split-row-column > .zen-split-hairline')
    expect(columnHairline).toContain('width: 16px')
    expect(columnHairline).toContain('height: 1px')
  })

  it('has no frame in the expanded sidebar', () => {
    const row = rule('.zen-split-row')
    expect(row).not.toContain('border:')
    expect(row).not.toContain('box-shadow')
    expect(row).not.toContain('outline')
  })
})
