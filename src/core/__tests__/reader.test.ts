import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs, Tab } from '../../shared/types'
import {
  DEFAULT_READER_PREFERENCES,
  READER_IMAGES_ATTRIBUTE,
  READER_LINKS_ATTRIBUTE
} from '../../shared/reader'
import { Browser } from '../browser'
import type { AppHost, Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import { READER_URL_PREFIX, readerArticleId, sanitizeArticleHtml } from '../reader'
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
      // One page per tab, as on the phone: the reader loads as a navigation of the tab.
      createCover: undefined,
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

const PAGE_URL = 'https://example.com/a'

/**
 * A tab reading `PAGE_URL` in Reader View: the article held by the service and the tab on the
 * reader document's own address (a bare `zen://reader` address whose article the service does
 * not hold wakes on the page instead – `TabManager.load`).
 */
function readerTab(browser: Browser, win: ZenWindow, active: boolean): Tab {
  const tab = browser.tabs.createTab({ url: PAGE_URL, active }, win)
  browser.reader.open(tab.id, { title: 'A', content: '<p>a</p>', length: 1 })
  expect(tab.url.startsWith(`${READER_URL_PREFIX}?id=`)).toBe(true)
  return tab
}

/** The preferences a `zenReaderApply` call handed the page, or null for a script that is not one. */
function applied(script: string): Record<string, unknown> | null {
  const m = /window\.zenReaderApply\((.*)\)$/.exec(script)
  return m ? (JSON.parse(m[1]) as Record<string, unknown>) : null
}

describe('reader text preferences in the browser', () => {
  it('saves a change and pushes it to every open reader page, not to the web pages', async () => {
    const { browser, platform, win, io } = start()
    const reader = readerTab(browser, win, true)
    const second = readerTab(browser, win, false)
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
    const reader = readerTab(browser, win, true)
    browser.handleCommand(win, 'reader.setPreferences', { fontSize: 13, font: 'comic' })
    browser.handleCommand(win, 'reader.setPreferences', { theme: 'auto' })
    expect(browser.reader.preferences()).toEqual(DEFAULT_READER_PREFERENCES)
    expect(platform.scripts.get(reader.id)!.map(applied).filter(Boolean)).toEqual([])
  })

  it('renders a reader page with the saved preferences and follows a settings patch', () => {
    const { browser, platform, win } = start()
    const reader = readerTab(browser, win, true)
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

describe('the Links and Images toggles (reader-12)', () => {
  it('render as root attributes of the reader document only while off, and reach an open reader as a patch', () => {
    const { browser, platform, win } = start()
    const tab = readerTab(browser, win, true)
    const id = readerArticleId(tab.url)!
    const html = (): string => browser.reader.pageHtml(id) ?? ''
    // On by default: the document carries neither attribute (the stylesheet's off rules sleep).
    expect(browser.reader.preferences()).toMatchObject({ links: true, images: true })
    expect(html()).not.toContain(`${READER_LINKS_ATTRIBUTE}="off"`)
    expect(html()).not.toContain(`${READER_IMAGES_ATTRIBUTE}="off"`)
    // The document's own rules for the two states.
    expect(html()).toContain(`:root[${READER_LINKS_ATTRIBUTE}='off'] article a`)
    expect(html()).toContain(`:root[${READER_IMAGES_ATTRIBUTE}='off'] article`)

    browser.handleCommand(win, 'reader.setPreferences', { links: false })
    expect(html()).toContain(`${READER_LINKS_ATTRIBUTE}="off"`)
    expect(html()).not.toContain(`${READER_IMAGES_ATTRIBUTE}="off"`)
    browser.handleCommand(win, 'reader.setPreferences', { images: false })
    expect(html()).toContain(`${READER_IMAGES_ATTRIBUTE}="off"`)
    // Each change went to the open reader page as the whole preferences record.
    const pushes = platform.scripts.get(tab.id)!.map(applied).filter(Boolean)
    expect(pushes).toEqual([
      { ...DEFAULT_READER_PREFERENCES, links: false },
      { ...DEFAULT_READER_PREFERENCES, links: false, images: false }
    ])
    // Back on: the attributes go.
    browser.handleCommand(win, 'reader.setPreferences', { links: true, images: true })
    expect(html()).not.toContain('="off"')
  })

  it('are saved with the reader preferences and come back on the next start', async () => {
    const { browser, win, io } = start()
    browser.handleCommand(win, 'reader.setPreferences', { links: false, images: false })
    await new Promise((r) => setImmediate(r))
    await browser.state.flush()
    expect(JSON.parse(io.files['state.json']).settings.reader).toMatchObject({
      links: false,
      images: false
    })
    const { browser: reloaded } = start(memoryIo({ ...io.files }))
    expect(reloaded.reader.preferences()).toMatchObject({ links: false, images: false })
    // A stored value that is not a boolean reads as the default.
    const { browser: odd } = start(
      memoryIo({
        'state.json': JSON.stringify({
          version: 2,
          settings: { reader: { links: 'no', images: 0 } },
          tabs: [],
          spaces: []
        })
      })
    )
    expect(odd.reader.preferences()).toMatchObject({ links: true, images: true })
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
