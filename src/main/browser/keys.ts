import type { Event, Input } from 'electron'
import { isModifierKey, matchShortcut } from '../../shared/shortcuts'
import type { Browser } from './browser'

/**
 * Routes `before-input-event` from every web contents (chrome and pages) through Zen's shortcut
 * table. Matching shortcuts are consumed so pages never see them – the same precedence Firefox
 * gives to browser keybindings.
 */
export class KeyboardHandler {
  constructor(private readonly browser: Browser) {}

  handle(event: Event, input: Input, sourceTabId: string | null): void {
    if (input.type !== 'keyDown') return
    if (isModifierKey(input.key)) return

    const shortcut = matchShortcut(this.browser.state.shortcuts, input)
    if (shortcut) {
      event.preventDefault()
      if (input.isAutoRepeat && !REPEATABLE.has(shortcut.action)) return
      if (shortcut.unsupported) {
        this.browser.toast(`"${shortcut.label}" is not available in this build yet.`)
        return
      }
      this.browser.actions.run(shortcut.action, { sourceTabId })
      return
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
        event.preventDefault()
        this.browser.tabs.closeGlance()
        return
      }
      const tab = this.browser.tabs.tab(sourceTabId)
      if (tab?.loading) this.browser.tabs.stop(sourceTabId)
    }
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
