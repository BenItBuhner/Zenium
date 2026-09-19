import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIState } from '@shared/types'
import { cmd } from '../api'
import { onLayoutApplied, onViewDrawn, pageViewStore } from '../pageView'
import {
  browserStore,
  coverPageUnderSheet as takeCover,
  overlayCoversContent,
  uiStore,
  type SheetCover
} from '../ui'

vi.mock('../api', () => ({ cmd: vi.fn(), run: vi.fn(), onEvent: vi.fn(() => () => undefined) }))

/*
 * The cover a FrameDialogHost sheet takes for the page on a phone (lib/ui.ts,
 * `coverPageUnderSheet`), in the order every other surface keeps: capture the live page, then
 * ask the host to hide it, then wait for the host to have it down before the sheet rises; on
 * the way out the page comes back only once the sheet has landed, and its picture goes only
 * once the host has drawn the page again. The dialogs the host mounts set their own flags
 * later and drop them sooner; the sheet's own flag is what keeps the sequence.
 */

const tab = { id: 't1', url: 'https://news.example/' }

function android(): UIState {
  return {
    platform: 'android',
    tabs: { t1: tab },
    spaces: [{ id: 's1', activeTabId: 't1', tabIds: ['t1'] }],
    activeSpaceId: 's1'
  } as unknown as UIState
}

/** Whether a promise has resolved by the time every microtask has run (a macrotask later). */
async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false
  void promise.then(() => {
    done = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  return done
}

let resolveCapture: ((data: string | null) => void) | null = null
/** Every cover a test took: released after it, so a failed test leaves no count behind. */
let covers: SheetCover[] = []
const coverPageUnderSheet = (): SheetCover => {
  const cover = takeCover()
  covers.push(cover)
  return cover
}

beforeEach(() => {
  browserStore.set({ state: android() })
  pageViewStore.set({ phases: new Map(), lastApplied: null })
  uiStore.set({ snapshot: null, snapshotTabId: null, frameSheetOpen: false })
  vi.mocked(cmd).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveCapture = resolve
      }) as never
  )
})

afterEach(() => {
  for (const cover of covers) cover.release()
  covers = []
  resolveCapture = null
  browserStore.set({ state: null })
  vi.clearAllMocks()
})

describe('coverPageUnderSheet', () => {
  it('captures first, hides second, and resolves only once the host has the page view down', async () => {
    const cover = coverPageUnderSheet()
    // The capture is in flight: nothing has asked the host for anything yet.
    expect(cmd).toHaveBeenCalledWith('overlay.snapshot', { tabId: 't1' })
    expect(uiStore.get().frameSheetOpen).toBe(false)
    expect(overlayCoversContent(uiStore.get())).toBe(false)
    expect(await settled(cover.promise)).toBe(false)

    // The picture is there: now the sheet asks for the page views to go, and still waits.
    resolveCapture?.('data:image/jpeg;base64,AAAA')
    expect(await settled(cover.promise)).toBe(false)
    expect(uiStore.get().snapshotTabId).toBe('t1')
    expect(uiStore.get().frameSheetOpen).toBe(true)
    expect(overlayCoversContent(uiStore.get())).toBe(true)

    // The core placed the layout (the view on its way down): not yet.
    onLayoutApplied({ contentHidden: true, hid: ['t1'], shown: [] })
    expect(await settled(cover.promise)).toBe(false)
    // The host drew the frame without it: the sheet may rise.
    onViewDrawn('t1', false)
    expect(await settled(cover.promise)).toBe(true)

    // The sheet landed: the page may come back; its picture stays until the host has drawn it.
    cover.release()
    expect(uiStore.get().frameSheetOpen).toBe(false)
    expect(uiStore.get().snapshot).not.toBeNull()
    onLayoutApplied({ contentHidden: false, hid: [], shown: ['t1'] })
    expect(uiStore.get().snapshot).not.toBeNull()
    onViewDrawn('t1', true)
    expect(uiStore.get().snapshot).toBeNull()
  })

  it('released during the capture never asks the host for anything', async () => {
    const cover = coverPageUnderSheet()
    cover.release()
    resolveCapture?.('data:image/jpeg;base64,AAAA')
    await settled(cover.promise)
    expect(uiStore.get().frameSheetOpen).toBe(false)
  })

  it('resolves at once with the page already under another sheet, and a second release is nothing', async () => {
    uiStore.set({ snapshot: 'data:image/jpeg;base64,AAAA', snapshotTabId: 't1' })
    onLayoutApplied({ contentHidden: true, hid: ['t1'], shown: [] })
    onViewDrawn('t1', false)
    const cover = coverPageUnderSheet()
    expect(cmd).not.toHaveBeenCalled()
    expect(await settled(cover.promise)).toBe(true)
    expect(uiStore.get().frameSheetOpen).toBe(true)
    cover.release()
    cover.release()
    expect(uiStore.get().frameSheetOpen).toBe(false)
  })

  it('two sheets holding the page keep it hidden until the last one lets go', async () => {
    uiStore.set({ snapshot: 'data:image/jpeg;base64,AAAA', snapshotTabId: 't1' })
    const first = coverPageUnderSheet()
    const second = coverPageUnderSheet()
    await settled(first.promise)
    await settled(second.promise)
    expect(uiStore.get().frameSheetOpen).toBe(true)
    first.release()
    expect(uiStore.get().frameSheetOpen).toBe(true)
    second.release()
    expect(uiStore.get().frameSheetOpen).toBe(false)
  })

  it('a desktop host, whose overlay is painted before a view goes, waits for nothing', async () => {
    browserStore.set({ state: { ...android(), platform: 'linux' } as UIState })
    uiStore.set({ snapshot: 'data:image/jpeg;base64,AAAA', snapshotTabId: 't1' })
    const cover = coverPageUnderSheet()
    expect(await settled(cover.promise)).toBe(true)
    cover.release()
  })

  it('with no session yet the sheet still holds its flag, and waits for nothing', async () => {
    browserStore.set({ state: null })
    const cover = coverPageUnderSheet()
    expect(cmd).not.toHaveBeenCalled()
    expect(await settled(cover.promise)).toBe(true)
    expect(uiStore.get().frameSheetOpen).toBe(true)
    cover.release()
    expect(uiStore.get().frameSheetOpen).toBe(false)
  })
})
