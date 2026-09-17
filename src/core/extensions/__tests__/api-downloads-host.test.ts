import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DownloadService } from '../../downloads'
import type { DownloadHost, StoreIO } from '../../platform'
import { DangerVerdictRegistry } from '../../downloads/danger'
import type { DownloadItem, ExtensionInfo } from '../../../shared/types'
import { DEFAULT_DOWNLOAD_SETTINGS } from '../../../shared/downloads'
import { DownloadsApi, type DownloadBridge } from '../../../main/platform/extensionApi/downloads'
import type {
  ApiContext,
  ApiHost,
  LoadedExtension
} from '../../../main/platform/extensionApi/types'
import type { FilenameDeterminer, ProgrammaticDownload } from '../../../main/platform/downloads'
import {
  ERROR_FILE_ALREADY_DELETED,
  ERROR_INVALID_ID,
  ERROR_NOT_COMPLETE,
  ERROR_NOT_DANGEROUS,
  ERROR_NOT_IN_PROGRESS,
  ERROR_NOT_RESUMABLE,
  ERROR_NO_PERMISSION,
  ERROR_OPEN_PERMISSION,
  type ChromeDownloadItem,
  type DownloadDelta
} from '../../extensions/api/downloads'

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

class FakeDownloadHost implements DownloadHost {
  calls: string[] = []
  opened: string[] = []
  pause(id: string): void {
    this.calls.push(`pause:${id}`)
  }
  resume(item: DownloadItem): void {
    this.calls.push(`resume:${item.id}`)
  }
  cancel(id: string): void {
    this.calls.push(`cancel:${id}`)
  }
  retry(item: DownloadItem): void {
    this.calls.push(`retry:${item.id}`)
  }
  async release(item: DownloadItem): Promise<{ savePath: string; finalName: string } | null> {
    this.calls.push(`release:${item.id}`)
    return { savePath: item.savePath.replace('.zeniumdownload', ''), finalName: item.finalName }
  }
  async deletePartial(item: DownloadItem): Promise<void> {
    this.calls.push(`deletePartial:${item.id}`)
  }
  async open(item: DownloadItem): Promise<void> {
    this.opened.push(item.id)
  }
  showInFolder(item: DownloadItem): void {
    this.calls.push(`show:${item.id}`)
  }
}

interface Dispatched {
  extensionId: string
  event: string
  args: unknown[]
}

const EXT_A = 'a'.repeat(32)
const EXT_B = 'b'.repeat(32)
const NOW = Date.UTC(2026, 8, 17, 12, 0, 0)

