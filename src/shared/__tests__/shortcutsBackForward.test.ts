import { describe, expect, it } from 'vitest'
import type { Platform } from '../types'
import {
  bindingFor,
  defaultShortcuts,
  formatBinding,
  matchShortcut,
  type KeyInput
} from '../shortcuts'

/*
 * Back and Forward on macOS (history-14): Chrome's History menu says ⌘[ and ⌘] and takes ⌘← and
 * ⌘→ as well. The Chrome preset binds both pairs; the Zen preset keeps to the brackets, and
 * Windows and Linux keep Alt+← / Alt+→ in both. `KeyboardHandler` leaves the arrows to a text
 * field (`keysEditing.test.ts`); this file holds the table alone.
 */

const press = (key: string, mods: Partial<Omit<KeyInput, 'key'>> = {}): KeyInput => ({
  key,
  control: false,
  alt: false,
  shift: false,
  meta: false,
  ...mods
})

const actionOf = (platform: Platform, preset: 'chrome' | 'zen', input: KeyInput): string | null =>
  matchShortcut(defaultShortcuts(platform, preset), input)?.action ?? null

describe('Back and Forward in the Chrome preset on macOS', () => {
  const table = defaultShortcuts('darwin', 'chrome')

  it('answer to ⌘← and ⌘→ as well as to ⌘[ and ⌘]', () => {
    expect(actionOf('darwin', 'chrome', press('ArrowLeft', { meta: true }))).toBe('nav.back')
    expect(actionOf('darwin', 'chrome', press('ArrowRight', { meta: true }))).toBe('nav.forward')
    expect(actionOf('darwin', 'chrome', press('[', { meta: true }))).toBe('nav.back')
    expect(actionOf('darwin', 'chrome', press(']', { meta: true }))).toBe('nav.forward')
  })

  it('keep the brackets as the chord shown in menus and tooltips', () => {
    expect(formatBinding(bindingFor(table, 'nav.back')!, 'darwin')).toBe('⌘[')
    expect(formatBinding(bindingFor(table, 'nav.forward')!, 'darwin')).toBe('⌘]')
    const back = table.find((s) => s.id === 'goBackKb')!
    expect(back.extraBindings.map((b) => formatBinding(b, 'darwin'))).toEqual(['⌘←'])
  })

  it('leave ⇧ and ⌥ variants of the arrows alone (selection, word motion, tab switching)', () => {
    expect(actionOf('darwin', 'chrome', press('ArrowLeft', { meta: true, shift: true }))).toBe(null)
    expect(actionOf('darwin', 'chrome', press('ArrowLeft', { alt: true }))).toBe(null)
    expect(actionOf('darwin', 'chrome', press('ArrowLeft', { meta: true, alt: true }))).toBe(
      'tab.prev'
    )
  })
})

describe('Back and Forward elsewhere', () => {
  it('the Zen preset on macOS keeps to ⌘[ and ⌘]', () => {
    expect(actionOf('darwin', 'zen', press('ArrowLeft', { meta: true }))).toBe(null)
    expect(actionOf('darwin', 'zen', press('ArrowRight', { meta: true }))).toBe(null)
    expect(actionOf('darwin', 'zen', press('[', { meta: true }))).toBe('nav.back')
    expect(actionOf('darwin', 'zen', press(']', { meta: true }))).toBe('nav.forward')
  })

  it.each(['linux', 'win32'] as Platform[])(
    '%s keeps Alt+← / Alt+→ in both presets',
    (platform) => {
      for (const preset of ['chrome', 'zen'] as const) {
        expect(actionOf(platform, preset, press('ArrowLeft', { alt: true }))).toBe('nav.back')
        expect(actionOf(platform, preset, press('ArrowRight', { alt: true }))).toBe('nav.forward')
        expect(actionOf(platform, preset, press('ArrowLeft', { meta: true }))).toBe(null)
        const back = defaultShortcuts(platform, preset).find((s) => s.id === 'goBackKb')!
        expect(back.extraBindings).toEqual([])
      }
    }
  )
})
