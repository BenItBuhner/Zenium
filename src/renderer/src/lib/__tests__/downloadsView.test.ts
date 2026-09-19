import { describe, expect, it } from 'vitest'
import type { DownloadItem } from '@shared/types'
import { downloadItem } from '@shared/__tests__/downloadFixtures'
import {
  blockedStatus,
  bubbleDescription,
  dangerActionLabels,
  dangerSummary,
  dayLabel,
  describeDownloadError,
  downloadStatus,
  extensionOf,
  fileGlyphFor,
  filterDownloads,
  formatRemaining,
  formatSpeed,
  groupDownloadsByDay,
  hasClearable,
  isOnDisk,
  splitFileName
} from '../downloadsView'

const MB = 1024 * 1024

function item(patch: Partial<DownloadItem> & { id: string }): DownloadItem {
  return downloadItem({
    url: `https://files.example/${patch.id}`,
    filename: `${patch.id}.zip`,
    savePath: `/home/u/Downloads/${patch.id}.zip`,
    totalBytes: 100 * MB,
    receivedBytes: 0,
    state: 'progressing',
    startedAt: Date.UTC(2026, 8, 17, 9, 0, 0),
    mimeType: 'application/zip',
    ...patch
  })
}

describe('formatRemaining', () => {
  it('uses Chrome units and singulars', () => {
    expect(formatRemaining(null)).toBe('')
    expect(formatRemaining(undefined)).toBe('')
    expect(formatRemaining(-5)).toBe('')
    expect(formatRemaining(400)).toBe('1 sec left')
    expect(formatRemaining(3_000)).toBe('3 secs left')
    expect(formatRemaining(61_000)).toBe('1 min left')
    expect(formatRemaining(5 * 60_000)).toBe('5 mins left')
    expect(formatRemaining(60 * 60_000)).toBe('1 hour left')
    expect(formatRemaining(3 * 60 * 60_000)).toBe('3 hours left')
    expect(formatRemaining(48 * 60 * 60_000)).toBe('2 days left')
  })
})

describe('formatSpeed', () => {
  it('formats a rate and hides idle ones', () => {
    expect(formatSpeed(0)).toBe('')
    expect(formatSpeed(1.5 * MB)).toBe('1.5 MB/s')
  })
})

