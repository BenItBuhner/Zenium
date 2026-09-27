// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Rect, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

/*
 * The hover card's native host seam (TABLET-05): with a host registered (`setHoverCardHost`,
 * Android's `boot.ts`) the app's controller drives that host – the frame out per change, `null`
 * to take the card down – and never the UI state's `hoverCard` slice, and it captures no page:
 * the page keeps playing under the card the host draws. With none registered the desktop's path
 * is what it was: the slice written, the active page and the hovered page captured.
 */

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { cmd } = await import('@renderer/lib/api')
const { browserStore, HOVER_CARD_HIDDEN, uiStore } = await import('@renderer/lib/ui')
const {
  bindHoverCardDismissals,
  HOVER_CARD_DELAY,
  hostHoverCard,
  hoverCard,
  hoverCardFrame,
  hoverCardNativeHost,
  nativeHoverCard,
  setHoverCardHost
} = await import('@renderer/lib/hoverCard')
type HoverCardFrame = import('@renderer/lib/hoverCard').HoverCardFrame

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 'space',
    containerId: DEFAULT_CONTAINER_ID,
    url: `https://www.${id}.example/page?q=1`,
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
    platform: 'linux',
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
    settings: { sidebarExpanded: true, sidebarSide: 'left' }
  } as unknown as UIState
}

const anchor: Rect = { x: 8, y: 120, width: 224, height: 44 }
const sidebar: Rect = { x: 0, y: 56, width: 240, height: 744 }
const viewport = { width: 1280, height: 800 }

/** A host that keeps every frame it was given. */
function sink(): { frames: Array<HoverCardFrame | null>; apply(frame: HoverCardFrame | null): void } {
  const frames: Array<HoverCardFrame | null> = []
  return { frames, apply: (frame) => frames.push(frame) }
}

let release: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(window, { innerWidth: viewport.width, innerHeight: viewport.height })
})

afterEach(() => {
  hoverCard.hide()
  release?.()
  release = null
  setHoverCardHost(null)
  uiStore.set({ hoverCard: HOVER_CARD_HIDDEN })
  nativeHoverCard.set({ card: HOVER_CARD_HIDDEN })
  vi.mocked(cmd).mockClear()
  vi.useRealTimers()
})

async function rest(): Promise<void> {
  await vi.advanceTimersByTimeAsync(HOVER_CARD_DELAY)
  await vi.advanceTimersByTimeAsync(0)
}

