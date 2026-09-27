// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Rect, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

/*
 * The native tab hover card's text in the chrome's document (TABLET-05, the lead's (g)): while
 * the host draws the card, Android's root keeps a visually hidden `#zen-tab-hover-card` with the
 * card's text – the title, the host, the state lines, as the desktop card renders them – so the
 * focused row describes itself by it (`TabItem`'s `aria-describedby`, `useHoverCardUp`) as a
 * desktop row does by the DOM card. One home for every layout that raises the native card: the
 * tablet (its `TabletHoverCardHost` the card's host) and the desktop class under a mouse (the
 * chrome's own `TabHoverCard` the host, drawing nothing on the native path). One
 * `#zen-tab-hover-card` per document, the row's reference resolving, in each configuration. And
 * the card's dismissals bound from here while the native card is up – on the desktop class
 * `TabHoverCard` binds them only for its own DOM card, so a press or Escape in the chrome's
 * document would otherwise leave the host's card standing.
 */

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { browserStore, HOVER_CARD_HIDDEN, uiStore } = await import('@renderer/lib/ui')
const { HOVER_CARD_DELAY, hoverCard, nativeHoverCard, setHoverCardHost } =
  await import('@renderer/lib/hoverCard')
const { defaultShortcuts } = await import('@shared/shortcuts')
const { NativeHoverCardDescription } = await import('../nativeHoverCardDescription')
const { TabletHoverCardHost } = await import('@renderer/components/tablet/TabletHoverCardHost')
const { TabHoverCard } = await import('@renderer/components/TabHoverCard')
const { SpacePanel } = await import('@renderer/components/sidebar/SpacePanel')
type HoverCardFrame = import('@renderer/lib/hoverCard').HoverCardFrame

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 'space',
    containerId: DEFAULT_CONTAINER_ID,
    url: `https://${id}.example/page`,
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

function fixture(tabs: Tab[], activeTabId: string): UIState {
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
    platform: 'android',
    capabilities: { windowControls: false },
    window: { kind: 'synced', fullscreen: false, htmlFullscreenTabId: null },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [space],
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
    downloadsProgress: { received: 0, total: 0, indeterminate: false, active: 0 },
    blockedPopups: {},
    translate: { available: true, tabs: {} },
    securityPrompts: [],
    autofill: { prompts: [], picker: null },
    shortcuts: defaultShortcuts('linux', 'chrome'),
    settings: {
      showTabSeparator: true,
      sidebarExpanded: true,
      sidebarSide: 'left',
      toolbarLayout: 'single',
      urlbarBehavior: 'normal'
    }
  } as unknown as UIState
}

/** The rows of the space as the sidebar lists them. */
function rows(state: UIState): ReactElement {
  return <SpacePanel state={state} space={state.spaces[0] as Space} isActive compact={false} />
}

const row = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${id}"]`)
  if (!el) throw new Error(`missing row ${id}`)
  return el
}
const node = (): HTMLElement | null => document.getElementById('zen-tab-hover-card')
const nodes = (): number => document.querySelectorAll('#zen-tab-hover-card').length
const texts = (el: HTMLElement): string[] =>
  Array.from(el.children).map((child) => child.textContent ?? '')
