import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DownloadService,
  RateEstimator,
  canKeepInsecure,
  canRetry,
  estimateEta,
  isQuarantined,
  migrate,
  type DownloadChange,
  type DownloadServiceDeps
} from '../downloads'
import type { DownloadHost, StoreIO } from '../platform'
import { DangerVerdictRegistry, type DangerVerdictProvider } from '../downloads/danger'
import { PRIVATE_CONTAINER_ID, type DownloadItem, type DownloadSettings } from '../../shared/types'
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
  autoResume?: 'core' | 'host'
  isOnline?: () => boolean
  onOnline?: (listener: () => void) => () => void
  releaseResult: { savePath: string; finalName: string } | null | 'derive' = 'derive'
  releaseNotify: boolean[] = []
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
  async release(
    item: DownloadItem,
    options: { notify: boolean }
  ): Promise<{ savePath: string; finalName: string } | null> {
    this.calls.push({ method: 'release', id: item.id })
    this.releaseNotify.push(options.notify)
    if (this.releaseResult !== 'derive') return this.releaseResult
    return { savePath: item.savePath.replace('.zeniumdownload', ''), finalName: item.finalName }
  }
  async deletePartial(item: DownloadItem): Promise<void> {
    this.calls.push({ method: 'deletePartial', id: item.id })
  }
  /**
   * The files "on disk": null means every path is there (the default, so the rest of the suite
   * never sees a missing file); a set names the paths that exist. `deleteFailsFor` are locked.
   */
  files: Set<string> | null = null
  deleteFailsFor = new Set<string>()
  /** Set to make `exists` reject (a host without an answer changes nothing). */
  existsThrows = false
  async exists(item: DownloadItem): Promise<boolean> {
    this.calls.push({ method: 'exists', id: item.id })
    if (this.existsThrows) throw new Error('no answer')
    return this.files === null || this.files.has(item.savePath)
  }
  async deleteFile(item: DownloadItem): Promise<'deleted' | 'missing' | 'failed'> {
    this.calls.push({ method: 'deleteFile', id: item.id })
    if (this.deleteFailsFor.has(item.savePath)) return 'failed'
    if (this.files === null) return 'deleted'
    return this.files.delete(item.savePath) ? 'deleted' : 'missing'
  }
  async open(item: DownloadItem): Promise<void> {
    this.opened.push(item.id)
  }
  showInFolder(item: DownloadItem): void {
    this.calls.push({ method: 'showInFolder', id: item.id })
  }
  async chooseDirectory(): Promise<string | null> {
    return '/picked'
  }
  /** Where a parked partial goes; null means the host could not keep it. */
  parkTo: ((item: DownloadItem) => string | null) | null = null
  park(item: DownloadItem): string | null {
    this.calls.push({ method: 'park', id: item.id })
    return this.parkTo ? this.parkTo(item) : null
  }
  count(method: keyof DownloadHost): number {
    return this.calls.filter((c) => c.method === method).length
  }
  ids(method: keyof DownloadHost): string[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.id)
  }
}

interface Harness {
  io: MemoryIO
  host: FakeHost
  service: DownloadService
  changes: Array<{ id: string; kind: DownloadChange; removed?: boolean }>
  dangers: string[]
  settings: DownloadSettings
  familiar: Set<string>
  clock: { now: number }
  verdicts: DangerVerdictRegistry
}

function harness(
  overrides: Partial<DownloadServiceDeps> = {},
  io = new MemoryIO(),
  host = new FakeHost()
): Harness {
  const changes: Harness['changes'] = []
  const dangers: string[] = []
  const settings: DownloadSettings = { ...DEFAULT_DOWNLOAD_SETTINGS }
  const familiar = new Set<string>()
  const clock = { now: 1_000_000 }
  const verdicts = new DangerVerdictRegistry()
  const service = new DownloadService(
    io,
    host,
    (item, kind) => changes.push({ id: item.id, kind, ...(item.removed ? { removed: true } : {}) }),
    {
      os: 'win32',
      settings: () => settings,
      referrerFamiliar: (referrer) => familiar.has(new URL(referrer).host),
      onDanger: (item) => dangers.push(item.id),
      verdicts,
      now: () => clock.now,
      ...overrides
    }
  )
  return { io, host, service, changes, dangers, settings, familiar, clock, verdicts }
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
    etag: '"v1"',
    ...over
  })
}

function stored(h: Harness): { version: number; items: DownloadItem[] } {
  h.service.flushSync()
  return JSON.parse(h.io.files.get('downloads.json')!) as { version: number; items: DownloadItem[] }
}

