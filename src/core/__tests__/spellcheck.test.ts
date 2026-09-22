import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import {
  DEFAULT_SPELLCHECK,
  UNAVAILABLE_SPELLCHECK,
  type SpellcheckDictionaryStatus
} from '../../shared/spellcheck'
import { Browser } from '../browser'
import type {
  AppHost,
  Platform,
  ShellHost,
  SpellcheckHost,
  StoreIO,
  TabView,
  TabViewHost,
  WindowHost
} from '../platform'
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

interface Applied {
  enabled: boolean
  languages: string[]
}

/**
 * Chromium's session spellchecker as the core sees it: records every `apply`, keeps a custom
 * dictionary, and lets the test report on a dictionary's download.
 */
interface FakeSpellcheckHost extends SpellcheckHost {
  applied: Applied[]
  words: Set<string>
  report: (code: string, status: SpellcheckDictionaryStatus) => void
}

function fakeHost(
  available: string[],
  locales: string[],
  systemLanguages = false
): FakeSpellcheckHost {
  const applied: Applied[] = []
  const words = new Set<string>()
  const listeners: ((code: string, status: SpellcheckDictionaryStatus) => void)[] = []
  return {
    applied,
    words,
    report: (code, status) => listeners.forEach((l) => l(code, status)),
    systemLanguages,
    locales,
    availableLanguages: () => [...available],
    apply: (enabled, languages) => void applied.push({ enabled, languages: [...languages] }),
    onDictionaryStatus: (listener) => void listeners.push(listener),
    listWords: async () => [...words],
    addWord: async (word) => {
      if (words.has(word)) return false
      words.add(word)
      return true
    },
    removeWord: async (word) => words.delete(word)
  }
}

interface Options {
  /** The host's dictionaries; none makes an Android-shaped host without a spellchecker. */
  available?: string[] | null
  locales?: string[]
  systemLanguages?: boolean
  io?: StoreIO
}

function fakePlatform(
  options: Options
): Platform & { host: FakeSpellcheckHost | undefined; viewWords: string[]; opened: string[] } {
  const host =
    options.available === null
      ? undefined
      : fakeHost(
          options.available ?? ['en-US', 'en-GB', 'de', 'fr'],
          options.locales ?? ['en-US'],
          options.systemLanguages
        )
  const viewWords: string[] = []
  const opened: string[] = []
  return {
    host,
    viewWords,
    opened,
    // A fresh profile's preferred languages are the OS's (CT-41): the same locales the host's
    // spellchecker reports as the UI's, as on a real host.
    info: {
      os: (host ? 'linux' : 'android') as PlatformOs,
      version: '0.0.0',
      locales: options.locales ?? ['en-US']
    },
    capabilities: stub<HostCapabilities>({ windows: Boolean(host), updates: false, agents: false }),
    io: options.io ?? memoryIo(),
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
      createView: () =>
        stub<TabView>({
          isDestroyed: () => false,
          isVisible: () => false,
          getZoom: () => 1,
          addWordToDictionary: (word: string) => void viewWords.push(word)
        })
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub<ShellHost>({ openKeyboardSettings: () => void opened.push('keyboard') }),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub<AppHost>(),
    readabilitySource: () => null,
    ...(host ? { spellcheck: host } : {})
  }
}

