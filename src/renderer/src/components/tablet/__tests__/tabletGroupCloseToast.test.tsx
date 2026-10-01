// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TOUCH_GROUP_DEFAULT_NAME } from '@shared/groupNames'
import type { ClosedEntrySummary, Events, Folder, Space, Tab, UIState } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'

/*
 * The tablet's Close Group toast (TAB-16 / TAB-13, the Design Lead's option C: Undo for Close on
 * both touch hosts): the sidebar group row's hold menu's "Close Group (N Tabs)" has the core emit
 * `folder.closeUndoable`, and the chrome (`useMainEvents`) runs the phone's undoable close for
 * the group's live members. Rendered for real in happy-dom through `TabletShell` – its
 * `MessageLayer` seating the toast slot in the frame dialog host's seat (`useFrameToastSeat`),
 * the children that carry none of it stubbed: the toast that follows the core's filing is the
 * frame seat's one card, "<Name> tab group closed and saved" with Undo on §9.33's Undo clock
 * (`TOAST_UNDO_MS`, the close family's one clock in lib/closeUndo.ts), drawn once in the
 * document (not in the sidebar's well, not in the message frame's banner stack); Undo restores
 * the entries newest first through `session.restoreClosed` – the core putting each back into the
 * group, whose record the saved group kept – and activates the user's tab. A group still wearing
 * a default name (`isDefaultGroupName`, the shared module) is not called by it: "Tab group closed
 * and saved" (the Lead's addendum).
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// --- the core: the bridge the chrome and its undo speak over -----------------------------------

/** The recently closed list, newest first; a restore takes its entry off and says so. */
let closed: ClosedEntrySummary[] = []
const listeners = new Map<string, Set<(payload: unknown) => void>>()
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name, args) => {
  if (name === 'session.recentlyClosed') return [...closed]
  if (name === 'session.restoreClosed') {
    const { id } = args as { id: string }
    closed = closed.filter((e) => e.id !== id)
    fire('session.recentlyClosedChanged', undefined)
  }
  return null
})
const on = (name: string, listener: (payload: unknown) => void): (() => void) => {
  const set = listeners.get(name) ?? new Set()
  listeners.set(name, set)
  set.add(listener)
  return () => void set.delete(listener)
}
function fire<K extends keyof Events>(name: K, payload: Events[K]): void {
  for (const listener of listeners.get(name) ?? []) listener(payload)
}
Object.assign(window, { zen: { invoke, on } })

// --- the tablet shell's stubs: the parts that carry none of the toast ---------------------------

const stub = (name: string): (() => ReactElement) => {
  const Stub = (): ReactElement => createElement('div', { [`data-${name}-stub`]: '' })
  Stub.displayName = `${name}Stub`
  return Stub
}
vi.mock('@renderer/components/sidebar/Sidebar', async () => {
  const { SidebarBottom } = await import('@renderer/components/sidebar/SidebarBottom')
  return {
    Sidebar: ({ state, isDark }: { state: UIState; isDark: boolean }) =>
      createElement(
        'div',
        { 'data-sidebar': '' },
        createElement(SidebarBottom, { state, compact: false, isDark })
      )
  }
})
vi.mock('@renderer/components/tablet/TabletToolbar', () => ({ TabletToolbar: stub('toolbar') }))
vi.mock('@renderer/components/content/ContentArea', () => ({ ContentArea: stub('page') }))
vi.mock('@renderer/components/DragLayer', () => ({
  ChromeDropLayer: stub('drop'),
  DragLayer: stub('drag')
}))
vi.mock('@renderer/components/ModStyles', () => ({ ModStyles: () => null }))
vi.mock('@renderer/components/overlays/Onboarding', () => ({ Onboarding: stub('onboarding') }))
vi.mock('@renderer/components/phone/PhoneStage', () => ({ PhoneStage: stub('stage') }))
vi.mock('@renderer/components/phone/SpacesDrawer', () => ({ SpacesDrawer: stub('spaces') }))
vi.mock('@renderer/components/phone/useFullscreenReturn', () => ({
  useFullscreenReturn: () => undefined
}))
vi.mock('@renderer/components/urlbar/Urlbar', () => ({ Urlbar: stub('urlbar') }))
vi.mock('@renderer/components/TabDialogs', async () => {
  const { FrameDialogHost } = await import('@renderer/lib/portals')
  return { TabDialogs: () => createElement(FrameDialogHost, { frame: true }) }
})

const { useMainEvents } = await import('@renderer/hooks/useMainEvents')
const { TOAST_ACTION_DURATION, browserStore, uiStore } = await import('@renderer/lib/ui')
const { TOAST_UNDO_MS } = await import('@shared/toastCard')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { CLOSE_SETTLE_MS } = await import('@renderer/lib/closeUndo')
const { TabletShell } = await import('../TabletShell')

/** The chrome's wiring to the core's events, as `App` mounts it. */
function Wired(): null {
  useMainEvents()
  return null
}

