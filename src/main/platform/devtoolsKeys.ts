import devtoolsQuitHoldPanelSource from 'virtual:zenium-devtools-quit-hold-panel'
import type { KeyEventInput } from '../../core/platform'
import type { QuitHoldPanel } from '../../shared/quitHoldPanel'
import type { KeyBinding, Shortcut } from '../../shared/types'

/**
 * The quit chord typed into a DevTools toolbox (session-08, review F3's DevTools path).
 *
 * The chord is held, not pressed, on a host that holds (macOS with Warn Before Quitting on): the
 * key table arms the hold on the chord's key down and releases it on the next key up, both read
 * from `before-input-event` – the chrome's, the pages', an extension popup's. A DevTools frontend
 * raises that event on nothing. Electron gives the frontend `InspectableWebContents` as its
 * `WebContentsDelegate` (`shell/browser/ui/inspectable_web_contents.h`, v44.4.5), which overrides
 * `HandleKeyboardEvent` – the keys the frontend's own scripts left unhandled, forwarded to the
 * inspected page's delegate – and not `PreHandleKeyboardEvent`, where `before-input-event` is
 * emitted; the API object of `webContents.devToolsWebContents` is an observer of the frontend,
 * not its delegate. So the chord's key down went from the toolbox straight to the inspected page's
 * `WebContents::HandleKeyboardEvent`, on macOS to `[[NSApp mainMenu] performKeyEquivalent:]`
 * (`electron_api_web_contents_mac.mm`) and the Quit role – a plain quit request with no hold
 * ever armed: with one tab and no download the app was gone at the press, the box checked.
 * Measured on the Linux stand-in (Electron 44.4.5, `--test-quit-hold`): a chord sent into a
 * docked, a detached and the chrome's own toolbox raised `before-input-event` on neither the
 * inspected page's webContents, nor the chrome's, nor the frontend's own emitter, and no hold
 * armed (`internal/desktop-parity/desktop-hold-to-quit-w5-19.md`).
 *
 * The route the frontend has is its console: the host already listens to it for the dock and
 * the page's hole (`devtoolsFrontend.ts`). The script below runs in the frontend page and, on
 * the chord's key down, consumes it there – so the key the frontend leaves unhandled never
 * reaches the menu bar's key equivalent – and says it on the console; the next key up, whichever
 * key (the hold's own rule: Chrome's panel waits for any key up), is said the same way, and so
 * is the frontend's window losing the keyboard while the chord is down (a key up the frontend
 * would never see is a release the hold must hear – review F1's reading). The host reads each
 * line back into the key table – for the inspected page's window from a page's toolbox
 * (`ElectronTabView.dressDevtools`), as chrome keys from the window's own (the Browser Console,
 * `ElectronWindow`) – as the page's and the chrome's own keys go. The chord is the one bound to
 * `app.quit` when the toolbox opens; a rebinding reaches toolboxes opened after it. Nothing else
 * of the toolbox's keys is touched: DevTools keeps its own shortcuts, and the chords it leaves go
 * on to the menu bar.
 */
export const DEVTOOLS_KEY_MESSAGE_PREFIX = 'zenium-devtools-key:'

/**
 * The frontend's script: the quit chord's key down consumed and said, the next key up said,
 * the window's blur while the chord is down said as a key up. Idempotent: a second run re-reads
 * the chord and installs no second listener. Resolves `hooked`, then `rebound`.
 */
export function devtoolsQuitChordScript(chord: KeyBinding | null): string {
  return `(() => {
  window.__zeniumQuitChord = ${JSON.stringify(chord)}
  if (window.__zeniumQuitChordHook) return 'rebound'
  window.__zeniumQuitChordHook = true
  let armed = false
  const say = (type, e) => {
    try {
      console.log(${JSON.stringify(DEVTOOLS_KEY_MESSAGE_PREFIX)} + JSON.stringify({
        type, key: e.key, control: Boolean(e.ctrlKey), alt: Boolean(e.altKey), shift: Boolean(e.shiftKey), meta: Boolean(e.metaKey), isAutoRepeat: Boolean(e.repeat)
      }))
    } catch (err) {}
  }
  const matches = (e) => {
    const c = window.__zeniumQuitChord
    if (!c || typeof e.key !== 'string') return false
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    return key === c.key && Boolean(e.ctrlKey) === c.ctrl && Boolean(e.altKey) === c.alt && Boolean(e.shiftKey) === c.shift && Boolean(e.metaKey) === c.meta
  }
  window.addEventListener('keydown', (e) => {
    if (!matches(e)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    armed = true
    say('keyDown', e)
  }, true)
  window.addEventListener('keyup', (e) => {
    if (!armed) return
    armed = false
    say('keyUp', e)
  }, true)
  window.addEventListener('blur', () => {
    if (!armed) return
    armed = false
    say('keyUp', { key: 'Unidentified' })
  })
  return 'hooked'
})()`
}

