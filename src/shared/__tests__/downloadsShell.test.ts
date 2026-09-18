import { describe, expect, it } from 'vitest'
import type { DownloadsProgress } from '../types'
import { DEFAULT_DOWNLOAD_SETTINGS, resolveDownloadSettings } from '../downloads'
import {
  PROGRESS_ERROR_FLASH_MS,
  allPaused,
  canResumeDownload,
  canRetryDownload,
  completionNotice,
  displayName,
  failedProgressBar,
  needsDangerDecision,
  progressBarFor,
  progressFraction,
  sameProgressBar,
  shouldNotifyCompletion
} from '../downloadsShell'
import { downloadItem as item } from './downloadFixtures'

const dangerous = { level: 'dangerous', reason: 'executable', message: 'Harmful.' } as const

describe('the desktop keys of Settings.downloads', () => {
  it('default to Chrome: the button animates on start, the bubble opens on finish, no pinned button', () => {
    expect(DEFAULT_DOWNLOAD_SETTINGS.openPanelOnStart).toBe(false)
    expect(DEFAULT_DOWNLOAD_SETTINGS.openPanelOnComplete).toBe(true)
    expect(DEFAULT_DOWNLOAD_SETTINGS.alwaysShowButton).toBe(false)
  })

  it('resolve alwaysShowButton like the engine keys', () => {
    expect(resolveDownloadSettings({ downloads: {} }).alwaysShowButton).toBe(false)
    expect(
      resolveDownloadSettings({ downloads: { alwaysShowButton: true } }).alwaysShowButton
    ).toBe(true)
    expect(
      resolveDownloadSettings({ downloads: { alwaysShowButton: 'yes' as unknown as boolean } })
        .alwaysShowButton
    ).toBe(false)
  })
})

describe('rows', () => {
  it('shows the engine final name and falls back to the suggested one', () => {
    expect(displayName(item({ id: 'a', filename: 'x.pdf', finalName: 'x (1).pdf' }))).toBe(
      'x (1).pdf'
    )
    expect(displayName(item({ id: 'a', filename: 'x.pdf', finalName: '' }))).toBe('x.pdf')
  })

  it('asks for a danger decision only for a finished, flagged, unanswered file', () => {
    expect(needsDangerDecision(item({ id: 'a', danger: dangerous }))).toBe(true)
    expect(needsDangerDecision(item({ id: 'a', danger: dangerous, dangerAccepted: true }))).toBe(
      false
    )
    expect(needsDangerDecision(item({ id: 'a', danger: dangerous, state: 'progressing' }))).toBe(
      false
    )
    expect(needsDangerDecision(item({ id: 'a' }))).toBe(false)
  })

  it('retries failed, cancelled and deleted rows except blob ones; resumes paused and resumable ones', () => {
    expect(canRetryDownload(item({ id: 'a', state: 'interrupted' }))).toBe(true)
    expect(canRetryDownload(item({ id: 'a', state: 'cancelled' }))).toBe(true)
    // A finished file the engine found gone from disk: Chrome's Retry on a "Deleted" row.
    expect(canRetryDownload(item({ id: 'a', fileMissing: true }))).toBe(true)
    expect(canRetryDownload(item({ id: 'a', fileMissing: false }))).toBe(false)
    expect(canRetryDownload(item({ id: 'a', fileMissing: true, url: 'blob:https://x/1' }))).toBe(
      false
    )
    expect(canRetryDownload(item({ id: 'a', state: 'cancelled', url: 'blob:https://x/1' }))).toBe(
      false
    )
    expect(canRetryDownload(item({ id: 'a' }))).toBe(false)
    expect(canResumeDownload(item({ id: 'a', state: 'paused' }))).toBe(true)
    expect(canResumeDownload(item({ id: 'a', state: 'interrupted', canResume: true }))).toBe(true)
    expect(canResumeDownload(item({ id: 'a', state: 'interrupted' }))).toBe(false)
  })
})

describe('taskbar progress from the engine aggregate', () => {
  const progress = (over: Partial<DownloadsProgress>): DownloadsProgress => ({
    received: 0,
    total: 0,
    indeterminate: false,
    active: 0,
    ...over
  })

  it('clears the bar when nothing is in flight', () => {
    expect(progressBarFor(progress({}), false)).toEqual({ value: -1, mode: 'none' })
    expect(progressFraction(progress({}))).toBe(0)
  })

  it('shows the shared fraction, greyed while every transfer is paused', () => {
    const p = progress({ received: 25, total: 100, active: 2 })
    expect(progressBarFor(p, false)).toEqual({ value: 0.25, mode: 'normal' })
    expect(progressBarFor(p, true)).toEqual({ value: 0.25, mode: 'paused' })
    expect(progressFraction(progress({ received: 150, total: 100, active: 1 }))).toBe(1)
  })

  it('sweeps when a running transfer has no size', () => {
    const p = progress({ received: 5, total: 0, indeterminate: true, active: 1 })
    expect(progressBarFor(p, false)).toEqual({ value: 2, mode: 'indeterminate' })
    expect(progressBarFor(p, true)).toEqual({ value: 0, mode: 'paused' })
  })

  it('paints the error tone over the aggregate after a failure while others run, clears otherwise', () => {
    expect(failedProgressBar(progress({ received: 25, total: 100, active: 1 }))).toEqual({
      value: 0.25,
      mode: 'error'
    })
    // A size-less aggregate fills rather than going indeterminate, which would lose the tone.
    expect(
      failedProgressBar(progress({ received: 5, total: 0, indeterminate: true, active: 1 }))
    ).toEqual({ value: 1, mode: 'error' })
    expect(failedProgressBar(progress({}))).toEqual({ value: -1, mode: 'none' })
    expect(PROGRESS_ERROR_FLASH_MS).toBeGreaterThan(0)
  })

  it('knows when every in-flight row is paused', () => {
    expect(allPaused([])).toBe(false)
    expect(allPaused([item({ id: 'a', state: 'paused' }), item({ id: 'b' })])).toBe(true)
    expect(
      allPaused([item({ id: 'a', state: 'paused' }), item({ id: 'b', state: 'progressing' })])
    ).toBe(false)
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

describe('completion notification', () => {
  it('notifies for released completions while no window has focus and the setting is on', () => {
    const on = { notifyOnComplete: true }
    expect(shouldNotifyCompletion(item({ id: 'a' }), on, false)).toBe(true)
    expect(shouldNotifyCompletion(item({ id: 'a' }), on, true)).toBe(false)
    expect(shouldNotifyCompletion(item({ id: 'a' }), { notifyOnComplete: false }, false)).toBe(
      false
    )
    expect(shouldNotifyCompletion(item({ id: 'a', state: 'interrupted' }), on, false)).toBe(false)
    // A flagged file waits for Keep in the bubble; it is not "complete" to the user yet.
    expect(shouldNotifyCompletion(item({ id: 'a', danger: dangerous }), on, false)).toBe(false)
    expect(
      shouldNotifyCompletion(item({ id: 'a', danger: dangerous, dangerAccepted: true }), on, false)
    ).toBe(true)
  })

  it('names the file as saved', () => {
    expect(completionNotice(item({ id: 'a', filename: 'r.pdf', finalName: 'r (2).pdf' }))).toEqual({
      title: 'Download complete',
      body: 'r (2).pdf'
    })
  })
})
