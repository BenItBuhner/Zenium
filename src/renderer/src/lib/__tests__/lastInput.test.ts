// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { inputKindOf, noteInput, watchLastInput } from '../lastInput'

/*
 * The last input on the root (`data-input`, A11Y-09): a hardware keyboard's navigation says
 * `keyboard` and lets the phone's coarse-pointer ring suppressor stand down; any pointer down
 * says `touch`; what a soft keyboard sends – characters, Enter, Backspace, composition – says
 * nothing, so typing in the omnibox never rings the pill after it.
 */

const key = (key: string, patch: Partial<KeyboardEventInit> = {}): KeyboardEvent =>
  new KeyboardEvent('keydown', { key, bubbles: true, ...patch })

describe('inputKindOf', () => {
  it('reads a hardware keyboard’s navigation as the keyboard: Tab, the arrows, Home / End / Page, Escape, the function keys', () => {
    for (const k of [
      'Tab',
      'ArrowDown',
      'ArrowLeft',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      'Escape',
      'F6',
      'F12'
    ])
      expect(inputKindOf(key(k)), k).toBe('keyboard')
  })

  it('reads a shortcut as the keyboard, a modifier alone as nothing', () => {
    expect(inputKindOf(key('l', { ctrlKey: true }))).toBe('keyboard')
    expect(inputKindOf(key('d', { altKey: true }))).toBe('keyboard')
    expect(inputKindOf(key('t', { metaKey: true }))).toBe('keyboard')
    expect(inputKindOf(key('Control', { ctrlKey: true }))).toBeNull()
    expect(inputKindOf(key('Shift', { shiftKey: true }))).toBeNull()
  })

  it('reads what a soft keyboard sends as nothing: characters, Enter, Backspace, Space, composition', () => {
    for (const k of ['a', 'Z', '1', 'Enter', 'Backspace', ' ', 'Unidentified'])
      expect(inputKindOf(key(k)), k).toBeNull()
    expect(inputKindOf(key('Tab', { isComposing: true }))).toBeNull()
  })

  it('reads any pointer down as a touch', () => {
    expect(inputKindOf({ type: 'pointerdown' })).toBe('touch')
    expect(inputKindOf({ type: 'pointerup' })).toBeNull()
  })
})

describe('the root’s data-input', () => {
  let stop: (() => void) | null = null
  afterEach(() => {
    stop?.()
    stop = null
    delete document.documentElement.dataset.input
  })

  it('follows the last input the window hears, and stays put over a keystroke that says nothing', () => {
    stop = watchLastInput(window)
    const root = document.documentElement
    expect(root.dataset.input).toBeUndefined()
    window.dispatchEvent(key('Tab'))
    expect(root.dataset.input).toBe('keyboard')
    window.dispatchEvent(key('a'))
    window.dispatchEvent(key('Enter'))
    expect(root.dataset.input).toBe('keyboard')
    window.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(root.dataset.input).toBe('touch')
    window.dispatchEvent(key('Enter'))
    expect(root.dataset.input).toBe('touch')
    window.dispatchEvent(key('ArrowDown'))
    expect(root.dataset.input).toBe('keyboard')
  })

  it('hears the event at the capture phase, before a handler that stops it', () => {
    stop = watchLastInput(window)
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.addEventListener('keydown', (e) => e.stopPropagation())
    button.dispatchEvent(key('Tab'))
    expect(document.documentElement.dataset.input).toBe('keyboard')
    button.remove()
  })

  it('writes the root once per change', () => {
    const root = document.createElement('div')
    noteInput('touch', root)
    expect(root.dataset.input).toBe('touch')
    noteInput('touch', root)
    expect(root.dataset.input).toBe('touch')
    noteInput('keyboard', root)
    expect(root.dataset.input).toBe('keyboard')
  })

  // The module watches from its import: an entry that leaves it out has no `data-input`, and the
  // phone's suppressor never stands down (the first emulator run of the fix: the Android entry
  // is `src/android/main.tsx`, not the desktop's, and only the desktop's imported it).
  it('is imported by both chrome entries, the desktop’s and the Android WebView’s', () => {
    for (const entry of ['../../main.tsx', '../../../../android/main.tsx']) {
      const source = readFileSync(fileURLToPath(new URL(entry, import.meta.url)), 'utf8')
      expect(source, entry).toMatch(/^import '(\.\/lib|@renderer\/lib)\/lastInput'$/m)
    }
  })
})
