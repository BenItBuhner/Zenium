import { describe, expect, it } from 'vitest'
import { Browser } from '../browser'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import { PRIVATE_CONTAINER_ID, type HostCapabilities, type Tab } from '../../shared/types'

/**
 * Picture-in-picture is withheld from private tabs, as Chrome withholds it from Incognito: a
 * window that left for the small video never stops, so the private tab lock would never arm
 * (ruled 2026-09-21). The `page.pip` action – the shortcut, the toolbar, the video menu's item –
 * says so and touches neither the page nor the host.
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

interface Fixture {
  browser: Browser
  sent: Array<{ name: string; payload: unknown }>
  scripts: string[]
  pipRequests: string[]
}

function fixture(options: { hostPip?: boolean } = {}): Fixture {
  const sent: Fixture['sent'] = []
  const scripts: string[] = []
  const pipRequests: string[] = []
  const capabilities = stub<HostCapabilities>({
    windows: true,
    updates: false,
    agents: false,
    newTabPage: false,
    pageTabs: false,
    pictureInPicture: true
  })
  const platform: Platform = {
    info: { os: 'linux', version: '0.0.0' },
    capabilities,
    io: memoryIo(),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          send: (name: string, payload: unknown) => {
            sent.push({ name, payload })
          },
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true
        })
    },
    views: stub<TabViewHost>({
      createView: (tab: Tab) => {
        let url = tab.url
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          hasDocument: () => url !== '',
          getURL: () => url,
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          navigationEntries: () => ({ entries: [], index: -1 }),
          loadURL: (u: string) => {
            url = u
          },
          executeJavaScript: async (code: string) => {
            scripts.push(code)
            return true
          },
          destroy: () => undefined
        })
      }
    }),
    ...(options.hostPip
      ? {
          mediaSession: {
            update: () => undefined,
            enterPictureInPicture: async (session: { tabId: string }) => {
              pipRequests.push(session.tabId)
              return true
            }
          }
        }
      : {}),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    readabilitySource: () => null
  } as Platform
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  return { browser, sent, scripts, pipRequests }
}

function toasts(f: Fixture): string[] {
  return f.sent
    .filter((e) => e.name === 'toast')
    .map((e) => (e.payload as { message: string }).message)
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('page.pip on a private tab', () => {
  it('says picture-in-picture is withheld and never asks the page (desktop path)', async () => {
    const f = fixture()
    const win = f.browser.focusedWindow()
    f.browser.tabs.createTab(
      { url: 'https://video.example/clip', active: true, containerId: PRIVATE_CONTAINER_ID },
      win
    )
    f.browser.actions.run('page.pip', { sourceTabId: null, win })
    await flush()
    expect(toasts(f)).toEqual(["Picture-in-Picture isn't available in private tabs."])
    expect(f.scripts.filter((s) => s.includes('requestPictureInPicture'))).toHaveLength(0)

    // A regular tab goes to the page as before.
    f.browser.tabs.createTab({ url: 'https://video.example/other', active: true }, win)
    f.browser.actions.run('page.pip', { sourceTabId: null, win })
    await flush()
    expect(f.scripts.filter((s) => s.includes('requestPictureInPicture'))).toHaveLength(1)
    expect(toasts(f)).toHaveLength(1)
  })

  it('never asks a host whose window goes into picture-in-picture (Android path)', async () => {
    const f = fixture({ hostPip: true })
    const win = f.browser.focusedWindow()
    const priv = f.browser.tabs.createTab(
      { url: 'https://video.example/clip', active: true, containerId: PRIVATE_CONTAINER_ID },
      win
    )
    f.browser.actions.run('page.pip', { sourceTabId: null, win })
    await flush()
    expect(f.pipRequests).toEqual([])
    expect(toasts(f)).toEqual(["Picture-in-Picture isn't available in private tabs."])
    // The media sheet's command, too, is refused before the host hears of it.
    expect(await f.browser.handleCommand(win, 'media.pictureInPicture', { tabId: priv.id })).toBe(
      false
    )
    expect(f.pipRequests).toEqual([])
  })
})
