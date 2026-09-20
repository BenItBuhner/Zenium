// The Kotlin engine's fixture is compared here, test-only (the core itself never touches Node).
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_BLOCKING_SETTINGS,
  DEFAULT_FILTER_LISTS,
  customListId,
  type BlockingSettings
} from '../../../shared/blocking'
import type { Tab } from '../../../shared/types'
import type { Browser } from '../../browser'
import { PermissionService } from '../../permissions'
import type { BlockingHost, BundledFilterList, StoreIO } from '../../platform'
import { DNR_OWNERSHIP } from '../../extensions/dnr/engineSink'
import { engineSetId } from '../../extensions/dnr/sink'
import { CONNECTIVITY_PROBES, connectivityProbesRuleSet } from '../connectivityProbes'
import { TEXT_MATCH_SET_ID, type TextMatch } from '../engine'
import { BlockingService, siteExceptionRule, type RuleSetOwnership } from '../service'
import { documentNameFor, tagOf, type IndexFile, type SetDocument } from '../store'
import {
  BUILTIN_RULE_SETS,
  RULE_SET_PRIORITY,
  USER_RULE_SET_ID,
  type RequestContext,
  type RuleSet
} from '../rules'
import { memoryIo } from './store.test'

type FetchResult = { ok: boolean; status: number; text: string }

interface Harness {
  browser: Browser
  io: StoreIO & { files: Map<string, string> }
  permissions: PermissionService
  settings: { blocking: BlockingSettings }
  tabs: Map<string, Tab>
  toasts: string[]
  fetched: string[]
  commits: { durable: number; volatile: number }
  respond: (url: string) => FetchResult | Promise<FetchResult>
}

function harness(
  options: { host?: BlockingHost; io?: StoreIO & { files: Map<string, string> } } = {}
): Harness {
  const io = options.io ?? memoryIo()
  const settings = { blocking: structuredClone(DEFAULT_BLOCKING_SETTINGS) }
  const tabs = new Map<string, Tab>()
  const toasts: string[] = []
  const fetched: string[] = []
  const commits = { durable: 0, volatile: 0 }
  const permissions = new PermissionService(io, {
    show: async () => 'block',
    cancel: () => undefined
  })
  const h: Harness = {
    io,
    permissions,
    settings,
    tabs,
    toasts,
    fetched,
    commits,
    respond: () => ({ ok: false, status: 0, text: '' }),
    browser: null as unknown as Browser
  }
  const browser = {
    permissions,
    platform: {
      io,
      blocking: options.host,
      net: {
        fetchText: async (url: string) => {
          fetched.push(url)
          return h.respond(url)
        }
      }
    },
    state: {
      settings,
      commit: () => commits.durable++,
      commitVolatile: () => commits.volatile++
    },
    tabs: { tab: (id: string | null | undefined) => (id ? tabs.get(id) : undefined) },
    toast: (message: string, kind: 'info' | 'error' = 'info') => toasts.push(`${kind}:${message}`)
  }
  h.browser = browser as unknown as Browser
  return h
}

function enabledIds(service: BlockingService): string[] {
  return service.engine
    .listRuleSets()
    .filter((s) => s.source === 'filter-list' && s.enabled)
    .map((s) => s.id)
    .sort()
}

const services: BlockingService[] = []
function start(h: Harness): BlockingService {
  const service = new BlockingService(h.browser)
  services.push(service)
  service.start()
  return service
}

afterEach(() => {
  for (const s of services.splice(0)) s.stop()
})

const req = (url: string, extra: Partial<RequestContext> = {}): RequestContext => ({
  url,
  type: 'script',
  method: 'GET',
  ...extra
})

