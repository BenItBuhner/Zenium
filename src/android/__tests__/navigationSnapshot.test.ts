import { describe, expect, it } from 'vitest'
import type { TabViewEvents } from '@core/platform'
import { createTabRecord } from '@core/model'
import type { NavigationSnapshot, Tab } from '@shared/types'
import { NAVIGATION_ENTRIES_MAX, NAVIGATION_HOST_STATE_MAX_CHARS } from '@core/session'
import type { Bridge } from '../bridge'
import { AndroidPlatform } from '../platform'
import { AndroidTabView, hostSnapshotFrom, NavigationBridge, reconcileHistory } from '../views'

/*
 * The Android view's side of the back/forward stack contract
 * (`internal/parity-services/navigation-snapshot-interface.md` §2.2-2.4): the list the host
 * pushes (`historyChanged`) or answers for (`view.navigationEntries`), the URL-only snapshot of a
 * host that does neither, the state blob (`hostState`) within its cap, and the restore paths.
 */

/** A recorded call of the scripted bridge. */
interface Call {
  method: string
  args: unknown
}

/**
 * A bridge whose sync methods answer from `sync` (a missing method answers `undefined`, as the
 * real bridge does for a method the host does not have) and whose async `view.restoreNavigation`
 * answers `restore` (a function may throw, as an older host's "Unknown method" rejection).
 */
function scriptedBridge(
  script: {
    sync?: Record<string, (args: { tabId: string }) => unknown>
    restore?: unknown | (() => unknown)
  } = {}
): { bridge: Bridge; calls: Call[]; syncCalls: Call[] } {
  const calls: Call[] = []
  const syncCalls: Call[] = []
  const bridge = {
    call: async (method: string, args: unknown) => {
      calls.push({ method, args })
      if (method !== 'view.restoreNavigation') return null
      return typeof script.restore === 'function' ? script.restore() : script.restore
    },
    send: (method: string, args: unknown) => {
      calls.push({ method, args })
    },
    callSync: (method: string, args: { tabId: string }) => {
      syncCalls.push({ method, args })
      return script.sync?.[method]?.(args)
    }
  } as unknown as Bridge
  return { bridge, calls, syncCalls }
}

function silentEvents(): TabViewEvents {
  return new Proxy({} as TabViewEvents, { get: () => (): undefined => undefined })
}

function viewOn(bridge: Bridge, navigation?: NavigationBridge): AndroidTabView {
  const view = new AndroidTabView('tab_1', bridge, undefined, navigation)
  view.events = silentEvents()
  return view
}

const nav = { title: '', canGoBack: false, canGoForward: false }

const stack: NavigationSnapshot = {
  entries: [
    { url: 'https://a.test/', title: 'A' },
    { url: 'https://b.test/', title: 'B' },
    { url: 'https://c.test/', title: 'C' }
  ],
  index: 2
}

/** Kotlin's list for `stack`: what `copyBackForwardList()` gives, with the WebView's originalUrl. */
const hostList = {
  entries: stack.entries.map((e) => ({ ...e, originalUrl: e.url })),
  index: 2
}

const blob = 'UGFyY2Vs'.repeat(16)
const overCap = 'x'.repeat(NAVIGATION_HOST_STATE_MAX_CHARS + 1)

describe('AndroidTabView.navigationEntries without a host list (an older APK, the preview host)', () => {
  it('is the current page alone, or nothing before a page', () => {
    const { bridge } = scriptedBridge()
    const view = viewOn(bridge)
    expect(view.navigationEntries()).toEqual({ entries: [], index: -1 })
    view.dispatch('navigated', { ...nav, url: 'https://a.test/', title: 'A', inPage: false })
    expect(view.navigationEntries()).toEqual({
      entries: [{ url: 'https://a.test/', title: 'A' }],
      index: 0
    })
  })

  it('asks a host without the sync methods once, not on every read', () => {
    const { bridge, syncCalls } = scriptedBridge()
    const view = viewOn(bridge)
    view.dispatch('navigated', { ...nav, url: 'https://a.test/', inPage: false })
    view.navigationEntries()
    view.navigationEntries()
    view.navigationEntries()
    expect(syncCalls.map((c) => c.method)).toEqual(['view.navigationEntries'])
  })

  it('keeps goToIndex a no-op: the current entry is the only one the core can name', () => {
    const { bridge, calls } = scriptedBridge()
    const view = viewOn(bridge)
    view.dispatch('navigated', { ...nav, url: 'https://a.test/', inPage: false })
    view.goToIndex(0)
    expect(calls).toEqual([])
  })
})