describe('downloadStatus', () => {
  it('shows bytes alone while the engine has no rate yet', () => {
    expect(downloadStatus(item({ id: 'a', receivedBytes: 30 * MB }))).toEqual({
      text: '30.0 MB of 100 MB',
      tone: 'muted'
    })
    expect(downloadStatus(item({ id: 'a', receivedBytes: 30 * MB, totalBytes: 0 }))).toEqual({
      text: '30.0 MB',
      tone: 'muted'
    })
  })

  it('adds the engine speed and time left', () => {
    const status = downloadStatus(
      item({ id: 'a', receivedBytes: 30 * MB, bytesPerSecond: 5 * MB, etaMs: 14_000 })
    )
    expect(status.text).toBe('5.0 MB/s · 30.0 MB of 100 MB · 14 secs left')
    // Paused: the engine reports a zero rate and no ETA.
    expect(
      downloadStatus(item({ id: 'a', state: 'paused', receivedBytes: 30 * MB, bytesPerSecond: 0 }))
        .text
    ).toBe('Paused · 30.0 MB of 100 MB')
  })

  it('words the engine failure reasons as Failed – <reason>, in the words of Chrome 112’s bubble', () => {
    // The Electron host names no reason: a bare Failed, not a guess.
    expect(describeDownloadError(undefined)).toBe('Failed')
    expect(describeDownloadError('interrupted')).toBe('Failed')
    // The engine's own reasons read as Chrome's USER_SHUTDOWN and FILE_FAILED do.
    expect(describeDownloadError('shutdown')).toBe('Failed – Couldn’t finish download')
    expect(describeDownloadError('file-error')).toBe('Failed – Something went wrong')
    // The engine's DownloadInterruptReason: Chromium's reasons spelled network-failed, read as
    // the chrome.downloads names they are one for one with.
    expect(describeDownloadError('network-failed')).toBe('Failed – Check internet connection')
    expect(describeDownloadError('network-timeout')).toBe('Failed – Check internet connection')
    expect(describeDownloadError('network-server-down')).toBe('Failed – Site wasn’t available')
    expect(describeDownloadError('server-unreachable')).toBe('Failed – Site wasn’t available')
    expect(describeDownloadError('server-forbidden')).toBe('Failed – File wasn’t available on site')
    expect(describeDownloadError('file-no-space')).toBe('Failed – Out of storage space')
    expect(describeDownloadError('file-access-denied')).toBe(
      'Failed – Needs permission to download'
    )
    expect(describeDownloadError('file-security-check-failed')).toBe('Failed – Virus scan failed')
    expect(describeDownloadError('user-shutdown')).toBe('Failed – Couldn’t finish download')
    expect(describeDownloadError('crash')).toBe('Failed – Couldn’t finish download')
    expect(describeDownloadError('server-no-range')).toBe('Failed – Something went wrong')
    expect(describeDownloadError('file-failed')).toBe('Failed – Something went wrong')
    // Chrome's interrupt reasons, grouped as its BubbleStatusTextBuilder groups them.
    expect(describeDownloadError('NETWORK_DISCONNECTED')).toBe('Failed – Check internet connection')
    expect(describeDownloadError('NETWORK_TIMEOUT')).toBe('Failed – Check internet connection')
    expect(describeDownloadError('NETWORK_SERVER_DOWN')).toBe('Failed – Site wasn’t available')
    expect(describeDownloadError('SERVER_CERT_PROBLEM')).toBe('Failed – Site wasn’t available')
    expect(describeDownloadError('SERVER_BAD_CONTENT')).toBe(
      'Failed – File wasn’t available on site'
    )
    expect(describeDownloadError('SERVER_FORBIDDEN')).toBe('Failed – File wasn’t available on site')
    expect(describeDownloadError('SERVER_CONTENT_LENGTH_MISMATCH')).toBe(
      'Failed – Couldn’t finish download'
    )
    expect(describeDownloadError('FILE_NO_SPACE')).toBe('Failed – Out of storage space')
    expect(describeDownloadError('DOWNLOAD_INTERRUPT_REASON_FILE_ACCESS_DENIED')).toBe(
      'Failed – Needs permission to download'
    )
    expect(describeDownloadError('FILE_NAME_TOO_LONG')).toBe(
      'Failed – File name or location is too long'
    )
    expect(describeDownloadError('FILE_TOO_LARGE')).toBe('Failed – File is too big for this device')
    expect(describeDownloadError('FILE_BLOCKED')).toBe('Failed – Blocked by your organization')
    expect(describeDownloadError('FILE_VIRUS_INFECTED')).toBe('Failed – Virus detected')
    expect(describeDownloadError('FILE_SECURITY_CHECK_FAILED')).toBe('Failed – Virus scan failed')
    expect(describeDownloadError('FILE_SAME_AS_SOURCE')).toBe('Failed – Already downloaded')
    for (const wrong of [
      'FILE_TOO_SHORT',
      'FILE_HASH_MISMATCH',
      'SERVER_NO_RANGE',
      'CANNOT_DOWNLOAD'
    ])
      expect(describeDownloadError(wrong)).toBe('Failed – Something went wrong')
    // Chromium net:: names go through the chrome.downloads bridge's reading of them.
    expect(describeDownloadError('net::ERR_CONNECTION_RESET')).toBe(
      'Failed – Check internet connection'
    )
    expect(describeDownloadError('net::ERR_INTERNET_DISCONNECTED')).toBe(
      'Failed – Check internet connection'
    )
    expect(describeDownloadError('net::ERR_NAME_NOT_RESOLVED')).toBe(
      'Failed – Site wasn’t available'
    )
    expect(describeDownloadError('ERR_CERT_DATE_INVALID')).toBe('Failed – Site wasn’t available')
    expect(describeDownloadError('net::ERR_HTTP_RESPONSE_CODE_FAILURE')).toBe(
      'Failed – Site wasn’t available'
    )
    expect(describeDownloadError('net::ERR_INVALID_RESPONSE')).toBe(
      'Failed – File wasn’t available on site'
    )
    expect(describeDownloadError('net::ERR_CONTENT_LENGTH_MISMATCH')).toBe(
      'Failed – Couldn’t finish download'
    )
    expect(describeDownloadError('net::ERR_FILE_NO_SPACE')).toBe('Failed – Out of storage space')
    // Outside every table: Chrome's catch-all, never a raw name.
    expect(describeDownloadError('net::ERR_UNEXPECTED_THING')).toBe('Failed – Something went wrong')
    expect(describeDownloadError('SOMETHING_NEW')).toBe('Failed – Something went wrong')
  })

  it('words paused, cancelled, failed and done like Chrome', () => {
    expect(downloadStatus(item({ id: 'a', state: 'paused', receivedBytes: 30 * MB })).text).toBe(
      'Paused · 30.0 MB of 100 MB'
    )
    expect(downloadStatus(item({ id: 'a', state: 'paused', totalBytes: 0 })).text).toBe('Paused')
    expect(downloadStatus(item({ id: 'a', state: 'cancelled' }))).toEqual({
      text: 'Cancelled',
      tone: 'muted'
    })
    expect(downloadStatus(item({ id: 'a', state: 'interrupted' }))).toEqual({
      text: 'Failed',
      tone: 'danger'
    })
    expect(
      downloadStatus(item({ id: 'a', state: 'interrupted', error: 'user-shutdown' })).text
    ).toBe('Failed – Couldn’t finish download')
    expect(
      downloadStatus(item({ id: 'a', state: 'interrupted', error: 'network-failed' })).text
    ).toBe('Failed – Check internet connection')
    // A finished file the engine found gone from disk.
    expect(downloadStatus(item({ id: 'a', state: 'completed', fileMissing: true }))).toEqual({
      text: 'Deleted',
      tone: 'muted'
    })
    expect(downloadStatus(item({ id: 'a', state: 'completed', receivedBytes: 100 * MB }))).toEqual({
      text: 'Done · 100 MB',
      tone: 'muted'
    })
    expect(downloadStatus(item({ id: 'a', state: 'completed', totalBytes: 0 })).text).toBe('Done')
  })

  it('shows Chrome’s blocked status with the engine’s sentence as detail until the user decides', () => {
    const danger = {
      level: 'dangerous' as const,
      reason: 'executable' as const,
      message: 'setup.exe may harm'
    }
    expect(downloadStatus(item({ id: 'a', state: 'completed', danger }))).toEqual({
      text: 'Blocked · Dangerous',
      tone: 'danger',
      detail: 'setup.exe may harm'
    })
    expect(
      downloadStatus(
        item({ id: 'a', state: 'completed', danger: { ...danger, level: 'suspicious' } })
      ).tone
    ).toBe('warn')
    expect(
      downloadStatus(item({ id: 'a', state: 'completed', danger, dangerAccepted: true }))
    ).toEqual({ text: 'Done · 100 MB', tone: 'muted' })
  })
})