describe('DownloadService state machine', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('begins progressing with the danger verdict and the record on top of the list', () => {
    const item = begin(h)
    expect(item.state).toBe('progressing')
    expect(item.danger).toEqual({ level: 'safe', reason: 'none', message: '' })
    expect(item.dangerAccepted).toBe(false)
    expect(item.private).toBe(false)
    expect(item.containerId).toBe('default')
    expect(item.finalName).toBe('report.pdf')
    expect(h.service.items[0]).toBe(item)
    expect(h.changes).toEqual([{ id: item.id, kind: 'started' }])
    expect(h.service.inFlight).toHaveLength(1)
    expect(h.service.activeCount()).toBe(1)
  })

  it('keeps the suggested name apart from the unique one the host chose', () => {
    const item = begin(h, { finalName: 'report(1).pdf.zeniumdownload' })
    expect(item.filename).toBe('report.pdf')
    expect(item.finalName).toBe('report(1).pdf')
  })

  it('tracks progress, speed and ETA, and persists on the way', () => {
    const item = begin(h)
    h.clock.now += 1000
    h.service.progress(item.id, { receivedBytes: 200, state: 'progressing' })
    h.clock.now += 1000
    h.service.progress(item.id, { receivedBytes: 400, state: 'progressing' })
    expect(item.receivedBytes).toBe(400)
    expect(item.bytesPerSecond).toBe(200)
    expect(item.etaMs).toBe(3000)
    const data = stored(h)
    expect(data.version).toBe(4)
    expect(data.items[0]!.receivedBytes).toBe(400)
  })

  it('throttles progress events to four a second per item; state changes go out at once', () => {
    const a = begin(h)
    const b = begin(h)
    h.changes.length = 0
    // The `started` event counts: the next progress for the same item waits 250 ms.
    h.clock.now += 100
    h.service.progress(a.id, { receivedBytes: 5, state: 'progressing' })
    expect(h.changes).toEqual([])
    h.clock.now += 200
    h.service.progress(a.id, { receivedBytes: 10, state: 'progressing' })
    h.service.progress(b.id, { receivedBytes: 10, state: 'progressing' })
    h.clock.now += 100
    h.service.progress(a.id, { receivedBytes: 20, state: 'progressing' })
    h.clock.now += 100
    h.service.progress(a.id, { receivedBytes: 30, state: 'progressing' })
    expect(h.changes.filter((c) => c.id === a.id)).toHaveLength(1)
    expect(h.changes.filter((c) => c.id === b.id)).toHaveLength(1)
    h.service.progress(a.id, { receivedBytes: 30, state: 'paused' })
    expect(h.changes.filter((c) => c.id === a.id)).toHaveLength(2)
    expect(a.receivedBytes).toBe(30)
  })

  it('completes through release: the partial file becomes the final one', async () => {
    const item = begin(h)
    h.service.progress(item.id, { receivedBytes: 1000, state: 'progressing' })
    h.service.finish(item.id, 'completed', { receivedBytes: 1000 })
    await flush()
    expect(item.state).toBe('completed')
    expect(item.savePath).toBe('/dl/report.pdf')
    expect(item.completedAt).toBe(h.clock.now)
    expect(item.endedAt).toBe(h.clock.now)
    expect(item.bytesPerSecond).toBe(0)
    expect(item.etaMs).toBeNull()
    expect(h.host.count('release')).toBe(1)
    // By default the bubble is the notice: the host is told not to raise one of its own.
    expect(h.host.releaseNotify).toEqual([false])
    expect(h.service.inFlight).toHaveLength(0)
    expect(h.changes.at(-1)).toEqual({ id: item.id, kind: 'done' })
    expect(h.dangers).toEqual([])
  })

  it('hands the notification setting to the host and opens when asked', async () => {
    h.settings.notifyOnComplete = true
    const item = begin(h)
    h.service.setOpenWhenDone(item.id, true)
    expect(item.openWhenDone).toBe(true)
    h.service.finish(item.id, 'completed')
    await flush()
    expect(h.host.releaseNotify).toEqual([true])
    expect(h.host.opened).toEqual([item.id])
  })

  it('auto-opens configured types but never flagged ones', async () => {
    h.settings.autoOpenTypes = ['pdf', 'exe']
    const pdf = begin(h)
    h.service.finish(pdf.id, 'completed')
    await flush()
    expect(h.host.opened).toEqual([pdf.id])
    const exe = begin(h, { filename: 'setup.exe', savePath: '/dl/setup.exe.zeniumdownload' })
    h.service.finish(exe.id, 'completed')
    await flush()
    expect(exe.danger.level).toBe('dangerous')
    expect(h.host.opened).toEqual([pdf.id])
    await h.service.acceptDanger(exe.id)
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
    h.service.progress(item.id, { receivedBytes: 300, state: 'progressing' })
    expect(item.state).toBe('progressing')
  })

  it('cancels: the partial file goes and the record stays as cancelled', async () => {
    const item = begin(h)
    h.service.cancel(item.id)
    expect(h.host.count('cancel')).toBe(1)
    h.service.finish(item.id, 'cancelled')
    await flush()
    expect(item.state).toBe('cancelled')
    expect(item.savePath).toBe('')
    expect(item.error).toBeUndefined()
    expect(item.endedAt).toBe(h.clock.now)
    expect(h.host.count('deletePartial')).toBe(1)
    expect(canRetry(item)).toBe(true)
  })

  it('an interruption keeps the partial file when the server can resume', () => {
    const item = begin(h)
    h.service.progress(item.id, { receivedBytes: 500, state: 'progressing' })
    h.service.finish(item.id, 'interrupted', { canResume: true, error: 'network-timeout' })
    expect(item.state).toBe('interrupted')
    expect(item.error).toBe('network-timeout')
    expect(item.errorMessage).toBe('Check internet connection')
    expect(item.savePath).toBe('/dl/report.pdf.zeniumdownload')
    expect(item.canResume).toBe(true)
    h.service.resume(item.id)
    expect(h.host.count('resume')).toBe(1)
    expect(h.host.count('retry')).toBe(0)
  })

  it('resume of a non-resumable interruption is a retry that keeps the row', () => {
    const item = begin(h)
    h.service.finish(item.id, 'interrupted', { canResume: false })
    // A host that names no reason leaves a plain network failure.
    expect(item.error).toBe('network-failed')
    expect(item.errorMessage).toBe('Check internet connection')
    h.service.resume(item.id)
    expect(h.host.count('retry')).toBe(1)
    expect(h.host.count('deletePartial')).toBe(1)
    expect(h.service.items[0]).toBe(item)
    expect(item.savePath).toBe('')
    expect(item.receivedBytes).toBe(0)
    // The host reports the new transfer into the same record.
    const again = h.service.begin({
      url: item.url,
      referrer: item.referrer,
      filename: 'report.pdf',
      totalBytes: 2000,
      mimeType: 'application/pdf',
      savePath: '/dl/report.pdf.zeniumdownload',
      resumes: item.id
    })
    expect(again).toBe(item)
    expect(item.state).toBe('progressing')
    expect(item.totalBytes).toBe(2000)
    expect(h.service.items).toHaveLength(1)
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
    expect(again.state).toBe('progressing')
    expect(again.error).toBeUndefined()
    expect(again.filename).toBe('report.pdf')
    expect(again.totalBytes).toBe(1000)
    expect(again.receivedBytes).toBe(500)
    expect(h.service.items).toHaveLength(1)
  })

  it('a retry that comes back under another name is classified again', () => {
    const item = begin(h)
    h.service.finish(item.id, 'interrupted', { canResume: false })
    h.service.retry(item.id)
    h.service.begin({
      url: item.url,
      filename: 'report.exe',
      totalBytes: 10,
      mimeType: 'application/octet-stream',
      resumes: item.id
    })
    expect(item.filename).toBe('report.exe')
    expect(item.finalName).toBe('report.exe')
    expect(item.danger.level).toBe('dangerous')
  })

  it('a final name of another type, learnt from the response, is classified again', () => {
    const item = begin(h, { filename: 'download', mimeType: '' })
    expect(item.danger.level).toBe('safe')
    h.service.progress(item.id, {
      state: 'progressing',
      receivedBytes: 10,
      finalName: 'setup(1).exe.zeniumdownload'
    })
    expect(item.finalName).toBe('setup(1).exe')
    expect(item.filename).toBe('download')
    expect(item.danger).toMatchObject({ level: 'dangerous', reason: 'executable' })
    // MediaStore making the same type unique again changes nothing.
    h.service.progress(item.id, {
      state: 'progressing',
      receivedBytes: 20,
      finalName: 'setup(2).exe'
    })
    expect(item.danger.reason).toBe('executable')
  })

  it('ignores progress for finished records and unknown ids', async () => {
    const item = begin(h)
    h.service.finish(item.id, 'completed')
    await flush()
    h.service.progress(item.id, { receivedBytes: 1, state: 'progressing' })
    expect(item.state).toBe('completed')
    h.service.progress('nope', { receivedBytes: 1, state: 'progressing' })
    h.service.finish('nope', 'completed')
  })

  it('caps the list at 100 records, dropping finished ones before running ones', async () => {
    const running = begin(h)
    for (let i = 0; i < 104; i++) {
      const done = begin(h)
      h.service.finish(done.id, 'completed')
      await flush()
    }
    expect(h.service.items).toHaveLength(100)
    expect(h.service.items.some((i) => i.id === running.id)).toBe(true)
  })

  it('remove and removeCompleted cancel in-flight rows, delete leftovers and announce removals', async () => {
    const running = begin(h)
    const failed = begin(h)
    h.service.finish(failed.id, 'interrupted', { canResume: true })
    const done = begin(h)
    h.service.finish(done.id, 'completed')
    await flush()
    h.changes.length = 0
    h.service.remove(running.id)
    expect(h.host.count('cancel')).toBe(1)
    expect(h.changes).toEqual([{ id: running.id, kind: 'removed', removed: true }])
    h.service.removeCompleted()
    expect(h.service.items.map((i) => i.id)).toEqual([])
    // The interrupted one's partial file is deleted; the completed file is left alone.
    expect(h.host.ids('deletePartial')).toEqual([failed.id])
    expect(h.changes.slice(1).map((c) => c.kind)).toEqual(['removed', 'removed'])
    expect(stored(h).items).toEqual([])
  })

  it('chooseDirectory goes through the host', async () => {
    expect(await h.service.chooseDirectory()).toBe('/picked')
  })

  it('registers files the app produced itself as completed downloads', () => {
    const shot = h.service.addCompleted('/shots/page.png', 'image/png')
    expect(shot.state).toBe('completed')
    expect(shot.finalName).toBe('page.png')
    expect(shot.private).toBe(false)
    expect(h.changes.at(-1)).toEqual({ id: shot.id, kind: 'done' })
  })
})

describe('aggregate progress', () => {
  it('sums received and total bytes, flags unknown sizes and counts paused rows', async () => {
    const h = harness()
    const a = begin(h, { totalBytes: 1000 })
    const b = begin(h, { totalBytes: 3000 })
    expect(h.service.aggregateProgress()).toEqual({
      received: 0,
      total: 4000,
      indeterminate: false,
      active: 2
    })
    h.service.progress(a.id, { receivedBytes: 1000, state: 'progressing' })
    h.service.progress(b.id, { receivedBytes: 1000, state: 'paused' })
    expect(h.service.aggregateProgress()).toEqual({
      received: 2000,
      total: 4000,
      indeterminate: false,
      active: 2
    })
    h.service.finish(a.id, 'completed')
    await flush()
    h.service.progress(b.id, { receivedBytes: 1000, totalBytes: 0, state: 'progressing' })
    expect(h.service.aggregateProgress()).toEqual({
      received: 1000,
      total: 0,
      indeterminate: true,
      active: 1
    })
    h.service.finish(b.id, 'cancelled')
    expect(h.service.aggregateProgress()).toEqual({
      received: 0,
      total: 0,
      indeterminate: false,
      active: 0
    })
  })
})

