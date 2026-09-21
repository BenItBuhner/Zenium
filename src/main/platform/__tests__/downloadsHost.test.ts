import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Session, DownloadItem as ElectronDownloadItem, WebContents } from 'electron'
import { PRIVATE_CONTAINER_ID, type DownloadItem } from '../../../shared/types'
import type { StoreIO } from '../../../core/platform'
import { DEFAULT_DOWNLOAD_SETTINGS } from '../../../shared/downloads'
import type { RequestObserver } from '../downloads'
import type { WebRequestDetails, WebRequestEvent, WebRequestListener } from '../webRequest'

/** Electron's `net.request`, answered by hand: the probe of a refused resume goes through it. */
const fakeNet = await vi.hoisted(async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class FakeRequest extends Emitter {
    headers: Record<string, string> = {}
    ended = false
    aborted = false
    constructor(readonly options: Record<string, unknown>) {
      super()
    }
    setHeader(name: string, value: string): void {
      this.headers[name] = value
    }
    /** Like Electron's: a Node writable that auto-destroys once flushed, `close` before any response. */
    end(): void {
      this.ended = true
      this.emit('finish')
      this.emit('close')
    }
    abort(): void {
      this.aborted = true
      this.emit('abort')
    }
    answer(statusCode: number, headers: Record<string, string | string[]> = {}): void {
      this.emit('response', { statusCode, headers })
    }
    fail(): void {
      this.emit('error', new Error('net::ERR_CONNECTION_REFUSED'))
    }
  }
  const requests: FakeRequest[] = []
  return {
    requests,
    request(options: Record<string, unknown>): FakeRequest {
      const request = new FakeRequest(options)
      requests.push(request)
      return request
    }
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/nowhere' },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
  net: { request: (options: Record<string, unknown>) => fakeNet.request(options) }
}))

const { ElectronDownloads, ONLINE_POLL_MS } = await import('../downloads')
const { DownloadService, AUTO_RESUME_DELAYS_MS } = await import('../../../core/downloads')
const { DangerVerdictRegistry } = await import('../../../core/downloads/danger')

class MemoryIO implements StoreIO {
  files = new Map<string, string>()
  readSync(name: string): string | null {
    return this.files.get(name) ?? null
  }
  async write(name: string, text: string): Promise<void> {
    this.files.set(name, text)
  }
  writeSync(name: string, text: string): void {
    this.files.set(name, text)
  }
}

/** The slice of Electron's DownloadItem the host reads and drives. */
class FakeItem extends EventEmitter {
  savePath = ''
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted' = 'progressing'
  paused = false
  /** Bytes in the partial file (Chromium keeps them over an interruption). */
  received = 0
  etag = ''
  lastModified = ''
  /** Chromium's verdict on an interrupted item: `updated` when true, `done` when false. */
  resumable = false
  constructor(
    readonly url: string,
    readonly filename: string,
    readonly chain: string[] = [url]
  ) {
    super()
  }
  getURL(): string {
    return this.url
  }
  getURLChain(): string[] {
    return this.chain
  }
  getFilename(): string {
    return this.filename
  }
  getTotalBytes(): number {
    return 3
  }
  getReceivedBytes(): number {
    return this.received || (this.state === 'completed' ? 3 : 0)
  }
  getMimeType(): string {
    return 'text/plain'
  }
  getSavePath(): string {
    return this.savePath
  }
  setSavePath(path: string): void {
    this.savePath = path
  }
  hasUserGesture(): boolean {
    return false
  }
  getETag(): string {
    return this.etag
  }
  getLastModifiedTime(): string {
    return this.lastModified
  }
  isPaused(): boolean {
    return this.paused
  }
  getState(): string {
    return this.state
  }
  canResume(): boolean {
    return this.resumable
  }
  /** Interrupted but resumable on request: Chromium reports it through `updated`. */
  interrupt(): void {
    this.state = 'interrupted'
    this.resumable = true
    this.emit('updated', {}, 'interrupted')
  }
  pause(): void {
    this.paused = true
  }
  /** Times `resume()` was asked of the item (an interrupted item only starts once it is). */
  resumed = 0
  resume(): void {
    this.paused = false
    this.resumed++
    if (this.state === 'interrupted') this.state = 'progressing'
  }
  cancel(): void {
    this.state = 'cancelled'
    this.emit('done', {}, 'cancelled')
  }
  /** The bytes landed in the partial file; Chromium reports completion. */
  complete(): void {
    writeFileSync(this.savePath, 'abc')
    this.state = 'completed'
    this.emit('done', {}, 'completed')
  }
  /** The transfer failed for good: Chromium settles the item interrupted. */
  fail(): void {
    this.state = 'interrupted'
    this.emit('done', {}, 'interrupted')
  }
}

/** The multiplexer's listener slot, replayed by hand. */
class FakeObserver implements RequestObserver {
  listeners = new Map<string, WebRequestListener[]>()
  registrants: string[] = []
  addListener(
    event: WebRequestEvent,
    listener: WebRequestListener,
    options: { registrant: string }
  ): () => void {
    this.registrants.push(options.registrant)
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return () => undefined
  }
  fire(event: WebRequestEvent, details: Partial<WebRequestDetails> & { url: string }): void {
    const full = {
      event,
      requestId: '1',
      method: 'GET',
      resourceType: 'main_frame',
      frameId: 0,
      parentFrameId: -1,
      tabId: null,
      partition: 'default',
      initiator: null,
      documentUrl: null,
      timestamp: 0,
      ...details
    } as WebRequestDetails
    for (const listener of this.listeners.get(event) ?? []) void listener(full)
  }
}

/** What `session.createInterruptedDownload` is asked for (Electron's `CreateInterruptedDownloadOptions`). */
interface InterruptedDownloadOptions {
  path: string
  urlChain: string[]
  mimeType?: string
  offset: number
  length: number
  lastModified?: string
  eTag?: string
  startTime?: number
}

