import { describe, expect, it } from 'vitest'
import type {
  BrowsingDataCount,
  BrowsingDataType,
  PermissionRule,
  SafetyCheckResult,
  UIState
} from '@shared/types'
import { contentSetting } from '@shared/contentSettings'
import { RANGE_OPTIONS, TYPE_LABEL, clearedToast, countLine, rangeLabel } from '../browsingData'
import { headline, passwordsSummary, safetyRows, worstState } from '../safetyCheck'
import {
  bySite,
  count,
  defaultDescription,
  defaultOptions,
  describeRule,
  hostOf
} from '../siteSettings'

const setting = (id: string): NonNullable<ReturnType<typeof contentSetting>> => {
  const s = contentSetting(id)
  if (!s) throw new Error(`no content setting ${id}`)
  return s
}

describe('Site settings rows', () => {
  it("offers the catalogue's choices with the built-in default marked", () => {
    expect(defaultOptions(setting('camera'))).toEqual([
      { value: 'ask', label: 'Ask (default)' },
      { value: 'deny', label: 'Block' }
    ])
    expect(defaultOptions(setting('popups')).map((o) => o.label)).toEqual([
      'Allow',
      'Block (default)'
    ])
  })

  it("describes the built-in default in the catalogue's words and every other choice in the row's own line (services pass 11)", () => {
    const camera = setting('camera')
    expect(defaultDescription(camera, 'ask')).toBe(camera.description)
    expect(defaultDescription(camera, 'deny')).toBe('Sites cannot use your camera')
    expect(defaultDescription(setting('popups'), 'allow')).toBe(
      'Sites can send pop-ups and use redirects'
    )
    // The template's "Sites can use automatic downloads without asking" is gone with the lines.
    const downloads = setting('automatic-downloads')
    expect(defaultDescription(downloads, 'ask')).toBe(downloads.description)
    expect(defaultDescription(downloads, 'allow')).toBe(
      'Sites can download multiple files without asking'
    )
    expect(defaultDescription(downloads, 'deny')).toBe(
      'Sites cannot download multiple files automatically'
    )
    // A value the row does not offer (Location has no Allow) still falls to the template.
    expect(defaultDescription(setting('geolocation'), 'allow')).toBe(
      'Sites can use location without asking'
    )
  })

  it("reads a value's own line from the catalogue first (MED-08 / EDGE-32), the template serving a row without one", () => {
    // Background video is not a thing a site asks for, so the template's "without asking" would
    // read wrong on Allow: the row carries its own line for that value and the one-line block
    // sentence as its description (the lead's #523 ruling).
    const video = setting('background-video')
    expect(video.description).toBe('Sites cannot play video in the background')
    expect(video.descriptions).toEqual({
      allow: 'Sites can keep playing video in the background'
    })
    expect(defaultDescription(video, 'deny')).toBe('Sites cannot play video in the background')
    expect(defaultDescription(video, 'allow')).toBe(
      'Sites can keep playing video in the background'
    )
    // A row without the field – none in the catalogue since services pass 11, so a made-up
    // one – still reads the built-in's line and the template for the rest.
    const sound = setting('sound')
    expect(defaultDescription(sound, 'deny')).toBe('Sites cannot play sound')
    const bare = { ...sound, descriptions: undefined }
    expect(defaultDescription(bare, 'allow')).toBe(sound.description)
    expect(defaultDescription(bare, 'deny')).toBe('Sites cannot use sound')
  })

  it('groups rules by site, sites by host, rows in catalogue order', () => {
    const rules: PermissionRule[] = [
      { origin: 'https://zed.example', permission: 'notifications', decision: 'allow' },
      { origin: 'https://alpha.example', permission: 'popups', decision: 'allow' },
      { origin: 'https://zed.example', permission: 'camera', decision: 'deny' },
      { origin: 'https://alpha.example', permission: 'geolocation', decision: 'allow' }
    ] as PermissionRule[]
    const grouped = bySite(rules)
    expect(grouped.map((g) => g.origin)).toEqual(['https://alpha.example', 'https://zed.example'])
    expect(grouped[0].rules.map((r) => r.permission)).toEqual(['geolocation', 'popups'])
    expect(grouped[1].rules.map((r) => r.permission)).toEqual(['camera', 'notifications'])
    expect(bySite([])).toEqual([])
  })

  it('reads a rule as "<label>: allowed|blocked", falling back to the permission label', () => {
    expect(
      describeRule({
        origin: 'https://a.example',
        permission: 'camera',
        decision: 'allow'
      } as PermissionRule)
    ).toBe('Camera: allowed')
    expect(
      describeRule({
        origin: 'https://a.example',
        permission: 'popups',
        decision: 'deny'
      } as PermissionRule)
    ).toBe('Pop-ups and redirects: blocked')
  })

  it('shows the host of an origin, or the origin itself when it is not a URL', () => {
    expect(hostOf('https://news.example:8443')).toBe('news.example:8443')
    expect(hostOf('*')).toBe('*')
    expect(hostOf('file://')).toBe('file://')
  })
})

