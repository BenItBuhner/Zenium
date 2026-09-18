import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { DownloadChangeKind, DownloadItem, DownloadsProgress } from '../../../shared/types'
import type { DownloadChangeListener } from '../../../core/browser'
import { downloadItem as item } from '../../../shared/__tests__/downloadFixtures'
import { PROGRESS_ERROR_FLASH_MS } from '../../../shared/downloadsShell'

/*
 * The desktop shell on the engine's `download.changed` events (contract: the engine owns
 * neither `setProgressBar` nor `Notification`): each window's taskbar entry follows the
 * aggregate the window lists, a failure flashes the error tone while others run, the last
 * transfer clears the entry, and a completion while no window is focused posts a notification
 * whose click reveals the row.
 */

class FakeNotification extends EventEmitter {
  static shown: FakeNotification[] = []
  static isSupported = (): boolean => true
  constructor(readonly options: { title: string; body: string; silent: boolean }) {
    super()
  }
  show(): void {
    FakeNotification.shown.push(this)
  }
}

const appEvents = new EventEmitter()
vi.mock('electron', () => ({
  app: Object.assign(appEvents, { dock: undefined, getFileIcon: vi.fn(), getPath: () => '/tmp' }),
  BrowserWindow: class {},
  Notification: FakeNotification,
  nativeImage: { createEmpty: () => ({ isEmpty: () => true }) },
  shell: { openPath: vi.fn() }
}))
vi.mock('../appIcon', () => ({ windowIcon: () => null }))
vi.mock('../downloads', () => ({ downloadDir: () => '/tmp' }))

const { ElectronDownloadsShell } = await import('../downloadsShell')

interface Bar {
  value: number
  mode: string
}

interface FakeWindow {
  win: {
    isPrivate: boolean
    host: {
      alive: boolean
      win: { setProgressBar: (value: number, o: { mode: string }) => void }
      isFocused: () => boolean
      show: () => void
      focus: () => void
    }
    send: ReturnType<typeof vi.fn>
  }
  /** Every paint the taskbar entry was asked for, in order. */
  bars: Bar[]
}

/** A window as the shell sees it: private or not, focused or not, with its taskbar entry. */
function fakeWindow(over: { isPrivate?: boolean; focused?: boolean } = {}): FakeWindow {
  const bars: Bar[] = []
  const win = {
    isPrivate: over.isPrivate ?? false,
    host: {
      alive: true,
      win: {
        setProgressBar: (value: number, o: { mode: string }): void => {
          bars.push({ value, ...o })
        }
      },
      isFocused: () => over.focused ?? false,
      show: vi.fn(),
      focus: vi.fn()
    },
    send: vi.fn()
  }
  return { win, bars }
}

interface FakeBrowser {
  browser: object
  /** The engine published a change: the list is `next`, the event is about `changed`. */
  publish: (next: DownloadItem[], changed: DownloadItem, kind: DownloadChangeKind) => void
}

/** The slice of the core the shell drives: the windows, the engine's list and its aggregate. */
function fakeBrowser(windows: FakeWindow[]): FakeBrowser {
  const listeners = new Set<DownloadChangeListener>()
  let items: DownloadItem[] = []
  const browser = {
    state: { settings: { downloads: {} } },
    allWindows: () => windows.map((w) => w.win),
    ensureWindow: () => windows[0].win,
    onDownloadChange: (l: DownloadChangeListener) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    downloads: {
      visibleTo: (priv: boolean) => items.filter((i) => priv || !i.private),
      aggregateProgress: (filter: { private?: boolean }): DownloadsProgress => {
        const active = items.filter(
          (i) =>
            (i.state === 'progressing' || i.state === 'paused') &&
            (filter.private === undefined || i.private === filter.private)
        )
        return {
          received: active.reduce((n, i) => n + i.receivedBytes, 0),
          total: active.reduce((n, i) => n + i.totalBytes, 0),
          indeterminate: active.some((i) => i.totalBytes <= 0),
          active: active.length
        }
      }
    }
  }
  const publish = (next: DownloadItem[], changed: DownloadItem, kind: DownloadChangeKind): void => {
    items = next
    for (const l of listeners) l(changed, kind)
  }
  return { browser, publish }
}

