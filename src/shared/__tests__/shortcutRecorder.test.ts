import { describe, expect, it } from 'vitest'
import { binding, defaultShortcuts, type KeyInput } from '../shortcuts'
import { conflictPrompt, recordKey, replaceConflicts } from '../shortcutRecorder'

const LINUX = defaultShortcuts('linux', 'chrome')
const press = (key: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key,
  control: false,
  alt: false,
  shift: false,
  meta: false,
  ...mods
})
const byId = (id: string): ReturnType<typeof defaultShortcuts>[number] => {
  const s = LINUX.find((x) => x.id === id)
  if (!s) throw new Error(id)
  return s
}

describe('recordKey', () => {
  it('cancels on Escape and unbinds on a bare Backspace or Delete', () => {
    expect(recordKey(press('Escape'), LINUX, 'key_reload')).toEqual({ kind: 'cancel' })
    expect(recordKey(press('Backspace'), LINUX, 'key_reload')).toEqual({ kind: 'unbind' })
    expect(recordKey(press('Delete'), LINUX, 'key_reload')).toEqual({ kind: 'unbind' })
  })

  it('keeps listening through modifiers and plain letters', () => {
    expect(recordKey(press('Control', { control: true }), LINUX, 'key_reload')).toEqual({
      kind: 'ignore'
    })
    expect(recordKey(press('Shift', { shift: true }), LINUX, 'key_reload')).toEqual({
      kind: 'ignore'
    })
    // A letter alone (or with Shift) would break typing in pages.
    expect(recordKey(press('x'), LINUX, 'key_reload')).toEqual({ kind: 'ignore' })
    expect(recordKey(press('X', { shift: true }), LINUX, 'key_reload')).toEqual({ kind: 'ignore' })
  })

  it('binds a free chord, and Ctrl+Backspace is a chord rather than an unbind', () => {
    expect(recordKey(press('x', { control: true, alt: true }), LINUX, 'key_reload')).toEqual({
      kind: 'bind',
      binding: binding('x', { ctrl: true, alt: true }, 'linux')
    })
    expect(
      recordKey(press('Backspace', { control: true, shift: true }), LINUX, 'key_reload')
    ).toEqual({
      kind: 'bind',
      binding: binding('Backspace', { ctrl: true, shift: true }, 'linux')
    })
    // Named keys stand alone, like Zen's F-keys.
    expect(recordKey(press('F8'), LINUX, 'key_reload')).toEqual({
      kind: 'bind',
      binding: binding('F8', {}, 'linux')
    })
  })

  it('reports a chord another shortcut holds instead of taking it (BUG-045)', () => {
    // Ctrl+T is "New Tab"; recording it for Reload must ask first.
    const outcome = recordKey(press('t', { control: true }), LINUX, 'key_reload')
    expect(outcome.kind).toBe('conflict')
    if (outcome.kind !== 'conflict') return
    expect(outcome.conflicts.map((s) => s.id)).toEqual(['key_newNavigatorTab'])
    expect(conflictPrompt(outcome.conflicts)).toBe('Already used by New Tab: replace?')
  })

  it('does not count the shortcut being recorded as its own conflict', () => {
    expect(recordKey(press('r', { control: true }), LINUX, 'key_reload')).toEqual({
      kind: 'bind',
      binding: binding('r', { ctrl: true }, 'linux')
    })
  })

  it('reads Cmd+Option chords from the physical key on macOS', () => {
    const mac = defaultShortcuts('darwin', 'chrome')
    const outcome = recordKey(
      press('©', { meta: true, alt: true, code: 'KeyG' }),
      mac,
      'zen-split-view-grid'
    )
    expect(outcome).toEqual({
      kind: 'bind',
      binding: binding('g', { meta: true, alt: true }, 'darwin')
    })
  })
})

describe('replaceConflicts', () => {
  it('gives the chord to the recorded shortcut and takes it from the one whose primary it was', () => {
    const chord = binding('t', { ctrl: true }, 'linux')
    expect(replaceConflicts('key_reload', chord, [byId('key_newNavigatorTab')])).toEqual([
      { id: 'key_reload', binding: chord },
      { id: 'key_newNavigatorTab', binding: null }
    ])
  })

  it('leaves a shortcut alone when the chord was only one of its alternatives', () => {
    // F5 is Reload's alternative; the table drops taken alternatives by itself.
    const chord = binding('F5', {}, 'linux')
    expect(replaceConflicts('key_stop', chord, [byId('key_reload')])).toEqual([
      { id: 'key_stop', binding: chord }
    ])
  })
})

describe('conflictPrompt', () => {
  it('lists several holders in prose', () => {
    expect(conflictPrompt([byId('key_reload'), byId('key_newNavigatorTab')])).toBe(
      'Already used by Reload and New Tab: replace?'
    )
    expect(
      conflictPrompt([byId('key_reload'), byId('key_newNavigatorTab'), byId('key_find')])
    ).toBe('Already used by Reload, New Tab and Find in Page: replace?')
  })
})
