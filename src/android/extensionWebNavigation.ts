import {
  isFragmentNavigation,
  transitionFor,
  type CommittedDetails,
  type ErrorDetails,
  type NavigationEventDetails,
  type TransitionQualifier,
  type WebNavigationEvent
} from '@core/extensions/api/webNavigation'

/**
 * One report of the WebView's `NavigationListener` (androidx.webkit `NAVIGATION_LISTENER`,
 * Chromium 137+), as Kotlin posts it in the `navigation` view event. `started` and `redirected`
 * carry the URL the navigation is at; `completed` says whether it committed (`committed`), or
 * failed with `error` (an `ERR_…` name); `dom` and `load` are the page's `DOMContentLoaded` and
 * `load` events, for the document the last `completed` committed.
 */
export interface NavigationReport {
  phase: 'started' | 'redirected' | 'completed' | 'dom' | 'load'
  url: string
  sameDocument?: boolean
  reload?: boolean
  history?: boolean
  /** The page's own script or link started it (as opposed to the chrome). */
  byPage?: boolean
  committed?: boolean
  /** The load failed and WebView committed its own error page under the URL. */
  errorPage?: boolean
  /** Set when a failed `completed` knows the failure's `net::` name. */
  error?: string
  statusCode?: number
}

export interface DerivedEvent {
  event: WebNavigationEvent
  details: NavigationEventDetails | CommittedDetails | ErrorDetails
}

/** What the derivation needs from its tab: the Chrome id and the main frame's committed URL. */
export interface TabFacts {
  chromeTabId: number
  /** The main frame's URL as the core has it: the fallback for fragment-vs-history decisions before a commit was seen. */
  committedUrl: string
}

/** The core's error page: a navigation of the chrome's, hidden from extensions like Chrome hides `chrome-error://`. */
const ERROR_PAGE_PREFIX = 'zen://error'

/** A navigation in flight in one tab's main frame (only the main frame is observable). */
interface InFlight {
  url: string
  serverRedirect: boolean
  reload: boolean
  history: boolean
  byPage: boolean
}

/** Chrome's `documentId`s: minted per committed document since the WebView exposes none. */
let documentSeq = 0

function documentId(): string {
  documentSeq += 1
  return `android-doc-${documentSeq.toString(36)}`
}

/**
 * `chrome.webNavigation`'s event family for Android's main frames, from either the WebView's
 * navigation listener (`report`, the derivation Chrome's own events go through: one
 * `onBeforeNavigate` per navigation, `server_redirect` and `forward_back` qualifiers, `reload`
 * transitions, a non-committing navigation's `onErrorOccurred`) or, on a WebView without it,
 * inferred from the client callbacks the tab always has (`inferred*`: commit, finish, failure).
 *
 * Only the main frame is observable either way (frame id 0); the details carry Chrome's shape
 * so `getFrame` and the desktop's payloads read alike.
 */
export class AndroidWebNavigation {
  private readonly inFlight = new Map<string, InFlight>()
  private readonly documents = new Map<string, string>()
  /** The main frame's URL after its last commit or same-document navigation, per tab. */
  private readonly urls = new Map<string, string>()
  /**
   * Tabs whose main frame shows an error page for a failed load. Chrome closes the failed
   * navigation with `onErrorOccurred` and hides the `chrome-error://` document that takes its
   * place; here two documents follow the failure and neither is the extension's business:
   * WebView's own error page, which commits and finishes *under the failed URL* (so the URL
   * alone cannot tell its `load` from the page's), then the core's `zen://error` page, whose
   * hash and `pushState` navigations report under a `data:` URL. Everything about the tab is
   * dropped until another document commits.
   */
  private readonly hidden = new Set<string>()

  constructor(private readonly now: () => number) {}

  tabRemoved(tabId: string): void {
    this.inFlight.delete(tabId)
    this.documents.delete(tabId)
    this.urls.delete(tabId)
    this.hidden.delete(tabId)
  }

  // ---------------------------------------------------------------------------
  // The navigation listener
  // ---------------------------------------------------------------------------

  report(tabId: string, tab: TabFacts, r: NavigationReport): DerivedEvent[] {
    if (r.url.startsWith(ERROR_PAGE_PREFIX)) return []
    switch (r.phase) {
      case 'started': {
        if (r.sameDocument) {
          if (this.hidden.has(tabId)) return []
          return this.sameDocument(tabId, tab, r.url)
        }
        this.inFlight.set(tabId, {
          url: r.url,
          serverRedirect: false,
          reload: r.reload === true,
          history: r.history === true,
          byPage: r.byPage === true
        })
        return [this.event('onBeforeNavigate', tab, r.url, this.documents.get(tabId))]
      }
      case 'redirected': {
        const flight = this.inFlight.get(tabId)
        if (flight) {
          flight.url = r.url
          flight.serverRedirect = true
        }
        return []
      }
      case 'completed': {
        if (r.sameDocument) return []
        const flight = this.inFlight.get(tabId)
        this.inFlight.delete(tabId)
        if (!r.committed || r.errorPage) {
          // Cancelled, failed before anything committed, or WebView's own error page took the
          // place of the document: Chrome reports the error and hides the error page's commit.
          if (r.committed) this.hidden.add(tabId)
          return [
            this.error(
              tab,
              r.url,
              r.error ?? (r.committed ? 'net::ERR_FAILED' : 'net::ERR_ABORTED'),
              this.documents.get(tabId)
            )
          ]
        }
        this.hidden.delete(tabId)
        const doc = documentId()
        this.documents.set(tabId, doc)
        this.urls.set(tabId, r.url)
        const out: DerivedEvent[] = []
        if (!flight) out.push(this.event('onBeforeNavigate', tab, r.url, undefined))
        out.push(
          this.committed(tab, r.url, doc, {
            reload: flight?.reload ?? r.reload === true,
            history: flight?.history ?? r.history === true,
            serverRedirect: flight?.serverRedirect ?? false,
            byPage: flight?.byPage ?? r.byPage === true
          })
        )
        return out
      }
      case 'dom':
        if (this.hidden.has(tabId)) return []
        return [this.event('onDOMContentLoaded', tab, r.url, this.documents.get(tabId))]
      case 'load':
        if (this.hidden.has(tabId)) return []
        return [this.event('onCompleted', tab, r.url, this.documents.get(tabId))]
    }
    return []
  }

