import type { SearchEngine, Suggestion } from '../shared/types'
import {
  SEARCH_SCOPES,
  buildSearchUrl,
  buildSuggestUrl,
  engineKeywords,
  matchKeyword,
  parseSuggestPayload,
  type KeywordMatch,
  type SuggestPayload
} from '../shared/search'
import { localAnswer } from '../shared/answers'
import { searchCommands } from '../shared/commands'
import { spaceLabel } from '../shared/defaults'
import {
  BOOKMARKS_URL,
  HISTORY_URL,
  displayUrl,
  inputToUrl,
  isEmptyTabUrl,
  isProbablyUrl
} from '../shared/url'
import type { Browser } from './browser'
import type { ZenWindow } from './window'
import { orderedTabsForSpace, tabVisibleIn } from './model'
import { AnswerService } from './answers'

/**
 * Chromium's relevance scale, so rows from every source sort against each other: the verbatim
 * query is 1300; a history completion that may be inlined outranks it; answers sit just under
 * it; engine suggestions come with their own score (Google sends 550–700 for plain queries and
 * above the verbatim when one should be inlined).
 */
export const RELEVANCE = {
  autofill: 1400,
  verbatim: 1300,
  keywordStarter: 1290,
  answer: 1250,
  intranet: 1240,
  entity: 1150,
  tabPrefix: 1120,
  bookmarkPrefix: 1100,
  historyHostPrefix: 1050,
  command: 1010,
  tab: 1000,
  historyTitlePrefix: 980,
  bookmark: 950,
  space: 900,
  history: 880
} as const

/** Rows shown at most; Chrome's desktop popup holds eight, Zenium's field is taller. */
export const MAX_ROWS = 10
const REMOTE_TIMEOUT_MS = 900
const INTRANET_TIMEOUT_MS = 400

type Ranked = Suggestion & { relevance: number }

/**
 * Builds the URL bar result list the way Chrome ranks its omnibox and Zen presents it: one
 * default match completed inline, then history, open tabs ("Switch to tab"), bookmarks, spaces,
 * Command Bar actions, answers (calculator, units, currency, weather, time, definitions),
 * Wikipedia entities and the engine's live suggestions, all merged by relevance.
 */
export class SuggestionService {
  private readonly remoteCache = new Map<string, SuggestPayload>()
  private readonly intranetCache = new Map<string, boolean>()
  private inFlight: AbortController | null = null
  readonly answers: AnswerService

  constructor(private readonly browser: Browser) {
    this.answers = new AnswerService(browser.platform.net)
  }