describe('BlockingService levels', () => {
  it('registers every default list and enables the balanced tier by default', () => {
    const h = harness()
    const service = start(h)
    const all = service.engine
      .listRuleSets()
      .filter((s) => s.source === 'filter-list')
      .map((s) => s.id)
      .sort()
    expect(all).toEqual(DEFAULT_FILTER_LISTS.map((d) => d.id).sort())
    expect(enabledIds(service)).toEqual([
      'easylist',
      'easyprivacy',
      'peter-lowe',
      'ubo-badware',
      'ubo-filters',
      'urlhaus'
    ])
    expect(service.engine.summary(BUILTIN_RULE_SETS.globalOff)?.enabled).toBe(false)
    expect(service.engine.summary(BUILTIN_RULE_SETS.siteExceptions)?.enabled).toBe(false)
    expect(service.status().ready).toBe(true)
    expect(service.status().lists.map((l) => [l.id, l.enabled, l.tier])).toContainEqual([
      'ubo-privacy',
      false,
      'strict'
    ])
  })

  it('maps basic, strict and off to their documented sets', () => {
    const h = harness()
    const service = start(h)
    const change = (patch: Partial<BlockingSettings>): void => {
      h.settings.blocking = { ...h.settings.blocking, ...patch }
      service.onSettingsChanged()
    }
    change({ level: 'basic' })
    expect(enabledIds(service)).toEqual(['ubo-badware', 'urlhaus'])
    change({ level: 'strict' })
    expect(enabledIds(service)).toEqual([
      'easylist',
      'easyprivacy',
      'peter-lowe',
      'ubo-badware',
      'ubo-filters',
      'ubo-privacy',
      'urlhaus'
    ])
    change({ level: 'off' })
    expect(enabledIds(service)).toEqual([])
    expect(service.engine.summary(BUILTIN_RULE_SETS.globalOff)?.enabled).toBe(true)
    expect(service.engine.decide(req('https://anything.example/')).matched?.setId).toBe(
      BUILTIN_RULE_SETS.globalOff
    )
    change({ level: 'balanced' })
    // The master switch is the permission's default; the store's notification syncs the sets.
    service.setEnabled(false)
    expect(service.enabled).toBe(false)
    expect(h.permissions.defaultFor('ads')).toBe('allow')
    expect(h.commits.volatile).toBeGreaterThan(0)
    expect(enabledIds(service)).toEqual([])
    expect(service.engine.summary(BUILTIN_RULE_SETS.globalOff)?.enabled).toBe(true)
    expect(service.status()).toMatchObject({ enabled: false, siteExceptions: [] })
    service.setEnabled(true)
    expect(h.permissions.defaultFor('ads')).toBeUndefined()
    change({ lists: { 'ubo-privacy': true, easylist: false } })
    expect(enabledIds(service)).toEqual([
      'easyprivacy',
      'peter-lowe',
      'ubo-badware',
      'ubo-filters',
      'ubo-privacy',
      'urlhaus'
    ])
    expect(service.engine.summary(BUILTIN_RULE_SETS.globalOff)?.enabled).toBe(false)
  })

  it('fetches a list the moment it is switched on without content', async () => {
    const h = harness()
    const service = start(h)
    h.respond = () => ({
      ok: true,
      status: 200,
      text: '! Title: uBO privacy\n! Version: 7\n||fingerprint.example^\nexample.com##.x\n'
    })
    h.settings.blocking = { ...h.settings.blocking, level: 'strict' }
    service.onSettingsChanged()
    expect(service.status().lists.find((l) => l.id === 'ubo-privacy')?.updating).toBe(true)
    await service.whenSettled()
    expect(h.fetched).toEqual([DEFAULT_FILTER_LISTS.find((d) => d.id === 'ubo-privacy')?.url])
    const status = service.status().lists.find((l) => l.id === 'ubo-privacy')
    expect(status).toMatchObject({
      enabled: true,
      updating: false,
      version: '7',
      filterCount: 1,
      lastError: null,
      bundled: false
    })
    expect(status?.updatedAt).toBeGreaterThan(0)
    expect(service.store.readFilterText('ubo-privacy')).toBe('||fingerprint.example^')
  })
})