/** The ids the row's `aria-describedby` names (an id list: a sleeping row's own line is one). */
const refs = (id: string): string[] =>
  (row(id).getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
/** Those ids resolved through the document as a reader resolves them; a dangling one is dropped. */
const describing = (id: string): HTMLElement[] =>
  refs(id)
    .map((ref) => document.getElementById(ref))
    .filter((el): el is HTMLElement => el !== null)

const anchor: Rect = { x: 8, y: 120, width: 224, height: 44 }
const sidebar: Rect = { x: 0, y: 56, width: 240, height: 744 }

function sink(): {
  frames: Array<HoverCardFrame | null>
  apply(frame: HoverCardFrame | null): void
} {
  const frames: Array<HoverCardFrame | null> = []
  return { frames, apply: (frame) => frames.push(frame) }
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

/** A card up for `tabId`: the pointer rested on its row. */
async function raise(tabId: string): Promise<void> {
  hoverCard.pointerEnter(tabId, () => ({ anchor, sidebar }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(HOVER_CARD_DELAY)
    await vi.advanceTimersByTimeAsync(0)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  hoverCard.hide()
  setHoverCardHost(null)
  uiStore.set({ hoverCard: HOVER_CARD_HIDDEN, drag: null })
  nativeHoverCard.set({ card: HOVER_CARD_HIDDEN, frame: null })
  vi.useRealTimers()
})

describe('NativeHoverCardDescription', () => {
  it('keeps the card’s text in the document, visually hidden, under the desktop card’s id while the host draws the card, and takes it out with the card', async () => {
    const state = fixture([tab('a'), tab('b', { discarded: true })], 'a')
    browserStore.set({ state })
    const host = sink()
    setHoverCardHost(host)
    render(
      <>
        <TabletHoverCardHost state={state} />
        <NativeHoverCardDescription />
      </>
    )
    expect(node()).toBeNull()

    await raise('b')
    const el = node()
    expect(el).not.toBeNull()
    expect(el!.getAttribute('role')).toBe('tooltip')
    expect(el!.classList.contains('sr-only')).toBe(true)
    expect(el!.dataset.tabId).toBe('b')
    // The desktop card's text in its order: the title, the host, the state lines.
    expect(texts(el!)).toEqual(['B', 'b.example', 'Sleeping – click to wake'])
    expect(host.frames.at(-1)).toMatchObject({ title: 'B', host: 'b.example' })

    act(() => hoverCard.hide())
    expect(node()).toBeNull()
  })

  it('the tablet: the row’s `aria-describedby` resolves to the description while the card stands, and drops after', async () => {
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    setHoverCardHost(sink())
    render(
      <>
        {rows(state)}
        <TabletHoverCardHost state={state} />
        <NativeHoverCardDescription />
      </>
    )
    expect(row('b').hasAttribute('aria-describedby')).toBe(false)

    await raise('b')
    expect(row('b').getAttribute('aria-describedby')).toBe('zen-tab-hover-card')
    expect(row('a').hasAttribute('aria-describedby')).toBe(false)
    expect(describing('b')).toEqual([node()])
    expect(texts(node()!)).toEqual(['B', 'b.example'])
    // Nothing in the UI state: the description is the host's frame, not a DOM card.
    expect(uiStore.get().hoverCard).toEqual(HOVER_CARD_HIDDEN)

    act(() => hoverCard.hide())
    expect(row('b').hasAttribute('aria-describedby')).toBe(false)
    expect(node()).toBeNull()
  })

  it('Android’s desktop class (a mouse under DeX): the chrome’s own card is the host and draws nothing on the native path – one node, the description, and the row’s reference resolving to it', async () => {
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    const host = sink()
    setHoverCardHost(host)
    render(
      <>
        {rows(state)}
        <TabHoverCard state={state} />
        <NativeHoverCardDescription />
      </>
    )
    expect(nodes()).toBe(0)

    await raise('b')
    expect(host.frames.at(-1)?.tabId).toBe('b')
    expect(uiStore.get().hoverCard).toEqual(HOVER_CARD_HIDDEN)
    expect(document.querySelector('.zen-tab-hover-card')).toBeNull()
    expect(nodes()).toBe(1)
    expect(node()!.classList.contains('sr-only')).toBe(true)
    expect(row('b').getAttribute('aria-describedby')).toBe('zen-tab-hover-card')
    expect(describing('b')).toEqual([node()])
    expect(texts(node()!)).toEqual(['B', 'b.example'])

    act(() => hoverCard.hide())
    expect(nodes()).toBe(0)
    expect(row('b').hasAttribute('aria-describedby')).toBe(false)
  })

  it('Android’s desktop class: a press on the active row and Escape take the native card down – the frame null, no node, the host sent null; an arrow (the rows’ own key) does not', async () => {
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    const host = sink()
    setHoverCardHost(host)
    render(
      <>
        {rows(state)}
        <TabHoverCard state={state} />
        <NativeHoverCardDescription />
      </>
    )

    await raise('b')
    expect(nodes()).toBe(1)
    expect(host.frames.at(-1)?.tabId).toBe('b')
    // `TabHoverCard` binds nothing on the native path (its own card never shows): the press
    // reaches the description's binding, the only one in this document.
    act(() => {
      row('a').dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(nativeHoverCard.get().frame).toBeNull()
    expect(nodes()).toBe(0)
    expect(host.frames.at(-1)).toBeNull()
    expect(row('b').hasAttribute('aria-describedby')).toBe(false)

    await raise('b')
    expect(nodes()).toBe(1)
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    })
    expect(nativeHoverCard.get().frame?.tabId).toBe('b')
    expect(nodes()).toBe(1)
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(nativeHoverCard.get().frame).toBeNull()
    expect(nodes()).toBe(0)
    expect(host.frames.at(-1)).toBeNull()
  })

  it('never two: the desktop card and the tablet host in one document with a native host – exactly one `#zen-tab-hover-card`, the description, and the row’s reference resolving to it', async () => {
    const state = fixture([tab('a'), tab('b', { discarded: true })], 'a')
    browserStore.set({ state })
    const host = sink()
    setHoverCardHost(host)
    render(
      <>
        {rows(state)}
        <TabHoverCard state={state} />
        <TabletHoverCardHost state={state} />
        <NativeHoverCardDescription />
      </>
    )
    await raise('b')
    expect(host.frames.at(-1)?.tabId).toBe('b')
    expect(nodes()).toBe(1)
    expect(node()!.classList.contains('sr-only')).toBe(true)
    // The sleeping row names its own line and the card: every reference resolves, the card's
    // to the description.
    expect(refs('b')).toContain('zen-tab-hover-card')
    expect(describing('b')).toHaveLength(refs('b').length)
    expect(describing('b')).toContain(node())
    expect(texts(node()!)).toEqual(['B', 'b.example', 'Sleeping – click to wake'])
  })

  it('the desktop’s own path, no native host: the description renders nothing and the one node is the DOM card’s, which the row names', () => {
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    render(
      <>
        {rows(state)}
        <TabHoverCard state={state} />
        <NativeHoverCardDescription />
      </>
    )
    act(() => uiStore.set({ hoverCard: { tabId: 'b', anchor, sidebar, by: 'focus' } }))
    expect(nodes()).toBe(1)
    expect(node()!.classList.contains('zen-tab-hover-card')).toBe(true)
    expect(node()!.classList.contains('sr-only')).toBe(false)
    expect(describing('b')).toEqual([node()])
  })

  // The entry is nothing a test renders (it boots the core first), so its seat is pinned as
  // source: the description mounted once, beside the shell's `Root`, inside the same boundary.
  it('has one home: Android’s root mounts it once, beside `<Root />` (`main.tsx`)', () => {
    const main = readFileSync(resolve(__dirname, '../main.tsx'), 'utf8')
    expect(main).toMatch(
      /<ErrorBoundary>\s*<Root \/>\s*(\{\/\*[\s\S]*?\*\/\}\s*)?<NativeHoverCardDescription \/>\s*<\/ErrorBoundary>/
    )
    expect(main.match(/<NativeHoverCardDescription \/>/g)).toHaveLength(1)
    // Nowhere else: the shells and the tablet's host render no node of that id.
    for (const file of [
      '../../renderer/src/App.tsx',
      '../../renderer/src/components/tablet/TabletShell.tsx',
      '../../renderer/src/components/tablet/TabletHoverCardHost.tsx'
    ]) {
      expect(readFileSync(resolve(__dirname, file), 'utf8'), file).not.toContain(
        'NativeHoverCardDescription />'
      )
    }
  })
})
