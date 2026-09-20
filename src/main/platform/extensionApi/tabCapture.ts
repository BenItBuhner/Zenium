import type { WebContents } from 'electron'
import type { Tab } from '../../../shared/types'
import {
  DESKTOP_CAPTURE_CANCELLED,
  DESKTOP_CAPTURE_INVALID_TAB_ERROR,
  TAB_CAPTURE_FINDING_TAB_ERROR,
  TAB_CAPTURE_GRANT_ERROR,
  TAB_CAPTURE_INVALID_TAB_ERROR,
  TAB_CAPTURE_NO_DOCUMENT_ERROR,
  TAB_CAPTURE_SAME_TAB_ERROR,
  TAB_CAPTURE_STATES,
  TAB_CAPTURE_TAB_URL_NOT_SECURE_ERROR,
  isCapturableUrl,
  isPotentiallyTrustworthyUrl,
  normalizeCaptureOptions,
  normalizeDesktopSources,
  normalizeStreamIdOptions,
  withTabSourceConstraints,
  type CaptureInfo,
  type TabCaptureState
} from '../../../core/extensions/api/tabCapture'
import type { ActiveTabGrants } from './activeTab'
import { ApiError, validated, type ApiContext, type ApiHost, type NamespaceHandlers } from './types'

/**
 * The engine's stream registry (`tabCaptureBridge.ts` binds it to Electron): `register` puts a
 * stream of the target's page in it for the consumer's main frame to redeem with `getUserMedia`
 * (`chromeMediaSource: "tab"`) within Chromium's ten seconds, once; `alive` says whether a
 * consuming document still exists.
 */
export interface StreamRegistrar {
  register(target: WebContents, consumer: WebContents): string
  alive(webContentsId: number): boolean
}

/**
 * How long a stream id this layer minted may wait for the consumer's `getUserMedia`. Chrome's
 * registry gives an engine id ten seconds; the minted id stands for one that is registered only
 * when the consumer calls, so it can afford the offscreen document's start-up.
 */
const MINTED_ID_TTL_MS = 60_000

/** Chrome's `TabCaptureRegistry::LiveRequest`: one capture request of one extension on one tab. */
interface LiveRequest {
  /** The id the extension was answered (this layer's, or the engine's when registered at once). */
  streamId: string
  extensionId: string
  zenTabId: string
  chromeTabId: number
  /** `getMediaStreamId`'s requests: no status events, absent from `getCapturedTabs`. */
  anonymous: boolean
  /** The origin of the consuming document (the extension's, or the consumer tab's). */
  origin: string
  /** The one document that may redeem the id (a `WebContents` id), or any of the extension's. */
  consumer: number | null
  /** The engine's id exists for a consumer: its media request may arrive on the target. */
  registered: boolean
  /** Null until the consumer's `getUserMedia` is under way (Chrome's `TAB_CAPTURE_STATE_NONE`). */
  state: TabCaptureState | null
  createdAt: number
}

/**
 * `chrome.tabCapture` over the engine's page capture (`WebContentsMediaCaptureId` streams, the
 * same the tab share of `getDisplayMedia` rides on), and `chrome.desktopCapture`'s answer.
 *
 * `getMediaStreamId` and `capture` resolve the target tab, require the user to have invoked the
 * extension on it (`ActiveTabGrants.allowsCapture`), refuse a tab with a capture under way, and
 * answer a stream id: the engine's when the consumer is a tab named by `consumerTabId`
 * (registered for it at once, as Chrome does), otherwise one of this layer's, which
 * `resolveStreamId` turns into the engine's for the document that calls `getUserMedia` with it
 * (the caller's own, or for a worker's request any document of the extension). The media
 * request the engine then makes on the target is approved by `allowsMediaRequest` (the
 * session's permission handler asks) when a registered request of that consumer's origin exists
 * for the tab: the user's gesture on the extension was the consent, as in Chrome.
 *
 * Status follows the consumer's `getUserMedia` call (`streamState` from the shim) and the
 * consumer document's life: Chrome observes the media request, which the engine does not report
 * to the browser layer here. `getCapturedTabs` and `onStatusChanged` cover `capture`'s requests
 * only, like Chrome's (`getMediaStreamId`'s are anonymous).
 */
export class TabCaptureApi {
  private readonly requests: LiveRequest[] = []
  private minted = 0
  private readonly prefix = Math.random().toString(36).slice(2, 10)

