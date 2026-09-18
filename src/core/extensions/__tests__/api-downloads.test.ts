import { describe, expect, it } from 'vitest'
import type { DownloadItem } from '../../../shared/types'
import {
  DownloadArgumentError,
  ERROR_INVALID_DANGER,
  ERROR_INVALID_FILENAME,
  ERROR_INVALID_FILTER,
  ERROR_INVALID_LIMIT,
  ERROR_INVALID_ORDER_BY,
  ERROR_INVALID_STATE,
  ERROR_INVALID_URL,
  ERROR_POST_UNSUPPORTED,
  ERROR_UNSAFE_HEADER,
  chromeDanger,
  chromeInterruptReason,
  chromeState,
  creationShape,
  downloadDelta,
  hashDownloadId,
  isSafeRelativePath,
  normalizeDownloadOptions,
  normalizeDownloadQuery,
  normalizeSuggestion,
  runDownloadQuery,
  toChromeDownloadItem,
  type ChromeDownloadItem,
  type DownloadView
} from '../api/downloads'

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0)

function record(over: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 'dl_1',
    url: 'https://cdn.example.com/report.pdf',
    referrer: 'https://example.com/page',
    filename: 'report.pdf',
    finalName: 'report.pdf',
    savePath: '/home/u/Downloads/report.pdf.zeniumdownload',
    totalBytes: 1000,
    receivedBytes: 250,
    state: 'progressing',
    startedAt: NOW - 10_000,
    mimeType: 'application/pdf',
    canResume: true,
    danger: { level: 'safe', reason: 'none', message: '' },
    dangerAccepted: false,
    openWhenDone: false,
    bytesPerSecond: 250,
    etaMs: 3000,
    private: false,
    containerId: 'default',
    etag: '"abc"',
    lastModified: '',
    ...over
  }
}

const view = (over: Partial<DownloadView> = {}): DownloadView => ({
  id: 7,
  targetPath: null,
  fileGone: false,
  ...over
})

const shape = (
  over: Partial<DownloadItem> = {},
  v: Partial<DownloadView> = {}
): ChromeDownloadItem => toChromeDownloadItem(record(over), view(v), NOW)

