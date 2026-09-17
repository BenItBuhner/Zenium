import { describe, expect, it } from 'vitest'
import type { DownloadItem } from '../../shared/types'
import type { AggregateProgress } from '../../shared/downloads'
import type { DownloadHost, StoreIO } from '../platform'
import { DownloadService, type DownloadChangeKind, type DownloadInit } from '../downloads'

function fakeIo(initial: string | null = null): StoreIO & { docs: Map<string, string> } {
  const docs = new Map<string, string>()
  if (initial !== null) docs.set('downloads.json', initial)
  return {
    docs,
    readSync: (name) => docs.get(name) ?? null,
    write: async (name, text) => {
      docs.set(name, text)
    },
    writeSync: (name, text) => {
      docs.set(name, text)
    }
  }
}

interface FakeHost extends DownloadHost {
  calls: string[]
  progress: AggregateProgress[]
  retried: DownloadItem[]
  deleted: string[]
}

function fakeHost(): FakeHost {
  const host: FakeHost = {
    calls: [],
    progress: [],
    retried: [],
    deleted: [],
    pause: (id) => host.calls.push(`pause:${id}`),
    resume: (id) => host.calls.push(`resume:${id}`),
    cancel: (id) => host.calls.push(`cancel:${id}`),
    retry: (item) => host.retried.push(item),
    open: async (item) => {
      host.calls.push(`open:${item.id}`)
    },
    showInFolder: (item) => host.calls.push(`show:${item.id}`),
    deleteFile: async (item) => {
      host.deleted.push(item.savePath)
    },
    defaultDirectory: () => '/downloads',
    openDirectory: (path) => host.calls.push(`dir:${path}`),
    setProgress: (p) => host.progress.push(p)
  }
  return host
}

function service(
  io = fakeIo(),
  host = fakeHost()
): {
  svc: DownloadService
  host: FakeHost
  io: ReturnType<typeof fakeIo>
  changes: Array<[string | null, DownloadChangeKind]>
} {
  const changes: Array<[string | null, DownloadChangeKind]> = []
  const svc = new DownloadService(io, host, (item, kind) => changes.push([item?.id ?? null, kind]))
  return { svc, host, io, changes }
}

const init = (patch: Partial<DownloadInit> = {}): DownloadInit => ({
  url: 'https://example.com/file.zip',
  filename: 'file.zip',
  totalBytes: 1000,
  mimeType: 'application/zip',
  savePath: '/downloads/file.zip',
  ...patch
})

