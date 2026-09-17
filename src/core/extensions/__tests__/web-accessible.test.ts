import { describe, expect, it } from 'vitest'
import {
  normalizeResourcePath,
  resourcePatternMatches,
  webAccessibleEntryFor
} from '../webAccessible'

describe('web_accessible_resources', () => {
  it('normalises a package path: no leading slash, query or fragment, escapes decoded', () => {
    expect(normalizeResourcePath('/war/noop.js?x=1#f')).toBe('war/noop.js')
    expect(normalizeResourcePath('//img/a%20b.png')).toBe('img/a b.png')
    expect(normalizeResourcePath('img/%zz.png')).toBe('img/%zz.png')
  })

  it('matches resources literally or with * wildcards, leading slash optional', () => {
    expect(resourcePatternMatches('war/noop.js', 'war/noop.js')).toBe(true)
    expect(resourcePatternMatches('/war/noop.js', 'war/noop.js')).toBe(true)
    expect(resourcePatternMatches('war/*', 'war/deep/noop.js')).toBe(true)
    expect(resourcePatternMatches('img/*.png', 'img/a.png')).toBe(true)
    expect(resourcePatternMatches('img/*.png', 'img/a.pngx')).toBe(false)
    expect(resourcePatternMatches('img/a.png', 'img/aXpng')).toBe(false)
    expect(resourcePatternMatches('war/*', 'other/noop.js')).toBe(false)
  })

  it('reads MV3 entries with use_dynamic_url and MV2 path lists', () => {
    const mv3 = {
      web_accessible_resources: [
        { resources: ['/strictblock.html'], matches: ['<all_urls>'], use_dynamic_url: true },
        { resources: ['war/*'], matches: ['https://a.example/*'] },
        { resources: ['img/*.png'], matches: ['<all_urls>'], use_dynamic_url: true }
      ]
    }
    expect(webAccessibleEntryFor(mv3, '/strictblock.html?u=x')).toEqual({
      useDynamicUrl: true,
      matches: ['<all_urls>']
    })
    expect(webAccessibleEntryFor(mv3, 'war/noop.js')).toEqual({
      useDynamicUrl: false,
      matches: ['https://a.example/*']
    })
    expect(webAccessibleEntryFor(mv3, 'img/a.png')?.useDynamicUrl).toBe(true)
    expect(webAccessibleEntryFor(mv3, 'background.js')).toBeUndefined()
    expect(webAccessibleEntryFor({ web_accessible_resources: ['img/*.png'] }, 'img/a.png')).toEqual(
      { useDynamicUrl: false, matches: undefined }
    )
    expect(webAccessibleEntryFor({}, 'img/a.png')).toBeUndefined()
  })
})
