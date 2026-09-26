import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/defaults'
import {
  DEFAULT_SEARCH_ENGINES,
  EEA_SEARCH_ENGINES,
  SEARCH_CHOICE_ENGINES,
  searchChoiceEngine
} from '../../shared/search'
import { Browser } from '../browser'
import type { AppHost, Platform, StoreIO, TabView, TabViewHost, WindowHost } from '../platform'
import {
  EEA_REGIONS,
  SEARCH_CHOICE_VERSION,
  isEeaRegion,
  isSearchChoiceEngine,
  newSearchChoiceSeed,
  normalizeRegion,
  resolveSearchChoiceRegion,
  sanitizeSearchChoice,
  searchChoiceRecord,
  searchChoiceRequired,
  searchChoiceState,
  searchChoiceTiles,
  seededShuffle,
  shuffledSearchChoiceTiles
} from '../searchChoice'
import type { ZenWindow } from '../window'

/*
 * The EEA's search-engine choice screen in the core (W6-2; DMA Art. 6(3)): the gate on the OS
 * region and the device's record, the eligible list and its seeded order, `choose` writing the
 * default and the record, `skip` writing nothing, Settings' "ask again", the region override.
 */

const RECORD = { engineId: 'duckduckgo', region: 'DE', madeAt: 1_700_000_000_000, version: 1 }

describe('the region gate', () => {
  it('names the thirty EEA states – the EU twenty-seven and Iceland, Liechtenstein, Norway', () => {
    expect(EEA_REGIONS.size).toBe(30)
    for (const code of ['DE', 'FR', 'IE', 'MT', 'IS', 'LI', 'NO'])
      expect(isEeaRegion(code)).toBe(true)
    for (const code of ['US', 'GB', 'CH', 'TR', 'UA', 'JP', '', null, undefined])
      expect(isEeaRegion(code)).toBe(false)
  })

  it('normalises the OS answer: two letters upper-cased, anything else is no region', () => {
    expect(normalizeRegion('de')).toBe('DE')
    expect(normalizeRegion(' fr ')).toBe('FR')
    expect(normalizeRegion('')).toBeNull()
    expect(normalizeRegion('DEU')).toBeNull()
    expect(normalizeRegion('D')).toBeNull()
    expect(normalizeRegion(12)).toBeNull()
    expect(normalizeRegion(undefined)).toBeNull()
  })

  it('is owed in the EEA with no record, and never outside it', () => {
    expect(searchChoiceRequired({ region: 'DE', record: null })).toBe(true)
    expect(searchChoiceRequired({ region: 'NO', record: null })).toBe(true)
    expect(searchChoiceRequired({ region: 'DE', record: RECORD })).toBe(false)
    expect(searchChoiceRequired({ region: 'US', record: null })).toBe(false)
    expect(searchChoiceRequired({ region: 'GB', record: null })).toBe(false)
    expect(searchChoiceRequired({ region: null, record: null })).toBe(false)
  })

  it('waits for the next run after a skip, and comes whatever the region when Settings asks', () => {
    expect(searchChoiceRequired({ region: 'DE', record: null, skipped: true })).toBe(false)
    expect(searchChoiceRequired({ region: 'US', record: RECORD, askAgain: true })).toBe(true)
    expect(searchChoiceRequired({ region: null, record: null, askAgain: true })).toBe(true)
    // Settings' ask outranks a skip earlier in the run: the row was pressed after it.
    expect(
      searchChoiceRequired({ region: 'DE', record: RECORD, skipped: true, askAgain: true })
    ).toBe(true)
  })

  it('prefers the override to the OS, and treats an empty OS answer as no region', () => {
    expect(resolveSearchChoiceRegion('DE', 'US')).toBe('DE')
    expect(resolveSearchChoiceRegion('de', 'US')).toBe('DE')
    expect(resolveSearchChoiceRegion(null, 'fr')).toBe('FR')
    expect(resolveSearchChoiceRegion(undefined, '')).toBeNull()
    expect(resolveSearchChoiceRegion('', 'IT')).toBe('IT')
    expect(resolveSearchChoiceRegion('junk', null)).toBeNull()
  })

  it('states the terms the chrome reads', () => {
    expect(searchChoiceState({ region: 'DE', record: null, seed: 7 })).toEqual({
      region: 'DE',
      eea: true,
      required: true,
      seed: 7
    })
    expect(searchChoiceState({ region: 'US', record: null, seed: 7 })).toEqual({
      region: 'US',
      eea: false,
      required: false,
      seed: 7
    })
  })
})