describe('danger copy (Chrome 112 download bubble)', () => {
  const verdict = (
    level: DownloadItem['danger']['level'],
    reason: DownloadItem['danger']['reason'],
    message = ''
  ): DownloadItem['danger'] => ({ level, reason, message })

  it('names the block by verdict', () => {
    expect(blockedStatus(verdict('dangerous', 'executable'))).toBe('Blocked · Dangerous')
    expect(blockedStatus(verdict('suspicious', 'archive'))).toBe('Blocked · Dangerous')
    expect(blockedStatus(verdict('dangerous', 'url-verdict'))).toBe('Blocked · Dangerous')
    expect(blockedStatus(verdict('suspicious', 'url-verdict'))).toBe('Blocked · Uncommon file')
    expect(blockedStatus(verdict('suspicious', 'insecure-download'))).toBe(
      'Blocked · Insecure download'
    )
  })

  it('explains with the engine’s sentence, else Chrome’s per reason', () => {
    expect(dangerSummary(verdict('dangerous', 'executable', 'This type can harm.'))).toBe(
      'This type can harm.'
    )
    expect(dangerSummary(verdict('dangerous', 'executable'))).toBe(
      'Zenium blocked this file because this type of file is dangerous'
    )
    expect(dangerSummary(verdict('dangerous', 'url-verdict'))).toBe(
      'Zenium blocked this file because it is dangerous'
    )
    expect(dangerSummary(verdict('suspicious', 'url-verdict'))).toBe(
      'This file is not commonly downloaded and may be dangerous'
    )
    expect(dangerSummary(verdict('suspicious', 'insecure-download'))).toBe(
      "This file may have been read or edited because this site isn't using a secure connection"
    )
  })

  it('labels the pair Keep / Delete and fills Delete only for a dangerous verdict', () => {
    expect(dangerActionLabels(verdict('dangerous', 'executable'))).toEqual({
      keep: 'Keep',
      discard: 'Delete',
      prominent: 'discard'
    })
    expect(dangerActionLabels(verdict('suspicious', 'archive')).prominent).toBeNull()
  })
})

