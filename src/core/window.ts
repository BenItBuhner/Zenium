import type {
  EventName,
  Events,
  FindResult,
  FormFactor,
  GlanceState,
  HapticKind,
  LayoutReport,
  Rect,
  Space,
  WindowChrome,
  WindowKind,
  WindowMaterial,
  WindowPrompt,
  WindowState
} from '../shared/types'
import type { Browser } from './browser'
import type { PersistedWindow } from './state'
import { getSpace, tabVisibleIn } from './model'
import { formatWindowTitle } from '../shared/windowTitle'
import {
  CHROME_MENU_TARGETS,
  type ChromeContextParams,
  type ChromeMenuTarget,
  type TabView,
  type WindowHost
} from './platform'

export interface WindowInit {
  id: string
  kind: WindowKind
  chrome: WindowChrome
  material: WindowMaterial
  bounds: Rect | null
  /** The display `bounds` were saved on (null: unknown, or the host has one display). */
  displayId: number | null
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
  readonly chrome: WindowChrome
  readonly material: WindowMaterial
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
  /** Window pixels under the HTML fullscreen view kept for chrome docked there (the find bar). */
  private fullscreenBottomInset = 0
  /**
   * The layout the chrome is showing, as it reports it (`window.formFactor`); the desktop layout
   * until the chrome says otherwise. The app menu and the command list are built for it.
   */
  formFactor: FormFactor = 'desktop'
  /**
   * The Settings recorder in this window's chrome is listening for a chord: key presses from the
   * chrome are its to capture, and no shortcut runs off them until it stops.
   */
  recordingShortcut = false
  lastFocusedAt = 0
  /** The window-modal question the chrome is showing ("Close N tabs?"), owned by `WindowPrompts`. */
  prompt: WindowPrompt | null = null
  /**
   * The user's request to close this window went through its checks (the tab-count warning,
   * every page's `beforeunload`): the host may close it for real. Hosts whose native close
   * request arrives first (the caption button, Alt+F4) hold it until this is set.
   */
  closeApproved = false
  readonly initialBounds: Rect | null
  readonly initialDisplayId: number | null
  readonly initialMaximized: boolean
  readonly cascadeFrom: ZenWindow | null
  private savedBounds: Rect | null
  private savedDisplayId: number | null
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
    this.chrome = init.chrome
    this.material = init.material
    this.activeSpaceId = init.activeSpaceId
    this.localSpace = init.localSpace
    this.compactEnabled = init.compact
    for (const [spaceId, tabId] of Object.entries(init.selection))
      this.selection.set(spaceId, tabId)
    this.initialBounds = init.bounds
    this.savedBounds = init.bounds
    this.initialDisplayId = init.displayId
    this.savedDisplayId = init.displayId
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

  /** Whether the chrome document has loaded (events reach it, the URL bar can be opened). */
  get chromeReady(): boolean {
    return this.chromeReadyOnce
  }

  /** Last known normal (non-maximised) bounds; what a reopened window comes back at. */
  get bounds(): Rect | null {
    return this.savedBounds
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
      chrome: this.chrome,
      material: this.material,
      maximized: alive ? this.host.isMaximized() : this.initialMaximized,
      fullscreen: alive ? this.host.isFullScreen() : false,
      focused: alive ? this.host.isFocused() : false,
      htmlFullscreenTabId: this.htmlFullscreenTabId,
      prompt: this.prompt
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
      displayId: this.savedDisplayId,
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
    // A maximised window keeps its normal bounds but may have moved to another display.
    this.savedDisplayId = this.host.displayId?.() ?? this.savedDisplayId
    if (this.kind === 'synced') this.browser.state.commit()
  }

  /** Maximised / fullscreen / focus flags changed. */
  onWindowStateChanged(): void {
    if (!this.alive) return
    this.browser.fullscreen.onWindowStateChanged(this)
    this.browser.state.commitVolatile()
  }

  onFocused(): void {
    this.lastFocusedAt = Date.now()
    this.browser.onWindowFocused(this)
    this.onWindowStateChanged()
  }

  /**
   * The host window is about to close – for real: a host whose native close request comes first
   * asks the browser (`requestWindowClose`) and closes once `closeApproved` is set.
   */
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

