import {
  PRIVATE_CONTAINER_ID,
  type Folder,
  type FormFactor,
  type HistoryEntry,
  type SearchEngine,
  type Suggestion,
  type SuggestionKind
} from '../shared/types'
import {
  SEARCH_SCOPES,
  buildSearchUrl,
  buildSuggestUrl,
  engineKeywords,
  isActiveSearchEngine,
  matchKeyword,
  parseSuggestPayload,
  searchTermsFromUrl,
  type KeywordMatch,
  type SuggestPayload
} from '../shared/search'
import { localAnswer } from '../shared/answers'
import { searchCommands } from '../shared/commands'
import { spaceLabel } from '../shared/defaults'
import { EXTENSION_SETTING_KEYS, effectiveSwitch } from '../shared/extensionSettings'
import {
  BOOKMARKS_URL,
  HISTORY_URL,
  addressParts,
  displayUrl,
  inputToUrl,
  isEmptyTabUrl,
  isInternalUrl,
  isProbablyUrl
} from '../shared/url'
import { foldForMatch, matchableUrl, queryTerms } from '../shared/wordMatch'
import { touchLayout } from '../shared/formFactor'
import {
  MOST_VISITED_GROUP,
  RECENT_SEARCHES_GROUP,
  RECENT_SEARCH_SCAN,
  RECENTLY_VISITED_GROUP,
  searchEnginesInOrder,
  searchesInHistory
} from '../shared/zeroSuggest'
import type { Browser } from './browser'
import type { ZenWindow } from './window'
import { orderedTabsForSpace, regularFolderTabs, tabVisibleIn } from './model'
import { AnswerService } from './answers'
import { matchesAtWordStart } from './history'
import type { Shortcut } from './omniboxShortcuts'

/**
 * Chromium's relevance scale, so rows from every source sort against each other: the verbatim
 * query is 1300; a history completion that may be inlined outranks it; answers sit just under
 * it; engine suggestions come with their own score (Google sends 550–700 for plain queries and
 * above the verbatim when one should be inlined).
 */
export const RELEVANCE = {
  /** The best learned shortcut, over the history completion (Chromium's shortcut boost, 1414). */
  shortcut: 1414,
  autofill: 1400,
  verbatim: 1300,
  keywordStarter: 1290,
  answer: 1250,
  intranet: 1240,
  /** Further shortcuts for the typing: under the verbatim row, over every other local source. */
  shortcutOther: 1199,
  entity: 1150,
  tabPrefix: 1120,
  bookmarkPrefix: 1100,
  historyHostPrefix: 1050,
  command: 1010,
  tab: 1000,
  /**
   * A tab group the typing names (OMN-15): just under the open tabs, as Chrome's
   * `TabGroupProvider` caps its score at the tab matches' 1000 – "based on these suggestions
   * sharing a group with open tab matches" – so a group row never outranks a tab's.
   */
  folder: 990,
  historyTitlePrefix: 980,
  bookmark: 950,
  /** A term at the start of a word in the title or of a path segment (HistoryQuick's idea). */
  historyWordStart: 930,
  space: 900,
  history: 880
} as const

// Zero-suggest's section names live with the shared module the chrome reads them from too.
export { RECENT_SEARCHES_GROUP, RECENTLY_VISITED_GROUP }
/** Remembered searches shown on focus at most (Chrome shows up to eight zero-suggest rows). */
export const RECENT_SEARCHES_MAX = 8
/** Recent pages shown on focus at most, under the recent searches. */
const RECENT_PAGES_MAX = 8

/**
 * The phone card's sections for a typed query (OMN-18), in the order Chrome for Android lays
 * its suggestions out: the pages first – addresses, history, bookmarks, a Wikipedia entity:
 * Chrome's URL group – then the searches, then the open tabs where any match – the tab groups
 * with them, in Chrome's one section for both (OMN-15) – then Zenium's own kinds (commands,
 * spaces, the `@` engines). Rows of a kind not listed here – the answer, the clipboard row, an
 * extension's omnibox rows – belong to no section and stand with the default match at the
 * field's end.
 */
