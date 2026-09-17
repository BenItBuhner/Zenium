import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Session, DownloadItem as ElectronDownloadItem } from 'electron'
import type { DownloadItem } from '../../../shared/types'
import type { StoreIO } from '../../../core/platform'
import { DEFAULT_DOWNLOAD_SETTINGS } from '../../../shared/downloads'

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
}

class FakeSession extends EventEmitter {
  started: Array<{ url: string; options: unknown }> = []
  downloadURL(url: string, options?: unknown): void {
    this.started.push({ url, options })
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function harness(): {
  dir: string
  host: InstanceType<typeof ElectronDownloads>
  service: InstanceType<typeof DownloadService>
  session: FakeSession
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
  const session = new FakeSession()
  const started: Array<string | null> = []
  host.attach(session as unknown as Session, 'default', (tabId) => started.push(tabId))
  const announce = (item: FakeItem): void => {
    session.emit('will-download', {}, item as unknown as ElectronDownloadItem, undefined)
  }
  return { dir, host, service, session, announce, started }
}

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
    await flush()
    await flush()
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
    await flush()
    await flush()
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
    await flush()
    await flush()
    expect(record.state).toBe('completed')
    expect(record.savePath).toBe(join(h.dir, 'late.txt'))
  })
})
