import { describe, expect, it } from 'vitest'
import {
  DISMISS_COOLDOWN_MS,
  defaultScope,
  displayIcon,
  fallbackShortcutTitle,
  iconSize,
  isInstallable,
  isSecureContextUrl,
  isVectorIcon,
  isWithinScope,
  launcherName,
  markDismissed,
  markPrompted,
  MIN_VISIT_GAP_MS,
  parseWebAppManifest,
  pickIcon,
  pinnedAppFor,
  PROMPT_INTERVAL_MS,
  recordVisit,
  shortcutIcon,
  shouldPrompt,
  tileColor,
  tileInk,
  tileLetter,
  type WebAppIcon,
  type WebAppInfo
} from '../webApp'

const DOC = 'https://app.example.com/tools/editor?mode=new#top'
const MANIFEST = 'https://app.example.com/tools/manifest.webmanifest'

function icon(
  src: string,
  sizes: string,
  purpose?: string,
  type?: string
): Record<string, unknown> {
  return { src, sizes, purpose, type }
}

function parsed(raw: Record<string, unknown>, manifestUrl = MANIFEST, doc = DOC): WebAppInfo {
  const info = parseWebAppManifest(raw, manifestUrl, doc)
  if (!info) throw new Error('expected a web app')
  return info
}

describe('parseWebAppManifest', () => {
  it('resolves URLs against the manifest and applies the W3C defaults', () => {
    const info = parsed({
      name: '  Sketch   Studio ',
      short_name: 'Sketch',
      description: 'Draw things.',
      start_url: './start?src=pwa',
      display: 'standalone',
      theme_color: '#123456',
      background_color: 'rgb(255, 255, 255)',
      icons: [icon('icons/192.png', '192x192'), icon('icons/512.png', '512x512', 'any maskable')],
      screenshots: [
        { src: 'shots/phone.png', sizes: '540x1170', form_factor: 'narrow', label: 'Home' },
        { src: 'shots/wide.png', sizes: '1280x720', form_factor: 'wide' }
      ]
    })
    expect(info.manifestUrl).toBe(MANIFEST)
    expect(info.name).toBe('Sketch Studio')
    expect(info.shortName).toBe('Sketch')
    expect(info.description).toBe('Draw things.')
    expect(info.startUrl).toBe('https://app.example.com/tools/start?src=pwa')
    // No `scope`: the start URL's directory, without its query.
    expect(info.scope).toBe('https://app.example.com/tools/')
    // No `id`: the start URL.
    expect(info.id).toBe('https://app.example.com/tools/start?src=pwa')
    expect(info.display).toBe('standalone')
    expect(info.themeColor).toBe('#123456')
    expect(info.backgroundColor).toBe('rgb(255, 255, 255)')
    expect(info.icons).toEqual([
      {
        src: 'https://app.example.com/tools/icons/192.png',
        sizes: '192x192',
        type: null,
        purpose: ['any']
      },
      {
        src: 'https://app.example.com/tools/icons/512.png',
        sizes: '512x512',
        type: null,
        purpose: ['any', 'maskable']
      }
    ])
    expect(info.screenshots).toEqual([
      {
        src: 'https://app.example.com/tools/shots/phone.png',
        sizes: '540x1170',
        type: null,
        formFactor: 'narrow',
        label: 'Home'
      },
      {
        src: 'https://app.example.com/tools/shots/wide.png',
        sizes: '1280x720',
        type: null,
        formFactor: 'wide',
        label: null
      }
    ])
  })

  it('resolves the id against the origin and keeps a scope the start URL is inside', () => {
    const info = parsed({
      name: 'App',
      id: '/editor',
      start_url: '/tools/editor',
      scope: '/tools/'
    })
    expect(info.id).toBe('https://app.example.com/editor')
    expect(info.scope).toBe('https://app.example.com/tools/')
  })

  it('falls back to the default scope when the start URL is outside the declared one', () => {
    const info = parsed({ name: 'App', start_url: '/tools/editor', scope: '/other/' })
    expect(info.scope).toBe('https://app.example.com/tools/')
  })

  it('rejects manifests that describe no installable app', () => {
    expect(parseWebAppManifest(null, MANIFEST, DOC)).toBeNull()
    expect(parseWebAppManifest('nope', MANIFEST, DOC)).toBeNull()
    // No name at all.
    expect(parseWebAppManifest({ start_url: '/' }, MANIFEST, DOC)).toBeNull()
    // A cross-origin start URL is not this document's app.
    expect(
      parseWebAppManifest({ name: 'App', start_url: 'https://evil.example/' }, MANIFEST, DOC)
    ).toBeNull()
    // The document itself is not a web page.
    expect(parseWebAppManifest({ name: 'App' }, MANIFEST, 'about:blank')).toBeNull()
  })

  it('takes the short name as the name when there is nothing else and drops a duplicate', () => {
    expect(parsed({ short_name: 'Short' }).name).toBe('Short')
    expect(parsed({ short_name: 'Short' }).shortName).toBeNull()
    expect(parsed({ name: 'Same', short_name: 'Same' }).shortName).toBeNull()
  })

  it('skips broken icons and screenshots and unknown display modes', () => {
    const info = parsed({
      name: 'App',
      display: 'kiosk',
      icons: [
        null,
        'x',
        { sizes: '1x1' },
        icon('javascript:alert(1)', 'any'),
        icon('ok.png', 'ANY', 'weird')
      ],
      screenshots: [{ label: 'no src' }, { src: 'shot.png', form_factor: 'huge' }]
    })
    expect(info.display).toBe('browser')
    expect(info.icons).toEqual([
      { src: 'https://app.example.com/tools/ok.png', sizes: 'any', type: null, purpose: ['any'] }
    ])
    expect(info.screenshots).toEqual([
      {
        src: 'https://app.example.com/tools/shot.png',
        sizes: null,
        type: null,
        formFactor: null,
        label: null
      }
    ])
  })

  it('keeps colours only when they look like CSS colours', () => {
    expect(parsed({ name: 'A', theme_color: 'hsl(200 50% 50%)' }).themeColor).toBe(
      'hsl(200 50% 50%)'
    )
    expect(parsed({ name: 'A', theme_color: 'url(x)' }).themeColor).toBe('url(x)')
    expect(parsed({ name: 'A', theme_color: 'red; background: url(x)' }).themeColor).toBeNull()
    expect(parsed({ name: 'A', theme_color: 42 }).themeColor).toBeNull()
  })
})

