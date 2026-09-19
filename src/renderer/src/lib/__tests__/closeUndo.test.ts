import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClosedEntrySummary, Settings, Tab } from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import { BLANK_URL } from '@shared/url'
import type { Invoke, Subscribe } from '../closeUndo'
import type { MessageAction, Toast } from '../ui'

/*
 * Undo for closing tabs (lib/closeUndo.ts; v2 draft §9.33; matrix TAB-05, TAB-06, TAB-07,
 * GN-16): a close goes through at once; the toast comes once the core has filed the closed tab
 * on its recently closed list and offers to bring the tabs back through `session.restoreClosed`,
 * newest first, so every tab lands at the index it held as it closed. The core here is a stand-in
 * that keeps the list newest first and fires `session.recentlyClosedChanged` as the real one does.
 */

/** The core as the module sees it: the list (newest first), the change event, the commands. */
class FakeCore {
  list: ClosedEntrySummary[] = []
  calls: Array<[string, unknown]> = []
  private listeners = new Set<(payload: undefined) => void>()

  invoke = async (name: string, args: unknown): Promise<unknown> => {
    this.calls.push([name, args])
    if (name === 'session.recentlyClosed') return [...this.list]
    if (name === 'session.restoreClosed') {
      const { id } = args as { id: string }
      this.list = this.list.filter((e) => e.id !== id)
      this.changed()
    }
    return null
  }

