import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { APP_ICON_DEFAULT, type AppIconId } from '../../shared/appIcon'
import { Browser } from '../browser'
import type { Platform, StoreIO } from '../platform'
import type { ZenWindow } from '../window'
import { BrowserState } from '../state'

/** In-memory documents; `state.json` is what the settings round-trip through. */
function memoryIo(files: Record<string, string> = {}): StoreIO & { files: Record<string, string> } {
  return {
    files,
    readSync: (name) => files[name] ?? null,
    write: async (name, text) => {
      files[name] = text
    },
    writeSync: (name, text) => {
      files[name] = text
    }
  }
}

/** Anything the browser touches on the host answers with a harmless no-op. */
function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

/**
 * A platform with no windows, pages or dialogs, but a real `app.setAppIcon` that records every
 * call – all the settings path needs.
 */
function fakePlatform(io: StoreIO): Platform & { icons: AppIconId[] } {
  const icons: AppIconId[] = []
  const capabilities = stub<HostCapabilities>({ windows: false, updates: false, agents: false })
  return {
    icons,
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities,
    io,
    windows: {
      create: () =>
        stub({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => false,
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true
        })
    },
    views: stub({ createView: () => stub({ isDestroyed: () => false, isVisible: () => false }) }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub({ setAppIcon: (id: AppIconId) => void icons.push(id) }),
    readabilitySource: () => null
  }
}

async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r))
}

describe('the app icon setting', () => {
  it('starts as the shipped colour and applies it to the host once at start', () => {
    const platform = fakePlatform(memoryIo())
    const browser = new Browser(platform)
    browser.start()
    expect(browser.state.settings.appIcon).toBe(APP_ICON_DEFAULT)
    expect(platform.icons).toEqual([APP_ICON_DEFAULT])
  })

  it('changes through settings.update, reaches the host and is persisted', async () => {
    const io = memoryIo()
    const platform = fakePlatform(io)
    const browser = new Browser(platform)
    browser.start()
    const win = browser.allWindows()[0] as ZenWindow
    browser.handleCommand(win, 'settings.update', { appIcon: 'sunset' })
    expect(browser.state.settings.appIcon).toBe('sunset')
    expect(platform.icons).toEqual([APP_ICON_DEFAULT, 'sunset'])
    // Setting the same colour again is not an event for the host.
    browser.handleCommand(win, 'settings.update', { appIcon: 'sunset' })
    expect(platform.icons).toHaveLength(2)
    await settle()
    await browser.state.flush()
    expect(JSON.parse(io.files['state.json']).settings.appIcon).toBe('sunset')
  })

  it('refuses unknown colours and keeps the host untouched', () => {
    const platform = fakePlatform(memoryIo())
    const browser = new Browser(platform)
    browser.start()
    const win = browser.allWindows()[0] as ZenWindow
    browser.handleCommand(win, 'settings.update', { appIcon: 'chartreuse' })
    expect(browser.state.settings.appIcon).toBe(APP_ICON_DEFAULT)
    expect(platform.icons).toEqual([APP_ICON_DEFAULT])
  })

  it('loads a persisted choice and sanitises a stale one', () => {
    const persisted = (appIcon: unknown): BrowserState => {
      const io = memoryIo({
        'state.json': JSON.stringify({ version: 2, settings: { appIcon }, tabs: [], spaces: [] })
      })
      const state = new BrowserState(io, {} as Platform, {} as HostCapabilities, '0.0')
      state.load()
      return state
    }
    expect(persisted('graphite').settings.appIcon).toBe('graphite')
    expect(persisted('teal').settings.appIcon).toBe(APP_ICON_DEFAULT)
    expect(persisted(undefined).settings.appIcon).toBe(APP_ICON_DEFAULT)
  })

  it('re-applies the persisted choice at the next start', () => {
    const io = memoryIo({
      'state.json': JSON.stringify({
        version: 2,
        settings: { appIcon: 'ocean' },
        tabs: [],
        spaces: []
      })
    })
    const platform = fakePlatform(io)
    new Browser(platform).start()
    expect(platform.icons).toEqual(['ocean'])
  })
})
