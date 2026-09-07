import type { Suggestion } from '../shared/types'
import {
  buildSearchUrl,
  buildSuggestUrl,
  matchEngineKeyword,
  parseSuggestResponse
} from '../shared/search'
import { searchCommands } from '../shared/commands'
import { spaceLabel } from '../shared/defaults'
import { displayUrl, inputToUrl, isProbablyUrl } from '../shared/url'
import type { Browser } from './browser'
import type { ZenWindow } from './window'
import { orderedTabsForSpace, tabVisibleIn } from './model'

/**
 * Builds the URL bar result list the way Zen does: inline URL autofill, history, open tabs
 * ("Switch to Tab"), bookmarks, spaces (type a space name to switch), Command Bar actions and
 * live search suggestions from the selected engine.
 */
export class SuggestionService {
  private cache = new Map<string, string[]>()
  private inFlight: AbortController | null = null

  constructor(private readonly browser: Browser) {}

  async suggest(
    rawQuery: string,
    currentTabId: string | null,
    win: ZenWindow = this.browser.focusedWindow()
  ): Promise<Suggestion[]> {
    const query = rawQuery.trim()
    const state = this.browser.state
    const engines = state.searchEngines
    const defaultEngine = engines.find((e) => e.id === state.settings.searchEngineId) ?? engines[0]
    const results: Suggestion[] = []
    const isPrivate = win.isPrivate
    const local = Boolean(win.localSpace)

    if (!query) return isPrivate ? [] : this.emptyState()

    // "` " prefix → spaces only (Zen's space-only search mode).
    if (query.startsWith('`')) {
      if (local) return []
      const q = query.slice(1).trim().toLowerCase()
      return state.model.spaces
        .filter((s) => !q || s.name.toLowerCase().includes(q))
        .map((s) => ({
          id: `space:${s.id}`,
          kind: 'space' as const,
          title: spaceLabel(s),
          subtitle: s.id === win.activeSpaceId ? 'Current space' : 'Switch to space',
          url: null,
          favicon: null,
          targetId: s.id,
          fill: query
        }))
    }

    const keyword = matchEngineKeyword(query, engines)
    const engine = keyword?.engine ?? defaultEngine
    const searchTerms = keyword ? keyword.query : query

    const url = inputToUrl(query)
    if (url) {
      results.push({
        id: 'url',
        kind: 'url',
        title: displayUrl(url) || url,
        subtitle: 'Visit',
        url,
        favicon: null,
        targetId: null,
        fill: query
      })
    } else {
      // Inline autofill from history (e.g. "gith" → "github.com/").
      const autofill = this.browser.history.autofill(query)
      if (autofill && autofill.toLowerCase().startsWith(query.toLowerCase())) {
        results.push({
          id: 'autofill',
          kind: 'url',
          title: autofill.replace(/\/$/, ''),
          subtitle: 'Visit',
          url: `https://${autofill}`,
          favicon: null,
          targetId: null,
          fill: autofill
        })
      }
    }

    if (!isProbablyUrl(query) || keyword) {
      results.push({
        id: 'search',
        kind: 'search',
        title: searchTerms,
        subtitle: `Search with ${engine.name}`,
        url: buildSearchUrl(engine, searchTerms),
        favicon: null,
        targetId: engine.id,
        fill: query
      })
    }

    for (const cmd of searchCommands(query)) {
      results.push({
        id: `cmd:${cmd.id}`,
        kind: 'command',
        title: cmd.label,
        subtitle: 'Command',
        url: null,
        favicon: null,
        targetId: cmd.action,
        fill: query
      })
    }

    const q = query.toLowerCase()
    if (!local) {
      for (const space of state.model.spaces) {
        if (space.id !== win.activeSpaceId && space.name.toLowerCase().includes(q)) {
          results.push({
            id: `space:${space.id}`,
            kind: 'space',
            title: spaceLabel(space),
            subtitle: 'Switch to space',
            url: null,
            favicon: null,
            targetId: space.id,
            fill: query
          })
        }
      }
    }

    // Open tabs → "Switch to Tab" (only tabs this window can show; private tabs stay private).
    const seenUrls = new Set<string>(results.map((r) => r.url ?? ''))
    const space = win.activeSpace()
    const m = state.model
    const openTabs = [
      ...orderedTabsForSpace(m, space, state.settings.containerSpecificEssentials, win.id),
      ...(local
        ? []
        : Object.values(m.tabs).filter(
            (t) =>
              t.spaceId &&
              t.spaceId !== space.id &&
              !m.localSpaces[t.spaceId] &&
              tabVisibleIn(t, win.id)
          ))
    ]
    let tabHits = 0
    for (const tab of openTabs) {
      if (tab.id === currentTabId || tabHits >= 3) continue
      const hay = `${tab.customTitle ?? ''} ${tab.title} ${tab.url}`.toLowerCase()
      if (!hay.includes(q)) continue
      results.push({
        id: `tab:${tab.id}`,
        kind: 'tab',
        title: tab.customTitle ?? tab.title,
        subtitle: `Switch to Tab · ${displayUrl(tab.url)}`,
        url: tab.url,
        favicon: tab.favicon,
        targetId: tab.id,
        fill: query
      })
      seenUrls.add(tab.url)
      tabHits += 1
    }

    for (const bm of isPrivate ? [] : this.browser.bookmarks.search(query, 3)) {
      if (seenUrls.has(bm.url)) continue
      results.push({
        id: `bm:${bm.id}`,
        kind: 'bookmark',
        title: bm.title,
        subtitle: displayUrl(bm.url),
        url: bm.url,
        favicon: bm.favicon,
        targetId: bm.id,
        fill: query
      })
      seenUrls.add(bm.url)
    }

    for (const entry of isPrivate ? [] : this.browser.history.search(query, 6)) {
      if (seenUrls.has(entry.url)) continue
      results.push({
        id: `hist:${entry.url}`,
        kind: 'history',
        title: entry.title,
        subtitle: displayUrl(entry.url),
        url: entry.url,
        favicon: entry.favicon,
        targetId: null,
        fill: query
      })
      seenUrls.add(entry.url)
    }

    if (state.settings.searchSuggestions && !isPrivate && searchTerms.length >= 2 && !url) {
      const terms = await this.fetchSearchSuggestions(engine.id, searchTerms)
      for (const term of terms.slice(0, 4)) {
        if (term.toLowerCase() === searchTerms.toLowerCase()) continue
        results.push({
          id: `sugg:${term}`,
          kind: 'search',
          title: term,
          subtitle: `Search with ${engine.name}`,
          url: buildSearchUrl(engine, term),
          favicon: null,
          targetId: engine.id,
          fill: keyword ? `${keyword.engine.keyword} ${term}` : term
        })
      }
    }

    return results.slice(0, 12)
  }

