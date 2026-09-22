// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLEAR_ON_EXIT_TYPES,
  SITE_DATA_ORIGIN_CAP,
  emptySiteDataStatus,
  type SiteDataListing,
  type SiteDataOriginRow,
  type SiteDataSiteState,
  type SiteDataStatus
} from '@shared/siteData'

/*
 * The words and the small decisions of Cookies and site data (siteDataUi.ts), read on their own:
 * the default's three radios with the block-all row's browser-wide line, the lists' headings on
 * a host with and without windows, the add form's feedback (the hint, the refusal, the duplicate,
 * the move), the on-exit rows and their paragraph, the viewer's storage and count lines, and the
 * site-information row's choice, decider and second line, with what picking a choice sends.
 */

const invoke = vi.fn<(name: string, args?: unknown) => Promise<unknown>>(async () => null)
Object.assign(window, { zen: { invoke, on: () => () => undefined } })

const ui = await import('../siteDataUi')

function status(over: Partial<SiteDataStatus> = {}): SiteDataStatus {
  return { ...emptySiteDataStatus(), ...over }
}

function row(over: Partial<SiteDataOriginRow> = {}): SiteDataOriginRow {
  return {
    origin: 'https://example.com',
    site: 'example.com',
    cookies: 0,
    usageBytes: null,
    permissions: [],
    state: 'default',
    ...over
  }
}

function listing(over: Partial<SiteDataListing> = {}): SiteDataListing {
  return { rows: [row()], total: 1, truncated: false, sized: true, ...over }
}

function site(over: Partial<SiteDataSiteState> = {}): SiteDataSiteState {
  return {
    state: 'default',
    pattern: null,
    addable: '[*.]example.com',
    default: 'block-third-party',
    ...over
  }
}

beforeEach(() => {
  invoke.mockClear()
  invoke.mockImplementation(async () => null)
})

describe('the default', () => {
  it('offers Chrome’s three radios in Chrome’s order, the block-all row saying it is browser-wide', () => {
    const options = ui.siteDataDefaultOptions()
    expect(options.map((o) => o.value)).toEqual(['allow', 'block-third-party', 'block-all'])
    expect(options.map((o) => o.label)).toEqual([
      'Allow all cookies',
      'Block third-party cookies',
      'Block all cookies'
    ])
    const blockAll = options[2]!
    expect(blockAll.description.startsWith('Browser-wide, not per site')).toBe(true)
    expect(blockAll.description).toContain('cookie jar')
    // The always-allow list's exception moved to the picker's title block (§9.13: two lines).
    expect(ui.SITE_DATA_TEXT.default.sheetDescription).toContain('always-allow list')
    // Every line fits two lines at 360 dp (#322 nit 2): about 80 characters at 13 px in the 296
    // the text has beside the radio; and a sentence takes its full stop (nit 4).
    for (const option of options) {
      expect(option.description.length).toBeGreaterThan(0)
      expect(option.description.length).toBeLessThanOrEqual(84)
      expect(option.description.endsWith('.')).toBe(true)
    }
  })

  it('carries the third-party setting as the switch under the default (#322 Q3)', () => {
    expect(ui.siteDataPrivateOnly('block-private')).toBe(true)
    expect(ui.siteDataPrivateOnly('block')).toBe(false)
    expect(ui.siteDataPrivateOnly('allow')).toBe(false)
    expect(ui.siteDataPrivateOnlyMode(true)).toBe('block-private')
    expect(ui.siteDataPrivateOnlyMode(false)).toBe('block')
    expect(ui.SITE_DATA_TEXT.privateOnly.label(true)).toBe('Only in private windows')
    expect(ui.SITE_DATA_TEXT.privateOnly.label(false)).toBe('Only in private tabs')
    expect(ui.siteDataPrivateOnlyDescription(true, false)).toBe(
      'Outside private tabs, embedded sites can use cookies.'
    )
    expect(ui.siteDataPrivateOnlyDescription(false, true)).toBe(
      'Embedded sites cannot use cookies anywhere.'
    )
  })
})

