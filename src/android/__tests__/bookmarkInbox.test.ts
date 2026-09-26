import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Browser } from '@core/browser'
import type { WindowCreateInit } from '@core/platform'
import type { ZenWindow } from '@core/window'
import { BackgroundWork } from '@core/background/work'
import {
  BOOKMARKS_INBOX_FILE,
  BookmarkInboxDrain,
  drainedInbox,
  parseInbox,
  planDrain,
  serializeInbox,
  type InboxDrainHost,
  type InboxEntry
} from '../bookmarkInbox'
import type { Bridge } from '../bridge'
import { AndroidPlatform, BOOKMARK_INBOX_SWEEP_DELAY_MS, type BootInfo } from '../platform'

const A: InboxEntry = { url: 'https://a.example/', title: 'A', at: 1_000 }
const B: InboxEntry = { url: 'https://b.example/', title: 'B', at: 2_000 }
const C: InboxEntry = { url: 'https://c.example/', title: 'C', at: 3_000 }
const EMPTY = '{"version":1,"entries":[]}'

/** The inbox as `CustomTabBookmarks.serialize` writes it. */
const inbox = (...entries: InboxEntry[]): string => serializeInbox(entries)

describe('the inbox document', () => {
  it('reads the entries the custom tab wrote, skipping one without a URL, and none from a document that is not one', () => {
    expect(parseInbox(null)).toEqual([])
    expect(parseInbox('')).toEqual([])
    expect(parseInbox('not json')).toEqual([])
    expect(parseInbox('[]')).toEqual([])
    expect(parseInbox('{"version":1}')).toEqual([])
    expect(
      parseInbox(
        '{"version":1,"entries":[{"url":"https://a.example/","title":"A","at":1000},{"url":"","title":"x","at":2},{"title":"no url"},null,{"url":"https://c.example/"}]}'
      )
    ).toEqual([A, { url: 'https://c.example/', title: '', at: 0 }])
  })

  it('serializes in the shape the custom tab reads back', () => {
    expect(serializeInbox([A])).toBe(
      '{"version":1,"entries":[{"url":"https://a.example/","title":"A","at":1000}]}'
    )
    expect(serializeInbox([])).toBe(EMPTY)
    expect(parseInbox(serializeInbox([B, A]))).toEqual([B, A])
  })
})

describe('planDrain', () => {
  it('creates in filing order, whatever order the file holds', () => {
    expect(planDrain([C, A, B], () => false)).toEqual([A, B, C])
  })

  it('keeps the file’s order for entries filed in the same millisecond', () => {
    const b = { ...B, at: A.at }
    expect(planDrain([b, A], () => false)).toEqual([b, A])
  })

  it('makes one bookmark of two entries of one URL: the first filed', () => {
    const again = { url: A.url, title: 'A again', at: 5_000 }
    expect(planDrain([again, B, A], () => false)).toEqual([A, B])
  })

  it('creates nothing the tree already holds, and asks the tree once per URL', () => {
    const has = vi.fn((url: string) => url === B.url)
    expect(planDrain([A, B, { ...B, at: 9_000 }, C], has)).toEqual([A, C])
    expect(has.mock.calls.map(([url]) => url)).toEqual([A.url, B.url, C.url])
  })
})

describe('drainedInbox', () => {
  it('empties the URLs a pass read and keeps an entry filed since', () => {
    expect(drainedInbox([A, B, C], new Set([A.url, B.url]))).toEqual([C])
    expect(drainedInbox([A, B], new Set([A.url, B.url]))).toEqual([])
  })

  it('is nothing to write when none of what was read is still there', () => {
    expect(drainedInbox([], new Set([A.url]))).toBeNull()
    expect(drainedInbox([C], new Set([A.url, B.url]))).toBeNull()
  })
})

/**
 * A host over a disk and a tree: `disk` is the inbox's text (null: no document), `tree` the
 * URLs bookmarked; `created` records the creates in order; `writes` the inbox's texts written.
 */
function fakeHost(
  text: string | null,
  bookmarked: string[] = []
): {
  host: InboxDrainHost
  state: { disk: string | null }
  tree: Set<string>
  created: InboxEntry[]
  writes: string[]
} {
  const state: { disk: string | null } = { disk: text }
  const tree = new Set(bookmarked)
  const created: InboxEntry[] = []
  const writes: string[] = []
  const host: InboxDrainHost = {
    readInbox: () => state.disk,
    writeInbox: async (next) => {
      writes.push(next)
      state.disk = next
    },
    has: (url) => tree.has(url),
    create: (entry) => {
      created.push(entry)
      tree.add(entry.url)
      return true
    }
  }
  return { host, state, tree, created, writes }
}

