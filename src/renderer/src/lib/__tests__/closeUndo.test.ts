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
 * newest first, so every tab lands at the index it held as it closed. A close of several goes
 * one page after the other in the core (`tab.closeMany`, each page's `beforeunload` heard in
 * turn), and the chrome hears which tab is closing from `closingTabIds`: the toast waits for the
 * run to end, however long it takes, and counts every tab that closed. The core here is a
 * stand-in that keeps the list newest first, fires `session.recentlyClosedChanged` as the real
 * one does, and says which tabs it has closing as the chrome's state would.
 */

/** The core as the module sees it: the list (newest first), the change event, the commands. */
class FakeCore {
  list: ClosedEntrySummary[] = []
  calls: Array<[string, unknown]> = []
  /** `UIState.closingTabIds` as the chrome last heard it. */
  closingTabIds: string[] = []
  /** How many times the module has (un)subscribed to the chrome's state. */
  stateSubscriptions = { on: 0, off: 0 }
  private listeners = new Set<(payload: undefined) => void>()
  private stateListeners = new Set<() => void>()

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

  /**
   * The core's next state reaches the chrome with these tabs closing (a `requestClose` in
   * flight for each: its page's unload check under way, or asking "Leave site?").
   */
  closing(...tabIds: string[]): void {
    this.closingTabIds = tabIds
    for (const listener of this.stateListeners) listener()
  }

