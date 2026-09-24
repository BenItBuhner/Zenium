// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Space, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

/*
 * The page preview in the tab hover card (tabs-19, Chrome's tab hover card preview): the
 * hovered background tab's picture above the title, in a 16:10 frame at the card's inner width
 * with the card's radius and a 1 px hairline; only when a picture exists and never for the
 * active tab. The app's controller captures the hovered page fresh before the card shows,
 * beside the active page's cover.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { cmd } = await import('@renderer/lib/api')
const { browserStore, HOVER_CARD_HIDDEN, uiStore } = await import('@renderer/lib/ui')
const { HOVER_CARD_DELAY, hoverCard } = await import('@renderer/lib/hoverCard')
const { rememberThumbnail, resetThumbnails } = await import('@renderer/lib/thumbnails')
const { TabHoverCard } = await import('../TabHoverCard')

const css = readFileSync(resolve(__dirname, '../../assets/main.css'), 'utf8')

function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

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

const PICTURE = 'data:image/jpeg;base64,QUJD'
const box = { x: 0, y: 40, width: 224, height: 36 }
const sidebar = { x: 0, y: 0, width: 240, height: 1000 }

function showCard(tabId: string): void {
  act(() => uiStore.set({ hoverCard: { tabId, anchor: box, sidebar, by: 'pointer' } }))
}

const card = (): HTMLElement | null => document.getElementById('zen-tab-hover-card')

beforeEach(() => {
  resetThumbnails()
})

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  uiStore.set({ hoverCard: HOVER_CARD_HIDDEN })
  resetThumbnails()
  vi.mocked(cmd).mockClear()
  vi.useRealTimers()
})

describe('the page preview in the hover card (tabs-19)', () => {
  it('shows the background tab’s picture above the title when one exists', () => {
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    rememberThumbnail('b', PICTURE)
    render(<TabHoverCard state={state} />)
    showCard('b')
    const el = card()
    expect(el).not.toBeNull()
    expect(el!.dataset.preview).toBe('true')
    const preview = el!.querySelector<HTMLElement>('.zen-tab-hover-card-preview')
    expect(preview).not.toBeNull()
    const img = preview!.querySelector('img')
    expect(img?.getAttribute('src')).toBe(PICTURE)
    // Nothing for a screen reader: the card is the row's description, the picture adds no words.
    expect(img?.getAttribute('alt')).toBe('')
    // Above the title.
    expect(preview!.nextElementSibling?.classList.contains('zen-tab-hover-card-title')).toBe(true)
    expect(el!.querySelector('.zen-tab-hover-card-title')?.textContent).toBe('B')
  })

  it('never previews the active tab: its page is under the card', () => {
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    rememberThumbnail('a', PICTURE)
    render(<TabHoverCard state={state} />)
    showCard('a')
    const el = card()
    expect(el).not.toBeNull()
    expect(el!.dataset.preview).toBeUndefined()
    expect(el!.querySelector('.zen-tab-hover-card-preview')).toBeNull()
    expect(el!.querySelector('.zen-tab-hover-card-title')?.textContent).toBe('A')
  })

  it('shows no frame when the tab has no picture, or is asleep', () => {
    const state = fixture([tab('a'), tab('b'), tab('c', { discarded: true })], 'a')
    browserStore.set({ state })
    rememberThumbnail('c', PICTURE)
    render(<TabHoverCard state={state} />)
    showCard('b')
    expect(card()!.querySelector('.zen-tab-hover-card-preview')).toBeNull()
    showCard('c')
    expect(card()!.querySelector('.zen-tab-hover-card-preview')).toBeNull()
  })

  it('the app’s controller captures the hovered page fresh beside the active page’s cover', async () => {
    vi.useFakeTimers()
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    vi.mocked(cmd).mockImplementation(async (name: string, args?: unknown) => {
      if (name !== 'overlay.snapshot') return null
      const { tabId } = args as { tabId: string }
      return `data:image/jpeg;base64,${tabId}`
    })
    render(<TabHoverCard state={state} />)
    hoverCard.pointerEnter('b', () => ({ anchor: box, sidebar }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_CARD_DELAY)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(cmd).toHaveBeenCalledWith('overlay.snapshot', { tabId: 'a' })
    expect(cmd).toHaveBeenCalledWith('overlay.snapshot', { tabId: 'b', fresh: true })
    expect(uiStore.get().hoverCard.tabId).toBe('b')
    // The hovered page's picture is remembered as its cover, and the card reads it.
    expect(card()).not.toBeNull()
    expect(card()!.querySelector('.zen-tab-hover-card-preview img')?.getAttribute('src')).toBe(
      'data:image/jpeg;base64,b'
    )
    hoverCard.hide()
  })

  it('does not capture the active tab twice when its own row is hovered', async () => {
    vi.useFakeTimers()
    const state = fixture([tab('a'), tab('b')], 'a')
    browserStore.set({ state })
    hoverCard.pointerEnter('a', () => ({ anchor: box, sidebar }))
    await vi.advanceTimersByTimeAsync(HOVER_CARD_DELAY)
    await vi.advanceTimersByTimeAsync(0)
    const snapshots = vi.mocked(cmd).mock.calls.filter(([name]) => name === 'overlay.snapshot')
    expect(snapshots).toEqual([['overlay.snapshot', { tabId: 'a' }]])
    hoverCard.hide()
  })

  it('frames the picture 16:10 at the card’s inner width, the card’s radius, a 1 px hairline', () => {
    const frame = rule('.zen-tab-hover-card-preview')
    // 320 − 2 (border) − 32 (padding) = 286; 286 × 10 / 16 = 178.75 → 179.
    expect(frame).toContain('width: 286px')
    expect(frame).toContain('height: 179px')
    expect(frame).toContain('box-sizing: border-box')
    expect(frame).toContain('margin-bottom: 12px')
    expect(frame).toContain('border-radius: 8px')
    expect(frame).toContain('border: 1px solid var(--v2-border)')
    expect(frame).toContain('overflow: hidden')
    const picture = rule('.zen-tab-hover-card-preview > img')
    expect(picture).toContain('object-fit: cover')
    expect(picture).toContain('object-position: top')
    expect(picture).toContain('width: 100%')
    expect(picture).toContain('height: 100%')
  })
})
