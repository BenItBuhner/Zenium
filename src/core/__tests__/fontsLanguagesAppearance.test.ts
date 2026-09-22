import { describe, expect, it } from 'vitest'
import type { ColorScheme, HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { DEFAULT_FONT_SETTINGS, type PageFontSettings } from '../../shared/fonts'
import { Browser } from '../browser'
import type {
  AppHost,
  Platform,
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

interface Recorded {
  themes: ColorScheme[]
  fonts: PageFontSettings[]
  languages: string[][]
  spellcheck: Array<{ enabled: boolean; languages: string[] }>
}

/**
 * A platform with no windows, pages or dialogs, but the engine hosts of the four rows: the
 * theme source (CT-23), the page fonts (CT-25), the sessions' languages and a spellchecker
 * (CT-41), every one recording what it was given.
 */
function fakePlatform(
  io: StoreIO,
  options: { locales?: string[]; dictionaries?: string[]; pageLanguages?: boolean } = {}
): Platform & { recorded: Recorded } {
  const recorded: Recorded = { themes: [], fonts: [], languages: [], spellcheck: [] }
  const pageLanguages = options.pageLanguages ?? true
  const locales = options.locales ?? ['en-US', 'en-US']
  const capabilities = stub<HostCapabilities>({
    windows: false,
    updates: false,
    agents: false,
    pageLanguages
  })
  const spellcheck: SpellcheckHost = {
    systemLanguages: false,
    locales,
    availableLanguages: () => options.dictionaries ?? ['en-US', 'de-DE', 'fr'],
    apply: (enabled, languages) => void recorded.spellcheck.push({ enabled, languages: [...languages] }),
    onDictionaryStatus: () => {},
    words: () => [],
    addWord: () => {},
    removeWord: () => {}
  } as unknown as SpellcheckHost
  return {
    recorded,
    info: { os: 'linux' as PlatformOs, version: '0.0.0', locales },
    capabilities,
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
      createView: () => stub<TabView>({ isDestroyed: () => false, isVisible: () => false })
    }),
    menus: stub(),
    dialogs: stub(),
    clipboard: stub(),
    shell: stub(),
    net: stub(),
    downloads: stub(),
    sessions: stub(),
    app: stub<AppHost>(),
    theme: {
      systemDark: () => false,
      onChanged: () => {},
      setSource: (scheme) => void recorded.themes.push(scheme)
    },
    pageFonts: { apply: (fonts) => void recorded.fonts.push({ ...fonts }) },
    ...(pageLanguages ? { languages: { apply: (list) => void recorded.languages.push([...list]) } } : {}),
    spellcheck,
    readabilitySource: () => null
  }
}

function started(
  io: StoreIO,
  options?: Parameters<typeof fakePlatform>[1]
): { browser: Browser; platform: ReturnType<typeof fakePlatform>; win: ZenWindow } {
  const platform = fakePlatform(io, options)
  const browser = new Browser(platform)
  browser.start()
  return { browser, platform, win: browser.allWindows()[0] as ZenWindow }
}

const persisted = (settings: Record<string, unknown>): StoreIO =>
  memoryIo({ 'state.json': JSON.stringify({ version: 2, settings, tabs: [], spaces: [] }) })

async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r))
}

describe('appearance follows Settings.colorScheme in the engine (CT-23)', () => {
  it('hands the scheme to the engine once at start and once per change, never for the same value', async () => {
    const { browser, platform, win } = started(memoryIo())
    expect(platform.recorded.themes).toEqual(['system'])
    browser.handleCommand(win, 'settings.update', { colorScheme: 'dark' })
    expect(browser.state.settings.colorScheme).toBe('dark')
    expect(platform.recorded.themes).toEqual(['system', 'dark'])
    browser.handleCommand(win, 'settings.update', { colorScheme: 'dark' })
    // The state's broadcast (any commit) is not a change either.
    browser.state.commit()
    await settle()
    expect(platform.recorded.themes).toEqual(['system', 'dark'])
    browser.handleCommand(win, 'settings.update', { colorScheme: 'light' })
    expect(platform.recorded.themes).toEqual(['system', 'dark', 'light'])
  })

  it('applies a persisted scheme at the next start, and a scheme written without updateSettings (a sync merge)', async () => {
    const { browser, platform } = started(persisted({ colorScheme: 'dark' }))
    expect(platform.recorded.themes).toEqual(['dark'])
    browser.state.settings.colorScheme = 'light'
    browser.state.commit()
    await settle()
    expect(platform.recorded.themes).toEqual(['dark', 'light'])
  })
})

