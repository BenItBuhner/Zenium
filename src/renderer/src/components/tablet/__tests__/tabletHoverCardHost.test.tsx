// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Rect, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

/*
 * The tablet chrome's host for the tab hover card (TABLET-05): mounted, it lets the rows raise
 * a card only where a native host is registered (Android's `boot.ts`), and while a card is up
 * it binds the desktop card's dismissals – a press, a key, another tab coming to the front, a
 * drag, a popover opening – each of which sends the host `null`. It draws nothing to the eye;
 * while the native card stands it keeps the card's text in the document, visually hidden, under
 * the desktop card's id, so the focused row describes itself by it as a desktop row does by the
 * DOM card – and never beside a mounted DOM card: one `#zen-tab-hover-card` per document.
 */

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { browserStore, HOVER_CARD_HIDDEN, uiStore } = await import('@renderer/lib/ui')
const { HOVER_CARD_DELAY, hoverCard, hoverCardHosted, nativeHoverCard, setHoverCardHost } =
  await import('@renderer/lib/hoverCard')
const { openPopover } = await import('@renderer/lib/popoverStore')
const { defaultShortcuts } = await import('@shared/shortcuts')
const { TabletHoverCardHost } = await import('../TabletHoverCardHost')
const { TabHoverCard } = await import('../../TabHoverCard')
const { SpacePanel } = await import('../../sidebar/SpacePanel')
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

/** The rows of the space, as the tablet's sidebar lists them, beside the card's host. */
function withRows(state: UIState): ReactElement {
  const space = state.spaces[0] as Space
  return (
    <>
      <SpacePanel state={state} space={space} isActive compact={false} />
      <TabletHoverCardHost state={state} />
    </>
  )
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

describe('TabletHoverCardHost', () => {
  it('counts itself as the card’s host only where a native host is registered', () => {
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    expect(hoverCardHosted()).toBe(false)
    render(<TabletHoverCardHost state={state} />)
    // The desktop at ?formFactor=tablet, the preview: no host that draws, so no card.
    expect(hoverCardHosted()).toBe(false)
    act(() => root!.unmount())
    root = null
    mount?.remove()
    mount = null

    setHoverCardHost(sink())
    render(<TabletHoverCardHost state={state} />)
    expect(hoverCardHosted()).toBe(true)
    act(() => root!.unmount())
    root = null
    expect(hoverCardHosted()).toBe(false)
  })

  it('lets the rows raise the native card, and the UI state keeps no card', async () => {
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    const host = sink()
    setHoverCardHost(host)
    render(<TabletHoverCardHost state={state} />)
    await raise('b')
    expect(host.frames.map((f) => f?.tabId ?? null)).toEqual(['b'])
    expect(uiStore.get().hoverCard).toEqual(HOVER_CARD_HIDDEN)
  })

  it('a press anywhere takes the card down, and nothing is bound once it is', async () => {
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    const host = sink()
    setHoverCardHost(host)
    render(<TabletHoverCardHost state={state} />)
    await raise('b')
    act(() => {
      document.dispatchEvent(new Event('pointerdown'))
    })
    expect(host.frames.at(-1)).toBeNull()
    expect(nativeHoverCard.get().card).toEqual(HOVER_CARD_HIDDEN)
    // Down: another press sends nothing more.
    const sent = host.frames.length
    act(() => {
      document.dispatchEvent(new Event('pointerdown'))
    })
    expect(host.frames.length).toBe(sent)
  })

  it('Escape takes it down; an arrow (the rows’ own key) does not', async () => {
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    const host = sink()
    setHoverCardHost(host)
    render(<TabletHoverCardHost state={state} />)
    await raise('b')
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    })
    expect(host.frames.at(-1)?.tabId).toBe('b')
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(host.frames.at(-1)).toBeNull()
  })

  it('another tab coming to the front takes it down', async () => {
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    const host = sink()
    setHoverCardHost(host)
    render(<TabletHoverCardHost state={state} />)
    await raise('b')
    const next = fixture([tab('a'), tab('b')], 'b')
    browserStore.set({ state: next })
    render(<TabletHoverCardHost state={next} />)
    expect(host.frames.at(-1)).toBeNull()
  })

  it('a drag takes it down', async () => {
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    const host = sink()
    setHoverCardHost(host)
    render(<TabletHoverCardHost state={state} />)
    await raise('b')
    act(() => {
      uiStore.set({
        drag: {
          tabId: 'b',
          remote: false,
          title: 'B',
          favicon: null,
          width: 224,
          height: 44,
          tile: false,
          settling: false
        }
      })
    })
    expect(host.frames.at(-1)).toBeNull()
  })

  it('a popover opening takes it down (§9.20, one at a time)', async () => {
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    const host = sink()
    setHoverCardHost(host)
    render(<TabletHoverCardHost state={state} />)
    await raise('b')
    const el = document.createElement('div')
    const close = openPopover({ element: () => el, close: () => undefined })
    expect(host.frames.at(-1)).toBeNull()
    close()
  })
})

