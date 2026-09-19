import { describe, expect, it } from 'vitest'
import type { NewTabDeviceState, NewTabSettings } from '../types'
import { DEFAULT_SETTINGS } from '../defaults'
import {
  DEFAULT_NEW_TAB_MODULES,
  DEFAULT_NEW_TAB_SETTINGS,
  MAX_NEW_TAB_HIDDEN_HOSTS,
  MAX_NEW_TAB_SHORTCUTS,
  emptyNewTabDevice,
  hideSite,
  migrateNewTabDevice,
  migrateNewTabSettings,
  newTabBackground,
  newTabSections,
  pickNewTabPreset,
  pinShortcut,
  presetAvailable,
  removeSite,
  sanitizeHiddenHosts,
  sanitizeNewTabDevice,
  sanitizeNewTabSettings,
  sanitizeNewTabShortcuts,
  siteHost,
  toggleNewTabModule,
  unhideSite,
  unpinShortcut
} from '../newTab'

const settings = (patch: Partial<NewTabSettings> = {}): NewTabSettings => ({
  ...structuredClone(DEFAULT_NEW_TAB_SETTINGS),
  ...patch
})

const device = (patch: Partial<NewTabDeviceState> = {}): NewTabDeviceState => ({
  ...emptyNewTabDevice(),
  ...patch
})

/** Ids the migration mints, predictable for the fixtures. */
const ids = (): (() => string) => {
  let n = 0
  return () => `sc_${++n}`
}

// ---------------------------------------------------------------------------
// The two frozen models exactly as their sanitisers wrote them (0.3.x)
// ---------------------------------------------------------------------------

/** `DEFAULT_NEW_TAB_PHONE_SETTINGS` of `shared/newTabPhone.ts`. */
const PHONE_DEFAULTS = {
  preset: 'focused',
  modules: { searchBox: true, shortcuts: true, wallpaper: false, feed: false },
  shortcutStyle: 'most-visited',
  wallpaper: 'space',
  pinned: [],
  hiddenHosts: []
}

/** `DEFAULT_NEW_TAB_SETTINGS` of `shared/defaults.ts` before the one model. */
const DESKTOP_DEFAULTS = {
  enabled: true,
  shortcuts: 'most-visited',
  background: 'space',
  greeting: false
}

describe('new tab settings', () => {
  it('ship enabled, focused, most visited over the space gradient', () => {
    expect(DEFAULT_SETTINGS.newTab).toEqual(DEFAULT_NEW_TAB_SETTINGS)
    expect(DEFAULT_NEW_TAB_SETTINGS).toEqual({
      enabled: true,
      mode: 'most-visited',
      preset: 'focused',
      modules: { searchBox: true, shortcuts: true, wallpaper: false, feed: false, greeting: false },
      background: 'space'
    })
    expect('newTabPhone' in DEFAULT_SETTINGS).toBe(false)
  })

  it('fills missing keys from the defaults', () => {
    expect(sanitizeNewTabSettings(undefined)).toEqual(DEFAULT_NEW_TAB_SETTINGS)
    expect(sanitizeNewTabSettings(null)).toEqual(DEFAULT_NEW_TAB_SETTINGS)
    expect(sanitizeNewTabSettings({})).toEqual(DEFAULT_NEW_TAB_SETTINGS)
    expect(sanitizeNewTabSettings({ enabled: false })).toEqual(settings({ enabled: false }))
    expect(sanitizeNewTabSettings({ modules: { greeting: true } }).modules).toEqual({
      ...DEFAULT_NEW_TAB_MODULES,
      greeting: true
    })
  })

  it('keeps known values and drops unknown ones', () => {
    expect(
      sanitizeNewTabSettings({
        mode: 'my-shortcuts',
        preset: 'inspirational',
        background: 'image',
        modules: { searchBox: false, feed: 'yes' }
      })
    ).toEqual({
      enabled: true,
      mode: 'my-shortcuts',
      preset: 'inspirational',
      modules: { ...DEFAULT_NEW_TAB_MODULES, searchBox: false },
      background: 'image'
    })
    expect(
      sanitizeNewTabSettings({ mode: 'tiles', preset: 'sparkly', background: 3, modules: 'all' })
    ).toEqual(DEFAULT_NEW_TAB_SETTINGS)
  })

  it("reads the desktop's first spelling of the user's own grid for one release", () => {
    expect(sanitizeNewTabSettings({ mode: 'custom' }).mode).toBe('my-shortcuts')
    // `hidden` was a mode, not a spelling: the shortcuts section owns visibility now.
    expect(sanitizeNewTabSettings({ mode: 'hidden' }).mode).toBe('most-visited')
  })
})

