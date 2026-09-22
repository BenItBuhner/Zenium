// Node's SHA-256 is the reference the core's own implementation is checked against.
// eslint-disable-next-line no-restricted-imports
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackgroundWork } from '../../background/work'
import type { Browser } from '../../browser'
import type { NetHost, PrivacyHost, StoreIO } from '../../platform'
import {
  DEFAULT_PRIVACY_SETTINGS,
  type PrivacySettings,
  type SafeBrowsingHit
} from '../../../shared/privacy'
import { prefixCountOf } from '../document'
import { SAFE_BROWSING_FEEDS, safeBrowsingFeed } from '../feeds'
import { PrefixTable } from '../prefixes'
import {
  DOCUMENT_LOAD_DELAY_MS,
  FEED_DOCUMENT_VERSION,
  SafeBrowsingService,
  STARTUP_SWEEP_DELAY_MS,
  bypassKey,
  feedFile,
  parseFeedDocument,
  sameDocument,
  type FeedDocument
} from '../service'

type FetchText = NetHost['fetchText']

interface Fake {
  browser: Browser
  io: StoreIO & { files: Map<string, string> }
  settings: PrivacySettings
  fetchText: ReturnType<typeof vi.fn<FetchText>>
  bundled: Map<string, string>
}

function memoryIo(): Fake['io'] {
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

function fake(overrides: Partial<PrivacySettings> = {}): Fake {
  const io = memoryIo()
  const settings: PrivacySettings = { ...DEFAULT_PRIVACY_SETTINGS, ...overrides }
  const fetchText = vi.fn<FetchText>(async () => ({ ok: false, status: 0, text: '' }))
  const bundled = new Map<string, string>()
  const browser = {
    state: { settings: { privacy: settings } },
    background: new BackgroundWork(),
    platform: {
      io,
      net: { fetchText },
      privacy: {
        apply: () => undefined,
        bundledSafeBrowsingFeed: async (id: string) => bundled.get(id) ?? null
      }
    }
  } as unknown as Browser
  return { browser, io, settings, fetchText, bundled }
}

function document(id: string, hosts: string[], extra: Partial<FeedDocument> = {}): FeedDocument {
  const table = PrefixTable.fromHosts(hosts)
  return {
    version: FEED_DOCUMENT_VERSION,
    id,
    threat: safeBrowsingFeed(id)?.threat ?? 'malware',
    entries: table.size,
    updatedAt: 1_700_000_000_000,
    etag: null,
    lastModified: null,
    bundled: false,
    prefixes: table.toBase64(),
    ...extra
  }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const services: SafeBrowsingService[] = []
afterEach(() => {
  for (const s of services.splice(0)) s.stop()
  vi.useRealTimers()
})

function start(f: Fake): SafeBrowsingService {
  const service = new SafeBrowsingService(f.browser)
  services.push(service)
  service.start()
  return service
}

describe('SafeBrowsingService', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('loads the persisted tables at start and answers lookups by host expression', () => {
    const f = fake()
    f.io.files.set(feedFile('urlhaus'), JSON.stringify(document('urlhaus', ['evil.example'])))
    f.io.files.set(
      feedFile('phishing-filter'),
      JSON.stringify(document('phishing-filter', ['phish.example.net']))
    )
    const service = start(f)
    expect(service.lookup('http://evil.example/payload.exe')).toEqual({
      feedId: 'urlhaus',
      threat: 'malware',
      expression: 'evil.example',
      remote: false
    })
    expect(service.lookup('https://login.phish.example.net/')).toMatchObject({
      feedId: 'phishing-filter',
      threat: 'phishing',
      expression: 'phish.example.net'
    })
    expect(service.lookup('https://example.net/')).toBeNull()
    expect(service.lookup('https://good.example/')).toBeNull()
    expect(service.lookup('zen://error')).toBeNull()
    expect(service.lookup('ftp://evil.example/')).toBeNull()
    // The reserved test hosts are always listed, exactly (not their subdomains), off the feeds' count.
    expect(service.lookup('http://malware.zenium.test:8080/x')).toEqual({
      feedId: 'test',
      threat: 'malware',
      expression: 'malware.zenium.test',
      remote: false
    })
    expect(service.lookup('https://phishing.zenium.test/')).toMatchObject({ threat: 'phishing' })
    expect(service.lookup('https://www.malware.zenium.test/')).toBeNull()
    expect(service.lookup('https://zenium.test/')).toBeNull()
    const status = service.status()
    expect(status.ready).toBe(true)
    expect(status.entries).toBe(2)
    expect(status.lastUpdatedAt).toBe(1_700_000_000_000)
    expect(status.feeds.map((x) => x.id)).toEqual(SAFE_BROWSING_FEEDS.map((x) => x.id))
  })

  it('is silent when switched off and remembers session bypasses per host', () => {
    const f = fake()
    f.io.files.set(
      feedFile('urlhaus'),
      JSON.stringify(document('urlhaus', ['evil.example', 'sub.evil.example']))
    )
    const service = start(f)
    expect(service.lookup('http://evil.example/a')).not.toBeNull()
    expect(service.bypass('http://evil.example/a#x')).toBe(true)
    expect(service.lookup('http://evil.example/b')).toBeNull()
    expect(service.isBypassed('http://evil.example/')).toBe(true)
    // The same host over https or another port (HTTPS-only mode's upgrade, a redirect) is let
    // through too; a subdomain the feed lists on its own is not.
    expect(service.lookup('https://evil.example/b')).toBeNull()
    expect(service.lookup('http://EVIL.example:8080/b')).toBeNull()
    expect(service.lookup('https://sub.evil.example/')).not.toBeNull()
    expect(service.bypasses()).toEqual(['evil.example'])
    expect(service.bypass('zen://error')).toBe(false)
    f.settings.safeBrowsingEnabled = false
    expect(service.lookup('https://evil.example/')).toBeNull()
    expect(service.status().enabled).toBe(false)
  })

  it('seeds a feed without a table from the bundled snapshot and persists it as bundled', async () => {
    const f = fake()
    f.bundled.set('urlhaus', JSON.stringify(document('urlhaus', ['bundled.example'])))
    f.bundled.set('phishing-database', JSON.stringify(document('phishing-database', ['x.example'])))
    const service = start(f)
    expect(service.lookup('http://bundled.example/')).toBeNull()
    await settle()
    await settle()
    expect(service.lookup('http://bundled.example/')).toMatchObject({ feedId: 'urlhaus' })
    const stored = parseFeedDocument(f.io.files.get(feedFile('urlhaus')) ?? null, 'urlhaus')
    expect(stored?.bundled).toBe(true)
    expect(stored?.entries).toBe(1)
    // A feed that is not part of the snapshot is not seeded even when the host offers a file.
    expect(f.io.files.has(feedFile('phishing-database'))).toBe(false)
    const status = service.status()
    expect(status.feeds.find((x) => x.id === 'urlhaus')?.bundled).toBe(true)
    // The snapshot's own build time is not "last updated".
    expect(status.lastUpdatedAt).toBeNull()
  })

  it('refreshes a feed from the network, keeps the validators and sends them next time', async () => {
    const f = fake()
    f.fetchText.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: '# hosts\n0.0.0.0 fresh.example\n0.0.0.0 localhost\n0.0.0.0 other.example\n',
      headers: { etag: '"v1"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' }
    })
    const service = start(f)
    await service.refresh('urlhaus')
    expect(f.fetchText).toHaveBeenCalledTimes(1)
    const [url, options] = f.fetchText.mock.calls[0]
    expect(url).toBe(SAFE_BROWSING_FEEDS[0].url)
    expect(options.headers).not.toHaveProperty('If-None-Match')
    expect(service.lookup('http://fresh.example/')).toMatchObject({ feedId: 'urlhaus' })
    expect(service.lookup('http://localhost/')).toBeNull()
    const stored = parseFeedDocument(f.io.files.get(feedFile('urlhaus')) ?? null, 'urlhaus')
    expect(stored).toMatchObject({ entries: 2, etag: '"v1"', bundled: false })

    f.fetchText.mockResolvedValueOnce({ ok: false, status: 304, text: '' })
    await service.refresh('urlhaus')
    const [, second] = f.fetchText.mock.calls[1]
    expect(second.headers).toMatchObject({
      'If-None-Match': '"v1"',
      'If-Modified-Since': 'Mon, 01 Jan 2024 00:00:00 GMT'
    })
    expect(service.lookup('http://fresh.example/')).not.toBeNull()
    expect(service.status().feeds[0].lastError).toBeNull()
  })

  it('keeps the old table and reports the error when a refresh fails or returns junk', async () => {
    const f = fake()
    f.io.files.set(feedFile('urlhaus'), JSON.stringify(document('urlhaus', ['old.example'])))
    const service = start(f)
    f.fetchText.mockResolvedValueOnce({ ok: false, status: 503, text: '' })
    await service.refresh('urlhaus')
    expect(service.lookup('http://old.example/')).not.toBeNull()
    expect(service.status().feeds[0].lastError).toBe('the server answered 503')

    f.fetchText.mockResolvedValueOnce({ ok: true, status: 200, text: '<html>captive portal' })
    await service.refresh('urlhaus')
    expect(service.status().feeds[0].lastError).toBe('the download is not a host list')
    expect(service.lookup('http://old.example/')).not.toBeNull()

    f.fetchText.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'TimeoutError' }))
    await service.refresh('urlhaus')
    expect(service.status().feeds[0].lastError).toBe('the download timed out')
  })

  it('does not send conditional headers for a bundled copy, so the first refresh replaces it', async () => {
    const f = fake()
    f.io.files.set(
      feedFile('urlhaus'),
      JSON.stringify(document('urlhaus', ['bundled.example'], { bundled: true, etag: '"snap"' }))
    )
    const service = start(f)
    f.fetchText.mockResolvedValueOnce({ ok: true, status: 200, text: '0.0.0.0 live.example\n' })
    await service.refresh('urlhaus')
    expect(f.fetchText.mock.calls[0][1].headers).not.toHaveProperty('If-None-Match')
    expect(service.lookup('http://live.example/')).not.toBeNull()
    expect(service.lookup('http://bundled.example/')).toBeNull()
  })

  it('hands a host-applied block to the tab once, for the same document, within its lifetime', () => {
    vi.useFakeTimers()
    const f = fake()
    const service = start(f)
    const hit = { feedId: 'urlhaus', threat: 'malware' as const, expression: 'e', remote: false }
    service.notePendingBlock('tab-1', 'http://evil.example/a', hit)
    expect(service.takePendingBlock('tab-1', 'http://other.example/')).toBeNull()
    service.notePendingBlock('tab-1', 'http://evil.example/a', hit)
    expect(service.takePendingBlock('tab-1', 'http://evil.example/a#frag')).toBe(hit)
    expect(service.takePendingBlock('tab-1', 'http://evil.example/a')).toBeNull()
    service.notePendingBlock('tab-2', 'http://evil.example/a', hit)
    vi.advanceTimersByTime(61_000)
    expect(service.takePendingBlock('tab-2', 'http://evil.example/a')).toBeNull()
    service.notePendingBlock('tab-3', 'http://evil.example/a', hit)
    service.forgetTab('tab-3')
    expect(service.takePendingBlock('tab-3', 'http://evil.example/a')).toBeNull()
  })

  it('looks navigations up remotely only with a key, matching full hashes and caching the answer', async () => {
    const f = fake({ safeBrowsingApiKey: 'KEY' })
    const service = start(f)
    expect(service.remoteLookups).toBe(true)
    const fullHash = createHash('sha256').update('bad.example/').digest('base64')
    f.fetchText.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: JSON.stringify({
        fullHashes: [{ fullHash, fullHashDetails: [{ threatType: 'SOCIAL_ENGINEERING' }] }],
        cacheDuration: '300s'
      })
    })
    const hit = await service.checkRemote('https://bad.example/login')
    expect(hit).toEqual({
      feedId: 'gsb',
      threat: 'phishing',
      expression: 'bad.example/',
      remote: true
    })
    const [url] = f.fetchText.mock.calls[0]
    expect(url).toContain('key=KEY')
    // Cached: no second request, and the synchronous lookup knows the answer too.
    expect(await service.checkRemote('https://bad.example/login')).toEqual(hit)
    expect(f.fetchText).toHaveBeenCalledTimes(1)
    expect(service.lookup('https://bad.example/login')).toEqual(hit)
    expect(service.lookup('https://bad.example/other')).toBeNull()

    f.fetchText.mockResolvedValueOnce({ ok: false, status: 429, text: '' })
    expect(await service.checkRemote('https://fine.example/')).toBeNull()
    expect(service.status().remoteErrors).toBe(1)

    f.settings.safeBrowsingApiKey = ''
    service.onSettingsChanged()
    expect(service.remoteLookups).toBe(false)
    expect(await service.checkRemote('https://bad.example/login')).toBeNull()
    expect(service.lookup('https://bad.example/login')).toBeNull()
  })

  it('tries a key against the API and refuses only what Google refuses', async () => {
    const f = fake()
    const service = start(f)
    f.fetchText.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: JSON.stringify({
        error: { message: 'API key not valid. Please pass a valid API key.' }
      })
    })
    expect(await service.checkKey('AIzaWrong')).toEqual({
      ok: false,
      problem: 'Google rejected this key: API key not valid. Please pass a valid API key'
    })
    const probe = new URL(f.fetchText.mock.calls[0][0])
    expect(probe.searchParams.get('key')).toBe('AIzaWrong')
    expect(probe.searchParams.get('hashPrefixes')).toBe('AAAAAA==')

    f.fetchText.mockResolvedValueOnce({ ok: true, status: 200, text: '{}' })
    expect(await service.checkKey('AIzaRight')).toEqual({ ok: true })

    // Google out of reach: the key goes through; its lookups' failures show on the status line.
    f.fetchText.mockRejectedValueOnce(new Error('offline'))
    expect(await service.checkKey('AIzaRight')).toEqual({ ok: true })

    expect(await service.checkKey('not a key')).toMatchObject({ ok: false })
    expect(f.fetchText).toHaveBeenCalledTimes(3)
  })

  it('gives downloads from listed hosts a dangerous verdict', async () => {
    const f = fake()
    f.io.files.set(feedFile('urlhaus'), JSON.stringify(document('urlhaus', ['evil.example'])))
    const service = start(f)
    const provider = service.verdictProvider()
    const request = { url: 'http://evil.example/setup.exe', filename: 'setup.exe', mimeType: '' }
    const signal = new AbortController().signal
    const verdict = await provider.verdict(request as never, signal)
    expect(verdict).toMatchObject({ level: 'dangerous', reason: 'url-verdict' })
    expect(
      await provider.verdict({ ...request, url: 'https://fine.example/a.zip' } as never, signal)
    ).toBeNull()
  })

  it('replaces a table directly and forgets cached host answers', () => {
    const f = fake()
    const service = start(f)
    expect(service.lookup('http://later.example/')).toBeNull()
    service.setTable('urlhaus', PrefixTable.fromHosts(['later.example']), 5)
    expect(service.lookup('http://later.example/')).toMatchObject({ feedId: 'urlhaus' })
    expect(service.status().feeds[0].updatedAt).toBe(5)
    service.setTable('unknown-feed', PrefixTable.fromHosts(['x.example']))
    expect(service.feedIds()).toEqual(SAFE_BROWSING_FEEDS.map((x) => x.id))
  })
})

