// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUIT_HOLD_MS } from '../../../core/quitHold'
import { quitChord, settle, start } from '../../../core/__tests__/quitHoldFixture'
import type { KeyEventInput } from '../../../core/platform'
import type { KeyBinding, Shortcut } from '../../../shared/types'
import { QUIT_HOLD_PANEL, type QuitHoldPanel } from '../../../shared/quitHoldPanel'
import {
  DEVTOOLS_KEY_MESSAGE_PREFIX,
  type DevtoolsFrontendLike,
  DevtoolsQuitHoldNotice,
  type DevtoolsToolbox,
  devtoolsKeyFromMessage,
  devtoolsQuitChordScript,
  devtoolsQuitHoldPanelScript,
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

/**
 * A frontend as the relay and the notice see it: its console listeners, the scripts run in it,
 * its main frame – the frame a line is said from is the main frame unless the test names
 * another – and whether it is gone.
 */
function fakeFrontend(): DevtoolsFrontendLike & {
  listeners: ((event: { message: string; frame?: unknown }) => void)[]
  scripts: string[]
  say(message: string, frame?: unknown): void
  sayFrameless(message: string): void
  destroy(): void
} {
  const listeners: ((event: { message: string; frame?: unknown }) => void)[] = []
  const scripts: string[] = []
  const mainFrame = { name: 'devtools://devtools/bundled/devtools_app.html' }
  let destroyed = false
  return {
    listeners,
    scripts,
    mainFrame,
    on: (_event, listener) => listeners.push(listener),
    executeJavaScript: (code) => {
      scripts.push(code)
      return Promise.resolve('hooked')
    },
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
    },
    say: (message, frame = mainFrame) =>
      listeners.forEach((listener) => listener({ message, frame })),
    sayFrameless: (message) => listeners.forEach((listener) => listener({ message }))
  }
}

const KEY_DOWN_LINE = `${DEVTOOLS_KEY_MESSAGE_PREFIX}{"type":"keyDown","key":"q","control":false,"alt":false,"shift":false,"meta":true,"isAutoRepeat":false}`
const KEY_UP_LINE = `${DEVTOOLS_KEY_MESSAGE_PREFIX}{"type":"keyUp","key":"Meta","control":false,"alt":false,"shift":false,"meta":false,"isAutoRepeat":false}`