describe('AndroidTabView.navigationEntries from the host’s historyChanged push (option b)', () => {
  it('is the list the host last pushed, entries reduced to URL and title', () => {
    const { bridge } = scriptedBridge()
    const view = viewOn(bridge)
    view.dispatch('navigated', { ...nav, url: 'https://c.test/', title: 'C', inPage: false })
    view.dispatch('historyChanged', hostList)
    expect(view.navigationEntries()).toEqual(stack)
  })

  it('accepts the app-wide form of the event, with the tabId inside the payload', () => {
    const { bridge } = scriptedBridge()
    const view = viewOn(bridge)
    view.dispatch('navigated', { ...nav, url: 'https://c.test/', inPage: false })
    view.dispatch('historyChanged', { tabId: 'tab_1', ...hostList } as typeof hostList)
    expect(view.navigationEntries()).toEqual(stack)
  })

  it('keeps the last good list through a malformed push and takes an empty list as an answer', () => {
    const { bridge } = scriptedBridge()
    const view = viewOn(bridge)
    view.dispatch('navigated', { ...nav, url: 'https://c.test/', inPage: false })
    view.dispatch('historyChanged', hostList)
    view.dispatch('historyChanged', { entries: 'nope', index: 0 } as unknown as typeof hostList)
    view.dispatch('historyChanged', null as unknown as typeof hostList)
    expect(view.navigationEntries()).toEqual(stack)
  })

  it('moves the index when the view is on another entry of the list (back or forward before the push)', () => {
    const { bridge } = scriptedBridge()
    const view = viewOn(bridge)
    view.dispatch('historyChanged', hostList)
    view.dispatch('navigated', { ...nav, url: 'https://a.test/', title: 'A', inPage: false })
    expect(view.navigationEntries()).toEqual({ ...stack, index: 0 })
    // The nearest entry with the URL, when it appears twice.
    view.dispatch('historyChanged', {
      entries: [
        { url: 'https://a.test/', title: 'A' },
        { url: 'https://b.test/', title: 'B' },
        { url: 'https://a.test/', title: 'A again' },
        { url: 'https://d.test/', title: 'D' }
      ],
      index: 3
    })
    expect(view.navigationEntries().index).toBe(2)
  })

  it('puts a new URL on top and drops the forward entries, as the WebView did (a commit before its push)', () => {
    const { bridge } = scriptedBridge()
    const view = viewOn(bridge)
    view.dispatch('historyChanged', { ...hostList, index: 1 })
    view.dispatch('navigated', { ...nav, url: 'https://d.test/', title: 'D', inPage: false })
    expect(view.navigationEntries()).toEqual({
      entries: [
        { url: 'https://a.test/', title: 'A' },
        { url: 'https://b.test/', title: 'B' },
        { url: 'https://d.test/', title: 'D' }
      ],
      index: 2
    })
    // Then the host's own list arrives and is what the snapshot is.
    view.dispatch('historyChanged', hostList)
    view.dispatch('navigated', { ...nav, url: 'https://c.test/', title: 'C', inPage: false })
    expect(view.navigationEntries()).toEqual(stack)
  })

  it('keeps a pushed hostState with the list it describes and drops it once the list is reconciled', () => {
    const { bridge } = scriptedBridge()
    const view = viewOn(bridge)
    view.dispatch('navigated', { ...nav, url: 'https://c.test/', title: 'C', inPage: false })
    view.dispatch('historyChanged', { ...hostList, hostState: blob })
    expect(view.navigationEntries()).toEqual({ ...stack, hostState: blob })
    view.dispatch('navigated', { ...nav, url: 'https://d.test/', title: 'D', inPage: false })
    expect(view.navigationEntries()).not.toHaveProperty('hostState')
  })

  it('drops a pushed hostState over 64 KB (the size cap)', () => {
    const { bridge } = scriptedBridge()
    const view = viewOn(bridge)
    view.dispatch('navigated', { ...nav, url: 'https://c.test/', title: 'C', inPage: false })
    view.dispatch('historyChanged', { ...hostList, hostState: overCap })
    expect(view.navigationEntries()).toEqual(stack)
  })

  it('cuts a list longer than NAVIGATION_ENTRIES_MAX to the newest entries, without its hostState', () => {
    const { bridge } = scriptedBridge()
    const view = viewOn(bridge)
    const entries = Array.from({ length: NAVIGATION_ENTRIES_MAX + 5 }, (_, i) => ({
      url: `https://s${i}.test/`,
      title: ''
    }))
    view.dispatch('navigated', { ...nav, url: entries[entries.length - 1].url, inPage: false })
    view.dispatch('historyChanged', { entries, index: entries.length - 1, hostState: blob })
    const out = view.navigationEntries()
    expect(out.entries).toHaveLength(NAVIGATION_ENTRIES_MAX)
    expect(out.index).toBe(NAVIGATION_ENTRIES_MAX - 1)
    expect(out).not.toHaveProperty('hostState')
  })

  it('sends goToIndex to the host once a list is known', () => {
    const { bridge, calls } = scriptedBridge()
    const view = viewOn(bridge)
    view.dispatch('historyChanged', hostList)
    view.goToIndex(0)
    expect(calls).toEqual([{ method: 'view.goToIndex', args: { tabId: 'tab_1', index: 0 } }])
  })
})

