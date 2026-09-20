import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  HostCapabilities,
  NavigationSnapshot,
  Platform as PlatformOs,
  Tab
} from '../../shared/types'
import { PRIVATE_CONTAINER_ID } from '../../shared/types'
import { Browser } from '../browser'
import { createTabRecord } from '../model'
import {
  closedNavigationOf,
  closedTabIds,
  NAVIGATION_STATE_INDEX,
  NAVIGATION_STATE_WRITE_DELAY_MS,
  navigationDocumentName,
  navigationListFingerprint,
  NavigationStateStore,
  withoutClosedHostState,
  withoutHostState,
  type NavigationStateDocument,
  type NavigationStateIndex
} from '../navigationState'
import type {
  AppHost,
  MenuHost,
  Platform,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'
import {
  closedTabEntry,
  closedWindowEntry,
  NAVIGATION_HOST_STATE_MAX_CHARS,
  RECENTLY_CLOSED_MAX
} from '../session'
import { BrowserState, type Persisted } from '../state'
import type { ZenWindow } from '../window'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface MemoryIo extends StoreIO {
  files: Record<string, string>
  /** Every host call in order: `write name`, `writeSync name`, `remove name`. */
  log: string[]
  /** The document names under `navigation/` right now. */
  documents(): string[]
}

function memoryIo(initial: Record<string, string> = {}): MemoryIo {
  const files: Record<string, string> = { ...initial }
  const log: string[] = []
  return {
    files,
    log,
    documents: () =>
      Object.keys(files)
        .filter((name) => name.startsWith('navigation/'))
        .sort(),
    readSync: (name) => files[name] ?? null,
    write: async (name, text) => {
      files[name] = text
      log.push(`write ${name}`)
    },
    writeSync: (name, text) => {
      files[name] = text
      log.push(`writeSync ${name}`)
    },
    remove: async (name) => {
      delete files[name]
      log.push(`remove ${name}`)
    }
  }
}

const blob = 'cGFyY2Vs'.repeat(64)

const stack: NavigationSnapshot = {
  entries: [
    { url: 'https://example.com/', title: 'Home', pageState: 'c2Nyb2xs' },
    { url: 'https://example.com/article', title: 'Article' }
  ],
  index: 1
}
const withHost: NavigationSnapshot = { ...stack, hostState: blob }

function document(io: MemoryIo, tabId: string): NavigationStateDocument | null {
  const text = io.files[navigationDocumentName(tabId)]
  return text === undefined ? null : (JSON.parse(text) as NavigationStateDocument)
}

function index(io: MemoryIo): string[] | null {
  const text = io.files[NAVIGATION_STATE_INDEX]
  return text === undefined ? null : (JSON.parse(text) as NavigationStateIndex).ids
}

function persisted(io: MemoryIo): Persisted {
  return JSON.parse(io.files['state.json'] ?? '{}') as Persisted
}

/** Anything the browser touches on the host answers with a harmless no-op. */
function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

interface FakeView {
  readonly tabId: string
  readonly events: TabViewEvents
  view: TabView
  destroyed: boolean
  /** What `navigationEntries()` reports; tests script the page's stack here. */
  snapshot: NavigationSnapshot
  /** Every stack the host was asked to replay. */
  restored: NavigationSnapshot[]
}

function fakeView(tab: Tab, events: TabViewEvents): FakeView {
  let url = ''
  const fake: FakeView = {
    tabId: tab.id,
    events,
    destroyed: false,
    snapshot: { entries: [], index: -1 },
    restored: [],
    view: undefined as unknown as TabView
  }
  const overrides: Partial<TabView> = {
    isDestroyed: () => fake.destroyed,
    destroy: () => {
      fake.destroyed = true
    },
    loadURL: (u) => {
      url = u
    },
    getURL: () => url,
    getTitle: () => (url ? 'Page title' : ''),
    hasDocument: () => url !== '',
    canGoBack: () => false,
    canGoForward: () => false,
    getZoom: () => 1,
    isCurrentlyAudible: () => false,
    navigationEntries: () => fake.snapshot,
    restoreNavigation: async (snapshot) => {
      fake.restored.push(snapshot)
      url = snapshot.entries[snapshot.index]?.url ?? ''
    }
  }
  fake.view = new Proxy(overrides as TabView, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
  return fake
}

interface Fixture {
  browser: Browser
  win: ZenWindow
  views: FakeView[]
  viewOf(tabId: string): FakeView
}

/** A browser on `io`; a second fixture on the same `io` is a relaunch. */
function fixture(io: MemoryIo, os: PlatformOs = 'android'): Fixture {
  const views: FakeView[] = []
  const capabilities = stub<HostCapabilities>({ windows: true, updates: false, agents: false })
  const platform: Platform = {
    info: { os, version: '0.0.0' },
    capabilities,
    io,
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true
        })
    },
    views: stub<TabViewHost>({
      createView: (tab, events) => {
        const fake = fakeView(tab, events)
        views.push(fake)
        return fake.view
      }
    }),
    menus: stub<MenuHost>(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub<AppHost>(),
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  const win = browser.allWindows()[0]
  if (!win) throw new Error('no window')
  return {
    browser,
    win,
    views,
    viewOf: (tabId) => {
      const v = [...views].reverse().find((x) => x.tabId === tabId)
      if (!v) throw new Error(`no view for ${tabId}`)
      return v
    }
  }
}

/** A page that navigated to the end of `snapshot`: the core remembers the stack. */
function navigated(f: Fixture, tabId: string, snapshot: NavigationSnapshot): void {
  const view = f.viewOf(tabId)
  view.snapshot = snapshot
  view.events.onNavigated(snapshot.entries[snapshot.index].url, false)
}

function flushed(f: Fixture): Promise<void> {
  return f.browser.state.flush()
}

// ---------------------------------------------------------------------------
// The store on its own
// ---------------------------------------------------------------------------

describe('navigationListFingerprint', () => {
  it('names a list by its URLs in order and the index; titles and page state do not count', () => {
    const a = navigationListFingerprint(stack)
    expect(a).toMatch(/^[0-9a-f]{1,14}$/)
    expect(navigationListFingerprint(withHost)).toBe(a)
    expect(
      navigationListFingerprint({
        entries: stack.entries.map((e) => ({ url: e.url, title: 'other' })),
        index: 1
      })
    ).toBe(a)
    expect(navigationListFingerprint({ ...stack, index: 0 })).not.toBe(a)
    expect(navigationListFingerprint({ entries: [...stack.entries].reverse(), index: 1 })).not.toBe(
      a
    )
    expect(
      navigationListFingerprint({
        entries: [...stack.entries, { url: 'x:y', title: '' }],
        index: 1
      })
    ).not.toBe(a)
    // Entry boundaries are part of the name: "ab" + "c" is not "a" + "bc".
    expect(
      navigationListFingerprint({
        entries: [
          { url: 'ab', title: '' },
          { url: 'c', title: '' }
        ],
        index: 0
      })
    ).not.toBe(
      navigationListFingerprint({
        entries: [
          { url: 'a', title: '' },
          { url: 'bc', title: '' }
        ],
        index: 0
      })
    )
  })
})

describe('withoutHostState / closed-entry helpers', () => {
  it('strips the blob and leaves blob-free objects untouched (same reference)', () => {
    expect(withoutHostState(stack)).toBe(stack)
    expect(withoutHostState(null)).toBeNull()
    const stripped = withoutHostState(withHost)
    expect(stripped).toEqual(stack)
    expect(stripped).not.toHaveProperty('hostState')
    expect(withHost.hostState).toBe(blob)

    const placement = { spaceId: 's', folderId: null, index: 0, windowId: null }
    const tab = createTabRecord({ spaceId: 's', containerId: 'default', url: 'https://a.test/' })
    const other = createTabRecord({ spaceId: 's', containerId: 'default', url: 'https://b.test/' })
    const plain = closedTabEntry(tab, placement, stack, 1)
    const rich = closedTabEntry(other, placement, withHost, 2)
    const plainWindow = closedWindowEntry('synced', null, null, [plain], 3)
    const richWindow = closedWindowEntry('synced', null, null, [plain, rich], 4)
    // Nothing to strip: the very same array and entries.
    const untouched = [plain, plainWindow]
    expect(withoutClosedHostState(untouched)).toBe(untouched)
    const entries = withoutClosedHostState([rich, plain, richWindow])
    expect(entries).toHaveLength(3)
    expect(entries[1]).toBe(plain)
    expect(entries[0]).toEqual({ ...rich, navigation: stack })
    expect(entries[2].kind === 'window' && entries[2].tabs[0]).toBe(plain)
    expect(entries[2].kind === 'window' && entries[2].tabs[1]).toEqual({
      ...rich,
      navigation: stack
    })
    expect(JSON.stringify(entries)).not.toContain('hostState')
    // The in-memory entries keep their blobs.
    expect(rich.navigation?.hostState).toBe(blob)
    expect(richWindow.tabs[1].navigation?.hostState).toBe(blob)

    expect(closedTabIds([rich, plainWindow, richWindow])).toEqual([
      other.id,
      tab.id,
      tab.id,
      other.id
    ])
    expect(closedNavigationOf([plain, richWindow], other.id)).toBe(withHost)
    expect(closedNavigationOf([plain, richWindow], tab.id)).toBe(stack)
    expect(closedNavigationOf([plain], 'tab_nobody')).toBeNull()
  })
})

describe('NavigationStateStore', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function storeOn(
    io: MemoryIo,
    snapshots: Map<string, NavigationSnapshot | null>,
    delayMs?: number
  ): NavigationStateStore {
    const store = new NavigationStateStore(io, (id) => snapshots.get(id) ?? null, delayMs)
    store.load(new Set(snapshots.keys()))
    return store
  }

  it('coalesces a burst of touches into one write per tab on one timer, the index first', async () => {
    vi.useFakeTimers()
    const io = memoryIo()
    const snapshots = new Map<string, NavigationSnapshot | null>([
      ['tab_a', withHost],
      ['tab_b', { ...withHost, index: 0 }]
    ])
    const store = storeOn(io, snapshots)
    for (let i = 0; i < 10; i++) {
      store.touch('tab_a')
      store.touch('tab_b')
    }
    expect(io.log).toEqual([])
    await vi.advanceTimersByTimeAsync(NAVIGATION_STATE_WRITE_DELAY_MS - 1)
    // A touch while the timer runs rides on it; the timer is not restarted.
    store.touch('tab_a')
    expect(io.log).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(io.log).toEqual([
      `write ${NAVIGATION_STATE_INDEX}`,
      'write navigation/tab_a.json',
      'write navigation/tab_b.json'
    ])
    expect(document(io, 'tab_a')).toEqual({
      version: 1,
      list: navigationListFingerprint(stack),
      hostState: blob
    })
    expect(document(io, 'tab_b')?.list).toBe(navigationListFingerprint({ ...stack, index: 0 }))
    expect(index(io)).toEqual(['tab_a', 'tab_b'])
    // Nothing more once everything is written.
    await vi.advanceTimersByTimeAsync(NAVIGATION_STATE_WRITE_DELAY_MS * 2)
    expect(io.log).toHaveLength(3)
  })

  it('does not rewrite the same pair; a changed list or blob is written again', async () => {
    const io = memoryIo()
    const snapshots = new Map<string, NavigationSnapshot | null>([['tab_a', withHost]])
    const store = storeOn(io, snapshots)
    store.touch('tab_a')
    await store.flush()
    expect(io.log).toEqual([`write ${NAVIGATION_STATE_INDEX}`, 'write navigation/tab_a.json'])
    // The same list and blob, in another object (the host reported the stack again).
    snapshots.set('tab_a', { entries: [...withHost.entries], index: 1, hostState: `${blob}` })
    store.touch('tab_a')
    await store.flush()
    expect(io.log).toHaveLength(2)
    // A new blob for the same list.
    snapshots.set('tab_a', { ...withHost, hostState: 'bmV3' })
    store.touch('tab_a')
    await store.flush()
    expect(io.log).toEqual([
      `write ${NAVIGATION_STATE_INDEX}`,
      'write navigation/tab_a.json',
      'write navigation/tab_a.json'
    ])
    expect(document(io, 'tab_a')?.hostState).toBe('bmV3')
    // The same blob for another list.
    snapshots.set('tab_a', { ...withHost, index: 0, hostState: 'bmV3' })
    store.touch('tab_a')
    await store.flush()
    expect(io.log).toHaveLength(4)
    expect(document(io, 'tab_a')?.list).toBe(navigationListFingerprint({ ...stack, index: 0 }))
  })

  it('removes the document of a snapshot that lost its blob, and of a tab nobody holds', async () => {
    const io = memoryIo()
    const snapshots = new Map<string, NavigationSnapshot | null>([
      ['tab_a', withHost],
      ['tab_b', withHost]
    ])
    const store = storeOn(io, snapshots)
    store.touch('tab_a')
    store.touch('tab_b')
    await store.flush()
    expect(io.documents()).toEqual([
      NAVIGATION_STATE_INDEX,
      'navigation/tab_a.json',
      'navigation/tab_b.json'
    ])
    snapshots.set('tab_a', stack)
    snapshots.delete('tab_b')
    store.touch('tab_a')
    store.touch('tab_b')
    await store.flush()
    expect(io.documents()).toEqual([NAVIGATION_STATE_INDEX])
    expect(index(io)).toEqual([])
    // An id leaves the index once its removal has landed, never before: the index may name a
    // document that is gone, never miss one that is there.
    expect(io.log.slice(3)).toEqual([
      'remove navigation/tab_a.json',
      'remove navigation/tab_b.json',
      `write ${NAVIGATION_STATE_INDEX}`
    ])
    // A tab that never had a document is not removed.
    store.touch('tab_c')
    await store.flush()
    expect(io.log).toHaveLength(6)
  })

  it('a blob over the cap or an empty one counts as none', async () => {
    const io = memoryIo()
    const snapshots = new Map<string, NavigationSnapshot | null>([
      ['tab_a', { ...stack, hostState: 'x'.repeat(NAVIGATION_HOST_STATE_MAX_CHARS + 1) }],
      ['tab_b', { ...stack, hostState: '' }]
    ])
    const store = storeOn(io, snapshots)
    store.touch('tab_a')
    store.touch('tab_b')
    await store.flush()
    expect(io.log).toEqual([])
  })

  it('flushSync writes the dirty set synchronously and flush lands it asynchronously', async () => {
    vi.useFakeTimers()
    const io = memoryIo()
    const snapshots = new Map<string, NavigationSnapshot | null>([
      ['tab_a', withHost],
      ['tab_b', withHost]
    ])
    const store = storeOn(io, snapshots)
    store.touch('tab_a')
    store.flushSync()
    expect(io.log).toEqual([
      `writeSync ${NAVIGATION_STATE_INDEX}`,
      'writeSync navigation/tab_a.json'
    ])
    expect(document(io, 'tab_a')?.hostState).toBe(blob)
    store.touch('tab_b')
    await store.flush()
    expect(io.log.slice(2)).toEqual([
      `write ${NAVIGATION_STATE_INDEX}`,
      'write navigation/tab_b.json'
    ])
    // The timer a touch started is cancelled by the flush: nothing fires later.
    await vi.advanceTimersByTimeAsync(NAVIGATION_STATE_WRITE_DELAY_MS * 2)
    expect(io.log).toHaveLength(4)
    // A removal at flushSync goes asynchronously (StoreIO has no synchronous remove); the index
    // still lists the id until the removal has landed and the next fire writes it.
    snapshots.set('tab_a', stack)
    store.touch('tab_a')
    store.flushSync()
    expect(io.log).toHaveLength(4)
    await Promise.resolve()
    await Promise.resolve()
    expect(io.log.slice(4)).toEqual(['remove navigation/tab_a.json'])
    expect(index(io)).toEqual(['tab_a', 'tab_b'])
    await vi.advanceTimersByTimeAsync(NAVIGATION_STATE_WRITE_DELAY_MS)
    expect(io.log.slice(5)).toEqual([`write ${NAVIGATION_STATE_INDEX}`])
    expect(index(io)).toEqual(['tab_b'])
  })

  it('freeze stops the timer and every later write', async () => {
    vi.useFakeTimers()
    const io = memoryIo()
    const snapshots = new Map<string, NavigationSnapshot | null>([['tab_a', withHost]])
    const store = storeOn(io, snapshots)
    store.touch('tab_a')
    store.freeze()
    await vi.advanceTimersByTimeAsync(NAVIGATION_STATE_WRITE_DELAY_MS * 2)
    store.touch('tab_a')
    await store.flush()
    store.flushSync()
    expect(io.log).toEqual([])
  })

  describe('hostStateFor (the lazy join)', () => {
    function withDocument(list: string, hostState: string = blob): MemoryIo {
      return memoryIo({
        [NAVIGATION_STATE_INDEX]: JSON.stringify({ version: 1, ids: ['tab_a'] }),
        'navigation/tab_a.json': JSON.stringify({ version: 1, list, hostState })
      })
    }

    it('attaches the blob of a document that describes this very list, once per tab per run', () => {
      const io = withDocument(navigationListFingerprint(stack))
      const store = storeOn(io, new Map([['tab_a', stack]]))
      expect(store.hostStateFor('tab_a', stack)).toBe(blob)
      // Read once: a second ask in the same run gets nothing (and reads nothing).
      const reads = io.log.length
      expect(store.hostStateFor('tab_a', stack)).toBeUndefined()
      expect(io.log).toHaveLength(reads)
    })

    it('gives nothing for another list, a missing document or a corrupt one', () => {
      const other = withDocument(navigationListFingerprint({ ...stack, index: 0 }))
      expect(
        storeOn(other, new Map([['tab_a', stack]])).hostStateFor('tab_a', stack)
      ).toBeUndefined()

      const missing = memoryIo({
        [NAVIGATION_STATE_INDEX]: JSON.stringify({ version: 1, ids: ['tab_a'] })
      })
      expect(
        storeOn(missing, new Map([['tab_a', stack]])).hostStateFor('tab_a', stack)
      ).toBeUndefined()

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        for (const text of [
          'not json',
          '{}',
          JSON.stringify({ version: 2, list: navigationListFingerprint(stack), hostState: blob }),
          JSON.stringify({ version: 1, list: navigationListFingerprint(stack), hostState: '' }),
          JSON.stringify({ version: 1, list: navigationListFingerprint(stack), hostState: 7 }),
          JSON.stringify({ version: 1, hostState: blob })
        ]) {
          const io = memoryIo({
            [NAVIGATION_STATE_INDEX]: JSON.stringify({ version: 1, ids: ['tab_a'] }),
            'navigation/tab_a.json': text
          })
          expect(
            storeOn(io, new Map([['tab_a', stack]])).hostStateFor('tab_a', stack)
          ).toBeUndefined()
        }
      } finally {
        warn.mockRestore()
      }
    })

    it('finds a document the index does not list, and remembers it for a later removal', async () => {
      const io = memoryIo({
        'navigation/tab_a.json': JSON.stringify({
          version: 1,
          list: navigationListFingerprint(stack),
          hostState: blob
        })
      })
      const snapshots = new Map<string, NavigationSnapshot | null>([['tab_a', stack]])
      const store = storeOn(io, snapshots)
      expect(store.hostStateFor('tab_a', stack)).toBe(blob)
      // The list is now known to be on disk as that pair: the same pair is not written again…
      snapshots.set('tab_a', withHost)
      store.touch('tab_a')
      await store.flush()
      expect(io.log).toEqual([`write ${NAVIGATION_STATE_INDEX}`])
      expect(index(io)).toEqual(['tab_a'])
      // …and a snapshot without a blob removes it.
      snapshots.set('tab_a', stack)
      store.touch('tab_a')
      await store.flush()
      expect(io.documents()).toEqual([NAVIGATION_STATE_INDEX])
    })
  })

  describe('load (the sweep)', () => {
    it('removes the documents of ids the index lists but nothing refers to, and keeps the rest', async () => {
      const doc = JSON.stringify({ version: 1, list: 'abc', hostState: blob })
      const io = memoryIo({
        [NAVIGATION_STATE_INDEX]: JSON.stringify({
          version: 1,
          ids: ['tab_open', 'tab_closed', 'tab_gone', 'tab_lost']
        }),
        'navigation/tab_open.json': doc,
        'navigation/tab_closed.json': doc,
        'navigation/tab_gone.json': doc
      })
      const store = new NavigationStateStore(io, () => null)
      store.load(new Set(['tab_open', 'tab_closed', 'tab_never_written']))
      // Documents are never read at load: the sweep is removals only.
      expect(io.log).toEqual([])
      await store.flush()
      expect(io.log).toEqual([
        'remove navigation/tab_gone.json',
        'remove navigation/tab_lost.json',
        `write ${NAVIGATION_STATE_INDEX}`
      ])
      expect(io.documents()).toEqual([
        NAVIGATION_STATE_INDEX,
        'navigation/tab_closed.json',
        'navigation/tab_open.json'
      ])
      expect(index(io)).toEqual(['tab_closed', 'tab_open'])
    })

    it('a missing or corrupt index means nothing to sweep, and no index is written for nothing', async () => {
      const doc = JSON.stringify({ version: 1, list: 'abc', hostState: blob })
      for (const text of [
        undefined,
        'oops',
        '{"version":1}',
        JSON.stringify({ version: 1, ids: 'x' })
      ]) {
        const files: Record<string, string> = { 'navigation/tab_gone.json': doc }
        if (text !== undefined) files[NAVIGATION_STATE_INDEX] = text
        const io = memoryIo(files)
        const store = new NavigationStateStore(io, () => null)
        store.load(new Set())
        await store.flush()
        expect(io.log).toEqual([])
        expect(io.files['navigation/tab_gone.json']).toBe(doc)
      }
    })

    it('ids that are not file names never become documents, whichever way they arrive', async () => {
      const io = memoryIo({
        [NAVIGATION_STATE_INDEX]: JSON.stringify({ version: 1, ids: ['../evil', 'tab_ok', 7] })
      })
      const snapshots = new Map<string, NavigationSnapshot | null>([
        ['tab_ok', withHost],
        ['../evil', withHost],
        ['a/b', withHost]
      ])
      const store = new NavigationStateStore(io, (id) => snapshots.get(id) ?? null)
      store.load(new Set(['tab_ok', '../evil', 'a/b']))
      store.touch('../evil')
      store.touch('a/b')
      store.touch('tab_ok')
      await store.flush()
      expect(io.documents()).toEqual([NAVIGATION_STATE_INDEX, 'navigation/tab_ok.json'])
      expect(index(io)).toEqual(['tab_ok'])
      expect(store.hostStateFor('../evil', stack)).toBeUndefined()
    })

    it('reads nothing at load (the boot path): the index comes in at the first fire, once', async () => {
      vi.useFakeTimers()
      const io = memoryIo({
        [NAVIGATION_STATE_INDEX]: JSON.stringify({ version: 1, ids: ['tab_gone'] }),
        'navigation/tab_gone.json': JSON.stringify({ version: 1, list: 'abc', hostState: blob })
      })
      const reads: string[] = []
      const counted = {
        ...io,
        readSync: (name: string) => {
          reads.push(name)
          return io.readSync(name)
        }
      } as MemoryIo
      const snapshots = new Map<string, NavigationSnapshot | null>([['tab_a', withHost]])
      const store = new NavigationStateStore(counted, (id) => snapshots.get(id) ?? null)
      store.load(new Set(['tab_a']))
      expect(reads).toEqual([])
      expect(io.log).toEqual([])
      // A run in which nothing is touched sweeps nothing: the next one does.
      await vi.advanceTimersByTimeAsync(NAVIGATION_STATE_WRITE_DELAY_MS * 2)
      expect(reads).toEqual([])
      store.touch('tab_a')
      await vi.advanceTimersByTimeAsync(NAVIGATION_STATE_WRITE_DELAY_MS)
      expect(reads).toEqual([NAVIGATION_STATE_INDEX])
      expect(io.log).toEqual([
        `write ${NAVIGATION_STATE_INDEX}`,
        'remove navigation/tab_gone.json',
        'write navigation/tab_a.json'
      ])
      // The orphan stayed listed until its removal landed; the index shrinks at the fire after.
      expect(index(io)).toEqual(['tab_a', 'tab_gone'])
      await vi.advanceTimersByTimeAsync(NAVIGATION_STATE_WRITE_DELAY_MS)
      expect(index(io)).toEqual(['tab_a'])
      expect(reads).toEqual([NAVIGATION_STATE_INDEX])
      store.touch('tab_a')
      await vi.advanceTimersByTimeAsync(NAVIGATION_STATE_WRITE_DELAY_MS)
      expect(reads).toEqual([NAVIGATION_STATE_INDEX])
      expect(io.log).toHaveLength(4)
    })

    it('a document written while its removal is in flight stays in the index', async () => {
      const io = memoryIo()
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const remove = io.remove
      if (!remove) throw new Error('the fixture removes')
      const slow = {
        ...io,
        remove: async (name: string) => {
          await gate
          await remove(name)
        }
      } as MemoryIo
      const snapshots = new Map<string, NavigationSnapshot | null>([['tab_a', withHost]])
      const store = new NavigationStateStore(slow, (id) => snapshots.get(id) ?? null)
      store.load(new Set())
      store.touch('tab_a')
      await store.flush()
      expect(index(io)).toEqual(['tab_a'])
      // The blob goes: a removal starts and hangs. Then a new blob arrives for the same tab.
      snapshots.set('tab_a', stack)
      store.touch('tab_a')
      const pending = store.flush()
      snapshots.set('tab_a', { ...withHost, hostState: 'bmV3' })
      store.touch('tab_a')
      const later = store.flush()
      release()
      await pending
      await later
      expect(document(io, 'tab_a')?.hostState).toBe('bmV3')
      expect(index(io)).toEqual(['tab_a'])
      expect(io.log.slice(2)).toEqual([
        'remove navigation/tab_a.json',
        'write navigation/tab_a.json'
      ])
    })
  })

  it('a snapshot without a blob (desktop) writes nothing and creates no folder', async () => {
    const io = memoryIo()
    const snapshots = new Map<string, NavigationSnapshot | null>([
      ['tab_a', stack],
      ['tab_b', { entries: [{ url: 'https://b.test/', title: '' }], index: 0 }]
    ])
    const store = storeOn(io, snapshots)
    store.touch('tab_a')
    store.touch('tab_b')
    await store.flush()
    store.touch('tab_a')
    store.flushSync()
    expect(store.hostStateFor('tab_a', stack)).toBeUndefined()
    expect(io.log).toEqual([])
    expect(io.documents()).toEqual([])
  })

  it('a failed write is tried again at the next fire', async () => {
    const io = memoryIo()
    const failing = { ...io, write: async () => Promise.reject(new Error('disk full')) } as MemoryIo
    const snapshots = new Map<string, NavigationSnapshot | null>([['tab_a', withHost]])
    const store = new NavigationStateStore(failing, (id) => snapshots.get(id) ?? null)
    store.load(new Set(['tab_a']))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      store.touch('tab_a')
      await store.flush()
      expect(io.documents()).toEqual([])
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
    failing.write = io.write
    store.touch('tab_a')
    await store.flush()
    expect(io.documents()).toEqual([NAVIGATION_STATE_INDEX, 'navigation/tab_a.json'])
  })
})

