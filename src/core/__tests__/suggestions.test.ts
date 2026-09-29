import { describe, expect, it, vi } from 'vitest'
import {
  PRIVATE_CONTAINER_ID,
  type HostCapabilities,
  type Suggestion,
  type TopSite
} from '../../shared/types'
import { BOOKMARKS_BAR_ID, OTHER_BOOKMARKS_ID } from '../../shared/bookmarks'
import { customSearchEngine } from '../../shared/search'
import { EXTENSION_SETTING_KEYS } from '../../shared/extensionSettings'
import type { NetHost, StoreIO } from '../platform'
import type { Browser } from '../browser'
import { BookmarkService } from '../bookmarks'
import { HistoryService } from '../history'
import { OmniboxShortcutsService } from '../omniboxShortcuts'
import { createFolder, createTabRecord } from '../model'
import { BrowserState } from '../state'
import {
  GROUP_MAX_SCORE,
  RELEVANCE,
  SuggestionService,
  groupMatch,
  isIntranetWord
} from '../suggestions'
import { ZenWindow } from '../window'

const io: StoreIO = {
  readSync: () => null,
  write: async () => {},
  writeSync: () => {}
}

/** The fixtures' "now": a fixed instant, so nothing here depends on the real date. */
const NOW = Date.parse('2026-09-17T12:00:00Z')

interface FakeNet extends NetHost {
  /** Body served per URL substring; unknown URLs get a 404. */
  routes: Array<{ match: string; body: unknown; status?: number }>
  requests: string[]
  resolvable: Set<string>
}

function fakeNet(withResolver = true): FakeNet {
  const net: FakeNet = {
    routes: [],
    requests: [],
    resolvable: new Set(),
    fetchText: async (url) => {
      net.requests.push(url)
      const route = net.routes.find((r) => url.includes(r.match))
      if (!route) return { ok: false, status: 404, text: '' }
      const status = route.status ?? 200
      return { ok: status < 400, status, text: JSON.stringify(route.body) }
    }
  }
  if (withResolver) net.resolveHost = async (host) => net.resolvable.has(host)
  return net
}

function setup(
  kind: 'synced' | 'private' = 'synced',
  opts: { online?: boolean; resolver?: boolean } = {}
): {
  suggestions: SuggestionService
  bookmarks: BookmarkService
  history: HistoryService
  shortcuts: OmniboxShortcutsService
  win: ZenWindow
  net: FakeNet
  state: BrowserState
  /** The new tab page's tile source as the fixture stands in for it (OMN-04). */
  newTab: { hiddenHosts: string[]; tiles: Pick<TopSite, 'url' | 'title' | 'favicon'>[] | null }
} {
  const state = new BrowserState(io, 'linux', {} as HostCapabilities, '0.0')
  state.load()
  // Live engine suggestions need the network; tests turn it on with a fake host.
  state.settings.searchSuggestions = opts.online ?? false
  const bookmarks = new BookmarkService(state)
  const history = new HistoryService(io)
  // The shortcuts provider on the fixture's clock (never the real date).
  const shortcuts = new OmniboxShortcutsService(io, () => NOW)
  const net = fakeNet(opts.resolver ?? true)
  // No extension holds an omnibox keyword: the URL bar's own sources answer.
  const extensions = { omniboxSuggest: async () => null }
  // Nothing on the clipboard: the empty state (nothing typed) is the recent history alone.
  const searchEngines = { peekClipboard: async () => 'none' as const }
  // The new tab page's tiles (`NewTabService.pageTiles`, the grid as the page lays it): the
  // fixture's own list when a test sets one, else history's top sites under the page's hidden
  // hosts – the grid under "most visited" with no shortcut pinned.
  const newTab = {
    hiddenHosts: [] as string[],
    tiles: null as Pick<TopSite, 'url' | 'title' | 'favicon'>[] | null,
    pageTiles: () => newTab.tiles ?? history.topSites(8, newTab.hiddenHosts)
  }
  const browser = {
    state,
    bookmarks,
    history,
    omniboxShortcuts: shortcuts,
    extensions,
    searchEngines,
    newTab,
    platform: { net }
  } as unknown as Browser
  const win = new ZenWindow(browser, {
    id: 'window_1',
    kind,
    bounds: null,
    displayId: null,
    maximized: false,
    activeSpaceId: state.model.activeSpaceId,
    selection: {},
    compact: false,
    localSpace: null,
    chrome: 'full',
    material: 'none'
  })
  const suggestions = new SuggestionService(browser)
  return { suggestions, bookmarks, history, shortcuts, win, net, state, newTab }
}

const kinds = (rows: Suggestion[]): string[] => rows.map((r) => r.kind)