// --- a profile ---------------------------------------------------------------------------------

const NOW = 1_700_000_000_000
const SPACE = 'space'
const GROUP = 'folder_research'

function tab(id: string, patch: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: SPACE,
    containerId: 'default',
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
    ...patch
  } as Tab
}

/** Research: Alpha and Beta live in it, a private tab attached; Home loose and active. */
function tabletState(name = 'Research'): UIState {
  const tabs = [
    tab('home'),
    tab('alpha', { folderId: GROUP }),
    tab('beta', { folderId: GROUP }),
    tab('ghost', { folderId: GROUP, containerId: PRIVATE_CONTAINER_ID })
  ]
  const space: Space = {
    id: SPACE,
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId: 'home',
    pinnedCollapsed: false
  }
  const folder = {
    id: GROUP,
    spaceId: SPACE,
    name,
    icon: '📁',
    collapsed: false,
    color: 'blue'
  } as Folder
  return {
    platform: 'android',
    capabilities: { windowControls: false },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [space],
    activeSpaceId: SPACE,
    folders: { [GROUP]: folder },
    essentialTabIds: [],
    agents: [],
    awayAgents: [],
    containers: [],
    settings: {
      colorScheme: 'light',
      sidebarSide: 'left',
      sidebarExpanded: true,
      phoneBarPosition: 'bottom',
      pinnedCloseBehavior: 'unload',
      containerSpecificEssentials: false,
      onboardingDone: true
    },
    window: { kind: 'normal', chrome: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    mods: [],
    boosts: [],
    extensions: [],
    bookmarks: [],
    recentlyClosed: [],
    closingTabIds: [],
    permissionRules: [],
    sync: { enabled: false, scope: { openTabs: false } }
  } as unknown as UIState
}

function entry(t: Tab, closedAt: number): ClosedEntrySummary {
  return {
    id: `closed:${t.id}`,
    kind: 'tab',
    title: t.title,
    url: t.url,
    favicon: null,
    closedAt,
    tabCount: 1
  }
}

/** The core files `entries` (oldest first) and says the list changed. */
function file(...entries: ClosedEntrySummary[]): void {
  for (const e of entries) closed = [e, ...closed]
  fire('session.recentlyClosedChanged', undefined)
}

/** The async work between the event and the toast: the list read and its attribution. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

// --- the harness --------------------------------------------------------------------------------

let root: Root | null = null
let mount: HTMLDivElement | null = null

function mountTablet(state: UIState): void {
  act(() => browserStore.set({ state }))
  mount = document.createElement('div')
  document.body.appendChild(mount)
  root = createRoot(mount)
  act(() =>
    root!.render(
      createElement(
        'div',
        null,
        createElement(Wired),
        createElement(TabletShell, { state, ui: uiStore.get(), isDark: false })
      )
    )
  )
  invoke.mockClear()
}

const seat = (): HTMLElement | null => document.querySelector<HTMLElement>('.zen-frame-toast-seat')
/** The layer's slot on the frame, seated inside the host's seat element. */
const layerSlot = (): HTMLElement | null =>
  seat()?.querySelector<HTMLElement>('.zen-message-layer > .zen-message-toasts') ?? null
const card = (): HTMLElement | null =>
  layerSlot()?.querySelector<HTMLElement>('.zen-message-toast[role="status"]') ?? null
const undo = (): HTMLButtonElement | null =>
  card()?.querySelector<HTMLButtonElement>('button.zen-message-button') ?? null
/** Every drawing of a toast in the document – a card or a plain row: one per act (§9.33). */
const drawings = (): number =>
  document.querySelectorAll('.zen-message-toast[role="status"], .zen-toast[role="status"]').length
/** The chrome's housekeeping on a state change (the thumbnails) and the undo's list reads, left out. */
const CHASSIS = new Set(['session.recentlyClosed', 'thumbnail.configure', 'thumbnail.sweep'])
const commands = (): Array<[string, unknown]> =>
  invoke.mock.calls
    .filter(([name]) => !CHASSIS.has(name))
    .map(([name, args]) => [name, args] as [string, unknown])
const of = (name: string): unknown[] =>
  invoke.mock.calls.filter(([n]) => n === name).map(([, args]) => args)

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  })
  vi.setSystemTime(NOW)
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  })) as unknown as typeof window.matchMedia
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 44
  })
  // The list starts empty and the app's undo hears so (its claims from a past test let go).
  closed = []
  fire('session.recentlyClosedChanged', undefined)
  await flush()
  uiStore.set({ toasts: [], banners: [], screenshotCards: [], frameDialogsOpen: 0 })
  viewportStore.set({ formFactor: 'tablet', width: 1280, height: 800, coarse: true, hover: false })
})

