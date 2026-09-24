import { describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { searchCommands } from '../../shared/commands'
import { Browser } from '../browser'
import type { ZenWindow } from '../window'
import type { Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'

/**
 * The entry points of Delete browsing data (Chrome's Ctrl+Shift+Delete, shortcuts-menus-40 and
 * -113): the `privacy.clearBrowsingData` action both presets bind to the chord, the app menu's
 * top-level row (menus.test.ts) and the palette's command. The dialog itself is the chrome's
 * (`components/siteControls/ClearBrowsingDataDialog`, services' PS-13); the core only raises
 * `clearBrowsingData.open` for the window and puts the keyboard in the chrome for it.
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
  /** How often the core asked the host to put the keyboard in the chrome. */
  focusedChrome: { count: number }
}

function fixture(): Fixture {
  const sent: Fixture['sent'] = []
  const focusedChrome = { count: 0 }
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
          focusChrome: () => {
            focusedChrome.count += 1
          },
          send: (name: string, payload: unknown) => {
            sent.push({ name, payload })
          }
        })
    },
    views: stub<TabViewHost>({
      createView: () => stub<TabView>({ isDestroyed: () => false, isVisible: () => true })
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
  return { browser, win: browser.focusedWindow(), sent, focusedChrome }
}

describe('privacy.clearBrowsingData', () => {
  it('asks the chrome for the dialog with the keyboard in the chrome, from a page or the chrome alike', () => {
    const f = fixture()
    const tab = f.browser.tabs.createTab({ url: 'https://example.test/page', active: true }, f.win)
    f.sent.length = 0
    f.focusedChrome.count = 0
    f.browser.actions.run('privacy.clearBrowsingData', { sourceTabId: tab.id, win: f.win })
    expect(f.sent.filter((s) => s.name === 'clearBrowsingData.open')).toEqual([
      { name: 'clearBrowsingData.open', payload: undefined }
    ])
    expect(f.focusedChrome.count).toBe(1)
    f.browser.actions.run('privacy.clearBrowsingData', { sourceTabId: null, win: f.win })
    expect(f.sent.filter((s) => s.name === 'clearBrowsingData.open')).toHaveLength(2)
  })

  it('reaches the window the chord was pressed in when the key table runs it', () => {
    const f = fixture()
    f.sent.length = 0
    const handled = f.browser.keys.handle(
      {
        type: 'keyDown',
        isAutoRepeat: false,
        key: 'Delete',
        control: true,
        alt: false,
        shift: true,
        meta: false
      },
      null,
      f.win
    )
    expect(handled).toBe(true)
    expect(f.sent.map((s) => s.name)).toContain('clearBrowsingData.open')
  })
})

describe('the palette', () => {
  const sidebar = { capabilities: stub<HostCapabilities>(), formFactor: 'desktop' as const }

  it('offers Delete Browsing Data on the sidebar layouts by its name, "clear" or "cookies"', () => {
    for (const typed of ['delete browsing', 'clear', 'cookies', 'cache']) {
      expect(searchCommands(typed, sidebar).map((c) => c.action)).toContain(
        'privacy.clearBrowsingData'
      )
    }
    expect(
      searchCommands('delete browsing', { ...sidebar, formFactor: 'tablet' }).map((c) => c.action)
    ).toContain('privacy.clearBrowsingData')
    // The phone's form is the Settings sheet, not the dialog the row asks for.
    expect(
      searchCommands('delete browsing', { ...sidebar, formFactor: 'phone' }).map((c) => c.action)
    ).not.toContain('privacy.clearBrowsingData')
  })

  it('offers Delete Browsing Data as the one row for Chrome’s action phrases (omnibox-39)', () => {
    for (const typed of ['clear browsing data', 'delete browsing data', 'clear history']) {
      const rows = searchCommands(typed, sidebar)
      expect(rows.map((c) => c.action)).toContain('privacy.clearBrowsingData')
      // "clear history" is the dialog, not Show History: the row that only says "history" does
      // not carry "clear".
      expect(rows.map((c) => c.action)).not.toContain('history.open')
    }
  })

  it('offers Manage Search Engines for Chrome’s phrases on every layout (omnibox-39)', () => {
    for (const typed of ['manage search engines', 'search engines', 'change search engine']) {
      const rows = searchCommands(typed, sidebar)
      expect(rows.map((c) => c.action)).toEqual(['search.manageEngines'])
      expect(rows[0]).toMatchObject({ id: 'manage-search-engines', label: 'Manage Search Engines' })
    }
    // Settings › Search is a page or a sheet on every host, so the row is host-agnostic.
    for (const formFactor of ['tablet', 'phone'] as const) {
      expect(
        searchCommands('search engines', { ...sidebar, formFactor }).map((c) => c.action)
      ).toEqual(['search.manageEngines'])
    }
  })
})

describe('search.manageEngines', () => {
  it('opens Settings at its Search section in the window the row was picked in', () => {
    const f = fixture()
    const open = vi.spyOn(f.browser.pages, 'open').mockImplementation(() => null)
    f.browser.actions.run('search.manageEngines', { sourceTabId: null, win: f.win })
    expect(open).toHaveBeenCalledWith('settings', 'search', f.win)
    // The palette's row reaches the same action through `urlbar.runCommand`.
    f.browser.handleCommand(f.win, 'urlbar.runCommand', { action: 'search.manageEngines' })
    expect(open).toHaveBeenCalledTimes(2)
  })
})