describe('the relay on a toolbox', () => {
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

/*
 * The held-key notice over a detached toolbox (#486's R2; design language v2 §9.23: the notice
 * is drawn where the keyboard is). The relay marks the toolbox the chord went down in; while
 * that toolbox stands in a window of its own, the page's panel yields and the window's state
 * stream is mirrored into the toolbox's document, where the frontend draws the panel itself
 * from the page's source.
 */
describe('the held-key notice over a detached toolbox', () => {
  const KEY_DOWN = devtoolsKeyFromMessage(KEY_DOWN_LINE)!
  const KEY_UP = devtoolsKeyFromMessage(KEY_UP_LINE)!
  const panel = (startedAt = 10_000): QuitHoldPanel => ({
    startedAt,
    durationMs: QUIT_HOLD_MS,
    chord: '⌘Q',
    dark: false,
    accent: '#3366cc'
  })

  /** A toolbox as the notice sees it, over `window`, detached unless docked; its frontend a fake. */
  function toolbox(
    window: object,
    detached = true
  ): DevtoolsToolbox & { frontend: ReturnType<typeof fakeFrontend>; dock(): void } {
    const frontend = fakeFrontend()
    let standalone = detached
    return {
      frontend,
      window: () => window,
      detached: () => standalone,
      dock: () => {
        standalone = false
      }
    }
  }

  /** A notice whose script is a label, so a toolbox's scripts read as `shown:<startedAt>` / `down`. */
  function notice(): DevtoolsQuitHoldNotice {
    return new DevtoolsQuitHoldNotice((p) => (p ? `shown:${p.startedAt}` : 'down'))
  }

  it('marks the toolbox the chord went down in until the key up there; the page yields to it only while it stands detached', () => {
    const n = notice()
    const win = {}
    const box = toolbox(win)
    expect(n.inToolbox()).toBe(false)
    n.heard(box, KEY_DOWN)
    expect(n.inToolbox()).toBe(true)
    // A repeat while the chord is down changes nothing; a key up elsewhere is not this toolbox's.
    n.heard(box, { ...KEY_DOWN, isAutoRepeat: true })
    n.heard(toolbox(win), KEY_UP)
    expect(n.inToolbox()).toBe(true)
    n.heard(box, KEY_UP)
    expect(n.inToolbox()).toBe(false)
    // Docked, the toolbox shares the window with the page's panel: the page draws as before.
    const docked = toolbox(win, false)
    n.heard(docked, KEY_DOWN)
    expect(n.inToolbox()).toBe(false)
    n.heard(docked, KEY_UP)
    // A toolbox closed with the chord down is nowhere to draw.
    const closing = toolbox(win)
    n.heard(closing, KEY_DOWN)
    closing.frontend.destroy()
    expect(n.inToolbox()).toBe(false)
  })

  it('mirrors the window’s hold into the keyboard’s toolbox once per hold, and null takes it down; another window’s state leaves it standing', () => {
    const n = notice()
    const win = {}
    const other = {}
    const box = toolbox(win)
    // No chord down in a toolbox: the state's hold is the page's or the chrome's to draw.
    n.mirror(win, panel())
    expect(box.frontend.scripts).toEqual([])
    n.heard(box, KEY_DOWN)
    n.mirror(win, panel())
    expect(box.frontend.scripts).toEqual(['shown:10000'])
    // The state stream runs on (a title, a tab): the same hold is not drawn twice.
    n.mirror(win, panel())
    n.mirror(win, { ...panel(), dark: true })
    expect(box.frontend.scripts).toEqual(['shown:10000'])
    // Another window's state, with no hold of its own, is not this panel's way down.
    n.mirror(other, null)
    expect(box.frontend.scripts).toEqual(['shown:10000'])
    n.mirror(win, null)
    expect(box.frontend.scripts).toEqual(['shown:10000', 'down'])
    // A second null with nothing standing runs nothing.
    n.mirror(win, null)
    expect(box.frontend.scripts).toEqual(['shown:10000', 'down'])
    // The keys still down (a hold that fired, latched): a new hold after the key up is drawn afresh.
    n.heard(box, KEY_UP)
    n.heard(box, KEY_DOWN)
    n.mirror(win, panel(12_000))
    expect(box.frontend.scripts).toEqual(['shown:10000', 'down', 'shown:12000'])
  })

  it('draws nothing in a docked toolbox, in one of another window, or in one that is gone', () => {
    const n = notice()
    const win = {}
    const docked = toolbox(win, false)
    n.heard(docked, KEY_DOWN)
    n.mirror(win, panel())
    expect(docked.frontend.scripts).toEqual([])
    n.heard(docked, KEY_UP)
    // The chord down in another window's toolbox: this window's hold is not that toolbox's.
    const elsewhere = toolbox({})
    n.heard(elsewhere, KEY_DOWN)
    n.mirror(win, panel())
    expect(elsewhere.frontend.scripts).toEqual([])
    n.heard(elsewhere, KEY_UP)
    // Closed with the panel standing: the way down runs no script into a gone frontend.
    const box = toolbox(win)
    n.heard(box, KEY_DOWN)
    n.mirror(win, panel())
    expect(box.frontend.scripts).toEqual(['shown:10000'])
    box.frontend.destroy()
    n.mirror(win, null)
    expect(box.frontend.scripts).toEqual(['shown:10000'])
  })

  it('a hold moving to another toolbox takes the first panel down before drawing the second', () => {
    const n = notice()
    const win = {}
    const first = toolbox(win)
    const second = toolbox(win)
    n.heard(first, KEY_DOWN)
    n.mirror(win, panel())
    n.heard(first, KEY_UP)
    n.heard(second, KEY_DOWN)
    n.mirror(win, panel(11_000))
    expect(first.frontend.scripts).toEqual(['shown:10000', 'down'])
    expect(second.frontend.scripts).toEqual(['shown:11000'])
  })

  it('the relay reports each key to the notice ahead of the key table, so the hold the table arms knows where the keyboard is', () => {
    const n = notice()
    const frontend = fakeFrontend()
    const seen: boolean[] = []
    relayDevtoolsQuitChord(
      frontend,
      () => MAC_QUIT,
      () => seen.push(n.inToolbox()),
      { notice: n, window: () => ({}), detached: () => true }
    )
    frontend.say(KEY_DOWN_LINE)
    frontend.say(KEY_UP_LINE)
    expect(seen).toEqual([true, false])
    // A line from another frame reaches neither the notice nor the table (R1).
    frontend.say(KEY_DOWN_LINE, { name: 'chrome-extension://abcdefgh/devtools.html' })
    expect(n.inToolbox()).toBe(false)
    expect(seen).toEqual([true, false])
    // A relay with no toolbox named marks nothing.
    const plain = fakeFrontend()
    relayDevtoolsQuitChord(
      plain,
      () => MAC_QUIT,
      () => undefined
    )
    plain.say(KEY_DOWN_LINE)
    expect(n.inToolbox()).toBe(false)
  })
})

/**
 * The frontend's document under the panel script: the bundled `devtoolsQuitHoldPanel.ts` run
 * in this happy-dom window as `executeJavaScript` runs it in the toolbox, the panel posted to
 * the listener it leaves.
 */
describe('the toolbox’s panel script', () => {
  /** Frames under the test's hand, as `quitHoldPanel.test.ts` has them. */
  let queue: Array<{ id: number; cb: (now: number) => void }> = []
  let seq = 0
  const tick = (): void => {
    const due = queue
    queue = []
    for (const f of due) f.cb(Date.now())
  }
  const run = (panel: QuitHoldPanel | null): unknown =>
    new Function(`return ${devtoolsQuitHoldPanelScript(panel)}`)()
  const host = (): HTMLElement | null =>
    document.documentElement.querySelector<HTMLElement>('zenium-quit-hold')

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(100_000)
    queue = []
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++seq
      queue.push({ id, cb })
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      queue = queue.filter((f) => f.id !== id)
    })
    document.documentElement.querySelectorAll('zenium-quit-hold').forEach((el) => el.remove())
  })
  afterEach(() => {
    run(null)
    vi.advanceTimersByTime(QUIT_HOLD_PANEL.fadeMs)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const panel = (startedAt: number): QuitHoldPanel => ({
    startedAt,
    durationMs: QUIT_HOLD_MS,
    chord: '⌘Q',
    dark: true,
    accent: '#3366cc'
  })

  it('stands the §9.23 panel in the toolbox document on the hold, where the hold is, and steps its ring from the hold’s clock', () => {
    expect(host()).toBeNull()
    expect(run(panel(Date.now() - 300))).toBe('shown')
    const standing = host()!
    expect(standing).not.toBeNull()
    expect(standing.getAttribute('role')).toBe('status')
    expect(standing.getAttribute('aria-label')).toBe('Hold ⌘Q to quit')
    expect(standing.getAttribute('data-chord')).toBe('⌘Q')
    // Over the whole toolbox document, the panel at its centre, taking no pointer.
    expect(standing.style.position).toBe('fixed')
    expect(standing.style.display).toBe('grid')
    expect(standing.style.placeItems).toBe('center')
    expect(standing.style.pointerEvents).toBe('none')
    expect(standing.style.opacity).toBe('1')
    // A panel arriving after the arm starts where the hold is.
    expect(standing.getAttribute('data-progress')).toBe('0.200')
    vi.setSystemTime(Date.now() + 450)
    tick()
    expect(standing.getAttribute('data-progress')).toBe('0.500')
    expect(queue).toHaveLength(1)
  })

  it('a repeat of the hold changes nothing, and the script installs its listener once', () => {
    const started = Date.now()
    run(panel(started))
    const standing = host()!
    const listener = (window as { __zeniumQuitHoldPanel?: unknown }).__zeniumQuitHoldPanel
    expect(typeof listener).toBe('function')
    expect(run(panel(started))).toBe('shown')
    expect(document.documentElement.querySelectorAll('zenium-quit-hold')).toHaveLength(1)
    expect(host()).toBe(standing)
    expect((window as { __zeniumQuitHoldPanel?: unknown }).__zeniumQuitHoldPanel).toBe(listener)
  })

  it('null takes the panel down with its 120 ms fade – the hold released, or fired', () => {
    run(panel(Date.now()))
    const standing = host()!
    expect(run(null)).toBe('down')
    expect(standing.hasAttribute('data-leaving')).toBe(true)
    expect(standing.style.opacity).toBe('0')
    expect(standing.style.transition).toBe(`opacity ${QUIT_HOLD_PANEL.fadeMs}ms ease`)
    expect(queue).toHaveLength(0)
    vi.advanceTimersByTime(QUIT_HOLD_PANEL.fadeMs - 1)
    expect(standing.isConnected).toBe(true)
    vi.advanceTimersByTime(1)
    expect(standing.isConnected).toBe(false)
    expect(host()).toBeNull()
    // Null with nothing standing is nothing.
    expect(run(null)).toBe('down')
    expect(host()).toBeNull()
  })

  it('carries the panel source as one self-contained script: no import, no require, the page’s own tag', () => {
    const script = devtoolsQuitHoldPanelScript(panel(Date.now()))
    expect(script).toContain('zenium-quit-hold')
    expect(script).toContain('__zeniumQuitHoldPanel')
    expect(script).not.toMatch(/\bimport\s*[({'"]/)
    expect(script).not.toMatch(/\brequire\(/)
  })
})