  private emptyState(): Suggestion[] {
    return this.browser.history.recent(8).map((entry) => ({
      id: `hist:${entry.url}`,
      kind: 'history' as const,
      title: entry.title,
      subtitle: displayUrl(entry.url),
      url: entry.url,
      favicon: entry.favicon,
      targetId: null,
      fill: displayUrl(entry.url)
    }))
  }

  private async fetchSearchSuggestions(engineId: string, query: string): Promise<string[]> {
    const engine = this.browser.state.searchEngines.find((e) => e.id === engineId)
    if (!engine) return []
    const url = buildSuggestUrl(engine, query)
    if (!url) return []
    const cacheKey = `${engineId}|${query.toLowerCase()}`
    const cached = this.cache.get(cacheKey)
    if (cached) return cached
    this.inFlight?.abort()
    const controller = new AbortController()
    this.inFlight = controller
    const timer = setTimeout(() => controller.abort(), 900)
    try {
      const res = await this.browser.platform.net.fetchText(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' }
      })
      if (!res.ok) return []
      const body: unknown = JSON.parse(res.text)
      const list = parseSuggestResponse(body)
      this.cache.set(cacheKey, list)
      if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value as string)
      return list
    } catch {
      return []
    } finally {
      clearTimeout(timer)
      if (this.inFlight === controller) this.inFlight = null
    }
  }
}
