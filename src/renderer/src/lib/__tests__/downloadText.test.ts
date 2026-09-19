import { describe, expect, it } from 'vitest'
import type { DownloadItem } from '@shared/types'
import {
  canRetry,
  describeDownloadError,
  downloadFolderLabel,
  downloadStatus,
  formatEta,
  isQuarantined,
  parseAutoOpenTypes
} from '../downloadText'

const NOW = 1_700_000_000_000

function item(patch: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 'd1',
    url: 'https://example.com/report.pdf',
    referrer: 'https://example.com/',
    filename: 'report.pdf',
    finalName: 'report.pdf',
    savePath: '/dl/report.pdf.zeniumdownload',
    totalBytes: 3_145_728,
    receivedBytes: 1_782_579,
    state: 'progressing',
    startedAt: NOW - 20_000,
    mimeType: 'application/pdf',
    canResume: true,
    danger: { level: 'safe', reason: 'none', message: '' },
    dangerAccepted: false,
    openWhenDone: false,
    bytesPerSecond: 1_258_291,
    etaMs: 1_083,
    private: false,
    containerId: 'default',
    etag: '',
    lastModified: '',
    ...patch
  }
}

describe('downloadStatus', () => {
  it('shows progress and time left while running', () => {
    expect(downloadStatus(item(), NOW)).toBe('1.7 MB of 3.0 MB · 1 s left')
  })

  it('shows the rate instead while there is no estimate', () => {
    expect(downloadStatus(item({ totalBytes: 0, etaMs: null }), NOW)).toBe('1.7 MB · 1.2 MB/s')
  })

  it('leaves out the total, the speed and the estimate it does not have', () => {
    expect(downloadStatus(item({ totalBytes: 0, bytesPerSecond: 0, etaMs: null }), NOW)).toBe(
      '1.7 MB'
    )
  })

  it('says paused with the bytes so far', () => {
    expect(downloadStatus(item({ state: 'paused', bytesPerSecond: 0 }), NOW)).toBe(
      'Paused · 1.7 MB of 3.0 MB'
    )
  })

  it('gives a finished file its size and when it finished', () => {
    const done = item({
      state: 'completed',
      receivedBytes: 3_145_728,
      completedAt: NOW - 5 * 60_000,
      bytesPerSecond: 0,
      etaMs: null
    })
    expect(downloadStatus(done, NOW)).toBe('3.0 MB · 5 min ago')
  })

  it('falls back to the received bytes and the start time for a sizeless finished file', () => {
    const done = item({
      state: 'completed',
      totalBytes: 0,
      receivedBytes: 31,
      completedAt: undefined,
      endedAt: undefined,
      startedAt: NOW - 10_000
    })
    expect(downloadStatus(done, NOW)).toBe('31 B · Just now')
  })

  it('tells a resumable interruption apart from a failure', () => {
    expect(downloadStatus(item({ state: 'interrupted', canResume: true }), NOW)).toBe(
      'Interrupted · 1.7 MB of 3.0 MB'
    )
    expect(
      downloadStatus(
        item({ state: 'interrupted', canResume: false, error: 'network-timeout' }),
        NOW
      )
    ).toBe('Failed · The connection timed out')
    expect(downloadStatus(item({ state: 'cancelled' }), NOW)).toBe('Cancelled')
  })
})

describe('formatEta', () => {
  it('rounds to the unit a person would say', () => {
    expect(formatEta(400)).toBe('1 s left')
    expect(formatEta(42_000)).toBe('42 s left')
    expect(formatEta(150_000)).toBe('3 min left')
    expect(formatEta(65 * 60_000)).toBe('1 hr 5 min left')
    expect(formatEta(120 * 60_000)).toBe('2 hr left')
    expect(formatEta(30 * 3_600_000)).toBe('More than a day left')
  })

  it('is empty without an estimate', () => {
    expect(formatEta(null)).toBe('')
    expect(formatEta(Number.NaN)).toBe('')
    expect(formatEta(-1)).toBe('')
  })
})

describe('describeDownloadError', () => {
  it('turns the engine reasons into sentences', () => {
    expect(describeDownloadError('shutdown')).toBe('Zenium was closed')
    expect(describeDownloadError('file-no-space')).toBe('Not enough storage space')
    expect(describeDownloadError('file-access-denied')).toBe('Zenium needs permission')
    expect(describeDownloadError('file-error')).toBe('The file could not be saved')
    expect(describeDownloadError('file-failed')).toBe('The file could not be saved')
    expect(describeDownloadError('network-timeout')).toBe('The connection timed out')
    expect(describeDownloadError('network-disconnected')).toBe('No internet connection')
    expect(describeDownloadError('network-failed')).toBe('Network error')
    expect(describeDownloadError('ERR_CONNECTION_RESET')).toBe('Network error')
    expect(describeDownloadError('server-error')).toBe('The server stopped sending the file')
  })

  it('has a generic line for anything unknown', () => {
    expect(describeDownloadError(undefined)).toBe('Something went wrong')
    expect(describeDownloadError('interrupted')).toBe('Something went wrong')
  })
})

describe('row predicates', () => {
  it('quarantines a finished flagged file until it is kept', () => {
    const flagged = item({
      state: 'completed',
      danger: {
        level: 'dangerous',
        reason: 'executable',
        message: 'This file can harm your device.'
      }
    })
    expect(isQuarantined(flagged)).toBe(true)
    expect(isQuarantined({ ...flagged, dangerAccepted: true })).toBe(false)
    expect(isQuarantined({ ...flagged, state: 'progressing' })).toBe(false)
    expect(isQuarantined(item({ state: 'completed' }))).toBe(false)
  })

  it('offers a retry for failed and cancelled rows, but not for blob: bytes', () => {
    expect(canRetry(item({ state: 'interrupted' }))).toBe(true)
    expect(canRetry(item({ state: 'cancelled' }))).toBe(true)
    expect(canRetry(item({ state: 'completed' }))).toBe(false)
    expect(canRetry(item({ state: 'cancelled', url: 'blob:https://example.com/abc' }))).toBe(false)
  })
})

describe('downloadFolderLabel', () => {
  it('names the default folder', () => {
    expect(downloadFolderLabel(null)).toBe('Downloads')
    expect(downloadFolderLabel('')).toBe('Downloads')
  })

  it('shows the relative path of an Android document tree', () => {
    expect(
      downloadFolderLabel(
        'content://com.android.externalstorage.documents/tree/primary%3ADownload%2FZenium'
      )
    ).toBe('Download/Zenium')
    expect(
      downloadFolderLabel('content://com.android.externalstorage.documents/tree/1A2B-3C4D%3A')
    ).toBe('Storage')
  })

  it('shows the last segment of a plain path', () => {
    expect(downloadFolderLabel('/home/me/Files/Invoices/')).toBe('Invoices')
    expect(downloadFolderLabel('C:\\Users\\me\\Desktop')).toBe('Desktop')
  })
})

describe('parseAutoOpenTypes', () => {
  it('normalises a typed list', () => {
    expect(parseAutoOpenTypes('pdf, PNG .jpg;txt  pdf')).toEqual(['pdf', 'png', 'jpg', 'txt'])
    expect(parseAutoOpenTypes('')).toEqual([])
    expect(parseAutoOpenTypes(' , . ')).toEqual([])
  })
})
