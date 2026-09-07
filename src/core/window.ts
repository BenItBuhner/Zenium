import type {
  EventName,
  Events,
  FindResult,
  GlanceState,
  LayoutReport,
  Rect,
  Space,
  WindowKind,
  WindowState
} from '../shared/types'
import type { Browser } from './browser'
import type { PersistedWindow } from './state'
import { getSpace, tabVisibleIn } from './model'
import type { WindowHost } from './platform'

export interface WindowInit {
  id: string
  kind: WindowKind
  bounds: Rect | null
  maximized: boolean
  activeSpaceId: string
  selection: Record<string, string>
  compact: boolean
  /** The private space of a blank / private window (already registered in the model). */
  localSpace: Space | null
  /** Window to offset the new one from (new windows cascade like Firefox). */
  cascadeFrom?: ZenWindow
}

/**
 * One browser window. Its chrome renders Zen's sidebar, toolbar and overlays; tab pages are host
 * views positioned wherever the chrome reports the content area to be.
 *
 * Windows share the tab model (Zen's window sync) but each keeps its own space / tab selection,
 * Glance, find bar and compact-mode state. A tab's live page lives in one window at a time – the
 * others show a dimmed preview until they are focused. The native frame (bounds, focus, the
 * chrome's web view) is the host's `WindowHost`.
 */
export class ZenWindow {
  readonly id: string
  readonly kind: WindowKind
  host!: WindowHost
  activeSpaceId: string
  /** Per-space selected tab of this window (falls back to the space's last selection). */
  readonly selection = new Map<string, string | null>()
  readonly localSpace: Space | null
  glance: GlanceState | null = null
  findResult: FindResult | null = null
  compactSidebarRevealed = false
  compactEnabled: boolean
  compactSidebarPersistent = false
  htmlFullscreenTabId: string | null = null
  lastFocusedAt = 0
  readonly initialBounds: Rect | null
  readonly initialMaximized: boolean
  readonly cascadeFrom: ZenWindow | null
  private savedBounds: Rect | null
  private lastLayout: LayoutReport | null = null
  private pendingContentFocus = false
  private closing = false
  private chromeReadyOnce = false

  constructor(
    private readonly browser: Browser,
    init: WindowInit
  ) {
    this.id = init.id
    this.kind = init.kind
    this.activeSpaceId = init.activeSpaceId
    this.localSpace = init.localSpace
    this.compactEnabled = init.compact
    for (const [spaceId, tabId] of Object.entries(init.selection))
      this.selection.set(spaceId, tabId)
    this.initialBounds = init.bounds
    this.savedBounds = init.bounds
    this.initialMaximized = init.maximized
    this.cascadeFrom = init.cascadeFrom ?? null
  }

  get isPrivate(): boolean {
    return this.kind === 'private'
  }

  get alive(): boolean {
    return Boolean(this.host) && this.host.alive
  }

