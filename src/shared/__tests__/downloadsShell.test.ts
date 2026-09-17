import { describe, expect, it } from 'vitest'
import type { DownloadItem } from '../types'
import {
  DEFAULT_DOWNLOAD_SETTINGS,
  aggregateProgress,
  completionNotice,
  diffDownloads,
  displayName,
  listedDownloads,
  needsDangerDecision,
  progressBarFor,
  progressFraction,
  sameProgressBar,
  sanitizeDownloadSettings,
  shouldNotifyCompletion,
  snapshotDownloads,
  type DownloadRecord
} from '../downloadsShell'

function item(patch: Partial<DownloadRecord> & { id: string }): DownloadRecord {
  const base: DownloadItem = {
    id: patch.id,
    url: `https://example.test/${patch.id}`,
    filename: `${patch.id}.bin`,
    savePath: `/tmp/${patch.id}.bin`,
    totalBytes: 100,
    receivedBytes: 0,
    state: 'progressing',
    startedAt: 1_000,
    mimeType: 'application/octet-stream'
  }
  return { ...base, ...patch }
}

describe('download settings', () => {
  it('defaults match the engine contract (Chrome opens the bubble on finish, not on start)', () => {
    expect(DEFAULT_DOWNLOAD_SETTINGS).toEqual({
      directory: null,
      askWhereToSave: false,
      notifyOnComplete: true,
      openPanelOnStart: false,
      openPanelOnComplete: true,
      autoOpenTypes: [],
      alwaysShowButton: false
    })
  })

  it('fills missing keys, drops junk and inherits the legacy ask-where-to-save flag', () => {
    expect(sanitizeDownloadSettings(undefined)).toEqual(DEFAULT_DOWNLOAD_SETTINGS)
    expect(sanitizeDownloadSettings(null, true).askWhereToSave).toBe(true)
    expect(sanitizeDownloadSettings({ askWhereToSave: false }, true).askWhereToSave).toBe(false)
    const raw = {
      directory: '',
      openPanelOnComplete: false,
      autoOpenTypes: ['pdf', 7, 'png'],
      alwaysShowButton: 'yes'
    } as unknown as Partial<typeof DEFAULT_DOWNLOAD_SETTINGS>
    expect(sanitizeDownloadSettings(raw)).toEqual({
      ...DEFAULT_DOWNLOAD_SETTINGS,
      openPanelOnComplete: false,
      autoOpenTypes: ['pdf', 'png']
    })
    expect(sanitizeDownloadSettings({ directory: '/data/dl' }).directory).toBe('/data/dl')
  })

  it('returns a fresh autoOpenTypes array each time', () => {
    const a = sanitizeDownloadSettings(undefined)
    const b = sanitizeDownloadSettings(undefined)
    expect(a.autoOpenTypes).not.toBe(b.autoOpenTypes)
  })
})

describe('records', () => {
  it('shows the engine final name when present and the suggested one otherwise', () => {
    expect(displayName(item({ id: 'a' }))).toBe('a.bin')
    expect(displayName(item({ id: 'a', finalName: 'a (1).bin' }))).toBe('a (1).bin')
    expect(displayName(item({ id: 'a', filename: '' }))).toBe('download')
  })

  it('asks for a danger decision only with an unanswered non-safe verdict on a live or finished file', () => {
    const danger = { level: 'dangerous' as const, reason: 'executable', message: 'May harm' }
    expect(needsDangerDecision(item({ id: 'a', state: 'completed' }))).toBe(false)
    expect(needsDangerDecision(item({ id: 'a', state: 'completed', danger }))).toBe(true)
    expect(needsDangerDecision(item({ id: 'a', state: 'progressing', danger }))).toBe(true)
    expect(
      needsDangerDecision(item({ id: 'a', state: 'completed', danger, dangerAccepted: true }))
    ).toBe(false)
    expect(needsDangerDecision(item({ id: 'a', state: 'cancelled', danger }))).toBe(false)
    expect(
      needsDangerDecision(
        item({ id: 'a', state: 'completed', danger: { ...danger, level: 'safe' } })
      )
    ).toBe(false)
  })

  it('hides records the user removed from the list', () => {
    const items = [item({ id: 'a' }), item({ id: 'b', removed: true })]
    expect(listedDownloads(items).map((i) => i.id)).toEqual(['a'])
  })
})