function start(options: Options = {}): {
  browser: Browser
  platform: ReturnType<typeof fakePlatform>
  host: FakeSpellcheckHost
  win: ZenWindow
} {
  const platform = fakePlatform(options)
  const browser = new Browser(platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  return { browser, platform, host: platform.host as FakeSpellcheckHost, win }
}

function last<T>(list: T[]): T | undefined {
  return list[list.length - 1]
}

function saved(io: { files: Record<string, string> }): unknown {
  return JSON.parse(io.files['state.json']).settings.spellcheck
}

describe('spell check in the browser', () => {
  it('checks the UI language’s dictionary in a fresh profile, once, at start', () => {
    const { browser, host } = start({ locales: ['en-GB', 'de'] })
    expect(host.applied).toEqual([{ enabled: true, languages: ['en-GB'] }])
    expect(browser.spellcheck.languages()).toEqual(['en-GB'])
    // The setting itself stays "not chosen": a later UI language would bring its own dictionary.
    expect(browser.state.settings.spellcheck).toEqual(DEFAULT_SPELLCHECK)
  })

  it('falls from a UI locale without a dictionary to the next, then to nothing', () => {
    expect(start({ locales: ['ja', 'de-AT'] }).host.applied).toEqual([
      { enabled: true, languages: ['de'] }
    ])
    const { browser, host } = start({ locales: ['ja'] })
    expect(host.applied).toEqual([{ enabled: true, languages: [] }])
    expect(browser.spellcheck.languages()).toEqual([])
  })

  it('lists every dictionary in Settings: the checked ones first with their status, the rest by name', () => {
    const { browser, host } = start({ available: ['nl', 'en-US', 'de', 'fr'], locales: ['en-US'] })
    const status = browser.spellcheck.uiState()
    expect(status.available).toBe(true)
    expect(status.systemLanguages).toBe(false)
    expect(status.languages.map((l) => [l.code, l.name, l.enabled, l.status])).toEqual([
      ['en-US', 'English (United States)', true, 'unknown'],
      ['nl', 'Dutch', false, 'unknown'],
      ['fr', 'French', false, 'unknown'],
      ['de', 'German', false, 'unknown']
    ])
    host.report('en-US', 'downloading')
    expect(browser.spellcheck.uiState().languages[0].status).toBe('downloading')
    host.report('en-US', 'ready')
    expect(browser.spellcheck.uiState().languages[0].status).toBe('ready')
  })

  it('turns the checker off and on through the setting, keeping the languages', async () => {
    const io = memoryIo()
    const { browser, host, win } = start({ io })
    browser.handleCommand(win, 'spellcheck.setEnabled', { enabled: false })
    expect(last(host.applied)).toEqual({ enabled: false, languages: ['en-US'] })
    expect(browser.spellcheck.languages()).toEqual([])
    expect(browser.spellcheck.uiState().languages[0]).toMatchObject({
      code: 'en-US',
      enabled: true
    })
    // The same value again is not a change.
    browser.handleCommand(win, 'spellcheck.setEnabled', { enabled: false })
    expect(host.applied).toHaveLength(2)
    browser.handleCommand(win, 'spellcheck.setEnabled', { enabled: true })
    expect(last(host.applied)).toEqual({ enabled: true, languages: ['en-US'] })
    await new Promise((r) => setImmediate(r))
    await browser.state.flush()
    expect(saved(io)).toEqual({ enabled: true, languages: [] })
  })

  it('adds and removes languages, up to Chrome’s limit, and persists the choice', async () => {
    const io = memoryIo()
    const { browser, host, win } = start({
      io,
      available: ['en-US', 'en-GB', 'de', 'fr', 'es', 'nl', 'it'],
      locales: ['en-US']
    })
    browser.handleCommand(win, 'spellcheck.setLanguage', { code: 'de', on: true })
    expect(last(host.applied)).toEqual({ enabled: true, languages: ['en-US', 'de'] })
    expect(browser.state.settings.spellcheck.languages).toEqual(['en-US', 'de'])
    // A dictionary the host does not have is not a language.
    browser.handleCommand(win, 'spellcheck.setLanguage', { code: 'ja', on: true })
    expect(host.applied).toHaveLength(2)
    for (const code of ['fr', 'es', 'nl']) {
      browser.handleCommand(win, 'spellcheck.setLanguage', { code, on: true })
    }
    expect(browser.spellcheck.languages()).toEqual(['en-US', 'de', 'fr', 'es', 'nl'])
    // The sixth is refused (Chrome greys the toggle at five).
    browser.handleCommand(win, 'spellcheck.setLanguage', { code: 'it', on: true })
    expect(browser.spellcheck.languages()).toEqual(['en-US', 'de', 'fr', 'es', 'nl'])
    browser.handleCommand(win, 'spellcheck.setLanguage', { code: 'de', on: false })
    expect(browser.spellcheck.languages()).toEqual(['en-US', 'fr', 'es', 'nl'])
    await new Promise((r) => setImmediate(r))
    await browser.state.flush()
    expect(saved(io)).toEqual({ enabled: true, languages: ['en-US', 'fr', 'es', 'nl'] })
  })

  it('turning the last language off turns the checker off; the switch brings it back', () => {
    const { browser, host, win } = start()
    browser.handleCommand(win, 'spellcheck.setLanguage', { code: 'en-US', on: false })
    expect(browser.state.settings.spellcheck).toEqual({ enabled: false, languages: ['en-US'] })
    expect(last(host.applied)).toEqual({ enabled: false, languages: ['en-US'] })
    expect(browser.spellcheck.languages()).toEqual([])
    browser.handleCommand(win, 'spellcheck.setEnabled', { enabled: true })
    expect(browser.spellcheck.languages()).toEqual(['en-US'])
  })

  it('forgets a dictionary’s status once its language is no longer checked', () => {
    const { browser, host, win } = start()
    browser.handleCommand(win, 'spellcheck.setLanguage', { code: 'de', on: true })
    host.report('de', 'failed')
    expect(browser.spellcheck.uiState().languages.find((l) => l.code === 'de')!.status).toBe(
      'failed'
    )
    browser.handleCommand(win, 'spellcheck.setLanguage', { code: 'de', on: false })
    expect(browser.spellcheck.uiState().languages.find((l) => l.code === 'de')!.status).toBe(
      'unknown'
    )
  })

  it('applies a settings patch (a sync merge) to the host as well', () => {
    const { browser, host, win } = start()
    browser.handleCommand(win, 'settings.update', {
      spellcheck: { enabled: true, languages: ['de', 'fr'] }
    })
    expect(last(host.applied)).toEqual({ enabled: true, languages: ['de', 'fr'] })
    expect(
      browser.spellcheck
        .uiState()
        .languages.slice(0, 2)
        .map((l) => l.code)
    ).toEqual(['de', 'fr'])
  })

  it('shows the OS’s languages without offering to change them on a host that follows them', () => {
    const { browser, host, win } = start({ systemLanguages: true, locales: ['en-US', 'de'] })
    // macOS: the list is the OS's; the core hands the host nothing to check in.
    expect(host.applied).toEqual([{ enabled: true, languages: [] }])
    expect(browser.spellcheck.uiState().systemLanguages).toBe(true)
    browser.handleCommand(win, 'spellcheck.setLanguage', { code: 'de', on: true })
    expect(browser.state.settings.spellcheck).toEqual(DEFAULT_SPELLCHECK)
    expect(host.applied).toHaveLength(1)
    // The switch still works.
    browser.handleCommand(win, 'spellcheck.setEnabled', { enabled: false })
    expect(last(host.applied)).toEqual({ enabled: false, languages: [] })
  })

  it('keeps one custom dictionary per profile, sorted, through the host', async () => {
    const { browser, host, platform, win } = start()
    expect(await browser.spellcheck.addWord('Zenium')).toBe(true)
    expect(await browser.spellcheck.addWord('Zenium')).toBe(false)
    expect(await browser.spellcheck.addWord('  ')).toBe(false)
    expect(await browser.spellcheck.addWord('two words')).toBe(false)
    expect(await browser.handleCommand(win, 'spellcheck.addWord', { word: 'anfangen' })).toBe(true)
    expect(await browser.handleCommand(win, 'spellcheck.words', {})).toEqual(['anfangen', 'Zenium'])
    expect(await browser.handleCommand(win, 'spellcheck.removeWord', { word: 'Zenium' })).toBe(true)
    expect([...host.words]).toEqual(['anfangen'])
    // With a spellchecker of its own the profile's dictionary takes the word, not the view's session.
    const tab = browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    await browser.spellcheck.addWord('Zen', browser.tabs.view(tab.id))
    expect(platform.viewWords).toEqual([])
  })

  it('on a host without a spellchecker reports the limit and leaves the words to the view', async () => {
    const { browser, platform, win } = start({ available: null })
    expect(browser.spellcheck.available).toBe(false)
    expect(browser.spellcheck.uiState()).toEqual(UNAVAILABLE_SPELLCHECK)
    expect(browser.spellcheck.languages()).toEqual([])
    browser.handleCommand(win, 'spellcheck.setLanguage', { code: 'de', on: true })
    expect(browser.state.settings.spellcheck).toEqual(DEFAULT_SPELLCHECK)
    expect(await browser.handleCommand(win, 'spellcheck.words', {})).toEqual([])
    expect(await browser.handleCommand(win, 'spellcheck.addWord', { word: 'Zenium' })).toBe(false)
    // "Add to Dictionary" from a page still reaches the WebView's own session.
    const tab = browser.tabs.createTab({ url: 'https://example.com/', active: true }, win)
    expect(await browser.spellcheck.addWord('Zenium', browser.tabs.view(tab.id))).toBe(true)
    expect(platform.viewWords).toEqual(['Zenium'])
    // Android's way to the system checker.
    browser.handleCommand(win, 'spellcheck.openKeyboardSettings', {})
    expect(platform.opened).toEqual(['keyboard'])
  })
})
