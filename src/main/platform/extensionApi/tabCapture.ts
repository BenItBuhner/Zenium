import type { WebContents } from 'electron'
import type { Tab } from '../../../shared/types'
import {
  DESKTOP_CAPTURE_CANCELLED,
  DESKTOP_CAPTURE_INVALID_STATE_ERROR,
  DESKTOP_CAPTURE_INVALID_TAB_ERROR,
  DESKTOP_CAPTURE_TARGET_NOT_FOUND_ERROR,
  DESKTOP_CAPTURE_WORKER_NEEDS_TAB_ERROR,
  TAB_CAPTURE_FINDING_TAB_ERROR,
  TAB_CAPTURE_GRANT_ERROR,
  TAB_CAPTURE_INVALID_TAB_ERROR,
  TAB_CAPTURE_NO_DOCUMENT_ERROR,
  TAB_CAPTURE_SAME_TAB_ERROR,
  TAB_CAPTURE_STATES,
  TAB_CAPTURE_TAB_URL_NOT_SECURE_ERROR,
  desktopCaptureResult,
  desktopSourceKinds,
  isCapturableUrl,
  isPotentiallyTrustworthyUrl,
  normalizeCaptureOptions,
  normalizeDesktopOptions,
  normalizeDesktopSources,
  normalizeDesktopTarget,
  normalizeStreamIdOptions,
  withTabSourceConstraints,
  type CaptureInfo,
  type DesktopCaptureResult,
  type DesktopStreamResolution,
  type TabCaptureState
} from '../../../core/extensions/api/tabCapture'
import { tabIdOfSource } from '../../../core/screenCapture'
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

/**
 * How long a `chooseDesktopMedia` pick waits for the consumer's `getUserMedia` (Chrome's
 * `DesktopStreamsRegistry` keeps a stream ten seconds; an extension that messages the id to a
 * target tab's content script first gets the same allowance a minted tab id does), and how long
 * the engine's media request may follow the consumer's call once it is under way.
 */
const PICK_TTL_MS = 60_000
const ARMED_TTL_MS = 10_000

/**
 * Chrome's `DesktopStreamsRegistry` entry: what `chooseDesktopMedia` picked, for the one document
 * that may take it (`chooseDesktopMedia`'s `targetTab`, else the calling document), once.
 */
interface DesktopPick {
  /**
   * The id the extension was answered: one of this layer's when the consumer is a document of
   * the extension (its shim turns it into the engine's terms at `getUserMedia`), the engine's own
   * source id when the consumer is a page (a `targetTab` of a site), which has no shim.
   */
  streamId: string
  extensionId: string
  /** The `WebContents` whose main frame may redeem the id. */
  consumer: number
  /** The consuming document's origin, as the engine's media request names it. */
  origin: string
  /** A `desktopCapturer` screen or window, or a Zenium tab. */
  source: { kind: 'desktop'; id: string } | { kind: 'tab'; tabId: string }
  /** Chrome's `audio_share`: the pick carries audio (`canRequestAudioTrack` as answered). */
  audio: boolean
  createdAt: number
  /** The consumer's `getUserMedia` is under way: the engine's media request may arrive. */
  armedAt: number | null
  /** The engine's request was approved: the entry is spent (Chrome hands a stream over once). */
  spent: boolean
}

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
 *
 * `chrome.desktopCapture.chooseDesktopMedia` puts up the chrome's screen picker (the core's
 * `ScreenCaptureService`, the one `getDisplayMedia` uses) with the extension's name and icon and
 * the panes it asked for, and answers the pick as a stream id (Chrome's `DesktopStreamsRegistry`
 * hand-over): the engine takes a `desktopCapturer` source id natively from a `getUserMedia` with
 * `chromeMediaSource: "desktop"`, once the session's permission handler has approved the media
 * request it makes on the consuming document (`allowsMediaRequest`, with the pick standing for
 * it); a picked tab goes the `tabCapture` way (the engine refuses a tab under `desktop`), which
 * the consumer's shim arranges at `getUserMedia` through `resolveStreamId`.
 */
export class TabCaptureApi {
  private readonly requests: LiveRequest[] = []
  private readonly picks: DesktopPick[] = []
  /** `chooseDesktopMedia` calls waiting on the picker: the caller's request id → the core's. */
  private readonly choices = new Map<string, string>()
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

