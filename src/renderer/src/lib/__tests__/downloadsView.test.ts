import { describe, expect, it } from 'vitest'
import type { DownloadRecord } from '@shared/downloadsShell'
import {
  dayLabel,
  downloadStatus,
  extensionOf,
  fileGlyphFor,
  filterDownloads,
  formatRemaining,
  formatSpeed,
  groupDownloadsByDay,
  hasClearable,
  isOnDisk
} from '../downloadsView'

const MB = 1024 * 1024

function item(patch: Partial<DownloadRecord> & { id: string }): DownloadRecord {
  return {
    url: `https://files.example/${patch.id}`,
    filename: `${patch.id}.zip`,
    savePath: `/home/u/Downloads/${patch.id}.zip`,
    totalBytes: 100 * MB,
    receivedBytes: 0,
    state: 'progressing',
    startedAt: Date.UTC(2026, 8, 17, 9, 0, 0),
    mimeType: 'application/zip',
    ...patch
  }
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
    expect(formatSpeed(undefined)).toBe('')
    expect(formatSpeed(0)).toBe('')
    expect(formatSpeed(1.5 * MB)).toBe('1.5 MB/s')
  })
})

describe('downloadStatus', () => {
  it('shows bytes only with the fields the engine on main has', () => {
    expect(downloadStatus(item({ id: 'a', receivedBytes: 30 * MB }))).toEqual({
      text: '30.0 MB of 100 MB',
      tone: 'muted'
    })
    expect(downloadStatus(item({ id: 'a', receivedBytes: 30 * MB, totalBytes: 0 }))).toEqual({
      text: '30.0 MB',
      tone: 'muted'
    })
  })

  it('adds speed and time left when the engine reports them', () => {
    const status = downloadStatus(
      item({ id: 'a', receivedBytes: 30 * MB, bytesPerSecond: 5 * MB, etaMs: 14_000 })
    )
    expect(status.text).toBe('5.0 MB/s · 30.0 MB of 100 MB · 14 secs left')
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
      downloadStatus(item({ id: 'a', state: 'interrupted', error: 'Network error' })).text
    ).toBe('Failed - Network error')
    expect(downloadStatus(item({ id: 'a', state: 'completed', receivedBytes: 100 * MB }))).toEqual({
      text: 'Done · 100 MB',
      tone: 'muted'
    })
    expect(downloadStatus(item({ id: 'a', state: 'completed', totalBytes: 0 })).text).toBe('Done')
  })

  it('shows the engine danger message until the user decides', () => {
    const danger = {
      level: 'dangerous' as const,
      reason: 'executable',
      message: 'setup.exe may harm'
    }
    expect(downloadStatus(item({ id: 'a', state: 'completed', danger }))).toEqual({
      text: 'setup.exe may harm',
      tone: 'danger'
    })
    expect(
      downloadStatus(
        item({ id: 'a', state: 'completed', danger: { ...danger, level: 'suspicious' } })
      ).tone
    ).toBe('warn')
    expect(
      downloadStatus(item({ id: 'a', state: 'completed', danger, dangerAccepted: true })).text
    ).toBe('Done · 100 MB')
  })
})

describe('isOnDisk', () => {
  it('is true for finished files without an open verdict', () => {
    expect(isOnDisk(item({ id: 'a', state: 'completed' }))).toBe(true)
    expect(isOnDisk(item({ id: 'a', state: 'progressing' }))).toBe(false)
    expect(isOnDisk(item({ id: 'a', state: 'completed', removed: true }))).toBe(false)
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
