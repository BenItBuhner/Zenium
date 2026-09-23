import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import { chromeReference } from '../../shared/shortcutReference'
import { collisions, defaultShortcuts, matchShortcut } from '../../shared/shortcuts'
import { searchCommands } from '../../shared/commands'
import { Browser } from '../browser'
import type { ZenWindow } from '../window'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'

/**
 * The entry points of the desktop's Web capture (Edge's, over services' capture engine): the
 * `capture.start` action the Chrome preset binds to Ctrl+Shift+S, the app menu's and the page
 * menu's rows, the palette's command. The overlay itself is the renderer's
 * (`components/capture/CaptureOverlay.tsx`); the core only raises `capture.start` for the tab.
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
  win: ZenWindow
  /** Every event the window was sent, in order. */
  sent: Array<{ name: string; payload: unknown }>
  /** Every `TabView.screenshot` call (Take Screenshot's path). */
  screenshots: string[]
}

function fixture(): Fixture {
  const sent: Fixture['sent'] = []
  const screenshots: string[] = []
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities: stub<HostCapabilities>({
      windows: true,
      updates: false,
      agents: false,
      pageTabs: false
    }),
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
      createView: (tab: Tab) => {
        let url = tab.url
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => true,
          hasDocument: () => true,
          getURL: () => url,
          getTitle: () => 'Example',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          loadURL: (u: string) => {
            url = u
          },
          screenshot: async (fileName: string) => {
            screenshots.push(fileName)
            return `/home/u/Downloads/${fileName}`
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
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  return { browser, win: browser.focusedWindow(), sent, screenshots }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('capture.start', () => {
  it('asks the desktop chrome for the overlay over the active tab, with the keyboard in the chrome', () => {
    const f = fixture()
    const tab = f.browser.tabs.createTab({ url: 'https://example.test/page', active: true }, f.win)
    f.sent.length = 0
    f.browser.actions.run('capture.start', { sourceTabId: tab.id, win: f.win })
    expect(f.sent.filter((s) => s.name === 'capture.start')).toEqual([
      { name: 'capture.start', payload: { tabId: tab.id } }
    ])
    expect(f.screenshots).toEqual([])
  })

  it('acts on the glance page when the shortcut came from it, as the other page actions do', () => {
    const f = fixture()
    const parent = f.browser.tabs.createTab({ url: 'https://example.test/', active: true }, f.win)
    const glance = f.browser.tabs.createTab(
      { url: 'https://example.test/glance', active: false },
      f.win
    )
    f.win.glance = { tabId: glance.id, parentTabId: parent.id, originX: 0.5, originY: 0.5 }
    f.sent.length = 0
    f.browser.actions.run('capture.start', { sourceTabId: glance.id, win: f.win })
    expect(f.sent.filter((s) => s.name === 'capture.start')).toEqual([
      { name: 'capture.start', payload: { tabId: glance.id } }
    ])
  })

  it('takes the visible page instead on a chrome without the overlay (the phone, the tablet)', async () => {
    const f = fixture()
    const tab = f.browser.tabs.createTab({ url: 'https://example.test/page', active: true }, f.win)
    f.win.formFactor = 'tablet'
    f.sent.length = 0
    f.browser.actions.run('capture.start', { sourceTabId: tab.id, win: f.win })
    await flush()
    expect(f.sent.filter((s) => s.name === 'capture.start')).toEqual([])
    expect(f.screenshots).toHaveLength(1)
    expect(f.screenshots[0]).toMatch(/^Screenshot \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}\.png$/)
  })

  it('does nothing without a tab', () => {
    const f = fixture()
    f.sent.length = 0
    f.browser.actions.run('capture.start', { sourceTabId: null, win: f.win })
    expect(f.sent.filter((s) => s.name === 'capture.start')).toEqual([])
    expect(f.screenshots).toEqual([])
  })
})

describe('the Ctrl+Shift+S chord', () => {
  const press = { key: 'S', control: true, alt: false, shift: true, meta: false }

  it('is Web capture in the Chrome preset (Edge’s chord) and Take Screenshot in the Zen preset (Firefox’s)', () => {
    expect(matchShortcut(defaultShortcuts('linux', 'chrome'), press)?.action).toBe('capture.start')
    expect(matchShortcut(defaultShortcuts('win32', 'chrome'), press)?.action).toBe('capture.start')
    expect(matchShortcut(defaultShortcuts('linux', 'zen'), press)?.action).toBe('page.screenshot')
    expect(
      matchShortcut(defaultShortcuts('darwin', 'chrome'), { ...press, control: false, meta: true })
        ?.action
    ).toBe('capture.start')
  })

  it('leaves the other action of each preset unbound rather than doubling the chord', () => {
    const bound = (preset: 'zen' | 'chrome', id: string): boolean =>
      defaultShortcuts('linux', preset).some((s) => s.id === id && s.binding !== null)
    expect(bound('chrome', 'key_screenshot')).toBe(false)
    expect(bound('chrome', 'key_webCapture')).toBe(true)
    expect(bound('zen', 'key_webCapture')).toBe(false)
    expect(bound('zen', 'key_screenshot')).toBe(true)
  })

  it('lists Web Capture on the desktop layout alone – the touch shells’ chord takes their screenshot – the binding itself on every layout', () => {
    for (const preset of ['zen', 'chrome'] as const) {
      const table = defaultShortcuts('linux', preset)
      expect(table.find((s) => s.id === 'key_webCapture')?.layouts).toEqual(['desktop'])
      expect(table.find((s) => s.id === 'key_screenshot')?.layouts).toBeUndefined()
    }
  })

  it('is no collision: Edge’s reference row names capture.start', () => {
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      const found = collisions(defaultShortcuts(platform, 'chrome'), chromeReference(platform))
      expect(found.filter((c) => c.shortcut.action === 'capture.start')).toEqual([])
    }
  })
})

describe('the palette', () => {
  const desktop = { capabilities: stub<HostCapabilities>(), formFactor: 'desktop' as const }

  it('offers Web Capture on the desktop, by its name and by "capture" or "snip"', () => {
    for (const typed of ['web capture', 'capture', 'snip', 'clip']) {
      expect(searchCommands(typed, desktop).map((c) => c.action)).toContain('capture.start')
    }
    expect(searchCommands('web capture', desktop)[0]).toMatchObject({
      id: 'web-capture',
      label: 'Web Capture',
      action: 'capture.start'
    })
  })

  it('keeps it from the phone and the tablet, whose chrome has no overlay for it', () => {
    for (const formFactor of ['phone', 'tablet'] as const) {
      const actions = searchCommands('web capture', { ...desktop, formFactor }).map((c) => c.action)
      expect(actions).not.toContain('capture.start')
    }
  })
})
