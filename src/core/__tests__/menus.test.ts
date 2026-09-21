import { describe, expect, it, vi } from 'vitest'
import type {
  FormFactor,
  HostCapabilities,
  Platform as PlatformOs,
  Settings,
  SharePayload
} from '../../shared/types'
import { PRIVATE_CONTAINER_ID } from '../../shared/types'
import { searchCommands, type CommandContext } from '../../shared/commands'
import { resolveDownloadSettings } from '../../shared/downloads'
import { buildSearchUrl } from '../../shared/search'
import { Browser } from '../browser'
import type {
  AppHost,
  ClipboardHost,
  DialogHost,
  MenuHost,
  MenuItemTemplate,
  MenuPopupOptions,
  Platform,
  ShortcutHost,
  SpeechHost,
  SpellcheckHost,
  StoreIO,
  TabView,
  TabViewHost,
  TranslateHost,
  TranslateModelStore,
  WindowHost
} from '../platform'
import type { ZenWindow } from '../window'
import type { ChromeContextParams, PageContextParams } from '../platform'
import {
  hasSiteInfo,
  isDownloadable,
  joinGroups,
  linkCopyItem,
  NAVIGATION_MENU_MAX,
  navigationWindow,
  SELECTION_TEXT_MAX,
  selectionUrl
} from '../menus'
import { serialiseMenu } from '../rendererMenus'

/**
 * Electron's capabilities, a hand-kept copy of src/main/platform/index.ts: the real object imports
 * Electron, which a core test cannot load. When a capability is added or flipped there, update it
 * here too (the `HostCapabilities` type catches an added one, not a changed value).
 */
const DESKTOP: HostCapabilities = {
  windowControls: true,
  windowControlsOverlay: false,
  windowMaterial: false,
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
  printPreview: true,
  pdfViewer: false,
  agents: true,
  updates: true,
  share: false,
  clipboardChip: false,
  appLinkSettings: false,
  pullToRefresh: false,
  passwords: true,
  defaultBrowser: false,
  requestBlocking: true,
  reducedExtensionIsolation: false,
  pageControls: false,
  darkenSites: false,
  privateTabs: false,
  secureDns: false,
  newTabPage: true,
  pageTabs: false,
  pinShortcuts: false,
  translate: true,
  voiceSearch: false,
  screenCapture: false,
  shareSheet: false,
  selectionToolbar: false,
  popupSurface: true,
  qrScan: false,
  readAloud: false
}

/**
 * The Android host on API 34 without an extension install root (the preview host), a hand-kept
 * copy of `androidCapabilities({ sdkInt: 34, extensions: false, isolatedWorlds: false })` in src/android/platform.ts:
 * that module pulls in the WebView bridge and Vite `?raw` imports a core test cannot load. Keep
 * it in step by hand, as above. A device build turns `extensions` on.
 */
const ANDROID: HostCapabilities = {
  windowControls: false,
  windowControlsOverlay: false,
  windowMaterial: false,
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
  printPreview: false,
  pdfViewer: true,
  agents: true,
  updates: true,
  share: true,
  clipboardChip: true,
  appLinkSettings: true,
  pullToRefresh: true,
  passwords: true,
  defaultBrowser: true,
  requestBlocking: true,
  reducedExtensionIsolation: false,
  pageControls: true,
  darkenSites: true,
  privateTabs: true,
  secureDns: false,
  newTabPage: false,
  pageTabs: true,
  // Kotlin's boot info turns this on where the launcher can pin (ShortcutManagerCompat).
  pinShortcuts: false,
  translate: true,
  voiceSearch: false,
  screenCapture: false,
  shareSheet: false,
  selectionToolbar: true,
  popupSurface: false,
  qrScan: false,
  readAloud: false
}

function memoryIo(files: Record<string, string> = {}): StoreIO {
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
  /** How many popups the host was asked for. */
  popups: () => number
  /** The options of the last popup: where it opened and whether the keyboard asked for it. */
  where: () => MenuPopupOptions | null
  /** Every call a tab view received, as `method(args)`. */
  viewCalls: string[]
  /** What the host's clipboard says on `readText`. */
  clipboardText: { value: string }
  /** The names of the events sent to the window's chrome, in order. */
  sent: string[]
  /** Every `apply` the fake spellchecker host received (empty without `options.spellcheck`). */
  spellcheckApplied: SpellcheckApplied[]
}

interface HarnessOptions {
  formFactor?: FormFactor
  /** The host has an OS emoji picker (Windows, macOS). */
  emojiPanel?: boolean
  /** The host's window is fullscreen. */
  fullScreen?: boolean
  /** The host runs the translation engine (`translate.available`), with no model on the device. */
  translate?: boolean
  /**
   * The host has a spellchecker of the browser's own with these dictionaries (Electron's session
   * spellchecker); `systemLanguages` makes it follow the OS's languages instead (macOS).
   */
  spellcheck?: { available: string[]; locales?: string[]; systemLanguages?: boolean }
  /** The host writes launchers for installed web apps (`capabilities.pinShortcuts` set too). */
  shortcuts?: boolean
  /** What the host's confirmation dialog answers (absent: the stub's nothing, read as No). */
  confirm?: boolean
  /** Documents already in the store when the browser starts (`webapps.json`, …). */
  files?: Record<string, string>
  /** The host has a speech engine (`Platform.speech`; `capabilities.readAloud` set too): read aloud's entry points show. */
  speech?: boolean
}

/** The languages the fake spellchecker was last told to check in. */
interface SpellcheckApplied {
  enabled: boolean
  languages: string[]
}

/** A browser on a host with the given capabilities whose menu popup only records the template. */
function harness(
  capabilities: HostCapabilities,
  options: HarnessOptions | FormFactor = {}
): Harness {
  const opts: HarnessOptions = typeof options === 'string' ? { formFactor: options } : options
  let last: MenuItemTemplate[] = []
  let lastOptions: MenuPopupOptions | null = null
  let count = 0
  const viewCalls: string[] = []
  const clipboardText = { value: '' }
  const sent: string[] = []
  const spellcheckApplied: SpellcheckApplied[] = []
  const spellcheckHost = (): SpellcheckHost => {
    const words = new Set<string>()
    const spec = opts.spellcheck!
    return {
      systemLanguages: Boolean(spec.systemLanguages),
      locales: spec.locales ?? ['en-US'],
      availableLanguages: () => [...spec.available],
      apply: (enabled, languages) =>
        void spellcheckApplied.push({ enabled, languages: [...languages] }),
      onDictionaryStatus: () => undefined,
      listWords: async () => [...words],
      addWord: async (word) => {
        if (words.has(word)) return false
        words.add(word)
        return true
      },
      removeWord: async (word) => words.delete(word)
    }
  }
  const menus: MenuHost = {
    popup: (items, options) => {
      last = items
      lastOptions = options
      count += 1
    }
  }
  /** A view that records what the menus ask of it. */
  const recordingView = (): TabView =>
    new Proxy(
      {
        isDestroyed: () => false,
        isVisible: () => false,
        getZoom: () => 1,
        executeJavaScript: (code: string, frameId?: number) => {
          viewCalls.push(`executeJavaScript(${frameId ?? 0}:${code.replace(/\s+/g, ' ').trim()})`)
          return Promise.resolve(true)
        }
      } as unknown as TabView,
      {
        get: (target, key) => {
          if (key in target) return Reflect.get(target, key)
          if (key === 'then') return undefined
          return (...args: unknown[]) => {
            viewCalls.push(`${String(key)}(${args.map((a) => JSON.stringify(a)).join(',')})`)
            return undefined
          }
        }
      }
    )
  const platform: Platform = {
    info: { os: capabilities.windows ? ('linux' as PlatformOs) : 'android', version: '1.2.3' },
    capabilities,
    io: memoryIo({ ...opts.files }),
    windows: {
      create: () =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => Boolean(opts.fullScreen),
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          send: (name) => void sent.push(name)
        })
    },
    views: stub<TabViewHost>({ createView: () => recordingView() }),
    menus,
    dialogs: stub<DialogHost>(
      opts.confirm === undefined ? {} : { confirm: () => Promise.resolve(opts.confirm!) }
    ),
    clipboard: stub<ClipboardHost>({ readText: () => Promise.resolve(clipboardText.value) }),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    // Optional members must read as absent, which the catch-all stub would not give.
    app: stub<AppHost>({ showEmojiPanel: opts.emojiPanel ? () => undefined : undefined }),
    readabilitySource: () => null,
    ...(opts.translate
      ? {
          translate: stub<TranslateHost>({
            models: stub<TranslateModelStore>({ list: () => Promise.resolve([]) }),
            locales: ['en']
          })
        }
      : {}),
    ...(opts.spellcheck ? { spellcheck: spellcheckHost() } : {}),
    ...(opts.shortcuts ? { shortcuts: stub<ShortcutHost>() } : {}),
    ...(opts.speech
      ? {
          speech: stub<SpeechHost>({
            voices: () => Promise.resolve([]),
            onVoicesChanged: () => undefined,
            onEvent: () => undefined,
            speak: () => undefined,
            stop: () => undefined
          })
        }
      : {})
  }
  const browser = new Browser(platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  if (opts.formFactor)
    browser.handleCommand(win, 'window.formFactor', { formFactor: opts.formFactor })
  return {
    browser,
    win,
    shown: () => last,
    popups: () => count,
    where: () => lastOptions,
    viewCalls,
    clipboardText,
    sent,
    spellcheckApplied
  }
}

