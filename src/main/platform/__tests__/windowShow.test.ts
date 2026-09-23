import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { READY_TO_SHOW_FALLBACK_MS, showWhenReady, type ShowableWindow } from '../windowShow'

/** A `BrowserWindow` as the fallback sees one: events, liveness, visibility and `show()`. */
function fakeWindow(): ShowableWindow & EventEmitter & { shows: number; destroyed: boolean } {
  const win = new EventEmitter() as ShowableWindow &
    EventEmitter & { shows: number; destroyed: boolean; visible: boolean }
  win.shows = 0
  win.destroyed = false
  win.visible = false
  win.isDestroyed = () => win.destroyed
  win.isVisible = () => win.visible
  win.show = () => {
    win.shows++
    win.visible = true
  }
  return win
}

describe('showWhenReady', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the window from ready-to-show and lets the fallback timer go', () => {
    const win = fakeWindow()
    const warn = vi.fn()
    showWhenReady(win, { warn })
    vi.advanceTimersByTime(400)
    win.emit('ready-to-show')
    expect(win.shows).toBe(1)
    vi.advanceTimersByTime(READY_TO_SHOW_FALLBACK_MS * 2)
    expect(win.shows).toBe(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('shows the window after the bounded wait when ready-to-show never fires, and says so once with the elapsed time', () => {
    const win = fakeWindow()
    const warn = vi.fn()
    let clock = 10_000
    showWhenReady(win, { warn, now: () => clock })
    vi.advanceTimersByTime(READY_TO_SHOW_FALLBACK_MS - 1)
    expect(win.shows).toBe(0)
    clock += READY_TO_SHOW_FALLBACK_MS + 7
    vi.advanceTimersByTime(1)
    expect(win.shows).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain(`within ${READY_TO_SHOW_FALLBACK_MS} ms`)
    expect(warn.mock.calls[0][0]).toContain(`${READY_TO_SHOW_FALLBACK_MS + 7} ms elapsed`)
    // The event arriving late is not a second show.
    win.emit('ready-to-show')
    vi.advanceTimersByTime(READY_TO_SHOW_FALLBACK_MS * 2)
    expect(win.shows).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('takes the wait from the caller', () => {
    const win = fakeWindow()
    showWhenReady(win, { timeoutMs: 100, warn: () => undefined })
    vi.advanceTimersByTime(99)
    expect(win.shows).toBe(0)
    vi.advanceTimersByTime(1)
    expect(win.shows).toBe(1)
  })

  it('leaves a window alone that was closed or destroyed before either came', () => {
    const closed = fakeWindow()
    const warn = vi.fn()
    showWhenReady(closed, { warn })
    closed.emit('closed')
    vi.advanceTimersByTime(READY_TO_SHOW_FALLBACK_MS * 2)
    closed.emit('ready-to-show')
    expect(closed.shows).toBe(0)

    const destroyed = fakeWindow()
    showWhenReady(destroyed, { warn })
    destroyed.destroyed = true
    vi.advanceTimersByTime(READY_TO_SHOW_FALLBACK_MS * 2)
    expect(destroyed.shows).toBe(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not show (or warn about) a window something else put on screen meanwhile', () => {
    const win = fakeWindow()
    const warn = vi.fn()
    showWhenReady(win, { warn })
    // The core showed it for a launch argument before the chrome painted.
    win.show()
    vi.advanceTimersByTime(READY_TO_SHOW_FALLBACK_MS * 2)
    expect(win.shows).toBe(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('the returned cancel stops the fallback without touching the event path', () => {
    const win = fakeWindow()
    const cancel = showWhenReady(win, { warn: () => undefined })
    cancel()
    vi.advanceTimersByTime(READY_TO_SHOW_FALLBACK_MS * 2)
    expect(win.shows).toBe(0)
    win.emit('ready-to-show')
    expect(win.shows).toBe(1)
  })
})