describe('BookmarkInboxDrain', () => {
  it('creates every filed page the tree does not hold, in filing order, and empties the inbox', async () => {
    const { host, created, writes, state } = fakeHost(inbox(B, A))
    await new BookmarkInboxDrain(host).request()
    expect(created).toEqual([A, B])
    expect(writes).toEqual([EMPTY])
    expect(state.disk).toBe(EMPTY)
  })

  it('does nothing with an absent or empty inbox: no create, no write', async () => {
    for (const text of [null, EMPTY, '{"version":1,"entries":[{"url":""}]}']) {
      const { host, created, writes } = fakeHost(text)
      await new BookmarkInboxDrain(host).request()
      expect(created).toEqual([])
      expect(writes).toEqual([])
    }
  })

  it('creates nothing for an entry withdrawn before the pass: the custom tab took it out of the inbox', async () => {
    const { host, state, created, writes } = fakeHost(inbox(A, B))
    // The second press on the star, before the browser ran: the entry is gone from the file.
    state.disk = inbox(A)
    await new BookmarkInboxDrain(host).request()
    expect(created).toEqual([A])
    expect(writes).toEqual([EMPTY])
  })

  it('creates nothing for a page the tree already holds (starred in the browser too), and empties it as well', async () => {
    const { host, created, writes } = fakeHost(inbox(A, B), [B.url])
    await new BookmarkInboxDrain(host).request()
    expect(created).toEqual([A])
    expect(writes).toEqual([EMPTY])
  })

  it('makes no second bookmark when the last pass was cut short between its creates and its emptying', async () => {
    const first = fakeHost(inbox(A, B))
    first.host.writeInbox = async () => {
      throw new Error('the process was killed')
    }
    await expect(new BookmarkInboxDrain(first.host).request()).rejects.toThrow('killed')
    expect(first.created).toEqual([A, B])
    // The next launch: the bookmarks landed, the inbox still holds both.
    const next = fakeHost(first.state.disk, [...first.tree])
    await new BookmarkInboxDrain(next.host).request()
    expect(next.created).toEqual([])
    expect(next.writes).toEqual([EMPTY])
  })

  it('keeps an entry the custom tab filed while the pass ran, and drains it on the pass asked for meanwhile', async () => {
    const { host, state, created, writes } = fakeHost(inbox(A))
    const drain = new BookmarkInboxDrain(host)
    let filedC = false
    host.create = (entry) => {
      created.push(entry)
      if (!filedC) {
        // Split screen: the custom tab files C as the browser creates A.
        state.disk = inbox(A, C)
        filedC = true
      }
      return true
    }
    const passOne = drain.request()
    // Asked again while running (a second return to the front): folded into one more pass.
    const passTwo = drain.request()
    expect(passTwo).toBe(passOne)
    await passOne
    expect(created).toEqual([A, C])
    expect(writes).toEqual([inbox(C), EMPTY])
  })

  it('leaves out an entry the core refused rather than carrying it forever, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { host, writes } = fakeHost(inbox(A))
    host.create = () => false
    await new BookmarkInboxDrain(host).request()
    expect(writes).toEqual([EMPTY])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(A.url))
    warn.mockRestore()
  })
})

/** What `Browser.start` hands the factory; the Android host reads none of it. */
const INIT = {} as WindowCreateInit

const BOOT: BootInfo = {
  version: '0.0.0-test',
  sdkInt: 34,
  signer: null,
  packageName: null,
  files: {},
  downloadsDir: '/sdcard/Download',
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
  fullscreen: false
}

/** A bridge over `disk`, as the Kotlin host: `storage.read` answers it, `storage.write` lands. */
function fakeBridge(disk: Record<string, string>): { bridge: Bridge; writes: string[] } {
  const writes: string[] = []
  const answer = (method: string, args: Record<string, unknown>): unknown => {
    const name = String(args.name)
    if (method === 'storage.read') return disk[name] ?? null
    if (method === 'storage.write') {
      writes.push(String(args.text))
      disk[name] = String(args.text)
    }
    return null
  }
  const bridge = {
    call: async (method: string, args: Record<string, unknown>) => answer(method, args),
    callSync: (method: string, args: Record<string, unknown>) => answer(method, args),
    send: () => undefined
  } as unknown as Bridge
  return { bridge, writes }
}

/**
 * The platform with the boot payload's copy of the inbox, a browser whose tree holds `held`
 * and whose `bookmark.create` is recorded, and the window `Browser.start` would create.
 */