  get isClosing(): boolean {
    return this.closing
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  /** The space this window is showing. */
  activeSpace(): Space {
    if (this.localSpace) return this.localSpace
    const m = this.browser.state.model
    return getSpace(m, this.activeSpaceId) ?? m.spaces[0]
  }

  /** Tab selected in `space` by this window, validated against the tabs the window can show. */
  selectedTabIn(space: Space): string | null {
    const m = this.browser.state.model
    const valid = (id: string | null | undefined): id is string => {
      if (!id) return false
      const tab = m.tabs[id]
      if (!tab || !tabVisibleIn(tab, this.id)) return false
      if (tab.essential) return !space.windowId
      return tab.spaceId === space.id
    }
    const own = this.selection.get(space.id)
    if (valid(own)) return own
    if (valid(space.activeTabId)) return space.activeTabId
    return null
  }

  select(space: Space, tabId: string | null): void {
    this.selection.set(space.id, tabId)
    if (tabId) space.activeTabId = tabId
  }

  windowState(): WindowState {
    const alive = this.alive
    return {
      id: this.id,
      kind: this.kind,
      maximized: alive ? this.host.isMaximized() : this.initialMaximized,
      fullscreen: alive ? this.host.isFullScreen() : false,
      focused: alive ? this.host.isFocused() : false,
      htmlFullscreenTabId: this.htmlFullscreenTabId
    }
  }

  /** Visible tabs whose live page is attached to another window right now. */
  foreignTabIds(): string[] {
    const tabs = this.browser.tabs
    return tabs.visibleTabIds(this).filter((id) => {
      const owner = tabs.ownerOf(id)
      return owner !== undefined && owner !== this
    })
  }

  toPersisted(): PersistedWindow {
    const selection: Record<string, string> = {}
    for (const [spaceId, tabId] of this.selection) if (tabId) selection[spaceId] = tabId
    return {
      id: this.id,
      bounds: this.savedBounds,
      maximized: this.alive ? this.host.isMaximized() : this.initialMaximized,
      activeSpaceId: this.activeSpaceId,
      selection,
      compact: this.compactEnabled
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle callbacks from the host
  // ---------------------------------------------------------------------------

  /** The host window's size or position changed (debounced by the host). */
  onBoundsChanged(): void {
    if (!this.alive) return
    if (!this.host.isMaximized() && !this.host.isFullScreen()) {
      this.savedBounds = this.host.normalBounds() ?? this.savedBounds
    }
    if (this.kind === 'synced') this.browser.state.commit()
  }

  /** Maximised / fullscreen / focus flags changed. */
  onWindowStateChanged(): void {
    if (!this.alive) return
    this.browser.state.commitVolatile()
  }

  onFocused(): void {
    this.lastFocusedAt = Date.now()
    this.browser.onWindowFocused(this)
    this.onWindowStateChanged()
  }

  /** The host window is about to close. */
  onClosing(): void {
    this.closing = true
    this.onBoundsChanged()
    this.browser.onWindowClosing(this)
    this.browser.state.flushSync()
  }

  onClosed(): void {
    this.browser.onWindowClosed(this)
  }

  /** The chrome document finished loading (also after a reload). */
  onChromeReady(): void {
    this.send('state', this.browser.state.snapshot(this))
    if (this.chromeReadyOnce) return
    this.chromeReadyOnce = true
    this.browser.onChromeReady(this)
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  /** Re-apply the last layout (used when core state such as HTML fullscreen changes). */
  relayout(): void {
    if (this.lastLayout) this.applyLayout(this.lastLayout)
  }

  /** Position tab views exactly where the renderer laid the content area out. */
  applyLayout(report: LayoutReport): void {
    this.lastLayout = report
    if (!this.alive) return
    const tabs = this.browser.tabs
    const owned = tabs.viewsOwnedBy(this)
    const fullscreenTabId = this.htmlFullscreenTabId
    if (fullscreenTabId && owned.has(fullscreenTabId)) {
      // An element in HTML fullscreen covers the whole window, chrome included.
      const { width, height } = this.host.contentSize()
      for (const [tabId, view] of owned) {
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
    for (const [tabId, view] of owned) {
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
      const view = owned.get(glance.tabId)
      if (view && !view.isDestroyed()) {
        view.bringToFront()
        view.setBounds(roundRect(glance.rect))
        view.setBorderRadius(Math.round(glance.radius))
        if (!view.isVisible()) view.setVisible(true)
      }
    }
    if (this.pendingContentFocus && !report.contentHidden) this.focusContent()
    // With no page visible (empty space / chrome overlay / preview of a page shown in another
    // window) keyboard input must go to the chrome, otherwise shortcuts stop working.
    const showsOwnPage = [...wanted.keys()].some((id) => owned.has(id))
    if (report.contentHidden || (!showsOwnPage && !glance)) this.focusChrome()
  }

  /**
   * Give keyboard focus to the active page (after the chrome handled an action). If the page is
   * still hidden behind chrome UI, the focus is applied once the next layout shows it again.
   */
  focusContent(): void {
    const active = this.browser.tabs.activeTabFor(this)
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
    const ownsView = this.browser.tabs.ownerOf(active.id) === this
    // A view without a committed document has no renderer to deliver shortcuts through.
    if (ownsView && view && view.hasDocument()) view.focus()
    else this.focusChrome()
  }

  focusChrome(): void {
    if (this.alive) this.host.focusChrome()
  }

  send<K extends EventName>(name: K, payload: Events[K]): void {
    if (this.alive) this.host.send(name, payload)
  }

  /** Whether the chrome currently covers the content (used by hosts for input routing). */
  get contentHidden(): boolean {
    return this.lastLayout?.contentHidden ?? false
  }

  /**
   * Snapshot of a tab, used to keep a dimmed preview behind overlays (URL bar, Glance) and for
   * tabs whose live page is shown in another window.
   */
  async snapshot(tabId: string): Promise<string | null> {
    const view = this.browser.tabs.view(tabId)
    if (!view || !view.isVisible()) return null
    return view.snapshot()
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
