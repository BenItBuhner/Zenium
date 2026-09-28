import { describe, expect, it } from 'vitest'
import type { BlockedSite } from '../../../shared/types'
import { TEXT_MATCH_SET_ID } from '../engine'
import {
  BLOCKED_SITES_CAP,
  SAFE_BROWSING_SET_ID,
  blockedSiteCategory,
  recordBlockedSites
} from '../report'
import { USER_RULE_SET_ID } from '../rules'

describe('blockedSiteCategory', () => {
  it('names the kind of rule set that matched, a list or an unknown set reading as a tracker', () => {
    expect(blockedSiteCategory(TEXT_MATCH_SET_ID)).toBe('tracker')
    expect(blockedSiteCategory(undefined)).toBe('tracker')
    expect(blockedSiteCategory('builtin:site-exceptions')).toBe('tracker')
    expect(blockedSiteCategory(USER_RULE_SET_ID)).toBe('user')
    expect(blockedSiteCategory('ext:abc@example/ruleset_1')).toBe('extension')
    expect(blockedSiteCategory(SAFE_BROWSING_SET_ID)).toBe('unsafe')
  })
})

describe('recordBlockedSites', () => {
  it('tallies by registrable domain in first-seen order, keeping the first category seen', () => {
    let sites = recordBlockedSites(undefined, [
      { host: 'stats.g.doubleclick.net', setId: TEXT_MATCH_SET_ID },
      { host: 'www.google-analytics.com', setId: TEXT_MATCH_SET_ID, count: 2 }
    ])
    expect(sites).toEqual([
      { domain: 'doubleclick.net', category: 'tracker', count: 1 },
      { domain: 'google-analytics.com', category: 'tracker', count: 2 }
    ])
    const same = sites
    sites = recordBlockedSites(sites, [
      { host: 'ad.doubleclick.net', setId: USER_RULE_SET_ID, count: 3 },
      { host: 'cdn.example.co.uk', setId: 'ext:abc@example/ruleset_1' }
    ])
    expect(sites).toBe(same)
    expect(sites).toEqual([
      { domain: 'doubleclick.net', category: 'tracker', count: 4 },
      { domain: 'google-analytics.com', category: 'tracker', count: 2 },
      { domain: 'example.co.uk', category: 'extension', count: 1 }
    ])
  })

  it('skips empty hosts and non-positive counts, recording nothing when nothing remains', () => {
    expect(recordBlockedSites(undefined, [{ host: '' }, { host: 'a.example', count: 0 }])).toBe(
      undefined
    )
    const sites: BlockedSite[] = [{ domain: 'a.example', category: 'tracker', count: 1 }]
    expect(recordBlockedSites(sites, [{ host: 'b.example', count: -1 }])).toBe(sites)
    expect(sites).toHaveLength(1)
  })

  it('keeps the first BLOCKED_SITES_CAP domains, counting known ones past the cap', () => {
    let sites: BlockedSite[] | undefined
    for (let i = 0; i < BLOCKED_SITES_CAP + 5; i++)
      sites = recordBlockedSites(sites, [{ host: `t${i}.example` }])
    expect(sites).toHaveLength(BLOCKED_SITES_CAP)
    expect(sites?.[0]?.domain).toBe('t0.example')
    expect(sites?.at(-1)?.domain).toBe(`t${BLOCKED_SITES_CAP - 1}.example`)
    sites = recordBlockedSites(sites, [
      { host: 'www.t3.example', count: 2 },
      { host: 'late.example' }
    ])
    expect(sites).toHaveLength(BLOCKED_SITES_CAP)
    expect(sites?.[3]).toEqual({ domain: 't3.example', category: 'tracker', count: 3 })
    expect(sites?.some((s) => s.domain === 'late.example')).toBe(false)
  })
})
