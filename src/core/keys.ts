import { isModifierKey, matchShortcut } from '../shared/shortcuts'
import type { Browser } from './browser'
import type { KeyEventInput } from './platform'
import type { ZenWindow } from './window'

/**
 * Routes key events from every web view (chrome and pages) through Zen's shortcut table.
 * Matching shortcuts are consumed so pages never see them – the same precedence Firefox gives to
 * browser keybindings. Returns true when the host must swallow the event.
 */
export class KeyboardHandler {
  constructor(private readonly browser: Browser) {}

  handle(input: KeyEventInput, sourceTabId: string | null, win: ZenWindow): boolean {
    if (input.type !== 'keyDown') return false
    if (isModifierKey(input.key)) return false

    const shortcut = matchShortcut(this.browser.state.shortcuts, input)
    if (shortcut) {
      if (input.isAutoRepeat && !REPEATABLE.has(shortcut.action)) return true
      if (shortcut.unsupported) {
        this.browser.toast(`"${shortcut.label}" is not available in this build yet.`, 'info', win)
        return true
      }
      this.browser.actions.run(shortcut.action, { sourceTabId, win })
      return true
    }

    if (
      input.key === 'Escape' &&
      sourceTabId !== null &&
      !input.alt &&
      !input.control &&
      !input.meta
    ) {
      // Escape inside a page: leave Boost zap mode / close Glance, else stop loading (Firefox).
      if (this.browser.boosts.isZapping(sourceTabId)) {
        this.browser.boosts.stopZap(sourceTabId)
        return true
      }
      if (win.glance) {
        this.browser.tabs.closeGlance(win)
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
