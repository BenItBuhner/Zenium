import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SEARCH_ENGINES,
  allSearchEngines,
  buildSearchUrl,
  defaultSearchEngineOf,
  isPickableSearchEngine
} from '../../../shared/search'
import { validateManifest } from '../manifest'
import {
  extensionEngineId,
  resolveExtensionSearch,
  searchProviderOf,
  type InstalledSearchProvider
} from '../searchProvider'

const NORTON = 'mpnlkmlkncncpgnnkmkgoobfpnjmblnk'
const BING = 'ddojnmkongaimkdddgmcccldlfhokcfb'

/** Norton Safe Search's manifest key (round 3 row 25): every field spelled out. */
const nortonOverrides = {
  search_provider: {
    encoding: 'UTF-8',
    favicon_url: 'https://searchsafe.norton.com/img/logoicon.ico',
    is_default: true,
    keyword: 'nortonsafe',
    name: 'Norton Safe',
    search_url: 'https://searchsafe.norton.com/search?omnisearch=yes&q={searchTerms}'
  }
}

/** Bing Homepage & Search's (row 26): a prepopulated id, the store's `__PARAM__` in every URL. */
const bingOverrides = {
  homepage: 'https://www.bing.com/?pc=__PARAM__BG00',
  search_provider: {
    favicon_url: 'https://www.bing.com/favicon.ico',
    is_default: true,
    prepopulated_id: 3,
    search_url:
      'https://www.bing.com/search?EID=MBHSC&form=BGGCMF&pc=__PARAM__BG00&q={searchTerms}',
    suggest_url: 'https://www.bing.com/osjson.aspx?form=BGGCSS&pc=__PARAM__BG00&query={searchTerms}'
  },
  startup_pages: ['https://www.bing.com/?pc=__PARAM__BG00']
}

function manifest(overrides: unknown): Record<string, unknown> {
  return { manifest_version: 3, name: 'x', version: '1', chrome_settings_overrides: overrides }
}

describe('searchProviderOf', () => {
  it('reads a spelled-out provider into an extension engine holding the default', () => {
    const provider = searchProviderOf(
      { chrome_settings_overrides: nortonOverrides },
      NORTON,
      'Norton Safe Search'
    )!
    expect(provider.isDefault).toBe(true)
    expect(provider.extensionName).toBe('Norton Safe Search')
    expect(provider.engine).toMatchObject({
      id: extensionEngineId(NORTON),
      name: 'Norton Safe',
      keyword: 'nortonsafe',
      searchUrl: 'https://searchsafe.norton.com/search?omnisearch=yes&q=%s',
      suggestUrl: null,
      favicon: 'https://searchsafe.norton.com/img/logoicon.ico',
      source: 'extension'
    })
    expect(buildSearchUrl(provider.engine, 'zenium browser')).toBe(
      'https://searchsafe.norton.com/search?omnisearch=yes&q=zenium%20browser'
    )
  })

  it("fills a prepopulated id's name and keyword and drops the store's install parameter", () => {
    const provider = searchProviderOf({ chrome_settings_overrides: bingOverrides }, BING, 'Bing')!
    expect(provider.isDefault).toBe(true)
    expect(provider.engine).toMatchObject({
      name: 'Bing',
      keyword: 'bing.com',
      searchUrl: 'https://www.bing.com/search?EID=MBHSC&form=BGGCMF&pc=BG00&q=%s',
      suggestUrl: 'https://www.bing.com/osjson.aspx?form=BGGCSS&pc=BG00&query=%s',
      favicon: 'https://www.bing.com/favicon.ico'
    })
  })

  it('names an engine of an unknown prepopulated id after its host', () => {
    const provider = searchProviderOf(
      {
        chrome_settings_overrides: {
          search_provider: {
            prepopulated_id: 777,
            is_default: false,
            search_url: 'https://www.example.org/find?q={searchTerms}'
          }
        }
      },
      NORTON,
      'x'
    )!
    expect(provider.engine.name).toBe('example.org')
    expect(provider.engine.keyword).toBe('example.org')
    expect(provider.engine.suggestUrl).toBeNull()
    expect(provider.isDefault).toBe(false)
  })

  it('answers null for what Chrome drops, and no default for a URL without the terms', () => {
    expect(searchProviderOf({}, NORTON, 'x')).toBeNull()
    expect(searchProviderOf({ chrome_settings_overrides: {} }, NORTON, 'x')).toBeNull()
    const spelledOut = nortonOverrides.search_provider
    const without = (field: string): unknown => {
      const copy: Record<string, unknown> = { ...spelledOut }
      delete copy[field]
      return { chrome_settings_overrides: { search_provider: copy } }
    }
    for (const field of ['name', 'keyword', 'encoding', 'favicon_url']) {
      expect(searchProviderOf(without(field) as object, NORTON, 'x')).toBeNull()
    }
    expect(
      searchProviderOf(
        {
          chrome_settings_overrides: {
            search_provider: { ...spelledOut, search_url: 'ftp://x/%s' }
          }
        },
        NORTON,
        'x'
      )
    ).toBeNull()
    const noTerms = searchProviderOf(
      {
        chrome_settings_overrides: {
          search_provider: { ...spelledOut, search_url: 'https://searchsafe.norton.com/' }
        }
      },
      NORTON,
      'x'
    )!
    expect(noTerms.isDefault).toBe(false)
  })
})

