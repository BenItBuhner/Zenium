import { describe, expect, it } from 'vitest'
import type { NewTabPhoneSettings } from '../types'
import {
  DEFAULT_NEW_TAB_PHONE_SETTINGS,
  MAX_TOP_SITES,
  newTabSections,
  pickNewTabPreset,
  pinSite,
  presetAvailable,
  removeSite,
  sanitizeNewTabPhoneSettings,
  siteHost,
  toggleNewTabModule,
  unpinSite
} from '../newTabPhone'

const settings = (patch: Partial<NewTabPhoneSettings> = {}): NewTabPhoneSettings => ({
  ...structuredClone(DEFAULT_NEW_TAB_PHONE_SETTINGS),
  ...patch
})

describe('sanitizeNewTabPhoneSettings', () => {
  it('fills in the defaults for nothing at all', () => {
    expect(sanitizeNewTabPhoneSettings(undefined)).toEqual(DEFAULT_NEW_TAB_PHONE_SETTINGS)
    expect(sanitizeNewTabPhoneSettings(null)).toEqual(DEFAULT_NEW_TAB_PHONE_SETTINGS)
    expect(sanitizeNewTabPhoneSettings({})).toEqual(DEFAULT_NEW_TAB_PHONE_SETTINGS)
  })

  it('drops values that are not ours and keeps the ones that are', () => {
    const out = sanitizeNewTabPhoneSettings({
      preset: 'sparkly' as never,
      shortcutStyle: 'my-shortcuts',
      wallpaper: 'video' as never,
      modules: { searchBox: false, feed: 'yes' as never } as never
    })
    expect(out.preset).toBe('focused')
    expect(out.shortcutStyle).toBe('my-shortcuts')
    expect(out.wallpaper).toBe('space')
    expect(out.modules).toEqual({
      searchBox: false,
      shortcuts: true,
      wallpaper: false,
      feed: false
    })
  })

  it('keeps only web pins, once each, at most a page of them', () => {
    const pinned = [
      { url: 'https://a.example', title: 'A' },
      { url: 'https://a.example', title: 'A again' },
      { url: 'zen://settings', title: 'Nope' },
      { url: 'javascript:alert(1)', title: 'Nope' },
      { url: 'https://b.example' },
      ...Array.from({ length: 12 }, (_, i) => ({ url: `https://s${i}.example`, title: `${i}` }))
    ]
    const out = sanitizeNewTabPhoneSettings({ pinned: pinned as never })
    expect(out.pinned).toHaveLength(MAX_TOP_SITES)
    expect(out.pinned[0]).toEqual({ url: 'https://a.example', title: 'A' })
    expect(out.pinned[1]).toEqual({ url: 'https://b.example', title: '' })
    expect(out.pinned.some((p) => p.url.startsWith('zen://'))).toBe(false)
  })

  it('normalises the removed hosts', () => {
    const out = sanitizeNewTabPhoneSettings({
      hiddenHosts: ['Example.COM', ' example.com', '', 42 as never, 'other.org']
    })
    expect(out.hiddenHosts).toEqual(['example.com', 'other.org'])
  })
})

describe('presets', () => {
  it('the named presets are fixed sets of sections', () => {
    expect(newTabSections(settings({ preset: 'focused' }))).toEqual({
      searchBox: true,
      shortcuts: true,
      wallpaper: false,
      feed: false
    })
    expect(newTabSections(settings({ preset: 'inspirational' }))).toMatchObject({
      wallpaper: true,
      feed: false
    })
  })

  it('never draws a feed while no feed core exists, whatever the preset says', () => {
    expect(newTabSections(settings({ preset: 'informational' })).feed).toBe(false)
    const custom = settings({
      preset: 'custom',
      modules: { searchBox: true, shortcuts: false, wallpaper: true, feed: true }
    })
    expect(newTabSections(custom)).toEqual({
      searchBox: true,
      shortcuts: false,
      wallpaper: true,
      feed: false
    })
    expect(presetAvailable('informational')).toBe(false)
    expect(presetAvailable('focused')).toBe(true)
    expect(presetAvailable('custom')).toBe(true)
  })

  it('toggling a section of a named preset moves to custom, changing only that section', () => {
    const out = toggleNewTabModule(settings({ preset: 'inspirational' }), 'shortcuts', false)
    expect(out.preset).toBe('custom')
    expect(out.modules).toEqual({ searchBox: true, shortcuts: false, wallpaper: true, feed: false })
    expect(newTabSections(out)).toEqual(out.modules)
  })

  it('picking custom starts from the sections of the preset being left', () => {
    const out = pickNewTabPreset(settings({ preset: 'inspirational' }), 'custom')
    expect(out.preset).toBe('custom')
    expect(out.modules.wallpaper).toBe(true)
    // Already custom: the toggles stay as they were.
    const tweaked = { ...out, modules: { ...out.modules, searchBox: false } }
    expect(pickNewTabPreset(tweaked, 'custom').modules.searchBox).toBe(false)
    // A named preset simply applies and leaves the toggles for the next time custom is picked.
    const back = pickNewTabPreset(tweaked, 'focused')
    expect(back.preset).toBe('focused')
    expect(back.modules.searchBox).toBe(false)
    expect(newTabSections(back).searchBox).toBe(true)
  })
})

describe('pins and removals', () => {
  it('siteHost lower-cases and drops www.', () => {
    expect(siteHost('https://WWW.Example.com/a?b')).toBe('example.com')
    expect(siteHost('not a url')).toBe('')
  })

  it('pinning adds once, brings a removed host back, and stops at a page of pins', () => {
    let s = settings({ hiddenHosts: ['example.com'] })
    s = pinSite(s, { url: 'https://www.example.com/', title: 'Example' })
    expect(s.pinned).toEqual([{ url: 'https://www.example.com/', title: 'Example' }])
    expect(s.hiddenHosts).toEqual([])
    expect(pinSite(s, { url: 'https://www.example.com/', title: 'Again' })).toBe(s)
    for (let i = 0; i < 12; i++) s = pinSite(s, { url: `https://s${i}.example/`, title: `${i}` })
    expect(s.pinned).toHaveLength(MAX_TOP_SITES)
  })

  it('unpinning leaves the host visible; removing hides it and drops its pin', () => {
    let s = settings()
    s = pinSite(s, { url: 'https://a.example/', title: 'A' })
    s = pinSite(s, { url: 'https://b.example/', title: 'B' })
    s = unpinSite(s, 'https://a.example/')
    expect(s.pinned.map((p) => p.url)).toEqual(['https://b.example/'])
    expect(s.hiddenHosts).toEqual([])
    s = removeSite(s, 'https://b.example/')
    expect(s.pinned).toEqual([])
    expect(s.hiddenHosts).toEqual(['b.example'])
    // Removing it again changes nothing.
    expect(removeSite(s, 'https://b.example/').hiddenHosts).toEqual(['b.example'])
  })
})