describe('BlockingService site exceptions and user filters', () => {
  it('expresses site exceptions as an allowAllRequests set and normalises the input', () => {
    const h = harness()
    const service = start(h)
    service.engine.setRuleSet({
      id: 'ads',
      source: 'dnr',
      priority: 1,
      enabled: true,
      rules: [{ id: 1, action: { type: 'block' }, condition: { urlFilter: '||ads.example^' } }]
    })
    const onTrusted = req('https://ads.example/x.js', {
      documentUrl: 'https://www.trusted.example/page'
    })
    expect(service.engine.decide(onTrusted).action).toBe('block')

    service.setSiteException('https://www.trusted.example/some/page?x', true)
    // Stored as the origin's `ads` decision, where the site-information sheet finds it.
    expect(h.permissions.listForOrigin('https://www.trusted.example')).toEqual([
      { permission: 'ads', decision: 'allow' }
    ])
    expect(service.siteExceptions()).toEqual(['https://www.trusted.example'])
    expect(service.status().siteExceptions).toEqual(['https://www.trusted.example'])
    expect(h.commits.volatile).toBeGreaterThan(0)
    expect(service.engine.decide(onTrusted)).toMatchObject({
      action: 'allow',
      matched: { setId: BUILTIN_RULE_SETS.siteExceptions }
    })
    expect(
      service.engine.decide(
        req('https://ads.example/x.js', { documentUrl: 'https://other.example/' })
      ).action
    ).toBe('block')
    // Exceptions are per origin: another host, scheme or port of the site is not covered.
    for (const other of [
      'https://trusted.example/',
      'https://www.trusted.example.evil/',
      'http://www.trusted.example/',
      'https://www.trusted.example:8443/'
    ]) {
      expect(service.isExcepted(other)).toBe(false)
      expect(
        service.engine.decide(req('https://ads.example/x.js', { documentUrl: other })).action
      ).toBe('block')
    }
    expect(service.isExcepted('https://www.trusted.example/other?y')).toBe(true)
    expect(service.siteFor('https://www.trusted.example/x')).toBe('https://www.trusted.example')
    expect(service.siteFor('zen://blank')).toBeNull()
    expect(service.siteFor('about:blank')).toBeNull()

    service.setSiteException('WWW.TRUSTED.example', true)
    expect(service.siteExceptions()).toEqual(['https://www.trusted.example'])
    service.setSiteException('nope', false)
    service.setSiteException('', true)
    expect(service.siteExceptions()).toEqual(['https://www.trusted.example'])
    // The sheet's "reset" reaches the engine through the store's notification.
    h.permissions.resetOrigin('https://www.trusted.example')
    expect(service.siteExceptions()).toEqual([])
    expect(service.engine.decide(onTrusted).action).toBe('block')
    expect(service.engine.summary(BUILTIN_RULE_SETS.siteExceptions)?.enabled).toBe(false)
    service.setSiteException('https://a.example', true)
    service.setSiteException('https://a.example', false)
    expect(h.permissions.listForPermission('ads')).toEqual([])
    expect(siteExceptionRule('https://a.example', 2)).toEqual({
      id: 3,
      action: { type: 'allowAllRequests' },
      condition: { urlFilter: '|https://a.example/', resourceTypes: ['main_frame', 'sub_frame'] }
    })
  })

  it('keeps the user filters in their own set and reports syntax errors', () => {
    const h = harness()
    const service = start(h)
    expect(service.engine.has(USER_RULE_SET_ID)).toBe(false)
    h.settings.blocking = {
      ...h.settings.blocking,
      userFilters: '! mine\n||mine.example^\n||broken.example^$bogus\n'
    }
    service.onSettingsChanged()
    expect(service.engine.summary(USER_RULE_SET_ID)).toMatchObject({
      source: 'user',
      priority: 10,
      filterCount: 2,
      hasFilterText: true
    })
    expect(service.store.readFilterText(USER_RULE_SET_ID)).toBe(
      '||mine.example^\n||broken.example^$bogus'
    )
    expect(service.status().userFilterErrors).toEqual([
      { line: 3, message: 'Unknown option "bogus"' }
    ])
    h.settings.blocking = { ...h.settings.blocking, userFilters: '   ' }
    service.onSettingsChanged()
    expect(service.engine.has(USER_RULE_SET_ID)).toBe(false)
    expect(service.status().userFilterErrors).toEqual([])
  })
})