describe('resolveExtensionSearch', () => {
  const installed = (id: string, at: number, isDefault: boolean): InstalledSearchProvider => ({
    installedAt: at,
    provider: searchProviderOf(
      {
        chrome_settings_overrides: {
          search_provider: { ...nortonOverrides.search_provider, is_default: isDefault }
        }
      },
      id,
      `Extension ${id}`
    )!
  })

  it('lists the engines in install order and gives the default to the newest asking', () => {
    const { engines, control } = resolveExtensionSearch([
      installed('b'.repeat(32), 200, true),
      installed('a'.repeat(32), 100, true),
      installed('c'.repeat(32), 300, false)
    ])
    expect(engines.map((e) => e.id)).toEqual([
      extensionEngineId('a'.repeat(32)),
      extensionEngineId('b'.repeat(32)),
      extensionEngineId('c'.repeat(32))
    ])
    expect(control).toEqual({
      engineId: extensionEngineId('b'.repeat(32)),
      extensionId: 'b'.repeat(32),
      extensionName: `Extension ${'b'.repeat(32)}`
    })
  })

  it('leaves the default alone when no installed provider asks for it', () => {
    const { engines, control } = resolveExtensionSearch([installed('a'.repeat(32), 1, false)])
    expect(engines).toHaveLength(1)
    expect(control).toBeNull()
    expect(resolveExtensionSearch([])).toEqual({ engines: [], control: null })
  })
})

describe('the search model with extension engines', () => {
  const provider = searchProviderOf(
    { chrome_settings_overrides: nortonOverrides },
    NORTON,
    'Norton Safe Search'
  )!
  const { engines: extension, control } = resolveExtensionSearch([{ provider, installedAt: 1 }])
  const custom = {
    id: 'custom-1',
    name: 'Mine',
    searchUrl: 'https://mine.example/?q=%s',
    suggestUrl: null,
    keyword: 'mine',
    glyph: 'M',
    source: 'custom' as const
  }

  it('lists them after the shipped engines and before the user’s', () => {
    const all = allSearchEngines([custom], extension)
    const ids = all.map((e) => e.id)
    expect(ids.slice(0, DEFAULT_SEARCH_ENGINES.length)).toEqual(
      DEFAULT_SEARCH_ENGINES.map((e) => e.id)
    )
    expect(ids.slice(DEFAULT_SEARCH_ENGINES.length)).toEqual([provider.engine.id, 'custom-1'])
  })

  it('resolves the default to the controlling engine while it is listed, else the pick', () => {
    const all = allSearchEngines([custom], extension)
    expect(defaultSearchEngineOf(all, 'custom-1', control).id).toBe(provider.engine.id)
    expect(defaultSearchEngineOf(all, 'custom-1', null).id).toBe('custom-1')
    // The extension gone: its engine is not listed any more, the user's pick returns.
    expect(defaultSearchEngineOf(allSearchEngines([custom]), 'custom-1', control).id).toBe(
      'custom-1'
    )
    expect(defaultSearchEngineOf(all, 'nowhere', null).id).toBe(DEFAULT_SEARCH_ENGINES[0]!.id)
  })

  it('never lets the user pick an extension engine as their own default', () => {
    const all = allSearchEngines([custom], extension)
    expect(isPickableSearchEngine(all, 'custom-1')).toBe(true)
    expect(isPickableSearchEngine(all, DEFAULT_SEARCH_ENGINES[0]!.id)).toBe(true)
    expect(isPickableSearchEngine(all, provider.engine.id)).toBe(false)
    expect(isPickableSearchEngine(all, 'nowhere')).toBe(false)
  })
})

