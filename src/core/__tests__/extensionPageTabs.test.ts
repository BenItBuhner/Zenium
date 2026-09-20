import { describe, expect, it } from 'vitest'
import type {
  ExtensionInfo,
  HostCapabilities,
  Platform as PlatformOs,
  Tab
} from '../../shared/types'
import { Browser } from '../browser'
import type {
  ClipboardHost,
  ExtensionHost,
  Platform,
  ShellHost,
  StoreIO,
  TabView,
  TabViewEvents,
  TabViewHost,
  WindowHost
} from '../platform'
import type { ZenWindow } from '../window'

/*
 * A tab on an extension's page presents as the extension's (v2 §10.1 applied to extension
 * pages): its title falls back to the extension's name rather than its id until – or unless –
 * the document names itself, and Copy Link and Share carry `chrome-extension://<id>/<path>`
 * whichever form the tab's URL takes – Chrome's scheme on the desktop, or the Android runtime's
 * emulated origin `https://<id>.ext.zenium.invalid/…`, which never leaves the runtime.
 */

const ID = 'dbepggeogbaibhgnhhndojpepiihcmeb'
const SCHEME_URL = `chrome-extension://${ID}/pages/options.html`
const EMULATED_URL = `https://${ID}.ext.zenium.invalid/pages/options.html`
const VIMIUM = { id: ID, name: 'Vimium', enabled: true, icon: null } as unknown as ExtensionInfo

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

interface Harness {
  browser: Browser
  win: ZenWindow
  /** Everything written to the clipboard, in order. */
  copied: string[]
  /** Everything handed to the share sheet, in order. */
  shared: { title: string; url: string }[]
  /** The events the core wired for a tab's page: the test plays the document's reports through them. */
  eventsOf: (tabId: string) => TabViewEvents
  open: (url: string) => Tab
}

function harness(extensions: ExtensionInfo[]): Harness {
  const copied: string[] = []
  const shared: { title: string; url: string }[] = []
  const events = new Map<string, TabViewEvents>()
  const platform: Platform = {
    info: { os: 'linux' as PlatformOs, version: '1.2.3' },
    capabilities: stub<HostCapabilities>({ windows: true, extensions: true, share: true }),
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
      createView: (tab, tabEvents) => {
        events.set(tab.id, tabEvents)
        let url = ''
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          loadURL: (u) => {
            url = u
          },
          getURL: () => url,
          // The document has not named itself: what the tab is called is the core's fallback.
          getTitle: () => '',
          hasDocument: () => url !== '',
          canGoBack: () => false,
          canGoForward: () => false,
          getZoom: () => 1,
          isCurrentlyAudible: () => false
        })
      }
    }),
    menus: { popup: () => undefined },
    dialogs: stub(),
    clipboard: stub<ClipboardHost>({
      writeText: (text) => {
        copied.push(text)
      }
    }),
    shell: stub<ShellHost>({
      share: async (payload) => {
        shared.push({ title: payload.title ?? '', url: payload.url ?? '' })
      }
    }),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub(),
    readabilitySource: () => null,
    createExtensions: () =>
      stub<ExtensionHost>({ start: async () => undefined, list: () => extensions })
  }
  const browser = new Browser(platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  return {
    browser,
    win,
    copied,
    shared,
    eventsOf: (tabId) => {
      const e = events.get(tabId)
      if (!e) throw new Error(`no page for ${tabId}`)
      return e
    },
    open: (url) => browser.tabs.createTab({ url, active: true }, win)
  }
}

describe('a tab on an extension page', () => {
  it('is titled after the extension until the document names itself, in either URL form', () => {
    const h = harness([VIMIUM])
    for (const url of [SCHEME_URL, EMULATED_URL]) {
      const tab = h.open(url)
      expect(h.browser.tabs.tab(tab.id)?.title).toBe('Vimium')
      // The document reports its title: the page's own name wins.
      h.eventsOf(tab.id).onTitleUpdated('Vimium Options')
      expect(h.browser.tabs.tab(tab.id)?.title).toBe('Vimium Options')
      // It reports none (a bare page, a reload mid-document): back to the extension's name, not its id.
      h.eventsOf(tab.id).onTitleUpdated('')
      expect(h.browser.tabs.tab(tab.id)?.title).toBe('Vimium')
    }
  })

  it('falls back to the id while the chrome knows no extension by it', () => {
    const h = harness([])
    const tab = h.open(SCHEME_URL)
    expect(h.browser.tabs.tab(tab.id)?.title).toBe(ID)
  })

  it('copies and shares chrome-extension://<id>/<path>, never the emulated origin', () => {
    const h = harness([VIMIUM])
    for (const url of [SCHEME_URL, EMULATED_URL]) {
      const tab = h.open(url)
      h.browser.tabs.copyUrl(tab.id)
      expect(h.copied.at(-1)).toBe(SCHEME_URL)
      h.browser.tabs.copyUrl(tab.id, true)
      expect(h.copied.at(-1)).toBe(`[Vimium](${SCHEME_URL})`)
      h.browser.shareTab(tab.id, h.win)
      expect(h.shared.at(-1)).toEqual({ title: 'Vimium', url: SCHEME_URL })
    }
    expect(h.copied.join('\n')).not.toContain('.ext.zenium.invalid')
    expect(h.shared.map((s) => s.url).join('\n')).not.toContain('.ext.zenium.invalid')
  })
})
