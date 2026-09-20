import { describe, expect, it } from 'vitest'
import { ID, ID2, PATH, harness, manifest, record } from './runtimeHarness'

/**
 * `chrome_settings_overrides.search_provider` on the phone: the engine an attached extension
 * declares joins the browser's search model while the extension is attached, and the most
 * recently installed one asking for `is_default` holds the default (Chrome's
 * `SettingsOverridesAPI`; the desktop's `SearchProviderApi`).
 */

/** Norton Safe Search's override, spelled out (its store manifest). */
const NORTON = {
  search_provider: {
    encoding: 'UTF-8',
    favicon_url: 'https://searchsafe.norton.com/img/logoicon.ico',
    is_default: true,
    keyword: 'nortonsafe',
    name: 'Norton Safe',
    search_url: 'https://searchsafe.norton.com/search?omnisearch=yes&q={searchTerms}'
  }
}

/** Bing Homepage & Search's: a prepopulated engine with the install parameter in its URLs. */
const BING = {
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

const PATH2 = `/data/user/0/app.zen.chromium/files/zen/extensions/${ID2}/1.0.0`

describe('chrome_settings_overrides.search_provider on the phone', () => {
  it('an attached extension declaring an engine with is_default puts it in the model and holds the default', async () => {
    const h = harness()
    await h.runtime.attach(
      record(h, { name: 'Norton Safe Search' }, manifest({ chrome_settings_overrides: NORTON }))
    )
    expect(h.search).toHaveLength(1)
    const { engines, control } = h.search[0]!
    expect(engines).toHaveLength(1)
    expect(engines[0]).toMatchObject({
      id: `extension:${ID}`,
      name: 'Norton Safe',
      keyword: 'nortonsafe',
      searchUrl: 'https://searchsafe.norton.com/search?omnisearch=yes&q=%s',
      source: 'extension',
      favicon: 'https://searchsafe.norton.com/img/logoicon.ico'
    })
    expect(control).toEqual({
      engineId: `extension:${ID}`,
      extensionId: ID,
      extensionName: 'Norton Safe Search'
    })
  })

  it('a prepopulated engine takes its name and keyword from the table, with the install parameter dropped', async () => {
    const h = harness()
    await h.runtime.attach(
      record(
        h,
        { name: 'Microsoft Bing Homepage & Search' },
        manifest({ chrome_settings_overrides: BING })
      )
    )
    const { engines, control } = h.search.at(-1)!
    expect(engines[0]).toMatchObject({
      id: `extension:${ID}`,
      name: 'Bing',
      keyword: 'bing.com',
      searchUrl: 'https://www.bing.com/search?EID=MBHSC&form=BGGCMF&pc=BG00&q=%s',
      suggestUrl: 'https://www.bing.com/osjson.aspx?form=BGGCSS&pc=BG00&query=%s',
      source: 'extension'
    })
    expect(control?.extensionId).toBe(ID)
  })

  it('the most recently installed extension asking for the default holds it; detaching hands it back, then leaves nothing', async () => {
    const h = harness()
    const norton = record(
      h,
      { name: 'Norton Safe Search', installedAt: h.clock.now - 60_000 },
      manifest({ chrome_settings_overrides: NORTON })
    )
    const bing = record(
      h,
      { id: ID2, path: PATH2, name: 'Microsoft Bing Homepage & Search', installedAt: h.clock.now },
      manifest({ chrome_settings_overrides: BING })
    )
    await h.runtime.attach(norton)
    await h.runtime.attach(bing)
    let last = h.search.at(-1)!
    expect(last.engines.map((e) => e.id)).toEqual([`extension:${ID}`, `extension:${ID2}`])
    expect(last.control?.extensionId).toBe(ID2)

    await h.runtime.detach(ID2)
    last = h.search.at(-1)!
    expect(last.engines.map((e) => e.id)).toEqual([`extension:${ID}`])
    expect(last.control?.extensionId).toBe(ID)

    await h.runtime.detach(ID)
    last = h.search.at(-1)!
    expect(last.engines).toEqual([])
    expect(last.control).toBeNull()
  })

  it('a re-attach re-reads the manifest: an update that drops the key takes the engine out', async () => {
    const h = harness()
    await h.runtime.attach(record(h, {}, manifest({ chrome_settings_overrides: NORTON })))
    expect(h.search.at(-1)!.engines).toHaveLength(1)
    await h.runtime.attach(record(h, {}, manifest()))
    expect(h.search.at(-1)!.engines).toEqual([])
    expect(h.search.at(-1)!.control).toBeNull()
  })

  it('an extension without the key, or with a search URL Chrome would drop, touches the model only when it had an engine', async () => {
    const h = harness()
    await h.runtime.attach(record(h))
    await h.runtime.attach(
      record(
        h,
        { id: ID2, path: PATH2 },
        manifest({
          chrome_settings_overrides: {
            search_provider: { ...NORTON.search_provider, search_url: 'javascript:alert(1)' }
          }
        })
      )
    )
    expect(h.search).toEqual([])
    await h.runtime.detach(ID)
    await h.runtime.detach(ID2)
    expect(h.search).toEqual([])
    h.kt.manifests.set(PATH, manifest())
  })

  it('an engine whose URL cannot take the terms is listed but never holds the default', async () => {
    const h = harness()
    await h.runtime.attach(
      record(
        h,
        {},
        manifest({
          chrome_settings_overrides: {
            search_provider: {
              ...NORTON.search_provider,
              search_url: 'https://searchsafe.norton.com/'
            }
          }
        })
      )
    )
    const { engines, control } = h.search.at(-1)!
    expect(engines).toHaveLength(1)
    expect(control).toBeNull()
  })
})