describe('presets', () => {
  it('the named presets are fixed sets of sections, with a greeting on the wallpaper ones', () => {
    expect(newTabSections(settings({ preset: 'focused' }))).toEqual({
      searchBox: true,
      shortcuts: true,
      wallpaper: false,
      feed: false,
      greeting: false
    })
    expect(newTabSections(settings({ preset: 'inspirational' }))).toEqual({
      searchBox: true,
      shortcuts: true,
      wallpaper: true,
      feed: false,
      greeting: true
    })
    expect(newTabSections(settings({ preset: 'informational' }))).toMatchObject({
      wallpaper: true,
      greeting: true
    })
  })

  it('never draws a feed while no feed core exists, whatever the preset says', () => {
    expect(newTabSections(settings({ preset: 'informational' })).feed).toBe(false)
    const custom = settings({
      preset: 'custom',
      modules: { searchBox: true, shortcuts: false, wallpaper: true, feed: true, greeting: false }
    })
    expect(newTabSections(custom)).toEqual({ ...custom.modules, feed: false })
    expect(presetAvailable('informational')).toBe(false)
    expect(presetAvailable('focused')).toBe(true)
    expect(presetAvailable('custom')).toBe(true)
  })

  it('a named preset ignores the toggles; only custom reads them', () => {
    const s = settings({
      preset: 'inspirational',
      modules: { ...DEFAULT_NEW_TAB_MODULES, shortcuts: false, greeting: false }
    })
    expect(newTabSections(s).shortcuts).toBe(true)
    expect(newTabSections(s).greeting).toBe(true)
    expect(newTabSections({ ...s, preset: 'custom' }).shortcuts).toBe(false)
  })

  it('toggling a section of a named preset moves to custom, changing only that section', () => {
    const out = toggleNewTabModule(settings({ preset: 'inspirational' }), 'shortcuts', false)
    expect(out.preset).toBe('custom')
    expect(out.modules).toEqual({
      searchBox: true,
      shortcuts: false,
      wallpaper: true,
      feed: false,
      greeting: true
    })
    expect(newTabSections(out)).toEqual(out.modules)
    // The desktop's "Show a greeting" switch is this toggle on the greeting section.
    expect(newTabSections(toggleNewTabModule(settings(), 'greeting', true)).greeting).toBe(true)
  })

  it('picking custom starts from the sections of the preset being left', () => {
    const out = pickNewTabPreset(settings({ preset: 'inspirational' }), 'custom')
    expect(out.preset).toBe('custom')
    expect(out.modules.wallpaper).toBe(true)
    expect(out.modules.greeting).toBe(true)
    // Already custom: the toggles stay as they were.
    const tweaked = { ...out, modules: { ...out.modules, searchBox: false } }
    expect(pickNewTabPreset(tweaked, 'custom').modules.searchBox).toBe(false)
    // A named preset simply applies and leaves the toggles for the next time custom is picked.
    const back = pickNewTabPreset(tweaked, 'focused')
    expect(back.preset).toBe('focused')
    expect(back.modules.searchBox).toBe(false)
    expect(newTabSections(back).searchBox).toBe(true)
  })

  it('paints the chosen background only while the wallpaper section is on', () => {
    expect(newTabBackground(settings({ background: 'image' }))).toBe('space')
    expect(newTabBackground(settings({ preset: 'inspirational', background: 'image' }))).toBe(
      'image'
    )
    expect(newTabBackground(settings({ preset: 'inspirational' }))).toBe('space')
    expect(
      newTabBackground(
        settings({
          preset: 'custom',
          modules: { ...DEFAULT_NEW_TAB_MODULES, wallpaper: true },
          background: 'solid'
        })
      )
    ).toBe('solid')
  })
})

