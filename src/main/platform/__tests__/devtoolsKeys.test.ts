// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUIT_HOLD_MS } from '../../../core/quitHold'
import { quitChord, settle, start } from '../../../core/__tests__/quitHoldFixture'
import type { KeyEventInput } from '../../../core/platform'
import type { KeyBinding, Shortcut } from '../../../shared/types'
import {
  DEVTOOLS_KEY_MESSAGE_PREFIX,
  type DevtoolsFrontendLike,
  devtoolsKeyFromMessage,
  devtoolsQuitChordScript,
  quitChordOf,
  relayDevtoolsQuitChord
} from '../devtoolsKeys'

/*
 * The quit chord typed into a DevTools toolbox (session-08, review F3's DevTools path). The
 * frontend's keys raise `before-input-event` on nothing – Electron's `InspectableWebContents`
 * is the frontend's delegate and forwards only the keys the frontend left unhandled, to the
 * menu bar – so with the toolbox focused the chord went to the Quit role as a plain quit, no
 * hold armed (measured on the Linux stand-in; `devtoolsKeys.ts`). The frontend script consumes
 * the chord's key down and says it on the console, says the next key up (or the window's blur
 * while the chord is down) the same way, and the host reads each line into the key table for the
 * inspected page's window, as the page's own keys go.
 */

const MAC_QUIT: KeyBinding = { ctrl: false, alt: false, shift: false, meta: true, key: 'q' }
const LINUX_QUIT: KeyBinding = { ctrl: true, alt: false, shift: true, meta: false, key: 'q' }

/**
 * The frontend script run in this document (one hook for the file, as one frontend has one; each
 * run re-reads the chord), its console lines collected from the run on.
 */
function frontend(chord: KeyBinding | null): {
  said: () => string[]
  keys: () => ReturnType<typeof devtoolsKeyFromMessage>[]
  rerun: (chord: KeyBinding | null) => unknown
  ran: unknown
} {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(' ')
    if (line.startsWith(DEVTOOLS_KEY_MESSAGE_PREFIX)) lines.push(line)
  })
  const run = (c: KeyBinding | null): unknown =>
    new Function(`return ${devtoolsQuitChordScript(c)}`)()
  const ran = run(chord)
  return {
    said: () => lines,
    keys: () => lines.map((line) => devtoolsKeyFromMessage(line)),
    rerun: run,
    ran
  }
}

function press(
  type: 'keydown' | 'keyup',
  key: string,
  modifiers: Partial<
    Pick<KeyboardEventInit, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'repeat'>
  > = {}
): KeyboardEvent {
  const event = new KeyboardEvent(type, { key, cancelable: true, bubbles: true, ...modifiers })
  window.dispatchEvent(event)
  return event
}

/** Every chord down is released at a test's end: the hook's arm is the document's. */
function disarm(): void {
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Unidentified' }))
  vi.restoreAllMocks()
}

