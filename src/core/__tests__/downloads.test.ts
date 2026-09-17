import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DownloadService,
  RateEstimator,
  canRetry,
  estimateEta,
  isQuarantined,
  migrate,
  type DownloadChange,
  type DownloadServiceDeps,
  type ProgressWindow
} from '../downloads'
import type { DownloadHost, StoreIO } from '../platform'
import type { DangerVerdictProvider } from '../downloadDanger'
import type { DownloadItem, DownloadSettings } from '../../shared/types'
import { DEFAULT_DOWNLOAD_SETTINGS } from '../../shared/downloads'

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

interface Call {
  method: keyof DownloadHost
  id: string
}

class FakeHost implements DownloadHost {
  calls: Call[] = []
  releaseResult: { savePath: string; filename: string } | null | 'derive' = 'derive'
  notified: string[] = []
  opened: string[] = []
  pause(id: string): void {
    this.calls.push({ method: 'pause', id })
  }
  resume(item: DownloadItem): void {
    this.calls.push({ method: 'resume', id: item.id })
  }
  cancel(id: string): void {
    this.calls.push({ method: 'cancel', id })
  }
  retry(item: DownloadItem): void {
    this.calls.push({ method: 'retry', id: item.id })
  }
  async release(item: DownloadItem): Promise<{ savePath: string; filename: string } | null> {
    this.calls.push({ method: 'release', id: item.id })
    if (this.releaseResult !== 'derive') return this.releaseResult
    return { savePath: item.savePath.replace('.zeniumdownload', ''), filename: item.filename }
  }
  async discard(item: DownloadItem): Promise<void> {
    this.calls.push({ method: 'discard', id: item.id })
  }
  async open(item: DownloadItem): Promise<void> {
    this.opened.push(item.id)
  }
  showInFolder(item: DownloadItem): void {
    this.calls.push({ method: 'showInFolder', id: item.id })
  }
  notifyCompleted(item: DownloadItem): void {
    this.notified.push(item.id)
  }
  async chooseLocation(): Promise<string | null> {
    return '/picked'
  }
  count(method: keyof DownloadHost): number {
    return this.calls.filter((c) => c.method === method).length
  }
}

class FakeWindow implements ProgressWindow {
  bars: Array<{ value: number; mode?: string }> = []
  alive = true
  readonly host = {
    setProgressBar: (value: number, mode?: 'normal' | 'indeterminate' | 'paused'): void => {
      this.bars.push({ value, mode })
    }
  }
  constructor(readonly id: string) {}
  get last(): { value: number; mode?: string } | undefined {
    return this.bars[this.bars.length - 1]
  }
}

interface Harness {
  io: MemoryIO
  host: FakeHost
  service: DownloadService
  windows: FakeWindow[]
  changes: Array<{ id: string; kind: DownloadChange }>
  settings: DownloadSettings
  familiar: Set<string>
  clock: { now: number }
}

