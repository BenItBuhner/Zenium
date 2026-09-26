import type { FormFactor, HostCapabilities, Platform as PlatformOs, Rect } from '../../shared/types'
import { Browser } from '../browser'
import { closeBootTabs } from './bootTab'
import type {
  AppHost,
  ChromeContextParams,
  ClipboardHost,
  DialogHost,
  MenuHost,
  MenuItemTemplate,
  MenuPopupOptions,
  PageContextParams,
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

/**
 * The menus' test harness: a real `Browser` on a fake host whose menu popup only records the
 * template, with the hand-kept capability copies of the desktop and the phone. Shared by the
 * core's menu suites and by the desktop's – `src/main/platform/__tests__/menuMnemonics.test.ts`
 * walks every menu the core can build through it to check the Alt mnemonics.
 */

/**
 * Electron's capabilities, a hand-kept copy of src/main/platform/index.ts: the real object imports
 * Electron, which a core test cannot load. When a capability is added or flipped there, update it
 * here too (the `HostCapabilities` type catches an added one, not a changed value).
 */
export const DESKTOP: HostCapabilities = {
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
export const ANDROID: HostCapabilities = {
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

export function memoryIo(files: Record<string, string> = {}): StoreIO {
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
export function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

export interface Harness {
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
  /** Every read of the chrome document a right-click asked the host for (`options.chromeDocument`). */
  documentReads: string[]
  /** The window host's `minimize` / `maximize` / `unmaximize` calls, in order. */
  windowCalls: string[]
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

export interface HarnessOptions {
  formFactor?: FormFactor
  /** The OS the host reports (`Platform.info.os`); absent, Linux for a windowed host, Android otherwise. */
  os?: PlatformOs
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
  /**
   * What the host reads from its chrome document for a right-click it did not handle: the
   * `data-zen-menu` element under the point, and the focused element's box (the desktop's
   * `menuTargetAt` / `focusedRect`); absent, the host answers nothing.
   */
  chromeDocument?: {
    hit?: { target: string; tabId: string | null } | null
    focused?: Rect | null
  }
  /** The window starts maximized (`WindowHost.isMaximized`); its `maximize` / `unmaximize` flip it. */
  maximized?: boolean
}

/** The languages the fake spellchecker was last told to check in. */
export interface SpellcheckApplied {
  enabled: boolean
  languages: string[]
}

/** A browser on a host with the given capabilities whose menu popup only records the template. */
export function harness(
  capabilities: HostCapabilities,
  options: HarnessOptions | FormFactor = {}
): Harness {
  const opts: HarnessOptions = typeof options === 'string' ? { formFactor: options } : options
  let last: MenuItemTemplate[] = []
  let lastOptions: MenuPopupOptions | null = null
  let count = 0
  const viewCalls: string[] = []
  const documentReads: string[] = []
  const windowCalls: string[] = []
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
  let maximized = Boolean(opts.maximized)
  const platform: Platform = {
    info: {
      os: opts.os ?? (capabilities.windows ? ('linux' as PlatformOs) : 'android'),
      version: '1.2.3'
    },
    capabilities,
    io: memoryIo({ ...opts.files }),
    windows: {
      create: (win) =>
        stub<WindowHost>({
          alive: true,
          contentSize: () => ({ width: 1280, height: 800 }),
          normalBounds: () => null,
          isFullScreen: () => Boolean(opts.fullScreen),
          isMaximized: () => maximized,
          maximize: () => {
            maximized = true
            windowCalls.push('maximize')
          },
          unmaximize: () => {
            maximized = false
            windowCalls.push('unmaximize')
          },
          minimize: () => void windowCalls.push('minimize'),
          isFocused: () => true,
          isVisible: () => true,
          send: (name) => void sent.push(name),
          focus: () => void focused.push(win.id),
          ...(opts.chromeDocument
            ? {
                menuTargetAt: (x, y) => {
                  documentReads.push(`menuTargetAt(${x},${y})`)
                  return Promise.resolve(opts.chromeDocument?.hit ?? null)
                },
                focusedRect: () => {
                  documentReads.push('focusedRect()')
                  return Promise.resolve(opts.chromeDocument?.focused ?? null)
                }
              }
            : {})
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
    documentReads,
    windowCalls,
    clipboardText,
    sent,
    focused,
    linkApps,
    spellcheckApplied
  }
}

/** Labels in order, separators as `-`, submenus flattened one level as `Parent > Child`. */
export function labels(items: MenuItemTemplate[]): string[] {
  return items.flatMap((item) => {
    if (item.type === 'separator') return ['-']
    const label = item.label ?? ''
    return item.submenu
      ? [label, ...item.submenu.map((sub) => `${label} > ${sub.label ?? '-'}`)]
      : [label]
  })
}

/** The item labelled `label` anywhere in `items`, submenus included. */
export function deepItem(items: MenuItemTemplate[], label: string): MenuItemTemplate {
  const found = allItems(items).find((i) => i.label === label)
  if (!found) throw new Error(`no "${label}" in ${topLabels(items).join(', ')}`)
  return found
}

/** Every item of a template, submenus included. */
export function allItems(items: MenuItemTemplate[]): MenuItemTemplate[] {
  return items.flatMap((item) => [item, ...(item.submenu ? allItems(item.submenu) : [])])
}

export const PAGE_URL = 'https://example.com/article'

export const NO_EDITS: PageContextParams['editFlags'] = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canDelete: false,
  canSelectAll: false
}

export const ALL_EDITS: PageContextParams['editFlags'] = {
  canUndo: true,
  canRedo: true,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canDelete: true,
  canSelectAll: true
}

/** A `context-menu` event's parameters for a click on the plain page, overridable per target. */
export function pageParams(overrides: Partial<PageContextParams> = {}): PageContextParams {
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

export const VIDEO_FLAGS: NonNullable<PageContextParams['mediaFlags']> = {
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

export interface PageHarness extends Harness {
  tabId: string
  /** Show the page menu for `params` and return its top-level labels (submenus collapsed). */
  menu: (params: PageContextParams) => string[]
  /** The last template's items, top level only. */
  items: () => MenuItemTemplate[]
  /** Click the item labelled `label` in the last template. */
  click: (label: string) => void
}

/** A desktop browser with one loaded web page tab. */
export function pageHarness(
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
export function topLabels(items: MenuItemTemplate[]): string[] {
  return items.map((item) => (item.type === 'separator' ? '-' : (item.label ?? '')))
}

export function separators(items: MenuItemTemplate[]): number {
  return items.filter((item) => item.type === 'separator').length
}

export function item(items: MenuItemTemplate[], label: string): MenuItemTemplate {
  const found = items.find((i) => i.label === label)
  if (!found) throw new Error(`no "${label}" in ${topLabels(items).join(', ')}`)
  return found
}

export function chromeParams(overrides: Partial<ChromeContextParams> = {}): ChromeContextParams {
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