describe('Chrome download shape', () => {
  it('reports a running transfer in progress with its target path and estimate', () => {
    const item = shape({}, { targetPath: '/home/u/Downloads/report.pdf' })
    expect(item).toMatchObject({
      id: 7,
      url: 'https://cdn.example.com/report.pdf',
      finalUrl: 'https://cdn.example.com/report.pdf',
      referrer: 'https://example.com/page',
      filename: '/home/u/Downloads/report.pdf',
      incognito: false,
      danger: 'safe',
      mime: 'application/pdf',
      state: 'in_progress',
      paused: false,
      canResume: false,
      bytesReceived: 250,
      totalBytes: 1000,
      fileSize: -1,
      exists: true
    })
    expect(item.startTime).toBe(new Date(NOW - 10_000).toISOString())
    expect(item.estimatedEndTime).toBe(new Date(NOW + 3000).toISOString())
    expect(item.endTime).toBeUndefined()
    expect(item.error).toBeUndefined()
  })

  it('derives the target from the partial file when the host has no path for it', () => {
    expect(shape().filename).toBe('/home/u/Downloads/report.pdf')
    expect(shape({ savePath: '' }).filename).toBe('report.pdf')
  })

  it('maps paused, completed, cancelled and interrupted records', () => {
    expect(shape({ state: 'paused', bytesPerSecond: 0, etaMs: null })).toMatchObject({
      state: 'in_progress',
      paused: true,
      canResume: true
    })
    const done = shape({
      state: 'completed',
      receivedBytes: 1000,
      savePath: '/home/u/Downloads/report.pdf',
      endedAt: NOW - 1000,
      completedAt: NOW - 1000,
      etaMs: null
    })
    expect(done).toMatchObject({
      state: 'complete',
      filename: '/home/u/Downloads/report.pdf',
      fileSize: 1000,
      totalBytes: 1000,
      exists: true,
      endTime: new Date(NOW - 1000).toISOString()
    })
    expect(done.estimatedEndTime).toBeUndefined()
    expect(shape({ state: 'cancelled', savePath: '', endedAt: NOW })).toMatchObject({
      state: 'interrupted',
      error: 'USER_CANCELED',
      canResume: false
    })
    expect(shape({ state: 'interrupted', error: 'shutdown', canResume: true })).toMatchObject({
      state: 'interrupted',
      error: 'USER_SHUTDOWN',
      canResume: true
    })
    expect(chromeInterruptReason(record({ state: 'interrupted', error: 'file-error' }))).toBe(
      'FILE_FAILED'
    )
    expect(chromeInterruptReason(record({ state: 'interrupted', error: 'ERR_TIMED_OUT' }))).toBe(
      'NETWORK_TIMEOUT'
    )
    expect(
      chromeInterruptReason(record({ state: 'interrupted', error: 'ERR_CERT_DATE_INVALID' }))
    ).toBe('SERVER_CERT_PROBLEM')
    expect(chromeInterruptReason(record({ state: 'interrupted', error: 'interrupted' }))).toBe(
      'NETWORK_FAILED'
    )
    expect(chromeInterruptReason(record())).toBeUndefined()
  })

  it('keeps a quarantined download in progress with its danger, complete and accepted once kept', () => {
    const flagged = record({
      state: 'completed',
      receivedBytes: 1000,
      endedAt: NOW,
      danger: { level: 'dangerous', reason: 'executable', message: 'This file can harm.' }
    })
    expect(chromeState(flagged)).toBe('in_progress')
    const item = toChromeDownloadItem(flagged, view(), NOW)
    expect(item).toMatchObject({ state: 'in_progress', danger: 'file', exists: true })
    expect(item.endTime).toBeUndefined()
    expect(item.filename).toBe('/home/u/Downloads/report.pdf')
    const kept = toChromeDownloadItem(
      { ...flagged, dangerAccepted: true, savePath: '/home/u/Downloads/report.pdf' },
      view(),
      NOW
    )
    expect(kept).toMatchObject({ state: 'complete', danger: 'accepted' })
  })

  it('maps danger levels and reasons onto Chrome danger types', () => {
    const d = (
      level: 'suspicious' | 'dangerous',
      reason: DownloadItem['danger']['reason']
    ): string => chromeDanger({ level, reason, message: 'x' }, false)
    expect(d('dangerous', 'executable')).toBe('file')
    expect(d('suspicious', 'archive')).toBe('uncommon')
    expect(d('dangerous', 'url-verdict')).toBe('url')
    expect(d('suspicious', 'insecure-download')).toBe('uncommon')
    expect(chromeDanger({ level: 'safe', reason: 'none', message: '' }, false)).toBe('safe')
  })

  it('reports an unknown size as -1 and a removed file as gone', () => {
    expect(shape({ totalBytes: 0 }).totalBytes).toBe(-1)
    expect(
      shape({ state: 'completed', totalBytes: 0, receivedBytes: 0, savePath: '/d/x' }).totalBytes
    ).toBe(0)
    expect(shape({ state: 'completed', savePath: '/d/x' }, { fileGone: true }).exists).toBe(false)
  })

  it('carries the starting extension', () => {
    const item = shape({}, { byExtension: { id: 'a'.repeat(32), name: 'Grabber' } })
    expect(item.byExtensionId).toBe('a'.repeat(32))
    expect(item.byExtensionName).toBe('Grabber')
  })
})