describe('the eligible list', () => {
  it('is the shipped web engines and the verified EEA set, each with its own line and no favourite', () => {
    const ids = searchChoiceTiles().map((t) => t.engine.id)
    expect(ids).toEqual(SEARCH_CHOICE_ENGINES.map((e) => e.id))
    expect(ids).toEqual(['google', 'duckduckgo', 'ecosia', 'bing', 'qwant'])
    // Wikipedia ships but is not a web search engine; the dropped EEA engines are not listed.
    for (const id of ['wikipedia', 'brave', 'yahoo', 'startpage']) expect(ids).not.toContain(id)
    for (const tile of searchChoiceTiles()) {
      expect(tile.tagline.length).toBeGreaterThan(0)
      expect(tile.engine.favicon).toMatch(/^https:\/\//)
    }
  })

  it('is the same list in every region – the region gates the screen, not the tiles', () => {
    const tiles = searchChoiceTiles().map((t) => t.engine.id)
    expect(
      shuffledSearchChoiceTiles(1)
        .map((t) => t.engine.id)
        .sort()
    ).toEqual([...tiles].sort())
  })

  it('resolves each tile to a shipped engine or one of the EEA set', () => {
    for (const { id } of SEARCH_CHOICE_ENGINES) {
      const engine = searchChoiceEngine(id)
      expect(engine).not.toBeNull()
      const shipped = DEFAULT_SEARCH_ENGINES.some((e) => e.id === id)
      const eea = EEA_SEARCH_ENGINES.some((e) => e.id === id)
      expect(shipped || eea).toBe(true)
      expect(isSearchChoiceEngine(id)).toBe(true)
    }
    expect(isSearchChoiceEngine('wikipedia')).toBe(false)
    expect(isSearchChoiceEngine('brave')).toBe(false)
    expect(searchChoiceEngine('nope')).toBeNull()
  })
})

describe('the seeded order', () => {
  it('is stable for one seed and different across seeds, over the same members', () => {
    const a = shuffledSearchChoiceTiles(0xc0ffee).map((t) => t.engine.id)
    const again = shuffledSearchChoiceTiles(0xc0ffee).map((t) => t.engine.id)
    expect(again).toEqual(a)
    const orders = new Set<string>()
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
      orders.add(
        shuffledSearchChoiceTiles(seed)
          .map((t) => t.engine.id)
          .join(',')
      )
    expect(orders.size).toBeGreaterThan(1)
    for (const order of orders) expect(order.split(',').sort()).toEqual([...a].sort())
  })

  it('shuffles a copy and leaves the input alone', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8]
    const out = seededShuffle(items, 42)
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect([...out].sort((x, y) => x - y)).toEqual(items)
    expect(seededShuffle(items, 42)).toEqual(out)
    expect(seededShuffle([], 42)).toEqual([])
    expect(seededShuffle(['one'], 42)).toEqual(['one'])
  })

  it('draws a 32-bit seed', () => {
    expect(newSearchChoiceSeed(() => 0)).toBe(0)
    expect(newSearchChoiceSeed(() => 1 - 2 ** -33)).toBe(0xffffffff)
    const seed = newSearchChoiceSeed()
    expect(Number.isInteger(seed)).toBe(true)
    expect(seed).toBeGreaterThanOrEqual(0)
    expect(seed).toBeLessThanOrEqual(0xffffffff)
  })
})

describe('the record', () => {
  it('is the engine, the region the screen was shown for, the time and the version', () => {
    expect(searchChoiceRecord('qwant', 'DE', 5)).toEqual({
      engineId: 'qwant',
      region: 'DE',
      madeAt: 5,
      version: SEARCH_CHOICE_VERSION
    })
    expect(searchChoiceRecord('qwant', null, 5).region).toBe('')
  })

  it('reads a profile: a complete record stands, anything without an engine is no answer', () => {
    expect(sanitizeSearchChoice(RECORD)).toEqual(RECORD)
    expect(sanitizeSearchChoice(null)).toBeNull()
    expect(sanitizeSearchChoice(undefined)).toBeNull()
    expect(sanitizeSearchChoice('duckduckgo')).toBeNull()
    expect(sanitizeSearchChoice({})).toBeNull()
    expect(sanitizeSearchChoice({ engineId: '' })).toBeNull()
    expect(sanitizeSearchChoice({ engineId: 'x'.repeat(129) })).toBeNull()
    // Missing or odd fields fall to their defaults rather than losing the answer.
    expect(sanitizeSearchChoice({ engineId: 'bing' })).toEqual({
      engineId: 'bing',
      region: '',
      madeAt: 0,
      version: SEARCH_CHOICE_VERSION
    })
    expect(
      sanitizeSearchChoice({ engineId: 'bing', region: 'fr', madeAt: Number.NaN, version: 0 })
    ).toEqual({ engineId: 'bing', region: 'FR', madeAt: 0, version: SEARCH_CHOICE_VERSION })
  })
})

