import type { Tab, WebAppBanner, WebAppInstallPrompt } from '../shared/types'
import { resolveTheme, rgbToHex } from '../shared/theme'
import {
  displayIcon,
  fallbackShortcutTitle,
  isInstallable,
  isWithinScope,
  launcherName,
  markDismissed,
  markPrompted,
  parseWebAppManifest,
  pinnedAppFor,
  recordVisit,
  shortcutIcon,
  shouldPrompt,
  tileColor,
  type EngagementRecord,
  type PinnedWebApp,
  type WebAppInfo
} from '../shared/webApp'
import type { Browser } from './browser'
import { getSpace } from './model'
import type { PageMessage, ShortcutRequest, StoreIO } from './platform'
import type { ZenWindow } from './window'

/** The persisted document: shortcuts on the Home screen and how often each app was visited. */
interface WebAppsDocument {
  version: 1
  pinned: PinnedWebApp[]
  engagement: Record<string, EngagementRecord>
}

const STORE_NAME = 'webapps.json'
/** Engagement records kept (least recently visited go first when the cap is reached). */
const MAX_ENGAGEMENT = 200
/**
 * After `beforeinstallprompt` fires, a site that wants to run the prompt itself cancels the
 * event synchronously; its `deferred` message needs one round trip to arrive.
 */
const DEFER_GRACE_MS = 1200
/** The ambient banner leaves on its own after this long (an ignored prompt is not a dismissal). */
export const BANNER_TIMEOUT_MS = 12_000
/** Fetching a manifest the page could not (CSP) goes through the host with this budget. */
const MANIFEST_FETCH_TIMEOUT_MS = 8000
const MAX_MANIFEST_BYTES = 256 * 1024

export interface WebAppServiceOptions {
  now?: () => number
}

/**
 * Web apps: the manifest a page declares becomes `tab.webApp`; "Add to Home screen" (from the
 * app menu, the ambient banner or a site's deferred `prompt()`) opens the install sheet, whose
 * "Add" asks the host to pin a launcher shortcut; the launcher's confirmation lands in
 * `onPinned`, which toasts, records the app for the "Open <app>" menu label and fires the page's
 * `appinstalled`. The engagement counter behind the ambient banner lives here too.
 */
export class WebAppService {
  private pinned: PinnedWebApp[] = []
  private engagement: Record<string, EngagementRecord> = {}
  /** Tabs whose site cancelled `beforeinstallprompt` (it will call `prompt()` itself). */
  private readonly deferred = new Set<string>()
  /** Tabs where a site-initiated `prompt()` awaits the sheet's outcome. */
  private readonly sitePrompts = new Set<string>()
  /** Tabs with the install sheet up (no ambient banner behind it). */
  private readonly installOpen = new Set<string>()
  /** Tabs with an ambient banner up (value: the app it advertises). */
  private readonly banners = new Map<string, string>()
  /** Pin requests the launcher has not confirmed yet, by shortcut id. */
  private readonly pendingPins = new Map<string, { tabId: string; title: string; url: string }>()
  /** The manifests behind pending pins, so a confirmation can register the app after the tab moved on. */
  private readonly pendingApps = new Map<string, WebAppInfo>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => number