function harness(): {
  api: DownloadsApi
  service: DownloadService
  downloadHost: FakeDownloadHost
  bridge: DownloadBridge & {
    files: Set<string>
    targets: Map<string, string>
    determiner: FilenameDeterminer | null
    started: ProgrammaticDownload[]
    shown: number
  }
  out: Dispatched[]
  grants: Record<string, string[]>
  listeners: Set<string>
  infos: ExtensionInfo[]
  answers: boolean[]
  ctx: (id: string) => ApiContext
  load: (id: string, name?: string) => void
  begin: (over?: Partial<Parameters<DownloadService['begin']>[0]>) => DownloadItem
  flush: () => Promise<void>
  clock: { now: number }
} {
  const io = new MemoryIO()
  const downloadHost = new FakeDownloadHost()
  const clock = { now: NOW }
  let api: DownloadsApi | null = null
  const service = new DownloadService(io, downloadHost, () => api?.tick(), {
    os: 'win32',
    settings: () => ({ ...DEFAULT_DOWNLOAD_SETTINGS }),
    referrerFamiliar: () => false,
    verdicts: new DangerVerdictRegistry(),
    now: () => clock.now
  })
  const loaded = new Map<string, LoadedExtension>()
  const grants: Record<string, string[]> = {}
  const listeners = new Set<string>()
  const infos: ExtensionInfo[] = []
  const out: Dispatched[] = []
  const answers: boolean[] = []
  const host = {
    browser: { downloads: service, extensions: { list: () => infos } },
    registry: {
      hasListener: (id: string, ns: string, ev: string) => listeners.has(`${id}:${ns}.${ev}`)
    },
    allLoaded: () => [...loaded.values()],
    grants: (id: string) => ({ permissions: grants[id] ?? [], origins: [] }),
    broadcast(
      namespace: string,
      event: string,
      argsFor: (ext: LoadedExtension) => unknown[] | null
    ): void {
      for (const ext of loaded.values()) {
        const args = argsFor(ext)
        if (args) out.push({ extensionId: ext.id, event: `${namespace}.${event}`, args })
      }
    },
    dispatch(extensionId: string, namespace: string, event: string, args: unknown[]): void {
      out.push({ extensionId, event: `${namespace}.${event}`, args })
    },
    scheduleTick: () => api?.tick(),
    confirm: async () => answers.shift() ?? false
  }
  const bridge = {
    files: new Set<string>(),
    targets: new Map<string, string>(),
    determiner: null as FilenameDeterminer | null,
    started: [] as ProgrammaticDownload[],
    shown: 0,
    async startDownload(request: ProgrammaticDownload): Promise<DownloadItem> {
      bridge.started.push(request)
      const name = request.suggestion?.filename.split('/').pop() ?? 'file.bin'
      return service.begin({
        url: request.url,
        filename: name,
        totalBytes: 10,
        mimeType: 'application/octet-stream',
        savePath: `/dl/${name}.zeniumdownload`
      })
    },
    setFilenameDeterminer(determiner: FilenameDeterminer | null): void {
      bridge.determiner = determiner
    },
    targetPath: (id: string) => bridge.targets.get(id) ?? null,
    fileExists: (path: string) => bridge.files.has(path),
    async deleteFile(path: string): Promise<boolean> {
      return bridge.files.delete(path)
    },
    async fileIcon(path: string, size: 16 | 32): Promise<string | null> {
      return path.endsWith('.none') ? null : `data:image/png;base64,${size}`
    },
    showDefaultFolder(): void {
      bridge.shown += 1
    }
  }
  api = new DownloadsApi(host as unknown as ApiHost, bridge, () => clock.now)
  api.attach()
  const load = (id: string, name = 'Ext'): void => {
    loaded.set(id, {
      id,
      manifest: { name, manifest_version: 3 }
    } as unknown as LoadedExtension)
    grants[id] = ['downloads']
    // Each load is a newer install than the one before.
    infos.push({ id, installedAt: NOW + 1000 * infos.length } as unknown as ExtensionInfo)
    api?.tick()
  }
  const ctx = (id: string): ApiContext =>
    ({ extensionId: id, extension: loaded.get(id) }) as unknown as ApiContext
  const begin = (over: Partial<Parameters<DownloadService['begin']>[0]> = {}): DownloadItem =>
    service.begin({
      url: 'https://cdn.example.com/report.pdf',
      referrer: 'https://example.com/page',
      filename: 'report.pdf',
      totalBytes: 1000,
      mimeType: 'application/pdf',
      savePath: '/dl/report.pdf.zeniumdownload',
      canResume: true,
      ...over
    })
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  return {
    api,
    service,
    downloadHost,
    bridge,
    out,
    grants,
    listeners,
    infos,
    answers,
    ctx,
    load,
    begin,
    flush,
    clock
  }
}

const call = async (
  api: DownloadsApi,
  method: string,
  ctx: ApiContext,
  ...args: unknown[]
): Promise<unknown> => await api.handlers[method]!(ctx, ...args)

const failsWith = async (
  api: DownloadsApi,
  method: string,
  ctx: ApiContext,
  message: string,
  ...args: unknown[]
): Promise<void> => {
  await expect(call(api, method, ctx, ...args)).rejects.toThrow(message)
}