class FakeSession extends EventEmitter {
  started: Array<{ url: string; options: unknown }> = []
  /** Every `createInterruptedDownload` call, with the item Electron would have made for it. */
  recreated: Array<{ options: InterruptedDownloadOptions; item: FakeItem }> = []
  downloadURL(url: string, options?: unknown): void {
    this.started.push({ url, options })
  }
  /**
   * Electron's: an interrupted, resumable item over the kept file, announced through
   * `will-download` like any other (with no source contents), which starts once `resume()` is
   * asked of it.
   */
  createInterruptedDownload(options: InterruptedDownloadOptions): void {
    const url = options.urlChain[options.urlChain.length - 1] ?? ''
    const item = new FakeItem(url, options.path.split('/').pop() ?? 'download', options.urlChain)
    item.savePath = options.path
    item.state = 'interrupted'
    item.resumable = true
    item.received = options.offset
    item.etag = options.eTag ?? ''
    item.lastModified = options.lastModified ?? ''
    this.recreated.push({ options, item })
    this.emit('will-download', { preventDefault: vi.fn() }, item, undefined)
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
/** The rename at the end of a download runs on the real file system: wait for it, not a tick count. */
async function settled(done: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('did not settle in time')
    await flush()
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  fakeNet.requests.length = 0
})

/** A page's WebContents as far as the host reads it: the initiator of a download. */
function pageAt(url: string): WebContents {
  return { isDestroyed: () => false, getURL: () => url } as unknown as WebContents
}

function harness(
  options: {
    /** A store shared with an earlier harness: the profile of a restarted app. */
    io?: MemoryIO
    /** Its folder too (the kept partial file lives there). */
    dir?: string
    /** What `net.isOnline()` answers. */
    online?: () => boolean
    now?: () => number
  } = {}
): {
  dir: string
  io: MemoryIO
  host: InstanceType<typeof ElectronDownloads>
  service: InstanceType<typeof DownloadService>
  session: FakeSession
  observer: FakeObserver
  announce: (item: FakeItem, source?: WebContents) => { preventDefault: ReturnType<typeof vi.fn> }
  started: Array<string | null>
  /** Tabs whose pending navigation the host stopped (`bind`'s `stopNavigation`). */
  stopped: string[]
} {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'zen-ext-dl-'))
  if (!options.dir) dirs.push(dir)
  const io = options.io ?? new MemoryIO()
  const host = new ElectronDownloads(
    () => ({ askWhereToSave: false, directory: dir }),
    undefined,
    options.online ?? (() => true)
  )
  const service = new DownloadService(io, host, () => undefined, {
    os: 'linux',
    settings: () => ({ ...DEFAULT_DOWNLOAD_SETTINGS, directory: dir }),
    referrerFamiliar: () => false,
    verdicts: new DangerVerdictRegistry(),
    now: options.now
  })
  const stopped: string[] = []
  host.bind(service, {
    tabIdFor: () => null,
    parentWindow: () => undefined,
    stopNavigation: (tabId) => stopped.push(tabId)
  })
  const observer = new FakeObserver()
  host.observeRequests(observer)
  const session = new FakeSession()
  const started: Array<string | null> = []
  host.attach(session as unknown as Session, 'default', (tabId) => started.push(tabId))
  const announce = (
    item: FakeItem,
    source?: WebContents
  ): { preventDefault: ReturnType<typeof vi.fn> } => {
    const event = { preventDefault: vi.fn() }
    session.emit('will-download', event, item as unknown as ElectronDownloadItem, source)
    return event
  }
  return { dir, io, host, service, session, observer, announce, started, stopped }
}