describe('scope', () => {
  it('defaultScope is the start URL directory', () => {
    expect(defaultScope('https://a.test/x/y/page.html?q=1#h')).toBe('https://a.test/x/y/')
    expect(defaultScope('https://a.test/page')).toBe('https://a.test/')
    expect(defaultScope('https://a.test')).toBe('https://a.test/')
  })

  it('isWithinScope needs the same origin and the scope path as a prefix', () => {
    expect(isWithinScope('https://a.test/app/page', 'https://a.test/app/')).toBe(true)
    expect(isWithinScope('https://a.test/app/', 'https://a.test/app/')).toBe(true)
    expect(isWithinScope('https://a.test/application/', 'https://a.test/app')).toBe(true)
    expect(isWithinScope('https://a.test/other/', 'https://a.test/app/')).toBe(false)
    expect(isWithinScope('https://b.test/app/', 'https://a.test/app/')).toBe(false)
    expect(isWithinScope('http://a.test/app/', 'https://a.test/app/')).toBe(false)
    expect(isWithinScope('not a url', 'https://a.test/')).toBe(false)
  })

  it('pinnedAppFor picks the most specific scope', () => {
    const site = {
      id: 'site',
      name: 'Site',
      startUrl: 'https://a.test/',
      scope: 'https://a.test/',
      pinnedAt: 1
    }
    const docs = {
      id: 'docs',
      name: 'Docs',
      startUrl: 'https://a.test/docs/',
      scope: 'https://a.test/docs/',
      pinnedAt: 2
    }
    expect(pinnedAppFor('https://a.test/docs/page', [site, docs])?.id).toBe('docs')
    expect(pinnedAppFor('https://a.test/blog/', [site, docs])?.id).toBe('site')
    expect(pinnedAppFor('https://b.test/', [site, docs])).toBeNull()
  })
})