describe('DownloadsApi events from the list', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('fires onCreated, onChanged for state changes only, and onErased', async () => {
    const h = harness()
    h.load(EXT_A)
    const item = h.begin()
    expect(h.out.map((o) => o.event)).toEqual(['downloads.onCreated'])
    const created = h.out[0]!.args[0] as ChromeDownloadItem
    expect(created).toMatchObject({
      state: 'in_progress',
      filename: '/dl/report.pdf',
      totalBytes: 1000,
      bytesReceived: 0,
      exists: true
    })
    const id = created.id
    h.out.length = 0

    h.clock.now += 1000
    h.service.progress(item.id, { receivedBytes: 300, state: 'progressing' })
    expect(h.out).toEqual([])

    h.service.progress(item.id, { receivedBytes: 300, state: 'paused' })
    expect(h.out.map((o) => o.event)).toEqual(['downloads.onChanged'])
    expect(h.out[0]!.args[0]).toEqual({
      id,
      paused: { previous: false, current: true },
      canResume: { previous: false, current: true }
    })
    h.out.length = 0

    h.service.progress(item.id, { receivedBytes: 1000, state: 'progressing' })
    h.out.length = 0
    h.service.finish(item.id, 'completed')
    await h.flush()
    const delta = h.out.find((o) => o.event === 'downloads.onChanged')?.args[0] as DownloadDelta
    expect(delta.state).toEqual({ previous: 'in_progress', current: 'complete' })
    expect(delta.fileSize).toEqual({ previous: -1, current: 1000 })
    expect(delta.endTime?.current).toBe(new Date(h.clock.now).toISOString())
    expect(h.downloadHost.calls).toContain(`release:${item.id}`)
    h.out.length = 0

    h.service.remove(item.id)
    expect(h.out).toEqual([{ extensionId: EXT_A, event: 'downloads.onErased', args: [id] }])
  })

  it('tells nothing to extensions without the permission, and hides private downloads', async () => {
    const h = harness()
    h.load(EXT_A)
    h.grants[EXT_A] = []
    h.begin()
    expect(h.out).toEqual([])
    h.grants[EXT_A] = ['downloads']
    h.begin({ private: true, savePath: '/p/x.zeniumdownload' })
    expect(h.out).toEqual([])
    await expect(call(h.api, 'search', h.ctx(EXT_A), {})).resolves.toHaveLength(1)
  })

  it('starts its baseline when the first extension loads', () => {
    const h = harness()
    h.begin()
    h.load(EXT_A)
    expect(h.out).toEqual([])
    h.begin({ url: 'https://x.example/b', filename: 'b.bin', savePath: '/dl/b.bin.zeniumdownload' })
    expect(h.out.map((o) => o.event)).toEqual(['downloads.onCreated'])
  })
})

