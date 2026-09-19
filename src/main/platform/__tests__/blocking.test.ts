import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuleEngine, TEXT_MATCH_SET_ID } from '../../../core/blocking/engine'
import type { Decision, RequestContext, RuleSet } from '../../../core/blocking/rules'
import { RuleSetStore } from '../../../core/blocking/store'
import type { StoreIO } from '../../../core/platform'
import type { DecisionStage } from '../blocking'
import type { HostRequest } from '../webRequest'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', getAppPath: () => '/nowhere', isPackaged: false }
}))

const { BlockingHandler, ElectronBundledLists, GhosteryTextMatcher } = await import('../blocking')

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zenium-blocking-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function memoryIo(): StoreIO & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    readSync: (name) => files.get(name) ?? null,
    write: async (name, text) => {
      files.set(name, text)
    },
    writeSync: (name, text) => {
      files.set(name, text)
    },
    exists: (name) => files.has(name),
    remove: async (name) => {
      files.delete(name)
    }
  }
}

const ctx = (url: string, extra: Partial<RequestContext> = {}): RequestContext => ({
  url,
  type: 'script',
  method: 'GET',
  ...extra
})

function hostRequest(c: RequestContext, tabId: string | null = 'tab-1'): HostRequest {
  return {
    ctx: c,
    containerId: 'default',
    tabId: tabId ?? undefined,
    base: {
      requestId: '1',
      url: c.url,
      method: c.method,
      resourceType: c.type,
      frameId: 0,
      parentFrameId: -1,
      tabId,
      partition: 'default',
      initiator: null,
      documentUrl: c.documentUrl ?? null,
      timestamp: 0
    },
    state: new Map()
  }
}

