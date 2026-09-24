import type { DevtoolsDock, Rect } from '../../shared/types'
import { DEVTOOLS_DOCKS } from '../../shared/devtoolsDock'

/**
 * What the Electron host asks of Chromium's DevTools frontend so a docked toolbox stands as
 * design language v2 §9.29 has it: "the page's view and the toolbox sharing the frame's one box
 * with a 1 px `--v2-border` between them (the edge where chrome meets foreign content) … the
 * toolbox draws its own theme and takes nothing from the window family."
 *
 * Electron docks the toolbox inside the page's own `WebContentsView` (Chromium's
 * `InspectableWebContentsView`): the frontend covers the view and the page is laid out in the
 * hole the frontend's root split widget leaves for it. The seam is therefore the frontend's –
 * the split widget's sidebar border, `--sys-color-divider` in its own palette – and the one
 * thing the host changes in the toolbox is that border's colour, to the chrome's token; the
 * rest of the toolbox is Chromium's, in whichever theme the frontend chose for itself.
 *
 * Every script here runs in the frontend page (`webContents.devToolsWebContents`) and reads back
 * a word for the host's logs; each is idempotent, since the frontend may be dressed again after
 * a dock change.
 */

/**
 * The chrome's `--v2-border` (`src/renderer/src/assets/main.css`), mirrored: the main process
 * cannot read the renderer's stylesheet, and the toolbox's seam must be the token, not a
 * reading of it. A test holds the two in step.
 */
export const DEVTOOLS_SEAM_COLORS = {
  light: 'rgb(0 0 0 / 0.15)',
  dark: 'rgb(255 255 255 / 0.12)'
} as const

/** The class the frontend puts on its `<html>` while it draws its dark theme (`ThemeSupport`). */
const FRONTEND_DARK_CLASS = 'theme-with-dark-background'

/**
 * The seam: one `<style>` in the root split widget's shadow root, on the sidebar half (the
 * toolbox's) whose `border-top` / `border-left` is the line between the page and the toolbox
 * at every dock. Keyed on the frontend's own theme class rather than the OS scheme, so a
 * toolbox the user set dark under a light window keeps the dark token, as §9.29 asks of a
 * surface that draws its own theme. Waits for the widget: the frontend builds its root view
 * after `devtools-opened`.
 */
export const DEVTOOLS_SEAM_SCRIPT = `(async () => {
  const deadline = Date.now() + 5000
  let host = null
  while (Date.now() < deadline) {
    host = document.querySelector('.root-view > .split-widget')
    if (host && host.shadowRoot) break
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!host || !host.shadowRoot) return 'no root split widget'
  if (host.shadowRoot.querySelector('#zenium-seam')) return 'already'
  const style = document.createElement('style')
  style.id = 'zenium-seam'
  style.textContent = ${JSON.stringify(
    `.shadow-split-widget-sidebar { border-color: ${DEVTOOLS_SEAM_COLORS.light} !important; }` +
      ` :host-context(.${FRONTEND_DARK_CLASS}) .shadow-split-widget-sidebar { border-color: ${DEVTOOLS_SEAM_COLORS.dark} !important; }`
  )}
  host.shadowRoot.appendChild(style)
  return 'styled'
})()`

/** The frontend's word on the console when its dock changes: `zenium-devtools-dock:<dock>`. */
export const DEVTOOLS_DOCK_MESSAGE_PREFIX = 'zenium-devtools-dock:'

/**
 * Reading the toolbox's own dock buttons back. The frontend's `DockController.setDockSide`
 * persists the new state (`currentDockState`) and then calls
 * `InspectorFrontendHost.setIsDocked`, at call time – so a wrapper on that method sees every
 * dock change the user makes inside the toolbox, reads the state it just persisted and says
 * it on the console, where the host listens (`console-message`). Electron offers no event for
 * it: without this the menu's checked row would drift from where the toolbox stands.
 */
export const DEVTOOLS_DOCK_HOOK_SCRIPT = `(() => {
  const host = InspectorFrontendHost
  if (host.__zeniumDockHook) return 'already'
  const orig = host.setIsDocked
  host.setIsDocked = function (docked, cb) {
    const r = orig.call(this, docked, cb)
    host.getPreferences((p) => {
      try { console.log(${JSON.stringify(DEVTOOLS_DOCK_MESSAGE_PREFIX)} + JSON.parse(p.currentDockState ?? 'null')) }
      catch (e) { console.log(${JSON.stringify(DEVTOOLS_DOCK_MESSAGE_PREFIX)} + 'error') }
    })
    return r
  }
  host.__zeniumDockHook = true
  return 'hooked'
})()`

/**
 * The dock a frontend console line reports, or null for any other line (the frontend's own
 * logging, a state that is not a dock).
 */
export function dockFromConsoleMessage(message: string): DevtoolsDock | null {
  if (!message.startsWith(DEVTOOLS_DOCK_MESSAGE_PREFIX)) return null
  const word = message.slice(DEVTOOLS_DOCK_MESSAGE_PREFIX.length).trim()
  return (DEVTOOLS_DOCKS as readonly string[]).includes(word) ? (word as DevtoolsDock) : null
}

