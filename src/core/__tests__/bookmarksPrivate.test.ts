import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { BOOKMARKS_BAR_ID } from '../../shared/bookmarks'
import { Browser } from '../browser'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import type { ZenWindow } from '../window'

/**
 * Bookmarks made from a private window (bookmarks-43): the record goes into the profile's one
 * store, as Chrome's Incognito bookmarks do, but nothing of the private visit goes with it –
 * the star and Ctrl+D write no favicon from a private tab, as the favicon backfill writes none.
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
  return { browser, win: browser.focusedWindow(), sent }
}

describe('bookmarks from a private window', () => {
  it('the star files the page into the shared store without the private tab’s favicon', () => {
    const f = fixture()
    const priv = f.browser.createWindow({ kind: 'private', from: f.win })!
    const tab = f.browser.tabs.createTab({ url: 'https://a.test/', active: true }, priv)
    tab.favicon = 'https://a.test/favicon.ico'
    tab.title = 'A'
    expect(f.browser.tabs.isPrivate(tab)).toBe(true)

    f.browser.starTab(tab.id, priv)
    const [node] = f.browser.bookmarks.findByUrl('https://a.test/')
    expect(node).toBeDefined()
    expect(node.title).toBe('A')
    // The store is the profile's: the regular window sees it too.
    expect(f.browser.bookmarks.has('https://a.test/')).toBe(true)
    // Nothing of the private visit: no favicon on the record.
    expect(node.favicon).toBeUndefined()
  })

  it('Ctrl+D’s toggle writes no favicon from a private tab either, and a regular tab’s icon still lands', () => {
    const f = fixture()
    const priv = f.browser.createWindow({ kind: 'private', from: f.win })!
    const secret = f.browser.tabs.createTab({ url: 'https://p.test/', active: true }, priv)
    secret.favicon = 'https://p.test/icon.png'
    f.browser.toggleBookmark(secret.id, priv)
    expect(f.browser.bookmarks.findByUrl('https://p.test/')[0]?.favicon).toBeUndefined()

    const open = f.browser.tabs.createTab({ url: 'https://r.test/', active: true }, f.win)
    open.favicon = 'https://r.test/icon.png'
    f.browser.toggleBookmark(open.id, f.win)
    expect(f.browser.bookmarks.findByUrl('https://r.test/')[0]?.favicon).toBe(
      'https://r.test/icon.png'
    )
  })

  it('a private tab dropped on another window’s bookmarks bar files the page without its favicon too', () => {
    const f = fixture()
    const priv = f.browser.createWindow({ kind: 'private', from: f.win })!
    const secret = f.browser.tabs.createTab({ url: 'https://d.test/', active: true }, priv)
    secret.favicon = 'https://d.test/icon.png'
    secret.title = 'D'
    // The regular window's bar slot, as the sidebar's drag names it (`bookmark:<folder>:<index>`).
    expect(f.browser.tabs.dropTab(secret.id, `bookmark:${BOOKMARKS_BAR_ID}:0`, f.win)).toBe(true)
    const [node] = f.browser.bookmarks.findByUrl('https://d.test/')
    expect(node.title).toBe('D')
    expect(node.parentId).toBe(BOOKMARKS_BAR_ID)
    expect(node.favicon).toBeUndefined()
    // The tab stays where it was: a bar drop files the page, it does not move the tab.
    expect(f.browser.tabs.windowFor(secret.id)).toBe(priv)
  })
})