describe('BlockingHandler', () => {
  function handler(
    decide: (c: RequestContext) => Decision,
    csp: string | null = null,
    observer:
      ((request: HostRequest, decision: Decision, stage: DecisionStage) => void) | null = null
  ): {
    handler: InstanceType<typeof BlockingHandler>
    blocked: Array<string | undefined>
  } {
    const blocked: Array<string | undefined> = []
    const h = new BlockingHandler(
      {
        decide,
        recordBlocked: (tabId, count = 1) =>
          blocked.push(...Array<string | undefined>(count).fill(tabId))
      },
      { cspDirectives: () => csp },
      observer
    )
    return { handler: h, blocked }
  }

  it('cancels blocked requests and counts them against the tab', () => {
    const { handler: h, blocked } = handler(() => ({
      action: 'block',
      matched: { setId: 'easylist' }
    }))
    expect(h.onBeforeRequest(hostRequest(ctx('https://ads.example/x.js')))).toEqual({
      cancel: true
    })
    expect(h.onBeforeRequest(hostRequest(ctx('wss://ads.example/socket'), null))).toEqual({
      cancel: true
    })
    expect(blocked).toEqual(['tab-1', undefined])
    // Non-web schemes never reach the engine.
    expect(h.onBeforeRequest(hostRequest(ctx('zen://blank')))).toBeUndefined()
    expect(h.onBeforeRequest(hostRequest(ctx('chrome-extension://abc/x.js')))).toBeUndefined()
    expect(h.onBeforeRequest(hostRequest(ctx('data:text/plain,x')))).toBeUndefined()
    expect(blocked.length).toBe(2)
  })

  it('redirects, counting list redirects but not translator redirects or upgrades', () => {
    const answers: Record<string, Decision> = {
      'https://a.example/list.js': {
        action: 'redirect',
        redirectUrl: 'data:text/javascript,',
        matched: { setId: TEXT_MATCH_SET_ID }
      },
      'https://a.example/dnr.js': {
        action: 'redirect',
        redirectUrl: 'https://b.example/dnr.js',
        matched: { setId: 'ext' }
      },
      'http://a.example/up.js': {
        action: 'upgrade',
        redirectUrl: 'https://a.example/up.js',
        matched: { setId: 'ext' }
      },
      'https://a.example/same.js': {
        action: 'redirect',
        redirectUrl: 'https://a.example/same.js',
        matched: { setId: 'ext' }
      }
    }
    const { handler: h, blocked } = handler((c) => answers[c.url] ?? { action: 'allow' })
    expect(h.onBeforeRequest(hostRequest(ctx('https://a.example/list.js')))).toEqual({
      redirectURL: 'data:text/javascript,'
    })
    expect(h.onBeforeRequest(hostRequest(ctx('https://a.example/dnr.js')))).toEqual({
      redirectURL: 'https://b.example/dnr.js'
    })
    expect(h.onBeforeRequest(hostRequest(ctx('http://a.example/up.js')))).toEqual({
      redirectURL: 'https://a.example/up.js'
    })
    expect(h.onBeforeRequest(hostRequest(ctx('https://a.example/same.js')))).toBeUndefined()
    expect(h.onBeforeRequest(hostRequest(ctx('https://a.example/fine.js')))).toBeUndefined()
    expect(blocked).toEqual(['tab-1'])
  })

  it('carries header edits from onBeforeRequest into the header phases and injects $csp', () => {
    const { handler: h } = handler(
      (c) =>
        c.url.includes('headers')
          ? {
              action: 'modifyHeaders',
              requestHeaders: [{ header: 'Sec-GPC', operation: 'set', value: '1' }],
              responseHeaders: [{ header: 'Set-Cookie', operation: 'remove' }],
              matched: { setId: 'ext', ruleId: 1 }
            }
          : { action: 'allow' },
      "script-src 'none'"
    )
    const request = hostRequest(ctx('https://a.example/headers', { type: 'main_frame' }))
    expect(h.onBeforeRequest(request)).toBeUndefined()
    const requestHeaders: Record<string, string> = { Accept: '*/*' }
    h.onBeforeSendHeaders(request, requestHeaders)
    expect(requestHeaders).toEqual({ Accept: '*/*', 'Sec-GPC': '1' })
    const responseHeaders: Record<string, string[]> = {
      'set-cookie': ['a=1'],
      'content-security-policy': ['default-src https:']
    }
    h.onHeadersReceived(request, responseHeaders)
    expect(responseHeaders).toEqual({
      'content-security-policy': ['default-src https:', "script-src 'none'"]
    })

    // Plain sub-resources get neither header edits nor CSP.
    const plain = hostRequest(ctx('https://a.example/plain.js'))
    h.onBeforeRequest(plain)
    const untouched: Record<string, string[]> = { 'x-a': ['1'] }
    h.onHeadersReceived(plain, untouched)
    expect(untouched).toEqual({ 'x-a': ['1'] })
  })

  it('asks the engine again at headers-received when a header-conditioned rule may apply', () => {
    // A decider shaped like the engine: at the request stage it only notes the header rule; with
    // the headers in it redirects `.user.css` served as CSS, blocks `x-ads`, edits `x-frame`.
    const asked: RequestContext[] = []
    const { handler: h, blocked } = handler((c) => {
      asked.push(c)
      const wants = /user\.css|ads|frame/.test(c.url)
      if (!c.responseHeaders) {
        const edits: Decision = c.url.includes('frame')
          ? {
              action: 'modifyHeaders',
              responseHeaders: [{ header: 'X-Early', operation: 'set', value: '1' }],
              matched: { setId: 'ext', ruleId: 1 }
            }
          : { action: 'allow' }
        return wants ? { ...edits, needsHeaders: true } : edits
      }
      const type = c.responseHeaders['content-type']?.[0] ?? ''
      if (c.url.includes('user.css') && type.startsWith('text/css'))
        return {
          action: 'redirect',
          redirectUrl: `chrome-extension://stylus/install-usercss.html#${c.url}`,
          matched: { setId: 'ext', ruleId: 2 }
        }
      if (c.url.includes('ads') && c.responseHeaders['x-ads'])
        return { action: 'block', matched: { setId: 'ext', ruleId: 3 } }
      if (c.url.includes('frame'))
        return {
          action: 'modifyHeaders',
          responseHeaders: [
            { header: 'X-Early', operation: 'set', value: '1' },
            ...(c.responseHeaders['x-frame-options']
              ? [{ header: 'X-Frame-Options', operation: 'remove' as const }]
              : [])
          ],
          matched: { setId: 'ext', ruleId: 1 }
        }
      return { action: 'allow' }
    })

    // Redirect once the content type says CSS; a plain HTML answer passes untouched.
    const css = hostRequest(ctx('https://a.example/theme.user.css', { type: 'main_frame' }))
    expect(h.onBeforeRequest(css)).toBeUndefined()
    const cssHeaders = { 'content-type': ['text/css'] }
    expect(h.onHeadersReceived(css, cssHeaders)).toEqual({
      redirectURL: 'chrome-extension://stylus/install-usercss.html#https://a.example/theme.user.css'
    })
    expect(asked.at(-1)?.responseHeaders).toBe(cssHeaders)
    const html = hostRequest(ctx('https://a.example/page.user.css', { type: 'main_frame' }))
    h.onBeforeRequest(html)
    expect(h.onHeadersReceived(html, { 'content-type': ['text/html'] })).toBeUndefined()

    // Block once the marker header shows up, counted against the tab.
    const ads = hostRequest(ctx('https://a.example/ads.js'))
    expect(h.onBeforeRequest(ads)).toBeUndefined()
    expect(h.onHeadersReceived(ads, { 'x-ads': ['1'] })).toEqual({ cancel: true })
    expect(blocked).toEqual(['tab-1'])

    // Header edits: the second decision's edits replace the first's (they contain them).
    const frame = hostRequest(ctx('https://a.example/frame', { type: 'main_frame' }))
    h.onBeforeRequest(frame)
    const frameHeaders: Record<string, string[]> = { 'x-frame-options': ['DENY'] }
    expect(h.onHeadersReceived(frame, frameHeaders)).toBeUndefined()
    expect(frameHeaders).toEqual({ 'X-Early': ['1'] })
    const noFrame = hostRequest(ctx('https://a.example/frame', { type: 'main_frame' }))
    h.onBeforeRequest(noFrame)
    const plainHeaders: Record<string, string[]> = { 'x-a': ['1'] }
    h.onHeadersReceived(noFrame, plainHeaders)
    expect(plainHeaders).toEqual({ 'x-a': ['1'], 'X-Early': ['1'] })

    // A request no header rule could match is decided once.
    const before = asked.length
    const plain = hostRequest(ctx('https://a.example/plain.js'))
    h.onBeforeRequest(plain)
    h.onHeadersReceived(plain, { 'x-ads': ['1'] })
    expect(asked.length).toBe(before + 1)
  })

  it('tells the observer which stage each named decision was taken at', () => {
    // Rule 1 (request stage, modifyHeaders) also notes a header rule; rule 3 blocks at the
    // header stage on `x-ads`; rule 9 blocks at the request stage; `late` matches nothing until
    // the headers are in.
    const early: Decision = {
      action: 'modifyHeaders',
      responseHeaders: [{ header: 'X-Early', operation: 'set', value: '1' }],
      matched: { setId: 'ext', ruleId: 1 }
    }
    const seen: Array<[string, number | undefined, DecisionStage]> = []
    const { handler: h } = handler(
      (c) => {
        if (!c.responseHeaders) {
          if (c.url.includes('early')) return { ...early, needsHeaders: true }
          if (c.url.includes('late')) return { action: 'allow', needsHeaders: true }
          if (c.url.includes('blocked'))
            return { action: 'block', matched: { setId: 'ext', ruleId: 9 } }
          return { action: 'allow' }
        }
        if (c.responseHeaders['x-ads'])
          return { action: 'block', matched: { setId: 'ext', ruleId: 3 } }
        return c.url.includes('early') ? early : { action: 'allow' }
      },
      null,
      (request, decision, stage) => seen.push([request.ctx.url, decision.matched?.ruleId, stage])
    )
    const run = (url: string, headers: Record<string, string[]>): void => {
      const request = hostRequest(ctx(url))
      if (h.onBeforeRequest(request)) return
      h.onHeadersReceived(request, headers)
    }
    run('https://a.example/blocked.js', {})
    run('https://a.example/late.js', { 'x-ads': ['1'] })
    run('https://a.example/late-clean.js', {})
    run('https://a.example/early.js', {})
    run('https://a.example/early-ads.js', { 'x-ads': ['1'] })
    run('https://a.example/plain.js', { 'x-ads': ['1'] })
    expect(seen).toEqual([
      ['https://a.example/blocked.js', 9, 'request'],
      // The request stage's default allow is not reported; the header stage's block is.
      ['https://a.example/late.js', 3, 'headersReceived'],
      // The same rule at both stages is reported once.
      ['https://a.example/early.js', 1, 'request'],
      // Overturned at the header stage: both stages, in order.
      ['https://a.example/early-ads.js', 1, 'request'],
      ['https://a.example/early-ads.js', 3, 'headersReceived']
    ])
  })
})