describe('BlockingService connectivity probes', () => {
  /**
   * The fixtures the Kotlin engine's test reads, in the store's own layout: the set's summary
   * (an `index.json` entry) and, under `sets/`, its document, exactly as the store writes them.
   */
  const fixtures = new URL('../../../../android/app/src/test/resources/blocking/', import.meta.url)
  const fixture = new URL('connectivity-probes.json', fixtures)

  /**
   * Stands in for the lists: EasyPrivacy's `/generate_204?$image` heuristic plus a tracker on
   * the sign-in host, matched the way the text matcher answers.
   */
  function listsMatcher(): { calls: string[]; match: (ctx: RequestContext) => TextMatch | null } {
    const calls: string[] = []
    return {
      calls,
      match: (ctx) => {
        calls.push(ctx.url)
        if (ctx.type === 'image' && /\/generate_204\?/.test(ctx.url))
          return { action: 'block', filter: '/generate_204?$image' }
        if (/^https:\/\/accounts\.google\.com\/tracker\.gif/.test(ctx.url))
          return { action: 'block', filter: '||accounts.google.com/tracker.gif' }
        return null
      }
    }
  }

  const signIn =
    'https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com'

  it('allows a sign-in page’s generate_204 above the lists while a tracker on the host stays blocked', () => {
    const h = harness()
    const service = start(h)
    expect(service.engine.summary(BUILTIN_RULE_SETS.connectivityProbes)).toMatchObject({
      source: 'builtin',
      priority: RULE_SET_PRIORITY.connectivityProbes,
      enabled: true,
      ruleCount: CONNECTIVITY_PROBES.length,
      hasFilterText: false
    })
    expect(RULE_SET_PRIORITY.connectivityProbes).toBeGreaterThan(RULE_SET_PRIORITY.filterList)
    expect(RULE_SET_PRIORITY.connectivityProbes).toBeLessThan(RULE_SET_PRIORITY.user)

    const lists = listsMatcher()
    service.engine.setTextMatcher(lists)
    const probe = req('https://accounts.google.com/generate_204?ZxpZxpZx', {
      type: 'image',
      documentUrl: signIn,
      initiator: 'https://accounts.google.com'
    })
    expect(service.engine.decide(probe)).toEqual({
      action: 'allow',
      matched: { setId: BUILTIN_RULE_SETS.connectivityProbes, ruleId: 1 }
    })
    // The structured allow settles it above the lists' band: the matcher is not even asked.
    expect(lists.calls).toEqual([])
    expect(
      service.engine.decide(
        req('https://accounts.google.com/tracker.gif?u=1', { type: 'image', documentUrl: signIn })
      )
    ).toMatchObject({ action: 'block', matched: { setId: TEXT_MATCH_SET_ID } })
    // Only the probe path is excepted: the heuristic still blocks it elsewhere on the host, and
    // a longer path is nobody's business (the default allow, no rule named).
    expect(
      service.engine.decide(
        req('https://accounts.google.com/x/generate_204?p', { type: 'image', documentUrl: signIn })
      ).action
    ).toBe('block')
    expect(
      service.engine.decide(
        req('https://accounts.google.com/generate_204x?p', { type: 'image', documentUrl: signIn })
      )
    ).toEqual({ action: 'allow' })

    // Every probe, with or without a query, as the probe request Chrome sends and as an image.
    for (const [index, path] of CONNECTIVITY_PROBES.entries()) {
      for (const url of [`https://${path}`, `http://${path}?${index}`, `https://${path}?a=1&b=2`]) {
        for (const type of ['image', 'main_frame', 'xmlhttprequest', 'other'] as const) {
          const decision = service.engine.decide(
            req(url, type === 'main_frame' ? { type } : { type, documentUrl: signIn })
          )
          expect(decision, `${type} ${url}`).toEqual({
            action: 'allow',
            matched: { setId: BUILTIN_RULE_SETS.connectivityProbes, ruleId: index + 1 }
          })
        }
      }
    }
    // Subdomains of a probe host are covered (`||`), unrelated hosts are not.
    expect(
      service.engine.decide(req('https://www.accounts.google.com/generate_204', { type: 'image' }))
        .matched?.setId
    ).toBe(BUILTIN_RULE_SETS.connectivityProbes)
    expect(
      service.engine.decide(
        req('https://evil.example/generate_204?x', { type: 'image', documentUrl: signIn })
      ).action
    ).toBe('block')
  })

  it('is written to the shared store as the Kotlin engine reads it, and is not a user list', async () => {
    const h = harness()
    const service = start(h)
    await service.store.flush()
    const index = JSON.parse(h.io.files.get('blocking/index.json') ?? 'null') as IndexFile
    const entry = index.sets.find((s) => s.id === BUILTIN_RULE_SETS.connectivityProbes)
    expect(entry).toEqual(JSON.parse(readFileSync(fixture, 'utf8')))
    expect(entry?.document).toMatch(/^sets\/builtin_connectivity-probes-[0-9a-f]{8}\.json$/)
    const written = h.io.files.get(`blocking/${entry?.document}`) ?? ''
    expect(tagOf(written)).toBe(entry?.tag)
    const document = JSON.parse(written) as SetDocument
    expect(document).toEqual(
      JSON.parse(readFileSync(new URL(entry?.document ?? '', fixtures), 'utf8'))
    )
    expect(document.rules).toEqual(connectivityProbesRuleSet().rules)
    expect(entry?.ruleCount).toBe(connectivityProbesRuleSet().rules?.length)

    // Whatever the level or the master switch, the probes are allowed.
    h.settings.blocking = { ...h.settings.blocking, level: 'off' }
    service.onSettingsChanged()
    expect(service.engine.summary(BUILTIN_RULE_SETS.connectivityProbes)?.enabled).toBe(true)
    service.setEnabled(false)
    expect(service.engine.summary(BUILTIN_RULE_SETS.connectivityProbes)?.enabled).toBe(true)

    // Settings lists the filter lists only.
    const status = service.status()
    expect(status.lists.map((l) => l.id)).not.toContain(BUILTIN_RULE_SETS.connectivityProbes)
    expect(JSON.stringify(status)).not.toContain('connectivity')

    // A second start finds the set on disk and keeps exactly one copy of it.
    service.stop()
    const service2 = start(harness({ io: h.io }))
    expect(
      service2.engine.listRuleSets().filter((s) => s.id === BUILTIN_RULE_SETS.connectivityProbes)
    ).toHaveLength(1)
    expect(service2.engine.summary(BUILTIN_RULE_SETS.connectivityProbes)?.ruleCount).toBe(
      CONNECTIVITY_PROBES.length
    )
  })
})