/**
 * Android: the Kotlin engine reads the feed documents and checks requests itself; the service
 * keeps the documents' metadata and the schedule, reads the documents after start – off the boot
 * path – and asks the host where it needs a table's word.
 */
describe('SafeBrowsingService with the tables at the host', () => {
  interface HostFake extends Fake {
    reads: string[]
    syncReads: string[]
    lookups: string[]
    hits: Map<string, SafeBrowsingHit>
  }

  function hostFake(overrides: Partial<PrivacySettings> = {}): HostFake {
    const f = fake(overrides) as HostFake
    f.reads = []
    f.syncReads = []
    f.lookups = []
    f.hits = new Map()
    const readSync = f.io.readSync
    f.io.readSync = (name) => {
      f.syncReads.push(name)
      return readSync(name)
    }
    f.io.read = async (name) => {
      f.reads.push(name)
      await settle()
      return f.io.files.get(name) ?? null
    }
    const privacy = f.browser.platform.privacy as PrivacyHost
    Object.assign(privacy, {
      safeBrowsingTables: 'host',
      lookupSafeBrowsing: async (url: string) => {
        f.lookups.push(url)
        return f.hits.get(url) ?? null
      }
    } satisfies Partial<PrivacyHost>)
    return f
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('reads no document at start; the documents come in after the delay, for their metadata, with no table built', async () => {
    vi.useFakeTimers()
    const f = hostFake()
    const listed = document('urlhaus', ['evil.example'], { updatedAt: 1_700_000_000_000 })
    f.io.files.set(feedFile('urlhaus'), JSON.stringify(listed))
    f.io.files.set(
      feedFile('phishing-database'),
      JSON.stringify(document('phishing-database', ['a.example', 'b.example'], { entries: 0 }))
    )
    const changes = vi.fn()
    const service = new SafeBrowsingService(f.browser)
    services.push(service)
    service.onChange(changes)
    service.start()

    // Nothing was read, synchronously or otherwise, and the card says the feeds are loading.
    expect(f.syncReads).toEqual([])
    expect(f.reads).toEqual([])
    expect(service.status()).toMatchObject({ ready: false, entries: 0 })
    expect(changes).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(DOCUMENT_LOAD_DELAY_MS - 1)
    expect(f.reads).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(f.reads).toEqual(SAFE_BROWSING_FEEDS.map((feed) => feedFile(feed.id)))
    await vi.advanceTimersByTimeAsync(10)
    expect(f.syncReads).toEqual([])

    const status = service.status()
    expect(status.ready).toBe(true)
    // The documents' counts: the writer's, or – a document without one – the prefixes' length.
    expect(status.feeds.find((x) => x.id === 'urlhaus')?.entries).toBe(1)
    expect(status.feeds.find((x) => x.id === 'phishing-database')?.entries).toBe(2)
    expect(status.entries).toBe(3)
    expect(status.lastUpdatedAt).toBe(1_700_000_000_000)
    // No table here: the host's engine answers requests; the reserved test hosts stay the service's.
    expect(service.lookup('http://evil.example/')).toBeNull()
    expect(service.lookup('http://malware.zenium.test/')).toMatchObject({ feedId: 'test' })
  })

  it('seeds the bundled snapshot and starts the schedule only once the documents are in', async () => {
    vi.useFakeTimers()
    const f = hostFake()
    f.bundled.set('urlhaus', JSON.stringify(document('urlhaus', ['bundled.example'])))
    const service = start(f)
    await vi.advanceTimersByTimeAsync(DOCUMENT_LOAD_DELAY_MS - 1)
    expect(f.io.files.has(feedFile('urlhaus'))).toBe(false)
    await vi.advanceTimersByTimeAsync(20)
    // The snapshot's whole document went to the file (the host reads the table from it), marked bundled.
    const stored = parseFeedDocument(f.io.files.get(feedFile('urlhaus')) ?? null, 'urlhaus')
    expect(stored).toMatchObject({ bundled: true, entries: 1 })
    expect(stored?.prefixes.length).toBeGreaterThan(0)
    expect(service.status().feeds.find((x) => x.id === 'urlhaus')).toMatchObject({
      bundled: true,
      entries: 1
    })
    // The startup sweep follows the load, not the start: a bundled feed is stale, so it is fetched.
    expect(f.fetchText).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(STARTUP_SWEEP_DELAY_MS - 100)
    expect(f.fetchText).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(f.fetchText).toHaveBeenCalled()
  })

  it('keeps what a refresh brought over the document read after it, and never the prefixes', async () => {
    vi.useFakeTimers()
    const f = hostFake()
    f.io.files.set(feedFile('urlhaus'), JSON.stringify(document('urlhaus', ['old.example'])))
    f.fetchText.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: '0.0.0.0 fresh.example\n0.0.0.0 other.example\n',
      headers: { etag: '"v2"' }
    })
    const service = start(f)
    // "Update now" before the documents were read: the refresh lands first.
    const refreshed = service.refresh('urlhaus')
    await vi.advanceTimersByTimeAsync(1)
    await refreshed
    expect(service.status().feeds[0]).toMatchObject({ entries: 2, lastError: null })
    const written = parseFeedDocument(f.io.files.get(feedFile('urlhaus')) ?? null, 'urlhaus')
    expect(written).toMatchObject({ entries: 2, etag: '"v2"' })
    expect(written?.prefixes.length).toBeGreaterThan(0)

    await vi.advanceTimersByTimeAsync(DOCUMENT_LOAD_DELAY_MS + 10)
    expect(service.status().ready).toBe(true)
    expect(service.status().feeds[0]).toMatchObject({ entries: 2 })

    // A 304 moves the check's time here, and rewrites nothing: the host would decode the
    // megabytes again for a date.
    const before = f.io.files.get(feedFile('urlhaus'))
    f.fetchText.mockResolvedValueOnce({ ok: false, status: 304, text: '' })
    await service.refresh('urlhaus')
    expect(f.fetchText.mock.calls[1][1].headers).toMatchObject({ 'If-None-Match': '"v2"' })
    expect(f.io.files.get(feedFile('urlhaus'))).toBe(before)
    expect(service.status().feeds[0].updatedAt).toBeGreaterThan(written?.updatedAt ?? 0)
  })

  it("asks the host's tables for a download's verdict, under this side's switch and bypasses", async () => {
    vi.useFakeTimers()
    const f = hostFake()
    f.hits.set('http://evil.example/setup.exe', {
      feedId: 'urlhaus',
      threat: 'malware',
      expression: 'evil.example',
      remote: false
    })
    const service = start(f)
    const provider = service.verdictProvider()
    const signal = new AbortController().signal
    const ask = (url: string): Promise<unknown> =>
      provider.verdict({ url, filename: 'setup.exe', mimeType: '' } as never, signal)
    expect(await ask('http://evil.example/setup.exe')).toMatchObject({
      level: 'dangerous',
      reason: 'url-verdict'
    })
    expect(await ask('https://fine.example/a.zip')).toBeNull()
    expect(f.lookups).toEqual(['http://evil.example/setup.exe', 'https://fine.example/a.zip'])
    // Bypassed here, off here: the host is not asked.
    service.bypass('http://evil.example/')
    expect(await ask('http://evil.example/setup.exe')).toBeNull()
    f.settings.safeBrowsingEnabled = false
    expect(await ask('https://fine.example/a.zip')).toBeNull()
    expect(f.lookups).toHaveLength(2)
    // The reserved test hosts never need the host.
    f.settings.safeBrowsingEnabled = true
    expect(await ask('http://malware.zenium.test/x.exe')).toMatchObject({ level: 'dangerous' })
    expect(f.lookups).toHaveLength(2)
  })

  it('reads through readSync where the host has no asynchronous read, and survives a failed one', async () => {
    vi.useFakeTimers()
    const f = hostFake()
    f.io.files.set(feedFile('urlhaus'), JSON.stringify(document('urlhaus', ['x.example'])))
    delete f.io.read
    const service = start(f)
    await vi.advanceTimersByTimeAsync(DOCUMENT_LOAD_DELAY_MS + 1)
    expect(f.syncReads).toEqual(SAFE_BROWSING_FEEDS.map((feed) => feedFile(feed.id)))
    expect(service.status()).toMatchObject({ ready: true, entries: 1 })

    const g = hostFake()
    g.io.read = async () => {
      throw new Error('the handler is gone')
    }
    const other = start(g)
    await vi.advanceTimersByTimeAsync(DOCUMENT_LOAD_DELAY_MS + 1)
    expect(other.status()).toMatchObject({ ready: true, entries: 0 })
  })

  it('reads nothing once stopped before the delay', async () => {
    vi.useFakeTimers()
    const f = hostFake()
    const service = start(f)
    service.stop()
    await vi.advanceTimersByTimeAsync(DOCUMENT_LOAD_DELAY_MS + 1)
    expect(f.reads).toEqual([])
    expect(service.status().ready).toBe(false)
  })
})

