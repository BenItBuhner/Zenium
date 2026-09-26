import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import type { KeyEventInput } from '../../../core/platform'
import { QUIT_HOLD_MS } from '../../../core/quitHold'
import { quitChord, release, settle, start } from '../../../core/__tests__/quitHoldFixture'
import type { KeyBinding } from '../../../shared/types'
import {
  type ChordKeyDown,
  type ChordKeyTarget,
  primeChromeForRelease,
  quitChordRepeat
} from '../quitHoldKeys'

/*
 * The chord's release under the hold's cover (the closing items on #486): the cover over a hung
 * page hides the view and the core moves the keyboard to the chrome, where Chromium drops a key
 * up while the widget's `suppress_events_until_keydown_` is set – measured: a short tap quit at
 * 1.5 s with the notice showing. The host puts one key down of the chord into the chrome's
 * widget as the cover engages, the auto-repeat the keyboard itself would have sent, which
 * clears the flag; the key table reads it as the hold's own repeat and consumes nothing.
 */

const MAC_QUIT: KeyBinding = { ctrl: false, alt: false, shift: false, meta: true, key: 'q' }
const LINUX_QUIT: KeyBinding = { ctrl: true, alt: false, shift: true, meta: false, key: 'q' }

/** The chrome's `WebContents` as the key needs it: what it was sent. */
function chrome(): ChordKeyTarget & {
  sendInputEvent: Mock<(event: ChordKeyDown) => void>
  sent: ChordKeyDown[]
} {
  const sent: ChordKeyDown[] = []
  return { sent, sendInputEvent: vi.fn((event: ChordKeyDown) => void sent.push(event)) }
}

/** The synthetic key as Electron hands it back to `before-input-event` on the chrome. */
function asInput(event: ChordKeyDown): KeyEventInput {
  return {
    type: 'keyDown',
    key: event.keyCode,
    control: event.modifiers.includes('control'),
    alt: event.modifiers.includes('alt'),
    shift: event.modifiers.includes('shift'),
    meta: event.modifiers.includes('meta'),
    isAutoRepeat: event.modifiers.includes('isautorepeat')
  }
}

describe('quitChordRepeat', () => {
  it('spells the chord as the key down its auto-repeat would be, for sendInputEvent', () => {
    expect(quitChordRepeat(MAC_QUIT)).toEqual({
      type: 'keyDown',
      keyCode: 'q',
      modifiers: ['meta', 'isautorepeat']
    })
    expect(quitChordRepeat(LINUX_QUIT)).toEqual({
      type: 'keyDown',
      keyCode: 'q',
      modifiers: ['control', 'shift', 'isautorepeat']
    })
  })

  it('names the keys Electron spells differently, and gives up on one it cannot spell', () => {
    expect(quitChordRepeat({ ...MAC_QUIT, key: 'ArrowLeft' })?.keyCode).toBe('Left')
    expect(quitChordRepeat({ ...MAC_QUIT, key: 'Enter' })?.keyCode).toBe('Return')
    expect(quitChordRepeat({ ...MAC_QUIT, key: ' ' })?.keyCode).toBe(' ')
    expect(quitChordRepeat({ ...MAC_QUIT, key: 'F12' })?.keyCode).toBe('F12')
    expect(quitChordRepeat({ ...MAC_QUIT, key: 'Dead' })).toBeNull()
    expect(quitChordRepeat(null)).toBeNull()
  })
})

describe('primeChromeForRelease', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('while a hold runs: one key down of the chord into the chrome, which the key table reads as the hold’s own repeat – unconsumed, the hold as it was – and the release that follows is heard', async () => {
    const { browser, platform, win } = start({ os: 'darwin' })
    browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win)
    const tabId = browser.tabs.activeTabFor(win)?.id ?? null
    // The chord goes down in the page (the hung page under the cover): the hold arms there.
    expect(browser.keys.handle(quitChord('darwin', 'keyDown'), tabId, win)).toBe(false)
    expect(browser.quitHold.holding).toBe(true)
    const hold = win.quitHold
    expect(hold).toEqual({ startedAt: Date.now(), durationMs: QUIT_HOLD_MS, chord: '⌘Q' })

    // The cover engages: the host primes the chrome's widget.
    const wc = chrome()
    vi.advanceTimersByTime(120)
    expect(primeChromeForRelease(wc, browser.quitHold, browser.state.shortcuts)).toBe(true)
    expect(wc.sendInputEvent).toHaveBeenCalledTimes(1)
    expect(wc.sent[0]).toEqual({
      type: 'keyDown',
      keyCode: 'q',
      modifiers: ['meta', 'isautorepeat']
    })

    // Electron runs the key table on the synthetic key synchronously, as on any key down of the
    // chrome's: the hold's repeat, left unconsumed (a consumed key down would set the very flag
    // the key is there to clear), and the running hold is the same hold.
    expect(browser.keys.handle(asInput(wc.sent[0]), null, win)).toBe(false)
    expect(browser.quitHold.holding).toBe(true)
    expect(win.quitHold).toBe(hold)

    // The tap's release, now heard in the chrome: the hold ends and nothing quits.
    vi.advanceTimersByTime(300)
    expect(browser.keys.handle(release('Meta'), null, win)).toBe(false)
    expect(browser.quitHold.holding).toBe(false)
    expect(win.quitHold).toBeNull()
    vi.advanceTimersByTime(QUIT_HOLD_MS)
    await settle()
    expect(platform.host.quits).toBe(0)
  })

  it('with no hold running nothing is sent: a chord key down with no finger on the keys would arm a hold nobody can release', () => {
    const { browser, win } = start({ os: 'darwin' })
    const wc = chrome()
    expect(browser.quitHold.holding).toBe(false)
    expect(primeChromeForRelease(wc, browser.quitHold, browser.state.shortcuts)).toBe(false)
    expect(wc.sendInputEvent).not.toHaveBeenCalled()
    expect(browser.quitHold.holding).toBe(false)
    expect(win.quitHold).toBeNull()
    // A hold that fired and is latched on its keys is not a running one either.
    expect(browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)).toBe(false)
    vi.advanceTimersByTime(QUIT_HOLD_MS)
    expect(browser.quitHold.holding).toBe(false)
    expect(browser.quitHold.engaged).toBe(true)
    expect(primeChromeForRelease(wc, browser.quitHold, browser.state.shortcuts)).toBe(false)
    expect(wc.sendInputEvent).not.toHaveBeenCalled()
  })

  it('an unbound chord has nothing to send', () => {
    const { browser, win } = start({ os: 'darwin' })
    expect(browser.keys.handle(quitChord('darwin', 'keyDown'), null, win)).toBe(false)
    expect(browser.quitHold.holding).toBe(true)
    const wc = chrome()
    const unbound = browser.state.shortcuts.map((shortcut) =>
      shortcut.action === 'app.quit' ? { ...shortcut, binding: null, extraBindings: [] } : shortcut
    )
    expect(primeChromeForRelease(wc, browser.quitHold, unbound)).toBe(false)
    expect(wc.sendInputEvent).not.toHaveBeenCalled()
  })
})
