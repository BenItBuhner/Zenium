import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEVTOOLS_DOCK_HOOK_SCRIPT,
  DEVTOOLS_DOCK_MESSAGE_PREFIX,
  DEVTOOLS_PAGE_BOUNDS_HOOK_SCRIPT,
  DEVTOOLS_PAGE_BOUNDS_MESSAGE_PREFIX,
  DEVTOOLS_SEAM_COLORS,
  DEVTOOLS_SEAM_SCRIPT,
  devtoolsBandRect,
  devtoolsMoveScript,
  dockFromConsoleMessage,
  pageBoundsFromConsoleMessage
} from '../devtoolsFrontend'

/** The chrome's stylesheet, where `--v2-border` is declared for light and for dark. */
const MAIN_CSS = readFileSync(join(__dirname, '../../../renderer/src/assets/main.css'), 'utf8')

describe('the DevTools frontend scripts (v2 §9.29)', () => {
  it('mirrors the chrome’s --v2-border for the seam, light and dark, as main.css declares them', () => {
    const declared = [...MAIN_CSS.matchAll(/^\s*--v2-border:\s*([^;]+);/gm)].map((m) => m[1].trim())
    expect(declared).toEqual([DEVTOOLS_SEAM_COLORS.light, DEVTOOLS_SEAM_COLORS.dark])
    expect(DEVTOOLS_SEAM_SCRIPT).toContain(DEVTOOLS_SEAM_COLORS.light)
    expect(DEVTOOLS_SEAM_SCRIPT).toContain(DEVTOOLS_SEAM_COLORS.dark)
  })

  it('touches the split widget’s sidebar border alone, keyed on the frontend’s own dark class', () => {
    expect(DEVTOOLS_SEAM_SCRIPT).toContain('.root-view > .split-widget')
    expect(DEVTOOLS_SEAM_SCRIPT).toContain('.shadow-split-widget-sidebar { border-color:')
    expect(DEVTOOLS_SEAM_SCRIPT).toContain(':host-context(.theme-with-dark-background)')
    expect(DEVTOOLS_SEAM_SCRIPT).not.toContain('prefers-color-scheme')
    // Idempotent: a second run finds its own style.
    expect(DEVTOOLS_SEAM_SCRIPT).toContain("querySelector('#zenium-seam')")
  })

  it('hooks setIsDocked once and says the persisted dock on the console', () => {
    expect(DEVTOOLS_DOCK_HOOK_SCRIPT).toContain('host.setIsDocked = function')
    expect(DEVTOOLS_DOCK_HOOK_SCRIPT).toContain('__zeniumDockHook')
    expect(DEVTOOLS_DOCK_HOOK_SCRIPT).toContain('currentDockState')
    expect(DEVTOOLS_DOCK_HOOK_SCRIPT).toContain(JSON.stringify(DEVTOOLS_DOCK_MESSAGE_PREFIX))
  })

  it('reads a dock back from the frontend’s line and nothing else', () => {
    expect(dockFromConsoleMessage('zenium-devtools-dock:bottom')).toBe('bottom')
    expect(dockFromConsoleMessage('zenium-devtools-dock:right')).toBe('right')
    expect(dockFromConsoleMessage('zenium-devtools-dock:left')).toBe('left')
    expect(dockFromConsoleMessage('zenium-devtools-dock:undocked')).toBe('undocked')
    expect(dockFromConsoleMessage('zenium-devtools-dock:error')).toBeNull()
    expect(dockFromConsoleMessage('zenium-devtools-dock:detach')).toBeNull()
    expect(dockFromConsoleMessage('Request Autofill.enable failed.')).toBeNull()
    expect(dockFromConsoleMessage('')).toBeNull()
  })

  it('moves through the frontend’s DockController with the dock as a JSON word', () => {
    const script = devtoolsMoveScript('right')
    expect(script).toContain("import('./ui/legacy/legacy.js')")
    expect(script).toContain('DockController.DockController.instance()')
    expect(script).toContain('setDockSide("right")')
  })

  /*
   * The page's hole read back (W5-5, §9.5's budget for the cover's toolbox picture): a wrapper on
   * `setInspectedPageBounds` says every rect the frontend lays the page out at, and asks for the
   * one laid out before the hook through the placeholder's plain `update()` – the forced one
   * sends a height one off first, for Lighthouse – or, without the module, the root view's resize.
   */
  it('hooks setInspectedPageBounds once, says each rect on the console and asks for the current one again', () => {
    expect(DEVTOOLS_PAGE_BOUNDS_HOOK_SCRIPT).toContain('host.setInspectedPageBounds = function')
    expect(DEVTOOLS_PAGE_BOUNDS_HOOK_SCRIPT).toContain('__zeniumPageBoundsHook')
    expect(DEVTOOLS_PAGE_BOUNDS_HOOK_SCRIPT).toContain(
      JSON.stringify(DEVTOOLS_PAGE_BOUNDS_MESSAGE_PREFIX)
    )
    expect(DEVTOOLS_PAGE_BOUNDS_HOOK_SCRIPT).toContain(
      '[bounds.x, bounds.y, bounds.width, bounds.height]'
    )
    // The wrapped call still reaches Electron: the page is laid out as before.
    expect(DEVTOOLS_PAGE_BOUNDS_HOOK_SCRIPT).toContain('return orig.call(this, bounds)')
    expect(DEVTOOLS_PAGE_BOUNDS_HOOK_SCRIPT).toContain("import('./ui/legacy/legacy.js')")
    expect(DEVTOOLS_PAGE_BOUNDS_HOOK_SCRIPT).toContain(
      'InspectedPagePlaceholder.InspectedPagePlaceholder.instance().update()'
    )
    expect(DEVTOOLS_PAGE_BOUNDS_HOOK_SCRIPT).not.toContain('update(true)')
    expect(DEVTOOLS_PAGE_BOUNDS_HOOK_SCRIPT).toContain("window.dispatchEvent(new Event('resize'))")
  })

  it('reads a hole back from the frontend’s line and nothing else', () => {
    expect(pageBoundsFromConsoleMessage('zenium-devtools-page-bounds:0,0,1352,690')).toEqual({
      x: 0,
      y: 0,
      width: 1352,
      height: 690
    })
    expect(pageBoundsFromConsoleMessage('zenium-devtools-page-bounds:0,0,900,984')).toEqual({
      x: 0,
      y: 0,
      width: 900,
      height: 984
    })
    expect(pageBoundsFromConsoleMessage('zenium-devtools-page-bounds:452,0,900,984')).toEqual({
      x: 452,
      y: 0,
      width: 900,
      height: 984
    })
    // Not a rect: too few parts, a word, an empty or a negative side.
    expect(pageBoundsFromConsoleMessage('zenium-devtools-page-bounds:0,0,1352')).toBeNull()
    expect(pageBoundsFromConsoleMessage('zenium-devtools-page-bounds:0,0,wide,690')).toBeNull()
    expect(pageBoundsFromConsoleMessage('zenium-devtools-page-bounds:0,0,1352,0')).toBeNull()
    expect(pageBoundsFromConsoleMessage('zenium-devtools-page-bounds:-1,0,1352,690')).toBeNull()
    // The dock line and the frontend's own logging are not holes.
    expect(pageBoundsFromConsoleMessage('zenium-devtools-dock:bottom')).toBeNull()
    expect(pageBoundsFromConsoleMessage('Request Autofill.enable failed.')).toBeNull()
    expect(pageBoundsFromConsoleMessage('')).toBeNull()
  })

  it('cuts the toolbox’s band beside the page’s hole per dock, the seam at its edge, in the box’s DIP', () => {
    const box = { width: 1352, height: 984 }
    // A bottom dock: the band is the box's width under the hole.
    expect(devtoolsBandRect('bottom', { x: 0, y: 0, width: 1352, height: 690 }, box)).toEqual({
      x: 0,
      y: 690,
      width: 1352,
      height: 294
    })
    // A right dock: the band is the box's height right of the hole.
    expect(devtoolsBandRect('right', { x: 0, y: 0, width: 900, height: 984 }, box)).toEqual({
      x: 900,
      y: 0,
      width: 452,
      height: 984
    })
    // A left dock: the band is the box's height left of the hole.
    expect(devtoolsBandRect('left', { x: 452, y: 0, width: 900, height: 984 }, box)).toEqual({
      x: 0,
      y: 0,
      width: 452,
      height: 984
    })
  })

  it('makes no band – the whole box is pictured – without a hole, undocked, or from a hole that is not where the dock puts it', () => {
    const box = { width: 1352, height: 984 }
    expect(devtoolsBandRect('bottom', null, box)).toBeNull()
    expect(devtoolsBandRect(null, { x: 0, y: 0, width: 1352, height: 690 }, box)).toBeNull()
    expect(devtoolsBandRect('undocked', { x: 0, y: 0, width: 1352, height: 690 }, box)).toBeNull()
    // A right dock's hole read while the dock says bottom (a layout mid-change), and the other way.
    expect(devtoolsBandRect('bottom', { x: 0, y: 0, width: 900, height: 984 }, box)).toBeNull()
    expect(devtoolsBandRect('right', { x: 0, y: 0, width: 1352, height: 690 }, box)).toBeNull()
    expect(devtoolsBandRect('left', { x: 0, y: 0, width: 900, height: 984 }, box)).toBeNull()
    // A hole outside the box (a stale reading from a larger window), or one that is the box.
    expect(devtoolsBandRect('bottom', { x: 0, y: 0, width: 1600, height: 690 }, box)).toBeNull()
    expect(devtoolsBandRect('bottom', { x: 0, y: 0, width: 1352, height: 984 }, box)).toBeNull()
    expect(devtoolsBandRect('right', { x: 0, y: 0, width: 1352, height: 984 }, box)).toBeNull()
    // No box yet.
    expect(
      devtoolsBandRect('bottom', { x: 0, y: 0, width: 1352, height: 690 }, { width: 0, height: 0 })
    ).toBeNull()
  })
})