const progressing = (
  id: string,
  received: number,
  over: Partial<DownloadItem> = {}
): DownloadItem =>
  item({ id, state: 'progressing', receivedBytes: received, totalBytes: 100, ...over })

describe('the desktop downloads shell', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeNotification.shown = []
  })
  afterEach(() => {
    vi.useRealTimers()
    appEvents.removeAllListeners()
  })

  it('shows the aggregate on every taskbar entry, paused while all are, cleared at the end', () => {
    const w = fakeWindow()
    const { browser, publish } = fakeBrowser([w])
    new ElectronDownloadsShell(browser as never)
    const a = progressing('a', 20)
    publish([a], a, 'started')
    const b = progressing('b', 60)
    publish([a, b], b, 'started')
    const aPaused = { ...a, state: 'paused' as const }
    const bPaused = { ...b, state: 'paused' as const }
    publish([aPaused, bPaused], bPaused, 'progress')
    const aDone = { ...a, state: 'completed' as const, receivedBytes: 100 }
    publish([aDone, bPaused], aDone, 'done')
    const bDone = { ...b, state: 'completed' as const, receivedBytes: 100 }
    publish([aDone, bDone], bDone, 'done')
    expect(w.bars).toEqual([
      { value: 0.2, mode: 'normal' },
      { value: 0.4, mode: 'normal' },
      { value: 0.4, mode: 'paused' },
      { value: 0.6, mode: 'paused' },
      { value: -1, mode: 'none' }
    ])
  })

  it('flashes the error tone after a failure while others run, then returns to the aggregate', () => {
    const w = fakeWindow()
    const { browser, publish } = fakeBrowser([w])
    new ElectronDownloadsShell(browser as never)
    const a = progressing('a', 50)
    const b = progressing('b', 50)
    publish([a, b], a, 'started')
    const bFailed = { ...b, state: 'interrupted' as const, error: 'net::ERR_FAILED' }
    publish([a, bFailed], bFailed, 'done')
    expect(w.bars.at(-1)).toEqual({ value: 0.5, mode: 'error' })
    vi.advanceTimersByTime(PROGRESS_ERROR_FLASH_MS)
    expect(w.bars.at(-1)).toEqual({ value: 0.5, mode: 'normal' })
    expect(w.bars).toHaveLength(3)
  })

  it('flashes once for a resumable interruption (a progress change), not on every later update', () => {
    const w = fakeWindow()
    const { browser, publish } = fakeBrowser([w])
    new ElectronDownloadsShell(browser as never)
    const a = progressing('a', 50)
    const b = progressing('b', 50)
    publish([a, b], a, 'started')
    // The connection dropped: the host reports the row interrupted but resumable.
    const bDropped = { ...b, state: 'interrupted' as const, canResume: true, error: 'interrupted' }
    publish([a, bDropped], bDropped, 'progress')
    expect(w.bars.at(-1)).toEqual({ value: 0.5, mode: 'error' })
    vi.advanceTimersByTime(PROGRESS_ERROR_FLASH_MS / 2)
    // The engine republishes the interrupted row (a rename, a persist): no second flash.
    publish([a, bDropped], bDropped, 'progress')
    vi.advanceTimersByTime(PROGRESS_ERROR_FLASH_MS / 2)
    expect(w.bars.at(-1)).toEqual({ value: 0.5, mode: 'normal' })
    // Resumed and dropped again: a new failure, a new flash.
    const bAgain = { ...b, state: 'progressing' as const }
    publish([a, bAgain], bAgain, 'progress')
    publish([a, bDropped], bDropped, 'progress')
    expect(w.bars.at(-1)).toEqual({ value: 0.5, mode: 'error' })
  })

  it('clears the entry at once when the failed transfer was the last one', () => {
    const w = fakeWindow()
    const { browser, publish } = fakeBrowser([w])
    new ElectronDownloadsShell(browser as never)
    const a = progressing('a', 50)
    publish([a], a, 'started')
    const failed = { ...a, state: 'interrupted' as const }
    publish([failed], failed, 'done')
    expect(w.bars.at(-1)).toEqual({ value: -1, mode: 'none' })
    vi.advanceTimersByTime(PROGRESS_ERROR_FLASH_MS)
    expect(w.bars).toHaveLength(2)
  })

  it('keeps a private failure to the private windows', () => {
    const regular = fakeWindow()
    const priv = fakeWindow({ isPrivate: true })
    const { browser, publish } = fakeBrowser([regular, priv])
    new ElectronDownloadsShell(browser as never)
    const a = progressing('a', 50)
    const p = progressing('p', 50, { private: true })
    publish([a, p], p, 'started')
    const pFailed = { ...p, state: 'interrupted' as const }
    publish([a, pFailed], pFailed, 'done')
    expect(regular.bars.at(-1)).toEqual({ value: 0.5, mode: 'normal' })
    expect(priv.bars.at(-1)).toEqual({ value: 0.5, mode: 'error' })
  })

  it('notifies a completion only while no window is focused, and the click reveals the row', () => {
    const w = fakeWindow({ focused: true })
    const { browser, publish } = fakeBrowser([w])
    new ElectronDownloadsShell(browser as never)
    const done = item({ id: 'a', filename: 'report.pdf' })
    publish([done], done, 'done')
    expect(FakeNotification.shown).toHaveLength(0)

    const away = fakeWindow({ focused: false })
    const unfocused = fakeBrowser([away])
    new ElectronDownloadsShell(unfocused.browser as never)
    unfocused.publish([done], done, 'done')
    expect(FakeNotification.shown).toHaveLength(1)
    expect(FakeNotification.shown[0].options).toMatchObject({
      title: 'Download complete',
      body: 'report.pdf'
    })
    FakeNotification.shown[0].emit('click')
    expect(away.win.host.focus).toHaveBeenCalled()
    expect(away.win.send).toHaveBeenCalledWith('downloads.reveal', { id: 'a' })
  })

  it('holds the notification for a flagged file until Keep releases it', () => {
    const w = fakeWindow({ focused: false })
    const { browser, publish } = fakeBrowser([w])
    new ElectronDownloadsShell(browser as never)
    const flagged = item({
      id: 'a',
      danger: { level: 'dangerous', reason: 'executable', message: 'Harmful.' }
    })
    publish([flagged], flagged, 'done')
    expect(FakeNotification.shown).toHaveLength(0)
  })

  it('on macOS a finished file bounces the Downloads stack; the dock icon only in the background', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const dock = { downloadFinished: vi.fn(), setBadge: vi.fn(), bounce: vi.fn() }
    const electronApp = appEvents as unknown as { dock: typeof dock | undefined }
    electronApp.dock = dock
    try {
      const front = fakeWindow({ focused: true })
      const focused = fakeBrowser([front])
      new ElectronDownloadsShell(focused.browser as never)
      const done = item({ id: 'a', savePath: '/Users/me/Downloads/report.pdf' })
      focused.publish([done], done, 'done')
      expect(dock.downloadFinished).toHaveBeenCalledWith('/Users/me/Downloads/report.pdf')
      expect(dock.bounce).not.toHaveBeenCalled()

      const away = fakeWindow({ focused: false })
      const background = fakeBrowser([away])
      new ElectronDownloadsShell(background.browser as never)
      background.publish([done], done, 'done')
      expect(dock.downloadFinished).toHaveBeenCalledTimes(2)
      expect(dock.bounce).toHaveBeenCalledWith('informational')
      expect(dock.setBadge).toHaveBeenCalledWith('1')
      // A window coming to the front clears the badge.
      appEvents.emit('browser-window-focus')
      expect(dock.setBadge).toHaveBeenLastCalledWith('')
    } finally {
      electronApp.dock = undefined
      if (platform) Object.defineProperty(process, 'platform', platform)
    }
  })
})