  async suggest(
    rawQuery: string,
    currentTabId: string | null,
    win: ZenWindow = this.browser.focusedWindow()
  ): Promise<Suggestion[]> {
    const query = rawQuery.trim()
    const state = this.browser.state
    const engines = state.searchEngines
    const defaultEngine = engines.find((e) => e.id === state.settings.searchEngineId) ?? engines[0]
    const isPrivate = win.isPrivate
    const local = Boolean(win.localSpace)

    if (!query) return isPrivate ? [] : this.emptyState()

    // An extension's `chrome.omnibox` keyword owns the input from the space after it on: the
    // rows are what the extension suggests, nothing else (Chrome's keyword mode).
    const omnibox = isPrivate ? null : await this.browser.extensions.omniboxSuggest(rawQuery, win)
    if (omnibox) return omnibox

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

    // One request per keystroke: the previous keystroke's lookups are abandoned.
    this.inFlight?.abort()
    const controller = new AbortController()
    this.inFlight = controller
    const signal = controller.signal

    // `@ddg ` with nothing after it is already keyword mode: the trailing space counts here.
    const keyword = matchKeyword(rawQuery.trimStart(), engines)
    if (keyword?.kind === 'scope') return this.scopeResults(keyword, query, currentTabId, win)
    const engine = keyword?.engine ?? defaultEngine
    const searchTerms = keyword ? keyword.query : query
    const searchFill = (term: string): string => (keyword ? `${keyword.keyword} ${term}` : term)

    const rows: Ranked[] = []

    // `@d` before the space: the keywords it could become.
    if (!keyword && /^@\S+$/.test(query)) rows.push(...this.keywordStarters(query, engines))

    // The verbatim match: what was typed, as a URL or as a search.
    const url = keyword ? null : inputToUrl(query)
    if (url) {
      rows.push({
        id: 'url',
        kind: 'url',
        title: displayUrl(url) || url,
        subtitle: '',
        url,
        favicon: null,
        targetId: null,
        fill: query,
        relevance: RELEVANCE.verbatim
      })
    }
    const searchUrl = buildSearchUrl(engine, searchTerms)
    if ((!isProbablyUrl(query) || keyword) && searchTerms) {
      rows.push({
        id: 'search',
        kind: 'search',
        title: searchTerms,
        subtitle: `Search with ${engine.name}`,
        url: searchUrl,
        favicon: null,
        targetId: engine.id,
        fill: query,
        relevance: RELEVANCE.verbatim
      })
    }

    // The default match to complete inline: the most frecent visited host or URL with this prefix.
    if (!keyword && !isPrivate) {
      const autofill = this.browser.history.autofill(query)
      if (autofill && autofill.fill.length > query.length) {
        rows.push({
          id: 'autofill',
          kind: 'url',
          title: autofill.fill.replace(/\/$/, ''),
          subtitle: '',
          url: autofill.url,
          favicon: this.browser.history.faviconFor(autofill.url),
          targetId: null,
          fill: autofill.fill,
          relevance: RELEVANCE.autofill
        })
      }
    }

    // Offline answers: arithmetic and unit conversions. Enter searches the question, as Chrome.
    const offline = keyword ? null : localAnswer(query)
    if (offline) {
      rows.push({
        id: 'answer:local',
        kind: 'answer',
        title: offline.text,
        subtitle: query,
        url: searchUrl,
        favicon: null,
        targetId: null,
        fill: query,
        relevance: RELEVANCE.answer
      })
    }

    if (!keyword) {
      rows.push(...this.commandRows(query, win))
      if (!local) rows.push(...this.spaceRows(query, win))
      rows.push(...this.tabRows(query, currentTabId, win, 3))
      if (!isPrivate) {
        rows.push(...this.bookmarkRows(query, 3))
        rows.push(...this.historyRows(query, 6))
      }
    }

    // Network sources run together; the popup waits for the slowest but never past its timeout.
    const online = state.settings.searchSuggestions && !isPrivate
    const wantsRemote = online && searchTerms.length >= 2 && !url
    const wantsAnswer = online && !keyword && !url && !offline
    const wantsEntity = online && !keyword && !url
    const wantsIntranet =
      !keyword && !url && Boolean(this.browser.platform.net.resolveHost) && isIntranetWord(query)
    const [remote, answer, entity, intranet] = await Promise.all([
      wantsRemote ? this.fetchRemote(engine, searchTerms, signal) : null,
      wantsAnswer ? this.answers.answer(query, searchUrl, signal) : null,
      wantsEntity ? this.answers.entity(query, signal) : null,
      wantsIntranet ? this.probeIntranet(query, signal) : false
    ])
    if (signal.aborted) return []

    if (answer) {
      rows.push({
        id: `answer:${answer.id}`,
        kind: 'answer',
        title: answer.title,
        subtitle: answer.subtitle,
        url: answer.url,
        favicon: answer.favicon,
        targetId: null,
        fill: query,
        relevance: RELEVANCE.answer
      })
    }
    if (entity) {
      rows.push({
        id: 'entity',
        kind: 'entity',
        title: entity.title,
        subtitle: entity.subtitle,
        url: entity.url,
        favicon: entity.favicon,
        targetId: null,
        fill: query,
        relevance: RELEVANCE.entity
      })
    }
    if (intranet) {
      const host = query.toLowerCase()
      rows.push({
        id: 'intranet',
        kind: 'url',
        title: `http://${host}/`,
        subtitle: 'Did you mean to go to this site?',
        url: `http://${host}/`,
        favicon: null,
        targetId: null,
        fill: query,
        relevance: RELEVANCE.intranet
      })
    }
    if (remote) {
      const terms = searchTerms.toLowerCase()
      let calculatorShown = Boolean(offline)
      for (const s of remote.suggestions) {
        if (s.type === 'calculator') {
          if (calculatorShown) continue
          calculatorShown = true
          rows.push({
            id: 'answer:engine',
            kind: 'answer',
            title: s.text.startsWith('=') ? s.text : `= ${s.text}`,
            subtitle: searchTerms,
            url: searchUrl,
            favicon: null,
            targetId: null,
            fill: query,
            relevance: Math.min(s.relevance, RELEVANCE.answer)
          })
          continue
        }
        // A suggestion the engine ranks above the verbatim query is its inline completion.
        const startsWithTyped =
          s.type === 'query'
            ? s.text.toLowerCase().startsWith(terms)
            : displayUrl(s.text).toLowerCase().startsWith(terms)
        const outranksVerbatim =
          remote.verbatimRelevance !== null && s.relevance > remote.verbatimRelevance
        const relevance =
          outranksVerbatim && startsWithTyped
            ? RELEVANCE.verbatim + 5
            : Math.min(s.relevance, RELEVANCE.verbatim - 1)
        if (s.type === 'navigation') {
          const navUrl = inputToUrl(s.text) ?? s.text
          const shown = displayUrl(navUrl) || navUrl
          rows.push({
            id: `nav:${navUrl}`,
            kind: 'url',
            title: s.description || shown,
            subtitle: s.description ? shown : '',
            url: navUrl,
            favicon: this.browser.history.faviconFor(navUrl),
            targetId: null,
            fill: startsWithTyped && !keyword ? shown : query,
            relevance
          })
          continue
        }
        if (s.text.toLowerCase() === terms) continue
        rows.push({
          id: `sugg:${s.text}`,
          kind: 'search',
          title: s.text,
          subtitle: `Search with ${engine.name}`,
          url: buildSearchUrl(engine, s.text),
          favicon: null,
          targetId: engine.id,
          fill: searchFill(s.text),
          relevance
        })
      }
    }

    return finish(rows, query)
  }