describe('BlockingService custom lists and updates', () => {
  it('adds, fetches, renames and removes custom lists', async () => {
    const h = harness()
    const service = start(h)
    const url = 'https://lists.example/my.txt'
    const id = customListId(url)
    h.respond = (u) =>
      u === url
        ? {
            ok: true,
            status: 200,
            text: '[Adblock Plus 2.0]\n! Title: My List\n! Homepage: https://lists.example/\n0.0.0.0 bad.example\n||worse.example^\n'
          }
        : { ok: false, status: 404, text: '' }
    h.settings.blocking = {
      ...h.settings.blocking,
      customLists: [{ id, url, name: url, enabled: true }]
    }
    service.onSettingsChanged()
    expect(service.engine.summary(id)).toMatchObject({
      source: 'filter-list',
      enabled: true,
      hasFilterText: false
    })
    await service.whenSettled()
    expect(h.fetched).toEqual([url])
    expect(service.engine.summary(id)).toMatchObject({
      filterCount: 2,
      hasFilterText: true,
      attribution: { name: 'My List', url: 'https://lists.example/' }
    })
    expect(h.settings.blocking.customLists[0].name).toBe('My List')
    const status = service.status().lists.find((l) => l.id === id)
    expect(status).toMatchObject({
      name: 'My List',
      tier: null,
      enabled: true,
      filterCount: 2,
      description: url
    })
    expect(service.store.readFilterText(id)).toBe('||bad.example^\n||worse.example^')

    h.settings.blocking = { ...h.settings.blocking, customLists: [] }
    service.onSettingsChanged()
    expect(service.engine.has(id)).toBe(false)
    await service.whenSettled()
    expect(h.io.files.has(`blocking/${id}.json`)).toBe(false)
    expect(
      (JSON.parse(h.io.files.get('blocking/index.json') ?? 'null') as IndexFile).sets.map(
        (s) => s.id
      )
    ).not.toContain(id)
  })

  it('reports failed downloads and content that is not a filter list', async () => {
    const h = harness()
    const service = start(h)
    h.respond = (u) =>
      u.includes('easylist.txt')
        ? { ok: true, status: 200, text: '<!doctype html><html>not a list</html>' }
        : u.includes('easyprivacy')
          ? { ok: true, status: 200, text: '||tracker.example^\n' }
          : { ok: false, status: 503, text: '' }
    await service.updateLists('easylist')
    expect(service.status().lists.find((l) => l.id === 'easylist')).toMatchObject({
      lastError: 'the download is not a filter list',
      updating: false,
      filterCount: 0
    })
    expect(h.toasts).toEqual([
      'error:Zenium could not update the filter lists. Check your connection and try again.'
    ])

    h.toasts.length = 0
    await service.updateLists()
    expect(h.fetched.length).toBe(1 + 6)
    expect(service.status().lists.find((l) => l.id === 'peter-lowe')?.lastError).toBe(
      'the server answered 503'
    )
    expect(service.status().lists.find((l) => l.id === 'easyprivacy')).toMatchObject({
      lastError: null,
      filterCount: 1
    })
    expect(h.toasts).toEqual(['error:5 of 6 filter lists could not be updated.'])

    h.toasts.length = 0
    await service.updateLists('easyprivacy')
    expect(h.toasts).toEqual(['info:EasyPrivacy is up to date.'])
    expect(service.status().lastUpdatedAt).toBeGreaterThan(0)
    await service.updateLists('unknown-list')
    expect(h.toasts.length).toBe(1)
  })
})