describe('device-local sets', () => {
  it('keeps web shortcuts only, once per id and address, a grid of them at most', () => {
    const raw = [
      { id: 'a', url: 'https://a.example/', title: 'A' },
      { id: 'a', url: 'https://a2.example/', title: 'Same id' },
      { id: 'b', url: 'https://a.example/', title: 'Same address' },
      { id: 'c', url: 'zen://settings', title: 'Nope' },
      { id: 'd', url: 'javascript:alert(1)', title: 'Nope' },
      { id: 'e', url: 'https://e.example/', title: '  ' },
      { url: 'https://noid.example/', title: 'No id' },
      'garbage',
      ...Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, url: `https://s${i}.example/` }))
    ]
    const out = sanitizeNewTabShortcuts(raw)
    expect(out).toHaveLength(MAX_NEW_TAB_SHORTCUTS)
    expect(out[0]).toEqual({ id: 'a', url: 'https://a.example/', title: 'A' })
    expect(out[1]).toEqual({ id: 'e', url: 'https://e.example/', title: 'https://e.example/' })
    expect(out.some((s) => s.url.startsWith('zen://') || s.id === 'b')).toBe(false)
    expect(sanitizeNewTabShortcuts('nope')).toEqual([])
  })

  it('normalises the removed hosts: lower-case, no www., unique, capped', () => {
    expect(
      sanitizeHiddenHosts(['WWW.News.Example', 'news.example', ' Other.org ', '', 7, 'www.'])
    ).toEqual(['news.example', 'other.org'])
    const many = Array.from({ length: MAX_NEW_TAB_HIDDEN_HOSTS + 20 }, (_, i) => `h${i}.example`)
    expect(sanitizeHiddenHosts(many)).toHaveLength(MAX_NEW_TAB_HIDDEN_HOSTS)
    expect(sanitizeHiddenHosts(undefined)).toEqual([])
  })

  it('sanitises the document as a whole', () => {
    expect(sanitizeNewTabDevice(undefined)).toEqual(emptyNewTabDevice())
    expect(
      sanitizeNewTabDevice({
        shortcuts: [{ id: 'a', url: 'https://a.example/', title: 'A' }],
        hiddenHosts: ['www.b.example']
      })
    ).toEqual({
      shortcuts: [{ id: 'a', url: 'https://a.example/', title: 'A' }],
      hiddenHosts: ['b.example']
    })
  })

  it('siteHost lower-cases and drops www.', () => {
    expect(siteHost('https://WWW.Example.com/a?b')).toBe('example.com')
    expect(siteHost('not a url')).toBe('')
  })

  it('pinning adds once, brings a removed host back, and stops at a grid of shortcuts', () => {
    let d = device({ hiddenHosts: ['example.com'] })
    d = pinShortcut(d, { id: 'p1', url: 'https://www.example.com/', title: 'Example' })
    expect(d.shortcuts).toEqual([{ id: 'p1', url: 'https://www.example.com/', title: 'Example' }])
    expect(d.hiddenHosts).toEqual([])
    expect(pinShortcut(d, { id: 'p2', url: 'https://www.example.com/', title: 'Again' })).toBe(d)
    for (let i = 0; i < 12; i++)
      d = pinShortcut(d, { id: `s${i}`, url: `https://s${i}.example/`, title: `${i}` })
    expect(d.shortcuts).toHaveLength(MAX_NEW_TAB_SHORTCUTS)
  })

  it('unpinning leaves the host visible; removing hides it and drops its shortcut', () => {
    let d = device()
    d = pinShortcut(d, { id: 'a', url: 'https://a.example/', title: 'A' })
    d = pinShortcut(d, { id: 'b', url: 'https://b.example/', title: 'B' })
    d = unpinShortcut(d, 'https://a.example/')
    expect(d.shortcuts.map((s) => s.url)).toEqual(['https://b.example/'])
    expect(d.hiddenHosts).toEqual([])
    d = removeSite(d, 'https://b.example/')
    expect(d.shortcuts).toEqual([])
    expect(d.hiddenHosts).toEqual(['b.example'])
    // Removing it again changes nothing.
    expect(removeSite(d, 'https://b.example/')).toBe(d)
  })

  it('hides and unhides a host by any of its addresses; the newest removal survives a full list', () => {
    let d = hideSite(device(), 'https://www.News.example/story')
    expect(d.hiddenHosts).toEqual(['news.example'])
    expect(hideSite(d, 'https://news.example/other')).toBe(d)
    expect(unhideSite(d, 'https://news.example/')).toEqual(device())
    expect(unhideSite(d, 'https://other.example/')).toBe(d)
    const full = device({
      hiddenHosts: Array.from({ length: MAX_NEW_TAB_HIDDEN_HOSTS }, (_, i) => `h${i}.example`)
    })
    d = hideSite(full, 'https://newest.example/')
    expect(d.hiddenHosts).toHaveLength(MAX_NEW_TAB_HIDDEN_HOSTS)
    expect(d.hiddenHosts.at(-1)).toBe('newest.example')
    expect(d.hiddenHosts).not.toContain('h0.example')
  })
})