  // ---------------------------------------------------------------------------
  // Local sources
  // ---------------------------------------------------------------------------

  private keywordStarters(query: string, engines: SearchEngine[]): Ranked[] {
    const q = query.toLowerCase()
    const out: Ranked[] = []
    for (const s of SEARCH_SCOPES) {
      if (s.keyword.startsWith(q) && s.keyword !== q) {
        out.push({
          id: `kw:${s.scope}`,
          kind: 'engine',
          title: s.keyword,
          subtitle: s.label,
          url: null,
          favicon: null,
          targetId: s.scope,
          fill: `${s.keyword} `,
          relevance: RELEVANCE.keywordStarter - out.length
        })
      }
    }
    for (const engine of engines) {
      const hit = engineKeywords(engine).find((k) => k.startsWith(q))
      if (!hit) continue
      out.push({
        id: `kw:${engine.id}`,
        kind: 'engine',
        title: engine.keyword,
        subtitle: `Search ${engine.name}`,
        url: null,
        favicon: null,
        targetId: engine.id,
        fill: `${engine.keyword} `,
        relevance: RELEVANCE.keywordStarter - out.length
      })
    }
    return out
  }

  private commandRows(query: string, win: ZenWindow): Ranked[] {
    const state = this.browser.state
    return searchCommands(query, {
      capabilities: state.capabilities,
      formFactor: win.formFactor
    }).map((cmd, i) => ({
      id: `cmd:${cmd.id}`,
      kind: 'command' as const,
      title: cmd.label,
      subtitle: 'Command',
      url: null,
      favicon: null,
      targetId: cmd.action,
      fill: query,
      relevance: RELEVANCE.command - i
    }))
  }

  private spaceRows(query: string, win: ZenWindow): Ranked[] {
    const q = query.toLowerCase()
    const out: Ranked[] = []
    for (const space of this.browser.state.model.spaces) {
      if (space.id === win.activeSpaceId || !space.name.toLowerCase().includes(q)) continue
      out.push({
        id: `space:${space.id}`,
        kind: 'space',
        title: spaceLabel(space),
        subtitle: 'Switch to space',
        url: null,
        favicon: null,
        targetId: space.id,
        fill: query,
        relevance: RELEVANCE.space - out.length
      })
    }
    return out
  }