describe('ElectronDownloads interrupt reasons', () => {
  it('names an interruption from the net error its request ended with', async () => {
    const h = harness()
    expect(h.observer.registrants).toEqual([
      'zenium:downloads',
      'zenium:downloads',
      'zenium:downloads'
    ])
    const item = new FakeItem('https://example.com/a.txt', 'a.txt')
    h.announce(item)
    const record = h.service.items[0]!
    // Another request's failure is nobody's reason here.
    h.observer.fire('onErrorOccurred', {
      url: 'https://elsewhere.example/x',
      error: 'net::ERR_INTERNET_DISCONNECTED'
    })
    h.observer.fire('onErrorOccurred', {
      url: 'https://example.com/a.txt',
      error: 'net::ERR_TIMED_OUT'
    })
    // A timeout is resumable in Chromium's book: the item settles through `updated`.
    item.interrupt()
    expect(record).toMatchObject({
      state: 'interrupted',
      error: 'network-timeout',
      errorMessage: 'Check internet connection',
      canResume: true
    })
    // A net error is checked with the server (Chromium's resume attempts may have got past
    // it); a server that answers well confirms it.
    expect(fakeNet.requests).toHaveLength(1)
    fakeNet.requests[0]!.answer(200)
    await flush()
    expect(record.error).toBe('network-timeout')
  })

  it('a network error noted on the first request is stale once Chromium refused to resume: the server said no', async () => {
    const h = harness()
    const item = new FakeItem('https://example.com/resumed.bin', 'resumed.bin')
    h.announce(item)
    const record = h.service.items[0]!
    // The first request drops mid-body; Chromium resumes on its own (a request the session's
    // webRequest never sees) and the server refuses that with 404: the item ends for good.
    item.received = 524_288
    item.emit('updated', {}, 'progressing')
    h.observer.fire('onErrorOccurred', {
      url: 'https://example.com/resumed.bin',
      error: 'net::ERR_CONTENT_LENGTH_MISMATCH'
    })
    item.received = 0 // Chromium discards the partial file of a non-resumable interruption.
    item.fail()
    await flush()
    // Not the drop (every NETWORK_* reason resumes in Chromium): a refusal, coarse until asked.
    expect(record).toMatchObject({ state: 'interrupted', canResume: false, error: 'server-failed' })
    // The probe re-sends Chromium's resume request from where the transfer had got to.
    const probe = fakeNet.requests[0]!
    expect(probe.headers).toEqual({ Range: 'bytes=524288-' })
    probe.answer(404)
    await flush()
    expect(record).toMatchObject({
      error: 'server-bad-content',
      errorMessage: 'File wasn’t available on site'
    })
  })

  it('a net error that is not the network’s stands on a non-resumable end, and a network one on a resumable end', async () => {
    const h = harness()
    const blocked = new FakeItem('https://example.com/blocked.exe', 'blocked.exe')
    h.announce(blocked)
    h.observer.fire('onErrorOccurred', {
      url: 'https://example.com/blocked.exe',
      error: 'net::ERR_BLOCKED_BY_CLIENT'
    })
    blocked.fail()
    await flush()
    const blockedRecord = h.service.items.find((i) => i.url.endsWith('blocked.exe'))!
    expect(blockedRecord).toMatchObject({ error: 'file-blocked', canResume: false })
    // The server answering fine says nothing against a blocked file.
    fakeNet.requests[0]!.answer(200)
    await flush()
    expect(blockedRecord.error).toBe('file-blocked')

    const dropped = new FakeItem('https://example.com/dropped.bin', 'dropped.bin')
    h.announce(dropped)
    h.observer.fire('onErrorOccurred', {
      url: 'https://example.com/dropped.bin',
      error: 'net::ERR_CONNECTION_RESET'
    })
    dropped.received = 65_536
    dropped.interrupt()
    const droppedRecord = h.service.items.find((i) => i.url.endsWith('dropped.bin'))!
    expect(droppedRecord).toMatchObject({ error: 'network-failed', canResume: true })
    // Asked anyway: Chromium's resume may have met a refusal the first request did not.
    expect(fakeNet.requests[1]!.headers).toEqual({ Range: 'bytes=65536-' })
    fakeNet.requests[1]!.answer(500)
    await flush()
    expect(droppedRecord).toMatchObject({
      error: 'server-failed',
      errorMessage: 'Site wasn’t available'
    })
  })

  it('matches the request over the redirect chain and reads a refusing status', async () => {
    const h = harness()
    const item = new FakeItem('https://cdn.example.com/final.bin', 'final.bin', [
      'https://example.com/start',
      'https://cdn.example.com/final.bin'
    ])
    h.announce(item)
    const record = h.service.items[0]!
    h.observer.fire('onHeadersReceived', { url: 'https://example.com/start', statusCode: 302 })
    h.observer.fire('onHeadersReceived', {
      url: 'https://cdn.example.com/final.bin',
      statusCode: 403
    })
    item.fail()
    await flush()
    expect(record).toMatchObject({ state: 'interrupted', error: 'server-forbidden' })
    expect(record.errorMessage).toBe('File wasn’t available on site')
  })

  it('keeps a refusal seen before the item existed; one that ends for good with nothing noted is the server’s', async () => {
    const h = harness()
    // Chromium judges the response before `will-download`: the 404 arrives first.
    h.observer.fire('onHeadersReceived', { url: 'https://example.com/gone.zip', statusCode: 404 })
    h.observer.fire('onErrorOccurred', {
      url: 'https://example.com/gone.zip',
      error: 'net::ERR_ABORTED'
    })
    const gone = new FakeItem('https://example.com/gone.zip', 'gone.zip')
    h.announce(gone)
    const plain = new FakeItem('https://example.com/plain.zip', 'plain.zip')
    h.announce(plain)
    gone.fail()
    plain.fail()
    await flush()
    expect(
      h.service.item(h.service.items.find((i) => i.url.endsWith('gone.zip'))!.id)
    ).toMatchObject({
      error: 'server-bad-content'
    })
    // Electron's `done` with `interrupted` is Chromium's "cannot resume", which it only says of
    // the server's refusals (network failures resume): coarse `server-failed`, and the probe asks.
    expect(h.service.items.find((i) => i.url.endsWith('plain.zip'))).toMatchObject({
      error: 'server-failed',
      errorMessage: 'Site wasn’t available'
    })
    // The 404 was noted: no need to ask the server about it.
    expect(fakeNet.requests.map((r) => r.options['url'])).toEqual(['https://example.com/plain.zip'])
  })

  it('a resumable interruption with nothing noted stays a network failure (a probe may refine it)', async () => {
    const h = harness()
    const item = new FakeItem('https://example.com/a.bin', 'a.bin')
    h.announce(item)
    const record = h.service.items[0]!
    item.received = 524_288
    item.etag = '"v1"'
    item.interrupt()
    expect(record).toMatchObject({ state: 'interrupted', canResume: true, error: 'network-failed' })
    // The server serves the range: the network was to blame, as Chromium said.
    fakeNet.requests[0]!.answer(206, { 'content-range': 'bytes 524288-4194303/4194304' })
    await flush()
    expect(record.error).toBe('network-failed')
    // Resumed and interrupted again, this time the server refuses the range.
    item.state = 'progressing'
    item.emit('updated', {}, 'progressing')
    item.interrupt()
    expect(fakeNet.requests).toHaveLength(2)
    fakeNet.requests[1]!.answer(416)
    await flush()
    expect(record).toMatchObject({
      state: 'interrupted',
      canResume: true,
      error: 'server-no-range',
      errorMessage: 'Something went wrong'
    })
  })
})