describe('private downloads', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('are stamped from the container and never written to disk', () => {
    const secret = begin(h, {
      containerId: PRIVATE_CONTAINER_ID,
      savePath: '/dl/secret.pdf.zeniumdownload'
    })
    const regular = begin(h)
    expect(secret.private).toBe(true)
    expect(secret.containerId).toBe(PRIVATE_CONTAINER_ID)
    h.service.progress(secret.id, { receivedBytes: 10, state: 'progressing' })
    expect(stored(h).items.map((i) => i.id)).toEqual([regular.id])
    // A host may also say so outright.
    const flagged = begin(h, { private: true })
    expect(flagged.containerId).toBe(PRIVATE_CONTAINER_ID)
    expect(stored(h).items.map((i) => i.id)).toEqual([regular.id])
  })

  it('are shown to private windows only, in the list and in the progress aggregate', () => {
    const secret = begin(h, { private: true, totalBytes: 500 })
    const regular = begin(h, { totalBytes: 1000 })
    expect(h.service.visibleTo(false).map((i) => i.id)).toEqual([regular.id])
    expect(h.service.visibleTo(true).map((i) => i.id)).toEqual([regular.id, secret.id])
    expect(h.service.aggregateProgress({ private: false }).total).toBe(1000)
    expect(h.service.aggregateProgress().total).toBe(1500)
    expect(h.service.activeCount({ private: true })).toBe(1)
    expect(h.service.activeCount({ private: false })).toBe(1)
    expect(h.service.activeCount()).toBe(2)
  })

  it('end of the private session cancels transfers, deletes partial files and forgets the rows', async () => {
    const running = begin(h, { private: true, savePath: '/dl/a.pdf.zeniumdownload' })
    const paused = begin(h, { private: true, savePath: '/dl/b.pdf.zeniumdownload' })
    h.service.progress(paused.id, { receivedBytes: 5, state: 'paused' })
    const failed = begin(h, { private: true, savePath: '/dl/c.pdf.zeniumdownload' })
    h.service.finish(failed.id, 'interrupted', { canResume: true })
    const done = begin(h, { private: true, savePath: '/dl/d.pdf.zeniumdownload' })
    h.service.finish(done.id, 'completed')
    const quarantined = begin(h, {
      private: true,
      filename: 'tool.exe',
      savePath: '/dl/tool.exe.zeniumdownload'
    })
    h.service.finish(quarantined.id, 'completed')
    const regular = begin(h)
    await flush()
    h.changes.length = 0
    h.service.endPrivateSession()
    expect(h.host.ids('cancel').sort()).toEqual([paused.id, running.id].sort())
    // Partial files of running, paused, failed and quarantined rows go; the completed file stays.
    expect(h.host.ids('deletePartial').sort()).toEqual(
      [running.id, paused.id, failed.id, quarantined.id].sort()
    )
    expect(h.service.items.map((i) => i.id)).toEqual([regular.id])
    expect(h.changes.map((c) => c.kind)).toEqual([
      'removed',
      'removed',
      'removed',
      'removed',
      'removed'
    ])
    expect(h.changes.every((c) => c.removed)).toBe(true)
    // The host's late cancellation report finds nothing to update.
    h.service.finish(running.id, 'cancelled')
    expect(h.service.items).toHaveLength(1)
    h.service.endPrivateSession()
    expect(h.changes).toHaveLength(5)
  })
})