  on = (name: string, listener: (payload: undefined) => void): (() => void) => {
    if (name === 'session.recentlyClosedChanged') this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The core files a closed tab: onto the front of the list, then the event. */
  file(...entries: ClosedEntrySummary[]): void {
    for (const entry of entries) this.list = [entry, ...this.list]
    this.changed()
  }

  /** The commands of one name, in order. */
  of(name: string): unknown[] {
    return this.calls.filter(([n]) => n === name).map(([, args]) => args)
  }

  reset(): void {
    this.list = []
    this.calls = []
  }

  private changed(): void {
    for (const listener of this.listeners) listener(undefined)
  }
}

const core = new FakeCore()
vi.stubGlobal('window', {
  zen: {
    invoke: (name: string, args: unknown) => core.invoke(name, args),
    on: (name: string, listener: (payload: undefined) => void) => core.on(name, listener)
  }
})

const { CLOSE_SETTLE_MS, closeWithUndo, closedMessage, createCloseUndo, leavesClosedEntry } =
  await import('../closeUndo')
const { TOAST_ACTION_DURATION, claimMessageCards, pickToastAction, uiStore } = await import('../ui')

// --- fixtures ----------------------------------------------------------------------------------

function tab(id: string, patch: Partial<Tab> = {}): Tab {
  return {
    id,
    spaceId: 'space',
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

const UNLOAD: Pick<Settings, 'pinnedCloseBehavior'> = { pinnedCloseBehavior: 'unload' }
const CLOSE: Pick<Settings, 'pinnedCloseBehavior'> = { pinnedCloseBehavior: 'close' }

/** The async work between the event and the toast: the list read and its attribution. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** An undo over the fake core; `toast` records the toasts, `active` is the tab the user is on. */
function harness(active: string | null = null): {
  close: (tabs: Tab[], activeTabId?: string | null, settings?: typeof UNLOAD) => () => void
  toasts: Array<{ message: string; action: MessageAction }>
  now: { value: number }
  active: { value: string | null }
} {
  const toasts: Array<{ message: string; action: MessageAction }> = []
  const now = { value: 10_000 }
  const current = { value: active }
  const undo = createCloseUndo({
    invoke: core.invoke as unknown as Invoke,
    on: core.on as unknown as Subscribe,
    toast: (message, action) => toasts.push({ message, action }),
    now: () => now.value,
    activeTabId: () => current.value
  })
  return {
    toasts,
    now,
    active: current,
    close: (tabs, activeTabId = active, settings = UNLOAD) => {
      const close = vi.fn()
      undo.close({ tabs, settings, activeTabId, close })
      return close
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  core.reset()
})

afterEach(async () => {
  await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + TOAST_ACTION_DURATION + 1000)
  uiStore.set({ toasts: [] })
  vi.useRealTimers()
})

// --- the rules ---------------------------------------------------------------------------------

describe('what a close leaves on the recently closed list', () => {
  it('a page does; a blank tab never visited does not, one with a history does', () => {
    expect(leavesClosedEntry(tab('a'), UNLOAD)).toBe(true)
    expect(leavesClosedEntry(tab('blank', { url: BLANK_URL }), UNLOAD)).toBe(false)
    expect(leavesClosedEntry(tab('back', { url: BLANK_URL, canGoBack: true }), UNLOAD)).toBe(true)
    expect(leavesClosedEntry(tab('fwd', { url: BLANK_URL, canGoForward: true }), UNLOAD)).toBe(true)
  })

  it('a pinned or essential tab only under the "Close the tab" behaviour; a private tab never', () => {
    expect(leavesClosedEntry(tab('p', { pinned: true }), UNLOAD)).toBe(false)
    expect(leavesClosedEntry(tab('p', { pinned: true }), CLOSE)).toBe(true)
    expect(leavesClosedEntry(tab('e', { essential: true }), UNLOAD)).toBe(false)
    expect(leavesClosedEntry(tab('e', { essential: true }), CLOSE)).toBe(true)
    expect(leavesClosedEntry(tab('x', { containerId: PRIVATE_CONTAINER_ID }), CLOSE)).toBe(false)
  })

  it('the toast names one tab and counts several (§9.33, sentence case)', () => {
    const a = tab('a', { title: 'Zenium docs' })
    expect(closedMessage([entry(a, 1)])).toBe('Closed Zenium docs')
    expect(closedMessage([entry(a, 1), entry(tab('b'), 2), entry(tab('c'), 3)])).toBe(
      '3 tabs closed'
    )
  })
})

// --- one tab -----------------------------------------------------------------------------------

describe('closing one tab', () => {
  it('closes at once, toasts once the core has filed the tab, and Undo brings it back as the active tab', async () => {
    const h = harness('a')
    const a = tab('a', { title: 'Zenium docs' })
    const close = h.close([a], 'a')
    // The close went through in the same call; nothing is deferred and nothing is up yet.
    expect(close).toHaveBeenCalledTimes(1)
    expect(h.toasts).toEqual([])
    // The core files the tab and says so: the toast follows, with its one action.
    core.file(entry(a, h.now.value))
    await flush()
    expect(h.toasts.map((t) => t.message)).toEqual(['Closed Zenium docs'])
    expect(h.toasts[0].action.label).toBe('Undo')
    // Undo: the core's restore puts the tab back into its place, then the user lands on it.
    h.toasts[0].action.onPick()
    await flush()
    expect(core.calls.filter(([n]) => n !== 'session.recentlyClosed')).toEqual([
      ['session.restoreClosed', { id: 'closed:a' }],
      ['tab.activate', { tabId: 'a' }]
    ])
  })

  it('Undo of a tab the user was not on keeps them where they are', async () => {
    const h = harness('b')
    const a = tab('a')
    h.close([a], 'b')
    core.file(entry(a, h.now.value))
    await flush()
    h.toasts[0].action.onPick()
    await flush()
    expect(core.of('session.restoreClosed')).toEqual([{ id: 'closed:a' }])
    // The core activates every restored tab; the chrome puts the user back on their own.
    expect(core.of('tab.activate')).toEqual([{ tabId: 'b' }])
  })

  it('a close that files nothing gets no toast: a blank tab, a pinned tab that only unloads, a private tab', async () => {
    const h = harness()
    const blank = h.close([tab('blank', { url: BLANK_URL })])
    const pinned = h.close([tab('p', { pinned: true })])
    const secret = h.close([tab('x', { containerId: PRIVATE_CONTAINER_ID })])
    expect(blank).toHaveBeenCalledTimes(1)
    expect(pinned).toHaveBeenCalledTimes(1)
    expect(secret).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + 1)
    expect(h.toasts).toEqual([])
    // Nothing was read either: there was nothing to wait for.
    expect(core.of('session.recentlyClosed')).toEqual([])
  })

  it('an entry filed before the close is not its; the toast waits for its own', async () => {
    const h = harness()
    const old = entry(tab('old'), h.now.value - 5000)
    core.list = [old]
    const a = tab('a')
    h.close([a])
    // The list changes for another reason first: the old entry is not taken.
    core.file()
    await flush()
    expect(h.toasts).toEqual([])
    core.file(entry(a, h.now.value))
    await flush()
    expect(h.toasts.map((t) => t.message)).toEqual(['Closed A'])
    h.toasts[0].action.onPick()
    await flush()
    expect(core.of('session.restoreClosed')).toEqual([{ id: 'closed:a' }])
  })

  it('a page that holds its close past the settle time gets no toast', async () => {
    const h = harness()
    h.close([tab('a')])
    await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + 1)
    expect(h.toasts).toEqual([])
    // The tab is filed late (the user let the page go): no toast comes for it after the fact…
    core.file(entry(tab('a'), h.now.value + CLOSE_SETTLE_MS + 2))
    await flush()
    expect(h.toasts).toEqual([])
    // …and the entry is free for the next close to take, should its clock allow.
    expect(core.list).toHaveLength(1)
  })
})

// --- several tabs ------------------------------------------------------------------------------

describe('closing several tabs at once', () => {
  it('one toast once all are filed; Undo restores newest first and the user lands on the closed tab they were on', async () => {
    const h = harness('b')
    const [a, b, c] = [tab('a'), tab('b'), tab('c')]
    const close = h.close([a, b, c], 'b')
    expect(close).toHaveBeenCalledTimes(1)
    // The core closes them in order and files each in turn; the list is newest first.
    core.file(entry(a, h.now.value))
    await flush()
    expect(h.toasts).toEqual([])
    core.file(entry(b, h.now.value), entry(c, h.now.value))
    await flush()
    expect(core.list.map((e) => e.id)).toEqual(['closed:c', 'closed:b', 'closed:a'])
    expect(h.toasts.map((t) => t.message)).toEqual(['3 tabs closed'])
    h.toasts[0].action.onPick()
    await flush()
    // Newest first: c goes back to the index it held once b and a were gone, then b, then a –
    // each into the place it left, so the row reads a, b, c again.
    expect(core.of('session.restoreClosed')).toEqual([
      { id: 'closed:c' },
      { id: 'closed:b' },
      { id: 'closed:a' }
    ])
    expect(core.of('tab.activate')).toEqual([{ tabId: 'b' }])
    expect(core.list).toEqual([])
  })

  it('only the tabs that leave an entry are waited for: the pinned ones in a close-all are not', async () => {
    const h = harness()
    const [a, p, c] = [tab('a'), tab('p', { pinned: true }), tab('c')]
    h.close([a, p, c])
    core.file(entry(a, h.now.value), entry(c, h.now.value))
    await flush()
    expect(h.toasts.map((t) => t.message)).toEqual(['2 tabs closed'])
  })

  it('what has come by the settle time is offered; the rest is nobody’s', async () => {
    const h = harness()
    const [a, b] = [tab('a'), tab('b')]
    h.close([a, b])
    core.file(entry(a, h.now.value))
    await flush()
    expect(h.toasts).toEqual([])
    await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + 1)
    expect(h.toasts.map((t) => t.message)).toEqual(['Closed A'])
    core.file(entry(b, h.now.value + CLOSE_SETTLE_MS + 2))
    await flush()
    expect(h.toasts).toHaveLength(1)
    h.toasts[0].action.onPick()
    await flush()
    expect(core.of('session.restoreClosed')).toEqual([{ id: 'closed:a' }])
  })
})

