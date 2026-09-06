import { net } from 'electron'
import { join } from 'node:path'
import type { LiveFolderConfig } from '../../shared/types'
import {
  LIVE_FOLDER_MAX_BYTES,
  LOCAL_REST_MAPPING,
  githubSearchUrl,
  isLocalEndpoint,
  parseFeed,
  parseGithubSearch,
  parseRestItems,
  type LiveItem
} from '../../shared/livefolders'
import { JsonStore } from '../store/JsonStore'
import { getSpace } from './model'
import type { Browser } from './browser'

interface Persisted {
  version: 1
  folders: LiveFolderConfig[]
}

/**
 * Zen's Live Folders: a folder bound to a provider (GitHub PRs / issues, RSS, REST) whose tabs
 * are created and retired automatically. Closing or ungrouping a live tab dismisses its item.
 */
export class LiveFolderService {
  private configs = new Map<string, LiveFolderConfig>()
  private readonly store: JsonStore<Persisted>
  private timer: NodeJS.Timeout | null = null
  private inFlight = new Set<string>()

  constructor(
    private readonly browser: Browser,
    userDataDir: string
  ) {
    this.store = new JsonStore<Persisted>(join(userDataDir, 'zen', 'live-folders.json'), 500)
    const data = this.store.readSync()
    if (data?.version === 1 && Array.isArray(data.folders)) {
      for (const f of data.folders)
        if (f && typeof f.folderId === 'string')
          this.configs.set(f.folderId, { ...f, items: f.items ?? {} })
    }
  }

  start(): void {
    // Drop configs whose folder disappeared while we were not running.
    for (const id of [...this.configs.keys()]) {
      if (!this.browser.state.model.folders[id]) this.configs.delete(id)
    }
    this.persist()
    if (this.timer) return
    this.timer = setInterval(() => void this.refreshDue(), 60_000)
    setTimeout(() => void this.refreshDue(), 3_000)
  }

  all(): Record<string, LiveFolderConfig> {
    return Object.fromEntries(this.configs)
  }

  get(folderId: string): LiveFolderConfig | undefined {
    return this.configs.get(folderId)
  }

  /** Create or update the live configuration of a folder and fetch right away. */
  save(
    folderId: string,
    config: Pick<
      LiveFolderConfig,
      'provider' | 'source' | 'includeDrafts' | 'token' | 'mapping' | 'intervalMinutes' | 'maxItems'
    >
  ): void {
    const existing = this.configs.get(folderId)
    const next: LiveFolderConfig = {
      folderId,
      provider: config.provider,
      source: config.source.trim(),
      includeDrafts: Boolean(config.includeDrafts),
      token: config.token?.trim() ?? '',
      mapping: config.provider === 'rest' ? config.mapping : null,
      intervalMinutes: Math.max(5, Math.min(24 * 60, Math.round(config.intervalMinutes) || 30)),
      maxItems: Math.max(1, Math.min(100, Math.round(config.maxItems) || 100)),
      lastFetched: null,
      lastError: null,
      dismissed: existing?.dismissed ?? [],
      items: existing?.items ?? {}
    }
    this.configs.set(folderId, next)
    this.persist()
    this.browser.state.commitVolatile()
    void this.refresh(folderId, true)
  }

  setInterval(folderId: string, minutes: number): void {
    const cfg = this.configs.get(folderId)
    if (!cfg) return
    cfg.intervalMinutes = minutes
    this.persist()
    this.browser.state.commitVolatile()
  }

  /** Turn a live folder back into a static one (its tabs stay). */
  remove(folderId: string): void {
    if (!this.configs.delete(folderId)) return
    this.persist()
    this.browser.state.commitVolatile()
  }

  /** The folder itself was deleted. */
  onFolderDeleted(folderId: string): void {
    this.remove(folderId)
  }

  /** A tab left its folder (closed, moved, ungrouped): dismiss the item it represented. */
  onTabLeftFolder(tabId: string, folderId: string | null): void {
    if (!folderId) return
    const cfg = this.configs.get(folderId)
    if (!cfg) return
    const itemId = Object.keys(cfg.items).find((k) => cfg.items[k] === tabId)
    if (!itemId) return
    delete cfg.items[itemId]
    if (!cfg.dismissed.includes(itemId)) cfg.dismissed.push(itemId)
    if (cfg.dismissed.length > 500) cfg.dismissed.splice(0, cfg.dismissed.length - 500)
    this.persist()
    this.browser.state.commitVolatile()
  }

