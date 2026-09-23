import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform as PlatformOs } from '../../shared/types'
import { PRIVATE_CONTAINER_ID } from '../../shared/types'
import { DEFAULT_SETTINGS } from '../../shared/defaults'
import {
  DEFAULT_SEARCH_ENGINES,
  MAX_OPENSEARCH_BYTES,
  isActiveSearchEngine,
  matchEngineKeyword,
  matchEngineWord,
  sanitizeSearchEngines
} from '../../shared/search'
import { Browser } from '../browser'
import type {
  AppHost,
  ClipboardHost,
  NetHost,
  Platform,
  StoreIO,
  TabView,
  TabViewHost,
  WindowHost
} from '../platform'
import { BrowserState } from '../state'
import type { ZenWindow } from '../window'

/*
 * The user's search engines (OMN-27) and the URL bar's clipboard row (OMN-14) in the core: a
 * page's OpenSearch description is fetched off the page and becomes a "Recently visited" engine
 * in the settings, Settings > Search adds and removes engines and the default falls back when
 * its engine goes, and the clipboard row's peek reads the clip's description while the content
 * is read once, on the reveal.
 */

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

interface Fakes {
  /** Every description fetch: the URL, the headers and the byte cap it went with. */
  fetches: Array<{
    url: string
    headers: Record<string, string> | undefined
    maxBytes?: number | undefined
  }>
  /** Body served per URL substring; unknown URLs get a 404. */
  routes: Array<{ match: string; body: string; status?: number }>
  /** How often the host was asked for the clip's description and for its content. */
  peeks: number
  reads: number
  /** How often the host was told the clip was used (opened through the row). */
  marks: number
  clip: { kind: 'url' | 'text' | 'image' | 'none'; text: string }
}

function fakePlatform(io: StoreIO): Platform & { fakes: Fakes } {
  const fakes: Fakes = {
    fetches: [],
    routes: [],
    peeks: 0,
    reads: 0,
    marks: 0,
    clip: { kind: 'none', text: '' }
  }
  const net = stub<NetHost>({
    fetchText: async (url, options) => {
      fakes.fetches.push({ url, headers: options?.headers, maxBytes: options?.maxBytes })
      const route = fakes.routes.find((r) => url.includes(r.match))
      if (!route) return { ok: false, status: 404, text: '' }
      const status = route.status ?? 200
      // As the hosts do: a body past the caller's cap stops the download and fails the fetch.
      if (options?.maxBytes !== undefined && route.body.length > options.maxBytes) {
        return { ok: false, status: 0, text: '' }
      }
      return { ok: status < 400, status, text: route.body }
    }
  })
  const clipboard = stub<ClipboardHost>({
    peek: async () => {
      fakes.peeks++
      return fakes.clip.kind
    },
    read: async () => {
      fakes.reads++
      return fakes.clip.text
    },
    readText: async () => {
      fakes.reads++
      return fakes.clip.text
    },
    markUsed: () => {
      fakes.marks++
    }
  })
  return {
    fakes,
    info: { os: 'linux' as PlatformOs, version: '0.0.0' },
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
    clipboard,
    shell: stub(),
    net,
    downloads: stub(),
    sessions: stub(),
    app: stub<AppHost>(),
    readabilitySource: () => null
  }
}

const FORUM_XML = `<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>Forum</ShortName>
  <Url type="text/html" template="https://forum.example/search?q={searchTerms}"/>
  <Url type="application/x-suggestions+json" template="https://forum.example/suggest?q={searchTerms}"/>
  <Image width="16" height="16">/favicon.ico</Image>
</OpenSearchDescription>`

function setup(): {
  browser: Browser
  win: ZenWindow
  platform: Platform & { fakes: Fakes }
  io: ReturnType<typeof memoryIo>
} {
  const io = memoryIo()
  const platform = fakePlatform(io)
  const browser = new Browser(platform)
  browser.start()
  const win = browser.allWindows()[0] as ZenWindow
  return { browser, win, platform, io }
}

/** A tab on `url`, as if it had navigated there. */
function pageTab(browser: Browser, win: ZenWindow, url: string): string {
  const tab = browser.tabs.createTab({ url, active: true }, win)
  tab.title = 'A page'
  return tab.id
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r))
}

