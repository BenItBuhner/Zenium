import { describe, expect, it } from 'vitest'
import type { DownloadItem } from '../types'
import {
  DEFAULT_DOWNLOAD_SETTINGS,
  aggregateProgress,
  displayNameOf,
  downloadStatus,
  downloadsProgressOf,
  engineFieldsOf,
  fileGlyphFor,
  filterDownloads,
  formatRemaining,
  groupDownloadsByDay,
  isActiveDownload,
  needsDangerDecision,
  progressBarFor,
  sanitizeDownloadSettings,
  secondsRemaining
} from '../downloads'

function item(patch: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 'dl_1',
    url: 'https://example.com/a.bin',
    filename: 'a.bin',
    savePath: '/tmp/a.bin',
    totalBytes: 100,
    receivedBytes: 0,
    state: 'completed',
    startedAt: 0,
    mimeType: 'application/octet-stream',
    ...patch
  }
}

describe('sanitizeDownloadSettings', () => {
  it('fills defaults, including Chrome 112+ openPanelOnComplete', () => {
    expect(sanitizeDownloadSettings(undefined)).toEqual(DEFAULT_DOWNLOAD_SETTINGS)
    expect(sanitizeDownloadSettings({}).openPanelOnComplete).toBe(true)
    expect(sanitizeDownloadSettings({}).notifyOnComplete).toBe(false)
    expect(sanitizeDownloadSettings({}).alwaysShowButton).toBe(false)
    expect(sanitizeDownloadSettings({}).directory).toBeNull()
  })

  it('accepts contract keys and legacy aliases', () => {
    const next = sanitizeDownloadSettings({
      directory: '/tmp/dl',
      notifyOnComplete: true,
      openPanelOnStart: true,
      openPanelOnComplete: false,
      alwaysShowButton: true,
      autoOpenTypes: ['pdf', 1 as unknown as string]
    })
    expect(next.directory).toBe('/tmp/dl')
    expect(next.notifyOnComplete).toBe(true)
    expect(next.openPanelOnStart).toBe(true)
    expect(next.openPanelOnComplete).toBe(false)
    expect(next.alwaysShowButton).toBe(true)
    expect(next.autoOpenTypes).toEqual(['pdf'])
    expect(
      sanitizeDownloadSettings({
        location: '/old',
        showWhenDone: false
      } as Partial<typeof DEFAULT_DOWNLOAD_SETTINGS> & { location: string; showWhenDone: boolean })
    ).toMatchObject({ directory: '/old', openPanelOnComplete: false })
  })
})

describe('aggregateProgress / progressBarFor', () => {
  it('is idle with no active transfers', () => {
    expect(aggregateProgress([item({ state: 'completed' })])).toEqual({ mode: 'idle', value: 0 })
    expect(aggregateProgress([])).toEqual({ mode: 'idle', value: 0 })
    expect(progressBarFor({ mode: 'idle', value: 0 })).toEqual({ value: -1, mode: 'none' })
  })

  it('sums known totals and pauses when every active item is paused', () => {
    const a = item({ state: 'progressing', receivedBytes: 25, totalBytes: 100 })
    const b = item({ id: 'dl_2', state: 'progressing', receivedBytes: 25, totalBytes: 100 })
    expect(aggregateProgress([a, b, item({ state: 'completed' })])).toEqual({
      mode: 'normal',
      value: 0.25
    })
    expect(progressBarFor({ mode: 'normal', value: 0.25 })).toEqual({
      value: 0.25,
      mode: 'normal'
    })
    expect(progressBarFor({ mode: 'paused', value: 0.4 })).toEqual({
      value: 0.4,
      mode: 'paused'
    })
    expect(progressBarFor({ mode: 'error', value: 1 })).toEqual({ value: 1, mode: 'error' })
  })

  it('is indeterminate when a total is unknown', () => {
    expect(
      aggregateProgress([item({ state: 'progressing', totalBytes: 0, receivedBytes: 10 })]).mode
    ).toBe('indeterminate')
    expect(progressBarFor({ mode: 'indeterminate', value: 0 })).toEqual({
      value: 2,
      mode: 'indeterminate'
    })
  })

  it('exposes the contract snapshot shape', () => {
    const a = item({ state: 'progressing', receivedBytes: 10, totalBytes: 40 })
    const b = item({ id: 'b', state: 'paused', receivedBytes: 10, totalBytes: 60 })
    expect(downloadsProgressOf([a, b])).toEqual({ received: 20, total: 100, indeterminate: false })
    expect(
      downloadsProgressOf([item({ state: 'progressing', totalBytes: 0, receivedBytes: 4 })])
    ).toEqual({ received: 4, total: 0, indeterminate: true })
  })
})