  constructor(
    private readonly host: ApiHost,
    private readonly activeTab: ActiveTabGrants,
    private readonly registrar: StreamRegistrar,
    private readonly now: () => number = Date.now
  ) {}

  readonly handlers: NamespaceHandlers = {
    capture: (ctx, options) => this.capture(ctx, options),
    getCapturedTabs: (ctx) => this.getCapturedTabs(ctx),
    getMediaStreamId: (ctx, options) => this.getMediaStreamId(ctx, options),
    resolveStreamId: (ctx, streamId) => this.resolveStreamId(ctx, streamId),
    streamState: (ctx, streamId, state) => this.streamState(ctx, streamId, state)
  }

  /** `chrome.desktopCapture`: the picker is a UI piece to come; until then every call is a cancel. */
  readonly desktopHandlers: NamespaceHandlers = {
    chooseDesktopMedia: (ctx, sources, targetTab) =>
      this.chooseDesktopMedia(ctx, sources, targetTab),
    cancelChooseDesktopMedia: () => undefined
  }

  // ---------------------------------------------------------------------------
  // The namespace's methods
  // ---------------------------------------------------------------------------

  private getMediaStreamId(ctx: ApiContext, raw: unknown): string {
    const options = validated(() => normalizeStreamIdOptions(raw))
    const target =
      options.targetTabId !== undefined ? this.tabById(options.targetTabId) : this.activeTabOf(ctx)
    const chromeTabId = this.host.model.chromeTabId(target)
    this.requireGrant(ctx.extensionId, chromeTabId, target)
    if (options.consumerTabId !== undefined) {
      const consumer = this.tabById(options.consumerTabId)
      const origin = originOf(consumer.url)
      if (!origin || !isPotentiallyTrustworthyUrl(consumer.url))
        throw new ApiError(TAB_CAPTURE_TAB_URL_NOT_SECURE_ERROR)
      const consumerWc = this.host.model.webContentsOf(consumer)
      if (!consumerWc) throw new ApiError(TAB_CAPTURE_INVALID_TAB_ERROR)
      const targetWc = this.host.model.webContentsOf(target)
      if (!targetWc) throw new ApiError(TAB_CAPTURE_FINDING_TAB_ERROR)
      this.requireFree(target)
      const streamId = this.registrar.register(targetWc, consumerWc)
      this.add({
        streamId,
        extensionId: ctx.extensionId,
        zenTabId: target.id,
        chromeTabId,
        anonymous: true,
        origin,
        consumer: consumerWc.id,
        registered: true,
        state: null,
        createdAt: this.now()
      })
      this.watchConsumer(consumerWc, streamId)
      return streamId
    }
    this.requireFree(target)
    const streamId = this.mint()
    this.add({
      streamId,
      extensionId: ctx.extensionId,
      zenTabId: target.id,
      chromeTabId,
      anonymous: true,
      origin: extensionOrigin(ctx.extensionId),
      consumer: ctx.sender.kind === 'frame' ? ctx.sender.webContents.id : null,
      registered: false,
      state: null,
      createdAt: this.now()
    })
    return streamId
  }

  private capture(ctx: ApiContext, raw: unknown): unknown {
    if (ctx.sender.kind !== 'frame') throw new ApiError(TAB_CAPTURE_NO_DOCUMENT_ERROR)
    const target = this.activeTabOf(ctx)
    const chromeTabId = this.host.model.chromeTabId(target)
    this.requireGrant(ctx.extensionId, chromeTabId, target)
    const options = validated(() => normalizeCaptureOptions(raw))
    this.requireFree(target)
    const streamId = this.mint()
    this.add({
      streamId,
      extensionId: ctx.extensionId,
      zenTabId: target.id,
      chromeTabId,
      anonymous: false,
      origin: extensionOrigin(ctx.extensionId),
      consumer: ctx.sender.webContents.id,
      registered: false,
      state: null,
      createdAt: this.now()
    })
    return withTabSourceConstraints(options, streamId)
  }

  private getCapturedTabs(ctx: ApiContext): CaptureInfo[] {
    return this.requests
      .filter((r) => r.extensionId === ctx.extensionId && !r.anonymous && r.state !== null)
      .map((r) => this.infoOf(r))
  }

  // ---------------------------------------------------------------------------
  // The shim's side of the consumer's getUserMedia
  // ---------------------------------------------------------------------------