export const CARD_SECTIONS: ReadonlyArray<{ label: string; kinds: readonly SuggestionKind[] }> = [
  { label: 'Pages', kinds: ['url', 'history', 'bookmark', 'entity'] },
  { label: 'Searches', kinds: ['search'] },
  { label: 'Open tabs', kinds: ['tab', 'folder'] },
  { label: 'Commands', kinds: ['command'] },
  { label: 'Spaces', kinds: ['space'] },
  { label: 'Search engines', kinds: ['engine'] }
]

/**
 * The open tabs' heading while a tab group row stands in the section (OMN-15): Chrome for
 * Android's `IDS_OMNIBOX_HUB_TYPED_MATCH_HEADER` over its `GROUP_MOBILE_OPEN_TABS`, the one
 * section its open-tab and tab-group rows share. Without a group row the heading stays "Open
 * tabs", as it names what is there.
 */
export const TABS_AND_GROUPS_GROUP = 'Tabs and tab groups'

export interface SuggestOptions {
  /**
   * The bar is in keyword or search mode for this engine (tab-to-search, Ctrl+K, `?`): the
   * query is search terms for it – no address, history, bookmark, tab or command rows.
   */
  engineId?: string
  /**
   * The rows are for the phone's card (OMN-18): sectioned under headings in Chrome for
   * Android's order ({@link groupForCard}), the default match alone at the field's end. The
   * desktop popup keeps the flat relevance order with zero-suggest's one heading.
   */
  grouped?: boolean
}

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

  /**
   * "Show search suggestions" as it acts: an extension's
   * `chrome.privacy.services.searchSuggestEnabled` over the user's `Settings.searchSuggestions`
   * while one holds it (`State.extensionLayer`, Chrome's extension pref layer above the
   * user's), the user's own value otherwise – so a hold or its release acts on the next query;
   * off while the layer's first publish is pending at a cold start (no query leaves the device).
   */
  suggestionsEnabled(): boolean {
    const state = this.browser.state
    return effectiveSwitch(
      state.extensionLayer,
      EXTENSION_SETTING_KEYS.searchSuggestions,
      state.settings.searchSuggestions
    )
  }

  async suggest(
    rawQuery: string,
    currentTabId: string | null,
    win: ZenWindow = this.browser.focusedWindow(),
    opts: SuggestOptions = {}
  ): Promise<Suggestion[]> {
    const rows = await this.rows(rawQuery, currentTabId, win, opts)
    return opts.grouped ? groupForCard(rows, rawQuery) : rows
  }

  private async rows(
    rawQuery: string,
    currentTabId: string | null,
    win: ZenWindow,
    opts: SuggestOptions
  ): Promise<Suggestion[]> {
    let query = rawQuery.trim()
    const state = this.browser.state
    const engines = state.searchEngines
    const defaultEngine = state.defaultSearchEngine()
    const isPrivate = this.privateContext(currentTabId, win)
    const local = Boolean(win.localSpace)
    // Suggestion privacy (omnibox-45): the history and bookmark sources can be switched off.
    const wantsHistory = !isPrivate && state.settings.historySuggestions !== false
    const wantsBookmarks = !isPrivate && state.settings.bookmarkSuggestions !== false

    // Search mode (omnibox-26): the bar's engine, or Chrome's legacy `?` prefix in the text.
    let modeEngine = opts.engineId ? engines.find((e) => e.id === opts.engineId) : undefined
    if (!modeEngine && query.startsWith('?') && !matchKeyword(rawQuery.trimStart(), engines)) {
      modeEngine = defaultEngine
      query = query.slice(1).trim()
    }

    if (!query) {
      if (isPrivate || modeEngine) return []
      const currentTab = currentTabId ? state.model.tabs[currentTabId] : undefined
      return await this.emptyState(wantsHistory, {
        formFactor: win.formFactor,
        touch: touchLayout(win.formFactor),
        onNewTab: currentTab !== undefined && isEmptyTabUrl(currentTab.url),
        onResultsPage:
          currentTab !== undefined && searchTermsFromUrl(defaultEngine, currentTab.url) !== null
      })
    }

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
          subtitle: s.id === win.activeSpaceId ? 'Current Space' : 'Switch to Space',
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
    const textKeyword = modeEngine ? null : matchKeyword(rawQuery.trimStart(), engines)
    if (textKeyword?.kind === 'scope')
      return this.scopeResults(textKeyword, query, currentTabId, win)
    // Search mode is keyword mode for the bar's engine, the field holding the terms alone.
    const keyword: KeywordMatch | null =
      textKeyword ??
      (modeEngine
        ? { kind: 'engine', engine: modeEngine, keyword: modeEngine.keyword, query }
        : null)
    const engine = keyword?.engine ?? defaultEngine
    const searchTerms = keyword ? keyword.query : query
    const searchFill = (term: string): string =>
      textKeyword ? `${textKeyword.keyword} ${term}` : term

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

    // What was typed before led somewhere (the shortcuts provider, omnibox-03): that
    // destination first, completed inline when its text extends the typing.
    if (!keyword && wantsHistory) rows.push(...this.shortcutRows(query, engines))

    // The default match to complete inline: the most frecent visited host or URL with this prefix.
    if (!keyword && wantsHistory) {
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
      if (!isPrivate) rows.push(...this.folderRows(query, win, 3))
      if (wantsBookmarks) rows.push(...this.bookmarkRows(query, 3))
      if (wantsHistory) rows.push(...this.historyRows(query, 6))
    }

    // Network sources run together; the popup waits for the slowest but never past its timeout.
    // The switch as it acts: an extension's `chrome.privacy.services.searchSuggestEnabled` over
    // the user's while one holds it, read per query (`State.extensionLayer`), the user's
    // setting never written by it.
    const online = this.suggestionsEnabled() && !isPrivate
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
      // A deactivated engine (settings-43) is offered nowhere until activated.
      if (!isActiveSearchEngine(engine)) continue
      const hit = engineKeywords(engine).find((k) => k.startsWith(q))
      if (!hit) continue
      out.push({
        id: `kw:${engine.id}`,
        kind: 'engine',
        title: engine.keyword,
        subtitle: `Search ${engine.name}`,
        url: null,
        // The engine's site icon in the row's glyph slot (v2 shell pass 7(b)), the magnifier
        // where the site offered none.
        favicon: engine.favicon ?? null,
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
        subtitle: 'Switch to Space',
        url: null,
        favicon: null,
        targetId: space.id,
        fill: query,
        relevance: RELEVANCE.space - out.length
      })
    }
    return out
  }

  /**
   * Whether the omnibox is a private one: its window is private (a desktop private window), or
   * the tab it serves is in the private container – a phone private tab, whose window is never
   * private. Either way nothing typed leaves the device and nothing of the profile is shown:
   * no engine suggest requests, no answers, no history or bookmark rows, no zero-suggest
   * (Chrome's incognito omnibox sends no suggest requests). Tab rows stay, as in a private
   * window.
   */
  private privateContext(currentTabId: string | null, win: ZenWindow): boolean {
    if (win.isPrivate) return true
    const tab = currentTabId ? this.browser.state.model.tabs[currentTabId] : undefined
    return tab?.containerId === PRIVATE_CONTAINER_ID
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

  /**
   * Tab groups the typing names (OMN-15; Chrome for Android's `TabGroupProvider`, the "Open
   * tab group" row of its tab switcher's search): every term of the query starts a word of the
   * group's name or of a member page's address – Chrome's `ALWAYS_PREFIX_SEARCH`, the rule of
   * `wordMatch.ts` – and the group has pages to open: its live regular tabs, else the pages a
   * saved group keeps. Chrome's `Score` ({@link groupMatch}) ranks the groups against each
   * other and the best `limit` are rows, in the tabs' band just under them ({@link RELEVANCE}
   * `folder`). The row is the group's name over its pages' sites, the matching site first, as
   * Chrome lists a group's addresses with the matching one in front. An unnamed group is no row
   * (Chrome surfaces none), nor one with nothing to open – a private group among them, whose
   * private tabs no regular surface opens (`regularFolderTabs`); a window of a local space sees
   * that space's groups alone, as its tab rows are that space's.
   */
  private folderRows(query: string, win: ZenWindow, limit: number): Ranked[] {
    const terms = queryTerms(query)
    if (terms.length === 0) return []
    const m = this.browser.state.model
    const local = win.localSpace
    const hits: { folder: Folder; score: number; sites: string[] }[] = []
    for (const folder of Object.values(m.folders)) {
      if (local ? folder.spaceId !== local.id : m.localSpaces[folder.spaceId]) continue
      if (!folder.name.trim()) continue
      const live = regularFolderTabs(m, folder.id)
      const pages = (live.length > 0 ? live : (folder.savedTabs ?? []))
        .map((t) => t.url)
        .filter((url) => !isEmptyTabUrl(url) && !isInternalUrl(url))
      if (pages.length === 0) continue
      const match = groupMatch(terms, folder.name, pages)
      if (!match) continue
      const sites: string[] = []
      for (const url of match.matchingUrl ? [match.matchingUrl, ...pages] : pages) {
        const site = addressParts(displayUrl(url)).site
        if (site && !sites.includes(site)) sites.push(site)
      }
      hits.push({ folder, score: match.score, sites })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, limit).map(({ folder, sites }, i) => ({
      id: `folder:${folder.id}`,
      kind: 'folder' as const,
      title: folder.name,
      subtitle: sites.join(', '),
      url: null,
      favicon: null,
      targetId: folder.id,
      fill: query,
      relevance: RELEVANCE.folder - i
    }))
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

  /**
   * History rows (omnibox-02, Chrome's HistoryURL and HistoryQuick providers): the service ranks
   * the candidates by typed count, visit count and recency; here the band says how the typing
   * matched – the address's start, the title's start, the start of a word in the title or of a
   * path segment, or somewhere inside a word – so a word-start match outranks a mid-word one.
   */
  private historyRows(query: string, limit: number): Ranked[] {
    const q = query.toLowerCase()
    const out: Ranked[] = []
    for (const entry of this.browser.history.search(query, limit)) {
      const shown = displayUrl(entry.url)
      const base = shown.toLowerCase().startsWith(q)
        ? RELEVANCE.historyHostPrefix
        : entry.title.toLowerCase().startsWith(q)
          ? RELEVANCE.historyTitlePrefix
          : matchesAtWordStart(`${entry.title} ${shown}`, q)
            ? RELEVANCE.historyWordStart
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
        deletable: true,
        relevance: base - out.length
      })
    }
    return out
  }

  /**
   * The shortcuts provider's rows: destinations the typing led to before, the best of them
   * boosted over the history completion (Chromium's shortcut boost) and completed inline when
   * its text extends what was typed, the others under the verbatim row. Every one is removable.
   */
  private shortcutRows(query: string, engines: SearchEngine[]): Ranked[] {
    const q = query.toLowerCase()
    const out: Ranked[] = []
    for (const s of this.browser.omniboxShortcuts.match(query, 3)) {
      const shown = displayUrl(s.url) || s.url
      const engine = s.engineId ? engines.find((e) => e.id === s.engineId) : undefined
      const extendsTyped = s.fill.toLowerCase().startsWith(q) && s.fill.length > query.length
      out.push({
        id: `shortcut:${s.url}`,
        kind: s.kind === 'search' ? 'search' : 'url',
        title: s.kind === 'search' ? s.fill : s.title || shown,
        subtitle: s.kind === 'search' ? `Search with ${engine?.name ?? 'the web'}` : shown,
        url: s.url,
        favicon: s.kind === 'search' ? null : this.browser.history.faviconFor(s.url),
        targetId: engine?.id ?? null,
        // The destination's text (Chromium's fill_into_edit: what arrowing onto the row puts in
        // the field), keeping the user's casing for the part they typed when it extends it, so
        // the inline completion's selection does not flicker.
        fill: extendsTyped ? query + s.fill.slice(query.length) : s.fill,
        deletable: true,
        relevance: out.length === 0 ? RELEVANCE.shortcut : RELEVANCE.shortcutOther - out.length
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
    if (this.privateContext(currentTabId, win)) return []
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
    // An explicit `@history foo` is the user asking for these rows: the toggles do not apply.
    if (terms) {
      rows.push(
        ...(scope.scope === 'bookmarks'
          ? this.bookmarkRows(terms, MAX_ROWS - 1)
          : this.historyRows(terms, MAX_ROWS - 1))
      )
    }
    return finish(rows, query)
  }

  /**
   * Nothing typed yet: what the clipboard holds first (Chrome's "Link you copied" / "Text you
   * copied"; the kind alone, from the clip's description – the content is read only when the
   * user reveals or picks the row), then the recent history.
   *
   * On a touch layout (OMN-04; Chrome for Android's zero-suggest on a web page) the list also
   * has the new tab page's tiles as a row ({@link MOST_VISITED_GROUP}) and remembers the
   * searches the history holds – the results pages of the user's engines, whoever's field the
   * terms went into – among the recent searches; the desktop's list is as it was.
   */
  private async emptyState(
    wantsHistory: boolean,
    layout: {
      /** The window's layout class: whose new tab page the tiles are (the phone's is the chrome's own). */
      formFactor: FormFactor
      touch: boolean
      /** The focused tab is a new tab page: it shows the tiles itself. */
      onNewTab: boolean
      /** The focused tab is the default engine's results page (Chrome's SRP classification). */
      onResultsPage: boolean
    }
  ): Promise<Suggestion[]> {
    const rows: Suggestion[] = []
    const clip = await this.browser.searchEngines.peekClipboard()
    // An image on the clipboard has nowhere to go: Zenium has no visual search, so no row.
    if (clip === 'url' || clip === 'text') {
      rows.push({
        id: 'clipboard',
        kind: 'clipboard',
        title: clip === 'url' ? 'Link you copied' : 'Text you copied',
        subtitle: '',
        url: null,
        favicon: null,
        targetId: clip,
        fill: ''
      })
    }
    if (!wantsHistory) return rows
    // The new tab page's tiles (Chrome's `MostVisitedSitesProvider`, local): the very list the
    // layout's page shows – its most visited sites or the user's shortcuts, as the page's mode
    // has it, and none while the page's shortcuts section is off – so not over the page itself,
    // nor over the default engine's results page (Chrome's `SupportsMostVisitedSites` leaves the
    // NTP and the SRP out), and on the touch layouts alone.
    const tiles =
      layout.touch && !layout.onNewTab && !layout.onResultsPage
        ? this.browser.newTab.pageTiles(layout.formFactor)
        : []
    const tileUrls = new Set<string>()
    for (const site of tiles) {
      tileUrls.add(site.url)
      rows.push({
        id: `tile:${site.url}`,
        kind: 'url',
        title: site.title || displayUrl(site.url),
        subtitle: displayUrl(site.url),
        url: site.url,
        favicon: site.favicon,
        targetId: null,
        fill: displayUrl(site.url),
        group: MOST_VISITED_GROUP
      })
    }
    // Zero-suggest (omnibox-20): the searches the user made, most recent first, as a section of
    // their own over the recent pages – every row removable. The shortcuts provider remembers
    // the searches submitted through this field; on a touch layout the history's results pages
    // are read back through the engines' templates too (Chrome's `LocalHistoryZeroSuggestProvider`
    // reads the history's search terms), so a search typed into the engine's own page counts.
    // The same terms from both sources, or on two engines, are one row, the most recent.
    const engines = this.browser.state.searchEngines
    const defaultEngine = this.browser.state.defaultSearchEngine()
    const remembered = this.browser.omniboxShortcuts.recentSearches(RECENT_SEARCHES_MAX)
    const pool = RECENT_PAGES_MAX + remembered.length
    const recentEntries = this.browser.history.recent(
      layout.touch ? Math.max(RECENT_SEARCH_SCAN, pool) : pool
    )
    const recent = recentSearches(
      remembered,
      layout.touch ? recentEntries : [],
      engines,
      defaultEngine
    )
    // What the searches were, by engine, so the engine's results page for the same terms – the
    // history entry the search left – is not listed again under them as a recent page (the
    // lead's #289 ruling: zero-suggest dedupes the default engine's results pages against
    // "Recent searches"). A search remembered without its engine went to the default one.
    const searched: { engine: SearchEngine; terms: Set<string>; urls: Set<string> }[] = []
    for (const s of recent) {
      rows.push({
        id: `recent:${s.url}`,
        kind: 'search',
        title: s.fill,
        subtitle: `Search with ${s.engine?.name ?? 'the web'}`,
        url: s.url,
        favicon: null,
        targetId: s.engine?.id ?? null,
        fill: s.fill,
        deletable: true,
        group: RECENT_SEARCHES_GROUP
      })
      const searchedWith = s.engine ?? defaultEngine
      let hit = searched.find((e) => e.engine.id === searchedWith.id)
      if (!hit) searched.push((hit = { engine: searchedWith, terms: new Set(), urls: new Set() }))
      hit.terms.add(s.fill.trim().toLowerCase())
      hit.urls.add(s.url)
    }
    const duplicatesRecentSearch = (url: string): boolean =>
      searched.some(({ engine, terms, urls }) => {
        if (urls.has(url)) return true
        const found = searchTermsFromUrl(engine, url)
        return found !== null && terms.has(found.toLowerCase())
      })
    // The pages a dropped results page would have stood among come up in its place, so the
    // section keeps its size. A page standing as a tile is not listed again under the tiles.
    let pages = 0
    for (const entry of recentEntries) {
      if (pages >= RECENT_PAGES_MAX) break
      if (duplicatesRecentSearch(entry.url) || tileUrls.has(entry.url)) continue
      pages += 1
      rows.push({
        id: `hist:${entry.url}`,
        kind: 'history' as const,
        title: entry.title,
        subtitle: displayUrl(entry.url),
        url: entry.url,
        favicon: entry.favicon,
        targetId: null,
        fill: displayUrl(entry.url),
        deletable: true
      })
    }
    return rows
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

/** Chrome's `TabGroupProvider` ceiling: the score of a group that matches whole (`kMaxScore`). */
export const GROUP_MAX_SCORE = 1000

/**
 * Chrome's `TabGroupProvider::Score` for one group (OMN-15): null unless every term of the
 * query (`queryTerms`) starts a word of the group's title or of one of its pages' addresses –
 * the address as Chrome formats it for matching, scheme and `www.` off, escapes decoded
 * (`matchableUrl`) – else the score: Chrome's `ScoringFunctor` summed over the title's hits and
 * the matching address's, each hit worth the term's length weighted towards the text's start,
 * normalised over the title's length + 10, capped at 1, times {@link GROUP_MAX_SCORE}; with the
 * address a term matched, which the row lists first. A term hits every word it starts, as
 * Chrome's `QueryNodeWord::HasMatchIn` positions every prefixed word. Where two terms match two
 * addresses, each address's hits weigh against its own length (Chrome weighs both against the
 * last one's); with one matching address, the usual case, the two agree.
 */
export function groupMatch(
  terms: readonly string[],
  title: string,
  pages: readonly string[]
): { score: number; matchingUrl: string | null } | null {
  const lowerTitle = foldForMatch(title)
  let titleFactor = 0
  let urlFactor = 0
  let matchingUrl: string | null = null
  for (const term of terms) {
    const titleHits = wordStarts(lowerTitle, term)
    let urlHit = false
    for (const url of pages) {
      const lowerUrl = foldForMatch(matchableUrl(url))
      const hits = wordStarts(lowerUrl, term)
      if (hits.length === 0) continue
      urlHit = true
      matchingUrl = url
      urlFactor += scoringFactor(hits, term.length, lowerUrl.length)
      break
    }
    if (titleHits.length === 0 && !urlHit) return null
    titleFactor += scoringFactor(titleHits, term.length, lowerTitle.length)
  }
  const normalized = Math.min((titleFactor + urlFactor) / (lowerTitle.length + 10), 1)
  return { score: normalized * GROUP_MAX_SCORE, matchingUrl }
}

/** Chrome's `ScoringFunctor`: each hit's length, weighted by how near the text's start it is. */
function scoringFactor(starts: readonly number[], length: number, textLength: number): number {
  let factor = 0
  for (const start of starts) factor += (length * (textLength - start)) / textLength
  return factor
}

const WORD_CHAR = /[\p{L}\p{N}]/u

/**
 * The offsets at which `term` starts a word of `hay` (both folded) – the text's start, or after
 * a character that is no letter or digit, `wordMatch.ts`'s rule: Chrome's match positions.
 */
function wordStarts(hay: string, term: string): number[] {
  const out: number[] = []
  if (!term) return out
  let from = 0
  for (;;) {
    const at = hay.indexOf(term, from)
    if (at === -1) return out
    if (at === 0 || !WORD_CHAR.test(hay[at - 1] ?? '')) out.push(at)
    from = at + 1
  }
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
 * Whether Enter with nothing highlighted may open `row` (Chromium's `allowed_to_be_default_match`):
 * a page or a search whose text starts with what was typed – the verbatim rows by construction,
 * a completion that extends the typing. A row whose text is something else (a shortcut or a
 * history page found by its title) is never the default, however high it ranks.
 */
function canBeDefault(row: Suggestion, typed: string): boolean {
  return (row.kind === 'url' || row.kind === 'search') && row.fill.toLowerCase().startsWith(typed)
}

/**
 * Order by relevance (ties keep source order), drop rows that name the same page or search,
 * cap the list, put the default match first – the best row that may be one, as Chromium's
 * `SortAndCull` rotates it to the front, so the first row is always what Enter opens – and mark
 * it for inline completion when it outranks the verbatim query and extends what was typed.
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
  const typed = query.toLowerCase()
  const defaultIndex = out.findIndex((row) => canBeDefault(row, typed))
  if (defaultIndex > 0) out.unshift(...out.splice(defaultIndex, 1))
  const top = out[0]
  if (
    top &&
    defaultIndex >= 0 &&
    (top.relevance ?? 0) > RELEVANCE.verbatim &&
    top.fill.length > query.length
  ) {
    top.inline = true
  }
  return out
}

/** The card section a row's kind is listed under, or -1 for a row of no section. */
function cardSection(row: Suggestion): number {
  return CARD_SECTIONS.findIndex((s) => s.kinds.includes(row.kind))
}

/**
 * The phone card's order (OMN-18; Chrome for Android's `AndroidNonZPSSection`): the first row
 * – the default match `finish` put there, what Enter opens – keeps the field's end with no
 * heading, and the rows of no section (an answer, the clipboard row) stand with it; the rest
 * are sectioned in {@link CARD_SECTIONS}' order, each section in the relevance order it had,
 * under its heading. A card of one kind – the search suggestions alone, `@tabs`, the space
 * mode – is one section and takes no heading: the heading names a section among others, and
 * a lone one is the card. Zero-suggest keeps its recent searches' heading and gives the recent
 * pages theirs (Chrome's "Recently visited"), the clipboard row alone above both.
 */
export function groupForCard(rows: Suggestion[], query: string): Suggestion[] {
  if (rows.length === 0) return rows
  if (!query.trim()) {
    const named = rows.map((row) =>
      row.kind === 'history' && !row.group ? { ...row, group: RECENTLY_VISITED_GROUP } : row
    )
    return oneSection(named) ? named.map(ungroup) : named
  }
  const [top, ...rest] = rows
  const loose: Suggestion[] = [top]
  const sections: Suggestion[][] = CARD_SECTIONS.map(() => [])
  for (const row of rest) {
    const i = cardSection(row)
    if (i < 0) loose.push(row)
    else sections[i].push({ ...row, group: CARD_SECTIONS[i].label })
  }
  // The open tabs' section holds a tab group (OMN-15): Chrome's heading for the two together.
  for (const section of sections) {
    if (section.some((row) => row.kind === 'folder'))
      for (const row of section) row.group = TABS_AND_GROUPS_GROUP
  }
  const filled = sections.filter((s) => s.length > 0)
  // One kind throughout, the default match included: Chrome's flat list, no heading.
  const lone =
    filled.length === 1 && loose.length === 1 && cardSection(top) === sections.indexOf(filled[0])
  const out = [...loose, ...filled.flat()]
  return lone ? out.map(ungroup) : out
}

/** Whether every row of `rows` is in one and the same section, nothing ungrouped among them. */
function oneSection(rows: Suggestion[]): boolean {
  const groups = new Set(rows.map((row) => row.group))
  return groups.size === 1 && rows.every((row) => row.group)
}

function ungroup(row: Suggestion): Suggestion {
  if (!row.group) return row
  const copy = { ...row }
  delete copy.group
  return copy
}

/** A recent search on its way to a row: the remembered pick's, or the history's results page's. */
interface RecentSearch {
  /** The terms, as the row shows and refines them. */
  fill: string
  /** Where the row goes: the remembered search's address, or the engine's template filled. */
  url: string
  /** The engine searched with; undefined for a pick remembered without one (the default's). */
  engine: SearchEngine | undefined
  /** When the search was last made, for the order. */
  at: number
}

/**
 * The "Recent searches" (OMN-04), most recent first, {@link RECENT_SEARCHES_MAX} at most: the
 * searches the shortcuts provider remembers (the picks made in this field) and the searches
 * the history holds among `entries` (`searchesInHistory`: the results pages of the user's
 * engines, the default engine's template read first, an inactive engine's not at all) – the
 * same terms from both, case aside, are one row: the remembered pick's, dated by whichever was
 * later. With no history entries to read the list is the remembered searches as they were.
 */
export function recentSearches(
  remembered: readonly Shortcut[],
  entries: readonly Pick<HistoryEntry, 'url' | 'lastVisit'>[],
  engines: readonly SearchEngine[],
  defaultEngine: SearchEngine
): RecentSearch[] {
  const byTerms = new Map<string, RecentSearch>()
  for (const s of remembered) {
    const key = s.fill.trim().toLowerCase()
    if (!key || byTerms.has(key)) continue
    byTerms.set(key, {
      fill: s.fill,
      url: s.url,
      engine: s.engineId ? engines.find((e) => e.id === s.engineId) : undefined,
      at: s.lastUsed
    })
  }
  if (entries.length > 0) {
    for (const found of searchesInHistory(entries, searchEnginesInOrder(engines, defaultEngine))) {
      const key = found.terms.toLowerCase()
      const seen = byTerms.get(key)
      if (seen) {
        if (found.lastVisit > seen.at) seen.at = found.lastVisit
        continue
      }
      byTerms.set(key, {
        fill: found.terms,
        url: buildSearchUrl(found.engine, found.terms),
        engine: found.engine,
        at: found.lastVisit
      })
    }
  }
  return [...byTerms.values()].sort((a, b) => b.at - a.at).slice(0, RECENT_SEARCHES_MAX)
}
