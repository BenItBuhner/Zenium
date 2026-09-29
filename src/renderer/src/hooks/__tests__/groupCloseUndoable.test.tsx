// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ClosedEntrySummary, Events, Folder, Space, Tab, UIState } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { NEW_FOLDER_NAME, TOUCH_GROUP_DEFAULT_NAME } from '@shared/groupNames'

/*
 * The core's `folder.closeUndoable` as `useMainEvents` answers it (TAB-16 / TAB-13, the Design
 * Lead's option C: Undo for Close, a confirmation for Delete, never both): the touch hosts'
 * group menu's "Close Group (N Tabs)" – the tablet sidebar row's hold – asks the chrome for the
 * phone's undoable close. The handler reads the group's LIVE members the way the phone's overview
 * does for its own Close Group (the space's regular tabs in the group; a private one is none of
 * them), runs the core's `folder.close` at once through `lib/closeUndo.ts`, and the toast that
 * follows the core's filing reads "<Name> tab group closed and saved" – "Tab group closed and
 * saved" for a group still wearing a default name (`isDefaultGroupName`, the shared module; the
 * Lead's addendum) – with Undo restoring the tabs newest first (each back INTO
 * the group, whose record the saved group keeps) and the user's tab activated. The desktop never
 * fires the event: its folder menu's Close Folder calls the core's `closeFolder` itself
 * (`savedGroups.test.ts` pins that line), so the handler is inert there by never being reached.
 */

const NOW = 1_700_000_000_000
const SPACE = 'space'
const GROUP = 'g'

/**
 * The core: every command is taken; the recently closed list is `closed`, newest first, and a
 * restore takes its entry off the list and says so, as the real one does.
 */
let closed: ClosedEntrySummary[] = []
const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async (name, args) => {
  if (name === 'session.recentlyClosed') return [...closed]
  if (name === 'session.restoreClosed') {
    const { id } = args as { id: string }
    closed = closed.filter((e) => e.id !== id)
    fire('session.recentlyClosedChanged', undefined)
  }
  return null
})
const listeners = new Map<string, Set<(payload: unknown) => void>>()
const on = (name: string, listener: (payload: unknown) => void): (() => void) => {
  const set = listeners.get(name) ?? new Set()
  listeners.set(name, set)
  set.add(listener)
  return () => void set.delete(listener)
}
const fire = <K extends keyof Events>(name: K, payload: Events[K]): void => {
  for (const listener of listeners.get(name) ?? []) listener(payload)
}
Object.assign(window, { zen: { invoke, on } })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { useMainEvents } = await import('../useMainEvents')
const { browserStore, uiStore } = await import('@renderer/lib/ui')
const { viewportStore } = await import('@renderer/lib/formFactor')
const { CLOSE_SETTLE_MS } = await import('@renderer/lib/closeUndo')

function Wired(): null {
  useMainEvents()
  return null
}

// --- a profile ---------------------------------------------------------------------------------

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

function folder(name: string): Folder {
  return {
    id: GROUP,
    spaceId: SPACE,
    name,
    icon: '📁',
    collapsed: false,
    color: 'blue'
  } as Folder
}

/** `tabs` in track order, `active` the tab the user is on, the one group `group`. */
function stateOf(tabs: Tab[], active: string, group: Folder | null): UIState {
  const space: Space = {
    id: SPACE,
    name: 'Work',
    icon: '',
    containerId: 'default',
    theme: null,
    tabIds: tabs.map((t) => t.id),
    activeTabId: active,
    pinnedCollapsed: false
  }
  return {
    platform: 'android',
    capabilities: { windowControls: false },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])),
    spaces: [space],
    activeSpaceId: SPACE,
    folders: group ? { [group.id]: group } : {},
    essentialTabIds: [],
    containers: [],
    settings: { ...DEFAULT_SETTINGS, pinnedCloseBehavior: 'unload' },
    window: { kind: 'normal', fullscreen: false, htmlFullscreenTabId: null },
    boosts: [],
    extensions: [],
    bookmarks: [],
    recentlyClosed: [],
    closingTabIds: [],
    sync: { enabled: false, scope: { openTabs: false } }
  } as unknown as UIState
}

/** A group of `a` and `b`, a private tab `p` in it too, the loose `c` active. */
const research = (name = 'Research'): UIState =>
  stateOf(
    [
      tab('a', { folderId: GROUP }),
      tab('b', { folderId: GROUP }),
      tab('p', { folderId: GROUP, containerId: PRIVATE_CONTAINER_ID }),
      tab('c')
    ],
    'c',
    folder(name)
  )

/** The entry the core files for `t`, closed at `closedAt`. */
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

/**
 * The commands the handler sent the core, in order; the undo's list reads and the chrome's own
 * housekeeping on a state change (`useMainEvents` configures and sweeps the thumbnails) left out.
 */
const CHASSIS = new Set(['session.recentlyClosed', 'thumbnail.configure', 'thumbnail.sweep'])
const commands = (): Array<[string, unknown]> =>
  invoke.mock.calls
    .filter(([name]) => !CHASSIS.has(name))
    .map(([name, args]) => [name, args] as [string, unknown])