describe('BlockingService bundled snapshot', () => {
  /** A host that, like the real ones, writes the snapshot document straight to the profile. */
  function host(
    io: StoreIO & { files: Map<string, string> },
    lists: BundledFilterList[]
  ): BlockingHost & { installed: Array<{ set: RuleSet; file: string }> } {
    const installed: Array<{ set: RuleSet; file: string }> = []
    return {
      installed,
      bundledLists: async () => lists,
      installBundled: async (set, file) => {
        const info = lists.find((l) => l.id === set.id)
        if (!info) return null
        installed.push({ set, file })
        io.files.set(file, JSON.stringify({ ...set, filterText: `||${set.id}.example^` }))
        return info
      }
    }
  }

  it('installs the snapshot on first run and skips lists with a fresher copy', async () => {
    const io = memoryIo()
    const snapshot = host(io, [
      { id: 'easylist', version: 'snap', builtAt: 5_000, filterCount: 40_000 },
      { id: 'urlhaus', version: null, builtAt: 5_000, filterCount: 900 },
      { id: 'not-a-default', version: null, builtAt: 5_000, filterCount: 1 }
    ])
    const h = harness({ io, host: snapshot })
    const service = start(h)
    await service.whenSettled()
    expect(
      snapshot.installed.map((i) => [i.set.id, i.file, i.set.updatedAt, i.set.version])
    ).toEqual([
      ['easylist', 'blocking/easylist.json', 5_000, 'snap'],
      ['urlhaus', 'blocking/urlhaus.json', 5_000, undefined]
    ])
    expect(snapshot.installed[0].set.attribution?.name).toBe('EasyList')
    expect(service.engine.summary('easylist')).toMatchObject({
      hasFilterText: true,
      filterCount: 40_000,
      updatedAt: 5_000,
      version: 'snap'
    })
    const status = service.status()
    expect(status.lists.find((l) => l.id === 'easylist')).toMatchObject({
      bundled: true,
      updatedAt: 5_000,
      filterCount: 40_000
    })
    expect(status.lastUpdatedAt).toBeNull()

    // A second start finds the snapshot persisted and does not install it again.
    service.stop()
    const again = host(io, [
      { id: 'easylist', version: 'snap', builtAt: 5_000, filterCount: 40_000 }
    ])
    const h2 = harness({ io, host: again })
    const service2 = start(h2)
    await service2.whenSettled()
    expect(again.installed).toEqual([])
    expect(service2.engine.summary('easylist')).toMatchObject({
      hasFilterText: true,
      filterCount: 40_000
    })

    // A newer build's snapshot replaces the old one; a downloaded copy that is newer stays.
    service2.stop()
    const newer = host(io, [
      { id: 'easylist', version: 'snap2', builtAt: 9_000, filterCount: 41_000 },
      { id: 'urlhaus', version: null, builtAt: 9_000, filterCount: 950 }
    ])
    const h3 = harness({ io, host: newer })
    const service3 = start(h3)
    service3.engine.setRuleSet({
      id: 'urlhaus',
      source: 'filter-list',
      priority: 1,
      enabled: true,
      filterText: '||x^',
      updatedAt: 10_000
    })
    await service3.whenSettled()
    expect(newer.installed.map((i) => i.set.id)).toEqual(['easylist'])
    expect(service3.engine.summary('easylist')?.filterCount).toBe(41_000)
    expect(service3.engine.summary('urlhaus')?.updatedAt).toBe(10_000)
  })

  it('survives a host without a snapshot or a failing one', async () => {
    const h = harness({
      host: {
        bundledLists: async () => {
          throw new Error('no manifest')
        },
        installBundled: async () => null
      }
    })
    const service = start(h)
    await service.whenSettled()
    expect(service.status().lists.every((l) => !l.bundled)).toBe(true)
    const plain = start(harness())
    await plain.whenSettled()
    expect(plain.status().ready).toBe(true)
  })
})