describe('migrateNewTabSettings', () => {
  it('reads the one model as it is, and nothing as the defaults', () => {
    const merged = settings({ preset: 'inspirational', mode: 'my-shortcuts' })
    expect(migrateNewTabSettings({ newTab: merged })).toEqual(merged)
    expect(migrateNewTabSettings({})).toEqual(DEFAULT_NEW_TAB_SETTINGS)
    expect(migrateNewTabSettings({ newTab: null, newTabPhone: null })).toEqual(
      DEFAULT_NEW_TAB_SETTINGS
    )
  })

  it("translates the desktop's first model: defaults stay defaults", () => {
    expect(migrateNewTabSettings({ newTab: DESKTOP_DEFAULTS })).toEqual(DEFAULT_NEW_TAB_SETTINGS)
  })

  it("translates the desktop's first model: custom → my-shortcuts, greeting and background into custom", () => {
    expect(
      migrateNewTabSettings({
        newTab: { enabled: false, shortcuts: 'custom', background: 'image', greeting: true }
      })
    ).toEqual({
      enabled: false,
      mode: 'my-shortcuts',
      preset: 'custom',
      modules: { searchBox: true, shortcuts: true, wallpaper: true, feed: false, greeting: true },
      background: 'image'
    })
    expect(migrateNewTabSettings({ newTab: { ...DESKTOP_DEFAULTS, background: 'solid' } })).toEqual(
      settings({
        preset: 'custom',
        modules: { ...DEFAULT_NEW_TAB_MODULES, wallpaper: true },
        background: 'solid'
      })
    )
  })

  it("translates the desktop's first model: hidden becomes the shortcuts section off", () => {
    expect(migrateNewTabSettings({ newTab: { ...DESKTOP_DEFAULTS, shortcuts: 'hidden' } })).toEqual(
      settings({
        preset: 'custom',
        modules: { ...DEFAULT_NEW_TAB_MODULES, shortcuts: false }
      })
    )
  })

  it('folds the phone defaults into the desktop defaults as the defaults', () => {
    expect(
      migrateNewTabSettings({ newTab: DESKTOP_DEFAULTS, newTabPhone: PHONE_DEFAULTS })
    ).toEqual(DEFAULT_NEW_TAB_SETTINGS)
  })

  it('folds a custom phone preset with the shortcuts off', () => {
    const out = migrateNewTabSettings({
      newTab: DESKTOP_DEFAULTS,
      newTabPhone: {
        ...PHONE_DEFAULTS,
        preset: 'custom',
        modules: { searchBox: true, shortcuts: false, wallpaper: false, feed: false }
      }
    })
    expect(out).toEqual(
      settings({ preset: 'custom', modules: { ...DEFAULT_NEW_TAB_MODULES, shortcuts: false } })
    )
    expect(newTabSections(out).shortcuts).toBe(false)
  })

  it('folds the phone wallpaper source into the background, with and without a picture stored', () => {
    // The picked picture is the host's file, never part of the settings: the source says image
    // either way, and a page with no file paints the space colours (`NewTabService`).
    for (const preset of ['inspirational', 'focused'] as const) {
      const out = migrateNewTabSettings({
        newTab: DESKTOP_DEFAULTS,
        newTabPhone: { ...PHONE_DEFAULTS, preset, wallpaper: 'image' }
      })
      expect(out.background).toBe('image')
      expect(out.preset).toBe(preset)
      expect(newTabBackground(out)).toBe(preset === 'inspirational' ? 'image' : 'space')
    }
  })

  it('folds the phone shortcut style into the mode', () => {
    expect(
      migrateNewTabSettings({
        newTab: DESKTOP_DEFAULTS,
        newTabPhone: { ...PHONE_DEFAULTS, shortcutStyle: 'my-shortcuts' }
      }).mode
    ).toBe('my-shortcuts')
  })

  it('the non-default value wins, whichever side set it', () => {
    // The phone user picked Inspirational; the desktop key holds the defaults it is always written with.
    expect(
      migrateNewTabSettings({
        newTab: DESKTOP_DEFAULTS,
        newTabPhone: { ...PHONE_DEFAULTS, preset: 'inspirational' }
      }).preset
    ).toBe('inspirational')
    // The desktop user turned the greeting on; the phone key is untouched.
    const greeting = migrateNewTabSettings({
      newTab: { ...DESKTOP_DEFAULTS, greeting: true },
      newTabPhone: PHONE_DEFAULTS
    })
    expect(greeting.preset).toBe('custom')
    expect(newTabSections(greeting).greeting).toBe(true)
    // The desktop user chose their own grid; the phone key is untouched.
    expect(
      migrateNewTabSettings({
        newTab: { ...DESKTOP_DEFAULTS, shortcuts: 'custom' },
        newTabPhone: PHONE_DEFAULTS
      }).mode
    ).toBe('my-shortcuts')
    // Off stays off: the phone has no say over a desktop-only field.
    expect(
      migrateNewTabSettings({
        newTab: { ...DESKTOP_DEFAULTS, enabled: false },
        newTabPhone: { ...PHONE_DEFAULTS, preset: 'inspirational' }
      }).enabled
    ).toBe(false)
  })

  it("where both sides are set, the phone's choice wins", () => {
    const out = migrateNewTabSettings({
      newTab: { enabled: true, shortcuts: 'custom', background: 'solid', greeting: true },
      newTabPhone: {
        ...PHONE_DEFAULTS,
        preset: 'inspirational',
        shortcutStyle: 'most-visited',
        wallpaper: 'image'
      }
    })
    expect(out.preset).toBe('inspirational')
    expect(out.background).toBe('image')
    // The phone's default style is no choice: the desktop's own grid stands.
    expect(out.mode).toBe('my-shortcuts')
    // The desktop's greeting rides along in the toggles, ready for the next custom pick.
    expect(out.modules.greeting).toBe(true)
  })

  it('is idempotent', () => {
    const sources = [
      { newTab: DESKTOP_DEFAULTS, newTabPhone: PHONE_DEFAULTS },
      { newTab: { ...DESKTOP_DEFAULTS, shortcuts: 'hidden', greeting: true } },
      {
        newTab: { ...DESKTOP_DEFAULTS, background: 'solid' },
        newTabPhone: { ...PHONE_DEFAULTS, preset: 'custom', shortcutStyle: 'my-shortcuts' }
      }
    ]
    for (const s of sources) {
      const once = migrateNewTabSettings(s)
      expect(migrateNewTabSettings({ newTab: once })).toEqual(once)
      expect(sanitizeNewTabSettings(once)).toEqual(once)
    }
  })
})