describe('ElectronDownloads probe of a refused resume', () => {
  /** A transfer that received some bytes, then ended non-resumably with nothing noted. */
  async function refused(): Promise<{
    h: ReturnType<typeof harness>
    record: DownloadItem
    probe: (typeof fakeNet.requests)[number]
  }> {
    const h = harness()
    const item = new FakeItem('https://cdn.example.com/expired.bin', 'expired.bin')
    h.announce(item)
    const record = h.service.items[0]!
    item.received = 524_288
    item.etag = '"fixture"'
    item.lastModified = 'Tue, 01 Sep 2026 10:00:00 GMT'
    item.fail()
    await flush()
    expect(record).toMatchObject({ state: 'interrupted', canResume: false, error: 'server-failed' })
    expect(fakeNet.requests).toHaveLength(1)
    return { h, record, probe: fakeNet.requests[0]! }
  }

  it('sends what Chromium’s resume sent, in the record’s session, and stops at the headers', async () => {
    const { h, record, probe } = await refused()
    expect(probe.options).toMatchObject({
      url: 'https://cdn.example.com/expired.bin',
      method: 'GET',
      credentials: 'include',
      cache: 'no-store'
    })
    expect(probe.options['session']).toBe(h.session)
    expect(probe.headers).toEqual({ Range: 'bytes=524288-', 'If-Range': '"fixture"' })
    expect(probe.ended).toBe(true)
    probe.answer(404, { 'content-type': 'text/plain' })
    expect(probe.aborted).toBe(true)
    await flush()
    expect(record).toMatchObject({
      state: 'interrupted',
      error: 'server-bad-content',
      errorMessage: 'File wasn’t available on site'
    })
  })

  it('maps each answer: the exact status, no range, a good answer or no answer as nothing new', async () => {
    const cases: Array<[number, Record<string, string>, string]> = [
      [403, {}, 'server-forbidden'],
      [401, {}, 'server-unauthorized'],
      [407, {}, 'server-unauthorized'],
      [416, {}, 'server-no-range'],
      [500, {}, 'server-failed'],
      [503, {}, 'server-failed'],
      [200, {}, 'server-no-range'],
      // The server serves the range: the refusal was not repeated; Chromium's verdict stands.
      [200, { 'content-range': 'bytes 524288-4194303/4194304' }, 'server-failed'],
      [206, { 'content-range': 'bytes 524288-4194303/4194304' }, 'server-failed']
    ]
    for (const [status, headers, expected] of cases) {
      const { record, probe } = await refused()
      probe.answer(status, headers)
      await flush()
      expect(record.error, `status ${status}`).toBe(expected)
      fakeNet.requests.length = 0
    }
    // The server could not be reached: Chromium's verdict stands.
    const { record, probe } = await refused()
    probe.fail()
    await flush()
    expect(record.error).toBe('server-failed')
  })

  it('a first request that never showed (a programmatic start) is probed from byte 0, without a range', async () => {
    const h = harness()
    const pending = h.host.startDownload({ url: 'https://example.com/gone.zip' })
    const item = new FakeItem('https://example.com/gone.zip', 'gone.zip')
    h.announce(item)
    const record = await pending
    item.fail()
    await flush()
    expect(record.error).toBe('server-failed')
    const probe = fakeNet.requests[0]!
    expect(probe.headers).toEqual({})
    probe.answer(404)
    await flush()
    expect(record.error).toBe('server-bad-content')
  })

  it('asks from where the transfer had got to, even after Chromium restarted it from scratch', async () => {
    const h = harness()
    const item = new FakeItem('https://example.com/ranges.bin', 'ranges.bin')
    h.announce(item)
    const record = h.service.items[0]!
    // 524288 bytes in, the connection drops; Chromium's resume is refused with 416, so it
    // restarts from byte 0 (the item reads 0 again), gets as far, is refused again, and after
    // its automatic attempts settles interrupted, resumable by the user, with nothing on disk.
    for (const received of [131_072, 524_288, 0, 262_144, 524_288, 0]) {
      item.received = received
      item.emit('updated', {}, 'progressing')
    }
    item.interrupt()
    expect(record).toMatchObject({ state: 'interrupted', canResume: true, error: 'network-failed' })
    const probe = fakeNet.requests[0]!
    expect(probe.headers).toEqual({ Range: 'bytes=524288-' })
    probe.answer(416)
    await flush()
    expect(record).toMatchObject({ error: 'server-no-range', errorMessage: 'Something went wrong' })
  })

  it('leaves a row alone that was retried or removed while the server was being asked', async () => {
    const { h, record, probe } = await refused()
    h.service.remove(record.id)
    probe.answer(404)
    await flush()
    expect(h.service.items).toHaveLength(0)
    expect(record.error).toBe('server-failed')
  })

  it('does not read its own request as the transfer’s refusal', async () => {
    const { h, record, probe } = await refused()
    // The probe's request passes the session's webRequest like any other, outside a tab.
    h.observer.fire('onBeforeRequest', {
      requestId: 'probe-1',
      url: 'https://cdn.example.com/expired.bin',
      resourceType: 'other',
      tabId: null
    })
    h.observer.fire('onHeadersReceived', {
      requestId: 'probe-1',
      url: 'https://cdn.example.com/expired.bin',
      resourceType: 'other',
      tabId: null,
      statusCode: 403
    })
    probe.answer(403)
    h.observer.fire('onErrorOccurred', {
      requestId: 'probe-1',
      url: 'https://cdn.example.com/expired.bin',
      error: 'net::ERR_ABORTED'
    })
    await flush()
    expect(record.error).toBe('server-forbidden')
    // Nothing was parked for the URL: a fresh transfer of it that drops resumably reads plainly.
    const again = new FakeItem('https://cdn.example.com/expired.bin', 'expired.bin')
    h.announce(again)
    again.interrupt()
    expect(h.service.items[0]!.error).toBe('network-failed')
  })
})