  /**
   * The consuming document is about to call `getUserMedia` with `streamId`: an id of this layer's
   * is registered with the engine for that document now and answered as the engine's; an id this
   * layer does not know (the engine's already, from a `consumerTabId` request) passes through.
   */
  private resolveStreamId(ctx: ApiContext, streamId: unknown): string {
    if (typeof streamId !== 'string') throw new ApiError(TAB_CAPTURE_INVALID_TAB_ERROR)
    if (ctx.sender.kind !== 'frame') throw new ApiError(TAB_CAPTURE_NO_DOCUMENT_ERROR)
    const request = this.requests.find((r) => r.streamId === streamId)
    if (!request) return streamId
    const consumerWc = ctx.sender.webContents
    // The engine registers the stream for the consumer's main frame: a sub-frame cannot redeem.
    if (
      request.extensionId !== ctx.extensionId ||
      (request.consumer !== null && request.consumer !== consumerWc.id) ||
      ctx.sender.frame.parent !== null
    ) {
      throw new ApiError(TAB_CAPTURE_INVALID_TAB_ERROR)
    }
    if (request.registered) return streamId
    if (this.now() - request.createdAt > MINTED_ID_TTL_MS) {
      this.remove(request)
      throw new ApiError(TAB_CAPTURE_FINDING_TAB_ERROR)
    }
    const target = this.host.model.tab(request.zenTabId)
    const targetWc = target ? this.host.model.webContentsOf(target) : undefined
    if (!targetWc) {
      this.remove(request)
      throw new ApiError(TAB_CAPTURE_FINDING_TAB_ERROR)
    }
    const engineId = this.registrar.register(targetWc, consumerWc)
    request.registered = true
    request.consumer = consumerWc.id
    this.watchConsumer(consumerWc, request.streamId)
    this.setState(request, 'pending')
    return engineId
  }

  /** What became of the consumer's `getUserMedia`: the stream started, ended or failed. */
  private streamState(ctx: ApiContext, streamId: unknown, state: unknown): void {
    if (typeof streamId !== 'string' || !isState(state)) return
    const request = this.requests.find(
      (r) => r.streamId === streamId && r.extensionId === ctx.extensionId
    )
    if (!request || request.state === 'stopped' || request.state === 'error') return
    if (state === 'pending' && request.state !== null) return
    this.setState(request, state)
  }

  // ---------------------------------------------------------------------------
  // What the platform asks
  // ---------------------------------------------------------------------------

  /**
   * The engine asks the target tab's permission handler about a `getUserMedia` naming no device
   * (`media` with an empty `mediaTypes`) from `securityOrigin`: allowed when a registered request
   * of that origin stands on the tab. The engine's own registry already tied the id to the one
   * consuming frame and to this moment.
   */
  allowsMediaRequest(target: WebContents, securityOrigin: string | undefined): boolean {
    if (!securityOrigin) return false
    const origin = originOf(securityOrigin)
    if (!origin) return false
    const tab = this.host.model.zenTab(target.id)
    if (!tab) return false
    return this.requests.some(
      (r) =>
        r.zenTabId === tab.id &&
        r.registered &&
        r.origin === origin &&
        r.state !== 'stopped' &&
        r.state !== 'error' &&
        this.now() - r.createdAt <= MINTED_ID_TTL_MS
    )
  }

  /** The target tab closed: its captures are over. */
  tabRemoved(chromeTabId: number): void {
    for (const request of [...this.requests]) {
      if (request.chromeTabId !== chromeTabId) continue
      if (request.state === 'pending' || request.state === 'active')
        this.setState(request, 'stopped')
      this.remove(request)
    }
  }

  unload(extensionId: string): void {
    for (const request of [...this.requests]) {
      if (request.extensionId === extensionId) this.remove(request)
    }
  }

  // ---------------------------------------------------------------------------
  // desktopCapture
  // ---------------------------------------------------------------------------