describe('SuggestionService: bookmarks across folders', () => {
  it('lists bookmarks from nested folders with the folder path as subtitle', async () => {
    const { suggestions, bookmarks, win } = setup()
    const work = bookmarks.createFolder(BOOKMARKS_BAR_ID, 'Work')!
    const docs = bookmarks.createFolder(work.id, 'Docs')!
    const design = bookmarks.create({
      parentId: docs.id,
      title: 'Design docs',
      url: 'https://docs.example.com/'
    })!
    bookmarks.create({
      parentId: OTHER_BOOKMARKS_ID,
      title: 'Docs mirror',
      url: 'https://mirror.example.com/docs'
    })

    const results = await suggestions.suggest('docs', null, win)
    const hits = results.filter((r) => r.kind === 'bookmark')
    // A title that starts with the query outranks one that merely contains it.
    expect(hits.map((r) => r.url)).toEqual([
      'https://mirror.example.com/docs',
      'https://docs.example.com/'
    ])
    expect(hits[0].subtitle).toBe('Other bookmarks · mirror.example.com/docs')
    expect(hits[1].subtitle).toBe('Bookmarks bar / Work / Docs · docs.example.com')
    // Picking a bookmark suggestion opens the node (so dateLastUsed can be stamped).
    expect(hits[1].targetId).toBe(design.id)
  })

  it('matches by folder name and never suggests folders themselves', async () => {
    const { suggestions, bookmarks, win } = setup()
    const recipes = bookmarks.createFolder(OTHER_BOOKMARKS_ID, 'Recipes')!
    bookmarks.create({ parentId: recipes.id, title: 'Bread', url: 'https://bread.example/' })

    const results = await suggestions.suggest('recipes', null, win)
    const hits = results.filter((r) => r.kind === 'bookmark')
    expect(hits).toHaveLength(1)
    expect(hits[0].title).toBe('Bread')
    expect(results.some((r) => r.targetId === recipes.id)).toBe(false)
  })

  it('caps bookmark hits at three and dedupes URLs already shown as history', async () => {
    const { suggestions, bookmarks, history, win } = setup()
    for (let i = 0; i < 5; i += 1) {
      bookmarks.create({ title: `News ${i}`, url: `https://news.example/${i}` })
    }
    history.visit('https://news.example/0', 'News 0', null)

    const results = await suggestions.suggest('news', null, win)
    const bm = results.filter((r) => r.kind === 'bookmark')
    expect(bm.length).toBeLessThanOrEqual(3)
    const urls = results.map((r) => r.url)
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('ranks the verbatim search above bookmarks, and bookmarks above weaker history', async () => {
    const { suggestions, bookmarks, history, win } = setup()
    bookmarks.create({ title: 'Example', url: 'https://example.com/a' })
    history.visit('https://other.example/b', 'Some example B', null)

    const results = await suggestions.suggest('example', null, win)
    const k = kinds(results)
    expect(k.indexOf('bookmark')).toBeGreaterThan(-1)
    expect(k.indexOf('history')).toBeGreaterThan(k.indexOf('bookmark'))
    expect(k.indexOf('bookmark')).toBeGreaterThan(k.indexOf('search'))
  })

  it('shows no bookmarks or history in a private window', async () => {
    const { suggestions, bookmarks, history, win } = setup('private')
    bookmarks.create({ title: 'Secret', url: 'https://secret.example/' })
    history.visit('https://secret.example/2', 'Secret 2', null)

    const results = await suggestions.suggest('secret', null, win)
    expect(results.some((r) => r.kind === 'bookmark' || r.kind === 'history')).toBe(false)
  })
})

describe('SuggestionService: inline default match', () => {
  it('completes a visited host and marks it as the inline default match', async () => {
    const { suggestions, history, win } = setup()
    history.visit('https://example.org/', 'Example Domain', null, { transition: 'typed' })
    history.visit('https://example.org/docs/intro', 'Intro', null)
    history.visit('https://exampleshop.test/', 'Shop', null)

    const results = await suggestions.suggest('exam', null, win)
    expect(results[0]).toMatchObject({
      kind: 'url',
      fill: 'example.org/',
      url: 'https://example.org/',
      inline: true,
      relevance: RELEVANCE.autofill
    })
    // The verbatim search follows; the host's pages come as history rows.
    expect(results[1]).toMatchObject({ kind: 'search', title: 'exam' })
    expect(results.some((r) => r.url === 'https://example.org/docs/intro')).toBe(true)
  })

  it('completes a full visited URL once a slash has been typed', async () => {
    const { suggestions, history, win } = setup()
    history.visit('https://example.org/docs/intro', 'Intro', null)
    history.visit('https://example.org/downloads', 'Downloads', null)
    history.visit('https://example.org/downloads', 'Downloads', null)

    const results = await suggestions.suggest('example.org/d', null, win)
    expect(results[0]).toMatchObject({
      kind: 'url',
      fill: 'example.org/downloads',
      url: 'https://example.org/downloads',
      inline: true
    })
    // The typed casing is kept in the completed text.
    const upper = await suggestions.suggest('Example.org/d', null, win)
    expect(upper[0].fill).toBe('Example.org/downloads')
  })

  it('keeps an http-only host on http and never completes past what was typed', async () => {
    const { suggestions, history, win } = setup()
    history.visit('http://intranet.local:8080/', 'Intranet', null)

    const results = await suggestions.suggest('intra', null, win)
    expect(results[0]).toMatchObject({
      fill: 'intranet.local:8080/',
      url: 'http://intranet.local:8080/'
    })
    const exact = await suggestions.suggest('intranet.local:8080/', null, win)
    expect(exact.some((r) => r.inline)).toBe(false)
  })
})

describe('SuggestionService: answers', () => {
  it('shows a calculator row under the verbatim query that still searches the expression', async () => {
    const { suggestions, win } = setup()
    const results = await suggestions.suggest('2+2', null, win)
    expect(results[0]).toMatchObject({ kind: 'search', title: '2+2' })
    expect(results[1]).toMatchObject({
      kind: 'answer',
      title: '= 4',
      subtitle: '2+2',
      relevance: RELEVANCE.answer
    })
    expect(results[1].url).toContain('2%2B2')
    expect(results[1].inline).toBeUndefined()
  })

  it('shows a unit conversion row', async () => {
    const { suggestions, win } = setup()
    const results = await suggestions.suggest('10 km in miles', null, win)
    expect(results.find((r) => r.kind === 'answer')?.title).toBe('= 6.21371 miles')
  })

  it('answers currency questions from Frankfurter and caches the table', async () => {
    // A rates table is refetched once it is more than two days old, so the clock is pinned to
    // the fixture's day (only `Date` is faked; the intranet probe's timeout stays real).
    vi.setSystemTime(Date.parse('2026-09-17T12:00:00Z'))
    try {
      const { suggestions, win, net } = setup('synced', { online: true })
      net.routes.push({
        match: 'frankfurter.dev/v1/latest?base=USD',
        body: { base: 'USD', date: '2026-09-17', rates: { EUR: 0.9 } }
      })
      const results = await suggestions.suggest('100 usd to eur', null, win)
      expect(results.find((r) => r.kind === 'answer')).toMatchObject({
        title: '= 90.00 EUR',
        subtitle: '100 USD · ECB rate of 2026-09-17 · Frankfurter'
      })
      await suggestions.suggest('200 usd to eur', null, win)
      expect(net.requests.filter((u) => u.includes('frankfurter')).length).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers weather and time questions through Open-Meteo', async () => {
    const { suggestions, win, net } = setup('synced', { online: true })
    net.routes.push({
      match: 'geocoding-api.open-meteo.com/v1/search?name=paris',
      body: {
        results: [
          {
            name: 'Paris',
            latitude: 48.85,
            longitude: 2.35,
            timezone: 'Europe/Paris',
            country: 'France'
          }
        ]
      }
    })
    net.routes.push({
      match: 'api.open-meteo.com/v1/forecast?latitude=48.85',
      body: {
        current_units: { temperature_2m: '°C' },
        current: { temperature_2m: 17.6, weather_code: 3 }
      }
    })
    const weather = await suggestions.suggest('weather in paris', null, win)
    expect(weather.find((r) => r.kind === 'answer')).toMatchObject({
      title: '18°C · Overcast',
      subtitle: 'Weather in Paris, France · Open-Meteo'
    })
    const time = await suggestions.suggest('time in paris', null, win)
    const row = time.find((r) => r.kind === 'answer')
    expect(row?.subtitle).toBe('Time in Paris, France (Europe/Paris)')
    expect(row?.title).toMatch(/\d/)
    // The place was geocoded once for both questions.
    expect(net.requests.filter((u) => u.includes('geocoding')).length).toBe(1)
  })

  it('answers "define" through Wiktionary and opens the entry on Enter', async () => {
    const { suggestions, win, net } = setup('synced', { online: true })
    net.routes.push({
      match: 'wiktionary.org/api/rest_v1/page/definition/serendipity',
      body: {
        en: [{ partOfSpeech: 'Noun', definitions: [{ definition: 'A <b>fortunate</b> find.' }] }]
      }
    })
    const results = await suggestions.suggest('define serendipity', null, win)
    expect(results.find((r) => r.kind === 'answer')).toMatchObject({
      title: 'noun · A fortunate find.',
      url: 'https://en.wiktionary.org/wiki/serendipity'
    })
  })

  it('shows a Wikipedia entity row when the summary exists and skips misses', async () => {
    const { suggestions, win, net } = setup('synced', { online: true })
    net.routes.push({
      match: 'wikipedia.org/api/rest_v1/page/summary/Wikipedia',
      body: {
        type: 'standard',
        title: 'Wikipedia',
        description: 'Free online encyclopedia',
        thumbnail: { source: 'https://upload.wikimedia.org/w.png' },
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Wikipedia' } }
      }
    })
    const results = await suggestions.suggest('wikipedia', null, win)
    expect(results.find((r) => r.kind === 'entity')).toMatchObject({
      title: 'Wikipedia',
      subtitle: 'Free online encyclopedia',
      favicon: 'https://upload.wikimedia.org/w.png',
      url: 'https://en.wikipedia.org/wiki/Wikipedia'
    })
    const miss = await suggestions.suggest('zzqx', null, win)
    expect(miss.some((r) => r.kind === 'entity')).toBe(false)
    // A miss is remembered: the same word is not asked again.
    await suggestions.suggest('zzqx', null, win)
    expect(net.requests.filter((u) => u.includes('summary/Zzqx')).length).toBe(1)
  })

  it('asks no network answers while search suggestions are off or in a private window', async () => {
    const offline = setup()
    await offline.suggestions.suggest('100 usd to eur', null, offline.win)
    expect(offline.net.requests).toEqual([])
    const priv = setup('private', { online: true })
    await priv.suggestions.suggest('wikipedia', null, priv.win)
    expect(priv.net.requests).toEqual([])
  })

  it("reads the switch as an extension holds it (chrome.privacy.services.searchSuggestEnabled) and as the user's again once released", async () => {
    const { suggestions, win, net, state } = setup('synced', { online: true })
    const guard = { extensionId: 'guard', name: 'Guard' }
    net.routes.push({ match: 'client=chrome&q=', body: [] })
    const remote = (): number => net.requests.filter((u) => u.includes('client=chrome&q=')).length

    // The extension's `false` over the user's `true`: no engine request, the user's setting untouched.
    state.setExtensionControls({
      [EXTENSION_SETTING_KEYS.searchSuggestions]: { ...guard, value: false }
    })
    expect(suggestions.suggestionsEnabled()).toBe(false)
    await suggestions.suggest('github', null, win)
    expect(remote()).toBe(0)
    expect(net.requests).toEqual([])
    expect(state.settings.searchSuggestions).toBe(true)
    // The user's own change while held changes nothing visible.
    state.settings.searchSuggestions = false
    state.settings.searchSuggestions = true
    await suggestions.suggest('github', null, win)
    expect(remote()).toBe(0)

    // Release: the user's value returns – the next query asks the engine.
    state.setExtensionControls({})
    expect(suggestions.suggestionsEnabled()).toBe(true)
    await suggestions.suggest('github', null, win)
    expect(remote()).toBe(1)

    // The extension's `true` over the user's `false` (a fresh query: the engine's answers are
    // cached per query); a hold on another key is not this switch.
    state.settings.searchSuggestions = false
    await suggestions.suggest('gitlab', null, win)
    expect(remote()).toBe(1)
    state.setExtensionControls({
      [EXTENSION_SETTING_KEYS.searchSuggestions]: { ...guard, value: true }
    })
    await suggestions.suggest('gitlab', null, win)
    expect(remote()).toBe(2)
    state.setExtensionControls({
      [EXTENSION_SETTING_KEYS.passwordSaving]: { ...guard, value: true }
    })
    expect(suggestions.suggestionsEnabled()).toBe(false)
    // Private windows show no engine rows whatever the layer says, as with the user's switch.
    const priv = setup('private', { online: true })
    priv.state.setExtensionControls({
      [EXTENSION_SETTING_KEYS.searchSuggestions]: { ...guard, value: true }
    })
    await priv.suggestions.suggest('github', null, priv.win)
    expect(priv.net.requests).toEqual([])
  })
})

describe('SuggestionService: engine suggestions', () => {
  const googlePayload = (query: string): unknown => [
    query,
    ['github desktop', 'https://github.com/', 'github copilot', '= 4'],
    ['', 'GitHub: Let’s build from here', '', ''],
    [],
    {
      'google:suggesttype': ['QUERY', 'NAVIGATION', 'QUERY', 'CALCULATOR'],
      'google:suggestrelevance': [1252, 800, 601, 1250],
      'google:verbatimrelevance': 851
    }
  ]

  it('ranks remote rows by their relevance, inlines the one the engine ranks above verbatim', async () => {
    const { suggestions, win, net } = setup('synced', { online: true })
    net.routes.push({ match: 'client=chrome&q=github', body: googlePayload('github') })
    const results = await suggestions.suggest('github', null, win)
    expect(results[0]).toMatchObject({
      kind: 'search',
      title: 'github desktop',
      fill: 'github desktop',
      inline: true
    })
    expect(results[1]).toMatchObject({ kind: 'search', title: 'github' })
    const nav = results.find((r) => r.id === 'nav:https://github.com/')
    expect(nav).toMatchObject({
      kind: 'url',
      title: 'GitHub: Let’s build from here',
      subtitle: 'github.com',
      fill: 'github.com',
      relevance: 800
    })
    const copilot = results.find((r) => r.title === 'github copilot')
    expect(copilot?.relevance).toBe(601)
    expect(results.indexOf(nav!)).toBeLessThan(results.indexOf(copilot!))
    // The engine's calculator row reads as an answer row.
    expect(results.find((r) => r.kind === 'answer')).toMatchObject({ title: '= 4' })
    expect(results.length).toBeGreaterThan(4)
    expect(net.requests[0]).toContain('client=chrome&q=github')
  })

  it('shows more than four remote rows and keeps them under strong local matches', async () => {
    const { suggestions, win, net, history } = setup('synced', { online: true })
    history.visit('https://cats.example/', 'Cats', null)
    const terms = ['cats 1', 'cats 2', 'cats 3', 'cats 4', 'cats 5', 'cats 6']
    net.routes.push({
      match: 'q=cats',
      body: [
        'cats',
        terms,
        [],
        [],
        {
          'google:suggestrelevance': [700, 690, 680, 670, 660, 650],
          'google:verbatimrelevance': 1300
        }
      ]
    })
    const results = await suggestions.suggest('cats', null, win)
    expect(results.filter((r) => r.id.startsWith('sugg:'))).toHaveLength(6)
    const first = results.findIndex((r) => r.id.startsWith('sugg:'))
    expect(results.slice(0, first).map((r) => r.kind)).toEqual(['url', 'search'])
    expect(results.some((r) => r.inline)).toBe(true)
  })

  it('does not inline a remote suggestion the engine ranks below verbatim', async () => {
    const { suggestions, win, net } = setup('synced', { online: true })
    net.routes.push({
      match: 'q=weath',
      body: [
        'weath',
        ['weather'],
        [],
        [],
        { 'google:suggestrelevance': [700], 'google:verbatimrelevance': 1300 }
      ]
    })
    const results = await suggestions.suggest('weath', null, win)
    expect(results[0]).toMatchObject({ kind: 'search', title: 'weath' })
    expect(results.some((r) => r.inline)).toBe(false)
  })
})

describe('SuggestionService: keyword mode', () => {
  it('offers the keywords a typed `@` could become', async () => {
    const { suggestions, win } = setup()
    const results = await suggestions.suggest('@d', null, win)
    const starter = results.find((r) => r.kind === 'engine')
    expect(starter).toMatchObject({ title: '@ddg', subtitle: 'Search DuckDuckGo', fill: '@ddg ' })
    const scopes = await suggestions.suggest('@b', null, win)
    expect(scopes.find((r) => r.kind === 'engine')).toMatchObject({
      title: '@bookmarks',
      subtitle: 'Search bookmarks'
    })
  })

  it('searches only bookmarks for `@bookmarks foo` and opens the manager on the verbatim row', async () => {
    const { suggestions, bookmarks, history, win } = setup()
    bookmarks.create({ title: 'Foo docs', url: 'https://foo.example/docs' })
    history.visit('https://foo.example/history-only', 'Foo history', null)
    const results = await suggestions.suggest('@bookmarks foo', null, win)
    expect(results[0]).toMatchObject({
      kind: 'search',
      title: 'foo',
      subtitle: 'Search bookmarks',
      url: 'zen://bookmarks'
    })
    expect(results.slice(1).map((r) => r.kind)).toEqual(['bookmark'])
    expect(results.some((r) => r.url === 'https://foo.example/history-only')).toBe(false)
  })

  it('searches history for `@history` and open tabs for `@tabs`', async () => {
    const { suggestions, history, win } = setup()
    history.visit('https://foo.example/page', 'Foo page', null)
    const hist = await suggestions.suggest('@history foo', null, win)
    expect(hist[0]).toMatchObject({ kind: 'search', url: 'zen://history' })
    expect(hist[1]).toMatchObject({ kind: 'history', url: 'https://foo.example/page' })
    const tabs = await suggestions.suggest('@tabs zzz', null, win)
    expect(tabs).toEqual([])
  })

  it('keeps the typed keyword in the fill of engine suggestions', async () => {
    const { suggestions, win, net } = setup('synced', { online: true })
    net.routes.push({
      match: 'duckduckgo.com/ac/?type=list&q=cats',
      body: ['cats', ['cats and dogs']]
    })
    const results = await suggestions.suggest('@duckduckgo cats', null, win)
    expect(results[0]).toMatchObject({
      kind: 'search',
      title: 'cats',
      subtitle: 'Search with DuckDuckGo'
    })
    expect(results[1]).toMatchObject({ title: 'cats and dogs', fill: '@duckduckgo cats and dogs' })
    expect(results.some((r) => r.kind === 'url')).toBe(false)
  })

  it('is keyword mode with nothing typed after the keyword yet', async () => {
    const { suggestions, win } = setup()
    expect(await suggestions.suggest('@ddg ', null, win)).toEqual([])
    const scoped = await suggestions.suggest('@bookmarks ', null, win)
    expect(scoped).toHaveLength(1)
    expect(scoped[0]).toMatchObject({ kind: 'search', title: 'Search bookmarks' })
  })

  it('offers a deactivated engine nowhere: no starter for its `@`, no keyword mode, until activated (settings-43)', async () => {
    const { suggestions, win, state } = setup()
    const own = customSearchEngine(
      'Marginalia',
      'https://marginalia.example/?q=%s',
      state.searchEngines
    )
    state.settings.searchEngines = [{ ...own, active: false }]
    const starters = (rows: Suggestion[]): string[] =>
      rows.filter((r) => r.kind === 'engine').map((r) => r.title)
    expect(starters(await suggestions.suggest('@m', null, win))).toEqual([])
    // `@marginalia cats` is a plain query, not the engine's keyword mode.
    const typed = await suggestions.suggest('@marginalia cats', null, win)
    expect(typed[0]).toMatchObject({ kind: 'search', title: '@marginalia cats' })
    expect(typed.some((r) => r.subtitle === 'Search with Marginalia')).toBe(false)
    // Activated, the starter and the keyword come back.
    state.settings.searchEngines = [own]
    expect(starters(await suggestions.suggest('@m', null, win))).toEqual(['@marginalia'])
    const active = await suggestions.suggest('@marginalia cats', null, win)
    expect(active[0]).toMatchObject({
      kind: 'search',
      title: 'cats',
      subtitle: 'Search with Marginalia'
    })
  })
})

describe('SuggestionService: intranet probe', () => {
  it('offers "Did you mean to go to http://host/" when a single word resolves', async () => {
    const { suggestions, win, net } = setup()
    net.resolvable.add('intranet')
    const results = await suggestions.suggest('intranet', null, win)
    const row = results.find((r) => r.id === 'intranet')
    expect(row).toMatchObject({
      kind: 'url',
      title: 'http://intranet/',
      url: 'http://intranet/',
      subtitle: 'Did you mean to go to this site?',
      relevance: RELEVANCE.intranet
    })
    expect(results[0].kind).toBe('search')
    expect(results.indexOf(row!)).toBe(1)
    const none = await suggestions.suggest('unknownword', null, win)
    expect(none.some((r) => r.id === 'intranet')).toBe(false)
  })

  it('probes nothing without a resolver, for URLs, or for multi-word queries', async () => {
    const { suggestions, win } = setup('synced', { resolver: false })
    const results = await suggestions.suggest('intranet', null, win)
    expect(results.some((r) => r.id === 'intranet')).toBe(false)
    expect(isIntranetWord('intranet')).toBe(true)
    expect(isIntranetWord('my-host2')).toBe(true)
    expect(isIntranetWord('example.com')).toBe(false)
    expect(isIntranetWord('two words')).toBe(false)
    expect(isIntranetWord('ab')).toBe(false)
    expect(isIntranetWord('2024')).toBe(false)
  })
})

describe('SuggestionService: rows and limits', () => {
  it('lists open tabs as Switch to tab rows with the site as subtitle', async () => {
    const { suggestions, state, win } = setup()
    const space = state.model.spaces[0]
    const tab = createTabRecord({
      id: 'tab_docs',
      url: 'https://docs.example.com/guide',
      title: 'Guide',
      spaceId: space.id,
      containerId: space.containerId
    })
    state.model.tabs[tab.id] = tab
    space.tabIds.push(tab.id)
    const results = await suggestions.suggest('guide', null, win)
    expect(results.find((r) => r.kind === 'tab')).toMatchObject({
      title: 'Guide',
      subtitle: 'docs.example.com/guide',
      targetId: 'tab_docs',
      relevance: RELEVANCE.tabPrefix
    })
  })

  it('never returns more than ten rows', async () => {
    const { suggestions, history, win } = setup()
    for (let i = 0; i < 30; i += 1) history.visit(`https://site${i}.example/`, `Site ${i}`, null)
    const results = await suggestions.suggest('site', null, win)
    expect(results.length).toBeLessThanOrEqual(10)
  })

  it('offers no Switch to tab for a new tab page or a blank tab', async () => {
    const { suggestions, state, win } = setup()
    const space = state.model.spaces[0]
    for (const [id, url, title] of [
      ['tab_ntp', 'zen://newtab', 'New Tab'],
      ['tab_blank', 'zen://blank/', 'New Tab'],
      ['tab_real', 'https://newtab.example/', 'New Tab']
    ]) {
      const tab = createTabRecord({
        id,
        url,
        title,
        spaceId: space.id,
        containerId: space.containerId
      })
      state.model.tabs[tab.id] = tab
      space.tabIds.push(tab.id)
    }
    const results = await suggestions.suggest('new tab', null, win)
    const rows = results.filter((r) => r.kind === 'tab')
    expect(rows.map((r) => r.targetId)).toEqual(['tab_real'])
    const scoped = await suggestions.suggest('@tabs new', null, win)
    expect(scoped.filter((r) => r.kind === 'tab').map((r) => r.targetId)).toEqual(['tab_real'])
  })
})

/*
 * The phone has no private window: a private tab lives in the private container inside a regular
 * window, so the private decision is keyed on the tab the omnibox serves as well as on the
 * window. Chrome's incognito omnibox sends no suggest requests and shows nothing of the profile.
 */
describe('SuggestionService: a private tab in a regular window', () => {
  function withTabs(): ReturnType<typeof setup> & { privateTab: string; regularTab: string } {
    const s = setup('synced', { online: true })
    const { state, bookmarks, history, net } = s
    const space = state.model.spaces[0]
    for (const [id, containerId] of [
      ['tab_private', PRIVATE_CONTAINER_ID],
      ['tab_regular', space.containerId]
    ]) {
      const tab = createTabRecord({
        id,
        url: 'https://open.example/',
        title: 'Open',
        spaceId: space.id,
        containerId
      })
      state.model.tabs[tab.id] = tab
      space.tabIds.push(tab.id)
    }
    bookmarks.create({ title: 'Secret bookmark', url: 'https://marks.example/secret' })
    history.visit('https://secret.example/2', 'Secret 2', null)
    net.routes.push({ match: 'q=secret', body: ['secret', ['secret garden', 'secret santa']] })
    return { ...s, privateTab: 'tab_private', regularTab: 'tab_regular' }
  }

  it('asks the engine nothing and shows no history, bookmarks or zero-suggest from a private tab', async () => {
    const { suggestions, win, net, privateTab } = withTabs()
    expect(win.isPrivate).toBe(false)

    const rows = await suggestions.suggest('secret', privateTab, win)
    expect(net.requests).toEqual([])
    expect(rows.some((r) => r.kind === 'history' || r.kind === 'bookmark')).toBe(false)
    expect(rows.some((r) => r.title === 'secret garden' || r.kind === 'entity')).toBe(false)
    // The verbatim search stays: what is typed still goes to the engine on Enter.
    expect(rows.some((r) => r.kind === 'search' && r.title === 'secret')).toBe(true)

    expect(await suggestions.suggest('', privateTab, win)).toEqual([])
    expect(await suggestions.suggest('@history secret', privateTab, win)).toEqual([])
    expect(await suggestions.suggest('@bookmarks secret', privateTab, win)).toEqual([])
    expect(net.requests).toEqual([])
  })

  it('still offers Switch to tab rows from a private tab, as a private window does', async () => {
    const { suggestions, win, privateTab } = withTabs()
    const rows = await suggestions.suggest('open', privateTab, win)
    expect(rows.filter((r) => r.kind === 'tab').map((r) => r.targetId)).toEqual(['tab_regular'])
  })

  it('leaves a regular tab in the same window as it was: history, bookmarks, zero-suggest and the engine', async () => {
    const { suggestions, win, net, regularTab } = withTabs()

    const rows = await suggestions.suggest('secret', regularTab, win)
    expect(rows.some((r) => r.kind === 'history')).toBe(true)
    expect(rows.some((r) => r.kind === 'bookmark')).toBe(true)
    expect(rows.some((r) => r.title === 'secret garden')).toBe(true)
    expect(net.requests.some((u) => u.includes('q=secret'))).toBe(true)

    const empty = await suggestions.suggest('', regularTab, win)
    expect(empty.map((r) => r.kind)).toEqual(['history'])
    // Nothing named, the window's own answer holds too.
    expect((await suggestions.suggest('', null, win)).length).toBe(1)
  })
})

describe('SuggestionService: the shortcuts provider (omnibox-03)', () => {
  it('boosts a remembered destination to the top of the popup, completed inline', async () => {
    const { suggestions, shortcuts, history, win } = setup()
    history.visit('https://mailing-lists.example/', 'Mailing lists', null)
    shortcuts.learn('mai', { url: 'https://mail.google.com/mail/', title: 'Gmail', kind: 'url' })

    // "Ma" is a prefix of the remembered typing and of the destination's text: boosted to the
    // top and completed inline, the typed prefix keeping its casing.
    const results = await suggestions.suggest('Ma', null, win)
    expect(results[0]).toMatchObject({
      kind: 'url',
      title: 'Gmail',
      url: 'https://mail.google.com/mail/',
      fill: 'Mail.google.com/mail/',
      deletable: true,
      relevance: RELEVANCE.shortcut
    })
    // Over the history completion (Chromium's shortcut boost) and the verbatim row.
    expect(results[1]).toMatchObject({ id: 'autofill', url: 'https://mailing-lists.example/' })
    expect(results.some((r) => r.kind === 'search' && r.title === 'Ma')).toBe(true)

    // A typing the destination's text does not extend is boosted but not completed inline
    // (Chromium's fill_into_edit rule): the row carries the destination's text for arrowing
    // onto it, and since it cannot be the default match the verbatim row stays first
    // (SortAndCull's rotation) – the first row is always what Enter opens – with the shortcut
    // right under it, over the history rows.
    shortcuts.learn('gm', { url: 'https://mail.google.com/mail/', title: 'Gmail', kind: 'url' })
    history.visit('https://example.org/guide', 'Guide', null)
    const byOtherText = await suggestions.suggest('g', null, win)
    expect(byOtherText[0]).toMatchObject({ kind: 'search', title: 'g', fill: 'g' })
    expect(byOtherText[0].inline).toBeUndefined()
    expect(byOtherText[1]).toMatchObject({
      url: 'https://mail.google.com/mail/',
      fill: 'mail.google.com/mail/',
      relevance: RELEVANCE.shortcut
    })
    expect(byOtherText.findIndex((r) => r.url === 'https://example.org/guide')).toBeGreaterThan(1)
  })

  it('shows a remembered search as a search row for its engine, other shortcuts under verbatim', async () => {
    const { suggestions, shortcuts, win } = setup()
    shortcuts.learn('ca', {
      url: 'https://www.google.com/search?q=cats',
      title: 'cats',
      kind: 'search',
      engineId: 'google'
    })
    shortcuts.learn('ca', { url: 'https://cats.example/', title: 'Cats', kind: 'url' })

    const results = await suggestions.suggest('ca', null, win)
    const shortcutRows = results.filter((r) => r.id.startsWith('shortcut:'))
    expect(shortcutRows).toHaveLength(2)
    expect(shortcutRows[0].relevance).toBe(RELEVANCE.shortcut)
    expect(shortcutRows[1].relevance).toBeLessThan(RELEVANCE.verbatim)
    const search = shortcutRows.find((r) => r.kind === 'search')!
    expect(search).toMatchObject({
      title: 'cats',
      subtitle: 'Search with Google',
      targetId: 'google',
      fill: 'cats',
      deletable: true
    })
  })

  it('offers nothing from the shortcuts in a private window or with history suggestions off', async () => {
    const priv = setup('private')
    priv.shortcuts.learn('gm', { url: 'https://mail.google.com/', title: 'Gmail', kind: 'url' })
    expect(
      (await priv.suggestions.suggest('g', null, priv.win)).some((r) =>
        r.id.startsWith('shortcut:')
      )
    ).toBe(false)

    const { suggestions, shortcuts, state, win } = setup()
    shortcuts.learn('gm', { url: 'https://mail.google.com/', title: 'Gmail', kind: 'url' })
    state.settings.historySuggestions = false
    expect(
      (await suggestions.suggest('g', null, win)).some((r) => r.id.startsWith('shortcut:'))
    ).toBe(false)
  })
})

describe('SuggestionService: zero-suggest (omnibox-20)', () => {
  it('lists the remembered searches as a "Recent searches" group over the recent pages', async () => {
    const { suggestions, shortcuts, history, win } = setup()
    history.visit('https://recent.example/', 'Recent page', null)
    shortcuts.learn('ca', {
      url: 'https://www.google.com/search?q=cats',
      title: 'cats',
      kind: 'search',
      engineId: 'google'
    })
    shortcuts.learn('gm', { url: 'https://mail.google.com/', title: 'Gmail', kind: 'url' })

    const rows = await suggestions.suggest('', null, win)
    expect(rows.map((r) => [r.kind, r.group ?? null])).toEqual([
      ['search', 'Recent searches'],
      ['history', null]
    ])
    expect(rows[0]).toMatchObject({
      title: 'cats',
      fill: 'cats',
      deletable: true,
      targetId: 'google'
    })
    expect(rows[1]).toMatchObject({ url: 'https://recent.example/', deletable: true })
  })

  it("drops the default engine's results pages that duplicate a Recent searches row from the recent pages, the next page taking the place (#289 ruling)", async () => {
    const { suggestions, shortcuts, history, win } = setup()
    // Eight plain pages, oldest first, then the results pages the searches left – Google's own
    // additions to the address and `+` for the space included – and one for terms never searched.
    const start = Date.now() - 60_000
    const visits = [
      ...Array.from({ length: 8 }, (_, i) => [`https://page${i}.example/`, `Page ${i}`]),
      ['https://www.google.com/search?q=cats&sourceid=chrome', 'cats - Google Search'],
      ['https://www.google.com/search?q=two+words', 'two words - Google Search'],
      ['https://www.google.com/search?q=dogs', 'dogs - Google Search']
    ]
    visits.forEach(([url, title], i) => history.visit(url, title, null, { at: start + i * 1000 }))
    shortcuts.learn('ca', {
      url: 'https://www.google.com/search?q=cats',
      title: 'cats',
      kind: 'search',
      engineId: 'google'
    })
    shortcuts.learn('two', {
      url: 'https://www.google.com/search?q=two%20words',
      title: 'two words',
      kind: 'search'
    })

    const rows = await suggestions.suggest('', null, win)
    const recent = rows.filter((r) => r.group === 'Recent searches').map((r) => r.title)
    expect(recent.sort()).toEqual(['cats', 'two words'])
    const pages = rows.filter((r) => r.kind === 'history').map((r) => r.url)
    // The two searched-for results pages are gone; "dogs" was never a search here and stays;
    // the eight-row section is filled from the older pages.
    expect(pages).toHaveLength(8)
    expect(pages[0]).toBe('https://www.google.com/search?q=dogs')
    expect(pages).not.toContain('https://www.google.com/search?q=cats&sourceid=chrome')
    expect(pages).not.toContain('https://www.google.com/search?q=two+words')
    expect(pages.slice(1)).toEqual([7, 6, 5, 4, 3, 2, 1].map((i) => `https://page${i}.example/`))
  })

  it("keeps another engine's results page for the same terms: only the engine the search went to is deduped", async () => {
    const { suggestions, shortcuts, history, win } = setup()
    history.visit('https://duckduckgo.com/?q=cats', 'cats at DuckDuckGo', null)
    shortcuts.learn('ca', {
      url: 'https://www.google.com/search?q=cats',
      title: 'cats',
      kind: 'search',
      engineId: 'google'
    })
    const rows = await suggestions.suggest('', null, win)
    expect(rows.filter((r) => r.kind === 'history').map((r) => r.url)).toEqual([
      'https://duckduckgo.com/?q=cats'
    ])
  })

  it('caps the recent searches at eight, most recent first', async () => {
    const { suggestions, shortcuts, win } = setup()
    for (let i = 0; i < 10; i += 1) {
      shortcuts.learn(`q${i}`, {
        url: `https://www.google.com/search?q=q${i}`,
        title: `q${i}`,
        kind: 'search',
        engineId: 'google'
      })
    }
    const rows = await suggestions.suggest('', null, win)
    expect(rows.filter((r) => r.group === 'Recent searches')).toHaveLength(8)
  })

  it('shows none in a private window, and none with history suggestions off', async () => {
    const priv = setup('private')
    priv.shortcuts.learn('c', {
      url: 'https://www.google.com/search?q=c',
      title: 'c',
      kind: 'search'
    })
    expect(await priv.suggestions.suggest('', null, priv.win)).toEqual([])

    const { suggestions, shortcuts, history, state, win } = setup()
    history.visit('https://recent.example/', 'Recent page', null)
    shortcuts.learn('c', { url: 'https://www.google.com/search?q=c', title: 'c', kind: 'search' })
    state.settings.historySuggestions = false
    expect(await suggestions.suggest('', null, win)).toEqual([])
  })
})

describe('SuggestionService: suggestion privacy toggles (omnibox-45)', () => {
  it('drops history rows and the inline completion with history suggestions off, bookmarks stay', async () => {
    const { suggestions, history, bookmarks, state, win } = setup()
    history.visit('https://example.org/', 'Example Domain', null, { transition: 'typed' })
    bookmarks.create({ title: 'Example mark', url: 'https://marks.example/example' })
    state.settings.historySuggestions = false

    const results = await suggestions.suggest('exam', null, win)
    expect(results.some((r) => r.kind === 'history' || r.inline)).toBe(false)
    expect(results.some((r) => r.kind === 'bookmark')).toBe(true)
    expect(results[0]).toMatchObject({ kind: 'search', title: 'exam' })
  })

  it('drops bookmark rows with bookmark suggestions off, history stays', async () => {
    const { suggestions, history, bookmarks, state, win } = setup()
    history.visit('https://example.org/docs', 'Example docs', null)
    bookmarks.create({ title: 'Example mark', url: 'https://marks.example/example' })
    state.settings.bookmarkSuggestions = false

    const results = await suggestions.suggest('example', null, win)
    expect(results.some((r) => r.kind === 'bookmark')).toBe(false)
    expect(results.some((r) => r.kind === 'history')).toBe(true)
  })

  it('an explicit @bookmarks or @history scope still answers with the toggles off', async () => {
    const { suggestions, history, bookmarks, state, win } = setup()
    history.visit('https://example.org/docs', 'Example docs', null)
    bookmarks.create({ title: 'Example mark', url: 'https://marks.example/example' })
    state.settings.bookmarkSuggestions = false
    state.settings.historySuggestions = false
    expect(kinds(await suggestions.suggest('@bookmarks example', null, win))).toContain('bookmark')
    expect(kinds(await suggestions.suggest('@history example', null, win))).toContain('history')
  })
})

describe('SuggestionService: search mode (omnibox-26, -08)', () => {
  it('with an engine given, an address-like typing is a search for that engine', async () => {
    const { suggestions, history, win } = setup()
    history.visit('https://example.org/', 'Example Domain', null, { transition: 'typed' })
    const results = await suggestions.suggest('example.org', null, win, { engineId: 'duckduckgo' })
    expect(results[0]).toMatchObject({
      kind: 'search',
      title: 'example.org',
      subtitle: 'Search with DuckDuckGo',
      url: 'https://duckduckgo.com/?q=example.org',
      fill: 'example.org'
    })
    expect(results.some((r) => r.kind === 'url' || r.kind === 'history')).toBe(false)
  })

  it('Chrome\u2019s legacy ? prefix is search mode for the default engine, and nothing on ? alone', async () => {
    const { suggestions, win } = setup()
    const results = await suggestions.suggest('?example.org', null, win)
    expect(results[0]).toMatchObject({
      kind: 'search',
      title: 'example.org',
      url: 'https://www.google.com/search?q=example.org'
    })
    expect(await suggestions.suggest('?', null, win)).toEqual([])
  })
})

/*
 * The phone card's sections (OMN-18): Chrome for Android's order – the default match alone at
 * the field's end, then the pages, the searches, the open tabs – each under its heading; the
 * desktop popup is untouched by the option.
 */
describe('SuggestionService: the phone card’s sections (OMN-18)', () => {
  const payload = (query: string): unknown => [
    query,
    ['github desktop', 'github copilot'],
    ['', ''],
    [],
    {
      'google:suggesttype': ['QUERY', 'QUERY'],
      'google:suggestrelevance': [700, 601],
      'google:verbatimrelevance': 851
    }
  ]

  function mixed(): ReturnType<typeof setup> {
    const s = setup('synced', { online: true })
    const { state, history, net } = s
    net.routes.push({ match: 'client=chrome&q=github', body: payload('github') })
    history.visit('https://github.com/zen/zenium', 'zen/zenium: GitHub', null)
    history.visit('https://docs.github.com/', 'GitHub Docs', null)
    const space = state.model.spaces[0]
    const tab = createTabRecord({
      id: 'tab_gh',
      url: 'https://github.com/notifications',
      title: 'GitHub notifications',
      spaceId: space.id,
      containerId: space.containerId
    })
    state.model.tabs[tab.id] = tab
    space.tabIds.push(tab.id)
    return s
  }

  it('sections a typed query: the default match, then Pages, Searches, Open tabs', async () => {
    const { suggestions, win } = mixed()
    const rows = await suggestions.suggest('github', null, win, { grouped: true })
    // The default match – the inline completion Enter opens – keeps the first row, no heading.
    expect(rows[0]).toMatchObject({ kind: 'url', title: 'github.com', inline: true })
    expect(rows[0].group).toBeUndefined()
    expect(rows.slice(1).map((r) => [r.kind, r.group])).toEqual([
      ['history', 'Pages'],
      ['history', 'Pages'],
      ['search', 'Searches'],
      ['search', 'Searches'],
      ['search', 'Searches'],
      ['tab', 'Open tabs']
    ])
    // Inside a section the relevance order stands: the verbatim search, then the engine's
    // 700 over its 601.
    expect(rows.filter((r) => r.group === 'Searches').map((r) => r.title)).toEqual([
      'github',
      'github desktop',
      'github copilot'
    ])
  })

  it('leaves the desktop’s flat relevance order alone without the option', async () => {
    const { suggestions, win } = mixed()
    const rows = await suggestions.suggest('github', null, win)
    expect(rows.every((r) => r.group === undefined)).toBe(true)
    // The tab row outranks the engine's suggestions there (relevance 1000 over 700).
    expect(kinds(rows).indexOf('tab')).toBeLessThan(kinds(rows).lastIndexOf('search'))
  })

  it('draws no heading over a card of one kind: the searches alone, or `@tabs`', async () => {
    const { suggestions, win, net, state } = setup('synced', { online: true })
    net.routes.push({ match: 'client=chrome&q=github', body: payload('github') })
    const alone = await suggestions.suggest('github', null, win, { grouped: true })
    expect(kinds(alone)).toEqual(['search', 'search', 'search'])
    expect(alone.every((r) => r.group === undefined)).toBe(true)

    const space = state.model.spaces[0]
    for (const [id, title] of [
      ['tab_a', 'Alpha'],
      ['tab_b', 'Beta']
    ]) {
      const tab = createTabRecord({
        id,
        url: `https://${id}.example/`,
        title,
        spaceId: space.id,
        containerId: space.containerId
      })
      state.model.tabs[tab.id] = tab
      space.tabIds.push(tab.id)
    }
    const tabs = await suggestions.suggest('@tabs a', null, win, { grouped: true })
    expect(kinds(tabs)).toEqual(['tab', 'tab'])
    expect(tabs.every((r) => r.group === undefined)).toBe(true)
  })

  it('names the section under a default match of another kind', async () => {
    const { suggestions, history, win } = setup()
    history.visit('https://notes.example/vcs', 'Learning git basics', null)
    // "git" is no address and completes no host: the verbatim search leads, and the one
    // history page found by its title is a section.
    const rows = await suggestions.suggest('git', null, win, { grouped: true })
    expect(rows.map((r) => [r.kind, r.group])).toEqual([
      ['search', undefined],
      ['history', 'Pages']
    ])
  })

  it('keeps an answer with the default match, over the sections', async () => {
    const { suggestions, history, win } = setup()
    history.visit('https://2plus2.example/', '2+2 explained', null)
    const rows = await suggestions.suggest('2+2', null, win, { grouped: true })
    expect(rows.map((r) => [r.kind, r.group])).toEqual([
      ['search', undefined],
      ['answer', undefined],
      ['history', 'Pages']
    ])
  })

  it('labels zero-suggest’s pages "Recently visited" under the recent searches', async () => {
    const { suggestions, shortcuts, history, win } = setup()
    history.visit('https://recent.example/', 'Recent page', null)
    shortcuts.learn('ca', {
      url: 'https://www.google.com/search?q=cats',
      title: 'cats',
      kind: 'search',
      engineId: 'google'
    })
    const rows = await suggestions.suggest('', null, win, { grouped: true })
    expect(rows.map((r) => [r.kind, r.group])).toEqual([
      ['search', 'Recent searches'],
      ['history', 'Recently visited']
    ])
    // The desktop keeps its one heading.
    const flat = await suggestions.suggest('', null, win)
    expect(flat.map((r) => r.group)).toEqual(['Recent searches', undefined])
  })

  it('draws no heading over zero-suggest’s pages alone, one over them under a clipboard row', async () => {
    const { suggestions, history, win } = setup()
    history.visit('https://recent.example/', 'Recent page', null)
    history.visit('https://older.example/', 'Older page', null)
    const rows = await suggestions.suggest('', null, win, { grouped: true })
    expect(rows.map((r) => r.group)).toEqual([undefined, undefined])

    const withClip = setup()
    withClip.history.visit('https://recent.example/', 'Recent page', null)
    ;(withClip.suggestions as unknown as { browser: Browser }).browser.searchEngines.peekClipboard =
      async () => 'url' as const
    const clipped = await withClip.suggestions.suggest('', null, withClip.win, { grouped: true })
    expect(clipped.map((r) => [r.kind, r.group])).toEqual([
      ['clipboard', undefined],
      ['history', 'Recently visited']
    ])
  })
})

/*
 * Tab group rows (OMN-15; Chrome for Android's `TabGroupProvider`, components/omnibox/browser/
 * tab_group_provider.cc): typing a group's name offers "Open tab group". Chrome matches every
 * term of the query as a word prefix of the group's title or of a member page's address
 * (`ALWAYS_PREFIX_SEARCH`), scores the group by its `ScoringFunctor` over the hits normalised
 * against the title's length + 10 (`kMaxScore` 1000, "sharing a group with open tab matches"),
 * surfaces no unnamed group and none for an off-the-record client, and lists the group's
 * addresses with the matching one first.
 */
describe('SuggestionService: tab group rows (OMN-15)', () => {
  type Fixture = ReturnType<typeof setup>

  /** A tab of the first space, in `folderId`'s group when given. */
  function addTab(
    s: Fixture,
    id: string,
    url: string,
    title: string,
    folderId: string | null = null,
    containerId?: string
  ): void {
    const space = s.state.model.spaces[0]
    const tab = createTabRecord({
      id,
      url,
      title,
      spaceId: space.id,
      containerId: containerId ?? space.containerId,
      folderId
    })
    s.state.model.tabs[tab.id] = tab
    space.tabIds.push(tab.id)
  }

  /** A group of the first space with `pages` as its live tabs. */
  function addGroup(s: Fixture, name: string, pages: string[]): string {
    const space = s.state.model.spaces[0]
    const folder = createFolder(s.state.model, space.id, name, '📁')
    pages.forEach((url, i) => addTab(s, `${folder.id}_tab${i}`, url, `Page ${i}`, folder.id))
    return folder.id
  }

  const folderRows = (rows: Suggestion[]): Suggestion[] => rows.filter((r) => r.kind === 'folder')

  it('offers a group whose name the typing starts, as its name over its sites', async () => {
    const s = setup()
    const research = addGroup(s, 'Research', [
      'https://www.arxiv.org/abs/1234',
      'https://scholar.google.com/q',
      'https://arxiv.org/abs/5678'
    ])
    addGroup(s, 'Trip', ['https://maps.example/'])
    const rows = await s.suggestions.suggest('res', null, s.win)
    expect(folderRows(rows)).toEqual([
      {
        id: `folder:${research}`,
        kind: 'folder',
        title: 'Research',
        // The sites once each, `www.` off, as the addresses of a group read (Chrome's format).
        subtitle: 'arxiv.org, scholar.google.com',
        url: null,
        favicon: null,
        targetId: research,
        fill: 'res',
        relevance: RELEVANCE.folder
      }
    ])
    // Chrome's word-prefix rule: nothing inside a word, case folded.
    expect(folderRows(await s.suggestions.suggest('search', null, s.win))).toEqual([])
    expect(folderRows(await s.suggestions.suggest('RESEARCH', null, s.win))).toHaveLength(1)
  })

  it('finds a group by a member page’s address too, that site listed first', async () => {
    const s = setup()
    const reading = addGroup(s, 'Reading', [
      'https://news.example/today',
      'https://www.scholar.example/paper'
    ])
    const rows = await s.suggestions.suggest('scholar', null, s.win)
    expect(folderRows(rows)).toMatchObject([
      { targetId: reading, title: 'Reading', subtitle: 'scholar.example, news.example' }
    ])
    // Every term must start a word of the title or of a page: "reading paper" does, "reading
    // tomorrow" does not; a term inside an address's word ("xample") matches nothing.
    expect(folderRows(await s.suggestions.suggest('reading paper', null, s.win))).toHaveLength(1)
    expect(folderRows(await s.suggestions.suggest('reading tomorrow', null, s.win))).toEqual([])
    expect(folderRows(await s.suggestions.suggest('xample', null, s.win))).toEqual([])
  })

  it('keeps the three best by Chrome’s score: a name matched whole over one merely started', async () => {
    const s = setup()
    const long = addGroup(s, 'Docs for the big project', ['https://a.example/'])
    const docs = addGroup(s, 'Docs', ['https://b.example/'])
    const docsWork = addGroup(s, 'Docs work', ['https://c.example/'])
    const docsHome = addGroup(s, 'Docs home', ['https://d.example/'])
    const rows = folderRows(await s.suggestions.suggest('docs', null, s.win))
    expect(rows).toHaveLength(3)
    // "Docs" whole: 4 · 4/4 over 4 + 10 = .286; "Docs work" and "Docs home": 4/19 = .21 each,
    // in the model's order; the long name's 4/34 = .12 is the fourth and dropped.
    expect(rows.map((r) => r.targetId)).toEqual([docs, docsWork, docsHome])
    expect(rows.map((r) => r.relevance)).toEqual([
      RELEVANCE.folder,
      RELEVANCE.folder - 1,
      RELEVANCE.folder - 2
    ])
    expect(rows.some((r) => r.targetId === long)).toBe(false)
  })

  it('scores as Chrome’s TabGroupProvider: hits weighted to the text’s start, over the title’s length + 10', () => {
    // "Docs" typed whole against "Docs": one hit of 4 at 0 in a text of 4 → 4; 4 / 14 → 286.
    expect(groupMatch(['docs'], 'Docs', ['https://a.example/'])?.score).toBeCloseTo(
      (4 / 14) * GROUP_MAX_SCORE
    )
    // "do" against "Docs to do": two prefixed words, at 0 (2 · 10/10) and at 8 (2 · 2/10); over 20.
    expect(groupMatch(['do'], 'Docs to do', ['https://a.example/'])?.score).toBeCloseTo(
      ((2 + 0.4) / 20) * GROUP_MAX_SCORE
    )
    // A title hit and an address hit add up (the title's 2 · 2/2, the address's 2 · 11/11 in
    // "ab.example/"); the factors are capped at 1, Chrome's 1000.
    const both = groupMatch(['ab'], 'Ab', ['https://ab.example/'])
    expect(both?.matchingUrl).toBe('https://ab.example/')
    expect(both?.score).toBeCloseTo(((2 + 2) / 12) * GROUP_MAX_SCORE)
    expect(groupMatch(['ab', 'ab', 'ab'], 'Ab', ['https://ab.example/'])?.score).toBe(
      GROUP_MAX_SCORE
    )
    // A term that starts no word of the title or of any address is no match; no terms, none.
    expect(groupMatch(['ocs'], 'Docs', ['https://a.example/'])).toBeNull()
    expect(groupMatch(['docs', 'zzz'], 'Docs', ['https://a.example/'])).toBeNull()
    expect(groupMatch([], 'Docs', [])?.score).toBe(0)
  })

  it('stands under the open tabs and over the pages that merely start or hold the term', async () => {
    const s = setup()
    addTab(s, 'tab_docs', 'https://docs.example/guide', 'Docs guide')
    addGroup(s, 'Docs', ['https://docs.example/inside'])
    // A page whose title starts with the typing (980), a bookmark holding it (950).
    s.history.visit('https://archive.example/old', 'Docs of old', null)
    s.bookmarks.create({ title: 'My docs mark', url: 'https://marks.example/m' })
    const rows = await s.suggestions.suggest('docs', null, s.win)
    const k = kinds(rows)
    expect(k.indexOf('tab')).toBeLessThan(k.indexOf('folder'))
    expect(k.indexOf('folder')).toBeLessThan(k.indexOf('history'))
    expect(k.indexOf('folder')).toBeLessThan(k.indexOf('bookmark'))
    expect(rows.find((r) => r.kind === 'folder')?.relevance).toBe(RELEVANCE.folder)
    // A tab merely containing the typing (Chrome's 1000) still outranks the group's row.
    const t = setup()
    addTab(t, 'tab_mid', 'https://inner.example/', 'The docs page')
    addGroup(t, 'Docs', ['https://docs.example/inside'])
    const mixed = kinds(await t.suggestions.suggest('docs', null, t.win))
    expect(mixed.indexOf('tab')).toBeLessThan(mixed.indexOf('folder'))
  })

  it('offers a saved group by its kept pages, and no empty, unnamed or private one', async () => {
    const s = setup()
    const m = s.state.model
    const space = m.spaces[0]
    const saved = createFolder(m, space.id, 'Trip', '📁', 'green')
    saved.savedTabs = [
      { url: 'https://hotel.example/booking', title: 'Booking' },
      { url: 'zen://newtab', title: 'New Tab' }
    ]
    createFolder(m, space.id, 'Trip planning', '📁')
    createFolder(m, space.id, '', '📁').savedTabs = [{ url: 'https://trip.example/', title: '' }]
    const secret = createFolder(m, space.id, 'Trip secrets', '📁')
    addTab(s, 'tab_private', 'https://secret.example/', 'Secret', secret.id, PRIVATE_CONTAINER_ID)
    const rows = folderRows(await s.suggestions.suggest('trip', null, s.win))
    expect(rows).toMatchObject([{ targetId: saved.id, title: 'Trip', subtitle: 'hotel.example' }])
    // A group whose pages are internal ones alone has nothing to list.
    saved.savedTabs = [{ url: 'zen://settings', title: 'Settings' }]
    expect(folderRows(await s.suggestions.suggest('trip', null, s.win))).toEqual([])
  })

  it('offers none in a private window or from a private tab, and none in keyword mode', async () => {
    const s = setup('private')
    addGroup(s, 'Docs', ['https://docs.example/'])
    expect(folderRows(await s.suggestions.suggest('docs', null, s.win))).toEqual([])

    const t = setup()
    addGroup(t, 'Docs', ['https://docs.example/'])
    addTab(t, 'tab_private', 'https://p.example/', 'Private', null, PRIVATE_CONTAINER_ID)
    expect(folderRows(await t.suggestions.suggest('docs', 'tab_private', t.win))).toEqual([])
    expect(folderRows(await t.suggestions.suggest('docs', null, t.win))).toHaveLength(1)
    expect(folderRows(await t.suggestions.suggest('@tabs docs', null, t.win))).toEqual([])
    expect(folderRows(await t.suggestions.suggest('@ddg docs', null, t.win))).toEqual([])
  })

  it('sections the phone card’s group row with the open tabs, under Chrome’s heading for both', async () => {
    const s = setup()
    addTab(s, 'tab_docs', 'https://docs.example/guide', 'Docs guide')
    addGroup(s, 'Docs', ['https://inside.example/'])
    s.history.visit('https://archive.example/old', 'Docs of old', null)
    const rows = await s.suggestions.suggest('docs', null, s.win, { grouped: true })
    expect(rows.map((r) => [r.kind, r.group])).toEqual([
      ['search', undefined],
      ['history', 'Pages'],
      ['tab', 'Tabs and tab groups'],
      ['folder', 'Tabs and tab groups']
    ])
    // Without a group row the section is the open tabs' as before.
    const t = setup()
    addTab(t, 'tab_docs', 'https://docs.example/guide', 'Docs guide')
    t.history.visit('https://archive.example/old', 'Docs of old', null)
    const plain = await t.suggestions.suggest('docs', null, t.win, { grouped: true })
    expect(plain.map((r) => [r.kind, r.group])).toEqual([
      ['search', undefined],
      ['history', 'Pages'],
      ['tab', 'Open tabs']
    ])
  })
})

describe('SuggestionService: zero-suggest on the touch layouts (OMN-04)', () => {
  const learnSearch = (
    shortcuts: OmniboxShortcutsService,
    terms: string,
    engineId = 'google'
  ): void =>
    shortcuts.learn(terms, {
      url: `https://www.google.com/search?q=${encodeURIComponent(terms)}`,
      title: terms,
      kind: 'search',
      engineId
    })
  const phone = (win: ZenWindow): ZenWindow => {
    win.formFactor = 'phone'
    return win
  }
  const openTab = (state: BrowserState, id: string, url: string): void => {
    const space = state.model.spaces[0]
    const tab = createTabRecord({
      id,
      url,
      title: id,
      spaceId: space.id,
      containerId: space.containerId
    })
    state.model.tabs[tab.id] = tab
    space.tabIds.push(tab.id)
  }

  it("reads the searches the history holds into Recent searches: the default engine's results pages and another engine's, the terms parsed back, a plain page ignored", async () => {
    const { suggestions, history, win } = setup()
    phone(win)
    history.visit(
      'https://www.google.com/search?q=cats&sourceid=chrome',
      'cats - Google Search',
      null,
      { at: NOW - 3000 }
    )
    history.visit('https://duckduckgo.com/?q=two+words&t=h_', 'two words at DuckDuckGo', null, {
      at: NOW - 2000
    })
    history.visit('https://news.example/story', 'A story', null, { at: NOW - 1000 })
    const rows = await suggestions.suggest('', null, win)
    const recent = rows.filter((r) => r.group === 'Recent searches')
    expect(recent.map((r) => [r.title, r.subtitle, r.targetId, r.url])).toEqual([
      [
        'two words',
        'Search with DuckDuckGo',
        'duckduckgo',
        'https://duckduckgo.com/?q=two%20words'
      ],
      ['cats', 'Search with Google', 'google', 'https://www.google.com/search?q=cats']
    ])
    expect(recent.every((r) => r.kind === 'search' && r.deletable && r.fill === r.title)).toBe(true)
    // The results pages the rows stand for are not recent pages as well; the story stands as a
    // tile (every host is one here, three of the eight slots), so no recent page is left.
    expect(rows.filter((r) => r.kind === 'history')).toEqual([])
    expect(rows.filter((r) => r.group === 'Most visited').map((r) => r.url)).toContain(
      'https://news.example/story'
    )
  })

  it("merges the remembered searches with the history's: the same terms once, dated by the later of the two, most recent first, eight at most", async () => {
    const { suggestions, shortcuts, history, win } = setup()
    phone(win)
    learnSearch(shortcuts, 'cats')
    // The same search made again later on the engine's own page: one row, at its newer date.
    history.visit('https://www.google.com/search?q=Cats&sca_esv=1', 'Cats', null, {
      at: NOW + 5000
    })
    history.visit('https://www.google.com/search?q=older', 'older', null, { at: NOW - 60_000 })
    history.visit('https://www.google.com/search?q=newest', 'newest', null, { at: NOW + 9000 })
    const rows = await suggestions.suggest('', null, win)
    const recent = rows.filter((r) => r.group === 'Recent searches')
    expect(recent.map((r) => r.title)).toEqual(['newest', 'cats', 'older'])
    // The remembered pick's row is the one shown for its terms: its address, its id.
    expect(recent[1]).toMatchObject({
      url: 'https://www.google.com/search?q=cats',
      id: 'recent:https://www.google.com/search?q=cats'
    })

    for (let i = 0; i < 10; i += 1)
      history.visit(`https://www.google.com/search?q=q${i}`, `q${i}`, null, {
        at: NOW + 10_000 + i
      })
    const capped = await suggestions.suggest('', null, win)
    expect(capped.filter((r) => r.group === 'Recent searches')).toHaveLength(8)
    expect(capped.filter((r) => r.group === 'Recent searches')[0].title).toBe('q9')
  })

  it('lists the most visited sites as a "Most visited" group of address rows first, the recent pages minus the pages the tiles stand for', async () => {
    const { suggestions, history, newTab, win } = setup()
    phone(win)
    // Three sites: a.example's front page visited often (its tile) and another of its pages once,
    // b.example's home a few times, c.example's page once – every host is a tile (three of the
    // eight slots); only the page no tile stands for is a recent page.
    for (let i = 0; i < 5; i += 1)
      history.visit('https://a.example/', 'A', 'https://a.example/icon.png', {
        at: NOW - 100_000 + i
      })
    for (let i = 0; i < 3; i += 1)
      history.visit('https://www.b.example/home', 'B', null, { at: NOW - 90_000 + i })
    history.visit('https://c.example/page', 'C', null, { at: NOW - 1000 })
    history.visit('https://a.example/other', 'A other', null, { at: NOW })
    const rows = await suggestions.suggest('', null, win)
    expect(rows.map((r) => [r.kind, r.group ?? null])).toEqual([
      ['url', 'Most visited'],
      ['url', 'Most visited'],
      ['url', 'Most visited'],
      ['history', null]
    ])
    expect(rows[0]).toMatchObject({
      id: 'tile:https://a.example/',
      title: 'A',
      subtitle: 'a.example',
      url: 'https://a.example/',
      favicon: 'https://a.example/icon.png',
      fill: 'a.example'
    })
    expect(rows[0].deletable).toBeUndefined()
    expect(rows.slice(1, 3).map((r) => r.url)).toEqual([
      'https://www.b.example/home',
      'https://c.example/page'
    ])
    // The pages the tiles stand for are not recent pages as well; a.example's other page is.
    expect(rows[3].url).toBe('https://a.example/other')

    // The page's exclusions are the row's: a site removed from the page is no tile here either,
    // and its pages are recent pages again.
    newTab.hiddenHosts.push('a.example')
    const hidden = await suggestions.suggest('', null, win)
    expect(hidden.filter((r) => r.group === 'Most visited').map((r) => r.url)).toEqual([
      'https://www.b.example/home',
      'https://c.example/page'
    ])
    expect(hidden.filter((r) => r.kind === 'history').map((r) => r.url)).toEqual([
      'https://a.example/other',
      'https://a.example/'
    ])
  })

  it('caps the tiles at eight and lists them on the tablet layout too', async () => {
    const { suggestions, history, win } = setup()
    win.formFactor = 'tablet'
    for (let i = 0; i < 12; i += 1)
      history.visit(`https://site${i}.example/`, `Site ${i}`, null, { at: NOW - i })
    const rows = await suggestions.suggest('', null, win)
    expect(rows.filter((r) => r.group === 'Most visited')).toHaveLength(8)
  })

  it("the row is the page's list as the page gives it (the Lead's fold on #725): a pinned shortcut is a tile in its place, an untitled one named by its host; no tiles at all while the page has none", async () => {
    const { suggestions, history, newTab, win } = setup()
    phone(win)
    for (let i = 0; i < 3; i += 1) history.visit('https://a.example/', 'A', null, { at: NOW - i })
    // The page under "most visited" with a shortcut pinned: the shortcut fronts, the most
    // visited site follows – the very list `NewTabService.pageTiles` composes.
    newTab.tiles = [
      { url: 'https://mine.example/', title: '', favicon: null },
      { url: 'https://a.example/', title: 'A', favicon: null }
    ]
    const rows = await suggestions.suggest('', null, win)
    expect(rows.filter((r) => r.group === 'Most visited')).toMatchObject([
      { id: 'tile:https://mine.example/', title: 'mine.example', url: 'https://mine.example/' },
      { id: 'tile:https://a.example/', title: 'A', url: 'https://a.example/' }
    ])
    // A page with no tiles – its shortcuts section off, or "my shortcuts" with none pinned –
    // gives the omnibox no row; the pages the tiles would have stood for are recent pages.
    newTab.tiles = []
    const none = await suggestions.suggest('', null, win)
    expect(none.some((r) => r.group === 'Most visited')).toBe(false)
    expect(none.map((r) => [r.kind, r.url])).toEqual([['history', 'https://a.example/']])
  })

  it("offers no tiles over the default engine's results page (Chrome's SRP classification), the recent searches and pages as ever; another engine's results page and a plain page get them", async () => {
    const { suggestions, history, state, shortcuts, win } = setup()
    phone(win)
    for (let i = 0; i < 3; i += 1) history.visit('https://a.example/', 'A', null, { at: NOW - i })
    learnSearch(shortcuts, 'cats')
    expect(state.defaultSearchEngine().id).toBe('google')
    openTab(state, 'tab_srp', 'https://www.google.com/search?q=cats&sourceid=chrome')
    openTab(state, 'tab_other_srp', 'https://duckduckgo.com/?q=cats&t=h_')
    openTab(state, 'tab_web', 'https://news.example/')
    const onResults = await suggestions.suggest('', 'tab_srp', win)
    expect(onResults.some((r) => r.group === 'Most visited')).toBe(false)
    expect(onResults.map((r) => r.group ?? r.kind)).toEqual(['Recent searches', 'history'])
    for (const tabId of ['tab_other_srp', 'tab_web']) {
      const rows = await suggestions.suggest('', tabId, win)
      expect(rows.map((r) => r.group ?? r.kind)).toEqual(['Most visited', 'Recent searches'])
    }
  })

  it('offers no tiles over the new tab page itself (Chrome: the page already shows them), the recent searches and pages as ever', async () => {
    const { suggestions, history, state, shortcuts, win } = setup()
    phone(win)
    for (let i = 0; i < 3; i += 1) history.visit('https://a.example/', 'A', null, { at: NOW - i })
    learnSearch(shortcuts, 'cats')
    openTab(state, 'tab_ntp', 'zen://blank')
    openTab(state, 'tab_newtab', 'zen://newtab')
    openTab(state, 'tab_web', 'https://news.example/')
    for (const tabId of ['tab_ntp', 'tab_newtab']) {
      const rows = await suggestions.suggest('', tabId, win)
      expect(rows.some((r) => r.group === 'Most visited')).toBe(false)
      expect(rows.map((r) => r.group ?? r.kind)).toEqual(['Recent searches', 'history'])
    }
    const onPage = await suggestions.suggest('', 'tab_web', win)
    expect(onPage.map((r) => r.group ?? r.kind)).toEqual(['Most visited', 'Recent searches'])
  })

  it('changes nothing while the user types: no tiles, no rows read from the history', async () => {
    const { suggestions, history, win } = setup()
    phone(win)
    for (let i = 0; i < 3; i += 1)
      history.visit('https://cats.example/', 'Cats site', null, { at: NOW - i })
    history.visit('https://www.google.com/search?q=cats', 'cats', null, { at: NOW })
    const typed = await suggestions.suggest('c', null, win)
    expect(typed.length).toBeGreaterThan(0)
    expect(typed.some((r) => r.group === 'Most visited' || r.id.startsWith('tile:'))).toBe(false)
    expect(typed.some((r) => r.id.startsWith('recent:'))).toBe(false)
  })

  it("the desktop's list is as it was: no tiles, the history's results pages recent pages, the remembered searches alone under Recent searches", async () => {
    const { suggestions, history, shortcuts, win } = setup()
    expect(win.formFactor).toBe('desktop')
    for (let i = 0; i < 3; i += 1)
      history.visit('https://a.example/', 'A', null, { at: NOW - 1000 - i })
    history.visit('https://www.google.com/search?q=dogs', 'dogs', null, { at: NOW })
    learnSearch(shortcuts, 'cats')
    const rows = await suggestions.suggest('', null, win)
    expect(rows.map((r) => [r.kind, r.group ?? null, r.url])).toEqual([
      ['search', 'Recent searches', 'https://www.google.com/search?q=cats'],
      ['history', null, 'https://www.google.com/search?q=dogs'],
      ['history', null, 'https://a.example/']
    ])
  })

  it("the phone card keeps the tiles' group and heads the recent pages (groupForCard)", async () => {
    const { suggestions, history, shortcuts, win } = setup()
    phone(win)
    for (let i = 0; i < 3; i += 1)
      history.visit('https://a.example/', 'A', null, { at: NOW - 1000 - i })
    history.visit('https://a.example/other', 'A other', null, { at: NOW - 500 })
    learnSearch(shortcuts, 'cats')
    const rows = await suggestions.suggest('', null, win, { grouped: true })
    expect(rows.map((r) => r.group)).toEqual([
      'Most visited',
      'Recent searches',
      'Recently visited'
    ])
  })
})