function harness(overrides: Partial<DownloadServiceDeps> = {}, io = new MemoryIO()): Harness {
  const host = new FakeHost()
  const windows = [new FakeWindow('w1'), new FakeWindow('w2')]
  const changes: Array<{ id: string; kind: DownloadChange }> = []
  const settings: DownloadSettings = { ...DEFAULT_DOWNLOAD_SETTINGS }
  const familiar = new Set<string>()
  const clock = { now: 1_000_000 }
  const service = new DownloadService(
    io,
    host,
    (item, kind) => changes.push({ id: item.id, kind }),
    {
      os: 'win32',
      settings: () => settings,
      windowForTab: (tabId) => (tabId === 't2' ? windows[1]! : windows[0]!),
      windows: () => windows,
      referrerFamiliar: (referrer) => familiar.has(new URL(referrer).host),
      now: () => clock.now,
      ...overrides
    }
  )
  return { io, host, service, windows, changes, settings, familiar, clock }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function begin(
  h: Harness,
  over: Partial<Parameters<DownloadService['begin']>[0]> = {}
): DownloadItem {
  return h.service.begin({
    url: 'https://cdn.example.com/report.pdf',
    referrer: 'https://example.com/page',
    filename: 'report.pdf',
    totalBytes: 1000,
    mimeType: 'application/pdf',
    savePath: '/dl/report.pdf.zeniumdownload',
    sourceTabId: 't1',
    canResume: true,
    ...over
  })
}

describe('DownloadService state machine', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('begins in progress with the danger verdict and the record on top of the list', () => {
    const item = begin(h)
    expect(item.state).toBe('in-progress')
    expect(item.danger).toEqual({ level: 'safe', reason: 'none' })
    expect(h.service.items[0]).toBe(item)
    expect(h.changes).toEqual([{ id: item.id, kind: 'started' }])
    expect(h.service.inFlight).toHaveLength(1)
  })

  it('tracks progress, speed and ETA, and persists on the way', () => {
    const item = begin(h)
    h.clock.now += 1000
    h.service.progress(item.id, { receivedBytes: 200, state: 'in-progress' })
    h.clock.now += 1000
    h.service.progress(item.id, { receivedBytes: 400, state: 'in-progress' })
    expect(item.receivedBytes).toBe(400)
    expect(item.bytesPerSecond).toBe(200)
    expect(item.etaMs).toBe(3000)
    h.service.flushSync()
    const stored = JSON.parse(h.io.files.get('downloads.json')!) as {
      version: number
      items: DownloadItem[]
    }
    expect(stored.version).toBe(2)
    expect(stored.items[0]!.receivedBytes).toBe(400)
  })

  it('completes through release: the partial file becomes the final one', async () => {
    const item = begin(h)
    h.service.progress(item.id, { receivedBytes: 1000, state: 'in-progress' })
    h.service.finish(item.id, 'completed', { receivedBytes: 1000 })
    await flush()
    expect(item.state).toBe('completed')
    expect(item.savePath).toBe('/dl/report.pdf')
    expect(item.endedAt).toBe(h.clock.now)
    expect(item.bytesPerSecond).toBe(0)
    expect(item.etaMs).toBeNull()
    expect(h.host.count('release')).toBe(1)
    expect(h.host.notified).toEqual([item.id])
    expect(h.service.inFlight).toHaveLength(0)
  })

  it('does not notify when notifications are off, and opens when asked', async () => {
    h.settings.showNotifications = false
    const item = begin(h)
    h.service.setOpenWhenDone(item.id, true)
    h.service.finish(item.id, 'completed')
    await flush()
    expect(h.host.notified).toEqual([])
    expect(h.host.opened).toEqual([item.id])
  })

  it('auto-opens configured types but never flagged ones', async () => {
    h.settings.autoOpen = ['pdf', 'exe']
    const pdf = begin(h)
    h.service.finish(pdf.id, 'completed')
    await flush()
    expect(h.host.opened).toEqual([pdf.id])
    const exe = begin(h, { filename: 'setup.exe', savePath: '/dl/setup.exe.zeniumdownload' })
    h.service.finish(exe.id, 'completed')
    await flush()
    expect(exe.danger.level).toBe('dangerous')
    expect(h.host.opened).toEqual([pdf.id])
    h.service.keep(exe.id)
    await flush()
    expect(h.host.opened).toEqual([pdf.id])
  })

  it('pauses and resumes through the host, only when the state allows it', () => {
    const item = begin(h)
    h.service.resume(item.id)
    expect(h.host.count('resume')).toBe(0)
    h.service.pause(item.id)
    expect(h.host.count('pause')).toBe(1)
    h.service.progress(item.id, { receivedBytes: 300, state: 'paused' })
    expect(item.state).toBe('paused')
    expect(item.bytesPerSecond).toBe(0)
    h.service.pause(item.id)
    expect(h.host.count('pause')).toBe(1)
    h.service.resume(item.id)
    expect(h.host.count('resume')).toBe(1)
    h.service.progress(item.id, { receivedBytes: 300, state: 'in-progress' })
    expect(item.state).toBe('in-progress')
  })

  it('cancels: the partial file goes and the record stays as cancelled', async () => {
    const item = begin(h)
    h.service.cancel(item.id)
    expect(h.host.count('cancel')).toBe(1)
    h.service.finish(item.id, 'cancelled')
    await flush()
    expect(item.state).toBe('cancelled')
    expect(item.savePath).toBe('')
    expect(h.host.count('discard')).toBe(1)
    expect(canRetry(item)).toBe(true)
  })

  it('an interruption keeps the partial file when the server can resume', () => {
    const item = begin(h)
    h.service.progress(item.id, { receivedBytes: 500, state: 'in-progress' })
    h.service.finish(item.id, 'interrupted', { canResume: true, error: 'network-failed' })
    expect(item.state).toBe('interrupted')
    expect(item.error).toBe('network-failed')
    expect(item.savePath).toBe('/dl/report.pdf.zeniumdownload')
    expect(item.canResume).toBe(true)
    h.service.resume(item.id)
    expect(h.host.count('resume')).toBe(1)
    expect(h.host.count('retry')).toBe(0)
  })

  it('resume of a non-resumable interruption is a retry: a new record replaces the old one', () => {
    const item = begin(h)
    h.service.finish(item.id, 'interrupted', { canResume: false })
    expect(item.error).toBe('interrupted')
    h.service.resume(item.id)
    expect(h.host.count('retry')).toBe(1)
    expect(h.service.items.find((i) => i.id === item.id)).toBeUndefined()
    expect(h.host.count('discard')).toBe(1)
  })

  it('a host continuing a record after a restart reuses it', () => {
    const item = begin(h)
    h.service.finish(item.id, 'interrupted', { canResume: true, receivedBytes: 500 })
    const again = h.service.begin({
      url: item.url,
      filename: '',
      totalBytes: 0,
      mimeType: '',
      resumes: item.id
    })
    expect(again).toBe(item)
    expect(again.state).toBe('in-progress')
    expect(again.error).toBeNull()
    expect(again.filename).toBe('report.pdf')
    expect(again.totalBytes).toBe(1000)
    expect(h.service.items).toHaveLength(1)
  })

  it('ignores progress for finished records and unknown ids', async () => {
    const item = begin(h)
    h.service.finish(item.id, 'completed')
    await flush()
    h.service.progress(item.id, { receivedBytes: 1, state: 'in-progress' })
    expect(item.state).toBe('completed')
    h.service.progress('nope', { receivedBytes: 1, state: 'in-progress' })
    h.service.finish('nope', 'completed')
  })

  it('caps the list at 100 records', () => {
    for (let i = 0; i < 105; i++) begin(h)
    expect(h.service.items).toHaveLength(100)
  })

  it('remove and clearCompleted cancel in-flight and discard leftovers', async () => {
    const running = begin(h)
    const failed = begin(h)
    h.service.finish(failed.id, 'interrupted', { canResume: true })
    const done = begin(h)
    h.service.finish(done.id, 'completed')
    await flush()
    h.service.remove(running.id)
    expect(h.host.count('cancel')).toBe(1)
    h.service.clearCompleted()
    expect(h.service.items.map((i) => i.id)).toEqual([])
    // The interrupted one's partial file is deleted; the completed file is left alone.
    expect(h.host.calls.filter((c) => c.method === 'discard').map((c) => c.id)).toEqual([failed.id])
  })

  it('chooseLocation goes through the host', async () => {
    expect(await h.service.chooseLocation()).toBe('/picked')
  })
})