  // ---------------------------------------------------------------------------
  // Inference from the client callbacks
  // ---------------------------------------------------------------------------

  /** `doUpdateVisitedHistory`: a document committed (or an in-page navigation happened). */
  inferredCommit(tabId: string, tab: TabFacts, url: string, inPage: boolean): DerivedEvent[] {
    if (url.startsWith(ERROR_PAGE_PREFIX)) {
      this.hidden.add(tabId)
      return []
    }
    if (inPage) {
      if (this.hidden.has(tabId)) return []
      return this.sameDocument(tabId, tab, url)
    }
    this.hidden.delete(tabId)
    const doc = documentId()
    this.documents.set(tabId, doc)
    this.urls.set(tabId, url)
    return [
      this.event('onBeforeNavigate', tab, url, undefined),
      this.committed(tab, url, doc, {
        reload: false,
        history: false,
        serverRedirect: false,
        byPage: true
      })
    ]
  }

  /**
   * `onPageFinished`: the document is done loading. After a failure the finish is WebView's own
   * error page's, under the failed URL, and stays hidden (a document of the page's commits first
   * when the tab moves on).
   */
  inferredFinish(tabId: string, tab: TabFacts, url: string): DerivedEvent[] {
    if (url.startsWith(ERROR_PAGE_PREFIX) || this.hidden.has(tabId)) return []
    const doc = this.documents.get(tabId)
    return [
      this.event('onDOMContentLoaded', tab, url, doc),
      this.event('onCompleted', tab, url, doc)
    ]
  }

  /** `onReceivedError` for the main frame: the navigation ends here, the error pages that follow are hidden. */
  inferredFailure(tabId: string, tab: TabFacts, url: string, error: string): DerivedEvent[] {
    this.hidden.add(tabId)
    return [this.error(tab, url, error, this.documents.get(tabId))]
  }

  // ---------------------------------------------------------------------------
  // Details
  // ---------------------------------------------------------------------------

  private sameDocument(tabId: string, tab: TabFacts, url: string): DerivedEvent[] {
    const previous = this.urls.get(tabId) ?? tab.committedUrl
    this.urls.set(tabId, url)
    const fragment = isFragmentNavigation(previous, url)
    const doc = this.documents.get(tabId)
    const { transitionType, transitionQualifiers } = transitionFor({
      isMainFrame: true,
      rendererInitiated: true
    })
    return [
      {
        event: fragment ? 'onReferenceFragmentUpdated' : 'onHistoryStateUpdated',
        details: {
          ...this.frame(tab, url, doc),
          transitionType,
          transitionQualifiers
        }
      }
    ]
  }

  private committed(
    tab: TabFacts,
    url: string,
    doc: string,
    hint: { reload: boolean; history: boolean; serverRedirect: boolean; byPage: boolean }
  ): DerivedEvent {
    const { transitionType, transitionQualifiers } = transitionFor({
      isMainFrame: true,
      reload: hint.reload,
      history: hint.history,
      serverRedirect: hint.serverRedirect,
      rendererInitiated: hint.byPage,
      // The chrome's own loads are what the user typed or tapped in the address bar.
      typed: !hint.byPage && !hint.reload && !hint.history
    })
    return {
      event: 'onCommitted',
      details: {
        ...this.frame(tab, url, doc),
        transitionType,
        transitionQualifiers: transitionQualifiers as TransitionQualifier[]
      }
    }
  }

  private error(tab: TabFacts, url: string, error: string, doc: string | undefined): DerivedEvent {
    return { event: 'onErrorOccurred', details: { ...this.frame(tab, url, doc), error } }
  }

  private event(
    event: WebNavigationEvent,
    tab: TabFacts,
    url: string,
    doc: string | undefined
  ): DerivedEvent {
    return { event, details: this.frame(tab, url, doc) }
  }

  private frame(tab: TabFacts, url: string, doc: string | undefined): NavigationEventDetails {
    return {
      tabId: tab.chromeTabId,
      frameId: 0,
      parentFrameId: -1,
      processId: -1,
      url,
      documentId: doc ?? '',
      frameType: 'outermost_frame',
      documentLifecycle: 'active',
      timeStamp: this.now()
    }
  }
}

/** The `navigation` view event's payload, checked. */
export function navigationReport(payload: unknown): NavigationReport | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as Record<string, unknown>
  const phase = p.phase
  if (
    phase !== 'started' &&
    phase !== 'redirected' &&
    phase !== 'completed' &&
    phase !== 'dom' &&
    phase !== 'load'
  )
    return null
  if (typeof p.url !== 'string') return null
  const report: NavigationReport = { phase, url: p.url }
  if (p.sameDocument === true) report.sameDocument = true
  if (p.reload === true) report.reload = true
  if (p.history === true) report.history = true
  if (p.byPage === true) report.byPage = true
  if (p.committed === true) report.committed = true
  if (p.errorPage === true) report.errorPage = true
  if (typeof p.error === 'string' && p.error) report.error = p.error
  if (typeof p.statusCode === 'number') report.statusCode = p.statusCode
  return report
}