  constructor(
    private readonly browser: Browser,
    private readonly io: StoreIO,
    options: WebAppServiceOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.load()
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private load(): void {
    const raw = this.io.readSync(STORE_NAME)
    if (!raw) return
    try {
      const doc = JSON.parse(raw) as Partial<WebAppsDocument>
      if (Array.isArray(doc.pinned))
        this.pinned = doc.pinned.filter(
          (p): p is PinnedWebApp =>
            Boolean(p) && typeof p.id === 'string' && typeof p.scope === 'string'
        )
      if (doc.engagement && typeof doc.engagement === 'object')
        this.engagement = { ...doc.engagement }
    } catch {
      /* a broken document starts over */
    }
  }

  private document(): WebAppsDocument {
    return { version: 1, pinned: this.pinned, engagement: this.engagement }
  }

  private save(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.io.write(STORE_NAME, JSON.stringify(this.document()))
    }, 500)
  }

  flushSync(): void {
    if (!this.saveTimer) return
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.io.writeSync(STORE_NAME, JSON.stringify(this.document()))
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /** Whether this host can pin pages at all (the menu item hides otherwise). */
  get supported(): boolean {
    return Boolean(
      this.browser.platform.capabilities.pinShortcuts && this.browser.platform.shortcuts
    )
  }

  /** The pinned app whose scope contains `url` (the app menu says "Open <name>" inside it). */
  pinnedFor(url: string): PinnedWebApp | null {
    return pinnedAppFor(url, this.pinned)
  }

  /** Whether "Add to Home screen" applies to the tab: a web page, not private, host able. */
  canPin(tab: Tab | undefined, win: ZenWindow): boolean {
    if (!tab || !this.supported || win.isPrivate) return false
    return /^https?:\/\//i.test(tab.url)
  }

  allPinned(): PinnedWebApp[] {
    return this.pinned
  }

  // ---------------------------------------------------------------------------
  // Page script messages
  // ---------------------------------------------------------------------------

  handleMessage(tabId: string, message: PageMessage): void {
    switch (message.webapp) {
      case 'manifest':
        this.onManifest(tabId, message)
        return
      case 'deferred':
        this.deferred.add(tabId)
        this.hideBanner(tabId)
        return
      case 'prompt': {
        const win = this.browser.tabs.windowFor(tabId)
        this.sitePrompts.add(tabId)
        this.openInstall(tabId, win)
        return
      }
    }
  }

  private onManifest(tabId: string, message: PageMessage): void {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab || typeof message.manifestUrl !== 'string') return
    if (message.manifest && typeof message.manifest === 'object') {
      this.applyManifest(tabId, parseWebAppManifest(message.manifest, message.manifestUrl, tab.url))
      return
    }
    // The page could not fetch its own manifest (a strict connect-src); fetch it from the host.
    const documentUrl = tab.url
    const manifestUrl = message.manifestUrl
    void this.browser.platform.net
      .fetchText(manifestUrl, {
        headers: { Accept: 'application/manifest+json, application/json;q=0.9, */*;q=0.5' },
        timeoutMs: MANIFEST_FETCH_TIMEOUT_MS
      })
      .then((res) => {
        if (!res.ok || !res.text || res.text.length > MAX_MANIFEST_BYTES) return
        const current = this.browser.tabs.tab(tabId)
        if (!current || current.url !== documentUrl) return
        let raw: unknown
        try {
          raw = JSON.parse(res.text)
        } catch {
          return
        }
        this.applyManifest(tabId, parseWebAppManifest(raw, manifestUrl, documentUrl))
      })
      .catch(() => undefined)
  }

  /** The tab's manifest is known: keep it, tell the page when it is installable, count the visit. */
  applyManifest(tabId: string, info: WebAppInfo | null): void {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab) return
    tab.webApp = info
    this.browser.state.commitVolatile()
    if (!info || !this.supported || this.browser.tabs.isPrivate(tab)) return
    if (!isInstallable(info) || this.pinnedFor(tab.url)) return

    this.browser.tabs.view(tabId)?.postToPage?.({ type: 'webapp', action: 'installable' })

    const now = this.now()
    const record = recordVisit(this.engagement[info.id], now)
    this.engagement[info.id] = record
    this.trimEngagement()
    this.save()
    if (!shouldPrompt(record, now)) return
    this.schedule(`banner:${tabId}`, DEFER_GRACE_MS, () => {
      const current = this.browser.tabs.tab(tabId)
      if (!current || current.webApp?.id !== info.id || this.deferred.has(tabId)) return
      // Meanwhile the user may have gone ahead through the menu: no banner behind the sheet,
      // none for an app that is on the Home screen by now.
      if (this.installOpen.has(tabId) || this.pinnedFor(current.url)) return
      this.showBanner(tabId, current, info)
    })
  }

  private trimEngagement(): void {
    const ids = Object.keys(this.engagement)
    if (ids.length <= MAX_ENGAGEMENT) return
    ids.sort((a, b) => this.engagement[a].lastVisitAt - this.engagement[b].lastVisitAt)
    for (const id of ids.slice(0, ids.length - MAX_ENGAGEMENT)) delete this.engagement[id]
  }

  // ---------------------------------------------------------------------------
  // Navigation / lifecycle
  // ---------------------------------------------------------------------------

  /** A tab moved to `url`: the manifest stays while the page is still inside the app's scope. */
  onNavigated(tabId: string, url: string, inPage: boolean): void {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab) return
    if (tab.webApp && !isWithinScope(url, tab.webApp.scope)) {
      tab.webApp = null
      this.hideBanner(tabId)
    } else if (!inPage && this.banners.has(tabId)) {
      // A new document inside the scope posts its manifest again; the banner returns if due.
      this.hideBanner(tabId, 'timeout')
    }
    if (!inPage) {
      // The page script starts over with the new document.
      this.deferred.delete(tabId)
      this.settleSitePrompt(tabId, 'dismissed')
      this.clear(`banner:${tabId}`)
    }
  }

  onTabRemoved(tabId: string): void {
    this.deferred.delete(tabId)
    this.sitePrompts.delete(tabId)
    this.installOpen.delete(tabId)
    this.banners.delete(tabId)
    this.clear(`banner:${tabId}`)
    this.clear(`banner-timeout:${tabId}`)
  }

  // ---------------------------------------------------------------------------
  // Ambient banner (PWA-03)
  // ---------------------------------------------------------------------------

  private showBanner(tabId: string, tab: Tab, info: WebAppInfo): void {
    const win = this.browser.tabs.windowFor(tabId)
    if (this.browser.tabs.activeTabFor(win)?.id !== tabId) return
    const now = this.now()
    const record = this.engagement[info.id]
    if (record) this.engagement[info.id] = markPrompted(record, now)
    this.save()
    this.banners.set(tabId, info.id)
    const banner: WebAppBanner = {
      tabId,
      name: launcherName(info),
      origin: originOf(tab.url),
      icon: displayIcon(info),
      tint: this.tileColorFor(info, tab)
    }
    this.browser.emit('webapp.banner', banner, win)
    this.schedule(`banner-timeout:${tabId}`, BANNER_TIMEOUT_MS, () =>
      this.hideBanner(tabId, 'timeout')
    )
  }

  /** The chrome reports the banner went away (or the core takes it down itself). */
  dismissBanner(tabId: string, reason: 'swipe' | 'timeout'): void {
    const appId = this.banners.get(tabId)
    this.banners.delete(tabId)
    this.clear(`banner-timeout:${tabId}`)
    if (!appId) return
    const record = this.engagement[appId]
    if (record && reason === 'swipe') {
      this.engagement[appId] = markDismissed(record, this.now())
      this.save()
    }
  }

  private hideBanner(tabId: string, reason: 'swipe' | 'timeout' = 'timeout'): void {
    if (!this.banners.has(tabId)) return
    this.dismissBanner(tabId, reason)
    this.browser.emit('webapp.bannerHide', { tabId }, this.browser.tabs.windowFor(tabId))
  }

  // ---------------------------------------------------------------------------
  // Install sheet (PWA-01 / PWA-04)
  // ---------------------------------------------------------------------------

  /** Open the install sheet (with a manifest) or the name-edit sheet (without). */
  openInstall(tabId: string, win: ZenWindow): void {
    const tab = this.browser.tabs.tab(tabId)
    if (!this.canPin(tab, win) || !tab) {
      this.settleSitePrompt(tabId, 'dismissed')
      return
    }
    // The user went ahead through the menu: a banner up or pending is moot.
    this.hideBanner(tabId)
    this.clear(`banner:${tabId}`)
    this.installOpen.add(tabId)
    const info = tab.webApp
    const prompt: WebAppInstallPrompt = {
      tabId,
      title: info ? launcherName(info) : fallbackShortcutTitle(tab.title, tab.url),
      url: info?.startUrl ?? tab.url,
      origin: originOf(tab.url),
      icon: (info && displayIcon(info)) ?? tab.favicon,
      info,
      tint: this.tileColorFor(info, tab)
    }
    this.browser.emit('webapp.install', prompt, win)
  }

  /** The sheet's "Add": ask the host to pin the page. */
  async pin(tabId: string, title: string, win: ZenWindow): Promise<void> {
    this.installOpen.delete(tabId)
    const tab = this.browser.tabs.tab(tabId)
    const host = this.browser.platform.shortcuts
    if (!tab || !host || !this.canPin(tab, win)) {
      this.settleSitePrompt(tabId, 'dismissed')
      return
    }
    const info = tab.webApp
    const name =
      title.replace(/\s+/g, ' ').trim().slice(0, 60) ||
      (info ? launcherName(info) : fallbackShortcutTitle(tab.title, tab.url))
    const icon = info ? shortcutIcon(info) : null
    const request: ShortcutRequest = {
      id: info?.id ?? tab.url,
      url: info?.startUrl ?? tab.url,
      title: name,
      iconUrl: icon?.url ?? tab.favicon,
      iconKind: icon ? icon.kind : tab.favicon ? 'any' : null,
      background: this.tileColorFor(info, tab),
      iconBackground: info?.backgroundColor ?? null
    }
    this.pendingPins.set(request.id, { tabId, title: name, url: request.url })
    if (info) this.pendingApps.set(request.id, { ...info, name })
    let ok = false
    try {
      ok = await host.pin(request)
    } catch {
      ok = false
    }
    if (!ok) {
      this.pendingPins.delete(request.id)
      this.pendingApps.delete(request.id)
      this.browser.toast("Couldn't add to Home screen", 'error', win)
      this.settleSitePrompt(tabId, 'dismissed')
    }
  }

  /** The sheet closed without pinning. */
  cancelInstall(tabId: string): void {
    this.installOpen.delete(tabId)
    this.settleSitePrompt(tabId, 'dismissed')
  }

  /** The launcher confirmed the shortcut (NOT-20): toast, register the app, tell the page. */
  onPinned(id: string): void {
    const pending = this.pendingPins.get(id)
    this.pendingPins.delete(id)
    const info = this.pendingApps.get(id)
    this.pendingApps.delete(id)
    const win = pending ? this.browser.tabs.windowFor(pending.tabId) : undefined
    const title = pending?.title ?? info?.name ?? 'Shortcut'
    if (info) {
      this.pinned = this.pinned.filter((p) => p.id !== id)
      this.pinned.push({
        id,
        name: title,
        startUrl: info.startUrl,
        scope: info.scope,
        pinnedAt: this.now()
      })
      this.save()
    }
    this.browser.toast(`Added ${title} to Home screen`, 'info', win)
    if (pending) {
      this.hideBanner(pending.tabId)
      this.settleSitePrompt(pending.tabId, 'accepted')
      this.browser.tabs.view(pending.tabId)?.postToPage?.({ type: 'webapp', action: 'installed' })
    }
    this.browser.state.commitVolatile()
  }

  /** A site's deferred `prompt()` learns how the sheet ended. */
  private settleSitePrompt(tabId: string, outcome: 'accepted' | 'dismissed'): void {
    if (!this.sitePrompts.delete(tabId)) return
    this.browser.tabs.view(tabId)?.postToPage?.({ type: 'webapp', action: 'result', outcome })
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * The colour behind the app's letter tile, as `#rrggbb`: the manifest's theme colour when it
   * is paintable, else the space's accent. The same value reaches the sheet, the banner and the
   * host's pin request, so the preview tile and the launcher tile agree.
   */
  private tileColorFor(info: WebAppInfo | null, tab: Tab): string {
    return tileColor(info?.themeColor ?? null, this.accentFor(tab))
  }

  /** The space's accent colour as a hex string. */
  private accentFor(tab: Tab): string {
    const space = getSpace(this.browser.state.model, tab.spaceId)
    const dark = this.browser.state.settings.colorScheme === 'dark'
    return rgbToHex(resolveTheme(space?.theme ?? null, dark).accent)
  }

  private schedule(key: string, delay: number, fn: () => void): void {
    this.clear(key)
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key)
        fn()
      }, delay)
    )
  }

  private clear(key: string): void {
    const timer = this.timers.get(key)
    if (timer) clearTimeout(timer)
    this.timers.delete(key)
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