describe('danger: quarantine, Keep and Discard', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('holds a flagged file back until Keep releases it', async () => {
    const exe = begin(h, { filename: 'setup.exe', savePath: '/dl/setup.exe.zeniumdownload' })
    expect(exe.danger).toEqual({
      level: 'dangerous',
      reason: 'executable',
      message: 'This type of file can harm your device.'
    })
    h.service.finish(exe.id, 'completed')
    await flush()
    expect(exe.state).toBe('completed')
    expect(exe.completedAt).toBe(h.clock.now)
    expect(isQuarantined(exe)).toBe(true)
    expect(exe.savePath).toBe('/dl/setup.exe.zeniumdownload')
    expect(h.host.count('release')).toBe(0)
    expect(h.dangers).toEqual([exe.id])
    await h.service.open(exe.id)
    expect(h.host.opened).toEqual([])
    await h.service.acceptDanger(exe.id)
    expect(exe.dangerAccepted).toBe(true)
    expect(isQuarantined(exe)).toBe(false)
    expect(exe.savePath).toBe('/dl/setup.exe')
    expect(h.host.count('release')).toBe(1)
    await h.service.open(exe.id)
    expect(h.host.opened).toEqual([exe.id])
  })

  it('Discard deletes the quarantined file and the record', async () => {
    const exe = begin(h, { filename: 'setup.exe', savePath: '/dl/setup.exe.zeniumdownload' })
    h.service.finish(exe.id, 'completed')
    await flush()
    await h.service.discard(exe.id)
    expect(h.host.count('deletePartial')).toBe(1)
    expect(h.service.items).toHaveLength(0)
    expect(h.changes.at(-1)).toEqual({ id: exe.id, kind: 'removed', removed: true })
  })

  it('a familiar site downloads its installer without a warning', () => {
    h.familiar.add('example.com')
    const exe = begin(h, { filename: 'setup.exe' })
    expect(exe.danger.level).toBe('safe')
    const stranger = begin(h, { filename: 'setup.exe', referrer: 'https://other.example/x' })
    expect(stranger.danger.level).toBe('dangerous')
  })

  it('a Safe Browsing verdict makes any file dangerous whatever its type (PS-34)', async () => {
    const provider: DangerVerdictProvider = {
      verdict: async () => ({ level: 'dangerous', reason: 'url-verdict', message: 'Malware.' })
    }
    h.service.addVerdictProvider(provider)
    const pdf = begin(h)
    expect(pdf.danger.level).toBe('safe')
    await flush()
    expect(pdf.danger).toEqual({ level: 'dangerous', reason: 'url-verdict', message: 'Malware.' })
    h.service.finish(pdf.id, 'completed', { receivedBytes: 1000 })
    await flush()
    await flush()
    expect(pdf.state).toBe('completed')
    expect(isQuarantined(pdf)).toBe(true)
    expect(h.host.count('release')).toBe(0)
    expect(h.dangers).toEqual([pdf.id])
  })

  it('the tier is named on the record: dangerous programs, suspicious disk images', () => {
    const exe = begin(h, { filename: 'setup.exe', referrer: 'https://other.example/x' })
    expect(exe.danger).toMatchObject({ level: 'dangerous', reason: 'executable' })
    const iso = begin(h, { filename: 'ubuntu.iso', referrer: 'https://other.example/x' })
    expect(iso.danger).toMatchObject({ level: 'suspicious', reason: 'archive' })
    const zip = begin(h, { filename: 'photos.zip', referrer: 'https://other.example/x' })
    expect(zip.danger.level).toBe('safe')
  })

  it('waits for verdict providers before releasing and takes the worst answer', async () => {
    let answer: (
      v: { level: 'dangerous'; reason: 'url-verdict'; message: string } | null
    ) => void = () => undefined
    const provider: DangerVerdictProvider = {
      verdict: () => new Promise((resolve) => (answer = resolve))
    }
    const unregister = h.service.addVerdictProvider(provider)
    const item = begin(h)
    h.service.finish(item.id, 'completed')
    await flush()
    expect(item.state).toBe('progressing')
    expect(h.host.count('release')).toBe(0)
    answer({ level: 'dangerous', reason: 'url-verdict', message: 'Safe Browsing says no.' })
    await flush()
    await flush()
    expect(item.state).toBe('completed')
    expect(item.danger).toEqual({
      level: 'dangerous',
      reason: 'url-verdict',
      message: 'Safe Browsing says no.'
    })
    expect(isQuarantined(item)).toBe(true)
    expect(h.dangers).toEqual([item.id])
    unregister()
    expect(h.verdicts.size).toBe(0)
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

  it('a record removed while verdicts were pending is not completed afterwards', async () => {
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
    expect(item.state).toBe('progressing')
  })
})

describe('interrupt reasons', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('carries the host’s reason with Chrome’s wording, cleared when the transfer goes on', () => {
    const item = begin(h)
    h.service.progress(item.id, {
      receivedBytes: 10,
      state: 'interrupted',
      canResume: true,
      error: 'file-no-space'
    })
    expect(item).toMatchObject({
      state: 'interrupted',
      error: 'file-no-space',
      errorMessage: 'Out of storage space'
    })
    // A later report of the same interruption without a reason keeps the one it has.
    h.service.progress(item.id, { receivedBytes: 10, state: 'interrupted', canResume: true })
    expect(item.error).toBe('file-no-space')
    h.service.progress(item.id, { receivedBytes: 20, state: 'progressing' })
    expect(item.error).toBeUndefined()
    expect(item.errorMessage).toBeUndefined()
    h.service.finish(item.id, 'interrupted', { canResume: false, error: 'server-forbidden' })
    expect(item.errorMessage).toBe('File wasn’t available on site')
    expect(stored(h).items[0]).toMatchObject({
      error: 'server-forbidden',
      errorMessage: 'File wasn’t available on site'
    })
  })

  it('a file the host could not place fails as file-failed', async () => {
    h.host.releaseResult = null
    const item = begin(h)
    h.service.finish(item.id, 'completed', { receivedBytes: 1000 })
    await flush()
    expect(item).toMatchObject({
      state: 'interrupted',
      error: 'file-failed',
      errorMessage: 'Something went wrong',
      canResume: false
    })
  })

  it('a cancelled row carries no reason', async () => {
    const item = begin(h)
    h.service.progress(item.id, {
      receivedBytes: 10,
      state: 'interrupted',
      error: 'network-timeout'
    })
    h.service.finish(item.id, 'cancelled')
    await flush()
    expect(item.error).toBeUndefined()
    expect(item.errorMessage).toBeUndefined()
  })

  it('reclassify refines an interrupted row’s reason, persists it and says so; nothing else moves', () => {
    const item = begin(h)
    h.service.finish(item.id, 'interrupted', { canResume: false, error: 'server-failed' })
    expect(item.errorMessage).toBe('Site wasn’t available')
    h.changes.length = 0
    h.service.reclassify(item.id, 'server-bad-content')
    expect(item).toMatchObject({
      state: 'interrupted',
      error: 'server-bad-content',
      errorMessage: 'File wasn’t available on site',
      canResume: false
    })
    expect(h.changes).toEqual([{ id: item.id, kind: 'progress' }])
    expect(stored(h).items[0]).toMatchObject({ error: 'server-bad-content' })
    // The same reason again is not news.
    h.service.reclassify(item.id, 'server-bad-content')
    expect(h.changes).toHaveLength(1)
    // A row that went on (retried) or finished keeps its own state.
    h.service.retry(item.id)
    h.service.begin({
      url: item.url,
      filename: item.filename,
      totalBytes: 0,
      mimeType: '',
      resumes: item.id
    })
    h.service.reclassify(item.id, 'server-forbidden')
    expect(item.state).toBe('progressing')
    expect(item.error).toBeUndefined()
    h.service.finish(item.id, 'completed', { receivedBytes: 1000 })
    h.service.reclassify(item.id, 'server-forbidden')
    expect(item.error).toBeUndefined()
    h.service.reclassify('dl_nobody', 'server-forbidden')
  })

  it('a dead link is noted per tab and URL, taken once, and forgotten after a while', () => {
    h.service.noteDeadLink('t1', 'https://example.com/gone.zip')
    h.service.noteDeadLink(null, 'https://example.com/untabbed.zip')
    expect(h.service.takeDeadLink('t2', 'https://example.com/gone.zip')).toBe(false)
    expect(h.service.takeDeadLink('t1', 'https://example.com/other.zip')).toBe(false)
    expect(h.service.takeDeadLink('t1', 'https://example.com/gone.zip')).toBe(true)
    expect(h.service.takeDeadLink('t1', 'https://example.com/gone.zip')).toBe(false)
    h.service.noteDeadLink('t1', 'https://example.com/gone.zip')
    h.clock.now += 10_001
    expect(h.service.takeDeadLink('t1', 'https://example.com/gone.zip')).toBe(false)
  })
})

