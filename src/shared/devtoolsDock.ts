import type { DevtoolsDock } from './types'

/** Every dock the toolbox can stand in – the frontend's four, each with a row in the menu. */
export const DEVTOOLS_DOCKS: readonly DevtoolsDock[] = ['bottom', 'right', 'left', 'undocked']

/**
 * The docks the app menu offers, in row order (design language v2 §9.29: bottom or right, the
 * last choice remembered, left and undocked on offer – the toolbox's own four, so no dock it can
 * stand in is one the menu cannot show; §9.1 Title Case). Bottom and right lead as §9.29 names
 * them; the toolbox's own Dock side row runs undock · left · bottom · right and is not followed.
 */
export const DEVTOOLS_DOCK_ROWS: readonly { dock: DevtoolsDock; label: string }[] = [
  { dock: 'bottom', label: 'Dock to Bottom' },
  { dock: 'right', label: 'Dock to Right' },
  { dock: 'left', label: 'Dock to Left' },
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