describe('DownloadService transitions', () => {
  it('begins in progress, reports smoothed speed and finishes completed', () => {
    const { svc, host, changes } = service()
    const rec = svc.begin(init())
    expect(rec.state).toBe('progressing')
    expect(rec.danger).toBe('safe')
    expect(rec.urlChain).toEqual(['https://example.com/file.zip'])
    expect(changes).toEqual([[rec.id, 'started']])
    expect(host.progress.at(-1)).toEqual({ mode: 'normal', value: 0 })

    svc.progress(rec.id, { state: 'progressing', receivedBytes: 0 }, 1000)
    svc.progress(rec.id, { state: 'progressing', receivedBytes: 500 }, 2000)
    expect(svc.get(rec.id)?.bytesPerSecond).toBe(500)
    expect(host.progress.at(-1)).toEqual({ mode: 'normal', value: 0.5 })

    svc.finish(rec.id, 'completed', { receivedBytes: 1000 }, 3000)
    const done = svc.get(rec.id)!
    expect(done.state).toBe('completed')
    expect(done.endedAt).toBe(3000)
    expect(done.bytesPerSecond).toBe(0)
    expect(done.canResume).toBe(false)
    expect(changes.at(-1)).toEqual([rec.id, 'done'])
    expect(host.progress.at(-1)).toEqual({ mode: 'idle', value: 0 })
  })

  it('throttles progress broadcasts but never a state change', () => {
    const { svc, changes } = service()
    const rec = svc.begin(init())
    svc.progress(rec.id, { state: 'progressing', receivedBytes: 10 }, 1000)
    svc.progress(rec.id, { state: 'progressing', receivedBytes: 20 }, 1050)
    svc.progress(rec.id, { state: 'progressing', receivedBytes: 30 }, 1100)
    expect(changes.filter(([, k]) => k === 'progress')).toHaveLength(1)
    svc.progress(rec.id, { state: 'paused', receivedBytes: 30 }, 1120)
    expect(changes.filter(([, k]) => k === 'progress')).toHaveLength(2)
    expect(svc.get(rec.id)?.state).toBe('paused')
    expect(svc.get(rec.id)?.bytesPerSecond).toBe(0)
  })

  it('paused transfers show as paused on the taskbar; an unknown total is indeterminate', () => {
    const { svc, host } = service()
    const a = svc.begin(init())
    svc.progress(a.id, { state: 'paused', receivedBytes: 100 })
    expect(host.progress.at(-1)).toEqual({ mode: 'paused', value: 0.1 })
    svc.begin(init({ url: 'https://example.com/b', filename: 'b.bin', totalBytes: 0 }))
    expect(host.progress.at(-1)).toEqual({ mode: 'indeterminate', value: 0 })
  })

  it('marks interrupted transfers resumable, shows the error until acknowledged', () => {
    const { svc, host } = service()
    const rec = svc.begin(init())
    svc.progress(rec.id, { state: 'progressing', receivedBytes: 400 })
    svc.finish(rec.id, 'interrupted', { canResume: true, interruptReason: 'network' })
    const failed = svc.get(rec.id)!
    expect(failed.state).toBe('interrupted')
    expect(failed.canResume).toBe(true)
    expect(failed.interruptReason).toBe('network')
    expect(host.progress.at(-1)).toEqual({ mode: 'error', value: 0 })
    svc.acknowledge()
    expect(host.progress.at(-1)).toEqual({ mode: 'idle', value: 0 })
  })

  it('retries through the host and keeps the record id on restart', () => {
    const { svc, host, changes } = service()
    const rec = svc.begin(init())
    svc.begin(init({ url: 'https://example.com/other', filename: 'other.txt' }))
    svc.finish(rec.id, 'interrupted', { receivedBytes: 300, canResume: true })
    svc.retry(rec.id)
    expect(host.retried.map((i) => i.id)).toEqual([rec.id])
    const restarted = svc.restart(rec.id, init({ receivedBytes: 300, etag: '"abc"' }))
    expect(restarted.id).toBe(rec.id)
    expect(restarted.state).toBe('progressing')
    expect(restarted.receivedBytes).toBe(300)
    expect(restarted.etag).toBe('"abc"')
    expect(restarted.interruptReason).toBeUndefined()
    expect(svc.items[0].id).toBe(rec.id)
    expect(changes.at(-1)).toEqual([rec.id, 'started'])
  })

  it('ignores retry for active or completed records', () => {
    const { svc, host } = service()
    const rec = svc.begin(init())
    svc.retry(rec.id)
    svc.finish(rec.id, 'completed')
    svc.retry(rec.id)
    expect(host.retried).toEqual([])
  })

  it('classifies dangerous files on completion and gates open until a decision', async () => {
    const { svc, host } = service()
    const rec = svc.begin(init({ filename: 'setup.exe', savePath: '/downloads/setup.exe' }))
    expect(rec.danger).toBe('dangerous')
    svc.finish(rec.id, 'completed')
    await svc.open(rec.id)
    expect(host.calls).not.toContain(`open:${rec.id}`)
    svc.keep(rec.id)
    expect(svc.get(rec.id)?.dangerDecision).toBe('kept')
    await svc.open(rec.id)
    expect(host.calls).toContain(`open:${rec.id}`)
    expect(svc.get(rec.id)?.opened).toBe(true)
  })

  it('discard deletes the file and keeps the row as discarded', async () => {
    const { svc, host } = service()
    const rec = svc.begin(init({ filename: 'setup.exe', savePath: '/downloads/setup.exe' }))
    svc.finish(rec.id, 'completed')
    await svc.discard(rec.id)
    expect(host.deleted).toEqual(['/downloads/setup.exe'])
    expect(svc.get(rec.id)?.dangerDecision).toBe('discarded')
    svc.showInFolder(rec.id)
    expect(host.calls).not.toContain(`show:${rec.id}`)
  })

  it('removing an undecided dangerous file deletes it; removing an active one cancels it', () => {
    const { svc, host } = service()
    const exe = svc.begin(init({ filename: 'a.exe', savePath: '/downloads/a.exe' }))
    svc.finish(exe.id, 'completed')
    const live = svc.begin(init({ url: 'https://example.com/live', filename: 'live.bin' }))
    svc.remove(exe.id)
    svc.remove(live.id)
    expect(host.deleted).toEqual(['/downloads/a.exe'])
    expect(host.calls).toContain(`cancel:${live.id}`)
    expect(svc.items).toEqual([])
  })

  it('clearCompleted keeps live transfers and clears the error indicator', () => {
    const { svc, host } = service()
    const done = svc.begin(init())
    svc.finish(done.id, 'interrupted')
    const live = svc.begin(init({ url: 'https://example.com/live', filename: 'live.bin' }))
    svc.clearCompleted()
    expect(svc.items.map((i) => i.id)).toEqual([live.id])
    expect(host.progress.at(-1)?.mode).toBe('normal')
  })

  it('persists a versioned document and reloads interrupted transfers', () => {
    const io = fakeIo()
    const { svc } = service(io)
    const rec = svc.begin(init())
    svc.progress(rec.id, { state: 'progressing', receivedBytes: 250 }, 10_000)
    svc.flushSync()
    const doc = JSON.parse(io.docs.get('downloads.json') ?? '{}') as {
      version: number
      items: DownloadItem[]
    }
    expect(doc.version).toBe(2)
    expect(doc.items[0].receivedBytes).toBe(250)

    const reloaded = new DownloadService(io, fakeHost(), () => undefined)
    const item = reloaded.get(rec.id)!
    expect(item.state).toBe('interrupted')
    expect(item.canResume).toBe(true)
    expect(item.receivedBytes).toBe(250)
  })

  it('upgrades a v1 document on load', () => {
    const io = fakeIo(
      JSON.stringify({
        version: 1,
        items: [
          {
            id: 'dl_old',
            url: 'https://example.com/old.pdf',
            filename: 'old.pdf',
            savePath: '/downloads/old.pdf',
            totalBytes: 10,
            receivedBytes: 10,
            state: 'completed',
            startedAt: 5,
            mimeType: 'application/pdf'
          }
        ]
      })
    )
    const { svc } = service(io)
    expect(svc.items).toHaveLength(1)
    expect(svc.items[0]).toMatchObject({
      id: 'dl_old',
      state: 'completed',
      urlChain: ['https://example.com/old.pdf'],
      danger: 'safe',
      endedAt: 5
    })
    svc.flushSync()
    expect(JSON.parse(io.docs.get('downloads.json') ?? '{}').version).toBe(2)
  })

  it('never flags files dangerous on a host that cannot delete them, and skips retry there', () => {
    const host = fakeHost()
    delete host.deleteFile
    delete host.retry
    const { svc } = service(fakeIo(), host)
    const rec = svc.begin(init({ filename: 'setup.exe', mimeType: 'application/x-msdownload' }))
    svc.finish(rec.id, 'interrupted')
    expect(rec.danger).toBe('safe')
    svc.retry(rec.id)
    expect(host.retried).toHaveLength(0)
    expect(rec.state).toBe('interrupted')
  })
})