describe('status, search, grouping, extras', () => {
  it('describes the states the current engine exposes', () => {
    expect(
      downloadStatus(item({ state: 'progressing', receivedBytes: 50, totalBytes: 100 })).text
    ).toBe('50 B of 100 B')
    expect(downloadStatus(item({ state: 'paused', receivedBytes: 50, totalBytes: 100 })).text).toBe(
      'Paused · 50 B of 100 B'
    )
    expect(downloadStatus(item({ state: 'cancelled' })).text).toBe('Cancelled')
    expect(downloadStatus(item({ state: 'interrupted' })).text).toBe('Failed')
    expect(downloadStatus(item({ state: 'completed', totalBytes: 100 })).text).toBe('Done · 100 B')
    expect(isActiveDownload(item({ state: 'progressing' }))).toBe(true)
    expect(isActiveDownload(item({ state: 'completed' }))).toBe(false)
  })

  it('shows ETA and danger only when those fields exist', () => {
    const progressing = {
      ...item({ state: 'progressing', receivedBytes: 50, totalBytes: 100 }),
      bytesPerSecond: 50
    } as DownloadItem
    expect(downloadStatus(progressing).text).toContain('left')
    const dangerous = {
      ...item(),
      danger: { level: 'dangerous', reason: 'executable', message: 'This file may be dangerous' }
    } as DownloadItem
    expect(needsDangerDecision(dangerous)).toBe(true)
    expect(downloadStatus(dangerous).tone).toBe('warn')
    expect(needsDangerDecision(item())).toBe(false)
    expect(displayNameOf({ ...item(), finalName: 'final.bin' } as DownloadItem)).toBe('final.bin')
    expect(displayNameOf(item())).toBe('a.bin')
    expect(engineFieldsOf(item()).bytesPerSecond).toBeUndefined()
  })

  it('filters by name and URL and groups by day', () => {
    const now = Date.UTC(2026, 8, 17, 12)
    const today = item({ filename: 'today.pdf', startedAt: now })
    const yesterday = item({
      id: 'y',
      filename: 'old.zip',
      url: 'https://cdn.example/old.zip',
      startedAt: now - 86_400_000
    })
    expect(filterDownloads([today, yesterday], 'PDF').map((i) => i.id)).toEqual(['dl_1'])
    expect(filterDownloads([today, yesterday], 'cdn.example').map((i) => i.id)).toEqual(['y'])
    const groups = groupDownloadsByDay([today, yesterday], now)
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday'])
    expect(groups[0]?.items).toHaveLength(1)
  })

  it('picks a file-type glyph from the name or MIME type', () => {
    expect(fileGlyphFor('photo.PNG')).toBe('image')
    expect(fileGlyphFor('a.bin', 'video/mp4')).toBe('video')
    expect(fileGlyphFor('setup.exe')).toBe('package')
    expect(fileGlyphFor('notes.txt')).toBe('text')
  })

  it('formats remaining time', () => {
    expect(secondsRemaining(50, 100, 50)).toBe(1)
    expect(formatRemaining(1)).toBe('1 sec left')
    expect(formatRemaining(90)).toBe('2 mins left')
    expect(formatRemaining(null)).toBe('')
  })
})