/** Let a click that reads the host's clipboard finish. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

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
  h.browser.handleCommand(h.win, 'app.menu', {})
  return labels(h.shown())
}

/** The desktop app menu as it was before the phone variant existed. */
const DESKTOP_APP_MENU = [
  'New Tab',
  'Search Tabs…',
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
  'Bookmarks > Show Bookmarks Bar',
  'Bookmarks > -',
  'Bookmarks > Import Bookmarks and Settings…',
  'Bookmarks > Export Bookmarks…',
  'History',
  'Recently Closed',
  'Downloads',
  'Passwords',
  'Add-ons and Themes',
  '-',
  'Compact Mode',
  'Change Theme…',
  'Zoom',
  'Zoom > Zoom In',
  'Zoom > Zoom Out',
  'Zoom > Reset Zoom',
  'Split View',
  'Split View > Grid',
  'Split View > Vertical',
  'Split View > Horizontal',
  'Split View > -',
  'Split View > Unsplit View',
  'Split View > New Empty Split View',
  'Fullscreen',
  '-',
  'Find in Page…',
  'Reader View',
  'Print…',
  'Save Page As…',
  'Take Screenshot',
  'Capture Full Page',
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

const DESKTOP_ONLY = [
  'Search Tabs…',
  'Keyboard Shortcuts',
  'Compact Mode',
  'Split View',
  'Fullscreen',
  'Quit'
]

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

  it('opens Keyboard Shortcuts through page.open: the Settings overlay on its Shortcuts section on the desktop (a tablet with page tabs gets the tab)', () => {
    const desktop = pageHarness(DESKTOP)
    appMenu(desktop)
    desktop.sent.length = 0
    desktop.click('Keyboard Shortcuts')
    expect(desktop.sent).toContain('overlay.open')
    expect(desktop.browser.tabs.activeTabFor(desktop.win)?.url).toBe(PAGE_URL)

    const tablet = pageHarness(ANDROID, { formFactor: 'tablet' })
    appMenu(tablet)
    tablet.sent.length = 0
    tablet.click('Keyboard Shortcuts')
    expect(tablet.browser.tabs.activeTabFor(tablet.win)?.url).toBe('zen://settings/shortcuts')
    expect(tablet.sent).not.toContain('overlay.open')
  })

  it('offers Text Preferences… under Reader View while a reader page is open, on both hosts', () => {
    for (const [caps, formFactor] of [
      [DESKTOP, undefined],
      [ANDROID, 'phone']
    ] as const) {
      const h = pageHarness(caps, formFactor ? { formFactor } : {})
      // A web page: Reader View is the toggle, the preferences item waits for an article.
      expect(appMenu(h)).not.toContain('Text Preferences…')
      h.browser.tabs.navigate(
        h.tabId,
        'zen://reader?id=article_1&url=https%3A%2F%2Fexample.org%2Fstory'
      )
      const menu = appMenu(h)
      expect(menu.indexOf('Text Preferences…')).toBe(menu.indexOf('Reader View') + 1)
      h.sent.length = 0
      h.click('Text Preferences…')
      // The chrome draws the surface: a popover under the pill on a mouse, a sheet on a phone.
      expect(h.sent).toContain('reader.preferences')
    }
  })

  it('offers Listen to This Page on a host with a speech engine, under Reader View and gated as it is', async () => {
    // No engine, no item – on either host.
    expect(appMenu(pageHarness(ANDROID, { formFactor: 'phone' }))).not.toContain(
      'Listen to This Page'
    )
    expect(appMenu(pageHarness(DESKTOP))).not.toContain('Listen to This Page')
    // The desktop's menu carries it too (the services program's desktop player, the reader UI
    // PR): under Reader View, gated by the same readability signal.
    const desktop = pageHarness({ ...DESKTOP, readAloud: true }, { speech: true })
    const desktopMenu = appMenu(desktop)
    expect(desktopMenu.indexOf('Listen to This Page')).toBe(desktopMenu.indexOf('Reader View') + 1)
    expect(item(desktop.items(), 'Listen to This Page').enabled).toBe(false)
    desktop.browser.tabs.tab(desktop.tabId)!.readerable = true
    appMenu(desktop)
    expect(item(desktop.items(), 'Listen to This Page').enabled).toBe(true)
    const h = pageHarness({ ...ANDROID, readAloud: true }, { formFactor: 'phone', speech: true })
    const menu = appMenu(h)
    expect(menu.indexOf('Listen to This Page')).toBe(menu.indexOf('Reader View') + 1)
    // The reader core's readability signal gates it exactly as it gates Reader View.
    expect(item(h.items(), 'Reader View').enabled).toBe(false)
    expect(item(h.items(), 'Listen to This Page').enabled).toBe(false)
    h.browser.tabs.tab(h.tabId)!.readerable = true
    appMenu(h)
    expect(item(h.items(), 'Reader View').enabled).toBe(true)
    expect(item(h.items(), 'Listen to This Page').enabled).toBe(true)
    // The click starts the core's session on the tab, which asks the page script for the text.
    h.viewCalls.length = 0
    h.click('Listen to This Page')
    await settle()
    expect(h.browser.readAloud.uiState()?.tabId).toBe(h.tabId)
    expect(
      h.viewCalls.some(
        (call) =>
          call.startsWith('postToPage(') &&
          call.includes('"action":"extract"') &&
          call.includes('"from":"top"')
      )
    ).toBe(true)
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

  it('on a phone opens on the icon row and keeps the page and library items in their desktop order', () => {
    // The star moved from the Bookmarks submenu into the row (TB-16): one bookmark entry; and
    // the row's Download Page is the phone's one save entry, so no 'Save Page As…' row (TB-08).
    expect(appMenu(harness(ANDROID, 'phone'))).toEqual([
      'Forward',
      'Bookmark',
      'Download Page',
      'Page Info',
      'Reload',
      '-',
      'New Tab',
      'New Private Tab',
      'Close Private Tabs',
      'New Space…',
      '-',
      'Bookmarks',
      'Bookmarks > Bookmark All Tabs…',
      'Bookmarks > -',
      'Bookmarks > Show Bookmarks',
      'Bookmarks > -',
      'Bookmarks > Import Bookmarks…',
      'Bookmarks > Export Bookmarks…',
      'History',
      'Downloads',
      'Passwords',
      '-',
      'Change Theme…',
      'Zoom…',
      '-',
      'Find in Page…',
      'Reader View',
      'Share…',
      'Print…',
      'Take Screenshot',
      'Capture Full Page',
      'Desktop Site',
      '-',
      'Settings',
      '-',
      'About Zenium 1.2.3'
    ])
  })

  it('offers private tabs where the host keeps the private session in tabs', () => {
    // Private windows: the private entry is the window, as on desktop.
    expect(appMenu(harness(DESKTOP))).not.toContain('New Private Tab')
    expect(appMenu(harness({ ...ANDROID, privateTabs: false }, 'phone'))).not.toContain(
      'New Private Tab'
    )
    const h = harness(ANDROID, 'phone')
    expect(appMenu(h)).toContain('New Private Tab')
    // Nothing to close until a private tab is open: the row stays, greyed (v2 §9.17 – a menu
    // row whose count is zero is disabled, not hidden), and comes alive with the first one.
    const closeRow = (): MenuItemTemplate | undefined => {
      appMenu(h)
      return h.shown().find((item) => item.label === 'Close Private Tabs')
    }
    expect(closeRow()).toMatchObject({ enabled: false })
    h.browser.handleCommand(h.win, 'tab.newPrivate', {})
    expect(closeRow()).toMatchObject({ enabled: true })
    h.browser.handleCommand(h.win, 'tab.closePrivate', undefined)
    expect(closeRow()).toMatchObject({ enabled: false })
  })

  it('on a phone follows the capabilities, not the platform name', () => {
    // A desktop window narrowed to the phone layout: no Share sheet, but extensions exist.
    const menu = appMenu(harness(DESKTOP, 'phone'))
    expect(menu).not.toContain('Share…')
    expect(menu).toContain('Add-ons and Themes')
    for (const label of DESKTOP_ONLY) expect(menu).not.toContain(label)
    // A phone without a printer path hides Print rather than greying it.
    expect(appMenu(harness({ ...ANDROID, print: false }, 'phone'))).not.toContain('Print…')
    // A device build has the extension store: the actions sheet and the management page are
    // reachable from the menu, closing the library block in Firefox's order.
    const withStore = appMenu(harness({ ...ANDROID, extensions: true }, 'phone'))
    const downloads = withStore.indexOf('Downloads')
    expect(withStore.slice(downloads, downloads + 4)).toEqual([
      'Downloads',
      'Passwords',
      'Extensions',
      'Add-ons and Themes'
    ])
  })

  it('offers the Extensions sheet on a phone with extensions only, and opens it through extensions.open', () => {
    // The desktop has the toolbar and the puzzle panel for the actions: its menu is unchanged.
    // The row follows the layout and the capability, not the platform, like the rest of the
    // phone menu; a host without extensions has nothing to list.
    expect(appMenu(harness(DESKTOP))).not.toContain('Extensions')
    expect(appMenu(harness(DESKTOP, 'tablet'))).not.toContain('Extensions')
    expect(appMenu(harness(ANDROID, 'phone'))).not.toContain('Extensions')
    const h = harness({ ...ANDROID, extensions: true }, 'phone')
    const menu = appMenu(h)
    expect(menu).toContain('Extensions')
    expect(menu.indexOf('Extensions')).toBeLessThan(menu.indexOf('Add-ons and Themes'))
    h.sent.length = 0
    h.shown()
      .find((item) => item.label === 'Extensions')
      ?.click?.()
    expect(h.sent).toEqual(['extensions.open'])
  })

  it('offers the install item only to a window whose chrome has an install surface up', () => {
    // A desktop host that writes launchers: the engine can install, but the item is a way into
    // the chrome's install dialog, so until the chrome registers one (`ui.surface`, as the
    // desktop's InstallDialogLayer does on mount) the menu offers no way into a prompt nothing
    // would show.
    const h = harness({ ...DESKTOP, pinShortcuts: true }, { shortcuts: true })
    h.browser.tabs.createTab({ url: PAGE_URL, active: true }, h.win)
    expect(appMenu(h)).not.toContain('Create shortcut…')
    h.browser.handleCommand(h.win, 'ui.surface', { surface: 'install', mounted: true })
    expect(appMenu(h)).toContain('Create shortcut…')
    h.browser.handleCommand(h.win, 'ui.surface', { surface: 'install', mounted: false })
    expect(appMenu(h)).not.toContain('Create shortcut…')
    // A window that never registered any surface has none.
    expect(h.win.surfaces.size).toBe(0)
  })

  describe("a web app's standalone window", () => {
    /** An installed app on record, so its window is the app's (`appId`) and can be uninstalled. */
    const NOTES = JSON.stringify({
      version: 1,
      pinned: [
        {
          id: 'notes',
          name: 'Notes',
          startUrl: 'https://notes.example/',
          scope: 'https://notes.example/',
          pinnedAt: 1,
          icon: null,
          bounds: null
        }
      ],
      engagement: {}
    })
    const WEB_APP_MENU = [
      'Copy URL',
      'Open in Zenium',
      '-',
      'Zoom (100%)',
      'Zoom (100%) > Zoom In',
      'Zoom (100%) > Zoom Out',
      'Zoom (100%) > Reset Zoom (100%)',
      '-',
      'Find in Page…',
      'Print…'
    ]

    it("has Chrome's web-app menu from its title bar's button, not the browser's", () => {
      const h = harness(DESKTOP, { files: { 'webapps.json': NOTES } })
      const app = h.browser.openAppWindow('https://notes.example/today')!
      h.browser.handleCommand(app, 'app.menu', { anchor: { x: 10, y: 20, width: 28, height: 28 } })
      expect(labels(h.shown())).toEqual([...WEB_APP_MENU, '-', 'Uninstall Notes…'])
      // From the button the menu hangs off its bottom edge, as the browser's does.
      expect(h.where()).toMatchObject({ source: 'app', x: 10, y: 48 })
      // The browser window keeps its own menu.
      expect(appMenu(h)).toEqual(DESKTOP_APP_MENU)
    })

    it('offers no Uninstall for a window no installed app owns, and no Print where the host cannot', () => {
      const h = harness({ ...DESKTOP, print: false })
      const app = h.browser.openAppWindow('https://plain.example/page')!
      expect(app.app?.appId).toBeNull()
      h.browser.handleCommand(app, 'app.menu', {})
      expect(labels(h.shown())).toEqual(WEB_APP_MENU.filter((l) => l !== 'Print…'))
    })

    it('Open in Zenium puts the page in a tab of the browser window behind the app', () => {
      const h = harness(DESKTOP)
      const app = h.browser.openAppWindow('https://plain.example/page', { from: h.win })!
      const before = h.browser.tabs.activeSpaceFor(h.win).tabIds.length
      h.browser.handleCommand(app, 'app.menu', {})
      h.shown()
        .find((item) => item.label === 'Open in Zenium')
        ?.click?.()
      expect(h.browser.tabs.activeSpaceFor(h.win).tabIds.length).toBe(before + 1)
      expect(h.browser.tabs.activeTabFor(h.win)?.url).toBe('https://plain.example/page')
      // The app window keeps its page.
      expect(h.browser.tabs.activeTabFor(app)?.url).toBe('https://plain.example/page')
    })

    it('Uninstall asks first; a Yes removes the record and closes the app’s windows, a No keeps both', async () => {
      const no = harness(DESKTOP, { files: { 'webapps.json': NOTES }, confirm: false })
      const kept = no.browser.openAppWindow('https://notes.example/')!
      no.browser.handleCommand(kept, 'app.menu', {})
      no.shown()
        .find((item) => item.label === 'Uninstall Notes…')
        ?.click?.()
      await settle()
      expect(no.browser.webApps.pinnedFor('https://notes.example/')?.name).toBe('Notes')
      expect(kept.alive).toBe(true)

      const yes = harness(DESKTOP, { files: { 'webapps.json': NOTES }, confirm: true })
      const gone = yes.browser.openAppWindow('https://notes.example/')!
      yes.browser.handleCommand(gone, 'app.menu', {})
      yes
        .shown()
        .find((item) => item.label === 'Uninstall Notes…')
        ?.click?.()
      await settle()
      expect(yes.browser.webApps.pinnedFor('https://notes.example/')).toBeNull()
      expect(gone.closeApproved).toBe(true)
    })
  })

  it('closes the page group with the page controls where the host has them', () => {
    // Desktop Site is Chrome's per-site checkbox; the dark-theme exception only joins it while
    // sites are being darkened. A host without page controls shows neither, and keeps the
    // stepping Zoom submenu where a host with them opens the zoom sheet.
    expect(appMenu(harness(DESKTOP, 'phone'))).not.toContain('Desktop Site')
    const plain = appMenu(harness({ ...ANDROID, pageControls: false }, 'phone'))
    expect(plain).not.toContain('Desktop Site')
    expect(plain).not.toContain('Zoom…')
    expect(plain).toContain('Zoom > Zoom In')
    const h = harness(ANDROID, 'phone')
    expect(appMenu(h)).not.toContain('Dark Theme for This Site')
    h.browser.pageControls.update({ darkenSites: true })
    expect(appMenu(h).slice(-6)).toEqual([
      'Desktop Site',
      'Dark Theme for This Site',
      '-',
      'Settings',
      '-',
      'About Zenium 1.2.3'
    ])
  })

  it('leaves the phone layout again when the window widens', () => {
    const h = harness(ANDROID, 'phone')
    expect(appMenu(h)).not.toContain('Quit')
    h.browser.handleCommand(h.win, 'window.formFactor', { formFactor: 'tablet' })
    expect(appMenu(h)).toContain('Keyboard Shortcuts')
  })
})

/** Every item of a template, submenus included. */
function allItems(items: MenuItemTemplate[]): MenuItemTemplate[] {
  return items.flatMap((item) => [item, ...(item.submenu ? allItems(item.submenu) : [])])
}

describe("the phone menu's icon row", () => {
  /** A phone with one loaded web page, its menu open; `row` is the menu's first group. */
  function phone(url = PAGE_URL): PageHarness & { row: () => MenuItemTemplate[] } {
    const h = pageHarness(ANDROID, { formFactor: 'phone' })
    if (url !== PAGE_URL) h.browser.tabs.tab(h.tabId)!.url = url
    return {
      ...h,
      row: () => {
        appMenu(h)
        const items = h.shown()
        return items.slice(
          0,
          items.findIndex((item) => item.type === 'separator')
        )
      }
    }
  }

  it("is Chrome's five, in Chrome's order, each naming its glyph, and heads the phone menu alone", () => {
    const h = phone()
    expect(h.row().map((item) => [item.label, item.glyph])).toEqual([
      ['Forward', 'forward'],
      ['Bookmark', 'star'],
      ['Download Page', 'download'],
      ['Page Info', 'info'],
      ['Reload', 'reload']
    ])
    // The row is the phone layout's: the desktop's native menu and the tablet's carry no glyph
    // anywhere, and their templates are what they were.
    for (const layout of [
      harness(DESKTOP),
      harness(DESKTOP, 'tablet'),
      harness(ANDROID, 'tablet')
    ]) {
      appMenu(layout)
      expect(allItems(layout.shown()).every((item) => item.glyph === undefined)).toBe(true)
    }
    // Rows of text below the row carry none either.
    appMenu(h)
    expect(allItems(h.shown().slice(6)).every((item) => item.glyph === undefined)).toBe(true)
  })

  it('serialises the glyph for the chrome and leaves every other descriptor as it was', () => {
    const { items } = serialiseMenu(
      [
        { label: 'Forward', glyph: 'forward', enabled: false },
        { type: 'separator' },
        { label: 'New Tab', click: () => undefined }
      ],
      'm'
    )
    expect(items[0]).toMatchObject({ label: 'Forward', glyph: 'forward', enabled: false })
    expect('glyph' in items[1]).toBe(false)
    expect('glyph' in items[2]).toBe(false)
  })

  it('has Forward disabled with no forward entry and stepping forward with one (§9.30: greyed, not gone)', () => {
    const h = phone()
    const forward = (): MenuItemTemplate => h.row()[0]
    expect(forward()).toMatchObject({ label: 'Forward', enabled: false })
    h.browser.tabs.tab(h.tabId)!.canGoForward = true
    expect(forward()).toMatchObject({ enabled: true })
    const go = vi.spyOn(h.browser.tabs, 'goForward').mockImplementation(() => undefined)
    forward().click?.()
    expect(go).toHaveBeenCalledWith(h.tabId)
  })

  it("the star is the page's bookmark: unfilled and saving on a new page, filled and editing on a bookmarked one, off a page that takes no bookmark", () => {
    const h = phone()
    const star = (): MenuItemTemplate => h.row()[1]
    expect(star()).toMatchObject({
      label: 'Bookmark',
      checked: false,
      enabled: true
    })
    // A stateful glyph, not a toggle (§9.13): a plain item whose `checked` is the fill – never a
    // checkbox, which the mouse popover would tick. The chrome gets `checked` either way.
    expect(star().type).toBeUndefined()
    appMenu(h)
    expect(serialiseMenu(h.shown(), 'm').items[1]).toMatchObject({ type: 'normal', checked: false })
    const flow = vi.spyOn(h.browser, 'starTab')
    star().click?.()
    expect(flow).toHaveBeenCalledWith(h.tabId, h.win)
    // The star flow saved the page: the row's star is filled now and a press edits.
    expect(h.browser.tabs.tab(h.tabId)!.bookmarked).toBe(true)
    expect(star()).toMatchObject({ label: 'Edit Bookmark', checked: true, enabled: true })
    appMenu(h)
    expect(serialiseMenu(h.shown(), 'm').items[1]).toMatchObject({ type: 'normal', checked: true })
    // The bookmarks submenu has no second entry for it on the phone.
    appMenu(h)
    const bookmarks = h.shown().find((item) => item.label === 'Bookmarks')
    expect(bookmarks?.submenu?.map((item) => item.label ?? '-')).toEqual([
      'Bookmark All Tabs…',
      '-',
      'Show Bookmarks',
      '-',
      'Import Bookmarks…',
      'Export Bookmarks…'
    ])
    // A blank tab has nothing to bookmark.
    const blank = phone('zen://blank')
    expect(blank.row()[1]).toMatchObject({ label: 'Bookmark', enabled: false })
  })

  it('Download Page saves a web page through page.savePage and is off elsewhere; it is the phone menu’s one save entry', () => {
    const h = phone()
    expect(h.row()[2]).toMatchObject({ label: 'Download Page', glyph: 'download', enabled: true })
    const run = vi.spyOn(h.browser.actions, 'run').mockImplementation(() => undefined)
    h.row()[2].click?.()
    expect(run).toHaveBeenCalledWith('page.savePage', { sourceTabId: h.tabId, win: h.win })
    expect(phone('zen://settings').row()[2]).toMatchObject({ enabled: false })
    expect(phone('zen://blank').row()[2]).toMatchObject({ enabled: false })
    // Chrome's phone menu saves through the icon alone: the text row is the desktop's, so the
    // same command is not offered twice (once gated to the web, once not).
    appMenu(h)
    expect(allItems(h.shown()).filter((item) => item.action === 'page.savePage')).toHaveLength(1)
    expect(appMenu(h)).not.toContain('Save Page As…')
    expect(appMenu(harness(DESKTOP))).toContain('Save Page As…')
    expect(appMenu(harness(ANDROID, 'tablet'))).toContain('Save Page As…')
  })

  it('Page Info asks the chrome for the site information sheet, and is off where there is no site', () => {
    const h = phone()
    expect(h.row()[3]).toMatchObject({ label: 'Page Info', glyph: 'info', enabled: true })
    h.sent.length = 0
    h.row()[3].click?.()
    expect(h.sent).toEqual(['siteInfo.open'])
    // No site: a blank or new tab, a registered internal page; a site's error page keeps it.
    expect(phone('zen://blank').row()[3]).toMatchObject({ enabled: false })
    expect(phone('zen://newtab').row()[3]).toMatchObject({ enabled: false })
    expect(phone('zen://settings/privacy').row()[3]).toMatchObject({ enabled: false })
    expect(hasSiteInfo({ url: 'zen://error?url=https%3A%2F%2Fexample.com' })).toBe(true)
    expect(hasSiteInfo({ url: 'file:///sdcard/page.html' })).toBe(true)
    expect(hasSiteInfo({ url: 'zen://settings' })).toBe(false)
  })

  it('Reload is Stop while the page loads, each running its own command', () => {
    const h = phone()
    const last = (): MenuItemTemplate => h.row()[4]
    expect(last()).toMatchObject({ label: 'Reload', glyph: 'reload', enabled: true })
    const reload = vi.spyOn(h.browser.tabs, 'reload').mockImplementation(() => undefined)
    last().click?.()
    expect(reload).toHaveBeenCalledWith(h.tabId)
    h.browser.tabs.tab(h.tabId)!.loading = true
    expect(last()).toMatchObject({ label: 'Stop', glyph: 'stop' })
    const stop = vi.spyOn(h.browser.tabs, 'stop').mockImplementation(() => undefined)
    last().click?.()
    expect(stop).toHaveBeenCalledWith(h.tabId)
    expect(reload).toHaveBeenCalledTimes(1)
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
    expect(ids('passwords', phone)).toEqual(['passwords'])
    expect(ids('passwords', { ...phone, capabilities: { ...ANDROID, passwords: false } })).toEqual(
      []
    )
  })

  it('keep the phone-relevant commands', () => {
    expect(ids('theme', phone)).toContain('theme')
    expect(ids('zoom', phone)).toEqual(expect.arrayContaining(['zoom-in', 'zoom-out']))
    expect(ids('reader', phone)).toContain('reader')
    expect(ids('screenshot', phone)).toContain('screenshot')
    expect(ids('history', phone)).toContain('history')
  })
})

// ---------------------------------------------------------------------------
// Page context menus
// ---------------------------------------------------------------------------

const PAGE_URL = 'https://example.com/article'

const NO_EDITS: PageContextParams['editFlags'] = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canDelete: false,
  canSelectAll: false
}

