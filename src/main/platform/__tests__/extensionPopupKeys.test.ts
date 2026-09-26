import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeyEventInput } from '../../../core/platform'
import { QUIT_HOLD_MS } from '../../../core/quitHold'
import { quitChord, release, settle, start } from '../../../core/__tests__/quitHoldFixture'
import type { ZenWindow } from '../../../core/window'
import { popupKey, type PopupKeyHost, type PopupKeyInput } from '../extensionPopupKeys'

/*
 * A browser-action popup's keys (review F3 on session-08): the popup's document holds the
 * keyboard while it is open, and its `before-input-event` handled Escape alone – the quit
 * chord pressed over a popup went unhandled to the menu bar's Quit role and quit at once, the
 * one path past the hold with Warn Before Quitting on. The router sends every key but Escape
 * through the owning window's key table, as the chrome's own keys go.
 */

/** The router wired to a real browser's key table for `win`, as `openPopup` wires it. */
function popupOn(
  browser: { keys: { handle(input: KeyEventInput, tabId: null, win: ZenWindow): boolean } },
  win: ZenWindow
): { key: (input: PopupKeyInput) => boolean; closed: number } {
  const state = { closed: 0 }
  const host: PopupKeyHost = {
    close: () => void state.closed++,
    handle: (input) => browser.keys.handle(input, null, win)
  }
  return {
    key: (input) => popupKey(input, host),
    get closed() {
      return state.closed
    }
  }
}

describe('a key in an extension popup', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('the quit chord over a popup is held, not quit: its key down arms the hold in the popup’s window and is left unconsumed, its key up releases it', async () => {
    const { browser, platform, win } = start({ os: 'darwin' })
    browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win)
    const requestQuit = vi.spyOn(browser, 'requestQuit')
    const popup = popupOn(browser, win)
    expect(popup.key(quitChord('darwin', 'keyDown'))).toBe(false)
    expect(browser.quitHold.holding).toBe(true)
    expect(win.quitHold).toEqual({ startedAt: Date.now(), durationMs: QUIT_HOLD_MS, chord: '⌘Q' })
    // The unconsumed chord reaches the menu bar's Quit role on macOS: its request is refused.
    await expect(browser.requestQuit()).resolves.toBe(false)
    expect(platform.host.quits).toBe(0)
    // A repeat is the same hold; the key up ends it and nothing quits.
    expect(popup.key(quitChord('darwin', 'keyDown', true))).toBe(false)
    vi.advanceTimersByTime(QUIT_HOLD_MS - 100)
    expect(popup.key(release('q'))).toBe(false)
    expect(browser.quitHold.holding).toBe(false)
    expect(win.quitHold).toBeNull()
    vi.advanceTimersByTime(QUIT_HOLD_MS)
    await settle()
    // The role's refused request is the only one: the hold itself asked for nothing.
    expect(requestQuit).toHaveBeenCalledTimes(1)
    expect(requestQuit).toHaveBeenCalledWith()
    expect(platform.host.quits).toBe(0)
    expect(popup.closed).toBe(0)
  })

  it('the chord held over a popup for the whole hold quits, confirmed by the hold', async () => {
    const { browser, platform, win } = start({ os: 'darwin' })
    browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win)
    browser.tabs.createTab({ url: 'https://example.com/b', active: false }, win)
    const requestQuit = vi.spyOn(browser, 'requestQuit')
    const popup = popupOn(browser, win)
    popup.key(quitChord('darwin', 'keyDown'))
    vi.advanceTimersByTime(QUIT_HOLD_MS)
    expect(requestQuit).toHaveBeenCalledWith(win, { held: true })
    await expect(requestQuit.mock.results[0]?.value).resolves.toBe(true)
    // No tab-count question: the hold was the confirmation.
    expect(win.prompt).toBeNull()
    expect(platform.host.quits).toBe(1)
  })

  it('with Warn Before Quitting off the chord quits at once from a popup, consumed as the chrome’s is', () => {
    const { browser, win } = start({ os: 'darwin' })
    browser.setWarnBeforeQuitting(false)
    const requestQuit = vi.spyOn(browser, 'requestQuit').mockResolvedValue(true)
    const popup = popupOn(browser, win)
    expect(popup.key(quitChord('darwin', 'keyDown'))).toBe(true)
    expect(browser.quitHold.holding).toBe(false)
    expect(requestQuit).toHaveBeenCalledTimes(1)
  })

  it('Escape’s key down closes the popup and is consumed; nothing else of it reaches the table', () => {
    const { browser, win } = start({ os: 'darwin' })
    const handle = vi.spyOn(browser.keys, 'handle')
    const popup = popupOn(browser, win)
    expect(popup.key({ ...release('Escape'), type: 'keyDown' })).toBe(true)
    expect(popup.closed).toBe(1)
    expect(handle).not.toHaveBeenCalled()
    // Its key up, should Chromium deliver one, is a key up like any other.
    expect(popup.key(release('Escape'))).toBe(false)
    expect(handle).toHaveBeenCalledTimes(1)
  })

  it('a Zenium shortcut runs from a popup as from the toolbar, and is consumed', () => {
    const { browser, win } = start({ os: 'darwin' })
    const run = vi.spyOn(browser.actions, 'run').mockImplementation(() => undefined)
    const popup = popupOn(browser, win)
    const newTab: PopupKeyInput = {
      type: 'keyDown',
      key: 't',
      control: false,
      alt: false,
      shift: false,
      meta: true,
      isAutoRepeat: false
    }
    expect(popup.key(newTab)).toBe(true)
    expect(run).toHaveBeenCalledWith('tab.new', { sourceTabId: null, win })
    // A plain letter is the document's own.
    expect(popup.key({ ...newTab, meta: false })).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