describe('BlockingService owner reconciliation', () => {
  const ALIVE = 'abcdefghijklmnopabcdefghijklmnop'
  const GONE = 'ponmlkjihgfedcbaponmlkjihgfedcba'
  const blocks = (id: string, host: string, extra: Partial<RuleSet> = {}): RuleSet => ({
    id,
    source: 'dnr',
    priority: RULE_SET_PRIORITY.dnr + 5,
    enabled: true,
    rules: [{ id: 1, action: { type: 'block' }, condition: { urlFilter: `||${host}^` } }],
    ...extra
  })
  const indexIds = (h: Harness): string[] =>
    (JSON.parse(h.io.files.get('blocking/index.json') ?? 'null') as IndexFile).sets.map((s) => s.id)

  it('drops the persisted sets of extensions that are gone at start and keeps the rest', async () => {
    // Run one: two extensions' sets reach the engine under the sink's ids and are persisted.
    const h = harness()
    const service = start(h)
    const kept = engineSetId(ALIVE, { kind: 'static', rulesetId: 'ads' })
    const keptDynamic = engineSetId(ALIVE, { kind: 'dynamic' })
    const gone = engineSetId(GONE, { kind: 'static', rulesetId: 'ads' })
    const goneSession = engineSetId(GONE, { kind: 'session' })
    service.engine.setRuleSet(blocks(kept, 'kept.example', { partitions: ['default'] }))
    service.engine.setRuleSet(blocks(keptDynamic, 'kept-dynamic.example'))
    service.engine.setRuleSet(blocks(gone, 'gone.example'))
    service.engine.setRuleSet(blocks(goneSession, 'gone-session.example', { enabled: false }))
    // A `dnr` set no extension can claim (not an `ext:` id): nobody could ever remove it.
    service.engine.setRuleSet(blocks('orphan', 'orphan.example'))
    await service.whenSettled()
    service.stop()

    // Run two: the engine loads what the index holds and the stale sets filter until the
    // extension layer says which extensions are enabled.
    const h2 = harness({ io: h.io })
    const service2 = start(h2)
    for (const id of [kept, keptDynamic, gone, goneSession, 'orphan'])
      expect(service2.engine.has(id), id).toBe(true)
    expect(service2.engine.decide(req('https://gone.example/a.js')).action).toBe('block')

    const dropped = service2.reconcileOwners(DNR_OWNERSHIP, [ALIVE, 'someone-else'])
    expect([...dropped].sort()).toEqual([gone, goneSession, 'orphan'].sort())
    for (const id of dropped) expect(service2.engine.has(id), id).toBe(false)
    expect(service2.engine.decide(req('https://gone.example/a.js'))).toEqual({ action: 'allow' })
    // The alive extension's sets are untouched, scope included; its layer replaces them as it loads.
    expect(service2.engine.summary(kept)).toMatchObject({ enabled: true, partitions: ['default'] })
    const inDefault = req('https://kept.example/a.js', { partition: 'default' })
    expect(service2.engine.decide(inDefault).matched?.setId).toBe(kept)
    expect(service2.engine.decide(req('https://kept.example/a.js', { partition: 'work' }))).toEqual(
      {
        action: 'allow'
      }
    )
    expect(service2.engine.has(keptDynamic)).toBe(true)
    // Zenium's own sets are not the layer's to reconcile.
    expect(enabledIds(service2).length).toBeGreaterThan(0)
    expect(service2.engine.has(BUILTIN_RULE_SETS.connectivityProbes)).toBe(true)
    expect(service2.engine.has(BUILTIN_RULE_SETS.globalOff)).toBe(true)
    // Nothing more goes on a second call, whatever holds the ids.
    expect(service2.reconcileOwners(DNR_OWNERSHIP, new Set([ALIVE]))).toEqual([])

    // The index follows, as for any removal (the Kotlin engine rebuilds from it).
    await service2.whenSettled()
    const ids = indexIds(h)
    expect(ids).toContain(kept)
    expect(ids).toContain(keptDynamic)
    for (const id of dropped) expect(ids).not.toContain(id)
    service2.stop()
    const service3 = start(harness({ io: h.io }))
    expect(service3.engine.has(kept)).toBe(true)
    expect(service3.engine.has(gone)).toBe(false)
  })

  it('reads the owner of an ext: set from its id and looks at the ownership’s source only', () => {
    expect(DNR_OWNERSHIP.source).toBe('dnr')
    for (const kind of [
      { kind: 'static', rulesetId: 'ruleset_1' },
      { kind: 'dynamic' },
      { kind: 'session' }
    ] as const)
      expect(DNR_OWNERSHIP.ownerOf(engineSetId(ALIVE, kind))).toBe(ALIVE)
    for (const stranger of ['easylist', 'ext:', `ext:${ALIVE}`, `ext:${ALIVE}:static:`, 'orphan'])
      expect(DNR_OWNERSHIP.ownerOf(stranger), stranger).toBeUndefined()

    const h = harness()
    const service = start(h)
    const set = engineSetId(GONE, { kind: 'dynamic' })
    service.engine.setRuleSet(blocks(set, 'x.example'))
    // An ownership over another source: the extension's set is none of its business.
    const users: RuleSetOwnership = { source: 'user', ownerOf: () => 'me' }
    expect(service.reconcileOwners(users, [])).toEqual([])
    expect(service.engine.has(set)).toBe(true)
    expect(service.reconcileOwners(DNR_OWNERSHIP, [])).toEqual([set])
  })
})

