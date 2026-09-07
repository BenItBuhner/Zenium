import type { Event, Input } from 'electron'
import { isModifierKey, matchShortcut } from '../../shared/shortcuts'
import type { Browser } from './browser'
import type { ZenWindow } from './window'

/**
 * Routes `before-input-event` from every web contents (chrome and pages) through Zen's shortcut
 * table. Matching shortcuts are consumed so pages never see them – the same precedence Firefox
 * gives to browser keybindings.
 */
export class KeyboardHandler {
  constructor(private readonly browser: Browser) {}

  handle(event: Event, input: Input, sourceTabId: string | null, win: ZenWindow): void {
    if (input.type !== 'keyDown') return
    if (isModifierKey(input.key)) return

    const shortcut = matchShortcut(this.browser.state.shortcuts, input)
    if (shortcut) {
      event.preventDefault()
      if (input.isAutoRepeat && !REPEATABLE.has(shortcut.action)) return
      if (shortcut.unsupported) {
        this.browser.toast(`"${shortcut.label}" is not available in this build yet.`, 'info', win)
        return
      }
      this.browser.actions.run(shortcut.action, { sourceTabId, win })
      return
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
        event.preventDefault()
        this.browser.boosts.stopZap(sourceTabId)
        return
      }
      if (win.glance) {
        event.preventDefault()
        this.browser.tabs.closeGlance(win)
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