const ALL_EDITS: PageContextParams['editFlags'] = {
  canUndo: true,
  canRedo: true,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canDelete: true,
  canSelectAll: true
}

/** A `context-menu` event's parameters for a click on the plain page, overridable per target. */
function pageParams(overrides: Partial<PageContextParams> = {}): PageContextParams {
  return {
    x: 120,
    y: 240,
    linkURL: '',
    srcURL: '',
    mediaType: 'none',
    selectionText: '',
    isEditable: false,
    misspelledWord: '',
    dictionarySuggestions: [],
    pageURL: PAGE_URL,
    frameURL: '',
    frameId: 0,
    editFlags: NO_EDITS,
    ...overrides
  }
}

const VIDEO_FLAGS: NonNullable<PageContextParams['mediaFlags']> = {
  inError: false,
  isPaused: true,
  isMuted: false,
  hasAudio: true,
  isLooping: false,
  isControlsVisible: true,
  canToggleControls: true,
  canSave: true,
  canShowPictureInPicture: true,
  isShowingPictureInPicture: false,
  canLoop: true
}

interface PageHarness extends Harness {
  tabId: string
  /** Show the page menu for `params` and return its top-level labels (submenus collapsed). */
  menu: (params: PageContextParams) => string[]
  /** The last template's items, top level only. */
  items: () => MenuItemTemplate[]
  /** Click the item labelled `label` in the last template. */
  click: (label: string) => void
}

/** A desktop browser with one loaded web page tab. */
function pageHarness(
  capabilities: HostCapabilities = DESKTOP,
  options: HarnessOptions = {}
): PageHarness {
  const h = harness(capabilities, options)
  const tab = h.browser.tabs.createTab({ url: PAGE_URL, active: true }, h.win)
  h.viewCalls.length = 0
  const items = (): MenuItemTemplate[] => h.shown()
  const click = (label: string): void => {
    const item = items().find((i) => i.label === label)
    if (!item?.click) throw new Error(`no clickable "${label}" in ${topLabels(items()).join(', ')}`)
    item.click()
  }
  return {
    ...h,
    tabId: tab.id,
    menu: (params) => {
      h.browser.menus.showPageContextMenu(tab.id, params, h.win)
      return topLabels(h.shown())
    },
    items,
    click
  }
}

/** Labels in order, separators as `-`, submenus as their label only. */
function topLabels(items: MenuItemTemplate[]): string[] {
  return items.map((item) => (item.type === 'separator' ? '-' : (item.label ?? '')))
}

function separators(items: MenuItemTemplate[]): number {
  return items.filter((item) => item.type === 'separator').length
}

function item(items: MenuItemTemplate[], label: string): MenuItemTemplate {
  const found = items.find((i) => i.label === label)
  if (!found) throw new Error(`no "${label}" in ${topLabels(items).join(', ')}`)
  return found
}

