import type { KeyEventInput } from '../../core/platform'
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
 * A toolbox's frontend as the relay needs it – its console, the frame of its own document and a
 * script run in it (Electron's `WebContents`; `mainFrame` and a line's `frame` its `WebFrameMain`).
 */
export interface DevtoolsFrontendLike {
  readonly mainFrame: unknown
  on(
    event: 'console-message',
    listener: (event: { message: string; frame?: unknown }) => void
  ): unknown
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
}

const relayed = new WeakSet<object>()

/**
 * The relay on one toolbox: its console watched for the keys the script says, the script run
 * with the chord as bound at this moment. Once per frontend; `onKey` gets each key in the key
 * table's shape, for the window the toolbox belongs to.
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
  onKey: (key: KeyEventInput) => void
): void {
  if (relayed.has(frontend)) return
  relayed.add(frontend)
  frontend.on('console-message', (event) => {
    if (event.frame === undefined || event.frame !== frontend.mainFrame) return
    const key = devtoolsKeyFromMessage(event.message)
    if (key) onKey(key)
  })
  frontend.executeJavaScript(devtoolsQuitChordScript(chord()), true).catch(() => undefined)
}
