import { describe, expect, it } from 'vitest'
import { BOOKMARKS_BAR_ID } from '../../shared/bookmarks'
import type { BookmarkNode, HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { Browser } from '../browser'
import type { Platform, StoreIO, WindowHost } from '../platform'
import type { ZenWindow } from '../window'

/**
 * The bookmark edits' commands as the windows hear of them (bookmarks-31): a delete tells the
 * window that made it (`bookmark.deleted`, the toast with Undo); an undo – the manager's Ctrl+Z
 * or a toast's Undo – tells every window which edit went back (`bookmark.undone`), so a toast
 * still offering that delete goes down wherever it is.
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

function fixture(): { browser: Browser; win: ZenWindow; sent: Sent[] } {
  const sent: Sent[] = []
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities: stub<HostCapabilities>({ windows: true, pageTabs: true }),
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
    views: stub(),
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
  return { browser, win: browser.focusedWindow(), sent }
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
    // windows hear its token, so the first window's toast can go down.
    const undone = f.browser.handleCommand(other, 'bookmark.undo', {})
    expect(undone).toMatchObject({ kind: 'remove', token: 1, parentId: BOOKMARKS_BAR_ID })
    expect(heard(f.sent, 'bookmark.undone')).toEqual([
      [f.win.id, { token: 1, kind: 'remove' }],
      [other.id, { token: 1, kind: 'remove' }]
    ])
    expect(f.browser.bookmarks.tree.children(BOOKMARKS_BAR_ID).map((n) => n.title)).toEqual([
      'A',
      'B'
    ])

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
})