describe('the DevTools frontend’s quit-chord relay', () => {
  afterEach(disarm)

  it('consumes the quit chord’s key down in the frontend and says it on the console in the key table’s shape; other keys pass untouched and unsaid', () => {
    const fe = frontend(MAC_QUIT)
    expect(['hooked', 'rebound']).toContain(fe.ran)
    const other = press('keydown', 't', { metaKey: true })
    expect(other.defaultPrevented).toBe(false)
    expect(fe.said()).toEqual([])
    const chord = press('keydown', 'q', { metaKey: true })
    expect(chord.defaultPrevented).toBe(true)
    expect(fe.keys()).toEqual([
      {
        type: 'keyDown',
        key: 'q',
        control: false,
        alt: false,
        shift: false,
        meta: true,
        isAutoRepeat: false
      }
    ])
    // A repeat while the chord is down is said as one (the table leaves repeats to the hold).
    press('keydown', 'q', { metaKey: true, repeat: true })
    expect(fe.keys()[1]).toMatchObject({ type: 'keyDown', isAutoRepeat: true })
  })

  it('says the next key up after the chord – whichever key, the hold’s own rule – and no key up before or after it', () => {
    const fe = frontend(LINUX_QUIT)
    press('keyup', 'Shift')
    expect(fe.said()).toEqual([])
    // Shift's spelling of the key: Q with Shift down is the chord bound to q.
    expect(press('keydown', 'Q', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true)
    const shiftUp = press('keyup', 'Shift', { ctrlKey: true })
    expect(shiftUp.defaultPrevented).toBe(false)
    press('keyup', 'q', { ctrlKey: true })
    expect(fe.keys()).toEqual([
      {
        type: 'keyDown',
        key: 'Q',
        control: true,
        alt: false,
        shift: true,
        meta: false,
        isAutoRepeat: false
      },
      {
        type: 'keyUp',
        key: 'Shift',
        control: true,
        alt: false,
        shift: false,
        meta: false,
        isAutoRepeat: false
      }
    ])
  })

  it('says a key up when the frontend’s window loses the keyboard with the chord down (the release it would never see), and nothing on a blur with no chord down', () => {
    const fe = frontend(MAC_QUIT)
    window.dispatchEvent(new Event('blur'))
    expect(fe.said()).toEqual([])
    press('keydown', 'q', { metaKey: true })
    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new Event('blur'))
    expect(fe.keys()).toEqual([
      {
        type: 'keyDown',
        key: 'q',
        control: false,
        alt: false,
        shift: false,
        meta: true,
        isAutoRepeat: false
      },
      {
        type: 'keyUp',
        key: 'Unidentified',
        control: false,
        alt: false,
        shift: false,
        meta: false,
        isAutoRepeat: false
      }
    ])
  })

  it('is idempotent: a second run re-reads the chord and installs no second listener; a null chord relays nothing', () => {
    const fe = frontend(MAC_QUIT)
    expect(fe.rerun(LINUX_QUIT)).toBe('rebound')
    press('keydown', 'q', { metaKey: true })
    expect(fe.said()).toEqual([])
    press('keydown', 'Q', { ctrlKey: true, shiftKey: true })
    expect(fe.said()).toHaveLength(1)
    fe.rerun(null)
    press('keydown', 'q', { metaKey: true })
    press('keydown', 'Q', { ctrlKey: true, shiftKey: true })
    expect(fe.said()).toHaveLength(1)
  })

  it('reads a key line back into the key table’s shape and nothing else', () => {
    const line = `${DEVTOOLS_KEY_MESSAGE_PREFIX}{"type":"keyUp","key":"Shift","control":true,"alt":false,"shift":false,"meta":false,"isAutoRepeat":false}`
    expect(devtoolsKeyFromMessage(line)).toEqual({
      type: 'keyUp',
      key: 'Shift',
      control: true,
      alt: false,
      shift: false,
      meta: false,
      isAutoRepeat: false
    })
    expect(devtoolsKeyFromMessage('zenium-devtools-dock:bottom')).toBeNull()
    expect(devtoolsKeyFromMessage(`${DEVTOOLS_KEY_MESSAGE_PREFIX}not json`)).toBeNull()
    expect(
      devtoolsKeyFromMessage(
        `${DEVTOOLS_KEY_MESSAGE_PREFIX}{"type":"char","key":"q","control":false,"alt":false,"shift":false,"meta":true,"isAutoRepeat":false}`
      )
    ).toBeNull()
    expect(
      devtoolsKeyFromMessage(
        `${DEVTOOLS_KEY_MESSAGE_PREFIX}{"type":"keyDown","key":"","control":false,"alt":false,"shift":false,"meta":true,"isAutoRepeat":false}`
      )
    ).toBeNull()
    expect(
      devtoolsKeyFromMessage(
        `${DEVTOOLS_KEY_MESSAGE_PREFIX}{"type":"keyDown","key":"q","control":"no","alt":false,"shift":false,"meta":true,"isAutoRepeat":false}`
      )
    ).toBeNull()
    expect(devtoolsKeyFromMessage(`${DEVTOOLS_KEY_MESSAGE_PREFIX}[1,2]`)).toBeNull()
  })
})