describe('Delete browsing data copy', () => {
  it("names Chrome's six ranges, the last 15 minutes first (HB-07; the lead's ruling 1)", () => {
    // Quick Delete's default and the first entry of Chrome Android's spinner
    // (`IDS_CLEAR_BROWSING_DATA_TAB_PERIOD_15_MINUTES`, `android_chrome_strings.grd:1283–1285`)
    // and of the desktop dialog's picker (`IDS_SETTINGS_CLEAR_PERIOD_15_MINUTES`,
    // `settings_strings.grdp:946–948`); the same six on both hosts.
    expect(RANGE_OPTIONS.map((o) => o.value)).toEqual([
      '15min',
      'hour',
      'day',
      'week',
      'month',
      'all'
    ])
    expect(RANGE_OPTIONS[0].label).toBe('Last 15 minutes')
    expect(RANGE_OPTIONS[1].label).toBe('Last hour')
    expect(RANGE_OPTIONS[5].label).toBe('All time')
    expect(rangeLabel('15min')).toBe('Last 15 minutes')
  })

  it("names the period deleted in Chrome Android's quick-delete shape, never the types", () => {
    // `IDS_QUICK_DELETE_SNACKBAR_MESSAGE` "<TIME_PERIOD> deleted", the period the picker's own
    // string (`TimePeriodUtils.getTimePeriodString` → `IDS_CLEAR_BROWSING_DATA_TAB_PERIOD_*`);
    // `IDS_QUICK_DELETE_SNACKBAR_ALL_TIME_MESSAGE` "Deleted" for all time. A catalogue line
    // (§9.33): no full stop. The types the user ticked are the form's, not the toast's (W8-7).
    expect(clearedToast('hour', ['history'])).toBe('Last hour deleted')
    expect(clearedToast('day', ['history', 'cookies', 'cache'])).toBe('Last 24 hours deleted')
    expect(clearedToast('week', ['cache'])).toBe('Last 7 days deleted')
    expect(clearedToast('month', ['passwords', 'downloads'])).toBe('Last 4 weeks deleted')
    expect(clearedToast('all', ['history', 'cookies', 'cache'])).toBe('Deleted')
    // Whatever was ticked, the same line for the same range.
    expect(clearedToast('hour', ['passwords'])).toBe(clearedToast('hour', ['history', 'cache']))
  })

  it('takes the period from the one range-label source the picker uses, so a new range needs no second edit', () => {
    for (const option of RANGE_OPTIONS) {
      expect(rangeLabel(option.value)).toBe(option.label)
      expect(clearedToast(option.value, ['history'])).toBe(
        option.value === 'all' ? 'Deleted' : `${option.label} deleted`
      )
    }
    for (const option of RANGE_OPTIONS) {
      const toast = clearedToast(option.value, ['history'])
      expect(toast).not.toMatch(/\.$/)
      expect(toast).toMatch(/^(Last .+ deleted|Deleted)$/)
    }
  })

  it('reads "Nothing deleted" in the same voice when nothing went', () => {
    expect(clearedToast('hour', [])).toBe('Nothing deleted')
    expect(clearedToast('all', [])).toBe('Nothing deleted')
  })

  it('counts each type in its unit, notes when the range does not apply, and why a type is unavailable', () => {
    const counts: BrowsingDataCount[] = [
      { type: 'history', count: 1, unit: 'visits', rangeApplies: true, unavailable: null },
      { type: 'cookies', count: 1234, unit: 'sites', rangeApplies: false, unavailable: null },
      { type: 'cache', count: 48_000_000, unit: 'bytes', rangeApplies: false, unavailable: null },
      { type: 'downloads', count: null, unit: 'downloads', rangeApplies: true, unavailable: null },
      {
        type: 'sitePermissions',
        count: null,
        unit: 'permissions',
        rangeApplies: false,
        unavailable: null
      },
      {
        type: 'passwords',
        count: 3,
        unit: 'logins',
        rangeApplies: false,
        unavailable: 'Unlock the vault to clear saved passwords'
      }
    ]
    expect(countLine('history', null, 'hour')).toBe('Counting…')
    expect(countLine('history', counts, 'hour')).toBe('1 visit')
    expect(countLine('cookies', counts, 'all')).toBe('From 1,234 sites')
    expect(countLine('cookies', counts, 'hour')).toBe('From 1,234 sites (all time)')
    expect(countLine('cache', counts, 'all')).toMatch(/^45\.8 MB$|^48(\.0)? MB$/)
    expect(countLine('downloads', counts, 'hour')).toBe('')
    expect(countLine('sitePermissions', counts, 'hour')).toBe('All of it, from all time')
    expect(countLine('sitePermissions', counts, 'all')).toBe('')
    expect(countLine('passwords', counts, 'hour')).toBe('Unlock the vault to clear saved passwords')
    expect(countLine('autofill', counts, 'hour')).toBe('')
  })

  it('has a label for every type and words for every unit, the tabs type among them (HB-07; the lead’s 3(a))', () => {
    // The compiler keeps both lists complete: a new type or unit fails here before it can fall
    // through to no words.
    const TYPES: Record<BrowsingDataType, true> = {
      history: true,
      cookies: true,
      cache: true,
      downloads: true,
      passwords: true,
      autofill: true,
      sitePermissions: true,
      recentlyClosed: true,
      tabs: true
    }
    for (const type of Object.keys(TYPES) as BrowsingDataType[]) {
      expect(TYPE_LABEL[type]).toMatch(/^[A-Z]/)
    }
    // `IDS_CLEAR_TABS_TITLE` "Tabs" (`android_chrome_strings.grd:1265–1267`).
    expect(TYPE_LABEL.tabs).toBe('Tabs')

    const UNITS: Record<Exclude<BrowsingDataCount['unit'], 'bytes'>, true> = {
      visits: true,
      sites: true,
      downloads: true,
      logins: true,
      entries: true,
      permissions: true,
      tabs: true
    }
    for (const unit of Object.keys(UNITS) as Array<keyof typeof UNITS>) {
      const counts: BrowsingDataCount[] = [
        { type: 'history', count: 1, unit, rangeApplies: true, unavailable: null },
        { type: 'cookies', count: 2, unit, rangeApplies: true, unavailable: null }
      ]
      // The tabs unit reads Chrome Android's line ("1 tab on this device"), every other its count.
      expect(countLine('history', counts, 'all')).toMatch(/^(From )?1 [a-z]+( on this device)?$/)
      expect(countLine('cookies', counts, 'all')).toMatch(/^(From )?2 [a-z]+s( on this device)?$/)
    }
  })

  it('reads the phone’s Tabs row in Chrome Android’s Quick Delete words (HB-07; the lead’s 4)', () => {
    const tabs = (count: number): BrowsingDataCount[] => [
      { type: 'tabs', count, unit: 'tabs', rangeApplies: true, unavailable: null }
    ]
    expect(TYPE_LABEL.tabs).toBe('Tabs')
    expect(countLine('tabs', tabs(1), '15min')).toBe('1 tab on this device')
    expect(countLine('tabs', tabs(3), 'hour')).toBe('3 tabs on this device')
    expect(countLine('tabs', tabs(12), 'all')).toBe('12 tabs on this device')
    expect(countLine('tabs', tabs(0), '15min')).toBe('No tabs from the last 15 minutes')
    expect(countLine('tabs', tabs(0), 'day')).toBe('No tabs from the last 24 hours')
    expect(countLine('tabs', tabs(0), 'all')).toBe('No tabs on this device')
    expect(countLine('tabs', null, '15min')).toBe('Counting…')
  })

  it("says the period mid-sentence in the range list's own words – one place for them, the label with its capital lowered (ADDENDUM B3)", () => {
    for (const { value, label } of RANGE_OPTIONS) {
      if (value === 'all') continue
      const zero: BrowsingDataCount[] = [
        { type: 'tabs', count: 0, unit: 'tabs', rangeApplies: true, unavailable: null }
      ]
      expect(countLine('tabs', zero, value)).toBe(
        `No tabs from the ${label.charAt(0).toLowerCase()}${label.slice(1)}`
      )
    }
  })
})