describe('helpers', () => {
  it('parses persisted documents strictly', () => {
    const doc = document('urlhaus', ['a.example'])
    expect(parseFeedDocument(JSON.stringify(doc), 'urlhaus')).toEqual(doc)
    expect(parseFeedDocument(JSON.stringify(doc), 'other')).toBeNull()
    expect(parseFeedDocument(JSON.stringify({ ...doc, version: 99 }), 'urlhaus')).toBeNull()
    expect(parseFeedDocument(JSON.stringify({ ...doc, prefixes: 7 }), 'urlhaus')).toBeNull()
    expect(parseFeedDocument('not json', 'urlhaus')).toBeNull()
    expect(parseFeedDocument(null, 'urlhaus')).toBeNull()
  })

  it('counts the prefixes of a document from its base64 alone', () => {
    for (const n of [0, 1, 2, 3, 1000]) {
      const hosts = Array.from({ length: n }, (_, i) => `h${i}.example`)
      expect(prefixCountOf(PrefixTable.fromHosts(hosts).toBase64())).toBe(n)
    }
    expect(prefixCountOf('AAAA\nAAAAAAAAAAA=\n')).toBe(1)
    expect(prefixCountOf('AAAA')).toBe(0)
  })

  it('keys bypasses on the host and compares documents without their fragment', () => {
    expect(bypassKey('https://A.example:8443/x?y#z')).toBe('a.example')
    expect(bypassKey('http://a.example/')).toBe('a.example')
    expect(bypassKey('zen://error')).toBeNull()
    expect(bypassKey('nope')).toBeNull()
    expect(sameDocument('https://a/x#1', 'https://a/x#2')).toBe(true)
    expect(sameDocument('https://a/x', 'https://a/y')).toBe(false)
  })
})
