import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuleEngine, TEXT_MATCH_SET_ID } from '../../../core/blocking/engine'
import type { BlockedRequestSource } from '../../../core/blocking/report'
import type { Decision, RequestContext, RuleSet } from '../../../core/blocking/rules'
import { RuleSetStore } from '../../../core/blocking/store'
import type { StoreIO } from '../../../core/platform'
import type { DecisionStage, IdleSlot } from '../blocking'
import type { GhosteryCompileOutput, GhosteryCompileScope } from '../blockingCompile'
import type { HostRequest } from '../webRequest'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', getAppPath: () => '/nowhere', isPackaged: false }
}))

const {
  BlockingHandler,
  DESERIALISE_IDLE_CAP_MS,
  ElectronBundledLists,
  GhosteryTextMatcher,
  IDLE_PROBE_MS,
  LIST_SETTLE_CAP_MS,
  LIST_SETTLE_MS,
  idleSlot
} = await import('../blocking')
const { GHOSTERY_CACHE_FORMAT, GHOSTERY_COMPILE_TASK, cacheDigest } =
  await import('../blockingCompile')

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zenium-blocking-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The metadata one scope's cache should carry: its fingerprint, version and the files' digests. */
function expectedMeta(
  cacheDir: string,
  fingerprint: string,
  version: string,
  tag = ''
): Record<string, unknown> {
  return {
    format: GHOSTERY_CACHE_FORMAT,
    fingerprint,
    version,
    engine: cacheDigest(readFileSync(join(cacheDir, `engine${tag}.bin`))),
    documents: cacheDigest(readFileSync(join(cacheDir, `documents${tag}.txt`)))
  }
}

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
    sources: Array<BlockedRequestSource | undefined>
  } {
    const blocked: Array<string | undefined> = []
    const sources: Array<BlockedRequestSource | undefined> = []
    const h = new BlockingHandler(
      {
        decide,
        recordBlocked: (tabId, count = 1, source) => {
          blocked.push(...Array<string | undefined>(count).fill(tabId))
          sources.push(source)
        }
      },
      { cspDirectives: () => csp },
      observer
    )
    return { handler: h, blocked, sources }
  }

  it('cancels blocked requests and counts them against the tab', () => {
    const {
      handler: h,
      blocked,
      sources
    } = handler(() => ({
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
    // The tracker report gets the blocked request's host and the set that matched.
    expect(sources).toEqual([
      { host: 'ads.example', setId: 'easylist' },
      { host: 'ads.example', setId: 'easylist' }
    ])
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
    expect(JSON.parse(readFileSync(join(cacheDir, 'engine.json'), 'utf8'))).toEqual(
      expectedMeta(cacheDir, 'excerpt:1000:10', 'v1')
    )

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

  it('compiles in the background when given the compile: the old engine answers meanwhile, changes fold into one build after, and a failed compile keeps what was there', async () => {
    const cacheDir = join(tempDir(), 'cache')
    const s = source()
    const { FiltersEngine, Request } = await import('@ghostery/adblocker')
    const { compileGhosteryEngine } = await import('../blockingCompile')
    // The compile as the worker runs it, but held until the test lets each one go.
    const gates: Array<() => void> = []
    let fail = false
    const compile = vi.fn(async (scopes: GhosteryCompileScope[]) => {
      await new Promise<void>((resolve) => gates.push(resolve))
      if (fail) throw new Error('the worker choked')
      return GHOSTERY_COMPILE_TASK.run({ scopes })
    })
    const partsOf = (call: number): string[] =>
      compile.mock.calls[call]![0].flatMap((scope) => scope.parts)
    const matcher = new GhosteryTextMatcher(s, cacheDir, 'v1', 0, compile)
    s.engine.setRuleSet(textSet('excerpt', EXCERPT))
    matcher.rebuild()
    // Out for compiling: nothing adopted yet, `ready` says so, nothing matches.
    expect(compile).toHaveBeenCalledTimes(1)
    expect(matcher.ready).toBe(false)
    expect(matcher.builds).toBe(0)
    expect(matcher.match(ctx('https://ad.doubleclick.net/x'))).toBeNull()
    // Two more sets land while the build is out: one build after it covers both.
    s.engine.setRuleSet(textSet('a', '||a.example^'))
    matcher.rebuild()
    s.engine.setRuleSet(textSet('b', '||b.example^'))
    matcher.rebuild()
    expect(compile).toHaveBeenCalledTimes(1)
    gates.shift()!()
    await new Promise((r) => setTimeout(r, 20))
    expect(matcher.builds).toBe(1)
    expect(matcher.compiledInBackground).toBe(1)
    expect(matcher.match(ctx('https://ad.doubleclick.net/x'))).toMatchObject({ action: 'block' })
    expect(matcher.match(ctx('https://a.example/'))).toBeNull()
    // The folded build went out by itself, with the later sets' unpersisted text.
    expect(compile).toHaveBeenCalledTimes(2)
    expect([...partsOf(1)].sort()).toEqual([EXCERPT, '||a.example^', '||b.example^'].sort())
    gates.shift()!()
    await new Promise((r) => setTimeout(r, 20))
    expect(matcher.builds).toBe(2)
    expect(matcher.ready).toBe(true)
    expect(matcher.match(ctx('https://a.example/'))).toMatchObject({ action: 'block' })
    expect(matcher.match(ctx('https://b.example/'))).toMatchObject({ action: 'block' })
    expect(matcher.match(ctx('https://phish.example/', { type: 'main_frame' }))).toMatchObject({
      action: 'block'
    })
    // The cache holds the worker's bytes as they came: the next start deserialises them.
    expect(Buffer.from(readFileSync(join(cacheDir, 'engine.bin')))).toEqual(
      Buffer.from(compileGhosteryEngine(partsOf(1)).engine.serialize())
    )
    expect(
      FiltersEngine.deserialize(new Uint8Array(readFileSync(join(cacheDir, 'engine.bin')))).match(
        Request.fromRawDetails({ url: 'https://a.example/', type: 'script' })
      ).match
    ).toBe(true)
    expect(readFileSync(join(cacheDir, 'documents.txt'), 'utf8')).toBe(
      '||phish.example^$all\n@@||trusted.example^$document'
    )

    // A compile that fails leaves the engine as it was, and the build is over.
    fail = true
    s.engine.setRuleSet(textSet('c', '||c.example^'))
    matcher.rebuild()
    gates.shift()!()
    await new Promise((r) => setTimeout(r, 20))
    expect(matcher.builds).toBe(3)
    expect(matcher.ready).toBe(true)
    expect(matcher.match(ctx('https://b.example/'))).toMatchObject({ action: 'block' })
    expect(matcher.match(ctx('https://c.example/'))).toBeNull()
  })

  it('hands back the same engine from the worker task as the parse on the spot', async () => {
    const { FiltersEngine, Request } = await import('@ghostery/adblocker')
    const { compileGhosteryEngine } = await import('../blockingCompile')
    const parts = [EXCERPT, '||a.example^\n||b.example^$third-party']
    const output = GHOSTERY_COMPILE_TASK.run({
      scopes: [
        { partition: null, parts, cache: null },
        { partition: 'private', parts: ['||p.example^'], cache: null }
      ]
    })
    // One answer for the build's scopes, in order; moved, not copied: the task names the buffers.
    expect(output.scopes.map((scope) => scope.partition)).toEqual([null, 'private'])
    expect(GHOSTERY_COMPILE_TASK.transferables!(output)).toEqual([
      output.scopes[0]!.engine.buffer,
      output.scopes[1]!.engine.buffer
    ])
    const cloned = structuredClone(output, {
      transfer: output.scopes.map((scope) => scope.engine.buffer)
    })
    expect(output.scopes[0]!.engine.byteLength).toBe(0)
    const fromWorker = FiltersEngine.deserialize(cloned.scopes[0]!.engine)
    const onTheSpot = compileGhosteryEngine(parts)
    expect(Buffer.from(fromWorker.serialize())).toEqual(Buffer.from(onTheSpot.engine.serialize()))
    expect(cloned.scopes[0]!.documents).toBe(onTheSpot.documents.lines.join('\n'))
    expect(
      FiltersEngine.deserialize(cloned.scopes[1]!.engine).match(
        Request.fromRawDetails({ url: 'https://p.example/', type: 'script' })
      ).match
    ).toBe(true)
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

  it('forgets the text a list update left behind once a build has read it, or has no use for it', async () => {
    const s = source()
    const matcher = new GhosteryTextMatcher(s, join(tempDir(), 'cache'), 'v1', 0)
    const stop = matcher.start()
    s.engine.setRuleSet(textSet('a', '||a.example^'))
    expect(matcher.pendingSets).toBe(1)
    await new Promise((r) => setTimeout(r, 20))
    expect(matcher.match(ctx('https://a.example/'))).toMatchObject({ action: 'block' })
    expect(matcher.pendingSets).toBe(0)

    // A list update while the master switch has every list off: the build that follows parses
    // nothing, and drops the text rather than holding it until the switch turns on – the store
    // has it by then, and the switch on reads it from there.
    s.engine.setEnabled('a', false)
    await new Promise((r) => setTimeout(r, 20))
    s.engine.setRuleSet(textSet('a', '||a.example^\n||a2.example^', false))
    expect(matcher.pendingSets).toBe(1)
    await new Promise((r) => setTimeout(r, 20))
    expect(matcher.pendingSets).toBe(0)
    expect(matcher.match(ctx('https://a2.example/'))).toBeNull()
    s.engine.setEnabled('a', true)
    await new Promise((r) => setTimeout(r, 20))
    expect(matcher.match(ctx('https://a2.example/'))).toMatchObject({ action: 'block' })
    expect(matcher.pendingSets).toBe(0)
    stop()
  })

  it('compiles a matcher of its own for a partition a text set names and answers that partition from it (PS-49)', () => {
    const cacheDir = join(tempDir(), 'cache')
    const s = source()
    const matcher = new GhosteryTextMatcher(s, cacheDir, 'v1', 0)
    s.engine.setRuleSet(textSet('easylist', '||ads.example^'))
    // The strict-only list, as the service enables it for private windows alone.
    s.engine.setRuleSet({
      ...textSet('ubo-privacy', '||fingerprint.example^'),
      partitions: ['private']
    })
    matcher.rebuild()
    expect(matcher.ready).toBe(true)
    expect(matcher.builds).toBe(1)
    expect(matcher.scopedPartitions).toEqual(['private'])
    const from = (url: string, partition?: string): RequestContext =>
      ctx(url, partition ? { partition, isPrivate: partition === 'private' } : {})
    const fp = 'https://fingerprint.example/fp.js'
    const ad = 'https://ads.example/a.js'
    // The private partition's matcher holds both lists; every other request meets EasyList alone.
    expect(matcher.match(from(fp, 'private'))).toMatchObject({
      action: 'block',
      filter: '||fingerprint.example^'
    })
    expect(matcher.match(from(fp, 'default'))).toBeNull()
    expect(matcher.match(from(fp, 'work'))).toBeNull()
    expect(matcher.match(from(fp))).toBeNull()
    expect(matcher.match(from(ad, 'private'))).toMatchObject({ action: 'block' })
    expect(matcher.match(from(ad, 'default'))).toMatchObject({ action: 'block' })
    expect(matcher.match(from(ad))).toMatchObject({ action: 'block' })
    // Each scope's serialised form under its own name, fingerprinted by the sets it holds.
    expect(JSON.parse(readFileSync(join(cacheDir, 'engine.json'), 'utf8'))).toEqual(
      expectedMeta(cacheDir, 'easylist:1000:1', 'v1')
    )
    expect(JSON.parse(readFileSync(join(cacheDir, 'engine.private.json'), 'utf8'))).toEqual(
      expectedMeta(cacheDir, 'easylist:1000:1|ubo-privacy:1000:1', 'v1', '.private')
    )
    expect(existsSync(join(cacheDir, 'engine.private.bin'))).toBe(true)
    expect(existsSync(join(cacheDir, 'documents.private.txt'))).toBe(true)

    // Wired into the core engine: the private window's request is the list's, the normal one's the default allow.
    s.engine.setTextMatcher(matcher)
    expect(s.engine.decide(from(fp, 'private'))).toMatchObject({
      action: 'block',
      matched: { setId: TEXT_MATCH_SET_ID }
    })
    expect(s.engine.decide(from(fp, 'default'))).toEqual({ action: 'allow' })

    // The switch off (the list disabled and unscoped): the private matcher goes, and a private
    // window's requests answer from the unscoped one again.
    s.engine.setEnabled('ubo-privacy', false)
    s.engine.setPartitions('ubo-privacy', undefined)
    matcher.rebuild()
    expect(matcher.scopedPartitions).toEqual([])
    expect(matcher.match(from(fp, 'private'))).toBeNull()
    expect(matcher.match(from(ad, 'private'))).toMatchObject({ action: 'block' })
    // The dropped scope's cache files go with it; the unscoped matcher's stay.
    expect(existsSync(join(cacheDir, 'engine.private.bin'))).toBe(false)
    expect(existsSync(join(cacheDir, 'engine.private.json'))).toBe(false)
    expect(existsSync(join(cacheDir, 'documents.private.txt'))).toBe(false)
    expect(existsSync(join(cacheDir, 'engine.bin'))).toBe(true)

    // The next start with the switch on and the text on disk only: the unscoped scope
    // deserialises, the private one (its cache gone with the switch off) compiles again from
    // the store's text.
    const s2 = source()
    s2.engine.setRuleSet(
      { id: 'easylist', source: 'filter-list', priority: 1, enabled: true, updatedAt: 1000 },
      { persisted: true, hasFilterText: true, filterCount: 1 }
    )
    s2.engine.setRuleSet({
      ...textSet('ubo-privacy', '||fingerprint.example^'),
      partitions: ['private']
    })
    const second = new GhosteryTextMatcher(s2, cacheDir, 'v1', 0)
    second.rebuild()
    expect(second.fromCache).toBe(true)
    expect(existsSync(join(cacheDir, 'engine.private.bin'))).toBe(true)
    expect(second.scopedPartitions).toEqual(['private'])
    expect(second.match(from(fp, 'private'))).toMatchObject({ action: 'block' })
    expect(second.match(from(fp, 'default'))).toBeNull()
    expect(second.match(from(ad, 'default'))).toMatchObject({ action: 'block' })
  })

  /** A compile the test lets go by hand, and an idle slot the test fires by hand. */
  function handDriven(): {
    compile: Mock<(scopes: GhosteryCompileScope[]) => Promise<GhosteryCompileOutput>>
    release(call?: number): Promise<void>
    slot: IdleSlot
    fireSlot(): void
    slots: number
  } {
    const gates: Array<() => void> = []
    const compile = vi.fn(async (scopes: GhosteryCompileScope[]) => {
      await new Promise<void>((resolve) => gates.push(resolve))
      // Without the cache targets: the stand-in worker never writes, so the disk holds what a
      // test put there and nothing else.
      return GHOSTERY_COMPILE_TASK.run({
        scopes: scopes.map((scope) => ({ ...scope, cache: null }))
      })
    })
    const pending: Array<() => void> = []
    const state = {
      compile,
      release: async (call = 0): Promise<void> => {
        gates[call]!()
        await new Promise((r) => setTimeout(r, 0))
        await new Promise((r) => setImmediate(r))
      },
      slot: ((fn: () => void) => {
        pending.push(fn)
        state.slots++
        return () => {
          const at = pending.indexOf(fn)
          if (at >= 0) pending.splice(at, 1)
        }
      }) as IdleSlot,
      fireSlot: (): void => {
        for (const fn of pending.splice(0)) fn()
      },
      slots: 0
    }
    return state
  }
  it('answers from the previous snapshot until the adopt: between a rebuild and its idle slot, every request sees the old engine (W8-P1 pin)', async () => {
    const s = source()
    const h = handDriven()
    const matcher = new GhosteryTextMatcher(s, join(tempDir(), 'cache'), 'v1', 0, h.compile, h.slot)
    s.engine.setRuleSet(textSet('excerpt', EXCERPT))
    matcher.rebuild()
    await h.release(0)
    expect(matcher.waitingScopes).toBe(1)
    expect(matcher.ready).toBe(false)
    h.fireSlot()
    expect(matcher.ready).toBe(true)
    expect(matcher.compiledInBackground).toBe(1)
    const old = (): void => {
      expect(matcher.match(ctx('https://ad.doubleclick.net/x'))).toMatchObject({ action: 'block' })
      expect(matcher.match(ctx('https://a.example/'))).toBeNull()
      expect(matcher.match(ctx('https://phish.example/', { type: 'main_frame' }))).toMatchObject({
        action: 'block'
      })
    }
    old()

    // A set lands and the rebuild goes out: the old snapshot answers while the worker compiles …
    s.engine.setRuleSet(textSet('a', '||a.example^\n@@||phish.example^$document'))
    matcher.rebuild()
    expect(h.compile).toHaveBeenCalledTimes(2)
    old()
    // … while its bytes wait for the idle slot …
    await h.release(1)
    expect(matcher.waitingScopes).toBe(1)
    expect(matcher.builds).toBe(2)
    old()
    // … and the one assignment of the slot switches every answer at once.
    h.fireSlot()
    expect(matcher.compiledInBackground).toBe(2)
    expect(matcher.ready).toBe(true)
    expect(matcher.match(ctx('https://a.example/'))).toMatchObject({ action: 'block' })
    expect(matcher.match(ctx('https://phish.example/', { type: 'main_frame' }))).toMatchObject({
      action: 'allow'
    })
    expect(matcher.match(ctx('https://ad.doubleclick.net/x'))).toMatchObject({ action: 'block' })
  })

  it('compiles the scopes of one build in one message, one after the other (#716 nit)', async () => {
    const s = source()
    const h = handDriven()
    const matcher = new GhosteryTextMatcher(s, join(tempDir(), 'cache'), 'v1', 0, h.compile, h.slot)
    s.engine.setRuleSet(textSet('easylist', '||ads.example^'))
    s.engine.setRuleSet({ ...textSet('ubo-privacy', '||fp.example^'), partitions: ['private'] })
    matcher.rebuild()
    expect(h.compile).toHaveBeenCalledTimes(1)
    const scopes = h.compile.mock.calls[0]![0]
    expect(scopes.map((scope) => scope.partition)).toEqual([null, 'private'])
    expect(scopes[0]!.parts).toEqual(['||ads.example^'])
    expect([...scopes[1]!.parts].sort()).toEqual(['||ads.example^', '||fp.example^'])
    expect(scopes.map((scope) => scope.cache?.fingerprint)).toEqual([
      'easylist:1000:1',
      'easylist:1000:1|ubo-privacy:1000:1'
    ])
    await h.release(0)
    expect(matcher.waitingScopes).toBe(2)
    h.fireSlot()
    expect(matcher.compiledInBackground).toBe(2)
    expect(matcher.scopedPartitions).toEqual(['private'])
    expect(matcher.match(ctx('https://fp.example/', { partition: 'private' }))).toMatchObject({
      action: 'block'
    })
    expect(matcher.match(ctx('https://fp.example/', { partition: 'default' }))).toBeNull()
  })

  it('folds N flips during a compile into one follow-up build of the final state; a flip back to a cached state adopts nothing new (W8-P1 pins)', async () => {
    const cacheDir = join(tempDir(), 'cache')
    const seed = source()
    seed.engine.setRuleSet(textSet('excerpt', EXCERPT))
    // The disk holds the excerpt alone (a start that parsed on the spot).
    new GhosteryTextMatcher(seed, cacheDir, 'v1', 0).rebuild()
    const s = source()
    const h = handDriven()
    const matcher = new GhosteryTextMatcher(s, cacheDir, 'v1', 0, h.compile, h.slot)
    // Subscribed before the sets load, as in the app (the matcher sees every set before a flip).
    const stop = matcher.start()
    s.engine.setRuleSet(textSet('excerpt', EXCERPT))
    s.engine.setRuleSet(textSet('a', '||a.example^', false))
    s.engine.setRuleSet(textSet('b', '||b.example^', false))
    await new Promise((r) => setTimeout(r, 5))
    expect(matcher.builds).toBe(1)
    expect(matcher.fromCache).toBe(true)
    expect(h.compile).not.toHaveBeenCalled()

    // A flip sends a compile out; four more while it runs: ONE follow-up, reading the sets as
    // they stand at its start – the final state – never an intermediate one.
    s.engine.setEnabled('a', true)
    await new Promise((r) => setTimeout(r, 5))
    expect(h.compile).toHaveBeenCalledTimes(1)
    s.engine.setEnabled('b', true)
    s.engine.setEnabled('a', false)
    s.engine.setEnabled('b', false)
    s.engine.setEnabled('b', true)
    expect(h.compile).toHaveBeenCalledTimes(1)
    await h.release(0)
    await new Promise((r) => setTimeout(r, 5))
    expect(matcher.builds).toBe(2)
    expect(h.compile).toHaveBeenCalledTimes(2)
    expect(h.compile.mock.calls[1]![0][0]!.cache?.fingerprint).toBe('b:1000:1|excerpt:1000:10')
    expect([...h.compile.mock.calls[1]![0][0]!.parts].sort()).toEqual(
      [EXCERPT, '||b.example^'].sort()
    )
    await h.release(1)
    await new Promise((r) => setTimeout(r, 5))
    expect(matcher.builds).toBe(3)
    // The first compile's bytes, still waiting, were replaced by the follow-up's: one deserialise.
    expect(matcher.superseded).toBe(1)
    expect(matcher.waitingScopes).toBe(1)
    h.fireSlot()
    expect(matcher.compiledInBackground).toBe(1)
    expect(matcher.match(ctx('https://b.example/'))).toMatchObject({ action: 'block' })
    expect(matcher.match(ctx('https://a.example/'))).toBeNull()
    expect(matcher.match(ctx('https://ad.doubleclick.net/x'))).toMatchObject({ action: 'block' })
    expect(matcher.ready).toBe(true)

    // A flip away and back while nothing is compiling: the build that follows finds the current
    // matcher carries the sets' fingerprint already, and neither compiles nor adopts.
    s.engine.setEnabled('a', true)
    s.engine.setEnabled('a', false)
    await new Promise((r) => setTimeout(r, 5))
    expect(matcher.builds).toBe(4)
    expect(h.compile).toHaveBeenCalledTimes(2)
    expect(matcher.compiledInBackground).toBe(1)

    // Flips during a compile that end at the state the disk cache holds (the excerpt alone):
    // the one follow-up hits the cache and deserialises from disk; the worker is not asked, and
    // the in-flight compile's bytes are dropped unread.
    s.engine.setEnabled('a', true)
    await new Promise((r) => setTimeout(r, 5))
    expect(h.compile).toHaveBeenCalledTimes(3)
    s.engine.setEnabled('b', false)
    s.engine.setEnabled('a', false)
    await h.release(2)
    await new Promise((r) => setTimeout(r, 5))
    expect(h.compile).toHaveBeenCalledTimes(3)
    expect(matcher.builds).toBe(6)
    expect(matcher.fromCache).toBe(true)
    expect(matcher.compiledInBackground).toBe(1)
    expect(matcher.waitingScopes).toBe(0)
    expect(matcher.match(ctx('https://b.example/'))).toBeNull()
    expect(matcher.match(ctx('https://a.example/'))).toBeNull()
    expect(matcher.match(ctx('https://ad.doubleclick.net/x'))).toMatchObject({ action: 'block' })
    expect(matcher.ready).toBe(true)
    stop()
  })

  it("supersedes waiting bytes with a newer build's: one deserialise, the newer (W8-P1 pin)", async () => {
    const s = source()
    const h = handDriven()
    const matcher = new GhosteryTextMatcher(s, join(tempDir(), 'cache'), 'v1', 0, h.compile, h.slot)
    s.engine.setRuleSet(textSet('a', '||a.example^'))
    matcher.rebuild()
    await h.release(0)
    expect(matcher.waitingScopes).toBe(1)
    expect(h.slots).toBe(1)
    // The next build goes out and comes back before the slot fires.
    s.engine.setRuleSet(textSet('b', '||b.example^'))
    matcher.rebuild()
    await h.release(1)
    expect(matcher.superseded).toBe(1)
    expect(matcher.waitingScopes).toBe(1)
    expect(h.slots).toBe(1)
    h.fireSlot()
    expect(matcher.compiledInBackground).toBe(1)
    expect(matcher.match(ctx('https://a.example/'))).toMatchObject({ action: 'block' })
    expect(matcher.match(ctx('https://b.example/'))).toMatchObject({ action: 'block' })
    expect(matcher.ready).toBe(true)
  })

  describe('the settle window', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    /** A matcher on fake timers, parsing on the spot, with a list arriving as the service lands one. */
    function settling(): {
      matcher: InstanceType<typeof GhosteryTextMatcher>
      engine: RuleEngine
      arrive(id: string, text: string, updatedAt?: number): void
      stop(): void
    } {
      vi.useFakeTimers()
      const s = source()
      const matcher = new GhosteryTextMatcher(s, join(tempDir(), 'cache'), 'v1', 50)
      const stop = matcher.start()
      vi.advanceTimersByTime(50)
      expect(matcher.builds).toBe(1)
      return {
        matcher,
        engine: s.engine,
        arrive: (id, text, updatedAt = Date.now()) =>
          s.engine.setRuleSet({ ...textSet(id, text), updatedAt }),
        stop
      }
    }
    const blocks = (matcher: InstanceType<typeof GhosteryTextMatcher>, host: string): boolean =>
      matcher.match(ctx(`https://${host}/x.js`))?.action === 'block'

    it('adopts the first arrival of an unprotected scope at once and settles the rest for a second (refinement A)', () => {
      const { matcher, arrive, stop } = settling()
      arrive('a', '||a.example^')
      vi.advanceTimersByTime(50)
      expect(matcher.builds).toBe(2)
      expect(blocks(matcher, 'a.example')).toBe(true)
      // The second and third arrivals, within a second of each other: one build when they settle.
      arrive('b', '||b.example^')
      vi.advanceTimersByTime(600)
      expect(matcher.builds).toBe(2)
      arrive('c', '||c.example^')
      vi.advanceTimersByTime(600)
      expect(matcher.builds).toBe(2)
      expect(blocks(matcher, 'b.example')).toBe(false)
      vi.advanceTimersByTime(LIST_SETTLE_MS - 600)
      expect(matcher.builds).toBe(3)
      expect(blocks(matcher, 'b.example')).toBe(true)
      expect(blocks(matcher, 'c.example')).toBe(true)
      expect(matcher.ready).toBe(true)
      stop()
    })

    it('builds at the cap when arrivals keep coming for longer than it', () => {
      const { matcher, arrive, stop } = settling()
      arrive('a', '||a.example^')
      vi.advanceTimersByTime(50)
      const start = Date.now()
      // A list every 800 ms: each extends the window, none lets it end; the cap from the first
      // arrival does, with every list so far.
      for (let i = 0; i < 7; i++) {
        arrive(`l${i}`, `||l${i}.example^`)
        vi.advanceTimersByTime(800)
        expect(matcher.builds).toBe(Date.now() - start >= LIST_SETTLE_CAP_MS ? 3 : 2)
      }
      expect(Date.now() - start).toBe(5600)
      expect(matcher.builds).toBe(3)
      for (let i = 0; i < 7; i++) expect(blocks(matcher, `l${i}.example`)).toBe(true)
      // The next arrival after the cap's build starts a window of its own.
      arrive('late', '||late.example^')
      vi.advanceTimersByTime(LIST_SETTLE_MS - 1)
      expect(matcher.builds).toBe(3)
      vi.advanceTimersByTime(1)
      expect(matcher.builds).toBe(4)
      expect(blocks(matcher, 'late.example')).toBe(true)
      stop()
    })

    it("cancels a pending window on a user's change and runs the one build with the arrivals (refinement B)", () => {
      const { matcher, engine, arrive, stop } = settling()
      arrive('a', '||a.example^')
      vi.advanceTimersByTime(50)
      arrive('b', '||b.example^')
      arrive('c', '||c.example^')
      vi.advanceTimersByTime(300)
      expect(matcher.builds).toBe(2)
      // The user toggles a list: the short timer, and the build reads b and c too.
      engine.setEnabled('a', false)
      vi.advanceTimersByTime(50)
      expect(matcher.builds).toBe(3)
      expect(blocks(matcher, 'a.example')).toBe(false)
      expect(blocks(matcher, 'b.example')).toBe(true)
      expect(blocks(matcher, 'c.example')).toBe(true)
      // No second build when the window would have ended.
      vi.advanceTimersByTime(LIST_SETTLE_MS + LIST_SETTLE_CAP_MS)
      expect(matcher.builds).toBe(3)
      stop()
    })

    it("tells a list's refresh (updatedAt moved) from a toggle (enabled moved) on the same set", () => {
      const { matcher, engine, arrive, stop } = settling()
      arrive('a', '||a.example^')
      vi.advanceTimersByTime(50)
      arrive('b', '||b.example^')
      vi.advanceTimersByTime(LIST_SETTLE_MS)
      expect(matcher.builds).toBe(3)
      // A sweep refreshes `a` (its text, updatedAt): an arrival, settled.
      arrive('a', '||a.example^\n||a2.example^', Date.now())
      vi.advanceTimersByTime(50)
      expect(matcher.builds).toBe(3)
      vi.advanceTimersByTime(LIST_SETTLE_MS - 50)
      expect(matcher.builds).toBe(4)
      expect(blocks(matcher, 'a2.example')).toBe(true)
      // The user turns `b` off: the short timer.
      engine.setEnabled('b', false)
      vi.advanceTimersByTime(50)
      expect(matcher.builds).toBe(5)
      expect(blocks(matcher, 'b.example')).toBe(false)
      // The user's own filters: the short timer too.
      engine.setRuleSet({
        id: 'user-filters',
        source: 'user',
        priority: 10,
        enabled: true,
        filterText: '||mine.example^',
        updatedAt: Date.now()
      })
      vi.advanceTimersByTime(50)
      expect(matcher.builds).toBe(6)
      expect(blocks(matcher, 'mine.example')).toBe(true)
      stop()
    })
  })

  describe('the idle slot', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('runs when a probe fires on time, and at the cap regardless when the loop stays busy', () => {
      vi.useFakeTimers()
      const now = (): number => Date.now()
      const idle = idleSlot({ busy: () => false, now })
      const ran: number[] = []
      const start = Date.now()
      idle(() => ran.push(Date.now() - start), DESERIALISE_IDLE_CAP_MS)
      vi.advanceTimersByTime(3)
      expect(ran).toEqual([])
      vi.advanceTimersByTime(1)
      expect(ran).toEqual([4])

      const busy = idleSlot({ busy: () => true, now })
      busy(() => ran.push(Date.now() - start), DESERIALISE_IDLE_CAP_MS)
      vi.advanceTimersByTime(DESERIALISE_IDLE_CAP_MS - 1)
      expect(ran).toEqual([4])
      vi.advanceTimersByTime(IDLE_PROBE_MS)
      expect(ran.length).toBe(2)
      expect(ran[1]! - 4).toBeGreaterThanOrEqual(DESERIALISE_IDLE_CAP_MS)
      expect(ran[1]! - 4).toBeLessThan(DESERIALISE_IDLE_CAP_MS + IDLE_PROBE_MS)

      // Cancelled: never runs.
      const cancel = busy(() => ran.push(-1), DESERIALISE_IDLE_CAP_MS)
      cancel()
      vi.advanceTimersByTime(DESERIALISE_IDLE_CAP_MS * 2)
      expect(ran.length).toBe(2)
    })

    it('runs within a few milliseconds on an idle loop', async () => {
      vi.useRealTimers()
      const idle = idleSlot()
      const ran: number[] = []
      const start = performance.now()
      idle(() => ran.push(performance.now() - start), DESERIALISE_IDLE_CAP_MS)
      await new Promise((r) => setTimeout(r, 40))
      expect(ran.length).toBe(1)
      expect(ran[0]!).toBeLessThan(DESERIALISE_IDLE_CAP_MS)
    })
  })

  describe("the worker's cache write", () => {
    it('lands atomically after the answer, and a failing write is logged once and never delays the adopt (condition 1)', async () => {
      const { resetGhosteryCacheWarnings, writeGhosteryCache } = await import('../blockingCompile')
      resetGhosteryCacheWarnings()
      const cacheDir = join(tempDir(), 'cache')
      const target = {
        bin: join(cacheDir, 'engine.bin'),
        meta: join(cacheDir, 'engine.json'),
        documents: join(cacheDir, 'documents.txt'),
        fingerprint: 'a:1:1',
        version: 'v1'
      }
      const output = GHOSTERY_COMPILE_TASK.run({
        scopes: [{ partition: null, parts: ['||a.example^\n||phish.example^$all'], cache: target }]
      })
      // Answered first: nothing is on disk until the worker's next turn.
      expect(existsSync(cacheDir)).toBe(false)
      const bytes = Buffer.from(output.scopes[0]!.engine)
      await new Promise((r) => setImmediate(r))
      expect(Buffer.from(readFileSync(target.bin))).toEqual(bytes)
      expect(readFileSync(target.documents, 'utf8')).toBe('||phish.example^$all')
      expect(JSON.parse(readFileSync(target.meta, 'utf8'))).toEqual(
        expectedMeta(cacheDir, 'a:1:1', 'v1')
      )
      expect(readdirSync(cacheDir).filter((name) => name.endsWith('.tmp'))).toEqual([])

      // Temp file + rename: the bytes go to `engine.bin.<pid>.tmp` first. With that path taken
      // by a directory the write fails before `engine.bin` is touched – it keeps the old bytes –
      // and the failure is logged once for the path, not once per build.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const tmp = `${target.bin}.${process.pid}.tmp`
      mkdirSync(tmp)
      expect(
        writeGhosteryCache({ ...target, fingerprint: 'b:2:2' }, new Uint8Array([9]), 'x')
      ).toBe(false)
      expect(
        writeGhosteryCache({ ...target, fingerprint: 'b:2:2' }, new Uint8Array([9]), 'x')
      ).toBe(false)
      expect(Buffer.from(readFileSync(target.bin))).toEqual(bytes)
      expect(JSON.parse(readFileSync(target.meta, 'utf8')).fingerprint).toBe('a:1:1')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]![0]).toBe('[zenium] filter engine cache not written')
      rmSync(tmp, { recursive: true })
      // A failure after the bytes landed (the documents path is a directory): the bytes are in
      // place whole, the metadata – written last – still names the old fingerprint, so a reader
      // of the new one misses rather than pairing new bytes with old filters.
      const other = { ...target, documents: join(cacheDir, 'docs-dir'), fingerprint: 'c:3:3' }
      mkdirSync(other.documents)
      expect(writeGhosteryCache(other, new Uint8Array([7, 7]), 'x')).toBe(false)
      expect(Buffer.from(readFileSync(target.bin))).toEqual(Buffer.from([7, 7]))
      expect(JSON.parse(readFileSync(target.meta, 'utf8')).fingerprint).toBe('a:1:1')
      expect(readdirSync(cacheDir).filter((name) => name.endsWith('.tmp'))).toEqual([])
      warn.mockRestore()

      // The matcher adopts whether or not the write landed – here every cache path is under a
      // file, so none can – and the next start finds no cache and recompiles.
      const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const blocked = join(tempDir(), 'not-a-dir')
      writeFileSync(blocked, 'x')
      const brokenCache = join(blocked, 'cache')
      const s = source()
      const compile = vi.fn((scopes: GhosteryCompileScope[]) =>
        Promise.resolve(GHOSTERY_COMPILE_TASK.run({ scopes }))
      )
      const matcher = new GhosteryTextMatcher(s, brokenCache, 'v1', 0, compile)
      s.engine.setRuleSet(textSet('a', '||a.example^'))
      matcher.rebuild()
      await new Promise((r) => setTimeout(r, 20))
      expect(matcher.ready).toBe(true)
      expect(matcher.match(ctx('https://a.example/'))).toMatchObject({ action: 'block' })
      expect(compile).toHaveBeenCalledTimes(1)
      const next = new GhosteryTextMatcher(s, brokenCache, 'v1', 0, compile)
      next.rebuild()
      expect(compile).toHaveBeenCalledTimes(2)
      await new Promise((r) => setTimeout(r, 20))
      expect(next.match(ctx('https://a.example/'))).toMatchObject({ action: 'block' })
      expect(quiet).toHaveBeenCalledTimes(1)
      quiet.mockRestore()
    })
  })

  it('keeps a partition an enabled text set stands aside from out of that set (PS-49)', () => {
    const s = source()
    const matcher = new GhosteryTextMatcher(s, join(tempDir(), 'cache'), 'v1', 0)
    s.engine.setRuleSet(textSet('easylist', '||ads.example^'))
    s.engine.setRuleSet({
      ...textSet('custom', '||custom.example^'),
      excludedPartitions: ['banking']
    })
    matcher.rebuild()
    expect(matcher.scopedPartitions).toEqual(['banking'])
    const custom = 'https://custom.example/c.js'
    expect(matcher.match(ctx(custom, { partition: 'banking' }))).toBeNull()
    expect(matcher.match(ctx(custom, { partition: 'default' }))).toMatchObject({ action: 'block' })
    expect(matcher.match(ctx(custom))).toMatchObject({ action: 'block' })
    expect(matcher.match(ctx('https://ads.example/a.js', { partition: 'banking' }))).toMatchObject({
      action: 'block'
    })
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
