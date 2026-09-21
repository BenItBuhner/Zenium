import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuDescriptor } from '@shared/types'
import { cmd } from '../api'
import { MENU_PRESS_CAPTURE_TTL_MS, closeMenu, prepareMenu, showMenu, uiStore } from '../ui'

vi.mock('../api', () => ({ cmd: vi.fn(), run: vi.fn(), onEvent: vi.fn(() => () => undefined) }))

/*
 * The page's picture is taken as the finger lands on the menu button (`prepareMenu`, the bar
 * item's `press`), not after the tap's round trip through the core: the sheet comes up over a
 * capture already in place or in flight (PERF-2, PR #269: on the profile's emulator the
 * capture was 530 to 860 ms of the click → sheet time). `showMenu` joins that capture instead
 * of starting a second; a press that never becomes the tap leaves nothing behind for long.
 */

const menu: MenuDescriptor = { id: 'm1', source: 'app', items: [], x: null, y: null }

let resolveCapture: ((data: string | null) => void) | null = null
let captures = 0

beforeEach(() => {
  vi.useFakeTimers()
  captures = 0
  uiStore.set({ snapshot: null, snapshotTabId: null, menu: null })
  vi.mocked(cmd).mockImplementation(
    () =>
      new Promise((resolve) => {
        captures++
        resolveCapture = resolve
      }) as never
  )
})

afterEach(() => {
  closeMenu(false)
  uiStore.set({ snapshot: null, snapshotTabId: null })
  resolveCapture = null
  vi.clearAllMocks()
  vi.useRealTimers()
})

/** Let the capture's promise chain run (fake timers leave microtasks to us). */
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

describe('prepareMenu', () => {
  it('captures the page on the press; the open that follows joins the capture and shows the menu over it', async () => {
    prepareMenu('t1')
    expect(cmd).toHaveBeenCalledWith('overlay.snapshot', { tabId: 't1' })
    expect(captures).toBe(1)

    // The tap's round trip comes back while the capture is still in flight: one capture.
    const open = showMenu(menu, 't1')
    await flush()
    expect(captures).toBe(1)
    expect(uiStore.get().menu).toBeNull()

    resolveCapture?.('data:image/jpeg;base64,AAAA')
    await open
    expect(uiStore.get().snapshotTabId).toBe('t1')
    expect(uiStore.get().menu).toEqual(menu)
  })

  it('a capture already in place from the press lets the open go up in the same turn', async () => {
    prepareMenu('t1')
    resolveCapture?.('data:image/jpeg;base64,AAAA')
    await flush()
    expect(uiStore.get().snapshot).not.toBeNull()

    await showMenu(menu, 't1')
    expect(captures).toBe(1)
    expect(uiStore.get().menu).toEqual(menu)
  })

  it('a press that never becomes the tap drops its capture after the TTL', async () => {
    prepareMenu('t1')
    resolveCapture?.('data:image/jpeg;base64,AAAA')
    await flush()
    expect(uiStore.get().snapshot).not.toBeNull()

    await vi.advanceTimersByTimeAsync(MENU_PRESS_CAPTURE_TTL_MS - 1)
    expect(uiStore.get().snapshot).not.toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(uiStore.get().snapshot).toBeNull()
    expect(uiStore.get().snapshotTabId).toBeNull()
  })

  it('the TTL never takes the picture from under a menu that is up', async () => {
    prepareMenu('t1')
    resolveCapture?.('data:image/jpeg;base64,AAAA')
    await flush()
    await showMenu(menu, 't1')

    await vi.advanceTimersByTimeAsync(MENU_PRESS_CAPTURE_TTL_MS + 1)
    expect(uiStore.get().menu).toEqual(menu)
    expect(uiStore.get().snapshot).not.toBeNull()
  })

  it('with no active tab there is nothing to capture', () => {
    prepareMenu(null)
    expect(cmd).not.toHaveBeenCalled()
  })
})
