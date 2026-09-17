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
import type { BlockingHost, BundledFilterList, DialogHost, StoreIO } from '../../platform'
import { BlockingService, siteExceptionRule } from '../service'
import { BUILTIN_RULE_SETS, USER_RULE_SET_ID, type RequestContext, type RuleSet } from '../rules'
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
    confirm: async () => false
  } as unknown as DialogHost)
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

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
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
    await settle()
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
    await settle()
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
    await service.store.flush()
    expect(h.io.files.has(`blocking/${id}.json`)).toBe(false)
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
    await settle()
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
    await service.store.flush()

    // A second start finds the snapshot persisted and does not install it again.
    service.stop()
    const again = host(io, [
      { id: 'easylist', version: 'snap', builtAt: 5_000, filterCount: 40_000 }
    ])
    const h2 = harness({ io, host: again })
    const service2 = start(h2)
    await settle()
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
    await settle()
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
    await settle()
    expect(service.status().lists.every((l) => !l.bundled)).toBe(true)
    const plain = start(harness())
    await settle()
    expect(plain.status().ready).toBe(true)
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
