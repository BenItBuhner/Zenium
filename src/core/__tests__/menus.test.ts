import { describe, expect, it, vi } from 'vitest'
import type {
  Folder,
  FormFactor,
  HostCapabilities,
  MediaState,
  MenuGlyph,
  Platform as PlatformOs,
  Settings,
  SharePayload,
  SyncDeviceKind,
  SyncDeviceTabs,
  SyncRemoteTab,
  Tab
} from '../../shared/types'
import { PRIVATE_CONTAINER_ID } from '../../shared/types'
import { searchCommands, type CommandContext } from '../../shared/commands'
import { resolveDownloadSettings } from '../../shared/downloads'
import { buildSearchUrl } from '../../shared/search'
import { Browser } from '../browser'
import { closeBootTabs } from './bootTab'
import type {
  AppHost,
  ClipboardHost,
  DialogHost,
  MenuHost,
  MenuItemTemplate,
  MenuPopupOptions,
  Platform,
  ShellHost,
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
  directedNavigationHistory,
  hasSiteInfo,
  isDownloadable,
  joinGroups,
  linkCopyItem,
  NAVIGATION_MENU_MAX,
  navigationWindow,
  SELECTION_TEXT_MAX,
  selectionUrl
} from '../menus'
import { HELP_URL, ISSUES_URL } from '../menuBar'
import { releaseNotesUrl } from '../../shared/links'
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
  savePageFormats: true,
  pdfViewer: false,
  agents: true,
  agentSkills: true,
  updates: true,
  share: false,
  sharePanel: false,
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
  inactiveTabs: false,
  secureDns: false,
  quitsThroughCore: false,
  lookalikeHolds: true,
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
  readAloud: false,
  pageLanguages: false,
  genericFontFamilies: false,
  caretBrowsing: false,
  placementAnswered: false
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
  savePageFormats: false,
  pdfViewer: true,
  agents: true,
  agentSkills: false,
  updates: true,
  share: true,
  sharePanel: false,
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
  inactiveTabs: true,
  secureDns: false,
  quitsThroughCore: false,
  lookalikeHolds: false,
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
  readAloud: false,
  pageLanguages: false,
  genericFontFamilies: false,
  caretBrowsing: false,
  placementAnswered: false
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
  /** Every `tel:` / `mailto:` hand-off the shell was asked for, as `target url`. */
  linkApps: string[]
  /** The names of the events sent to the window's chrome, in order. */
  sent: string[]
  /** The ids of the windows whose host was asked to come forward (`WindowHost.focus`), in order. */
  focused: string[]
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
  /**
   * The host hands `tel:` and `mailto:` links to the device's apps (`ShellHost.openLinkIn`,
   * Android); absent, the shell has no dialer or mail app to speak of (the desktop).
   */
  linkApps?: boolean
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
  const focused: string[] = []
  const linkApps: string[] = []
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
      create: (win) =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => Boolean(opts.fullScreen),
          isMaximized: () => false,
          isFocused: () => true,
          isVisible: () => true,
          send: (name) => void sent.push(name),
          focus: () => void focused.push(win.id)
        })
    },
    views: stub<TabViewHost>({ createView: () => recordingView() }),
    menus,
    dialogs: stub<DialogHost>(
      opts.confirm === undefined ? {} : { confirm: () => Promise.resolve(opts.confirm!) }
    ),
    clipboard: stub<ClipboardHost>({ readText: () => Promise.resolve(clipboardText.value) }),
    shell: stub<ShellHost>({
      openLinkIn: opts.linkApps
        ? (target, url) => void linkApps.push(`${target} ${url}`)
        : undefined
    }),
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
  closeBootTabs(browser)
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
    focused,
    linkApps,
    spellcheckApplied
  }
}

/** Let a click that reads the host's clipboard finish. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * The page's answer to the core's `textFragment` / `generate` request (`TextFragments`): the
 * request the recording view saw is found and answered with `directive`; its id, or null when
 * nothing was asked.
 */
function answerTextFragment(
  h: { viewCalls: string[]; browser: Browser; tabId: string },
  directive: string | null
): string | null {
  const call = h.viewCalls.find(
    (c) => c.startsWith('postToPage(') && c.includes('"type":"textFragment"')
  )
  if (!call) return null
  const message = JSON.parse(call.slice('postToPage('.length, -1)) as { id: string }
  h.browser.handlePageMessage(h.tabId, { type: 'textFragment', id: message.id, directive })
  return message.id
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
  h.browser.handleCommand(h.win, 'app.menu', {})
  return labels(h.shown())
}

/** The app menu asked for with the media hub's toolbar button folded (design language v2 §9.29). */
function appMenuFolded(h: Harness, win = h.win): string[] {
  h.browser.handleCommand(win, 'app.menu', { mediaHubFolded: true })
  return labels(h.shown())
}

/**
 * The desktop app menu: Firefox's groups (design language v2 §6 "Menus") – the tabs and windows;
 * the library; the page's actions; the app's in Firefox's order (Settings, More Tools, Help,
 * Quit: "settings, tools, help, quit") – with the rest in submenus, so it stands on an 800 px
 * window. Submenus flattened one level (`labels`); the More Tools and Help submenus are asserted
 * whole below.
 */
const DESKTOP_APP_MENU = [
  'New Tab',
  'Search Tabs…',
  'New Window',
  'New Private Window',
  '-',
  'Bookmarks',
  'Bookmarks > Bookmark This Page',
  'Bookmarks > Bookmark All Tabs…',
  'Bookmarks > -',
  'Bookmarks > Show Bookmarks',
  'Bookmarks > Show Bookmarks Bar',
  'Bookmarks > Reading List',
  'Bookmarks > -',
  'Bookmarks > Import Bookmarks and Settings…',
  'Bookmarks > Export Bookmarks…',
  'Bookmarks > -',
  'Bookmarks > Tab Folders',
  'History',
  'History > Show Full History',
  'History > -',
  'History > No recently closed tabs',
  'Downloads',
  'Passwords',
  'Add-ons and Themes',
  'Delete Browsing Data…',
  '-',
  'Find in Page…',
  'Zoom',
  'Zoom > Zoom In',
  'Zoom > Zoom Out',
  'Zoom > Reset Zoom',
  'Zoom > -',
  'Zoom > Fullscreen',
  'Reader View',
  'Save and Share',
  'Save and Share > Save Page As',
  'Save and Share > Web Capture…',
  'Save and Share > Print…',
  '-',
  'Settings',
  'More Tools',
  'More Tools > New Space…',
  'More Tools > New Blank Window',
  'More Tools > Name Window…',
  'More Tools > Duplicate Window',
  'More Tools > -',
  'More Tools > Compact Mode',
  'More Tools > Split View',
  'More Tools > Change Theme…',
  'More Tools > -',
  'More Tools > Resources',
  'More Tools > Task Manager',
  'More Tools > Developer Tools',
  'More Tools > Dock to Bottom',
  'More Tools > Dock to Right',
  'More Tools > Dock to Left',
  'More Tools > Undock',
  'Help',
  'Help > About Zenium',
  "Help > What's New",
  'Help > -',
  'Help > Zenium Help',
  'Help > Keyboard Shortcuts',
  'Help > Report an Issue…',
  'Quit'
]

/**
 * The desktop menu's top level alone: Firefox's count, and §6's three separators – the tabs, the
 * library, the page's actions (Save and Share their last row, a submenu; shortcuts-menus-120),
 * the app's.
 */
const DESKTOP_APP_MENU_TOP = DESKTOP_APP_MENU.filter((l) => !l.includes(' > '))

/**
 * The tablet's More Tools keeps the two captures (its chrome has no Web Capture… overlay), in
 * their own group before the resources and the developer's rows.
 */
const TABLET_CAPTURES = [
  'More Tools > Take Screenshot',
  'More Tools > Capture Full Page',
  'More Tools > -'
]

const DESKTOP_ONLY = [
  'Search Tabs…',
  'Web Capture…',
  'Help > Keyboard Shortcuts',
  'More Tools > Compact Mode',
  'More Tools > Split View',
  'More Tools > Name Window…',
  'More Tools > Task Manager',
  'Zoom > Fullscreen',
  'Quit'
]

/** The item labelled `label` anywhere in `items`, submenus included. */
function deepItem(items: MenuItemTemplate[], label: string): MenuItemTemplate {
  const found = allItems(items).find((i) => i.label === label)
  if (!found) throw new Error(`no "${label}" in ${topLabels(items).join(', ')}`)
  return found
}