  /** Open tabs this window can show (private tabs stay private), as "Switch to tab" rows. */
  private tabRows(
    query: string,
    currentTabId: string | null,
    win: ZenWindow,
    limit: number
  ): Ranked[] {
    const q = query.toLowerCase()
    const state = this.browser.state
    const m = state.model
    const space = win.activeSpace()
    const local = Boolean(win.localSpace)
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
    const out: Ranked[] = []
    for (const tab of openTabs) {
      if (tab.id === currentTabId || out.length >= limit) continue
      // An empty tab (the blank page, the new tab page) is nothing to switch to.
      if (isEmptyTabUrl(tab.url)) continue
      const title = (tab.customTitle ?? tab.title).toLowerCase()
      const shown = displayUrl(tab.url).toLowerCase()
      const hay = `${title} ${tab.url.toLowerCase()}`
      if (!hay.includes(q)) continue
      const prefix = title.startsWith(q) || shown.startsWith(q)
      out.push({
        id: `tab:${tab.id}`,
        kind: 'tab',
        title: tab.customTitle ?? tab.title,
        subtitle: displayUrl(tab.url),
        url: tab.url,
        favicon: tab.favicon,
        targetId: tab.id,
        fill: query,
        relevance: (prefix ? RELEVANCE.tabPrefix : RELEVANCE.tab) - out.length
      })
    }
    return out
  }

  /** Bookmarks from every folder; the subtitle names the folder so "Work / Docs" is visible. */
  private bookmarkRows(query: string, limit: number): Ranked[] {
    const q = query.toLowerCase()
    const out: Ranked[] = []
    for (const bm of this.browser.bookmarks.searchUrls(query, limit)) {
      if (!bm.url) continue
      const path = this.browser.bookmarks.pathLabel(bm.id)
      const shown = displayUrl(bm.url)
      const prefix = bm.title.toLowerCase().startsWith(q) || shown.toLowerCase().startsWith(q)
      out.push({
        id: `bm:${bm.id}`,
        kind: 'bookmark',
        title: bm.title,
        subtitle: path ? `${path} · ${shown}` : shown,
        url: bm.url,
        favicon: bm.favicon ?? null,
        targetId: bm.id,
        fill: query,
        relevance: (prefix ? RELEVANCE.bookmarkPrefix : RELEVANCE.bookmark) - out.length
      })
    }
    return out
  }

  private historyRows(query: string, limit: number): Ranked[] {
    const q = query.toLowerCase()
    const out: Ranked[] = []
    for (const entry of this.browser.history.search(query, limit)) {
      const shown = displayUrl(entry.url)
      const base = shown.toLowerCase().startsWith(q)
        ? RELEVANCE.historyHostPrefix
        : entry.title.toLowerCase().startsWith(q)
          ? RELEVANCE.historyTitlePrefix
          : RELEVANCE.history
      out.push({
        id: `hist:${entry.url}`,
        kind: 'history',
        title: entry.title || shown,
        subtitle: shown,
        url: entry.url,
        favicon: entry.favicon,
        targetId: null,
        fill: query,
        relevance: base - out.length
      })
    }
    return out
  }

