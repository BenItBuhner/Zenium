import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { DEFAULT_READER_PREFERENCES } from '../../shared/reader'
import { Browser } from '../browser'
import type { AppHost, Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import { READER_URL_PREFIX, sanitizeArticleHtml } from '../reader'
import type { ZenWindow } from '../window'

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

/** A desktop host whose views record the script each is asked to run, by tab. */
function fakePlatform(io: StoreIO): Platform & { scripts: Map<string, string[]> } {
  const scripts = new Map<string, string[]>()
  return {
    scripts,
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
    capabilities: stub<HostCapabilities>({ windows: true, updates: false, agents: false }),
    io,
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
      createView: (tab) => {
        const record: string[] = []
        scripts.set(tab.id, record)
        return stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          getURL: () => tab.url,
          getZoom: () => 1,
          executeJavaScript: (code: string) => {
            record.push(code)
            return Promise.resolve(undefined)
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
    app: stub<AppHost>(),
    readabilitySource: () => null
  }
}

function start(io = memoryIo()): {
  browser: Browser
  platform: ReturnType<typeof fakePlatform>
  win: ZenWindow
  io: ReturnType<typeof memoryIo>
} {
  const platform = fakePlatform(io)
  const browser = new Browser(platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  return { browser, platform, win, io }
}

const READER_URL = `${READER_URL_PREFIX}?id=article-1&url=${encodeURIComponent('https://example.com/a')}`

/** The preferences a `zenReaderApply` call handed the page, or null for a script that is not one. */
function applied(script: string): Record<string, unknown> | null {
  const m = /window\.zenReaderApply\((.*)\)$/.exec(script)
  return m ? (JSON.parse(m[1]) as Record<string, unknown>) : null
}

describe('reader text preferences in the browser', () => {
  it('saves a change and pushes it to every open reader page, not to the web pages', async () => {
    const { browser, platform, win, io } = start()
    const reader = browser.tabs.createTab({ url: READER_URL, active: true }, win)
    const second = browser.tabs.createTab({ url: READER_URL, active: false }, win)
    const web = browser.tabs.createTab({ url: 'https://example.com/', active: false }, win)
    expect(browser.reader.preferences()).toEqual(DEFAULT_READER_PREFERENCES)

    browser.handleCommand(win, 'reader.setPreferences', { fontSize: 22, theme: 'sepia' })
    const want = { ...DEFAULT_READER_PREFERENCES, fontSize: 22, theme: 'sepia' }
    expect(browser.state.settings.reader).toEqual(want)
    for (const id of [reader.id, second.id]) {
      const pushes = platform.scripts.get(id)!.map(applied).filter(Boolean)
      expect(pushes).toEqual([want])
    }
    expect(platform.scripts.get(web.id)!.map(applied).filter(Boolean)).toEqual([])

    await new Promise((r) => setImmediate(r))
    await browser.state.flush()
    expect(JSON.parse(io.files['state.json']).settings.reader).toEqual(want)
  })

  it('ignores a patch with nothing valid in it and one that changes nothing', () => {
    const { browser, platform, win } = start()
    const reader = browser.tabs.createTab({ url: READER_URL, active: true }, win)
    browser.handleCommand(win, 'reader.setPreferences', { fontSize: 13, font: 'comic' })
    browser.handleCommand(win, 'reader.setPreferences', { theme: 'auto' })
    expect(browser.reader.preferences()).toEqual(DEFAULT_READER_PREFERENCES)
    expect(platform.scripts.get(reader.id)!.map(applied).filter(Boolean)).toEqual([])
  })

  it('renders a reader page with the saved preferences and follows a settings patch', () => {
    const { browser, platform, win } = start()
    const reader = browser.tabs.createTab({ url: READER_URL, active: true }, win)
    browser.handleCommand(win, 'settings.update', { reader: { width: 'narrow', fontSize: 15 } })
    expect(browser.reader.preferences()).toEqual({
      ...DEFAULT_READER_PREFERENCES,
      width: 'narrow',
      fontSize: 15
    })
    // The settings path pushes too (a sync merge or a Settings row, not the page itself).
    expect(platform.scripts.get(reader.id)!.map(applied).filter(Boolean)).toEqual([
      { ...DEFAULT_READER_PREFERENCES, width: 'narrow', fontSize: 15 }
    ])
    // A stored value off the ladder comes back as the default on load.
    const { browser: reloaded } = start(
      memoryIo({
        'state.json': JSON.stringify({
          version: 2,
          settings: { reader: { fontSize: 19, font: 'sans', theme: 'dark', width: 'wide' } },
          tabs: [],
          spaces: []
        })
      })
    )
    expect(reloaded.reader.preferences()).toEqual({
      ...DEFAULT_READER_PREFERENCES,
      fontSize: 18,
      font: 'sans',
      theme: 'dark',
      width: 'wide'
    })
  })
})

describe('sanitizeArticleHtml', () => {
  it('strips scripts, frames, forms and inline handlers', () => {
    const html =
      '<p onclick="x()">Hi</p><script>alert(1)</script><iframe src="https://evil"></iframe>' +
      '<form action="/x"><input></form><a href="javascript:alert(1)">l</a><img src="data:text/html,x">'
    const out = sanitizeArticleHtml(html)
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('<form')
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('data:text/html')
    expect(out).toContain('<p>Hi</p>')
  })

  it('keeps ordinary article markup', () => {
    const html =
      '<h2>Title</h2><p>Text with <a href="https://ok.test/">link</a> and <img src="https://ok.test/i.png"></p>'
    expect(sanitizeArticleHtml(html)).toBe(html)
  })
})