describe('OpenSearch discovery', () => {
  it('fetches the linked description off the page and remembers the engine as visited', async () => {
    const { browser, win, platform } = setup()
    platform.fakes.routes.push({ match: 'opensearch.xml', body: FORUM_XML })
    const tabId = pageTab(browser, win, 'https://forum.example/t/1')

    browser.handlePageMessage(tabId, {
      type: 'opensearch',
      url: 'https://forum.example/opensearch.xml',
      title: 'Forum search'
    })
    await settle()

    expect(platform.fakes.fetches).toHaveLength(1)
    expect(platform.fakes.fetches[0].url).toBe('https://forum.example/opensearch.xml')
    expect(platform.fakes.fetches[0].headers?.Accept).toContain(
      'application/opensearchdescription+xml'
    )
    const own = browser.state.settings.searchEngines ?? []
    expect(own).toHaveLength(1)
    expect(own[0]).toMatchObject({
      id: 'discovered:forum.example',
      name: 'Forum',
      searchUrl: 'https://forum.example/search?q=%s',
      suggestUrl: 'https://forum.example/suggest?q=%s',
      favicon: 'https://forum.example/favicon.ico',
      source: 'discovered'
    })
    expect(own[0].visitedAt).toBeGreaterThan(0)
    // The profile's list offers it after the shipped engines; the default is unchanged.
    expect(browser.state.searchEngines.map((e) => e.id)).toEqual([
      ...DEFAULT_SEARCH_ENGINES.map((e) => e.id),
      'discovered:forum.example'
    ])
    expect(browser.state.settings.searchEngineId).toBe(DEFAULT_SETTINGS.searchEngineId)

    // The same site browsed on: one fetch per description, not one per page.
    browser.handlePageMessage(tabId, {
      type: 'opensearch',
      url: 'https://forum.example/opensearch.xml'
    })
    await settle()
    expect(platform.fakes.fetches).toHaveLength(1)
  })

  it('ignores private tabs, relative-only garbage, unreachable and malformed descriptions', async () => {
    const { browser, win, platform } = setup()
    const tabId = pageTab(browser, win, 'https://forum.example/t/1')
    const tab = browser.tabs.tab(tabId)!

    // A private tab leaves no trace, not even a fetch.
    const container = tab.containerId
    tab.containerId = PRIVATE_CONTAINER_ID
    browser.handlePageMessage(tabId, { type: 'opensearch', url: '/opensearch.xml' })
    await settle()
    expect(platform.fakes.fetches).toHaveLength(0)
    tab.containerId = container

    // Not http(s): nothing to fetch.
    browser.handlePageMessage(tabId, { type: 'opensearch', url: 'javascript:alert(1)' })
    await settle()
    expect(platform.fakes.fetches).toHaveLength(0)

    // A 404 and an HTML page in place of the description leave the settings alone.
    platform.fakes.routes.push({ match: 'broken.xml', body: '<html>nope</html>' })
    browser.handlePageMessage(tabId, { type: 'opensearch', url: '/missing.xml' })
    browser.handlePageMessage(tabId, { type: 'opensearch', url: '/broken.xml' })
    await settle()
    expect(platform.fakes.fetches.map((f) => f.url)).toEqual([
      'https://forum.example/missing.xml',
      'https://forum.example/broken.xml'
    ])
    expect(browser.state.settings.searchEngines).toEqual([])
  })

  it('caps the download at 64 KB and remembers a tried description, good or bad, for the refresh window', async () => {
    const { browser, win, platform } = setup()
    const tabId = pageTab(browser, win, 'https://forum.example/t/1')
    // An oversized description: the host stops at the cap and fails the fetch, no engine.
    const padding = `<!-- ${'x'.repeat(MAX_OPENSEARCH_BYTES)} -->`
    platform.fakes.routes.push({
      match: 'huge.xml',
      body: FORUM_XML.replace('</Open', `${padding}</Open`)
    })
    browser.handlePageMessage(tabId, { type: 'opensearch', url: '/huge.xml' })
    await settle()
    expect(platform.fakes.fetches).toHaveLength(1)
    // The cap travels with the request: the host bounds the transfer, not just the parse.
    expect(platform.fakes.fetches[0].maxBytes).toBe(MAX_OPENSEARCH_BYTES)
    expect(MAX_OPENSEARCH_BYTES).toBe(64 * 1024)
    expect(browser.state.settings.searchEngines).toEqual([])

    // Tried: the same page linking it again (a reload, the next page) does not fetch it again,
    // nor a malformed one or a 404 (each answered, each remembered) within the refresh window.
    platform.fakes.routes.push({ match: 'broken.xml', body: '<html>nope</html>' })
    browser.handlePageMessage(tabId, { type: 'opensearch', url: '/huge.xml' })
    browser.handlePageMessage(tabId, { type: 'opensearch', url: '/broken.xml' })
    browser.handlePageMessage(tabId, { type: 'opensearch', url: '/missing.xml' })
    await settle()
    browser.handlePageMessage(tabId, { type: 'opensearch', url: '/huge.xml' })
    browser.handlePageMessage(tabId, { type: 'opensearch', url: '/broken.xml' })
    browser.handlePageMessage(tabId, { type: 'opensearch', url: '/missing.xml' })
    await settle()
    expect(platform.fakes.fetches.map((f) => f.url.split('/').pop())).toEqual([
      'huge.xml',
      'broken.xml',
      'missing.xml'
    ])

    // A fetch that never answered (the network went away) is not remembered: tried again.
    let failures = 0
    const served = platform.net.fetchText
    platform.net.fetchText = async (url, options) => {
      if (url.endsWith('down.xml')) {
        failures++
        throw new Error('network')
      }
      return served(url, options)
    }
    browser.handlePageMessage(tabId, { type: 'opensearch', url: '/down.xml' })
    await settle()
    browser.handlePageMessage(tabId, { type: 'opensearch', url: '/down.xml' })
    await settle()
    expect(failures).toBe(2)
  })

  it('drops a description whose page the user has already left', async () => {
    const { browser, win, platform } = setup()
    let release: (() => void) | null = null
    platform.net.fetchText = async (url) => {
      platform.fakes.fetches.push({ url, headers: undefined })
      await new Promise<void>((r) => (release = r))
      return { ok: true, status: 200, text: FORUM_XML }
    }
    const tabId = pageTab(browser, win, 'https://forum.example/t/1')
    browser.handlePageMessage(tabId, { type: 'opensearch', url: '/opensearch.xml' })
    await settle()
    // Navigated away while the description was in flight.
    browser.tabs.tab(tabId)!.url = 'https://elsewhere.example/'
    release!()
    await settle()
    expect(browser.state.settings.searchEngines).toEqual([])
  })
})