describe('danger: quarantine, Keep and Discard', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('holds a flagged file back until Keep releases it', async () => {
    const exe = begin(h, { filename: 'setup.exe', savePath: '/dl/setup.exe.zeniumdownload' })
    expect(exe.danger).toEqual({ level: 'dangerous', reason: 'file-type' })
    h.service.finish(exe.id, 'completed')
    await flush()
    expect(exe.state).toBe('completed')
    expect(isQuarantined(exe)).toBe(true)
    expect(exe.savePath).toBe('/dl/setup.exe.zeniumdownload')
    expect(h.host.count('release')).toBe(0)
    expect(h.host.notified).toEqual([])
    await h.service.open(exe.id)
    expect(h.host.opened).toEqual([])
    await h.service.keep(exe.id)
    expect(exe.danger.kept).toBe(true)
    expect(isQuarantined(exe)).toBe(false)
    expect(exe.savePath).toBe('/dl/setup.exe')
    expect(h.host.notified).toEqual([exe.id])
    await h.service.open(exe.id)
    expect(h.host.opened).toEqual([exe.id])
  })

  it('Discard deletes the quarantined file and the record', async () => {
    const exe = begin(h, { filename: 'setup.exe', savePath: '/dl/setup.exe.zeniumdownload' })
    h.service.finish(exe.id, 'completed')
    await flush()
    await h.service.discard(exe.id)
    expect(h.host.count('discard')).toBe(1)
    expect(h.service.items).toHaveLength(0)
  })

  it('a familiar site downloads its installer without a warning', () => {
    h.familiar.add('example.com')
    const exe = begin(h, { filename: 'setup.exe' })
    expect(exe.danger.level).toBe('safe')
    const stranger = begin(h, { filename: 'setup.exe', referrer: 'https://other.example/x' })
    expect(stranger.danger.level).toBe('dangerous')
  })

  it('an http download from an https page is suspicious', () => {
    const item = begin(h, { url: 'http://cdn.example.com/report.pdf' })
    expect(item.danger).toEqual({ level: 'suspicious', reason: 'insecure' })
  })

  it('waits for verdict providers before releasing and takes the worst answer', async () => {
    let answer: (v: { level: 'dangerous'; reason: 'url' } | null) => void = () => undefined
    const provider: DangerVerdictProvider = {
      verdict: () => new Promise((resolve) => (answer = resolve))
    }
    h.service.addVerdictProvider(provider)
    const item = begin(h)
    h.service.finish(item.id, 'completed')
    await flush()
    expect(item.state).toBe('in-progress')
    expect(h.host.count('release')).toBe(0)
    answer({ level: 'dangerous', reason: 'url' })
    await flush()
    await flush()
    expect(item.state).toBe('completed')
    expect(item.danger).toEqual({ level: 'dangerous', reason: 'url' })
    expect(isQuarantined(item)).toBe(true)
  })

  it('a null verdict leaves the classification alone and the timeout unblocks completion', async () => {
    vi.useFakeTimers()
    try {
      const never: DangerVerdictProvider = { verdict: () => new Promise(() => undefined) }
      const h2 = harness()
      h2.service.addVerdictProvider(never)
      const item = begin(h2)
      h2.service.finish(item.id, 'completed')
      await vi.advanceTimersByTimeAsync(16_000)
      expect(item.state).toBe('completed')
      expect(item.danger.level).toBe('safe')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a record cancelled while verdicts were pending is not completed afterwards', async () => {
    let answer: (v: null) => void = () => undefined
    h.service.addVerdictProvider({ verdict: () => new Promise((resolve) => (answer = resolve)) })
    const item = begin(h)
    h.service.finish(item.id, 'completed')
    await flush()
    h.service.remove(item.id)
    answer(null)
    await flush()
    await flush()
    expect(h.host.count('release')).toBe(0)
    expect(item.state).toBe('in-progress')
  })
})

