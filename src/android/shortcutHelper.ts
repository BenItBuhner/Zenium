import type { FormFactor, KeyBinding, Shortcut, ShortcutAction, ShortcutGroup } from '@shared/types'

/**
 * One row of the shortcut table as Android's keyboard-shortcut helper needs it: the system dialog
 * a Meta long-press opens (`Activity.onProvideKeyboardShortcuts`) lists a label and a chord per
 * row, grouped; Kotlin puts the rows in Chrome's groups from the action. Only the primary chord
 * crosses – Chrome's helper lists primaries alone and keeps the alternates for routing, which the
 * flat `bindings` list beside this one already carries.
 */
export interface HelperShortcut {
  action: ShortcutAction
  group: ShortcutGroup
  label: string
  /** The primary chord; `null` when unbound (the helper leaves the row out). */
  binding: KeyBinding | null
  /** Reserved for a feature that has not shipped: routed, never listed. */
  hidden: boolean
  /** The chrome layouts whose listings show the row; `null` when every layout does. */
  layouts: FormFactor[] | null
}

/** The rows the helper can list, in the table's order (the settings page's order). */
export function helperShortcuts(table: readonly Shortcut[]): HelperShortcut[] {
  return table.map((s) => ({
    action: s.action,
    group: s.group,
    label: s.label,
    binding: s.binding,
    hidden: s.hidden === true,
    layouts: s.layouts ?? null
  }))
}
