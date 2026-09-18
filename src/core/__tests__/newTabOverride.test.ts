import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { Browser } from '../browser'
import { NoExtensions } from '../hostDefaults'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'

const OVERRIDE = 'chrome-extension://laookkfknpbbblfpciffpaejjkokdgca/dashboard.html'

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
  loads: string[]
  sent: Array<{ name: string; payload: unknown }>
  override: { url: string | null }
}

function fixture(): Fixture {
  const loads: string[] = []
  const sent: Fixture['sent'] = []
  const override = { url: null as string | null }
  const capabilities = stub<HostCapabilities>({ windows: true, updates: false, agents: false })
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities,
    io: memoryIo(),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          send: (name: string, payload: unknown) => {
            sent.push({ name, payload })
          }
        })
    },
    views: stub<TabViewHost>({
      createView: () => {
        let url = ''
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          hasDocument: () => url !== '',
          getURL: () => url,
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          loadURL: (u: string) => {
            url = u
            loads.push(u)
          }
        })
      }
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    readabilitySource: () => null,
    createExtensions: (browser) => {
      const host = new NoExtensions(browser)
      host.newTabUrl = () => override.url
      return host
    }
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  return { browser, loads, sent, override }
}

describe('opening a new tab with a chrome_url_overrides.newtab extension', () => {
  it('opens the URL bar in new-tab mode when no extension holds the override', () => {
    const f = fixture()
    const tabsBefore = Object.keys(f.browser.state.model.tabs).length
    f.browser.handleCommand(f.browser.focusedWindow(), 'tab.new', undefined)
    expect(f.sent.filter((e) => e.name === 'urlbar.toggle')).toEqual([
      { name: 'urlbar.toggle', payload: { mode: 'new-tab' } }
    ])
    expect(Object.keys(f.browser.state.model.tabs)).toHaveLength(tabsBefore)
  })

  it("opens the extension's page as the new active tab when one does", () => {
    const f = fixture()
    f.override.url = OVERRIDE
    const win = f.browser.focusedWindow()
    f.browser.handleCommand(win, 'tab.new', undefined)
    expect(f.sent.filter((e) => e.name === 'urlbar.toggle')).toEqual([])
    const active = f.browser.tabs.activeTabFor(win)
    expect(active?.url).toBe(OVERRIDE)
    expect(f.loads).toEqual([OVERRIDE])
  })

  it('keeps private windows on the URL bar: extensions do not run there', () => {
    const f = fixture()
    f.override.url = OVERRIDE
    const priv = f.browser.openWindow('private')
    if (!priv) throw new Error('no private window')
    f.sent.length = 0
    f.browser.openNewTab(priv)
    expect(f.sent.map((e) => e.name)).toContain('urlbar.toggle')
    expect(f.loads).not.toContain(OVERRIDE)
  })
})