describe('ElectronDownloads dead download links', () => {
  const refusal = (
    over: Partial<WebRequestDetails> & { url: string; statusCode: number }
  ): Partial<WebRequestDetails> & { url: string } => ({
    requestId: 'nav-1',
    resourceType: 'main_frame',
    tabId: 't1',
    partition: 'default',
    initiator: 'https://example.com',
    responseHeaders: {
      'Content-Type': ['application/zip; charset=binary'],
      'Content-Disposition': ['attachment; filename="gone.zip"']
    },
    ...over
  })

  it('a frame navigation the server refuses with an attachment becomes the failed row Chrome shows', async () => {
    const h = harness()
    h.observer.fire(
      'onHeadersReceived',
      refusal({ url: 'https://example.com/dl/42', statusCode: 404 })
    )
    expect(h.service.items).toHaveLength(1)
    const record = h.service.items[0]!
    expect(record).toMatchObject({
      url: 'https://example.com/dl/42',
      filename: 'gone.zip',
      finalName: 'gone.zip',
      mimeType: 'application/zip',
      state: 'interrupted',
      error: 'server-bad-content',
      errorMessage: 'File wasn’t available on site',
      canResume: false,
      receivedBytes: 0,
      totalBytes: 0,
      savePath: '',
      referrer: 'https://example.com',
      containerId: 'default',
      private: false
    })
    expect(record.endedAt).toBeDefined()
    // Announced like a download that started, from its tab; the tab's failure is this row's.
    expect(h.started).toEqual(['t1'])
    expect(h.service.takeDeadLink('t1', 'https://example.com/dl/42')).toBe(true)
    // The tab's navigation was stopped while the response was still held, so no error document
    // of Chromium's commits over the page (the page stays, as Chrome's does).
    expect(h.stopped).toEqual(['t1'])
    // The navigation's own error follows and parks nothing: a later transfer of the URL that
    // ends non-resumably reads by Chromium's verdict, not by a stale note.
    h.observer.fire('onErrorOccurred', {
      requestId: 'nav-1',
      url: 'https://example.com/dl/42',
      error: 'net::ERR_INVALID_RESPONSE'
    })
    h.service.remove(record.id)
    const again = new FakeItem('https://example.com/dl/42', 'gone.zip')
    h.announce(again)
    again.fail()
    await flush()
    expect(h.service.items[0]!.error).toBe('server-failed')
    expect(fakeNet.requests).toHaveLength(1)
  })

  it('reads the reason from the status and the name from the header or the URL', () => {
    const h = harness()
    h.observer.fire(
      'onHeadersReceived',
      refusal({
        requestId: 'a',
        url: 'https://example.com/files/r%C3%A9sum%C3%A9.pdf',
        statusCode: 403,
        resourceType: 'sub_frame',
        responseHeaders: { 'content-disposition': ['attachment'] }
      })
    )
    h.observer.fire(
      'onHeadersReceived',
      refusal({
        requestId: 'b',
        url: 'https://example.com/get?id=7',
        statusCode: 500,
        responseHeaders: {
          'Content-Disposition': [
            'attachment; filename="cv.pdf"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.pdf'
          ]
        }
      })
    )
    h.observer.fire(
      'onHeadersReceived',
      refusal({
        requestId: 'c',
        url: 'https://example.com/',
        statusCode: 401,
        responseHeaders: { 'Content-Disposition': ['ATTACHMENT'] }
      })
    )
    expect(h.service.items.map((i) => [i.filename, i.error, i.mimeType])).toEqual([
      ['download', 'server-unauthorized', ''],
      ['résumé.pdf', 'server-failed', ''],
      ['résumé.pdf', 'server-forbidden', '']
    ])
    // A frame's dead link keeps to its frame (Chromium's error document there, as in Chrome);
    // only the tab's own navigations are stopped.
    expect(h.stopped).toEqual(['t1', 't1'])
  })

  it('is for frames only, for attachments only, and keeps private rows private', () => {
    const h = harness()
    // A fetch or XHR never becomes a download, whatever it answers.
    h.observer.fire(
      'onHeadersReceived',
      refusal({
        url: 'https://example.com/api/file',
        statusCode: 404,
        resourceType: 'xmlhttprequest'
      })
    )
    h.observer.fire(
      'onHeadersReceived',
      refusal({ url: 'https://example.com/img.png', statusCode: 404, resourceType: 'image' })
    )
    // A page that is simply missing is the tab's business (and its refusal waits for an item).
    h.observer.fire(
      'onHeadersReceived',
      refusal({
        url: 'https://example.com/missing.html',
        statusCode: 404,
        responseHeaders: { 'Content-Type': ['text/html'] }
      })
    )
    h.observer.fire(
      'onHeadersReceived',
      refusal({
        url: 'https://example.com/inline.pdf',
        statusCode: 404,
        responseHeaders: { 'Content-Disposition': ['inline; filename="inline.pdf"'] }
      })
    )
    // A response the download proceeds under is no dead link either.
    h.observer.fire(
      'onHeadersReceived',
      refusal({ url: 'https://example.com/ok.zip', statusCode: 200 })
    )
    expect(h.service.items).toHaveLength(0)
    expect(h.started).toEqual([])
    h.observer.fire(
      'onHeadersReceived',
      refusal({
        url: 'https://example.com/secret.zip',
        statusCode: 403,
        partition: PRIVATE_CONTAINER_ID,
        tabId: 't9'
      })
    )
    expect(h.service.items[0]).toMatchObject({
      private: true,
      containerId: PRIVATE_CONTAINER_ID,
      error: 'server-forbidden'
    })
    expect(h.service.visibleTo(false)).toEqual([])
    expect(h.service.takeDeadLink('t9', 'https://example.com/secret.zip')).toBe(true)
  })
})

describe('ElectronDownloads interrupt reasons (updated)', () => {
  it('reports the reason through the updated event too, once per interruption', async () => {
    const h = harness()
    const item = new FakeItem('https://example.com/a.txt', 'a.txt')
    h.announce(item)
    const record = h.service.items[0]!
    h.observer.fire('onErrorOccurred', {
      url: 'https://example.com/a.txt',
      error: 'net::ERR_CONNECTION_FAILED'
    })
    item.state = 'interrupted'
    item.emit('updated', {}, 'interrupted')
    expect(record).toMatchObject({ state: 'interrupted', error: 'network-server-down' })
    // Resumed, then interrupted again without a new error: the old reason is not replayed.
    item.state = 'progressing'
    item.emit('updated', {}, 'progressing')
    expect(record.error).toBeUndefined()
    item.state = 'interrupted'
    item.emit('updated', {}, 'interrupted')
    expect(record.error).toBe('network-failed')
  })
})

describe('ElectronDownloads file state', () => {
  it('exists is a stat on the released file; deleteFile removes it or says why not', async () => {
    const h = harness()
    const item = new FakeItem('https://example.com/a.txt', 'a.txt')
    h.announce(item)
    const record = h.service.items[0]!
    item.complete()
    await settled(() => record.state === 'completed')
    expect(record.savePath).toBe(join(h.dir, 'a.txt'))
    await expect(h.host.exists(record)).resolves.toBe(true)
    await expect(h.host.deleteFile(record)).resolves.toBe('deleted')
    expect(existsSync(record.savePath)).toBe(false)
    await expect(h.host.exists(record)).resolves.toBe(false)
    await expect(h.host.deleteFile(record)).resolves.toBe('missing')
    await expect(h.host.exists({ ...record, savePath: '' })).resolves.toBe(false)
    await expect(h.host.deleteFile({ ...record, savePath: '' })).resolves.toBe('missing')
    // A folder in the file's place is neither the file nor ours to remove.
    const folder = { ...record, savePath: h.dir }
    await expect(h.host.exists(folder)).resolves.toBe(false)
    await expect(h.host.deleteFile(folder)).resolves.toBe('failed')
    expect(existsSync(h.dir)).toBe(true)
  })

  it('the service’s deleteFile marks the row and Retry downloads the file again into it', async () => {
    const h = harness()
    const item = new FakeItem('https://example.com/a.txt', 'a.txt')
    h.announce(item)
    const record = h.service.items[0]!
    item.complete()
    await settled(() => record.state === 'completed')
    await expect(h.service.deleteFile(record.id)).resolves.toBe('deleted')
    expect(record.fileMissing).toBe(true)
    expect(existsSync(join(h.dir, 'a.txt'))).toBe(false)
    h.service.resume(record.id)
    expect(h.session.started.map((s) => s.url)).toEqual(['https://example.com/a.txt'])
    const again = new FakeItem('https://example.com/a.txt', 'a.txt')
    h.announce(again)
    expect(h.service.items).toHaveLength(1)
    expect(record.state).toBe('progressing')
    expect(record.fileMissing).toBeUndefined()
    again.complete()
    await settled(() => record.state === 'completed')
    expect(record.savePath).toBe(join(h.dir, 'a.txt'))
    expect(readFileSync(record.savePath, 'utf8')).toBe('abc')
    expect(record.fileMissing).toBeUndefined()
  })
})

