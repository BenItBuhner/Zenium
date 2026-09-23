import { describe, expect, it } from 'vitest'
import { BOOKMARKS_BAR_ID } from '../../shared/bookmarks'
import type { BookmarkNode, HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { Browser } from '../browser'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import type { ZenWindow } from '../window'

/**
 * The bookmark edits' commands as the windows hear of them (bookmarks-31): a delete tells the
 * window that made it (`bookmark.deleted`, the toast with Undo); an undo – the manager's Ctrl+Z
 * or a toast's Undo – tells every window which edit went back (`bookmark.undone`), so a toast
 * still offering that delete goes down wherever it is. A `quiet` delete (the phone panels'
 * deferred commits, whose own Undo already spoke) goes on the undo stack without a word; the
 * phone's other way to a delete, the tab row's Remove Bookmark, is told like the desktop's.
 */

function memoryIo(): StoreIO {
  const files: Record<string, string> = {}
  return {
    readSync: (name) => files[name] ?? null,
    write: async (name, text) => {
      files[name] = text
    },
    writeSync: (name, text) => {
      files[name] = text
    }
  }
}

function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

interface Sent {
  name: string
  payload: unknown
  winId: string
}

/** A desktop host with windows, or a phone-shaped one: a single window, no page tabs. */
function fixture(shape: 'desktop' | 'phone' = 'desktop'): {
  browser: Browser
  win: ZenWindow
  sent: Sent[]
} {
  const sent: Sent[] = []
  const phone = shape === 'phone'
  const platform: Platform = {
    info: { os: (phone ? 'android' : 'linux') as PlatformOs, version: '0.0.0' },
    capabilities: stub<HostCapabilities>({ windows: !phone, pageTabs: !phone }),
    io: memoryIo(),
    windows: {
      create: (win: ZenWindow) =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1600, height: 1000 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          send: (name: string, payload: unknown) => {
            sent.push({ name, payload, winId: win.id })
          }
        })
    },
    // A tab's view answers what loading it asks and records nothing (the tests are the words').
    views: stub<TabViewHost>({
      createView: () =>
        stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          getZoom: () => 1,
          executeJavaScript: () => Promise.resolve(true)
        })
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  const win = browser.focusedWindow()
  if (phone) browser.handleCommand(win, 'window.formFactor', { formFactor: 'phone' })
  return { browser, win, sent }
}

const heard = (sent: Sent[], name: string): Array<[string, unknown]> =>
  sent.filter((s) => s.name === name).map((s) => [s.winId, s.payload])

describe('bookmark.remove and bookmark.undo, as the windows hear them', () => {
  it('a delete tells its window; an undo from any window tells every window which edit went back', () => {
    const f = fixture()
    const other = f.browser.createWindow({ kind: 'synced', from: f.win })
    const create = (title: string): BookmarkNode =>
      f.browser.handleCommand(f.win, 'bookmark.create', {
        parentId: BOOKMARKS_BAR_ID,
        title,
        url: `https://${title.toLowerCase()}.test/`,
        type: 'url'
      }) as BookmarkNode
    const a = create('A')
    const b = create('B')

    f.browser.handleCommand(f.win, 'bookmark.remove', { ids: [a.id] })
    const deleted = heard(f.sent, 'bookmark.deleted')
    expect(deleted).toEqual([[f.win.id, { token: 1, count: 1, kind: 'bookmark' }]])
    expect(f.browser.bookmarks.get(a.id)).toBeNull()

    // Ctrl+Z in the other window's manager: the newest edit, this delete, goes back – and both
    // windows hear its token, so the first window's toast can go down. The answer names the
    // node under its own id (services' `restore`, #370): the manager selects the row it knew.
    const undone = f.browser.handleCommand(other, 'bookmark.undo', {})
    expect(undone).toEqual({ kind: 'remove', token: 1, ids: [a.id], parentId: BOOKMARKS_BAR_ID })
    expect(heard(f.sent, 'bookmark.undone')).toEqual([
      [f.win.id, { token: 1, kind: 'remove' }],
      [other.id, { token: 1, kind: 'remove' }]
    ])
    expect(f.browser.bookmarks.tree.children(BOOKMARKS_BAR_ID).map((n) => n.id)).toEqual([
      a.id,
      b.id
    ])
    expect(f.browser.bookmarks.get(a.id)).toEqual(a)

    // The toast's Undo for a delete already undone: nothing happens, nothing is said.
    expect(f.browser.handleCommand(f.win, 'bookmark.undo', { token: 1 })).toBeNull()
    expect(heard(f.sent, 'bookmark.undone')).toHaveLength(2)

    // A move taken back is told too, under its own token and kind.
    f.browser.handleCommand(f.win, 'bookmark.move', {
      ids: [b.id],
      parentId: BOOKMARKS_BAR_ID,
      index: 0
    })
    expect(f.browser.handleCommand(f.win, 'bookmark.undo', {})).toMatchObject({
      kind: 'move',
      token: 2
    })
    expect(heard(f.sent, 'bookmark.undone').slice(2)).toEqual([
      [f.win.id, { token: 2, kind: 'move' }],
      [other.id, { token: 2, kind: 'move' }]
    ])
  })

  it('a quiet delete says nothing to the window and still goes on the undo stack (#357 G2, the phone panels’ deferred commits)', () => {
    const f = fixture('phone')
    const a = f.browser.handleCommand(f.win, 'bookmark.create', {
      parentId: BOOKMARKS_BAR_ID,
      title: 'A',
      url: 'https://a.test/',
      type: 'url'
    }) as BookmarkNode
    f.sent.length = 0

    f.browser.handleCommand(f.win, 'bookmark.remove', { ids: [a.id], quiet: true })
    expect(f.browser.bookmarks.get(a.id)).toBeNull()
    // No `bookmark.deleted`, no toast: the panel's own Undo toast already ran its course.
    expect(f.sent.map((s) => s.name)).not.toContain('bookmark.deleted')
    expect(f.sent.map((s) => s.name)).not.toContain('toast')

    // The delete is on the stack all the same: the manager's Ctrl+Z brings it back, and says so.
    expect(f.browser.handleCommand(f.win, 'bookmark.undo', {})).toMatchObject({
      kind: 'remove',
      token: 1,
      ids: [a.id]
    })
    expect(f.browser.bookmarks.tree.children(BOOKMARKS_BAR_ID).map((n) => n.title)).toEqual(['A'])
    expect(heard(f.sent, 'bookmark.undone')).toEqual([[f.win.id, { token: 1, kind: 'remove' }]])
  })

  it("on a phone the tab row's Remove Bookmark (Ctrl+D's path) is told like the desktop's: bookmark.deleted for the toast with Undo, no bare word (#357 G2)", () => {
    const f = fixture('phone')
    const tab = f.browser.tabs.createTab({ url: 'https://a.test/', active: true }, f.win)
    f.browser.toggleBookmark(tab.id, f.win)
    expect(f.browser.bookmarks.has('https://a.test/')).toBe(true)
    expect(f.browser.tabs.tab(tab.id)?.bookmarked).toBe(true)
    f.sent.length = 0

    f.browser.toggleBookmark(tab.id, f.win)
    expect(f.browser.bookmarks.has('https://a.test/')).toBe(false)
    expect(heard(f.sent, 'bookmark.deleted')).toEqual([
      [f.win.id, { token: 1, count: 1, kind: 'bookmark' }]
    ])
    // Not the old "Bookmark removed" toast: the core's one word is the event the chrome toasts.
    expect(f.sent.map((s) => s.name)).not.toContain('toast')
  })
})
