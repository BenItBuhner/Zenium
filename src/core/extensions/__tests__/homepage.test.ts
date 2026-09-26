import { describe, expect, it } from 'vitest'
import {
  homepageControls,
  homepageOf,
  resolveHomepageOverride,
  type HomepageOverride
} from '../homepage'

/*
 * `chrome_settings_overrides.homepage`: the page an extension's manifest sets, which of several
 * extensions holds it (Chrome's newest-installed precedence), and the control the Settings rows
 * and the Home action read.
 */

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

describe('homepageOf', () => {
  it('reads the manifest’s http(s) homepage, the Web Store install parameter substituted as Chrome does', () => {
    expect(homepageOf({ chrome_settings_overrides: { homepage: 'https://www.bing.com/' } })).toBe(
      'https://www.bing.com/'
    )
    expect(
      homepageOf({ chrome_settings_overrides: { homepage: 'http://start.example/?p=__PARAM__' } })
    ).toBe('http://start.example/?p=')
    // Normalised as a URL Chrome would set: a bare host becomes its origin's page.
    expect(homepageOf({ chrome_settings_overrides: { homepage: 'https://example.com' } })).toBe(
      'https://example.com/'
    )
  })

  it('declares none for a manifest without the key, a part that is not a string, or a page that is not http(s)', () => {
    expect(homepageOf({})).toBeNull()
    expect(homepageOf({ chrome_settings_overrides: {} })).toBeNull()
    expect(homepageOf({ chrome_settings_overrides: null })).toBeNull()
    expect(homepageOf({ chrome_settings_overrides: { homepage: 42 } })).toBeNull()
    expect(homepageOf({ chrome_settings_overrides: { homepage: 'chrome://newtab' } })).toBeNull()
    expect(
      homepageOf({ chrome_settings_overrides: { homepage: 'javascript:alert(1)' } })
    ).toBeNull()
    expect(homepageOf({ chrome_settings_overrides: { homepage: 'not a url' } })).toBeNull()
    // The other parts of the key say nothing about the homepage.
    expect(
      homepageOf({
        chrome_settings_overrides: { startup_pages: ['https://a.example/'] }
      })
    ).toBeNull()
  })
})

describe('resolveHomepageOverride', () => {
  const older: HomepageOverride = {
    extensionId: OLD,
    name: 'Older',
    url: 'https://older.example/',
    installedAt: 1_000
  }
  const newer: HomepageOverride = {
    extensionId: NEW,
    name: 'Newer',
    url: 'https://newer.example/',
    installedAt: 2_000
  }

  it('gives the setting to the most recently installed extension, whatever order they come in', () => {
    expect(resolveHomepageOverride([older, newer])).toBe(newer)
    expect(resolveHomepageOverride([newer, older])).toBe(newer)
    expect(resolveHomepageOverride([older])).toBe(older)
    expect(resolveHomepageOverride([])).toBeNull()
  })

  it('breaks a tie in install time to the first candidate – the registry’s order, when offered in it', () => {
    const twin = { ...newer, installedAt: older.installedAt }
    expect(resolveHomepageOverride([older, twin])).toBe(older)
    expect(resolveHomepageOverride([twin, older])).toBe(twin)
  })
})

describe('homepageControls', () => {
  it('is the one `homepage` control with the page as its value, or nothing while no extension holds it', () => {
    expect(
      homepageControls({
        extensionId: NEW,
        name: 'Newer',
        url: 'https://newer.example/',
        installedAt: 2_000
      })
    ).toEqual({ homepage: { extensionId: NEW, name: 'Newer', value: 'https://newer.example/' } })
    expect(homepageControls(null)).toEqual({})
  })
})
