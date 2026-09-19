import { describe, expect, it } from 'vitest'
import { Clock, Globe, Settings } from 'lucide-react'
import { suggestionIcon } from '../suggestionIcon'

/*
 * The glyph in a suggestion row's favicon slot (v2 §10.1): a row that lands on an internal page
 * draws the page's registry glyph – the gear for Settings – whether the row is the typed
 * address, the page's open tab or a history entry, and whichever alias the row's URL carries;
 * every other row keeps its kind's glyph (Chrome's globe for a site with no favicon).
 */

describe('suggestionIcon', () => {
  it('draws the registry glyph for a row that lands on an internal page, by either alias', () => {
    expect(suggestionIcon({ kind: 'url', url: 'zenium://settings' })).toEqual({
      Icon: Settings,
      page: true
    })
    expect(suggestionIcon({ kind: 'tab', url: 'zen://settings/look' })).toEqual({
      Icon: Settings,
      page: true
    })
    expect(suggestionIcon({ kind: 'history', url: 'zenium://settings/privacy' })).toEqual({
      Icon: Settings,
      page: true
    })
  })

  it('keeps the kind glyph for every other row', () => {
    expect(suggestionIcon({ kind: 'url', url: 'https://example.com' })).toEqual({
      Icon: Globe,
      page: false
    })
    expect(suggestionIcon({ kind: 'history', url: 'https://example.com/a' })).toEqual({
      Icon: Clock,
      page: false
    })
    expect(suggestionIcon({ kind: 'url', url: null })).toEqual({ Icon: Globe, page: false })
    expect(suggestionIcon({ kind: 'url', url: 'zenium://nowhere' })).toEqual({
      Icon: Globe,
      page: false
    })
  })
})
