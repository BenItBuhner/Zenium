import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DownloadService,
  RateEstimator,
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

function harness(overrides: Partial<DownloadServiceDeps> = {}, io = new MemoryIO()): Harness {
  const host = new FakeHost()
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
    expect(data.version).toBe(2)
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
    expect(h.host.releaseNotify).toEqual([true])
    expect(h.service.inFlight).toHaveLength(0)
    expect(h.changes.at(-1)).toEqual({ id: item.id, kind: 'done' })
    expect(h.dangers).toEqual([])
  })

  it('hands the notification setting to the host and opens when asked', async () => {
    h.settings.notifyOnComplete = false
    const item = begin(h)
    h.service.setOpenWhenDone(item.id, true)
    expect(item.openWhenDone).toBe(true)
    h.service.finish(item.id, 'completed')
    await flush()
    expect(h.host.releaseNotify).toEqual([false])
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
    h.service.finish(item.id, 'interrupted', { canResume: true, error: 'network-failed' })
    expect(item.state).toBe('interrupted')
    expect(item.error).toBe('network-failed')
    expect(item.savePath).toBe('/dl/report.pdf.zeniumdownload')
    expect(item.canResume).toBe(true)
    h.service.resume(item.id)
    expect(h.host.count('resume')).toBe(1)
    expect(h.host.count('retry')).toBe(0)
  })

  it('resume of a non-resumable interruption is a retry that keeps the row', () => {
    const item = begin(h)
    h.service.finish(item.id, 'interrupted', { canResume: false })
    expect(item.error).toBe('interrupted')
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

  it('an http download from an https page is suspicious', () => {
    const item = begin(h, { url: 'http://cdn.example.com/report.pdf' })
    expect(item.danger).toEqual({
      level: 'suspicious',
      reason: 'insecure-download',
      message: 'This file was downloaded over an insecure connection.'
    })
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
    expect(items[1]).toMatchObject({
      id: 'dl-2',
      state: 'interrupted',
      error: 'shutdown',
      canResume: false
    })
    expect(items[1]!.completedAt).toBeUndefined()
  })

  it('reads version 2 records; in-flight ones come back interrupted by the shutdown', () => {
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
    expect(restored.error).toBe('shutdown')
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

    // Chromium now cancels the live items: nothing of that reaches the rows or the files.
    first.service.finish(running.id, 'cancelled', { receivedBytes: 300 })
    first.service.progress(paused.id, { receivedBytes: 100, state: 'interrupted' })
    expect(running.state).toBe('progressing')
    expect(running.savePath).toBe('/dl/report.pdf.quit.zeniumdownload')
    expect(first.host.count('deletePartial')).toBe(0)
    first.service.flushSync()

    const second = harness({}, io)
    const restored = second.service.item(running.id)!
    expect(restored).toMatchObject({
      state: 'interrupted',
      error: 'shutdown',
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