/**
 * The key a frontend console line carries, in the key table's shape, or null for any other line
 * (the frontend's own logging, a line that is not a key).
 */
export function devtoolsKeyFromMessage(message: string): KeyEventInput | null {
  if (!message.startsWith(DEVTOOLS_KEY_MESSAGE_PREFIX)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(message.slice(DEVTOOLS_KEY_MESSAGE_PREFIX.length))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const type = record.type
  if (type !== 'keyDown' && type !== 'keyUp') return null
  const key = record.key
  if (typeof key !== 'string' || key.length === 0) return null
  const flags = [record.control, record.alt, record.shift, record.meta, record.isAutoRepeat]
  if (!flags.every((flag) => typeof flag === 'boolean')) return null
  return {
    type,
    key,
    control: record.control as boolean,
    alt: record.alt as boolean,
    shift: record.shift as boolean,
    meta: record.meta as boolean,
    isAutoRepeat: record.isAutoRepeat as boolean
  }
}

/** The chord the key table binds to `app.quit` now, or null while it is unbound. */
export function quitChordOf(shortcuts: readonly Shortcut[]): KeyBinding | null {
  return shortcuts.find((shortcut) => shortcut.action === 'app.quit')?.binding ?? null
}

/**
 * A toolbox's frontend as the relay needs it – its console, the frame of its own document, a
 * script run in it and whether it is gone (Electron's `WebContents`; `mainFrame` and a line's
 * `frame` its `WebFrameMain`).
 */
export interface DevtoolsFrontendLike {
  readonly mainFrame: unknown
  on(
    event: 'console-message',
    listener: (event: { message: string; frame?: unknown }) => void
  ): unknown
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  isDestroyed(): boolean
}

/**
 * A toolbox as the held-key notice needs it: its frontend, the window its keys go to, and
 * whether it stands in a window of its own.
 */
export interface DevtoolsToolbox {
  readonly frontend: DevtoolsFrontendLike
  /** The window the toolbox's relayed keys are the keys of; its identity alone is read. Null while it has none. */
  window(): object | null
  /**
   * True while the toolbox is a window of its own – a page's at `undocked`, the Browser Console
   * always (`detach`) – and false docked into the page's view, where the browser window has the
   * keyboard and the page's panel stands in sight.
   */
  detached(): boolean
}

/**
 * The toolbox's held-key panel script: the bundled `devtoolsQuitHoldPanel.ts` installed on the
 * first run (its listener left on the window), then the panel posted to it – or null, the
 * panel's way down. Resolves `shown` or `down`.
 */
export function devtoolsQuitHoldPanelScript(panel: QuitHoldPanel | null): string {
  return `(() => {
  if (!window.__zeniumQuitHoldPanel) {
    ${devtoolsQuitHoldPanelSource}
  }
  window.__zeniumQuitHoldPanel(${JSON.stringify(panel)})
  return ${JSON.stringify(panel ? 'shown' : 'down')}
})()`
}

/**
 * "Hold ⌘Q to quit" over a detached toolbox (design language v2 §9.23: the held-key notice is
 * drawn where the keyboard is; #486's R2). A hold armed from a toolbox that stands in a window
 * of its own runs with the browser window blurred, and the panel the window's page or chrome
 * drew would stand behind the toolbox, or off where nobody is looking. So the relay marks the
 * toolbox the chord went down in (`heard`, before the key table hears the key; the key up line
 * clears it); while that toolbox is detached, the page's own panel yields
 * (`inToolbox`, `ElectronTabView.showQuitHold`) and the window's state stream, which carries the
 * hold as the chrome reads it, is mirrored into the toolbox's document (`mirror`,
 * `ElectronWindow.send`): the panel drawn by the frontend itself at its centre from the page's
 * source (`shared/quitHoldPanel.ts`, `devtoolsQuitHoldPanel.ts`), taken down with its fade when
 * the hold ends either way. The toolbox alone draws it. A docked toolbox changes nothing: the
 * mark is set, the toolbox is not detached, the page draws as before.
 *
 * One keyboard, one notice: the platform keeps a single instance (`devtoolsQuitHoldNotice`),
 * which every window's state passes through with its own hold – a window with none leaves
 * another window's panel standing.
 */
export class DevtoolsQuitHoldNotice {
  /** The toolbox the chord is down in, from its key down line to its key up line. */
  private keyboard: DevtoolsToolbox | null = null
  /** The toolbox a panel stands in, the window whose hold it shows and that hold. */
  private standing: { toolbox: DevtoolsToolbox; window: object; startedAt: number } | null = null

  constructor(
    private readonly script: (panel: QuitHoldPanel | null) => string = devtoolsQuitHoldPanelScript
  ) {}

  /** The relay's report, ahead of the key table: the chord went down in `toolbox`, or a key came up there. */
  heard(toolbox: DevtoolsToolbox, key: KeyEventInput): void {
    if (key.type === 'keyDown') this.keyboard = toolbox
    else if (this.keyboard === toolbox) this.keyboard = null
  }

  /**
   * True while the chord is down in a detached toolbox that still stands: the notice is the
   * toolbox's to draw, and the page's own panel yields.
   */
  inToolbox(): boolean {
    const toolbox = this.keyboard
    return toolbox !== null && !toolbox.frontend.isDestroyed() && toolbox.detached()
  }

  /**
   * `window`'s hold as its state stream carries it: the panel drawn in the keyboard's detached
   * toolbox when that toolbox is the window's, a change of hold replacing it, a repeat of the
   * same hold (its `startedAt`) running nothing; null takes the window's panel down. Another
   * window's state, hold or none, leaves the panel standing.
   */
  mirror(window: object, panel: QuitHoldPanel | null): void {
    if (panel) {
      const toolbox = this.keyboard
      if (!toolbox || !this.inToolbox() || toolbox.window() !== window) return
      const standing = this.standing
      if (standing?.toolbox === toolbox && standing.startedAt === panel.startedAt) return
      if (standing && standing.toolbox !== toolbox) this.run(standing.toolbox, null)
      this.standing = { toolbox, window, startedAt: panel.startedAt }
      this.run(toolbox, panel)
      return
    }
    const standing = this.standing
    if (!standing || standing.window !== window) return
    this.standing = null
    this.run(standing.toolbox, null)
  }

  private run(toolbox: DevtoolsToolbox, panel: QuitHoldPanel | null): void {
    const { frontend } = toolbox
    if (frontend.isDestroyed()) return
    frontend.executeJavaScript(this.script(panel), true).catch(() => undefined)
  }
}

/** The one notice of the process: one keyboard, one chord down at a time. */
export const devtoolsQuitHoldNotice = new DevtoolsQuitHoldNotice()

const relayed = new WeakSet<object>()

/**
 * The relay on one toolbox: its console watched for the keys the script says, the script run
 * with the chord as bound at this moment. Once per frontend; `onKey` gets each key in the key
 * table's shape, for the window the toolbox belongs to. With `toolbox` named, each key is
 * reported to the held-key notice first (`DevtoolsQuitHoldNotice.heard`), so a hold the key
 * table arms from it knows where the keyboard is.
 *
 * Only the frontend document's own frame is heard (the first line's R1 on #486): the console
 * event carries every frame's lines, and an extension's `devtools_page` – Zenium loads extensions
 * through the session (`ses.extensions.loadExtension`), under which Electron mounts that page as
 * an iframe of the frontend – could otherwise say a key line of its own and drive the key table
 * with it (a quit with the box off, a held quit with no key up on it, a chord that closes tabs
 * or windows). The script above runs in the main frame alone, so its lines are the main frame's;
 * a line from any other frame, or one without a frame, is not a key.
 */
export function relayDevtoolsQuitChord(
  frontend: DevtoolsFrontendLike,
  chord: () => KeyBinding | null,
  onKey: (key: KeyEventInput) => void,
  toolbox?: { notice: DevtoolsQuitHoldNotice; window(): object | null; detached(): boolean }
): void {
  if (relayed.has(frontend)) return
  relayed.add(frontend)
  const notice = toolbox
    ? { at: toolbox.notice, of: { frontend, window: toolbox.window, detached: toolbox.detached } }
    : null
  frontend.on('console-message', (event) => {
    if (event.frame === undefined || event.frame !== frontend.mainFrame) return
    const key = devtoolsKeyFromMessage(event.message)
    if (!key) return
    if (notice) notice.at.heard(notice.of, key)
    onKey(key)
  })
  frontend.executeJavaScript(devtoolsQuitChordScript(chord()), true).catch(() => undefined)
}