describe('insecure downloads are blocked (HB-44)', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('refuses an http download an https page started before a byte is written, and the row waits', () => {
    const item = begin(h, { url: 'http://cdn.example.com/report.pdf' })
    expect(item).toMatchObject({
      state: 'insecure-blocked',
      savePath: '',
      receivedBytes: 0,
      canResume: false,
      endedAt: h.clock.now
    })
    expect(item.error).toBeUndefined()
    expect(item.insecureAccepted).toBeUndefined()
    // The file type is judged on its own: a PDF is safe, so Keep anyway may be offered.
    expect(item.danger).toEqual({ level: 'safe', reason: 'none', message: '' })
    expect(canKeepInsecure(item)).toBe(true)
    expect(h.service.inFlight).toHaveLength(0)
    expect(h.changes).toEqual([{ id: item.id, kind: 'started' }])
    // The danger hook fires so the panel opens on the blocked row, as for a flagged file.
    expect(h.dangers).toEqual([item.id])
    // Written as blocked, so the row survives a restart.
    expect(stored(h).items[0]).toMatchObject({ state: 'insecure-blocked' })
    // The transfer the host cancelled reports nothing more that counts.
    h.service.progress(item.id, { receivedBytes: 100, state: 'progressing' })
    expect(item.state).toBe('insecure-blocked')
    h.service.finish(item.id, 'cancelled')
    expect(item.state).toBe('insecure-blocked')
    expect(h.service.items).toContain(item)
  })

  it('judges the whole redirect chain; a secure chain from a secure page, or any page over http, runs', () => {
    const mixed = begin(h, {
      url: 'https://c.example/file.pdf',
      urlChain: ['https://a.example/dl', 'http://b.example/dl', 'https://c.example/file.pdf']
    })
    expect(mixed.state).toBe('insecure-blocked')
    const secure = begin(h, {
      url: 'https://c.example/file.pdf',
      urlChain: ['https://a.example/dl', 'https://c.example/file.pdf']
    })
    expect(secure.state).toBe('progressing')
    const plainPage = begin(h, {
      url: 'http://cdn.example.com/report.pdf',
      referrer: 'http://example.com/page'
    })
    expect(plainPage.state).toBe('progressing')
    const noPage = begin(h, { url: 'http://cdn.example.com/report.pdf', referrer: '' })
    expect(noPage.state).toBe('progressing')
    const local = begin(h, { url: 'http://localhost:8080/report.pdf' })
    expect(local.state).toBe('progressing')
  })

  it('Keep anyway runs the transfer again into the same row, once, and the file type still counts', async () => {
    const item = begin(h, { url: 'http://cdn.example.com/setup.exe', filename: 'setup.exe' })
    expect(item.state).toBe('insecure-blocked')
    expect(item.danger.level).toBe('dangerous')
    // No Keep anyway for a dangerous type (Chrome offers none): the call is refused.
    expect(canKeepInsecure(item)).toBe(false)
    await h.service.acceptDanger(item.id)
    expect(item.state).toBe('insecure-blocked')
    expect(h.host.count('retry')).toBe(0)

    const pdf = begin(h, { url: 'http://cdn.example.com/report.pdf' })
    h.changes.length = 0
    await h.service.acceptDanger(pdf.id)
    expect(pdf.insecureAccepted).toBe(true)
    expect(h.host.ids('retry')).toEqual([pdf.id])
    expect(stored(h).items.find((i) => i.id === pdf.id)).toMatchObject({ insecureAccepted: true })
    // The host's new request reports into the row and is not refused a second time.
    const again = h.service.begin({
      url: pdf.url,
      urlChain: [pdf.url],
      referrer: pdf.referrer,
      filename: 'report.pdf',
      totalBytes: 1000,
      mimeType: 'application/pdf',
      savePath: '/dl/report.pdf.zeniumdownload',
      resumes: pdf.id
    })
    expect(again).toBe(pdf)
    expect(pdf.state).toBe('progressing')
    expect(pdf.savePath).toBe('/dl/report.pdf.zeniumdownload')
    h.service.finish(pdf.id, 'completed', { receivedBytes: 1000 })
    await flush()
    expect(pdf.state).toBe('completed')
    expect(isQuarantined(pdf)).toBe(false)
    expect(h.host.count('release')).toBe(1)
    // A Retry later keeps the answer: the same chain is not blocked again.
    h.service.finish(pdf.id, 'interrupted', { canResume: false, error: 'server-failed' })
    h.service.retry(pdf.id)
    const third = h.service.begin({
      url: pdf.url,
      referrer: pdf.referrer,
      filename: 'report.pdf',
      totalBytes: 1000,
      mimeType: 'application/pdf',
      resumes: pdf.id
    })
    expect(third.state).toBe('progressing')
  })

  it('Discard and Remove drop the row; nothing is on disk to delete; Retry and Resume do nothing', async () => {
    const item = begin(h, { url: 'http://cdn.example.com/report.pdf' })
    expect(canRetry(item)).toBe(false)
    h.service.retry(item.id)
    h.service.resume(item.id)
    h.service.cancel(item.id)
    expect(h.host.calls).toEqual([])
    await h.service.discard(item.id)
    expect(h.host.count('deletePartial')).toBe(0)
    expect(h.service.items).toHaveLength(0)
    expect(h.changes.at(-1)).toEqual({ id: item.id, kind: 'removed', removed: true })
    const other = begin(h, { url: 'http://cdn.example.com/other.pdf' })
    h.service.remove(other.id)
    expect(h.service.items).toHaveLength(0)
    const third = begin(h, { url: 'http://cdn.example.com/third.pdf' })
    h.service.removeCompleted()
    expect(h.service.items).toHaveLength(0)
    expect(third.state).toBe('insecure-blocked')
  })

  it('a host that learns the chain late reports the refusal through finish (the Kotlin downloader)', async () => {
    const item = begin(h)
    expect(item.state).toBe('progressing')
    h.changes.length = 0
    h.service.finish(item.id, 'insecure-blocked')
    expect(item).toMatchObject({ state: 'insecure-blocked', savePath: '', receivedBytes: 0 })
    // Whatever the host wrote before it knew is deleted.
    expect(h.host.ids('deletePartial')).toEqual([item.id])
    expect(h.changes).toEqual([{ id: item.id, kind: 'done' }])
    expect(h.dangers).toEqual([item.id])
    await h.service.acceptDanger(item.id)
    expect(h.host.ids('retry')).toEqual([item.id])
  })

  it('a Safe Browsing verdict on a blocked row takes Keep anyway away', async () => {
    const provider: DangerVerdictProvider = {
      verdict: async () => ({ level: 'dangerous', reason: 'url-verdict', message: 'Malware.' })
    }
    h.service.addVerdictProvider(provider)
    const item = begin(h, { url: 'http://cdn.example.com/report.pdf' })
    expect(item.state).toBe('insecure-blocked')
    await flush()
    expect(item.danger.level).toBe('dangerous')
    expect(canKeepInsecure(item)).toBe(false)
    expect(item.state).toBe('insecure-blocked')
  })

  it('the private list forgets its blocked rows with the session', () => {
    const item = begin(h, { url: 'http://cdn.example.com/report.pdf', private: true })
    expect(item.state).toBe('insecure-blocked')
    expect(stored(h).items).toHaveLength(0)
    h.service.endPrivateSession()
    expect(h.service.items).toHaveLength(0)
  })
})

