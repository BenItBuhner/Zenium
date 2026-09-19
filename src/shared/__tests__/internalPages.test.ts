import { describe, expect, it } from 'vitest'
import type { HostCapabilities } from '../types'
import {
  INTERNAL_PAGES,
  SETTINGS_SECTIONS,
  availableSections,
  internalPageAliasUrl,
  internalPageSection,
  internalPageTitle,
  internalPageUrl,
  isInternalPageUrl,
  landingRuns,
  matchSections,
  matchesQuery,
  namesInternal,
  parseInternalPageUrl,
  refusedFromDocument,
  sameInternalPage
} from '../internalPages'

/** Every capability off: what a section needs must be named for it to show. */
const NONE = new Proxy({} as HostCapabilities, { get: () => false })
const ALL = new Proxy({} as HostCapabilities, { get: () => true })

describe('the page registry', () => {
  it('registers Settings with stable section ids in nav order', () => {
    expect(Object.keys(INTERNAL_PAGES)).toEqual(['settings'])
    expect(INTERNAL_PAGES.settings.title).toBe('Settings')
    // Zen's features, Privacy and Security after Search, Security (the remembered per-site
    // answers and the session's sign-ins) last among them, then the browser-wide group past the
    // first hairline: Sync, Accessibility, Keyboard Shortcuts, Updates; About past the second.
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      'look',
      'compact',
      'newtab',
      'tabs',
      'downloads',
      'resources',
      'search',
      'languages',
      'privacy',
      'spaces',
      'containers',
      'boosts',
      'mods',
      'extensions',
      'agents',
      'passwords',
      'security',
      'sync',
      'accessibility',
      'shortcuts',
      'updates',
      'about'
    ])
  })

  it('keeps section ids URL safe and unique', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/)
  })
})