  private chooseDesktopMedia(
    _ctx: ApiContext,
    sources: unknown,
    targetTab: unknown
  ): typeof DESKTOP_CAPTURE_CANCELLED {
    validated(() => normalizeDesktopSources(sources))
    if (targetTab !== undefined && targetTab !== null) {
      const tab = targetTab as Record<string, unknown>
      if (typeof tab !== 'object' || (tab.id !== undefined && typeof tab.id !== 'number')) {
        throw new ApiError(DESKTOP_CAPTURE_INVALID_TAB_ERROR)
      }
      if (typeof tab.id === 'number' && !this.host.model.zenTab(tab.id)) {
        throw new ApiError(DESKTOP_CAPTURE_INVALID_TAB_ERROR)
      }
    }
    return DESKTOP_CAPTURE_CANCELLED
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private tabById(tabId: number): Tab {
    const tab = this.host.model.zenTab(tabId)
    if (!tab) throw new ApiError(TAB_CAPTURE_INVALID_TAB_ERROR)
    return tab
  }

  /** Chrome's `FindAnyBrowser` + active tab: the caller's window, else the last focused one. */
  private activeTabOf(ctx: ApiContext): Tab {
    const win = ctx.window ?? this.host.model.lastFocusedWindow()
    const active = win ? this.host.browser.tabs.activeTabFor(win) : undefined
    if (!active) throw new ApiError(TAB_CAPTURE_FINDING_TAB_ERROR)
    return active
  }

  private requireGrant(extensionId: string, chromeTabId: number, target: Tab): void {
    if (!this.activeTab.allowsCapture(extensionId, chromeTabId) || !isCapturableUrl(target.url)) {
      throw new ApiError(TAB_CAPTURE_GRANT_ERROR)
    }
  }

  /**
   * Chrome refuses a second capture of a tab whose request is pending or active, and replaces a
   * request in any other state. A request whose consuming document is gone counts as over.
   */
  private requireFree(target: Tab): void {
    const existing = this.requests.find((r) => r.zenTabId === target.id)
    if (!existing) return
    if (
      existing.consumer !== null &&
      existing.registered &&
      !this.registrar.alive(existing.consumer)
    ) {
      if (existing.state === 'pending' || existing.state === 'active')
        this.setState(existing, 'stopped')
      this.remove(existing)
      return
    }
    if (existing.state === 'pending' || existing.state === 'active') {
      throw new ApiError(TAB_CAPTURE_SAME_TAB_ERROR)
    }
    this.remove(existing)
  }

  private add(request: LiveRequest): void {
    this.requests.push(request)
  }

  private remove(request: LiveRequest): void {
    const at = this.requests.indexOf(request)
    if (at >= 0) this.requests.splice(at, 1)
  }

  private mint(): string {
    this.minted += 1
    return `zen-tab-capture-${this.prefix}-${this.minted}`
  }

  /** The consuming document going away ends the capture (Chrome sees the media request close). */
  private watchConsumer(consumer: WebContents, streamId: string): void {
    const onGone = (): void => {
      const request = this.requests.find((r) => r.streamId === streamId)
      if (!request) return
      if (request.state === 'pending' || request.state === 'active')
        this.setState(request, 'stopped')
      this.remove(request)
    }
    try {
      consumer.once('destroyed', onGone)
    } catch {
      /* already gone */
    }
  }

  private setState(request: LiveRequest, state: TabCaptureState): void {
    if (request.state === state) return
    request.state = state
    if (request.anonymous) return
    this.host.dispatch(request.extensionId, 'tabCapture', 'onStatusChanged', [this.infoOf(request)])
  }

  /** Chrome's `fullscreen`: an element of the captured page is in fullscreen. */
  private infoOf(request: LiveRequest): CaptureInfo {
    const tab = this.host.model.tab(request.zenTabId)
    const win = tab ? this.host.model.windowOfTab(tab) : undefined
    return {
      tabId: request.chromeTabId,
      status: request.state ?? 'pending',
      fullscreen: tab !== undefined && win?.htmlFullscreenTabId === tab.id
    }
  }
}

function isState(value: unknown): value is TabCaptureState {
  return typeof value === 'string' && (TAB_CAPTURE_STATES as readonly string[]).includes(value)
}

function extensionOrigin(extensionId: string): string {
  return `chrome-extension://${extensionId}`
}

/**
 * The origin of a URL the way Chromium spells a security origin: `scheme://host[:port]`. Node's
 * `URL.origin` is `"null"` for every scheme it does not know (`chrome-extension:`, `file:`), so
 * those are spelled here from their parts.
 */
function originOf(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.origin && parsed.origin !== 'null') return parsed.origin
  if (parsed.protocol === 'file:') return 'file://'
  return parsed.host ? `${parsed.protocol}//${parsed.host}` : null
}