describe('automatic resume after a transient network failure (HB-43)', () => {
  let h: Harness
  beforeEach(() => {
    vi.useFakeTimers()
    h = harness()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A running transfer that the network just dropped, resumable. */
  function dropped(over: Partial<Parameters<DownloadService['begin']>[0]> = {}): DownloadItem {
    const item = begin(h, over)
    h.service.progress(item.id, { receivedBytes: 300, state: 'progressing' })
    h.service.progress(item.id, {
      receivedBytes: 300,
      state: 'interrupted',
      canResume: true,
      error: 'network-disconnected'
    })
    return item
  }

  it('schedules resume 2 / 4 / 8 s after each failure in a row, then leaves the row to the user', () => {
    const item = dropped()
    expect(item.state).toBe('interrupted')
    expect(item.autoResumeAt).toBe(h.clock.now + 2000)
    // Not persisted: a restart offers Resume, it does not retry on its own.
    expect(stored(h).items[0]!.autoResumeAt).toBeUndefined()
    vi.advanceTimersByTime(1999)
    expect(h.host.count('resume')).toBe(0)
    vi.advanceTimersByTime(1)
    expect(h.host.ids('resume')).toEqual([item.id])
    expect(item.autoResumeAt).toBeUndefined()

    // The host's resume runs, then the network drops again: the second step.
    h.service.progress(item.id, { receivedBytes: 300, state: 'progressing' })
    h.service.progress(item.id, {
      receivedBytes: 300,
      state: 'interrupted',
      canResume: true,
      error: 'network-failed'
    })
    expect(item.autoResumeAt).toBe(h.clock.now + 4000)
    vi.advanceTimersByTime(4000)
    expect(h.host.count('resume')).toBe(2)
    h.service.progress(item.id, { receivedBytes: 300, state: 'progressing' })
    h.service.progress(item.id, {
      receivedBytes: 300,
      state: 'interrupted',
      canResume: true,
      error: 'network-timeout'
    })
    expect(item.autoResumeAt).toBe(h.clock.now + 8000)
    vi.advanceTimersByTime(8000)
    expect(h.host.count('resume')).toBe(3)
    // The fourth failure in a row: interrupted with Resume / Retry, nothing scheduled.
    h.service.progress(item.id, { receivedBytes: 300, state: 'progressing' })
    h.service.progress(item.id, {
      receivedBytes: 300,
      state: 'interrupted',
      canResume: true,
      error: 'network-server-down'
    })
    expect(item.autoResumeAt).toBeUndefined()
    vi.advanceTimersByTime(60_000)
    expect(h.host.count('resume')).toBe(3)
    expect(item.state).toBe('interrupted')
    expect(item.canResume).toBe(true)
  })

  it('bytes arriving start the count over', () => {
    const item = dropped()
    vi.advanceTimersByTime(2000)
    expect(h.host.count('resume')).toBe(1)
    h.service.progress(item.id, { receivedBytes: 301, state: 'progressing' })
    h.service.progress(item.id, {
      receivedBytes: 301,
      state: 'interrupted',
      canResume: true,
      error: 'network-failed'
    })
    // Back to the first step, not the second.
    expect(item.autoResumeAt).toBe(h.clock.now + 2000)
  })

  it('never for a server refusal, a server without ranges, a file error, a stop of the user’s, or a blob', () => {
    const cases: Array<[Partial<DownloadItem>, string]> = [
      [{ canResume: true, error: 'server-bad-content' }, '404'],
      [{ canResume: true, error: 'server-forbidden' }, '403'],
      [{ canResume: false, error: 'network-failed' }, 'no ranges'],
      [{ canResume: true, error: 'server-no-range' }, '416'],
      [{ canResume: true, error: 'file-no-space' }, 'file'],
      [{ canResume: true, error: 'user-shutdown' }, 'shutdown']
    ]
    for (const [patch] of cases) {
      const item = begin(h)
      h.service.progress(item.id, {
        receivedBytes: 10,
        state: 'interrupted',
        canResume: patch.canResume,
        error: patch.error
      })
      expect(item.autoResumeAt).toBeUndefined()
    }
    const blob = begin(h, { url: 'blob:https://example.com/abc' })
    h.service.progress(blob.id, {
      receivedBytes: 10,
      state: 'interrupted',
      canResume: true,
      error: 'network-failed'
    })
    expect(blob.autoResumeAt).toBeUndefined()
    // No validator on the row (no ETag, no Last-Modified): a resume could only start over from
    // byte 0, and a restart is the user's Retry, whatever the host says about resuming.
    const unverified = begin(h, { etag: '', lastModified: '' })
    h.service.progress(unverified.id, {
      receivedBytes: 10,
      state: 'interrupted',
      canResume: true,
      error: 'network-failed'
    })
    expect(unverified.autoResumeAt).toBeUndefined()
    vi.advanceTimersByTime(60_000)
    expect(h.host.count('resume')).toBe(0)
    // A Last-Modified alone is a validator.
    const dated = begin(h, { etag: '', lastModified: 'Mon, 21 Sep 2026 10:00:00 GMT' })
    h.service.progress(dated.id, {
      receivedBytes: 10,
      state: 'interrupted',
      canResume: true,
      error: 'network-failed'
    })
    expect(dated.autoResumeAt).toBe(h.clock.now + 2000)
    h.service.remove(dated.id)
    // A terminal interruption (the host's done) that is resumable and transient also schedules.
    const term = begin(h)
    h.service.finish(term.id, 'interrupted', { canResume: true, error: 'network-failed' })
    expect(term.autoResumeAt).toBe(h.clock.now + 2000)
    vi.advanceTimersByTime(60_000)
    expect(h.host.count('resume')).toBe(1)
  })

  it('waits for the host’s network to come back, then resumes at once', () => {
    let online = false
    const listeners = new Set<() => void>()
    h.host.isOnline = () => online
    h.host.onOnline = (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
    const item = dropped()
    vi.advanceTimersByTime(2000)
    expect(h.host.count('resume')).toBe(0)
    expect(listeners.size).toBe(1)
    vi.advanceTimersByTime(60_000)
    expect(h.host.count('resume')).toBe(0)
    online = true
    for (const l of [...listeners]) l()
    expect(h.host.ids('resume')).toEqual([item.id])
    expect(listeners.size).toBe(0)
  })

  it('the user’s own Resume, Retry, Cancel or removal drop the schedule', () => {
    const a = dropped()
    h.service.resume(a.id)
    expect(a.autoResumeAt).toBeUndefined()
    expect(h.host.ids('resume')).toEqual([a.id])
    vi.advanceTimersByTime(60_000)
    expect(h.host.count('resume')).toBe(1)

    const b = dropped()
    h.service.retry(b.id)
    expect(b.autoResumeAt).toBeUndefined()
    vi.advanceTimersByTime(60_000)
    expect(h.host.count('resume')).toBe(1)

    const c = dropped()
    h.service.remove(c.id)
    vi.advanceTimersByTime(60_000)
    expect(h.host.count('resume')).toBe(1)

    const d = dropped()
    h.service.finish(d.id, 'cancelled')
    expect(d.autoResumeAt).toBeUndefined()
    vi.advanceTimersByTime(60_000)
    expect(h.host.count('resume')).toBe(1)
  })

  it('a host that retries on its own (Android) sees nothing scheduled', () => {
    h.host.autoResume = 'host'
    const item = dropped()
    expect(item.autoResumeAt).toBeUndefined()
    vi.advanceTimersByTime(60_000)
    expect(h.host.count('resume')).toBe(0)
  })

  it('a resume the core did not start (a Retry, a restart) keeps the count for the next failure', () => {
    const item = dropped()
    vi.advanceTimersByTime(2000)
    expect(h.host.count('resume')).toBe(1)
    // The host's transfer picked the row up again through begin (a resume after a restart).
    h.service.begin({
      url: item.url,
      filename: item.filename,
      totalBytes: 1000,
      mimeType: 'application/pdf',
      savePath: item.savePath,
      resumes: item.id
    })
    h.service.progress(item.id, {
      receivedBytes: 300,
      state: 'interrupted',
      canResume: true,
      error: 'network-failed'
    })
    expect(item.autoResumeAt).toBe(h.clock.now + 4000)
  })

  it('nothing is retried on the way out: shutdown clears the schedule', () => {
    const item = dropped()
    h.service.shutdown()
    expect(item.autoResumeAt).toBeUndefined()
    vi.advanceTimersByTime(60_000)
    expect(h.host.count('resume')).toBe(0)
  })

  it('the exact reason arriving late as a server refusal drops the schedule; a network one keeps it', () => {
    // The host probed the server after the drop and found it answers the range with a 200: no
    // ranges, so the engine's next attempt would only start over. Nothing is retried.
    const noRange = dropped()
    expect(noRange.autoResumeAt).toBe(h.clock.now + 2000)
    h.service.reclassify(noRange.id, 'server-no-range')
    expect(noRange.error).toBe('server-no-range')
    expect(noRange.autoResumeAt).toBeUndefined()
    vi.advanceTimersByTime(60_000)
    expect(h.host.count('resume')).toBe(0)
    expect(noRange.state).toBe('interrupted')
    // A 404 behind it likewise.
    const gone = dropped()
    h.service.reclassify(gone.id, 'server-bad-content')
    expect(gone.autoResumeAt).toBeUndefined()
    // The network's own reasons refining each other change nothing about the schedule.
    const timedOut = dropped()
    const at = timedOut.autoResumeAt
    h.service.reclassify(timedOut.id, 'network-timeout')
    expect(timedOut.autoResumeAt).toBe(at)
    vi.advanceTimersByTime(2000)
    expect(h.host.ids('resume')).toEqual([timedOut.id])
  })
})

describe('the file on disk: deleteFile, exists and fileMissing', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
    h.host.files = new Set()
  })

  async function completed(over: Parameters<typeof begin>[1] = {}): Promise<DownloadItem> {
    const item = begin(h, over)
    h.service.finish(item.id, 'completed', { receivedBytes: 1000 })
    await flush()
    h.host.files!.add(item.savePath)
    return item
  }

  it('deleteFile removes the completed file, marks the row and keeps it', async () => {
    const item = await completed()
    h.changes.length = 0
    await expect(h.service.deleteFile(item.id)).resolves.toBe('deleted')
    expect(h.host.files!.has('/dl/report.pdf')).toBe(false)
    expect(item.fileMissing).toBe(true)
    expect(item.state).toBe('completed')
    expect(item.savePath).toBe('/dl/report.pdf')
    expect(h.service.items).toEqual([item])
    expect(h.changes).toEqual([{ id: item.id, kind: 'progress' }])
    expect(stored(h).items[0]!.fileMissing).toBe(true)
    // Again: nothing to do, said clearly, and no second change.
    await expect(h.service.deleteFile(item.id)).resolves.toBe('missing')
    expect(h.host.count('deleteFile')).toBe(1)
    expect(h.changes).toHaveLength(1)
  })

  it('deleteFile on a file that vanished already marks the row and says so', async () => {
    const item = await completed()
    h.host.files!.delete(item.savePath)
    await expect(h.service.deleteFile(item.id)).resolves.toBe('missing')
    expect(item.fileMissing).toBe(true)
  })

  it('deleteFile leaves a row alone when the host cannot remove the file', async () => {
    const item = await completed()
    h.host.deleteFailsFor.add(item.savePath)
    await expect(h.service.deleteFile(item.id)).resolves.toBe('failed')
    expect(item.fileMissing).toBeUndefined()
    expect(h.host.files!.has(item.savePath)).toBe(true)
  })

  it('deleteFile acts on completed, released rows only', async () => {
    const running = begin(h)
    await expect(h.service.deleteFile(running.id)).resolves.toBe('not-completed')
    await expect(h.service.deleteFile('nope')).resolves.toBe('not-completed')
    h.service.finish(running.id, 'interrupted', { canResume: false })
    await expect(h.service.deleteFile(running.id)).resolves.toBe('not-completed')
    const flagged = begin(h, {
      url: 'https://sketchy.example/setup.exe',
      filename: 'setup.exe',
      savePath: '/dl/setup.exe.zeniumdownload'
    })
    h.service.finish(flagged.id, 'completed', { receivedBytes: 1000 })
    await flush()
    expect(isQuarantined(flagged)).toBe(true)
    await expect(h.service.deleteFile(flagged.id)).resolves.toBe('not-completed')
    expect(h.host.count('deleteFile')).toBe(0)
  })

  it('exists checks now and the row follows the answer both ways', async () => {
    const item = await completed()
    await expect(h.service.exists(item.id)).resolves.toBe(true)
    expect(item.fileMissing).toBeUndefined()
    h.host.files!.delete(item.savePath)
    h.changes.length = 0
    await expect(h.service.exists(item.id)).resolves.toBe(false)
    expect(item.fileMissing).toBe(true)
    expect(h.changes).toEqual([{ id: item.id, kind: 'progress' }])
    // The file came back (restored from the bin): the mark goes.
    h.host.files!.add(item.savePath)
    await expect(h.service.exists(item.id)).resolves.toBe(true)
    expect(item.fileMissing).toBeUndefined()
    // Rows without a completed file answer false and are not marked.
    const running = begin(h, { url: 'https://x.example/b', savePath: '/dl/b.zeniumdownload' })
    await expect(h.service.exists(running.id)).resolves.toBe(false)
    expect(running.fileMissing).toBeUndefined()
    await expect(h.service.exists('nope')).resolves.toBe(false)
  })

  it('a host without an answer changes nothing', async () => {
    const item = await completed()
    h.host.existsThrows = true
    await expect(h.service.exists(item.id)).resolves.toBe(true)
    expect(item.fileMissing).toBeUndefined()
  })

  it('checks the loaded rows as the list loads and marks those whose file is gone', async () => {
    const kept = await completed()
    const lost = await completed({
      url: 'https://x.example/lost.bin',
      filename: 'lost.bin',
      savePath: '/dl/lost.bin.zeniumdownload'
    })
    h.host.files!.delete(lost.savePath)
    h.service.flushSync()

    const disk = new FakeHost()
    disk.files = h.host.files
    const second = harness({}, h.io, disk)
    // The first snapshot goes out untouched; the rows that lost their file follow as changes.
    expect(second.service.item(lost.id)!.fileMissing).toBeUndefined()
    await second.service.loaded
    expect(second.service.item(lost.id)!.fileMissing).toBe(true)
    expect(second.service.item(kept.id)!.fileMissing).toBeUndefined()
    expect(second.changes).toEqual([{ id: lost.id, kind: 'progress' }])
    expect(second.host.ids('exists').sort()).toEqual([kept.id, lost.id].sort())
  })

  it('open checks the file first and refuses one that is gone', async () => {
    const item = await completed()
    await h.service.open(item.id)
    expect(h.host.opened).toEqual([item.id])
    h.host.files!.delete(item.savePath)
    await h.service.open(item.id)
    expect(h.host.opened).toEqual([item.id])
    expect(item.fileMissing).toBe(true)
  })

  it('a snapshot after a row was opened or revealed checks its file again', async () => {
    const item = await completed()
    await h.service.open(item.id)
    h.host.calls.length = 0
    h.service.visibleTo(false)
    await flush()
    expect(h.host.ids('exists')).toEqual([item.id])
    // Once per open or reveal: the next snapshot is quiet.
    h.service.visibleTo(false)
    await flush()
    expect(h.host.ids('exists')).toEqual([item.id])

    h.service.showInFolder(item.id)
    expect(h.host.count('showInFolder')).toBe(1)
    h.host.files!.delete(item.savePath)
    h.service.visibleTo(true)
    await flush()
    expect(item.fileMissing).toBe(true)
  })

  it('a deleted row retries into the same row, with nothing of ours to delete first', async () => {
    const item = await completed()
    expect(canRetry(item)).toBe(false)
    await h.service.deleteFile(item.id)
    expect(canRetry(item)).toBe(true)
    h.service.resume(item.id)
    expect(h.host.ids('retry')).toEqual([item.id])
    expect(h.host.count('deletePartial')).toBe(0)
    // As with any retry, the row waits for the host's report of the new transfer.
    expect(item).toMatchObject({ state: 'completed', savePath: '', receivedBytes: 0 })
    const again = h.service.begin({
      url: item.url,
      filename: 'report.pdf',
      totalBytes: 1000,
      mimeType: 'application/pdf',
      savePath: '/dl/report.pdf.zeniumdownload',
      resumes: item.id
    })
    expect(again).toBe(item)
    expect(item.state).toBe('progressing')
    expect(item.fileMissing).toBeUndefined()
    h.service.finish(item.id, 'completed', { receivedBytes: 1000 })
    await flush()
    expect(item.state).toBe('completed')
    expect(h.service.items).toHaveLength(1)
  })

  it('fileMissing survives a restart; a row whose file is back is un-marked on load', async () => {
    const item = await completed()
    await h.service.deleteFile(item.id)
    h.service.flushSync()
    const disk = new FakeHost()
    disk.files = h.host.files
    const second = harness({}, h.io, disk)
    expect(second.service.item(item.id)!.fileMissing).toBe(true)
    await second.service.loaded
    expect(second.service.item(item.id)!.fileMissing).toBe(true)
    expect(second.changes).toEqual([])
    h.host.files!.add(item.savePath)
    const third = harness({}, h.io, disk)
    await third.service.loaded
    expect(third.service.item(item.id)!.fileMissing).toBeUndefined()
    expect(third.changes).toEqual([{ id: item.id, kind: 'progress' }])
  })
})

