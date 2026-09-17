/**
 * `chrome.commands`, the host-neutral part: parse the manifest's `commands` block the way Chrome's
 * `Command::Parse` does (per-platform `suggested_key`, modifier rules, the four-suggested-keys
 * limit), turn the bindings into Zenium `KeyBinding`s, and decide which of them may actually be
 * bound: an extension never takes a key Zenium's own shortcut table uses, and the first extension
 * to claim a key keeps it.
 */
import type { ManifestCommand, ManifestCommandPlatform } from '../manifest'
import type { KeyBinding, Platform, Shortcut } from '../../../shared/types'
import { bindingsEqual, findConflicts } from '../../../shared/shortcuts'

/** Commands Chrome routes to the toolbar action instead of `commands.onCommand`. */
export const EXECUTE_ACTION_COMMANDS = new Set([
  '_execute_action',
  '_execute_browser_action',
  '_execute_page_action'
])

/** Chrome's `kMaxCommandsWithKeybindingPerExtension`. */
export const MAX_SUGGESTED_KEYS = 4

export type CommandUnboundReason =
  | 'invalid-key'
  | 'no-key-for-platform'
  | 'too-many-suggested-keys'
  | 'zenium-shortcut'
  | 'other-extension'
  | 'global-unsupported'

export interface ExtensionCommand {
  name: string
  description: string
  /** Whether the manifest asked for a global (system-wide) shortcut; Zenium binds them per window. */
  global: boolean
  /** The manifest's key for this platform, or null when it has none or it is malformed. */
  suggested: KeyBinding | null
  /** The key the command is actually bound to; null when unbound. */
  binding: KeyBinding | null
  /** Why `binding` is null although the manifest suggested a key. */
  unbound: CommandUnboundReason | null
  /** The shortcut label that took the key when `unbound` is `zenium-shortcut` / `other-extension`. */
  conflictsWith: string | null
}

const PLATFORM_KEYS: Record<Platform, ManifestCommandPlatform> = {
  linux: 'linux',
  win32: 'windows',
  darwin: 'mac',
  android: 'linux'
}

const MEDIA_KEYS: Record<string, string> = {
  MediaNextTrack: 'MediaTrackNext',
  MediaPlayPause: 'MediaPlayPause',
  MediaPrevTrack: 'MediaTrackPrevious',
  MediaStop: 'MediaStop'
}

const NAMED_KEYS: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Space: ' ',
  Insert: 'Insert',
  Delete: 'Delete',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight'
}

/** The `suggested_key` entry Chrome picks for a platform: the platform's own, else `default`. */
export function suggestedKeyFor(command: ManifestCommand, platform: Platform): string | null {
  const key = command.suggested_key
  if (key === undefined) return null
  if (typeof key === 'string') return key
  const own = key[PLATFORM_KEYS[platform]]
  if (typeof own === 'string') return own
  const fallback = key.default
  return typeof fallback === 'string' ? fallback : null
}

/**
 * Parse one `suggested_key` string (`Ctrl+Shift+Y`, `Command+Comma`, `MediaPlayPause`) into a
 * binding, following `Command::ParseImpl`: `Ctrl` is Command on macOS (`MacCtrl` is the Control
 * key there), `Command` / `MacCtrl` are macOS-only, a shortcut needs Ctrl or Alt (or Command) unless
 * it is a media key, Shift alone is not enough, and Ctrl+Alt is refused because it is AltGr on
 * many keyboards. Returns null for anything Chrome rejects.
 */
export function parseSuggestedKey(value: string, platform: Platform): KeyBinding | null {
  const mac = platform === 'darwin'
  const tokens = value.split('+')
  let ctrl = false
  let alt = false
  let shift = false
  let meta = false
  let key: string | null = null
  let media = false
  for (const token of tokens) {
    switch (token) {
      case 'Ctrl':
        if (mac) meta = true
        else ctrl = true
        break
      case 'Command':
        if (!mac) return null
        meta = true
        break
      case 'MacCtrl':
        if (!mac) return null
        ctrl = true
        break
      case 'Alt':
        alt = true
        break
      case 'Shift':
        shift = true
        break
      case 'Search':
        return null
      default: {
        if (key !== null) return null
        const mapped = mapKeyToken(token)
        if (mapped === null) return null
        key = mapped.key
        media = mapped.media
      }
    }
  }
  if (key === null) return null
  if (media) {
    if (ctrl || alt || shift || meta) return null
    return { ctrl: false, alt: false, shift: false, meta: false, key }
  }
  if (!ctrl && !alt && !meta) return null
  // Command+Option is fine on macOS; only Ctrl+Alt is refused (it is AltGr on many keyboards).
  if (ctrl && alt) return null
  return { ctrl, alt, shift, meta, key }
}

function mapKeyToken(token: string): { key: string; media: boolean } | null {
  if (/^[A-Z]$/.test(token)) return { key: token.toLowerCase(), media: false }
  if (/^[0-9]$/.test(token)) return { key: token, media: false }
  if (token in NAMED_KEYS) return { key: NAMED_KEYS[token], media: false }
  if (token in MEDIA_KEYS) return { key: MEDIA_KEYS[token], media: true }
  if (/^F([1-9]|1[0-2])$/.test(token)) return { key: token, media: false }
  return null
}

