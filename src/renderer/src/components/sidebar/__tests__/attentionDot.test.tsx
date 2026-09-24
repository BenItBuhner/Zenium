// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Space, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID } from '@shared/types'

/*
 * The attention dot on a pinned tab (tabs-11): a pinned row's favicon, and an Essentials tile's,
 * sits in a seat that wears a 6 px accent dot at the icon's top-right corner while the tab's
 * `attention` flag stands – Chrome's seat, the dot's edges 1 px outside the icon's box, the
 * icon punched out around it. A regular row shows no seat (its title tells), and the row's
 * description says the word for a screen reader.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<null>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

const { browserStore, HOVER_CARD_HIDDEN, uiStore } = await import('@renderer/lib/ui')
const { defaultShortcuts } = await import('@shared/shortcuts')
const { tabRowStates } = await import('@renderer/lib/tabRowAria')
const { SpacePanel } = await import('../SpacePanel')
const { Essentials } = await import('../Essentials')

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')

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

function fixture(tabs: Tab[], activeTabId = tabs[0]?.id ?? null): { state: UIState; space: Space } {
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

function panel(tabs: Tab[], activeTabId?: string): void {
  const { state, space } = fixture(tabs, activeTabId ?? tabs[0]?.id ?? null)
  browserStore.set({ state })
  render(<SpacePanel state={state} space={space} isActive compact={false} />)
}

afterEach(() => {
  act(() => root?.unmount())
  mount?.remove()
  root = null
  mount = null
  uiStore.set({ hoverCard: HOVER_CARD_HIDDEN, renamingTabId: null, stripFocus: null })
})

const row = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${id}"]`)
  if (!el) throw new Error(`missing row ${id}`)
  return el
}
const describedBy = (el: HTMLElement): string[] =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? `#${id}`)

describe('the attention dot on a pinned row', () => {
  it('wears the dot on the favicon seat while the flag stands, and says so', () => {
    panel([tab('front'), tab('mail', { pinned: true, attention: true })], 'front')
    const mail = row('mail')
    const seat = mail.querySelector<HTMLElement>('.zen-favicon-seat')
    expect(seat).not.toBeNull()
    expect(seat!.dataset.attention).toBe('true')
    const dot = seat!.querySelector<HTMLElement>('.zen-attention-dot')
    expect(dot).not.toBeNull()
    expect(dot!.getAttribute('aria-hidden')).toBe('true')
    // The icon itself sits inside the seat, so the dot is at its corner and not the row's.
    expect(seat!.querySelector('.zen-tab-favicon')).not.toBeNull()
    expect(describedBy(mail)).toEqual(['updated in the background, pinned'])
  })

  it('shows a bare seat on a pinned row without the flag', () => {
    panel([tab('front'), tab('mail', { pinned: true })], 'front')
    const seat = row('mail').querySelector<HTMLElement>('.zen-favicon-seat')
    expect(seat).not.toBeNull()
    expect(seat!.dataset.attention).toBeUndefined()
    expect(seat!.querySelector('.zen-attention-dot')).toBeNull()
    expect(describedBy(row('mail'))).toEqual(['pinned'])
  })

  it('never seats a regular row: its title is its own telling', () => {
    panel([tab('front'), tab('news')], 'front')
    expect(row('news').querySelector('.zen-favicon-seat')).toBeNull()
    expect(row('news').querySelector('.zen-tab-favicon')).not.toBeNull()
  })

  it('wears the dot on an Essentials tile too', () => {
    const essential = tab('mail', { essential: true, attention: true })
    render(<Essentials essentials={[essential]} activeTabId={null} compact={false} />)
    const tile = document.querySelector<HTMLElement>('.zen-essential')
    expect(tile).not.toBeNull()
    const seat = tile!.querySelector<HTMLElement>('.zen-favicon-seat[data-attention]')
    expect(seat).not.toBeNull()
    expect(seat!.style.width).toBe('20px')
    expect(seat!.querySelector('.zen-attention-dot')).not.toBeNull()
    expect(tile!.querySelector('[data-essential-audio]')).toBeNull()
  })

  it('yields to the audio disc on an Essentials tile – one disc per icon (§9.29, the lead’s #436 ruling 3): a playing tile draws its audio disc and no dot; muted, the disc goes and the dot draws', () => {
    const playing = tab('radio', { essential: true, attention: true, audible: true })
    const tile = (): HTMLElement => document.querySelector<HTMLElement>('.zen-essential')!
    const seat = (): HTMLElement => tile().querySelector<HTMLElement>('.zen-favicon-seat')!
    render(<Essentials essentials={[playing]} activeTabId={null} compact={false} />)
    // Playing: the tile is marked already, so the seat draws no dot and punches no icon out.
    expect(tile().querySelector('[data-essential-audio]')).not.toBeNull()
    expect(seat()).not.toBeNull()
    expect(seat().dataset.attention).toBeUndefined()
    expect(seat().querySelector('.zen-attention-dot')).toBeNull()
    // Muted: the audio disc goes and the flag – standing all along – draws its dot.
    render(
      <Essentials essentials={[{ ...playing, muted: true }]} activeTabId={null} compact={false} />
    )
    expect(tile().querySelector('[data-essential-audio]')).toBeNull()
    expect(seat().dataset.attention).toBe('true')
    expect(seat().querySelector('.zen-attention-dot')).not.toBeNull()
    // The sound gone (the page stopped): the dot stays for the same reason.
    render(
      <Essentials essentials={[{ ...playing, audible: false }]} activeTabId={null} compact={false} />
    )
    expect(tile().querySelector('[data-essential-audio]')).toBeNull()
    expect(seat().querySelector('.zen-attention-dot')).not.toBeNull()
    // Playing again: the dot yields again.
    render(<Essentials essentials={[playing]} activeTabId={null} compact={false} />)
    expect(tile().querySelector('[data-essential-audio]')).not.toBeNull()
    expect(seat().querySelector('.zen-attention-dot')).toBeNull()
  })

  it('keeps the dot on a pinned row that plays – its audio is a glyph in the trailing slot, not a disc on the icon – and the row’s words carry both states', () => {
    panel([tab('front'), tab('radio', { pinned: true, attention: true, audible: true })], 'front')
    const r = row('radio')
    expect(r.querySelector('.zen-favicon-seat[data-attention] > .zen-attention-dot')).not.toBeNull()
    expect(describedBy(r)).toEqual(['playing, updated in the background, pinned'])
    expect(tabRowStates(tab('radio', { attention: true, audible: true, muted: true }), null)).toEqual([
      'muted',
      'updated in the background'
    ])
  })

  it('draws a 6 px accent disc 1 px outside the icon’s top-right corner, the icon punched out', () => {
    const seat = rule('.zen-favicon-seat')
    expect(seat).toContain('position: relative')
    expect(seat).toContain('flex-shrink: 0')
    const dot = rule('.zen-attention-dot')
    expect(dot).toContain('position: absolute')
    expect(dot).toContain('top: -1px')
    expect(dot).toContain('right: -1px')
    expect(dot).toContain('width: 6px')
    expect(dot).toContain('height: 6px')
    expect(dot).toContain('border-radius: 50%')
    expect(dot).toContain('background: var(--zen-accent)')
    expect(dot).toContain('pointer-events: none')
    // Chrome's ring: the icon is masked out for 1 px around the dot (radius 4 about its centre).
    expect(rule('.zen-favicon-seat[data-attention] > .zen-tab-favicon')).toContain(
      'mask-image: radial-gradient(circle 4px at calc(100% - 2px) 2px, transparent 98%, #000 100%)'
    )
    // The rail flyout's glyph rule knows the seat as a leading glyph, both sides.
    expect(css).toContain(
      '.zen-tab:not(.zen-split-seg)\n    > :is(.zen-tab-favicon, .zen-favicon-seat, .zen-group-row-glyph)'
    )
    expect(
      css.split('> :is(.zen-tab-favicon, .zen-favicon-seat, .zen-group-row-glyph)').length - 1
    ).toBe(2)
  })
})