describe('the lists', () => {
  it('head the lists with Chrome’s words, the on-exit list closing as the host does', () => {
    expect(ui.siteDataListHeading('allow', true)).toBe('Sites that can always use cookies')
    expect(ui.siteDataListHeading('block', false)).toBe('Sites that can never use cookies')
    expect(ui.siteDataListHeading('clearOnExit', true)).toBe(
      'Always clear cookies when windows are closed'
    )
    expect(ui.siteDataListHeading('clearOnExit', false)).toBe(
      'Always clear cookies when Zenium closes'
    )
  })

  it('describe a list and its rows for the host’s timing of the clear', () => {
    expect(ui.siteDataListDescription('clearOnExit', false)).toContain('when Zenium closes')
    expect(ui.siteDataListDescription('clearOnExit', true)).toContain('the next time Zenium starts')
    expect(ui.siteDataPatternDescription('clearOnExit', false)).toBe('Cleared when Zenium closes')
    expect(ui.siteDataPatternDescription('clearOnExit', true)).toBe(
      'Cleared the next time Zenium starts'
    )
    // The always and never lists' rows are the pattern alone: "Can always use cookies" under
    // "Sites that can always use cookies" restated the heading (#322 nit 1).
    expect(ui.siteDataPatternDescription('allow', false)).toBeUndefined()
    expect(ui.siteDataPatternDescription('block', true)).toBeUndefined()
    expect(ui.siteDataListDescription('block', false)).toContain('cleared when it is added')
  })

  it('find the list holding a pattern as typed, in the grammar’s canonical form', () => {
    const s = status({ block: ['[*.]example.com'], allow: ['https://news.example:8443'] })
    expect(ui.siteDataListOf(s, '[*.]example.com')).toBe('block')
    expect(ui.siteDataListOf(s, '[*.]EXAMPLE.com')).toBe('block')
    expect(ui.siteDataListOf(s, 'https://news.example:8443')).toBe('allow')
    expect(ui.siteDataListOf(s, 'news.example')).toBeNull()
    expect(ui.siteDataListOf(s, 'not a pattern!')).toBeNull()
  })

  it('answer the add form: the hint while empty or new, the refusal, the duplicate, the move', () => {
    const s = status({ block: ['[*.]example.com'] })
    expect(ui.siteDataAddFeedback(s, 'allow', '', false)).toEqual({
      problem: null,
      hint: ui.SITE_DATA_TEXT.lists.fieldHint
    })
    expect(ui.siteDataAddFeedback(s, 'allow', '  ', false).problem).toBeNull()
    expect(ui.siteDataAddFeedback(s, 'allow', 'news.example', false)).toEqual({
      problem: null,
      hint: ui.SITE_DATA_TEXT.lists.fieldHint
    })
    // A problem comes with the grammar's hint, which the form keeps showing until the field is
    // judged – on blur, Enter or Add (§9.12's `:user-invalid`, #322 nit 3).
    expect(ui.siteDataAddFeedback(s, 'allow', 'not a pattern!', false)).toEqual({
      problem: ui.SITE_DATA_TEXT.lists.invalid,
      hint: ui.SITE_DATA_TEXT.lists.fieldHint
    })
    expect(ui.siteDataAddFeedback(s, 'block', '[*.]example.com', false)).toEqual({
      problem: ui.SITE_DATA_TEXT.lists.duplicate,
      hint: ui.SITE_DATA_TEXT.lists.fieldHint
    })
    const moves = ui.siteDataAddFeedback(s, 'allow', '[*.]example.com', false)
    expect(moves.problem).toBeNull()
    expect(moves.hint).toBe(
      'Currently under “Sites that can never use cookies”; Add moves it here.'
    )
    // Sentences take their full stop, the empty-field hint and the list's empty line none (nit 4).
    expect(ui.SITE_DATA_TEXT.lists.invalid.endsWith('.')).toBe(true)
    expect(ui.SITE_DATA_TEXT.lists.duplicate.endsWith('.')).toBe(true)
    expect(ui.SITE_DATA_TEXT.lists.empty.endsWith('.')).toBe(false)
  })
})