const SHORTCUT_KEY_NAMES: Record<string, string> = {
  ',': 'Comma',
  '.': 'Period',
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPrevTrack'
}

/**
 * The `shortcut` string `commands.getAll` reports: Chrome's `Ctrl+Shift+Y` form on Windows and
 * Linux, the symbol form on macOS. Empty when unbound.
 */
export function formatCommandShortcut(binding: KeyBinding | null, platform: Platform): string {
  if (!binding) return ''
  const key =
    SHORTCUT_KEY_NAMES[binding.key] ??
    (binding.key.length === 1 ? binding.key.toUpperCase() : binding.key)
  if (platform === 'darwin') {
    let out = ''
    if (binding.ctrl) out += '\u2303'
    if (binding.alt) out += '\u2325'
    if (binding.shift) out += '\u21e7'
    if (binding.meta) out += '\u2318'
    return out + key
  }
  const parts: string[] = []
  if (binding.ctrl) parts.push('Ctrl')
  if (binding.alt) parts.push('Alt')
  if (binding.shift) parts.push('Shift')
  if (binding.meta) parts.push('Meta')
  parts.push(key)
  return parts.join('+')
}

/** A key already taken by another extension, for conflict detection across extensions. */
export interface TakenBinding {
  binding: KeyBinding
  /** Human readable owner (`<extension name>: <command>`). */
  owner: string
}

/**
 * Parse an extension's commands and decide their bindings. `shortcuts` is Zenium's effective
 * shortcut table (defaults plus user overrides); `taken` lists keys other loaded extensions hold.
 * Commands come out in manifest order; `_execute_*` commands are included (their `onCommand` never
 * fires, the host opens the action instead).
 */
export function resolveCommands(
  manifestCommands: Record<string, ManifestCommand> | undefined,
  platform: Platform,
  shortcuts: readonly Shortcut[],
  taken: readonly TakenBinding[]
): ExtensionCommand[] {
  const out: ExtensionCommand[] = []
  if (!manifestCommands) return out
  const claimed: KeyBinding[] = []
  let suggestedCount = 0
  for (const [name, command] of Object.entries(manifestCommands)) {
    const description = typeof command.description === 'string' ? command.description : ''
    const global = command.global === true
    const raw = suggestedKeyFor(command, platform)
    const entry: ExtensionCommand = {
      name,
      description,
      global,
      suggested: null,
      binding: null,
      unbound: null,
      conflictsWith: null
    }
    if (raw === null) {
      if (command.suggested_key !== undefined) entry.unbound = 'no-key-for-platform'
      out.push(entry)
      continue
    }
    const suggested = parseSuggestedKey(raw, platform)
    if (!suggested) {
      entry.unbound = 'invalid-key'
      out.push(entry)
      continue
    }
    entry.suggested = suggested
    if (!EXECUTE_ACTION_COMMANDS.has(name)) {
      suggestedCount += 1
      if (suggestedCount > MAX_SUGGESTED_KEYS) {
        entry.unbound = 'too-many-suggested-keys'
        out.push(entry)
        continue
      }
    }
    const zenium = findConflicts([...shortcuts], suggested, '')
    if (zenium.length > 0) {
      entry.unbound = 'zenium-shortcut'
      entry.conflictsWith = zenium[0].label
      out.push(entry)
      continue
    }
    const other = taken.find((t) => bindingsEqual(t.binding, suggested))
    if (other) {
      entry.unbound = 'other-extension'
      entry.conflictsWith = other.owner
      out.push(entry)
      continue
    }
    if (claimed.some((c) => bindingsEqual(c, suggested))) {
      entry.unbound = 'other-extension'
      entry.conflictsWith =
        out.find((c) => c.binding && bindingsEqual(c.binding, suggested))?.name ?? null
      out.push(entry)
      continue
    }
    claimed.push(suggested)
    entry.binding = suggested
    out.push(entry)
  }
  return out
}

/** The command bound to a pressed key, if any. */
export function commandForBinding(
  commands: readonly ExtensionCommand[],
  pressed: KeyBinding
): ExtensionCommand | null {
  for (const command of commands) {
    if (command.binding && bindingsEqual(command.binding, pressed)) return command
  }
  return null
}

/** A one-line description of a conflict for `ExtensionInfo.commandConflicts`. */
export function describeUnbound(command: ExtensionCommand): string | null {
  switch (command.unbound) {
    case null:
      return null
    case 'invalid-key':
      return `${command.name}: the suggested key is not a valid shortcut`
    case 'no-key-for-platform':
      return `${command.name}: no suggested key for this platform`
    case 'too-many-suggested-keys':
      return `${command.name}: only ${MAX_SUGGESTED_KEYS} suggested shortcuts are bound per extension`
    case 'zenium-shortcut':
      return `${command.name}: the key is used by "${command.conflictsWith ?? 'a Zenium shortcut'}"`
    case 'other-extension':
      return `${command.name}: the key is used by ${command.conflictsWith ?? 'another extension'}`
    case 'global-unsupported':
      return `${command.name}: global shortcuts are not supported`
  }
}