const of = (name: string): unknown[] =>
  invoke.mock.calls.filter(([n]) => n === name).map(([, args]) => args)
const toasts = (): Array<[string, string | undefined]> =>
  uiStore.get().toasts.map((t) => [t.message, t.action?.label])

describe('folder.closeUndoable in the chrome', () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
    })
    vi.setSystemTime(NOW)
    // The list starts empty and the app's undo hears so: an entry a past test claimed and never
    // restored is let go (the entries' ids repeat from test to test).
    closed = []
    fire('session.recentlyClosedChanged', undefined)
    await flush()
    viewportStore.set({ ...viewportStore.get(), formFactor: 'tablet' })
    uiStore.set({ toasts: [] })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root.render(createElement(Wired)))
    invoke.mockClear()
  })

  afterEach(async () => {
    // A close this test issued and never filed settles now, so the app's one undo carries no
    // intent into the next test.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + 1)
    })
    act(() => root.unmount())
    host.remove()
    uiStore.set({ toasts: [] })
    browserStore.set({ state: null })
    viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
    // The hook's own subscriptions went with the unmount; the app's one undo keeps its
    // `session.recentlyClosedChanged` subscription for the whole file, as the app does.
    vi.useRealTimers()
  })

  it('runs the core’s folder.close at once, for the group’s live regular members; the toast reads the group’s words and Undo brings the tabs back newest first', async () => {
    act(() => browserStore.set({ state: research() }))
    act(() => fire('folder.closeUndoable', { folderId: GROUP }))
    // The close went through in the same tick (`folder.close`: the group stays, saved with the
    // pages); nothing is up until the core files the tabs.
    expect(commands()).toEqual([['folder.close', { folderId: GROUP }]])
    expect(toasts()).toEqual([])
    // The core files the two regular members – the private one closes to no entry and was none
    // of the count: the toast comes with these two, no settle wait for a third.
    file(entry(tab('a'), NOW), entry(tab('b'), NOW))
    await flush()
    expect(toasts()).toEqual([['Research tab group closed and saved', 'Undo']])
    // Undo: each entry restored newest first – the core puts each back into the group, whose
    // record the saved group kept – and the user stays on the tab they were on.
    act(() => uiStore.get().toasts[0].action!.onPick())
    await flush()
    expect(of('session.restoreClosed')).toEqual([{ id: 'closed:b' }, { id: 'closed:a' }])
    expect(of('tab.activate')).toEqual([{ tabId: 'c' }])
  })

  it('a group still wearing the default name is not called by it: "Tab group closed and saved" (the Lead’s addendum)', async () => {
    act(() => browserStore.set({ state: research(TOUCH_GROUP_DEFAULT_NAME) }))
    act(() => fire('folder.closeUndoable', { folderId: GROUP }))
    expect(commands()).toEqual([['folder.close', { folderId: GROUP }]])
    file(entry(tab('a'), NOW), entry(tab('b'), NOW))
    await flush()
    expect(toasts()).toEqual([['Tab group closed and saved', 'Undo']])
  })

  it('a group named "New Folder" – a touch group from before the touch hosts had a word of their own – closes to "Tab group closed and saved" too (the Lead’s ruling; no migration)', async () => {
    act(() => browserStore.set({ state: research(NEW_FOLDER_NAME) }))
    act(() => fire('folder.closeUndoable', { folderId: GROUP }))
    expect(commands()).toEqual([['folder.close', { folderId: GROUP }]])
    file(entry(tab('a'), NOW), entry(tab('b'), NOW))
    await flush()
    expect(toasts()).toEqual([['Tab group closed and saved', 'Undo']])
  })

  it('a member the user is on comes back as the active tab', async () => {
    const state = research()
    state.spaces[0].activeTabId = 'a'
    act(() => browserStore.set({ state }))
    act(() => fire('folder.closeUndoable', { folderId: GROUP }))
    file(entry(tab('a'), NOW), entry(tab('b'), NOW))
    await flush()
    act(() => uiStore.get().toasts[0].action!.onPick())
    await flush()
    expect(of('tab.activate')).toEqual([{ tabId: 'a' }])
  })

  it('a group the state does not hold, or no state, runs nothing', () => {
    act(() => browserStore.set({ state: research() }))
    act(() => fire('folder.closeUndoable', { folderId: 'nowhere' }))
    expect(commands()).toEqual([])
    act(() => browserStore.set({ state: null }))
    act(() => fire('folder.closeUndoable', { folderId: GROUP }))
    expect(commands()).toEqual([])
    expect(toasts()).toEqual([])
  })

  it('the handler is the same on the phone: one path for both touch hosts', async () => {
    viewportStore.set({ ...viewportStore.get(), formFactor: 'phone' })
    act(() => browserStore.set({ state: research('Reading') }))
    act(() => fire('folder.closeUndoable', { folderId: GROUP }))
    expect(commands()).toEqual([['folder.close', { folderId: GROUP }]])
    file(entry(tab('a'), NOW), entry(tab('b'), NOW))
    await flush()
    expect(toasts()).toEqual([['Reading tab group closed and saved', 'Undo']])
  })
})