describe('persistence and migration', () => {
  it('reads version 1 records and turns what was in flight into interruptions', () => {
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
      finalName: 'x.zip',
      canResume: false,
      danger: { level: 'safe', reason: 'none', message: '' },
      dangerAccepted: false,
      private: false,
      containerId: 'default',
      completedAt: 5,
      endedAt: 5
    })
    expect(items[0]!.error).toBeUndefined()
    // Version 1 builds did not write their rows on quit: one still in flight was shut down over.
    expect(items[1]).toMatchObject({
      id: 'dl-2',
      state: 'interrupted',
      error: 'user-shutdown',
      errorMessage: 'Couldn’t finish download',
      canResume: false
    })
    expect(items[1]!.completedAt).toBeUndefined()
  })

  it('reads this build’s records; a row still in flight in the file was never shut down (crash)', () => {
    const io = new MemoryIO()
    const first = harness({}, io)
    const item = begin(first, {
      filename: 'setup.exe',
      finalName: 'setup(1).exe',
      savePath: '/dl/setup(1).exe.zeniumdownload'
    })
    first.service.progress(item.id, {
      receivedBytes: 400,
      state: 'progressing',
      etag: '"abc"',
      canResume: true
    })
    first.service.flushSync()
    const second = harness({}, io)
    const restored = second.service.items[0]!
    expect(restored.id).toBe(item.id)
    expect(restored.state).toBe('interrupted')
    expect(restored.error).toBe('crash')
    expect(restored.canResume).toBe(true)
    expect(restored.etag).toBe('"abc"')
    expect(restored.finalName).toBe('setup(1).exe')
    expect(restored.danger).toEqual({
      level: 'dangerous',
      reason: 'executable',
      message: 'This type of file can harm your device.'
    })
    expect(restored.bytesPerSecond).toBe(0)
    second.service.resume(restored.id)
    expect(second.host.count('resume')).toBe(1)
  })

  it('on quit parks the partial files of regular in-flight rows and ignores the teardown', async () => {
    const io = new MemoryIO()
    const first = harness({}, io)
    first.host.parkTo = (item) => item.savePath.replace('.zeniumdownload', '.quit.zeniumdownload')
    const running = begin(first)
    first.service.progress(running.id, { receivedBytes: 300, state: 'progressing' })
    const paused = begin(first, { filename: 'b.bin', savePath: '/dl/b.bin.zeniumdownload' })
    first.service.progress(paused.id, { receivedBytes: 100, state: 'paused' })
    const secret = begin(first, {
      filename: 'c.bin',
      savePath: '/dl/c.bin.zeniumdownload',
      containerId: PRIVATE_CONTAINER_ID
    })
    const done = begin(first, { filename: 'd.bin', savePath: '/dl/d.bin.zeniumdownload' })
    first.service.finish(done.id, 'completed', { receivedBytes: 1000 })
    await flush()

    first.service.shutdown()
    expect(first.host.ids('park').sort()).toEqual([paused.id, running.id].sort())
    expect(running.savePath).toBe('/dl/report.pdf.quit.zeniumdownload')
    expect(paused.savePath).toBe('/dl/b.bin.quit.zeniumdownload')
    expect(secret.savePath).toBe('/dl/c.bin.zeniumdownload')

    // The rows read as interrupted by the shutdown; Chromium now cancels the live items and
    // nothing of that reaches the rows or the files.
    expect(running).toMatchObject({ state: 'interrupted', error: 'user-shutdown' })
    first.service.finish(running.id, 'cancelled', { receivedBytes: 300 })
    first.service.progress(paused.id, { receivedBytes: 100, state: 'interrupted' })
    expect(running.state).toBe('interrupted')
    expect(running.receivedBytes).toBe(300)
    expect(running.savePath).toBe('/dl/report.pdf.quit.zeniumdownload')
    expect(first.host.count('deletePartial')).toBe(0)
    first.service.flushSync()

    // The shutdown wrote the in-flight rows as interrupted by it, so the file says so itself.
    expect(stored(first).items.find((i) => i.id === running.id)).toMatchObject({
      state: 'interrupted',
      error: 'user-shutdown'
    })
    const second = harness({}, io)
    const restored = second.service.item(running.id)!
    expect(restored).toMatchObject({
      state: 'interrupted',
      error: 'user-shutdown',
      errorMessage: 'Couldn’t finish download',
      canResume: true,
      savePath: '/dl/report.pdf.quit.zeniumdownload',
      receivedBytes: 300
    })
    expect(second.service.item(paused.id)!.savePath).toBe('/dl/b.bin.quit.zeniumdownload')
    expect(second.service.item(secret.id)).toBeUndefined()
    expect(second.service.item(done.id)!.state).toBe('completed')
    second.service.resume(restored.id)
    expect(second.host.ids('resume')).toEqual([restored.id])
  })

  it('on quit a host that cannot keep a partial leaves the row as it was', () => {
    const h = harness()
    const item = begin(h)
    h.service.progress(item.id, { receivedBytes: 10, state: 'progressing' })
    h.service.shutdown()
    h.service.shutdown()
    expect(h.host.count('park')).toBe(1)
    expect(item.savePath).toBe('/dl/report.pdf.zeniumdownload')
    expect(stored(h).items[0]!.savePath).toBe('/dl/report.pdf.zeniumdownload')
  })

  it('reads records written by earlier builds of this schema', () => {
    const items = migrate(
      {
        version: 2,
        items: [
          {
            id: 'dl-old',
            url: 'https://a/setup.exe',
            filename: 'setup.exe',
            savePath: '/dl/setup.exe',
            totalBytes: 10,
            receivedBytes: 10,
            state: 'completed',
            startedAt: 5,
            endedAt: 9,
            mimeType: '',
            danger: { level: 'dangerous', reason: 'file-type', kept: true },
            error: null
          } as unknown as DownloadItem
        ]
      },
      100
    )
    expect(items[0]).toMatchObject({
      finalName: 'setup.exe',
      dangerAccepted: true,
      completedAt: 9,
      danger: { level: 'dangerous', reason: 'file-type' }
    })
    expect(items[0]!.danger.message).not.toBe('')
  })

  it('survives garbage', () => {
    expect(migrate(null, 0)).toEqual([])
    expect(migrate({ version: 2, items: 'x' as unknown as DownloadItem[] }, 0)).toEqual([])
  })

  it('reads version 2 reasons onto the closed set, network-failed when nothing closer is known', () => {
    const row = (id: string, over: Record<string, unknown>): Record<string, unknown> => ({
      id,
      url: `https://a/${id}`,
      filename: id,
      finalName: id,
      savePath: `/dl/${id}.zeniumdownload`,
      totalBytes: 10,
      receivedBytes: 4,
      state: 'interrupted',
      startedAt: 5,
      endedAt: 9,
      mimeType: '',
      canResume: false,
      ...over
    })
    const items = migrate(
      {
        version: 2,
        items: [
          row('plain', { error: 'interrupted' }),
          row('none', {}),
          row('quit', { error: 'shutdown' }),
          row('disk', { error: 'file-error' }),
          row('net', { error: 'net::ERR_TIMED_OUT' }),
          row('cert', { error: 'ERR_CERT_DATE_INVALID' }),
          row('chrome', { error: 'SERVER_NO_RANGE' }),
          row('member', { error: 'file-no-space' }),
          row('odd', { error: 'something else entirely' }),
          row('flight', { state: 'progressing', error: undefined })
        ]
      },
      100
    )
    const reasons = Object.fromEntries(items.map((i) => [i.id, i.error]))
    expect(reasons).toEqual({
      plain: 'network-failed',
      none: 'network-failed',
      quit: 'user-shutdown',
      disk: 'file-failed',
      net: 'network-timeout',
      cert: 'server-failed',
      chrome: 'server-no-range',
      member: 'file-no-space',
      odd: 'network-failed',
      // Version 2 builds did not write in-flight rows on quit: the browser was shut down over it.
      flight: 'user-shutdown'
    })
    for (const item of items) {
      expect(item.state).toBe('interrupted')
      expect(item.errorMessage).not.toBe('')
    }
    expect(items.find((i) => i.id === 'net')!.errorMessage).toBe('Check internet connection')
    expect(items.find((i) => i.id === 'quit')!.errorMessage).toBe('Couldn’t finish download')
  })

  it('reads version 3 rows as written; in-flight ones were never shut down', () => {
    const base = {
      url: 'https://a/x',
      filename: 'x',
      finalName: 'x',
      totalBytes: 10,
      receivedBytes: 10,
      startedAt: 5,
      endedAt: 9,
      mimeType: '',
      canResume: false
    }
    const items = migrate(
      {
        version: 3,
        items: [
          {
            ...base,
            id: 'gone',
            state: 'completed',
            savePath: '/dl/x',
            completedAt: 9,
            fileMissing: true
          },
          { ...base, id: 'there', state: 'completed', savePath: '/dl/y', completedAt: 9 },
          {
            ...base,
            id: 'failed',
            state: 'interrupted',
            savePath: '',
            error: 'server-unauthorized',
            errorMessage: 'stale wording from an older build'
          },
          { ...base, id: 'flight', state: 'progressing', savePath: '/dl/z.zeniumdownload' }
        ] as unknown as DownloadItem[]
      },
      100
    )
    const byId = Object.fromEntries(items.map((i) => [i.id, i]))
    expect(byId['gone']!.fileMissing).toBe(true)
    expect(byId['there']!.fileMissing).toBeUndefined()
    expect(byId['failed']).toMatchObject({
      error: 'server-unauthorized',
      errorMessage: 'File wasn’t available on site'
    })
    expect(byId['flight']).toMatchObject({
      state: 'interrupted',
      error: 'crash',
      errorMessage: 'Couldn’t finish download'
    })
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
      finalName: '',
      savePath: '',
      totalBytes: 0,
      receivedBytes: 0,
      state: 'progressing',
      startedAt: 0,
      mimeType: '',
      canResume: false,
      danger: { level: 'safe', reason: 'none', message: '' },
      dangerAccepted: false,
      openWhenDone: false,
      bytesPerSecond: 0,
      etaMs: null,
      private: false,
      containerId: 'default',
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