describe('parsing page addresses', () => {
  it('reads the landing page and a section from zen:// and the zenium:// alias alike', () => {
    expect(parseInternalPageUrl('zen://settings')).toEqual({ id: 'settings', section: null })
    expect(parseInternalPageUrl('zen://settings/')).toEqual({ id: 'settings', section: null })
    expect(parseInternalPageUrl('zenium://settings')).toEqual({ id: 'settings', section: null })
    expect(parseInternalPageUrl('zenium://settings/privacy')).toEqual({
      id: 'settings',
      section: 'privacy'
    })
    expect(parseInternalPageUrl('zen://settings/look')).toEqual({ id: 'settings', section: 'look' })
  })

  it('is case-insensitive and tolerates whitespace, a query and a fragment', () => {
    expect(parseInternalPageUrl('  ZENIUM://Settings/Privacy  ')).toEqual({
      id: 'settings',
      section: 'privacy'
    })
    expect(parseInternalPageUrl('zenium://settings/look?from=menu#top')).toEqual({
      id: 'settings',
      section: 'look'
    })
  })

  it('opens the landing page for a section it does not know (a stale deep link still lands)', () => {
    expect(parseInternalPageUrl('zenium://settings/nothing')).toEqual({
      id: 'settings',
      section: null
    })
  })

  it('refuses documents, sites and unregistered pages', () => {
    expect(parseInternalPageUrl('zen://error?code=-105')).toBeNull()
    expect(parseInternalPageUrl('zen://history')).toBeNull()
    expect(parseInternalPageUrl('zen://blank')).toBeNull()
    expect(parseInternalPageUrl('zenium://nothing')).toBeNull()
    expect(parseInternalPageUrl('https://settings/')).toBeNull()
    expect(parseInternalPageUrl('settings')).toBeNull()
    expect(parseInternalPageUrl('zen://settings/privacy/deeper')).toBeNull()
    expect(parseInternalPageUrl('')).toBeNull()
  })

  it('round-trips between the stored zen:// form and the user-facing alias', () => {
    expect(internalPageUrl({ id: 'settings', section: null })).toBe('zen://settings')
    expect(internalPageUrl({ id: 'settings', section: 'privacy' })).toBe('zen://settings/privacy')
    expect(internalPageAliasUrl('zen://settings/privacy')).toBe('zenium://settings/privacy')
    expect(internalPageAliasUrl('zenium://settings')).toBe('zenium://settings')
    expect(internalPageAliasUrl('https://example.com/')).toBe('https://example.com/')
    expect(isInternalPageUrl('zen://settings/look')).toBe(true)
    expect(isInternalPageUrl('zen://history')).toBe(false)
  })

  it('calls the tab Settings on every section and keeps the section label for the header', () => {
    expect(internalPageTitle('zen://settings')).toBe('Settings')
    expect(internalPageTitle('zen://settings/privacy')).toBe('Settings')
    expect(internalPageTitle('zenium://settings/look')).toBe('Settings')
    expect(internalPageTitle('https://example.com/')).toBeNull()
    expect(internalPageSection('zen://settings/privacy')?.label).toBe('Privacy and Security')
    expect(internalPageSection('zen://settings/about')?.label).toBe('About')
    expect(internalPageSection('zen://settings')).toBeNull()
  })

  it('treats every section of a page as the same page (reuse in space)', () => {
    expect(sameInternalPage('zen://settings', 'zen://settings/privacy')).toBe(true)
    expect(sameInternalPage('zen://settings/look', 'zenium://settings/about')).toBe(true)
    expect(sameInternalPage('zen://settings', 'zen://history')).toBe(false)
    expect(sameInternalPage('https://a.test/', 'https://a.test/')).toBe(false)
  })

  it('refuses a web document its own navigation to an internal address, not the browser’s documents theirs', () => {
    expect(namesInternal('zen://settings')).toBe(true)
    expect(namesInternal('ZENIUM://settings/privacy')).toBe(true)
    expect(namesInternal('zen://error?url=x')).toBe(true)
    expect(namesInternal('https://zen.test/zen://settings')).toBe(false)
    expect(namesInternal('zeniumx://settings')).toBe(false)
    expect(namesInternal(null)).toBe(false)

    // Web content, a data: or about:blank document, an extension's own document (its new-tab
    // override page, as Chrome refuses one a chrome://settings link), and no document at all:
    // refused.
    for (const document of [
      'https://example.com/',
      'data:text/html,<a>',
      'about:blank',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/newtab.html',
      '',
      null
    ]) {
      expect(refusedFromDocument(document, 'zen://settings/privacy')).toBe(true)
      expect(refusedFromDocument(document, 'zenium://settings')).toBe(true)
      expect(refusedFromDocument(document, 'zen://newtab')).toBe(true)
    }
    // The browser's own documents may link to its pages.
    expect(refusedFromDocument('zen://newtab', 'zenium://settings/look')).toBe(false)
    expect(refusedFromDocument('zen://error?url=https%3A%2F%2Fa.test', 'zen://settings')).toBe(
      false
    )
    // Anything that is not an internal address is not this rule's business.
    expect(refusedFromDocument('https://example.com/', 'https://other.test/')).toBe(false)
    expect(refusedFromDocument('https://example.com/', 'mailto:a@b.c')).toBe(false)
    expect(refusedFromDocument(null, null)).toBe(false)
  })
})

