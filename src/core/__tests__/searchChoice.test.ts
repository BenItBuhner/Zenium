import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/defaults'
import {
  DEFAULT_SEARCH_ENGINES,
  EEA_SEARCH_CHOICE,
  SEARCH_CHOICE_ALIASES,
  SEARCH_CHOICE_EXTRA_ENGINES,
  SEARCH_CHOICE_FALLBACK,
  searchChoiceEngine,
  searchChoiceTagline
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
  searchChoiceListRegion,
  searchChoiceRecord,
  searchChoiceRequired,
  searchChoiceShownFor,
  searchChoiceState,
  searchChoiceTiles,
  seededShuffle,
  shuffledSearchChoiceTiles
} from '../searchChoice'
import type { ZenWindow } from '../window'

/*
 * The EEA's search-engine choice screen in the core (W6-2; DMA Art. 6(3)): the gate on the OS
 * region and the device's record, each country's list (Chrome's table) and its seeded order,
 * `choose` writing the default and the record, `skip` writing nothing, Settings' "ask again",
 * the region override.
 */

const RECORD = { engineId: 'duckduckgo', region: 'DE', madeAt: 1_700_000_000_000, version: 1 }

describe('the region gate', () => {
  it("names Chrome's forty-seven: the thirty EEA states and the seventeen territories on a member's list", () => {
    expect(Object.keys(EEA_SEARCH_CHOICE)).toHaveLength(30)
    expect(Object.keys(SEARCH_CHOICE_ALIASES)).toHaveLength(17)
    expect(EEA_REGIONS.size).toBe(47)
    for (const code of ['DE', 'FR', 'IE', 'MT', 'IS', 'LI', 'NO', 'AX', 'RE', 'IC', 'SJ', 'VA'])
      expect(isEeaRegion(code)).toBe(true)
    // Not Chrome's: the UK, Switzerland, San Marino, Andorra, the Faroes, Greenland.
    for (const code of ['US', 'GB', 'CH', 'SM', 'AD', 'FO', 'GL', 'TR', 'UA', 'JP', '', null])
      expect(isEeaRegion(code)).toBe(false)
    expect(isEeaRegion(undefined)).toBe(false)
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
    expect(searchChoiceRequired({ region: 'GP', record: null })).toBe(true)
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
  it("is Chrome's table: thirty countries, eight engines each, every id an engine, Wikipedia on none", () => {
    const shipped = new Set(DEFAULT_SEARCH_ENGINES.map((e) => e.id))
    const extra = new Set(SEARCH_CHOICE_EXTRA_ENGINES.map((e) => e.id))
    for (const [country, ids] of Object.entries(EEA_SEARCH_CHOICE)) {
      expect(ids, country).toHaveLength(8)
      expect(new Set(ids).size, country).toBe(8)
      expect(ids, country).not.toContain('wikipedia')
      for (const id of ids) {
        expect(shipped.has(id) || extra.has(id), `${country}: ${id}`).toBe(true)
        expect(searchChoiceEngine(id), `${country}: ${id}`).not.toBeNull()
        expect(isSearchChoiceEngine(id, country), `${country}: ${id}`).toBe(true)
      }
      // The tiles are the country's list in the table's order, each engine behind its tile.
      expect(searchChoiceTiles(country).map((t) => t.engine.id)).toEqual(ids)
    }
    // Twenty-one engines over the table; every extra engine is on some country's list.
    const union = new Set(Object.values(EEA_SEARCH_CHOICE).flat())
    expect(union.size).toBe(21)
    for (const id of extra) expect(union.has(id), id).toBe(true)
    expect(SEARCH_CHOICE_EXTRA_ENGINES).toHaveLength(17)
  })

  it("names the country's own engines where Chrome's table does", () => {
    expect(EEA_SEARCH_CHOICE.CZ).toContain('seznam')
    expect(EEA_SEARCH_CHOICE.SK).toContain('seznam')
    expect(EEA_SEARCH_CHOICE.DE).toContain('startpage')
    expect(EEA_SEARCH_CHOICE.LI).toContain('startpage')
    expect(EEA_SEARCH_CHOICE.DE).toContain('yahoo_de')
    expect(EEA_SEARCH_CHOICE.FR).toContain('yahoo_fr')
    expect(EEA_SEARCH_CHOICE.IE).toContain('yahoo_uk')
    expect(EEA_SEARCH_CHOICE.PL).toContain('yahoo_emea')
    expect(EEA_SEARCH_CHOICE.FR).not.toContain('startpage')
    expect(EEA_SEARCH_CHOICE.DE).not.toContain('privacywall')
    expect(EEA_SEARCH_CHOICE.DE).not.toContain('seznam')
  })

  it("a territory takes its state's list; outside the table the fallback is the shipped web engines", () => {
    const ids = (region: string | null): string[] =>
      searchChoiceTiles(region).map((t) => t.engine.id)
    expect(ids('AX')).toEqual(EEA_SEARCH_CHOICE.FI)
    expect(ids('RE')).toEqual(EEA_SEARCH_CHOICE.FR)
    expect(ids('IC')).toEqual(EEA_SEARCH_CHOICE.ES)
    expect(ids('SJ')).toEqual(EEA_SEARCH_CHOICE.NO)
    expect(ids('VA')).toEqual(EEA_SEARCH_CHOICE.IT)
    expect(ids('US')).toEqual(SEARCH_CHOICE_FALLBACK)
    expect(ids('GB')).toEqual(SEARCH_CHOICE_FALLBACK)
    expect(ids(null)).toEqual(SEARCH_CHOICE_FALLBACK)
    expect(SEARCH_CHOICE_FALLBACK).toEqual(['google', 'duckduckgo', 'ecosia', 'bing'])
  })

  it("reads the list's region: the host's when the table has it, else the record's, else none", () => {
    expect(searchChoiceListRegion('DE', null)).toBe('DE')
    expect(searchChoiceListRegion('AX', null)).toBe('FI')
    expect(searchChoiceListRegion('DE', { region: 'FR' })).toBe('DE')
    expect(searchChoiceListRegion('US', { region: 'DE' })).toBe('DE')
    expect(searchChoiceListRegion('US', { region: 'RE' })).toBe('FR')
    expect(searchChoiceListRegion('US', { region: 'US' })).toBeNull()
    expect(searchChoiceListRegion('US', { region: '' })).toBeNull()
    expect(searchChoiceListRegion(null, null)).toBeNull()
    expect(searchChoiceListRegion(undefined, undefined)).toBeNull()
  })

  it("records the screen as shown for the host's region, or the record's after a move", () => {
    expect(searchChoiceShownFor('DE', null)).toBe('DE')
    expect(searchChoiceShownFor('AX', null)).toBe('AX')
    expect(searchChoiceShownFor('DE', { region: 'FR' })).toBe('DE')
    expect(searchChoiceShownFor('US', { region: 'DE' })).toBe('DE')
    expect(searchChoiceShownFor('US', { region: 'US' })).toBe('US')
    expect(searchChoiceShownFor('US', null)).toBe('US')
    expect(searchChoiceShownFor(null, null)).toBeNull()
  })

  it("accepts an engine for the region's list only", () => {
    expect(isSearchChoiceEngine('startpage', 'DE')).toBe(true)
    expect(isSearchChoiceEngine('startpage', 'FR')).toBe(false)
    expect(isSearchChoiceEngine('seznam', 'CZ')).toBe(true)
    expect(isSearchChoiceEngine('seznam', 'DE')).toBe(false)
    expect(isSearchChoiceEngine('yahoo_fr', 'RE')).toBe(true)
    expect(isSearchChoiceEngine('yahoo_fr', 'DE')).toBe(false)
    expect(isSearchChoiceEngine('wikipedia', 'DE')).toBe(false)
    expect(isSearchChoiceEngine('qwant', 'US')).toBe(false)
    expect(isSearchChoiceEngine('google', 'US')).toBe(true)
    expect(isSearchChoiceEngine('bing', null)).toBe(true)
    expect(isSearchChoiceEngine('nope', 'DE')).toBe(false)
    expect(isSearchChoiceEngine('', 'DE')).toBe(false)
    expect(searchChoiceEngine('nope')).toBeNull()
  })

  it("gives each tile its line and its icon's address – a reference, never a picture", () => {
    for (const country of Object.keys(EEA_SEARCH_CHOICE))
      for (const tile of searchChoiceTiles(country)) {
        expect(tile.tagline.length).toBeGreaterThan(0)
        expect(tile.tagline).toBe(searchChoiceTagline(tile.engine))
        expect(tile.engine.favicon).toMatch(/^https:\/\//)
        expect(tile.engine.favicon).not.toMatch(/^data:/)
      }
    // Yahoo's editions share Yahoo's line; an engine without a line of its own has Chrome's
    // neutral one ("You can use $1 to search the web.").
    expect(searchChoiceTagline({ id: 'yahoo_de', name: 'Yahoo Search' })).toBe(
      searchChoiceTagline({ id: 'yahoo_fr', name: 'Yahoo Recherche' })
    )
    expect(searchChoiceTagline({ id: 'seznam', name: 'Seznam.cz' })).toBe(
      'You can use Seznam.cz to search the web.'
    )
    expect(searchChoiceTagline({ id: 'qwant', name: 'Qwant' })).not.toMatch(/^You can use/)
  })
})

describe('the seeded order', () => {
  it("is stable for one seed and different across seeds, over the country's list", () => {
    const a = shuffledSearchChoiceTiles('DE', 0xc0ffee).map((t) => t.engine.id)
    const again = shuffledSearchChoiceTiles('DE', 0xc0ffee).map((t) => t.engine.id)
    expect(again).toEqual(a)
    expect([...a].sort()).toEqual([...EEA_SEARCH_CHOICE.DE!].sort())
    const orders = new Set<string>()
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
      orders.add(
        shuffledSearchChoiceTiles('DE', seed)
          .map((t) => t.engine.id)
          .join(',')
      )
    expect(orders.size).toBeGreaterThan(1)
    for (const order of orders) expect(order.split(',').sort()).toEqual([...a].sort())
  })

  it("shuffles every country's own list, the fallback outside the table – the same seed, each list's order", () => {
    for (const [country, ids] of Object.entries(EEA_SEARCH_CHOICE)) {
      const order = shuffledSearchChoiceTiles(country, 7).map((t) => t.engine.id)
      expect([...order].sort(), country).toEqual([...ids].sort())
    }
    expect(shuffledSearchChoiceTiles('AX', 7).map((t) => t.engine.id)).toEqual(
      shuffledSearchChoiceTiles('FI', 7).map((t) => t.engine.id)
    )
    expect(
      shuffledSearchChoiceTiles('US', 7)
        .map((t) => t.engine.id)
        .sort()
    ).toEqual([...SEARCH_CHOICE_FALLBACK].sort())
    // Google leads the table everywhere; the screen's order does not keep it there.
    const firsts = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(
        (seed) => shuffledSearchChoiceTiles('FR', seed)[0]!.engine.id
      )
    )
    expect(firsts.size).toBeGreaterThan(1)
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

  it("choose of an engine not shipped copies it into the user's list so the id resolves everywhere", async () => {
    const { browser, win, io } = setup('FR')
    browser.handleCommand(win, 'searchChoice.choose', { engineId: 'qwant' })

    expect(browser.state.settings.searchEngineId).toBe('qwant')
    const own = browser.state.settings.searchEngines ?? []
    expect(own).toHaveLength(1)
    // The registry's entry as it is, `source: 'custom'`: the template, the name, the shortcut,
    // the glyph and the icon's documented address – a reference; no picture crosses the sync.
    expect(own[0]).toEqual({
      id: 'qwant',
      name: 'Qwant',
      searchUrl: 'https://www.qwant.com/?q=%s',
      suggestUrl: 'https://api.qwant.com/api/suggest/?q=%s',
      keyword: '@qwant',
      glyph: 'Q',
      favicon: 'https://www.qwant.com/favicon.ico',
      source: 'custom'
    })
    expect(JSON.stringify(own)).not.toMatch(/data:/)
    expect(browser.state.searchEngines.some((e) => e.id === 'qwant')).toBe(true)
    expect(browser.state.settings.searchChoice).toMatchObject({ engineId: 'qwant', region: 'FR' })
    // The list reaches the disk with the default and the record.
    const saved = await persisted(browser, io)
    expect(saved.searchEngines).toEqual(own)
    expect(saved.searchEngineId).toBe('qwant')

    // Chosen again: no second copy.
    browser.handleCommand(win, 'searchChoice.choose', { engineId: 'qwant' })
    expect(browser.state.settings.searchEngines).toHaveLength(1)
  })

  it("choose of a country's own engine works in that country – Yahoo's edition, Startpage in Germany", () => {
    const { browser, win } = setup('DE')
    browser.handleCommand(win, 'searchChoice.choose', { engineId: 'startpage' })
    expect(browser.state.settings.searchEngineId).toBe('startpage')
    browser.handleCommand(win, 'searchChoice.choose', { engineId: 'yahoo_de' })
    expect(browser.state.settings.searchEngineId).toBe('yahoo_de')
    expect(browser.state.settings.searchEngines?.map((e) => e.id)).toEqual([
      'startpage',
      'yahoo_de'
    ])
    expect(browser.state.settings.searchEngines?.[1]).toMatchObject({
      name: 'Yahoo Search',
      searchUrl: 'https://de.search.yahoo.com/search?ei=UTF-8&p=%s'
    })
  })

  it("a territory's screen is its state's list, and the record names the territory", () => {
    const { browser, win } = setup('AX')
    browser.handleCommand(win, 'searchChoice.choose', { engineId: 'yahoo_fi' })
    expect(browser.state.settings.searchEngineId).toBe('yahoo_fi')
    expect(browser.state.settings.searchChoice).toMatchObject({
      engineId: 'yahoo_fi',
      region: 'AX'
    })
  })

  it("choose of an engine not on the region's screen writes nothing", async () => {
    const { browser, win, io } = setup('DE')
    // Not shipped for the screen, not on Germany's list, not an engine, no id.
    for (const engineId of ['wikipedia', 'seznam', 'privacywall', 'yahoo_fr', 'nope', ''])
      browser.handleCommand(win, 'searchChoice.choose', { engineId })
    expect(browser.state.settings.searchEngines ?? []).toEqual([])
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
    // Outside the table the list is the fallback: a country's engine is not on it.
    browser.handleCommand(win, 'searchChoice.askAgain', undefined)
    browser.handleCommand(win, 'searchChoice.choose', { engineId: 'qwant' })
    expect(browser.state.settings.searchEngineId).toBe('ecosia')
    expect(browser.state.snapshot(win).searchChoice.required).toBe(true)
  })

  it('a device that moved keeps the list it was given: the record’s country, and its record', () => {
    // Answered in Germany, now booted with the OS in the US: not owed (a record stands);
    // Settings' ask shows Germany's list, and the new record is Germany's still.
    const { browser, win } = setup('US', {
      'state.json': JSON.stringify({
        version: 2,
        settings: {
          ...DEFAULT_SETTINGS,
          searchEngineId: 'google',
          searchChoice: { engineId: 'google', region: 'DE', madeAt: 1, version: 1 }
        }
      })
    })
    expect(browser.state.snapshot(win).searchChoice).toMatchObject({
      region: 'US',
      eea: false,
      required: false
    })
    browser.handleCommand(win, 'searchChoice.askAgain', undefined)
    browser.handleCommand(win, 'searchChoice.choose', { engineId: 'privacywall' })
    expect(browser.state.settings.searchEngineId).toBe('google')
    browser.handleCommand(win, 'searchChoice.choose', { engineId: 'startpage' })
    expect(browser.state.settings.searchEngineId).toBe('startpage')
    expect(browser.state.settings.searchChoice).toMatchObject({
      engineId: 'startpage',
      region: 'DE',
      version: SEARCH_CHOICE_VERSION
    })
    expect(browser.state.snapshot(win).searchChoice.required).toBe(false)
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
