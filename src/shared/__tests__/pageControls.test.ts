import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PAGE_CONTROLS,
  ZOOM_LEVELS,
  clampZoom,
  desktopByDefault,
  formatZoom,
  needsViewportMeta,
  pageRulesFor,
  parseViewport,
  resolveDarkening,
  resolveDesktop,
  resolvePageControls,
  resolveZoom,
  rewriteViewport,
  sanitizePageControls,
  siteKey,
  siteValue,
  stepZoom,
  withSiteOverride,
  zoomLevelIndex
} from '../pageControls'
import type { PageControlsSettings, PageEnvironment } from '../types'

const phone: PageEnvironment = { largeScreen: false, pointerAndKeyboard: false, fontScale: 1 }
const tablet: PageEnvironment = { ...phone, largeScreen: true }
const docked: PageEnvironment = { ...phone, pointerAndKeyboard: true }

function settings(patch: Partial<PageControlsSettings> = {}): PageControlsSettings {
  return { ...structuredClone(DEFAULT_PAGE_CONTROLS), ...patch }
}

describe('page controls settings', () => {
  it('reads any stored shape back into a complete, well-typed value', () => {
    expect(sanitizePageControls(undefined)).toEqual(DEFAULT_PAGE_CONTROLS)
    expect(sanitizePageControls(null)).toEqual(DEFAULT_PAGE_CONTROLS)
    const raw = {
      desktopSite: 'always',
      desktopSites: { 'example.com': true, '': true, 'bad.com': 'yes' },
      darkenSites: 'true',
      darkenSiteExceptions: { 'github.com': false },
      zoom: 9,
      zoomIncludesOsFontSize: 0,
      siteZooms: { 'a.com': 1.5, 'b.com': 'x', 'c.com': Number.NaN, 'd.com': 0.1 },
      forceZoom: true
    } as unknown as Partial<PageControlsSettings>
    expect(sanitizePageControls(raw)).toEqual({
      desktopSite: 'auto',
      desktopSites: { 'example.com': true },
      darkenSites: false,
      darkenSiteExceptions: { 'github.com': false },
      zoom: 3,
      zoomIncludesOsFontSize: true,
      siteZooms: { 'a.com': 1.5, 'd.com': 0.5 },
      forceZoom: true
    })
  })

  it('keeps zoom factors to two decimals within the sheet range', () => {
    expect(clampZoom(1.2345)).toBe(1.23)
    expect(clampZoom(0.1)).toBe(0.5)
    expect(clampZoom(10)).toBe(3)
    expect(clampZoom(Number.NaN)).toBe(1)
  })
})

describe('per-site maps', () => {
  it('keys sites by registrable domain and only for web pages', () => {
    expect(siteKey('https://en.wikipedia.org/wiki/Zen')).toBe('wikipedia.org')
    expect(siteKey('https://www.bbc.co.uk/news')).toBe('bbc.co.uk')
    expect(siteKey('http://localhost:3000/')).toBe('localhost')
    expect(siteKey('zen://settings')).toBeNull()
    expect(siteKey('about:blank')).toBeNull()
    expect(siteKey('file:///tmp/x.html')).toBeNull()
  })

  it('drops a value equal to the default, so lists only hold real exceptions', () => {
    let map: Record<string, boolean> = {}
    map = withSiteOverride(map, 'a.com', true, false)
    expect(map).toEqual({ 'a.com': true })
    map = withSiteOverride(map, 'a.com', false, false)
    expect(map).toEqual({})
    map = withSiteOverride({ 'a.com': true }, 'a.com', null, false)
    expect(map).toEqual({})
    const zooms = withSiteOverride({ 'a.com': 1.5 }, 'a.com', 1, 1)
    expect(zooms).toEqual({})
  })

  it('matches a host against stored domains by suffix, longest first', () => {
    const sites = { 'example.co.uk': true, 'm.example.co.uk': false, 'wikipedia.org': true }
    expect(siteValue(sites, 'https://www.example.co.uk/')).toBe(true)
    expect(siteValue(sites, 'https://m.example.co.uk/')).toBe(false)
    expect(siteValue(sites, 'https://en.wikipedia.org/')).toBe(true)
    expect(siteValue(sites, 'https://notwikipedia.org/')).toBeUndefined()
    expect(siteValue(sites, 'not a url')).toBeUndefined()
  })
})