describe('GhosteryTextMatcher', () => {
  const EXCERPT = [
    '! EasyList excerpt',
    '||doubleclick.net^',
    '||google-analytics.com/analytics.js',
    '/adframe.$script,third-party',
    '||good.example/ads/',
    '@@||good.example/ads/allowed.js$script',
    '||tracker.example^$third-party',
    '||evil.example^$redirect=noopjs,script',
    "||csp.example^$csp=script-src 'none'",
    '||phish.example^$all',
    '@@||trusted.example^$document',
    'example.com##.ad-banner',
    ''
  ].join('\n')

  function source(): { engine: RuleEngine; store: RuleSetStore; io: ReturnType<typeof memoryIo> } {
    const io = memoryIo()
    const engine = new RuleEngine()
    const store = new RuleSetStore(io)
    store.load()
    store.attach(engine)
    return { engine, store, io }
  }

  function textSet(id: string, filterText: string, enabled = true): RuleSet {
    return { id, source: 'filter-list', priority: 1, enabled, filterText, updatedAt: 1000 }
  }

  it('matches EasyList syntax, exceptions, redirects and csp for the enabled sets', () => {
    const s = source()
    const matcher = new GhosteryTextMatcher(s, join(tempDir(), 'cache'), 'test', 0)
    s.engine.setRuleSet(textSet('excerpt', EXCERPT))
    matcher.rebuild()
    expect(matcher.ready).toBe(true)
    expect(matcher.builds).toBe(1)
    expect(matcher.match(ctx('https://ad.doubleclick.net/x'))).toMatchObject({
      action: 'block',
      filter: '||doubleclick.net^'
    })
    expect(
      matcher.match(
        ctx('https://www.google-analytics.com/analytics.js', { initiator: 'https://site.example/' })
      )
    ).toMatchObject({ action: 'block' })
    expect(
      matcher.match(ctx('https://x.example/adframe.js', { initiator: 'https://site.example/' }))
    ).toMatchObject({ action: 'block' })
    expect(
      matcher.match(ctx('https://site.example/adframe.js', { initiator: 'https://site.example/' }))
    ).toBeNull()
    expect(matcher.match(ctx('https://good.example/ads/banner.js'))).toMatchObject({
      action: 'block'
    })
    expect(matcher.match(ctx('https://good.example/ads/allowed.js'))).toMatchObject({
      action: 'allow',
      filter: expect.stringContaining('@@||good.example')
    })
    expect(
      matcher.match(ctx('https://tracker.example/t', { initiator: 'https://tracker.example/' }))
    ).toBeNull()
    expect(
      matcher.match(ctx('https://tracker.example/t', { initiator: 'https://site.example/' }))
    ).toMatchObject({ action: 'block' })
    expect(matcher.match(ctx('https://evil.example/e.js'))).toMatchObject({
      action: 'redirect',
      redirectUrl: expect.stringMatching(/^data:/)
    })
    expect(matcher.match(ctx('https://clean.example/app.js'))).toBeNull()
    expect(matcher.cspDirectives(ctx('https://csp.example/', { type: 'main_frame' }))).toBe(
      "script-src 'none'"
    )
    expect(matcher.cspDirectives(ctx('https://clean.example/', { type: 'main_frame' }))).toBeNull()

    // Navigations: untyped filters never block the page itself, `$all` / `$document` ones do.
    expect(matcher.match(ctx('https://ad.doubleclick.net/', { type: 'main_frame' }))).toBeNull()
    expect(matcher.match(ctx('https://phish.example/login', { type: 'main_frame' }))).toMatchObject(
      {
        action: 'block',
        filter: '||phish.example^$all'
      }
    )
    expect(matcher.match(ctx('https://phish.example/a.js'))).toMatchObject({ action: 'block' })
    // A `$document` exception switches the lists off for everything the page loads.
    expect(
      matcher.match(
        ctx('https://ad.doubleclick.net/x', { documentUrl: 'https://trusted.example/p' })
      )
    ).toMatchObject({ action: 'allow', filter: '@@||trusted.example^$document' })
    expect(
      matcher.match(ctx('https://ad.doubleclick.net/x', { documentUrl: 'https://other.example/p' }))
    ).toMatchObject({ action: 'block' })

    // Wired into the core engine, a text match is a decision at the filter-list priority.
    s.engine.setTextMatcher(matcher)
    expect(s.engine.decide(ctx('https://ad.doubleclick.net/x'))).toMatchObject({
      action: 'block',
      matched: { setId: TEXT_MATCH_SET_ID }
    })
    s.engine.setRuleSet({
      id: 'user',
      source: 'user',
      priority: 10,
      enabled: true,
      rules: [{ id: 1, action: { type: 'allow' }, condition: { urlFilter: '||doubleclick.net^' } }]
    })
    expect(s.engine.decide(ctx('https://ad.doubleclick.net/x')).matched?.setId).toBe('user')
  })

  it('follows set changes, ignores disabled sets and reads persisted text from the store', async () => {
    const s = source()
    const matcher = new GhosteryTextMatcher(s, join(tempDir(), 'cache'), 'test', 0)
    const stop = matcher.start()
    s.engine.setRuleSet(textSet('a', '||a.example^'))
    s.engine.setRuleSet(textSet('b', '||b.example^', false))
    await new Promise((r) => setTimeout(r, 20))
    expect(matcher.ready).toBe(true)
    expect(matcher.match(ctx('https://a.example/'))).toMatchObject({ action: 'block' })
    expect(matcher.match(ctx('https://b.example/'))).toBeNull()

    s.engine.setEnabled('b', true)
    await new Promise((r) => setTimeout(r, 20))
    expect(matcher.match(ctx('https://b.example/'))).toMatchObject({ action: 'block' })

    s.engine.removeRuleSet('a')
    await new Promise((r) => setTimeout(r, 20))
    expect(matcher.match(ctx('https://a.example/'))).toBeNull()
    expect(matcher.match(ctx('https://b.example/'))).toMatchObject({ action: 'block' })

    // Structured-only changes do not trigger a build.
    const builds = matcher.builds
    s.engine.setRuleSet({ id: 'dnr', source: 'dnr', priority: 5, enabled: true, rules: [] })
    await new Promise((r) => setTimeout(r, 20))
    expect(matcher.builds).toBe(builds)
    stop()
    s.engine.setRuleSet(textSet('c', '||c.example^'))
    await new Promise((r) => setTimeout(r, 20))
    expect(matcher.builds).toBe(builds)
  })

  it('caches the serialised engine keyed by the sets fingerprint and app version', () => {
    const cacheDir = join(tempDir(), 'cache')
    const s = source()
    s.engine.setRuleSet(textSet('excerpt', EXCERPT))
    const first = new GhosteryTextMatcher(s, cacheDir, 'v1', 0)
    first.rebuild()
    expect(first.fromCache).toBe(false)
    expect(existsSync(join(cacheDir, 'engine.bin'))).toBe(true)
    expect(readFileSync(join(cacheDir, 'documents.txt'), 'utf8')).toBe(
      '||phish.example^$all\n@@||trusted.example^$document'
    )
    expect(JSON.parse(readFileSync(join(cacheDir, 'engine.json'), 'utf8'))).toEqual({
      fingerprint: 'excerpt:1000:10',
      version: 'v1'
    })

    // Same sets on the next start: deserialised, and still matching.
    const s2 = source()
    s2.engine.setRuleSet(
      { id: 'excerpt', source: 'filter-list', priority: 1, enabled: true, updatedAt: 1000 },
      { persisted: true, hasFilterText: true, filterCount: 10 }
    )
    const second = new GhosteryTextMatcher(s2, cacheDir, 'v1', 0)
    second.rebuild()
    expect(second.fromCache).toBe(true)
    expect(second.match(ctx('https://ad.doubleclick.net/x'))).toMatchObject({ action: 'block' })
    expect(second.match(ctx('https://phish.example/', { type: 'main_frame' }))).toMatchObject({
      action: 'block'
    })

    // A different app version or set fingerprint rebuilds from text.
    const third = new GhosteryTextMatcher(s, cacheDir, 'v2', 0)
    third.rebuild()
    expect(third.fromCache).toBe(false)
    s.engine.setMetadata('excerpt', { updatedAt: 2000 })
    const fourth = new GhosteryTextMatcher(s, cacheDir, 'v2', 0)
    fourth.rebuild()
    expect(fourth.fromCache).toBe(false)
    expect(fourth.match(ctx('https://ad.doubleclick.net/x'))).toMatchObject({ action: 'block' })
  })

  it('keeps the cached lists while the master switch has every list off', () => {
    const cacheDir = join(tempDir(), 'cache')
    const s = source()
    s.engine.setRuleSet(textSet('excerpt', EXCERPT))
    const matcher = new GhosteryTextMatcher(s, cacheDir, 'v1', 0)
    matcher.rebuild()
    const meta = readFileSync(join(cacheDir, 'engine.json'), 'utf8')

    // Off: nothing matches, and the serialised lists stay on disk untouched.
    s.engine.setEnabled('excerpt', false)
    matcher.rebuild()
    expect(matcher.match(ctx('https://ad.doubleclick.net/x'))).toBeNull()
    expect(matcher.match(ctx('https://phish.example/', { type: 'main_frame' }))).toBeNull()
    expect(readFileSync(join(cacheDir, 'engine.json'), 'utf8')).toBe(meta)

    // On again: deserialised, not parsed.
    s.engine.setEnabled('excerpt', true)
    matcher.rebuild()
    expect(matcher.fromCache).toBe(true)
    expect(matcher.match(ctx('https://ad.doubleclick.net/x'))).toMatchObject({ action: 'block' })
  })
})

