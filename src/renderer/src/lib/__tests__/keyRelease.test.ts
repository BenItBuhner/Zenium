// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KEY_RELEASE_TIMEOUT_MS, afterKeyRelease } from '../keyRelease'

describe('afterKeyRelease', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs once the key comes up, and only then', () => {
    const fn = vi.fn()
    afterKeyRelease(fn, window)
    expect(fn).not.toHaveBeenCalled()
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' }))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('runs once even when the release is followed by the timeout', () => {
    const fn = vi.fn()
    afterKeyRelease(fn, window)
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' }))
    vi.advanceTimersByTime(KEY_RELEASE_TIMEOUT_MS + 10)
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' }))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('runs after the timeout when the release goes elsewhere', () => {
    const fn = vi.fn()
    afterKeyRelease(fn, window, 200)
    vi.advanceTimersByTime(199)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('listens in the capture phase, ahead of a handler that stops the event', () => {
    const fn = vi.fn()
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.addEventListener('keyup', (e) => e.stopPropagation())
    afterKeyRelease(fn, window)
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }))
    expect(fn).toHaveBeenCalledTimes(1)
    input.remove()
  })
})