describe('DownloadsApi methods', () => {
  it('searches in Chrome shape and refreshes exists', async () => {
    const h = harness()
    h.load(EXT_A)
    const item = h.begin()
    h.service.finish(item.id, 'completed')
    await h.flush()
    h.bridge.files.add('/dl/report.pdf')
    const hits = (await call(h.api, 'search', h.ctx(EXT_A), {
      state: 'complete'
    })) as ChromeDownloadItem[]
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ filename: '/dl/report.pdf', exists: true, state: 'complete' })
    h.out.length = 0
    h.bridge.files.delete('/dl/report.pdf')
    const again = (await call(h.api, 'search', h.ctx(EXT_A), {})) as ChromeDownloadItem[]
    expect(again[0]!.exists).toBe(false)
    expect(h.out.map((o) => o.event)).toEqual(['downloads.onChanged'])
    expect((h.out[0]!.args[0] as DownloadDelta).exists).toEqual({
      previous: true,
      current: false
    })
    h.grants[EXT_A] = []
    await failsWith(h.api, 'search', h.ctx(EXT_A), ERROR_NO_PERMISSION, {})
  })

  it('pauses, resumes and cancels through the service with Chrome refusals', async () => {
    const h = harness()
    h.load(EXT_A)
    const item = h.begin()
    const id = (h.out[0]!.args[0] as ChromeDownloadItem).id
    await failsWith(h.api, 'pause', h.ctx(EXT_A), ERROR_INVALID_ID, 12345)
    await failsWith(h.api, 'pause', h.ctx(EXT_A), ERROR_INVALID_ID, 'x')
    await failsWith(h.api, 'resume', h.ctx(EXT_A), ERROR_NOT_RESUMABLE, id)
    await call(h.api, 'pause', h.ctx(EXT_A), id)
    expect(h.downloadHost.calls).toEqual([`pause:${item.id}`])
    h.service.progress(item.id, { state: 'paused' })
    await call(h.api, 'resume', h.ctx(EXT_A), id)
    expect(h.downloadHost.calls).toEqual([`pause:${item.id}`, `resume:${item.id}`])
    await call(h.api, 'cancel', h.ctx(EXT_A), 99999)
    await call(h.api, 'cancel', h.ctx(EXT_A), id)
    expect(h.downloadHost.calls.at(-1)).toBe(`cancel:${item.id}`)
    h.service.finish(item.id, 'cancelled')
    await failsWith(h.api, 'pause', h.ctx(EXT_A), ERROR_NOT_IN_PROGRESS, id)
    await failsWith(h.api, 'resume', h.ctx(EXT_A), ERROR_NOT_RESUMABLE, id)
    const shape = ((await call(h.api, 'search', h.ctx(EXT_A), { id })) as ChromeDownloadItem[])[0]
    expect(shape).toMatchObject({ state: 'interrupted', error: 'USER_CANCELED' })
  })

  it('erases what a query matches and returns the ids', async () => {
    const h = harness()
    h.load(EXT_A)
    const a = h.begin()
    const b = h.begin({
      url: 'https://x.example/b.bin',
      filename: 'b.bin',
      savePath: '/dl/b.zeniumdownload'
    })
    h.service.finish(a.id, 'completed')
    await h.flush()
    h.bridge.files.add('/dl/report.pdf')
    const ids = h.out
      .filter((o) => o.event === 'downloads.onCreated')
      .map((o) => (o.args[0] as ChromeDownloadItem).id)
    h.out.length = 0
    const erased = await call(h.api, 'erase', h.ctx(EXT_A), { state: 'complete' })
    expect(erased).toEqual([ids[0]])
    expect(h.service.items.map((i) => i.id)).toEqual([b.id])
    expect(h.out).toEqual([{ extensionId: EXT_A, event: 'downloads.onErased', args: [ids[0]] }])
  })

  it('removes a completed file once, then reports it gone', async () => {
    const h = harness()
    h.load(EXT_A)
    const item = h.begin()
    const id = (h.out[0]!.args[0] as ChromeDownloadItem).id
    await failsWith(h.api, 'removeFile', h.ctx(EXT_A), ERROR_NOT_COMPLETE, id)
    h.service.finish(item.id, 'completed')
    await h.flush()
    h.bridge.files.add('/dl/report.pdf')
    h.out.length = 0
    await call(h.api, 'removeFile', h.ctx(EXT_A), id)
    expect(h.bridge.files.has('/dl/report.pdf')).toBe(false)
    expect((h.out[0]!.args[0] as DownloadDelta).exists).toEqual({ previous: true, current: false })
    await failsWith(h.api, 'removeFile', h.ctx(EXT_A), ERROR_FILE_ALREADY_DELETED, id)
  })

  it('keeps or discards a quarantined download by the answer to the danger prompt', async () => {
    const h = harness()
    h.load(EXT_A)
    const exe = h.begin({
      url: 'http://sketchy.example/setup.exe',
      filename: 'setup.exe',
      mimeType: 'application/octet-stream',
      savePath: '/dl/setup.exe.zeniumdownload'
    })
    const id = (h.out[0]!.args[0] as ChromeDownloadItem).id
    await failsWith(h.api, 'acceptDanger', h.ctx(EXT_A), ERROR_NOT_DANGEROUS, id)
    h.service.finish(exe.id, 'completed')
    await h.flush()
    expect(exe.state).toBe('completed')
    expect(exe.danger.level).not.toBe('safe')
    const shape = ((await call(h.api, 'search', h.ctx(EXT_A), { id })) as ChromeDownloadItem[])[0]!
    expect(shape.state).toBe('in_progress')
    expect(['file', 'uncommon']).toContain(shape.danger)
    h.out.length = 0
    h.answers.push(true)
    await call(h.api, 'acceptDanger', h.ctx(EXT_A), id)
    const delta = h.out.find((o) => o.event === 'downloads.onChanged')?.args[0] as DownloadDelta
    expect(delta.state).toEqual({ previous: 'in_progress', current: 'complete' })
    expect(delta.danger?.current).toBe('accepted')
    await failsWith(h.api, 'acceptDanger', h.ctx(EXT_A), ERROR_NOT_IN_PROGRESS, id)

    const second = h.begin({
      url: 'http://sketchy.example/other.exe',
      filename: 'other.exe',
      mimeType: 'application/octet-stream',
      savePath: '/dl/other.exe.zeniumdownload'
    })
    h.service.finish(second.id, 'completed')
    await h.flush()
    const secondId = (
      h.out.find((o) => o.event === 'downloads.onCreated')!.args[0] as ChromeDownloadItem
    ).id
    h.out.length = 0
    h.answers.push(false)
    await call(h.api, 'acceptDanger', h.ctx(EXT_A), secondId)
    expect(h.out.map((o) => o.event)).toEqual(['downloads.onErased'])
    expect(h.downloadHost.calls).toContain(`deletePartial:${second.id}`)
  })

  it('opens only complete downloads, with the permission and the user agreeing', async () => {
    const h = harness()
    h.load(EXT_A)
    const item = h.begin()
    const id = (h.out[0]!.args[0] as ChromeDownloadItem).id
    await failsWith(h.api, 'open', h.ctx(EXT_A), ERROR_OPEN_PERMISSION, id)
    h.grants[EXT_A] = ['downloads', 'downloads.open']
    await failsWith(h.api, 'open', h.ctx(EXT_A), ERROR_NOT_COMPLETE, id)
    h.service.finish(item.id, 'completed')
    await h.flush()
    h.answers.push(false)
    await call(h.api, 'open', h.ctx(EXT_A), id)
    expect(h.downloadHost.opened).toEqual([])
    h.answers.push(true)
    await call(h.api, 'open', h.ctx(EXT_A), id)
    expect(h.downloadHost.opened).toEqual([item.id])
    await call(h.api, 'show', h.ctx(EXT_A), id)
    expect(h.downloadHost.calls).toContain(`show:${item.id}`)
    await call(h.api, 'showDefaultFolder', h.ctx(EXT_A))
    expect(h.bridge.shown).toBe(1)
  })

  it('answers file icons at 16 or 32 pixels', async () => {
    const h = harness()
    h.load(EXT_A)
    h.begin()
    const id = (h.out[0]!.args[0] as ChromeDownloadItem).id
    expect(await call(h.api, 'getFileIcon', h.ctx(EXT_A), id)).toBe('data:image/png;base64,32')
    expect(await call(h.api, 'getFileIcon', h.ctx(EXT_A), id, { size: 16 })).toBe(
      'data:image/png;base64,16'
    )
    await failsWith(h.api, 'getFileIcon', h.ctx(EXT_A), 'Value must be one of 16, 32', id, {
      size: 24
    })
  })

  it('gates the UI options on their permissions', async () => {
    const h = harness()
    h.load(EXT_A)
    await failsWith(h.api, 'setUiOptions', h.ctx(EXT_A), 'downloads.ui permission required', {
      enabled: false
    })
    h.grants[EXT_A] = ['downloads', 'downloads.ui', 'downloads.shelf']
    await call(h.api, 'setUiOptions', h.ctx(EXT_A), { enabled: false })
    expect(h.api.uiDisabled).toBe(true)
    await call(h.api, 'setShelfEnabled', h.ctx(EXT_A), true)
    expect(h.api.uiDisabled).toBe(false)
  })
})

