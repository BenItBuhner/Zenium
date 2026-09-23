import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { Browser } from '../browser'
import { captionDoubleClickEffect, macTitleBarDoubleClickAction } from '../captionDoubleClick'
import type {
  AppHost,
  Platform,
  StoreIO,
  TabView,
  TabViewHost,
  TitleBarDoubleClickAction,
  WindowHost
} from '../platform'

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

/** A window host that records what the core asked of its frame. */
interface FrameLog {
  calls: string[]
  maximized: boolean
  fullscreen: boolean
}

interface Fixture {
  browser: Browser
  frame: FrameLog
}

/**
 * A browser on `os` whose one window's frame is a fake; `macAction` stands in for the macOS
 * host's reading of the title-bar double-click setting (undefined: the host has no such hook,
 * as on Windows and Linux).
 */
function fixture(os: PlatformOs, macAction?: TitleBarDoubleClickAction): Fixture {
  const frame: FrameLog = { calls: [], maximized: false, fullscreen: false }
  const capabilities = stub<HostCapabilities>({ windows: true, updates: false, agents: false })
  const app: AppHost = stub<AppHost>(
    macAction === undefined ? {} : { titleBarDoubleClickAction: () => macAction }
  )
  const platform: Platform = {
    info: { os, version: '0.0.0' },
    capabilities,
    io: memoryIo(),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => frame.fullscreen,
          isMaximized: () => frame.maximized,
          isFocused: () => true,
          isVisible: () => true,
          maximize: () => {
            frame.calls.push('maximize')
            frame.maximized = true
          },
          unmaximize: () => {
            frame.calls.push('unmaximize')
            frame.maximized = false
          },
          minimize: () => {
            frame.calls.push('minimize')
          }
        })
    },
    views: stub<TabViewHost>({
      createView: () =>
        stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          hasDocument: () => false,
          getURL: () => '',
          getTitle: () => '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1
        })
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app,
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.state.settings.onboardingDone = true
  browser.start()
  return { browser, frame }
}

function doubleClick(f: Fixture): void {
  f.browser.handleCommand(f.browser.focusedWindow(), 'window.captionDoubleClick', undefined)
}

describe('captionDoubleClickEffect (tabs-47, shortcuts-menus-94)', () => {
  it('toggles maximise on Windows and Linux, whatever a Mac setting would say', () => {
    for (const os of ['win32', 'linux'] as const) {
      expect(captionDoubleClickEffect(os, null)).toBe('toggleMaximize')
      expect(captionDoubleClickEffect(os, 'minimize')).toBe('toggleMaximize')
      expect(captionDoubleClickEffect(os, 'none')).toBe('toggleMaximize')
    }
  })

  it('follows the title-bar setting on macOS: zoom (a toggle), minimise or nothing', () => {
    expect(captionDoubleClickEffect('darwin', 'zoom')).toBe('toggleMaximize')
    expect(captionDoubleClickEffect('darwin', 'minimize')).toBe('minimize')
    expect(captionDoubleClickEffect('darwin', 'none')).toBe('none')
  })

  it('zooms on a Mac whose host could not read the setting', () => {
    expect(captionDoubleClickEffect('darwin', null)).toBe('toggleMaximize')
  })

  it('does nothing on a host without a window frame of its own', () => {
    expect(captionDoubleClickEffect('android', null)).toBe('none')
    expect(captionDoubleClickEffect('android', 'zoom')).toBe('none')
  })
})

describe('macTitleBarDoubleClickAction (AppleActionOnDoubleClick)', () => {
  it('reads the three choices of the setting', () => {
    expect(macTitleBarDoubleClickAction('Maximize')).toBe('zoom')
    expect(macTitleBarDoubleClickAction('Minimize')).toBe('minimize')
    expect(macTitleBarDoubleClickAction('None')).toBe('none')
  })

  it('reads macOS 15’s Fill as the zoom it is a variant of', () => {
    expect(macTitleBarDoubleClickAction('Fill')).toBe('zoom')
  })

  it('reads an unset default – a fresh Mac – and a value the setting does not have as zoom', () => {
    expect(macTitleBarDoubleClickAction(undefined)).toBe('zoom')
    expect(macTitleBarDoubleClickAction(null)).toBe('zoom')
    expect(macTitleBarDoubleClickAction('')).toBe('zoom')
    expect(macTitleBarDoubleClickAction('Explode')).toBe('zoom')
  })
})

describe('window.captionDoubleClick', () => {
  it('maximises a Linux window, and a second double-click restores it', () => {
    const f = fixture('linux')
    doubleClick(f)
    expect(f.frame.calls).toEqual(['maximize'])
    doubleClick(f)
    expect(f.frame.calls).toEqual(['maximize', 'unmaximize'])
  })

  it('restores a Windows window the OS had maximised', () => {
    const f = fixture('win32')
    f.frame.maximized = true
    doubleClick(f)
    expect(f.frame.calls).toEqual(['unmaximize'])
  })

  it('zooms a Mac window under the default setting, through the host’s maximize', () => {
    const f = fixture('darwin', 'zoom')
    doubleClick(f)
    expect(f.frame.calls).toEqual(['maximize'])
    doubleClick(f)
    expect(f.frame.calls).toEqual(['maximize', 'unmaximize'])
  })

  it('minimises a Mac window whose user chose Minimize', () => {
    const f = fixture('darwin', 'minimize')
    doubleClick(f)
    expect(f.frame.calls).toEqual(['minimize'])
  })

  it('leaves a Mac window alone whose user chose None', () => {
    const f = fixture('darwin', 'none')
    doubleClick(f)
    expect(f.frame.calls).toEqual([])
  })

  it('zooms on a Mac whose host has no reading of the setting', () => {
    const f = fixture('darwin')
    doubleClick(f)
    expect(f.frame.calls).toEqual(['maximize'])
  })

  it('does nothing to a fullscreen window, which has no title bar', () => {
    const f = fixture('linux')
    f.frame.fullscreen = true
    doubleClick(f)
    expect(f.frame.calls).toEqual([])
  })

  it('does nothing on Android, whose one window has no frame', () => {
    const f = fixture('android')
    doubleClick(f)
    expect(f.frame.calls).toEqual([])
  })
})
