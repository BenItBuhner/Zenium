// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({ cmd: vi.fn(), run: vi.fn(), onEvent: vi.fn(() => () => undefined) }))

import { cmd, run } from '../api'
import {
  chromeNeedsKeyboard,
  closeReaderPreferences,
  openReaderPreferences,
  overlayCoversContent,
  panelAloneOverContent,
  readerPreferencesChanged,
  uiStore,
  type UiState
} from '../ui'

/*
 * Reader View's text preferences over the page (lib/ui.ts): the surface comes up over a picture
 * of the reader page as the zoom bubble does, takes the keyboard, hangs from the pill's chip on
 * a mouse – the chip pressed, or the one a request from the app menu finds on screen (the
 * reader tab never hides it, §9.29) –, stays as it is on a second request for the same tab, and
 * has the page's picture taken again once a preference has been pushed to it.
 */

const idle = (): UiState => uiStore.get()

/** An element drawn at `box` (happy-dom lays nothing out: the two rect readers are given). */
function drawn(
  el: HTMLElement,
  box: { x: number; y: number; width: number; height: number }
): void {
  const rect = {
    ...box,
    top: box.y,
    left: box.x,
    right: box.x + box.width,
    bottom: box.y + box.height
  }
  el.getBoundingClientRect = () => rect as DOMRect
  el.getClientRects = () => [rect] as unknown as DOMRectList
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(cmd).mockResolvedValue('data:image/jpeg;base64,AAAA' as never)
})

afterEach(() => {
  uiStore.set({ readerPreferences: null, snapshot: null, snapshotTabId: null, overlay: 'none' })
  document.body.innerHTML = ''
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('the reader text preferences surface', () => {
  it('captures the page, takes the keyboard and remembers the chip it hangs from', async () => {
    await openReaderPreferences('t1', { x: 10, y: 20, width: 30, height: 40 })
    expect(cmd).toHaveBeenCalledWith('overlay.snapshot', { tabId: 't1' })
    expect(run).toHaveBeenCalledWith('focus.chrome', undefined)
    expect(idle().readerPreferences).toEqual({
      tabId: 't1',
      anchor: { x: 10, y: 20, width: 30, height: 40 },
      bar: null
    })
    expect(idle().snapshotTabId).toBe('t1')
    // A DOMRect from the chip carries more than the four numbers: only those are kept.
    closeReaderPreferences()
    const rect = { x: 1, y: 2, width: 3, height: 4, top: 2, left: 1, right: 4, bottom: 6 }
    await openReaderPreferences('t1', rect as DOMRect)
    expect(idle().readerPreferences?.anchor).toEqual({ x: 1, y: 2, width: 3, height: 4 })
  })

  it('a request from the app menu hangs from the chip on screen, in its pill (§9.29: the reader tab never hides it)', async () => {
    document.body.innerHTML = '<div class="zen-pill"><button data-reader-prefs-chip></button></div>'
    drawn(document.querySelector('.zen-pill')!, { x: 100, y: 42, width: 70, height: 32 })
    drawn(document.querySelector('[data-reader-prefs-chip]')!, {
      x: 142,
      y: 48,
      width: 20,
      height: 20
    })
    await openReaderPreferences('t1')
    expect(idle().readerPreferences).toEqual({
      tabId: 't1',
      anchor: { x: 142, y: 48, width: 20, height: 20 },
      bar: { x: 100, y: 42, width: 70, height: 32 }
    })
  })

  it('hangs under the frame top with no chip on screen (compact mode, a phone)', async () => {
    // A chip in the document with no box is not on screen either.
    document.body.innerHTML = '<button data-reader-prefs-chip></button>'
    const chip = document.querySelector<HTMLElement>('[data-reader-prefs-chip]')!
    chip.getClientRects = () => [] as unknown as DOMRectList
    await openReaderPreferences('t1')
    expect(idle().readerPreferences).toEqual({ tabId: 't1', anchor: null, bar: null })
  })

  it('is a lone panel over the page that holds the keyboard, and not over Settings', async () => {
    expect(chromeNeedsKeyboard()).toBe(false)
    expect(overlayCoversContent(idle())).toBe(false)
    await openReaderPreferences('t1')
    expect(chromeNeedsKeyboard()).toBe(true)
    // The live view gives way to the page's picture under the surface, as under the zoom
    // bubble; the surface draws no dim of its own (§9.5), so the picture shows undimmed.
    expect(overlayCoversContent(idle())).toBe(true)
    expect(panelAloneOverContent(idle())).toBe(true)
    // Over Settings the popover is not alone: the overlay dims.
    uiStore.set({ overlay: 'settings' })
    expect(panelAloneOverContent(idle())).toBe(false)
  })

  it('draws no scrim while one of its menulists is open (the list is floating chrome, not a dialog)', async () => {
    await openReaderPreferences('t1')
    // The font or theme menulist's list counts in `floatingChrome` while it is down (§9.13); a
    // popover with its menu open is still panels alone over the page (§9.5, §9.20: no scrim).
    uiStore.set((s) => ({ floatingChrome: s.floatingChrome + 1 }))
    expect(overlayCoversContent(idle())).toBe(true)
    expect(panelAloneOverContent(idle())).toBe(true)
    uiStore.set((s) => ({ floatingChrome: s.floatingChrome - 1 }))
    expect(panelAloneOverContent(idle())).toBe(true)
  })

  it('leaves the surface as it is on a second request for the same tab', async () => {
    await openReaderPreferences('t1', { x: 1, y: 1, width: 1, height: 1 })
    vi.mocked(cmd).mockClear()
    vi.mocked(run).mockClear()
    await openReaderPreferences('t1', { x: 9, y: 9, width: 9, height: 9 })
    expect(cmd).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(idle().readerPreferences?.anchor).toEqual({ x: 1, y: 1, width: 1, height: 1 })
  })

  it('gives the keyboard back to the page on close unless Escape keeps it in the chrome', async () => {
    await openReaderPreferences('t1')
    vi.mocked(run).mockClear()
    closeReaderPreferences()
    expect(idle().readerPreferences).toBeNull()
    expect(run).toHaveBeenCalledWith('focus.content', undefined)
    // The picture goes with the surface: nothing else holds it.
    expect(idle().snapshot).toBeNull()

    vi.mocked(run).mockClear()
    closeReaderPreferences()
    expect(run).not.toHaveBeenCalled()

    await openReaderPreferences('t1')
    vi.mocked(run).mockClear()
    closeReaderPreferences({ keepFocus: true })
    expect(run).not.toHaveBeenCalledWith('focus.content', undefined)
  })

  it('takes a fresh picture after a preference has reached the page, for the open tab alone', async () => {
    await openReaderPreferences('t1')
    vi.mocked(cmd).mockClear()
    readerPreferencesChanged('t1')
    expect(cmd).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(cmd).toHaveBeenCalledWith('overlay.snapshot', { tabId: 't1', fresh: true })

    vi.mocked(cmd).mockClear()
    readerPreferencesChanged('t2')
    await vi.advanceTimersByTimeAsync(200)
    expect(cmd).not.toHaveBeenCalled()

    // The surface went away before the page had repainted: no picture is taken for it.
    readerPreferencesChanged('t1')
    closeReaderPreferences()
    vi.mocked(cmd).mockClear()
    await vi.advanceTimersByTimeAsync(200)
    expect(cmd).not.toHaveBeenCalled()
  })
})
