import { describe, expect, it } from 'vitest'
import type { DownloadItem } from '@shared/types'
import { downloadFolderLabel, downloadStatus, formatEta } from '../downloadText'

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

  it('reads a finished file the engine found gone as Deleted, as the desktop row does (#161)', () => {
    expect(
      downloadStatus(item({ state: 'completed', fileMissing: true, completedAt: NOW }), NOW)
    ).toBe('Deleted')
  })

  it('reads a flagged file as blocked while it waits for Keep / Delete', () => {
    const flagged = item({
      state: 'completed',
      danger: {
        level: 'dangerous',
        reason: 'file-type',
        message: 'This file can harm your device.'
      }
    })
    expect(downloadStatus(flagged, NOW)).toBe('Blocked · Dangerous')
    expect(
      downloadStatus(
        item({
          state: 'completed',
          danger: { level: 'suspicious', reason: 'url-verdict', message: '' }
        }),
        NOW
      )
    ).toBe('Blocked · Uncommon file')
    expect(downloadStatus({ ...flagged, dangerAccepted: true, completedAt: NOW }, NOW)).toBe(
      '3.0 MB · Just now'
    )
  })

  it('reads a failure as Failed · with the engine’s sentence, resumable or not', () => {
    const failed = item({
      state: 'interrupted',
      canResume: true,
      error: 'network-failed',
      errorMessage: 'Check internet connection'
    })
    expect(downloadStatus(failed, NOW)).toBe('Failed · Check internet connection')
    expect(downloadStatus({ ...failed, canResume: false }, NOW)).toBe(
      'Failed · Check internet connection'
    )
    // A record from before the engine sent sentences: Chrome's line for the reason, else bare.
    expect(downloadStatus(item({ state: 'interrupted', error: 'file-no-space' }), NOW)).toBe(
      'Failed · Out of storage space'
    )
    expect(downloadStatus(item({ state: 'interrupted' }), NOW)).toBe('Failed')
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

describe('downloadFolderLabel', () => {
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

  it('shows a desktop path as it is', () => {
    expect(downloadFolderLabel('/home/me/Files/Invoices')).toBe('/home/me/Files/Invoices')
    expect(downloadFolderLabel('C:\\Users\\me\\Desktop')).toBe('C:\\Users\\me\\Desktop')
  })
})
