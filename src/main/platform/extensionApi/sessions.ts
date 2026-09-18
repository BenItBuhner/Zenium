import type { ClosedEntry, Tab } from '../../../shared/types'
import type { SessionService } from '../../../core/session'
import {
  ERROR_NO_PERMISSION,
  ERROR_NO_RECENTLY_CLOSED,
  ERROR_NO_WINDOW,
  SessionsError,
  invalidSessionId,
  normalizeSessionFilter,
  normalizeSessionId,
  restoredSession,
  toChromeSession,
  type ChromeSession
} from '../../../core/extensions/api/sessions'
import {
  ApiError,
  type ApiContext,
  type ApiHost,
  type LoadedExtension,
  type NamespaceHandlers
} from './types'

/**
 * `chrome.sessions` over Zenium's recently-closed list (`core/session`, owned by the tabs
 * program): `getRecentlyClosed` lists the entries newest first as Chrome's `Session`s, `restore`
 * brings one back through the service and answers with the live tab or window, `getDevices` is
 * empty (no synced sessions). `onChanged` comes from the tick: the list is replaced on every
 * change, so a new list is a change.
 */
export class SessionsApi {
  private seen: ClosedEntry[] | null = null

  constructor(
    private readonly host: ApiHost,
    private readonly now: () => number = Date.now
  ) {}

  readonly handlers: NamespaceHandlers = {
    getRecentlyClosed: (ctx, filter) => this.getRecentlyClosed(ctx, filter),
    getDevices: (ctx) => this.getDevices(ctx),
    restore: (ctx, sessionId) => this.restore(ctx, sessionId)
  }

  private get service(): SessionService {
    return this.host.browser.session
  }

  private requirePermission(ext: LoadedExtension): void {
    if (!hasSessions(this.host, ext)) throw new ApiError(ERROR_NO_PERMISSION)
  }

  private visibility(ext: LoadedExtension): (url: string) => boolean {
    return (url) => this.host.canSeeTab(ext, url)
  }

  // ---------------------------------------------------------------------------
  // Methods
  // ---------------------------------------------------------------------------

  private getRecentlyClosed(ctx: ApiContext, raw: unknown): ChromeSession[] {
    this.requirePermission(ctx.extension)
    const { maxResults } = checked(() => normalizeSessionFilter(raw))
    const visible = this.visibility(ctx.extension)
    return this.service
      .recentlyClosed()
      .slice(0, maxResults)
      .map((entry) => toChromeSession(entry, visible))
  }

  private getDevices(ctx: ApiContext): [] {
    this.requirePermission(ctx.extension)
    return []
  }

  private restore(ctx: ApiContext, raw: unknown): ChromeSession {
    this.requirePermission(ctx.extension)
    const wanted = checked(() => normalizeSessionId(raw))
    const entries = this.service.recentlyClosed()
    const entry = wanted === null ? entries[0] : entries.find((e) => e.id === wanted)
    if (!entry) {
      throw new ApiError(wanted === null ? ERROR_NO_RECENTLY_CLOSED : invalidSessionId(wanted))
    }
    const win = ctx.window ?? this.host.model.lastFocusedWindow()
    if (!win) throw new ApiError(ERROR_NO_WINDOW)
    // The service restores in place and tells nothing back: the tabs that appear are the answer.
    const before = new Set(this.host.model.allTabs().map((tab) => tab.id))
    this.service.restoreClosed(entry.id, win)
    const fresh = this.host.model.allTabs().filter((tab) => !before.has(tab.id))
    const urls = (tab: Tab): boolean => this.host.canSeeTab(ctx.extension, tab.url)
    const first = fresh[0]
    if (!first) throw new ApiError(invalidSessionId(entry.id))
    if (entry.kind === 'tab') {
      return restoredSession({ tab: this.host.model.chromeTab(first, urls(first)) }, this.now())
    }
    const owner = this.host.model.windowOfTab(first)
    if (!owner) throw new ApiError(ERROR_NO_WINDOW)
    return restoredSession({ window: this.host.model.chromeWindow(owner, true, urls) }, this.now())
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  /** Called from the router's tick: a replaced list means the recently-closed entries changed. */
  tick(): void {
    const list = this.host.browser.state.recentlyClosed
    const prev = this.seen
    this.seen = list
    if (prev === null || prev === list) return
    this.host.broadcast('sessions', 'onChanged', (ext) => (hasSessions(this.host, ext) ? [] : null))
  }

  /** No extension is loaded: the next load starts from a fresh baseline. */
  reset(): void {
    this.seen = null
  }
}

function hasSessions(host: ApiHost, ext: LoadedExtension): boolean {
  return host.grants(ext.id).permissions.includes('sessions')
}

function checked<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof SessionsError) throw new ApiError(error.message)
    throw error
  }
}
