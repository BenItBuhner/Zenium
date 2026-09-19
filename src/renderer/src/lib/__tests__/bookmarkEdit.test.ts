import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIState } from '@shared/types'
import { cmd, run } from '../api'
import { closeBookmarkEditor, editBookmark } from '../bookmarkEdit'
import { onLayoutApplied, onViewDrawn, pageViewStore } from '../pageView'
import { browserStore, overlayCoversContent, uiStore } from '../ui'

vi.mock('../api', () => ({ cmd: vi.fn(), run: vi.fn(), onEvent: vi.fn(() => () => undefined) }))

/*
 * The bookmark editor is a sheet over the page (a `PhoneSheet` in the frame dialog host on a
 * phone, a frame dialog on desktop), so it opens in the order every surface over the page keeps:
 * the live page is captured first, and only then does its flag ask the host to hide the page –
 * a flag set with no picture in place has the host hide the page at once, with nothing to wait
 * for, and the sheet comes up over the window behind the page (the recede demo's editor step
 * measured the window gradient where the page was). On close the picture stays until the host
 * has drawn the page back, and the page gets the keyboard.
 */

const tab = { id: 't1', url: 'https://news.example/', title: 'News' }
const node = { id: 'b1', parentId: 'mobile', type: 'url', title: 'News', url: tab.url }

function android(): UIState {
  return {
    platform: 'android',
    tabs: { t1: tab },
    spaces: [{ id: 's1', activeTabId: 't1', tabIds: ['t1'] }],
    activeSpaceId: 's1',
    bookmarks: [node]
  } as unknown as UIState
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

let resolveCapture: ((data: string | null) => void) | null = null

beforeEach(() => {
  browserStore.set({ state: android() })
  pageViewStore.set({ phases: new Map(), lastApplied: null })
  uiStore.set({ snapshot: null, snapshotTabId: null, bookmarkEdit: null, overlay: 'none' })
  vi.mocked(cmd).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveCapture = resolve
      }) as never
  )
})

afterEach(() => {
  resolveCapture = null
  uiStore.set({ snapshot: null, snapshotTabId: null, bookmarkEdit: null, overlay: 'none' })
  browserStore.set({ state: null })
  vi.clearAllMocks()
})

describe('editBookmark', () => {
  it('captures the page first and asks for it to be hidden only once the picture is in place', async () => {
    editBookmark('b1')
    // The capture is in flight: the flag is not set, nothing asks the host to hide the page.
    expect(cmd).toHaveBeenCalledWith('overlay.snapshot', { tabId: 't1' })
    expect(uiStore.get().bookmarkEdit).toBeNull()
    expect(overlayCoversContent(uiStore.get())).toBe(false)
    await flush()
    expect(uiStore.get().bookmarkEdit).toBeNull()

    // The picture is there: now the editor's flag has the page views go under it.
    resolveCapture?.('data:image/jpeg;base64,AAAA')
    await flush()
    expect(uiStore.get().snapshotTabId).toBe('t1')
    expect(uiStore.get().bookmarkEdit).toEqual({ id: 'b1', parentId: 'mobile', type: 'url' })
    expect(overlayCoversContent(uiStore.get())).toBe(true)
    // The chrome takes the keyboard for the editor's fields.
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
  })

  it('a node the state has not caught up with still opens, filed in the default folder', async () => {
    editBookmark('b-not-yet')
    resolveCapture?.('data:image/jpeg;base64,AAAA')
    await flush()
    expect(uiStore.get().bookmarkEdit).toMatchObject({ id: 'b-not-yet', type: 'url' })
  })

  it('inside the bookmarks overlay the request is handled in place, over the overlay’s own picture', () => {
    uiStore.set({ overlay: 'bookmarks' })
    editBookmark('b1')
    expect(cmd).not.toHaveBeenCalled()
    expect(uiStore.get().bookmarkEdit).toEqual({ id: 'b1', parentId: 'mobile', type: 'url' })
  })
})

describe('closeBookmarkEditor', () => {
  it('lets the picture go once the host has drawn the page back, and hands the page the keyboard', async () => {
    editBookmark('b1')
    resolveCapture?.('data:image/jpeg;base64,AAAA')
    await flush()
    onLayoutApplied({ contentHidden: true, hid: ['t1'], shown: [] })
    onViewDrawn('t1', false)
    vi.mocked(run).mockClear()

    closeBookmarkEditor()
    expect(uiStore.get().bookmarkEdit).toBeNull()
    expect(overlayCoversContent(uiStore.get())).toBe(false)
    // The page is still down: its picture stays where it is.
    expect(uiStore.get().snapshot).not.toBeNull()
    onLayoutApplied({ contentHidden: false, hid: [], shown: ['t1'] })
    onViewDrawn('t1', true)
    expect(uiStore.get().snapshot).toBeNull()
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
  })

  it('with no editor up it is nothing', () => {
    closeBookmarkEditor()
    expect(run).not.toHaveBeenCalled()
  })
})
