import type { Boost } from '../shared/types'
import { boostCss, emptyBoost, isEmptyBoost } from '../shared/boosts'
import { getDomain } from '../shared/url'
import { JsonStore } from './store/JsonStore'
import type { Browser } from './browser'

interface Persisted {
  version: 1
  boosts: Boost[]
}

/**
 * Zen's Boosts: per-site tint, fonts, zapped elements, forced dark mode and custom CSS.
 * Compiled to one stylesheet per domain and injected into every page of that domain.
 */
export class BoostService {
  private boosts = new Map<string, Boost>()
  private readonly store: JsonStore<Persisted>
  /** tabId → inserted stylesheet key (so it can be swapped when the boost changes). */
  private readonly injected = new Map<string, { domain: string; key: string }>()
  private readonly zapping = new Set<string>()

  constructor(private readonly browser: Browser) {
    this.store = new JsonStore<Persisted>(browser.platform.io, 'boosts.json', 300)
    const data = this.store.readSync()
    if (data?.version === 1 && Array.isArray(data.boosts)) {
      for (const b of data.boosts)
        if (b && typeof b.domain === 'string') this.boosts.set(b.domain, b)
    }
  }

  all(): Boost[] {
    return [...this.boosts.values()].sort((a, b) => a.domain.localeCompare(b.domain))
  }

  get(domain: string): Boost | undefined {
    return this.boosts.get(domain)
  }

  /** The boost for a page URL, when there is one. */
  forUrl(url: string): Boost | undefined {
    const domain = getDomain(url)
    return domain ? this.boosts.get(domain) : undefined
  }

  zappingTabId(): string | null {
    return this.zapping.values().next().value ?? null
  }

  isZapping(tabId: string): boolean {
    return this.zapping.has(tabId)
  }

  update(domain: string, patch: Partial<Omit<Boost, 'domain' | 'updatedAt'>>): void {
    if (!domain) return
    const current = this.boosts.get(domain) ?? emptyBoost(domain)
    const next: Boost = { ...current, ...patch, domain, updatedAt: Date.now() }
    next.zapped = [...new Set(next.zapped.map((s) => s.trim()).filter(Boolean))]
    next.tintIntensity = Math.max(0, Math.min(1, Number(next.tintIntensity) || 0))
    next.fontSize = Math.max(50, Math.min(200, Math.round(Number(next.fontSize) || 100)))
    this.boosts.set(domain, next)
    this.persist()
    this.reapply(domain)
    this.browser.state.commitVolatile()
  }

  /** Replace a whole record (used by sync). Returns true when something changed. */
  put(boost: Boost): boolean {
    const before = JSON.stringify(this.boosts.get(boost.domain))
    if (before === JSON.stringify(boost)) return false
    this.boosts.set(boost.domain, boost)
    this.persist()
    this.reapply(boost.domain)
    this.browser.state.commitVolatile()
    return true
  }

  remove(domain: string): void {
    if (!this.boosts.delete(domain)) return
    this.persist()
    this.reapply(domain)
    this.browser.state.commitVolatile()
  }

  // ---------------------------------------------------------------------------
  // Zap element
  // ---------------------------------------------------------------------------

  startZap(tabId: string): void {
    const view = this.browser.tabs.view(tabId)
    if (!view) return
    this.zapping.add(tabId)
    view.setZapMode(true)
    view.focus()
    this.browser.toast(
      'Click an element to hide it. Press Esc to cancel.',
      'info',
      this.browser.tabs.windowFor(tabId)
    )
    this.browser.state.commitVolatile()
  }

  stopZap(tabId: string): void {
    if (!this.zapping.delete(tabId)) return
    this.browser.tabs.view(tabId)?.setZapMode(false)
    this.browser.state.commitVolatile()
  }

  /** The page reported the element the user clicked in zap mode. */
  onZapped(tabId: string, selector: string): void {
    const tab = this.browser.tabs.tab(tabId)
    this.stopZap(tabId)
    if (!tab || !selector || selector.length > 400) return
    const domain = getDomain(tab.url)
    if (!domain) return
    const boost = this.boosts.get(domain) ?? emptyBoost(domain)
    this.update(domain, { zapped: [...boost.zapped, selector] })
  }

  // ---------------------------------------------------------------------------
  // Injection
  // ---------------------------------------------------------------------------

  /** Called on `dom-ready`: inject the domain's boost into the page. */
  apply(tabId: string): void {
    const tab = this.browser.tabs.tab(tabId)
    const view = this.browser.tabs.view(tabId)
    if (!tab || !view) return
    const previous = this.injected.get(tabId)
    if (previous) {
      this.injected.delete(tabId)
      void view.removeInsertedCSS(previous.key).catch(() => undefined)
    }
    const domain = getDomain(tab.url)
    const boost = domain ? this.boosts.get(domain) : undefined
    if (!boost || !/^https?:/.test(tab.url)) return
    const css = boostCss(boost)
    if (!css) return
    void view
      .insertCSS(css)
      .then((key) => {
        if (this.browser.tabs.view(tabId) === view) this.injected.set(tabId, { domain, key })
      })
      .catch(() => undefined)
  }

  private reapply(domain: string): void {
    for (const [tabId] of this.browser.tabs.allViews()) {
      const tab = this.browser.tabs.tab(tabId)
      if (tab && getDomain(tab.url) === domain) this.apply(tabId)
    }
  }

  private persist(): void {
    this.store.write({
      version: 1,
      boosts: [...this.boosts.values()].filter((b) => !isEmptyBoost(b) || b.enabled === false)
    })
  }

  flushSync(): void {
    this.store.flushSync()
  }
}
