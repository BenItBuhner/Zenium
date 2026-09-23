// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MediaState, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_CONTAINER_ID, PRIVATE_CONTAINER_ID } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { run } from '@renderer/lib/api'
import { viewportStore } from '@renderer/lib/formFactor'
import { privateLockStore, resetPrivateLock } from '@renderer/lib/privateLock'
import { browserStore, uiStore } from '@renderer/lib/ui'
import { PANE_FADE_MS } from '../../phone/PaneSlot'
import { Sidebar } from '../Sidebar'

/*
 * PRIVATE-BROWSING LEAK, the tablet sidebar (W4-11; the project-context rule): since #273 the
 * tablet's sidebar listed the space's PRIVATE tabs as rows – their titles and favicons – beside
 * the regular ones, on the regular surface, with no lock state of their own. The fix is the
 * sidebar's two POSES, following the tab in view as the phone's chrome does (`privateTabs.ts`):
 * the REGULAR pose lists the space's regular tabs and never a private one – no row, no title,
 * no count, no hint that any exists – and the PRIVATE pose, on while a private tab is in view
 * (the window on the private theme, §9.29 / §11.6), lists the private session's tabs alone,
 * across the spaces in the Private pane's order, under the mask's header, with New Private Tab
 * as its row. Under the lock (#250) the private pose's rows read "Private tab" behind the mask
 * and lie inert under the lock cover's veil; the regular pose is not covered (the phone's Tabs
 * pane under the lock). The desktop's sidebar and a private window's are untouched.
 */

const css = readFileSync(resolve(__dirname, '../../../assets/main.css'), 'utf8')

/** The text of the first `selector {` rule in the stylesheet. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, selector).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 'work',
    containerId: DEFAULT_CONTAINER_ID,
    url: `https://${id}.example/`,
    title: `${id.toUpperCase()} PAGE`,
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

const secret = (id: string, over: Partial<Tab> = {}): Tab =>
  tab(id, { containerId: PRIVATE_CONTAINER_ID, url: `https://${id}.secret/`, ...over })

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

interface Scene {
  /** The tabs of the space `work`, in order; a second space `play` takes `playTabs`. */
  tabs: Tab[]
  playTabs?: Tab[]
  /** The tab in view (of `work`); the space's first tab by default. */
  active?: string
  formFactor?: 'tablet' | 'desktop'
  windowKind?: 'synced' | 'private'
  privateTabs?: boolean
  media?: MediaState[]
  compact?: boolean
}

/**
 * The sidebar with the spaces' tabs; re-rendered with new state by the next call. The layout is
 * set after the browser store: the viewport re-derives itself from the window (a desktop's, in
 * happy-dom) whenever that store changes.
 */
function sidebar({
  tabs,
  playTabs = [],
  active = tabs[0]?.id,
  formFactor = 'tablet',
  windowKind = 'synced',
  privateTabs = true,
  media = [],
  compact = false
}: Scene): UIState {
  const space = (id: string, name: string, list: Tab[], activeTabId: string | null): Space =>
    ({
      id,
      name,
      icon: '',
      containerId: DEFAULT_CONTAINER_ID,
      theme: null,
      tabIds: list.map((t) => t.id),
      activeTabId,
      pinnedCollapsed: false
    }) as Space
  const spaces = [space('work', 'Work', tabs, active ?? null)]
  if (playTabs.length) spaces.push(space('play', 'Play', playTabs, playTabs[0].id))
  const all = [...tabs, ...playTabs.map((t) => ({ ...t, spaceId: 'play' }))]
  const state = {
    platform: 'android',
    window: { kind: windowKind, fullscreen: false, htmlFullscreenTabId: null, chrome: 'full' },
    capabilities: { privateTabs, windowControls: false, windowControlsOverlay: false },
    tabs: Object.fromEntries(all.map((t) => [t.id, t])),
    spaces,
    activeSpaceId: 'work',
    folders: {},
    liveFolders: {},
    splitGroups: {},
    essentialTabIds: [],
    foreignTabIds: [],
    agents: [],
    containers: [],
    media,
    mods: [],
    settings: {
      showTabSeparator: false,
      sidebarExpanded: !compact,
      sidebarSide: 'left',
      toolbarLayout: 'multiple',
      containerSpecificEssentials: false
    }
  } as unknown as UIState
  browserStore.set({ state })
  const touch = formFactor === 'tablet'
  viewportStore.set({ ...viewportStore.get(), formFactor, coarse: touch, hover: !touch })
  render(<Sidebar state={state} isDark={false} compact={compact} navRow={false} />)
  return state
}