describe('taskbar progress', () => {
  it('aggregates the window\u2019s downloads, shows indeterminate for unknown sizes and clears at the end', async () => {
    const h = harness()
    const a = begin(h, { totalBytes: 1000 })
    const b = begin(h, { totalBytes: 3000, sourceTabId: 't1' })
    const other = begin(h, { totalBytes: 100, sourceTabId: 't2' })
    expect(h.windows[0]!.last).toEqual({ value: 0, mode: 'normal' })
    h.clock.now += 1000
    h.service.progress(a.id, { receivedBytes: 1000, state: 'in-progress' })
    // Broadcasts (and the bars with them) are throttled to four a second.
    h.clock.now += 300
    h.service.progress(b.id, { receivedBytes: 1000, state: 'in-progress' })
    expect(h.windows[0]!.last).toEqual({ value: 0.5, mode: 'normal' })
    h.service.progress(b.id, { receivedBytes: 1000, state: 'paused' })
    h.clock.now += 1000
    h.service.finish(a.id, 'completed')
    await flush()
    expect(h.windows[0]!.last).toEqual({ value: 1000 / 3000, mode: 'paused' })
    h.service.progress(b.id, { receivedBytes: 1000, totalBytes: 0, state: 'in-progress' })
    expect(h.windows[0]!.last).toEqual({ value: 2, mode: 'indeterminate' })
    h.service.finish(b.id, 'cancelled')
    expect(h.windows[0]!.last).toEqual({ value: -1, mode: undefined })
    expect(h.windows[1]!.last).toEqual({ value: 0, mode: 'normal' })
    h.service.finish(other.id, 'completed')
    await flush()
    expect(h.windows[1]!.last).toEqual({ value: -1, mode: undefined })
  })
})