describe('the page context menu', () => {
  it('on the plain page has Chrome’s groups: navigation, page, developer', () => {
    const h = pageHarness()
    expect(h.menu(pageParams())).toEqual([
      'Back',
      'Forward',
      'Reload',
      '-',
      'Bookmark Page',
      'Save Page As…',
      'Print…',
      'Take Screenshot',
      'Capture Full Page',
      'Enter Reader View',
      '-',
      'Boosts',
      'View Page Source',
      'Inspect Element'
    ])
    expect(item(h.items(), 'Back').enabled).toBe(false)
    expect(item(h.items(), 'Back').action).toBe('nav.back')
    expect(item(h.items(), 'Inspect Element').action).toBe('devtools.inspector')
  })

  it('leaves Print, View Page Source and Inspect to hosts that have them', () => {
    const menu = pageHarness({
      ...DESKTOP,
      print: false,
      viewSource: false,
      devtools: false
    }).menu(pageParams())
    expect(menu).not.toContain('Print…')
    expect(menu).not.toContain('View Page Source')
    expect(menu).not.toContain('Inspect Element')
  })

  it('inspects the clicked node, not the document corner', () => {
    const h = pageHarness()
    h.menu(pageParams({ x: 333, y: 44 }))
    h.click('Inspect Element')
    expect(h.viewCalls).toEqual(['inspectElementAt(333,44)'])
  })

  it('offers a way out of fullscreen while the page is in it', () => {
    const h = pageHarness()
    h.win.htmlFullscreenTabId = h.tabId
    expect(h.menu(pageParams())[0]).toBe('Exit Full Screen')
    h.click('Exit Full Screen')
    expect(h.viewCalls[0]).toContain('document.exitFullscreen()')
    h.win.htmlFullscreenTabId = null
    expect(h.menu(pageParams())[0]).toBe('Back')
    expect(pageHarness(DESKTOP, { fullScreen: true }).menu(pageParams())[0]).toBe(
      'Exit Full Screen'
    )
  })

  it('adds the frame items for a click inside a sub-frame', () => {
    const h = pageHarness()
    const menu = h.menu(pageParams({ frameId: 7, frameURL: 'https://ads.example.net/frame' }))
    expect(menu.slice(-5)).toEqual([
      'Reload Frame',
      'View Frame Source',
      'Boosts',
      'View Page Source',
      'Inspect Element'
    ])
    expect(separators(h.items())).toBeLessThanOrEqual(3)
    h.click('Reload Frame')
    expect(h.viewCalls).toEqual(['reloadFrame(7)'])
    h.click('View Frame Source')
    const urls = Object.values(h.browser.state.model.tabs).map((t) => t.url)
    expect(urls).toContain('view-source:https://ads.example.net/frame')
  })

  it('shows a link’s open targets, then its save and copy items', () => {
    const h = pageHarness()
    const menu = h.menu(
      pageParams({ linkURL: 'https://example.org/next', linkText: 'Next chapter' })
    )
    expect(menu).toEqual([
      'Open Link in New Tab',
      'Open Link in New Window',
      'Open Link in New Private Window',
      'Open Link in Glance',
      'Open Link in Split View',
      'Open Link in New Container Tab',
      '-',
      'Save Link As…',
      'Copy Link Address',
      'Copy Link Text',
      '-',
      'Boosts',
      'Inspect Element'
    ])
    h.click('Save Link As…')
    expect(h.viewCalls).toEqual(['downloadURL("https://example.org/next",{"saveAs":true})'])
  })

  it('opens a link in a new Zenium window', () => {
    const h = pageHarness()
    h.menu(pageParams({ linkURL: 'https://example.org/next' }))
    const before = h.browser.allWindows().length
    h.click('Open Link in New Window')
    const windows = h.browser.allWindows()
    expect(windows.length).toBe(before + 1)
    const opened = windows[windows.length - 1] as ZenWindow
    const tabs = Object.values(h.browser.state.model.tabs).filter(
      (t) => t.url === 'https://example.org/next'
    )
    expect(tabs.length).toBe(1)
    expect(opened.isPrivate).toBe(false)
  })

  it('gives a mailto: link its copy item and nothing to open', () => {
    const h = pageHarness()
    const menu = h.menu(
      pageParams({ linkURL: 'mailto:hello@example.com?subject=Hi', linkText: 'Write to us' })
    )
    expect(menu).toEqual(['Copy Email Address', 'Copy Link Text', '-', 'Boosts', 'Inspect Element'])
    expect(pageHarness().menu(pageParams({ linkURL: 'tel:+1-555-0100' }))[0]).toBe(
      'Copy Phone Number'
    )
  })

  it('lists the image items in Chrome’s order and saves through the dialog', () => {
    const h = pageHarness()
    const menu = h.menu(pageParams({ mediaType: 'image', srcURL: 'https://example.com/a.png' }))
    expect(menu).toEqual([
      'Open Image in New Tab',
      'Save Image As…',
      'Copy Image',
      'Copy Image Address',
      '-',
      'Boosts',
      'Inspect Element'
    ])
    h.click('Save Image As…')
    expect(h.viewCalls).toEqual(['downloadURL("https://example.com/a.png",{"saveAs":true})'])
  })

  it('folds a linked image’s link items into one group to stay within three separators', () => {
    const h = pageHarness()
    const menu = h.menu(
      pageParams({
        linkURL: 'https://example.org/next',
        mediaType: 'image',
        srcURL: 'https://example.com/a.png'
      })
    )
    expect(menu.indexOf('Save Link As…')).toBe(menu.indexOf('Open Link in New Container Tab') + 1)
    expect(menu.indexOf('-')).toBe(menu.indexOf('Open Image in New Tab') - 1)
    expect(separators(h.items())).toBeLessThanOrEqual(3)
  })

  it('gives a video its controls, then its save, copy and open items', () => {
    const h = pageHarness()
    const menu = h.menu(
      pageParams({
        mediaType: 'video',
        srcURL: 'https://example.com/clip.mp4',
        mediaFlags: VIDEO_FLAGS
      })
    )
    expect(menu).toEqual([
      'Play',
      'Mute',
      'Loop',
      'Show Controls',
      'Picture-in-Picture',
      '-',
      'Save Video As…',
      'Copy Video Address',
      'Open Video in New Tab',
      '-',
      'Boosts',
      'Inspect Element'
    ])
    expect(item(h.items(), 'Loop').type).toBe('checkbox')
    expect(item(h.items(), 'Loop').checked).toBe(false)
    expect(item(h.items(), 'Show Controls').checked).toBe(true)
    h.click('Loop')
    expect(h.viewCalls[0]).toContain('el.loop = true')
    h.click('Play')
    expect(h.viewCalls[1]).toContain('el.play()')
  })

  it('follows the media flags: paused / muted labels, unsaveable streams, PiP state', () => {
    const h = pageHarness()
    h.menu(
      pageParams({
        mediaType: 'video',
        srcURL: 'blob:https://example.com/stream',
        mediaFlags: {
          ...VIDEO_FLAGS,
          isPaused: false,
          isMuted: true,
          canSave: false,
          isShowingPictureInPicture: true
        }
      })
    )
    const labels = topLabels(h.items())
    expect(labels.slice(0, 2)).toEqual(['Pause', 'Unmute'])
    expect(labels).toContain('Exit Picture-in-Picture')
    expect(item(h.items(), 'Save Video As…').enabled).toBe(false)
  })

  it("withholds Picture-in-Picture from a private tab's video (Chrome withholds it from Incognito)", () => {
    const h = pageHarness()
    const priv = h.browser.tabs.createTab(
      { url: PAGE_URL, active: true, containerId: PRIVATE_CONTAINER_ID },
      h.win
    )
    h.browser.menus.showPageContextMenu(
      priv.id,
      pageParams({
        mediaType: 'video',
        srcURL: 'https://example.com/clip.mp4',
        mediaFlags: VIDEO_FLAGS
      }),
      h.win
    )
    const labels = topLabels(h.shown())
    expect(labels).toContain('Show Controls')
    expect(labels).not.toContain('Picture-in-Picture')
    expect(labels).not.toContain('Exit Picture-in-Picture')
  })

  it('gives audio the same menu without Picture-in-Picture', () => {
    const menu = pageHarness().menu(
      pageParams({
        mediaType: 'audio',
        srcURL: 'https://example.com/a.mp3',
        mediaFlags: VIDEO_FLAGS
      })
    )
    expect(menu).toEqual([
      'Play',
      'Mute',
      'Loop',
      'Show Controls',
      '-',
      'Save Audio As…',
      'Copy Audio Address',
      'Open Audio in New Tab',
      '-',
      'Boosts',
      'Inspect Element'
    ])
  })

  it('runs media controls in the frame the click landed in', () => {
    const h = pageHarness()
    h.menu(
      pageParams({
        mediaType: 'video',
        srcURL: 'https://example.com/clip.mp4',
        mediaFlags: VIDEO_FLAGS,
        frameId: 12
      })
    )
    h.click('Mute')
    expect(h.viewCalls[0]).toMatch(/^executeJavaScript\(12:/)
  })

  it('searches the default engine for a selection in a new tab next to this one', () => {
    const h = pageHarness()
    const menu = h.menu(pageParams({ selectionText: '  quantum foam  ' }))
    expect(menu).toEqual([
      'Copy',
      'Search Google for “quantum foam”',
      '-',
      'Boosts',
      'Inspect Element'
    ])
    h.click('Search Google for “quantum foam”')
    const active = h.browser.tabs.activeTabFor(h.win)
    expect(active?.id).not.toBe(h.tabId)
    expect(active?.url).toContain('quantum%20foam')
    expect(active?.url).toMatch(/^https:\/\/www\.google\./)
  })

  it('clips a long selection in the search label at fifty characters', () => {
    const long = 'a'.repeat(80)
    const menu = pageHarness().menu(pageParams({ selectionText: long }))
    const label = menu[1] ?? ''
    expect(label.startsWith('Search Google for “')).toBe(true)
    expect(label.endsWith('…”')).toBe(true)
    expect(label.length).toBe('Search Google for “”'.length + 50)
  })

  it('offers Go to <url> instead of a search when the selection reads as an address', () => {
    const h = pageHarness()
    const menu = h.menu(pageParams({ selectionText: 'example.org/docs' }))
    expect(menu[1]).toBe('Go to example.org/docs')
    expect(menu).not.toContain('Search Google for “example.org/docs”')
    h.click('Go to example.org/docs')
    expect(h.browser.tabs.activeTabFor(h.win)?.url).toBe('https://example.org/docs')
  })

  it('gives a text field the editing group and nothing else', () => {
    const h = pageHarness()
    const menu = h.menu(pageParams({ isEditable: true, editFlags: ALL_EDITS }))
    expect(menu).toEqual([
      'Undo',
      'Redo',
      'Cut',
      'Copy',
      'Paste',
      'Paste as Plain Text',
      'Delete',
      'Select All',
      '-',
      'Boosts',
      'Inspect Element'
    ])
    expect(item(h.items(), 'Paste').role).toBe('paste')
    expect(item(h.items(), 'Paste as Plain Text').role).toBe('pasteAndMatchStyle')
  })

  it('searches a field’s selected text from the end of the editing group', () => {
    const h = pageHarness()
    const menu = h.menu(
      pageParams({ isEditable: true, editFlags: ALL_EDITS, selectionText: 'quantum foam' })
    )
    expect(menu.indexOf('Search Google for “quantum foam”')).toBe(menu.indexOf('Select All') + 1)
    expect(menu.filter((l) => l === 'Copy').length).toBe(1)
  })

  it('treats a javascript: link as no link at all', () => {
    expect(pageHarness().menu(pageParams({ linkURL: 'javascript:void(0)' }))[0]).toBe('Back')
  })

  it('greys the editing items the field cannot do', () => {
    const h = pageHarness()
    h.menu(pageParams({ isEditable: true, editFlags: { ...NO_EDITS, canPaste: true } }))
    expect(item(h.items(), 'Undo').enabled).toBe(false)
    expect(item(h.items(), 'Paste').enabled).toBe(true)
    expect(item(h.items(), 'Select All').enabled).toBe(false)
  })

  it('puts the spelling suggestions first and replaces the word on click', () => {
    const h = pageHarness()
    const menu = h.menu(
      pageParams({
        isEditable: true,
        editFlags: ALL_EDITS,
        misspelledWord: 'teh',
        dictionarySuggestions: ['the', 'tea', 'ten', 'tech', 'thee', 'tee', 'toe']
      })
    )
    expect(menu.slice(0, 7)).toEqual([
      'the',
      'tea',
      'ten',
      'tech',
      'thee',
      'Add to Dictionary',
      '-'
    ])
    expect(menu).not.toContain('tee')
    h.click('tea')
    h.click('Add to Dictionary')
    expect(h.viewCalls).toEqual(['replaceMisspelling("tea")', 'addWordToDictionary("teh")'])
    expect(separators(h.items())).toBeLessThanOrEqual(3)
  })

  it('says so when the checker has no suggestions', () => {
    const h = pageHarness()
    const menu = h.menu(
      pageParams({ isEditable: true, editFlags: ALL_EDITS, misspelledWord: 'xqzt' })
    )
    expect(menu.slice(0, 3)).toEqual(['No Spelling Suggestions', 'Add to Dictionary', '-'])
    expect(item(h.items(), 'No Spelling Suggestions').enabled).toBe(false)
  })

  it('does not offer to search the auto-selected misspelled word', () => {
    // Right-clicking a misspelled word selects it; its group is the suggestions, not a web search
    // (as in Chrome).
    const menu = pageHarness().menu(
      pageParams({
        isEditable: true,
        editFlags: ALL_EDITS,
        misspelledWord: 'teh',
        dictionarySuggestions: ['the'],
        selectionText: 'teh'
      })
    )
    expect(menu.some((l) => l.startsWith('Search'))).toBe(false)
    expect(menu).toContain('the')
  })

  it('offers the emoji picker only where the host has one', () => {
    const without = pageHarness().menu(pageParams({ isEditable: true, editFlags: ALL_EDITS }))
    expect(without).not.toContain('Emoji')
    const h = pageHarness(DESKTOP, { emojiPanel: true })
    const menu = h.menu(pageParams({ isEditable: true, editFlags: ALL_EDITS }))
    expect(menu.indexOf('Emoji')).toBe(menu.indexOf('Select All') + 1)
  })

  it('gives a text field Chrome’s Spell Check submenu after the editing group on a host with its own checker', () => {
    const h = pageHarness(DESKTOP, {
      spellcheck: { available: ['en-US', 'en-GB', 'de', 'fr', 'nl'], locales: ['en-US', 'de'] }
    })
    const field = pageParams({ isEditable: true, editFlags: ALL_EDITS })
    const menu = h.menu(field)
    expect(menu.slice(menu.indexOf('Select All'))).toEqual([
      'Select All',
      '-',
      'Spell Check',
      '-',
      'Boosts',
      'Inspect Element'
    ])
    expect(separators(h.items())).toBeLessThanOrEqual(3)
    // The languages checked now lead, checked; the UI languages' other dictionaries follow,
    // unchecked; then the switch and the way to Settings › Languages.
    const submenu = item(h.items(), 'Spell Check').submenu!
    expect(labels(submenu)).toEqual([
      'English (United States)',
      'German',
      '-',
      'Check the Spelling of Text Fields',
      '-',
      'Language Settings'
    ])
    expect(submenu[0]).toMatchObject({ type: 'checkbox', checked: true, enabled: true })
    expect(submenu[1]).toMatchObject({ type: 'checkbox', checked: false, enabled: true })
    expect(submenu[3]).toMatchObject({ type: 'checkbox', checked: true })

    // German checks in next to English and reads checked the next time.
    submenu[1].click!()
    expect(h.spellcheckApplied.at(-1)).toEqual({ enabled: true, languages: ['en-US', 'de'] })
    h.menu(field)
    const again = item(h.items(), 'Spell Check').submenu!
    expect(again[1]).toMatchObject({ label: 'German', checked: true })

    // The switch turns the checker off; the languages then read unchecked and greyed, as in Chrome.
    again[3].click!()
    expect(h.spellcheckApplied.at(-1)).toEqual({ enabled: false, languages: ['en-US', 'de'] })
    h.menu(field)
    const off = item(h.items(), 'Spell Check').submenu!
    expect(off[0]).toMatchObject({ checked: false, enabled: false })
    expect(off[1]).toMatchObject({ checked: false, enabled: false })
    expect(off[3]).toMatchObject({ checked: false })
    off[3].click!()
    expect(h.spellcheckApplied.at(-1)).toEqual({ enabled: true, languages: ['en-US', 'de'] })

    // Language Settings opens Settings on its Languages section (the overlay on the desktop).
    h.menu(field)
    h.sent.length = 0
    item(h.items(), 'Spell Check').submenu![5].click!()
    expect(h.sent).toContain('overlay.open')
  })

  it('sends Add to Dictionary to the profile’s dictionary where the host keeps one, not the view’s session', async () => {
    const h = pageHarness(DESKTOP, { spellcheck: { available: ['en-US'] } })
    h.menu(
      pageParams({
        isEditable: true,
        editFlags: ALL_EDITS,
        misspelledWord: 'Zenium',
        dictionarySuggestions: ['Zen']
      })
    )
    h.click('Add to Dictionary')
    await settle()
    expect(await h.browser.spellcheck.words()).toEqual(['Zenium'])
    expect(h.viewCalls).toEqual([])
  })

  it('leaves the Spell Check submenu to hosts that check spelling and choose their own languages', () => {
    const field = pageParams({ isEditable: true, editFlags: ALL_EDITS })
    // Android: the system's checker, chosen in the keyboard settings.
    expect(pageHarness(ANDROID).menu(field)).not.toContain('Spell Check')
    // macOS: the OS's languages; the submenu would have nothing to offer.
    const mac = pageHarness(DESKTOP, {
      spellcheck: { available: ['en-US', 'de'], systemLanguages: true }
    })
    expect(mac.menu(field)).not.toContain('Spell Check')
    expect(mac.spellcheckApplied).toEqual([{ enabled: true, languages: [] }])
  })

  it('never needs more than three separators', () => {
    const h = pageHarness()
    const cases: PageContextParams[] = [
      pageParams(),
      pageParams({ frameId: 3, frameURL: 'https://example.net/' }),
      pageParams({ linkURL: 'https://example.org/', linkText: 'x' }),
      pageParams({
        linkURL: 'https://example.org/',
        mediaType: 'image',
        srcURL: 'https://e.com/i.png'
      }),
      pageParams({ linkURL: 'https://example.org/', selectionText: 'text' }),
      pageParams({ mediaType: 'video', srcURL: 'https://e.com/v.mp4', mediaFlags: VIDEO_FLAGS }),
      pageParams({
        isEditable: true,
        editFlags: ALL_EDITS,
        misspelledWord: 'teh',
        dictionarySuggestions: ['the']
      }),
      pageParams({ selectionText: 'some words' })
    ]
    for (const params of cases) {
      h.menu(params)
      expect(separators(h.items())).toBeLessThanOrEqual(3)
      // Separators only between groups: never first, last or doubled.
      const labels = topLabels(h.items())
      expect(labels[0]).not.toBe('-')
      expect(labels[labels.length - 1]).not.toBe('-')
      expect(labels.join(',')).not.toContain('-,-')
    }
  })

  it('leaves the window items to hosts with windows and Share to hosts with a sheet', () => {
    const menu = pageHarness({ ...DESKTOP, windows: false, share: true }).menu(
      pageParams({ linkURL: 'https://example.org/' })
    )
    expect(menu).not.toContain('Open Link in New Window')
    expect(menu).not.toContain('Open Link in New Private Window')
    expect(menu).toContain('Share Link…')
  })

  it('offers Open Link in Private Tab only where private browsing is a tab (Android)', () => {
    const params = pageParams({ linkURL: 'https://example.org/next' })
    expect(pageHarness(DESKTOP).menu(params)).not.toContain('Open Link in Private Tab')
    const h = pageHarness(ANDROID)
    const menu = h.menu(params)
    expect(menu.indexOf('Open Link in Private Tab')).toBe(menu.indexOf('Open Link in New Tab') + 1)
    expect(menu).not.toContain('Open Link in New Private Window')
    h.click('Open Link in Private Tab')
    const opened = Object.values(h.browser.state.model.tabs).find(
      (t) => t.url === 'https://example.org/next'
    )
    expect(opened?.containerId).toBe(PRIVATE_CONTAINER_ID)
    expect(h.browser.tabs.activeTabFor(h.win)?.id).toBe(opened?.id)
    // Without the capability (an old WebView) the item stays out, as the windows items do.
    expect(pageHarness({ ...ANDROID, privateTabs: false }).menu(params)).not.toContain(
      'Open Link in Private Tab'
    )
  })
})

// ---------------------------------------------------------------------------
// The floating selection toolbar (Android's action mode over selected page text)
// ---------------------------------------------------------------------------

describe('the selection toolbar', () => {
  const PHONE: HarnessOptions = { formFactor: 'phone' }

  it('has no items on a desktop host, whose page context menu carries the actions', () => {
    const h = pageHarness()
    expect(h.browser.menus.selectionToolbar(h.tabId, 'quantum foam')).toEqual([])
    expect(h.browser.menus.runSelectionAction(h.tabId, 'search', 'quantum foam')).toBe(false)
    expect(h.browser.tabs.activeTabFor(h.win)?.id).toBe(h.tabId)
    expect(h.menu(pageParams({ selectionText: 'quantum foam' })).slice(0, 2)).toEqual([
      'Copy',
      'Search Google for “quantum foam”'
    ])
  })

  it('on the phone lists Search <engine> then Share for text, and nothing for blank text or a gone tab', () => {
    const h = pageHarness(ANDROID, PHONE)
    expect(h.browser.menus.selectionToolbar(h.tabId, '  quantum foam ')).toEqual([
      { id: 'search', title: 'Search Google' },
      { id: 'share', title: 'Share' }
    ])
    // The title names the engine the search goes through, the menu's own (never the browser).
    h.browser.handleCommand(h.win, 'settings.update', { searchEngineId: 'duckduckgo' })
    expect(h.browser.menus.selectionToolbar(h.tabId, 'quantum foam')[0]).toEqual({
      id: 'search',
      title: 'Search DuckDuckGo'
    })
    expect(h.menu(pageParams({ selectionText: 'quantum foam' }))[1]).toBe(
      'Search DuckDuckGo for “quantum foam”'
    )
    expect(h.browser.menus.selectionToolbar(h.tabId, '   ')).toEqual([])
    expect(h.browser.menus.selectionToolbar('tab_gone', 'quantum foam')).toEqual([])
  })

  it('with a speech engine lists Listen last in the bar and in the menu, and starts the core from the selection reading on', async () => {
    expect(pageHarness(ANDROID, PHONE).browser.menus.selectionToolbar('t', 'quantum foam')).toEqual(
      []
    )
    const h = pageHarness({ ...ANDROID, readAloud: true }, { ...PHONE, speech: true })
    expect(h.browser.menus.selectionToolbar(h.tabId, 'quantum foam')).toEqual([
      { id: 'search', title: 'Search Google' },
      { id: 'share', title: 'Share' },
      { id: 'readAloud', title: 'Listen' }
    ])
    expect(h.menu(pageParams({ selectionText: 'quantum foam' })).slice(0, 4)).toEqual([
      'Copy',
      'Search Google for “quantum foam”',
      'Share…',
      'Listen'
    ])
    // Without an engine the menu has no such item either. (The item is worded "Listen", the app
    // menu's verb, so that beside Google's process-text "Read aloud" the pair reads as two things.)
    expect(
      pageHarness(ANDROID, PHONE).menu(pageParams({ selectionText: 'quantum foam' }))
    ).not.toContain('Listen')
    // The desktop's right-click menu on a selection carries it too (the reader UI PR's desktop
    // player), and without an engine it does not; its item reads on from the selection to the
    // document's end (Edge's, the model's `selection-on`), as the phone's does.
    expect(pageHarness(DESKTOP).menu(pageParams({ selectionText: 'quantum foam' }))).not.toContain(
      'Listen'
    )
    const desktop = pageHarness({ ...DESKTOP, readAloud: true }, { speech: true })
    expect(desktop.browser.readAloud.available).toBe(true)
    expect(desktop.menu(pageParams({ selectionText: 'quantum foam' }))).toContain('Listen')
    desktop.viewCalls.length = 0
    desktop.click('Listen')
    await settle()
    expect(desktop.browser.readAloud.uiState()).toMatchObject({
      tabId: desktop.tabId,
      source: 'selection'
    })
    expect(
      desktop.viewCalls.some(
        (call) =>
          call.startsWith('postToPage(') &&
          call.includes('"action":"extract"') &&
          call.includes('"from":"selection"') &&
          call.includes('"then":"document"')
      )
    ).toBe(true)
    // The touch starts the core's one session from the selection and reads on: the page script
    // is asked for the selection's text and then the document's after it (`then: 'document'`,
    // EDGE-11's "read aloud from here"; Chrome would read the selection alone).
    h.viewCalls.length = 0
    expect(h.browser.menus.runSelectionAction(h.tabId, 'readAloud', 'quantum foam')).toBe(true)
    await settle()
    expect(h.browser.readAloud.uiState()).toMatchObject({ tabId: h.tabId, source: 'selection' })
    expect(
      h.viewCalls.some(
        (call) =>
          call.startsWith('postToPage(') &&
          call.includes('"action":"extract"') &&
          call.includes('"from":"selection"') &&
          call.includes('"then":"document"')
      )
    ).toBe(true)
  })

  it('takes at most SELECTION_TEXT_MAX characters of a host selection', () => {
    const h = pageHarness(ANDROID, PHONE)
    const long = 'a'.repeat(SELECTION_TEXT_MAX + 500)
    expect(h.browser.menus.selectionToolbar(h.tabId, long).map((item) => item.id)).toEqual([
      'search',
      'share'
    ])
    expect(h.browser.menus.runSelectionAction(h.tabId, 'search', long)).toBe(true)
    const tabIds = h.win.activeSpace().tabIds
    const opened = h.browser.tabs.tab(tabIds[tabIds.indexOf(h.tabId) + 1] ?? '')
    expect(opened?.url).toContain('a'.repeat(SELECTION_TEXT_MAX))
    expect(opened?.url).not.toContain('a'.repeat(SELECTION_TEXT_MAX + 1))
  })

  it('Search <engine> opens the query in a background tab next to this one, with it as the opener', () => {
    const h = pageHarness(ANDROID, PHONE)
    expect(h.browser.menus.runSelectionAction(h.tabId, 'search', 'quantum foam')).toBe(true)
    expect(h.browser.tabs.activeTabFor(h.win)?.id).toBe(h.tabId)
    const tabIds = h.win.activeSpace().tabIds
    const opened = h.browser.tabs.tab(tabIds[tabIds.indexOf(h.tabId) + 1] ?? '')
    expect(opened?.url).toMatch(/^https:\/\/www\.google\..*quantum%20foam/)
    expect(opened?.openerTabId).toBe(h.tabId)
    // The menu's search still comes to the front, like Chrome's.
    h.menu(pageParams({ selectionText: 'quantum foam' }))
    h.click('Search Google for “quantum foam”')
    expect(h.browser.tabs.activeTabFor(h.win)?.id).not.toBe(h.tabId)
  })

  it('an address gets Open in Glance instead of a search, which previews it where the selection sits', () => {
    const h = pageHarness(ANDROID, PHONE)
    expect(h.browser.menus.selectionToolbar(h.tabId, 'example.org/docs')).toEqual([
      { id: 'glance', title: 'Open in Glance' },
      { id: 'share', title: 'Share' }
    ])
    expect(
      h.browser.menus.runSelectionAction(h.tabId, 'glance', 'example.org/docs', { x: 0.25, y: 1.5 })
    ).toBe(true)
    expect(h.win.glance).toMatchObject({ parentTabId: h.tabId, originX: 0.25, originY: 1 })
    expect(h.browser.tabs.tab(h.win.glance?.tabId ?? '')?.url).toBe('https://example.org/docs')
    expect(h.browser.tabs.activeTabFor(h.win)?.id).toBe(h.tabId)
  })

  it('leaves Open in Glance out while a glance is open or the setting is off', () => {
    const h = pageHarness(ANDROID, PHONE)
    h.browser.tabs.openGlance('https://example.com/', h.tabId, 0.5, 0.5, h.win)
    expect(h.browser.menus.selectionToolbar(h.tabId, 'example.org/docs')).toEqual([
      { id: 'share', title: 'Share' }
    ])
    h.browser.tabs.closeGlance(h.win)
    h.browser.handleCommand(h.win, 'settings.update', { glanceEnabled: false })
    expect(h.browser.menus.selectionToolbar(h.tabId, 'example.org/docs')).toEqual([
      { id: 'share', title: 'Share' }
    ])
    expect(h.browser.menus.runSelectionAction(h.tabId, 'glance', 'example.org/docs')).toBe(false)
    expect(h.win.glance).toBeNull()
  })

  it('Share hands the text to the host sheet, and an id the text does not warrant does nothing', () => {
    const shared: SharePayload[] = []
    const h = pageHarness(ANDROID, PHONE)
    h.browser.platform.shell.share = (payload): Promise<void> => {
      shared.push(payload)
      return Promise.resolve()
    }
    expect(h.browser.menus.runSelectionAction(h.tabId, 'share', 'quantum foam')).toBe(true)
    expect(shared).toEqual([{ text: 'quantum foam', tabId: h.tabId }])
    // A menu-only action, a toolbar action the text no longer warrants, an unknown id.
    expect(h.browser.menus.runSelectionAction(h.tabId, 'go', 'example.org/docs')).toBe(false)
    expect(h.browser.menus.runSelectionAction(h.tabId, 'glance', 'quantum foam')).toBe(false)
    expect(h.browser.menus.runSelectionAction(h.tabId, 'define', 'quantum foam')).toBe(false)
    expect(h.browser.menus.runSelectionAction(h.tabId, 'share', '   ')).toBe(false)
    expect(shared.length).toBe(1)
    expect(h.win.glance).toBeNull()
    expect(h.win.activeSpace().tabIds.length).toBe(1)
  })

  it('is off without the capability even on a phone-shaped host', () => {
    const h = pageHarness({ ...ANDROID, selectionToolbar: false }, PHONE)
    expect(h.browser.menus.selectionToolbar(h.tabId, 'quantum foam')).toEqual([])
    expect(h.browser.menus.runSelectionAction(h.tabId, 'search', 'quantum foam')).toBe(false)
  })

  it('with the translation engine lists Translate last in the bar and Translate Selection before Share in the menu', async () => {
    const h = pageHarness(ANDROID, { ...PHONE, translate: true })
    expect(h.browser.menus.selectionToolbar(h.tabId, 'quantum foam')).toEqual([
      { id: 'search', title: 'Search Google' },
      { id: 'share', title: 'Share' },
      { id: 'translate', title: 'Translate' }
    ])
    expect(
      h.browser.menus.selectionToolbar(h.tabId, 'example.org/docs').map((item) => item.id)
    ).toEqual(['glance', 'share', 'translate'])
    // The menu keeps the desktop's order and offers it for the page's own selection only.
    expect(h.menu(pageParams({ selectionText: 'quantum foam' })).slice(0, 4)).toEqual([
      'Copy',
      'Search Google for “quantum foam”',
      'Translate Selection',
      'Share…'
    ])
    expect(h.menu(pageParams({ selectionText: 'quantum foam', isEditable: true }))).not.toContain(
      'Translate Selection'
    )
    // The touch shows the sheet for the text on screen, anchored nowhere.
    const asked: unknown[] = []
    h.win.host.send = (name, payload) => {
      if (name === 'translate.selection') asked.push(payload)
    }
    expect(h.browser.menus.runSelectionAction(h.tabId, 'translate', 'quantum  foam ')).toBe(true)
    await settle()
    expect(asked).toEqual([{ tabId: h.tabId, text: 'quantum foam', x: null, y: null }])
    // The menu's item anchors the popover where the click landed.
    h.menu(pageParams({ selectionText: 'quantum foam', x: 40, y: 60 }))
    h.click('Translate Selection')
    await settle()
    expect(asked[1]).toEqual({ tabId: h.tabId, text: 'quantum foam', x: 40, y: 60 })
  })

  it('leaves Translate out on a host without the engine', () => {
    const h = pageHarness(ANDROID, PHONE)
    expect(
      h.browser.menus.selectionToolbar(h.tabId, 'quantum foam').map((item) => item.id)
    ).toEqual(['search', 'share'])
    expect(h.browser.menus.runSelectionAction(h.tabId, 'translate', 'quantum foam')).toBe(false)
    expect(h.menu(pageParams({ selectionText: 'quantum foam' }))).not.toContain(
      'Translate Selection'
    )
  })
})

// ---------------------------------------------------------------------------
// Chrome context menus (URL bar, reload button, chrome text fields)
// ---------------------------------------------------------------------------

function chromeParams(overrides: Partial<ChromeContextParams> = {}): ChromeContextParams {
  return {
    x: 300,
    y: 20,
    target: null,
    tabId: null,
    isEditable: false,
    selectionText: '',
    editFlags: NO_EDITS,
    ...overrides
  }
}

describe('the chrome context menus', () => {
  const show = async (h: PageHarness, params: ChromeContextParams): Promise<string[]> => {
    await h.browser.menus.showChromeContextMenu(params, h.win)
    return topLabels(h.shown())
  }

  it('gives the URL bar field Chrome’s omnibox menu with Paste and Go', async () => {
    const h = pageHarness()
    h.clipboardText.value = 'https://example.org/from-clipboard'
    const menu = await show(
      h,
      chromeParams({ target: 'urlbar', tabId: h.tabId, isEditable: true, editFlags: ALL_EDITS })
    )
    expect(menu).toEqual([
      'Undo',
      'Redo',
      'Cut',
      'Copy',
      'Paste',
      'Paste and Go',
      'Paste as Plain Text',
      'Delete',
      'Select All',
      '-',
      'Always Show Full URLs',
      'Manage Search Engines…'
    ])
    h.sent.length = 0
    h.click('Paste and Go')
    await settle()
    expect(h.browser.tabs.tab(h.tabId)?.url).toBe('https://example.org/from-clipboard')
    // The open bar closes, as a submit does.
    expect(h.sent).toContain('urlbar.close')
  })

  it('says Paste and Search when the clipboard is not an address, and greys it when empty', async () => {
    const h = pageHarness()
    h.clipboardText.value = 'weather  tomorrow'
    let menu = await show(
      h,
      chromeParams({ target: 'urlbar', tabId: h.tabId, isEditable: true, editFlags: ALL_EDITS })
    )
    expect(menu).toContain('Paste and Search')
    h.click('Paste and Search')
    await settle()
    // Searched with the default engine, whitespace collapsed as the omnibox pastes it.
    expect(h.browser.tabs.tab(h.tabId)?.url).toContain('weather%20tomorrow')
    h.clipboardText.value = '   '
    menu = await show(h, chromeParams({ target: 'urlbar', isEditable: true, editFlags: ALL_EDITS }))
    expect(menu).toContain('Paste and Search')
    expect(item(h.shown(), 'Paste and Search').enabled).toBe(false)
  })

  it('searches what Paste and Search offered even when it reads as an engine keyword', async () => {
    const h = pageHarness()
    const engines = h.browser.state.searchEngines
    const keyword = engines.find((e) => e.id !== h.browser.state.settings.searchEngineId)
    if (!keyword) throw new Error('the defaults need a second engine')
    h.clipboardText.value = `${keyword.keyword} cats`
    await show(
      h,
      chromeParams({ target: 'urlbar', tabId: h.tabId, isEditable: true, editFlags: ALL_EDITS })
    )
    h.click('Paste and Search')
    await settle()
    const url = h.browser.tabs.tab(h.tabId)?.url ?? ''
    const defaultEngine = engines.find((e) => e.id === h.browser.state.settings.searchEngineId)
    expect(url).toBe(buildSearchUrl(defaultEngine ?? engines[0], `${keyword.keyword} cats`))
  })

  it('opens a new tab from the new-tab URL bar’s Paste and Go', async () => {
    const h = pageHarness()
    h.clipboardText.value = 'example.net'
    const before = Object.keys(h.browser.state.model.tabs).length
    await show(h, chromeParams({ target: 'urlbar', isEditable: true, editFlags: ALL_EDITS }))
    h.click('Paste and Go')
    await settle()
    expect(Object.keys(h.browser.state.model.tabs).length).toBe(before + 1)
    expect(h.browser.tabs.activeTabFor(h.win)?.url).toBe('https://example.net')
  })

  it('gives the address pill Copy and the clipboard, not the field items', async () => {
    const h = pageHarness()
    h.clipboardText.value = 'https://example.org/'
    const menu = await show(h, chromeParams({ target: 'urlpill', tabId: h.tabId }))
    expect(menu).toEqual([
      'Copy',
      'Paste and Go',
      '-',
      'Always Show Full URLs',
      'Manage Search Engines…'
    ])
    expect(item(h.shown(), 'Copy').action).toBe('tab.copyUrl')
  })

  it('routes Manage Search Engines… through page.open: a Settings tab where the host has page tabs, the overlay elsewhere', async () => {
    const phone = pageHarness(ANDROID)
    await show(phone, chromeParams({ target: 'urlpill', tabId: phone.tabId }))
    phone.click('Manage Search Engines…')
    const active = phone.browser.tabs.activeTabFor(phone.win)
    expect(active?.url).toBe('zen://settings/search')
    expect(phone.sent).not.toContain('overlay.open')

    const desktop = pageHarness(DESKTOP)
    await show(desktop, chromeParams({ target: 'urlpill', tabId: desktop.tabId }))
    desktop.sent.length = 0
    desktop.click('Manage Search Engines…')
    expect(desktop.sent).toContain('overlay.open')
    expect(desktop.browser.tabs.activeTabFor(desktop.win)?.url).toBe(PAGE_URL)
  })

  it('toggles Always Show Full URLs from the pill and the field', async () => {
    const h = pageHarness()
    const settings: Settings = h.browser.state.settings
    expect(settings.showFullUrls).toBe(false)
    const menu = await show(h, chromeParams({ target: 'urlpill', tabId: h.tabId }))
    expect(menu).toEqual([
      'Copy',
      'Paste and Search',
      '-',
      'Always Show Full URLs',
      'Manage Search Engines…'
    ])
    let toggle = item(h.shown(), 'Always Show Full URLs')
    expect(toggle.type).toBe('checkbox')
    expect(toggle.checked).toBe(false)
    h.click('Always Show Full URLs')
    expect(settings.showFullUrls).toBe(true)
    await show(
      h,
      chromeParams({ target: 'urlbar', tabId: h.tabId, isEditable: true, editFlags: ALL_EDITS })
    )
    toggle = item(h.shown(), 'Always Show Full URLs')
    expect(toggle.checked).toBe(true)
    h.click('Always Show Full URLs')
    expect(settings.showFullUrls).toBe(false)
  })

  it('names the omnibox actions on Paste and Go / Paste and Search for the shortcut hints', async () => {
    const h = pageHarness()
    h.clipboardText.value = 'https://example.org/'
    await show(h, chromeParams({ target: 'urlpill', tabId: h.tabId }))
    expect(item(h.shown(), 'Paste and Go').action).toBe('urlbar.pasteAndGo')
    h.clipboardText.value = 'plain words'
    await show(h, chromeParams({ target: 'urlpill', tabId: h.tabId }))
    expect(item(h.shown(), 'Paste and Search').action).toBe('urlbar.pasteAndSearch')
  })

  it('shows the reload choices only while the tab’s DevTools are open', async () => {
    const h = pageHarness()
    await show(h, chromeParams({ target: 'reload', tabId: h.tabId }))
    expect(h.popups()).toBe(0)
    h.browser.state.devtoolsOpenFor.add(h.tabId)
    const menu = await show(h, chromeParams({ target: 'reload', tabId: h.tabId }))
    expect(menu).toEqual(['Normal Reload', 'Hard Reload', 'Empty Cache and Hard Reload'])
    h.click('Hard Reload')
    expect(h.viewCalls).toEqual(['reload(true)'])
  })

  it('gives other chrome text fields the editing items and a selection Copy', async () => {
    const h = pageHarness()
    expect(await show(h, chromeParams({ isEditable: true, editFlags: ALL_EDITS }))).toEqual([
      'Undo',
      'Redo',
      'Cut',
      'Copy',
      'Paste',
      'Paste as Plain Text',
      'Delete',
      'Select All'
    ])
    expect(await show(h, chromeParams({ selectionText: 'a label' }))).toEqual(['Copy'])
  })

  it('shows nothing for plain chrome', async () => {
    const h = pageHarness()
    await show(h, chromeParams())
    expect(h.popups()).toBe(0)
  })
})

describe('menu helpers', () => {
  it('joinGroups puts one separator between non-empty groups', () => {
    const a: MenuItemTemplate = { label: 'a' }
    const b: MenuItemTemplate = { label: 'b' }
    expect(topLabels(joinGroups([[a], [], [b], []]))).toEqual(['a', '-', 'b'])
    expect(joinGroups([[], []])).toEqual([])
  })

  it('linkCopyItem copies addresses, bare email addresses and phone numbers', () => {
    expect(linkCopyItem('https://example.com/x?y=1')).toEqual({
      label: 'Copy Link Address',
      text: 'https://example.com/x?y=1',
      confirmation: 'Link copied'
    })
    expect(linkCopyItem('mailto:a%2Bb@example.com?subject=Hello')).toMatchObject({
      label: 'Copy Email Address',
      text: 'a+b@example.com'
    })
    expect(linkCopyItem('tel:+1-555-0100')).toMatchObject({
      label: 'Copy Phone Number',
      text: '+1-555-0100'
    })
  })

  it('selectionUrl accepts what the URL bar would open and nothing else', () => {
    expect(selectionUrl('example.org/docs')).toBe('https://example.org/docs')
    expect(selectionUrl(' http://localhost:3000/x ')).toBe('http://localhost:3000/x')
    expect(selectionUrl('weather tomorrow')).toBeNull()
    expect(selectionUrl('about:blank')).toBeNull()
    expect(selectionUrl('')).toBeNull()
  })

  it('isDownloadable keeps Save As to fetchable schemes', () => {
    expect(isDownloadable('https://example.com/a.pdf')).toBe(true)
    expect(isDownloadable('blob:https://example.com/id')).toBe(true)
    expect(isDownloadable('zen://settings')).toBe(false)
    expect(isDownloadable('mailto:a@b.c')).toBe(false)
  })
})

describe('the download row menu', () => {
  const start = (h: Harness, url = 'https://example.com/report.pdf'): string =>
    h.browser.downloads.begin({
      url,
      filename: 'report.pdf',
      totalBytes: 100,
      mimeType: 'application/pdf'
    }).id

  const menu = (h: Harness, id: string): string[] => {
    h.browser.handleCommand(h.win, 'download.contextMenu', { id })
    return labels(h.shown())
  }

  const enabled = (h: Harness, label: string): boolean | undefined =>
    h.shown().find((item) => item.label === label)?.enabled

  const checked = (h: Harness, label: string): boolean | undefined =>
    h.shown().find((item) => item.label === label)?.checked

  it('offers Open when done, Pause and Cancel while the transfer runs', () => {
    const h = harness(DESKTOP)
    const id = start(h)
    expect(menu(h, id)).toEqual([
      'Open When Done',
      'Always Open Files of This Type',
      'Show in Folder',
      '-',
      'Copy Download Link',
      '-',
      'Pause',
      'Cancel',
      '-',
      'Remove from List'
    ])
    expect(checked(h, 'Open When Done')).toBe(false)
    expect(enabled(h, 'Show in Folder')).toBe(false)
    expect(enabled(h, 'Remove from List')).toBe(false)
  })

  it('Open when done is a toggle on the row (Chrome applies it when the transfer finishes)', () => {
    const h = harness(DESKTOP)
    const id = start(h)
    menu(h, id)
    h.shown()
      .find((item) => item.label === 'Open When Done')
      ?.click?.()
    expect(h.browser.downloads.item(id)?.openWhenDone).toBe(true)
    expect(checked(h, 'Open When Done')).toBe(false)
    menu(h, id)
    expect(checked(h, 'Open When Done')).toBe(true)
    h.shown()
      .find((item) => item.label === 'Open When Done')
      ?.click?.()
    expect(h.browser.downloads.item(id)?.openWhenDone).toBe(false)
  })

  it('Always open files of this type toggles the extension in the engine setting', () => {
    const h = harness(DESKTOP)
    const id = start(h)
    menu(h, id)
    expect(checked(h, 'Always Open Files of This Type')).toBe(false)
    h.shown()
      .find((item) => item.label === 'Always Open Files of This Type')
      ?.click?.()
    expect(resolveDownloadSettings(h.browser.state.settings).autoOpenTypes).toEqual(['pdf'])
    menu(h, id)
    expect(checked(h, 'Always Open Files of This Type')).toBe(true)
    h.shown()
      .find((item) => item.label === 'Always Open Files of This Type')
      ?.click?.()
    expect(resolveDownloadSettings(h.browser.state.settings).autoOpenTypes).toEqual([])
  })

  it('never offers Always open for a type Chromium keeps from opening by itself, or for no type', () => {
    const h = harness(DESKTOP)
    // `.crx` is ALLOW_ON_USER_GESTURE on every platform (`.exe` only on Windows).
    const flagged = h.browser.downloads.begin({
      url: 'https://example.com/extension.crx',
      filename: 'extension.crx',
      totalBytes: 100,
      mimeType: 'application/x-chrome-extension'
    }).id
    expect(menu(h, flagged)).not.toContain('Always Open Files of This Type')
    const bare = h.browser.downloads.begin({
      url: 'https://example.com/README',
      filename: 'README',
      totalBytes: 100,
      mimeType: 'text/plain'
    }).id
    expect(menu(h, bare)).not.toContain('Always Open Files of This Type')
  })

  it('swaps Pause for Resume once paused', () => {
    const h = harness(DESKTOP)
    const id = start(h)
    h.browser.downloads.progress(id, { state: 'paused' })
    expect(menu(h, id)).toContain('Resume')
    expect(menu(h, id)).not.toContain('Pause')
    expect(menu(h, id)).toContain('Cancel')
  })

  it('offers Retry for a failed or cancelled transfer and Remove from List', () => {
    const h = harness(DESKTOP)
    const failed = start(h)
    h.browser.downloads.finish(failed, 'interrupted')
    expect(menu(h, failed)).toEqual([
      'Open',
      'Always Open Files of This Type',
      'Show in Folder',
      '-',
      'Copy Download Link',
      '-',
      'Retry',
      '-',
      'Remove from List'
    ])
    expect(enabled(h, 'Open')).toBe(false)
    expect(enabled(h, 'Remove from List')).toBe(true)
    const cancelled = start(h)
    h.browser.downloads.finish(cancelled, 'cancelled')
    expect(menu(h, cancelled)).toContain('Retry')
  })

  it('prefers Resume over Retry when the failed transfer can continue', () => {
    const h = harness(DESKTOP)
    const id = start(h)
    h.browser.downloads.progress(id, { state: 'interrupted', canResume: true })
    const shown = menu(h, id)
    expect(shown).toContain('Resume')
    expect(shown).not.toContain('Retry')
  })

  it('offers Retry only for a reason a retry can get past, as the row’s controls do', () => {
    const h = harness(DESKTOP)
    const dropped = start(h)
    h.browser.downloads.finish(dropped, 'interrupted', { error: 'network-timeout' })
    expect(menu(h, dropped)).toContain('Retry')
    const blocked = start(h)
    h.browser.downloads.finish(blocked, 'interrupted', { error: 'file-blocked' })
    expect(menu(h, blocked)).toEqual([
      'Open',
      'Always Open Files of This Type',
      'Show in Folder',
      '-',
      'Copy Download Link',
      '-',
      'Remove from List'
    ])
    const full = start(h)
    h.browser.downloads.finish(full, 'interrupted', { error: 'file-no-space' })
    expect(menu(h, full)).not.toContain('Retry')
  })

  it('has no Retry for a blob: download – the page object is gone', () => {
    const h = harness(DESKTOP)
    const id = start(h, 'blob:https://example.com/0b1')
    h.browser.downloads.finish(id, 'cancelled')
    expect(menu(h, id)).toEqual([
      'Open',
      'Always Open Files of This Type',
      'Show in Folder',
      '-',
      'Copy Download Link',
      '-',
      'Remove from List'
    ])
  })

  it('opens and reveals a finished file, and copies its link', async () => {
    const h = harness(DESKTOP)
    const id = h.browser.downloads.addCompleted('/tmp/shot.png', 'image/png').id
    expect(menu(h, id)).toEqual([
      'Open',
      'Always Open Files of This Type',
      'Show in Folder',
      '-',
      'Copy Download Link',
      '-',
      'Delete File',
      'Remove from List'
    ])
    expect(enabled(h, 'Open')).toBe(true)
    expect(enabled(h, 'Show in Folder')).toBe(true)
    expect(enabled(h, 'Delete File')).toBe(true)
    let copied = ''
    h.browser.platform.clipboard.writeText = (text: string) => void (copied = text)
    h.shown()
      .find((item) => item.label === 'Copy Download Link')
      ?.click?.()
    await settle()
    expect(copied).toBe('file:///tmp/shot.png')
  })

  it('Delete File takes the finished file away and leaves the row as Deleted', async () => {
    const h = harness(DESKTOP)
    h.browser.platform.downloads.deleteFile = () => Promise.resolve('deleted')
    const id = h.browser.downloads.addCompleted('/tmp/shot.png', 'image/png').id
    menu(h, id)
    h.sent.length = 0
    h.shown()
      .find((item) => item.label === 'Delete File')
      ?.click?.()
    await settle()
    expect(h.browser.downloads.item(id)?.fileMissing).toBe(true)
    // The row says it; no toast.
    expect(h.sent).not.toContain('toast')
    // The Deleted row: nothing to open, show or delete again, Retry instead.
    expect(menu(h, id)).toEqual([
      'Open',
      'Always Open Files of This Type',
      'Show in Folder',
      '-',
      'Copy Download Link',
      '-',
      'Retry',
      '-',
      'Delete File',
      'Remove from List'
    ])
    expect(enabled(h, 'Open')).toBe(false)
    expect(enabled(h, 'Show in Folder')).toBe(false)
    expect(enabled(h, 'Delete File')).toBe(false)
    expect(enabled(h, 'Remove from List')).toBe(true)
  })

  it('Delete File tells the window in a toast when the file would not go', async () => {
    const h = harness(DESKTOP)
    h.browser.platform.downloads.deleteFile = () => Promise.resolve('failed')
    const id = h.browser.downloads.addCompleted('/tmp/shot.png', 'image/png').id
    menu(h, id)
    h.sent.length = 0
    h.shown()
      .find((item) => item.label === 'Delete File')
      ?.click?.()
    await settle()
    expect(h.browser.downloads.item(id)?.fileMissing).toBeUndefined()
    expect(h.sent).toContain('toast')
  })

  it('has no Delete File for a row without a finished file', () => {
    const h = harness(DESKTOP)
    const running = start(h)
    expect(menu(h, running)).not.toContain('Delete File')
    const failed = start(h)
    h.browser.downloads.finish(failed, 'interrupted')
    expect(menu(h, failed)).not.toContain('Delete File')
    const cancelled = start(h)
    h.browser.downloads.finish(cancelled, 'cancelled')
    expect(menu(h, cancelled)).not.toContain('Delete File')
  })

  it('shows nothing for an unknown record', () => {
    const h = harness(DESKTOP)
    const before = h.popups()
    h.browser.handleCommand(h.win, 'download.contextMenu', { id: 'dl-missing' })
    expect(h.popups()).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// Where a menu opens for the keyboard (Shift+F10, the Menu key; a11y-08)
// ---------------------------------------------------------------------------

describe('a menu asked for from the keyboard', () => {
  /** The page sits to the right of the sidebar: its coordinates are offset in the window's. */
  const placePage = (h: PageHarness): void =>
    h.win.applyLayout({
      placements: [{ tabId: h.tabId, rect: { x: 300, y: 60, width: 900, height: 700 }, radius: 8 }],
      glance: null,
      contentHidden: false
    })

  it("a page's menu opens at the focused element or caret, in the window's coordinates, first item selected", () => {
    const h = pageHarness()
    placePage(h)
    h.menu(pageParams({ x: 100, y: 200, menuSourceType: 'keyboard' }))
    expect(h.where()).toMatchObject({ source: 'page', x: 400, y: 260, keyboard: true })
  })

  it("a page's menu from the pointer opens at the pointer, which the host does by itself", () => {
    const h = pageHarness()
    placePage(h)
    h.menu(pageParams({ x: 100, y: 200, menuSourceType: 'mouse' }))
    expect(h.where()).toMatchObject({ source: 'page' })
    expect(h.where()).not.toHaveProperty('x')
    expect(h.where()).not.toHaveProperty('keyboard')
    h.menu(pageParams({ x: 100, y: 200 }))
    expect(h.where()).not.toHaveProperty('keyboard')
  })

  it('a page the chrome has not placed still gets keyboard mode', () => {
    const h = pageHarness()
    h.menu(pageParams({ x: 100, y: 200, menuSourceType: 'keyboard' }))
    expect(h.where()).toMatchObject({ source: 'page', keyboard: true })
    expect(h.where()).not.toHaveProperty('x')
  })

  it("the URL bar's menu opens at the caret for Shift+F10, at the pointer otherwise", async () => {
    const h = pageHarness()
    await h.browser.menus.showChromeContextMenu(
      chromeParams({
        target: 'urlbar',
        tabId: h.tabId,
        isEditable: true,
        editFlags: ALL_EDITS,
        x: 420,
        y: 18,
        keyboard: true
      }),
      h.win
    )
    expect(h.where()).toMatchObject({ source: 'urlbar', x: 420, y: 18, keyboard: true })
    await h.browser.menus.showChromeContextMenu(
      chromeParams({ target: 'urlbar', tabId: h.tabId, isEditable: true, editFlags: ALL_EDITS }),
      h.win
    )
    expect(h.where()).not.toHaveProperty('keyboard')
    expect(h.where()).not.toHaveProperty('x')
  })

  it("the chrome's rows pass their anchor through the commands: at the row, keyboard mode", () => {
    const h = pageHarness()
    const space = h.win.activeSpace()
    h.browser.handleCommand(h.win, 'tab.contextMenu', {
      tabId: h.tabId,
      x: 120,
      y: 240,
      keyboard: true
    })
    expect(h.where()).toMatchObject({ source: 'tab', x: 120, y: 240, keyboard: true })
    h.browser.handleCommand(h.win, 'space.contextMenu', { spaceId: space.id, x: 30, y: 900 })
    expect(h.where()).toMatchObject({ source: 'space', x: 30, y: 900 })
    expect(h.where()).not.toHaveProperty('keyboard')
    const folderId = h.browser.createFolder(space.id, 'Work', '📁', h.win).id
    h.browser.handleCommand(h.win, 'folder.contextMenu', {
      folderId,
      x: 100,
      y: 300,
      keyboard: true
    })
    expect(h.where()).toMatchObject({ source: 'folder', x: 100, y: 300, keyboard: true })
    h.browser.handleCommand(h.win, 'newtab.contextMenu', { x: 90, y: 500, keyboard: true })
    expect(h.where()).toMatchObject({ source: 'newtab', x: 90, y: 500, keyboard: true })
    // A right-click's command without an anchor is the pointer's, as before.
    h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: h.tabId })
    expect(h.where()).toMatchObject({ source: 'tab' })
    expect(h.where()).not.toHaveProperty('x')
  })
})

describe('the tab strip menus (tabs-35, tabs-24, tabs-25)', () => {
  /** The item of that label in the last popup, wherever it sits. */
  const item = (h: Harness, label: string): MenuItemTemplate => {
    const found = h.shown().find((i) => i.label === label)
    if (!found) throw new Error(`no "${label}" in ${topLabels(h.shown()).join(', ')}`)
    return found
  }
  const enabled = (h: Harness, label: string): boolean => item(h, label).enabled !== false

  it("the strip's menu is Chrome's trio first, then Zenium's own", () => {
    const h = pageHarness()
    h.browser.handleCommand(h.win, 'newtab.contextMenu', {})
    expect(topLabels(h.shown())).toEqual([
      'New Tab',
      'New Tab in Container',
      'Reopen Closed Tab',
      'Bookmark All Tabs…',
      '-',
      'New Folder',
      'New Live Folder…',
      'New Space…',
      '-',
      'Clear Unpinned Tabs'
    ])
    expect(item(h, 'Reopen Closed Tab').action).toBe('tab.reopenClosed')
    expect(item(h, 'Bookmark All Tabs…').action).toBe('bookmark.allTabs')
  })

  it('greys Reopen Closed Tab while nothing was closed and brings the newest closed tab back', () => {
    const h = pageHarness()
    const { tabs } = h.browser
    h.browser.handleCommand(h.win, 'newtab.contextMenu', {})
    expect(enabled(h, 'Reopen Closed Tab')).toBe(false)
    const closed = tabs.createTab({ url: 'https://closed.example/', active: false }, h.win)
    tabs.closeTab(closed.id, false, h.win)
    expect(tabs.tab(closed.id)).toBeUndefined()
    h.browser.handleCommand(h.win, 'newtab.contextMenu', {})
    expect(enabled(h, 'Reopen Closed Tab')).toBe(true)
    item(h, 'Reopen Closed Tab').click!()
    const urls = Object.values(h.browser.state.model.tabs).map((t) => t.url)
    expect(urls).toContain('https://closed.example/')
    h.browser.handleCommand(h.win, 'newtab.contextMenu', {})
    expect(enabled(h, 'Reopen Closed Tab')).toBe(false)
  })

  it("Reopen Closed Tab closes the tab row's menu too, after the close items", () => {
    const h = pageHarness()
    h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: h.tabId })
    expect(topLabels(h.shown()).slice(-7)).toEqual([
      'Close Tabs Above',
      'Close Tabs Below',
      'Close Other Tabs',
      '-',
      'Close Tab',
      '-',
      'Reopen Closed Tab'
    ])
    expect(enabled(h, 'Reopen Closed Tab')).toBe(false)
  })

  describe('Close Tabs Above / Below / Other Tabs share one scope: the regular tabs, pinned and Essentials exempt', () => {
    /** A pinned row P, an essential E, regular rows A B C, in that order in the space. */
    function strip(): Harness & { ids: Record<string, string> } {
      const h = harness(DESKTOP)
      const { tabs } = h.browser
      const make = (host: string): string =>
        tabs.createTab({ url: `https://${host}.example/`, active: false }, h.win).id
      const P = make('p')
      tabs.togglePin(P, h.win)
      const E = make('e')
      tabs.toggleEssential(E, h.win)
      const A = make('a')
      const B = make('b')
      const C = make('c')
      // The window's first tab is a regular row too; it goes so the strip is exactly P E | A B C.
      for (const t of Object.values(h.browser.state.model.tabs))
        if (![P, E, A, B, C].includes(t.id)) tabs.closeTab(t.id, true, h.win)
      return { ...h, ids: { P, E, A, B, C } }
    }
    const scopes = (h: Harness, tabId: string): Record<string, boolean> => {
      h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId })
      return {
        above: enabled(h, 'Close Tabs Above'),
        below: enabled(h, 'Close Tabs Below'),
        others: enabled(h, 'Close Other Tabs')
      }
    }
    const alive = (h: Harness): string[] =>
      Object.values(h.browser.state.model.tabs)
        .map((t) => t.url.replace('https://', '').replace('.example/', ''))
        .sort()

    it('reads the regular rows around a regular row', () => {
      const h = strip()
      const { tabs } = h.browser
      expect(tabs.closeScope(h.ids.B, 'above', h.win)).toEqual([h.ids.A])
      expect(tabs.closeScope(h.ids.B, 'below', h.win)).toEqual([h.ids.C])
      expect(tabs.closeScope(h.ids.B, 'others', h.win)).toEqual([h.ids.A, h.ids.C])
      expect(scopes(h, h.ids.B)).toEqual({ above: true, below: true, others: true })
      expect(scopes(h, h.ids.A)).toEqual({ above: false, below: true, others: true })
      expect(scopes(h, h.ids.C)).toEqual({ above: true, below: false, others: true })
    })

    it('from a pinned or essential row has every regular row below, none above, and never closes pinned or Essentials', () => {
      const h = strip()
      const { tabs } = h.browser
      for (const id of [h.ids.P, h.ids.E]) {
        expect(tabs.closeScope(id, 'above', h.win)).toEqual([])
        expect(tabs.closeScope(id, 'below', h.win)).toEqual([h.ids.A, h.ids.B, h.ids.C])
        expect(tabs.closeScope(id, 'others', h.win)).toEqual([h.ids.A, h.ids.B, h.ids.C])
        expect(scopes(h, id)).toEqual({ above: false, below: true, others: true })
        // The items are there, greyed, not gone (§9.30).
        expect(topLabels(h.shown())).toEqual(
          expect.arrayContaining(['Close Tabs Above', 'Close Tabs Below', 'Close Other Tabs'])
        )
      }
      tabs.closeOthers(h.ids.P, h.win)
      expect(alive(h)).toEqual(['e', 'p'])
    })

    it('closes exactly its scope and leaves pinned and Essentials standing', () => {
      let h = strip()
      h.browser.tabs.closeAbove(h.ids.B, h.win)
      expect(alive(h)).toEqual(['b', 'c', 'e', 'p'])
      h = strip()
      h.browser.tabs.closeBelow(h.ids.B, h.win)
      expect(alive(h)).toEqual(['a', 'b', 'e', 'p'])
      h = strip()
      h.browser.tabs.closeOthers(h.ids.B, h.win)
      expect(alive(h)).toEqual(['b', 'e', 'p'])
      h = strip()
      h.browser.tabs.closeBelow(h.ids.P, h.win)
      expect(alive(h)).toEqual(['e', 'p'])
    })

    it('greys all three on the one regular row', () => {
      const h = strip()
      const { tabs } = h.browser
      tabs.closeTab(h.ids.A, false, h.win)
      tabs.closeTab(h.ids.C, false, h.win)
      expect(scopes(h, h.ids.B)).toEqual({ above: false, below: false, others: false })
      // And on the pinned row, with no regular row left at all.
      tabs.closeTab(h.ids.B, false, h.win)
      expect(scopes(h, h.ids.P)).toEqual({ above: false, below: false, others: false })
      tabs.closeOthers(h.ids.P, h.win)
      tabs.closeBelow(h.ids.P, h.win)
      expect(alive(h)).toEqual(['e', 'p'])
    })
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
