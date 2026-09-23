// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Folder, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

/*
 * What a tab row tells a screen reader (parity matrix a11y-31): its states – recording, muted,
 * playing, sleeping, pinned – as hidden text the row is described by, joined by the hover card
 * when it stands; its place in its list as aria-posinset / aria-setsize, one list per run of
 * rows; and the rename field beside the row in the chrome layer rather than inside the tab
 * (axe nested-interactive), handing focus back to the row on Enter and Escape.
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
const { tabRowDescription, tabRowPosition, tabRowStates } = await import('@renderer/lib/tabRowAria')
const { defaultShortcuts } = await import('@shared/shortcuts')
const { SpacePanel } = await import('../SpacePanel')

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
  activeTabId = tabs[0]?.id ?? null
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
  const state = {
    platform: 'linux',
    capabilities: { windowControls: false },
    window: { kind: 'synced', fullscreen: false, htmlFullscreenTabId: null },
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
  return { state, space }
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

function panel(tabs: Tab[], folders: Folder[] = [], activeTabId?: string): void {
  const { state, space } = fixture(tabs, folders, activeTabId ?? tabs[0]?.id ?? null)
  browserStore.set({ state })
  render(<SpacePanel state={state} space={space} isActive compact={false} />)
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
/** The text a row is described by: every id in its `aria-describedby`, in order. */
const describedBy = (el: HTMLElement): string[] =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? `#${id}`)
const position = (el: HTMLElement): string =>
  `${el.getAttribute('aria-posinset')} of ${el.getAttribute('aria-setsize')}`