describe('splitFileName', () => {
  it('keeps the extension and the end of the stem in the tail of a long name', () => {
    expect(splitFileName('quarterly-report-final-version-2.pdf')).toEqual({
      head: 'quarterly-report-final-ver',
      tail: 'sion-2.pdf'
    })
    expect(splitFileName('averyveryverylongnamewithoutanextension')).toEqual({
      head: 'averyveryverylongnamewithoutanext',
      tail: 'ension'
    })
  })

  it('leaves short names whole', () => {
    expect(splitFileName('notes.txt')).toEqual({ head: 'notes.txt', tail: '' })
    expect(splitFileName('README')).toEqual({ head: 'README', tail: '' })
    expect(splitFileName('a.tar.gz')).toEqual({ head: 'a.tar.gz', tail: '' })
  })
})

describe('bubbleDescription', () => {
  it('sums the list up: running, paused, blocked, failed, done', () => {
    expect(bubbleDescription([])).toBeNull()
    expect(bubbleDescription([item({ id: 'a' }), item({ id: 'b', state: 'completed' })])).toBe(
      '1 in progress'
    )
    expect(bubbleDescription([item({ id: 'a' }), item({ id: 'b' })])).toBe('2 in progress')
    expect(bubbleDescription([item({ id: 'a', state: 'paused' })])).toBe('1 paused')
    // One paused, one running: the running one is what the line is about.
    expect(bubbleDescription([item({ id: 'a', state: 'paused' }), item({ id: 'b' })])).toBe(
      '2 in progress'
    )
    const danger = { level: 'dangerous' as const, reason: 'executable' as const, message: 'x' }
    expect(
      bubbleDescription([
        item({ id: 'a', state: 'completed', danger }),
        item({ id: 'b', state: 'interrupted' })
      ])
    ).toBe('1 file blocked')
    expect(
      bubbleDescription([
        item({ id: 'a', state: 'completed', danger }),
        item({ id: 'b', state: 'completed', danger })
      ])
    ).toBe('2 files blocked')
    expect(
      bubbleDescription([
        item({ id: 'a', state: 'interrupted' }),
        item({ id: 'b', state: 'completed' })
      ])
    ).toBe('1 failed')
    expect(
      bubbleDescription([
        item({ id: 'a', state: 'completed' }),
        item({ id: 'b', state: 'cancelled' })
      ])
    ).toBe('All done')
  })
})

describe('isOnDisk', () => {
  it('is true for finished files without an open verdict that are still on disk', () => {
    expect(isOnDisk(item({ id: 'a', state: 'completed' }))).toBe(true)
    expect(isOnDisk(item({ id: 'a', state: 'progressing' }))).toBe(false)
    expect(isOnDisk(item({ id: 'a', state: 'completed', fileMissing: true }))).toBe(false)
    expect(
      isOnDisk(
        item({
          id: 'a',
          state: 'completed',
          danger: { level: 'dangerous', reason: 'executable', message: 'x' }
        })
      )
    ).toBe(false)
  })
})

