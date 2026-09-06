import type { LayoutReport, Rect } from '../shared/types'
import type { Browser } from './browser'

/**
 * Positions tab views exactly where the renderer laid the content area out, and moves keyboard
 * focus between the chrome and the active page. Hosts only provide `TabView.setBounds()` & co.
 */
export class Viewport {
  private lastLayout: LayoutReport | null = null
  private pendingContentFocus = false

  constructor(private readonly browser: Browser) {}

  /** Re-apply the last layout (used when core state such as HTML fullscreen changes). */
  relayout(): void {
    if (this.lastLayout) this.applyLayout(this.lastLayout)
  }

  applyLayout(report: LayoutReport): void {
    this.lastLayout = report
    const { tabs, state, platform } = this.browser
    const fullscreenTabId = state.window.htmlFullscreenTabId
    if (fullscreenTabId && tabs.view(fullscreenTabId)) {
      // An element in HTML fullscreen covers the whole window, chrome included.
      const { width, height } = platform.window.contentSize()
      for (const [tabId, view] of tabs.allViews()) {
        if (view.isDestroyed()) continue
        if (tabId === fullscreenTabId) {
          view.bringToFront()
          view.setBounds({ x: 0, y: 0, width, height })
          view.setBorderRadius(0)
          view.setVisible(true)
        } else if (view.isVisible()) {
          view.setVisible(false)
        }
      }
      return
    }
    const wanted = new Map<string, { rect: Rect; radius: number }>()
    if (!report.contentHidden) {
      for (const p of report.placements) wanted.set(p.tabId, { rect: p.rect, radius: p.radius })
    }
    const glance = report.glance
    for (const [tabId, view] of tabs.allViews()) {
      if (view.isDestroyed()) continue
      const placement = wanted.get(tabId)
      const isGlance = glance?.tabId === tabId
      if (isGlance) continue
      if (placement) {
        view.setBounds(roundRect(placement.rect))
        view.setBorderRadius(Math.round(placement.radius))
        if (!view.isVisible()) view.setVisible(true)
      } else if (view.isVisible()) {
        view.setVisible(false)
      }
    }
    if (glance) {
      const view = tabs.view(glance.tabId)
      if (view) {
        view.bringToFront()
        view.setBounds(roundRect(glance.rect))
        view.setBorderRadius(Math.round(glance.radius))
        if (!view.isVisible()) view.setVisible(true)
      }
    }
    if (this.pendingContentFocus && !report.contentHidden) this.focusContent()
    // With no page visible (empty space / chrome overlay) keyboard input must go to the chrome,
    // otherwise shortcuts stop working after the focused view is hidden.
    if (report.contentHidden || (report.placements.length === 0 && !glance)) this.focusChrome()
  }

  /**
   * Give keyboard focus to the active page (after the chrome handled an action). If the page is
   * still hidden behind chrome UI, the focus is applied once the next layout shows it again.
   */
  focusContent(): void {
    const active = this.browser.tabs.activeTab
    if (!active) {
      this.focusChrome()
      return
    }
    if (!this.lastLayout || this.lastLayout.contentHidden) {
      this.pendingContentFocus = true
      return
    }
    this.pendingContentFocus = false
    const view = this.browser.tabs.view(active.id)
    // A view without a committed document has no renderer to deliver shortcuts through.
    if (view && view.hasDocument()) view.focus()
    else this.focusChrome()
  }

  focusChrome(): void {
    this.browser.platform.chrome.focus()
  }

  /** Whether the chrome currently covers the content (used by hosts for input routing). */
  get contentHidden(): boolean {
    return this.lastLayout?.contentHidden ?? false
  }
}

function roundRect(r: Rect): Rect {
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.max(0, Math.round(r.width)),
    height: Math.max(0, Math.round(r.height))
  }
}