describe('DownloadsApi download() and onDeterminingFilename', () => {
  it('starts a transfer through the host and stamps the extension on it', async () => {
    const h = harness()
    h.load(EXT_A, 'Grabber')
    const id = (await call(h.api, 'download', h.ctx(EXT_A), {
      url: 'https://example.com/a.zip',
      filename: 'zips/a.zip',
      conflictAction: 'overwrite',
      headers: [{ name: 'X-Token', value: 't' }]
    })) as number
    expect(h.bridge.started).toEqual([
      {
        url: 'https://example.com/a.zip',
        headers: { 'X-Token': 't' },
        suggestion: { filename: 'zips/a.zip', conflictAction: 'overwrite' }
      }
    ])
    const created = h.out.find((o) => o.event === 'downloads.onCreated')!
      .args[0] as ChromeDownloadItem
    expect(created.id).toBe(id)
    expect(created.byExtensionId).toBe(EXT_A)
    expect(created.byExtensionName).toBe('Grabber')
    await failsWith(h.api, 'download', h.ctx(EXT_A), 'Invalid URL', { url: 'nope' })
    h.grants[EXT_A] = []
    await failsWith(h.api, 'download', h.ctx(EXT_A), ERROR_NO_PERMISSION, {
      url: 'https://example.com/a.zip'
    })
  })

  it('asks every listening extension once and lets the newest install win', async () => {
    const h = harness()
    h.load(EXT_A)
    h.load(EXT_B)
    const record = h.begin()
    h.out.length = 0
    expect(h.bridge.determiner).not.toBeNull()
    // Nobody listens: the default name stands without a round trip.
    expect(await h.bridge.determiner!(record, 'report.pdf')).toBeNull()
    expect(h.out).toEqual([])

    h.listeners.add(`${EXT_A}:downloads.onDeterminingFilename`)
    h.listeners.add(`${EXT_B}:downloads.onDeterminingFilename`)
    const pending = h.bridge.determiner!(record, 'report.pdf')
    await h.flush()
    const asked = h.out.filter((o) => o.event === 'downloads.onDeterminingFilename')
    expect(asked.map((o) => o.extensionId).sort()).toEqual([EXT_A, EXT_B])
    expect((asked[0]!.args[0] as ChromeDownloadItem).filename).toBe('report.pdf')
    const tokenOf = (id: string): unknown => asked.find((o) => o.extensionId === id)!.args[1]
    // The wrong extension cannot answer for another; A (older) suggests, B (newer) suggests too.
    h.api.determined(h.ctx(EXT_B), {
      token: tokenOf(EXT_A),
      suggestion: { filename: 'hijack.pdf' }
    })
    h.api.determined(h.ctx(EXT_A), {
      token: tokenOf(EXT_A),
      suggestion: { filename: 'from-a.pdf' }
    })
    h.api.determined(h.ctx(EXT_B), {
      token: tokenOf(EXT_B),
      suggestion: { filename: 'pdfs/from-b.pdf', conflictAction: 'prompt' }
    })
    expect(await pending).toEqual({ filename: 'pdfs/from-b.pdf', conflictAction: 'prompt' })

    // Only A suggests this time; B declines with an empty suggest().
    const second = h.bridge.determiner!(record, 'report.pdf')
    await h.flush()
    const round = h.out.filter((o) => o.event === 'downloads.onDeterminingFilename').slice(2)
    for (const ask of round) {
      h.api.determined(h.ctx(ask.extensionId), {
        token: ask.args[1],
        suggestion: ask.extensionId === EXT_A ? { filename: 'a.pdf' } : null
      })
    }
    expect(await second).toEqual({ filename: 'a.pdf', conflictAction: 'uniquify' })
  })

  it('gives up on a listener that never answers', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      h.load(EXT_A)
      const record = h.begin()
      h.listeners.add(`${EXT_A}:downloads.onDeterminingFilename`)
      const pending = h.bridge.determiner!(record, 'report.pdf')
      await vi.advanceTimersByTimeAsync(15_000)
      expect(await pending).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
