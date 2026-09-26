import { describe, expect, it } from 'vitest'
import type { SearchEngine } from '@shared/types'
import {
  DEFAULT_SEARCH_ENGINES,
  SEARCH_CHOICE_EXTRA_ENGINES,
  customSearchEngine
} from '@shared/search'
import { bundledSearchEngineIcon, searchEngineIconSrc } from '../searchEngineIcons'

/*
 * The choice screen's bundled icons (W6-2): every engine the screen offers has a picture in the
 * build – a file beside the bundle, never bytes in the script, never an address on the network –
 * and the chrome draws a stored non-shipped engine's mark from it, while the shipped engines and
 * the user's own keep their favicon address as they always had.
 */

const PNG = /search-engines\/[a-z]+\.png/

describe('the bundled icons', () => {
  it("has a picture for every engine on Chrome's table, Yahoo's editions sharing Yahoo's", () => {
    for (const engine of [...DEFAULT_SEARCH_ENGINES, ...SEARCH_CHOICE_EXTRA_ENGINES]) {
      if (engine.id === 'wikipedia') continue
      const icon = bundledSearchEngineIcon(engine.id)
      expect(icon, engine.id).toMatch(PNG)
      expect(icon, engine.id).not.toMatch(/^(https?:|data:)/)
    }
    expect(bundledSearchEngineIcon('yahoo_de')).toBe(bundledSearchEngineIcon('yahoo_fr'))
    expect(bundledSearchEngineIcon('yahoo_emea')).toMatch(/yahoo/)
    expect(bundledSearchEngineIcon('wikipedia')).toBeNull()
    expect(bundledSearchEngineIcon('custom:mine')).toBeNull()
    expect(bundledSearchEngineIcon('')).toBeNull()
  })

  it("draws a stored non-shipped engine's mark from the bundle, the shipped ones and the user's from their address", () => {
    const qwant = SEARCH_CHOICE_EXTRA_ENGINES.find((e) => e.id === 'qwant')!
    const stored: SearchEngine = { ...qwant, source: 'custom' }
    expect(searchEngineIconSrc(stored)).toMatch(/qwant.*\.png/)
    expect(
      searchEngineIconSrc(SEARCH_CHOICE_EXTRA_ENGINES.find((e) => e.id === 'yahoo_fr')!)
    ).toMatch(/yahoo.*\.png/)
    const google = DEFAULT_SEARCH_ENGINES.find((e) => e.id === 'google')!
    expect(searchEngineIconSrc(google)).toBe('https://www.google.com/favicon.ico')
    const own = customSearchEngine('Mine', 'https://example.com/?q=%s', DEFAULT_SEARCH_ENGINES)
    expect(searchEngineIconSrc(own)).toBeNull()
    expect(searchEngineIconSrc({ ...own, favicon: 'https://example.com/favicon.ico' })).toBe(
      'https://example.com/favicon.ico'
    )
  })
})
