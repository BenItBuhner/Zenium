import type { DevtoolsDock } from './types'

/** Every dock the toolbox can stand in – the menu's three and the toolbox's own `left`. */
export const DEVTOOLS_DOCKS: readonly DevtoolsDock[] = ['bottom', 'right', 'left', 'undocked']

/**
 * The docks the app menu offers, in row order (design language v2 §9.29: bottom or right, the
 * last choice remembered, undocked on offer; §9.1 Title Case).
 */
export const DEVTOOLS_DOCK_ROWS: readonly { dock: DevtoolsDock; label: string }[] = [
  { dock: 'bottom', label: 'Dock to Bottom' },
  { dock: 'right', label: 'Dock to Right' },
  { dock: 'undocked', label: 'Undock' }
]

/**
 * A stored dock read back – from the profile, a `settings.update` patch, or the toolbox's own
 * dock buttons: one of the four, anything else (a profile from before the setting, a corrupt
 * field) falls back to `fallback`.
 */
export function sanitizeDevtoolsDock(value: unknown, fallback: DevtoolsDock): DevtoolsDock {
  return typeof value === 'string' && (DEVTOOLS_DOCKS as readonly string[]).includes(value)
    ? (value as DevtoolsDock)
    : fallback
}

/** Whether the toolbox at `dock` shares the frame's box with the page (§9.29), as against a window of its own. */
export function isDockedInFrame(dock: DevtoolsDock): boolean {
  return dock !== 'undocked'
}
