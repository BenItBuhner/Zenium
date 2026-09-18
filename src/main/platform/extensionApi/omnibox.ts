import type { Suggestion } from '../../../shared/types'
import type { ZenWindow } from '../../../core/window'
import {
  OmniboxError,
  defaultRow,
  dispositionFor,
  matchKeyword,
  normalizeDefaultSuggestion,
  normalizeSuggestResults,
  suggestionRows,
  type DefaultSuggestResult,
  type KeywordMatch,
  type OmniboxRowSource,
  type SuggestResult
} from '../../../core/extensions/api/omnibox'
import {
  ApiError,
  isRecord,
  type ApiContext,
  type ApiHost,
  type LoadedExtension,
  type NamespaceHandlers
} from './types'

/** How long the URL bar waits for `suggest` before showing what it has. */
export const SUGGEST_WAIT_MS = 350

interface Session {
  extensionId: string
}

interface PendingSuggest {
  extensionId: string
  text: string
  resolve: (results: SuggestResult[]) => void
}

/**
 * `chrome.omnibox`: the URL bar's input belongs to an extension while it starts with the
 * extension's manifest keyword and a space. Per window this module keeps the session
 * (`onInputStarted` when the keyword takes over, `onInputCancelled` when the input leaves it or
 * the bar closes), asks the extension for rows on every change (`onInputChanged(text, suggest)`,
 * the answer arriving through the shim's `omnibox-suggest` notify) and hands an entry over
 * (`onInputEntered(text, disposition)`). `setDefaultSuggestion` is the first row's text.
 */
export class OmniboxApi {
  private readonly keywords = new Map<string, string>()
  private readonly defaults = new Map<string, DefaultSuggestResult>()
  private readonly sessions = new Map<string, Session>()
  private readonly pending = new Map<number, PendingSuggest>()
  /** Answers that came after the URL bar stopped waiting, for the next query with that text. */
  private readonly late = new Map<string, SuggestResult[]>()
  private nextToken = 1

  constructor(
    private readonly host: ApiHost,
    private readonly waitMs: number = SUGGEST_WAIT_MS
  ) {}