  private async refreshDue(): Promise<void> {
    const now = Date.now()
    for (const cfg of this.configs.values()) {
      const due = !cfg.lastFetched || now - cfg.lastFetched >= cfg.intervalMinutes * 60_000
      if (due) await this.refresh(cfg.folderId, false)
    }
  }

  async refresh(folderId: string, force: boolean): Promise<void> {
    const cfg = this.configs.get(folderId)
    const folder = this.browser.state.model.folders[folderId]
    if (!cfg || !folder || this.inFlight.has(folderId)) return
    if (!force && cfg.lastFetched && Date.now() - cfg.lastFetched < 60_000) return
    this.inFlight.add(folderId)
    try {
      const items = (await this.fetchItems(cfg)).slice(0, cfg.maxItems)
      this.reconcile(cfg, items)
      cfg.lastError = null
    } catch (error) {
      cfg.lastError = (error as Error).message || 'Could not update this folder'
    } finally {
      cfg.lastFetched = Date.now()
      this.inFlight.delete(folderId)
      this.persist()
      this.browser.state.commit()
    }
  }

  private async fetchItems(cfg: LiveFolderConfig): Promise<LiveItem[]> {
    switch (cfg.provider) {
      case 'github-pulls':
      case 'github-issues': {
        if (!cfg.source) throw new Error('Enter a GitHub username')
        const headers: Record<string, string> = {
          accept: 'application/vnd.github+json',
          'user-agent': 'zen-chromium-live-folders'
        }
        if (cfg.token) headers.authorization = `Bearer ${cfg.token}`
        const body = await this.fetchJson(githubSearchUrl(cfg), headers)
        return parseGithubSearch(body, cfg.includeDrafts)
      }
      case 'rss': {
        const xml = await this.fetchText(cfg.source, {
          accept:
            'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
        })
        return parseFeed(xml)
      }
      case 'rest': {
        const mapping = isLocalEndpoint(cfg.source) ? LOCAL_REST_MAPPING : cfg.mapping
        if (!mapping) throw new Error('A field mapping is required for remote APIs')
        const body = await this.fetchJson(cfg.source, { accept: 'application/json' })
        return parseRestItems(body, mapping, cfg.source)
      }
    }
  }

  private async fetchText(url: string, headers: Record<string, string>): Promise<string> {
    if (!/^https?:\/\//i.test(url)) throw new Error('Enter an http(s) URL')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const res = await net.fetch(url, { headers, signal: controller.signal, cache: 'no-store' })
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      const length = Number(res.headers.get('content-length') ?? 0)
      if (length > LIVE_FOLDER_MAX_BYTES) throw new Error('Response larger than 1 MB')
      const text = await res.text()
      if (text.length > LIVE_FOLDER_MAX_BYTES) throw new Error('Response larger than 1 MB')
      return text
    } finally {
      clearTimeout(timer)
    }
  }

  private async fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
    const text = await this.fetchText(url, headers)
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('Response is not JSON')
    }
  }

  /** Create tabs for new items, refresh existing ones, retire items that disappeared. */
  private reconcile(cfg: LiveFolderConfig, items: LiveItem[]): void {
    const { tabs, state } = this.browser
    const folder = state.model.folders[cfg.folderId]
    if (!folder) return
    const space = getSpace(state.model, folder.spaceId)
    if (!space) return
    const seen = new Set<string>()
    for (const item of items) {
      if (cfg.dismissed.includes(item.id)) continue
      seen.add(item.id)
      const existingId = cfg.items[item.id]
      const existing = existingId ? tabs.tab(existingId) : undefined
      if (existing && existing.folderId === cfg.folderId) {
        if (existing.discarded && existing.url !== item.url) existing.url = item.url
        if (existing.discarded && !existing.customTitle) existing.title = item.title
        continue
      }
      const tab = tabs.createTab(
        {
          url: item.url,
          spaceId: space.id,
          active: false,
          load: false,
          folderId: cfg.folderId,
          containerId: space.containerId
        },
        this.browser.allWindows().find((w) => w.kind === 'synced') ?? this.browser.focusedWindow()
      )
      tab.title = item.title
      cfg.items[item.id] = tab.id
    }
    for (const [itemId, tabId] of Object.entries(cfg.items)) {
      if (seen.has(itemId)) continue
      delete cfg.items[itemId]
      const tab = tabs.tab(tabId)
      // Items that vanished upstream (merged PR, closed issue) take their unloaded tab with them.
      if (tab && tab.folderId === cfg.folderId && tab.discarded) tabs.closeTab(tabId, true)
    }
  }

  private persist(): void {
    this.store.write({ version: 1, folders: [...this.configs.values()] })
  }

  flushSync(): void {
    this.store.flushSync()
  }
}