// ---------------------------------------------------------------------------
// Through BrowserState: state.json stays blob-free
// ---------------------------------------------------------------------------

function stateOn(io: MemoryIo): BrowserState {
  const s = new BrowserState(io, 'linux', {} as HostCapabilities, '0.0')
  s.load()
  return s
}

/** An open tab in the state's first space. */
function openTab(s: BrowserState, url: string, containerId = 'default'): Tab {
  const space = s.model.spaces[0]
  const tab = createTabRecord({ spaceId: space.id, containerId, url })
  s.model.tabs[tab.id] = tab
  space.tabIds.push(tab.id)
  return tab
}

const placement = { spaceId: null, folderId: null, index: 0, windowId: null }

describe('state.json without host state', () => {
  it('strips the blob of open tabs, closed tabs and a closed window’s tabs; memory keeps it', async () => {
    const io = memoryIo()
    const s = stateOn(io)
    const open = openTab(s, 'https://example.com/article')
    s.tabNavigation.set(open.id, withHost)
    const closedTab = createTabRecord({
      spaceId: null,
      containerId: 'default',
      url: 'https://c.test/'
    })
    const windowTab = createTabRecord({
      spaceId: null,
      containerId: 'default',
      url: 'https://w.test/'
    })
    const closed = closedTabEntry(closedTab, placement, withHost, 5)
    const window = closedWindowEntry(
      'synced',
      null,
      null,
      [closedTabEntry(windowTab, placement, withHost, 6)],
      7
    )
    s.recentlyClosed = [closed, window]
    for (const id of [open.id, closedTab.id, windowTab.id]) s.navigationState.touch(id)
    await s.flush()

    const written = persisted(io)
    expect(io.files['state.json']).not.toContain('hostState')
    expect(io.files['state.json']).not.toContain(blob)
    expect(written.navigation).toEqual({ [open.id]: stack })
    const [tabEntry, windowEntry] = written.recentlyClosed ?? []
    expect(tabEntry.kind === 'tab' && tabEntry.navigation).toEqual(stack)
    expect(windowEntry.kind === 'window' && windowEntry.tabs[0].navigation).toEqual(stack)
    // In memory the whole snapshots are as they were.
    expect(s.tabNavigation.get(open.id)).toBe(withHost)
    expect(s.recentlyClosed[0].kind === 'tab' && s.recentlyClosed[0].navigation).toBe(withHost)
    expect(s.recentlyClosed[1].kind === 'window' && s.recentlyClosed[1].tabs[0].navigation).toBe(
      withHost
    )
    // Each has a document of its own, and the index names the three.
    expect(index(io)).toEqual([open.id, closedTab.id, windowTab.id].sort())
    for (const id of [open.id, closedTab.id, windowTab.id])
      expect(document(io, id)).toEqual({
        version: 1,
        list: navigationListFingerprint(stack),
        hostState: blob
      })
    // A relaunch reads the stacks back without blobs, and the sweep keeps the three documents.
    const again = stateOn(io)
    expect(again.tabNavigation.get(open.id)).toEqual(stack)
    await again.navigationState.flush()
    expect(io.documents()).toHaveLength(4)
  })

  it('a private tab’s stack has no document, and a closed tab’s goes with its entry', async () => {
    const io = memoryIo()
    const s = stateOn(io)
    const priv = openTab(s, 'https://secret.test/', PRIVATE_CONTAINER_ID)
    s.tabNavigation.set(priv.id, withHost)
    s.navigationState.touch(priv.id)
    await s.flush()
    expect(io.documents()).toEqual([])
    expect(s.tabNavigation.has(priv.id)).toBe(false)

    const gone = createTabRecord({ spaceId: null, containerId: 'default', url: 'https://c.test/' })
    s.recentlyClosed = [closedTabEntry(gone, placement, withHost, 5)]
    s.navigationState.touch(gone.id)
    await s.flush()
    expect(io.documents()).toEqual([NAVIGATION_STATE_INDEX, navigationDocumentName(gone.id)])
    s.recentlyClosed = []
    s.navigationState.touch(gone.id)
    await s.flush()
    expect(io.documents()).toEqual([NAVIGATION_STATE_INDEX])
    expect(index(io)).toEqual([])
  })

  it('a stack whose tab is gone is dropped from state.json and its document with it', async () => {
    const io = memoryIo()
    const s = stateOn(io)
    const tab = openTab(s, 'https://example.com/article')
    s.tabNavigation.set(tab.id, withHost)
    s.navigationState.touch(tab.id)
    await s.flush()
    expect(io.documents()).toContain(navigationDocumentName(tab.id))
    delete s.model.tabs[tab.id]
    s.model.spaces[0].tabIds = []
    await s.flush()
    expect(persisted(io).navigation).toEqual({})
    expect(io.documents()).toEqual([NAVIGATION_STATE_INDEX])
  })

  it('the load sweep removes orphans the index lists and leaves what state.json refers to', async () => {
    const io = memoryIo()
    const first = stateOn(io)
    const open = openTab(first, 'https://example.com/article')
    first.tabNavigation.set(open.id, withHost)
    const closedTab = createTabRecord({
      spaceId: null,
      containerId: 'default',
      url: 'https://c.test/'
    })
    first.recentlyClosed = [closedTabEntry(closedTab, placement, withHost, 5)]
    first.navigationState.touch(open.id)
    first.navigationState.touch(closedTab.id)
    await first.flush()
    // Two documents state.json no longer knows of (their tab closed and evicted while nothing
    // was written), one of them in the index, one not.
    const doc = JSON.stringify({ version: 1, list: 'abc', hostState: blob })
    io.files['navigation/tab_orphan.json'] = doc
    io.files['navigation/tab_unlisted.json'] = doc
    io.files[NAVIGATION_STATE_INDEX] = JSON.stringify({
      version: 1,
      ids: [open.id, closedTab.id, 'tab_orphan']
    })
    io.log.length = 0

    const second = stateOn(io)
    expect(io.log).toEqual([])
    await second.navigationState.flush()
    expect(io.documents()).toEqual(
      [
        NAVIGATION_STATE_INDEX,
        navigationDocumentName(open.id),
        navigationDocumentName(closedTab.id),
        'navigation/tab_unlisted.json'
      ].sort()
    )
    expect(index(io)).toEqual([open.id, closedTab.id].sort())
  })

  it('40 open tabs with 64 KB blobs: state.json stays under 64 KB with every URL; one document each', async () => {
    const io = memoryIo()
    const s = stateOn(io)
    const ids: string[] = []
    for (let i = 0; i < 40; i++) {
      const tab = openTab(s, `https://site${i}.example/articles/${i}`)
      ids.push(tab.id)
      s.tabNavigation.set(tab.id, {
        entries: [
          { url: `https://site${i}.example/`, title: `Site ${i}` },
          { url: `https://site${i}.example/articles/${i}`, title: `Article ${i}` }
        ],
        index: 1,
        hostState: String.fromCharCode(65 + (i % 26)).repeat(NAVIGATION_HOST_STATE_MAX_CHARS)
      })
      s.navigationState.touch(tab.id)
    }
    await s.flush()
    const text = io.files['state.json']
    expect(text.length).toBeLessThan(64 * 1024)
    const written = persisted(io)
    expect(Object.keys(written.navigation ?? {})).toHaveLength(40)
    for (let i = 0; i < 40; i++) {
      expect(written.navigation?.[ids[i]]?.entries.map((e) => e.url)).toEqual([
        `https://site${i}.example/`,
        `https://site${i}.example/articles/${i}`
      ])
    }
    expect(text).not.toContain('hostState')
    const documents = io.documents().filter((name) => name !== NAVIGATION_STATE_INDEX)
    expect(documents).toEqual(ids.map(navigationDocumentName).sort())
    for (const name of documents) {
      const roundTrip = JSON.stringify(JSON.parse(io.files[name]) as NavigationStateDocument)
      expect(roundTrip.length).toBeLessThan(66 * 1024)
      expect(roundTrip.length).toBeGreaterThan(NAVIGATION_HOST_STATE_MAX_CHARS)
    }
    expect(index(io)).toEqual([...ids].sort())
  })
})

