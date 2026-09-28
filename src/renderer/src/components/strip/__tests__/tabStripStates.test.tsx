// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

/*
 * The horizontal strip's states as the DOM carries them (parity tabs-61 / tabs-63; design
 * language v2 §9.37, §9.29): the rows stand as direct children of their tablist, 4 px apart –
 * the gap is the strip's one separator – and a group's chip as the header of its shell, ahead
 * of the member rows' own list under the group's line; the active row says so in `data-active`,
 * the private window's strip is marked `data-private` and carries the mask at its start, and a
 * press commits nothing: the activation is the click's, so the pressed fill (§9.29's window
 * hover fill) is a state on the way to the pill, which arrives with the release.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { run } = await import('@renderer/lib/api')
const { browserStore, HOVER_CARD_HIDDEN, uiStore } = await import('@renderer/lib/ui')
const { defaultShortcuts } = await import('@shared/shortcuts')
const { TabStrip } = await import('../TabStrip')

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
    errorCode: null,
    bookmarked: false,
    readerable: false,
    blockedCount: 0,
    ...over
  } as Tab
}

function folder(id: string, name: string, over: Partial<Folder> = {}): Folder {
  return {
    id,
    spaceId: 'space',
    name,
    icon: '📁',
    color: null,
    collapsed: false,
    ...over
  } as Folder
}

function fixture(
  tabs: Tab[],
  folders: Folder[] = [],
  activeTabId = tabs[0]?.id ?? null,
  windowKind: 'synced' | 'private' = 'synced'
): UIState {
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
  return {
    platform: 'linux',
    capabilities: { windowControls: false },
    window: { kind: windowKind, fullscreen: false, htmlFullscreenTabId: null },
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
    boosts: [],
    extensions: [],
    bookmarks: [],
    downloads: [],
    downloadsProgress: { received: 0, total: 0, indeterminate: false, active: 0 },
    shortcuts: defaultShortcuts('linux', 'chrome'),
    blockedPopups: {},
    translate: { available: true, tabs: {} },
    securityPrompts: [],
    autofill: { prompts: [], picker: null },
    settings: {
      showTabSeparator: true,
      sidebarExpanded: true,
      sidebarSide: 'left',
      toolbarLayout: 'single',
      urlbarBehavior: 'normal'
    }
  } as unknown as UIState
}

let root: Root | null = null
let mount: HTMLElement | null = null

function render(el: ReactElement): HTMLElement {
  if (!root) {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  }
  act(() => root!.render(el))
  return mount!
}

function strip(state: UIState): HTMLElement {
  browserStore.set({ state })
  render(<TabStrip state={state} />)
  const el = document.querySelector<HTMLElement>('[data-tab-strip]')
  if (!el) throw new Error('missing strip')
  return el
}

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  uiStore.set({ hoverCard: HOVER_CARD_HIDDEN, renamingTabId: null, stripFocus: null })
  vi.mocked(run).mockClear()
})

const row = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${id}"]`)
  if (!el) throw new Error(`missing row ${id}`)
  return el
}

describe('the strip’s rows (the shape the state rules read)', () => {
  it('stands every tab row as a direct child of its tablist, 4 px apart, the active one saying so', () => {
    strip(fixture([tab('a'), tab('b'), tab('c')], [], 'b'))
    const list = document.querySelector<HTMLElement>('[data-tab-list="regular"]')!
    const rows = [...list.children]
    expect(rows.map((r) => r.getAttribute('data-tab-id'))).toEqual(['a', 'b', 'c'])
    expect(rows.every((r) => r.classList.contains('zen-tab'))).toBe(true)
    expect(rows.map((r) => r.getAttribute('data-active'))).toEqual(['false', 'true', 'false'])
    // §9.37's separators are the gaps: the list is a `gap-1` flex row (the 4), and no row carries
    // a hairline of its own.
    expect(list.classList.contains('gap-1')).toBe(true)
    expect(list.querySelector('[data-strip-separator], hr')).toBeNull()
    // The strip is a window surface (§9.29): its rows read the window family's tokens.
    expect(document.querySelector('[data-tab-strip]')?.getAttribute('data-surface')).toBe('window')
  })

  it('puts a group’s chip ahead of its members as the shell’s header, the members in their own list under the group’s line', () => {
    strip(
      fixture(
        [tab('a'), tab('g1', { folderId: 'f' }), tab('g2', { folderId: 'f' }), tab('z')],
        [folder('f', 'Work', { color: 'blue' })],
        'a'
      )
    )
    const shell = document.querySelector<HTMLElement>('[data-strip-group-shell="f"]')!
    expect(shell.classList.contains('zen-strip-group')).toBe(true)
    expect(shell.parentElement?.getAttribute('data-tab-list')).toBe('regular')
    const [chip, rows] = [...shell.children].filter((c) => c.tagName === 'DIV')
    expect(chip.matches('.zen-tab[data-tab-folder="f"]')).toBe(true)
    expect(rows.classList.contains('zen-group-rows')).toBe(true)
    expect([...rows.children].map((r) => r.getAttribute('data-tab-id'))).toEqual(['g1', 'g2'])
    // The same 4 between the chip and its members and between the members (§9.37: the line
    // bridges the 4 px gaps); the shell spans the band so the line can sit in its top inset.
    expect(shell.classList.contains('gap-1')).toBe(true)
    expect(shell.classList.contains('h-full')).toBe(true)
    expect(rows.classList.contains('gap-1')).toBe(true)
    // The group's line is the shell's own child, after the rows, wearing the §9.14 colour pair.
    const line = shell.querySelector<HTMLElement>('.zen-strip-group-line')!
    expect(line.getAttribute('data-strip-group-line')).toBe('f')
    expect(line.parentElement).toBe(shell)
    expect(line.hasAttribute('data-group-rgb')).toBe(true)
    expect(line.style.getPropertyValue('--zen-group-rgb-light')).not.toBe('')
    expect(line.style.getPropertyValue('--zen-group-rgb-dark')).not.toBe('')
    expect(line.getAttribute('aria-hidden')).not.toBeNull()
  })

  it('lists pinned tabs in their own tablist, 4 px apart, ahead of the scroller', () => {
    strip(fixture([tab('p', { pinned: true }), tab('a')], [], 'a'))
    const pinned = document.querySelector<HTMLElement>('[data-strip-pinned]')!
    expect(pinned.getAttribute('data-tab-list')).toBe('pinned')
    expect(pinned.classList.contains('gap-1')).toBe(true)
    expect([...pinned.children].map((r) => r.getAttribute('data-tab-id'))).toEqual(['p'])
    expect(pinned.nextElementSibling?.classList.contains('zen-strip-scroller')).toBe(true)
  })
})

describe('the private window’s strip (§9.37: the private ink with the mask at its start)', () => {
  it('is marked data-private and carries the mask', () => {
    const el = strip(fixture([tab('a')], [], 'a', 'private'))
    expect(el.hasAttribute('data-private')).toBe(true)
    const mask = el.querySelector('[aria-label="Private window"]')
    expect(mask).not.toBeNull()
    expect(el.firstElementChild).toBe(mask)
  })

  it('a regular window’s strip is not, and has no mask', () => {
    const el = strip(fixture([tab('a')], [], 'a'))
    expect(el.hasAttribute('data-private')).toBe(false)
    expect(el.querySelector('[aria-label="Private window"]')).toBeNull()
  })
})

describe('pressed: the press commits nothing, the click does', () => {
  it('activates on the click, not on the pointer-down (the press is §9.29’s pressed fill, a state on the way to the pill)', () => {
    strip(fixture([tab('a'), tab('b')], [], 'a'))
    const b = row('b')
    act(() => {
      b.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
      )
    })
    expect(vi.mocked(run).mock.calls.some(([name]) => name === 'tab.activate')).toBe(false)
    act(() => {
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
    })
    expect(vi.mocked(run)).toHaveBeenCalledWith('tab.activate', { tabId: 'b' })
  })
})