describe('icons', () => {
  const png = (
    src: string,
    sizes: string,
    purpose: WebAppIcon['purpose'] = ['any']
  ): WebAppIcon => ({
    src,
    sizes,
    type: 'image/png',
    purpose
  })

  it('iconSize reads the largest declared side and treats any as unbounded', () => {
    expect(iconSize({ sizes: '48x48 96x96' })).toBe(96)
    expect(iconSize({ sizes: '192X192' })).toBe(192)
    expect(iconSize({ sizes: '100x60' })).toBe(100)
    expect(iconSize({ sizes: 'any' })).toBe(Infinity)
    expect(iconSize({ sizes: '' })).toBe(0)
    expect(iconSize({ sizes: 'large' })).toBe(0)
  })

  it('isVectorIcon spots SVGs by type or file name', () => {
    expect(isVectorIcon({ src: 'https://a.test/i.svg', type: null })).toBe(true)
    expect(isVectorIcon({ src: 'https://a.test/i', type: 'image/svg+xml' })).toBe(true)
    expect(isVectorIcon({ src: 'https://a.test/i.png', type: 'image/png' })).toBe(false)
  })

  it('pickIcon prefers the smallest raster icon at or above the target', () => {
    const icons = [
      png('https://a.test/48.png', '48x48'),
      png('https://a.test/512.png', '512x512'),
      png('https://a.test/192.png', '192x192'),
      { ...png('https://a.test/v.svg', 'any'), type: 'image/svg+xml' }
    ]
    expect(pickIcon(icons, 'any')?.src).toBe('https://a.test/192.png')
    expect(pickIcon(icons, 'any', { target: 256 })?.src).toBe('https://a.test/512.png')
    // Nothing big enough: the largest there is.
    expect(pickIcon(icons, 'any', { target: 2048 })?.src).toBe('https://a.test/512.png')
    // Vectors only when asked for.
    expect(pickIcon([icons[3]], 'any')).toBeNull()
    expect(pickIcon([icons[3]], 'any', { allowVector: true })?.src).toBe('https://a.test/v.svg')
    // `any`-sized rasters win over undersized ones.
    expect(
      pickIcon([png('https://a.test/s.png', '48x48'), png('https://a.test/a.png', 'any')], 'any')
        ?.src
    ).toBe('https://a.test/a.png')
    expect(pickIcon(icons, 'maskable')).toBeNull()
  })

  it('shortcutIcon prefers maskable, then any, then monochrome', () => {
    const maskable = png('https://a.test/m.png', '512x512', ['maskable'])
    const any = png('https://a.test/a.png', '192x192')
    const mono = png('https://a.test/mono.png', '192x192', ['monochrome'])
    expect(shortcutIcon({ icons: [any, mono, maskable] })).toEqual({
      url: maskable.src,
      kind: 'maskable'
    })
    expect(shortcutIcon({ icons: [any, mono] })).toEqual({ url: any.src, kind: 'any' })
    expect(shortcutIcon({ icons: [mono] })).toEqual({ url: mono.src, kind: 'monochrome' })
    expect(shortcutIcon({ icons: [] })).toBeNull()
    // A vector-only manifest has nothing the launcher can draw.
    expect(
      shortcutIcon({ icons: [{ ...any, src: 'https://a.test/a.svg', type: 'image/svg+xml' }] })
    ).toBeNull()
  })

  it('displayIcon may be a vector and falls back to a maskable icon', () => {
    const svg = { ...png('https://a.test/a.svg', 'any'), type: 'image/svg+xml' }
    const maskable = png('https://a.test/m.png', '512x512', ['maskable'])
    expect(displayIcon({ icons: [svg] })).toBe(svg.src)
    expect(displayIcon({ icons: [maskable] })).toBe(maskable.src)
    expect(displayIcon({ icons: [] })).toBeNull()
  })

  it('isInstallable wants a secure context, a raster icon and its own window', () => {
    const base = parsed({
      name: 'App',
      display: 'standalone',
      icons: [icon('192.png', '192x192', undefined, 'image/png')]
    })
    expect(isInstallable(base)).toBe(true)
    expect(isInstallable({ ...base, display: 'browser' })).toBe(false)
    expect(isInstallable({ ...base, icons: [] })).toBe(false)
    expect(isInstallable({ ...base, startUrl: 'http://app.example.com/tools/editor' })).toBe(false)
    // Plain http on a loopback host is a secure context (an app under development installs too).
    expect(isInstallable({ ...base, startUrl: 'http://localhost:5173/' })).toBe(true)
    expect(isInstallable({ ...base, startUrl: 'http://127.0.0.1:18131/app/' })).toBe(true)
  })

  it('isSecureContextUrl is https or http on a loopback host', () => {
    expect(isSecureContextUrl('https://app.example.com/')).toBe(true)
    expect(isSecureContextUrl('http://app.example.com/')).toBe(false)
    expect(isSecureContextUrl('http://localhost/')).toBe(true)
    expect(isSecureContextUrl('http://dev.localhost:3000/')).toBe(true)
    expect(isSecureContextUrl('http://127.0.0.1/')).toBe(true)
    expect(isSecureContextUrl('http://127.1.2.3:8080/x')).toBe(true)
    expect(isSecureContextUrl('http://[::1]:8080/')).toBe(true)
    expect(isSecureContextUrl('http://localhost.example.com/')).toBe(false)
    expect(isSecureContextUrl('http://1270.0.0.1/')).toBe(false)
    expect(isSecureContextUrl('file:///tmp/app/')).toBe(false)
    expect(isSecureContextUrl('not a url')).toBe(false)
  })
})

