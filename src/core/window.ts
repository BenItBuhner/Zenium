import type {
  AppWindowInfo,
  ChromeSurface,
  ContentCover,
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
import { formatWindowTitle, normalizeWindowName } from '../shared/windowTitle'
import { captionDoubleClickEffect } from './captionDoubleClick'
import {
  CHROME_MENU_TARGETS,
  type ChromeContextParams,
  type ChromeMenuTarget,
  type TabView,
  type WindowHost
} from './platform'

/**
 * Whether `win`'s chrome has `surface` up to answer a page's request (`ZenWindow.surfaces`); a
 * window that is gone – or a host object that never registered any – has none.
 */
export function surfaceMounted(
  win: Pick<ZenWindow, 'surfaces'> | null | undefined,
  surface: ChromeSurface
): boolean {
  return Boolean(win?.surfaces?.has(surface))
}

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
  /** The window this one was opened from (a popup's parent), when one was. */
  opener?: ZenWindow
  /** The web app a standalone window (`chrome` `app`) shows; browser windows leave it out. */
  app?: AppWindowInfo | null
  /** The name the user gave the window last session (`ZenWindow.name`); none for a new one. */
  name?: string | null
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
  /** The web app of a standalone window (`chrome` `app`): name, icon and scope; else null. */
  app: AppWindowInfo | null
  /**
   * The name the user gave the window (Chrome's Name window…): what the OS title bar reads
   * instead of the active tab's title and what tab search calls the window; null while it has
   * none. Kept with the session for synced windows (`toPersisted`). A host with a single window
   * (Android) carries it inert – nothing there sets or shows it.
   */
  name: string | null
  host!: WindowHost
  activeSpaceId: string
  /** Per-space selected tab of this window (falls back to the space's last selection). */
  readonly selection = new Map<string, string | null>()
  readonly localSpace: Space | null
  glance: GlanceState | null = null
  findResult: FindResult | null = null
  compactSidebarRevealed = false
  /** The hidden top toolbar is out (compact mode or the window's fullscreen); the chrome's word. */
  compactToolbarRevealed = false
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
   * The surfaces this window's chrome has mounted (`ui.surface`): the install prompt, the screen
   * picker, the share sheet. A page's request for one that is absent is answered at once as a
   * cancel (`surfaceMounted`) rather than held for a chrome that is not there.
   */
  readonly surfaces = new Set<ChromeSurface>()
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
  /**
   * The window this one was opened from, for what a toolbar-only popup cannot hold itself: an
   * internal page asked for from a popup opens in its opener (`PageService.hostWindowFor`).
   */
  readonly opener: ZenWindow | null
  private savedBounds: Rect | null
  private savedDisplayId: number | null
  private lastLayout: LayoutReport | null = null
  /** Where the content area last put a page (the size a page preloaded off screen lays out at). */
  private lastContentRect: Rect | null = null
  private pendingContentFocus = false
  private closing = false
  private chromeReadyOnce = false
  /** Where the popup surface (the autofill picker) stands, while it is up. */
  private popupBounds: Rect | null = null

  constructor(
    private readonly browser: Browser,
    init: WindowInit
  ) {
    this.id = init.id
    this.kind = init.kind
    this.chrome = init.chrome
    this.material = init.material
    this.app = init.app ?? null
    this.name = normalizeWindowName(init.name)
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
    this.opener = init.opener ?? null
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
      prompt: this.prompt,
      app: this.app,
      name: this.name
    }
  }

  /**
   * Name the window (Chrome's Name window…), or clear the name with null or an empty string.
   * The title bar follows at once; a synced window keeps the name with the session.
   */
  setName(name: string | null): void {
    const next = normalizeWindowName(name)
    if (next === this.name) return
    this.name = next
    this.updateTitle()
    this.browser.state.commit()
  }

  /**
   * The chrome's empty caption room was double-clicked (the sidebar's empty space, tabs-47,
   * shortcuts-menus-94): the window does what a double-clicked title bar does on this OS
   * (`captionDoubleClickEffect`) – maximise or restore, minimise, or nothing. Nothing in
   * fullscreen either, where there is no title bar to double-click.
   */
  captionDoubleClick(): void {
    if (!this.alive || this.host.isFullScreen()) return
    const { info, app } = this.browser.platform
    switch (captionDoubleClickEffect(info.os, app.titleBarDoubleClickAction?.() ?? null)) {
      case 'toggleMaximize':
        if (this.host.isMaximized()) this.host.unmaximize()
        else this.host.maximize()
        return
      case 'minimize':
        this.host.minimize()
        return
      case 'none':
        return
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
      compact: this.compactEnabled,
      name: this.name
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
    // An installed app's window opens where it last stood (Chrome remembers per app).
    if (this.app?.appId) this.browser.webApps.rememberBounds(this.app.appId, this.savedBounds)
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
    // The views this report takes down or brings back: told to the chrome once they are placed.
    const hid: string[] = []
    const shown: string[] = []
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
          view.setCover?.(NO_COVER)
          if (!view.isVisible()) shown.push(tabId)
          view.setVisible(true)
        } else if (view.isVisible()) {
          view.setVisible(false)
          hid.push(tabId)
        }
      }
      this.send('layout.applied', { contentHidden: false, hid, shown })
      return
    }
    // The extension side panel sits beside the page and hides with it.
    this.browser.extensions.placeSidePanel(
      this,
      report.contentHidden ? null : (report.sidePanel ?? null)
    )
    const wanted = new Map<string, { rect: Rect; radius: number; cover: ContentCover }>()
    if (!report.contentHidden) {
      for (const p of report.placements)
        wanted.set(p.tabId, { rect: p.rect, radius: p.radius, cover: p.cover ?? NO_COVER })
    }
    if (report.placements.length === 1) this.lastContentRect = roundRect(report.placements[0].rect)
    const glance = report.glance
    // Whether a page that was showing goes away under this report (chrome UI covers it), and
    // whether one of those pages held the keyboard as it went.
    let covered = false
    let coveredTyping = false
    for (const [tabId, view] of owned) {
      if (view.isDestroyed()) continue
      const placement = wanted.get(tabId)
      const isGlance = glance?.tabId === tabId
      if (isGlance) continue
      if (placement) {
        view.setBounds(roundRect(placement.rect))
        view.setBorderRadius(Math.round(placement.radius))
        view.setCover?.(placement.cover)
        if (!view.isVisible()) {
          view.setVisible(true)
          shown.push(tabId)
        }
      } else if (view.isVisible()) {
        if (view.isFocused?.()) coveredTyping = true
        view.setVisible(false)
        hid.push(tabId)
        covered = true
      }
    }
    if (glance) {
      const view = owned.get(glance.tabId)
      if (view && !view.isDestroyed()) {
        view.bringToFront()
        view.setBounds(roundRect(glance.rect))
        view.setBorderRadius(Math.round(glance.radius))
        view.setCover?.(glance.cover ?? NO_COVER)
        if (!view.isVisible()) {
          view.setVisible(true)
          shown.push(glance.tabId)
        }
      }
    }
    // The chrome sequences its page cover against the host's frames from this (lib/pageView.ts).
    this.send('layout.applied', { contentHidden: report.contentHidden, hid, shown })
    if (this.pendingContentFocus && !report.contentHidden) this.focusContent()
    // A view placed again may have come up above the popup surface: put it back on top.
    if (this.popupBounds) this.host.setPopupSurface?.(this.popupBounds)
    // With no page visible (empty space / chrome overlay / preview of a page shown in another
    // window / a page tab the chrome itself draws) keyboard input must go to the chrome,
    // otherwise shortcuts stop working.
    const showsOwnPage = [...wanted.keys()].some((id) => owned.has(id))
    if (report.contentHidden) {
      // Chrome UI covers the page: the keyboard goes with it, but only when a page that was
      // showing loses its place under this report (one that hides nothing new leaves the
      // keyboard where it is) and never while a document of another surface holds it – an
      // extension popup's view, focused while still hidden, would blur and close. A page the
      // user was typing in gets the keyboard back with the layout that shows it again, so
      // chrome that only rests over the page for a while (the tab hover card, the compact
      // sidebar's reveal) leaves no lost keyboard behind; chrome that asks for the page's focus
      // itself as it closes asks for the same thing.
      if (covered && !this.keyboardHeldElsewhere(owned)) {
        if (coveredTyping) this.pendingContentFocus = true
        this.focusChrome()
      }
    } else if (!showsOwnPage && !glance && !this.keyboardHeldElsewhere(owned)) {
      // The same guard here: a chrome page tab (Settings) reports no placement on every layout
      // – a resize, a sheet – and an extension popup open over it must keep the keyboard.
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
    // Focusing a page focuses its window as well (Electron, on Linux and macOS): when the user
    // has gone to another window meanwhile, the keyboard stays there.
    if (!this.host.isFocused()) return
    const view = this.browser.tabs.view(active.id)
    const ownsView = this.browser.tabs.ownerOf(active.id) === this
    // A view without a committed document has no renderer to deliver shortcuts through.
    if (ownsView && view && view.hasDocument()) view.focus()
    else this.focusChrome()
  }

  focusChrome(): void {
    if (this.alive) this.host.focusChrome()
  }

  /** Whether the host can float the popup surface (the desktop picker) above the page views. */
  get hasPopupSurface(): boolean {
    return typeof this.host.setPopupSurface === 'function'
  }

  /** The window's content size in CSS pixels: what anchored surfaces are clamped inside. */
  viewportSize(): { width: number; height: number } {
    return this.host.contentSize()
  }

  /** Place the popup surface at `bounds` (window CSS pixels) or take it down (null). */
  setPopupSurface(bounds: Rect | null): void {
    this.popupBounds = bounds
    if (this.alive) this.host.setPopupSurface?.(bounds)
  }

  haptic(kind: HapticKind): void {
    if (this.alive) this.host.haptic?.(kind)
  }

  send<K extends EventName>(name: K, payload: Events[K]): void {
    if (this.alive) this.host.send(name, payload)
  }

  /**
   * Push the native window title (`<active tab title> - Zenium`, or `<name> — Zenium` for a
   * window the user named) to the host; the host throttles.
   */
  updateTitle(): void {
    if (!this.alive) return
    this.host.setTitle(
      formatWindowTitle(
        this.browser.tabs.activeTitleFor(this),
        this.isPrivate,
        this.app?.name,
        this.name
      )
    )
  }

  /** Whether the chrome currently covers the content (used by hosts for input routing). */
  get contentHidden(): boolean {
    return this.lastLayout?.contentHidden ?? false
  }

  /** Where a single page last sat in this window (null before the first layout). */
  contentRect(): Rect | null {
    return this.lastContentRect
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

const NO_COVER: ContentCover = { top: 0, bottom: 0 }