describe('page fonts (CT-25)', () => {
  it('starts a fresh profile on the engine’s fonts and hands them over once', async () => {
    const { browser, platform } = started(memoryIo())
    expect(browser.state.settings.fonts).toEqual(DEFAULT_FONT_SETTINGS)
    expect(platform.recorded.fonts).toEqual([DEFAULT_FONT_SETTINGS])
    browser.state.commit()
    await settle()
    expect(platform.recorded.fonts).toHaveLength(1)
  })

  it('changes through settings.update as a patch, sanitised, reaches the host and is persisted', async () => {
    const io = memoryIo()
    const { browser, platform, win } = started(io)
    browser.handleCommand(win, 'settings.update', { fonts: { standard: 'Georgia', size: 20 } })
    expect(browser.state.settings.fonts).toEqual({ ...DEFAULT_FONT_SETTINGS, standard: 'Georgia', size: 20 })
    browser.handleCommand(win, 'settings.update', { fonts: { minimumSize: 3, size: 500 } })
    expect(browser.state.settings.fonts).toEqual({
      ...DEFAULT_FONT_SETTINGS,
      standard: 'Georgia',
      size: 72,
      minimumSize: 6
    })
    expect(platform.recorded.fonts.map((f) => [f.standard, f.size, f.minimumSize])).toEqual([
      [null, 16, 0],
      ['Georgia', 20, 0],
      ['Georgia', 72, 6]
    ])
    // The same fonts again are not an event for the host.
    browser.handleCommand(win, 'settings.update', { fonts: { size: 72 } })
    expect(platform.recorded.fonts).toHaveLength(3)
    await settle()
    await browser.state.flush()
    expect(JSON.parse(io.files['state.json']).settings.fonts).toEqual(browser.state.settings.fonts)
  })

  it('loads a persisted document, sanitising it, and follows one written by a sync merge', async () => {
    const { browser, platform } = started(
      persisted({ fonts: { standard: '"Noto Serif"', size: 15.6, minimumSize: 30, fixed: 7 } })
    )
    expect(browser.state.settings.fonts).toEqual({
      ...DEFAULT_FONT_SETTINGS,
      standard: 'Noto Serif',
      size: 16,
      minimumSize: 24
    })
    expect(platform.recorded.fonts).toEqual([browser.state.settings.fonts])
    browser.state.settings.fonts = { ...DEFAULT_FONT_SETTINGS, sansSerif: 'Inter' }
    browser.state.commit()
    await settle()
    expect(platform.recorded.fonts.at(-1)?.sansSerif).toBe('Inter')
    expect(browser.pageFonts.fonts.sansSerif).toBe('Inter')
  })
})

describe('preferred languages (CT-41)', () => {
  it('starts a fresh profile from the OS languages, expanded like Chrome’s, and hands them to the sessions', () => {
    const { browser, platform } = started(memoryIo(), { locales: ['de-DE', 'de-DE', 'en-GB'] })
    expect(browser.state.settings.languages).toEqual(['de-DE', 'de', 'en-GB', 'en'])
    expect(platform.recorded.languages).toEqual([['de-DE', 'de', 'en-GB', 'en']])
    expect(browser.languages.acceptLanguage()).toBe('de-DE,de;q=0.9,en-GB;q=0.8,en;q=0.7')
    expect(browser.languages.pagesFollow).toBe(true)
    // Translate reads the list as the languages the user reads, the default target first.
    expect(browser.translate.preferences.preferred).toEqual(['de', 'en'])
    // Spellcheck, with no dictionary chosen, checks in the first preferred language that has one.
    expect(platform.recorded.spellcheck.at(-1)).toEqual({ enabled: true, languages: ['de-DE'] })
  })

  it('falls back to English when the OS names no language', () => {
    const { browser } = started(memoryIo(), { locales: [] })
    expect(browser.state.settings.languages).toEqual(['en-US', 'en'])
  })

  it('changes through settings.update: the sessions, translate and spellcheck follow, and it is persisted', async () => {
    const io = memoryIo()
    const { browser, platform, win } = started(io)
    expect(browser.state.settings.languages).toEqual(['en-US', 'en'])
    browser.handleCommand(win, 'settings.update', { languages: ['fr-fr', 'FR', 'en-US', 'fr', 'C'] })
    expect(browser.state.settings.languages).toEqual(['fr-FR', 'fr', 'en-US'])
    expect(platform.recorded.languages).toEqual([['en-US', 'en'], ['fr-FR', 'fr', 'en-US']])
    expect(browser.languages.acceptLanguage()).toBe('fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7')
    expect(browser.translate.preferences.preferred).toEqual(['fr', 'en'])
    expect(platform.recorded.spellcheck.at(-1)).toEqual({ enabled: true, languages: ['fr'] })
    // A list with nothing valid leaves the current one standing (Chrome keeps its last language).
    browser.handleCommand(win, 'settings.update', { languages: ['C', ''] })
    expect(browser.state.settings.languages).toEqual(['fr-FR', 'fr', 'en-US'])
    expect(platform.recorded.languages).toHaveLength(2)
    await settle()
    await browser.state.flush()
    expect(JSON.parse(io.files['state.json']).settings.languages).toEqual(['fr-FR', 'fr', 'en-US'])
  })

  it('keeps a persisted list as it stands, ahead of the OS, and follows a sync merge', async () => {
    const { browser, platform } = started(persisted({ languages: ['ja', 'en-US'] }), {
      locales: ['de-DE']
    })
    expect(browser.state.settings.languages).toEqual(['ja', 'en-US'])
    expect(platform.recorded.languages).toEqual([['ja', 'en-US']])
    browser.state.settings.languages = ['es-419', 'es']
    browser.state.commit()
    await settle()
    expect(platform.recorded.languages.at(-1)).toEqual(['es-419', 'es'])
    expect(browser.translate.preferences.preferred).toEqual(['es'])
  })

  it('records the limit of a host whose pages send the system languages (Android)', () => {
    const { browser, platform } = started(memoryIo(), { pageLanguages: false, locales: ['it-IT'] })
    expect(browser.languages.pagesFollow).toBe(false)
    expect(platform.recorded.languages).toEqual([])
    // The list still stands, for translate and spellcheck.
    expect(browser.state.settings.languages).toEqual(['it-IT', 'it'])
    expect(browser.translate.preferences.preferred).toEqual(['it'])
  })
})
