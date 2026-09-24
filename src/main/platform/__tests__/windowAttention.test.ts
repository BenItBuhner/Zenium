import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { flashUntilFocused, type FlashableWindow } from '../windowAttention'

/** A `BrowserWindow` as the flash sees one: focus, liveness, and every `flashFrame` call. */
function fakeWindow(
  focused: boolean
): FlashableWindow & EventEmitter & { flashes: boolean[]; focused: boolean; destroyed: boolean } {
  const win = new EventEmitter() as FlashableWindow &
    EventEmitter & { flashes: boolean[]; focused: boolean; destroyed: boolean }
  win.flashes = []
  win.focused = focused
  win.destroyed = false
  win.isDestroyed = () => win.destroyed
  win.isFocused = () => win.focused
  win.flashFrame = (flag) => {
    win.flashes.push(flag)
  }
  return win
}

describe('flashUntilFocused (os-19: a page dialog in a background window)', () => {
  it('flashes a window that is not in front and stops the flash once it is focused', () => {
    const win = fakeWindow(false)
    expect(flashUntilFocused(win)).toBe(true)
    expect(win.flashes).toEqual([true])
    win.focused = true
    win.emit('focus')
    expect(win.flashes).toEqual([true, false])
    // Focus again later: nothing left listening.
    win.emit('focus')
    expect(win.flashes).toEqual([true, false])
    expect(win.listenerCount('focus')).toBe(0)
    expect(win.listenerCount('closed')).toBe(0)
  })

  it('leaves the focused window alone: its dialog is on screen or waiting for its tab', () => {
    const win = fakeWindow(true)
    expect(flashUntilFocused(win)).toBe(false)
    expect(win.flashes).toEqual([])
    expect(win.listenerCount('focus')).toBe(0)
  })

  it('one flash per window: a second dialog while it flashes adds nothing, and the focus ends both', () => {
    const win = fakeWindow(false)
    expect(flashUntilFocused(win)).toBe(true)
    expect(flashUntilFocused(win)).toBe(true)
    expect(win.flashes).toEqual([true])
    expect(win.listenerCount('focus')).toBe(1)
    win.emit('focus')
    expect(win.flashes).toEqual([true, false])
    // After the stop a new dialog flashes afresh.
    expect(flashUntilFocused(win)).toBe(true)
    expect(win.flashes).toEqual([true, false, true])
  })

  it('a window closing while it flashes is not touched again, and a destroyed one never flashes', () => {
    const win = fakeWindow(false)
    flashUntilFocused(win)
    win.destroyed = true
    win.emit('closed')
    expect(win.flashes).toEqual([true])
    expect(win.listenerCount('focus')).toBe(0)
    expect(flashUntilFocused(win)).toBe(false)
    expect(win.flashes).toEqual([true])
  })
})