describe('onChanged delta', () => {
  it('lists changed fields with previous and current, skipping bytes and the estimate', () => {
    const before = shape()
    const after = shape({ receivedBytes: 900, etaMs: 400, state: 'paused' })
    expect(downloadDelta(before, after)).toEqual({
      id: 7,
      paused: { previous: false, current: true },
      canResume: { previous: false, current: true }
    })
    expect(downloadDelta(before, shape({ receivedBytes: 500, etaMs: 2000 }))).toBeNull()
  })

  it('omits a side that is undefined', () => {
    const before = shape()
    const after = shape({
      state: 'interrupted',
      error: 'interrupted',
      endedAt: NOW,
      canResume: false
    })
    const delta = downloadDelta(before, after)
    expect(delta?.error).toEqual({ current: 'NETWORK_FAILED' })
    expect(delta?.endTime).toEqual({ current: new Date(NOW).toISOString() })
    expect(delta?.state).toEqual({ previous: 'in_progress', current: 'interrupted' })
  })

  it('rewinds a settled row to the shape Chrome creates it in, so the settling is the delta', () => {
    const done = shape(
      { receivedBytes: 1000, state: 'completed', endedAt: NOW },
      { targetPath: '/home/u/Downloads/report.pdf', fileGone: true }
    )
    const created = creationShape(done)
    expect(created).toMatchObject({
      id: 7,
      url: done.url,
      filename: done.filename,
      state: 'in_progress',
      paused: false,
      canResume: false,
      bytesReceived: 0,
      totalBytes: 1000,
      fileSize: -1,
      exists: true
    })
    expect(created.endTime).toBeUndefined()
    expect(created.error).toBeUndefined()
    expect(downloadDelta(created, done)).toEqual({
      id: 7,
      state: { previous: 'in_progress', current: 'complete' },
      endTime: { current: new Date(NOW).toISOString() },
      fileSize: { previous: -1, current: 1000 },
      exists: { previous: true, current: false }
    })

    const failed = shape({ state: 'interrupted', error: 'interrupted', endedAt: NOW })
    const rewound = creationShape(failed)
    expect(rewound.error).toBeUndefined()
    expect(downloadDelta(rewound, failed)).toMatchObject({
      state: { previous: 'in_progress', current: 'interrupted' },
      error: { current: 'NETWORK_FAILED' },
      canResume: { previous: false, current: true }
    })
  })
})

describe('ids', () => {
  it('hashes model ids to stable positive integers', () => {
    expect(hashDownloadId('dl_abc')).toBe(hashDownloadId('dl_abc'))
    expect(hashDownloadId('dl_abc')).not.toBe(hashDownloadId('dl_abd'))
    for (const id of ['', 'a', 'dl_0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0']) {
      const n = hashDownloadId(id)
      expect(Number.isInteger(n) && n > 0 && n <= 0x7fffffff).toBe(true)
    }
  })
})

