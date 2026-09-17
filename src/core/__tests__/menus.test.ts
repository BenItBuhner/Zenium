import { describe, expect, it } from 'vitest'
import type { FormFactor, HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { searchCommands, type CommandContext } from '../../shared/commands'
import { Browser } from '../browser'
import type {
  AppHost,
  MenuHost,
  MenuItemTemplate,
  Platform,
  StoreIO,
  TabView,
  TabViewHost,
  WindowHost
} from '../platform'
import type { ZenWindow } from '../window'
import { NAVIGATION_MENU_MAX, navigationWindow } from '../menus'

/**
 * Electron's capabilities, a hand-kept copy of src/main/platform/index.ts: the real object imports
 * Electron, which a core test cannot load. When a capability is added or flipped there, update it
 * here too (the `HostCapabilities` type catches an added one, not a changed value).
 */
const DESKTOP: HostCapabilities = {
  windowControls: true,
  nativeMenus: true,
  windowDrag: true,
  devtools: true,
  compactReveal: true,
  pictureInPicture: true,
  viewSource: true,
  windows: true,
  extensions: true,
  resourceGovernor: true,
  sync: true,
  print: true,
  agents: true,
  updates: true,
  share: false,
  clipboardChip: false,
  appLinkSettings: false,
  pullToRefresh: false,
  passwords: true,
  defaultBrowser: false,
  requestBlocking: true,
  newTabPage: true
}

/**
 * The Android host on API 34 without an extension install root (the preview host), a hand-kept
 * copy of `androidCapabilities({ sdkInt: 34, extensions: false })` in src/android/platform.ts:
 * that module pulls in the WebView bridge and Vite `?raw` imports a core test cannot load. Keep
 * it in step by hand, as above. A device build turns `extensions` on.
 */
const ANDROID: HostCapabilities = {
  windowControls: false,
  nativeMenus: false,
  windowDrag: false,
  devtools: false,
  compactReveal: false,
  pictureInPicture: false,
  viewSource: false,
  windows: false,
  extensions: false,
  resourceGovernor: false,
  sync: false,
  print: true,
  agents: true,
  updates: true,
  share: true,
  clipboardChip: true,
  appLinkSettings: true,
  pullToRefresh: true,
  passwords: true,
  defaultBrowser: true,
  requestBlocking: true,
  newTabPage: false
}

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

/** Anything the browser touches on the host answers with a harmless no-op. */
function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

interface Harness {
  browser: Browser
  win: ZenWindow
  /** The last template handed to the host's menu popup. */
  shown: () => MenuItemTemplate[]
}

/** A browser on a host with the given capabilities whose menu popup only records the template. */
function harness(capabilities: HostCapabilities, formFactor?: FormFactor): Harness {
  let last: MenuItemTemplate[] = []
  const menus: MenuHost = {
    popup: (items) => {
      last = items
    }
  }
  const platform: Platform = {
    info: { os: capabilities.windows ? ('linux' as PlatformOs) : 'android', version: '1.2.3' },
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
          isVisible: () => true
        })
    },
    views: stub<TabViewHost>({
      createView: () => stub<TabView>({ isDestroyed: () => false, isVisible: () => false })
    }),
    menus,
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub<AppHost>(),
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  if (formFactor) browser.handleCommand(win, 'window.formFactor', { formFactor })
  return { browser, win, shown: () => last }
}

/** Labels in order, separators as `-`, submenus flattened one level as `Parent > Child`. */
function labels(items: MenuItemTemplate[]): string[] {
  return items.flatMap((item) => {
    if (item.type === 'separator') return ['-']
    const label = item.label ?? ''
    return item.submenu
      ? [label, ...item.submenu.map((sub) => `${label} > ${sub.label ?? '-'}`)]
      : [label]
  })
}

function appMenu(h: Harness): string[] {
  h.browser.handleCommand(h.win, 'app.menu', undefined)
  return labels(h.shown())
}

