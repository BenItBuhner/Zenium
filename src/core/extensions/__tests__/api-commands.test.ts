import { describe, expect, it } from 'vitest'
import {
  EXECUTE_ACTION_COMMANDS,
  MAX_SUGGESTED_KEYS,
  commandForBinding,
  describeUnbound,
  formatCommandShortcut,
  parseSuggestedKey,
  resolveCommands,
  suggestedKeyFor,
  type TakenBinding
} from '../api/commands'
import type { ManifestCommand } from '../manifest'
import { defaultShortcuts } from '../../../shared/shortcuts'
import type { KeyBinding } from '../../../shared/types'

const binding = (key: string, mods: Partial<KeyBinding> = {}): KeyBinding => ({
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
  key,
  ...mods
})

const LINUX = defaultShortcuts('linux')

describe('suggestedKeyFor', () => {
  it('takes the platform entry, then default, and a plain string as is', () => {
    const command: ManifestCommand = {
      suggested_key: { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+Y', linux: 'Alt+Y' }
    }
    expect(suggestedKeyFor(command, 'linux')).toBe('Alt+Y')
    expect(suggestedKeyFor(command, 'darwin')).toBe('Command+Shift+Y')
    expect(suggestedKeyFor(command, 'win32')).toBe('Ctrl+Shift+Y')
    expect(suggestedKeyFor({ suggested_key: 'Ctrl+B' }, 'win32')).toBe('Ctrl+B')
    expect(suggestedKeyFor({ description: 'no key' }, 'linux')).toBeNull()
    // Android is resolved like Linux (the key names are the same table).
    expect(suggestedKeyFor(command, 'android')).toBe('Alt+Y')
  })

  it('returns null when only other platforms have a key', () => {
    expect(suggestedKeyFor({ suggested_key: { mac: 'Command+B' } }, 'linux')).toBeNull()
  })
})

describe('parseSuggestedKey', () => {
  it('parses Chrome key strings into normalised bindings', () => {
    expect(parseSuggestedKey('Ctrl+Shift+Y', 'linux')).toEqual(
      binding('y', { ctrl: true, shift: true })
    )
    expect(parseSuggestedKey('Alt+Comma', 'win32')).toEqual(binding(',', { alt: true }))
    expect(parseSuggestedKey('Ctrl+Up', 'linux')).toEqual(binding('ArrowUp', { ctrl: true }))
    expect(parseSuggestedKey('Ctrl+F5', 'linux')).toEqual(binding('F5', { ctrl: true }))
    expect(parseSuggestedKey('Alt+Space', 'linux')).toEqual(binding(' ', { alt: true }))
    expect(parseSuggestedKey('Ctrl+1', 'linux')).toEqual(binding('1', { ctrl: true }))
  })

  it('maps Ctrl to Command on macOS and keeps MacCtrl as the Control key', () => {
    expect(parseSuggestedKey('Ctrl+B', 'darwin')).toEqual(binding('b', { meta: true }))
    expect(parseSuggestedKey('Command+B', 'darwin')).toEqual(binding('b', { meta: true }))
    expect(parseSuggestedKey('MacCtrl+B', 'darwin')).toEqual(binding('b', { ctrl: true }))
    // Command and MacCtrl are macOS-only tokens.
    expect(parseSuggestedKey('Command+B', 'linux')).toBeNull()
    expect(parseSuggestedKey('MacCtrl+B', 'win32')).toBeNull()
  })

  it('refuses what Chrome refuses', () => {
    // A shortcut needs Ctrl or Alt (Shift alone is not enough), and Ctrl+Alt is AltGr.
    expect(parseSuggestedKey('Shift+B', 'linux')).toBeNull()
    expect(parseSuggestedKey('B', 'linux')).toBeNull()
    expect(parseSuggestedKey('Ctrl+Alt+B', 'linux')).toBeNull()
    // Two non-modifier keys, unknown tokens, and Search.
    expect(parseSuggestedKey('Ctrl+A+B', 'linux')).toBeNull()
    expect(parseSuggestedKey('Ctrl+Escape', 'linux')).toBeNull()
    expect(parseSuggestedKey('Search+B', 'linux')).toBeNull()
    expect(parseSuggestedKey('Ctrl+F13', 'linux')).toBeNull()
    // Lower-case letters are not Chrome's syntax.
    expect(parseSuggestedKey('Ctrl+b', 'linux')).toBeNull()
  })

  it('accepts media keys without modifiers and rejects them with', () => {
    expect(parseSuggestedKey('MediaPlayPause', 'linux')).toEqual(binding('MediaPlayPause'))
    expect(parseSuggestedKey('MediaNextTrack', 'linux')).toEqual(binding('MediaTrackNext'))
    expect(parseSuggestedKey('Ctrl+MediaPlayPause', 'linux')).toBeNull()
  })

  it('lets Command+Option through on macOS (only Ctrl+Alt is refused)', () => {
    expect(parseSuggestedKey('Command+Alt+B', 'darwin')).toEqual(
      binding('b', { meta: true, alt: true })
    )
    expect(parseSuggestedKey('MacCtrl+Alt+B', 'darwin')).toBeNull()
  })
})

describe('formatCommandShortcut', () => {
  it('uses Chrome names on Windows / Linux and symbols on macOS, empty when unbound', () => {
    expect(formatCommandShortcut(binding('y', { ctrl: true, shift: true }), 'linux')).toBe(
      'Ctrl+Shift+Y'
    )
    expect(formatCommandShortcut(binding(',', { alt: true }), 'win32')).toBe('Alt+Comma')
    expect(formatCommandShortcut(binding('ArrowUp', { ctrl: true }), 'linux')).toBe('Ctrl+Up')
    expect(formatCommandShortcut(binding('MediaTrackNext'), 'linux')).toBe('MediaNextTrack')
    expect(formatCommandShortcut(binding('b', { meta: true, shift: true }), 'darwin')).toBe(
      '\u21e7\u2318B'
    )
    expect(formatCommandShortcut(binding('b', { ctrl: true, alt: true }), 'darwin')).toBe(
      '\u2303\u2325B'
    )
    expect(formatCommandShortcut(null, 'linux')).toBe('')
  })
})

describe('resolveCommands', () => {
  const manifest = (entries: Record<string, string | undefined>): Record<string, ManifestCommand> =>
    Object.fromEntries(
      Object.entries(entries).map(([name, key]) => [
        name,
        key === undefined ? { description: name } : { suggested_key: key, description: name }
      ])
    )

  it('binds free keys in manifest order and leaves keyless commands unbound without a reason', () => {
    const out = resolveCommands(
      manifest({ one: 'Ctrl+Shift+1', two: undefined }),
      'linux',
      LINUX,
      []
    )
    expect(out.map((c) => c.name)).toEqual(['one', 'two'])
    expect(out[0].binding).toEqual(binding('1', { ctrl: true, shift: true }))
    expect(out[0].unbound).toBeNull()
    expect(out[1]).toMatchObject({ binding: null, suggested: null, unbound: null })
  })

  it('never takes a key Zenium uses and names the shortcut', () => {
    // Ctrl+T is Zenium's New Tab on Linux.
    const [command] = resolveCommands(manifest({ grab: 'Ctrl+T' }), 'linux', LINUX, [])
    expect(command.binding).toBeNull()
    expect(command.unbound).toBe('zenium-shortcut')
    expect(command.conflictsWith).toBe('New Tab')
    expect(describeUnbound(command)).toBe('grab: the key is used by "New Tab"')
  })

  it('does not bind a key another extension already holds', () => {
    const taken: TakenBinding[] = [
      { binding: binding('9', { ctrl: true, shift: true }), owner: 'Other: jump' }
    ]
    const [command] = resolveCommands(manifest({ jump: 'Ctrl+Shift+9' }), 'linux', LINUX, taken)
    expect(command).toMatchObject({
      binding: null,
      unbound: 'other-extension',
      conflictsWith: 'Other: jump'
    })
    expect(describeUnbound(command)).toBe('jump: the key is used by Other: jump')
  })

  it('gives a key to the first command of the extension that asks for it', () => {
    const out = resolveCommands(
      manifest({ first: 'Alt+Shift+8', second: 'Alt+Shift+8' }),
      'linux',
      LINUX,
      []
    )
    expect(out[0].binding).not.toBeNull()
    expect(out[1]).toMatchObject({
      binding: null,
      unbound: 'other-extension',
      conflictsWith: 'first'
    })
  })

  it(`binds at most ${MAX_SUGGESTED_KEYS} suggested keys, _execute_action not counted`, () => {
    const out = resolveCommands(
      manifest({
        _execute_action: 'Alt+Shift+0',
        a: 'Alt+Shift+1',
        b: 'Alt+Shift+2',
        c: 'Alt+Shift+3',
        d: 'Alt+Shift+4',
        e: 'Alt+Shift+5'
      }),
      'linux',
      LINUX,
      []
    )
    const bound = out.filter((c) => c.binding !== null).map((c) => c.name)
    expect(bound).toEqual(['_execute_action', 'a', 'b', 'c', 'd'])
    expect(out[5]).toMatchObject({ name: 'e', unbound: 'too-many-suggested-keys' })
    expect(describeUnbound(out[5])).toContain(`only ${MAX_SUGGESTED_KEYS} suggested shortcuts`)
    expect(EXECUTE_ACTION_COMMANDS.has('_execute_browser_action')).toBe(true)
  })

  it('reports malformed and platform-less keys distinctly', () => {
    const out = resolveCommands(
      {
        bad: { suggested_key: 'Shift+B' },
        macOnly: { suggested_key: { mac: 'Command+B' } }
      },
      'linux',
      LINUX,
      []
    )
    expect(out[0]).toMatchObject({ unbound: 'invalid-key', suggested: null })
    expect(out[1]).toMatchObject({ unbound: 'no-key-for-platform', suggested: null })
    expect(describeUnbound(out[0])).toBe('bad: the suggested key is not a valid shortcut')
    expect(describeUnbound(out[1])).toBe('macOnly: no suggested key for this platform')
  })

  it('keeps the global flag but binds the key per window like any other', () => {
    const [command] = resolveCommands(
      { wake: { suggested_key: 'Ctrl+Shift+8', global: true } },
      'linux',
      LINUX,
      []
    )
    expect(command.global).toBe(true)
    expect(command.binding).toEqual(binding('8', { ctrl: true, shift: true }))
  })

  it('returns nothing for a manifest without commands', () => {
    expect(resolveCommands(undefined, 'linux', LINUX, [])).toEqual([])
  })
})

describe('commandForBinding', () => {
  it('finds the bound command for a pressed key and ignores unbound ones', () => {
    const commands = resolveCommands(
      manifestOf({ hit: 'Ctrl+Shift+7', miss: 'Ctrl+T' }),
      'linux',
      LINUX,
      []
    )
    expect(commandForBinding(commands, binding('7', { ctrl: true, shift: true }))?.name).toBe('hit')
    expect(commandForBinding(commands, binding('t', { ctrl: true }))).toBeNull()
    expect(commandForBinding(commands, binding('7', { ctrl: true }))).toBeNull()
  })
})

function manifestOf(entries: Record<string, string>): Record<string, ManifestCommand> {
  return Object.fromEntries(
    Object.entries(entries).map(([name, key]) => [name, { suggested_key: key }])
  )
}
