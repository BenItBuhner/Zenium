import type { PageControlsSettings, PageEnvironment, Tab } from '../shared/types'
import {
  ZOOM_LEVELS,
  ZOOM_PRESETS,
  clampZoom,
  desktopByDefault,
  isWebPage,
  pageRulesFor,
  resolveDesktop,
  resolveDarkening,
  resolvePageControls,
  resolveZoom,
  sanitizePageControls,
  siteKey,
  siteZoom,
  stepZoom,
  withSiteOverride,
  type ResolvedPageControls
} from '../shared/pageControls'
import type { Browser } from './browser'
import type { TabView } from './platform'

/**
 * Page controls: desktop site, dark theme for sites and page zoom, each remembered per site the
 * way Chrome does. The rules themselves are the pure functions in `shared/pageControls.ts`; this
 * service owns the stored maps, hands hosts their copy of the policy (`PageRules`) and applies
 * the resolved values to live pages.
 *
 * Zoom memory is on every host: a factor set on one tab of a site goes to every tab of the site
 * and is written to the settings, so the site opens at it after a relaunch (Chrome's per-host
 * zoom levels; the key here is the registrable domain, `siteKey`, as for the other controls).
 * Desktop site, darkening and the rules push are the full page controls of the Android host
 * (`capabilities.pageControls`); the desktop keeps Chromium's own user agent and colours.
 * Pages that are not web pages (internal pages, files) keep the host's plain per-tab zoom.
 */
export class PageControls {
  constructor(private readonly browser: Browser) {}

  /** The full set – desktop site, darkening, the rules push – as opposed to zoom memory alone. */
  get enabled(): boolean {
    return this.browser.state.capabilities.pageControls
  }

  get settings(): PageControlsSettings {
    return this.browser.state.settings.pageControls
  }

  get environment(): PageEnvironment {
    return this.browser.state.pageEnvironment
  }

  /**
   * The ladder Zoom In / Zoom Out climb: the sheet's 50 to 300 percent with the full page
   * controls (the phone's slider walks the same levels), Chrome's 25 to 500 percent presets on
   * the desktop.
   */
  get zoomLevels(): readonly number[] {
    return this.enabled ? ZOOM_LEVELS : ZOOM_PRESETS
  }

  resolve(url: string): ResolvedPageControls {
    return resolvePageControls(this.settings, url, this.environment)
  }

  /** Whether "Desktop site" is on for the tab's site (the menu checkbox). */
  isDesktop(tab: Tab): boolean {
    return resolveDesktop(this.settings, tab.url, this.environment)
  }

  /** Whether the tab's site is darkened while the chrome is dark (the menu checkbox). */
  isDarkened(tab: Tab): boolean {
    return resolveDarkening(this.settings, tab.url)
  }

  /** The zoom the sheet shows and stores: the site's own factor, before the system font size. */
  siteZoomOf(tab: Tab): number {
    return siteZoom(this.settings, tab.url)
  }

  /** Whether the tab's page has a remembered site zoom (a web page); other pages zoom per tab. */
  remembersZoom(tab: Tab): boolean {
    return siteKey(tab.url) !== null
  }

  // ---------------------------------------------------------------------------
  // Host plumbing
  // ---------------------------------------------------------------------------

  /** Called once at start and whenever the policy or the device changes. */
  push(): void {
    if (!this.enabled) return
    this.browser.platform.views.setPageRules?.(pageRulesFor(this.settings, this.environment))
  }

  /** The host reported the device (at boot and on configuration changes). */
  setEnvironment(env: PageEnvironment): void {
    const state = this.browser.state
    const before = JSON.stringify(state.pageEnvironment)
    state.pageEnvironment = {
      largeScreen: Boolean(env.largeScreen),
      pointerAndKeyboard: Boolean(env.pointerAndKeyboard),
      fontScale: Number.isFinite(env.fontScale) && env.fontScale > 0 ? env.fontScale : 1
    }
    if (before === JSON.stringify(state.pageEnvironment)) return
    this.push()
    this.applyAll()
    state.commitVolatile()
  }

  /** A `settings.update` carried a page-controls patch. */
  onSettingsChanged(): void {
    this.push()
    this.applyAll()
  }

  /**
   * A live page was created for `tab`: give it the controls of the page it is about to load. A
   * page that is not a web page gets the tab's own zoom back (a restored tab).
   */
  onViewCreated(tab: Tab, view: TabView): void {
    if (!this.enabled && !isWebPage(tab.url)) {
      if (tab.zoom !== 1) view.setZoom(tab.zoom)
      return
    }
    tab.zoom = this.applyTo(view, tab.url)
  }

  /**
   * The page committed a navigation: its controls follow the new URL. Without the full page
   * controls a page that is not a web page reports the zoom the engine gave it (Chromium keeps
   * one per host of its own).
   */
  onNavigated(tab: Tab, view: TabView): void {
    if (!this.enabled && !isWebPage(tab.url)) {
      tab.zoom = view.getZoom()
      return
    }
    tab.zoom = this.applyTo(view, tab.url)
  }

