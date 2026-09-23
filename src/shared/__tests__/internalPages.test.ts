import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform } from '../types'
import {
  INTERNAL_PAGES,
  SETTINGS_SECTIONS,
  availableSections,
  internalPageAliasUrl,
  internalPageSection,
  internalPageSubpage,
  internalPageTitle,
  internalPageUrl,
  isInternalPageUrl,
  landingRuns,
  matchSections,
  matchesQuery,
  namesInternal,
  pageForOverlayKind,
  pageOpensAsTab,
  parseInternalPageUrl,
  refusedFromDocument,
  sameInternalPage
} from '../internalPages'

/** Every capability off: what a section needs must be named for it to show. */
const NONE = new Proxy({} as HostCapabilities, { get: () => false })
const ALL = new Proxy({} as HostCapabilities, { get: () => true })

describe('the page registry', () => {
  it('registers Settings with stable section ids in nav order', () => {
    expect(Object.keys(INTERNAL_PAGES)).toEqual([
      'settings',
      'history',
      'bookmarks',
      'downloads',
      'licences',
      'print',
      'pdf'
    ])
    expect(INTERNAL_PAGES.settings.title).toBe('Settings')
    // Zen's features, Autofill, Languages and then Privacy after Search; Agents, Passwords and
    // Security (the remembered per-site answers and the session's sign-ins) last among them; then
    // the browser-wide group past the first hairline: Sync, then Import beside it as Chrome keeps
    // its "Import bookmarks and settings" (ID-23), Accessibility, Keyboard Shortcuts, Default
    // Browser (the desktop platforms alone), Updates; About past the second.
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      'look',
      'compact',
      'newtab',
      'tabs',
      'downloads',
      'resources',
      'search',
      'autofill',
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
      'import',
      'accessibility',
      'shortcuts',
      'default-browser',
      'updates',
      'about'
    ])
  })

  it('keeps section ids URL safe and unique', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  it('registers History, Bookmarks and Downloads as singleton chrome pages of the desktop and tablet layouts (v2 §10.1)', () => {
    for (const [id, title, glyph] of [
      ['history', 'History', 'history'],
      ['bookmarks', 'Bookmarks', 'star'],
      ['downloads', 'Downloads', 'download']
    ] as const) {
      expect(INTERNAL_PAGES[id]).toMatchObject({
        id,
        title,
        render: 'chrome',
        singleton: true,
        glyph,
        // Nothing of the browser's own is bookmarked, and a page has no lock or site chip.
        pill: { showStar: false },
        splittable: false,
        // The phone keeps its panel; the same kind is what a host without page tabs opens.
        overlay: id,
        layouts: ['desktop', 'tablet'],
        // The day groups and the folder tree are in the page, not sections of the address.
        sections: []
      })
    }
  })

  it('registers Licences as a singleton chrome page tab of every layout with page tabs, no panel form (settings-73)', () => {
    expect(INTERNAL_PAGES.licences).toMatchObject({
      id: 'licences',
      title: 'Licences',
      render: 'chrome',
      singleton: true,
      glyph: 'scale',
      pill: { showStar: false },
      splittable: false,
      sections: []
    })
    // No overlay and no layouts: a tab wherever the host draws page tabs, the phone included.
    expect(INTERNAL_PAGES.licences.overlay).toBeUndefined()
    expect(INTERNAL_PAGES.licences.layouts).toBeUndefined()
    expect(pageOpensAsTab(INTERNAL_PAGES.licences, { pageTabs: true }, 'phone')).toBe(true)
    expect(pageOpensAsTab(INTERNAL_PAGES.licences, { pageTabs: false }, 'desktop')).toBe(false)
  })

  it('opens a chrome page as a tab where the host draws page tabs and the layout is one of its own', () => {
    const tabs = { pageTabs: true }
    const none = { pageTabs: false }
    for (const id of ['history', 'bookmarks', 'downloads'] as const) {
      expect(pageOpensAsTab(INTERNAL_PAGES[id], tabs, 'desktop')).toBe(true)
      expect(pageOpensAsTab(INTERNAL_PAGES[id], tabs, 'tablet')).toBe(true)
      // The phone's layout is left out: the page opens as its overlay, page tabs or not.
      expect(pageOpensAsTab(INTERNAL_PAGES[id], tabs, 'phone')).toBe(false)
      expect(pageOpensAsTab(INTERNAL_PAGES[id], none, 'desktop')).toBe(false)
    }
    // Settings names no layouts: a tab on every one of them, given page tabs.
    expect(pageOpensAsTab(INTERNAL_PAGES.settings, tabs, 'phone')).toBe(true)
    expect(pageOpensAsTab(INTERNAL_PAGES.settings, none, 'desktop')).toBe(false)
    // A document page is a tab whatever the host.
    expect(pageOpensAsTab(INTERNAL_PAGES.pdf, none, 'phone')).toBe(true)
  })

  it('names the page an overlay kind stands for: a page’s own overlay, or a Settings section by id', () => {
    expect(pageForOverlayKind('history')).toEqual({ id: 'history', section: null })
    expect(pageForOverlayKind('bookmarks')).toEqual({ id: 'bookmarks', section: null })
    expect(pageForOverlayKind('downloads')).toEqual({ id: 'downloads', section: null })
    expect(pageForOverlayKind('settings')).toEqual({ id: 'settings', section: null })
    expect(pageForOverlayKind('shortcuts')).toEqual({ id: 'settings', section: 'shortcuts' })
    expect(pageForOverlayKind('sync')).toEqual({ id: 'settings', section: 'sync' })
    // Overlays in their own right stay overlays – the Boosts and Passwords panels too, although
    // a Settings category shares their id.
    expect(pageForOverlayKind('theme')).toBeNull()
    expect(pageForOverlayKind('space-editor')).toBeNull()
    expect(pageForOverlayKind('boosts')).toBeNull()
    expect(pageForOverlayKind('passwords')).toBeNull()
    expect(pageForOverlayKind('addons')).toBeNull()
  })

  it('gates the print preview and the PDF viewer on the host that can show them', () => {
    // Print is Chrome's tab-modal preview: a chrome-drawn singleton over the page, never split.
    expect(INTERNAL_PAGES.print).toMatchObject({
      render: 'chrome',
      singleton: true,
      overlay: 'print',
      splittable: false,
      requires: 'printPreview'
    })
    // The PDF viewer is a document of its own per file, for the host whose engine draws no PDF.
    expect(INTERNAL_PAGES.pdf).toMatchObject({
      render: 'document',
      singleton: false,
      splittable: true,
      requires: 'pdfViewer'
    })
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
    // A query is the page's own parameters; a fragment is dropped.
    expect(parseInternalPageUrl('zenium://settings/look?from=menu#top')).toEqual({
      id: 'settings',
      section: 'look',
      query: { from: 'menu' }
    })
    expect(parseInternalPageUrl('zen://settings/look?#top')).toEqual({
      id: 'settings',
      section: 'look'
    })
  })

  it('carries a page’s parameters as the address’s query, never in the alias the pill shows', () => {
    // chrome://history/?q=, chrome://bookmarks/?id=: what "More from This Site", the omnibox's
    // @history / @bookmarks scopes and the bar's "Bookmark Manager" open the page with.
    expect(parseInternalPageUrl('zen://history?q=example.com')).toEqual({
      id: 'history',
      section: null,
      query: { q: 'example.com' }
    })
    expect(parseInternalPageUrl('zenium://bookmarks?folder=f1&q=zen')).toEqual({
      id: 'bookmarks',
      section: null,
      query: { folder: 'f1', q: 'zen' }
    })
    expect(internalPageUrl({ id: 'history', section: null, query: { q: 'a b&c' } })).toBe(
      'zen://history?q=a+b%26c'
    )
    expect(parseInternalPageUrl('zen://history?q=a+b%26c')?.query).toEqual({ q: 'a b&c' })
    expect(internalPageUrl({ id: 'downloads', section: null, query: {} })).toBe('zen://downloads')
    expect(internalPageAliasUrl('zen://history?q=example.com')).toBe('zenium://history')
    expect(internalPageAliasUrl('zen://bookmarks?folder=f1')).toBe('zenium://bookmarks')
    expect(sameInternalPage('zen://history?q=a', 'zen://history')).toBe(true)
  })

  it('opens the landing page for a section it does not know (a stale deep link still lands)', () => {
    expect(parseInternalPageUrl('zenium://settings/nothing')).toEqual({
      id: 'settings',
      section: null
    })
  })

  it('names a section’s own drill-in page as a third segment (v2 §10.2), a stale one landing on the section', () => {
    expect(parseInternalPageUrl('zen://settings/privacy/site-data')).toEqual({
      id: 'settings',
      section: 'privacy',
      subpage: 'site-data'
    })
    expect(parseInternalPageUrl('zenium://Settings/Privacy/Site-Data?site=a')).toEqual({
      id: 'settings',
      section: 'privacy',
      subpage: 'site-data',
      query: { site: 'a' }
    })
    expect(internalPageSubpage('zen://settings/privacy/site-data')).toEqual({
      id: 'site-data',
      label: 'Site data'
    })
    expect(internalPageSubpage('zen://settings/privacy')).toBeNull()
    expect(internalPageSection('zen://settings/privacy/site-data')?.id).toBe('privacy')
    // A page the section does not have, or a page under a section that has none: the section.
    expect(parseInternalPageUrl('zen://settings/privacy/deeper')).toEqual({
      id: 'settings',
      section: 'privacy'
    })
    expect(parseInternalPageUrl('zen://settings/look/site-data')).toEqual({
      id: 'settings',
      section: 'look'
    })
    expect(parseInternalPageUrl('zen://settings/privacy/site-data/more')).toBeNull()
    expect(internalPageUrl({ id: 'settings', section: 'privacy', subpage: 'site-data' })).toBe(
      'zen://settings/privacy/site-data'
    )
    // A drill-in page hangs off a section: without one it is not an address.
    expect(internalPageUrl({ id: 'settings', section: null, subpage: 'site-data' })).toBe(
      'zen://settings'
    )
    expect(internalPageAliasUrl('zen://settings/privacy/site-data?site=a')).toBe(
      'zenium://settings/privacy/site-data'
    )
    expect(internalPageTitle('zen://settings/privacy/site-data')).toBe('Settings')
  })

  it('refuses documents, sites and unregistered pages', () => {
    expect(parseInternalPageUrl('zen://error?code=-105')).toBeNull()
    expect(parseInternalPageUrl('zen://newtab')).toBeNull()
    expect(parseInternalPageUrl('zen://blank')).toBeNull()
    expect(parseInternalPageUrl('zenium://nothing')).toBeNull()
    expect(parseInternalPageUrl('https://settings/')).toBeNull()
    expect(parseInternalPageUrl('settings')).toBeNull()
    expect(parseInternalPageUrl('')).toBeNull()
  })

  it('round-trips between the stored zen:// form and the user-facing alias', () => {
    expect(internalPageUrl({ id: 'settings', section: null })).toBe('zen://settings')
    expect(internalPageUrl({ id: 'settings', section: 'privacy' })).toBe('zen://settings/privacy')
    expect(internalPageAliasUrl('zen://settings/privacy')).toBe('zenium://settings/privacy')
    expect(internalPageAliasUrl('zenium://settings')).toBe('zenium://settings')
    expect(internalPageAliasUrl('https://example.com/')).toBe('https://example.com/')
    expect(isInternalPageUrl('zen://settings/look')).toBe(true)
    expect(isInternalPageUrl('zen://history')).toBe(true)
    expect(isInternalPageUrl('zen://newtab')).toBe(false)
    for (const id of ['history', 'bookmarks', 'downloads']) {
      expect(internalPageUrl({ id, section: null })).toBe(`zen://${id}`)
      expect(internalPageAliasUrl(`zen://${id}`)).toBe(`zenium://${id}`)
      // No sections: a stale or made-up one lands on the page.
      expect(parseInternalPageUrl(`zenium://${id}/today`)).toEqual({ id, section: null })
    }
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
      // Ungated too: every host can take a bookmarks HTML or passwords CSV file (ID-23).
      'import',
      'about'
    ])
    const desktop = availableSections(INTERNAL_PAGES.settings, ALL, 'desktop', 'linux').map(
      (s) => s.id
    )
    expect(desktop).toEqual(SETTINGS_SECTIONS.map((s) => s.id))
    const tablet = availableSections(INTERNAL_PAGES.settings, ALL, 'tablet', 'android').map(
      (s) => s.id
    )
    // Compact mode is the desktop's (the tablet's sidebar collapses to its rail, TABLET-02);
    // the keyboard sections stay: a tablet may have one.
    expect(tablet).not.toContain('compact')
    expect(tablet).toContain('shortcuts')
    expect(tablet).toContain('sync')
  })

  it('keeps Default Browser to the desktop OSes: Android has the row under About (v2 §10.5)', () => {
    const ids = (platform?: Platform): string[] =>
      availableSections(INTERNAL_PAGES.settings, ALL, 'desktop', platform).map((s) => s.id)
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const list = ids(platform)
      expect(list).toContain('default-browser')
      // Zen's desktop panel order: after Keyboard Shortcuts, before Updates.
      expect(list.indexOf('default-browser')).toBe(list.indexOf('shortcuts') + 1)
      expect(list.indexOf('updates')).toBe(list.indexOf('default-browser') + 1)
    }
    expect(ids('android')).not.toContain('default-browser')
    expect(ids()).not.toContain('default-browser')
    // Every section without a platform list shows on every platform.
    expect(ids('android')).toEqual(SETTINGS_SECTIONS.filter((s) => !s.platforms).map((s) => s.id))
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
    expect(
      availableSections(INTERNAL_PAGES.settings, translating, 'phone').map((s) => s.id)
    ).toContain('languages')
  })
})