describe('aggregate progress', () => {
  it('is empty without active transfers', () => {
    expect(aggregateProgress([item({ id: 'a', state: 'completed', receivedBytes: 100 })])).toEqual({
      received: 0,
      total: 0,
      indeterminate: false
    })
    expect(progressBarFor([])).toEqual({ value: -1, mode: 'none' })
  })

  it('sums bytes of active transfers only and caps received at total', () => {
    const items = [
      item({ id: 'a', receivedBytes: 50, totalBytes: 100 }),
      item({ id: 'b', receivedBytes: 300, totalBytes: 200, state: 'paused' }),
      item({ id: 'c', receivedBytes: 100, totalBytes: 100, state: 'completed' })
    ]
    const progress = aggregateProgress(items)
    expect(progress).toEqual({ received: 250, total: 300, indeterminate: false })
    expect(progressFraction(progress)).toBeCloseTo(250 / 300)
    expect(progressBarFor(items)).toEqual({ value: 250 / 300, mode: 'normal' })
  })

  it('turns indeterminate when any active transfer has no size', () => {
    const items = [item({ id: 'a', receivedBytes: 50 }), item({ id: 'b', totalBytes: 0 })]
    expect(aggregateProgress(items).indeterminate).toBe(true)
    expect(progressFraction(aggregateProgress(items))).toBe(0)
    expect(progressBarFor(items)).toEqual({ value: 2, mode: 'indeterminate' })
  })

  it('greys the bar while every transfer is paused', () => {
    expect(progressBarFor([item({ id: 'a', state: 'paused', receivedBytes: 25 })])).toEqual({
      value: 0.25,
      mode: 'paused'
    })
    expect(
      progressBarFor([item({ id: 'a', state: 'paused', receivedBytes: 25, totalBytes: 0 })])
    ).toEqual({ value: 0, mode: 'paused' })
  })

  it('treats bars within a percent as the same paint', () => {
    expect(
      sameProgressBar({ value: 0.501, mode: 'normal' }, { value: 0.504, mode: 'normal' })
    ).toBe(true)
    expect(sameProgressBar({ value: 0.5, mode: 'normal' }, { value: 0.51, mode: 'normal' })).toBe(
      false
    )
    expect(sameProgressBar({ value: 0.5, mode: 'normal' }, { value: 0.5, mode: 'paused' })).toBe(
      false
    )
  })
})

describe('diffDownloads', () => {
  it('reports new live records as started and new finished ones as done', () => {
    const changes = diffDownloads(
      [],
      [item({ id: 'a' }), item({ id: 'shot', state: 'completed', receivedBytes: 100 })]
    )
    expect(changes.map((c) => [c.item.id, c.kind])).toEqual([
      ['a', 'started'],
      ['shot', 'done']
    ])
  })

  it('reports byte and pause changes as progress and terminal states as done', () => {
    const before = [item({ id: 'a', receivedBytes: 10 }), item({ id: 'b', receivedBytes: 10 })]
    const after = [
      item({ id: 'a', receivedBytes: 20 }),
      item({ id: 'b', receivedBytes: 10, state: 'paused' })
    ]
    expect(diffDownloads(before, after).map((c) => [c.item.id, c.kind])).toEqual([
      ['a', 'progress'],
      ['b', 'progress']
    ])
    const finished = [
      item({ id: 'a', receivedBytes: 100, state: 'completed' }),
      item({ id: 'b', receivedBytes: 10, state: 'interrupted' })
    ]
    expect(diffDownloads(after, finished).map((c) => [c.item.id, c.kind])).toEqual([
      ['a', 'done'],
      ['b', 'done']
    ])
    expect(diffDownloads(finished, finished)).toEqual([])
  })

  it('reports records that left the list as removed, carrying the last known record', () => {
    const before = [item({ id: 'a', state: 'completed' }), item({ id: 'b', state: 'cancelled' })]
    const changes = diffDownloads(before, [before[0]])
    expect(changes).toEqual([{ item: before[1], kind: 'removed' }])
  })

  it('snapshots copies so in-place mutation by the engine still diffs', () => {
    const live = [item({ id: 'a', receivedBytes: 10 })]
    const snapshot = snapshotDownloads(live)
    live[0].receivedBytes = 40
    expect(diffDownloads(snapshot, live).map((c) => c.kind)).toEqual(['progress'])
    expect(diffDownloads(live, live)).toEqual([])
  })
})

describe('completion notification', () => {
  it('notifies for completions while no window has focus and the setting is on', () => {
    const done = item({ id: 'a', state: 'completed', receivedBytes: 100 })
    expect(shouldNotifyCompletion(done, { notifyOnComplete: true }, false)).toBe(true)
    expect(shouldNotifyCompletion(done, { notifyOnComplete: true }, true)).toBe(false)
    expect(shouldNotifyCompletion(done, { notifyOnComplete: false }, false)).toBe(false)
    expect(
      shouldNotifyCompletion(
        item({ id: 'a', state: 'interrupted' }),
        { notifyOnComplete: true },
        false
      )
    ).toBe(false)
  })

  it('names the file as saved', () => {
    expect(completionNotice(item({ id: 'a', finalName: 'a (2).bin' }))).toEqual({
      title: 'Download complete',
      body: 'a (2).bin'
    })
  })
})