const q = <T extends HTMLElement>(selector: string): T | null => document.querySelector<T>(selector)
const qa = <T extends HTMLElement>(selector: string): T[] => [
  ...document.querySelectorAll<T>(selector)
]
const aside = (): HTMLElement => q<HTMLElement>('aside[aria-label="Sidebar"]')!
const rows = (): string[] => qa('[data-testid="tab"]').map((el) => el.dataset.tabId!)
const titles = (): string[] => qa('[data-testid="tab-title"]').map((el) => el.textContent ?? '')
const text = (): string => aside().textContent ?? ''
const newTabRow = (): HTMLElement => q<HTMLElement>('[data-new-tab]')!

beforeEach(() => {
  resetPrivateLock()
  uiStore.set({ drag: null, selectedTabIds: [], renamingTabId: null })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  mount?.remove()
  mount = null
  resetPrivateLock()
  vi.mocked(run).mockClear()
})

const regularScene = (): Tab[] => [
  tab('home'),
  secret('bank'),
  tab('docs', { pinned: true }),
  secret('mail'),
  tab('news')
]

describe('the private-browsing leak: the tablet sidebar in its regular pose', () => {
  it('lists no private tab – no row, no title, no count, no hint – while a regular tab is in view', () => {
    sidebar({ tabs: regularScene(), active: 'home' })
    expect(aside().dataset.pose).toBe('regular')
    expect(rows()).toEqual(['docs', 'home', 'news'])
    expect(titles()).toEqual(['DOCS PAGE', 'HOME PAGE', 'NEWS PAGE'])
    for (const word of ['BANK', 'MAIL', 'secret', 'Private'])
      expect(text(), `${word} in the regular sidebar`).not.toContain(word)
    expect(q('[data-testid="sidebar-private-header"]')).toBeNull()
    expect(q('[data-tab-list="private"]')).toBeNull()
    expect(newTabRow().textContent).toBe('New Tab')
  })

  it('stays the regular pose whichever regular tab is in view, and lists no private tab of another space either', () => {
    sidebar({ tabs: regularScene(), playTabs: [tab('game'), secret('diary')], active: 'news' })
    expect(aside().dataset.pose).toBe('regular')
    expect(text()).not.toContain('BANK')
    expect(text()).not.toContain('DIARY')
    expect(text()).not.toContain('MAIL')
    // The other space's panel is off to the side, its own rows regular alone.
    expect(rows()).toEqual(['docs', 'home', 'news', 'game'])
  })

  it('lists no private tab’s media player at its foot on the regular pose', () => {
    const media = (tabId: string, priv: boolean): MediaState =>
      ({
        tabId,
        playing: true,
        private: priv,
        title: priv ? '' : 'Regular song',
        artist: '',
        album: '',
        artwork: null
      }) as unknown as MediaState
    sidebar({
      tabs: regularScene(),
      active: 'home',
      media: [media('bank', true), media('news', false)]
    })
    expect(text()).not.toContain('BANK')
    expect(text()).toContain('NEWS PAGE')
  })

  it('is not covered by the lock: the regular tabs stay usable, and still no private row', () => {
    sidebar({ tabs: regularScene(), active: 'home' })
    act(() => privateLockStore.set({ locked: true }))
    expect(aside().dataset.pose).toBe('regular')
    expect(q('[data-testid="private-lock-cover"]')).toBeNull()
    expect(rows()).toEqual(['docs', 'home', 'news'])
    expect(text()).not.toContain('BANK')
    expect(text()).not.toContain('Private tab')
  })
})

