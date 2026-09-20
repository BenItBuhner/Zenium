import { describe, expect, it, vi } from 'vitest'
import { PRIVATE_CONTAINER_ID, type HostCapabilities, type Suggestion } from '../../shared/types'
import { BOOKMARKS_BAR_ID, OTHER_BOOKMARKS_ID } from '../../shared/bookmarks'
import type { NetHost, StoreIO } from '../platform'
import type { Browser } from '../browser'
import { BookmarkService } from '../bookmarks'
import { HistoryService } from '../history'
import { createTabRecord } from '../model'
import { BrowserState } from '../state'
import { RELEVANCE, SuggestionService, isIntranetWord } from '../suggestions'
import { ZenWindow } from '../window'

const io: StoreIO = {
  readSync: () => null,
  write: async () => {},
  writeSync: () => {}
}

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
  win: ZenWindow
  net: FakeNet
  state: BrowserState
} {
  const state = new BrowserState(io, 'linux', {} as HostCapabilities, '0.0')
  state.load()
  // Live engine suggestions need the network; tests turn it on with a fake host.
  state.settings.searchSuggestions = opts.online ?? false
  const bookmarks = new BookmarkService(state)
  const history = new HistoryService(io)
  const net = fakeNet(opts.resolver ?? true)
  // No extension holds an omnibox keyword: the URL bar's own sources answer.
  const extensions = { omniboxSuggest: async () => null }
  // Nothing on the clipboard: the empty state (nothing typed) is the recent history alone.
  const searchEngines = { peekClipboard: async () => 'none' as const }
  const browser = {
    state,
    bookmarks,
    history,
    extensions,
    searchEngines,
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
  return { suggestions, bookmarks, history, win, net, state }
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