describe('AndroidTabView.navigationEntries from the host’s sync reply (option a)', () => {
  it('wins over the pushed list and is asked again on every read', () => {
    const { bridge, syncCalls } = scriptedBridge({
      sync: { 'view.navigationEntries': () => ({ ...hostList, index: 0 }) }
    })
    const view = viewOn(bridge)
    view.dispatch('historyChanged', hostList)
    view.dispatch('navigated', { ...nav, url: 'https://c.test/', inPage: false })
    expect(view.navigationEntries()).toEqual({ ...stack, index: 0 })
    view.navigationEntries()
    expect(syncCalls.filter((c) => c.method === 'view.navigationEntries')).toHaveLength(2)
    expect(syncCalls[0].args).toEqual({ tabId: 'tab_1' })
  })

  it('takes the reply’s hostState, within the cap', () => {
    const { bridge } = scriptedBridge({
      sync: { 'view.navigationEntries': () => ({ ...hostList, hostState: blob }) }
    })
    expect(viewOn(bridge).navigationEntries()).toEqual({ ...stack, hostState: blob })
    const { bridge: capped, syncCalls } = scriptedBridge({
      sync: {
        'view.navigationEntries': () => ({ ...hostList, hostState: overCap }),
        'view.navigationHostState': () => null
      }
    })
    expect(viewOn(capped).navigationEntries()).toEqual(stack)
    // A reply without a blob to keep has the separate method asked.
    expect(syncCalls.map((c) => c.method)).toEqual([
      'view.navigationEntries',
      'view.navigationHostState'
    ])
  })

  it('returns the host’s empty list as it is, so the core keeps what it remembered', () => {
    const { bridge } = scriptedBridge({
      sync: { 'view.navigationEntries': () => ({ entries: [], index: -1 }) }
    })
    const view = viewOn(bridge)
    view.dispatch('navigated', { ...nav, url: 'https://c.test/', inPage: false })
    expect(view.navigationEntries()).toEqual({ entries: [], index: -1 })
  })

  it('treats a malformed reply as no answer and falls back to the pushed list', () => {
    const { bridge } = scriptedBridge({
      sync: { 'view.navigationEntries': () => ({ entries: 7 }) }
    })
    const view = viewOn(bridge)
    view.dispatch('navigated', { ...nav, url: 'https://c.test/', inPage: false })
    view.dispatch('historyChanged', hostList)
    expect(view.navigationEntries()).toEqual(stack)
  })

  it('lets every view of the host share what it offers (NavigationBridge)', () => {
    const { bridge, syncCalls } = scriptedBridge()
    const shared = new NavigationBridge(bridge)
    const one = viewOn(bridge, shared)
    const two = viewOn(bridge, shared)
    one.dispatch('navigated', { ...nav, url: 'https://a.test/', inPage: false })
    two.dispatch('navigated', { ...nav, url: 'https://b.test/', inPage: false })
    one.navigationEntries()
    two.navigationEntries()
    expect(syncCalls).toHaveLength(1)
  })
})

