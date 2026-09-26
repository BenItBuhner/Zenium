// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUIT_HOLD_MS } from '../../../core/quitHold'
import type { KeyBinding } from '../../../shared/types'
import { QUIT_HOLD_PANEL, type QuitHoldPanel } from '../../../shared/quitHoldPanel'
import {
  type DevtoolsToolbox,
  devtoolsKeyFromMessage,
  relayDevtoolsQuitChord
} from '../devtoolsKeys'
import { DevtoolsQuitHoldNotice, devtoolsQuitHoldPanelScript } from '../devtoolsQuitHoldNotice'
import { KEY_DOWN_LINE, KEY_UP_LINE, fakeFrontend } from './devtoolsKeysFixture'

const MAC_QUIT: KeyBinding = { ctrl: false, alt: false, shift: false, meta: true, key: 'q' }

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

  it('routes the window’s state: the hold drawn in the toolbox is withheld from the chrome, so no twin stands behind the toolbox; any other state passes as it came', () => {
    const n = notice()
    const win = {}
    const box = toolbox(win)
    const hold = { startedAt: 10_000, durationMs: QUIT_HOLD_MS, chord: '⌘Q' }
    const panelFor = (h: typeof hold): QuitHoldPanel => ({ ...h, dark: false, accent: '#3366cc' })
    const state = { tabs: ['a'], window: { title: 'Zenium', quitHold: hold } }
    // No chord down in a toolbox: the chrome reads the hold and draws its twin where no page is.
    expect(n.route(win, state, panelFor)).toBe(state)
    expect(n.drawing(win)).toBe(false)
    expect(box.frontend.scripts).toEqual([])
    // The chord down in the detached toolbox: the toolbox draws, the chrome reads no hold – the
    // rest of the state untouched.
    n.heard(box, KEY_DOWN)
    const routed = n.route(win, state, panelFor)
    expect(routed).not.toBe(state)
    expect(routed.window.quitHold).toBeNull()
    expect(routed.window.title).toBe('Zenium')
    expect(routed.tabs).toBe(state.tabs)
    expect(n.drawing(win)).toBe(true)
    expect(box.frontend.scripts).toEqual(['shown:10000'])
    // The state stream runs on with the same hold: withheld again, not drawn twice.
    expect(
      n.route(win, { ...state, window: { ...state.window, title: 'Two' } }, panelFor).window
        .quitHold
    ).toBeNull()
    expect(box.frontend.scripts).toEqual(['shown:10000'])
    // Another window's state is not this toolbox's: its hold reaches its own chrome.
    const other = {}
    const elsewhere = {
      tabs: [],
      window: { title: 'Other', quitHold: { ...hold, startedAt: 10_500 } }
    }
    expect(n.route(other, elsewhere, panelFor)).toBe(elsewhere)
    expect(n.drawing(other)).toBe(false)
    // The hold's end: the state with none passes as it came, the toolbox's panel comes down.
    const ended = { tabs: ['a'], window: { title: 'Zenium', quitHold: null } }
    expect(n.route(win, ended, panelFor)).toBe(ended)
    expect(n.drawing(win)).toBe(false)
    expect(box.frontend.scripts).toEqual(['shown:10000', 'down'])
    n.heard(box, KEY_UP)
    // Docked, the toolbox draws nothing and the chrome reads the hold as before.
    const docked = toolbox(win, false)
    n.heard(docked, KEY_DOWN)
    expect(n.route(win, state, panelFor)).toBe(state)
    expect(docked.frontend.scripts).toEqual([])
    n.heard(docked, KEY_UP)
    // A toolbox closed with the panel standing is no longer drawing: the chrome reads the hold again.
    const closing = toolbox(win)
    n.heard(closing, KEY_DOWN)
    expect(n.route(win, state, panelFor).window.quitHold).toBeNull()
    closing.frontend.destroy()
    expect(n.drawing(win)).toBe(false)
    expect(n.route(win, state, panelFor)).toBe(state)
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