function result(patch: Partial<SafetyCheckResult> = {}): SafetyCheckResult {
  return {
    checkedAt: 1_700_000_000_000,
    updates: {
      state: 'safe',
      summary: 'Zenium is up to date',
      currentVersion: '0.3.27',
      latestVersion: '0.3.27'
    },
    safeBrowsing: {
      state: 'safe',
      summary: 'Safe Browsing is on',
      configured: true,
      enabled: true
    },
    passwords: {
      state: 'safe',
      summary: 'No compromised passwords',
      compromised: 0,
      weak: 0,
      reused: 0,
      known: true,
      checkedAt: 1_700_000_000_000
    },
    permissions: {
      state: 'safe',
      summary: 'No sites need a review',
      grantedSites: 0,
      review: [],
      revoked: []
    },
    notifications: { state: 'safe', summary: 'No sites send notifications', sites: [] },
    extensions: { state: 'unavailable', summary: 'No extensions on this device', flagged: [] },
    ...patch
  }
}

describe('Safety check card', () => {
  it('takes the worst state across the rows, with unavailable counting as fine', () => {
    expect(worstState(result())).toBe('safe')
    expect(
      worstState(
        result({
          permissions: { state: 'info', summary: '', grantedSites: 3, review: [], revoked: [] }
        })
      )
    ).toBe('info')
    expect(
      worstState(
        result({
          permissions: { state: 'info', summary: '', grantedSites: 3, review: [], revoked: [] },
          passwords: {
            state: 'warning',
            summary: '',
            compromised: 2,
            weak: 0,
            reused: 0,
            known: true,
            checkedAt: 1_700_000_000_000
          }
        })
      )
    ).toBe('warning')
  })

  it('reads the headline from what is known so far', () => {
    expect(headline(null, true, null, null)).toBe('Checking…')
    expect(headline(null, false, 'boom', null)).toBe('Safety check could not run')
    expect(headline(null, false, null, null)).toBe('Safety check')
    const r = result()
    expect(headline(r, false, null, 'safe')).toBe('Everything looks safe')
    expect(headline(r, false, null, 'info')).toBe('A few things to look at')
    expect(headline(r, false, null, 'warning')).toBe('Some things need your attention')
    // A re-run keeps the last result's words rather than flashing "Checking…".
    expect(headline(r, true, null, 'safe')).toBe('Everything looks safe')
  })

  it('offers an action only where there is something to do', () => {
    const state = {
      updates: { phase: 'idle', mode: 'auto' },
      passwords: { locked: false, count: 4 },
      capabilities: { extensions: true }
    } as unknown as UIState
    const quiet = safetyRows(result(), state)
    expect(quiet.map((r) => r.id)).toEqual([
      'updates',
      'safeBrowsing',
      'passwords',
      'permissions',
      'notifications',
      'extensions'
    ])
    expect(quiet.find((r) => r.id === 'permissions')?.action).toBeNull()
    expect(quiet.find((r) => r.id === 'notifications')?.action).toBeNull()
    expect(quiet.find((r) => r.id === 'extensions')?.action).toBeNull()
    expect(quiet.find((r) => r.id === 'passwords')?.action).toEqual({
      label: 'Check passwords',
      ariaLabel: 'Run the password checkup',
      act: { kind: 'passwords-checkup' }
    })
    expect(quiet.find((r) => r.id === 'updates')?.action).toEqual({
      label: 'Check',
      act: { kind: 'command', command: 'updates.check' }
    })

    const busy = safetyRows(
      result({
        permissions: {
          state: 'info',
          summary: '2 sites hold several permissions',
          grantedSites: 2,
          review: [
            { origin: 'https://a.example', permissions: ['camera', 'microphone'], reason: 'many' }
          ],
          revoked: []
        },
        notifications: {
          state: 'info',
          summary: '1 site',
          sites: [{ origin: 'https://a.example', shown: 3 }]
        },
        extensions: {
          state: 'warning',
          summary: '1 flagged',
          flagged: [{ id: 'x', name: 'X', reasons: ['broad'] }]
        },
        updates: {
          state: 'unavailable',
          summary: 'Updates are managed elsewhere',
          currentVersion: '0.3.27',
          latestVersion: null
        }
      }),
      { ...state, passwords: { locked: true, count: 4 } } as unknown as UIState
    )
    expect(busy.find((r) => r.id === 'permissions')?.action?.act).toEqual({
      kind: 'section',
      section: 'site-settings'
    })
    expect(busy.find((r) => r.id === 'notifications')?.action?.label).toBe('Review')
    expect(busy.find((r) => r.id === 'extensions')?.action?.act).toEqual({
      kind: 'section',
      section: 'extensions'
    })
    expect(busy.find((r) => r.id === 'updates')?.action).toBeNull()
    // A locked vault cannot be checked from here.
    expect(busy.find((r) => r.id === 'passwords')?.action).toBeNull()
    // Permissions the sweep removed are something to review even with no site holding one (PS-41).
    const removed = safetyRows(
      result({
        permissions: {
          state: 'info',
          summary: 'Permissions removed from 1 site',
          grantedSites: 0,
          review: [],
          revoked: [{ origin: 'https://a.example', permissions: ['camera'], revokedAt: 1 }]
        }
      }),
      state
    )
    expect(removed.find((r) => r.id === 'permissions')?.action).toEqual({
      label: 'Review',
      ariaLabel: 'Review site permissions',
      act: { kind: 'section', section: 'site-settings' }
    })
    // Without extensions on the host, flagged ones are only a sentence.
    const noExt = safetyRows(
      result({
        extensions: {
          state: 'warning',
          summary: '1 flagged',
          flagged: [{ id: 'x', name: 'X', reasons: ['broad'] }]
        }
      }),
      { ...state, capabilities: { extensions: false } } as unknown as UIState
    )
    expect(noExt.find((r) => r.id === 'extensions')?.action).toBeNull()
  })

  it('reads the checkup summary into the Passwords row (PS-20 / ID-19): the counts’ sentence with when the checkup last ran, and Review into the manager while any login is compromised', () => {
    const state = {
      updates: { phase: 'idle', mode: 'auto' },
      passwords: { locked: false, count: 4 },
      capabilities: { extensions: true }
    } as unknown as UIState
    const at = 1_700_000_000_000

    // The engine's sentence keeps its words; the time of the last run follows it in the shape of
    // the Passwords section's own checkup row.
    expect(passwordsSummary({ ...result().passwords, checkedAt: at }, at + 20_000)).toBe(
      'No compromised passwords · Last checked just now'
    )
    expect(passwordsSummary({ ...result().passwords, checkedAt: at }, at + 3 * 3_600_000)).toBe(
      'No compromised passwords · Last checked 3 h ago'
    )
    // Never run on this device: nothing to date, the engine's offer stands alone.
    expect(
      passwordsSummary({
        ...result().passwords,
        state: 'info',
        summary: 'Run Password Checkup to look for compromised passwords',
        known: false,
        checkedAt: null
      })
    ).toBe('Run Password Checkup to look for compromised passwords')

    // Compromised logins – a checkup's finding, or a sign-in's leak before any checkup ran –
    // turn the row's action into a review of them in the manager's checkup view.
    const flagged = safetyRows(
      result({
        passwords: {
          state: 'warning',
          summary: '2 compromised passwords found; change them now',
          compromised: 2,
          weak: 1,
          reused: 0,
          known: true,
          checkedAt: null
        }
      }),
      state
    ).find((r) => r.id === 'passwords')
    expect(flagged).toMatchObject({
      state: 'warning',
      summary: '2 compromised passwords found; change them now',
      action: {
        label: 'Review',
        ariaLabel: 'Review compromised passwords',
        act: { kind: 'passwords-review' }
      }
    })
    // Weak or reused only: the checkup is the answer again, run once more.
    const weak = safetyRows(
      result({
        passwords: {
          state: 'info',
          summary: '1 weak password, 2 reused passwords',
          compromised: 0,
          weak: 1,
          reused: 2,
          known: true,
          checkedAt: at
        }
      }),
      state
    ).find((r) => r.id === 'passwords')
    expect(weak?.action?.act).toEqual({ kind: 'passwords-checkup' })
    expect(weak?.summary.startsWith('1 weak password, 2 reused passwords · Last checked ')).toBe(
      true
    )
    // A locked vault: the sentence still speaks (the summary lives outside the vault), no button.
    const locked = safetyRows(
      result({
        passwords: {
          state: 'warning',
          summary: '1 compromised password found; change it now',
          compromised: 1,
          weak: 0,
          reused: 0,
          known: true,
          checkedAt: at
        }
      }),
      { ...state, passwords: { locked: true, count: 4 } } as unknown as UIState
    ).find((r) => r.id === 'passwords')
    expect(locked?.action).toBeNull()
    expect(locked?.summary.startsWith('1 compromised password found; change it now · ')).toBe(true)
  })
})

describe('pane helpers', () => {
  it('pluralises counts', () => {
    expect(count(1, 'site')).toBe('1 site')
    expect(count(2, 'site')).toBe('2 sites')
    expect(count(1, 'entry', 'entries')).toBe('1 entry')
    expect(count(1200, 'entry', 'entries')).toBe('1,200 entries')
  })
})
