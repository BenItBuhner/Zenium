import { randomBytes } from 'node:crypto'
import { webContents as electronWebContents, type WebContents, type WebFrameMain } from 'electron'
import {
  isFragmentNavigation,
  netErrorName,
  transitionFor,
  type CommittedDetails,
  type CreatedNavigationTargetDetails,
  type ErrorDetails,
  type FrameDetails,
  type GetAllFramesEntry,
  type GetFrameResult,
  type NavigationEventDetails,
  type NavigationHint,
  type WebNavigationEvent
} from '../../../core/extensions/api/webNavigation'
import type { ElectronTabView } from '../views'
import { frameById, frameFromIds, frameIdOf, parentFrameIdOf } from './frames'
import {
  ApiError,
  isInteger,
  isRecord,
  type ApiContext,
  type ApiHost,
  type NamespaceHandlers
} from './types'

/** What a view remembers per frame: Chrome's `documentId` and the last committed URL. */
interface FrameState {
  documentId: string
  url: string
  errorOccurred: boolean
}

/** A `window.open` / `target=_blank` the host turned into a tab, waiting for that tab's view. */
interface PendingTarget {
  sourceTabId: number
  sourceFrameId: number
  sourceProcessId: number
  url: string
  at: number
}

const PENDING_TARGET_TTL_MS = 3_000

/**
 * `chrome.webNavigation`: frame queries over the engine's frame tree and the navigation event
 * family from every tab view's `WebContents` events, fanned out to the extensions holding the
 * `webNavigation` permission with each listener's `UrlFilter` applied in the registry. Frame ids
 * are Chrome's (`0` for the outermost frame, the frame tree node id below); `documentId`s are
 * minted per committed document since the engine does not expose Chromium's.
 */
export class WebNavigationApi {
  /** Frame states per view, keyed by `processId:routingId`. */
  private readonly frames = new WeakMap<WebContents, Map<string, FrameState>>()
  private readonly pendingTargets: PendingTarget[] = []
  /** A tab's outermost frame committed a document at `url` (activeTab and dNR follow tabs this way). */
  onMainFrameCommitted: ((tabId: number, url: string) => void) | null = null

  constructor(private readonly host: ApiHost) {}