describe('persistence and migration', () => {
  it('reads version 1 records and turns what was in flight into resumable-looking interruptions', () => {
    const items = migrate(
      {
        version: 1,
        items: [
          {
            id: 'dl-1',
            url: 'https://a/x.zip',
            filename: 'x.zip',
            savePath: '/dl/x.zip',
            totalBytes: 10,
            receivedBytes: 10,
            state: 'completed',
            startedAt: 5,
            mimeType: 'application/zip'
          },
          {
            id: 'dl-2',
            url: 'https://a/y.zip',
            filename: 'y.zip',
            savePath: '/dl/y.zip',
            totalBytes: 10,
            receivedBytes: 4,
            state: 'progressing',
            startedAt: 6,
            mimeType: ''
          },
          { nonsense: true }
        ]
      },
      100
    )
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      id: 'dl-1',
      state: 'completed',
      referrer: '',
      canResume: false,
      error: null,
      danger: { level: 'safe', reason: 'none' },
      endedAt: 5
    })
    expect(items[1]).toMatchObject({
      id: 'dl-2',
      state: 'interrupted',
      error: 'shutdown',
      canResume: false
    })
  })

  it('reads version 2 records; in-flight ones come back interrupted by the shutdown', () => {
    const io = new MemoryIO()
    const first = harness({}, io)
    const item = begin(first, { filename: 'setup.exe', savePath: '/dl/setup.exe.zeniumdownload' })
    first.service.progress(item.id, {
      receivedBytes: 400,
      state: 'in-progress',
      etag: '"abc"',
      canResume: true
    })
    first.service.flushSync()
    const second = harness({}, io)
    const restored = second.service.items[0]!
    expect(restored.id).toBe(item.id)
    expect(restored.state).toBe('interrupted')
    expect(restored.error).toBe('shutdown')
    expect(restored.canResume).toBe(true)
    expect(restored.etag).toBe('"abc"')
    expect(restored.danger).toEqual({ level: 'dangerous', reason: 'file-type' })
    expect(restored.bytesPerSecond).toBe(0)
    second.service.resume(restored.id)
    expect(second.host.count('resume')).toBe(1)
  })

  it('survives garbage', () => {
    expect(migrate(null, 0)).toEqual([])
    expect(migrate({ version: 2, items: 'x' as unknown as DownloadItem[] }, 0)).toEqual([])
  })
})

describe('RateEstimator and ETA', () => {
  it('averages over the recent window and forgets on reset', () => {
    const rate = new RateEstimator(0)
    rate.reset(0, 0)
    rate.update(1000, 1000)
    rate.update(2000, 2000)
    expect(rate.bytesPerSecond(2000)).toBe(1000)
    rate.update(2000, 12_000)
    expect(rate.bytesPerSecond(12_000)).toBe(0)
    rate.reset(2000, 12_000)
    rate.update(2500, 12_500)
    expect(rate.bytesPerSecond(12_500)).toBe(500)
  })

  it('has no ETA without a size or a rate', () => {
    const base: DownloadItem = {
      id: 'x',
      url: '',
      referrer: '',
      filename: '',
      savePath: '',
      totalBytes: 0,
      receivedBytes: 0,
      state: 'in-progress',
      startedAt: 0,
      endedAt: null,
      mimeType: '',
      canResume: false,
      error: null,
      danger: { level: 'safe', reason: 'none' },
      openWhenDone: false,
      bytesPerSecond: 0,
      etaMs: null,
      etag: '',
      lastModified: ''
    }
    expect(estimateEta(base)).toBeNull()
    expect(estimateEta({ ...base, totalBytes: 100, bytesPerSecond: 10 })).toBe(10_000)
    expect(
      estimateEta({ ...base, totalBytes: 100, bytesPerSecond: 10, state: 'paused' })
    ).toBeNull()
  })
})