// ---------------------------------------------------------------------------
// Through the browser: the hooks in tabs.ts and session.ts
// ---------------------------------------------------------------------------

describe('host state documents across the tab lifecycle', () => {
  it('a navigated page’s blob gets a document; the stack in state.json goes without it', async () => {
    const io = memoryIo()
    const f = fixture(io)
    const tab = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, f.win)
    navigated(f, tab.id, withHost)
    expect(f.browser.state.tabNavigation.get(tab.id)).toBe(withHost)
    await flushed(f)
    expect(document(io, tab.id)).toEqual({
      version: 1,
      list: navigationListFingerprint(stack),
      hostState: blob
    })
    expect(index(io)).toEqual([tab.id])
    expect(persisted(io).navigation?.[tab.id]).toEqual(stack)
    expect(io.files['state.json']).not.toContain(blob)

    // The page reports the same list and blob again: nothing is rewritten.
    const writes = io.log.length
    navigated(f, tab.id, { ...withHost })
    await flushed(f)
    expect(io.log.filter((l) => l.endsWith(navigationDocumentName(tab.id)))).toHaveLength(1)
    expect(io.log.length).toBeGreaterThanOrEqual(writes)

    // The blob goes (the host has none for this list any more): so does the document.
    navigated(f, tab.id, stack)
    await flushed(f)
    expect(io.documents()).toEqual([NAVIGATION_STATE_INDEX])
  })

  it('a closed tab keeps its document while “Recently closed” holds it; clearing the list removes it', async () => {
    const io = memoryIo()
    const f = fixture(io)
    const tab = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, f.win)
    navigated(f, tab.id, withHost)
    f.browser.tabs.closeTab(tab.id, true, f.win)
    await flushed(f)
    const entry = f.browser.state.recentlyClosed[0]
    expect(entry.kind === 'tab' && entry.tab.id).toBe(tab.id)
    expect(entry.kind === 'tab' && entry.navigation?.hostState).toBe(blob)
    expect(document(io, tab.id)?.hostState).toBe(blob)
    expect(io.files['state.json']).not.toContain(blob)

    f.browser.session.clearRecentlyClosed()
    await flushed(f)
    expect(io.documents()).toEqual([NAVIGATION_STATE_INDEX])
    expect(index(io)).toEqual([])
  })

  it('a closed tab evicted from the list loses its document', async () => {
    const io = memoryIo()
    const f = fixture(io)
    const tab = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, f.win)
    navigated(f, tab.id, withHost)
    f.browser.tabs.closeTab(tab.id, true, f.win)
    await flushed(f)
    expect(document(io, tab.id)?.hostState).toBe(blob)
    for (let i = 0; i < RECENTLY_CLOSED_MAX - 1; i++) {
      const t = createTabRecord({
        spaceId: null,
        containerId: 'default',
        url: `https://s${i}.test/`
      })
      f.browser.session.pushTab(closedTabEntry(t, placement, stack, i))
    }
    await flushed(f)
    expect(f.browser.state.recentlyClosed).toHaveLength(RECENTLY_CLOSED_MAX)
    expect(document(io, tab.id)?.hostState).toBe(blob)
    const last = createTabRecord({
      spaceId: null,
      containerId: 'default',
      url: 'https://last.test/'
    })
    f.browser.session.pushTab(closedTabEntry(last, placement, stack, 99))
    await flushed(f)
    expect(
      f.browser.state.recentlyClosed.some((e) => e.kind === 'tab' && e.tab.id === tab.id)
    ).toBe(false)
    expect(io.documents()).toEqual([NAVIGATION_STATE_INDEX])
  })

  it('a tab closed with a window keeps its document under the window entry', async () => {
    const io = memoryIo()
    const f = fixture(io)
    const second = f.browser.createWindow({ kind: 'synced', from: f.win })
    const tab = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, second)
    tab.windowId = second.id
    navigated(f, tab.id, withHost)
    f.browser.tabs.releaseWindow(second, false)
    await flushed(f)
    const entry = f.browser.state.recentlyClosed[0]
    expect(entry.kind).toBe('window')
    expect(entry.kind === 'window' && entry.tabs[0].navigation?.hostState).toBe(blob)
    expect(document(io, tab.id)?.hostState).toBe(blob)
    expect(io.files['state.json']).not.toContain(blob)
  })

  it('a private tab never writes a document', async () => {
    const io = memoryIo()
    const f = fixture(io)
    const priv = f.browser.tabs.createTab(
      { url: 'https://secret.test/', active: true, containerId: PRIVATE_CONTAINER_ID },
      f.win
    )
    navigated(f, priv.id, withHost)
    f.browser.tabs.discard(priv.id)
    await flushed(f)
    f.browser.tabs.closeTab(priv.id, true, f.win)
    await flushed(f)
    expect(io.documents()).toEqual([])
    expect(io.log.some((l) => l.includes('navigation/'))).toBe(false)
  })

  it('a graceful shutdown lands the documents synchronously and freezes the store', () => {
    const io = memoryIo()
    const f = fixture(io)
    const tab = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, f.win)
    navigated(f, tab.id, { ...withHost, index: 0 })
    // The user scrolled since: the page's state moved on, read once more at shutdown.
    f.viewOf(tab.id).snapshot = withHost
    f.browser.shutdown()
    expect(io.log).toContain(`writeSync ${navigationDocumentName(tab.id)}`)
    expect(io.log).toContain(`writeSync ${NAVIGATION_STATE_INDEX}`)
    expect(document(io, tab.id)).toEqual({
      version: 1,
      list: navigationListFingerprint(stack),
      hostState: blob
    })
    expect(persisted(io).cleanExit).toBe(true)
    // Frozen: a page reporting after the final write changes nothing on disk.
    const writes = io.log.length
    navigated(f, tab.id, { ...withHost, hostState: 'bGF0ZQ==' })
    f.browser.state.flushSync()
    expect(io.log).toHaveLength(writes)
  })

  it('a relaunch replays a restored tab with the blob when the document names its list, without it otherwise', async () => {
    const io = memoryIo()
    const first = fixture(io)
    const a = first.browser.tabs.createTab({ url: 'https://example.com/', active: true }, first.win)
    navigated(first, a.id, withHost)
    const b = first.browser.tabs.createTab(
      { url: 'https://example.com/', active: false },
      first.win
    )
    first.browser.tabs.ensureLoaded(b.id, first.win)
    navigated(first, b.id, { ...withHost, hostState: 'b2xk' })
    const c = first.browser.tabs.createTab(
      { url: 'https://example.com/', active: false },
      first.win
    )
    first.browser.tabs.ensureLoaded(c.id, first.win)
    navigated(first, c.id, { ...withHost, hostState: 'Y29ycnVwdA==' })
    first.browser.shutdown()
    expect(io.documents()).toEqual(
      [NAVIGATION_STATE_INDEX, ...[a.id, b.id, c.id].map(navigationDocumentName)].sort()
    )
    // Meanwhile b's document came to describe another list, and c's is not a document.
    io.files[navigationDocumentName(b.id)] = JSON.stringify({
      version: 1,
      list: navigationListFingerprint({ ...stack, index: 0 }),
      hostState: 'b2xk'
    })
    io.files[navigationDocumentName(c.id)] = 'not json'
    const reads = io.log.length

    const second = fixture(io)
    expect(second.browser.state.tabNavigation.get(a.id)).toEqual(stack)
    // No document is read at load: one each when the tab is restored.
    expect(io.log.slice(reads).filter((l) => l.includes('navigation/'))).toEqual([])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      for (const id of [a.id, b.id, c.id]) second.browser.tabs.ensureLoaded(id, second.win)
    } finally {
      warn.mockRestore()
    }
    expect(second.viewOf(a.id).restored).toEqual([withHost])
    expect(second.viewOf(b.id).restored).toEqual([stack])
    expect(second.viewOf(b.id).restored[0]).not.toHaveProperty('hostState')
    expect(second.viewOf(c.id).restored).toEqual([stack])
    // Restored pages report their stacks: a's is the same pair (no write), b's a new one.
    navigated(second, a.id, withHost)
    navigated(second, b.id, { ...withHost, hostState: 'bmV3' })
    navigated(second, c.id, stack)
    await flushed(second)
    expect(io.log.slice(reads).filter((l) => l.startsWith('write navigation/'))).toEqual([
      `write ${navigationDocumentName(b.id)}`,
      `write ${NAVIGATION_STATE_INDEX}`
    ])
    expect(document(io, b.id)?.hostState).toBe('bmV3')
    expect(io.log.slice(reads)).toContain(`remove ${navigationDocumentName(c.id)}`)
  })

  it('a closed tab reopened after a relaunch gets its blob back by the closed tab’s id', async () => {
    const io = memoryIo()
    const first = fixture(io)
    const tab = first.browser.tabs.createTab(
      { url: 'https://example.com/', active: true },
      first.win
    )
    navigated(first, tab.id, withHost)
    first.browser.tabs.closeTab(tab.id, true, first.win)
    first.browser.shutdown()
    expect(document(io, tab.id)?.hostState).toBe(blob)

    const second = fixture(io)
    const entry = second.browser.state.recentlyClosed[0]
    expect(entry.kind === 'tab' && entry.tab.id).toBe(tab.id)
    expect(entry.kind === 'tab' && entry.navigation).toEqual(stack)
    second.browser.session.reopenClosed(second.win)
    const reopened = second.browser.tabs.tab(tab.id)
    expect(reopened).toBeDefined()
    expect(second.viewOf(tab.id).restored).toEqual([withHost])
    // The document still describes the pending stack: the page reporting it writes nothing new.
    navigated(second, tab.id, withHost)
    await flushed(second)
    expect(io.log.filter((l) => l === `write ${navigationDocumentName(tab.id)}`)).toHaveLength(0)
    expect(document(io, tab.id)?.hostState).toBe(blob)
  })

  it('reopening under a new id: the old id’s document follows whoever holds the id now', async () => {
    const io = memoryIo()
    const f = fixture(io)
    const tab = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, f.win)
    navigated(f, tab.id, withHost)
    f.browser.tabs.closeTab(tab.id, true, f.win)
    await flushed(f)
    expect(document(io, tab.id)?.hostState).toBe(blob)
    // Another live tab has come to hold the id (nothing of its own to persist).
    const m = f.browser.state.model
    const squatter = createTabRecord({
      id: tab.id,
      spaceId: m.spaces[0].id,
      containerId: 'default',
      url: 'https://live.test/'
    })
    m.tabs[tab.id] = squatter
    m.spaces[0].tabIds.push(tab.id)

    f.browser.session.reopenClosed(f.win)
    const reopened = f.views[f.views.length - 1]
    expect(reopened.tabId).not.toBe(tab.id)
    expect(reopened.restored).toEqual([withHost])
    await flushed(f)
    // The old id's document went with the live tab's lack of a stack; the reopened tab's page
    // reporting its stack writes one under the new id.
    expect(document(io, tab.id)).toBeNull()
    navigated(f, reopened.tabId, withHost)
    await flushed(f)
    expect(io.documents()).toEqual([NAVIGATION_STATE_INDEX, navigationDocumentName(reopened.tabId)])
  })

  it('a closed tab reopened into a private window has no document', async () => {
    const io = memoryIo()
    const f = fixture(io)
    const tab = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, f.win)
    navigated(f, tab.id, withHost)
    f.browser.tabs.closeTab(tab.id, true, f.win)
    await flushed(f)
    expect(document(io, tab.id)?.hostState).toBe(blob)
    const priv = f.browser.createWindow({ kind: 'private', from: f.win })
    f.browser.session.reopenClosed(priv)
    await flushed(f)
    expect(f.browser.tabs.tab(tab.id)?.containerId).toBe(PRIVATE_CONTAINER_ID)
    expect(io.documents()).toEqual([NAVIGATION_STATE_INDEX])
  })

  it('desktop: pages without a blob write nothing under navigation/', async () => {
    const io = memoryIo()
    const f = fixture(io, 'linux')
    const tab = f.browser.tabs.createTab({ url: 'https://example.com/', active: true }, f.win)
    navigated(f, tab.id, stack)
    f.browser.tabs.discard(tab.id)
    f.browser.tabs.ensureLoaded(tab.id, f.win)
    expect(f.viewOf(tab.id).restored).toEqual([stack])
    f.browser.tabs.closeTab(tab.id, true, f.win)
    await flushed(f)
    f.browser.session.reopenClosed(f.win)
    f.browser.shutdown()
    expect(io.documents()).toEqual([])
    expect(io.log.some((l) => l.includes('navigation/'))).toBe(false)
  })
})