describe('the relayed chord through the inspected page’s key table', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    disarm()
    vi.useRealTimers()
  })

  it('the toolbox’s chord is held, not quit: the said key down arms the hold in the page’s window, the said key up releases it, nothing quits', async () => {
    const { browser, platform, win } = start({ os: 'darwin' })
    const tabId = browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win).id
    const requestQuit = vi.spyOn(browser, 'requestQuit')
    const fe = frontend(MAC_QUIT)
    press('keydown', 'q', { metaKey: true })
    const [down] = fe.keys()
    expect(down).not.toBeNull()
    browser.keys.handle(down!, tabId, win)
    expect(browser.quitHold.holding).toBe(true)
    expect(win.quitHold).toEqual({ startedAt: Date.now(), durationMs: QUIT_HOLD_MS, chord: '⌘Q' })
    vi.advanceTimersByTime(QUIT_HOLD_MS - 100)
    press('keyup', 'Meta')
    const up = fe.keys()[1]
    expect(up).toMatchObject({ type: 'keyUp', key: 'Meta' })
    browser.keys.handle(up!, tabId, win)
    expect(browser.quitHold.holding).toBe(false)
    expect(win.quitHold).toBeNull()
    vi.advanceTimersByTime(QUIT_HOLD_MS)
    await settle()
    expect(requestQuit).not.toHaveBeenCalled()
    expect(platform.host.quits).toBe(0)
  })

  it('the toolbox’s chord held through the hold quits with the tab question skipped, as the page’s own chord does', async () => {
    const { browser, platform, win } = start({ os: 'darwin' })
    const tabId = browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win).id
    browser.tabs.createTab({ url: 'https://example.com/b', active: false }, win)
    const requestQuit = vi.spyOn(browser, 'requestQuit')
    const fe = frontend(MAC_QUIT)
    press('keydown', 'q', { metaKey: true })
    browser.keys.handle(fe.keys()[0]!, tabId, win)
    vi.advanceTimersByTime(QUIT_HOLD_MS)
    await expect(requestQuit.mock.results[0]?.value).resolves.toBe(true)
    expect(requestQuit).toHaveBeenCalledWith(win, { held: true })
    expect(win.prompt).toBeNull()
    expect(platform.host.quits).toBe(1)
  })

  it('with the hold off the toolbox’s chord quits at the press through the table, consumed as the chrome’s is – the frontend having kept it from the menu bar', () => {
    const { browser, win } = start({ os: 'darwin' })
    const tabId = browser.tabs.createTab({ url: 'https://example.com/a', active: true }, win).id
    browser.setWarnBeforeQuitting(false)
    const requestQuit = vi.spyOn(browser, 'requestQuit').mockResolvedValue(true)
    const fe = frontend(MAC_QUIT)
    press('keydown', 'q', { metaKey: true })
    expect(browser.keys.handle(fe.keys()[0]!, tabId, win)).toBe(true)
    expect(browser.quitHold.holding).toBe(false)
    expect(requestQuit).toHaveBeenCalledTimes(1)
    // The fixture's chord and the frontend's say the same key.
    expect(quitChord('darwin', 'keyDown')).toMatchObject({ key: 'q', meta: true, control: false })
  })
})