/**
 * The frontend's word on the console when the page's hole in its box moves:
 * `zenium-devtools-page-bounds:<x>,<y>,<width>,<height>`, in DIP of the frontend's box.
 */
export const DEVTOOLS_PAGE_BOUNDS_MESSAGE_PREFIX = 'zenium-devtools-page-bounds:'

/**
 * Reading the page's hole back. A docked frontend lays the inspected page out in the hole its
 * placeholder widget leaves and tells the embedder where with
 * `InspectorFrontendHost.setInspectedPageBounds` – the DIP rect Electron sizes the page's view
 * to (`InspectedPagePlaceholder.dipPageRect`: the placeholder's box times the frontend's own
 * zoom), on every layout: the opening, a dock change, a drag of the split, a resize. A wrapper
 * on that method says each rect on the console, where the host listens; from the hole and the
 * box the host knows the toolbox's band – the part of the frontend the cover's picture needs
 * (`snapshotDevtools`), a third of the box at the default split rather than the whole of it
 * (design language v2 §9.5's budget). The rect laid out before the hook was in place is asked
 * for again through the placeholder's own `update()` – the plain one: the forced one sends a
 * height one off for Lighthouse's sake – and, without the module, through the root view's
 * resize, which reaches the same `update`. Without either the host pictures the whole box.
 */
export const DEVTOOLS_PAGE_BOUNDS_HOOK_SCRIPT = `(() => {
  const host = InspectorFrontendHost
  if (host.__zeniumPageBoundsHook) return 'already'
  const orig = host.setInspectedPageBounds
  host.setInspectedPageBounds = function (bounds) {
    try {
      console.log(${JSON.stringify(DEVTOOLS_PAGE_BOUNDS_MESSAGE_PREFIX)} + [bounds.x, bounds.y, bounds.width, bounds.height].join(','))
    } catch (e) {}
    return orig.call(this, bounds)
  }
  host.__zeniumPageBoundsHook = true
  import('./ui/legacy/legacy.js')
    .then((legacy) => legacy.InspectedPagePlaceholder.InspectedPagePlaceholder.instance().update())
    .catch(() => window.dispatchEvent(new Event('resize')))
  return 'hooked'
})()`

/**
 * The page's hole a frontend console line reports, or null for any other line (the frontend's
 * own logging, a rect that is not one).
 */
export function pageBoundsFromConsoleMessage(message: string): Rect | null {
  if (!message.startsWith(DEVTOOLS_PAGE_BOUNDS_MESSAGE_PREFIX)) return null
  const parts = message.slice(DEVTOOLS_PAGE_BOUNDS_MESSAGE_PREFIX.length).trim().split(',')
  if (parts.length !== 4) return null
  const [x, y, width, height] = parts.map((p) => Number(p))
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null
  if (width <= 0 || height <= 0 || x < 0 || y < 0) return null
  return { x, y, width, height }
}

/**
 * The toolbox's band in a docked frontend's box – what stands beside the page's hole, the seam
 * at its edge: below the hole for a bottom dock, right of it for a right dock, left of it for a
 * left dock – in the box's DIP, for the frontend's `capturePage(rect)`. Null where the reading
 * makes no band: an undocked toolbox, a hole that does not stand at the box's edge as the dock
 * has it (a layout mid-change, a report from another dock), or no hole at all – the host then
 * pictures the whole box, which the cover lays out the same way.
 */
export function devtoolsBandRect(
  dock: DevtoolsDock | null,
  hole: Rect | null,
  box: { width: number; height: number }
): Rect | null {
  if (!dock || !hole || box.width <= 0 || box.height <= 0) return null
  const within =
    hole.x >= 0 &&
    hole.y >= 0 &&
    hole.x + hole.width <= box.width &&
    hole.y + hole.height <= box.height
  if (!within) return null
  switch (dock) {
    case 'bottom': {
      const top = hole.y + hole.height
      if (hole.y !== 0 || top >= box.height) return null
      return { x: 0, y: top, width: box.width, height: box.height - top }
    }
    case 'right': {
      const left = hole.x + hole.width
      if (hole.x !== 0 || left >= box.width) return null
      return { x: left, y: 0, width: box.width - left, height: box.height }
    }
    case 'left': {
      if (hole.x <= 0) return null
      return { x: 0, y: 0, width: hole.x, height: box.height }
    }
    default:
      return null
  }
}

/**
 * Moving an open toolbox (the app menu's dock rows): Electron has no call for it, the frontend's
 * `DockController` has – the same path its own buttons take, so the frontend persists the new
 * state as the user's and the toolbox keeps its panel and drawer. Resolves `moved`; rejects
 * when the frontend module is not where this Chromium keeps it, and the host closes and
 * reopens instead.
 */
export function devtoolsMoveScript(dock: DevtoolsDock): string {
  return `import('./ui/legacy/legacy.js').then((legacy) => {
    const controller = legacy.DockController.DockController.instance()
    controller.setDockSide(${JSON.stringify(dock)})
    return 'moved'
  })`
}