describe('desktop site', () => {
  it('follows the device by default: large screens and docked phones get the desktop', () => {
    const s = settings()
    expect(desktopByDefault(s, phone)).toBe(false)
    expect(desktopByDefault(s, tablet)).toBe(true)
    expect(desktopByDefault(s, docked)).toBe(true)
    expect(desktopByDefault(settings({ desktopSite: 'on' }), phone)).toBe(true)
    expect(desktopByDefault(settings({ desktopSite: 'off' }), tablet)).toBe(false)
  })

  it('remembers the choice per site and never for internal pages', () => {
    const s = settings({ desktopSites: { 'wikipedia.org': true, 'example.com': false } })
    expect(resolveDesktop(s, 'https://en.wikipedia.org/', phone)).toBe(true)
    expect(resolveDesktop(s, 'https://example.com/', tablet)).toBe(false)
    expect(resolveDesktop(s, 'https://other.org/', phone)).toBe(false)
    expect(resolveDesktop(settings({ desktopSite: 'on' }), 'zen://settings', phone)).toBe(false)
  })
})

describe('dark theme for sites', () => {
  it('is the switch minus its per-site exceptions', () => {
    const s = settings({ darkenSites: true, darkenSiteExceptions: { 'github.com': false } })
    expect(resolveDarkening(s, 'https://example.com/')).toBe(true)
    expect(resolveDarkening(s, 'https://gist.github.com/')).toBe(false)
    expect(resolveDarkening(s, 'zen://newtab')).toBe(false)
    const off = settings({ darkenSiteExceptions: { 'example.com': true } })
    expect(resolveDarkening(off, 'https://example.com/')).toBe(true)
    expect(resolveDarkening(off, 'https://other.com/')).toBe(false)
  })
})

describe('zoom', () => {
  it('steps along the zoom table and sticks at the ends', () => {
    expect(stepZoom(1, 1)).toBe(1.1)
    expect(stepZoom(1, -1)).toBe(0.9)
    expect(stepZoom(3, 1)).toBe(3)
    expect(stepZoom(0.5, -1)).toBe(0.5)
    // Between two levels: to the next one in that direction.
    expect(stepZoom(1.05, 1)).toBe(1.1)
    expect(stepZoom(1.05, -1)).toBe(1)
    expect(stepZoom(2.7, 1)).toBe(3)
    expect(stepZoom(0.4, -1)).toBe(0.5)
  })

  it('maps a factor to the nearest slider position and back', () => {
    expect(ZOOM_LEVELS[zoomLevelIndex(1)]).toBe(1)
    expect(ZOOM_LEVELS[zoomLevelIndex(1.3)]).toBe(1.25)
    expect(ZOOM_LEVELS[zoomLevelIndex(0.1)]).toBe(0.5)
    expect(ZOOM_LEVELS[zoomLevelIndex(9)]).toBe(3)
    expect(formatZoom(1.25)).toBe('125%')
    expect(formatZoom(0.666)).toBe('67%')
  })

  it('takes the site factor times the system font scale when included', () => {
    const s = settings({ zoom: 1.25, siteZooms: { 'a.com': 1.5 } })
    const large: PageEnvironment = { ...phone, fontScale: 1.3 }
    expect(resolveZoom(s, 'https://a.com/', phone)).toBe(1.5)
    expect(resolveZoom(s, 'https://b.com/', phone)).toBe(1.25)
    expect(resolveZoom(s, 'https://b.com/', large)).toBe(1.625)
    expect(resolveZoom(s, 'https://a.com/', large)).toBe(1.95)
    expect(
      resolveZoom(settings({ ...s, zoomIncludesOsFontSize: false }), 'https://b.com/', large)
    ).toBe(1.25)
    expect(resolveZoom(s, 'zen://settings', large)).toBe(1)
  })

  it('resolves everything for one page and ships the rules a host keeps', () => {
    const s = settings({
      desktopSites: { 'wikipedia.org': true },
      darkenSites: true,
      siteZooms: { 'a.com': 1.5 },
      forceZoom: true
    })
    expect(resolvePageControls(s, 'https://en.wikipedia.org/', phone)).toEqual({
      desktop: true,
      darken: true,
      zoom: 1,
      forceZoom: true
    })
    const rules = pageRulesFor(s, { ...tablet, fontScale: 1.15 })
    expect(rules).toEqual({
      desktop: { default: true, sites: { 'wikipedia.org': true } },
      darken: { default: true, sites: {} },
      zoom: { default: 1, sites: { 'a.com': 1.5 }, scale: 1.15 },
      forceZoom: true
    })
    // The rules are a copy: mutating them leaves the settings alone.
    rules.zoom.sites['b.com'] = 2
    expect(s.siteZooms).toEqual({ 'a.com': 1.5 })
  })
})