  /**
   * `chrome.desktopCapture`: the shim leads `chooseDesktopMedia`'s arguments with its request id,
   * as Chrome's binding does, so `cancelChooseDesktopMedia` can name the call.
   */
  readonly desktopHandlers: NamespaceHandlers = {
    chooseDesktopMedia: (ctx, requestId, sources, targetTab, options) =>
      this.chooseDesktopMedia(ctx, requestId, sources, targetTab, options),
    cancelChooseDesktopMedia: (ctx, requestId) => this.cancelChooseDesktopMedia(ctx, requestId),
    resolveStreamId: (ctx, streamId) => this.resolveDesktopStreamId(ctx, streamId)
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
      const consumer = this.consumerById(options.consumerTabId)
      const origin = originOf(consumer.url)
      if (!origin || !isPotentiallyTrustworthyUrl(consumer.url))
        throw new ApiError(TAB_CAPTURE_TAB_URL_NOT_SECURE_ERROR)
      const consumerWc = consumer.wc
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
   * The engine asks a permission handler about a `getUserMedia` naming no device (`media` with
   * an empty `mediaTypes`) from `securityOrigin`, on `target`: allowed when an extension's
   * capture stands behind it – a registered `tabCapture` request of that origin on the tab
   * (`target` is the captured tab), or a `chooseDesktopMedia` pick the consuming document
   * (`target`, for a screen or window; the picked tab, for a tab) is redeeming now, which this
   * spends. The engine's own registry already tied a tab stream to the one consuming frame and to
   * this moment; a pick of a screen or window is tied here.
   */
  allowsMediaRequest(target: WebContents, securityOrigin: string | undefined): boolean {
    if (!securityOrigin) return false
    const origin = originOf(securityOrigin)
    if (!origin) return false
    const pick = this.armedPick(target, origin)
    if (pick) {
      pick.spent = true
      return true
    }
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

  /**
   * The target tab closed: its captures are over. A `chooseDesktopMedia` pick of it stays until
   * its consumer calls (Chrome's registry answers that call `Invalid state`) or it lapses.
   */
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
    for (const pick of [...this.picks]) {
      if (pick.extensionId === extensionId) this.picks.splice(this.picks.indexOf(pick), 1)
    }
    for (const [key, requestId] of [...this.choices]) {
      if (!key.startsWith(`${extensionId}:`)) continue
      this.choices.delete(key)
      this.host.browser.screenCapture.respond(requestId, null)
    }
  }

  // ---------------------------------------------------------------------------
  // desktopCapture
  // ---------------------------------------------------------------------------

  /**
   * Chrome's `DesktopCaptureChooseDesktopMediaFunction`: the arguments checked in its order, the
   * picker up over the target tab (or the calling document's tab, or the focused window's
   * active tab for a document without one – a popup, the side panel) with the extension named
   * where a site would be, the pick answered as a stream id for the consuming document. A worker
   * has no document to consume the stream, so it must name a `targetTab`, as in Chrome.
   *
   * A `targetTab` of a site makes that page the consumer: it has no shim, so it gets the engine's
   * own source id, which Electron parses natively for a screen or window; a tab it could not take
   * that way, so the tab pane stays out of its picker.
   */
  private async chooseDesktopMedia(
    ctx: ApiContext,
    requestId: unknown,
    rawSources: unknown,
    rawTarget: unknown,
    rawOptions: unknown
  ): Promise<DesktopCaptureResult> {
    const sources = validated(() => normalizeDesktopSources(rawSources))
    const target = validated(() => normalizeDesktopTarget(rawTarget))
    const options = validated(() => normalizeDesktopOptions(rawOptions))
    const audio = sources.includes('audio')
    const own = extensionOrigin(ctx.extensionId)
    let consumer: WebContents
    let origin: string
    let anchor: Tab | undefined
    if (target) {
      let found: { url: string; wc: WebContents | undefined }
      try {
        found = this.consumerById(target.id)
      } catch {
        throw new ApiError(DESKTOP_CAPTURE_INVALID_TAB_ERROR)
      }
      if (!found.wc) throw new ApiError(DESKTOP_CAPTURE_TARGET_NOT_FOUND_ERROR)
      consumer = found.wc
      origin = originOf(target.url) ?? target.url
      anchor = this.host.model.zenTab(target.id) ?? this.anchorTabOf(ctx)
    } else {
      if (ctx.sender.kind !== 'frame') throw new ApiError(DESKTOP_CAPTURE_WORKER_NEEDS_TAB_ERROR)
      consumer = ctx.sender.webContents
      origin = own
      anchor = (ctx.tabId ? this.host.model.tab(ctx.tabId) : undefined) ?? this.anchorTabOf(ctx)
    }
    if (!anchor) throw new ApiError(DESKTOP_CAPTURE_TARGET_NOT_FOUND_ERROR)
    // The consumer's shim resolves an id of this layer's; a site's page has none.
    const shimmed = origin === own
    const kinds = desktopSourceKinds(sources).filter((kind) => shimmed || kind !== 'tab')
    const anchorWc = this.host.model.webContentsOf(anchor)
    const opened = this.host.browser.screenCapture.open({
      tabId: anchor.id,
      url: shimmed ? '' : (target?.url ?? ''),
      audio,
      extension: this.presentationOf(ctx),
      kinds,
      excludeSystemAudio: options.excludeSystemAudio,
      excludeSelf: options.excludeSelf && anchorWc !== undefined && anchorWc.id === consumer.id
    })
    const key = opened.id ? choiceKey(ctx, requestId) : null
    if (key && opened.id) this.choices.set(key, opened.id)
    const picked = await opened.answer
    if (key) this.choices.delete(key)
    if (!picked.sourceId || consumer.isDestroyed()) return DESKTOP_CAPTURE_CANCELLED
    const tabId = tabIdOfSource(picked.sourceId)
    const source: DesktopPick['source'] = tabId
      ? { kind: 'tab', tabId }
      : { kind: 'desktop', id: picked.sourceId }
    // Chrome's `audio_share`: the system-audio box for a screen; a tab's own sound whenever
    // audio was asked for (the tab share carries it, as Chrome's "Share tab audio" does).
    const canRequestAudioTrack = source.kind === 'tab' ? audio : picked.audio
    const streamId = shimmed ? this.mintDesktop() : picked.sourceId
    this.prunePicks()
    this.picks.push({
      streamId,
      extensionId: ctx.extensionId,
      consumer: consumer.id,
      origin,
      source,
      audio: canRequestAudioTrack,
      createdAt: this.now(),
      armedAt: shimmed ? null : this.now(),
      spent: false
    })
    return desktopCaptureResult(streamId, canRequestAudioTrack)
  }

  /** Chrome's `DesktopCaptureRequestsRegistry::CancelRequest`: the picker goes, the call answers empty. */
  private cancelChooseDesktopMedia(ctx: ApiContext, requestId: unknown): void {
    const key = choiceKey(ctx, requestId)
    const pending = this.choices.get(key)
    if (!pending) return
    this.choices.delete(key)
    this.host.browser.screenCapture.respond(pending, null)
  }

  /**
   * The consuming extension document is about to call `getUserMedia` with an id
   * `chooseDesktopMedia` answered: the engine's terms for it – the `desktopCapturer` id under
   * `chromeMediaSource: "desktop"`, or for a picked tab the engine's tab stream, registered for
   * this document now, under `"tab"` – and the pick armed for the media request that follows.
   * Null for an id this layer did not mint (the constraints stay as they are).
   */
  private resolveDesktopStreamId(
    ctx: ApiContext,
    streamId: unknown
  ): DesktopStreamResolution | null {
    if (typeof streamId !== 'string' || ctx.sender.kind !== 'frame') return null
    this.prunePicks()
    const pick = this.picks.find((p) => p.streamId === streamId)
    if (!pick) return null
    const consumerWc = ctx.sender.webContents
    if (
      pick.extensionId !== ctx.extensionId ||
      pick.consumer !== consumerWc.id ||
      ctx.sender.frame.parent !== null ||
      pick.spent ||
      pick.armedAt !== null
    ) {
      throw new ApiError(DESKTOP_CAPTURE_INVALID_STATE_ERROR)
    }
    if (pick.source.kind === 'tab') {
      const tab = this.host.model.tab(pick.source.tabId)
      const targetWc = tab ? this.host.model.webContentsOf(tab) : undefined
      if (!targetWc) {
        this.picks.splice(this.picks.indexOf(pick), 1)
        throw new ApiError(DESKTOP_CAPTURE_INVALID_STATE_ERROR)
      }
      const engineId = this.registrar.register(targetWc, consumerWc)
      pick.armedAt = this.now()
      return { source: 'tab', id: engineId, audio: pick.audio }
    }
    pick.armedAt = this.now()
    return { source: 'desktop', id: pick.source.id, audio: pick.audio }
  }

  /**
   * The pick behind a media request the engine makes on `target` for `origin`: a screen or
   * window's, when `target` is the consuming document; a tab's, when `target` is the picked tab.
   */
  private armedPick(target: WebContents, origin: string): DesktopPick | undefined {
    this.prunePicks()
    const now = this.now()
    const tab = this.host.model.zenTab(target.id)
    return this.picks.find(
      (p) =>
        p.origin === origin &&
        !p.spent &&
        p.armedAt !== null &&
        now - p.armedAt <= ARMED_TTL_MS &&
        (p.source.kind === 'desktop'
          ? p.consumer === target.id
          : tab !== undefined && p.source.tabId === tab.id)
    )
  }

  /**
   * Picks past their time go. A spent one stays until then, so a second `getUserMedia` with its
   * id gets Chrome's `Invalid state` rather than the engine's word on an id it cannot parse.
   */
  private prunePicks(): void {
    const now = this.now()
    for (const pick of [...this.picks]) {
      if (now - pick.createdAt > PICK_TTL_MS) this.picks.splice(this.picks.indexOf(pick), 1)
    }
  }

  /** The extension as the picker names it: its name and icon, from the browser's record of it. */
  private presentationOf(ctx: ApiContext): { name: string; icon: string | null } {
    const info = this.host.browser.extensions.list().find((i) => i.id === ctx.extensionId)
    return {
      name: info?.name ?? ctx.extension.manifest.name ?? ctx.extensionId,
      icon: info?.icon ?? null
    }
  }

  /**
   * Chrome makes the picker modal to the target's own window, else to the last active browser
   * window: the tab it shows over is that window's active one.
   */
  private anchorTabOf(ctx: ApiContext): Tab | undefined {
    const win = ctx.window ?? this.host.model.lastFocusedWindow()
    return win ? this.host.browser.tabs.activeTabFor(win) : undefined
  }

  private mintDesktop(): string {
    this.minted += 1
    return `zen-desktop-capture-${this.prefix}-${this.minted}`
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private tabById(tabId: number): Tab {
    const tab = this.host.model.zenTab(tabId)
    if (!tab) throw new ApiError(TAB_CAPTURE_INVALID_TAB_ERROR)
    return tab
  }

  /**
   * The consumer named by `consumerTabId`. Chrome's `GetTabById` finds any tab of the profile:
   * the browser's, and the one tab of an extension popup window (`windows.create({type:
   * "popup"})`), which an extension's recorder window passes as itself (`tabs.getCurrent()`).
   * The page may be unloaded (no `wc`); the caller reports that after the URL checks, as Chrome
   * orders them.
   */
  private consumerById(tabId: number): { url: string; wc: WebContents | undefined } {
    const tab = this.host.model.zenTab(tabId)
    if (tab) return { url: tab.url, wc: this.host.model.webContentsOf(tab) }
    const popup = this.host.model.popupForTabId(tabId)
    if (!popup) throw new ApiError(TAB_CAPTURE_INVALID_TAB_ERROR)
    const wc = popup.bw.webContents
    return { url: wc.getURL(), wc }
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

  /**
   * The consuming document going away ends the capture: Chrome sees its media request close. The
   * document goes with its `WebContents`, with its renderer, and with a cross-document navigation
   * of its frame (a reload of a recorder window): the stream it held is over, and the tab is free
   * for the next document's capture. A request nothing has redeemed yet (Chrome's
   * `TAB_CAPTURE_STATE_NONE`) outlives a navigation, as its registry entry does.
   */
  private watchConsumer(consumer: WebContents, streamId: string): void {
    const find = (): LiveRequest | undefined => this.requests.find((r) => r.streamId === streamId)
    const detach = (): void => {
      consumer.removeListener('did-navigate', onNavigated)
      consumer.removeListener('render-process-gone', onGone)
      consumer.removeListener('destroyed', onGone)
    }
    const end = (request: LiveRequest): void => {
      detach()
      if (request.state === 'pending' || request.state === 'active')
        this.setState(request, 'stopped')
      this.remove(request)
    }
    const onGone = (): void => {
      const request = find()
      if (request) end(request)
      else detach()
    }
    const onNavigated = (): void => {
      const request = find()
      if (!request) detach()
      else if (request.state === 'pending' || request.state === 'active') end(request)
    }
    try {
      consumer.on('did-navigate', onNavigated)
      consumer.on('render-process-gone', onGone)
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
 * A `chooseDesktopMedia` call's key: the shim's request id counts per document or worker, so
 * the calling context qualifies it (Chrome keys its registry by the calling process).
 */
function choiceKey(ctx: ApiContext, requestId: unknown): string {
  const context =
    ctx.sender.kind === 'frame'
      ? `f${ctx.sender.webContents.id}:${ctx.sender.frame.routingId}`
      : `w${ctx.sender.worker.versionId}`
  return `${ctx.extensionId}:${context}:${String(requestId)}`
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