describe('AndroidTabView.navigationEntries and the hostState fetched when a stack is recorded', () => {
  it('asks view.navigationHostState for the tab and attaches a blob within the cap', () => {
    const { bridge, syncCalls } = scriptedBridge({
      sync: { 'view.navigationHostState': () => blob }
    })
    const view = viewOn(bridge)
    view.dispatch('navigated', { ...nav, url: 'https://c.test/', title: 'C', inPage: false })
    view.dispatch('historyChanged', hostList)
    expect(view.navigationEntries()).toEqual({ ...stack, hostState: blob })
    expect(syncCalls.map((c) => c.method)).toEqual([
      'view.navigationEntries',
      'view.navigationHostState'
    ])
    expect(syncCalls[1].args).toEqual({ tabId: 'tab_1' })
  })

  it('drops a blob over 64 KB and takes null as nothing to keep, asking again next time', () => {
    let reply: unknown = overCap
    const { bridge, syncCalls } = scriptedBridge({
      sync: { 'view.navigationHostState': () => reply }
    })
    const view = viewOn(bridge)
    view.dispatch('navigated', { ...nav, url: 'https://c.test/', title: 'C', inPage: false })
    view.dispatch('historyChanged', hostList)
    expect(view.navigationEntries()).toEqual(stack)
    reply = null
    expect(view.navigationEntries()).toEqual(stack)
    reply = blob
    expect(view.navigationEntries()).toEqual({ ...stack, hostState: blob })
    expect(syncCalls.filter((c) => c.method === 'view.navigationHostState')).toHaveLength(3)
  })

  it('does not ask for a blob with no list to attach it to', () => {
    const { bridge, syncCalls } = scriptedBridge({
      sync: { 'view.navigationHostState': () => blob }
    })
    const view = viewOn(bridge)
    expect(view.navigationEntries()).toEqual({ entries: [], index: -1 })
    view.dispatch('historyChanged', { entries: [], index: -1 })
    view.dispatch('navigated', { ...nav, url: 'https://a.test/', title: 'A', inPage: false })
    // A list of one page grown from the empty push is a live list: the blob is asked for.
    expect(view.navigationEntries()).toEqual({
      entries: [{ url: 'https://a.test/', title: 'A' }],
      index: 0,
      hostState: blob
    })
    expect(syncCalls.filter((c) => c.method === 'view.navigationHostState')).toHaveLength(1)
  })
})

describe('AndroidTabView.restoreNavigation', () => {
  const withHost: NavigationSnapshot = {
    entries: [
      { url: 'https://a.test/', title: 'A', pageState: 'ZWxlY3Ryb24=' },
      { url: 'https://b.test/', title: 'B' }
    ],
    index: 1,
    hostState: blob
  }

  it('hands the host the list, the index and its blob – URLs and titles only – and is done on { restored: true }', async () => {
    const { bridge, calls } = scriptedBridge({ restore: { restored: true } })
    await viewOn(bridge).restoreNavigation(withHost)
    expect(calls).toEqual([
      {
        method: 'view.restoreNavigation',
        args: {
          tabId: 'tab_1',
          entries: [
            { url: 'https://a.test/', title: 'A' },
            { url: 'https://b.test/', title: 'B' }
          ],
          index: 1,
          hostState: blob
        }
      }
    ])
  })

  it('loads the current entry when the host could not restore the list', async () => {
    const { bridge, calls } = scriptedBridge({ restore: { restored: false } })
    await viewOn(bridge).restoreNavigation(withHost)
    expect(calls.map((c) => c.method)).toEqual(['view.restoreNavigation', 'view.load'])
    expect(calls[1].args).toEqual({ tabId: 'tab_1', url: 'https://b.test/' })
  })

  it('loads the current entry on a host without the handler (the rejection of an older APK)', async () => {
    const { bridge, calls } = scriptedBridge({
      restore: () => {
        throw new Error('Unknown method: view.restoreNavigation')
      }
    })
    await viewOn(bridge).restoreNavigation(withHost)
    expect(calls.map((c) => c.method)).toEqual(['view.restoreNavigation', 'view.load'])
  })

  it('loads the current entry on a host that answers nothing (the preview host)', async () => {
    const { bridge, calls } = scriptedBridge({ restore: undefined })
    await viewOn(bridge).restoreNavigation(withHost)
    expect(calls.map((c) => c.method)).toEqual(['view.restoreNavigation', 'view.load'])
  })

  it('sends no hostState when the snapshot has none to send, and clamps the index', async () => {
    const { bridge, calls } = scriptedBridge({ restore: { restored: false } })
    await viewOn(bridge).restoreNavigation({
      entries: [
        { url: 'https://a.test/', title: 'A' },
        { url: '', title: 'dropped' }
      ],
      index: 5,
      hostState: overCap
    })
    expect(calls[0].args).toEqual({
      tabId: 'tab_1',
      entries: [{ url: 'https://a.test/', title: 'A' }],
      index: 0
    })
    expect(calls[1]).toEqual({
      method: 'view.load',
      args: { tabId: 'tab_1', url: 'https://a.test/' }
    })
  })

  it('gives a zen:// current entry its document on the fallback, as loadURL does', async () => {
    const { bridge, calls } = scriptedBridge({ restore: { restored: false } })
    const view = viewOn(bridge)
    await view.restoreNavigation({
      entries: [
        { url: 'https://a.test/', title: 'A' },
        { url: 'zen://newtab', title: '' }
      ],
      index: 1
    })
    expect(calls[1].method).toBe('view.loadHtml')
    expect((calls[1].args as { url: string }).url).toBe('zen://newtab')
    expect(view.hasDocument()).toBe(true)
  })

  it('loads nothing into a view destroyed meanwhile, and nothing for an empty snapshot', async () => {
    const { bridge, calls } = scriptedBridge({ restore: { restored: false } })
    const view = viewOn(bridge)
    const pending = view.restoreNavigation(withHost)
    view.dispatch('destroyed', undefined)
    await pending
    expect(calls.map((c) => c.method)).toEqual(['view.restoreNavigation'])
    await viewOn(bridge).restoreNavigation({ entries: [], index: -1 })
    expect(calls).toHaveLength(1)
  })
})