/** The desktop app menu as it was before the phone variant existed. */
const DESKTOP_APP_MENU = [
  'New Tab',
  'New Space…',
  '-',
  'New Window',
  'New Blank Window',
  'New Private Window',
  '-',
  'Bookmarks',
  'Bookmarks > Bookmark This Page',
  'Bookmarks > Bookmark All Tabs…',
  'Bookmarks > -',
  'Bookmarks > Show Bookmarks',
  'Bookmarks > -',
  'Bookmarks > Import Bookmarks…',
  'Bookmarks > Export Bookmarks…',
  'History',
  'Recently Closed',
  'Downloads',
  'Add-ons and Themes',
  '-',
  'Compact Mode',
  'Change Theme…',
  'Zoom',
  'Zoom > Zoom In',
  'Zoom > Zoom Out',
  'Zoom > Reset Zoom',
  'Fullscreen',
  '-',
  'Find in Page…',
  'Reader View',
  'Print…',
  'Save Page As…',
  'Take Screenshot',
  '-',
  'Resources',
  'Resources > Memory 0 MB · CPU 0% · 0 live, 0 frozen',
  'Resources > -',
  'Resources > Free Up Memory Now',
  'Resources > Freeze Other Tabs',
  'Resources > Wake All Tabs',
  'Resources > -',
  'Resources > Resource Settings…',
  'Keyboard Shortcuts',
  'Settings',
  'Developer Tools',
  '-',
  'About Zenium 1.2.3',
  'Quit'
]

const DESKTOP_ONLY = ['Keyboard Shortcuts', 'Compact Mode', 'Fullscreen', 'Quit']

describe('the app menu', () => {
  it('is unchanged on the desktop', () => {
    expect(appMenu(harness(DESKTOP))).toEqual(DESKTOP_APP_MENU)
  })

  it('gives a tablet the desktop menu', () => {
    expect(appMenu(harness(DESKTOP, 'tablet'))).toEqual(DESKTOP_APP_MENU)
  })

  it('keeps the desktop menu until the chrome reports a phone layout', () => {
    const h = harness(ANDROID)
    expect(appMenu(h)).toContain('Keyboard Shortcuts')
    h.browser.handleCommand(h.win, 'window.formFactor', { formFactor: 'phone' })
    expect(appMenu(h)).not.toContain('Keyboard Shortcuts')
  })

  it('on a phone drops what only a desktop window can use', () => {
    const menu = appMenu(harness(ANDROID, 'phone'))
    for (const label of DESKTOP_ONLY) expect(menu).not.toContain(label)
    // The host has no windows, extensions, devtools or resource governor.
    for (const label of [
      'New Window',
      'New Blank Window',
      'New Private Window',
      'Add-ons and Themes',
      'Developer Tools',
      'Resources'
    ])
      expect(menu).not.toContain(label)
  })

  it('on a phone keeps the page and library items in their desktop order', () => {
    expect(appMenu(harness(ANDROID, 'phone'))).toEqual([
      'New Tab',
      'New Space…',
      '-',
      'Bookmarks',
      'Bookmarks > Bookmark This Page',
      'Bookmarks > Bookmark All Tabs…',
      'Bookmarks > -',
      'Bookmarks > Show Bookmarks',
      'Bookmarks > -',
      'Bookmarks > Import Bookmarks…',
      'Bookmarks > Export Bookmarks…',
      'History',
      'Downloads',
      '-',
      'Change Theme…',
      'Zoom',
      'Zoom > Zoom In',
      'Zoom > Zoom Out',
      'Zoom > Reset Zoom',
      '-',
      'Find in Page…',
      'Reader View',
      'Share…',
      'Print…',
      'Save Page As…',
      'Take Screenshot',
      '-',
      'Settings',
      '-',
      'About Zenium 1.2.3'
    ])
  })

  it('on a phone follows the capabilities, not the platform name', () => {
    // A desktop window narrowed to the phone layout: no Share sheet, but extensions exist.
    const menu = appMenu(harness(DESKTOP, 'phone'))
    expect(menu).not.toContain('Share…')
    expect(menu).toContain('Add-ons and Themes')
    for (const label of DESKTOP_ONLY) expect(menu).not.toContain(label)
    // A phone without a printer path hides Print rather than greying it.
    expect(appMenu(harness({ ...ANDROID, print: false }, 'phone'))).not.toContain('Print…')
    // A device build has the extension store: the management page is reachable from the menu.
    const withStore = appMenu(harness({ ...ANDROID, extensions: true }, 'phone'))
    expect(withStore.indexOf('Add-ons and Themes')).toBe(withStore.indexOf('Downloads') + 1)
  })

  it('leaves the phone layout again when the window widens', () => {
    const h = harness(ANDROID, 'phone')
    expect(appMenu(h)).not.toContain('Quit')
    h.browser.handleCommand(h.win, 'window.formFactor', { formFactor: 'tablet' })
    expect(appMenu(h)).toContain('Keyboard Shortcuts')
  })
})