describe('the private pose: a private tab in view', () => {
  it('lists the private session’s tabs alone, across the spaces, under the mask’s header, with New Private Tab as its row', () => {
    sidebar({
      tabs: regularScene(),
      playTabs: [tab('game'), secret('diary')],
      active: 'bank'
    })
    expect(aside().dataset.pose).toBe('private')
    const header = q<HTMLElement>('[data-testid="sidebar-private-header"]')!
    expect(header.textContent).toContain('Private')
    expect(header.textContent).toContain('3')
    expect(header.querySelector('svg.lucide-venetian-mask')).not.toBeNull()
    // The Private pane's order: the spaces in their order, each space's private tabs in theirs.
    expect(rows()).toEqual(['bank', 'mail', 'diary'])
    expect(titles()).toEqual(['BANK PAGE', 'MAIL PAGE', 'DIARY PAGE'])
    for (const word of ['HOME', 'DOCS', 'NEWS', 'GAME', 'Work', 'Play'])
      expect(text(), `${word} on the private pose`).not.toContain(word)
    const list = q<HTMLElement>('[data-tab-list="private"]')!
    expect(list.getAttribute('role')).toBe('tablist')
    expect(list.getAttribute('aria-label')).toBe('Private tabs')
    expect(q('[data-testid="tab"][data-active="true"]')?.dataset.tabId).toBe('bank')
    // No Essentials, no spaces row: the private session is one across the spaces (the phone's
    // Private pane shows no space strip either), and nothing of the workspaces shows on it.
    expect(q('[data-testid="essentials"]')).toBeNull()
    expect(q('[title="New Space"]')).toBeNull()
    expect(q('[title="Change theme"]')).toBeNull()
    // New Private Tab: the Plus row asking for a tab of the private container.
    expect(newTabRow().textContent).toBe('New Private Tab')
    const heard: Array<CustomEvent<{ containerId?: string }>> = []
    const listener = (e: Event): void => {
      heard.push(e as CustomEvent<{ containerId?: string }>)
    }
    window.addEventListener('zen-new-tab', listener)
    act(() => newTabRow().click())
    window.removeEventListener('zen-new-tab', listener)
    expect(heard.map((e) => e.detail?.containerId)).toEqual([PRIVATE_CONTAINER_ID])
  })

  it('keeps New Private Tab in view however long the list: the row stands in the column’s foot, outside the rows’ scroller (tabs-28)', () => {
    sidebar({ tabs: regularScene(), active: 'bank' })
    const scroller = q<HTMLElement>('[data-tab-scroller][data-active="true"]')!
    expect(scroller).not.toBeNull()
    expect(scroller.dataset.fadeAxis).toBe('y')
    expect(scroller.contains(newTabRow())).toBe(false)
    const foot = newTabRow().closest<HTMLElement>('[data-strip-foot]')!
    expect(foot).not.toBeNull()
    expect(foot.classList.contains('zen-list-foot')).toBe(true)
    expect(scroller.nextElementSibling).toBe(foot)
    // One column holds them both: the veil's `inert` lands on it (the lock's test below).
    expect(scroller.parentElement).toBe(foot.parentElement)
    expect(scroller.parentElement?.hasAttribute('data-tab-panel')).toBe(true)
  })

  it('returns to the regular pose as a regular tab comes into view, the private rows gone with it', () => {
    // No Web Animations API: the still leaves on its timer (the overview's own fallback).
    const proto = HTMLElement.prototype as { animate?: unknown }
    const had = proto.animate
    proto.animate = undefined
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // The window on the private theme while the private pose stands (`useTheme` paints the
    // root's `data-theme`; the private surface is dark whatever the scheme).
    document.documentElement.dataset.theme = 'dark'
    try {
      sidebar({ tabs: regularScene(), active: 'bank' })
      expect(aside().dataset.pose).toBe('private')
      sidebar({ tabs: regularScene(), active: 'home' })
      expect(aside().dataset.pose).toBe('regular')
      expect(rows()).toEqual(['docs', 'home', 'news'])
      // The pose that left fades over the slot as the overview's pane does (§11.4): its still,
      // a copy of its DOM out of reach of the reader and of touch, no row of the strip and no
      // hook of anything (nothing finds a private row in it), drawn for the 120 ms the new
      // pose takes to come up on its own fade, then gone with its titles.
      const still = q<HTMLElement>('[data-testid="pane-still"]')!
      expect(still).not.toBeNull()
      expect(still.getAttribute('aria-hidden')).toBe('true')
      expect(still.hasAttribute('inert')).toBe(true)
      expect(
        still.querySelector(
          '[data-testid], [data-strip-item], [data-tab-id], [data-tab-list], [data-new-tab], [data-tab-scroller], [data-drop]'
        )
      ).toBeNull()
      expect(q('.zen-sidebar-pose')?.hasAttribute('data-switching')).toBe(true)
      // The still is a picture of the private pose under the polarity it left in – the private
      // theme's – and is not drawn once the window has flipped to the scheme's at the blend's
      // midpoint (§11.6 cuts the ink there): never the private titles in the regular ink, on a
      // slow frame or under reduced motion's cut.
      expect(still.classList.contains('zen-pane-still')).toBe(true)
      expect(still.dataset.stillTheme).toBe('dark')
      expect(rule(":root[data-theme='dark'] .zen-pane-still[data-still-theme='light']")).toContain(
        'visibility: hidden'
      )
      expect(css).toContain(":root[data-theme='light'] .zen-pane-still[data-still-theme='dark'],")
      act(() => vi.advanceTimersByTime(PANE_FADE_MS))
      expect(q('[data-testid="pane-still"]')).toBeNull()
      expect(q('.zen-sidebar-pose')?.hasAttribute('data-switching')).toBe(false)
      expect(text()).not.toContain('BANK')
      expect(text()).not.toContain('Private')
    } finally {
      vi.useRealTimers()
      proto.animate = had
      delete document.documentElement.dataset.theme
    }
  })

  it('under the lock: the rows read "Private tab" behind the mask, the list lies inert under the veil, and no second Unlock', () => {
    sidebar({ tabs: regularScene(), active: 'bank' })
    act(() => privateLockStore.set({ locked: true }))
    expect(aside().dataset.pose).toBe('private')
    const cover = q<HTMLElement>('[data-testid="private-lock-cover"]')!
    expect(cover).not.toBeNull()
    expect(cover.dataset.variant).toBe('veil')
    expect(cover.querySelector('[data-testid="private-lock-unlock"]')).toBeNull()
    expect(cover.querySelector('.zen-private-lock-veil')).not.toBeNull()
    expect(cover.querySelector('.zen-private-lock-block')).toBeNull()
    // The list and its New Private Tab lie under the veil together: their scroller is inert and
    // out of the accessibility tree until the cover lifts.
    const list = q<HTMLElement>('[data-tab-list="private"]')!
    const covered = list.closest<HTMLElement>('[inert]')!
    expect(covered).not.toBeNull()
    expect(covered.getAttribute('aria-hidden')).toBe('true')
    expect(covered.contains(newTabRow())).toBe(true)
    expect(titles()).toEqual(['Private tab', 'Private tab'])
    for (const row of qa('[data-testid="tab"]')) {
      expect(row.getAttribute('aria-label')).toBe('Private tab')
      expect(row.dataset.masked).toBe('true')
      expect(row.querySelector('svg.lucide-venetian-mask')).not.toBeNull()
      // Nothing of the page in the row's slots either: no favicon, no close, no state.
      expect(row.querySelector('img, .zen-tab-close, button')).toBeNull()
    }
    expect(text()).not.toContain('BANK')
    expect(text()).not.toContain('MAIL')
    expect(text()).not.toContain('secret')
    // The header stays, the count with it: a count is no identity (the pill's).
    expect(q('[data-testid="sidebar-private-header"]')?.textContent).toContain('2')
    // The veil alone: no opaque panel under it – the rows are masked already – and the veil in
    // the window's tone, lifting on the cover's own spring with the frame's cover.
    expect(rule(".zen-private-lock[data-variant='veil']")).toContain('background: transparent')
  })

  it('lifts the veil with the lock: the rows read their titles again once the cover has gone', () => {
    sidebar({ tabs: regularScene(), active: 'bank' })
    act(() => privateLockStore.set({ locked: true }))
    act(() => privateLockStore.set({ locked: false }))
    expect(titles()).toEqual(['BANK PAGE', 'MAIL PAGE'])
    expect(q('[data-tab-list="private"]')?.closest('[inert]')).toBeNull()
    expect(q('[data-testid="tab"][data-masked]')).toBeNull()
  })

  it('keeps the rows masked while the lift runs, the veil still over them, until the cover lands', () => {
    // The host released the lock with the cover up over the private tab in front: the frame's
    // cover lifts on its spring and the sidebar's veil with it (`lifting`, `privateLock.ts`),
    // the rows behind the mask until it lands.
    sidebar({ tabs: regularScene(), active: 'bank' })
    act(() => privateLockStore.set({ locked: true }))
    act(() => privateLockStore.set({ locked: false, lifting: true }))
    expect(titles()).toEqual(['Private tab', 'Private tab'])
    expect(q('[data-tab-list="private"]')?.closest('[inert]')).not.toBeNull()
    expect(q('[data-testid="private-lock-cover"]')?.dataset.leaving).toBe('true')
    // The wait ends before the veil's spring lands – `LIFT_MAX_MS` on a device drawing a frame
    // every 100 ms or more, or the frame's cover landing a frame first: the veil goes with the
    // wait, in the flush that brings the titles back, so no frame shows a title under it.
    act(() => privateLockStore.set({ lifting: false }))
    expect(titles()).toEqual(['BANK PAGE', 'MAIL PAGE'])
    expect(q('[data-tab-list="private"]')?.closest('[inert]')).toBeNull()
    expect(q('[data-testid="private-lock-cover"]')).toBeNull()
  })

  it('in the rail shows the mask alone for the header and the rows’ favicons masked under the lock', () => {
    sidebar({ tabs: regularScene(), active: 'bank', compact: true })
    const header = q<HTMLElement>('[data-testid="sidebar-private-header"]')!
    expect(header.textContent?.trim()).toBe('')
    expect(header.querySelector('svg.lucide-venetian-mask')).not.toBeNull()
    expect(rows()).toEqual(['bank', 'mail'])
    act(() => privateLockStore.set({ locked: true }))
    for (const row of qa('[data-testid="tab"]')) {
      expect(row.querySelector('svg.lucide-venetian-mask')).not.toBeNull()
      expect(row.querySelector('img')).toBeNull()
    }
  })
})

describe('the desktop and a private window keep their sidebar', () => {
  it('desktop: a host without private tabs shows the regular list as it was', () => {
    sidebar({ tabs: [tab('home'), tab('news')], formFactor: 'desktop', privateTabs: false })
    expect(aside().dataset.pose).toBe('regular')
    expect(rows()).toEqual(['home', 'news'])
    expect(q('[data-testid="sidebar-private-header"]')).toBeNull()
  })

  it('a private window lists its own tabs whole with its own header, no pose', () => {
    sidebar({
      tabs: [secret('bank'), secret('mail')],
      active: 'bank',
      formFactor: 'desktop',
      windowKind: 'private',
      privateTabs: false
    })
    expect(aside().dataset.pose).toBe('regular')
    expect(rows()).toEqual(['bank', 'mail'])
    expect(text()).toContain('Private Browsing')
    expect(q('[data-testid="sidebar-private-header"]')).toBeNull()
  })
})