afterEach(async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + TOAST_UNDO_MS + 1000)
  })
  act(() => root?.unmount())
  root = null
  mount?.remove()
  mount = null
  uiStore.set({ toasts: [], banners: [], screenshotCards: [], frameDialogsOpen: 0 })
  browserStore.set({ state: null })
  viewportStore.set({
    formFactor: 'desktop',
    width: 1600,
    height: 1000,
    coarse: false,
    hover: true
  })
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight
  vi.useRealTimers()
})

describe('the tablet’s Close Group toast in the frame seat (TAB-16, option C)', () => {
  it('folder.closeUndoable runs folder.close at once; the toast lands in the frame seat as the one card, "<Name> tab group closed and saved" with Undo on the close toast’s clock', async () => {
    mountTablet(tabletState())
    // The host's seat stands from the start; the layer draws nothing until a card is up.
    expect(seat()).not.toBeNull()
    expect(layerSlot()).toBeNull()
    expect(drawings()).toBe(0)
    act(() => fire('folder.closeUndoable', { folderId: GROUP }))
    // The core's close at once – the group stays, saved with the pages; the toast waits for the
    // core's filing.
    expect(commands()).toEqual([['folder.close', { folderId: GROUP }]])
    expect(layerSlot()).toBeNull()
    // The core files the two regular members (the private one closes to no entry, and was none
    // of the count: the toast comes with these two, no settle wait for a third).
    file(entry(tab('alpha'), NOW), entry(tab('beta'), NOW))
    await flush()
    const toast = uiStore.get().toasts[0]!
    expect(toast.message).toBe('Research tab group closed and saved')
    expect(toast.action?.label).toBe('Undo')
    expect(toast.seat).toBe('frame')
    // §9.33's Undo clock by the shared constant, not the action default by omission.
    expect(toast.duration).toBe(TOAST_UNDO_MS)
    expect(TOAST_UNDO_MS).toBeGreaterThan(TOAST_ACTION_DURATION)
    // Drawn once, in the frame seat's slot: not in the sidebar's well, not in the message frame.
    expect(layerSlot()).not.toBeNull()
    expect(card()?.textContent).toContain('Research tab group closed and saved')
    expect(seat()!.contains(card())).toBe(true)
    expect(undo()?.textContent).toBe('Undo')
    expect(drawings()).toBe(1)
    expect(document.querySelector('.zen-message-well')).toBeNull()
    expect(document.querySelector('.zen-tablet-message-frame .zen-message-toast')).toBeNull()
    expect(document.querySelectorAll('button.zen-message-button')).toHaveLength(1)
    // Undo by touch: the entries restored newest first – each back into the group, whose record
    // the saved group kept – then the user's tab; the card leaves in the seat.
    act(() => undo()!.click())
    await flush()
    expect(of('session.restoreClosed')).toEqual([{ id: 'closed:beta' }, { id: 'closed:alpha' }])
    expect(of('tab.activate')).toEqual([{ tabId: 'home' }])
    expect(uiStore.get().toasts[0]?.leaving).toBe(true)
  })

  it('a group still wearing the default name is not called by it: "Tab group closed and saved" (the Lead’s addendum; the name read through the shared module)', async () => {
    mountTablet(tabletState(TOUCH_GROUP_DEFAULT_NAME))
    act(() => fire('folder.closeUndoable', { folderId: GROUP }))
    file(entry(tab('alpha'), NOW), entry(tab('beta'), NOW))
    await flush()
    expect(card()?.textContent).toContain('Tab group closed and saved')
    expect(uiStore.get().toasts[0]?.message).toBe('Tab group closed and saved')
    expect(drawings()).toBe(1)
  })

  it('left alone, the toast leaves with its clock and the seat holds nothing', async () => {
    mountTablet(tabletState())
    act(() => fire('folder.closeUndoable', { folderId: GROUP }))
    file(entry(tab('alpha'), NOW), entry(tab('beta'), NOW))
    await flush()
    expect(card()).not.toBeNull()
    // Past the plain action toast's clock it still stands: the Undo clock is the longer one.
    act(() => vi.advanceTimersByTime(TOAST_ACTION_DURATION))
    expect(uiStore.get().toasts).toHaveLength(1)
    expect(uiStore.get().toasts[0]?.leaving).toBeUndefined()
    act(() => vi.advanceTimersByTime(TOAST_UNDO_MS - TOAST_ACTION_DURATION - 1))
    expect(uiStore.get().toasts[0]?.leaving).toBeUndefined()
    act(() => vi.advanceTimersByTime(1))
    expect(uiStore.get().toasts[0]?.leaving).toBe(true)
    expect(card()?.dataset.leaving).toBe('')
    expect(of('session.restoreClosed')).toEqual([])
    // The card is gone after its exit, the seat holding nothing; the group's pages stayed saved.
    act(() => vi.advanceTimersByTime(1000))
    expect(uiStore.get().toasts).toHaveLength(0)
    expect(layerSlot()).toBeNull()
    expect(drawings()).toBe(0)
    expect(commands()).toEqual([['folder.close', { folderId: GROUP }]])
  })
})