  /**
   * Keyword mode for Zenium's own data (`@bookmarks foo`, `@history foo`, `@tabs foo`): only
   * rows of that kind, plus a verbatim row that opens the matching manager for the search.
   */
  private scopeResults(
    scope: Extract<KeywordMatch, { kind: 'scope' }>,
    query: string,
    currentTabId: string | null,
    win: ZenWindow
  ): Suggestion[] {
    const terms = scope.query.trim()
    const rows: Ranked[] = []
    const label = SEARCH_SCOPES.find((s) => s.scope === scope.scope)?.label ?? 'Search'
    if (scope.scope === 'tabs') {
      rows.push(...this.tabRows(terms || '', currentTabId, win, MAX_ROWS))
      return finish(rows, query)
    }
    if (win.isPrivate) return []
    rows.push({
      id: 'scope',
      kind: 'search',
      title: terms || label,
      subtitle: terms ? label : '',
      url: scope.scope === 'bookmarks' ? BOOKMARKS_URL : HISTORY_URL,
      favicon: null,
      targetId: scope.scope,
      fill: query,
      relevance: RELEVANCE.verbatim
    })
    if (terms) {
      rows.push(
        ...(scope.scope === 'bookmarks'
          ? this.bookmarkRows(terms, MAX_ROWS - 1)
          : this.historyRows(terms, MAX_ROWS - 1))
      )
    }
    return finish(rows, query)
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

  // ---------------------------------------------------------------------------
  // Network sources
  // ---------------------------------------------------------------------------

  /** The engine's suggestions for `query`, typed and ranked; empty on any failure or timeout. */
  private async fetchRemote(
    engine: SearchEngine,
    query: string,
    signal: AbortSignal
  ): Promise<SuggestPayload | null> {
    const url = buildSuggestUrl(engine, query)
    if (!url) return null
    const cacheKey = `${engine.id}|${query.toLowerCase()}`
    const cached = this.remoteCache.get(cacheKey)
    if (cached) return cached
    try {
      const res = await this.browser.platform.net.fetchText(url, {
        signal,
        timeoutMs: REMOTE_TIMEOUT_MS,
        headers: { accept: 'application/json' }
      })
      if (!res.ok) return null
      const body: unknown = JSON.parse(res.text)
      const payload = parseSuggestPayload(body)
      this.remoteCache.set(cacheKey, payload)
      if (this.remoteCache.size > 200)
        this.remoteCache.delete(this.remoteCache.keys().next().value as string)
      return payload
    } catch {
      return null
    }
  }

  /** Does a single typed word resolve as a host on this network? Cached either way. */
  private async probeIntranet(word: string, signal: AbortSignal): Promise<boolean> {
    const host = word.toLowerCase()
    const known = this.intranetCache.get(host)
    if (known !== undefined) return known
    const resolve = this.browser.platform.net.resolveHost
    if (!resolve) return false
    const timeout = new Promise<boolean>((done) =>
      setTimeout(() => done(false), INTRANET_TIMEOUT_MS)
    )
    const result = await Promise.race([
      resolve.call(this.browser.platform.net, host, { signal }).catch(() => false),
      timeout
    ])
    if (!signal.aborted) this.intranetCache.set(host, result)
    return result
  }
}

/** A word Chrome would probe as an intranet host: letters, digits and hyphens, no dot. */
export function isIntranetWord(query: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(query) && query.length >= 3 && !/^\d+$/.test(query)
}

function dedupeKey(row: Suggestion): string {
  switch (row.kind) {
    case 'url':
    case 'history':
    case 'bookmark':
    case 'tab':
    case 'entity':
      return `url:${normalizeUrl(row.url ?? row.id)}`
    case 'search':
      return `search:${row.title.trim().toLowerCase()}`
    default:
      return `${row.kind}:${row.id}`
  }
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    const host = u.host.toLowerCase().replace(/^www\./, '')
    const path = u.pathname.replace(/\/$/, '')
    return `${host}${path}${u.search}${u.hash}`
  } catch {
    return url.toLowerCase()
  }
}

/**
 * Order by relevance (ties keep source order), drop rows that name the same page or search,
 * cap the list and mark the default match that is completed inline: the top row when it
 * outranks the verbatim query and extends what was typed.
 */
function finish(rows: Ranked[], query: string): Suggestion[] {
  const ordered = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.relevance - a.row.relevance || a.index - b.index)
    .map((r) => r.row)
  const seen = new Set<string>()
  const out: Suggestion[] = []
  for (const row of ordered) {
    const key = dedupeKey(row)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
    if (out.length >= MAX_ROWS) break
  }
  const top = out[0]
  const typed = query.toLowerCase()
  if (
    top &&
    (top.relevance ?? 0) > RELEVANCE.verbatim &&
    (top.kind === 'url' || top.kind === 'search') &&
    top.fill.length > query.length &&
    top.fill.toLowerCase().startsWith(typed)
  ) {
    top.inline = true
  }
  return out
}