describe('the native host seam (TABLET-05)', () => {
  it('registers and reads back the host; none by default', () => {
    expect(hoverCardNativeHost()).toBeNull()
    const host = sink()
    setHoverCardHost(host)
    expect(hoverCardNativeHost()).toBe(host)
    setHoverCardHost(null)
    expect(hoverCardNativeHost()).toBeNull()
  })

  it('a native host receives the frame once the pointer has rested; the UI state is never written and nothing is captured', async () => {
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    const host = sink()
    setHoverCardHost(host)
    release = hostHoverCard()

    hoverCard.pointerEnter('b', () => ({ anchor, sidebar }))
    expect(host.frames).toEqual([])
    await rest()

    expect(host.frames).toHaveLength(1)
    expect(host.frames[0]).toEqual({
      visible: true,
      tabId: 'b',
      title: 'B',
      host: 'b.example',
      lines: [],
      preview: true,
      url: 'https://www.b.example/page?q=1',
      anchor,
      sidebar,
      viewport,
      by: 'pointer'
    })
    expect(nativeHoverCard.get().card).toEqual({ tabId: 'b', anchor, sidebar, axis: undefined, by: 'pointer' })
    expect(hoverCard.showing('b')).toBe(true)
    // The page keeps playing under the host's card: no cover of the active page, no fresh
    // picture of the hovered one, and nothing over the content frame in the UI state.
    expect(uiStore.get().hoverCard).toEqual(HOVER_CARD_HIDDEN)
    expect(cmd).not.toHaveBeenCalled()
  })

  it('moving to the next row while a card is up sends its frame at once; hide sends null', async () => {
    const state = fixture([tab('a'), tab('b'), tab('c')], 'a')
    browserStore.set({ state })
    const host = sink()
    setHoverCardHost(host)
    release = hostHoverCard()

    hoverCard.pointerEnter('b', () => ({ anchor, sidebar }))
    await rest()
    const next: Rect = { ...anchor, y: 164 }
    hoverCard.pointerLeave('b')
    hoverCard.pointerEnter('c', () => ({ anchor: next, sidebar }))
    await vi.advanceTimersByTimeAsync(0)
    expect(host.frames.map((f) => f?.tabId ?? null)).toEqual(['b', 'c'])
    expect(host.frames[1]?.anchor).toEqual(next)

    hoverCard.hide()
    expect(host.frames.at(-1)).toBeNull()
    expect(nativeHoverCard.get().card).toEqual(HOVER_CARD_HIDDEN)
    expect(uiStore.get().hoverCard).toEqual(HOVER_CARD_HIDDEN)
  })

  it('keyboard focus sends the frame at once, by focus, along the strip with its axis', async () => {
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    const host = sink()
    setHoverCardHost(host)
    release = hostHoverCard()

    const band: Rect = { x: 0, y: 0, width: 1280, height: 36 }
    hoverCard.focus('b', () => ({ anchor: { x: 300, y: 0, width: 180, height: 36 }, sidebar: band, axis: 'x' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(host.frames).toHaveLength(1)
    expect(host.frames[0]).toMatchObject({ tabId: 'b', by: 'focus', axis: 'x', sidebar: band })
  })

  it('the active tab’s card carries no preview: its page is under the card', async () => {
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    const host = sink()
    setHoverCardHost(host)
    release = hostHoverCard()

    hoverCard.pointerEnter('a', () => ({ anchor, sidebar }))
    await rest()
    expect(host.frames[0]).toMatchObject({ tabId: 'a', preview: false })
  })

  it('without a host mounted the controller raises nothing, native host or not', async () => {
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    const host = sink()
    setHoverCardHost(host)

    hoverCard.pointerEnter('b', () => ({ anchor, sidebar }))
    await rest()
    expect(host.frames).toEqual([])
    expect(nativeHoverCard.get().card).toEqual(HOVER_CARD_HIDDEN)
    expect(cmd).not.toHaveBeenCalled()
  })

  it('with no native host the desktop’s path is what it was: the UI state written, the pages captured', async () => {
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    release = hostHoverCard()

    hoverCard.pointerEnter('b', () => ({ anchor, sidebar }))
    await rest()
    expect(uiStore.get().hoverCard).toEqual({ tabId: 'b', anchor, sidebar, axis: undefined, by: 'pointer' })
    expect(nativeHoverCard.get().card).toEqual(HOVER_CARD_HIDDEN)
    expect(cmd).toHaveBeenCalledWith('overlay.snapshot', { tabId: 'a' })
    expect(cmd).toHaveBeenCalledWith('overlay.snapshot', { tabId: 'b', fresh: true })
  })
})

describe('hoverCardFrame', () => {
  const state = fixture([tab('a'), tab('b', { title: 'Beta – a long title' }), tab('c', { discarded: true })], 'a')

  it('is null for no card, or a card whose tab has gone', () => {
    expect(hoverCardFrame(HOVER_CARD_HIDDEN, state, viewport)).toBeNull()
    expect(hoverCardFrame({ tabId: 'zz', anchor, sidebar, by: 'pointer' }, state, viewport)).toBeNull()
    expect(hoverCardFrame({ tabId: 'b', anchor, sidebar, by: 'pointer' }, null, viewport)).toBeNull()
  })

  it('carries the desktop card’s text: the title, the host as the pill shows it, the state lines', () => {
    const frame = hoverCardFrame({ tabId: 'b', anchor, sidebar, by: 'pointer' }, state, viewport)
    expect(frame).toMatchObject({ visible: true, tabId: 'b', title: 'Beta – a long title', host: 'b.example', lines: [] })
    expect(frame).not.toHaveProperty('axis')
  })

  it('no preview for a sleeping tab, and the axis when the row is on the strip', () => {
    expect(hoverCardFrame({ tabId: 'c', anchor, sidebar, by: 'focus' }, state, viewport)).toMatchObject({
      preview: false,
      by: 'focus'
    })
    expect(hoverCardFrame({ tabId: 'b', anchor, sidebar, axis: 'x', by: 'pointer' }, state, viewport)).toMatchObject({
      axis: 'x'
    })
  })
})

describe('bindHoverCardDismissals', () => {
  function fire(target: EventTarget, type: string, init: EventInit | KeyboardEventInit = {}): void {
    const event = type === 'keydown' ? new KeyboardEvent(type, init) : new Event(type, init)
    target.dispatchEvent(event)
  }

  it('takes the card down on a press, a context menu, a wheel, a scroll, the window’s blur and resize', () => {
    for (const [target, type] of [
      [document, 'pointerdown'],
      [document, 'contextmenu'],
      [document, 'wheel'],
      [document, 'scroll'],
      [window, 'blur'],
      [window, 'resize']
    ] as Array<[EventTarget, string]>) {
      const hide = vi.fn()
      const off = bindHoverCardDismissals(hide)
      fire(target, type)
      expect(hide, type).toHaveBeenCalledTimes(1)
      off()
    }
  })

  it('Escape, Backspace, Delete and typing dismiss; the rows’ own keys do not', () => {
    const hide = vi.fn()
    const off = bindHoverCardDismissals(hide)
    for (const key of ['ArrowDown', 'ArrowUp', 'Tab', 'Enter']) {
      fire(document, 'keydown', { key })
    }
    fire(document, 'keydown', { key: 'a', ctrlKey: true })
    expect(hide).not.toHaveBeenCalled()
    for (const key of ['Escape', 'Backspace', 'Delete', 'a']) {
      fire(document, 'keydown', { key })
    }
    expect(hide).toHaveBeenCalledTimes(4)
    off()
  })

  it('the release unbinds everything', () => {
    const hide = vi.fn()
    bindHoverCardDismissals(hide)()
    fire(document, 'pointerdown')
    fire(document, 'keydown', { key: 'Escape' })
    fire(window, 'blur')
    expect(hide).not.toHaveBeenCalled()
  })
})