describe('BlockingService.whenSettled', () => {
  /** A `StoreIO` whose asynchronous writes and removals land only once released. */
  function gatedIo(): StoreIO & { files: Map<string, string>; release: () => void } {
    const io = memoryIo()
    const gates: Array<() => void> = []
    const gate = (): Promise<void> => new Promise((resolve) => gates.push(resolve))
    return {
      ...io,
      write: async (name, text) => {
        await gate()
        io.files.set(name, text)
      },
      remove: async (name) => {
        await gate()
        io.files.delete(name)
      },
      release: () => {
        for (const open of gates.splice(0)) open()
      }
    }
  }
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1))

  it('resolves at once when nothing is in flight, else once the fetch and its writes have landed', async () => {
    const io = gatedIo()
    const h = harness({ io })
    const service = start(h)
    // Nothing queued and no snapshot host: the seeding is over before anyone asks.
    let settled = false
    void service.whenSettled().then(() => {
      settled = true
    })
    // `start()` has the connectivity probes' document and then the index to write, gated: not
    // settled until both landed, the document first (the index's write waits for it).
    await tick()
    expect(settled).toBe(false)
    io.release()
    await tick()
    const probes = `blocking/${documentNameFor(BUILTIN_RULE_SETS.connectivityProbes)}`
    expect(io.files.has(probes)).toBe(true)
    expect(io.files.has('blocking/index.json')).toBe(false)
    expect(settled).toBe(false)
    io.release()
    await tick()
    expect(settled).toBe(true)
    expect(io.files.has('blocking/index.json')).toBe(true)
    await service.whenSettled()

    // A level change queues a fetch: the fetch, the text file and the index all come first.
    let answer: (result: FetchResult) => void = () => undefined
    h.respond = () => new Promise<FetchResult>((resolve) => (answer = resolve))
    h.settings.blocking = { ...h.settings.blocking, level: 'strict' }
    service.onSettingsChanged()
    settled = false
    const wait = service.whenSettled().then(() => {
      settled = true
    })
    await tick()
    expect(h.fetched).toHaveLength(1)
    expect(settled).toBe(false)
    answer({ ok: true, status: 200, text: '||fingerprint.example^\n' })
    await tick()
    // Fetched and in the engine, but nothing has reached the disk yet.
    expect(service.engine.summary('ubo-privacy')?.hasFilterText).toBe(true)
    expect(io.files.has('blocking/ubo-privacy.json')).toBe(false)
    expect(settled).toBe(false)
    io.release()
    await tick()
    // The text file has landed; the index that names it follows, and only then is it settled.
    expect(io.files.has('blocking/ubo-privacy.json')).toBe(true)
    expect(settled).toBe(false)
    io.release()
    await wait
    const index = JSON.parse(io.files.get('blocking/index.json') ?? 'null') as IndexFile
    expect(index.sets.find((s) => s.id === 'ubo-privacy')).toMatchObject({
      hasFilterText: true,
      filterCount: 1,
      file: 'ubo-privacy.json'
    })
    expect(service.status().lists.find((l) => l.id === 'ubo-privacy')?.updating).toBe(false)
  })
})

describe('BlockingService counters', () => {
  it('counts per tab and per session, resets on navigation and commits at most once per burst', async () => {
    const h = harness()
    const service = start(h)
    h.tabs.set('tab-1', { id: 'tab-1', blockedCount: 0 } as Tab)
    const before = h.commits.volatile
    service.recordBlocked('tab-1')
    service.recordBlocked('tab-1', 2)
    service.recordBlocked('tab-missing')
    service.recordBlocked(undefined, 5)
    service.recordBlocked('tab-1', 0)
    expect(h.tabs.get('tab-1')?.blockedCount).toBe(3)
    expect(service.status().sessionBlocked).toBe(9)
    expect(h.commits.volatile).toBe(before)
    await new Promise((r) => setTimeout(r, 250))
    expect(h.commits.volatile).toBe(before + 1)
    service.onNavigated('tab-1')
    expect(h.tabs.get('tab-1')?.blockedCount).toBe(0)
    expect(service.status().sessionBlocked).toBe(9)
    service.onNavigated('tab-missing')
  })
})