function booted(
  inboxText: string | null,
  held: string[] = []
): {
  platform: AndroidPlatform
  background: BackgroundWork
  handleCommand: ReturnType<
    typeof vi.fn<(win: ZenWindow, name: string, args: { url: string }) => unknown>
  >
  disk: Record<string, string>
  writes: string[]
  files: Record<string, string>
  win: ZenWindow
} {
  const disk: Record<string, string> = {}
  if (inboxText !== null) disk[BOOKMARKS_INBOX_FILE] = inboxText
  const { bridge, writes } = fakeBridge(disk)
  const files: Record<string, string> = { 'state.json': '{}' }
  if (inboxText !== null) files[BOOKMARKS_INBOX_FILE] = inboxText
  const platform = new AndroidPlatform(bridge, { ...BOOT, files })
  const tree = new Set(held)
  const handleCommand = vi.fn((_win: ZenWindow, name: string, args: { url: string }) => {
    if (name !== 'bookmark.create') throw new Error(`Unknown command: ${name}`)
    tree.add(args.url)
    return { id: 'bm_new', url: args.url }
  })
  const background = new BackgroundWork()
  const browser = {
    background,
    bookmarks: { has: (url: string) => tree.has(url) },
    handleCommand
  }
  platform.bind(browser as unknown as Browser)
  const win = {
    id: 1,
    onChromeReady: vi.fn(),
    onFocused: vi.fn(),
    onWindowStateChanged: vi.fn()
  } as unknown as ZenWindow
  return { platform, background, handleCommand, disk, writes, files, win }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the platform’s drain of the inbox', () => {
  it('runs a startup sweep once the core has its window, and reads the boot copy without a bridge call', async () => {
    vi.useFakeTimers()
    const { platform, handleCommand, disk, writes, files, win } = booted(inbox(A))
    // The payload's copy is the drain's, not the mirror's.
    expect(files).toEqual({ 'state.json': '{}' })
    platform.windows.create(win, INIT)
    vi.advanceTimersByTime(BOOKMARK_INBOX_SWEEP_DELAY_MS - 1)
    expect(handleCommand).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(handleCommand).toHaveBeenCalledTimes(1)
    expect(handleCommand.mock.calls[0]!.slice(1)).toEqual([
      'bookmark.create',
      { title: 'A', url: A.url, type: 'url' }
    ])
    await vi.runAllTimersAsync()
    expect(writes).toEqual([EMPTY])
    expect(disk[BOOKMARKS_INBOX_FILE]).toBe(EMPTY)
  })

  it('runs again each time the app comes back to the front, from the disk as the custom tab left it', async () => {
    vi.useFakeTimers()
    // The focus cue also ends a cut-short gesture on the chrome document (`zen-resume`).
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
    const { platform, handleCommand, disk, writes, win } = booted(null)
    platform.windows.create(win, INIT)
    // The cold start's own focus, before the sweep: nothing runs yet.
    platform.hostEvent('focus', { focused: true })
    expect(handleCommand).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(BOOKMARK_INBOX_SWEEP_DELAY_MS)
    expect(handleCommand).not.toHaveBeenCalled()
    expect(writes).toEqual([])
    // A custom tab's star filed two pages; the browser returns to the front.
    disk[BOOKMARKS_INBOX_FILE] = inbox(B, A)
    platform.hostEvent('focus', { focused: false })
    expect(handleCommand).not.toHaveBeenCalled()
    platform.hostEvent('focus', { focused: true })
    await vi.runAllTimersAsync()
    expect(handleCommand.mock.calls.map(([, , args]) => args.url)).toEqual([A.url, B.url])
    expect(writes).toEqual([EMPTY])
    // Back again with nothing filed: a read, no create, no write.
    platform.hostEvent('focus', { focused: true })
    await vi.runAllTimersAsync()
    expect(handleCommand).toHaveBeenCalledTimes(2)
    expect(writes).toEqual([EMPTY])
  })

  it('makes no second bookmark of a page the tree holds, and empties its entry', async () => {
    vi.useFakeTimers()
    const { platform, handleCommand, writes, win } = booted(inbox(A, B), [A.url])
    platform.windows.create(win, INIT)
    await vi.advanceTimersByTimeAsync(BOOKMARK_INBOX_SWEEP_DELAY_MS)
    expect(handleCommand.mock.calls.map(([, , args]) => args.url)).toEqual([B.url])
    expect(writes).toEqual([EMPTY])
  })

  it('waits for the demo harness’s hold like the other startup sweeps', async () => {
    vi.useFakeTimers()
    const disk: Record<string, string> = { [BOOKMARKS_INBOX_FILE]: inbox(A) }
    const { bridge, writes } = fakeBridge(disk)
    const platform = new AndroidPlatform(bridge, {
      ...BOOT,
      files: { [BOOKMARKS_INBOX_FILE]: inbox(A) },
      holdBackgroundWork: true
    })
    const background = new BackgroundWork({ hold: platform.performance.holdBackgroundWork })
    const handleCommand = vi.fn(() => ({ id: 'bm_new' }))
    platform.bind({
      background,
      bookmarks: { has: () => false },
      handleCommand
    } as unknown as Browser)
    platform.windows.create({ id: 1, onChromeReady: vi.fn() } as unknown as ZenWindow, INIT)
    await vi.advanceTimersByTimeAsync(BOOKMARK_INBOX_SWEEP_DELAY_MS * 4)
    expect(handleCommand).not.toHaveBeenCalled()
    platform.hostEvent('background.release', undefined)
    await vi.runAllTimersAsync()
    expect(handleCommand).toHaveBeenCalledTimes(1)
    expect(writes).toEqual([EMPTY])
    background.stop()
  })
})