describe('the relay on a toolbox', () => {
  /**
   * A frontend as the relay sees it: its console listeners, the scripts run in it, its main
   * frame – the frame a line is said from is the main frame unless the test names another.
   */
  function fakeFrontend(): DevtoolsFrontendLike & {
    listeners: ((event: { message: string; frame?: unknown }) => void)[]
    scripts: string[]
    say(message: string, frame?: unknown): void
    sayFrameless(message: string): void
  } {
    const listeners: ((event: { message: string; frame?: unknown }) => void)[] = []
    const scripts: string[] = []
    const mainFrame = { name: 'devtools://devtools/bundled/devtools_app.html' }
    return {
      listeners,
      scripts,
      mainFrame,
      on: (_event, listener) => listeners.push(listener),
      executeJavaScript: (code) => {
        scripts.push(code)
        return Promise.resolve('hooked')
      },
      say: (message, frame = mainFrame) =>
        listeners.forEach((listener) => listener({ message, frame })),
      sayFrameless: (message) => listeners.forEach((listener) => listener({ message }))
    }
  }

  const KEY_DOWN_LINE = `${DEVTOOLS_KEY_MESSAGE_PREFIX}{"type":"keyDown","key":"q","control":false,"alt":false,"shift":false,"meta":true,"isAutoRepeat":false}`
  const KEY_UP_LINE = `${DEVTOOLS_KEY_MESSAGE_PREFIX}{"type":"keyUp","key":"Meta","control":false,"alt":false,"shift":false,"meta":false,"isAutoRepeat":false}`

  it('watches the console for the keys the script says, runs the script with the chord as bound now, and once per frontend', () => {
    const frontend = fakeFrontend()
    const keys: KeyEventInput[] = []
    let chord: KeyBinding | null = MAC_QUIT
    relayDevtoolsQuitChord(
      frontend,
      () => chord,
      (key) => keys.push(key)
    )
    expect(frontend.listeners).toHaveLength(1)
    expect(frontend.scripts).toHaveLength(1)
    expect(frontend.scripts[0]).toContain(JSON.stringify(MAC_QUIT))
    frontend.say('zenium-devtools-dock:bottom')
    frontend.say(KEY_DOWN_LINE)
    frontend.say(KEY_UP_LINE)
    expect(keys.map((k) => `${k.type}:${k.key}`)).toEqual(['keyDown:q', 'keyUp:Meta'])
    // The same frontend again (a second `devtools-opened` for one toolbox): nothing doubled.
    chord = LINUX_QUIT
    relayDevtoolsQuitChord(
      frontend,
      () => chord,
      (key) => keys.push(key)
    )
    expect(frontend.listeners).toHaveLength(1)
    expect(frontend.scripts).toHaveLength(1)
    // A fresh frontend reads the chord as bound at its opening.
    const next = fakeFrontend()
    relayDevtoolsQuitChord(
      next,
      () => chord,
      () => undefined
    )
    expect(next.scripts[0]).toContain(JSON.stringify(LINUX_QUIT))
  })

  it('hears the frontend document’s own frame alone: a key line from a sub-frame – an extension’s devtools_page mounted as an iframe of the frontend – or from no frame is not a key (R1)', () => {
    const frontend = fakeFrontend()
    const keys: KeyEventInput[] = []
    relayDevtoolsQuitChord(
      frontend,
      () => MAC_QUIT,
      (key) => keys.push(key)
    )
    const devtoolsPage = { name: 'chrome-extension://abcdefgh/devtools.html' }
    // The forged hold: a key down with no key up after it would be a quit at 1.5 s.
    frontend.say(KEY_DOWN_LINE, devtoolsPage)
    expect(keys).toEqual([])
    frontend.say(KEY_UP_LINE, devtoolsPage)
    frontend.sayFrameless(KEY_DOWN_LINE)
    frontend.say(KEY_DOWN_LINE, null)
    expect(keys).toEqual([])
    // The main frame's own lines go on as before.
    frontend.say(KEY_DOWN_LINE)
    frontend.say(KEY_UP_LINE)
    expect(keys.map((k) => `${k.type}:${k.key}`)).toEqual(['keyDown:q', 'keyUp:Meta'])
  })

  it('reads the chord bound to app.quit from the key table’s shortcuts, null while unbound', () => {
    const quit = {
      id: 'key_quitApplication',
      action: 'app.quit',
      binding: MAC_QUIT
    } as unknown as Shortcut
    const other = {
      id: 'key_newNavigatorTab',
      action: 'tab.new',
      binding: { ...MAC_QUIT, key: 't' }
    } as unknown as Shortcut
    expect(quitChordOf([other, quit])).toEqual(MAC_QUIT)
    expect(quitChordOf([other, { ...quit, binding: null } as unknown as Shortcut])).toBeNull()
    expect(quitChordOf([other])).toBeNull()
  })
})
