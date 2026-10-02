// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ClosedEntrySummary, Events, Space, Tab, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'

/*
 * The core's `tab.closeUndoable` as `useMainEvents` answers it (OS-40 part B, §9.23: on a touch
 * host, closing a tab never asks and can always be undone): a touch host's tab menu close row –
 * Close Tab, Remove Tab, Close Tabs Above / Below, Close Other Tabs, the selection's Close N Tabs
 * – closes nothing in the core; it names the tabs the close takes, as the core's own rule reads
 * them, and the core command that closes them, and asks the chrome, which runs that command at
 * once through `lib/closeUndo.ts`. The toast that follows the core's filing reads "N tabs
 * closed" – "Closed <title>" for one – with Undo restoring the tabs newest first and the user's
 * tab activated. The desktop never fires the event: its rows call the core themselves
 * (`tabletTabMenu.test.ts` pins that line).
 */

const NOW = 1_700_000_000_000
const SPACE = 'space'

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
const { CLOSE_SETTLE_MS, closeTabFromChrome } = await import('@renderer/lib/closeUndo')

function Wired(): null {
  useMainEvents()
  return null
}

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

/** `tabs` in track order, `active` the tab the user is on. */
function stateOf(tabs: Tab[], active: string): UIState {
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
    folders: {},
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

/** Three loose tabs, `c` the one the user is on and the row the menu was asked from. */
const three = (): UIState => stateOf([tab('a'), tab('b'), tab('c')], 'c')

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

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

const CHASSIS = new Set(['session.recentlyClosed', 'thumbnail.configure', 'thumbnail.sweep'])
const commands = (): Array<[string, unknown]> =>
  invoke.mock.calls
    .filter(([name]) => !CHASSIS.has(name))
    .map(([name, args]) => [name, args] as [string, unknown])
const of = (name: string): unknown[] =>
  invoke.mock.calls.filter(([n]) => n === name).map(([, args]) => args)
const toasts = (): Array<[string, string | undefined]> =>
  uiStore.get().toasts.map((t) => [t.message, t.action?.label])

describe('tab.closeUndoable in the chrome', () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
    })
    vi.setSystemTime(NOW)
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + 1)
    })
    act(() => root.unmount())
    host.remove()
    uiStore.set({ toasts: [] })
    browserStore.set({ state: null })
    viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
    vi.useRealTimers()
  })

  it('runs the core’s tab.closeOthers at once for the row; the toast counts the tabs the core named and Undo brings them back newest first, the user kept on their tab', async () => {
    act(() => browserStore.set({ state: three() }))
    act(() =>
      fire('tab.closeUndoable', {
        tabIds: ['a', 'b'],
        close: { command: 'tab.closeOthers', tabId: 'c' }
      })
    )
    expect(commands()).toEqual([['tab.closeOthers', { tabId: 'c' }]])
    expect(toasts()).toEqual([])
    // The core files the two: the toast comes with them, no settle wait for a third.
    file(entry(tab('a'), NOW), entry(tab('b'), NOW))
    await flush()
    expect(toasts()).toEqual([['2 tabs closed', 'Undo']])
    act(() => uiStore.get().toasts[0].action!.onPick())
    await flush()
    expect(of('session.restoreClosed')).toEqual([{ id: 'closed:b' }, { id: 'closed:a' }])
    expect(of('tab.activate')).toEqual([{ tabId: 'c' }])
  })

  it('one other tab closes to "Closed <title>"', async () => {
    act(() => browserStore.set({ state: stateOf([tab('a'), tab('c')], 'c') }))
    act(() =>
      fire('tab.closeUndoable', {
        tabIds: ['a'],
        close: { command: 'tab.closeOthers', tabId: 'c' }
      })
    )
    expect(commands()).toEqual([['tab.closeOthers', { tabId: 'c' }]])
    file(entry(tab('a'), NOW))
    await flush()
    expect(toasts()).toEqual([['Closed A', 'Undo']])
  })

  it('Close Tabs Above runs the core’s directed close for the row, the toast counting the tabs the core named', async () => {
    act(() => browserStore.set({ state: three() }))
    act(() =>
      fire('tab.closeUndoable', {
        tabIds: ['a', 'b'],
        close: { command: 'tab.closeAbove', tabId: 'c' }
      })
    )
    expect(commands()).toEqual([['tab.closeAbove', { tabId: 'c' }]])
    file(entry(tab('a'), NOW), entry(tab('b'), NOW))
    await flush()
    expect(toasts()).toEqual([['2 tabs closed', 'Undo']])
  })

  it('Close Tabs Below the same way, with the tabs under the row', async () => {
    act(() => browserStore.set({ state: stateOf([tab('a'), tab('b'), tab('c')], 'a') }))
    act(() =>
      fire('tab.closeUndoable', {
        tabIds: ['b', 'c'],
        close: { command: 'tab.closeBelow', tabId: 'a' }
      })
    )
    expect(commands()).toEqual([['tab.closeBelow', { tabId: 'a' }]])
    file(entry(tab('b'), NOW), entry(tab('c'), NOW))
    await flush()
    expect(toasts()).toEqual([['2 tabs closed', 'Undo']])
  })

  it('Close Tab runs the core’s tab.close for the row at once; "Closed <title>", and Undo brings the tab back as the active one when it was the user’s', async () => {
    act(() => browserStore.set({ state: three() }))
    act(() =>
      fire('tab.closeUndoable', {
        tabIds: ['c'],
        close: { command: 'tab.close', tabId: 'c', force: false }
      })
    )
    expect(commands()).toEqual([['tab.close', { tabId: 'c', force: false }]])
    file(entry(tab('c'), NOW))
    await flush()
    expect(toasts()).toEqual([['Closed C', 'Undo']])
    act(() => uiStore.get().toasts[0].action!.onPick())
    await flush()
    expect(of('session.restoreClosed')).toEqual([{ id: 'closed:c' }])
    expect(of('tab.activate')).toEqual([{ tabId: 'c' }])
  })

  it('Close Tab on a pinned row under the "unload" behaviour only resets it: the close runs, nothing is counted, no toast', async () => {
    act(() => browserStore.set({ state: stateOf([tab('p', { pinned: true }), tab('c')], 'c') }))
    act(() =>
      fire('tab.closeUndoable', {
        tabIds: ['p'],
        close: { command: 'tab.close', tabId: 'p', force: false }
      })
    )
    expect(commands()).toEqual([['tab.close', { tabId: 'p', force: false }]])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + 1)
    })
    expect(toasts()).toEqual([])
  })

  it('Remove Tab closes a pinned row outright (tab.close with force), whatever the pinned-close behaviour: its entry is expected and the toast offers Undo', async () => {
    act(() => browserStore.set({ state: stateOf([tab('p', { pinned: true }), tab('c')], 'c') }))
    act(() =>
      fire('tab.closeUndoable', {
        tabIds: ['p'],
        close: { command: 'tab.close', tabId: 'p', force: true }
      })
    )
    expect(commands()).toEqual([['tab.close', { tabId: 'p', force: true }]])
    file(entry(tab('p'), NOW))
    await flush()
    expect(toasts()).toEqual([['Closed P', 'Undo']])
  })

  it('the selection’s Close N Tabs runs the core’s tab.closeMany with the selection, the toast counting them', async () => {
    act(() => browserStore.set({ state: three() }))
    act(() =>
      fire('tab.closeUndoable', {
        tabIds: ['a', 'c'],
        close: { command: 'tab.closeMany', tabIds: ['a', 'c'] }
      })
    )
    expect(commands()).toEqual([['tab.closeMany', { tabIds: ['a', 'c'] }]])
    file(entry(tab('a'), NOW), entry(tab('c'), NOW))
    await flush()
    expect(toasts()).toEqual([['2 tabs closed', 'Undo']])
  })

  it('a tab the core named that the chrome’s state no longer holds is none of the count; with none to count the close still runs, toastless', async () => {
    act(() => browserStore.set({ state: three() }))
    act(() =>
      fire('tab.closeUndoable', {
        tabIds: ['a', 'gone'],
        close: { command: 'tab.closeOthers', tabId: 'c' }
      })
    )
    expect(commands()).toEqual([['tab.closeOthers', { tabId: 'c' }]])
    file(entry(tab('a'), NOW))
    await flush()
    expect(toasts()).toEqual([['Closed A', 'Undo']])
    uiStore.set({ toasts: [] })
    invoke.mockClear()
    act(() =>
      fire('tab.closeUndoable', { tabIds: [], close: { command: 'tab.closeOthers', tabId: 'c' } })
    )
    expect(commands()).toEqual([['tab.closeOthers', { tabId: 'c' }]])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + 1)
    })
    expect(toasts()).toEqual([])
  })

  it('with no state the handler runs nothing', () => {
    act(() => browserStore.set({ state: null }))
    act(() =>
      fire('tab.closeUndoable', {
        tabIds: ['a'],
        close: { command: 'tab.closeOthers', tabId: 'c' }
      })
    )
    expect(commands()).toEqual([])
    expect(toasts()).toEqual([])
  })
})