describe('clear on exit', () => {
  it('lists every browsing-data type but passwords, with the dialog’s labels', () => {
    const rows = ui.clearOnExitRows()
    expect(rows.map((r) => r.type)).toEqual([...CLEAR_ON_EXIT_TYPES])
    expect(rows.map((r) => r.type)).not.toContain('passwords')
    expect(rows.find((r) => r.type === 'history')?.label).toBe('Browsing history')
    expect(rows.find((r) => r.type === 'recentlyClosed')?.label).toBe('Recently closed tabs')
  })

  it('describes the group: the choice and the passwords line, the host’s timing once, a pending clear', () => {
    const base = ui.clearOnExitDescription(status())
    expect(base).toBe(ui.SITE_DATA_TEXT.clearOnExit.description)
    expect(base).toContain('Saved passwords are never cleared this way')
    // The host that clears at its next start says so in the choice's own sentence, once (#322
    // Q6 and (d)); the lists' standing clear is theirs to say, not this group's.
    const nextLaunch = ui.clearOnExitDescription(status({ clearsAtNextLaunch: true }))
    expect(nextLaunch).toContain('the next time Zenium starts')
    expect(nextLaunch.match(/next time Zenium starts/g)).toHaveLength(1)
    expect(nextLaunch).toContain('Saved passwords are never cleared this way')
    expect(nextLaunch.split('. ').length).toBeLessThanOrEqual(3)
    expect(ui.clearOnExitDescription(status({ block: ['a.example'] }))).toBe(base)
    expect(ui.clearOnExitDescription(status({ clearOnExit: ['a.example'] }))).toBe(base)
    expect(ui.clearOnExitDescription(status({ pendingClear: true }))).toContain('still running')
  })

  it('toggles a type and keeps the dialog’s order whatever the order picked', () => {
    expect(ui.toggleClearOnExitType([], 'cache', true)).toEqual(['cache'])
    expect(ui.toggleClearOnExitType(['cache'], 'history', true)).toEqual(['history', 'cache'])
    expect(ui.toggleClearOnExitType(['history', 'cache'], 'cache', false)).toEqual(['history'])
    expect(ui.toggleClearOnExitType(['history'], 'history', false)).toEqual([])
    expect(ui.toggleClearOnExitType(['history'], 'history', true)).toEqual(['history'])
  })
})

describe('the viewer', () => {
  it('names an origin by its host for https and whole for anything else', () => {
    expect(ui.originLabel('https://example.com')).toBe('example.com')
    expect(ui.originLabel('https://example.com:8443')).toBe('example.com:8443')
    expect(ui.originLabel('http://127.0.0.1:18131')).toBe('http://127.0.0.1:18131')
  })

  it('writes the storage line: cookies, the size where sized, permissions; the honest words otherwise', () => {
    expect(ui.originLine(row({ cookies: 1 }), true)).toBe('1 cookie')
    expect(ui.originLine(row({ cookies: 12, usageBytes: 2048 }), true)).toBe('12 cookies · 2 KB')
    expect(
      ui.originLine(
        row({
          cookies: 2,
          usageBytes: 512,
          permissions: [{ permission: 'camera', decision: 'allow' }]
        }),
        true
      )
    ).toBe('2 cookies · 512 B · 1 permission')
    expect(
      ui.originLine(
        row({
          permissions: [
            { permission: 'camera', decision: 'allow' },
            { permission: 'geolocation', decision: 'deny' }
          ]
        }),
        false
      )
    ).toBe('2 permissions')
    // An unsized origin on a host that sizes others (Android's probed cookie origins) says so…
    expect(ui.originLine(row({ usageBytes: null }), true)).toBe('Size unavailable')
    // …but where no origin is sized (Electron) the heading says it once, never the row.
    expect(ui.originLine(row({ usageBytes: null }), false)).toBe('No data')
    expect(ui.originLine(row({ cookies: 3, usageBytes: null }), true)).toBe('3 cookies')
    // Sized at nothing is a measurement, not a missing one.
    expect(ui.originLine(row({ usageBytes: 0 }), true)).toBe('No data')
  })

  it('adds the policy’s word for an origin a list holds to the row’s second line', () => {
    expect(ui.siteDataStateWord('default')).toBeNull()
    expect(ui.siteDataStateWord('allow')).toBe('Always allowed')
    expect(ui.siteDataStateWord('block')).toBe('Never allowed')
    expect(ui.siteDataStateWord('clear-on-exit')).toBe('Cleared on exit')
    expect(ui.originDescription(row({ cookies: 2 }), true)).toBe('2 cookies')
    expect(ui.originDescription(row({ cookies: 2, state: 'clear-on-exit' }), true)).toBe(
      '2 cookies · Cleared on exit'
    )
    expect(ui.originDescription(row({ state: 'block' }), false)).toBe('No data · Never allowed')
  })

  it('counts the sites at the heading’s aside, and the cap’s share of them when the listing stopped there', () => {
    expect(ui.siteDataCountAside(listing({ total: 1 }))).toBe('1 site')
    expect(ui.siteDataCountAside(listing({ total: 2 }))).toBe('2 sites')
    expect(ui.siteDataCountAside(listing({ total: 1204, truncated: true }))).toBe(
      `${SITE_DATA_ORIGIN_CAP.toLocaleString()} of 1,204 sites`
    )
  })

  it('writes the cap’s line and the one sizes-unavailable note under the heading, each its own line', () => {
    expect(ui.siteDataListingNotes(listing())).toEqual([])
    // The cap's line fits one line at the dialog's 400 (#322 nit 6): the count is the heading's
    // aside, so the line does not repeat it.
    const capped = `Showing the ${SITE_DATA_ORIGIN_CAP.toLocaleString()} with the most data`
    expect(ui.siteDataListingNotes(listing({ total: 1204, truncated: true }))).toEqual([capped])
    expect(ui.siteDataListingNotes(listing({ sized: false }))).toEqual([
      ui.SITE_DATA_TEXT.viewer.sizeUnavailable
    ])
    expect(
      ui.siteDataListingNotes(listing({ sized: false, total: 1500, truncated: true }))
    ).toEqual([capped, ui.SITE_DATA_TEXT.viewer.sizeUnavailable])
    // Nothing stored: nothing to size, so no note.
    expect(ui.siteDataListingNotes(listing({ rows: [], total: 0, sized: false }))).toEqual([])
  })
})