describe('migrateNewTabDevice', () => {
  it('reads a v5 document as it is, a v4 profile from its two lists, and nothing as empty', () => {
    const v5 = {
      shortcuts: [{ id: 'a', url: 'https://a.example/', title: 'A' }],
      hiddenHosts: ['a.example']
    }
    expect(migrateNewTabDevice({ newTabDevice: v5 })).toEqual(v5)
    expect(
      migrateNewTabDevice({
        newTabShortcuts: v5.shortcuts,
        newTabHiddenHosts: ['WWW.A.example', 'a.example']
      })
    ).toEqual(v5)
    expect(migrateNewTabDevice({})).toEqual(emptyNewTabDevice())
  })

  it('moves eight pins into the shortcuts and dedupes a www. copy of a hidden host', () => {
    const pinned = Array.from({ length: 8 }, (_, i) => ({
      url: `https://p${i}.example/`,
      title: i === 3 ? '' : `P${i}`
    }))
    const out = migrateNewTabDevice(
      {
        newTabPhone: {
          ...PHONE_DEFAULTS,
          pinned,
          // As the phone's sanitiser kept them: `www.` not stripped, so one host twice.
          hiddenHosts: ['www.news.example', 'news.example', 'other.example']
        }
      },
      ids()
    )
    expect(out.shortcuts).toHaveLength(MAX_NEW_TAB_SHORTCUTS)
    expect(out.shortcuts.map((s) => s.url)).toEqual(pinned.map((p) => p.url))
    expect(out.shortcuts[0]).toEqual({ id: 'sc_1', url: 'https://p0.example/', title: 'P0' })
    // A blank title stands in as the address, as the desktop's sanitiser has it.
    expect(out.shortcuts[3].title).toBe('https://p3.example/')
    expect(out.hiddenHosts).toEqual(['news.example', 'other.example'])
  })

  it('pinning a host the phone had removed brings it back, as the phone did', () => {
    const out = migrateNewTabDevice(
      {
        newTabPhone: {
          ...PHONE_DEFAULTS,
          pinned: [{ url: 'https://www.news.example/', title: 'News' }],
          hiddenHosts: ['news.example', 'www.other.example']
        }
      },
      ids()
    )
    expect(out.shortcuts.map((s) => s.url)).toEqual(['https://www.news.example/'])
    expect(out.hiddenHosts).toEqual(['other.example'])
  })

  it("appends the pins after the device's shortcuts, once per address, within the grid", () => {
    const own = Array.from({ length: 6 }, (_, i) => ({
      id: `own${i}`,
      url: `https://own${i}.example/`,
      title: `Own ${i}`
    }))
    const out = migrateNewTabDevice(
      {
        newTabShortcuts: own,
        newTabHiddenHosts: ['gone.example'],
        newTabPhone: {
          ...PHONE_DEFAULTS,
          pinned: [
            { url: 'https://own1.example/', title: 'Already there' },
            { url: 'https://p1.example/', title: 'P1' },
            { url: 'https://p2.example/', title: 'P2' },
            { url: 'https://p3.example/', title: 'Cut' }
          ],
          hiddenHosts: ['phone.example']
        }
      },
      ids()
    )
    expect(out.shortcuts.map((s) => s.id)).toEqual([...own.map((s) => s.id), 'sc_2', 'sc_3'])
    expect(out.shortcuts).toHaveLength(MAX_NEW_TAB_SHORTCUTS)
    expect(out.hiddenHosts).toEqual(['gone.example', 'phone.example'])
  })

  it('is idempotent once the phone key is gone', () => {
    const once = migrateNewTabDevice(
      {
        newTabPhone: {
          ...PHONE_DEFAULTS,
          pinned: [{ url: 'https://a.example/', title: 'A' }],
          hiddenHosts: ['b.example']
        }
      },
      ids()
    )
    expect(migrateNewTabDevice({ newTabDevice: once })).toEqual(once)
    expect(sanitizeNewTabDevice(once)).toEqual(once)
  })
})