describe('the section model', () => {
  it('hides sections whose capability the host lacks and layouts they do not apply to', () => {
    const phone = availableSections(INTERNAL_PAGES.settings, NONE, 'phone').map((s) => s.id)
    expect(phone).toEqual([
      'look',
      'tabs',
      'downloads',
      'search',
      'spaces',
      'containers',
      'boosts',
      'mods',
      // Ungated, as the desktop Security pane is: every host keeps per-site answers (#62).
      'security',
      'about'
    ])
    const desktop = availableSections(INTERNAL_PAGES.settings, ALL, 'desktop').map((s) => s.id)
    expect(desktop).toEqual(SETTINGS_SECTIONS.map((s) => s.id))
    const tablet = availableSections(INTERNAL_PAGES.settings, ALL, 'tablet').map((s) => s.id)
    expect(tablet).toContain('compact')
    expect(tablet).toContain('shortcuts')
  })

  it('gates a section on exactly the capability it needs', () => {
    const caps = new Proxy({} as HostCapabilities, {
      get: (_t, key) => key === 'updates' || key === 'agents'
    })
    const ids = availableSections(INTERNAL_PAGES.settings, caps, 'phone').map((s) => s.id)
    expect(ids).toContain('updates')
    expect(ids).toContain('agents')
    expect(ids).not.toContain('extensions')
    expect(ids).not.toContain('sync')
    expect(ids).not.toContain('resources')
    expect(ids).not.toContain('accessibility')
    expect(ids).not.toContain('privacy')
    expect(ids).not.toContain('passwords')
    // #106's Languages follows the translation engine, as the desktop pane does.
    expect(ids).not.toContain('languages')
    const translating = new Proxy({} as HostCapabilities, { get: (_t, key) => key === 'translate' })
    expect(availableSections(INTERNAL_PAGES.settings, translating, 'phone').map((s) => s.id)).toContain(
      'languages'
    )
  })
})

describe('the landing list', () => {
  const page = INTERNAL_PAGES.settings

  it('separates Zen features from Sync and Updates, and those from About (v2 §10.2)', () => {
    const runs = landingRuns(page, availableSections(page, ALL, 'phone')).map((run) =>
      run.map((s) => s.id)
    )
    expect(runs).toHaveLength(3)
    expect(runs[0][0]).toBe('look')
    expect(runs[0]).not.toContain('sync')
    expect(runs[0]).not.toContain('accessibility')
    expect(runs[1]).toEqual(['sync', 'accessibility', 'updates'])
    expect(runs[2]).toEqual(['about'])
  })

  it('keeps a break when the section it precedes is missing and drops a run left empty', () => {
    const noSync = new Proxy({} as HostCapabilities, { get: (_t, key) => key !== 'sync' })
    const runs = landingRuns(page, availableSections(page, noSync, 'phone')).map((run) =>
      run.map((s) => s.id)
    )
    expect(runs[1]).toEqual(['accessibility', 'updates'])
    expect(runs[2]).toEqual(['about'])
    const bare = landingRuns(page, availableSections(page, NONE, 'phone')).map((run) =>
      run.map((s) => s.id)
    )
    expect(bare).toEqual([
      ['look', 'tabs', 'downloads', 'search', 'spaces', 'containers', 'boosts', 'mods', 'security'],
      ['about']
    ])
  })
})

describe('searching settings', () => {
  it('matches section labels and keywords, any word order, case-insensitive', () => {
    expect(matchSections(SETTINGS_SECTIONS, 'privacy').map((s) => s.id)).toEqual(['privacy'])
    expect(matchSections(SETTINGS_SECTIONS, 'Dark').map((s) => s.id)).toEqual(['look', 'boosts'])
    expect(matchSections(SETTINGS_SECTIONS, 'bar navigation').map((s) => s.id)).toEqual(['look'])
    expect(matchSections(SETTINGS_SECTIONS, 'default browser').map((s) => s.id)).toEqual(['about'])
  })

  it('returns every section for an empty query and none for nonsense', () => {
    expect(matchSections(SETTINGS_SECTIONS, '')).toHaveLength(SETTINGS_SECTIONS.length)
    expect(matchSections(SETTINGS_SECTIONS, '   ')).toHaveLength(SETTINGS_SECTIONS.length)
    expect(matchSections(SETTINGS_SECTIONS, 'xyzzy')).toEqual([])
  })

  it('matches a row by every term of the query', () => {
    expect(matchesQuery('Show the bookmarks bar under the toolbar', 'bookmarks bar')).toBe(true)
    expect(matchesQuery('Show the bookmarks bar under the toolbar', 'BAR toolbar')).toBe(true)
    expect(matchesQuery('Show the bookmarks bar under the toolbar', 'bar sidebar')).toBe(false)
    expect(matchesQuery('anything', '')).toBe(true)
  })
})
