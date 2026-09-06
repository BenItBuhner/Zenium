import { isModifierKey, matchShortcut } from '../shared/shortcuts'
import type { Browser } from './browser'
import type { KeyEventInput } from './platform'

/**
 * Routes key events from every web contents (chrome and pages) through Zen's shortcut table.
 * Returns true when the event was consumed so hosts can stop pages from seeing it – the same
 * precedence Firefox gives to browser keybindings.
 */
export class KeyboardHandler {
  constructor(private readonly browser: Browser) {}

  handle(input: KeyEventInput, sourceTabId: string | null): boolean {
    if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return false
    if (isModifierKey(input.key)) return false

    const shortcut = matchShortcut(this.browser.state.shortcuts, input)
    if (shortcut) {
      if (input.isAutoRepeat && !REPEATABLE.has(shortcut.action)) return true
      if (shortcut.unsupported) {
        this.browser.toast(`"${shortcut.label}" is not available in this build yet.`)
        return true
      }
      this.browser.actions.run(shortcut.action, { sourceTabId })
      return true
    }

    if (
      input.key === 'Escape' &&
      sourceTabId !== null &&
      !input.alt &&
      !input.control &&
      !input.meta
    ) {
      // Escape inside a page: close Glance, else stop loading (Firefox behaviour).
      const state = this.browser.state
      if (state.glance) {
        this.browser.tabs.closeGlance()
        return true
      }
      const tab = this.browser.tabs.tab(sourceTabId)
      if (tab?.loading) this.browser.tabs.stop(sourceTabId)
    }
    return false
  }
}

const REPEATABLE = new Set([
  'zoom.in',
  'zoom.out',
  'tab.next',
  'tab.prev',
  'space.next',
  'space.prev',
  'tab.moveBackward',
  'tab.moveForward',
  'find.next',
  'find.prev'
])