describe('validateManifest: chrome_settings_overrides', () => {
  const paths = (issues: Array<{ path: string }>): string[] => issues.map((i) => i.path).sort()

  it('accepts the two store manifests as they are', () => {
    for (const overrides of [nortonOverrides, bingOverrides]) {
      const result = validateManifest(manifest(overrides))
      expect(result.errors).toEqual([])
      expect(result.warnings).toEqual([])
      expect(result.manifest?.chrome_settings_overrides).toEqual(overrides)
    }
  })

  it('reports the shapes Chrome requires as errors', () => {
    expect(
      paths(validateManifest(manifest({ search_provider: { is_default: true } })).errors)
    ).toEqual(['chrome_settings_overrides.search_provider.search_url'])
    expect(
      paths(
        validateManifest(manifest({ search_provider: { search_url: 'https://x.example/?q=%s' } }))
          .errors
      )
    ).toEqual(['chrome_settings_overrides.search_provider.is_default'])
    expect(
      paths(
        validateManifest(
          manifest({
            search_provider: { ...nortonOverrides.search_provider, prepopulated_id: '3' },
            homepage: 7
          })
        ).errors
      )
    ).toEqual([
      'chrome_settings_overrides.homepage',
      'chrome_settings_overrides.search_provider.prepopulated_id'
    ])
    expect(paths(validateManifest(manifest({})).errors)).toEqual(['chrome_settings_overrides'])
    expect(paths(validateManifest(manifest('x')).errors)).toEqual(['chrome_settings_overrides'])
  })

  it('fails the install only when every declared part is dropped, warns otherwise', () => {
    const noKeyword: Record<string, unknown> = { ...nortonOverrides.search_provider }
    delete noKeyword.keyword
    const alone = validateManifest(manifest({ search_provider: noKeyword }))
    expect(paths(alone.errors)).toEqual(['chrome_settings_overrides.search_provider.keyword'])
    expect(alone.warnings).toEqual([])

    const beside = validateManifest(
      manifest({ search_provider: noKeyword, homepage: 'https://www.example.org/' })
    )
    expect(beside.errors).toEqual([])
    expect(paths(beside.warnings)).toEqual(['chrome_settings_overrides.search_provider.keyword'])
    expect(beside.warnings[0]!.message).toMatch(/ignored/)

    const badUrls = validateManifest(
      manifest({ homepage: 'ftp://x/', startup_pages: ['https://ok.example/', 'javascript:1'] })
    )
    expect(paths(badUrls.errors)).toEqual([
      'chrome_settings_overrides.homepage',
      'chrome_settings_overrides.startup_pages[1]'
    ])

    const providerBadUrl = validateManifest(
      manifest({
        search_provider: { ...nortonOverrides.search_provider, search_url: 'file:///x' },
        startup_pages: ['https://ok.example/']
      })
    )
    expect(providerBadUrl.errors).toEqual([])
    expect(paths(providerBadUrl.warnings)).toEqual([
      'chrome_settings_overrides.search_provider.search_url'
    ])
  })
})