describe('engagement', () => {
  const t0 = 1_700_000_000_000

  it('counts visits only when they are far enough apart', () => {
    const first = recordVisit(undefined, t0)
    expect(first).toEqual({
      visits: 1,
      firstVisitAt: t0,
      lastVisitAt: t0,
      dismissedAt: null,
      promptedAt: null
    })
    const soon = recordVisit(first, t0 + MIN_VISIT_GAP_MS - 1)
    expect(soon).toBe(first)
    const later = recordVisit(first, t0 + MIN_VISIT_GAP_MS)
    expect(later.visits).toBe(2)
    expect(later.lastVisitAt).toBe(t0 + MIN_VISIT_GAP_MS)
    expect(later.firstVisitAt).toBe(t0)
  })

  it('prompts after the second visit, not before', () => {
    const once = recordVisit(undefined, t0)
    expect(shouldPrompt(undefined, t0)).toBe(false)
    expect(shouldPrompt(once, t0)).toBe(false)
    const twice = recordVisit(once, t0 + MIN_VISIT_GAP_MS)
    expect(shouldPrompt(twice, t0 + MIN_VISIT_GAP_MS)).toBe(true)
  })

  it('a swipe silences the prompt for the cooldown, an ignored prompt for a day', () => {
    const twice = recordVisit(recordVisit(undefined, t0), t0 + MIN_VISIT_GAP_MS)
    const now = t0 + MIN_VISIT_GAP_MS
    const dismissed = markDismissed(twice, now)
    expect(dismissed.dismissedAt).toBe(now)
    expect(shouldPrompt(dismissed, now + DISMISS_COOLDOWN_MS - 1)).toBe(false)
    expect(shouldPrompt(dismissed, now + DISMISS_COOLDOWN_MS)).toBe(true)
    const prompted = markPrompted(twice, now)
    expect(prompted.dismissedAt).toBeNull()
    expect(shouldPrompt(prompted, now + PROMPT_INTERVAL_MS - 1)).toBe(false)
    expect(shouldPrompt(prompted, now + PROMPT_INTERVAL_MS)).toBe(true)
  })
})

describe('names', () => {
  it('launcherName prefers the short name', () => {
    expect(launcherName({ name: 'Sketch Studio', shortName: 'Sketch' })).toBe('Sketch')
    expect(launcherName({ name: 'Sketch Studio', shortName: null })).toBe('Sketch Studio')
  })

  it('fallbackShortcutTitle uses the page title, else the host', () => {
    expect(fallbackShortcutTitle('  Hello   World ', 'https://www.example.com/x')).toBe(
      'Hello World'
    )
    expect(fallbackShortcutTitle('', 'https://www.example.com/x')).toBe('example.com')
    expect(fallbackShortcutTitle('', 'nope')).toBe('Shortcut')
    expect(fallbackShortcutTitle('x'.repeat(80), 'https://a.test/')).toHaveLength(60)
  })
})

// The same three rules as ShortcutTile.kt (ShortcutTileTest.kt pins the Kotlin side).
describe('letter tile', () => {
  const accent = '#606eeb'

  it('tileColor takes the theme colour in the forms the launcher paints, else the accent', () => {
    expect(tileColor('#2F6F8F', accent)).toBe('#2f6f8f')
    expect(tileColor('#abc', accent)).toBe('#aabbcc')
    expect(tileColor(' #12345680 ', accent)).toBe('#123456')
    expect(tileColor('rgb(1, 2, 3)', accent)).toBe('#010203')
    expect(tileColor('rgba(255 0 0 / 50%)', accent)).toBe('#ff0000')
    expect(tileColor('rebeccapurple', accent)).toBe(accent)
    expect(tileColor('#12', accent)).toBe(accent)
    expect(tileColor(null, accent)).toBe(accent)
  })

  it('tileInk is white on a dark tile and the text colour on a light one', () => {
    expect(tileInk('#16161b')).toBe('#ffffff')
    expect(tileInk(accent)).toBe('#ffffff')
    expect(tileInk('#ffffff')).toBe('#15141a')
    expect(tileInk('#ffe080')).toBe('#15141a')
    // Either side of isDarkColor's 0.45 (the launcher draws the same split).
    expect(tileInk('#adadad')).toBe('#ffffff')
    expect(tileInk('#b4b4b4')).toBe('#15141a')
    expect(tileInk('not a colour')).toBe('#ffffff')
  })

  it('tileLetter takes the first letter or digit as one code point', () => {
    expect(tileLetter('  sketch studio')).toBe('S')
    expect(tileLetter('7 Days')).toBe('7')
    expect(tileLetter('école')).toBe('É')
    // A leading symbol is skipped for the first letter; a symbol-only title keeps its symbol whole.
    expect(tileLetter('→ Zenium')).toBe('Z')
    expect(tileLetter('😀😀')).toBe('😀')
    expect(tileLetter('   ')).toBe('?')
  })
})