describe('Settings > Search engines', () => {
  it('adds an engine by name and template, makes it the default and persists it', async () => {
    const { browser, win, io } = setup()
    const id = browser.handleCommand(win, 'search.addEngine', {
      name: 'Marginalia',
      url: 'https://search.marginalia.nu/search?query=%s'
    })
    expect(id).toBe('custom:marginalia')
    expect(browser.state.settings.searchEngines).toHaveLength(1)
    expect(browser.state.searchEngines.some((e) => e.id === id)).toBe(true)

    browser.handleCommand(win, 'settings.update', { searchEngineId: id })
    expect(browser.state.settings.searchEngineId).toBe(id)
    // The URL bar searches with it now.
    expect(browser.defaultSearchEngine().id).toBe(id)

    await settle()
    await browser.state.flush()
    const persisted = JSON.parse(io.files['state.json']).settings
    expect(persisted.searchEngineId).toBe(id)
    expect(persisted.searchEngines).toHaveLength(1)
  })

  it('refuses a template without %s or a name, with the reason the form shows', () => {
    const { browser, win } = setup()
    expect(() =>
      browser.handleCommand(win, 'search.addEngine', { name: 'X', url: 'https://x.example/search' })
    ).toThrow('Put %s where the search terms go')
    expect(() =>
      browser.handleCommand(win, 'search.addEngine', { name: '  ', url: 'https://x.example/?q=%s' })
    ).toThrow('Enter a name')
    expect(browser.state.settings.searchEngines).toEqual([])
  })

  it('falls back to the shipped default when the default engine is removed or unknown', () => {
    const { browser, win } = setup()
    const id = browser.handleCommand(win, 'search.addEngine', {
      name: 'Mine',
      url: 'https://mine.example/?q=%s'
    })
    browser.handleCommand(win, 'settings.update', { searchEngineId: id })
    browser.handleCommand(win, 'search.removeEngine', { id })
    expect(browser.state.settings.searchEngines).toEqual([])
    expect(browser.state.settings.searchEngineId).toBe(DEFAULT_SETTINGS.searchEngineId)

    // A peer's default this build has no engine for: the shipped default stands in.
    browser.handleCommand(win, 'settings.update', { searchEngineId: 'discovered:nowhere.example' })
    expect(browser.state.settings.searchEngineId).toBe(DEFAULT_SETTINGS.searchEngineId)
    // The shipped engines cannot be removed.
    browser.handleCommand(win, 'search.removeEngine', { id: 'google' })
    expect(browser.state.searchEngines).toHaveLength(DEFAULT_SEARCH_ENGINES.length)
  })

  it('loads a persisted list through the sanitiser and keeps a default that is in it', () => {
    const io = memoryIo({
      'state.json': JSON.stringify({
        version: 2,
        tabs: [],
        spaces: [],
        settings: {
          searchEngineId: 'custom:mine',
          searchEngines: [
            { id: 'custom:mine', name: 'Mine', searchUrl: 'https://mine.example/?q=%s' },
            { id: 'google', name: 'Evil', searchUrl: 'https://evil.example/?q=%s' },
            { id: 'custom:bad', name: 'Bad', searchUrl: 'not a url' }
          ]
        }
      })
    })
    const state = new BrowserState(io, 'linux', {} as HostCapabilities, '0.0')
    state.load()
    expect((state.settings.searchEngines ?? []).map((e) => e.id)).toEqual(['custom:mine'])
    expect(state.settings.searchEngineId).toBe('custom:mine')
    // A shipped id in the stored list never shadows the shipped engine.
    expect(state.searchEngines.find((e) => e.id === 'google')!.name).toBe('Google')
  })

  it('edits an engine – name, template and shortcut – deriving the shortcut when left empty (omnibox-09)', () => {
    const { browser, win } = setup()
    const id = browser.handleCommand(win, 'search.addEngine', {
      name: 'Marginalia',
      url: 'https://search.marginalia.nu/search?query=%s'
    })
    expect(browser.state.searchEngines.find((e) => e.id === id)!.keyword).toBe('@marginalia')

    browser.handleCommand(win, 'search.updateEngine', {
      id,
      name: 'Marginalia Search',
      searchUrl: 'https://search.marginalia.nu/search?query=%s&profile=modern',
      keyword: 'MS'
    })
    const edited = browser.state.searchEngines.find((e) => e.id === id)!
    // The shortcut takes its `@` and lower case; the glyph follows the name.
    expect(edited).toMatchObject({
      name: 'Marginalia Search',
      searchUrl: 'https://search.marginalia.nu/search?query=%s&profile=modern',
      keyword: '@ms',
      glyph: 'M',
      source: 'custom'
    })
    // The omnibox reads the persisted shortcut.
    expect(matchEngineKeyword('@ms rust', browser.state.searchEngines)?.engine.id).toBe(id)
    expect(matchEngineKeyword('@marginalia rust', browser.state.searchEngines)?.engine.id).toBe(
      undefined
    )

    // An empty shortcut derives one from the new name, unique among the others (`@google` is
    // the shipped engine's).
    browser.handleCommand(win, 'search.updateEngine', {
      id,
      name: 'Google',
      searchUrl: 'https://mirror.example/?q=%s',
      keyword: ''
    })
    expect(browser.state.searchEngines.find((e) => e.id === id)!.keyword).toBe('@google2')
  })

  it('refuses an edit with the reason the form shows, and the shipped engines are not edited', () => {
    const { browser, win } = setup()
    const id = browser.handleCommand(win, 'search.addEngine', {
      name: 'Mine',
      url: 'https://mine.example/?q=%s'
    })
    const edit = (patch: Partial<{ name: string; searchUrl: string; keyword: string }>): unknown =>
      browser.handleCommand(win, 'search.updateEngine', {
        id,
        name: 'Mine',
        searchUrl: 'https://mine.example/?q=%s',
        keyword: '@mine',
        ...patch
      })
    expect(() => edit({ name: ' ' })).toThrow('Enter a name')
    expect(() => edit({ searchUrl: 'https://mine.example/' })).toThrow(
      'Put %s where the search terms go'
    )
    expect(() => edit({ keyword: 'my engine' })).toThrow('A shortcut is one word, with no spaces')
    expect(() => edit({ keyword: '@ddg' })).toThrow('DuckDuckGo already answers to @ddg')
    expect(() => edit({ keyword: 'tabs' })).toThrow('@tabs is one of Zenium’s own shortcuts')
    expect(() =>
      browser.handleCommand(win, 'search.updateEngine', {
        id: 'google',
        name: 'Evil',
        searchUrl: 'https://evil.example/?q=%s',
        keyword: '@google'
      })
    ).toThrow('The engine is not one of yours to edit')
    expect(browser.state.searchEngines.find((e) => e.id === 'google')!.name).toBe('Google')
  })

  it('deactivates an engine out of the omnibox and activates it again; the default stays active (settings-43)', () => {
    const { browser, win } = setup()
    const id = browser.handleCommand(win, 'search.addEngine', {
      name: 'Mine',
      url: 'https://mine.example/?q=%s'
    })
    const engines = (): ReturnType<typeof browser.state.searchEngines.filter> =>
      browser.state.searchEngines
    expect(matchEngineKeyword('@mine x', engines())?.engine.id).toBe(id)
    expect(matchEngineWord('mine.example', engines())?.id).toBe(id)

    browser.handleCommand(win, 'search.setEngineActive', { id, active: false })
    const off = engines().find((e) => e.id === id)!
    expect(off.active).toBe(false)
    expect(isActiveSearchEngine(off)).toBe(false)
    // Kept, with its shortcut, but answering to nothing: not by keyword, not by host.
    expect(off.keyword).toBe('@mine')
    expect(matchEngineKeyword('@mine x', engines())).toBeNull()
    expect(matchEngineWord('mine.example', engines())).toBeNull()

    browser.handleCommand(win, 'search.setEngineActive', { id, active: true })
    const on = engines().find((e) => e.id === id)!
    expect(on.active).toBeUndefined()
    expect(matchEngineKeyword('@mine x', engines())?.engine.id).toBe(id)

    // The default engine stays active.
    browser.handleCommand(win, 'settings.update', { searchEngineId: id })
    expect(() =>
      browser.handleCommand(win, 'search.setEngineActive', { id, active: false })
    ).toThrow('The default search engine stays active')
    expect(engines().find((e) => e.id === id)!.active).toBeUndefined()
    // A shipped engine is not the user's to deactivate: nothing happens.
    browser.handleCommand(win, 'search.setEngineActive', { id: 'google', active: false })
    expect(engines().find((e) => e.id === 'google')!.active).toBeUndefined()
  })

  it('keeps a deactivated flag and an edited engine through the sanitiser and a site’s later visit', () => {
    const { browser, win } = setup()
    browser.searchEngines.remember({
      name: 'Wiki',
      searchUrl: 'https://wiki.example/w/index.php?search=%s',
      suggestUrl: null,
      favicon: null
    })
    const id = 'discovered:wiki.example'
    browser.handleCommand(win, 'search.setEngineActive', { id, active: false })
    // The site offers its description again: the engine stays deactivated.
    browser.searchEngines.remember({
      name: 'Wiki renamed',
      searchUrl: 'https://wiki.example/w/index.php?search=%s',
      suggestUrl: null,
      favicon: null
    })
    expect(browser.state.searchEngines.find((e) => e.id === id)).toMatchObject({
      name: 'Wiki renamed',
      source: 'discovered',
      active: false
    })
    // Edited, the engine is the user's own: the site's later description leaves it alone.
    browser.handleCommand(win, 'search.updateEngine', {
      id,
      name: 'My wiki',
      searchUrl: 'https://wiki.example/w/index.php?search=%s',
      keyword: '@w'
    })
    browser.searchEngines.remember({
      name: 'Wiki again',
      searchUrl: 'https://wiki.example/w/index.php?search=%s',
      suggestUrl: null,
      favicon: null
    })
    const mine = browser.state.searchEngines.find((e) => e.id === id)!
    expect(mine).toMatchObject({ name: 'My wiki', keyword: '@w', source: 'custom', active: false })
    expect(mine.visitedAt).toBeUndefined()

    const persisted = sanitizeSearchEngines(
      JSON.parse(JSON.stringify(browser.state.settings.searchEngines))
    )
    expect(persisted).toEqual(browser.state.settings.searchEngines)
  })
})

