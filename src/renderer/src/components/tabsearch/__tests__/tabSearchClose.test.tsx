// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { TabSearchCandidate, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

/*
 * The tab search popover's × (tabs-17, §9.20: a 28 px icon button trailing every row) closes
 * the row's tab through the chrome's one close seam, `closeTabFromChrome` (`lib/closeUndo.ts`,
 * OS-40 part B, §9.23): on a touch layout the close comes with Undo on the toast, on the
 * desktop it is the bare `tab.close` it always was – the seam's two sides are pinned where it
 * lives (`hooks/__tests__/closeUndoable.test.tsx`). Here the button is held to the seam, and
 * the press stays the button's: it does not switch to the row's tab on its way.
 */

Object.assign(window, { zen: { invoke: async () => null, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function candidate(id: string, over: Partial<TabSearchCandidate> = {}): TabSearchCandidate {
  return {
    id,
    title: id.toUpperCase(),
    url: `https://${id}.example/`,
    favicon: null,
    customIcon: null,
    containerId: DEFAULT_CONTAINER_ID,
    windowLabel: null,
    active: false,
    audible: false,
    muted: false,
    loading: false,
    discarded: false,
    lastActiveAt: 0,
    ...over
  }
}

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async (name: string) =>
    name === 'tab.searchCandidates'
      ? [candidate('a'), candidate('b'), candidate('c', { muted: true, windowLabel: 'Window 2' })]
      : null
  ),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))
vi.mock('@renderer/lib/closeUndo', () => ({
  closeTabFromChrome: vi.fn()
}))

const { run } = await import('@renderer/lib/api')
const { closeTabFromChrome } = await import('@renderer/lib/closeUndo')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { defaultShortcuts } = await import('@shared/shortcuts')
const { TabSearchLayer } = await import('../TabSearchPopover')

/** A window with no active tab: the popover holds no picture of a page and paints at once. */
const STATE = {
  platform: 'android',
  capabilities: { windowControls: false },
  window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
  tabs: {},
  spaces: [
    {
      id: 'space',
      name: 'Home',
      icon: '',
      containerId: DEFAULT_CONTAINER_ID,
      theme: null,
      tabIds: [],
      activeTabId: null,
      pinnedCollapsed: false
    }
  ],
  activeSpaceId: 'space',
  folders: {},
  liveFolders: {},
  splitGroups: {},
  essentialTabIds: [],
  foreignTabIds: [],
  agents: [],
  containers: [],
  media: [],
  boosts: [],
  extensions: [],
  bookmarks: [],
  downloads: [],
  recentlyClosed: [],
  closingTabIds: [],
  shortcuts: defaultShortcuts('linux', 'chrome'),
  settings: { pinnedCloseBehavior: 'unload' }
} as unknown as UIState

let root: Root | null = null
let host: HTMLElement | null = null

async function open(tablet = false): Promise<void> {
  browserStore.set({ state: STATE })
  // After the state: the store's change refreshes the viewport from the window's chrome.
  if (tablet)
    viewportStore.set({ ...viewportStore.get(), formFactor: 'tablet', coarse: true, hover: false })
  uiStore.set({ tabSearch: { keyboard: false } })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(createElement(TabSearchLayer))
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

function closeOf(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[data-tab-search-row="${id}"] .zen-tab-search-close`
  )
  if (!el) throw new Error(`no × on the row of ${id}`)
  return el
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  uiStore.set({ tabSearch: null, toasts: [] })
  browserStore.set({ state: null })
  viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop', coarse: false, hover: true })
  vi.mocked(run).mockClear()
  vi.mocked(closeTabFromChrome).mockClear()
})

describe("the tab search popover's × (TabSearchPopover.tsx)", () => {
  it('on the tablet closes the row’s tab through the chrome’s seam, which carries the Undo, and switches to nothing', async () => {
    await open(true)
    act(() => closeOf('b').click())
    expect(vi.mocked(closeTabFromChrome).mock.calls).toEqual([['b']])
    expect(vi.mocked(run).mock.calls.map(([name]) => name)).not.toContain('tab.close')
    expect(vi.mocked(run).mock.calls.map(([name]) => name)).not.toContain('tab.switchTo')
  })

  it('on the desktop goes through the same seam, which there is the bare tab.close it always was', async () => {
    await open()
    act(() => closeOf('a').click())
    expect(vi.mocked(closeTabFromChrome).mock.calls).toEqual([['a']])
    expect(vi.mocked(run).mock.calls.map(([name]) => name)).not.toContain('tab.close')
  })
})

/*
 * A row's trailing slot is 16 on every platform (§9.3; the Lead's ruling on #787's nit 3, A9):
 * the mute and other-window status badges follow the chevron and the check, not the leading
 * glyph token, which grows to 20 on a touch layout. The favicon in the lead keeps its own size.
 */
describe("the tab search row's trailing status badges (TabSearchPopover.tsx, A9)", () => {
  function badgesOf(id: string): SVGElement[] {
    const row = document.querySelector<HTMLElement>(`[data-tab-search-row="${id}"]`)
    if (!row) throw new Error(`no row for ${id}`)
    return Array.from(
      row.querySelectorAll<SVGElement>('svg.zen-tab-search-glyph, span.zen-tab-search-glyph > svg')
    )
  }

  it('draws the mute badge and the other-window badge at 16 on the tablet, where the leading glyph token is 20', async () => {
    await open(true)
    const badges = badgesOf('c')
    expect(badges).toHaveLength(2)
    for (const svg of badges) {
      const classes = svg.getAttribute('class') ?? ''
      expect(classes).toContain('h-4 w-4')
      expect(classes).not.toContain('var(--v2-icon)')
    }
    expect(badgesOf('a')).toHaveLength(0)
  })

  it('on the desktop the same 16: nothing changes there, where the glyph token is 16 already', async () => {
    await open()
    for (const svg of badgesOf('c')) {
      expect(svg.getAttribute('class') ?? '').toContain('h-4 w-4')
    }
    expect(badgesOf('c')).toHaveLength(2)
  })
})
