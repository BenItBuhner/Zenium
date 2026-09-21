import { describe, expect, it } from 'vitest'
import type { DownloadInterruptReason, DownloadItem } from '@shared/types'
import { INTERRUPT_REASONS, interruptMessage } from '@shared/downloads'
import { canRetryDownload } from '@shared/downloadsShell'
import { downloadItem } from '@shared/__tests__/downloadFixtures'
import {
  INTERRUPT_WORDING,
  autoResumeStatus,
  blockedStatus,
  bubbleDescription,
  dangerActionLabels,
  dangerSummary,
  dayLabel,
  decisionLabels,
  describeDownloadError,
  downloadStatus,
  extensionOf,
  fileGlyphFor,
  filterDownloads,
  formatRemaining,
  formatSpeed,
  groupDownloadsByDay,
  hasClearable,
  isDeletedRow,
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

  it('words every one of the engine’s 22 interrupt reasons as Failed · <reason>, in the words of Chrome 112’s bubble', () => {
    // Chrome's BubbleStatusTextBuilder groups, one line per member of the closed set.
    const expected: Record<DownloadInterruptReason, string> = {
      'network-failed': 'Check internet connection',
      'network-timeout': 'Check internet connection',
      'network-disconnected': 'Check internet connection',
      'network-server-down': 'Site wasn’t available',
      'server-failed': 'Site wasn’t available',
      'server-unreachable': 'Site wasn’t available',
      'server-unauthorized': 'File wasn’t available on site',
      'server-forbidden': 'File wasn’t available on site',
      'server-bad-content': 'File wasn’t available on site',
      'server-no-range': 'Something went wrong',
      'file-failed': 'Something went wrong',
      'file-access-denied': 'Needs permission to download',
      'file-no-space': 'Out of storage space',
      'file-name-too-long': 'File name or location is too long',
      'file-too-large': 'File is too big for this device',
      'file-virus-infected': 'Virus detected',
      'file-blocked': 'Blocked by your organization',
      'file-security-check-failed': 'Virus scan failed',
      'file-same-as-source': 'Already downloaded',
      'user-canceled': 'Cancelled',
      'user-shutdown': 'Couldn’t finish download',
      crash: 'Couldn’t finish download'
    }
    expect(INTERRUPT_REASONS).toHaveLength(22)
    expect(Object.keys(INTERRUPT_WORDING).sort()).toEqual([...INTERRUPT_REASONS].sort())
    for (const reason of INTERRUPT_REASONS) {
      expect(describeDownloadError(reason)).toBe(`Failed · ${expected[reason]}`)
      // The engine's own sentence (DownloadItem.errorMessage) is the same wording, so a row and
      // a consumer without a table (the Android sheet, extensions) agree.
      expect(INTERRUPT_WORDING[reason]).toBe(interruptMessage(reason))
    }
    // No reason at all (an engine that could not say): a bare Failed, not a guess.
    expect(describeDownloadError(undefined)).toBe('Failed')
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
      tone: 'danger',
      hint: undefined
    })
    // The engine's sentence rides along as the line's tooltip (Chrome's shelf showed one).
    expect(
      downloadStatus(
        item({
          id: 'a',
          state: 'interrupted',
          error: 'user-shutdown',
          errorMessage: 'Couldn’t finish download'
        })
      )
    ).toEqual({
      text: 'Failed · Couldn’t finish download',
      tone: 'danger',
      hint: 'Couldn’t finish download'
    })
    expect(
      downloadStatus(item({ id: 'a', state: 'interrupted', error: 'network-failed' })).text
    ).toBe('Failed · Check internet connection')
    // While the engine will try again on its own (HB-43) the line counts down in the plain ink,
    // the failure's sentence still the tooltip; Resume and Cancel stay the row's verbs.
    const scheduled = item({
      id: 'a',
      state: 'interrupted',
      error: 'network-disconnected',
      errorMessage: 'Check internet connection',
      canResume: true,
      autoResumeAt: 10_000
    })
    expect(downloadStatus(scheduled, 7_500)).toEqual({
      text: 'Resuming in 3 s…',
      tone: 'muted',
      hint: 'Check internet connection'
    })
    expect(downloadStatus(scheduled, 10_000).text).toBe('Resuming…')
    expect(downloadStatus({ ...scheduled, autoResumeAt: undefined }).text).toBe(
      'Failed · Check internet connection'
    )
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

  it('names the block by verdict, the tier in the line (HB-19 / PS-34)', () => {
    expect(blockedStatus(verdict('dangerous', 'executable'))).toBe('Blocked · Dangerous')
    expect(blockedStatus(verdict('dangerous', 'script'))).toBe('Blocked · Dangerous')
    // A disk image or a macro-bearing document is the lesser tier: Chrome's "Suspicious", not
    // "Dangerous" – the line names the tier the engine gave, as the interface's verbs table says.
    expect(blockedStatus(verdict('suspicious', 'archive'))).toBe('Blocked · Suspicious')
    expect(blockedStatus(verdict('suspicious', 'office-macro'))).toBe('Blocked · Suspicious')
    expect(blockedStatus(verdict('suspicious', 'file-type'))).toBe('Blocked · Suspicious')
    expect(blockedStatus(verdict('dangerous', 'url-verdict'))).toBe('Blocked · Dangerous')
    expect(blockedStatus(verdict('suspicious', 'url-verdict'))).toBe('Blocked · Uncommon file')
    expect(blockedStatus(verdict('suspicious', 'insecure-download'))).toBe(
      'Blocked · Insecure download'
    )
  })

  it('words the waiting pair per state: Keep / Delete for a flagged file, Keep anyway / Discard for an insecure block', () => {
    const flagged = item({ id: 'f', state: 'completed', danger: verdict('dangerous', 'executable') })
    expect(decisionLabels(flagged)).toEqual({ keep: 'Keep', discard: 'Delete', prominent: 'discard' })
    const lesser = item({ id: 'l', state: 'completed', danger: verdict('suspicious', 'archive') })
    expect(decisionLabels(lesser)).toEqual({ keep: 'Keep', discard: 'Delete', prominent: null })
    // Nothing is on disk for an insecure-blocked row, so its second verb is Discard, not Delete;
    // both plain. Keep anyway only while the engine would honour it (`canKeepInsecure`).
    const blocked = item({ id: 'b', state: 'insecure-blocked', savePath: '', receivedBytes: 0 })
    expect(decisionLabels(blocked)).toEqual({ keep: 'Keep anyway', discard: 'Discard', prominent: null })
    const blockedDangerous = item({
      id: 'bd',
      state: 'insecure-blocked',
      savePath: '',
      receivedBytes: 0,
      danger: verdict('dangerous', 'executable')
    })
    expect(decisionLabels(blockedDangerous)).toEqual({ keep: null, discard: 'Discard', prominent: null })
  })

  it('counts an automatic resume down in whole seconds, then reads Resuming… (HB-43)', () => {
    expect(autoResumeStatus(10_000, 8_000)).toBe('Resuming in 2 s…')
    expect(autoResumeStatus(10_000, 8_001)).toBe('Resuming in 2 s…')
    expect(autoResumeStatus(10_000, 9_000)).toBe('Resuming in 1 s…')
    expect(autoResumeStatus(10_000, 9_999)).toBe('Resuming in 1 s…')
    expect(autoResumeStatus(10_000, 10_000)).toBe('Resuming…')
    expect(autoResumeStatus(10_000, 12_000)).toBe('Resuming…')
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

describe('the Deleted row (Chrome’s greyed row for a finished file gone from disk)', () => {
  it('is a completed row the engine marked fileMissing, and nothing else', () => {
    expect(isDeletedRow(item({ id: 'a', state: 'completed', fileMissing: true }))).toBe(true)
    expect(isDeletedRow(item({ id: 'a', state: 'completed', fileMissing: false }))).toBe(false)
    expect(isDeletedRow(item({ id: 'a', state: 'completed' }))).toBe(false)
    // The engine never marks a row without a completed file; the derivation does not guess.
    for (const state of ['progressing', 'paused', 'cancelled', 'interrupted'] as const) {
      expect(isDeletedRow(item({ id: 'a', state, fileMissing: true }))).toBe(false)
    }
  })

  it('reads Deleted in the muted ink, with nothing to open and Retry still offered', () => {
    const deleted = item({
      id: 'a',
      state: 'completed',
      receivedBytes: 100 * MB,
      fileMissing: true
    })
    expect(downloadStatus(deleted)).toEqual({ text: 'Deleted', tone: 'muted' })
    expect(isOnDisk(deleted)).toBe(false)
    expect(canRetryDownload(deleted)).toBe(true)
    // The file came back (the user restored it): the row is a plain finished one again.
    const restored = { ...deleted, fileMissing: undefined }
    expect(downloadStatus(restored)).toEqual({ text: 'Done · 100 MB', tone: 'muted' })
    expect(isOnDisk(restored)).toBe(true)
    expect(canRetryDownload(restored)).toBe(false)
  })

  it('counts as done in the bubble’s description, not as failed', () => {
    const items = [
      item({ id: 'a', state: 'completed', fileMissing: true }),
      item({ id: 'b', state: 'completed' })
    ]
    expect(bubbleDescription(items)).toBe('All done')
    expect(hasClearable(items)).toBe(true)
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