  readonly handlers: NamespaceHandlers = {
    getFrame: (ctx, details) => this.getFrame(ctx, details),
    getAllFrames: (ctx, details) => this.getAllFrames(ctx, details)
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  private webContentsFor(details: unknown): { wc: WebContents; tabId: number } | null {
    if (!isRecord(details) || !isInteger(details.tabId)) throw new ApiError('Invalid tabId')
    const tab = this.host.model.zenTab(details.tabId)
    const wc = tab ? this.host.model.webContentsOf(tab) : undefined
    if (!wc) return null
    return { wc, tabId: details.tabId }
  }

  private getFrame(_ctx: ApiContext, details: unknown): GetFrameResult | null {
    const target = this.webContentsFor(details)
    if (!target || !isRecord(details) || !isInteger(details.frameId)) return null
    const frame = frameById(target.wc, details.frameId)
    if (!frame) return null
    return this.frameResult(target.wc, frame)
  }

  private getAllFrames(_ctx: ApiContext, details: unknown): GetAllFramesEntry[] | null {
    const target = this.webContentsFor(details)
    if (!target) return null
    const out: GetAllFramesEntry[] = []
    for (const frame of target.wc.mainFrame.framesInSubtree) {
      out.push({
        ...this.frameResult(target.wc, frame),
        processId: frame.processId,
        frameId: frameIdOf(frame)
      })
    }
    return out
  }

  private frameResult(wc: WebContents, frame: WebFrameMain): GetFrameResult {
    const state = this.stateOf(wc, frame)
    const result: GetFrameResult = {
      errorOccurred: state.errorOccurred,
      url: frame.url,
      parentFrameId: parentFrameIdOf(frame),
      documentId: state.documentId,
      frameType: frame.parent === null ? 'outermost_frame' : 'sub_frame',
      documentLifecycle: 'active'
    }
    const parent = frame.parent
    if (parent) result.parentDocumentId = this.stateOf(wc, parent).documentId
    return result
  }

  // ---------------------------------------------------------------------------
  // Frame state
  // ---------------------------------------------------------------------------

  private statesOf(wc: WebContents | null): Map<string, FrameState> {
    if (!wc) return new Map()
    let states = this.frames.get(wc)
    if (!states) {
      states = new Map()
      this.frames.set(wc, states)
    }
    return states
  }

  private stateOf(wc: WebContents | null, frame: WebFrameMain): FrameState {
    const states = this.statesOf(wc)
    const key = `${frame.processId}:${frame.routingId}`
    let state = states.get(key)
    if (!state) {
      state = { documentId: newDocumentId(), url: frame.url, errorOccurred: false }
      states.set(key, state)
    }
    return state
  }

  private stateByIds(wc: WebContents, processId: number, routingId: number): FrameState {
    const states = this.statesOf(wc)
    const key = `${processId}:${routingId}`
    let state = states.get(key)
    if (!state) {
      state = { documentId: newDocumentId(), url: '', errorOccurred: false }
      states.set(key, state)
    }
    return state
  }

  // ---------------------------------------------------------------------------
  // Event sources
  // ---------------------------------------------------------------------------

  /** Follow a tab view's navigations for as long as it lives. */
  attach(view: ElectronTabView): void {
    const wc = view.webContents
    if (wc.isDestroyed()) return
    const tabId = (): number => this.tabIdFor(wc)
    view.onNavigationTarget = (source, url) => this.navigationTarget(source, url)
    this.consumePendingTarget(wc)

    wc.on('did-start-navigation', (details) => {
      if (details.isSameDocument) return
      const frame = details.frame ?? (details.isMainFrame ? wc.mainFrame : null)
      if (!frame) return
      const state = this.stateOf(wc, frame)
      state.errorOccurred = false
      // The main frame's hint (reload / history / typed) is consumed by the commit below.
      this.emit('onBeforeNavigate', {
        ...this.details(tabId(), frame, details.url, state),
        timeStamp: Date.now()
      })
    })

    wc.on('did-redirect-navigation', (details) => {
      const frame = details.frame ?? (details.isMainFrame ? wc.mainFrame : null)
      if (frame) this.redirected.add(`${frame.processId}:${frame.routingId}`)
    })

    wc.on('did-frame-navigate', (_e, url, _code, _text, isMainFrame, processId, routingId) => {
      const frame = frameFromIds(processId, routingId) ?? (isMainFrame ? wc.mainFrame : null)
      const state = frame ? this.stateOf(wc, frame) : this.stateByIds(wc, processId, routingId)
      state.documentId = newDocumentId()
      state.url = url
      state.errorOccurred = false
      const key = `${processId}:${routingId}`
      const hint: NavigationHint = {
        isMainFrame,
        serverRedirect: this.redirected.delete(key),
        ...(isMainFrame ? view.takeNavigationHint() : {})
      }
      const transition = transitionFor(hint)
      const id = tabId()
      this.emit('onCommitted', {
        ...this.details(id, frame, url, state, processId, routingId, isMainFrame),
        timeStamp: Date.now(),
        ...transition
      })
      if (isMainFrame) {
        this.onMainFrameCommitted?.(id, url)
        this.host.scheduleTick()
      }
    })

    wc.on('did-navigate-in-page', (_e, url, isMainFrame, processId, routingId) => {
      const frame = frameFromIds(processId, routingId) ?? (isMainFrame ? wc.mainFrame : null)
      const state = frame ? this.stateOf(wc, frame) : this.stateByIds(wc, processId, routingId)
      const fragment = isFragmentNavigation(state.url, url)
      state.url = url
      const hint: NavigationHint = {
        isMainFrame,
        ...(isMainFrame ? view.takeNavigationHint() : {})
      }
      this.emit(fragment ? 'onReferenceFragmentUpdated' : 'onHistoryStateUpdated', {
        ...this.details(tabId(), frame, url, state, processId, routingId, isMainFrame),
        timeStamp: Date.now(),
        ...transitionFor(hint)
      })
    })

    wc.on('dom-ready', () => {
      if (wc.isDestroyed()) return
      const frame = wc.mainFrame
      const state = this.stateOf(wc, frame)
      this.emit('onDOMContentLoaded', {
        ...this.details(tabId(), frame, frame.url, state),
        timeStamp: Date.now()
      })
    })

    wc.on('did-frame-finish-load', (_e, isMainFrame, processId, routingId) => {
      const frame = frameFromIds(processId, routingId) ?? (isMainFrame ? wc.mainFrame : null)
      const state = frame ? this.stateOf(wc, frame) : this.stateByIds(wc, processId, routingId)
      if (state.errorOccurred) return
      const url = frame?.url ?? state.url
      const base = this.details(tabId(), frame, url, state, processId, routingId, isMainFrame)
      // The engine has no DOMContentLoaded signal for sub-frames; Chrome fires it right before
      // `onCompleted`, which is where it lands here.
      if (!isMainFrame) this.emit('onDOMContentLoaded', { ...base, timeStamp: Date.now() })
      this.emit('onCompleted', { ...base, timeStamp: Date.now() })
    })

    wc.on('did-fail-load', (_e, code, description, url, isMainFrame, processId, routingId) => {
      const frame = frameFromIds(processId, routingId) ?? (isMainFrame ? wc.mainFrame : null)
      const state = frame ? this.stateOf(wc, frame) : this.stateByIds(wc, processId, routingId)
      state.errorOccurred = true
      this.emit('onErrorOccurred', {
        ...this.details(tabId(), frame, url, state, processId, routingId, isMainFrame),
        timeStamp: Date.now(),
        error: netErrorName(code, description)
      })
    })
  }

  /** Server redirects seen since the last commit, by frame key. */
  private readonly redirected = new Set<string>()

  /**
   * The host is about to turn a `window.open` / `target=_blank` from `source` into a tab:
   * remember it so the new tab's view fires `onCreatedNavigationTarget`. Returns the function
   * that withdraws the entry when the core decides against a tab (popup window, blocked).
   */
  navigationTarget(source: WebContents, url: string): () => void {
    if (source.isDestroyed()) return () => undefined
    const target: PendingTarget = {
      sourceTabId: this.tabIdFor(source),
      sourceFrameId: 0,
      sourceProcessId: source.mainFrame.processId,
      url,
      at: Date.now()
    }
    this.pendingTargets.push(target)
    if (this.pendingTargets.length > 20) this.pendingTargets.shift()
    return () => {
      const index = this.pendingTargets.indexOf(target)
      if (index >= 0) this.pendingTargets.splice(index, 1)
    }
  }

  private consumePendingTarget(wc: WebContents): void {
    const now = Date.now()
    const live = this.pendingTargets.filter((t) => now - t.at <= PENDING_TARGET_TTL_MS)
    this.pendingTargets.splice(0, this.pendingTargets.length, ...live)
    const tabUrl = this.host.model.zenTab(wc.id)?.url
    let index = -1
    for (let i = live.length - 1; i >= 0; i--) {
      if (tabUrl !== undefined && live[i].url !== tabUrl) continue
      index = i
      break
    }
    if (index < 0) return
    const [target] = this.pendingTargets.splice(index, 1)
    const details: CreatedNavigationTargetDetails = {
      sourceTabId: target.sourceTabId,
      sourceProcessId: target.sourceProcessId,
      sourceFrameId: target.sourceFrameId,
      url: target.url,
      tabId: wc.id,
      timeStamp: now
    }
    this.emit('onCreatedNavigationTarget', details)
  }

  // ---------------------------------------------------------------------------
  // Payloads and fan-out
  // ---------------------------------------------------------------------------

  private tabIdFor(wc: WebContents): number {
    const tab = this.host.model.zenTab(wc.id)
    return tab ? this.host.model.chromeTabId(tab) : wc.id
  }

  private details(
    tabId: number,
    frame: WebFrameMain | null,
    url: string,
    state: FrameState,
    processId?: number,
    routingId?: number,
    isMainFrame?: boolean
  ): FrameDetails {
    const main = frame ? frame.parent === null : Boolean(isMainFrame)
    const details: FrameDetails = {
      tabId,
      frameId: frame ? frameIdOf(frame) : main ? 0 : (routingId ?? -1),
      parentFrameId: frame ? parentFrameIdOf(frame) : main ? -1 : 0,
      processId: frame ? frame.processId : (processId ?? -1),
      url,
      documentId: state.documentId,
      frameType: main ? 'outermost_frame' : 'sub_frame',
      documentLifecycle: 'active'
    }
    const parent = frame?.parent
    if (parent) details.parentDocumentId = this.stateOf(topContents(frame), parent).documentId
    return details
  }

  private emit(
    event: WebNavigationEvent,
    details:
      NavigationEventDetails | CommittedDetails | ErrorDetails | CreatedNavigationTargetDetails
  ): void {
    const url = details.url
    for (const ext of this.host.allLoaded()) {
      if (!this.host.grants(ext.id).permissions.includes('webNavigation')) continue
      this.host.dispatch(ext.id, 'webNavigation', event, [details], { url })
    }
  }
}

function newDocumentId(): string {
  return randomBytes(16).toString('hex').toUpperCase()
}

/** The `WebContents` a frame belongs to, when the engine still knows it. */
function topContents(frame: WebFrameMain): WebContents | null {
  try {
    return electronWebContents.fromFrame(frame) ?? null
  } catch {
    return null
  }
}