// --- closes back to back -----------------------------------------------------------------------

describe('closes back to back', () => {
  it('each takes its own entries, oldest first, and gets its own toast', async () => {
    const h = harness()
    const [a, b, c] = [tab('a'), tab('b'), tab('c')]
    h.close([a])
    h.now.value += 1
    h.close([b, c])
    // The core files them in the order they closed.
    core.file(entry(a, h.now.value - 1))
    await flush()
    expect(h.toasts.map((t) => t.message)).toEqual(['Closed A'])
    core.file(entry(b, h.now.value), entry(c, h.now.value))
    await flush()
    expect(h.toasts.map((t) => t.message)).toEqual(['Closed A', '2 tabs closed'])
    h.toasts[1].action.onPick()
    await flush()
    expect(core.of('session.restoreClosed')).toEqual([{ id: 'closed:c' }, { id: 'closed:b' }])
    h.toasts[0].action.onPick()
    await flush()
    expect(core.of('session.restoreClosed')).toEqual([
      { id: 'closed:c' },
      { id: 'closed:b' },
      { id: 'closed:a' }
    ])
  })

  it('entries filed in one change go to the intents in order', async () => {
    const h = harness()
    const [a, b] = [tab('a'), tab('b')]
    h.close([a])
    h.close([b])
    core.file(entry(a, h.now.value), entry(b, h.now.value))
    await flush()
    expect(h.toasts.map((t) => t.message)).toEqual(['Closed A', 'Closed B'])
  })
})