describe('the landing list', () => {
  const page = INTERNAL_PAGES.settings

  it('separates Zen features from Sync and Updates, and those from About (v2 §10.2)', () => {
    // The tablet layout: Sync (the desktop panel's section serves the two-pane page) and Keyboard
    // Shortcuts are listed there and not on the phone.
    const runs = landingRuns(page, availableSections(page, ALL, 'tablet')).map((run) =>
      run.map((s) => s.id)
    )
    expect(runs).toHaveLength(3)
    expect(runs[0][0]).toBe('look')
    expect(runs[0]).not.toContain('sync')
    expect(runs[0]).not.toContain('accessibility')
    expect(runs[1]).toEqual(['sync', 'import', 'accessibility', 'shortcuts', 'updates'])
    expect(runs[2]).toEqual(['about'])
  })

  it('lists Sync on the phone landing behind the capability, at the head of Zen’s second run (ID-08)', () => {
    const phone = availableSections(page, ALL, 'phone').map((s) => s.id)
    expect(phone).toContain('sync')
    const runs = landingRuns(page, availableSections(page, ALL, 'phone')).map((run) =>
      run.map((s) => s.id)
    )
    expect(runs[1]).toEqual(['sync', 'import', 'accessibility', 'updates'])
  })

  it('keeps a break when the section it precedes is missing and drops a run left empty', () => {
    const noSync = new Proxy({} as HostCapabilities, { get: (_t, key) => key !== 'sync' })
    const runs = landingRuns(page, availableSections(page, noSync, 'phone')).map((run) =>
      run.map((s) => s.id)
    )
    expect(runs[1]).toEqual(['import', 'accessibility', 'updates'])
    expect(runs[2]).toEqual(['about'])
    const bare = landingRuns(page, availableSections(page, NONE, 'phone')).map((run) =>
      run.map((s) => s.id)
    )
    expect(bare).toEqual([
      ['look', 'tabs', 'downloads', 'search', 'spaces', 'containers', 'boosts', 'mods', 'security'],
      ['import'],
      ['about']
    ])
    // Import is the one ungated section of the middle run: without it the run is left empty and
    // goes, About following the first run directly.
    const emptied = landingRuns(
      page,
      availableSections(page, NONE, 'phone').filter((s) => s.id !== 'import')
    ).map((run) => run.map((s) => s.id))
    expect(emptied).toEqual([
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
    expect(matchSections(SETTINGS_SECTIONS, 'default browser').map((s) => s.id)).toEqual([
      'default-browser',
      'about'
    ])
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
