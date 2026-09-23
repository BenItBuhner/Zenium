import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEVTOOLS_DOCK_HOOK_SCRIPT,
  DEVTOOLS_DOCK_MESSAGE_PREFIX,
  DEVTOOLS_SEAM_COLORS,
  DEVTOOLS_SEAM_SCRIPT,
  devtoolsMoveScript,
  dockFromConsoleMessage
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
})
