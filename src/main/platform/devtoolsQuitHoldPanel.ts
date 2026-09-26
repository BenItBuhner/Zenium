import { installQuitHoldPanel, type QuitHoldPanel } from '../../shared/quitHoldPanel'

/*
 * "Hold ⌘Q to quit" in a DevTools toolbox's own document (session-08, #486's R2). Design
 * language v2 §9.23: the held-key notice is drawn where the keyboard is. With the toolbox
 * detached, the chord is held in a window of its own – the browser window behind it is blurred,
 * and a panel its page or chrome drew would stand behind the toolbox, or off where nobody is
 * looking – so the toolbox draws the panel itself, from the same source the page does
 * (`shared/quitHoldPanel.ts`: the §9.23 title block, the ring, the pop and the fade), at its own
 * document's centre.
 *
 * This file is not part of the main bundle: `scripts/inline-script.ts` bundles it at build time
 * into an IIFE served as `virtual:zenium-devtools-quit-hold-panel`, and `DevtoolsQuitHoldNotice`
 * (`devtoolsKeys.ts`) runs that source in the frontend once, then posts the panel – or null, the
 * way down – through the listener it leaves on the window. Every style is set through the CSSOM
 * (the frontend's content security policy has nothing to refuse), and the panel takes no pointer
 * and no focus: the keyboard stays in the toolbox for the key up that ends the hold. Idempotent:
 * a second run leaves the first listener where it is.
 */
type ToolboxWindow = Window & {
  __zeniumQuitHoldPanel?: (panel: QuitHoldPanel | null) => void
}

const toolbox = window as ToolboxWindow
if (!toolbox.__zeniumQuitHoldPanel) {
  installQuitHoldPanel((listener) => {
    toolbox.__zeniumQuitHoldPanel = listener
  })
}