/* ---- the browser: choose, skip, ask again ---- */

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

function stub<T extends object>(overrides: Partial<T> = {}): T {
  return new Proxy(overrides as T, {
    get: (target, key) =>
      key in target ? Reflect.get(target, key) : key === 'then' ? undefined : () => undefined
  })
}

function fakePlatform(io: StoreIO, region: string | null | undefined): Platform {
  return {
    info: { os: 'linux' as PlatformOs, version: '0.0.0', region },
    capabilities: stub<HostCapabilities>({ windows: false, updates: false, agents: false }),
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
    readabilitySource: () => null
  }
}

function setup(
  region: string | null | undefined,
  files: Record<string, string> = {}
): { browser: Browser; win: ZenWindow; io: ReturnType<typeof memoryIo> } {
  const io = memoryIo(files)
  const browser = new Browser(fakePlatform(io, region))
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  return { browser, win, io }
}

async function persisted(
  browser: Browser,
  io: ReturnType<typeof memoryIo>
): Promise<Record<string, unknown>> {
  await browser.state.flush()
  return JSON.parse(io.files['state.json']).settings
}

/** What the disk holds of the choice: the default engine and the record (the run writes other things). */
async function persistedChoice(
  browser: Browser,
  io: ReturnType<typeof memoryIo>
): Promise<{ searchEngineId: unknown; searchChoice: unknown }> {
  const settings = await persisted(browser, io)
  return { searchEngineId: settings.searchEngineId, searchChoice: settings.searchChoice ?? null }
}

