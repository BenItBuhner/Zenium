import { describe, expect, it } from 'vitest'
import type {
  FormFactor,
  HostCapabilities,
  Platform as PlatformOs,
  Settings
} from '../../shared/types'
import { searchCommands, type CommandContext } from '../../shared/commands'
import { resolveDownloadSettings } from '../../shared/downloads'
import { buildSearchUrl } from '../../shared/search'
import { Browser } from '../browser'
import type {
  AppHost,
  ClipboardHost,
  MenuHost,
  MenuItemTemplate,
  Platform,
  StoreIO,
  TabView,
  TabViewHost,
  WindowHost
} from '../platform'
import type { ZenWindow } from '../window'
import type { ChromeContextParams, PageContextParams } from '../platform'
import {
  isDownloadable,
  joinGroups,
  linkCopyItem,
  NAVIGATION_MENU_MAX,
  navigationWindow,
  selectionUrl
} from '../menus'

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
  privateTabs: false,
  secureDns: false,
  newTabPage: true,
  pageTabs: false
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
  privateTabs: true,
  secureDns: false,
  newTabPage: false,
  pageTabs: true
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
  /** How many popups the host was asked for. */
  popups: () => number
  /** Every call a tab view received, as `method(args)`. */
  viewCalls: string[]
  /** What the host's clipboard says on `readText`. */
  clipboardText: { value: string }
  /** The names of the events sent to the window's chrome, in order. */
  sent: string[]
}

interface HarnessOptions {
  formFactor?: FormFactor
  /** The host has an OS emoji picker (Windows, macOS). */
  emojiPanel?: boolean
  /** The host's window is fullscreen. */
  fullScreen?: boolean
}

/** A browser on a host with the given capabilities whose menu popup only records the template. */
function harness(
  capabilities: HostCapabilities,
  options: HarnessOptions | FormFactor = {}
): Harness {
  const opts: HarnessOptions = typeof options === 'string' ? { formFactor: options } : options
  let last: MenuItemTemplate[] = []
  let count = 0
  const viewCalls: string[] = []
  const clipboardText = { value: '' }
  const sent: string[] = []
  const menus: MenuHost = {
    popup: (items) => {
      last = items
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
    io: memoryIo(),
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
    dialogs: stub(),
    clipboard: stub<ClipboardHost>({ readText: () => Promise.resolve(clipboardText.value) }),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    // Optional members must read as absent, which the catch-all stub would not give.
    app: stub<AppHost>({ showEmojiPanel: opts.emojiPanel ? () => undefined : undefined }),
    readabilitySource: () => null
  }
  const browser = new Browser(platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  if (opts.formFactor)
    browser.handleCommand(win, 'window.formFactor', { formFactor: opts.formFactor })
  return { browser, win, shown: () => last, popups: () => count, viewCalls, clipboardText, sent }
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
      'Zoom…',
      '-',
      'Find in Page…',
      'Reader View',
      'Share…',
      'Print…',
      'Save Page As…',
      'Take Screenshot',
      'Desktop Site',
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
      'Remove from List'
    ])
    expect(enabled(h, 'Open')).toBe(true)
    expect(enabled(h, 'Show in Folder')).toBe(true)
    let copied = ''
    h.browser.platform.clipboard.writeText = (text: string) => void (copied = text)
    h.shown()
      .find((item) => item.label === 'Copy Download Link')
      ?.click?.()
    await settle()
    expect(copied).toBe('file:///tmp/shot.png')
  })

  it('shows nothing for an unknown record', () => {
    const h = harness(DESKTOP)
    const before = h.popups()
    h.browser.handleCommand(h.win, 'download.contextMenu', { id: 'dl-missing' })
    expect(h.popups()).toBe(before)
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