describe('the app menu', () => {
  it("on the desktop has Firefox's groups: the tabs and windows, the library, the page's actions, the app's (§6)", () => {
    const h = harness(DESKTOP)
    expect(appMenu(h)).toEqual(DESKTOP_APP_MENU)
    // The app group closes the menu in Firefox's order and §6's – settings, tools, help, quit –
    // under the last separator: More Tools is the app's long tail, not the page's.
    const top = topLabels(h.shown())
    expect(top.slice(top.lastIndexOf('-') + 1)).toEqual(['Settings', 'More Tools', 'Help', 'Quit'])
  })

  it('stands on an 800 px window: about eighteen top-level rows and three separators, four with the Now Playing… row (§6)', () => {
    const rows = (h: Harness): string[] => topLabels(h.shown()).filter((l) => l !== '-')
    // The DESKTOP harness has no translate host and no speech engine: Firefox's eighteen, with
    // Chrome's Delete Browsing Data… row in the library group and Save and Share closing the
    // page's group – the submenu's one row where the flat group spent three to six.
    const bare = harness(DESKTOP)
    appMenu(bare)
    expect(rows(bare)).toEqual(DESKTOP_APP_MENU_TOP.filter((l) => l !== '-'))
    expect(rows(bare)).toHaveLength(18)
    expect(separators(bare.shown())).toBe(3)
    // A build with a translate host carries Translate Page… (19), one with a speech engine
    // Listen to This Page too: the Linux build's twenty rows and three separators – #299's
    // count, 31 × 20 + 9 × 3 + 14 = 661 px on the chrome's rows – every row Title Case (§9.1).
    const full = pageHarness({ ...DESKTOP, readAloud: true }, { translate: true, speech: true })
    appMenu(full)
    expect(rows(full)).toHaveLength(20)
    expect(separators(full.shown())).toBe(3)
    for (const row of rows(full)) expect(row).toMatch(/^[A-Z]/)
    // With the media hub folded the Now Playing… row and its separator lead: twenty-one rows
    // and four separators (701 px), which still stand on an 800 px window under the bar's 74.
    full.browser.state.media = [
      { tabId: full.tabId, playing: true, title: 'Nocturne', session: true }
    ]
    appMenuFolded(full)
    expect(rows(full)).toHaveLength(21)
    expect(separators(full.shown())).toBe(4)
  })

  describe("Chrome's Update row at the menu's head (shortcuts-menus-101)", () => {
    /** The updater driven to `phase`, a 2.0.0 release found (downloaded when `ready`). */
    const updater = (
      h: Harness,
      phase: 'available' | 'ready' | 'downloading' | 'up-to-date'
    ): void => {
      const status = h.browser.updates.status()
      vi.spyOn(h.browser.updates, 'status').mockReturnValue({
        ...status,
        phase,
        release: {
          version: '2.0.0',
          tag: 'v2.0.0',
          prerelease: false,
          publishedAt: '2026-09-24T00:00:00Z',
          releaseUrl: 'https://github.com/BenItBuhner/Zenium/releases/tag/v2.0.0',
          notesUrl: 'https://github.com/BenItBuhner/Zenium/releases/tag/v2.0.0',
          asset: null
        },
        downloadedPath: phase === 'ready' ? '/tmp/zenium-2.0.0.AppImage' : null
      })
    }

    it('heads the desktop menu with Update Zenium over a hairline while an update is downloaded, and its pick relaunches into it (About’s Relaunch, #409)', () => {
      const h = harness(DESKTOP)
      updater(h, 'ready')
      const install = vi.spyOn(h.browser.updates, 'install').mockResolvedValue(undefined)
      expect(appMenu(h).slice(0, 3)).toEqual(['Update Zenium', '-', 'New Tab'])
      // Chrome's form of the row ("Update Google Chrome"), not About's "Relaunch to update".
      const row = h.shown()[0]
      expect(row).toMatchObject({ label: 'Update Zenium' })
      expect(row.enabled).not.toBe(false)
      row.click?.()
      expect(install).toHaveBeenCalledTimes(1)
      // The rest of the menu is as it was: the row is one row and one hairline more.
      expect(appMenu(h).slice(2)).toEqual(DESKTOP_APP_MENU)
    })

    it('shows nothing while an update is merely found (Chrome shows nothing on available), while it downloads, or when the build is up to date', () => {
      for (const phase of ['available', 'downloading', 'up-to-date'] as const) {
        const h = harness(DESKTOP)
        updater(h, phase)
        expect(appMenu(h), phase).toEqual(DESKTOP_APP_MENU)
      }
      // A host that cannot update has no row whatever the phase reads.
      const h = harness({ ...DESKTOP, updates: false })
      updater(h, 'ready')
      expect(appMenu(h)).not.toContain('Update Zenium')
    })

    it("is the desktop's alone: the tablet's and the phone's menus keep their shape with an update waiting", () => {
      const tablet = harness(ANDROID, 'tablet')
      updater(tablet, 'ready')
      expect(appMenu(tablet)).not.toContain('Update Zenium')
      expect(appMenu(tablet)[0]).toBe('New Tab')
      const phone = harness(ANDROID, 'phone')
      updater(phone, 'ready')
      expect(appMenu(phone)).not.toContain('Update Zenium')
    })

    it('is a twenty-first row only while the update waits: 21 rows / 4 separators (701 px); the Now Playing… row folded too, 22 / 5 (741 px) and the Update row first', () => {
      const rows = (h: Harness): string[] => topLabels(h.shown()).filter((l) => l !== '-')
      const full = pageHarness({ ...DESKTOP, readAloud: true }, { translate: true, speech: true })
      appMenu(full)
      expect(rows(full)).toHaveLength(20)
      expect(separators(full.shown())).toBe(3)
      updater(full, 'ready')
      appMenu(full)
      expect(rows(full)).toHaveLength(21)
      expect(separators(full.shown())).toBe(4)
      expect(rows(full)[0]).toBe('Update Zenium')
      // Chrome's order at the head: the update, then the folded hub's row, then the tabs.
      full.browser.state.media = [
        { tabId: full.tabId, playing: true, title: 'Nocturne', session: true }
      ]
      appMenuFolded(full)
      expect(rows(full)).toHaveLength(22)
      expect(separators(full.shown())).toBe(5)
      expect(topLabels(full.shown()).slice(0, 5)).toEqual([
        'Update Zenium',
        '-',
        'Now Playing…',
        '-',
        'New Tab'
      ])
    })
  })

  describe("Chrome's Tab groups submenu (shortcuts-menus-111)", () => {
    /** A folder of the window's space, its tabs closed and `pages` kept: a SAVED group. */
    const savedGroup = (
      h: Harness,
      name: string,
      pages: string[],
      patch: Partial<Folder> = {}
    ): Folder => {
      const folder = h.browser.createFolder(h.win.activeSpace().id, name, '📁', h.win, {
        rename: false,
        color: 'blue'
      })
      Object.assign(folder, {
        savedTabs: pages.map((url) => ({ url, title: url, favicon: null })),
        ...patch
      })
      return folder
    }
    /** The Tab Folders submenu of the window's app menu (Chrome's Tab groups ▸; the desktop's noun). */
    const tabGroups = (h: Harness, win = h.win): MenuItemTemplate[] => {
      h.browser.handleCommand(win, 'app.menu', {})
      return item(item(h.shown(), 'Bookmarks').submenu!, 'Tab Folders').submenu!
    }

    it("closes the Bookmarks submenu as its last group – Chrome's seat for a list beside the bookmarks – listing the saved groups by name with their mark, the most recently used first", () => {
      const h = pageHarness(DESKTOP)
      savedGroup(h, 'Research', ['https://a.example/', 'https://b.example/'], { lastUsedAt: 10 })
      savedGroup(h, 'Trip', ['https://c.example/'], { lastUsedAt: 20, color: 'green', icon: '✈️' })
      // An OPEN group (a live member) is the sidebar's, an EMPTY one (nothing kept) neither's.
      const open = h.browser.createFolder(h.win.activeSpace().id, 'Work', '📁', h.win, {
        rename: false
      })
      h.browser.tabs.moveToFolder(h.tabId, open.id)
      h.browser.createFolder(h.win.activeSpace().id, 'Empty', '📁', h.win, { rename: false })
      appMenu(h)
      const bookmarks = item(h.shown(), 'Bookmarks').submenu!
      expect(topLabels(bookmarks).slice(-3)).toEqual(['Export Bookmarks…', '-', 'Tab Folders'])
      expect(separators(bookmarks)).toBe(3)
      const rows = tabGroups(h)
      expect(rows.map((r) => r.label)).toEqual(['Trip', 'Research'])
      expect(rows[0]).toMatchObject({ group: { color: 'green', icon: '✈️', saved: true } })
      expect(rows[1]).toMatchObject({ group: { color: 'blue', icon: '📁', saved: true } })
      for (const row of rows) expect(row.enabled).not.toBe(false)
      // The mark rides the descriptor the renderer draws (`serialiseMenu`).
      expect(serialiseMenu(rows, 'm').items.map((r) => r.group)).toEqual([
        { color: 'green', icon: '✈️', saved: true },
        { color: 'blue', icon: '📁', saved: true }
      ])
      // The top level keeps its resting shape – §6's three separators, no row of its own for
      // the groups (twenty rows, 661 px, on the full host) – with groups saved: the list is
      // the submenu's. (A page harness's zoom row carries its percentage.)
      appMenu(h)
      expect(topLabels(h.shown()).map((l) => l.replace(' (100%)', ''))).toEqual(
        DESKTOP_APP_MENU_TOP
      )
      expect(separators(h.shown())).toBe(3)
    })

    it("a row's pick opens the group in this window: its pages back as its tabs, the first active; the group is then the sidebar's and leaves the list", () => {
      const h = pageHarness(DESKTOP)
      const research = savedGroup(h, 'Research', ['https://a.example/', 'https://b.example/'])
      savedGroup(h, 'Trip', ['https://c.example/'], { lastUsedAt: 1 })
      item(tabGroups(h), 'Research').click?.()
      const m = h.browser.state.model
      const members = Object.values(m.tabs).filter((t) => t.folderId === research.id)
      expect(members.map((t) => t.url)).toEqual(['https://a.example/', 'https://b.example/'])
      expect(h.browser.tabs.activeTabFor(h.win)?.url).toBe('https://a.example/')
      expect(m.folders[research.id].savedTabs).toBeNull()
      expect(tabGroups(h).map((r) => r.label)).toEqual(['Trip'])
    })

    it("with nothing saved the submenu is §9.17's empty state: 'No saved tab folders' as the note row", () => {
      const h = harness(DESKTOP)
      expect(tabGroups(h)).toEqual([{ label: 'No saved tab folders', enabled: false, note: true }])
      // A group open in the sidebar saves nothing yet: still the note.
      const p = pageHarness(DESKTOP)
      const open = p.browser.createFolder(p.win.activeSpace().id, 'Work', '📁', p.win, {
        rename: false
      })
      p.browser.tabs.moveToFolder(p.tabId, open.id)
      expect(tabGroups(p).map((r) => r.label)).toEqual(['No saved tab folders'])
    })

    it("is the desktop's alone, and no row of a private window's menu: the tablet's and the phone's Bookmarks keep their shape", () => {
      const desktop = pageHarness(DESKTOP)
      savedGroup(desktop, 'Trip', ['https://c.example/'])
      const priv = desktop.browser.openWindow('private', desktop.win)!
      desktop.browser.handleCommand(priv, 'app.menu', {})
      expect(labels(desktop.shown())).not.toContain('Bookmarks > Tab Folders')
      expect(labels(item(desktop.shown(), 'Bookmarks').submenu!).at(-1)).toBe('Export Bookmarks…')
      const tablet = pageHarness(DESKTOP, { formFactor: 'tablet' })
      savedGroup(tablet, 'Trip', ['https://c.example/'])
      expect(appMenu(tablet)).not.toContain('Bookmarks > Tab Folders')
      const phone = pageHarness(ANDROID, { formFactor: 'phone' })
      savedGroup(phone, 'Trip', ['https://c.example/'])
      expect(appMenu(phone)).not.toContain('Bookmarks > Tab Folders')
      expect(allItems(phone.shown()).map((i) => i.label)).not.toContain('Tab Folders')
    })
  })

  it('folds Chrome’s Save and Share into a submenu closing the page’s group, before the app’s separator: the saves, then the shares (shortcuts-menus-120)', () => {
    // A host that shares and pins shortcuts, with a page up and the install surface mounted,
    // syncing with another device: every row of the group stands – Save Page As…, Create
    // Shortcut…, Manage Apps (shortcuts-menus-138), Web Capture…, Print…, Share…, Send to Your
    // Devices – and no Cast row.
    const h = pageHarness({ ...DESKTOP, share: true, pinShortcuts: true }, { shortcuts: true })
    h.browser.handleCommand(h.win, 'ui.surface', { surface: 'install', mounted: true })
    vi.spyOn(h.browser.sync, 'status').mockReturnValue({
      ...h.browser.sync.status(),
      enabled: true,
      devices: [
        { id: 'phone', name: 'Pixel 9', lastSeen: 2 },
        { id: 'laptop', name: 'Work laptop', lastSeen: 1 }
      ]
    })
    appMenu(h)
    const top = topLabels(h.shown())
    const at = top.indexOf('Save and Share')
    // The page's actions close with the reader's row, then the submenu, then the app's
    // separator – no separator of the group's own, so the top level keeps §6's three.
    expect(top.slice(at - 1, at + 3)).toEqual(['Reader View', 'Save and Share', '-', 'Settings'])
    expect(separators(h.shown())).toBe(3)
    const group = item(h.shown(), 'Save and Share').submenu!
    expect(topLabels(group)).toEqual([
      'Save Page As',
      'Create Shortcut…',
      'Manage Apps',
      'Web Capture…',
      'Print…',
      'Share…',
      'Send to Your Devices'
    ])
    expect(allItems(h.shown()).map((i) => i.label)).not.toContain('Cast…')
    // The saves run the same actions as the keys, and the rows carry their chords: Save Page As
    // is the formats' submenu on this host, its marked row the key's (CT-27, tested below).
    expect(item(item(group, 'Save Page As').submenu!, 'Webpage, Complete…').action).toBe(
      'page.savePage'
    )
    expect(item(group, 'Web Capture…').action).toBe('capture.start')
    expect(item(group, 'Print…')).toMatchObject({
      action: 'page.printPreview',
      accelerator: 'Ctrl+P'
    })
    // Create Shortcut… is the install row, the way into the chrome's install dialog.
    h.sent.length = 0
    item(group, 'Create Shortcut…').click?.()
    expect(h.sent).toContain('webapp.install')
    // The bare desktop keeps the submenu less the rows its host cannot act on, in the same seat.
    const bare = harness(DESKTOP)
    appMenu(bare)
    const bareTop = topLabels(bare.shown())
    const bareAt = bareTop.indexOf('Save and Share')
    expect(bareTop.slice(bareAt - 1, bareAt + 3)).toEqual([
      'Reader View',
      'Save and Share',
      '-',
      'Settings'
    ])
    expect(labels(item(bare.shown(), 'Save and Share').submenu!)).toEqual([
      'Save Page As',
      'Save Page As > Webpage, Complete…',
      'Save Page As > Webpage, HTML Only…',
      'Save Page As > Webpage, Single File…',
      'Web Capture…',
      'Print…'
    ])
  })

  it('Save Page As is the formats’ submenu on a host that writes Chrome’s three (CT-27): radio rows in the dialog’s words, the last-used format marked and carrying Ctrl+S, a pick saving in its format and remembering it', () => {
    const h = pageHarness(DESKTOP)
    const saveAs = vi.spyOn(h.browser.actions, 'savePageAs').mockImplementation(() => undefined)
    const rows = (): MenuItemTemplate[] => {
      appMenu(h)
      return item(item(h.shown(), 'Save and Share').submenu!, 'Save Page As').submenu!
    }
    // Chrome's dialog's three types, in its order; a fresh profile saves complete pages, as
    // Chrome's dialog opens on Webpage, Complete.
    expect(rows().map((r) => [r.label, r.type, r.checked])).toEqual([
      ['Webpage, Complete…', 'radio', true],
      ['Webpage, HTML Only…', 'radio', false],
      ['Webpage, Single File…', 'radio', false]
    ])
    // The marked row is what the key does, so it alone carries the chord (`withAccelerators`
    // fills it from the action); the others are picks of a format, chordless.
    expect(item(rows(), 'Webpage, Complete…')).toMatchObject({
      action: 'page.savePage',
      accelerator: 'Ctrl+S'
    })
    expect(item(rows(), 'Webpage, HTML Only…').action).toBeUndefined()
    expect(item(rows(), 'Webpage, HTML Only…').accelerator).toBeUndefined()
    // A row's pick saves the active page in its format – its own click, not the action's.
    item(rows(), 'Webpage, Single File…').click?.()
    expect(saveAs).toHaveBeenCalledWith(h.tabId, h.win, 'singleFile')
    // The format a save went through in is the one the key saves in next (Edge remembers the
    // dialog's last type): the mark moves and the chord with it.
    h.browser.updateSettings({ downloads: { savePageFormat: 'singleFile' } }, h.win)
    expect(rows().map((r) => r.checked)).toEqual([false, false, true])
    expect(item(rows(), 'Webpage, Single File…')).toMatchObject({
      action: 'page.savePage',
      accelerator: 'Ctrl+S'
    })
    expect(item(rows(), 'Webpage, Complete…').accelerator).toBeUndefined()
    // The page's context menu keeps Chrome's one Save Page As… row, the key's save.
    expect(h.menu(pageParams())).toContain('Save Page As…')
    expect(item(h.items(), 'Save Page As…').action).toBe('page.savePage')
    // No page up: the rows stand, disabled, as the row of before did.
    const empty = harness(DESKTOP)
    appMenu(empty)
    const disabled = item(item(empty.shown(), 'Save and Share').submenu!, 'Save Page As')
    expect(disabled.enabled).toBe(false)
    expect(disabled.submenu!.every((r) => r.enabled === false)).toBe(true)
    // A host without the formats – Android's WebView writes its one archive – keeps the one
    // row, on the tablet's menu as before (the phone saves through its icon row's Download Page).
    const tablet = pageHarness(ANDROID, { formFactor: 'tablet' })
    appMenu(tablet)
    const row = item(item(tablet.shown(), 'Save and Share').submenu!, 'Save Page As…')
    expect(row.submenu).toBeUndefined()
    expect(row.action).toBe('page.savePage')
  })

  it('a Save Page As pick asks the view for its format under the title’s name, lists the file it wrote by the file’s type, and remembers the format for Ctrl+S; a cancelled dialog remembers nothing (CT-27)', async () => {
    const h = pageHarness(DESKTOP)
    h.browser.tabs.tab(h.tabId)!.title = 'Example Page'
    const view = h.browser.tabs.view(h.tabId)!
    const asked: [string, string][] = []
    let answer: string | null = null
    // The recording view answers nothing to a save; this one answers the dialog's path.
    view.savePage = (name, format) => {
      asked.push([name, format])
      return Promise.resolve(answer)
    }
    const format = (): string => resolveDownloadSettings(h.browser.state.settings).savePageFormat
    expect(format()).toBe('complete')
    // A cancelled dialog: no file, no row, and the key's format stands.
    h.browser.actions.savePageAs(h.tabId, h.win, 'singleFile')
    await settle()
    expect(asked).toEqual([['Example Page.mhtml', 'singleFile']])
    expect(h.browser.downloads.visibleTo(false)).toEqual([])
    expect(format()).toBe('complete')
    // A save that went through: the row reads the written file – an archive by its extension –
    // and the format is the key's from now on.
    answer = '/home/u/Downloads/Example Page.mhtml'
    h.browser.actions.savePageAs(h.tabId, h.win, 'singleFile')
    await settle()
    expect(h.browser.downloads.visibleTo(false).map((d) => [d.savePath, d.mimeType])).toEqual([
      ['/home/u/Downloads/Example Page.mhtml', 'multipart/related']
    ])
    expect(format()).toBe('singleFile')
    // Ctrl+S saves in the remembered format; a name the dialog was given with another extension
    // is listed as what it is.
    answer = '/home/u/Downloads/kept.html'
    h.browser.actions.run('page.savePage', { sourceTabId: h.tabId, win: h.win })
    await settle()
    expect(asked.at(-1)).toEqual(['Example Page.mhtml', 'singleFile'])
    expect(h.browser.downloads.visibleTo(false)[0]).toMatchObject({
      savePath: '/home/u/Downloads/kept.html',
      mimeType: 'text/html'
    })
  })

  it('seats Edge’s Manage Apps under the install row, whatever the page shows, on a desktop host that pins launchers; its pick opens Settings › Apps (shortcuts-menus-138)', () => {
    // The install row is the page's (an installable page, the surface up); Manage Apps is the
    // list's, so it stands with no page up and no surface, on any host that writes launchers –
    // the way to the installed apps by name, with Open and Uninstall.
    const h = harness({ ...DESKTOP, pinShortcuts: true }, { shortcuts: true })
    appMenu(h)
    let group = item(h.shown(), 'Save and Share').submenu!
    expect(topLabels(group)).toEqual(['Save Page As', 'Manage Apps', 'Web Capture…', 'Print…'])
    const open = vi.spyOn(h.browser.pages, 'open')
    item(group, 'Manage Apps').click?.()
    expect(open).toHaveBeenCalledWith('settings', 'apps', h.win)
    // With the install row up the pair reads as Edge's Apps does: install, then manage.
    h.browser.tabs.createTab({ url: PAGE_URL, active: true }, h.win)
    h.browser.handleCommand(h.win, 'ui.surface', { surface: 'install', mounted: true })
    appMenu(h)
    group = item(h.shown(), 'Save and Share').submenu!
    expect(topLabels(group).slice(0, 3)).toEqual([
      'Save Page As',
      'Create Shortcut…',
      'Manage Apps'
    ])
    // A host that pins no launchers has no list to manage: the bare desktop, the tablet and the
    // phone show no row (the section is the desktop OSes'; Android's apps are the launcher's).
    for (const other of [
      harness(DESKTOP),
      harness({ ...DESKTOP, pinShortcuts: true }, { formFactor: 'tablet', shortcuts: true }),
      harness({ ...ANDROID, pinShortcuts: true }, { formFactor: 'phone', shortcuts: true })
    ]) {
      appMenu(other)
      expect(allItems(other.shown()).map((i) => i.label)).not.toContain('Manage Apps')
    }
  })

  it('carries Chrome’s Delete Browsing Data… row at the top level, closing the library group with its chord, and runs the dialog’s request from it', () => {
    const h = harness(DESKTOP)
    const menu = appMenu(h)
    expect(menu.indexOf('Delete Browsing Data…')).toBe(menu.indexOf('Add-ons and Themes') + 1)
    expect(menu[menu.indexOf('Delete Browsing Data…') + 1]).toBe('-')
    const row = item(h.shown(), 'Delete Browsing Data…')
    expect(row.action).toBe('privacy.clearBrowsingData')
    expect(row.accelerator).toBe('Ctrl+Shift+Delete')
    h.sent.length = 0
    row.click?.()
    expect(h.sent).toEqual(['clearBrowsingData.open'])
    // The tablet's menu has the row too; the phone's form is the Settings sheet.
    expect(appMenu(harness(DESKTOP, 'tablet'))).toContain('Delete Browsing Data…')
    expect(appMenu(harness(ANDROID, 'phone'))).not.toContain('Delete Browsing Data…')
  })

  it('carries Chrome’s Name Window… in More Tools with the window rows and asks the chrome for the prompt (shortcuts-menus-121)', () => {
    const h = harness(DESKTOP)
    const menu = appMenu(h)
    // The window rows: New Blank Window, the one that names this one, then its double – the
    // group closes after Duplicate Window (the #451 lead check's order).
    expect(menu.indexOf('More Tools > Name Window…')).toBe(
      menu.indexOf('More Tools > New Blank Window') + 1
    )
    expect(menu[menu.indexOf('More Tools > Name Window…') + 1]).toBe(
      'More Tools > Duplicate Window'
    )
    expect(menu[menu.indexOf('More Tools > Duplicate Window') + 1]).toBe('More Tools > -')
    const row = deepItem(h.shown(), 'Name Window…')
    expect(row.action).toBe('window.name')
    // Unbound in both presets, as in Chrome: no chord after the label.
    expect(row.accelerator).toBeUndefined()
    h.sent.length = 0
    row.click?.()
    expect(h.sent).toEqual(['windowName.open'])
    // The desktop's alone: a tablet's one window has no title bar to name, the phone none.
    expect(appMenu(harness(DESKTOP, 'tablet'))).not.toContain('More Tools > Name Window…')
    const phone = harness(ANDROID, 'phone')
    appMenu(phone)
    expect(allItems(phone.shown()).map((i) => i.label)).not.toContain('Name Window…')
  })

  it('carries Duplicate Window right after Name Window… in More Tools (the name first, then the verb that makes another – the #451 lead check’s order), making a second window on this one’s space; left out for a popup (session-19)', () => {
    const h = harness(DESKTOP)
    const menu = appMenu(h)
    expect(menu.indexOf('More Tools > Duplicate Window')).toBe(
      menu.indexOf('More Tools > Name Window…') + 1
    )
    expect(menu.indexOf('More Tools > Name Window…')).toBe(
      menu.indexOf('More Tools > New Blank Window') + 1
    )
    const row = deepItem(h.shown(), 'Duplicate Window')
    expect(row.action).toBe('window.duplicate')
    // Never greyed: the row is there to run or not there at all.
    expect(row.enabled).toBeUndefined()
    // Unbound in both presets: no chord after the label.
    expect(row.accelerator).toBeUndefined()
    const before = h.browser.allWindows()
    row.click?.()
    const windows = h.browser.allWindows()
    expect(windows).toHaveLength(before.length + 1)
    const dup = windows.find((w) => !before.includes(w))
    expect(dup?.kind).toBe(h.win.kind)
    expect(dup?.activeSpace().id).toBe(h.win.activeSpace().id)
    expect(dup?.cascadeFrom).toBe(h.win)
    // A popup's toolbar-only chrome has no tab strip to duplicate: the row is left out rather
    // than greyed (`when`'s rule for a row the host cannot act on); the window rows around it stay.
    const popup = h.browser.createWindow({
      kind: 'synced',
      from: h.win,
      chrome: 'popup',
      bounds: { x: 0, y: 0, width: 400, height: 300 }
    })
    h.browser.handleCommand(popup, 'app.menu', {})
    const popupLabels = allItems(h.shown()).map((i) => i.label)
    expect(popupLabels).not.toContain('Duplicate Window')
    expect(popupLabels).toContain('New Blank Window')
    expect(popupLabels).toContain('Name Window…')
    // A host with one window has nothing to duplicate into: no row.
    const phone = harness(ANDROID, 'phone')
    appMenu(phone)
    expect(allItems(phone.shown()).map((i) => i.label)).not.toContain('Duplicate Window')
  })

  describe('the developer tools dock rows (design language v2 §9.29)', () => {
    /** The More Tools submenu as the desktop draws it. */
    const moreTools = (h: Harness): MenuItemTemplate[] => {
      appMenu(h)
      return item(h.shown(), 'More Tools').submenu!
    }
    const dockRows = (h: Harness): MenuItemTemplate[] =>
      moreTools(h).filter((i) =>
        /^(Dock to Bottom|Dock to Right|Dock to Left|Undock)$/.test(i.label ?? '')
      )

    it('follow Developer Tools as the toolbox’s four radio rows – bottom, right, left, undocked – the remembered dock checked, the bottom to begin with', () => {
      const h = harness(DESKTOP)
      const rows = moreTools(h)
      const devtools = rows.findIndex((i) => i.label === 'Developer Tools')
      expect(labels(rows.slice(devtools))).toEqual([
        'Developer Tools',
        'Dock to Bottom',
        'Dock to Right',
        'Dock to Left',
        'Undock'
      ])
      for (const row of dockRows(h)) {
        expect(row.type).toBe('radio')
        // A preference, not a page action: it stands without an active page.
        expect(row.enabled).not.toBe(false)
        expect(row.action).toBeUndefined()
      }
      expect(dockRows(h).map((r) => r.checked)).toEqual([true, false, false, false])
      // Every row Title Case (§9.1).
      for (const row of dockRows(h)) expect(row.label).toMatch(/^[A-Z]/)
    })

    it('a row remembers its dock and moves every open toolbox there; a choice made inside the toolbox – left included – checks its row', () => {
      const h = pageHarness()
      // A toolbox up on the page (its host said `onDevtoolsOpened`).
      h.browser.state.devtoolsOpenFor.add(h.tabId)
      h.viewCalls.length = 0
      dockRows(h)[1].click?.()
      expect(h.browser.state.settings.devtoolsDock).toBe('right')
      expect(h.viewCalls).toEqual(['setDevtoolsDock("right")'])
      expect(dockRows(h).map((r) => r.checked)).toEqual([false, true, false, false])
      // Dock to Left goes the same way as Dock to Right (the lead's ruling 4 on #414).
      h.viewCalls.length = 0
      dockRows(h)[2].click?.()
      expect(h.browser.state.settings.devtoolsDock).toBe('left')
      expect(h.viewCalls).toEqual(['setDevtoolsDock("left")'])
      expect(dockRows(h).map((r) => r.checked)).toEqual([false, false, true, false])
      h.viewCalls.length = 0
      dockRows(h)[3].click?.()
      expect(h.browser.state.settings.devtoolsDock).toBe('undocked')
      expect(h.viewCalls).toEqual(['setDevtoolsDock("undocked")'])
      expect(dockRows(h).map((r) => r.checked)).toEqual([false, false, false, true])
      // The same row again: nothing to store, the toolboxes still told where to stand.
      h.viewCalls.length = 0
      dockRows(h)[3].click?.()
      expect(h.viewCalls).toEqual(['setDevtoolsDock("undocked")'])
      // With no toolbox up the choice is kept for the next opening alone.
      h.browser.state.devtoolsOpenFor.clear()
      h.viewCalls.length = 0
      dockRows(h)[0].click?.()
      expect(h.browser.state.settings.devtoolsDock).toBe('bottom')
      expect(h.viewCalls).toEqual([])
      // The toolbox's own Dock to left, read back through the host: kept, and its row checked –
      // the group never stands all unchecked.
      h.browser.tabs.setDevtoolsDock('left', h.win, { move: false })
      expect(h.browser.state.settings.devtoolsDock).toBe('left')
      expect(dockRows(h).map((r) => r.checked)).toEqual([false, false, true, false])
    })

    it('open the toolbox at the remembered dock from the row, the chords and the context menu alike', () => {
      const h = pageHarness()
      h.viewCalls.length = 0
      deepItem(moreTools(h), 'Developer Tools').click?.()
      expect(h.viewCalls).toEqual(['openDevTools("toggle","bottom")'])
      h.browser.updateSettings({ devtoolsDock: 'right' }, h.win)
      h.viewCalls.length = 0
      deepItem(moreTools(h), 'Developer Tools').click?.()
      h.browser.actions.run('devtools.console', { sourceTabId: h.tabId, win: h.win })
      h.browser.actions.run('devtools.inspector', { sourceTabId: h.tabId, win: h.win })
      expect(h.viewCalls).toEqual([
        'openDevTools("toggle","right")',
        'openDevTools("console","right")',
        'openDevTools("inspect","right")'
      ])
    })

    it('are the hosts’ with developer tools, as the Developer Tools row is: none on Android', () => {
      const tablet = harness(ANDROID, 'tablet')
      appMenu(tablet)
      const everywhere = allItems(tablet.shown()).map((i) => i.label)
      for (const label of [
        'Developer Tools',
        'Dock to Bottom',
        'Dock to Right',
        'Dock to Left',
        'Undock'
      ])
        expect(everywhere).not.toContain(label)
      // A profile whose dock is not one the host knows reads as the bottom (state.ts).
      const h = harness(DESKTOP)
      h.browser.updateSettings({ devtoolsDock: 'sideways' as never }, h.win)
      expect(h.browser.state.settings.devtoolsDock).toBe('bottom')
    })
  })

  it('folds the desktop’s Take Screenshot and Capture Full Page into Web Capture… (the #396 review’s ruling 3); the tablet keeps its two rows', () => {
    const desktop = harness(DESKTOP)
    const desktopMenu = appMenu(desktop)
    const everywhere = allItems(desktop.shown()).map((i) => i.label)
    expect(everywhere).not.toContain('Take Screenshot')
    expect(everywhere).not.toContain('Capture Full Page')
    expect(desktopMenu).toContain('Save and Share > Web Capture…')
    // More Tools: two rows and a separator fewer than the row had – ten of its own (the
    // desktop's Task Manager among them, W5-8; Duplicate Window with the window rows, W5-13),
    // the four dock rows after them, two separators.
    const moreTools = item(desktop.shown(), 'More Tools').submenu!
    expect(moreTools.filter((i) => i.type !== 'separator')).toHaveLength(14)
    expect(separators(moreTools)).toBe(2)
    // The tablet's chrome has no Web Capture… overlay, so its More Tools keeps the two captures
    // in their own group before the resources.
    const tablet = harness(DESKTOP, 'tablet')
    const tabletMenu = appMenu(tablet)
    for (const label of TABLET_CAPTURES) expect(tabletMenu).toContain(label)
    expect(tabletMenu.indexOf('More Tools > Capture Full Page')).toBe(
      tabletMenu.indexOf('More Tools > Take Screenshot') + 1
    )
    expect(tabletMenu).not.toContain('Save and Share > Web Capture…')
    const tabletMore = item(tablet.shown(), 'More Tools').submenu!
    expect(separators(tabletMore)).toBe(3)
    // The rows keep their actions where they stand, so the palette and the Zen preset's chord
    // (`key_screenshot`) still reach them on the tablet; the phone's flat list keeps them too.
    expect(deepItem(tablet.shown(), 'Take Screenshot').action).toBe('page.screenshot')
    expect(deepItem(tablet.shown(), 'Capture Full Page').action).toBe('page.captureFullPage')
    expect(appMenu(harness(ANDROID, 'phone'))).toContain('Take Screenshot')
  })

  it('loses nothing the flat menu could do: every one of its thirty-two rows, on a host with every capability, is a row or a submenu row now', () => {
    /**
     * The flat menu of main at a8cca556 as the Linux build drew it on a web page with a
     * translate host, a speech engine and the install surface up (the #299 record's "before"
     * list): thirty-two rows in six groups. The one claim, on the full capability set – the
     * host-gated rows (Translate Page…, Listen to This Page, Create Shortcut…) included.
     */
    const before = [
      'New Tab',
      'Search Tabs…',
      'New Space…',
      'New Window',
      'New Blank Window',
      'New Private Window',
      'Bookmarks',
      'History',
      'Recently Closed',
      'Downloads',
      'Passwords',
      'Add-ons and Themes',
      'Compact Mode',
      'Change Theme…',
      'Zoom (100%)',
      'Split View',
      'Fullscreen',
      'Find in Page…',
      'Reader View',
      'Listen to This Page',
      'Translate Page…',
      'Create Shortcut…',
      'Print…',
      'Save Page As…',
      'Take Screenshot',
      'Capture Full Page',
      'Resources',
      'Keyboard Shortcuts',
      'Settings',
      'Developer Tools',
      'About Zenium 1.2.3',
      'Quit'
    ]
    expect(before).toHaveLength(32)
    const h = pageHarness(
      { ...DESKTOP, readAloud: true, pinShortcuts: true },
      { translate: true, speech: true, shortcuts: true }
    )
    h.browser.handleCommand(h.win, 'ui.surface', { surface: 'install', mounted: true })
    appMenu(h)
    // The History page is the submenu's first row and keeps its chord; with nothing closed the
    // recently closed block is §9.17's one sentence – a note in the deemphasised ink, not a
    // greyed command – under the separator.
    const history = item(h.shown(), 'History').submenu!
    expect(history[0]).toMatchObject({ label: 'Show Full History', action: 'history.sidebar' })
    expect(labels(history)).toEqual(['Show Full History', '-', 'No recently closed tabs'])
    expect(history.at(-1)).toMatchObject({ enabled: false, note: true })
    expect(history.at(-1)!.click).toBeUndefined()
    // With a tab closed the block is Chrome's: the header, the entries, Restore All, Clear List
    // – and every one of the flat menu's thirty-two rows is somewhere in the tree, the top level
    // still Firefox's count (twenty rows here, with Delete Browsing Data… and the Save and Share
    // submenu's one row – Create Shortcut… inside it with the install surface up; §6's three
    // separators).
    const closed = h.browser.tabs.createTab(
      { url: 'https://closed.example/', active: false },
      h.win
    )
    h.browser.tabs.closeTab(closed.id, false, h.win)
    appMenu(h)
    const everywhere = allItems(h.shown()).map((i) => i.label)
    // The flat menu's two captures are the desktop's one Web Capture… row now (the #396
    // review's ruling 3): the overlay takes the visible area and the full page both, so
    // nothing the two rows did is lost, and More Tools is two rows and a separator shorter.
    const foldedIntoWebCapture = new Set(['Take Screenshot', 'Capture Full Page'])
    // The flat menu's disabled version line is Help's About Zenium row now, which opens the
    // About page the version is on (shortcuts-menus-152).
    // The flat menu's Save Page As… is the formats' submenu on this host (CT-27).
    const renamed: Record<string, string> = {
      'About Zenium 1.2.3': 'About Zenium',
      'Save Page As…': 'Save Page As'
    }
    for (const label of before)
      expect(everywhere, label).toContain(
        foldedIntoWebCapture.has(label) ? 'Web Capture…' : (renamed[label] ?? label)
      )
    for (const label of foldedIntoWebCapture) expect(everywhere).not.toContain(label)
    expect(topLabels(h.shown()).filter((l) => l !== '-')).toHaveLength(20)
    expect(separators(h.shown())).toBe(3)
    expect(labels(item(h.shown(), 'History').submenu!)).toEqual([
      'Show Full History',
      '-',
      'Recently Closed',
      'closed.example',
      '-',
      'Restore All',
      'Clear List'
    ])
    expect(deepItem(h.shown(), 'closed.example').action).toBe('tab.reopenClosed')
  })

  it('gives a tablet the sidebar layouts\u2019 menu, less what acts on chrome it does not draw (TABLET-01)', () => {
    // Compact Mode is the desktop's hover-revealed sidebar (the tablet's rail is the toolbar's
    // toggle) and the tablet has no bookmarks bar; everything else of the desktop's list is the
    // tablet's too, its host permitting. Both rows live in submenus now (§6 "Menus"). Web
    // capture's overlay is the desktop chrome's, so its row is too – which is why the tablet's
    // More Tools keeps Take Screenshot and Capture Full Page, the rows the desktop folded into
    // it; Name Window… names an OS title bar the tablet's one window does not have; the Tab
    // Folders submenu (its group closing Bookmarks) is the desktop's, the tablet's saved groups
    // being its overview's pane (TAB-16). The task manager is a page tab of the desktop layout
    // alone (`internalPages.ts`).
    const tabletChrome = DESKTOP_APP_MENU.filter(
      (label) =>
        label !== 'More Tools > Compact Mode' &&
        label !== 'More Tools > Name Window…' &&
        label !== 'More Tools > Task Manager' &&
        label !== 'Bookmarks > Show Bookmarks Bar' &&
        label !== 'Bookmarks > Tab Folders' &&
        label !== 'Save and Share > Web Capture…'
    )
    tabletChrome.splice(tabletChrome.lastIndexOf('Bookmarks > -'), 1)
    tabletChrome.splice(tabletChrome.indexOf('More Tools > Resources'), 0, ...TABLET_CAPTURES)
    expect(appMenu(harness(DESKTOP, 'tablet'))).toEqual(tabletChrome)
  })

  it('on an Android tablet follows the capabilities as on the phone: no windows, no Quit', () => {
    const h = harness(ANDROID, 'tablet')
    const menu = appMenu(h)
    const everywhere = allItems(h.shown()).map((i) => i.label)
    for (const label of ['New Window', 'New Private Window', 'Quit', 'Compact Mode'])
      expect(everywhere).not.toContain(label)
    // The sidebar layouts' items the phone drops stay: the tablet has the sidebar and a toolbar
    // whose popovers they open – in the submenus Firefox's groups put them (§6).
    for (const label of [
      'Search Tabs…',
      'History > No recently closed tabs',
      'Help > Keyboard Shortcuts',
      'Save and Share > Save Page As…'
    ])
      expect(menu).toContain(label)
    // No icon row (the toolbar has Forward, the star and Reload) and no Extensions sheet (the
    // toolbar has the actions).
    expect(menu[0]).toBe('New Tab')
    expect(everywhere).not.toContain('Extensions')
  })

  it('offers Listen to This Page on a tablet with a speech engine, as on the phone', () => {
    expect(appMenu(pageHarness(ANDROID, { formFactor: 'tablet' }))).not.toContain(
      'Listen to This Page'
    )
    const h = pageHarness({ ...ANDROID, readAloud: true }, { formFactor: 'tablet', speech: true })
    const menu = appMenu(h)
    expect(menu.indexOf('Listen to This Page')).toBe(menu.indexOf('Reader View') + 1)
  })

  it("on a tablet with page controls keeps Fullscreen with the window's toggles under More Tools, the zoom being the sheet", () => {
    const menu = appMenu(harness(ANDROID, 'tablet'))
    expect(menu).toContain('Zoom…')
    expect(menu).not.toContain('Zoom > Fullscreen')
    expect(menu).toContain('More Tools > Fullscreen')
    expect(menu.indexOf('More Tools > Fullscreen')).toBe(
      menu.indexOf('More Tools > Change Theme…') + 1
    )
  })

  it("Help is Chrome's Help submenu in Chrome's order (shortcuts-menus-152): About Zenium opens the About page, What's New the release notes, Zenium Help and Report an Issue… their pages", () => {
    const opened: string[] = []
    const h = harness(DESKTOP)
    h.browser.platform.shell.openExternal = (url: string): Promise<void> => {
      opened.push(url)
      return Promise.resolve()
    }
    appMenu(h)
    const help = deepItem(h.shown(), 'Help').submenu ?? []
    expect(topLabels(help)).toEqual([
      'About Zenium',
      "What's New",
      '-',
      'Zenium Help',
      'Keyboard Shortcuts',
      'Report an Issue…'
    ])
    deepItem(h.shown(), 'Zenium Help').click?.()
    deepItem(h.shown(), 'Report an Issue…').click?.()
    expect(opened).toEqual([HELP_URL, ISSUES_URL])
    // About is a row that acts now – the About page (Settings › About: the version, the
    // update row, the legal pages), not a disabled version line; the version is the page's.
    const about = deepItem(h.shown(), 'About Zenium')
    expect(about.enabled).not.toBe(false)
    h.sent.length = 0
    about.click?.()
    expect(h.sent).toContain('overlay.open')
    // The phone's flat list keeps its version line, as it was.
    const phone = harness(ANDROID, 'phone')
    expect(appMenu(phone)).toContain('About Zenium 1.2.3')
    expect(appMenu(phone)).not.toContain("What's New")
  })

  it("What's New opens the running version's release notes: the zen://whats-new page tab where the host has it, else the version's release on GitHub in a tab", () => {
    // A host without page tabs (this fixture's `pageTabs: false`) cannot hold the `whats-new`
    // page tab: the release on GitHub, in a Zenium tab – the running version's, not the found
    // release's (`openRelease`).
    const h = pageHarness(DESKTOP)
    appMenu(h)
    deepItem(h.shown(), "What's New").click?.()
    expect(h.browser.tabs.activeTabFor(h.win)?.url).toBe(releaseNotesUrl('1.2.3'))
    expect(releaseNotesUrl('1.2.3')).toBe(
      'https://github.com/BenItBuhner/Zenium/releases/tag/v1.2.3'
    )
    // A host with page tabs opens the registered page (#424 registers `whats-new` for every
    // layout with page tabs): the tablet here, and the shipping desktop (`pageTabs: true`).
    const tablet = pageHarness(ANDROID, { formFactor: 'tablet' })
    appMenu(tablet)
    deepItem(tablet.shown(), "What's New").click?.()
    expect(tablet.browser.tabs.activeTabFor(tablet.win)?.url).toBe('zen://whats-new')
  })

  describe('the Now Playing… row (design language v2 §9.29: the hub folded into the menu)', () => {
    /** A media entry for `tabId`, the OS controls' session by default. */
    const media = (tabId: string, over: Partial<MediaState> = {}): MediaState => ({
      tabId,
      playing: true,
      title: 'Nocturne',
      artist: 'The Band',
      artwork: 'https://example.com/art.png',
      session: true,
      ...over
    })
    const ROW = 'Now Playing…'

    it('heads the desktop menu while a session is live and the hub button has folded, and is gone otherwise', () => {
      const h = pageHarness(DESKTOP)
      const without = appMenu(h)
      expect(without[0]).toBe('New Tab')
      h.browser.state.media = [media(h.tabId)]
      const menu = appMenuFolded(h)
      // Its name alone, the menu's Title Case (§9.1), the ellipsis of a popover opener: the
      // content is the hub's on the pick, and a menu row carrying it would widen the whole
      // menu (§5).
      expect(menu.slice(0, 3)).toEqual([ROW, '-', 'New Tab'])
      // The rest of the menu is as it was: the row is added at the top, nothing else moves.
      expect(menu.slice(2)).toEqual(without)
      // No picture (§9.29: a renderer-drawn menu's rows are all-or-nothing per menu, and the
      // app menu's carry none – a glyph column reserved only while a session plays would move
      // every label between one opening and the next); the artwork is the hub's on the pick.
      expect(h.items()[0].icon).toBeUndefined()
      expect(h.items().some((i) => i.icon)).toBe(false)
      h.browser.state.media = []
      expect(appMenuFolded(h)).toEqual(without)
    })

    it('is the folded state’s: with the hub’s toolbar button up, the button is the hub and the menu has no row', () => {
      const h = pageHarness(DESKTOP)
      const without = appMenu(h)
      h.browser.state.media = [media(h.tabId)]
      // The chrome's request without the fold (the tier has not folded the button, or the
      // request said nothing – the row never assumes a fold).
      expect(appMenu(h)).toEqual(without)
      h.browser.handleCommand(h.win, 'app.menu', { mediaHubFolded: false })
      expect(labels(h.shown())).toEqual(without)
      expect(appMenuFolded(h)[0]).toBe(ROW)
    })

    it('stays while the media has paused (the hub keeps its card), keeping its name', () => {
      const h = pageHarness(DESKTOP)
      h.browser.state.media = [media(h.tabId, { playing: false, session: false })]
      expect(appMenuFolded(h)[0]).toBe(ROW)
    })

    it('is one row for the hub, whatever plays: a session and a merely playing tab together are the one row, its name alone', () => {
      const h = pageHarness(DESKTOP)
      const other = h.browser.tabs.createTab({ url: 'https://video.example.org/watch' }, h.win)
      h.browser.state.media = [
        media(h.tabId, { session: false, artwork: 'https://example.com/background.png' }),
        media(other.id, { artwork: 'https://video.example.org/poster.jpg' })
      ]
      const menu = appMenuFolded(h)
      expect(menu[0]).toBe(ROW)
      expect(menu.filter((l) => l === ROW)).toHaveLength(1)
      // Neither card's artwork is on the row: the hub shows its cards on the pick.
      expect(h.items()[0].icon).toBeUndefined()
    })

    it('carries no picture with or without artwork – never the artwork, never the tab’s favicon (§9.29)', () => {
      const h = pageHarness(DESKTOP)
      h.browser.tabs.tab(h.tabId)!.favicon = 'https://example.com/favicon.ico'
      for (const artwork of ['https://example.com/art.png', null, '']) {
        h.browser.state.media = [media(h.tabId, { artwork })]
        expect(appMenuFolded(h)[0]).toBe(ROW)
        expect(h.items()[0].icon).toBeUndefined()
      }
    })

    it('is not there for media whose tab is gone', () => {
      const h = pageHarness(DESKTOP)
      const without = appMenu(h)
      h.browser.state.media = [media('gone')]
      expect(appMenuFolded(h)).toEqual(without)
    })

    it('is the window’s, as the hub is: another window’s own tab is that window’s row, not this one’s', () => {
      const h = pageHarness(DESKTOP)
      const without = appMenu(h)
      const priv = h.browser.openWindow('private', h.win)!
      const theirs = h.browser.tabs.createTab({ url: 'https://video.example.org/watch' }, priv)
      h.browser.state.media = [media(theirs.id, { artwork: 'https://video.example.org/p.jpg' })]
      // The main window's hub lists no such tab, so its menu carries no row for it…
      expect(appMenuFolded(h)).toEqual(without)
      // …while the private window's own menu leads with it.
      expect(appMenuFolded(h, priv)[0]).toBe(ROW)
      expect(h.items()[0].icon).toBeUndefined()
      // A synced tab shows in every synced window and so does its row.
      h.browser.state.media = [media(h.tabId)]
      expect(appMenuFolded(h)[0]).toBe(ROW)
      expect(appMenuFolded(h, priv)[0]).toBe('New Tab')
    })

    it('is the sidebar layouts’ row: the phone keeps its chip and sheet', () => {
      const h = pageHarness(ANDROID, { formFactor: 'phone' })
      h.browser.state.media = [media(h.tabId)]
      expect(appMenuFolded(h)).not.toContain(ROW)
      const tablet = pageHarness(ANDROID, { formFactor: 'tablet' })
      tablet.browser.state.media = [media(tablet.tabId)]
      expect(appMenuFolded(tablet)[0]).toBe(ROW)
    })

    it('opens the hub on its pick – every player and the transport – with the chrome focused', () => {
      const h = pageHarness(DESKTOP)
      h.browser.state.media = [media(h.tabId)]
      appMenuFolded(h)
      h.sent.length = 0
      h.click(ROW)
      expect(h.sent).toEqual(['mediahub.open'])
    })
  })

  describe('the folded Forward row (Look and Feel › Customise toolbar, settings-36: the button off the desktop bar)', () => {
    it('heads the desktop menu while Forward is unpinned and is gone while the bar has the button', () => {
      const h = pageHarness(DESKTOP)
      const without = appMenu(h)
      expect(without[0]).toBe('New Tab')
      expect(without).not.toContain('Forward')
      h.browser.state.settings.toolbarPins = { forward: false }
      const menu = appMenu(h)
      // The row and its separator at the top; nothing else moves.
      expect(menu.slice(0, 3)).toEqual(['Forward', '-', 'New Tab'])
      expect(menu.slice(2)).toEqual(without)
      // No glyph column: the desktop menu's rows carry none (§9.29's all-or-nothing).
      expect('glyph' in h.items()[0]).toBe(false)
      // Re-pinned (the key removed, as the dialog writes it), the row leaves.
      h.browser.state.settings.toolbarPins = {}
      expect(appMenu(h)).toEqual(without)
    })

    it('is disabled, not dropped, on the last history entry and steps forward with one (§9.30)', () => {
      const h = pageHarness(DESKTOP)
      h.browser.state.settings.toolbarPins = { forward: false }
      appMenu(h)
      expect(h.items()[0]).toMatchObject({
        label: 'Forward',
        action: 'nav.forward',
        enabled: false
      })
      h.browser.tabs.tab(h.tabId)!.canGoForward = true
      appMenu(h)
      expect(h.items()[0]).toMatchObject({ label: 'Forward', enabled: true })
      const go = vi.spyOn(h.browser.tabs, 'goForward').mockImplementation(() => undefined)
      h.click('Forward')
      expect(go).toHaveBeenCalledWith(h.tabId)
    })

    it('stands under the Now Playing… row when both have folded: the hub first, then Forward, then the tabs', () => {
      const h = pageHarness(DESKTOP)
      h.browser.state.settings.toolbarPins = { forward: false }
      h.browser.state.media = [
        {
          tabId: h.tabId,
          playing: true,
          title: 'Nocturne',
          artist: 'The Band',
          artwork: null,
          session: true
        }
      ]
      expect(appMenuFolded(h).slice(0, 5)).toEqual(['Now Playing…', '-', 'Forward', '-', 'New Tab'])
    })

    it('is the desktop’s alone: the tablet and the phone keep their bars whatever the field says', () => {
      const tablet = pageHarness(ANDROID, { formFactor: 'tablet' })
      tablet.browser.state.settings.toolbarPins = { forward: false }
      expect(appMenu(tablet)[0]).toBe('New Tab')
      const phone = pageHarness(ANDROID, { formFactor: 'phone' })
      phone.browser.state.settings.toolbarPins = { forward: false }
      // The phone's icon row has its own Forward (TB-08), one and only one.
      expect(appMenu(phone).filter((l) => l === 'Forward')).toHaveLength(1)
    })
  })

  it('keeps the desktop menu until the chrome reports a phone layout', () => {
    const h = harness(ANDROID)
    expect(appMenu(h)).toContain('Help > Keyboard Shortcuts')
    h.browser.handleCommand(h.win, 'window.formFactor', { formFactor: 'phone' })
    expect(appMenu(h)).not.toContain('Help > Keyboard Shortcuts')
    expect(appMenu(h)).not.toContain('Help')
  })

  it('opens Keyboard Shortcuts through page.open: the Settings overlay on its Shortcuts section on the desktop (a tablet with page tabs gets the tab)', () => {
    const desktop = pageHarness(DESKTOP)
    appMenu(desktop)
    desktop.sent.length = 0
    deepItem(desktop.shown(), 'Keyboard Shortcuts').click?.()
    expect(desktop.sent).toContain('overlay.open')
    expect(desktop.browser.tabs.activeTabFor(desktop.win)?.url).toBe(PAGE_URL)

    const tablet = pageHarness(ANDROID, { formFactor: 'tablet' })
    appMenu(tablet)
    tablet.sent.length = 0
    deepItem(tablet.shown(), 'Keyboard Shortcuts').click?.()
    expect(tablet.browser.tabs.activeTabFor(tablet.win)?.url).toBe('zen://settings/shortcuts')
    expect(tablet.sent).not.toContain('overlay.open')
  })

  it('seats Task Manager in More Tools before Developer Tools on the desktop alone, opening the zen://tasks page in its own window (shortcuts-menus-121, W5-18)', () => {
    const desktop = pageHarness({ ...DESKTOP, pageTabs: true })
    const menu = appMenu(desktop)
    const tools = menu.filter((l) => l.startsWith('More Tools > ') && l !== 'More Tools > -')
    expect(tools.indexOf('More Tools > Task Manager')).toBe(
      tools.indexOf('More Tools > Developer Tools') - 1
    )
    expect(tools.indexOf('More Tools > Task Manager')).toBe(
      tools.indexOf('More Tools > Resources') + 1
    )
    const row = deepItem(desktop.shown(), 'Task Manager')
    // The row's action is the shortcut's (Shift+Esc), so the menu shows its keys.
    expect(row.action).toBe('tasks.open')
    expect(row.enabled).not.toBe(false)
    const windowsBefore = desktop.browser.allWindows().length
    row.click?.()
    // As in Chrome and Edge, the task manager is a window of its own – a page window holding
    // the zen://tasks page and nothing else – and the browser window keeps its page in front.
    const tasksWin = desktop.browser.allWindows().find((w) => w.chrome === 'page')
    expect(tasksWin).toBeDefined()
    if (!tasksWin) return
    expect(desktop.browser.allWindows()).toHaveLength(windowsBefore + 1)
    expect(desktop.browser.tabs.activeTabFor(tasksWin)?.url).toBe('zen://tasks')
    expect(desktop.browser.tabs.visibleTabIds(tasksWin)).toHaveLength(1)
    expect(desktop.browser.tabs.activeTabFor(desktop.win)?.url).toBe(PAGE_URL)
    expect(desktop.focused.at(-1)).toBe(tasksWin.id)
    // A second press brings the one task manager to the front (one per profile), opening no
    // other window and no tab.
    const tabsBefore = Object.keys(desktop.browser.state.model.tabs).length
    desktop.focused.length = 0
    appMenu(desktop)
    deepItem(desktop.shown(), 'Task Manager').click?.()
    expect(desktop.browser.allWindows()).toHaveLength(windowsBefore + 1)
    expect(Object.keys(desktop.browser.state.model.tabs).length).toBe(tabsBefore)
    expect(desktop.focused).toEqual([tasksWin.id])
    expect(desktop.browser.tabs.activeTabFor(desktop.win)?.url).toBe(PAGE_URL)

    // Not a tablet's row: the page is the desktop layout's (`internalPages.ts` layouts).
    expect(appMenu(harness(DESKTOP, 'tablet'))).not.toContain('More Tools > Task Manager')
    expect(appMenu(harness(ANDROID, 'phone'))).not.toContain('Task Manager')
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
    const h = harness(ANDROID, 'phone')
    const menu = appMenu(h)
    const everywhere = allItems(h.shown()).map((i) => i.label)
    for (const label of DESKTOP_ONLY) expect(menu).not.toContain(label)
    for (const label of [
      'Search Tabs…',
      'Keyboard Shortcuts',
      'Compact Mode',
      'Split View',
      'Fullscreen',
      'Name Window…',
      'Quit',
      // Chrome's phone menu is one flat list: the desktop's submenus are not folded into it.
      'More Tools',
      'Help'
    ])
      expect(everywhere).not.toContain(label)
    // The host has no windows, extensions, devtools or resource governor.
    for (const label of [
      'New Window',
      'New Blank Window',
      'Duplicate Window',
      'New Private Window',
      'Add-ons and Themes',
      'Developer Tools',
      'Resources'
    ])
      expect(everywhere).not.toContain(label)
  })

  it('on a phone opens on the icon row and keeps the page and library items in their desktop order', () => {
    // The star moved from the Bookmarks submenu into the row (TB-16): one bookmark entry; and
    // the row's Download Page is the phone's one save entry, so no 'Save Page As…' row (TB-08).
    expect(appMenu(harness(ANDROID, 'phone'))).toEqual([
      'Forward',
      'Home',
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
      'About Zenium 1.2.3',
      '-',
      'Change Menu'
    ])
  })

  describe('the phone menu’s order (Edge’s Change menu, TB-22)', () => {
    const keysOf = (items: MenuItemTemplate[]): (string | undefined)[] => items.map((i) => i.key)

    it('names every item of the phone menu for the saved order – the icon row’s `icon.*`, the rows’ `row.*`, the hairlines’ `sep.*` – each once, and the Change Menu row last, outside the order', () => {
      const h = harness(ANDROID, 'phone')
      appMenu(h)
      const shown = h.shown()
      const keys = keysOf(shown)
      // Every item carries a key but the structural hairline between the sections and the one
      // before the Change Menu row.
      const unkeyed = shown.filter((i) => i.key === undefined)
      expect(unkeyed.every((i) => i.type === 'separator')).toBe(true)
      expect(unkeyed).toHaveLength(2)
      const named = keys.filter((k): k is string => k !== undefined)
      expect(new Set(named).size).toBe(named.length)
      const glyphs = shown.filter((i) => i.glyph)
      expect(glyphs.length).toBeGreaterThan(0)
      expect(glyphs.every((i) => i.key?.startsWith('icon.'))).toBe(true)
      const rows = shown.filter(
        (i) => !i.glyph && i.type !== 'separator' && i.key !== 'menu.change'
      )
      expect(rows.every((i) => i.key?.startsWith('row.'))).toBe(true)
      const hairlines = shown.filter((i) => i.type === 'separator' && i.key)
      expect(hairlines.every((i) => i.key?.startsWith('sep.'))).toBe(true)
      expect(shown.at(-1)).toMatchObject({ label: 'Change Menu', key: 'menu.change' })
      expect(shown.at(-1)!.click).toBeUndefined()
      // Reload and Stop share the row's last slot and its key.
      expect(item(shown, 'Reload').key).toBe('icon.reload')
      // A row that comes and goes on a condition of its own is named where it is built, not by
      // its place in a group: Close Private Tabs is not the private-tab row's second, Dark Theme
      // for This Site not Desktop Site's, so a saved key still names the same row when the
      // other is absent.
      expect(item(shown, 'New Private Tab').key).toBe('row.newPrivateTab')
      expect(item(shown, 'Close Private Tabs').key).toBe('row.closePrivateTabs')
      expect(item(shown, 'Desktop Site').key).toBe('row.desktopSite')
      expect(named.some((k) => /\.\d+$/.test(k) && !k.startsWith('sep.'))).toBe(false)
      // The desktop-shaped menus are not keyed as a whole: under the desktop's capabilities they
      // carry no key at all; where a builder of theirs is shared with the phone branch (the
      // page controls' rows, Add to Home Screen) its items carry the phone's key as an extra
      // property the templates never read – the Android tablet's four – and `menuOrder` moves
      // nothing there: the order is the phone's.
      for (const other of [harness(DESKTOP), harness(DESKTOP, 'tablet')]) {
        appMenu(other)
        expect(keysOf(other.shown()).every((k) => k === undefined)).toBe(true)
      }
      const tablet = harness(ANDROID, 'tablet')
      const plain = appMenu(tablet)
      const tabletKeys = keysOf(tablet.shown()).filter((k): k is string => k !== undefined)
      expect(tabletKeys).toEqual(['row.newPrivateTab', 'row.closePrivateTabs', 'row.desktopSite'])
      tablet.browser.state.settings.menuOrder = [
        'row.desktopSite',
        'row.closePrivateTabs',
        'row.newPrivateTab'
      ]
      expect(appMenu(tablet)).toEqual(plain)
      // The desktop as shipped (site darkening on) carries the darken row's key the same way
      // once the row is live; whatever it carries is a shared row's, and the order moves nothing.
      const desktop = harness({ ...DESKTOP, darkenSites: true })
      const desktopPlain = appMenu(desktop)
      expect(keysOf(desktop.shown()).every((k) => k === undefined || k.startsWith('row.'))).toBe(
        true
      )
      desktop.browser.state.settings.menuOrder = ['row.darkenSite', 'row.newTab']
      expect(appMenu(desktop)).toEqual(desktopPlain)
    })

    it('reads `settings.menuOrder` per section: the named items in the saved order, an item the order never named after its default predecessor, a key the build has no item for dropped, the Change Menu row last whatever the order says', () => {
      const h = harness(ANDROID, 'phone')
      const plain = appMenu(h)
      const defaults = keysOf(h.shown()).filter(
        (k): k is string => k !== undefined && k !== 'menu.change'
      )
      // Saved as the sheet saves – every key shown – while Home was on the bar (absent), with
      // Reload dragged to the row's head, Settings and the fourth hairline's group (Find in
      // Page…'s) to the list's head, and a key of another build's among them.
      const rest = defaults.filter(
        (k) => !['icon.home', 'icon.reload', 'row.settings', 'sep.4'].includes(k)
      )
      h.browser.state.settings.menuOrder = [
        'icon.reload',
        'row.settings',
        'row.readAloud',
        'menu.change',
        'sep.4',
        ...rest
      ]
      const menu = appMenu(h)
      // Reload first; Home – never named – back after Forward, the glyph it follows by default.
      expect(menu.slice(0, 7)).toEqual([
        'Reload',
        'Forward',
        'Home',
        'Bookmark',
        'Download Page',
        'Page Info',
        '-'
      ])
      // Settings, then the fourth hairline, then the default order less the two.
      expect(menu.slice(7, 11)).toEqual(['Settings', '-', 'New Tab', 'New Private Tab'])
      expect(menu.filter((l) => l === 'Settings')).toHaveLength(1)
      expect(menu.filter((l) => l === 'Downloads')).toHaveLength(1)
      expect(menu.at(-2)).toBe('-')
      expect(menu.at(-1)).toBe('Change Menu')
      expect(menu).not.toContain('row.readAloud')
      // The same rows (Settings' hairline, left beside another, tidied away as the core does).
      expect(menu.filter((l) => l !== '-').sort()).toEqual(plain.filter((l) => l !== '-').sort())
    })

    it('saves the order through `settings.update` – sanitised – and the empty list is the Reset: STORED as the setting’s value, the default order back', () => {
      const h = harness(ANDROID, 'phone')
      const before = appMenu(h)
      expect('menuOrder' in h.browser.state.settings).toBe(false)
      h.browser.handleCommand(h.win, 'settings.update', {
        menuOrder: ['row.about', 3, 'row.about', '', 'row.newTab']
      })
      expect(h.browser.state.settings.menuOrder).toEqual(['row.about', 'row.newTab'])
      expect(appMenu(h).slice(7, 9)).toEqual(['About Zenium 1.2.3', 'New Tab'])
      // The Reset keeps the key with the empty list – a value the profile persists and the sync
      // record carries, so the reset reaches the other devices – and the menu is the default.
      h.browser.handleCommand(h.win, 'settings.update', { menuOrder: [] })
      expect(h.browser.state.settings.menuOrder).toEqual([])
      expect(appMenu(h)).toEqual(before)
      // A list with nothing valid in it is the empty list as well.
      h.browser.handleCommand(h.win, 'settings.update', { menuOrder: ['row.about', 'row.newTab'] })
      h.browser.handleCommand(h.win, 'settings.update', { menuOrder: [3, null, ''] })
      expect(h.browser.state.settings.menuOrder).toEqual([])
      expect(appMenu(h)).toEqual(before)
    })

    it('ignores a malformed `menuOrder` patch – anything but a list – rather than reading it as the Reset', () => {
      const h = harness(ANDROID, 'phone')
      h.browser.handleCommand(h.win, 'settings.update', { menuOrder: ['row.about', 'row.newTab'] })
      const saved = appMenu(h)
      for (const bad of ['row.about', 42, null, true, { 0: 'row.about' }]) {
        h.browser.handleCommand(h.win, 'settings.update', { menuOrder: bad })
        expect(h.browser.state.settings.menuOrder).toEqual(['row.about', 'row.newTab'])
      }
      expect(appMenu(h)).toEqual(saved)
    })
  })

  it('on a phone Home is the icon row’s glyph after Forward (SET-36, v2 §9.13), never a text row: gone while Off, and it opens the homepage on the active tab', () => {
    const h = harness(ANDROID, 'phone')
    const active = (): Tab => h.browser.tabs.activeTabFor(h.win)!
    h.browser.handleCommand(h.win, 'urlbar.submit', {
      input: 'https://example.com/a',
      newTab: true,
      background: false
    })
    expect(active().url).toBe('https://example.com/a')
    h.browser.handleCommand(h.win, 'settings.update', {
      homepage: { mode: 'url', url: 'https://news.example/' }
    })
    const items = appMenu(h)
    // In the row's group, second after Forward, before its separator – a button with the bar's
    // own House glyph, not a row among New Tab and New Private Tab.
    expect(items.indexOf('Home')).toBe(items.indexOf('Forward') + 1)
    expect(items.indexOf('Home')).toBeLessThan(items.indexOf('-'))
    const home = item(h.shown(), 'Home')
    expect(home.glyph).toBe('home')
    expect(h.shown().filter((i) => i.label === 'Home')).toHaveLength(1)
    expect(home.enabled).not.toBe(false)
    home.click?.()
    expect(h.viewCalls.at(-1)).toBe('loadURL("https://news.example/")')
    // Off: no glyph, and the desktop's menu never had one.
    h.browser.handleCommand(h.win, 'settings.update', { homepage: { mode: 'off', url: '' } })
    expect(appMenu(h)).not.toContain('Home')
    expect(appMenu(harness(DESKTOP))).not.toContain('Home')
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

  describe('in a private window (profiles-25)', () => {
    const top = (h: Harness, win: ZenWindow): string[] => {
      h.browser.handleCommand(win, 'app.menu', {})
      return topLabels(h.shown())
    }

    it('closes the window group with Close Private Window – the counted verb for more – and carries no note; a regular window’s menu is as it was', () => {
      const h = harness(DESKTOP)
      const priv = h.browser.openWindow('private', h.win)!
      expect(priv.isPrivate).toBe(true)
      const menu = top(h, priv)
      expect(menu.slice(0, 6)).toEqual([
        'New Tab',
        'Search Tabs…',
        'New Window',
        'New Private Window',
        'Close Private Window',
        '-'
      ])
      // No note row says the state: the theme, the sidebar's header and the private new tab
      // page's heading do (§6). One row more than the regular menu, no separator more.
      expect(h.shown().some((i) => i.note)).toBe(false)
      expect(menu.filter((l) => l !== '-')).toHaveLength(19)
      expect(separators(h.shown())).toBe(3)
      // The count is in the verb, Firefox's way: no parentheses (§6).
      h.browser.openWindow('private', h.win)
      const two = top(h, priv)
      expect(two).toContain('Close 2 Private Windows')
      expect(two.some((l) => /Close Private Windows? \(\d+\)/.test(l))).toBe(false)
      // The regular window says nothing of them.
      expect(appMenu(h)).toEqual(DESKTOP_APP_MENU)
    })

    it('keeps the Now Playing… row at the head with the media hub folded: four separators, the window group under it', () => {
      const h = pageHarness(DESKTOP)
      const priv = h.browser.openWindow('private', h.win)!
      const theirs = h.browser.tabs.createTab({ url: 'https://video.example.org/watch' }, priv)
      h.browser.state.media = [
        { tabId: theirs.id, playing: true, title: 'Nocturne', session: true }
      ]
      expect(appMenuFolded(h, priv).slice(0, 3)).toEqual(['Now Playing…', '-', 'New Tab'])
      expect(separators(h.shown())).toBe(4)
    })

    it('Close 2 Private Windows closes every private window – the asking one last – and no other', async () => {
      const h = harness(DESKTOP)
      const first = h.browser.openWindow('private', h.win)!
      const second = h.browser.openWindow('private', h.win)!
      h.browser.handleCommand(first, 'app.menu', {})
      const row = deepItem(h.shown(), 'Close 2 Private Windows')
      expect(row.enabled).not.toBe(false)
      row.click?.()
      await settle()
      expect(second.closeApproved).toBe(true)
      expect(first.closeApproved).toBe(true)
      expect(h.win.closeApproved).toBe(false)
    })
  })

  it('on a phone follows the capabilities, not the platform name', () => {
    // A desktop window narrowed to the phone layout: no Share sheet, but extensions exist.
    const menu = appMenu(harness(DESKTOP, 'phone'))
    expect(menu).not.toContain('Share…')
    expect(menu).toContain('Add-ons and Themes')
    for (const label of DESKTOP_ONLY) if (label !== 'Quit') expect(menu).not.toContain(label)
    // Quit is the host's, not the layout's: an Electron window narrowed to the phone layout still
    // quits the app; an Android app (no windows) is left to the system at every layout.
    expect(menu).toContain('Quit')
    expect(appMenu(harness(ANDROID, 'phone'))).not.toContain('Quit')
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
    expect(allItems((appMenu(h), h.shown())).map((i) => i.label)).not.toContain('Create Shortcut…')
    h.browser.handleCommand(h.win, 'ui.surface', { surface: 'install', mounted: true })
    // In the Save and Share submenu, where Chrome's Save and share carries "Create shortcut…"
    // (shortcuts-menus-120): the row after Save Page As…, and not in More Tools.
    expect(appMenu(h)).toContain('Save and Share > Create Shortcut…')
    expect(appMenu(h)).not.toContain('More Tools > Create Shortcut…')
    expect(appMenu(h).indexOf('Save and Share > Create Shortcut…')).toBe(
      appMenu(h).indexOf('Save and Share > Save Page As') + 1
    )
    h.browser.handleCommand(h.win, 'ui.surface', { surface: 'install', mounted: false })
    expect(appMenu(h)).not.toContain('Save and Share > Create Shortcut…')
    // A window that never registered any surface has none.
    expect(h.win.surfaces.size).toBe(0)
  })

  it('keeps an installed app’s Open in <app> with the window actions in More Tools, not in Save and Share', () => {
    const h = harness(
      { ...DESKTOP, pinShortcuts: true },
      {
        shortcuts: true,
        files: {
          'webapps.json': JSON.stringify({
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
        }
      }
    )
    h.browser.tabs.createTab({ url: 'https://notes.example/today', active: true }, h.win)
    h.browser.handleCommand(h.win, 'ui.surface', { surface: 'install', mounted: true })
    const menu = appMenu(h)
    expect(menu).toContain('More Tools > Open in Notes')
    expect(menu.indexOf('More Tools > Open in Notes')).toBe(menu.indexOf('More Tools') + 1)
    expect(menu).not.toContain('Open in Notes')
    expect(menu).not.toContain('Save and Share > Create Shortcut…')
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
    expect(appMenu(h).slice(-8)).toEqual([
      'Desktop Site',
      'Dark Theme for This Site',
      '-',
      'Settings',
      '-',
      'About Zenium 1.2.3',
      '-',
      'Change Menu'
    ])
  })

  it('leaves the phone layout again when the window widens', () => {
    const h = harness(ANDROID, 'phone')
    expect(appMenu(h)).not.toContain('Quit')
    h.browser.handleCommand(h.win, 'window.formFactor', { formFactor: 'tablet' })
    expect(appMenu(h)).toContain('Help > Keyboard Shortcuts')
  })
})

/** Every item of a template, submenus included. */
function allItems(items: MenuItemTemplate[]): MenuItemTemplate[] {
  return items.flatMap((item) => [item, ...(item.submenu ? allItems(item.submenu) : [])])
}

describe("the phone menu's icon row", () => {
  /**
   * A phone with one loaded web page, its menu open; `row` is the menu's first group and
   * `glyph(name)` the row's button carrying that glyph (the row's order is fixed, but Home
   * comes and goes with the homepage setting, so the tests below name their glyph).
   */
  function phone(
    url = PAGE_URL
  ): PageHarness & { row: () => MenuItemTemplate[]; glyph: (name: MenuGlyph) => MenuItemTemplate } {
    const h = pageHarness(ANDROID, { formFactor: 'phone' })
    if (url !== PAGE_URL) h.browser.tabs.tab(h.tabId)!.url = url
    const row = (): MenuItemTemplate[] => {
      appMenu(h)
      const items = h.shown()
      return items.slice(
        0,
        items.findIndex((item) => item.type === 'separator')
      )
    }
    return {
      ...h,
      row,
      glyph: (name) => {
        const found = row().find((item) => item.glyph === name)
        if (!found) throw new Error(`no ${name} glyph in the row`)
        return found
      }
    }
  }

  it("is Chrome's five plus Home while a homepage is set, in Chrome's order, each naming its glyph, and heads the phone menu alone", () => {
    const h = phone()
    // The default homepage is the new tab page, so Home rides second (SET-36, §9.13).
    expect(h.row().map((item) => [item.label, item.glyph])).toEqual([
      ['Forward', 'forward'],
      ['Home', 'home'],
      ['Bookmark', 'star'],
      ['Download Page', 'download'],
      ['Page Info', 'info'],
      ['Reload', 'reload']
    ])
    // Homepage Off: Chrome's five, Home gone from the row and from the menu.
    h.browser.handleCommand(h.win, 'settings.update', { homepage: { mode: 'off', url: '' } })
    expect(h.row().map((item) => item.label)).toEqual([
      'Forward',
      'Bookmark',
      'Download Page',
      'Page Info',
      'Reload'
    ])
    expect(appMenu(h)).not.toContain('Home')
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
    const shown = h.shown()
    const below = shown.slice(shown.findIndex((item) => item.type === 'separator'))
    expect(allItems(below).every((item) => item.glyph === undefined)).toBe(true)
  })

  it('leaves out an action the bar carries (§9.13: a control lives once), and keeps the two the bar cannot host', () => {
    const h = phone()
    const labels = (): (string | undefined)[] => h.row().map((item) => item.label)
    // Forward and Reload / Stop moved onto the bar: the row is the other four, in its order.
    h.browser.handleCommand(h.win, 'settings.update', {
      phoneBar: { left: ['back', 'forward'], right: ['reload', 'tabs', 'menu'] }
    })
    expect(labels()).toEqual(['Home', 'Bookmark', 'Download Page', 'Page Info'])
    // Stop shares Reload's slot, so it leaves with it while the page loads.
    h.browser.tabs.tab(h.tabId)!.loading = true
    expect(labels()).toEqual(['Home', 'Bookmark', 'Download Page', 'Page Info'])
    h.browser.tabs.tab(h.tabId)!.loading = false
    // The bar holding all four: Download Page and Page Info stand alone, still a row of glyphs.
    h.browser.handleCommand(h.win, 'settings.update', {
      phoneBar: { left: ['back', 'forward', 'home'], right: ['bookmark', 'reload', 'menu'] }
    })
    expect(h.row().map((item) => [item.label, item.glyph])).toEqual([
      ['Download Page', 'download'],
      ['Page Info', 'info']
    ])
    // Home on the bar and the homepage Off: no Home anywhere, the bar's and the row's agreeing.
    h.browser.handleCommand(h.win, 'settings.update', { homepage: { mode: 'off', url: '' } })
    expect(appMenu(h)).not.toContain('Home')
    // The bar back to its default: the six return.
    h.browser.handleCommand(h.win, 'settings.update', {
      homepage: { mode: 'newtab', url: '' },
      phoneBar: { left: ['back'], right: ['new-tab', 'tabs', 'menu'] }
    })
    expect(labels()).toEqual([
      'Forward',
      'Home',
      'Bookmark',
      'Download Page',
      'Page Info',
      'Reload'
    ])
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
    const star = (): MenuItemTemplate => h.glyph('star')
    const serialisedStar = (): unknown => {
      appMenu(h)
      const items = h.shown()
      return serialiseMenu(items, 'm').items[items.findIndex((item) => item.glyph === 'star')]
    }
    expect(star()).toMatchObject({
      label: 'Bookmark',
      checked: false,
      enabled: true
    })
    // A stateful glyph, not a toggle (§9.13): a plain item whose `checked` is the fill – never a
    // checkbox, which the mouse popover would tick. The chrome gets `checked` either way.
    expect(star().type).toBeUndefined()
    expect(serialisedStar()).toMatchObject({ type: 'normal', checked: false })
    const flow = vi.spyOn(h.browser, 'starTab')
    star().click?.()
    expect(flow).toHaveBeenCalledWith(h.tabId, h.win)
    // The star flow saved the page: the row's star is filled now and a press edits.
    expect(h.browser.tabs.tab(h.tabId)!.bookmarked).toBe(true)
    expect(star()).toMatchObject({ label: 'Edit Bookmark', checked: true, enabled: true })
    expect(serialisedStar()).toMatchObject({ type: 'normal', checked: true })
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
    expect(blank.glyph('star')).toMatchObject({ label: 'Bookmark', enabled: false })
  })

  it('Download Page saves a web page through page.savePage and is off elsewhere; it is the phone menu’s one save entry', () => {
    const h = phone()
    expect(h.glyph('download')).toMatchObject({ label: 'Download Page', enabled: true })
    const run = vi.spyOn(h.browser.actions, 'run').mockImplementation(() => undefined)
    h.glyph('download').click?.()
    expect(run).toHaveBeenCalledWith('page.savePage', { sourceTabId: h.tabId, win: h.win })
    expect(phone('zen://settings').glyph('download')).toMatchObject({ enabled: false })
    expect(phone('zen://blank').glyph('download')).toMatchObject({ enabled: false })
    // Chrome's phone menu saves through the icon alone: the text row is the desktop's, so the
    // same command is not offered twice (once gated to the web, once not).
    appMenu(h)
    expect(allItems(h.shown()).filter((item) => item.action === 'page.savePage')).toHaveLength(1)
    expect(appMenu(h)).not.toContain('Save Page As…')
    expect(appMenu(h)).not.toContain('Save Page As')
    expect(appMenu(harness(DESKTOP))).toContain('Save and Share > Save Page As')
    expect(appMenu(harness(ANDROID, 'tablet'))).toContain('Save and Share > Save Page As…')
  })

  it('Page Info asks the chrome for the site information sheet, and is off where there is no site', () => {
    const h = phone()
    expect(h.glyph('info')).toMatchObject({ label: 'Page Info', enabled: true })
    h.sent.length = 0
    h.glyph('info').click?.()
    expect(h.sent).toEqual(['siteInfo.open'])
    // No site: a blank or new tab, a registered internal page; a site's error page keeps it.
    expect(phone('zen://blank').glyph('info')).toMatchObject({ enabled: false })
    expect(phone('zen://newtab').glyph('info')).toMatchObject({ enabled: false })
    expect(phone('zen://settings/privacy').glyph('info')).toMatchObject({ enabled: false })
    expect(hasSiteInfo({ url: 'zen://error?url=https%3A%2F%2Fexample.com' })).toBe(true)
    expect(hasSiteInfo({ url: 'file:///sdcard/page.html' })).toBe(true)
    expect(hasSiteInfo({ url: 'zen://settings' })).toBe(false)
  })

  it('Reload is Stop while the page loads, each running its own command', () => {
    const h = phone()
    const last = (): MenuItemTemplate => h.row().at(-1)!
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
      'Web Capture…',
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

  it('on the new tab page leads with the page’s own rows (NTP-18, NTP-22): Hide Greeting / Hide Shortcuts for the sections it shows, Restore Default Shortcuts with the grid, Customise New Tab Page…', () => {
    const h = harness(DESKTOP)
    h.browser.handleCommand(h.win, 'settings.update', { newTab: { preset: 'inspirational' } })
    h.browser.handleCommand(h.win, 'newtab.open', undefined)
    const tab = h.browser.tabs.activeTabFor(h.win)!
    const menu = (): string[] => {
      h.browser.menus.showPageContextMenu(tab.id, pageParams(), h.win)
      return topLabels(h.shown())
    }
    expect(menu().slice(0, 5)).toEqual([
      'Hide Greeting',
      'Hide Shortcuts',
      'Restore Default Shortcuts',
      'Customise New Tab Page…',
      '-'
    ])
    // A fresh profile's grid: the restore has nothing to do and its row is greyed.
    expect(item(h.shown(), 'Restore Default Shortcuts').enabled).toBe(false)
    const commands: unknown[] = []
    h.browser.tabs.view(tab.id)!.sendNewTabCommand = (c) => {
      commands.push(c)
    }
    // A pinned shortcut enables the row; the row restores through the model and raises the
    // page's toast (Undo alone, §9.33) in place of a confirmation – the toast's link is gone.
    h.browser.newTab.addShortcut('Docs', 'docs.example')
    menu()
    expect(item(h.shown(), 'Restore Default Shortcuts').enabled).toBe(true)
    item(h.shown(), 'Restore Default Shortcuts').click?.()
    expect(h.browser.state.newTabDevice.shortcuts).toEqual([])
    expect(commands).toEqual([{ type: 'defaults-restored' }])
    menu()
    expect(item(h.shown(), 'Restore Default Shortcuts').enabled).toBe(false)
    commands.length = 0
    item(h.shown(), 'Hide Greeting').click?.()
    expect(h.browser.state.settings.newTab).toMatchObject({ modules: { greeting: false } })
    expect(commands).toEqual([{ type: 'section-hidden', section: 'greeting' }])
    // A hidden section has no row – the grid's restore goes with the grid; a page with neither
    // section shows only the way to Customise.
    expect(menu().slice(0, 4)).toEqual([
      'Hide Shortcuts',
      'Restore Default Shortcuts',
      'Customise New Tab Page…',
      '-'
    ])
    item(h.shown(), 'Hide Shortcuts').click?.()
    expect(menu().slice(0, 2)).toEqual(['Customise New Tab Page…', '-'])
    // The private page has neither section and no rows of its own.
    const priv = h.browser.openWindow('private')!
    const privTab = h.browser.tabs.activeTabFor(priv)!
    h.browser.menus.showPageContextMenu(privTab.id, pageParams(), priv)
    expect(topLabels(h.shown())[0]).toBe('Back')
    // A web page keeps Chrome's groups alone.
    const page = pageHarness()
    expect(page.menu(pageParams())[0]).toBe('Back')
  })

  it('says capture once on the desktop – one Web Capture… row with its chord, where the menu said it three times (the #396 review’s ruling 3, the lead on #414); a touch host keeps its two one-shot rows', () => {
    const h = pageHarness()
    const menu = h.menu(pageParams())
    // One row, between Print… and Reader View, where the three stood.
    expect(menu.filter((l) => /capture|screenshot/i.test(l))).toEqual(['Web Capture…'])
    expect(menu.indexOf('Web Capture…')).toBe(menu.indexOf('Print…') + 1)
    expect(menu[menu.indexOf('Web Capture…') + 1]).toBe('Enter Reader View')
    const row = item(h.items(), 'Web Capture…')
    // Edge's row runs the overlay – the visible area, the full page and an area select are its
    // toolbar's – and wears the Chrome preset's chord (Edge's Web capture chord).
    expect(row.action).toBe('capture.start')
    expect(row.accelerator).toBe('Ctrl+Shift+S')
    expect(row.hint).toBe('Ctrl+Shift+S')
    h.viewCalls.length = 0
    h.sent.length = 0
    row.click?.()
    expect(h.sent).toContain('capture.start')
    // The Zen preset gives Ctrl+Shift+S to Firefox's Take Screenshot: the row stands, unchorded.
    h.browser.handleCommand(h.win, 'settings.update', { shortcutPreset: 'zen' })
    h.menu(pageParams())
    expect(item(h.items(), 'Web Capture…').accelerator).toBeUndefined()
    // A tablet's page menu has no overlay to open: Take Screenshot and Capture Full Page stay,
    // in the same seat, running their one-shot actions.
    const tablet = pageHarness(DESKTOP, { formFactor: 'tablet' })
    const tabletMenu = tablet.menu(pageParams())
    expect(tabletMenu).not.toContain('Web Capture…')
    expect(tabletMenu).not.toContain('Capture Page…')
    expect(tabletMenu.indexOf('Take Screenshot')).toBe(tabletMenu.indexOf('Print…') + 1)
    expect(tabletMenu.indexOf('Capture Full Page')).toBe(tabletMenu.indexOf('Take Screenshot') + 1)
    expect(item(tablet.items(), 'Take Screenshot').action).toBe('page.screenshot')
    expect(item(tablet.items(), 'Capture Full Page').action).toBe('page.captureFullPage')
    const phone = pageHarness(ANDROID, { formFactor: 'phone' })
    const phoneMenu = phone.menu(pageParams())
    expect(phoneMenu).toContain('Take Screenshot')
    expect(phoneMenu).not.toContain('Web Capture…')
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

  it('inspects the clicked node, not the document corner, at the remembered dock (§9.29)', () => {
    const h = pageHarness()
    h.menu(pageParams({ x: 333, y: 44 }))
    h.click('Inspect Element')
    expect(h.viewCalls).toEqual(['inspectElementAt(333,44,"bottom")'])
    h.browser.updateSettings({ devtoolsDock: 'right' }, h.win)
    h.viewCalls.length = 0
    h.menu(pageParams({ x: 1, y: 2 }))
    h.click('Inspect Element')
    expect(h.viewCalls).toEqual(['inspectElementAt(1,2,"right")'])
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
      'Add Link to Reading List',
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

  it('on the phone hands a tel: link to the dialer, the messaging app and the contacts form, and a mailto: link to the mail app (PUI-22)', () => {
    const h = pageHarness(ANDROID, { formFactor: 'phone', linkApps: true })
    expect(h.menu(pageParams({ linkURL: 'tel:+1-555-0100' }))).toEqual([
      'Call',
      'Send Message',
      'Add to Contacts',
      '-',
      'Copy Phone Number',
      '-',
      'Boosts'
    ])
    h.click('Call')
    h.click('Send Message')
    h.click('Add to Contacts')
    expect(h.linkApps).toEqual([
      'call tel:+1-555-0100',
      'message tel:+1-555-0100',
      'addContact tel:+1-555-0100'
    ])
    const mail = h.menu(
      pageParams({ linkURL: 'mailto:hello@example.com?subject=Hi', linkText: 'Write to us' })
    )
    expect(mail).toEqual(['Send Email', '-', 'Copy Email Address', 'Copy Link Text', '-', 'Boosts'])
    h.click('Send Email')
    expect(h.linkApps.at(-1)).toBe('email mailto:hello@example.com?subject=Hi')
    // A phone whose host has no such apps, and every other form factor, keep Chrome desktop's
    // copy items alone; a web link gains nothing.
    expect(
      pageHarness(ANDROID, { formFactor: 'phone' }).menu(
        pageParams({ linkURL: 'tel:+1-555-0100' })
      )[0]
    ).toBe('Copy Phone Number')
    expect(
      pageHarness(ANDROID, { formFactor: 'tablet', linkApps: true }).menu(
        pageParams({ linkURL: 'tel:+1-555-0100' })
      )[0]
    ).toBe('Copy Phone Number')
    expect(h.menu(pageParams({ linkURL: 'https://example.org/next' }))).not.toContain('Call')
  })

  it('opens the phone’s link and image menus on a header naming what was held (PUI-18); the desktop’s and the tablet’s carry none', () => {
    const h = pageHarness(ANDROID, { formFactor: 'phone' })
    h.browser.tabs.tab(h.tabId)!.favicon = 'data:image/png;base64,TAB'
    // A link within the tab's site: its text over its address, the tab's own favicon.
    h.menu(pageParams({ linkURL: `${PAGE_URL}next`, linkText: 'Next page' }))
    expect(h.where()?.header).toEqual({
      url: `${PAGE_URL}next`,
      copied: 'Link copied',
      title: 'Next page',
      favicon: 'data:image/png;base64,TAB',
      thumbnail: null,
      scheme: null
    })
    // A link without text names its host; another site's favicon comes from history's cache.
    h.menu(pageParams({ linkURL: 'https://other.example/a/b' }))
    expect(h.where()?.header).toMatchObject({
      url: 'https://other.example/a/b',
      title: 'other.example',
      favicon: null
    })
    h.browser.history.visit('https://other.example/', 'Other', 'data:image/png;base64,OTHER')
    h.menu(pageParams({ linkURL: 'https://www.other.example/a/b' }))
    expect(h.where()?.header?.favicon).toBe('data:image/png;base64,OTHER')
    // An image is its own thumbnail; a linked image keeps the link's address.
    h.menu(pageParams({ mediaType: 'image', srcURL: 'https://example.com/a.png' }))
    expect(h.where()?.header).toMatchObject({
      url: 'https://example.com/a.png',
      title: 'example.com',
      favicon: null,
      thumbnail: 'https://example.com/a.png',
      scheme: null
    })
    h.menu(
      pageParams({
        linkURL: 'https://example.com/gallery',
        mediaType: 'image',
        srcURL: 'https://example.com/a.png'
      })
    )
    expect(h.where()?.header).toMatchObject({
      url: 'https://example.com/gallery',
      thumbnail: 'https://example.com/a.png'
    })
    // A number or an address shows bare, as its copy item copies it, under the scheme's name,
    // with the scheme for the glyph in the favicon's place (§9.31).
    h.menu(pageParams({ linkURL: 'tel:+1-555-0100' }))
    expect(h.where()?.header).toEqual({
      url: '+1-555-0100',
      copied: 'Phone number copied',
      title: 'Phone number',
      favicon: null,
      thumbnail: null,
      scheme: 'tel'
    })
    h.menu(pageParams({ linkURL: 'mailto:hello@example.com?subject=Hi', linkText: 'Write to us' }))
    expect(h.where()?.header).toMatchObject({
      url: 'hello@example.com',
      copied: 'Email address copied',
      title: 'Write to us',
      favicon: null,
      scheme: 'mailto'
    })
    // The plain page opens on its title; a javascript: link is no link.
    h.menu(pageParams())
    expect(h.where()?.header).toBeUndefined()
    h.menu(pageParams({ linkURL: 'javascript:void(0)' }))
    expect(h.where()?.header).toBeUndefined()
    const tablet = pageHarness(ANDROID, { formFactor: 'tablet' })
    tablet.menu(pageParams({ linkURL: 'https://other.example/a/b' }))
    expect(tablet.where()?.header).toBeUndefined()
    const desktop = pageHarness()
    desktop.menu(pageParams({ linkURL: 'https://other.example/a/b' }))
    expect(desktop.where()?.header).toBeUndefined()
  })

  it('lists the image items in Chrome’s order and saves through the dialog', () => {
    const h = pageHarness()
    const menu = h.menu(pageParams({ mediaType: 'image', srcURL: 'https://example.com/a.png' }))
    expect(menu).toEqual([
      'Open Image in New Tab',
      'Save Image As…',
      'Copy Image',
      'Copy Image Address',
      'Search Image with Google Lens',
      '-',
      'Boosts',
      'Inspect Element'
    ])
    h.click('Save Image As…')
    expect(h.viewCalls).toEqual(['downloadURL("https://example.com/a.png",{"saveAs":true})'])
  })

  describe('Search Image with <engine> (CT-32)', () => {
    const IMAGE = 'https://example.com/pics/a b.png?size=large&v=2'
    const imageMenu = (h: ReturnType<typeof pageHarness>, src: string): string[] =>
      h.menu(pageParams({ mediaType: 'image', srcURL: src }))

    const hasRow = (menu: string[]): boolean =>
      menu.some((label) => label.startsWith('Search Image with'))
    /** An engine of the user's that defines an image search of its own (Chrome's `image_url`). */
    const YANDEX = {
      id: 'custom:yandex',
      name: 'Yandex',
      searchUrl: 'https://yandex.com/search/?text=%s',
      suggestUrl: null,
      keyword: '@yandex',
      glyph: 'Y',
      source: 'custom' as const,
      imageSearch: { name: 'Yandex', url: 'https://yandex.com/images/search?rpt=imageview&url=%s' }
    }

    it('names Google Lens for Google', () => {
      expect(imageMenu(pageHarness(), IMAGE)).toContain('Search Image with Google Lens')
    })

    it('names Bing for Bing', () => {
      const h = pageHarness()
      h.browser.handleCommand(h.win, 'settings.update', { searchEngineId: 'bing' })
      expect(imageMenu(h, IMAGE)).toContain('Search Image with Bing')
      expect(imageMenu(h, IMAGE)).not.toContain('Search Image with Google Lens')
    })

    it('names the product of an engine of the user’s that defines an image search', () => {
      const h = pageHarness()
      h.browser.handleCommand(h.win, 'settings.update', {
        searchEngines: [YANDEX],
        searchEngineId: YANDEX.id
      })
      expect(imageMenu(h, IMAGE)).toContain('Search Image with Yandex')
      h.click('Search Image with Yandex')
      const tabIds = h.win.activeSpace().tabIds
      expect(h.browser.tabs.tab(tabIds[tabIds.indexOf(h.tabId) + 1] ?? '')?.url).toBe(
        `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(IMAGE)}`
      )
    })

    it.each(['duckduckgo', 'ecosia', 'wikipedia'])(
      'has no row for %s, which defines no image search (Chrome shows none either)',
      (id) => {
        const h = pageHarness()
        h.browser.handleCommand(h.win, 'settings.update', { searchEngineId: id })
        expect(hasRow(imageMenu(h, IMAGE))).toBe(false)
      }
    )

    it('has no row for a hand-added engine, which defines none', () => {
      const h = pageHarness()
      const id = h.browser.handleCommand(h.win, 'search.addEngine', {
        name: 'Kagi',
        url: 'https://kagi.com/search?q=%s'
      }) as string
      h.browser.handleCommand(h.win, 'settings.update', { searchEngineId: id })
      expect(h.browser.state.defaultSearchEngine().id).toBe(id)
      expect(hasRow(imageMenu(h, IMAGE))).toBe(false)
    })

    it.each([
      ['a data: image', 'data:image/png;base64,iVBORw0KGgo='],
      ['a blob: image', 'blob:https://example.com/1d2c3b4a'],
      ['a file', 'file:///home/me/a.png'],
      ['an extension resource', 'chrome-extension://abcdef/icon.png'],
      ['a blank source', '']
    ])('has no row for %s', (_name, src) => {
      const h = pageHarness()
      // A blank source is no image at all; the others are images no engine can fetch.
      const menu = h.menu(pageParams({ mediaType: 'image', srcURL: src }))
      expect(menu.some((label) => label.startsWith('Search Image with'))).toBe(false)
    })

    it('opens the engine’s lookup of the address in a tab beside this one, in front, with this tab as the opener', () => {
      const h = pageHarness()
      imageMenu(h, IMAGE)
      h.click('Search Image with Google Lens')
      const tabIds = h.win.activeSpace().tabIds
      const opened = h.browser.tabs.tab(tabIds[tabIds.indexOf(h.tabId) + 1] ?? '')
      expect(opened?.url).toBe(
        `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(IMAGE)}`
      )
      expect(opened?.openerTabId).toBe(h.tabId)
      expect(h.browser.tabs.activeTabFor(h.win)?.id).toBe(opened?.id)
      h.browser.handleCommand(h.win, 'settings.update', { searchEngineId: 'bing' })
      h.browser.tabs.activateTab(h.tabId, h.win)
      imageMenu(h, IMAGE)
      h.click('Search Image with Bing')
      const ids = h.win.activeSpace().tabIds
      expect(h.browser.tabs.tab(ids[ids.indexOf(h.tabId) + 1] ?? '')?.url).toBe(
        `https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:${encodeURIComponent(IMAGE)}`
      )
    })

    it('reaches the phone’s image sheet through the same template: after Copy Image Address, before Share Image…', () => {
      const h = pageHarness(ANDROID, { formFactor: 'phone' })
      const menu = imageMenu(h, IMAGE)
      expect(menu.indexOf('Search Image with Google Lens')).toBe(
        menu.indexOf('Copy Image Address') + 1
      )
      expect(menu.indexOf('Share Image…')).toBe(menu.indexOf('Search Image with Google Lens') + 1)
      expect(imageMenu(h, 'data:image/gif;base64,R0lGOD')).not.toContain(
        'Search Image with Google Lens'
      )
      // Bing as the engine: its own product, in the same seat.
      h.browser.handleCommand(h.win, 'settings.update', { searchEngineId: 'bing' })
      const bing = imageMenu(h, IMAGE)
      expect(bing.indexOf('Search Image with Bing')).toBe(bing.indexOf('Copy Image Address') + 1)
      expect(bing.indexOf('Share Image…')).toBe(bing.indexOf('Search Image with Bing') + 1)
    })

    it('has no row for a DuckDuckGo default on either host', () => {
      for (const h of [pageHarness(), pageHarness(ANDROID, { formFactor: 'phone' })]) {
        h.browser.handleCommand(h.win, 'settings.update', { searchEngineId: 'duckduckgo' })
        const menu = imageMenu(h, IMAGE)
        expect(hasRow(menu)).toBe(false)
        expect(menu).toContain('Copy Image Address')
      }
    })
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
      'Copy Link to Highlight',
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
    expect(h.menu(pageParams({ selectionText: 'quantum foam' })).slice(0, 5)).toEqual([
      'Copy',
      'Search Google for “quantum foam”',
      'Copy Link to Highlight',
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
    // A tablet is a touch layout: its menu and bar list Listen too, and its item reads on from
    // the selection as every layout's does (#266).
    const tablet = pageHarness(
      { ...ANDROID, readAloud: true },
      { formFactor: 'tablet', speech: true }
    )
    expect(tablet.menu(pageParams({ selectionText: 'quantum foam' }))).toContain('Listen')
    expect(
      tablet.browser.menus.selectionToolbar(tablet.tabId, 'quantum foam').map((a) => a.id)
    ).toContain('readAloud')
    tablet.viewCalls.length = 0
    tablet.click('Listen')
    await settle()
    expect(
      tablet.viewCalls.some(
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

  it('Share hands the text and its link to the highlight to the host sheet, and an id the text does not warrant does nothing', async () => {
    const shared: SharePayload[] = []
    const h = pageHarness(ANDROID, PHONE)
    h.browser.platform.shell.share = (payload): Promise<void> => {
      shared.push(payload)
      return Promise.resolve()
    }
    h.viewCalls.length = 0
    expect(h.browser.menus.runSelectionAction(h.tabId, 'share', 'quantum foam')).toBe(true)
    // The core asks the page for the selection's text directive first (SH-11) and shares once
    // it has answered: the text, and the page's URL with the directive as its fragment directive.
    const id = answerTextFragment(h, 'text=quantum%20foam')
    expect(id).toBeTruthy()
    await settle()
    expect(shared).toEqual([
      {
        text: 'quantum foam',
        url: 'https://example.com/article#:~:text=quantum%20foam',
        tabId: h.tabId
      }
    ])
    // A menu-only action, a toolbar action the text no longer warrants, an unknown id.
    expect(h.browser.menus.runSelectionAction(h.tabId, 'go', 'example.org/docs')).toBe(false)
    expect(h.browser.menus.runSelectionAction(h.tabId, 'glance', 'quantum foam')).toBe(false)
    expect(h.browser.menus.runSelectionAction(h.tabId, 'define', 'quantum foam')).toBe(false)
    expect(h.browser.menus.runSelectionAction(h.tabId, 'share', '   ')).toBe(false)
    expect(shared.length).toBe(1)
    expect(h.win.glance).toBeNull()
    expect(h.win.activeSpace().tabIds.length).toBe(1)
  })

  it('Share hands the text alone when the page cannot make a directive for the selection', async () => {
    const shared: SharePayload[] = []
    const h = pageHarness(ANDROID, PHONE)
    h.browser.platform.shell.share = (payload): Promise<void> => {
      shared.push(payload)
      return Promise.resolve()
    }
    h.viewCalls.length = 0
    expect(h.browser.menus.runSelectionAction(h.tabId, 'share', 'quantum foam')).toBe(true)
    expect(answerTextFragment(h, null)).toBeTruthy()
    await settle()
    expect(shared).toEqual([{ text: 'quantum foam', url: undefined, tabId: h.tabId }])
  })

  it('Copy Link to Highlight copies the page URL with the text directive, and says so when the page cannot make one', async () => {
    const h = pageHarness(ANDROID, PHONE)
    let copied = ''
    h.browser.platform.clipboard.writeText = (text: string) => void (copied = text)
    h.menu(pageParams({ selectionText: 'quantum foam' }))
    h.viewCalls.length = 0
    h.click('Copy Link to Highlight')
    expect(answerTextFragment(h, 'text=quantum%20foam')).toBeTruthy()
    await settle()
    expect(copied).toBe('https://example.com/article#:~:text=quantum%20foam')
    // The page's URL keeps its own fragment; the directive rides behind `:~:`.
    h.browser.tabs.tab(h.tabId)!.url = 'https://example.com/article#intro'
    h.menu(pageParams({ selectionText: 'quantum foam' }))
    h.viewCalls.length = 0
    h.click('Copy Link to Highlight')
    expect(answerTextFragment(h, 'text=quantum%20foam')).toBeTruthy()
    await settle()
    expect(copied).toBe('https://example.com/article#intro:~:text=quantum%20foam')
    // Nothing to link to: the clipboard is left alone and the window hears a toast.
    copied = ''
    h.menu(pageParams({ selectionText: 'quantum foam' }))
    h.viewCalls.length = 0
    h.sent.length = 0
    h.click('Copy Link to Highlight')
    expect(answerTextFragment(h, null)).toBeTruthy()
    await settle()
    expect(copied).toBe('')
    expect(h.sent).toContain('toast')
    // A `zen://` page has no highlight anyone could follow: no item.
    h.browser.tabs.tab(h.tabId)!.url = 'zen://settings'
    expect(h.menu(pageParams({ selectionText: 'quantum foam' }))).not.toContain(
      'Copy Link to Highlight'
    )
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
    expect(h.menu(pageParams({ selectionText: 'quantum foam' })).slice(0, 5)).toEqual([
      'Copy',
      'Search Google for “quantum foam”',
      'Copy Link to Highlight',
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

describe("the phone's new tab tile menu (NTP-06)", () => {
  const tileMenu = (h: PageHarness, url: string, title: string): string[] => {
    h.browser.handleCommand(h.win, 'newtab.tileContextMenu', { url, title, tabId: h.tabId })
    return topLabels(h.shown())
  }

  it('a pinned tile: Open in New Tab, Copy Link, then Edit Shortcut…, Move Left, Move Right, Unpin Shortcut and Remove', () => {
    const h = pageHarness(ANDROID, { formFactor: 'phone' })
    const id = h.browser.newTab.addShortcut('Docs', 'https://docs.example/')!
    expect(tileMenu(h, 'https://docs.example/', 'Docs')).toEqual([
      'Open in New Tab',
      'Copy Link',
      '-',
      'Edit Shortcut…',
      'Move Left',
      'Move Right',
      'Unpin Shortcut',
      'Remove'
    ])
    // Edit opens the shortcut's form sheet over the page the tile was held on.
    h.sent.length = 0
    h.click('Edit Shortcut…')
    expect(h.sent).toContain('newtab.shortcutDialog')
    // Unpin takes the tile off the pinned list; Remove hides its host from the page as well.
    h.click('Unpin Shortcut')
    expect(h.browser.state.newTabDevice.shortcuts.find((s) => s.id === id)).toBeUndefined()
  })

  it('Move Left / Move Right step a pinned tile one slot along the grid – the drag’s accessible path – and are greyed at the ends (§9.17)', () => {
    const h = pageHarness(ANDROID, { formFactor: 'phone' })
    const a = h.browser.newTab.addShortcut('A', 'https://a.example/')!
    const b = h.browser.newTab.addShortcut('B', 'https://b.example/')!
    const c = h.browser.newTab.addShortcut('C', 'https://c.example/')!
    const order = (): string[] => h.browser.state.newTabDevice.shortcuts.map((s) => s.id)
    const move = (url: string, label: string): MenuItemTemplate => {
      tileMenu(h, url, '')
      return item(h.shown(), label)
    }
    // At the start Move Left is off, Move Right steps the tile past its neighbour.
    expect(move('https://a.example/', 'Move Left').enabled).toBe(false)
    expect(move('https://a.example/', 'Move Right').enabled).toBe(true)
    move('https://a.example/', 'Move Right').click?.()
    expect(order()).toEqual([b, a, c])
    // In the middle both are on; at the end Move Right is off.
    expect(move('https://a.example/', 'Move Left').enabled).toBe(true)
    move('https://a.example/', 'Move Right').click?.()
    expect(order()).toEqual([b, c, a])
    expect(move('https://a.example/', 'Move Right').enabled).toBe(false)
    move('https://a.example/', 'Move Left').click?.()
    expect(order()).toEqual([b, a, c])
    // A most visited tile is not a slot: no Move rows for it.
    expect(tileMenu(h, 'https://often.example/', 'Often')).not.toContain('Move Left')
  })

  it('a most visited tile has no edit – it is the history’s – and offers Pin instead', () => {
    const h = pageHarness(ANDROID, { formFactor: 'phone' })
    expect(tileMenu(h, 'https://often.example/', 'Often')).toEqual([
      'Open in New Tab',
      'Copy Link',
      '-',
      'Pin Shortcut',
      'Remove'
    ])
    h.click('Pin Shortcut')
    expect(h.browser.state.newTabDevice.shortcuts.map((s) => s.url)).toEqual([
      'https://often.example/'
    ])
    h.click('Remove')
    expect(h.browser.state.newTabDevice.hiddenHosts).toContain('often.example')
  })
})

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
  it('serialiseMenu carries an item’s shortcut action to the renderer, and no key for an item without one', () => {
    const { items } = serialiseMenu(
      [
        { label: 'Reader View', action: 'page.readerMode', click: () => undefined },
        { label: 'Text Preferences…', click: () => undefined }
      ],
      'm'
    )
    // The chrome recognises the row by what it does (the phone's reader crossing, MOT-36).
    expect(items[0]).toMatchObject({ label: 'Reader View', action: 'page.readerMode' })
    expect('action' in items[1]!).toBe(false)
  })

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
// The History page's row menu (v2 §10.1: selection is a mode the menu can enter)
// ---------------------------------------------------------------------------

describe('the history row menu', () => {
  it('offers Select between the copy and the removals, and Select asks the page to pick the row', () => {
    const h = harness(DESKTOP)
    h.browser.handleCommand(h.win, 'history.contextMenu', {
      visitId: 'v1',
      url: 'https://example.com/docs'
    })
    expect(labels(h.shown())).toEqual([
      'Open in New Tab',
      'Open in New Window',
      'Open in New Private Window',
      '-',
      'Copy Link',
      '-',
      'Select',
      'Remove from History',
      'Forget About This Page',
      '-',
      'More from This Site'
    ])
    h.sent.length = 0
    h.shown().find((item) => item.label === 'Select')!.click!()
    expect(h.sent).toEqual(['history.select'])
  })

  it('a row that names no visit – a tab from another device – keeps the page’s items and drops the visit’s', () => {
    const h = harness(DESKTOP)
    h.browser.handleCommand(h.win, 'history.contextMenu', {
      visitId: null,
      url: 'https://example.com/docs'
    })
    expect(labels(h.shown())).toEqual([
      'Open in New Tab',
      'Open in New Window',
      'Open in New Private Window',
      '-',
      'Copy Link',
      '-',
      'More from This Site'
    ])
    const before = Object.keys(h.browser.state.model.tabs).length
    h.shown().find((item) => item.label === 'Open in New Tab')!.click!()
    expect(Object.keys(h.browser.state.model.tabs).length).toBe(before + 1)
  })
})

// ---------------------------------------------------------------------------
// The URL bar popup's suggestion row menu (context-menus-115)
// ---------------------------------------------------------------------------

describe('the suggestion row menu', () => {
  it('offers Remove on a removable row, opening where the row’s right-click said, and Remove goes back to the bar as its pick', () => {
    const h = harness(DESKTOP)
    h.browser.handleCommand(h.win, 'urlbar.suggestionContextMenu', {
      id: 'hist:https://example.com/docs',
      kind: 'history',
      x: 640,
      y: 212
    })
    expect(labels(h.shown())).toEqual(['Remove'])
    expect(h.where()).toMatchObject({ source: 'urlbar', x: 640, y: 212 })
    expect(h.where()).not.toHaveProperty('keyboard')
    h.sent.length = 0
    h.shown()[0].click!()
    expect(h.sent).toEqual(['urlbar.suggestionAction'])
  })

  it('a remembered search adds Delete Search History, whose pick goes back the same way; the keyboard’s anchor passes through', () => {
    const h = harness(DESKTOP)
    h.browser.handleCommand(h.win, 'urlbar.suggestionContextMenu', {
      id: 'recent:https://www.google.com/search?q=cats',
      kind: 'search',
      x: 640,
      y: 262,
      keyboard: true
    })
    expect(labels(h.shown())).toEqual(['Remove', 'Delete Search History'])
    expect(h.where()).toMatchObject({ source: 'urlbar', x: 640, y: 262, keyboard: true })
    h.sent.length = 0
    h.shown()[1].click!()
    expect(h.sent).toEqual(['urlbar.suggestionAction'])
    // Nothing is forgotten by the menu itself: the bar acts on the pick through the core's
    // removes, Delete Search History being `urlbar.clearSearchHistory`.
    const shortcuts = h.browser.omniboxShortcuts
    shortcuts.learn('cat', {
      url: 'https://www.google.com/search?q=cats',
      title: 'cats',
      kind: 'search',
      engineId: 'google'
    })
    shortcuts.learn('gm', { url: 'https://mail.google.com/', title: 'Gmail', kind: 'url' })
    expect(shortcuts.all()).toHaveLength(2)
    h.browser.handleCommand(h.win, 'urlbar.clearSearchHistory', undefined)
    expect(shortcuts.all().map((s) => s.kind)).toEqual(['url'])
  })

  it('the other kinds get Remove alone: a page, an extension’s row', () => {
    const h = harness(DESKTOP)
    for (const kind of ['url', 'omnibox'] as const) {
      h.browser.handleCommand(h.win, 'urlbar.suggestionContextMenu', { id: `${kind}:1`, kind })
      expect(labels(h.shown())).toEqual(['Remove'])
    }
    // No anchor given: the host opens the menu at the pointer.
    expect(h.where()).not.toHaveProperty('x')
  })
})

// ---------------------------------------------------------------------------
// The History page's device heading menu (history-21; the lead's #326 ruling)
// ---------------------------------------------------------------------------

describe('the history device heading menu', () => {
  /** A remote tab as the engine lists one. */
  const remote = (tabId: string, url: string): SyncRemoteTab => ({
    tabId,
    url,
    title: url,
    favicon: null,
    lastActive: 1,
    windowId: null
  })
  /** The phone's list, newest activity first, as `sync.tabsFromDevices` answers. */
  const phone = (tabs: SyncRemoteTab[]): SyncDeviceTabs => ({
    deviceId: 'phone',
    deviceName: 'Pixel 9',
    updatedAt: 1,
    tabs
  })
  const openTabs = (h: Harness): string[] =>
    Object.values(h.browser.state.model.tabs).map((t) => t.url)
  const activeUrl = (h: Harness): string | undefined => h.browser.tabs.activeTabFor(h.win)?.url

  it('offers Open All in Tabs and Hide Device, at the anchor the heading asked with', () => {
    const h = harness(DESKTOP)
    vi.spyOn(h.browser.sync, 'tabsFromDevices').mockReturnValue([
      phone([remote('p1', 'https://a.test/'), remote('p2', 'https://b.test/')])
    ])
    h.browser.handleCommand(h.win, 'history.deviceMenu', {
      deviceId: 'phone',
      x: 120,
      y: 80,
      keyboard: true
    })
    expect(labels(h.shown())).toEqual(['Open All in Tabs', 'Hide Device'])
    expect(h.shown()[0]!.enabled).toBe(true)
    expect(h.where()).toMatchObject({ source: 'history', x: 120, y: 80, keyboard: true })
  })

  it('Open All in Tabs opens every listed tab here in the group’s order, the first in front, the rest behind', () => {
    const h = harness(DESKTOP)
    vi.spyOn(h.browser.sync, 'tabsFromDevices').mockReturnValue([
      phone([
        remote('p1', 'https://a.test/'),
        remote('p2', 'https://b.test/'),
        remote('p3', 'https://c.test/')
      ])
    ])
    const before = openTabs(h)
    h.browser.handleCommand(h.win, 'history.deviceMenu', { deviceId: 'phone' })
    h.shown().find((item) => item.label === 'Open All in Tabs')!.click!()
    const opened = openTabs(h).filter((url) => !before.includes(url))
    expect(opened).toEqual(['https://a.test/', 'https://b.test/', 'https://c.test/'])
    expect(activeUrl(h)).toBe('https://a.test/')
  })

  it('a tab this window already holds under the tab’s own id is not opened twice; first, it comes to the front', () => {
    const h = harness(DESKTOP)
    // The Open tabs scope carried the phone's tab here already, as an unloaded tab of its own id.
    const held = h.browser.tabs.createTab(
      { id: 'p1', url: 'https://a.test/', active: false },
      h.win
    )
    const other = h.browser.tabs.createTab({ url: 'https://elsewhere.test/', active: true }, h.win)
    expect(h.browser.tabs.activeTabFor(h.win)?.id).toBe(other.id)
    vi.spyOn(h.browser.sync, 'tabsFromDevices').mockReturnValue([
      phone([remote('p1', 'https://a.test/'), remote('p2', 'https://b.test/')])
    ])
    const before = openTabs(h)
    h.browser.handleCommand(h.win, 'history.deviceMenu', { deviceId: 'phone' })
    h.shown().find((item) => item.label === 'Open All in Tabs')!.click!()
    const opened = openTabs(h).filter((url) => !before.includes(url))
    expect(opened).toEqual(['https://b.test/'])
    expect(h.browser.tabs.activeTabFor(h.win)?.id).toBe(held.id)
    // Its window is this one: no other window is asked forward.
    expect(h.focused).toEqual([])
  })

  it('a tab held in another window is held too (#314’s rule): it comes to the front there and that window comes forward; what opens here opens behind', () => {
    const h = harness(DESKTOP)
    const second = h.browser.openWindow('unsynced', h.win)
    if (!second) throw new Error('no second window')
    // The other window holds the phone's first tab under its own id, behind a tab of its own.
    const held = h.browser.tabs.createTab(
      { id: 'p1', url: 'https://a.test/', active: true },
      second
    )
    const theirs = h.browser.tabs.createTab({ url: 'https://theirs.test/', active: true }, second)
    expect(h.browser.tabs.activeTabFor(second)?.id).toBe(theirs.id)
    const mine = h.browser.tabs.createTab({ url: 'https://mine.test/', active: true }, h.win)
    vi.spyOn(h.browser.sync, 'tabsFromDevices').mockReturnValue([
      phone([
        remote('p1', 'https://a.test/'),
        remote('p2', 'https://b.test/'),
        remote('p3', 'https://c.test/')
      ])
    ])
    const before = openTabs(h)
    h.focused.length = 0
    h.browser.handleCommand(h.win, 'history.deviceMenu', { deviceId: 'phone' })
    h.shown().find((item) => item.label === 'Open All in Tabs')!.click!()
    // Not opened a second time here; to the front in its own window, which comes forward.
    const opened = openTabs(h).filter((url) => !before.includes(url))
    expect(opened).toEqual(['https://b.test/', 'https://c.test/'])
    expect(h.browser.tabs.activeTabFor(second)?.id).toBe(held.id)
    expect(h.focused).toEqual([second.id])
    // The held tab took the front: the tabs that opened here opened behind this window's own.
    expect(h.browser.tabs.activeTabFor(h.win)?.id).toBe(mine.id)
    for (const url of opened) {
      const tab = Object.values(h.browser.state.model.tabs).find((t) => t.url === url)!
      expect(h.browser.tabs.windowShowing(tab, h.win)).toBe(h.win)
    }
  })

  it('with several held tabs the first comes to the front and the others stay; an unheld tab listed before them still opens behind', () => {
    const h = harness(DESKTOP)
    const first = h.browser.tabs.createTab(
      { id: 'p2', url: 'https://b.test/', active: false },
      h.win
    )
    const other = h.browser.tabs.createTab(
      { id: 'p3', url: 'https://c.test/', active: false },
      h.win
    )
    const mine = h.browser.tabs.createTab({ url: 'https://mine.test/', active: true }, h.win)
    expect(h.browser.tabs.activeTabFor(h.win)?.id).toBe(mine.id)
    vi.spyOn(h.browser.sync, 'tabsFromDevices').mockReturnValue([
      phone([
        remote('p1', 'https://a.test/'),
        remote('p2', 'https://b.test/'),
        remote('p3', 'https://c.test/')
      ])
    ])
    const before = openTabs(h)
    const activated = vi.spyOn(h.browser.tabs, 'activateTab')
    h.browser.handleCommand(h.win, 'history.deviceMenu', { deviceId: 'phone' })
    h.shown().find((item) => item.label === 'Open All in Tabs')!.click!()
    const opened = openTabs(h).filter((url) => !before.includes(url))
    expect(opened).toEqual(['https://a.test/'])
    // The first held tab has the front, not the unheld one listed above it; the second held
    // stays where it is – one activation in all, the first held tab's.
    expect(h.browser.tabs.activeTabFor(h.win)?.id).toBe(first.id)
    expect(activated.mock.calls.map((call) => call[0])).toEqual([first.id])
    expect(h.browser.tabs.tab(other.id)?.id).toBe(other.id)
    expect(h.focused).toEqual([])
  })

  it('Hide Device hides the device for the session, and a device the engine no longer lists still hides', () => {
    const h = harness(DESKTOP)
    vi.spyOn(h.browser.sync, 'tabsFromDevices').mockReturnValue([])
    h.browser.handleCommand(h.win, 'history.deviceMenu', { deviceId: 'gone' })
    expect(labels(h.shown())).toEqual(['Open All in Tabs', 'Hide Device'])
    expect(h.shown()[0]!.enabled).toBe(false)
    h.sent.length = 0
    h.shown().find((item) => item.label === 'Hide Device')!.click!()
    expect(h.browser.handleCommand(h.win, 'history.hiddenDevices', undefined)).toEqual(['gone'])
    expect(h.sent).toContain('history.hiddenDevicesChanged')
  })
})

// ---------------------------------------------------------------------------
// The History submenu's Tabs from Other Devices (shortcuts-menus-108; the #326 group's rulings)
// ---------------------------------------------------------------------------

describe('the History submenu’s Tabs from Other Devices', () => {
  const remote = (tabId: string, url: string, lastActive = 1, title = url): SyncRemoteTab => ({
    tabId,
    url,
    title,
    favicon: `data:image/png;base64,${tabId}`,
    lastActive,
    windowId: null
  })
  const device = (
    deviceId: string,
    deviceName: string,
    updatedAt: number,
    tabs: SyncRemoteTab[]
  ): SyncDeviceTabs => ({ deviceId, deviceName, updatedAt, tabs })
  /** Sync on with the Open tabs scope as asked, the engine listing `lists` (newest publish first). */
  const syncing = (h: Harness, lists: SyncDeviceTabs[], openTabs = true): void => {
    const status = h.browser.sync.status()
    vi.spyOn(h.browser.sync, 'status').mockReturnValue({
      ...status,
      enabled: true,
      scope: { ...status.scope, openTabs }
    })
    vi.spyOn(h.browser.sync, 'tabsFromDevices').mockReturnValue(lists)
  }
  const history = (h: Harness): MenuItemTemplate[] => {
    h.browser.handleCommand(h.win, 'app.menu', {})
    return item(h.shown(), 'History').submenu!
  }
  const openTabs = (h: Harness): string[] =>
    Object.values(h.browser.state.model.tabs).map((t) => t.url)

  it('lists the devices as submenus of their tabs after Recently Closed, the header first, newest publish and newest activity first, each tab with its favicon', () => {
    const h = harness(DESKTOP)
    syncing(h, [
      device('phone', 'Pixel 9', 20, [
        remote('p1', 'https://a.test/', 5, 'A'),
        remote('p2', 'https://b.test/', 9, 'B')
      ]),
      device('laptop', 'Work laptop', 10, [remote('l1', 'https://c.test/', 1, '')])
    ])
    const menu = history(h)
    expect(labels(menu)).toEqual([
      'Show Full History',
      '-',
      'No recently closed tabs',
      '-',
      'Tabs from Other Devices',
      'Pixel 9',
      'Pixel 9 > B',
      'Pixel 9 > A',
      'Pixel 9 > -',
      'Pixel 9 > Open All in Tabs',
      'Work laptop',
      'Work laptop > c.test',
      'Work laptop > -',
      'Work laptop > Open All in Tabs'
    ])
    // The header is a heading, not a greyed command: a note kind, which the chrome writes in the
    // deemphasised ink on a row that takes no focus, and a native menu shows disabled.
    expect(item(menu, 'Tabs from Other Devices')).toMatchObject({ enabled: false, note: true })
    expect(item(menu, 'Tabs from Other Devices').click).toBeUndefined()
    const phone = item(menu, 'Pixel 9').submenu!
    expect(phone[0]).toMatchObject({ label: 'B', icon: 'data:image/png;base64,p2' })
    expect(phone[1]).toMatchObject({ label: 'A', icon: 'data:image/png;base64,p1' })
    // The app menu's shape holds: the block adds no top-level row and no separator up there.
    expect(topLabels(h.shown())).toEqual(DESKTOP_APP_MENU_TOP)
  })

  it('a row opens its tab through the held-tab rule: a new tab in front for one this browser does not hold, the held one brought forward otherwise', () => {
    const h = harness(DESKTOP)
    const held = h.browser.tabs.createTab(
      { id: 'p2', url: 'https://b.test/', active: false },
      h.win
    )
    const mine = h.browser.tabs.createTab({ url: 'https://mine.test/', active: true }, h.win)
    expect(h.browser.tabs.activeTabFor(h.win)?.id).toBe(mine.id)
    syncing(h, [
      device('phone', 'Pixel 9', 20, [
        remote('p1', 'https://a.test/', 9, 'A'),
        remote('p2', 'https://b.test/', 5, 'B')
      ])
    ])
    const before = openTabs(h)
    const phone = item(history(h), 'Pixel 9').submenu!
    item(phone, 'A').click!()
    expect(openTabs(h).filter((url) => !before.includes(url))).toEqual(['https://a.test/'])
    expect(h.browser.tabs.activeTabFor(h.win)?.url).toBe('https://a.test/')
    const after = openTabs(h)
    item(phone, 'B').click!()
    expect(openTabs(h)).toEqual(after)
    expect(h.browser.tabs.activeTabFor(h.win)?.id).toBe(held.id)
  })

  it('a device’s submenu lists ten tabs, the rest as a count, and Open All in Tabs opens every one the device lists', () => {
    const h = harness(DESKTOP)
    const tabs = Array.from({ length: 12 }, (_, i) =>
      remote(`p${i}`, `https://site${i}.test/`, 100 - i, `Tab ${i}`)
    )
    syncing(h, [device('phone', 'Pixel 9', 20, tabs)])
    const phone = item(history(h), 'Pixel 9').submenu!
    expect(phone.map((i) => i.label ?? '-')).toEqual([
      ...tabs.slice(0, 10).map((t) => t.title),
      '2 more…',
      '-',
      'Open All in Tabs'
    ])
    expect(item(phone, '2 more…')).toMatchObject({ enabled: false })
    const before = openTabs(h)
    item(phone, 'Open All in Tabs').click!()
    expect(openTabs(h).filter((url) => !before.includes(url))).toEqual(tabs.map((t) => t.url))
    expect(h.browser.tabs.activeTabFor(h.win)?.url).toBe('https://site0.test/')
  })

  it('leaves out a device hidden on the History page and offers Show Hidden Devices, which brings it back; a device with no tab is not listed', () => {
    const h = harness(DESKTOP)
    syncing(h, [
      device('phone', 'Pixel 9', 20, [remote('p1', 'https://a.test/')]),
      device('laptop', 'Work laptop', 10, [remote('l1', 'https://c.test/')]),
      device('idle', 'Idle tablet', 5, [])
    ])
    h.browser.pages.hideDevice('laptop', true)
    let menu = history(h)
    expect(labels(menu).slice(4)).toEqual([
      'Tabs from Other Devices',
      'Pixel 9',
      'Pixel 9 > https://a.test/',
      'Pixel 9 > -',
      'Pixel 9 > Open All in Tabs',
      'Show Hidden Devices'
    ])
    // Every device hidden: §9.17's sentence under the header, and the way back.
    h.browser.pages.hideDevice('phone', true)
    menu = history(h)
    expect(labels(menu).slice(4)).toEqual([
      'Tabs from Other Devices',
      "You've hidden every device",
      'Show Hidden Devices'
    ])
    expect(item(menu, "You've hidden every device")).toMatchObject({ enabled: false, note: true })
    item(menu, 'Show Hidden Devices').click!()
    expect(h.browser.pages.hiddenDeviceIds()).toEqual([])
    menu = history(h)
    expect(labels(menu)).toContain('Work laptop')
    expect(labels(menu)).not.toContain('Show Hidden Devices')
    expect(labels(menu)).not.toContain('Idle tablet')
  })

  it('has no block with sync off, with Open tabs out of what syncs, or with nothing published – the History submenu keeps its two groups', () => {
    const lists = [device('phone', 'Pixel 9', 20, [remote('p1', 'https://a.test/')])]
    const twoGroups = ['Show Full History', '-', 'No recently closed tabs']
    const off = harness(DESKTOP)
    vi.spyOn(off.browser.sync, 'tabsFromDevices').mockReturnValue(lists)
    expect(off.browser.sync.status().enabled).toBe(false)
    expect(labels(history(off))).toEqual(twoGroups)
    const scopeOff = harness(DESKTOP)
    syncing(scopeOff, lists, false)
    expect(labels(history(scopeOff))).toEqual(twoGroups)
    const nothing = harness(DESKTOP)
    syncing(nothing, [])
    expect(labels(history(nothing))).toEqual(twoGroups)
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

describe('Send to your devices (ID-27)', () => {
  /** The browser's sync as a connected engine would report it, its `sendTab` recorded. */
  function connectSync(
    h: Harness,
    devices: Array<{ id: string; name: string; lastSeen: number; kind?: SyncDeviceKind }>
  ): ReturnType<typeof vi.fn> {
    const sendTab = vi.fn(async () => undefined)
    const status = { ...h.browser.sync.status(), enabled: true, devices }
    const sync = new Proxy(h.browser.sync, {
      get: (target, key) =>
        key === 'status' ? () => status : key === 'sendTab' ? sendTab : Reflect.get(target, key)
    })
    Object.defineProperty(h.browser, 'sync', { value: sync, configurable: true })
    return sendTab
  }
  const LAPTOP = { id: 'dev-2', name: 'Work laptop', lastSeen: 2_000 }
  const DESK = { id: 'dev-3', name: 'Home desktop', lastSeen: 5_000 }

  it('is not in the tab menu or the app menu while sync is off or no other device has synced: nothing to send to is not greyed (§10.4)', () => {
    const h = pageHarness()
    h.browser.menus.showTabContextMenu(h.tabId, h.win)
    expect(labels(h.shown()).some((l) => l.startsWith('Send to'))).toBe(false)
    expect(appMenu(h).some((l) => l.startsWith('Send to'))).toBe(false)
    connectSync(h, [])
    h.browser.menus.showTabContextMenu(h.tabId, h.win)
    expect(labels(h.shown()).some((l) => l.startsWith('Send to'))).toBe(false)
    expect(appMenu(h).some((l) => l.startsWith('Send to'))).toBe(false)
  })

  it('with one other device names it beside Share – "Send to Work laptop" – and sends the tab’s page on the click, in the tab menu and the app menu', () => {
    const h = pageHarness()
    const sendTab = connectSync(h, [LAPTOP])
    h.browser.menus.showTabContextMenu(h.tabId, h.win)
    const tabMenu = labels(h.shown())
    expect(tabMenu).toContain('Send to Work laptop')
    expect(tabMenu.indexOf('Send to Work laptop')).toBe(tabMenu.indexOf('Share > Email Link…') + 1)
    const item = h.shown().find((i) => i.label === 'Send to Work laptop')
    expect(item?.enabled).toBe(true)
    expect(item?.submenu).toBeUndefined()
    item?.click?.()
    expect(sendTab).toHaveBeenCalledWith(
      { deviceId: 'dev-2', url: PAGE_URL, tabId: h.tabId },
      h.win
    )
    const menu = appMenu(h)
    expect(menu).toContain('Save and Share > Send to Work laptop')
    // On the desktop the app menu has no Share… (no share target): the item sits where Share…
    // does on the hosts that have it – the Save and Share submenu's order is save, shortcut,
    // web capture, print, share, send (shortcuts-menus-120; Edge's Web capture between the save
    // and the print) – so after Print…, closing the submenu, which the app's separator follows.
    expect(menu.indexOf('Save and Share > Send to Work laptop')).toBe(
      menu.indexOf('Save and Share > Print…') + 1
    )
    expect(menu.indexOf('Save and Share > Web Capture…')).toBe(
      menu.indexOf('Save and Share > Save Page As') + 1
    )
    expect(menu[menu.indexOf('Save and Share > Send to Work laptop') + 1]).toBe('-')
    expect(menu.indexOf('Save and Share')).toBe(menu.indexOf('Reader View') + 1)
  })

  it('with several devices is "Send to Your Devices", the devices most recently seen first, each row sending to its device', () => {
    const h = pageHarness()
    const sendTab = connectSync(h, [LAPTOP, DESK])
    h.browser.menus.showTabContextMenu(h.tabId, h.win)
    expect(labels(h.shown())).toEqual(
      expect.arrayContaining([
        'Send to Your Devices',
        'Send to Your Devices > Home desktop',
        'Send to Your Devices > Work laptop'
      ])
    )
    const item = h.shown().find((i) => i.label === 'Send to Your Devices')
    expect(item?.submenu?.map((d) => d.label)).toEqual(['Home desktop', 'Work laptop'])
    item?.submenu?.[1]?.click?.()
    expect(sendTab).toHaveBeenCalledWith(
      { deviceId: 'dev-2', url: PAGE_URL, tabId: h.tabId },
      h.win
    )
    // The tablet's popover menu cascades the same submenu, from Save and Share's.
    const tablet = pageHarness(ANDROID, { formFactor: 'tablet' })
    connectSync(tablet, [LAPTOP, DESK])
    expect(appMenu(tablet)).toContain('Save and Share > Send to Your Devices')
    expect(labels(deepItem(tablet.shown(), 'Send to Your Devices').submenu!)).toEqual([
      'Home desktop',
      'Work laptop'
    ])
  })

  it('each device’s row carries the device’s kind for the renderer-drawn menu’s glyph, null for a device that announced none (services pass 4)', () => {
    const h = pageHarness()
    connectSync(h, [
      { ...LAPTOP, kind: 'laptop' },
      { ...DESK, kind: 'desktop' },
      { id: 'dev-4', name: 'Pixel 9', lastSeen: 4_000, kind: 'phone' },
      { id: 'dev-5', name: 'Old build', lastSeen: 3_000 }
    ])
    const appMenuItems = (h: Harness): MenuItemTemplate[] => {
      h.browser.handleCommand(h.win, 'app.menu', {})
      return h.shown()
    }
    const rows = deepItem(appMenuItems(h), 'Send to Your Devices').submenu!
    expect(rows.map((row) => [row.label, row.device])).toEqual([
      ['Home desktop', { kind: 'desktop' }],
      ['Pixel 9', { kind: 'phone' }],
      ['Old build', { kind: null }],
      ['Work laptop', { kind: 'laptop' }]
    ])
    // The renderer's descriptor keeps the mark, as it keeps a group's (`serialiseMenu`).
    const { items } = serialiseMenu(rows, 'm')
    expect(items.map((item) => item.device)).toEqual([
      { kind: 'desktop' },
      { kind: 'phone' },
      { kind: null },
      { kind: 'laptop' }
    ])
    // The one-device item names the device and carries no mark: it is not a device row.
    connectSync(h, [{ ...LAPTOP, kind: 'laptop' }])
    expect(appMenuItems(h).some((item) => item.device)).toBe(false)
  })

  it('on a phone with several devices the item opens the device picker sheet instead (sendTab.open), beside Share…', () => {
    const phone = pageHarness(ANDROID, { formFactor: 'phone' })
    const sendTab = connectSync(phone, [LAPTOP, DESK])
    const sheet = appMenu(phone)
    expect(sheet).toContain('Send to Your Devices…')
    expect(sheet.indexOf('Send to Your Devices…')).toBe(sheet.indexOf('Share…') + 1)
    // No drill-in level: the picker is the chrome's sheet, asked for as the menu leaves.
    expect(sheet.some((l) => l.startsWith('Send to Your Devices… >'))).toBe(false)
    const item = phone.shown().find((i) => i.label === 'Send to Your Devices…')
    expect(item?.submenu).toBeUndefined()
    phone.sent.length = 0
    item?.click?.()
    expect(phone.sent).toEqual(['sendTab.open'])
    expect(sendTab).not.toHaveBeenCalled()
    // The tab's own menu (the overview card's hold) carries the same item.
    phone.browser.menus.showTabContextMenu(phone.tabId, phone.win)
    expect(labels(phone.shown())).toContain('Send to Your Devices…')
    // One device still sends outright on the phone: one tap, the toast confirms.
    const one = pageHarness(ANDROID, { formFactor: 'phone' })
    const sendOne = connectSync(one, [LAPTOP])
    expect(appMenu(one)).toContain('Send to Work laptop')
    one
      .shown()
      .find((i) => i.label === 'Send to Work laptop')
      ?.click?.()
    expect(sendOne).toHaveBeenCalledWith(
      { deviceId: 'dev-2', url: PAGE_URL, tabId: one.tabId },
      one.win
    )
  })

  it('keeps the item for a page that cannot travel – an internal page – disabled, so the page reads as the reason', () => {
    const h = pageHarness()
    connectSync(h, [LAPTOP])
    const settings = h.browser.tabs.createTab({ url: 'zen://settings', active: true }, h.win)
    h.browser.menus.showTabContextMenu(settings.id, h.win)
    const item = h.shown().find((i) => i.label === 'Send to Work laptop')
    expect(item).toBeDefined()
    expect(item?.enabled).toBe(false)
  })
})

describe('the tab strip menus (tabs-35, tabs-24, tabs-25)', () => {
  /** The item of that label in the last popup, wherever it sits – in a submenu too. */
  const item = (h: Harness, label: string): MenuItemTemplate => {
    const found = allItems(h.shown()).find((i) => i.label === label)
    if (!found) throw new Error(`no "${label}" in ${labels(h.shown()).join(', ')}`)
    return found
  }
  const enabled = (h: Harness, label: string): boolean => item(h, label).enabled !== false

  describe("the tab row's menu is Firefox's, in Firefox's groups (§6 Menus: a long context menu regrouped to the app menu's counts)", () => {
    /** Firefox's skeleton for a regular row: five groups, four separators, twenty rows – and Chrome's reading list row (W6-1). */
    const REGULAR_TAB_MENU = [
      'New Tab Below',
      '-',
      'Reload Tab',
      'Mute Tab',
      'Mute Site',
      'Unload Tab',
      'Freeze Tab',
      'Duplicate Tab',
      'Pin Tab',
      'Add to Essentials',
      'Rename Tab…',
      'Change Icon…',
      '-',
      'Bookmark Tab',
      'Bookmark All Tabs…',
      'Add Tab to Reading List',
      'Move Tab',
      'Split with Current Tab',
      'Open in New Container Tab',
      'Share',
      '-',
      'Close Multiple Tabs',
      'Close Tab',
      '-',
      'Reopen Closed Tab'
    ]

    it('a regular row: twenty-one rows and four separators, every move under Move Tab and the three scoped closes under Close Multiple Tabs', () => {
      const h = pageHarness()
      h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: h.tabId })
      const shown = h.shown()
      expect(topLabels(shown)).toEqual(REGULAR_TAB_MENU)
      // Firefox's twenty and Chrome's Add tab to reading list (W6-1) under the bookmark rows.
      expect(topLabels(shown).filter((l) => l !== '-')).toHaveLength(21)
      expect(separators(shown)).toBe(4)
      // The state group in Firefox's order – Reload, Mute, Unload, Freeze, Duplicate, Pin: the
      // unload and the freeze are the tab's state, as its mute is, not its place.
      const top = topLabels(shown)
      expect(top.slice(top.indexOf('Reload Tab'), top.indexOf('Pin Tab') + 1)).toEqual([
        'Reload Tab',
        'Mute Tab',
        'Mute Site',
        'Unload Tab',
        'Freeze Tab',
        'Duplicate Tab',
        'Pin Tab'
      ])
      expect(top.slice(top.indexOf('Bookmark Tab'), top.indexOf('Move Tab') + 1)).toEqual([
        'Bookmark Tab',
        'Bookmark All Tabs…',
        'Add Tab to Reading List',
        'Move Tab'
      ])
      expect(topLabels(item(h, 'Move Tab').submenu!)).toEqual([
        'Move to Space',
        'Add Tab to New Folder',
        'Add Route for Domain',
        '-',
        'Move Tab to New Window',
        'Move Tab to Another Window'
      ])
      expect(topLabels(item(h, 'Close Multiple Tabs').submenu!)).toEqual([
        'Close Tabs Above',
        'Close Tabs Below',
        'Close Other Tabs'
      ])
      expect(topLabels(item(h, 'Share').submenu!)).toEqual([
        'Copy Link',
        'Copy Link as Markdown',
        'Email Link…'
      ])
    })

    it('nothing the flat menu did is gone: every one of its rows is in the regrouped menu, at the top or in a submenu', () => {
      const h = pageHarness()
      h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: h.tabId })
      const all = allItems(h.shown())
        .map((i) => i.label)
        .filter((l): l is string => Boolean(l))
      // The flat menu's rows for a regular tab (#263, before this regrouping).
      for (const label of [
        'New Tab Below',
        'Reload Tab',
        'Mute Tab',
        'Mute Site',
        'Duplicate Tab',
        'Rename Tab…',
        'Change Icon…',
        'Add to Essentials',
        'Pin Tab',
        'Split with Current Tab',
        'Move to Space',
        'Add Tab to New Folder',
        'Add Route for Domain',
        'Move Tab to New Window',
        'Move Tab to Another Window',
        'Open in New Container Tab',
        'Bookmark Tab',
        'Bookmark All Tabs…',
        'Share',
        'Copy Link',
        'Copy Link as Markdown',
        'Email Link…',
        'Freeze Tab',
        'Unload Tab',
        'Close Tabs Above',
        'Close Tabs Below',
        'Close Other Tabs',
        'Close Tab',
        'Reopen Closed Tab'
      ])
        expect(all).toContain(label)
    })

    it("a pinned row's state rows stand with Pin: Unpin, Reset Pinned Tab, Edit Pinned Tab…; its close is Close Tab (keep pinned) with Remove Tab beside it", () => {
      const h = pageHarness()
      h.browser.tabs.togglePin(h.tabId, h.win)
      h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: h.tabId })
      const top = topLabels(h.shown())
      expect(top.slice(top.indexOf('Duplicate Tab') + 1, top.indexOf('Add to Essentials'))).toEqual(
        ['Unpin Tab', 'Reset Pinned Tab', 'Edit Pinned Tab…']
      )
      expect(top.slice(-5)).toEqual([
        'Close Multiple Tabs',
        'Close Tab (keep pinned)',
        'Remove Tab',
        '-',
        'Reopen Closed Tab'
      ])
      expect(separators(h.shown())).toBe(4)
    })

    it('every row is Title Case (§9.1)', () => {
      const h = pageHarness()
      h.browser.handleCommand(h.win, 'tab.contextMenu', { tabId: h.tabId })
      for (const label of topLabels(h.shown()).filter((l) => l !== '-'))
        expect(label, label).toMatch(/^[A-Z0-9]/)
    })
  })

  it("the strip's menu is Chrome's rows first – Name Window… among them on the desktop (context-menus-108) – then Zenium's own", () => {
    const h = pageHarness()
    h.browser.handleCommand(h.win, 'newtab.contextMenu', {})
    expect(topLabels(h.shown())).toEqual([
      'New Tab',
      'New Tab in Container',
      'Reopen Closed Tab',
      'Bookmark All Tabs…',
      'Name Window…',
      '-',
      'New Folder',
      'New Live Folder…',
      'New Space…',
      '-',
      'Clear Unpinned Tabs'
    ])
    expect(item(h, 'Reopen Closed Tab').action).toBe('tab.reopenClosed')
    expect(item(h, 'Bookmark All Tabs…').action).toBe('bookmark.allTabs')
    expect(item(h, 'Name Window…').action).toBe('window.name')
    h.sent.length = 0
    item(h, 'Name Window…').click!()
    expect(h.sent).toEqual(['windowName.open'])
    // A tablet's one window has no title bar to name: the row is the desktop's.
    const tablet = pageHarness(DESKTOP, { formFactor: 'tablet' })
    tablet.browser.handleCommand(tablet.win, 'newtab.contextMenu', {})
    expect(topLabels(tablet.shown())).not.toContain('Name Window…')
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
    expect(topLabels(h.shown()).slice(-5)).toEqual([
      '-',
      'Close Multiple Tabs',
      'Close Tab',
      '-',
      'Reopen Closed Tab'
    ])
    expect(topLabels(item(h, 'Close Multiple Tabs').submenu!)).toEqual([
      'Close Tabs Above',
      'Close Tabs Below',
      'Close Other Tabs'
    ])
    expect(enabled(h, 'Reopen Closed Tab')).toBe(false)
  })

  it("the phone row's Remove Bookmark (the drawer's hold menu) is told as the desktop's: bookmark.deleted for the toast with Undo, no bare word (#357 G2)", () => {
    const h = pageHarness(ANDROID, { formFactor: 'phone' })
    h.browser.menus.showTabContextMenu(h.tabId, h.win)
    item(h, 'Bookmark Tab').click!()
    expect(h.browser.bookmarks.has(PAGE_URL)).toBe(true)
    h.sent.length = 0
    h.browser.menus.showTabContextMenu(h.tabId, h.win)
    expect(labels(h.shown())).toContain('Remove Bookmark')
    item(h, 'Remove Bookmark').click!()
    expect(h.browser.bookmarks.has(PAGE_URL)).toBe(false)
    expect(h.sent).toContain('bookmark.deleted')
    expect(h.sent).not.toContain('toast')
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
        expect(topLabels(item(h, 'Close Multiple Tabs').submenu!)).toEqual([
          'Close Tabs Above',
          'Close Tabs Below',
          'Close Other Tabs'
        ])
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

describe('directedNavigationHistory', () => {
  const stack = Array.from({ length: 12 }, (_, i) => ({
    url: `https://example.org/${i}`,
    title: i % 3 === 0 ? '' : `Page ${i}`
  }))

  it('lists the back entries nearest first, capped at the limit, never the current one', () => {
    const rows = directedNavigationHistory(stack, 10, 'back', 8)
    expect(rows.map((r) => r.index)).toEqual([9, 8, 7, 6, 5, 4, 3, 2])
    expect(rows[0]).toEqual({ index: 9, url: 'https://example.org/9', title: '' })
    expect(rows[1].title).toBe('Page 8')
  })

  it('lists the forward entries nearest first and stops at the stack’s end', () => {
    expect(directedNavigationHistory(stack, 9, 'forward', 8).map((r) => r.index)).toEqual([10, 11])
  })

  it('gives nothing at either end of the stack, off it, or for a stack of one', () => {
    expect(directedNavigationHistory(stack, 0, 'back', 8)).toEqual([])
    expect(directedNavigationHistory(stack, 11, 'forward', 8)).toEqual([])
    expect(directedNavigationHistory(stack, -1, 'back', 8)).toEqual([])
    expect(directedNavigationHistory(stack, 12, 'back', 8)).toEqual([])
    expect(directedNavigationHistory(stack.slice(0, 1), 0, 'back', 8)).toEqual([])
    expect(directedNavigationHistory([], -1, 'back', 8)).toEqual([])
  })
})
