import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DownloadItem, DownloadSettings, UIState } from '@shared/types'
import { downloadItem } from '@shared/__tests__/downloadFixtures'

vi.mock('../api', () => ({
  cmd: vi.fn(() => Promise.resolve(null)),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))
vi.mock('../formFactor', () => ({ isPhone: () => false }))

import {
  DOWNLOAD_LINGER_MS,
  bubbleItems,
  dismissDownloadBubble,
  downloadButtonVisible,
  downloadsUi,
  handleDownloadChange,
  handleDownloadDanger,
  openDownloadBubble
} from '../downloads'
import type { DownloadChange } from '../downloadsEngine'
import { browserStore, uiStore } from '../ui'

const item = downloadItem

/** The snapshot as the engine sends it: the settings block is partial, `askWhereToSave` top-level. */
function state(
  downloads: DownloadItem[],
  over: { focused?: boolean; settings?: Partial<DownloadSettings> } = {}
): UIState {
  return {
    downloads,
    downloadsProgress: { received: 0, total: 0, indeterminate: false, active: 0 },
    settings: { askWhereToSave: false, downloads: over.settings ?? {} },
    window: { focused: over.focused ?? true },
    spaces: [{ id: 's', activeTabId: null }],
    activeSpaceId: 's',
    tabs: {}
  } as unknown as UIState
}

function change(kind: DownloadChange['kind'], it: DownloadItem): DownloadChange {
  return { kind, item: it }
}

/** Let the bubble's async open (the page capture) settle under fake timers. */
const flush = (): Promise<void> => vi.advanceTimersByTimeAsync(0).then(() => undefined)

describe('downloads chrome state', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    dismissDownloadBubble()
    downloadsUi.set({
      unseen: [],
      pulse: 0,
      lingerUntil: 0,
      highlightId: null,
      sessionHadDownload: false
    })
    uiStore.set({ overlay: 'none', downloadsOpen: false })
    browserStore.set({ state: state([]) })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the button only while something is happening, or when Settings keep it', () => {
    const ui = downloadsUi.get()
    expect(downloadButtonVisible(state([]), ui)).toBe(false)
    expect(downloadButtonVisible(state([item({ id: 'a', state: 'progressing' })]), ui)).toBe(true)
    expect(downloadButtonVisible(state([item({ id: 'a' })]), ui)).toBe(false)
    expect(downloadButtonVisible(state([]), { ...ui, unseen: ['a'] })).toBe(true)
    expect(downloadButtonVisible(state([]), { ...ui, lingerUntil: 5 })).toBe(true)
    expect(downloadButtonVisible(state([]), { ...ui, open: true })).toBe(true)
    expect(downloadButtonVisible(state([]), { ...ui, sessionHadDownload: true })).toBe(true)
    expect(downloadButtonVisible(state([], { settings: { alwaysShowButton: true } }), ui)).toBe(
      true
    )
  })

  it('a start pulses the button and holds nothing', () => {
    const s = state([item({ id: 'a', state: 'progressing', receivedBytes: 1 })])
    handleDownloadChange(change('started', s.downloads[0]), s)
    expect(downloadsUi.get().pulse).toBe(1)
    expect(downloadsUi.get().lingerUntil).toBe(0)
    expect(downloadsUi.get().open).toBe(false)
  })

  it('keeps the button for the rest of the session once a download has happened', async () => {
    const running = item({ id: 'a', state: 'progressing', receivedBytes: 1 })
    handleDownloadChange(change('started', running), state([running]))
    const done = item({ id: 'a' })
    const s = state([done], { settings: { openPanelOnComplete: false } })
    handleDownloadChange(change('done', done), s)
    await flush()
    // Seen, closed, linger over: the button is still there, as Chrome's is.
    void openDownloadBubble()
    await flush()
    dismissDownloadBubble()
    vi.advanceTimersByTime(DOWNLOAD_LINGER_MS + 1)
    const ui = downloadsUi.get()
    expect(ui.unseen).toEqual([])
    expect(ui.lingerUntil).toBe(0)
    expect(downloadButtonVisible(s, ui)).toBe(true)
    // The list at startup does not count: nothing happened in this session yet.
    expect(downloadButtonVisible(s, { ...ui, sessionHadDownload: false })).toBe(false)
  })

  it('the last completion auto-opens the partial bubble, which closes after five seconds', async () => {
    const done = item({ id: 'a' })
    const s = state([done])
    handleDownloadChange(change('done', done), s)
    await flush()
    const ui = downloadsUi.get()
    expect(ui.open).toBe(true)
    expect(ui.autoClose).toBe(true)
    expect(ui.partial).toEqual(['a'])
    expect(ui.unseen).toEqual([])
    expect(uiStore.get().downloadsOpen).toBe(true)
    // The button lingers for the five seconds after the bubble goes.
    dismissDownloadBubble()
    expect(downloadsUi.get().open).toBe(false)
    expect(downloadsUi.get().lingerUntil).toBeGreaterThan(0)
    vi.advanceTimersByTime(DOWNLOAD_LINGER_MS + 1)
    expect(downloadsUi.get().lingerUntil).toBe(0)
  })

  it('counts completions on the badge instead when Settings say no or the window is unfocused', async () => {
    const done = item({ id: 'a' })
    handleDownloadChange(
      change('done', done),
      state([done], { settings: { openPanelOnComplete: false } })
    )
    await flush()
    expect(downloadsUi.get().open).toBe(false)
    expect(downloadsUi.get().unseen).toEqual(['a'])

    const other = item({ id: 'b' })
    handleDownloadChange(change('done', other), state([done, other], { focused: false }))
    await flush()
    expect(downloadsUi.get().open).toBe(false)
    expect(downloadsUi.get().unseen).toEqual(['a', 'b'])
  })

  it('waits for the other transfers before opening, and ignores cancellations', async () => {
    const done = item({ id: 'a' })
    const running = item({ id: 'b', state: 'progressing', receivedBytes: 1 })
    handleDownloadChange(change('done', done), state([done, running]))
    await flush()
    expect(downloadsUi.get().open).toBe(false)
    expect(downloadsUi.get().unseen).toEqual(['a'])

    const cancelled = item({ id: 'b', state: 'cancelled' })
    handleDownloadChange(change('done', cancelled), state([done, cancelled]))
    await flush()
    // Nothing runs any more, but the last event was a cancellation: badge only.
    expect(downloadsUi.get().open).toBe(false)
    expect(downloadsUi.get().unseen).toEqual(['a'])
    expect(downloadsUi.get().lingerUntil).toBeGreaterThan(0)
  })

  it('does not open over another surface', async () => {
    uiStore.set({ overlay: 'settings' })
    const done = item({ id: 'a' })
    handleDownloadChange(change('done', done), state([done]))
    await flush()
    expect(downloadsUi.get().open).toBe(false)
    expect(downloadsUi.get().unseen).toEqual(['a'])
  })

  it('a removed record leaves the badge', () => {
    downloadsUi.set({ unseen: ['a', 'b'] })
    const gone = item({ id: 'a', removed: true })
    handleDownloadChange(change('removed', gone), state([]))
    expect(downloadsUi.get().unseen).toEqual(['b'])
  })

  it('reads the snapshot the event runs ahead of: the finished item speaks for itself', async () => {
    // `download.changed` arrives before the state that reflects it, so the list still says
    // "progressing" for the item that just completed; nothing else runs, so the bubble opens.
    const stale = item({ id: 'a', state: 'progressing', receivedBytes: 5 })
    handleDownloadChange(change('done', item({ id: 'a' })), state([stale]))
    await flush()
    expect(downloadsUi.get().open).toBe(true)
    expect(downloadsUi.get().partial).toEqual(['a'])
  })

  it('a flagged file opens the bubble on its warning whatever the auto-open setting says', async () => {
    const flagged = item({
      id: 'setup',
      danger: { level: 'dangerous', reason: 'executable', message: 'Harmful.' }
    })
    const s = state([flagged], { settings: { openPanelOnComplete: false } })
    handleDownloadChange(change('done', flagged), s)
    await flush()
    expect(downloadsUi.get().open).toBe(false)
    handleDownloadDanger('setup', s)
    await flush()
    expect(downloadsUi.get()).toMatchObject({ open: true, autoClose: false, highlightId: 'setup' })
    // Already up and about to auto-close: the warning holds it open instead.
    dismissDownloadBubble()
    downloadsUi.set({ unseen: [] })
    handleDownloadChange(change('done', item({ id: 'b' })), state([flagged, item({ id: 'b' })]))
    await flush()
    expect(downloadsUi.get().autoClose).toBe(true)
    handleDownloadDanger('setup', s)
    expect(downloadsUi.get()).toMatchObject({ open: true, autoClose: false, highlightId: 'setup' })
    // Not while the window is in the background, and never over another surface.
    dismissDownloadBubble()
    handleDownloadDanger('setup', state([flagged], { focused: false }))
    await flush()
    expect(downloadsUi.get().open).toBe(false)
    uiStore.set({ overlay: 'settings' })
    handleDownloadDanger('setup', s)
    await flush()
    expect(downloadsUi.get().open).toBe(false)
  })

  it('opening the bubble by hand marks everything seen and hides the page', async () => {
    downloadsUi.set({ unseen: ['a'] })
    await openDownloadBubble({ takeFocus: true, highlightId: 'a' })
    expect(downloadsUi.get()).toMatchObject({
      open: true,
      autoClose: false,
      partial: null,
      highlightId: 'a',
      unseen: []
    })
    expect(uiStore.get().downloadsOpen).toBe(true)
    dismissDownloadBubble()
    expect(uiStore.get().downloadsOpen).toBe(false)
  })

  it('the partial bubble falls back to the whole list when its items are gone', () => {
    const a = item({ id: 'a' })
    const b = item({ id: 'b' })
    expect(bubbleItems([a, b], null)).toEqual([a, b])
    expect(bubbleItems([a, b], ['b'])).toEqual([b])
    expect(bubbleItems([a, b], ['zzz'])).toEqual([a, b])
  })

  it('lists the transfers still running ahead of the finished ones, each in the engine order', () => {
    const done1 = item({ id: 'done1' })
    const running = item({ id: 'running', state: 'progressing' })
    const done2 = item({ id: 'done2' })
    const paused = item({ id: 'paused', state: 'paused' })
    expect(bubbleItems([done1, running, done2, paused], null)).toEqual([
      running,
      paused,
      done1,
      done2
    ])
    expect(bubbleItems([done1, running, done2, paused], ['done2', 'paused'])).toEqual([
      paused,
      done2
    ])
  })
})