describe('the browser', () => {
  it('owes the screen on a fresh EEA profile and states the region, lower-cased or not', () => {
    const { browser, win } = setup('de')
    const s = browser.state.snapshot(win).searchChoice
    expect(s).toMatchObject({ region: 'DE', eea: true, required: true })
    expect(Number.isInteger(s.seed)).toBe(true)
    expect(browser.state.settings.searchChoice).toBeNull()
    expect(browser.state.settings.searchEngineId).toBe(DEFAULT_SETTINGS.searchEngineId)
  })

  it('owes nothing outside the EEA, or when the OS does not know its region', () => {
    expect(setup('US').browser.state.snapshot(setup('US').win).searchChoice).toMatchObject({
      region: 'US',
      eea: false,
      required: false
    })
    const { browser, win } = setup('')
    expect(browser.state.snapshot(win).searchChoice).toMatchObject({
      region: null,
      eea: false,
      required: false
    })
    expect(
      setup(undefined).browser.state.snapshot(setup(undefined).win).searchChoice.required
    ).toBe(false)
  })

  it('keeps one order for the run: every window reads the same seed', () => {
    const { browser, win } = setup('DE')
    const second = browser.createWindow({ kind: 'synced' })
    expect(browser.state.snapshot(second).searchChoice.seed).toBe(
      browser.state.snapshot(win).searchChoice.seed
    )
  })

  it('choose writes the default and the record together, and the screen is not owed again', async () => {
    const { browser, win, io } = setup('DE')
    const before = Date.now()
    browser.handleCommand(win, 'searchChoice.choose', { engineId: 'duckduckgo' })

    expect(browser.state.settings.searchEngineId).toBe('duckduckgo')
    expect(browser.state.settings.searchChoice).toMatchObject({
      engineId: 'duckduckgo',
      region: 'DE',
      version: SEARCH_CHOICE_VERSION
    })
    expect(browser.state.settings.searchChoice!.madeAt).toBeGreaterThanOrEqual(before)
    expect(browser.state.snapshot(win).searchChoice.required).toBe(false)
    // Both fields reach the disk in one commit.
    const saved = await persisted(browser, io)
    expect(saved.searchEngineId).toBe('duckduckgo')
    expect(saved.searchChoice).toMatchObject({ engineId: 'duckduckgo', region: 'DE' })
    // A shipped engine is not copied into the user's list.
    expect(browser.state.settings.searchEngines ?? []).toEqual([])
  })

  it("choose of an EEA-set engine copies it into the user's list so the id resolves everywhere", () => {
    const { browser, win } = setup('FR')
    browser.handleCommand(win, 'searchChoice.choose', { engineId: 'qwant' })

    expect(browser.state.settings.searchEngineId).toBe('qwant')
    const own = browser.state.settings.searchEngines ?? []
    expect(own).toHaveLength(1)
    expect(own[0]).toMatchObject({ id: 'qwant', name: 'Qwant', source: 'custom' })
    expect(browser.state.searchEngines.some((e) => e.id === 'qwant')).toBe(true)
    expect(browser.state.settings.searchChoice).toMatchObject({ engineId: 'qwant', region: 'FR' })

    // Chosen again: no second copy.
    browser.handleCommand(win, 'searchChoice.choose', { engineId: 'qwant' })
    expect(browser.state.settings.searchEngines).toHaveLength(1)
  })

  it('choose of an engine not on the screen writes nothing', async () => {
    const { browser, win, io } = setup('DE')
    for (const engineId of ['wikipedia', 'brave', 'nope', ''])
      browser.handleCommand(win, 'searchChoice.choose', { engineId })
    expect(browser.state.settings.searchEngineId).toBe(DEFAULT_SETTINGS.searchEngineId)
    expect(browser.state.settings.searchChoice).toBeNull()
    expect(browser.state.snapshot(win).searchChoice.required).toBe(true)
    expect(await persistedChoice(browser, io)).toEqual({
      searchEngineId: DEFAULT_SETTINGS.searchEngineId,
      searchChoice: null
    })
  })

  it('skip writes nothing and holds the screen for this run only', async () => {
    const { browser, win, io } = setup('DE')
    browser.handleCommand(win, 'searchChoice.skip', undefined)

    expect(browser.state.settings.searchChoice).toBeNull()
    expect(browser.state.settings.searchEngineId).toBe(DEFAULT_SETTINGS.searchEngineId)
    expect(await persistedChoice(browser, io)).toEqual({
      searchEngineId: DEFAULT_SETTINGS.searchEngineId,
      searchChoice: null
    })
    expect(browser.state.snapshot(win).searchChoice.required).toBe(false)

    // The next run, from the same (unwritten) profile: asked again.
    const next = setup('DE', { ...io.files })
    expect(next.browser.state.snapshot(next.win).searchChoice.required).toBe(true)
  })

  it('a recorded profile is not asked again, and the record survives a reload', async () => {
    const first = setup('DE')
    first.browser.handleCommand(first.win, 'searchChoice.choose', { engineId: 'bing' })
    await first.browser.state.flush()
    const next = setup('DE', { ...first.io.files })
    expect(next.browser.state.settings.searchChoice).toMatchObject({
      engineId: 'bing',
      region: 'DE'
    })
    expect(next.browser.state.snapshot(next.win).searchChoice.required).toBe(false)
  })

  it('Settings asks again whatever the region, and the answer – or a skip – ends the ask', () => {
    const { browser, win } = setup('US')
    expect(browser.state.snapshot(win).searchChoice.required).toBe(false)

    browser.handleCommand(win, 'searchChoice.askAgain', undefined)
    expect(browser.state.snapshot(win).searchChoice.required).toBe(true)

    browser.handleCommand(win, 'searchChoice.skip', undefined)
    expect(browser.state.snapshot(win).searchChoice.required).toBe(false)

    browser.handleCommand(win, 'searchChoice.askAgain', undefined)
    browser.handleCommand(win, 'searchChoice.choose', { engineId: 'ecosia' })
    expect(browser.state.snapshot(win).searchChoice.required).toBe(false)
    expect(browser.state.settings.searchChoice).toMatchObject({ engineId: 'ecosia', region: 'US' })
  })

  it('reads a junk record off the disk as no record', () => {
    const { browser, win } = setup('DE', {
      'state.json': JSON.stringify({
        version: 2,
        settings: { ...DEFAULT_SETTINGS, searchChoice: { madeAt: 1 } }
      })
    })
    expect(browser.state.settings.searchChoice).toBeNull()
    expect(browser.state.snapshot(win).searchChoice.required).toBe(true)
  })
})
