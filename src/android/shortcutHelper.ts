import type { FormFactor, KeyBinding, Shortcut, ShortcutAction, ShortcutGroup } from '@shared/types'

/**
 * One row of the shortcut table as Android's keyboard-shortcut helper needs it: the system dialog
 * Meta + / opens (`Activity.onProvideKeyboardShortcuts`) lists a label and a chord per row,
 * grouped; Kotlin puts the rows in Chrome's groups from the action. Only the primary chord
 * crosses – Chrome's helper lists primaries alone and keeps the alternates for routing, which the
 * flat `bindings` list beside this one already carries.
 */
export interface HelperShortcut {
  action: ShortcutAction
  group: ShortcutGroup
  /** The Settings page's Title Case words; the helper's fallback where no `helperLabel` is. */
  label: string
  /**
   * The sentence-form words the helper prints for a row Zenium alone has (`Shortcut.helperLabel`);
   * `null` where the table gives none – Chrome's rows, whose words Kotlin holds.
   */
  helperLabel: string | null
  /** The primary chord; `null` when unbound (the helper leaves the row out). */
  binding: KeyBinding | null
  /** An action this build cannot perform: routed (the chord says so), never listed. */
  unsupported: boolean
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
    helperLabel: s.helperLabel ?? null,
    binding: s.binding,
    unsupported: s.unsupported === true,
    hidden: s.hidden === true,
    layouts: s.layouts ?? null
  }))
}
