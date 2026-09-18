import type { KeyBinding, Shortcut } from './types'
import {
  bindingFromInput,
  bindingMatches,
  findConflicts,
  isModifierKey,
  type KeyInput
} from './shortcuts'

/**
 * What a key press means to the Settings recorder while it listens for the chord of one
 * shortcut. Pure: the recorder component keeps the phase, this decides the step.
 */
export type RecorderOutcome =
  /** Escape: stop listening, nothing changes. */
  | { kind: 'cancel' }
  /** Backspace or Delete on their own: the shortcut loses its chord. */
  | { kind: 'unbind' }
  /** A modifier alone, or a plain key that would break typing in pages: keep listening. */
  | { kind: 'ignore' }
  /** A free chord: bind it. */
  | { kind: 'bind'; binding: KeyBinding }
  /** A chord other shortcuts hold: ask before taking it from them. */
  | { kind: 'conflict'; binding: KeyBinding; conflicts: Shortcut[] }

export function recordKey(input: KeyInput, shortcuts: Shortcut[], id: string): RecorderOutcome {
  if (input.key === 'Escape') return { kind: 'cancel' }
  const bare = !input.control && !input.alt && !input.meta && !input.shift
  if (bare && (input.key === 'Backspace' || input.key === 'Delete')) return { kind: 'unbind' }
  if (isModifierKey(input.key)) return { kind: 'ignore' }
  const binding = bindingFromInput(input)
  // Plain letters (with or without Shift) would break typing in pages: a chord needs Ctrl, Alt
  // or Cmd. Keys with a name of their own (F5, F11, PageUp) are fine alone, as Zen has them.
  if (!binding.ctrl && !binding.alt && !binding.meta && binding.key.length === 1)
    return { kind: 'ignore' }
  const conflicts = findConflicts(shortcuts, binding, id)
  return conflicts.length > 0 ? { kind: 'conflict', binding, conflicts } : { kind: 'bind', binding }
}

/**
 * The updates that give `id` a chord other shortcuts hold: `id` takes it, and a shortcut whose
 * primary chord it was loses that chord. One whose built-in alternative it was needs nothing –
 * the user's choice takes alternatives away by itself when the table is built.
 */
export function replaceConflicts(
  id: string,
  binding: KeyBinding,
  conflicts: Shortcut[]
): Array<{ id: string; binding: KeyBinding | null }> {
  const updates: Array<{ id: string; binding: KeyBinding | null }> = [{ id, binding }]
  for (const other of conflicts) {
    if (other.id !== id && bindingMatches(other.binding, binding))
      updates.push({ id: other.id, binding: null })
  }
  return updates
}

/** "Already used by Reload: replace?" – the prompt of a conflicting chord. */
export function conflictPrompt(conflicts: Shortcut[]): string {
  const names = conflicts.map((s) => s.label)
  const list =
    names.length <= 2
      ? names.join(' and ')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `Already used by ${list}: replace?`
}