describe('the clipboard row', () => {
  it('peeks at the description only; the content is read once, on the reveal', async () => {
    const { browser, win, platform } = setup()
    platform.fakes.clip = { kind: 'url', text: ' https://copied.example/page ' }

    const rows = await browser.handleCommand(win, 'urlbar.suggest', { query: '', tabId: null })
    const list = (await rows) as Array<{ kind: string; title: string; fill: string; url: unknown }>
    expect(list[0]).toMatchObject({
      kind: 'clipboard',
      title: 'Link you copied',
      fill: '',
      url: null
    })
    // The list came from the description alone: no content crossed the bridge.
    expect(platform.fakes.peeks).toBe(1)
    expect(platform.fakes.reads).toBe(0)

    const content = await browser.handleCommand(win, 'clipboard.read', undefined)
    expect(content).toEqual({ kind: 'url', text: 'https://copied.example/page' })
    expect(platform.fakes.reads).toBe(1)
  })

  it('names text as text and shows no row for an image or an empty clip', async () => {
    const { browser, win, platform } = setup()
    const suggest = async (): Promise<Array<{ kind: string; title: string }>> =>
      (await browser.handleCommand(win, 'urlbar.suggest', { query: '', tabId: null })) as Array<{
        kind: string
        title: string
      }>
    platform.fakes.clip = { kind: 'text', text: 'two  words\nhere' }
    expect((await suggest())[0]).toMatchObject({ kind: 'clipboard', title: 'Text you copied' })
    expect(await browser.handleCommand(win, 'clipboard.read', undefined)).toEqual({
      kind: 'text',
      text: 'two words here'
    })
    // Zenium has no visual search: an image on the clipboard gets no row.
    platform.fakes.clip = { kind: 'image', text: '' }
    expect((await suggest()).some((r) => r.kind === 'clipboard')).toBe(false)
    platform.fakes.clip = { kind: 'none', text: '' }
    expect((await suggest()).some((r) => r.kind === 'clipboard')).toBe(false)
    // A clip that emptied between the peek and the read reads as nothing.
    expect(await browser.handleCommand(win, 'clipboard.read', undefined)).toEqual({
      kind: 'none',
      text: ''
    })
  })

  it('marks the clip used on the pick, through the host, and not on a host without the marker', async () => {
    const { browser, win, platform } = setup()
    platform.fakes.clip = { kind: 'url', text: 'https://copied.example/' }
    // The reveal is a read alone; the pick tells the host the clip is used up.
    await browser.handleCommand(win, 'clipboard.read', undefined)
    expect(platform.fakes.marks).toBe(0)
    await browser.handleCommand(win, 'clipboard.markUsed', undefined)
    expect(platform.fakes.marks).toBe(1)
    // A host without the marker offers the clip again; the command is a no-op there.
    delete (platform.clipboard as Partial<ClipboardHost>).markUsed
    await browser.handleCommand(win, 'clipboard.markUsed', undefined)
    expect(platform.fakes.marks).toBe(1)
  })

  it('offers no row on a host without the description peek', async () => {
    const { browser, win, platform } = setup()
    platform.fakes.clip = { kind: 'url', text: 'https://copied.example/' }
    delete (platform.clipboard as Partial<ClipboardHost>).peek
    const list = (await browser.handleCommand(win, 'urlbar.suggest', {
      query: '',
      tabId: null
    })) as Array<{ kind: string }>
    expect(list.some((r) => r.kind === 'clipboard')).toBe(false)
    expect(platform.fakes.reads).toBe(0)
  })
})
