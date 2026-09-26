import type { TabView } from './platform'
import type { Browser } from './browser'
import type { ZenWindow } from './window'

/**
 * Caret browsing (CT-34): Chrome's and Edge's F7 puts a text cursor into the page that the arrow
 * keys move and Shift selects with. As in Chrome (`settings.a11y.enable_caret_browsing`) it is
 * one state for the profile – every page's view is told (`TabView.setCaretBrowsingEnabled`, one
 * call each), a page that opens while it is on gets it at creation, and it is kept across runs
 * (`Settings.caretBrowsing`). Turning it on asks once – "Turn on caret browsing?" through the
 * window's §9.23 confirm, whose "Don't ask again" clears `Settings.caretBrowsingConfirm` – and
 * F7 again turns it off with no question, as Chrome does. Only on hosts whose engine has the
 * call (`HostCapabilities.caretBrowsing`): elsewhere F7 does nothing and Settings hides the row.
 */
export class CaretBrowsing {
  constructor(private readonly browser: Browser) {}

  /** Whether the host can do it at all. */
  get supported(): boolean {
    return this.browser.state.capabilities.caretBrowsing === true
  }

  get enabled(): boolean {
    return this.supported && this.browser.state.settings.caretBrowsing === true
  }

  /**
   * F7: off at once when on; on after the confirm (or at once, when the user asked not to be
   * asked again). A window busy with another question, or a cancelled confirm, changes nothing.
   */
  async toggle(win: ZenWindow): Promise<void> {
    if (!this.supported) return
    if (this.enabled) {
      this.set(false)
      return
    }
    if (this.browser.state.settings.caretBrowsingConfirm !== false) {
      const accepted = await this.browser.windowPrompts.ask(win, 'caret-browsing', 0)
      if (!accepted) return
    }
    this.set(true)
  }

  /** The state, written to the setting and told to every live page. */
  set(on: boolean): void {
    if (!this.supported) return
    if (this.browser.state.settings.caretBrowsing !== on) {
      this.browser.state.settings.caretBrowsing = on
      this.browser.state.commit()
    }
    this.applyAll()
  }

  /** A page that opens while caret browsing is on shows the caret from the start. */
  onViewCreated(view: TabView): void {
    if (this.enabled) view.setCaretBrowsingEnabled?.(true)
  }

  /** The setting changed elsewhere (a Settings row, a sync merge): the pages follow it. */
  onSettingsChanged(): void {
    this.applyAll()
  }

  private applyAll(): void {
    if (!this.supported) return
    const on = this.enabled
    for (const [, view] of this.browser.tabs.allViews()) {
      if (!view.isDestroyed()) view.setCaretBrowsingEnabled?.(on)
    }
  }
}