/*
 * The chrome's own close of one tab (`closeTabFromChrome`, `lib/closeUndo.ts`): the strip row's
 * × and middle-click, the Essentials tile's middle-click, the strip's Delete, the tab search's ×
 * all close through it (their component pins hold them to the seam). On a touch layout the close
 * comes with Undo on the toast, as the overview's cards' closes do; on the desktop it is the bare
 * `tab.close` it always was, its page free to ask. The stores stand as in the suite above: the
 * tablet's layout, the chrome's state, the fake core filing what closed.
 */
describe('closeTabFromChrome: the chrome’s own close of one tab', () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
    })
    vi.setSystemTime(NOW)
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + 1)
    })
    act(() => root.unmount())
    host.remove()
    uiStore.set({ toasts: [] })
    browserStore.set({ state: null })
    viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
    vi.useRealTimers()
  })

  /** The chrome's state, then the tablet's layout: the store's change refreshes the viewport from the window's chrome. */
  function onTablet(state: UIState): void {
    act(() => browserStore.set({ state }))
    viewportStore.set({ ...viewportStore.get(), formFactor: 'tablet' })
  }

  it('on a touch layout closes through the family’s Undo: the core’s tab.close at once, "Closed <title>" once the core has filed it, Undo bringing the tab back as the active one', async () => {
    onTablet(three())
    act(() => closeTabFromChrome('c'))
    expect(commands()).toEqual([['tab.close', { tabId: 'c' }]])
    expect(toasts()).toEqual([])
    file(entry(tab('c'), NOW))
    await flush()
    expect(toasts()).toEqual([['Closed C', 'Undo']])
    act(() => uiStore.get().toasts[0].action!.onPick())
    await flush()
    expect(of('session.restoreClosed')).toEqual([{ id: 'closed:c' }])
    expect(of('tab.activate')).toEqual([{ tabId: 'c' }])
  })

  it('hands the caller’s args to the core as they are (the strip’s Delete keeps the keyboard on the strip)', () => {
    onTablet(three())
    act(() => closeTabFromChrome('b', { keepFocus: true }))
    expect(commands()).toEqual([['tab.close', { tabId: 'b', keepFocus: true }]])
  })

  it('a pinned tab under the "unload" behaviour only resets: the close runs, nothing is counted, no toast', async () => {
    onTablet(stateOf([tab('p', { pinned: true }), tab('c')], 'c'))
    act(() => closeTabFromChrome('p'))
    expect(commands()).toEqual([['tab.close', { tabId: 'p' }]])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + 1)
    })
    expect(toasts()).toEqual([])
  })

  it('a forced close (Remove Tab) closes a pinned tab outright, whatever the behaviour: its entry is expected and the toast offers Undo', async () => {
    onTablet(stateOf([tab('p', { pinned: true }), tab('c')], 'c'))
    act(() => closeTabFromChrome('p', { force: true }))
    expect(commands()).toEqual([['tab.close', { tabId: 'p', force: true }]])
    file(entry(tab('p'), NOW))
    await flush()
    expect(toasts()).toEqual([['Closed P', 'Undo']])
  })

  it('on the desktop the close is as it was: a bare tab.close, no undo of the chrome’s – an entry the core then files is nobody’s', async () => {
    act(() => browserStore.set({ state: three() }))
    viewportStore.set({ ...viewportStore.get(), formFactor: 'desktop' })
    act(() => closeTabFromChrome('c'))
    expect(commands()).toEqual([['tab.close', { tabId: 'c' }]])
    file(entry(tab('c'), NOW))
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + 1)
    })
    expect(toasts()).toEqual([])
  })

  it('a tab the chrome’s state does not hold closes plainly: there is nothing to count', async () => {
    onTablet(three())
    act(() => closeTabFromChrome('gone'))
    expect(commands()).toEqual([['tab.close', { tabId: 'gone' }]])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + 1)
    })
    expect(toasts()).toEqual([])
  })
})