describe('day groups', () => {
  const now = new Date(2026, 8, 17, 12, 0, 0).getTime()
  const at = (daysAgo: number, hour = 10): number => new Date(2026, 8, 17 - daysAgo, hour).getTime()

  it('labels today, yesterday, weekdays and dates', () => {
    expect(dayLabel(new Date(2026, 8, 17).getTime(), now)).toBe('Today')
    expect(dayLabel(new Date(2026, 8, 16).getTime(), now)).toBe('Yesterday')
    expect(dayLabel(new Date(2026, 8, 14).getTime(), now)).toBe(
      new Date(2026, 8, 14).toLocaleDateString(undefined, { weekday: 'long' })
    )
    expect(dayLabel(new Date(2026, 7, 1).getTime(), now)).toBe(
      new Date(2026, 7, 1).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
    )
    expect(dayLabel(new Date(2025, 0, 1).getTime(), now)).toBe(
      new Date(2025, 0, 1).toLocaleDateString(undefined, {
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      })
    )
  })

  it('buckets newest first within and across days', () => {
    const items = [
      item({ id: 'old', startedAt: at(3) }),
      item({ id: 'today-early', startedAt: at(0, 8) }),
      item({ id: 'yesterday', startedAt: at(1) }),
      item({ id: 'today-late', startedAt: at(0, 11) })
    ]
    const groups = groupDownloadsByDay(items, now)
    expect(groups.map((g) => g.label)).toEqual([
      'Today',
      'Yesterday',
      new Date(at(3)).toLocaleDateString(undefined, { weekday: 'long' })
    ])
    expect(groups[0].items.map((i) => i.id)).toEqual(['today-late', 'today-early'])
  })
})

describe('filterDownloads', () => {
  const items = [
    item({ id: 'report', filename: 'Report.pdf', url: 'https://acme.test/q3/report.pdf' }),
    item({
      id: 'song',
      filename: 'song.mp3',
      finalName: 'song (1).mp3',
      url: 'https://music.test/x'
    })
  ]

  it('matches the shown name, the suggested name and the URL, case-insensitively', () => {
    expect(filterDownloads(items, '').map((i) => i.id)).toEqual(['report', 'song'])
    expect(filterDownloads(items, 'REPORT').map((i) => i.id)).toEqual(['report'])
    expect(filterDownloads(items, 'acme').map((i) => i.id)).toEqual(['report'])
    expect(filterDownloads(items, '(1)').map((i) => i.id)).toEqual(['song'])
    expect(filterDownloads(items, 'nothing')).toEqual([])
  })

  it('knows when there is something to clear', () => {
    expect(hasClearable([item({ id: 'a' })])).toBe(false)
    expect(hasClearable([item({ id: 'a' }), item({ id: 'b', state: 'cancelled' })])).toBe(true)
  })
})

describe('file glyphs', () => {
  it('reads extensions', () => {
    expect(extensionOf('archive.tar.gz')).toBe('gz')
    expect(extensionOf('.bashrc')).toBe('')
    expect(extensionOf('README')).toBe('')
    expect(extensionOf('trailing.')).toBe('')
    expect(extensionOf('Setup.EXE')).toBe('exe')
  })

  it('prefers the MIME family, then the extension table, then a plain file', () => {
    expect(fileGlyphFor('photo.bin', 'image/png')).toBe('image')
    expect(fileGlyphFor('clip.bin', 'video/mp4; codecs=avc1')).toBe('video')
    expect(fileGlyphFor('setup.exe', 'application/octet-stream')).toBe('package')
    expect(fileGlyphFor('archive.zip')).toBe('archive')
    expect(fileGlyphFor('notes', 'text/plain')).toBe('text')
    expect(fileGlyphFor('blob', 'application/x-compressed')).toBe('archive')
    expect(fileGlyphFor('blob', 'application/octet-stream')).toBe('file')
  })
})