// --- on the message cards (§9.33) --------------------------------------------------------------

describe('the toast on the cards', () => {
  const live = (): Toast[] => uiStore.get().toasts.filter((t) => !t.leaving)
  let release: (() => void) | null = null

  beforeEach(() => {
    uiStore.set({ toasts: [] })
    release = claimMessageCards()
  })
  afterEach(() => {
    release?.()
    release = null
  })

  it('runs on the action clock, the newer replaces the older, and its Undo restores through the core', async () => {
    const a = tab('a', { title: 'Zenium docs' })
    const b = tab('b', { title: 'Release notes' })
    closeWithUndo({ tabs: [a], settings: UNLOAD, activeTabId: 'a', close: () => undefined })
    core.file(entry(a, Date.now()))
    await flush()
    expect(live().map((t) => [t.message, t.kind, t.duration, t.action?.label])).toEqual([
      ['Closed Zenium docs', 'info', TOAST_ACTION_DURATION, 'Undo']
    ])
    // A second close: one toast at a time on the cards, the newer sends the older off.
    closeWithUndo({ tabs: [b], settings: UNLOAD, activeTabId: 'b', close: () => undefined })
    core.file(entry(b, Date.now()))
    await flush()
    expect(uiStore.get().toasts.map((t) => [t.message, Boolean(t.leaving)])).toEqual([
      ['Closed Zenium docs', true],
      ['Closed Release notes', false]
    ])
    // Undo from the card: the toast goes, the tab comes back.
    pickToastAction(live()[0].id)
    await flush()
    expect(core.of('session.restoreClosed')).toEqual([{ id: 'closed:b' }])
    expect(core.of('tab.activate')).toEqual([{ tabId: 'b' }])
    expect(live()).toEqual([])
  })

  it('an untouched toast leaves when its clock runs out', async () => {
    // The app's one undo keeps the ids it has taken; the core never reuses one, nor does this.
    const c = tab('c')
    closeWithUndo({ tabs: [c], settings: UNLOAD, activeTabId: 'c', close: () => undefined })
    core.file(entry(c, Date.now()))
    await flush()
    expect(live()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(TOAST_ACTION_DURATION - 1)
    expect(live()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(live()).toHaveLength(0)
    expect(core.of('session.restoreClosed')).toEqual([])
  })
})