describe('ElectronBundledLists', () => {
  it('reports the manifest and installs gunzipped snapshots as rule-set documents', async () => {
    const bundle = tempDir()
    const profile = tempDir()
    writeFileSync(join(bundle, 'easylist.txt.gz'), gzipSync('||ads.example^\n||more.example^'))
    writeFileSync(
      join(bundle, 'manifest.json'),
      JSON.stringify({
        builtAt: 1234,
        lists: [{ id: 'easylist', file: 'easylist.txt.gz', version: '2026', filterCount: 2 }]
      })
    )
    const host = new ElectronBundledLists(bundle, profile)
    expect(await host.bundledLists()).toEqual([
      { id: 'easylist', version: '2026', builtAt: 1234, filterCount: 2 }
    ])
    const set: RuleSet = {
      id: 'easylist',
      source: 'filter-list',
      priority: 1,
      enabled: true,
      updatedAt: 1234
    }
    expect(await host.installBundled(set, 'blocking/easylist.json')).toEqual({
      id: 'easylist',
      version: '2026',
      builtAt: 1234,
      filterCount: 2
    })
    const doc = JSON.parse(
      readFileSync(join(profile, 'blocking', 'easylist.json'), 'utf8')
    ) as RuleSet
    expect(doc).toEqual({ ...set, filterText: '||ads.example^\n||more.example^' })
    expect(await host.installBundled({ ...set, id: 'other' }, 'blocking/other.json')).toBeNull()
    expect(set.filterText).toBeUndefined()
  })

  it('treats a missing or malformed manifest as no snapshot', async () => {
    const bundle = tempDir()
    expect(await new ElectronBundledLists(bundle, tempDir()).bundledLists()).toEqual([])
    writeFileSync(join(bundle, 'manifest.json'), '{"lists": "no"}')
    expect(await new ElectronBundledLists(bundle, tempDir()).bundledLists()).toEqual([])
  })
})