  /**
   * A right-click in the chrome document that the chrome itself did not handle (its sidebar,
   * tab and bookmark rows show their menus through commands): the URL bar's field and pill and
   * plain text fields get Chrome's menus for them.
   */
  onContextMenu(params: Omit<ChromeContextParams, 'target' | 'tabId'>): void {
    if (!this.alive) return
    const lookup = this.host.menuTargetAt?.(params.x, params.y) ?? Promise.resolve(null)
    void lookup
      .catch(() => null)
      .then((hit) => {
        if (!this.alive) return
        const target = CHROME_MENU_TARGETS.find((t): t is ChromeMenuTarget => t === hit?.target)
        return this.browser.menus.showChromeContextMenu(
          { ...params, target: target ?? null, tabId: hit?.tabId ?? null },
          this
        )
      })
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  /** Re-apply the last layout (used when core state such as HTML fullscreen changes). */
  relayout(): void {
    if (this.lastLayout) this.applyLayout(this.lastLayout)
  }

  /** Where the chrome last placed a tab's view (window coordinates), or null when it is not shown. */
  viewRect(tabId: string): Rect | null {
    const layout = this.lastLayout
    if (!layout || layout.contentHidden) return null
    if (layout.glance?.tabId === tabId) return layout.glance.rect
    return layout.placements.find((p) => p.tabId === tabId)?.rect ?? null
  }

  /**
   * The find bar opened (or closed) under a page in HTML fullscreen: the view gives up (or takes
   * back) that strip at the bottom, the only chrome a fullscreen page shares the window with.
   */
  setFullscreenInset(bottom: number): void {
    const next = Math.max(0, Math.round(bottom))
    if (next === this.fullscreenBottomInset) return
    this.fullscreenBottomInset = next
    if (this.htmlFullscreenTabId) this.relayout()
  }

  /** Position tab views exactly where the renderer laid the content area out. */
  applyLayout(report: LayoutReport): void {
    this.lastLayout = report
    if (!this.alive) return
    const tabs = this.browser.tabs
    const owned = tabs.viewsOwnedBy(this)
    const fullscreenTabId = this.htmlFullscreenTabId
    if (fullscreenTabId && owned.has(fullscreenTabId)) {
      // An element in HTML fullscreen covers the whole window, chrome included, save for the
      // strip a docked find bar asked for.
      this.browser.extensions.placeSidePanel(this, null)
      const { width, height: full } = this.host.contentSize()
      const height = Math.max(0, full - this.fullscreenBottomInset)
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
    // The extension side panel sits beside the page and hides with it.
    this.browser.extensions.placeSidePanel(
      this,
      report.contentHidden ? null : (report.sidePanel ?? null)
    )
    const wanted = new Map<string, { rect: Rect; radius: number }>()
    if (!report.contentHidden) {
      for (const p of report.placements) wanted.set(p.tabId, { rect: p.rect, radius: p.radius })
    }
    const glance = report.glance
    // Whether a page that was showing goes away under this report (chrome UI covers it).
    let covered = false
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
        covered = true
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
    if (report.contentHidden) {
      // Chrome UI covers the page: the keyboard goes with it, but only when a page that was
      // showing loses its place under this report (one that hides nothing new leaves the
      // keyboard where it is) and never while a document of another surface holds it – an
      // extension popup's view, focused while still hidden, would blur and close.
      if (covered && !this.keyboardHeldElsewhere(owned)) this.focusChrome()
    } else if (!showsOwnPage && !glance) {
      this.focusChrome()
    }
  }

  /**
   * Whether the keyboard is held by a document that is neither this window's chrome nor one of
   * the tab views it shows. Hosts that cannot tell get the old answer: the keyboard moves.
   */
  private keyboardHeldElsewhere(owned: Map<string, TabView>): boolean {
    if (this.host.focusedDocument?.() !== 'other') return false
    for (const view of owned.values()) {
      if (view.isDestroyed()) continue
      // A view that cannot say may well be the one holding it.
      if (!view.isFocused || view.isFocused()) return false
    }
    return true
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

  haptic(kind: HapticKind): void {
    if (this.alive) this.host.haptic?.(kind)
  }

  send<K extends EventName>(name: K, payload: Events[K]): void {
    if (this.alive) this.host.send(name, payload)
  }

  /** Push the native window title (`<active tab title> - Zenium`) to the host; the host throttles. */
  updateTitle(): void {
    if (!this.alive) return
    this.host.setTitle(formatWindowTitle(this.browser.tabs.activeTitleFor(this), this.isPrivate))
  }

  /** Whether the chrome currently covers the content (used by hosts for input routing). */
  get contentHidden(): boolean {
    return this.lastLayout?.contentHidden ?? false
  }

  /**
   * Snapshot of a tab, used to keep a dimmed preview behind overlays (URL bar, Glance) and for
   * tabs whose live page is shown in another window. A page hidden under the chrome has none,
   * unless `fresh` asks for it as it is now (it changed under the zoom bubble); Electron paints
   * a hidden view on request, a host that cannot answers null and the chrome keeps its picture.
   */
  async snapshot(tabId: string, fresh = false): Promise<string | null> {
    const view = this.browser.tabs.view(tabId)
    if (!view || (!fresh && !view.isVisible())) return null
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