  onState = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener)
    this.stateSubscriptions.on += 1
    return () => {
      this.stateListeners.delete(listener)
      this.stateSubscriptions.off += 1
    }
  }

  /** The commands of one name, in order. */
  of(name: string): unknown[] {
    return this.calls.filter(([n]) => n === name).map(([, args]) => args)
  }

  reset(): void {
    this.list = []
    this.calls = []
    this.closingTabIds = []
    this.stateSubscriptions = { on: 0, off: 0 }
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

/**
 * The async work between the event and the toast: the list read and its attribution (`ticks`
 * microtasks; an Undo of several restores each in turn and needs a few per entry).
 */
async function flush(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve()
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
    activeTabId: () => current.value,
    closingTabIds: () => core.closingTabIds,
    onState: core.onState
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

  it('a close the chrome hears nothing of past the settle time gets no toast', async () => {
    const h = harness()
    h.close([tab('a')])
    // The core never listed the tab as closing and filed nothing: the wait runs out.
    await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + 1)
    expect(h.toasts).toEqual([])
    // An entry filed after the fact is nobody's…
    core.file(entry(tab('a'), h.now.value + CLOSE_SETTLE_MS + 2))
    await flush()
    expect(h.toasts).toEqual([])
    // …and free for the next close to take, should its clock allow.
    expect(core.list).toHaveLength(1)
  })

  it('a page asking "Leave site?" holds the toast for as long as the user takes; Leave then gets it', async () => {
    const h = harness('a')
    const a = tab('a', { title: 'Draft' })
    h.close([a], 'a')
    // The core has the close in flight: the page objected, its question is up on the tab.
    core.closing('a')
    await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS * 4)
    expect(h.toasts).toEqual([])
    // Leave, well past the settle time: the tab is filed and the question is gone.
    h.now.value += CLOSE_SETTLE_MS * 4
    core.file(entry(a, h.now.value))
    core.closing()
    await flush()
    expect(h.toasts.map((t) => t.message)).toEqual(['Closed Draft'])
    h.toasts[0].action.onPick()
    await flush()
    expect(core.of('session.restoreClosed')).toEqual([{ id: 'closed:a' }])
  })

  it('Stay keeps the tab: the question goes without an entry and no toast follows', async () => {
    const h = harness()
    h.close([tab('a')])
    core.closing('a')
    await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS * 4)
    core.closing()
    await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + 1)
    expect(h.toasts).toEqual([])
  })

  it("another tab's close in flight holds nothing here", async () => {
    const h = harness()
    core.closing('other')
    h.close([tab('a')])
    await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + 1)
    expect(h.toasts).toEqual([])
    // The intent settled on its wait: an entry filed now is nobody's.
    core.file(entry(tab('a'), h.now.value + CLOSE_SETTLE_MS + 2))
    await flush()
    expect(h.toasts).toEqual([])
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

  it('what has come by the settle time is offered when the chrome hears nothing of the close; the rest is nobody’s', async () => {
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

// --- one page after the other (tab.closeMany) --------------------------------------------------

/** The seven unpinned tabs of the tab-close demo's space: a group of two, then five loose. */
const SEVEN = ['www', 'damping', 'example', 'hn', 'rfc', 'tea', 'coffee'].map((id) => tab(id))
/** What one page's unload check takes on the emulator (H-2's `ZenBack` cadence). */
const PER_TAB_MS = 1200

/**
 * The core's Close All over `tabs`: the group closes as one (`folder.close`, both entries filed
 * in the tick the command runs), then `tab.closeMany` takes the rest one page after the other
 * – each in `closingTabIds` for its unload check, filed as it goes – with `keep` kept by its
 * user's "Stay" (asked for `askMs`, then no entry). Fires the states and the events in the order
 * the core does; the fake clock moves `PER_TAB_MS` per page.
 */
async function closeAllRun(
  h: ReturnType<typeof harness>,
  tabs: Tab[],
  opts: { keep?: string; askMs?: number } = {}
): Promise<void> {
  const [w, d, ...rest] = tabs
  core.file(entry(w, h.now.value), entry(d, h.now.value))
  await flush()
  for (const t of rest) {
    core.closing(t.id)
    await flush()
    if (t.id === opts.keep) {
      // The page objects; the user reads the question, then stays. No entry, the run goes on.
      await vi.advanceTimersByTimeAsync(opts.askMs ?? CLOSE_SETTLE_MS * 3)
      h.now.value += opts.askMs ?? CLOSE_SETTLE_MS * 3
      continue
    }
    await vi.advanceTimersByTimeAsync(PER_TAB_MS)
    h.now.value += PER_TAB_MS
    core.file(entry(t, h.now.value))
    await flush()
  }
  core.closing()
  await flush()
}

describe('closing several one page after the other', () => {
  it('the toast waits for the run, however long, and counts the seven; Undo brings the seven back newest first', async () => {
    const h = harness('example')
    const close = h.close(SEVEN, 'example')
    expect(close).toHaveBeenCalledTimes(1)
    // Seven pages at ~1.2 s each is well past the settle time; nothing shows before the last.
    const before = h.toasts.length
    await closeAllRun(h, SEVEN)
    expect(before).toBe(0)
    expect(h.toasts.map((t) => t.message)).toEqual(['7 tabs closed'])
    expect(h.toasts[0].action.label).toBe('Undo')
    h.toasts[0].action.onPick()
    await flush(40)
    // Newest first, each back to the index it held as it closed; the user ends on their tab.
    expect(core.of('session.restoreClosed')).toEqual(
      [...SEVEN].reverse().map((t) => ({ id: `closed:${t.id}` }))
    )
    expect(core.of('tab.activate')).toEqual([{ tabId: 'example' }])
    expect(core.list).toEqual([])
  })

  it('no toast stands while a page of the run is still closing, even past the settle time', async () => {
    const h = harness()
    h.close(SEVEN)
    const [w, d, example, hn, ...rest] = SEVEN
    core.file(entry(w, h.now.value), entry(d, h.now.value))
    core.closing(example.id)
    await vi.advanceTimersByTimeAsync(PER_TAB_MS)
    h.now.value += PER_TAB_MS
    core.file(entry(example, h.now.value))
    // The fourth page is slow to answer (a silent page waits out the core's 5 s): the wait is
    // held all along, with three entries in – the state the fixed wait used to toast on.
    core.closing(hn.id)
    await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS * 4)
    expect(h.toasts).toEqual([])
    h.now.value += CLOSE_SETTLE_MS * 4
    core.file(entry(hn, h.now.value))
    for (const t of rest) {
      core.closing(t.id)
      await vi.advanceTimersByTimeAsync(PER_TAB_MS)
      h.now.value += PER_TAB_MS
      core.file(entry(t, h.now.value))
    }
    await flush()
    expect(h.toasts.map((t) => t.message)).toEqual(['7 tabs closed'])
  })

  it('a page kept by its user\'s "Stay" is left out of the count; the rest close and come back', async () => {
    const h = harness()
    h.close(SEVEN)
    await closeAllRun(h, SEVEN, { keep: 'rfc' })
    expect(h.toasts.map((t) => t.message)).toEqual([])
    // The run is through with six entries in; the wait for the seventh runs out.
    await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + 1)
    expect(h.toasts.map((t) => t.message)).toEqual(['6 tabs closed'])
    h.toasts[0].action.onPick()
    await flush(40)
    expect(core.of('session.restoreClosed').map((a) => (a as { id: string }).id)).toEqual(
      ['coffee', 'tea', 'hn', 'example', 'damping', 'www'].map((id) => `closed:${id}`)
    )
  })

  it("the chrome's state is watched while an intent is pending and let go after", async () => {
    const h = harness()
    expect(core.stateSubscriptions).toEqual({ on: 0, off: 0 })
    h.close(SEVEN)
    expect(core.stateSubscriptions).toEqual({ on: 1, off: 0 })
    await closeAllRun(h, SEVEN)
    expect(h.toasts.map((t) => t.message)).toEqual(['7 tabs closed'])
    expect(core.stateSubscriptions).toEqual({ on: 1, off: 1 })
    // A second close subscribes again; two pending share the one subscription.
    h.close([tab('x')])
    h.close([tab('y')])
    expect(core.stateSubscriptions).toEqual({ on: 2, off: 1 })
    await vi.advanceTimersByTimeAsync(CLOSE_SETTLE_MS + 1)
    expect(core.stateSubscriptions).toEqual({ on: 2, off: 2 })
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