describe('the site-information row', () => {
  it('maps the page’s state to the picker’s choice and names it', () => {
    expect(ui.siteDataChoice(site())).toBe('default')
    expect(ui.siteDataChoice(site({ state: 'allow' }))).toBe('allow')
    expect(ui.siteDataChoice(site({ state: 'clear-on-exit' }))).toBe('clearOnExit')
    expect(ui.siteDataChoice(site({ state: 'block' }))).toBe('block')
    expect(ui.siteDataChoiceLabel(site())).toBe('Use the default')
    expect(ui.siteDataChoiceLabel(site({ state: 'block' }))).toBe('Never allow')
    expect(ui.siteDataChoiceLabel(site({ state: 'clear-on-exit' }))).toBe('Clear on exit')
  })

  it('says what decides: the list entry as it stands, else the default the page falls to, else no site', () => {
    expect(ui.siteDataDecider(site({ state: 'block', pattern: '[*.]example.com' }))).toBe(
      'Listed as [*.]example.com'
    )
    expect(ui.siteDataDecider(site())).toBe('Block third-party cookies')
    expect(ui.siteDataDecider(site({ default: 'block-all' }))).toBe('Block all cookies')
    expect(ui.siteDataDecider(site({ addable: null }))).toBe(ui.SITE_DATA_TEXT.site.noSite)
    expect(ui.siteDataRowLine(site())).toBe('Use the default · Block third-party cookies')
    expect(ui.siteDataRowLine(site({ state: 'block', pattern: '127.0.0.1' }))).toBe(
      'Never allow · Listed as 127.0.0.1'
    )
    expect(ui.siteDataOverviewLine(site())).toBeUndefined()
    expect(ui.siteDataOverviewLine(site({ state: 'allow', pattern: 'a.example' }))).toBe(
      'Always allowed'
    )
  })

  it('offers four options – the default named for what it is, then the lists – with the host’s timing under clear on exit', () => {
    const options = ui.siteDataChoiceOptions(site({ default: 'allow' }), false)
    expect(options.map((o) => o.value)).toEqual(['default', 'allow', 'clearOnExit', 'block'])
    expect(options[0]).toEqual({
      value: 'default',
      label: 'Use the default',
      description: 'Allow all cookies'
    })
    expect(options[2]!.description).toBe('Its cookies and data go when Zenium closes.')
    // The host that clears at its next start says the mechanism as a sentence (the #322 ruling
    // (d)); the row's value line never carries a second moment.
    expect(ui.siteDataChoiceOptions(site(), true)[2]!.description).toBe(
      'Site data from this session is cleared the next time Zenium starts.'
    )
    expect(options[3]!.description).toContain('cleared now')
  })

  it('applies a choice: the site onto the list picked, the deciding entry off its list for the default', async () => {
    invoke.mockImplementation(async () => ({ ok: true, pattern: '[*.]example.com' }))
    expect(await ui.applySiteDataChoice(site(), 'https://www.example.com/page', 'block')).toBeNull()
    expect(invoke).toHaveBeenCalledWith('siteData.addSite', {
      list: 'block',
      url: 'https://www.example.com/page'
    })

    invoke.mockClear()
    expect(
      await ui.applySiteDataChoice(
        site({ state: 'block', pattern: '[*.]example.com' }),
        'https://www.example.com/page',
        'default'
      )
    ).toBeNull()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('siteData.remove', { pattern: '[*.]example.com' })

    // Already on the default: nothing to take off, nothing sent.
    invoke.mockClear()
    expect(await ui.applySiteDataChoice(site(), 'https://example.com/', 'default')).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('hands back the engine’s reason when it refused', async () => {
    invoke.mockImplementation(async () => ({ ok: false, problem: 'That list is full' }))
    expect(await ui.applySiteDataChoice(site(), 'https://example.com/', 'allow')).toBe(
      'That list is full'
    )
  })
})