describe('URL bar command suggestions', () => {
  const desktop: CommandContext = { capabilities: DESKTOP, formFactor: 'desktop' }
  const phone: CommandContext = { capabilities: ANDROID, formFactor: 'phone' }
  const ids = (query: string, ctx: CommandContext): string[] =>
    searchCommands(query, ctx).map((c) => c.id)

  it('are unfiltered without a context, as before', () => {
    expect(searchCommands('compact').map((c) => c.action)).toContain('compact.toggle')
    expect(searchCommands('split grid').map((c) => c.action)).toContain('split.grid')
  })

  it('offer sidebar, split view and fullscreen commands only where there is a sidebar', () => {
    expect(ids('compact', desktop)).toContain('compact')
    expect(ids('compact', phone)).toEqual([])
    expect(ids('split', desktop)).toContain('split-grid')
    expect(ids('split', phone)).toEqual([])
    expect(ids('unsplit', phone)).toEqual([])
    expect(ids('fullscreen', phone)).toEqual([])
    expect(ids('fullscreen', desktop)).toContain('fullscreen')
  })

  it('follow the host capabilities', () => {
    expect(ids('window', desktop)).toEqual(
      expect.arrayContaining(['new-window', 'new-private-window'])
    )
    expect(ids('window', phone)).toEqual([])
    expect(ids('devtools', phone)).toEqual([])
    expect(ids('addons', phone)).toEqual([])
    expect(ids('source', phone)).toEqual([])
    expect(ids('memory', phone)).toEqual([])
    expect(ids('print', phone)).toEqual(['print'])
    expect(ids('print', { ...phone, capabilities: { ...ANDROID, print: false } })).toEqual([])
  })

  it('keep the phone-relevant commands', () => {
    expect(ids('theme', phone)).toContain('theme')
    expect(ids('zoom', phone)).toEqual(expect.arrayContaining(['zoom-in', 'zoom-out']))
    expect(ids('reader', phone)).toContain('reader')
    expect(ids('screenshot', phone)).toContain('screenshot')
    expect(ids('history', phone)).toContain('history')
  })
})

describe('navigationWindow', () => {
  it('lists a short stack whole', () => {
    expect(navigationWindow(4, 2, NAVIGATION_MENU_MAX)).toEqual({ start: 0, end: 4 })
    expect(navigationWindow(0, -1, NAVIGATION_MENU_MAX)).toEqual({ start: 0, end: 0 })
  })

  it('caps a long stack at the maximum and keeps the current entry in view', () => {
    for (let index = 0; index < 40; index += 1) {
      const { start, end } = navigationWindow(40, index, NAVIGATION_MENU_MAX)
      expect(end - start).toBe(NAVIGATION_MENU_MAX)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeLessThanOrEqual(40)
      expect(index).toBeGreaterThanOrEqual(start)
      expect(index).toBeLessThan(end)
    }
  })

  it('favours back entries, with a few forward ones when they exist', () => {
    // Current entry deep in the middle: three forward entries, six back entries.
    expect(navigationWindow(40, 20, NAVIGATION_MENU_MAX)).toEqual({ start: 14, end: 24 })
    // At the newest entry: nothing forward, nine back.
    expect(navigationWindow(40, 39, NAVIGATION_MENU_MAX)).toEqual({ start: 30, end: 40 })
    // At the oldest entry: all ten are forward entries.
    expect(navigationWindow(40, 0, NAVIGATION_MENU_MAX)).toEqual({ start: 0, end: 10 })
  })
})