  readonly handlers: NamespaceHandlers = {
    setDefaultSuggestion: (ctx, suggestion) => this.setDefaultSuggestion(ctx, suggestion)
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  load(ext: LoadedExtension): void {
    const keyword = ext.manifest.omnibox?.keyword
    if (typeof keyword === 'string' && keyword.trim()) this.keywords.set(ext.id, keyword.trim())
  }

  unload(extensionId: string): void {
    this.keywords.delete(extensionId)
    this.defaults.delete(extensionId)
    for (const [winId, session] of this.sessions) {
      if (session.extensionId === extensionId) this.sessions.delete(winId)
    }
    for (const [token, p] of this.pending) {
      if (p.extensionId === extensionId) {
        this.pending.delete(token)
        p.resolve([])
      }
    }
    for (const key of this.late.keys())
      if (key.startsWith(`${extensionId}\n`)) this.late.delete(key)
  }

  /** The keyword an extension registered, for the extensions page. */
  keywordOf(extensionId: string): string | null {
    return this.keywords.get(extensionId) ?? null
  }

  // ---------------------------------------------------------------------------
  // Methods
  // ---------------------------------------------------------------------------

  private setDefaultSuggestion(ctx: ApiContext, raw: unknown): void {
    let suggestion: DefaultSuggestResult
    try {
      suggestion = normalizeDefaultSuggestion(raw)
    } catch (error) {
      if (error instanceof OmniboxError) throw new ApiError(error.message)
      throw error
    }
    if (!this.keywords.has(ctx.extensionId)) {
      throw new ApiError('The extension has no omnibox keyword in its manifest.')
    }
    this.defaults.set(ctx.extensionId, suggestion)
  }

  /** The shim answered `onInputChanged`'s `suggest` for a token. */
  suggested(ctx: ApiContext, payload: unknown): void {
    if (!isRecord(payload) || typeof payload.token !== 'number') return
    const p = this.pending.get(payload.token)
    if (!p || p.extensionId !== ctx.extensionId) return
    let results: SuggestResult[]
    try {
      results = normalizeSuggestResults(payload.results)
    } catch {
      return
    }
    this.pending.delete(payload.token)
    p.resolve(results)
  }

  // ---------------------------------------------------------------------------
  // The URL bar
  // ---------------------------------------------------------------------------

  private match(input: string): KeywordMatch | null {
    const entries = [...this.keywords].map(([extensionId, keyword]) => ({ extensionId, keyword }))
    const match = matchKeyword(input, entries)
    return match && this.host.loaded(match.extensionId) ? match : null
  }

  private source(ext: LoadedExtension, keyword: string): OmniboxRowSource {
    const info = this.host.browser.extensions.list().find((record) => record.id === ext.id)
    return {
      extensionId: ext.id,
      extensionName: info?.name || ext.extension.name,
      keyword,
      icon: info?.icon ?? null
    }
  }

  /** Rows for input in keyword mode, or null when no extension's keyword starts it. */
  async suggest(input: string, win: ZenWindow): Promise<Suggestion[] | null> {
    const match = this.match(input)
    if (!match) {
      this.cancel(win)
      return null
    }
    const ext = this.host.loaded(match.extensionId)!
    this.begin(match.extensionId, win)
    const results = await this.ask(ext, match.text)
    const source = this.source(ext, match.keyword)
    return [
      defaultRow(source, this.defaults.get(ext.id) ?? null, match.text),
      ...suggestionRows(source, results)
    ]
  }

  private begin(extensionId: string, win: ZenWindow): void {
    const current = this.sessions.get(win.id)
    if (current?.extensionId === extensionId) return
    if (current) this.host.dispatch(current.extensionId, 'omnibox', 'onInputCancelled', [])
    this.sessions.set(win.id, { extensionId })
    this.host.dispatch(extensionId, 'omnibox', 'onInputStarted', [], { wake: true })
  }

  private ask(ext: LoadedExtension, text: string): Promise<SuggestResult[]> {
    const lateKey = `${ext.id}\n${text}`
    const late = this.late.get(lateKey)
    if (late) {
      this.late.delete(lateKey)
      return Promise.resolve(late)
    }
    const token = this.nextToken++
    return new Promise<SuggestResult[]>((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        // Keep waiting for the answer, for the next query with this text.
        const p = this.pending.get(token)
        if (p) {
          p.resolve = (results) => {
            this.late.set(lateKey, results)
          }
        }
        resolve([])
      }, this.waitMs)
      this.pending.set(token, {
        extensionId: ext.id,
        text,
        resolve: (results) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(results)
        }
      })
      this.host.dispatch(ext.id, 'omnibox', 'onInputChanged', [text, token], { wake: true })
    })
  }

  /** Enter on keyword-mode input: the extension gets it; true when one did. */
  submit(input: string, newTab: boolean, background: boolean, win: ZenWindow): boolean {
    const match = this.match(input)
    if (!match) {
      this.cancel(win)
      return false
    }
    this.sessions.delete(win.id)
    this.host.dispatch(
      match.extensionId,
      'omnibox',
      'onInputEntered',
      [match.text, dispositionFor(newTab, background)],
      { wake: true }
    )
    return true
  }

  /** The input left keyword mode or the bar closed without an entry. */
  cancel(win: ZenWindow): void {
    const session = this.sessions.get(win.id)
    if (!session) return
    this.sessions.delete(win.id)
    this.host.dispatch(session.extensionId, 'omnibox', 'onInputCancelled', [])
  }

  /** The user deleted one of the extension's rows (`fill` of a `deletable` row). */
  deleteSuggestion(input: string): void {
    const match = this.match(input)
    if (!match || !match.text) return
    this.host.dispatch(match.extensionId, 'omnibox', 'onDeleteSuggestion', [match.text])
  }

  /** The extension owning `win`'s current keyword session, if any. */
  sessionOf(win: ZenWindow): string | null {
    return this.sessions.get(win.id)?.extensionId ?? null
  }
}
