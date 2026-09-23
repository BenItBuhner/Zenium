import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { Browser } from '../browser'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import type { ZenWindow } from '../window'

/**
 * "Bookmark all tabs" as the window hears the request (`bookmark.allTabs`, the dialog's Name
 * field and its Save's fallback): a whole space's folder is offered under the space's NAME ALONE
 * – the space's icon is its picture, neither a character of its name nor a leading glyph in the
 * field (§9.12; the design gate on pr-386, seed 48) – and picked tabs under their count.
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

interface Request {
  tabIds: string[]
  defaultTitle: string
}

function fixture(): { browser: Browser; win: ZenWindow; requests: Request[] } {
  const requests: Request[] = []
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities: stub<HostCapabilities>({ windows: true, pageTabs: true }),
    io: memoryIo(),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1600, height: 1000 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          send: (name: string, payload: unknown) => {
            if (name === 'bookmark.allTabs') requests.push(payload as Request)
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
  return { browser, win: browser.focusedWindow(), requests }
}

describe('bookmark.allTabs, as the window hears it', () => {
  it("a whole space's folder defaults to the space's name alone – the icon is its picture, not a character of the name (pr-386 gate 1)", () => {
    const f = fixture()
    const space = f.win.activeSpace()
    f.browser.handleCommand(f.win, 'space.update', {
      spaceId: space.id,
      patch: { name: 'Browse', icon: '🧭' }
    })
    const one = f.browser.tabs.createTab({ url: 'https://one.test/', active: true }, f.win)
    const two = f.browser.tabs.createTab({ url: 'https://two.test/', active: false }, f.win)

    f.browser.bookmarkTabs(f.win)

    expect(f.requests).toHaveLength(1)
    expect(f.requests[0].defaultTitle).toBe('Browse')
    expect(f.requests[0].defaultTitle).not.toContain('🧭')
    expect(f.requests[0].tabIds.sort()).toEqual([one.id, two.id].sort())
  })

  it("picked tabs' folder defaults to their count", () => {
    const f = fixture()
    const one = f.browser.tabs.createTab({ url: 'https://one.test/', active: true }, f.win)
    const two = f.browser.tabs.createTab({ url: 'https://two.test/', active: false }, f.win)

    f.browser.bookmarkTabs(f.win, [one.id, two.id])

    expect(f.requests.map((r) => r.defaultTitle)).toEqual(['2 tabs'])
  })
})
