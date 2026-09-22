import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LongCapture } from '@shared/types'

vi.mock('@renderer/lib/api', () => ({
  cmd: vi.fn(async () => null),
  run: vi.fn(),
  onEvent: vi.fn(() => () => undefined)
}))

import { cmd, run } from '@renderer/lib/api'
import {
  closeLongScreenshot,
  longScreenshotCapturing,
  openLongScreenshot,
  saveLongScreenshot,
  uiStore
} from '@renderer/lib/ui'

/** One host capture the test answers when it chooses to. */
function pendingCapture(): {
  resolve: (capture: LongCapture | null) => void
  promise: Promise<LongCapture | null>
} {
  let resolve!: (capture: LongCapture | null) => void
  const promise = new Promise<LongCapture | null>((r) => {
    resolve = r
  })
  return { resolve, promise }
}

const capture = (id: string): LongCapture => ({
  id,
  preview: 'data:image/jpeg;base64,',
  width: 700,
  height: 4676,
  viewportHeight: 1366
})

/** Every `screenshot.captureLong` the store asked the host for, in order. */
function captureRequests(): number {
  return vi.mocked(cmd).mock.calls.filter(([name]) => name === 'screenshot.captureLong').length
}

/** The promise chain behind a host answer has run: a macrotask later. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  vi.mocked(cmd).mockReset()
  vi.mocked(run).mockReset()
  uiStore.set({ longScreenshot: null, toasts: [], screenshotCards: [] })
})
afterEach(() => {
  closeLongScreenshot()
})

/**
 * SH-08's order on Android: the host copies the page out of the window, and the chrome lies
 * under the pages – a sheet over the page has the page hidden. So the editor mounts only once
 * the picture is in hand; while the host stitches, nothing covers the page.
 */
describe('openLongScreenshot', () => {
  it('asks the host for the page first and mounts the editor with the picture', async () => {
    const host = pendingCapture()
    vi.mocked(cmd).mockReturnValueOnce(host.promise as never)
    openLongScreenshot('tab-1')
    expect(captureRequests()).toBe(1)
    expect(uiStore.get().longScreenshot).toBeNull()
    expect(longScreenshotCapturing()).toBe(true)

    host.resolve(capture('long-1'))
    await flush()
    expect(longScreenshotCapturing()).toBe(false)
    expect(uiStore.get().longScreenshot).toMatchObject({
      tabId: 'tab-1',
      busy: false,
      capture: { id: 'long-1', height: 4676 }
    })
  })

  it('a page the host could not capture is a toast, and no editor', async () => {
    vi.mocked(cmd).mockResolvedValueOnce(null as never)
    openLongScreenshot('tab-1')
    await flush()
    expect(uiStore.get().longScreenshot).toBeNull()
    expect(longScreenshotCapturing()).toBe(false)
    expect(uiStore.get().toasts.map((t) => [t.message, t.kind])).toEqual([
      ['Could not capture the page', 'error']
    ])
  })

  it('a host that fails the call is the same toast', async () => {
    vi.mocked(cmd).mockRejectedValueOnce(new Error('no page'))
    openLongScreenshot('tab-1')
    await flush()
    expect(uiStore.get().longScreenshot).toBeNull()
    expect(uiStore.get().toasts.map((t) => t.message)).toEqual(['Could not capture the page'])
  })

  it('a request closed while the page was being stitched lets the host drop its copy', async () => {
    const host = pendingCapture()
    vi.mocked(cmd).mockReturnValueOnce(host.promise as never)
    openLongScreenshot('tab-1')
    closeLongScreenshot()
    expect(longScreenshotCapturing()).toBe(false)

    host.resolve(capture('long-1'))
    await flush()
    expect(uiStore.get().longScreenshot).toBeNull()
    expect(run).toHaveBeenCalledWith('screenshot.discardLong', { id: 'long-1' })
  })

  it('the newest request wins: the older capture is dropped when it arrives', async () => {
    const first = pendingCapture()
    const second = pendingCapture()
    vi.mocked(cmd)
      .mockReturnValueOnce(first.promise as never)
      .mockReturnValueOnce(second.promise as never)
    openLongScreenshot('tab-1')
    openLongScreenshot('tab-2')
    expect(captureRequests()).toBe(2)

    second.resolve(capture('long-2'))
    await flush()
    expect(uiStore.get().longScreenshot).toMatchObject({
      tabId: 'tab-2',
      capture: { id: 'long-2' }
    })

    first.resolve(capture('long-1'))
    await flush()
    expect(uiStore.get().longScreenshot).toMatchObject({
      tabId: 'tab-2',
      capture: { id: 'long-2' }
    })
    expect(run).toHaveBeenCalledWith('screenshot.discardLong', { id: 'long-1' })
  })

  it('Save takes the editor down and the crop goes to the host as the picture rows', async () => {
    vi.mocked(cmd).mockResolvedValueOnce(capture('long-1') as never)
    openLongScreenshot('tab-1')
    await flush()
    expect(uiStore.get().longScreenshot).not.toBeNull()

    vi.mocked(cmd).mockResolvedValueOnce({
      uri: 'content://media/1',
      thumbnail: 'data:image/jpeg;base64,',
      width: 700,
      height: 761,
      bytes: 3826
    } as never)
    await saveLongScreenshot({ top: 0, bottom: 761 }, false)
    expect(cmd).toHaveBeenCalledWith('screenshot.saveLong', {
      id: 'long-1',
      crop: { top: 0, bottom: 761 },
      share: false
    })
    expect(uiStore.get().longScreenshot).toBeNull()
    expect(uiStore.get().screenshotCards).toHaveLength(1)
    expect(uiStore.get().screenshotCards[0]).toMatchObject({
      tabId: 'tab-1',
      long: true,
      height: 761
    })
  })
})