const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
const type = (input: HTMLInputElement, value: string): void => {
  act(() => {
    nativeValue.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the row’s states (lib/tabRowAria.ts)', () => {
  it('names what the user cannot see first – the alert, the audio – then the sleep, then pinned', () => {
    expect(tabRowStates(tab('a'), null)).toEqual([])
    expect(tabRowStates(tab('a', { audible: true }), null)).toEqual(['playing'])
    expect(tabRowStates(tab('a', { audible: true, muted: true }), null)).toEqual(['muted'])
    expect(tabRowStates(tab('a', { muted: true }), null)).toEqual(['muted'])
    expect(tabRowStates(tab('a', { discarded: true }), null)).toEqual(['sleeping'])
    expect(tabRowStates(tab('a', { frozen: true }), null)).toEqual(['frozen'])
    expect(tabRowStates(tab('a', { cpuThrottle: 4 }), null)).toEqual(['throttled'])
    // Asleep outranks the governor's marks, as in the row's trailing slot.
    expect(tabRowStates(tab('a', { discarded: true, frozen: true }), null)).toEqual(['sleeping'])
    expect(tabRowStates(tab('a', { pinned: true }), null)).toEqual(['pinned'])
    expect(tabRowStates(tab('a', { audible: true }), 'recording')).toEqual(['recording', 'playing'])
    expect(tabRowStates(tab('a'), 'capturing')).toEqual(['sharing'])
    expect(tabRowStates(tab('a'), 'pip')).toEqual(['picture in picture'])
    expect(
      tabRowStates(tab('a', { pinned: true, muted: true, discarded: true }), 'recording')
    ).toEqual(['recording', 'muted', 'sleeping', 'pinned'])
  })

  it('says nothing of a row under the private lock', () => {
    expect(tabRowStates(tab('a', { pinned: true, audible: true }), 'recording', true)).toEqual([])
  })

  it('describes the split pane first, then the states; nothing for a plain row', () => {
    expect(tabRowDescription([], null)).toBeNull()
    expect(tabRowDescription(['muted'], null)).toBe('muted')
    expect(tabRowDescription([], { index: 0, count: 2 })).toBe('Split view, pane 1 of 2')
    expect(tabRowDescription(['playing', 'pinned'], { index: 1, count: 2 })).toBe(
      'Split view, pane 2 of 2, playing, pinned'
    )
  })

  it('places a row in its list one-based, and nowhere outside a list', () => {
    expect(tabRowPosition(['a', 'b', 'c'], 'b')).toEqual({ pos: 2, size: 3 })
    expect(tabRowPosition(['a', 'b', 'c'], 'z')).toBeNull()
    expect(tabRowPosition(null, 'a')).toBeNull()
  })
})

describe('the row in the sidebar (a11y-31)', () => {
  it('is described by its states as hidden text, and by nothing when it has none', () => {
    panel([
      tab('a'),
      tab('b', { audible: true }),
      tab('c', { muted: true }),
      tab('d', { discarded: true }),
      tab('e', { alert: 'recording', audible: true, pinned: false })
    ])
    expect(row('a').hasAttribute('aria-describedby')).toBe(false)
    expect(row('a').hasAttribute('aria-description')).toBe(false)
    expect(describedBy(row('b'))).toEqual(['playing'])
    expect(describedBy(row('c'))).toEqual(['muted'])
    expect(describedBy(row('d'))).toEqual(['sleeping'])
    expect(describedBy(row('e'))).toEqual(['recording, playing'])
    // The name stays the title (the aria baselines read `tab "B"`), the text is hidden.
    expect(row('b').getAttribute('aria-label')).toBe('B')
    const hidden = document.getElementById(row('b').getAttribute('aria-describedby')!)!
    expect(hidden.hasAttribute('hidden')).toBe(true)
    expect(row('b').contains(hidden)).toBe(true)
  })

  it('says its place in its own list: the pinned run, a folder’s run, the loose run, each counted alone', () => {
    panel(
      [
        tab('p1', { pinned: true }),
        tab('p2', { pinned: true }),
        tab('f1', { folderId: 'work' }),
        tab('f2', { folderId: 'work' }),
        tab('f3', { folderId: 'work' }),
        tab('l1'),
        tab('l2')
      ],
      [folder('work', 'Work')],
      'l1'
    )
    expect(['p1', 'p2'].map((id) => position(row(id)))).toEqual(['1 of 2', '2 of 2'])
    expect(['f1', 'f2', 'f3'].map((id) => position(row(id)))).toEqual([
      '1 of 3',
      '2 of 3',
      '3 of 3'
    ])
    expect(['l1', 'l2'].map((id) => position(row(id)))).toEqual(['1 of 2', '2 of 2'])
    // A pinned row is described as pinned; its place is the pinned list's.
    expect(describedBy(row('p2'))).toEqual(['pinned'])
  })

  it('keeps the hover card as its description too, after the states, while the card stands', () => {
    panel([tab('a'), tab('b', { muted: true })])
    const box = { x: 0, y: 0, width: 200, height: 32 }
    act(() => uiStore.set({ hoverCard: { tabId: 'b', anchor: box, sidebar: box, by: 'focus' } }))
    expect(row('b').getAttribute('aria-describedby')).toBe('zen-tab-desc-b zen-tab-hover-card')
    expect(describedBy(row('b'))[0]).toBe('muted')
    // A plain row's description is the card alone.
    act(() => uiStore.set({ hoverCard: { tabId: 'a', anchor: box, sidebar: box, by: 'focus' } }))
    expect(row('a').getAttribute('aria-describedby')).toBe('zen-tab-hover-card')
    expect(row('b').getAttribute('aria-describedby')).toBe('zen-tab-desc-b')
  })
})

describe('the rename field (a11y-31, axe nested-interactive)', () => {
  const startRename = (id: string): HTMLInputElement => {
    act(() => uiStore.set({ renamingTabId: id }))
    const field = document.querySelector<HTMLInputElement>(`[data-tab-rename="${id}"] input`)
    if (!field) throw new Error('no rename field')
    return field
  }

  it('stands in the chrome layer beside the row, not inside the tab, named, and the title’s box stays', () => {
    panel([tab('a'), tab('b')])
    const field = startRename('b')
    expect(field.getAttribute('aria-label')).toBe('Rename tab')
    expect(field.value).toBe('B')
    expect(document.activeElement).toBe(field)
    // Nothing focusable inside any tab; the tablist holds tabs alone.
    expect(document.querySelectorAll('[role="tab"] input, [role="tab"] [tabindex]')).toHaveLength(0)
    expect(row('b').contains(field)).toBe(false)
    expect(field.closest('#zen-chrome-layer')).not.toBeNull()
    expect(field.closest('[data-surface]')?.getAttribute('data-surface')).toBe('window')
    expect(field.closest('[role="tablist"]')).toBeNull()
    // The title keeps its box for the field to draw over, blank meanwhile.
    const title = row('b').querySelector<HTMLElement>('[data-testid="tab-title"]')!
    expect(title.style.visibility).toBe('hidden')
    expect(row('b').dataset.renaming).toBe('true')
  })

  it('is visible at the moment it takes focus: the box is measured before the first commit (the browser refuses focus under visibility: hidden – the a11y-2 drive)', () => {
    panel([tab('a'), tab('b')])
    const seen: string[] = []
    const focus = HTMLInputElement.prototype.focus
    const spy = vi.spyOn(HTMLInputElement.prototype, 'focus').mockImplementation(function (
      this: HTMLInputElement
    ) {
      seen.push(this.closest<HTMLElement>('.zen-tab-rename')?.style.visibility ?? '<no wrapper>')
      focus.call(this)
    })
    try {
      const field = startRename('b')
      expect(document.activeElement).toBe(field)
      expect(seen).toEqual(['visible'])
    } finally {
      spy.mockRestore()
    }
  })

  it('commits on Enter and hands focus back to the row, which is the strip’s stop again', () => {
    panel([tab('a'), tab('b')])
    const field = startRename('b')
    type(field, 'Notes')
    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(vi.mocked(run)).toHaveBeenCalledWith('tab.rename', { tabId: 'b', title: 'Notes' })
    expect(uiStore.get().renamingTabId).toBeNull()
    expect(document.querySelector('[data-tab-rename]')).toBeNull()
    expect(document.activeElement).toBe(row('b'))
    expect(uiStore.get().stripFocus).toBe('tab:b')
    expect(row('b').querySelector<HTMLElement>('[data-testid="tab-title"]')!.style.visibility).toBe(
      ''
    )
    // The row's own keys never saw the field's Enter (it would have activated the tab).
    expect(vi.mocked(run)).not.toHaveBeenCalledWith('tab.activate', expect.anything())
  })

  it('drops the edit on Escape, focus back to the row, and commits once on a blur without moving focus', () => {
    panel([tab('a'), tab('b')])
    let field = startRename('b')
    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(vi.mocked(run)).not.toHaveBeenCalledWith('tab.rename', expect.anything())
    expect(document.activeElement).toBe(row('b'))

    field = startRename('b')
    type(field, 'Later')
    const elsewhere = document.createElement('button')
    document.body.appendChild(elsewhere)
    act(() => elsewhere.focus())
    expect(vi.mocked(run)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(run)).toHaveBeenCalledWith('tab.rename', { tabId: 'b', title: 'Later' })
    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()
  })
})