describe('the focused row describes itself (the lead’s (g))', () => {
  it('keeps the card’s text in the document, visually hidden, under the desktop card’s id while the native card stands, and takes it out with the card', async () => {
    const state = fixture([tab('a'), tab('b', { discarded: true })], 'a')
    browserStore.set({ state })
    const host = sink()
    setHoverCardHost(host)
    render(<TabletHoverCardHost state={state} />)
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

  it('the row names it: `aria-describedby` carries the id on the native path while the card stands, and drops it after', async () => {
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    const host = sink()
    setHoverCardHost(host)
    render(withRows(state))
    expect(row('b').hasAttribute('aria-describedby')).toBe(false)

    await raise('b')
    expect(row('b').getAttribute('aria-describedby')).toBe('zen-tab-hover-card')
    expect(row('a').hasAttribute('aria-describedby')).toBe(false)
    const described = document.getElementById(row('b').getAttribute('aria-describedby')!)
    expect(described).not.toBeNull()
    expect(texts(described!)).toEqual(['B', 'b.example'])
    // Nothing in the UI state: the description is the host's frame, not a DOM card.
    expect(uiStore.get().hoverCard).toEqual(HOVER_CARD_HIDDEN)

    act(() => hoverCard.hide())
    expect(row('b').hasAttribute('aria-describedby')).toBe(false)
    expect(node()).toBeNull()
  })

  it('one `#zen-tab-hover-card` per document: the desktop card’s where it is mounted', () => {
    // The desktop card and the tablet host in one document, no native host (the desktop at
    // ?formFactor=tablet registers none): the card raised is the DOM card, and the only node.
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    render(
      <>
        <TabHoverCard state={state} />
        <TabletHoverCardHost state={state} />
      </>
    )
    act(() => uiStore.set({ hoverCard: { tabId: 'b', anchor, sidebar, by: 'focus' } }))
    expect(nodes()).toBe(1)
    expect(node()!.classList.contains('zen-tab-hover-card')).toBe(true)
    expect(node()!.classList.contains('sr-only')).toBe(false)
  })

  it('one `#zen-tab-hover-card` per document: the tablet host’s on Android’s tablet, with a frame applied', async () => {
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    setHoverCardHost(sink())
    render(<TabletHoverCardHost state={state} />)
    await raise('b')
    expect(nodes()).toBe(1)
    expect(node()!.classList.contains('sr-only')).toBe(true)
  })

  it('never two: beside a mounted desktop card the tablet host adds no node of its own', async () => {
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    const host = sink()
    setHoverCardHost(host)
    render(
      <>
        <TabHoverCard state={state} />
        <TabletHoverCardHost state={state} />
      </>
    )
    await raise('b')
    // The native card stands (the host has its frame); the id stays the DOM card's.
    expect(host.frames.at(-1)?.tabId).toBe('b')
    expect(nodes()).toBeLessThanOrEqual(1)
    expect(document.querySelector('#zen-tab-hover-card.sr-only')).toBeNull()
  })
})