describe('download queries', () => {
  const items: ChromeDownloadItem[] = [
    shape({ id: 'a', startedAt: NOW - 30_000 }, { id: 1 }),
    shape(
      {
        id: 'b',
        url: 'https://files.example.org/photo.JPG',
        finalName: 'photo.JPG',
        savePath: '/d/photo.JPG',
        mimeType: 'image/jpeg',
        state: 'completed',
        totalBytes: 5000,
        receivedBytes: 5000,
        startedAt: NOW - 20_000,
        endedAt: NOW - 15_000
      },
      { id: 2 }
    ),
    shape(
      {
        id: 'c',
        url: 'https://example.com/setup.exe',
        finalName: 'setup.exe',
        savePath: '',
        state: 'cancelled',
        totalBytes: 90,
        startedAt: NOW - 10_000,
        endedAt: NOW - 9000
      },
      { id: 3 }
    )
  ]

  it('defaults to everything, in list order, capped at a thousand', () => {
    const query = normalizeDownloadQuery(undefined)
    expect(query.limit).toBe(1000)
    expect(runDownloadQuery(items, query).map((i) => i.id)).toEqual([1, 2, 3])
    expect(runDownloadQuery(items, normalizeDownloadQuery({ limit: 2 })).map((i) => i.id)).toEqual([
      1, 2
    ])
    expect(runDownloadQuery(items, normalizeDownloadQuery({ limit: 0 }))).toHaveLength(3)
  })

  it('matches terms against the file name and URL, a leading dash excluding', () => {
    const ids = (q: unknown): number[] =>
      runDownloadQuery(items, normalizeDownloadQuery(q)).map((i) => i.id)
    expect(ids({ query: ['photo'] })).toEqual([2])
    expect(ids({ query: ['EXAMPLE', '-photo'] })).toEqual([1, 3])
    expect(ids({ query: ['nowhere'] })).toEqual([])
  })

  it('filters by state, danger, exact fields, regexes, sizes and times', () => {
    const ids = (q: unknown): number[] =>
      runDownloadQuery(items, normalizeDownloadQuery(q)).map((i) => i.id)
    expect(ids({ state: 'complete' })).toEqual([2])
    expect(ids({ state: 'interrupted', error: 'USER_CANCELED' })).toEqual([3])
    expect(ids({ danger: 'safe', paused: false })).toEqual([1, 2, 3])
    expect(ids({ mime: 'image/jpeg' })).toEqual([2])
    expect(ids({ id: 3 })).toEqual([3])
    expect(ids({ filenameRegex: '\\.exe$' })).toEqual([3])
    expect(ids({ urlRegex: '^https://files' })).toEqual([2])
    expect(ids({ totalBytesGreater: 999, totalBytesLess: 5000 })).toEqual([1])
    expect(ids({ startedAfter: NOW - 25_000 })).toEqual([2, 3])
    expect(ids({ startedBefore: new Date(NOW - 25_000).toISOString() })).toEqual([1])
    expect(ids({ endedAfter: NOW - 12_000 })).toEqual([3])
    expect(ids({ endedBefore: String(NOW - 12_000) })).toEqual([2])
  })

  it('sorts by the orderBy fields, a dash for descending', () => {
    const ids = (q: unknown): number[] =>
      runDownloadQuery(items, normalizeDownloadQuery(q)).map((i) => i.id)
    expect(ids({ orderBy: ['-startTime'] })).toEqual([3, 2, 1])
    expect(ids({ orderBy: ['totalBytes'] })).toEqual([3, 1, 2])
    expect(ids({ orderBy: ['state', '-id'] })).toEqual([2, 1, 3])
    expect(ids({ orderBy: '-totalBytes' })).toEqual([2, 1, 3])
  })

  it("refuses what Chrome refuses, with Chrome's words", () => {
    const refuse = (q: unknown, message: string): void => {
      expect(() => normalizeDownloadQuery(q)).toThrow(DownloadArgumentError)
      expect(() => normalizeDownloadQuery(q)).toThrow(message)
    }
    refuse({ limit: -1 }, ERROR_INVALID_LIMIT)
    refuse({ limit: 1.5 }, ERROR_INVALID_LIMIT)
    refuse({ orderBy: ['size'] }, ERROR_INVALID_ORDER_BY)
    refuse({ state: 'done' }, ERROR_INVALID_STATE)
    refuse({ danger: 'scary' }, ERROR_INVALID_DANGER)
    refuse({ filenameRegex: '(' }, ERROR_INVALID_FILTER)
    refuse({ query: 'photo' }, ERROR_INVALID_FILTER)
    refuse({ paused: 'yes' }, ERROR_INVALID_FILTER)
    refuse('everything', ERROR_INVALID_FILTER)
  })
})