  /** Apply the resolved controls for `url` to a live page; returns the effective zoom. */
  private applyTo(view: TabView, url: string): number {
    const r = this.resolve(url)
    view.setZoom(r.zoom)
    if (this.enabled) {
      view.setDarkening?.(r.darken)
      view.setDesktopMode?.(r.desktop)
    }
    return r.zoom
  }

  /**
   * Re-apply to every live page (a policy or device change), or to every page of one site (its
   * zoom changed); desktop mode waits for its next load.
   */
  private applyAll(onlySite?: string): void {
    for (const [tabId, view] of this.browser.tabs.allViews()) {
      const tab = this.browser.tabs.tab(tabId)
      if (!tab || view.isDestroyed()) continue
      const key = siteKey(tab.url)
      if (onlySite ? key !== onlySite : !this.enabled && !key) continue
      tab.zoom = this.applyTo(view, tab.url)
    }
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /**
   * An exact factor for the tab's site, as a slider sets it (the desktop bubble's and the phone
   * zoom sheet's; the menu's steps go through `adjustZoom`). Every tab of the site follows at
   * once, and the chrome hears of the change (`zoom.changed`) so it can show the zoom bubble.
   */
  setZoomFactor(tabId: string, factor: number): void {
    const tab = this.browser.tabs.tab(tabId)
    const key = tab ? siteKey(tab.url) : null
    if (!tab || !key) return
    const s = this.settings
    s.siteZooms = withSiteOverride(s.siteZooms, key, clampZoom(factor), s.zoom)
    this.afterChange(key)
    this.browser.emit(
      'zoom.changed',
      { tabId, factor: tab.zoom, siteKey: key },
      this.browser.tabs.windowFor(tabId)
    )
  }

  /** Zoom in / out along the host's ladder (keyboard shortcuts, Ctrl+wheel, the sheet's steppers). */
  adjustZoom(tabId: string, direction: number): void {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab || !siteKey(tab.url)) return
    this.setZoomFactor(tabId, stepZoom(this.siteZoomOf(tab), direction, this.zoomLevels))
  }

  /** Back to the default zoom: the site's exception goes away. */
  resetZoom(tabId: string): void {
    this.setZoomFactor(tabId, this.settings.zoom)
  }

  /** "Desktop site" for the tab's site; the page reloads with the new user agent. */
  setDesktopSite(tabId: string, on: boolean | null): void {
    const tab = this.browser.tabs.tab(tabId)
    const key = tab ? siteKey(tab.url) : null
    if (!tab || !key) return
    const s = this.settings
    s.desktopSites = withSiteOverride(
      s.desktopSites,
      key,
      on,
      desktopByDefault(s, this.environment)
    )
    this.afterChange(key)
    // Only the tab the user asked in reloads; other tabs of the site follow on their next load.
    this.browser.tabs.reload(tabId)
  }

  /** "Dark theme for this site" (the per-site exception to "Apply dark theme to sites"). */
  setDarkenSite(tabId: string, on: boolean | null): void {
    const tab = this.browser.tabs.tab(tabId)
    const key = tab ? siteKey(tab.url) : null
    if (!tab || !key) return
    const s = this.settings
    s.darkenSiteExceptions = withSiteOverride(s.darkenSiteExceptions, key, on, s.darkenSites)
    this.afterChange(key)
  }

  /** The per-site lists in Settings: one exception goes away. */
  forgetSite(kind: 'desktop' | 'darken' | 'zoom', domain: string): void {
    const s = this.settings
    const maps = {
      desktop: s.desktopSites,
      darken: s.darkenSiteExceptions,
      zoom: s.siteZooms
    }
    if (!(domain in maps[kind])) return
    const next = { ...maps[kind] } as Record<string, boolean | number>
    delete next[domain]
    if (kind === 'desktop') s.desktopSites = next as Record<string, boolean>
    else if (kind === 'darken') s.darkenSiteExceptions = next as Record<string, boolean>
    else s.siteZooms = next as Record<string, number>
    this.afterChange(domain)
  }

  /** A patch from the Settings surface (defaults, toggles); the maps are kept as they are. */
  update(patch: Partial<PageControlsSettings>): void {
    const s = this.browser.state.settings
    const before = JSON.stringify(s.pageControls)
    s.pageControls = sanitizePageControls({ ...s.pageControls, ...patch })
    if (before !== JSON.stringify(s.pageControls)) this.onSettingsChanged()
  }

  private afterChange(site: string): void {
    this.browser.state.settings.pageControls = sanitizePageControls(this.settings)
    this.push()
    this.applyAll(site)
    this.browser.state.commit()
  }

  /** Effective zoom for a URL under the current policy (tests and the sheet's preview). */
  zoomFor(url: string): number {
    return resolveZoom(this.settings, url, this.environment)
  }
}