describe('ElectronDownloads programmatic starts', () => {
  it('starts by URL, correlates the announced item and places it under the suggested name', async () => {
    const h = harness()
    const pending = h.host.startDownload({
      url: 'https://example.com/a.txt',
      headers: { 'X-Token': 't' },
      suggestion: { filename: 'sub/renamed.txt', conflictAction: 'uniquify' }
    })
    expect(h.session.started).toEqual([
      { url: 'https://example.com/a.txt', options: { headers: { 'X-Token': 't' } } }
    ])
    const other = new FakeItem('https://example.com/other.txt', 'other.txt')
    h.announce(other)
    const item = new FakeItem('https://example.com/a.txt', 'a.txt')
    h.announce(item)
    const record = await pending
    expect(record.url).toBe('https://example.com/a.txt')
    expect(h.service.items.map((i) => i.url)).toEqual([record.url, other.url])
    await flush()
    expect(h.host.targetPath(record.id)).toBe(join(h.dir, 'sub', 'renamed.txt'))
    expect(record.finalName).toBe('renamed.txt')
    // The other item kept the default name; a page download is announced, the API's is not.
    expect(h.host.targetPath(h.service.items[1]!.id)).toBe(join(h.dir, 'other.txt'))
    expect(h.started).toEqual([null, null])
    item.complete()
    await settled(() => record.savePath === join(h.dir, 'sub', 'renamed.txt'))
    expect(record.state).toBe('completed')
    expect(record.savePath).toBe(join(h.dir, 'sub', 'renamed.txt'))
    expect(readFileSync(record.savePath, 'utf8')).toBe('abc')
  })

  it('rejects when nothing is announced in time', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      const pending = expect(
        h.host.startDownload({ url: 'https://example.com/never.txt' })
      ).rejects.toThrow('NETWORK_TIMEOUT')
      await vi.advanceTimersByTimeAsync(60_000)
      await pending
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ElectronDownloads filename determiner', () => {
  it('asks once per new download and applies the answer, overwriting when told to', async () => {
    const h = harness()
    writeFileSync(join(h.dir, 'chosen.txt'), 'old')
    const asked: Array<{ id: string; suggested: string }> = []
    h.host.setFilenameDeterminer(async (record: DownloadItem, suggested: string) => {
      asked.push({ id: record.id, suggested })
      return { filename: 'chosen.txt', conflictAction: 'overwrite' }
    })
    const item = new FakeItem('https://example.com/a.txt', 'a.txt')
    h.announce(item)
    const record = h.service.items[0]!
    expect(item.savePath).toBe(join(h.dir, 'a.txt.zeniumdownload'))
    await flush()
    expect(asked).toEqual([{ id: record.id, suggested: 'a.txt' }])
    expect(h.host.targetPath(record.id)).toBe(join(h.dir, 'chosen.txt'))
    item.complete()
    await settled(() => record.savePath === join(h.dir, 'chosen.txt'))
    expect(record.savePath).toBe(join(h.dir, 'chosen.txt'))
    expect(readFileSync(record.savePath, 'utf8')).toBe('abc')
    expect(existsSync(join(h.dir, 'chosen(1).txt'))).toBe(false)
  })

  it('numbers a taken name under uniquify and keeps the default on null', async () => {
    const h = harness()
    writeFileSync(join(h.dir, 'taken.txt'), 'old')
    let answer: { filename: string; conflictAction: 'uniquify' } | null = {
      filename: 'taken.txt',
      conflictAction: 'uniquify'
    }
    h.host.setFilenameDeterminer(async () => answer)
    const first = new FakeItem('https://example.com/a.txt', 'a.txt')
    h.announce(first)
    await flush()
    expect(h.host.targetPath(h.service.items[0]!.id)).toBe(join(h.dir, 'taken(1).txt'))
    answer = null
    const second = new FakeItem('https://example.com/b.txt', 'b.txt')
    h.announce(second)
    await flush()
    expect(h.host.targetPath(h.service.items[0]!.id)).toBe(join(h.dir, 'b.txt'))
    h.host.setFilenameDeterminer(null)
  })

  it('waits for a slow determiner before releasing a fast download', async () => {
    const h = harness()
    let answer: ((s: { filename: string; conflictAction: 'uniquify' } | null) => void) | null = null
    h.host.setFilenameDeterminer(() => new Promise((resolve) => (answer = resolve)))
    const item = new FakeItem('https://example.com/fast.txt', 'fast.txt')
    h.announce(item)
    const record = h.service.items[0]!
    item.complete()
    await flush()
    expect(record.state).toBe('progressing')
    expect(existsSync(join(h.dir, 'fast.txt'))).toBe(false)
    answer!({ filename: 'late.txt', conflictAction: 'uniquify' })
    await settled(() => record.savePath === join(h.dir, 'late.txt'))
    expect(record.state).toBe('completed')
    expect(record.savePath).toBe(join(h.dir, 'late.txt'))
  })
})

describe('ElectronDownloads insecure downloads (HB-44)', () => {
  it('refuses a secure page’s download over a plain hop before it writes; Keep anyway requests it again into the same row', async () => {
    const h = harness()
    const item = new FakeItem('http://cdn.example.com/notes.zip', 'notes.zip', [
      'https://example.com/dl',
      'http://cdn.example.com/notes.zip'
    ])
    const event = h.announce(item, pageAt('https://example.com/page'))
    // Electron's way of cancelling the item before it opens its file.
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(h.service.items).toHaveLength(1)
    const record = h.service.items[0]!
    expect(record).toMatchObject({
      state: 'insecure-blocked',
      savePath: '',
      receivedBytes: 0,
      canResume: false,
      referrer: 'https://example.com/page',
      danger: { level: 'safe' }
    })
    expect(record.error).toBeUndefined()
    // The reserved name is given back: a later download may take `notes.zip`.
    expect(h.host.targetPath(record.id)).toBeNull()
    // The panel still opens on the row, as on any new download.
    expect(h.started).toEqual([null])
    // Nothing the refused item says later reaches the row.
    item.emit('updated', {}, 'progressing')
    item.fail()
    await flush()
    expect(record.state).toBe('insecure-blocked')

    // Keep anyway: the same URL is requested again with the page as referrer …
    await h.service.acceptDanger(record.id)
    expect(record.insecureAccepted).toBe(true)
    expect(h.session.started).toEqual([
      {
        url: 'http://cdn.example.com/notes.zip',
        options: { headers: { Referer: 'https://example.com/page' } }
      }
    ])
    // … and the item that answers continues the row, unblocked this time.
    const again = new FakeItem('http://cdn.example.com/notes.zip', 'notes.zip')
    const second = h.announce(again)
    expect(second.preventDefault).not.toHaveBeenCalled()
    expect(h.service.items).toHaveLength(1)
    expect(record.state).toBe('progressing')
    expect(record.savePath).toBe(join(h.dir, 'notes.zip.zeniumdownload'))
    again.complete()
    await settled(() => record.state === 'completed')
    expect(record.savePath).toBe(join(h.dir, 'notes.zip'))
    expect(readFileSync(record.savePath, 'utf8')).toBe('abc')
  })

  it('offers no Keep anyway for a dangerous type, and lets every secure chain through', async () => {
    const h = harness()
    // The harness runs the Linux table: a `.deb` is the installer flagged there (an `.exe` is
    // Windows's, per Chromium's platform bits).
    const installer = new FakeItem('http://example.com/setup.deb', 'setup.deb')
    h.announce(installer, pageAt('https://example.com/downloads'))
    const blocked = h.service.items[0]!
    expect(blocked).toMatchObject({
      state: 'insecure-blocked',
      danger: { level: 'dangerous', reason: 'executable' }
    })
    await h.service.acceptDanger(blocked.id)
    expect(blocked.insecureAccepted).toBeUndefined()
    expect(h.session.started).toEqual([])
    // Discard drops the row; nothing was on disk.
    await h.service.discard(blocked.id)
    expect(h.service.items).toHaveLength(0)

    // Secure all the way, a loopback hop, or a plain page: not this rule's business.
    const fine = [
      new FakeItem('https://cdn.example.com/a.txt', 'a.txt', [
        'https://example.com/dl',
        'https://cdn.example.com/a.txt'
      ]),
      new FakeItem('http://localhost:3000/b.txt', 'b.txt')
    ]
    for (const item of fine) {
      const event = h.announce(item, pageAt('https://example.com/page'))
      expect(event.preventDefault).not.toHaveBeenCalled()
    }
    const plainPage = new FakeItem('http://example.com/c.txt', 'c.txt')
    expect(
      h.announce(plainPage, pageAt('http://example.com/page')).preventDefault
    ).not.toHaveBeenCalled()
    expect(h.service.items.map((i) => i.state)).toEqual([
      'progressing',
      'progressing',
      'progressing'
    ])
  })
})

describe('ElectronDownloads resume after a restart (HB-42)', () => {
  it('re-creates the kept partial file with createInterruptedDownload and continues the same row', async () => {
    const first = harness()
    const item = new FakeItem('https://example.com/big.bin', 'big.bin')
    item.etag = '"v1"'
    item.lastModified = 'Mon, 21 Sep 2026 10:00:00 GMT'
    first.announce(item)
    const record = first.service.items[0]!
    expect(record).toMatchObject({ canResume: true, etag: '"v1"' })
    // Two of three bytes are in the partial file when the app quits.
    writeFileSync(record.savePath, 'ab')
    item.received = 2
    item.emit('updated', {}, 'progressing')
    expect(record.receivedBytes).toBe(2)
    first.service.shutdown()
    first.service.flushSync()
    expect(record).toMatchObject({ state: 'interrupted', error: 'user-shutdown', canResume: true })
    // The partial was parked under another name so Chromium's own cancel misses it.
    expect(record.savePath).not.toBe(join(first.dir, 'big.bin.zeniumdownload'))
    expect(record.savePath.endsWith('.zeniumdownload')).toBe(true)
    expect(existsSync(record.savePath)).toBe(true)

    // The next launch: the row is offered as interrupted, nothing runs on its own …
    const next = harness({ io: first.io, dir: first.dir })
    expect(next.service.items).toHaveLength(1)
    const row = next.service.items[0]!
    expect(row).toMatchObject({ id: record.id, state: 'interrupted', canResume: true })
    expect(row.autoResumeAt).toBeUndefined()
    expect(next.session.recreated).toHaveLength(0)
    // … until Resume: Electron gets the kept file, its size as the offset and the validators.
    next.service.resume(row.id)
    expect(next.session.recreated).toHaveLength(1)
    const { options, item: recreated } = next.session.recreated[0]!
    expect(options).toEqual({
      path: record.savePath,
      urlChain: ['https://example.com/big.bin'],
      mimeType: 'text/plain',
      offset: 2,
      length: 3,
      lastModified: 'Mon, 21 Sep 2026 10:00:00 GMT',
      eTag: '"v1"',
      startTime: Math.floor(record.startedAt / 1000)
    })
    // The item Electron made for it continued the row (no second row) and was started.
    expect(next.service.items).toHaveLength(1)
    expect(row.state).toBe('progressing')
    expect(row.receivedBytes).toBe(2)
    await flush()
    expect(recreated.resumed).toBe(1)
    expect(next.started).toEqual([])
    // The rest arrives; the file lands under its own name.
    recreated.complete()
    await settled(() => row.state === 'completed')
    expect(row.savePath).toBe(join(first.dir, 'big.bin'))
    expect(existsSync(record.savePath)).toBe(false)
  })

  it('starts over through downloadURL when the kept file is gone', () => {
    const first = harness()
    const item = new FakeItem('https://example.com/gone.bin', 'gone.bin')
    item.etag = '"v1"'
    first.announce(item)
    const record = first.service.items[0]!
    writeFileSync(record.savePath, 'a')
    first.service.shutdown()
    first.service.flushSync()
    rmSync(record.savePath)
    const next = harness({ io: first.io, dir: first.dir })
    const row = next.service.items[0]!
    next.service.resume(row.id)
    expect(next.session.recreated).toHaveLength(0)
    expect(next.session.started).toEqual([
      { url: 'https://example.com/gone.bin', options: undefined }
    ])
  })
})

describe('ElectronDownloads automatic resume (HB-43)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resumes a transient network interruption after 2, 4 and 8 s, then leaves the row to the user', () => {
    vi.useFakeTimers()
    const clock = { now: 1_000_000 }
    vi.setSystemTime(clock.now)
    const h = harness({ now: () => Date.now() })
    const item = new FakeItem('https://example.com/flaky.bin', 'flaky.bin')
    item.etag = '"v1"'
    h.announce(item)
    const record = h.service.items[0]!
    h.observer.fire('onErrorOccurred', {
      url: 'https://example.com/flaky.bin',
      error: 'net::ERR_CONNECTION_RESET'
    })
    item.interrupt()
    expect(record).toMatchObject({ state: 'interrupted', error: 'network-failed', canResume: true })
    expect(record.autoResumeAt).toBe(Date.now() + AUTO_RESUME_DELAYS_MS[0]!)
    for (const [attempt, delay] of AUTO_RESUME_DELAYS_MS.entries()) {
      expect(item.resumed).toBe(attempt)
      vi.advanceTimersByTime(delay - 1)
      expect(item.resumed).toBe(attempt)
      vi.advanceTimersByTime(1)
      // The core's resume is the user's path: the engine's item is asked to resume.
      expect(item.resumed).toBe(attempt + 1)
      expect(record.autoResumeAt).toBeUndefined()
      // It fails the same way again.
      item.interrupt()
      const next = AUTO_RESUME_DELAYS_MS[attempt + 1]
      if (next === undefined) expect(record.autoResumeAt).toBeUndefined()
      else expect(record.autoResumeAt).toBe(Date.now() + next)
    }
    // The fourth failure in a row: interrupted for good, Resume still offered.
    vi.advanceTimersByTime(60_000)
    expect(item.resumed).toBe(AUTO_RESUME_DELAYS_MS.length)
    expect(record).toMatchObject({ state: 'interrupted', canResume: true })
  })

  it('holds the attempt until net.isOnline says yes, polling while it waits', () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)
    let online = false
    const h = harness({ online: () => online, now: () => Date.now() })
    const item = new FakeItem('https://example.com/offline.bin', 'offline.bin')
    item.etag = '"v1"'
    h.announce(item)
    const record = h.service.items[0]!
    h.observer.fire('onErrorOccurred', {
      url: 'https://example.com/offline.bin',
      error: 'net::ERR_INTERNET_DISCONNECTED'
    })
    item.interrupt()
    expect(record.error).toBe('network-disconnected')
    vi.advanceTimersByTime(AUTO_RESUME_DELAYS_MS[0]!)
    // The step is over but the network is not back: the attempt waits, polled every 2 s.
    expect(item.resumed).toBe(0)
    vi.advanceTimersByTime(ONLINE_POLL_MS * 3)
    expect(item.resumed).toBe(0)
    online = true
    vi.advanceTimersByTime(ONLINE_POLL_MS)
    expect(item.resumed).toBe(1)
    expect(record.autoResumeAt).toBeUndefined()
    // Bytes arriving start the count over: the next interruption waits 2 s again.
    item.received = 1
    item.emit('updated', {}, 'progressing')
    item.interrupt()
    expect(record.autoResumeAt).toBe(Date.now() + AUTO_RESUME_DELAYS_MS[0]!)
  })

  it('never retries a server’s refusal, a user’s stop, or a row without a resumable file', () => {
    vi.useFakeTimers()
    const h = harness({ now: () => Date.now() })
    const refused = new FakeItem('https://example.com/missing.bin', 'missing.bin')
    refused.etag = '"v1"'
    h.announce(refused)
    const row = h.service.items[0]!
    h.observer.fire('onHeadersReceived', {
      url: 'https://example.com/missing.bin',
      statusCode: 404
    })
    refused.fail()
    expect(row).toMatchObject({ state: 'interrupted', error: 'server-bad-content' })
    expect(row.autoResumeAt).toBeUndefined()

    const paused = new FakeItem('https://example.com/user.bin', 'user.bin')
    paused.etag = '"v1"'
    h.announce(paused)
    const userRow = h.service.items[0]!
    h.observer.fire('onErrorOccurred', {
      url: 'https://example.com/user.bin',
      error: 'net::ERR_TIMED_OUT'
    })
    paused.interrupt()
    expect(userRow.autoResumeAt).toBeDefined()
    // The user's own Resume drops the schedule; their Cancel drops it too.
    h.service.resume(userRow.id)
    expect(paused.resumed).toBe(1)
    expect(userRow.autoResumeAt).toBeUndefined()
    // Chromium reports the resumed item in progress before it can fail again.
    paused.emit('updated', {}, 'progressing')
    paused.interrupt()
    expect(userRow.autoResumeAt).toBeDefined()
    h.service.cancel(userRow.id)
    expect(userRow.state).toBe('cancelled')
    expect(userRow.autoResumeAt).toBeUndefined()
    vi.advanceTimersByTime(60_000)
    expect(paused.resumed).toBe(1)
    expect(refused.resumed).toBe(0)
  })
})