describe('download() options', () => {
  it('normalizes a full request', () => {
    expect(
      normalizeDownloadOptions({
        url: 'HTTPS://Example.com/a.zip',
        filename: 'archives/a.zip',
        conflictAction: 'overwrite',
        saveAs: true,
        method: 'GET',
        headers: [{ name: 'X-Token', value: 'abc' }, { name: 'Accept' }]
      })
    ).toEqual({
      url: 'https://example.com/a.zip',
      filename: 'archives/a.zip',
      conflictAction: 'overwrite',
      saveAs: true,
      headers: { 'X-Token': 'abc', Accept: '' }
    })
    expect(normalizeDownloadOptions({ url: 'data:text/plain,hi' })).toMatchObject({
      filename: null,
      conflictAction: 'uniquify',
      saveAs: null,
      headers: {}
    })
  })

  it('refuses bad URLs, unsafe names, unsafe headers and POST bodies', () => {
    const refuse = (o: unknown, message: string): void =>
      expect(() => normalizeDownloadOptions(o)).toThrow(message)
    refuse({}, ERROR_INVALID_URL)
    refuse({ url: 'not a url' }, ERROR_INVALID_URL)
    refuse({ url: 'javascript:alert(1)' }, ERROR_INVALID_URL)
    refuse({ url: 'zen://settings' }, ERROR_INVALID_URL)
    refuse({ url: 'https://e.com/a', filename: '../a' }, ERROR_INVALID_FILENAME)
    refuse({ url: 'https://e.com/a', filename: '/etc/passwd' }, ERROR_INVALID_FILENAME)
    refuse({ url: 'https://e.com/a', filename: 'C:/x' }, ERROR_INVALID_FILENAME)
    refuse({ url: 'https://e.com/a', filename: 'a:b' }, ERROR_INVALID_FILENAME)
    refuse({ url: 'https://e.com/a', filename: 'con.txt' }, ERROR_INVALID_FILENAME)
    refuse({ url: 'https://e.com/a', filename: 'name. ' }, ERROR_INVALID_FILENAME)
    refuse(
      { url: 'https://e.com/a', headers: [{ name: 'Cookie', value: 'a=b' }] },
      ERROR_UNSAFE_HEADER
    )
    refuse(
      { url: 'https://e.com/a', headers: [{ name: 'Sec-Fetch-Mode', value: 'x' }] },
      ERROR_UNSAFE_HEADER
    )
    refuse(
      { url: 'https://e.com/a', headers: [{ name: 'Bad Name', value: 'x' }] },
      'Invalid request header name'
    )
    refuse(
      { url: 'https://e.com/a', headers: [{ name: 'X-A', value: 'a\r\nb' }] },
      'Invalid request header value'
    )
    refuse({ url: 'https://e.com/a', method: 'POST' }, ERROR_POST_UNSUPPORTED)
    refuse({ url: 'https://e.com/a', body: 'x' }, ERROR_POST_UNSUPPORTED)
    refuse({ url: 'https://e.com/a', conflictAction: 'ask' }, 'Invalid conflictAction')
  })

  it('judges relative paths the portable way', () => {
    expect(isSafeRelativePath('a.txt')).toBe(true)
    expect(isSafeRelativePath('dir/sub/a.txt')).toBe(true)
    expect(isSafeRelativePath('')).toBe(false)
    expect(isSafeRelativePath('dir//a')).toBe(false)
    expect(isSafeRelativePath('./a')).toBe(false)
    expect(isSafeRelativePath('a\\b')).toBe(false)
    expect(isSafeRelativePath('a\u0000b')).toBe(false)
    expect(isSafeRelativePath('LPT1')).toBe(false)
  })

  it("reads a listener's suggestion, declining what is unsafe or empty", () => {
    expect(normalizeSuggestion({ filename: 'x/y.pdf' })).toEqual({
      filename: 'x/y.pdf',
      conflictAction: 'uniquify'
    })
    expect(normalizeSuggestion({ filename: 'y.pdf', conflictAction: 'prompt' })).toEqual({
      filename: 'y.pdf',
      conflictAction: 'prompt'
    })
    expect(normalizeSuggestion(undefined)).toBeNull()
    expect(normalizeSuggestion({})).toBeNull()
    expect(normalizeSuggestion({ filename: '../y.pdf' })).toBeNull()
    expect(normalizeSuggestion({ filename: 'y.pdf', conflictAction: 'zap' })).toBeNull()
  })
})