describe('viewport meta rewrite', () => {
  const base = { zoom: 1, desktop: false, forceZoom: false, deviceWidth: 412 }

  it('parses and serialises the content attribute', () => {
    const m = parseViewport('width=device-width, initial-scale=1.0; user-scalable=no')
    expect([...m]).toEqual([
      ['width', 'device-width'],
      ['initial-scale', '1.0'],
      ['user-scalable', 'no']
    ])
  })

  it('leaves a page alone at 100 percent without desktop or force-zoom', () => {
    expect(rewriteViewport('width=device-width, initial-scale=1', base)).toBeNull()
    expect(rewriteViewport(null, base)).toBeNull()
    expect(needsViewportMeta(base)).toBe(false)
  })

  it('narrows the layout viewport by the zoom factor so the page reflows and scales up', () => {
    expect(rewriteViewport('width=device-width, initial-scale=1', { ...base, zoom: 1.25 })).toBe(
      'width=330, initial-scale=1.25'
    )
    expect(rewriteViewport('width=device-width', { ...base, zoom: 2 })).toBe('width=206')
    // A fixed width scales the same way.
    expect(rewriteViewport('width=1024', { ...base, zoom: 0.5 })).toBe('width=2048')
    // Scale limits the page set keep their meaning relative to the zoomed layout.
    expect(
      rewriteViewport('width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no', {
        ...base,
        zoom: 1.5
      })
    ).toBe('width=275, initial-scale=1.5, maximum-scale=1.5, user-scalable=no')
    // Neither width nor scale: Chrome's 980 px desktop width is the base.
    expect(rewriteViewport(null, { ...base, zoom: 1.25 })).toBe('width=784')
    expect(rewriteViewport('user-scalable=no', { ...base, zoom: 1.25 })).toBe(
      'user-scalable=no, width=784'
    )
    expect(needsViewportMeta({ ...base, zoom: 1.25 })).toBe(true)
  })

  it('scales only the scales of a page with a scale but no width', () => {
    // Blink lays such a page out at device-width / initial-scale, so the scale alone narrows the
    // layout by the zoom; a width added beside it would become the layout width (784 CSS px shown
    // at 1.25 in a 412 view: sideways overflow, locked when the scales are pinned).
    expect(rewriteViewport('initial-scale=1', { ...base, zoom: 1.25 })).toBe('initial-scale=1.25')
    expect(
      rewriteViewport('user-scalable=no, initial-scale=1, maximum-scale=1, minimum-scale=1', {
        ...base,
        zoom: 1.25
      })
    ).toBe('user-scalable=no, initial-scale=1.25, maximum-scale=1.25, minimum-scale=1.25')
    expect(rewriteViewport('initial-scale=1', { ...base, zoom: 1.25 })).not.toContain('width')
  })

  it('falls back to an initial scale when the device width is unknown', () => {
    expect(rewriteViewport('width=device-width', { ...base, zoom: 1.25, deviceWidth: 0 })).toBe(
      'initial-scale=1.25'
    )
  })

  it('lays a desktop site out at the desktop width whatever the page asked for', () => {
    expect(
      rewriteViewport('width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no', {
        ...base,
        desktop: true
      })
    ).toBe('width=980')
    expect(rewriteViewport(null, { ...base, desktop: true })).toBe('width=980')
    // Zoom applies on top of the desktop layout.
    expect(rewriteViewport(null, { ...base, desktop: true, zoom: 1.25 })).toBe('width=784')
    expect(rewriteViewport('width=980', { ...base, desktop: true })).toBeNull()
    // A view wider than 980 CSS px (a large tablet in landscape, DeX) lays out at its own width.
    expect(rewriteViewport(null, { ...base, desktop: true, deviceWidth: 1280 })).toBe('width=1280')
    expect(rewriteViewport(null, { ...base, desktop: true, deviceWidth: 1280, zoom: 1.25 })).toBe(
      'width=1024'
    )
  })

  it('force-zoom drops the scale lock but keeps the rest', () => {
    expect(
      rewriteViewport('width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no', {
        ...base,
        forceZoom: true
      })
    ).toBe('width=device-width, initial-scale=1')
    expect(
      rewriteViewport('width=device-width, minimum-scale=1.5, maximum-scale=1.5', {
        ...base,
        forceZoom: true
      })
    ).toBe('width=device-width')
    expect(
      rewriteViewport('width=device-width, initial-scale=1', { ...base, forceZoom: true })
    ).toBeNull()
  })
})