describe('the app-wide historyChanged host event', () => {
  it('reaches the view named by its tabId, and no other', () => {
    const { bridge } = scriptedBridge()
    const platform = new AndroidPlatform(bridge, {
      version: '0.0.0-test',
      sdkInt: 34,
      signer: null,
      packageName: null,
      files: {},
      downloadsDir: '/sdcard/Download',
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      fullscreen: false
    })
    const tabOf = (id: string): Tab =>
      createTabRecord({ id, spaceId: 'space_1', containerId: 'default', url: 'https://c.test/' })
    const one = platform.views.createView(tabOf('tab_1'), silentEvents())
    const two = platform.views.createView(tabOf('tab_2'), silentEvents())
    platform.viewEvent('tab_1', 'navigated', { ...nav, url: 'https://c.test/', inPage: false })
    platform.viewEvent('tab_2', 'navigated', { ...nav, url: 'https://x.test/', inPage: false })
    platform.hostEvent('historyChanged', { tabId: 'tab_1', ...hostList })
    // Payloads without a tabId, or for a view that is not there, go nowhere.
    platform.hostEvent('historyChanged', hostList as unknown as { tabId: string } & typeof hostList)
    platform.hostEvent('historyChanged', { tabId: 'tab_9', ...hostList })
    expect(one.navigationEntries()).toEqual(stack)
    expect(two.navigationEntries()).toEqual({
      entries: [{ url: 'https://x.test/', title: '' }],
      index: 0
    })
  })
})

describe('hostSnapshotFrom', () => {
  it('checks the host’s payload: an empty list is an answer, a malformed one is none', () => {
    expect(hostSnapshotFrom({ entries: [], index: -1 })).toEqual({ entries: [], index: -1 })
    expect(hostSnapshotFrom({ entries: [], index: 0 })).toEqual({ entries: [], index: -1 })
    expect(hostSnapshotFrom(hostList)).toEqual(stack)
    expect(hostSnapshotFrom(null)).toBeNull()
    expect(hostSnapshotFrom('list')).toBeNull()
    expect(hostSnapshotFrom({ entries: hostList.entries })).toBeNull()
    expect(hostSnapshotFrom({ entries: [{ title: 'no url' }], index: 0 })).toBeNull()
  })
})

describe('reconcileHistory', () => {
  it('leaves a list whose current entry is the view’s URL alone, and any list without a URL', () => {
    expect(reconcileHistory(stack, { ...nav, url: 'https://c.test/' })).toBe(stack)
    expect(reconcileHistory(stack, { ...nav, url: '' })).toBe(stack)
  })

  it('grows a full list from the end, keeping NAVIGATION_ENTRIES_MAX entries', () => {
    const entries = Array.from({ length: NAVIGATION_ENTRIES_MAX }, (_, i) => ({
      url: `https://s${i}.test/`,
      title: ''
    }))
    const out = reconcileHistory(
      { entries, index: entries.length - 1 },
      { ...nav, url: 'https://new.test/', title: 'New' }
    )
    expect(out.entries).toHaveLength(NAVIGATION_ENTRIES_MAX)
    expect(out.entries[0].url).toBe('https://s1.test/')
    expect(out.entries[out.entries.length - 1]).toEqual({ url: 'https://new.test/', title: 'New' })
    expect(out.index).toBe(NAVIGATION_ENTRIES_MAX - 1)
  })
})
