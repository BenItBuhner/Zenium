import devtoolsQuitHoldPanelSource from 'virtual:zenium-devtools-quit-hold-panel'
import type { KeyEventInput } from '../../core/platform'
import type { QuitHoldPanel } from '../../shared/quitHoldPanel'
import type { QuitHoldState } from '../../shared/types'
import type { DevtoolsToolbox } from './devtoolsKeys'

/**
 * "Hold ⌘Q to quit" over a detached toolbox (design language v2 §9.23: the held-key notice is
 * drawn where the keyboard is; #486's R2). A hold armed from a toolbox that stands in a window
 * of its own runs with the browser window blurred, and the panel the window's page or chrome
 * drew would stand behind the toolbox, or off where nobody is looking. So the relay
 * (`devtoolsKeys.ts`) marks the toolbox the chord went down in (`heard`, before the key table
 * hears the key; the key up line clears it); while that toolbox is detached, the page's own
 * panel yields (`inToolbox`, `ElectronTabView.showQuitHold`) and the window's state stream,
 * which carries the hold as the chrome reads it, is routed (`route`, `ElectronWindow.send`):
 * the hold mirrored into the toolbox's document – the panel drawn by the frontend itself at its
 * centre from the page's source (`shared/quitHoldPanel.ts`, `devtoolsQuitHoldPanel.ts`), taken
 * down with its fade when the hold ends either way – and withheld from the chrome meanwhile,
 * whose twin would otherwise stand over a chrome page (the Browser Console over Settings). The
 * toolbox alone draws it. A docked toolbox changes nothing: the mark is set, the toolbox is not
 * detached, the state goes to the chrome as it came and the page draws as before.
 *
 * This module, not `devtoolsKeys.ts`, carries the bundled panel: the page preload reaches the
 * relay's helpers (`quitHoldKeys.ts` → `quitChordOf`) and must not carry the toolbox's script.
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
   * True while a panel stands in a toolbox for `window`'s hold: the toolbox alone draws it, and
   * the window's chrome is to read no hold meanwhile.
   */
  drawing(window: object): boolean {
    const standing = this.standing
    return (
      standing !== null && standing.window === window && !standing.toolbox.frontend.isDestroyed()
    )
  }

  /**
   * `window`'s state as its chrome is to read it: the hold it carries mirrored into the
   * keyboard's detached toolbox (`mirror`), and – while the toolbox draws it – taken out of the
   * state the chrome receives, so its twin does not stand in the blurred window behind the
   * toolbox. Any other state is returned as it came.
   */
  route<S extends { window: { quitHold: QuitHoldState | null } }>(
    window: object,
    state: S,
    panelFor: (hold: QuitHoldState) => QuitHoldPanel
  ): S {
    const hold = state.window.quitHold
    this.mirror(window, hold ? panelFor(hold) : null)
    if (!hold || !this.drawing(window)) return state
    return { ...state, window: { ...state.window, quitHold: null } }
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
