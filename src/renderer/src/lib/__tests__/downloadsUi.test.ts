import { describe, expect, it } from 'vitest'
import type { DownloadItem, UIState } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import {
  bubbleItems,
  downloadButtonVisible,
  shouldAutoOpenPartialBubble,
  type DownloadsUi
} from '../downloadsLogic'
import {
  canOpenDownload,
  canResumeDownload,
  canRetryDownload,
  needsKeepDiscard
} from '../downloadsEngine'

function ui(patch: Partial<DownloadsUi> = {}): DownloadsUi {
  return {
    open: false,
    closing: false,
    partial: null,
    autoClose: false,
    highlightId: null,
    unseen: [],
    pulse: 0,
    lingerUntil: 0,
    ...patch
  }
}

function browser(patch: Partial<Pick<UIState, 'downloads' | 'settings'>> = {}): UIState {
  return {
    settings: structuredClone(DEFAULT_SETTINGS),
    downloads: [],
    ...patch
  } as UIState
}

const progressing: DownloadItem = {
  id: 'dl_1',
  url: 'https://example.com/a.bin',
  filename: 'a.bin',
  savePath: '/tmp/a.bin',
  totalBytes: 10,
  receivedBytes: 1,
  state: 'progressing',
  startedAt: 1,
  mimeType: 'application/octet-stream'
}

describe('downloadButtonVisible', () => {
  it('shows while a transfer is in progress, the bubble is open, or the linger holds', () => {
    expect(downloadButtonVisible(browser(), ui())).toBe(false)
    expect(downloadButtonVisible(browser({ downloads: [progressing] }), ui())).toBe(true)
    expect(downloadButtonVisible(browser(), ui({ open: true }))).toBe(true)
    expect(downloadButtonVisible(browser(), ui({ lingerUntil: Date.now() + 1000 }))).toBe(true)
  })

  it('stays when alwaysShowButton is on', () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.downloads.alwaysShowButton = true
    expect(downloadButtonVisible(browser({ settings }), ui())).toBe(true)
  })
})

describe('bubbleItems', () => {
  it('shows the partial set when those ids still exist', () => {
    const items = [progressing, { ...progressing, id: 'dl_2', state: 'completed' as const }]
    expect(bubbleItems(items, ['dl_2']).map((i) => i.id)).toEqual(['dl_2'])
    expect(bubbleItems(items, ['missing']).map((i) => i.id)).toEqual(['dl_1', 'dl_2'])
    expect(bubbleItems(items, null)).toHaveLength(2)
  })
})

describe('shouldAutoOpenPartialBubble', () => {
  const base = {
    finishedState: 'completed' as const,
    stillActive: 0,
    openPanelOnComplete: true,
    bubbleOpen: false,
    overlayIsDownloads: false,
    phone: false,
    finishedCount: 1
  }

  it('opens when the last in-progress download finishes and the setting is on', () => {
    expect(shouldAutoOpenPartialBubble(base)).toBe(true)
  })

  it('stays closed when the setting is off, something is still in flight, or the user is looking', () => {
    expect(shouldAutoOpenPartialBubble({ ...base, openPanelOnComplete: false })).toBe(false)
    expect(shouldAutoOpenPartialBubble({ ...base, stillActive: 1 })).toBe(false)
    expect(shouldAutoOpenPartialBubble({ ...base, bubbleOpen: true })).toBe(false)
    expect(shouldAutoOpenPartialBubble({ ...base, overlayIsDownloads: true })).toBe(false)
    expect(shouldAutoOpenPartialBubble({ ...base, phone: true })).toBe(false)
    expect(shouldAutoOpenPartialBubble({ ...base, finishedCount: 0 })).toBe(false)
    expect(shouldAutoOpenPartialBubble({ ...base, finishedState: 'cancelled' })).toBe(false)
  })
})

describe('engine adapter gates', () => {
  it('hides retry, Keep/Discard and open-when-done until the engine exposes them', () => {
    expect(canRetryDownload({ ...progressing, state: 'interrupted' })).toBe(false)
    expect(canRetryDownload({ ...progressing, state: 'cancelled' })).toBe(false)
    expect(needsKeepDiscard(progressing)).toBe(false)
    const dangerous = {
      ...progressing,
      state: 'completed' as const,
      danger: { level: 'dangerous', reason: 'executable', message: 'This file may be dangerous' }
    }
    expect(needsKeepDiscard(dangerous)).toBe(false)
    expect(canOpenDownload({ ...progressing, state: 'completed' })).toBe(true)
  })

  it('offers Resume for paused items, and for interrupted only when canResume is set', () => {
    expect(canResumeDownload({ ...progressing, state: 'paused' })).toBe(true)
    expect(canResumeDownload({ ...progressing, state: 'interrupted' })).toBe(false)
    expect(
      canResumeDownload({
        ...progressing,
        state: 'interrupted',
        canResume: true
      } as DownloadItem)
    ).toBe(true)
    expect(canResumeDownload(progressing)).toBe(false)
  })
})
