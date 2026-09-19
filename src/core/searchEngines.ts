/**
 * The user's search engines beyond the shipped list: OpenSearch discovery on visited pages
 * (Chrome's "Recently visited" engines), the Settings > Search "Add search engine" form, and the
 * URL bar's clipboard row, whose reads go through the host's description-only peek.
 */
import type { Browser } from './browser'
import type { ZenWindow } from './window'
import type { ClipboardContent, ClipboardPeekKind } from '../shared/types'
import {
  MAX_OPENSEARCH_BYTES,
  customSearchEngine,
  discoveredSearchEngine,
  parseOpenSearchDescription,
  rememberDiscoveredEngine,
  searchTemplateProblem
} from '../shared/search'
import { isProbablyUrl } from '../shared/url'

/** A description fetch that has not answered by then is not worth an engine. */
const DESCRIPTION_FETCH_TIMEOUT_MS = 6000
/** A site visited again within this long keeps its engine as it is (no fetch, no settings write). */
const REFRESH_MS = 10 * 60 * 1000
/** The longest clipboard text the URL bar will search for or open. */
const MAX_CLIP_TEXT = 2000

/** Recently fetched descriptions remembered, so a long session cannot grow the map without bound. */
const MAX_RECENT = 64

export class SearchEngineService {
  /** Description URLs being fetched now: a page that links its description twice fetches once. */
  private readonly inFlight = new Set<string>()
  /** Description URL → when it was last fetched; a site browsed page by page fetches once. */
  private readonly recent = new Map<string, number>()
  private readonly now: () => number

  constructor(
    private readonly browser: Browser,
    options: { now?: () => number } = {}
  ) {
    this.now = options.now ?? Date.now
  }

  // ---------------------------------------------------------------------------
  // OpenSearch discovery
  // ---------------------------------------------------------------------------

  /**
   * The page in `tabId` links an OpenSearch description at `url`: fetch and parse it, and
   * remember the engine as visited now. Private tabs leave no trace; a site whose engine was
   * refreshed within `REFRESH_MS` is left alone.
   */
  async discover(tabId: string, url: string, title: string): Promise<void> {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab || this.browser.tabs.isPrivate(tab)) return
    let descriptionUrl: URL
    try {
      descriptionUrl = new URL(url, tab.url)
    } catch {
      return
    }
    if (descriptionUrl.protocol !== 'https:' && descriptionUrl.protocol !== 'http:') return
    const href = descriptionUrl.href
    const now = this.now()
    if ((this.recent.get(href) ?? 0) > now - REFRESH_MS || this.inFlight.has(href)) return
    this.inFlight.add(href)
    const documentUrl = tab.url
    try {
      const res = await this.browser.platform.net.fetchText(href, {
        headers: { Accept: 'application/opensearchdescription+xml, application/xml;q=0.9, */*;q=0.5' },
        timeoutMs: DESCRIPTION_FETCH_TIMEOUT_MS
      })
      if (!res.ok || !res.text || res.text.length > MAX_OPENSEARCH_BYTES) return
      const current = this.browser.tabs.tab(tabId)
      // The user moved on: the description belongs to a page they are no longer visiting.
      if (!current || current.url !== documentUrl) return
      const description = parseOpenSearchDescription(res.text, href, title)
      if (!description) return
      this.recent.set(href, this.now())
      if (this.recent.size > MAX_RECENT) this.recent.delete(this.recent.keys().next().value!)
      this.remember(description)
    } catch {
      // Unreachable descriptions are the site's problem; nothing to tell the user.
    } finally {
      this.inFlight.delete(href)
    }
  }

  /** A parsed description joins the user's engines (exposed for the tests and the demo host). */
  remember(description: ReturnType<typeof parseOpenSearchDescription>): void {
    if (!description) return
    const state = this.browser.state
    const engine = discoveredSearchEngine(description, this.now(), state.searchEngines)
    if (!engine) return
    const user = state.settings.searchEngines ?? []
    const next = rememberDiscoveredEngine(user, engine, state.settings.searchEngineId)
    if (sameEngines(user, next)) return
    state.settings.searchEngines = next
    state.commit()
  }

  // ---------------------------------------------------------------------------
  // Settings > Search
  // ---------------------------------------------------------------------------

  /**
   * Add an engine by hand: `url` carries `%s` where the terms go. Rejects with the reason the
   * form shows (`searchTemplateProblem`); resolves with the new engine's id.
   */
  add(name: string, url: string, win: ZenWindow): string {
    const cleanName = name.trim()
    if (!cleanName) throw new Error('Enter a name')
    const problem = searchTemplateProblem(url)
    if (problem) throw new Error(problem)
    const state = this.browser.state
    const engine = customSearchEngine(cleanName, url, state.searchEngines)
    this.browser.updateSettings(
      { searchEngines: [...(state.settings.searchEngines ?? []), engine] },
      win
    )
    return engine.id
  }

  /**
   * Forget an engine the user added or a page offered; the shipped ones stay. The default
   * falls back to the shipped default when its engine goes (`updateSettings`).
   */
  remove(id: string, win: ZenWindow): void {
    const user = this.browser.state.settings.searchEngines ?? []
    if (!user.some((e) => e.id === id)) return
    this.browser.updateSettings({ searchEngines: user.filter((e) => e.id !== id) }, win)
  }

  // ---------------------------------------------------------------------------
  // The clipboard row
  // ---------------------------------------------------------------------------

  /**
   * What the clipboard holds, from its description alone: the host reads no content, so
   * Android 12+ shows no "pasted from" toast. Hosts without the peek offer nothing.
   */
  async peekClipboard(): Promise<ClipboardPeekKind> {
    const peek = this.browser.platform.clipboard.peek
    if (!peek) return 'none'
    try {
      return await peek.call(this.browser.platform.clipboard)
    } catch {
      return 'none'
    }
  }

  /**
   * The clipboard's text, read once on the user's reveal or pick: a URL to open, or text to
   * search for; `none` when the clip is empty (or not text after all).
   */
  async readClipboard(): Promise<ClipboardContent> {
    const read = this.browser.platform.clipboard.read
    if (!read) return { kind: 'none', text: '' }
    let text: string
    try {
      text = (await read.call(this.browser.platform.clipboard)).trim()
    } catch {
      return { kind: 'none', text: '' }
    }
    if (!text) return { kind: 'none', text: '' }
    if (text.length > MAX_CLIP_TEXT) text = text.slice(0, MAX_CLIP_TEXT)
    const oneLine = text.replace(/\s+/g, ' ')
    return isProbablyUrl(text) && !/\s/.test(text)
      ? { kind: 'url', text }
      : { kind: 'text', text: oneLine }
  }
}

function sameEngines(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b)
}
