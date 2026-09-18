import { describe, expect, it } from 'vitest'
import {
  acceptLanguages,
  chromeUserAgent,
  chromiumBrands,
  clientHintPlatform,
  formatBrands,
  hasClientHints,
  lowEntropyClientHints
} from '../browserIdentity'

/**
 * Reference values read off Google Chrome 152.0.7977.82 (Linux x86_64, 2026-09-18) with the
 * DevTools protocol, and off Electron 44.3.0 (Chromium 152.0.7977.78): its default user agent
 * (`app.userAgentFallback`) and the `Sec-CH-UA` its renderer put on a subresource request.
 */
const CHROME_152_LINUX_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
const ELECTRON_44_LINUX_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Zenium/0.3.31 Chrome/152.0.7977.78 Electron/44.3.0 Safari/537.36'
const ELECTRON_152_SEC_CH_UA = '"Not?A_Brand";v="24", "Chromium";v="152"'

describe('chromeUserAgent', () => {
  it('turns Electron’s default string into the Chrome 152 reference string', () => {
    expect(chromeUserAgent(ELECTRON_44_LINUX_UA, 'Zenium')).toBe(CHROME_152_LINUX_UA)
  })

  it('does the same on Windows and macOS, keeping the platform section as Chrome has it', () => {
    expect(
      chromeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Zenium/0.3.31 Chrome/152.0.7977.78 Electron/44.3.0 Safari/537.36',
        'Zenium'
      )
    ).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
    )
    expect(
      chromeUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Zenium/0.3.31 Chrome/152.0.7977.78 Electron/44.3.0 Safari/537.36',
        'Zenium'
      )
    ).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
    )
  })

  it('escapes the app name and leaves a string already in Chrome’s shape alone', () => {
    expect(
      chromeUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Zen+Chromium/1.0 Chrome/152.0.7977.78 Electron/44.3.0 Safari/537.36',
        'Zen+Chromium'
      )
    ).toBe(CHROME_152_LINUX_UA)
    expect(chromeUserAgent(CHROME_152_LINUX_UA, 'Zenium')).toBe(CHROME_152_LINUX_UA)
  })

  it('never leaves an Electron or Zenium token, or a minor version, in the string', () => {
    const ua = chromeUserAgent(ELECTRON_44_LINUX_UA, 'Zenium')
    expect(ua).not.toMatch(/Electron|Zenium/)
    expect(ua).toMatch(/ Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/)
  })
})

describe('chromiumBrands', () => {
  it('builds the list Electron 44’s renderer sends for Chromium 152, in the same order', () => {
    expect(chromiumBrands('152.0.7977.78')).toEqual([
      { brand: 'Not?A_Brand', version: '24' },
      { brand: 'Chromium', version: '152' }
    ])
    expect(formatBrands(chromiumBrands('152.0.7977.78'))).toBe(ELECTRON_152_SEC_CH_UA)
    expect(formatBrands(chromiumBrands('152.0.7977.78', true))).toBe(
      '"Not?A_Brand";v="24.0.0.0", "Chromium";v="152.0.7977.78"'
    )
  })

  it('follows Chromium’s seeded GREASE characters, versions and order for other majors', () => {
    // Chromium's algorithm: chars[seed % 11], chars[(seed + 1) % 11]; versions[seed % 3]; the
    // two entries swap for odd majors (GetRandomOrder: {seed % 2, (seed + 1) % 2}).
    expect(formatBrands(chromiumBrands('153.0.1.2'))).toBe(
      '"Chromium";v="153", "Not_A Brand";v="8"'
    )
    expect(formatBrands(chromiumBrands('131.0.6778.85'))).toBe(
      '"Chromium";v="131", "Not_A Brand";v="24"'
    )
    expect(formatBrands(chromiumBrands('120.0.6099.109'))).toBe(
      '"Not_A Brand";v="8", "Chromium";v="120"'
    )
    expect(formatBrands(chromiumBrands('130.0.6723.58', true))).toBe(
      '"Not?A_Brand";v="99.0.0.0", "Chromium";v="130.0.6723.58"'
    )
  })

  it('pads a short version to four components in the full list', () => {
    expect(chromiumBrands('152', true)).toEqual([
      { brand: 'Not?A_Brand', version: '24.0.0.0' },
      { brand: 'Chromium', version: '152.0.0.0' }
    ])
  })
})

describe('lowEntropyClientHints', () => {
  it('names the three hints Chrome sends on every navigation, per platform', () => {
    expect(lowEntropyClientHints('152.0.7977.78', 'linux')).toEqual({
      'sec-ch-ua': ELECTRON_152_SEC_CH_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Linux"'
    })
    expect(lowEntropyClientHints('152.0.7977.78', 'win32')['sec-ch-ua-platform']).toBe('"Windows"')
    expect(lowEntropyClientHints('152.0.7977.78', 'darwin')['sec-ch-ua-platform']).toBe('"macOS"')
    expect(clientHintPlatform('android')).toBe('Android')
    expect(clientHintPlatform('freebsd')).toBe('Linux')
  })

  it('recognises an existing brand list in any casing', () => {
    expect(hasClientHints({ 'Sec-CH-UA': '"Chromium";v="152"' })).toBe(true)
    expect(hasClientHints({ 'sec-ch-ua': '' })).toBe(true)
    expect(hasClientHints({ 'sec-ch-ua-mobile': '?0', 'User-Agent': 'x' })).toBe(false)
  })
})

describe('acceptLanguages', () => {
  it('adds the base language after each region variant, as Chrome does', () => {
    expect(acceptLanguages('en-US', ['en-US'])).toBe('en-US,en')
    expect(acceptLanguages('de-DE', ['de-DE', 'en-US'])).toBe('de-DE,de,en-US,en')
    expect(acceptLanguages('pt-BR', ['pt-BR', 'pt-PT'])).toBe('pt-BR,pt,pt-PT')
  })

  it('keeps the locale first, drops duplicates (case-insensitively) and blanks', () => {
    expect(acceptLanguages('en-US', ['fr-FR', 'en-us', ' ', 'en'])).toBe('en-US,en,fr-FR,fr')
    expect(acceptLanguages('en', [])).toBe('en')
    expect(acceptLanguages('', [])).toBe('en-US,en')
  })

  it('drops entries that are not language tags and normalises POSIX spellings', () => {
    // A CI runner's locale list: `C` is the POSIX locale, not a language (Chrome never sends it).
    expect(acceptLanguages('en-US', ['en-US', 'C'])).toBe('en-US,en')
    expect(acceptLanguages('en-US', ['POSIX', 'C.UTF-8', 'de_DE.UTF-8', 'sr_RS@latin'])).toBe(
      'en-US,en,de-DE,de,sr-RS,sr'
    )
    expect(acceptLanguages('zh-Hant-TW', ['es-419'])).toBe('zh-Hant-TW,zh,es-419,es')
    expect(acceptLanguages('C', ['POSIX'])).toBe('en-US,en')
  })
})
