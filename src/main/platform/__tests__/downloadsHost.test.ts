import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Session, DownloadItem as ElectronDownloadItem } from 'electron'
import type { DownloadItem } from '../../../shared/types'
import type { StoreIO } from '../../../core/platform'
import { DEFAULT_DOWNLOAD_SETTINGS } from '../../../shared/downloads'
import type { RequestObserver } from '../downloads'
import type { WebRequestDetails, WebRequestEvent, WebRequestListener } from '../webRequest'

vi.mock('electron', () => ({
  app: { getPath: () => '/nowhere' },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() }
}))

const { ElectronDownloads } = await import('../downloads')
const { DownloadService } = await import('../../../core/downloads')
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
    return this.state === 'completed' ? 3 : 0
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
    return ''
  }
  getLastModifiedTime(): string {
    return ''
  }
  isPaused(): boolean {
    return this.paused
  }
  getState(): string {
    return this.state
  }
  canResume(): boolean {
    return false
  }
  pause(): void {
    this.paused = true
  }
  resume(): void {
    this.paused = false
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

class FakeSession extends EventEmitter {
  started: Array<{ url: string; options: unknown }> = []
  downloadURL(url: string, options?: unknown): void {
    this.started.push({ url, options })
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
})

function harness(): {
  dir: string
  host: InstanceType<typeof ElectronDownloads>
  service: InstanceType<typeof DownloadService>
  session: FakeSession
  observer: FakeObserver
  announce: (item: FakeItem) => void
  started: Array<string | null>
} {
  const dir = mkdtempSync(join(tmpdir(), 'zen-ext-dl-'))
  dirs.push(dir)
  const host = new ElectronDownloads(() => ({ askWhereToSave: false, directory: dir }))
  const service = new DownloadService(new MemoryIO(), host, () => undefined, {
    os: 'linux',
    settings: () => ({ ...DEFAULT_DOWNLOAD_SETTINGS, directory: dir }),
    referrerFamiliar: () => false,
    verdicts: new DangerVerdictRegistry()
  })
  host.bind(service, { tabIdFor: () => null, parentWindow: () => undefined })
  const observer = new FakeObserver()
  host.observeRequests(observer)
  const session = new FakeSession()
  const started: Array<string | null> = []
  host.attach(session as unknown as Session, 'default', (tabId) => started.push(tabId))
  const announce = (item: FakeItem): void => {
    session.emit('will-download', {}, item as unknown as ElectronDownloadItem, undefined)
  }
  return { dir, host, service, session, observer, announce, started }
}

describe('ElectronDownloads interrupt reasons', () => {
  it('names an interruption from the net error its request ended with', async () => {
    const h = harness()
    expect(h.observer.registrants).toEqual(['zenium:downloads', 'zenium:downloads'])
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
    item.fail()
    await flush()
    expect(record).toMatchObject({
      state: 'interrupted',
      error: 'network-timeout',
      errorMessage: 'Check internet connection',
      canResume: false
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

  it('keeps a refusal seen before the item existed, and a transfer without one fails plainly', async () => {
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
    expect(h.service.items.find((i) => i.url.endsWith('plain.zip'))).toMatchObject({
      error: 'network-failed',
      errorMessage: 'Check internet connection'
    })
  })

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
