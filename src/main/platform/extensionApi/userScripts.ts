import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { WebContents, WebFrameMain } from 'electron'
import { PRIVATE_CONTAINER_ID } from '../../../shared/types'
import {
  NO_RECEIVER_ERROR,
  PORT_CLOSED_ERROR,
  USER_SCRIPTS_CHANNELS,
  type PortWire,
  type ShimMessageAnswer,
  type ShimPortWire,
  type WireAnswer,
  type WireExtensionPlan,
  type WirePlannedScript,
  type WireWorldPlan,
  type WorldDelivery,
  type WorldExecution,
  type WorldMessage,
  type WorldMessageResult,
  type WorldPortInfo
} from '../../../shared/userScripts'
import {
  DEFAULT_USER_SCRIPT_CSP,
  applyUpdates,
  emptyUserScriptsState,
  normalizeInjection,
  normalizeRegistrations,
  normalizeWorldConfig,
  persistedUserScripts,
  planUserScripts,
  resetWorldConfig,
  selectScripts,
  setWorldConfig,
  userScriptsMethodUnavailable,
  userScriptsStateFrom,
  worldConfigFor,
  type RegisteredUserScript,
  type UserScriptInjection,
  type UserScriptSource,
  type UserScriptsState,
  type WorldPlan
} from '../../../core/extensions/api/userScripts'
import type { FrameContext, WorkerContext } from './contexts'
import { frameById, frameIdOf } from './frames'
import {
  ApiError,
  isInteger,
  isRecord,
  validated,
  type ApiContext,
  type ApiHost,
  type LoadedExtension,
  type NamespaceHandlers
} from './types'

/** What the module needs of `WebNavigationApi`: Chrome's document ids of a page's frames. */
export interface DocumentIds {
  documentIdOf(wc: WebContents, frame: WebFrameMain): string
  frameByDocumentId(wc: WebContents, documentId: string): WebFrameMain | null
}

type Context = FrameContext | WorkerContext

/** What `tabs.sendMessage`'s hosted half answers the shim with (see `combineTabMessage`). */
export interface HostedTabMessage {
  handled: boolean
  responded: boolean
  result?: unknown
}

/** Chrome's `userScripts.InjectionResult`. */
export interface InjectionResult {
  frameId: number
  documentId: string
  result?: unknown
  error?: string
}

/** A `deliver` or `execute` sent to a page frame, waiting for the frame's `answer`. */
interface PendingAnswer {
  extensionId: string
  wc: WebContents
  frame: WebFrameMain
  frameKey: string
  resolve(answer: WireAnswer | null): void
}

/** A world's `runtime.sendMessage`, dispatched to the extension's contexts under a token. */
interface PendingMessage {
  extensionId: string
  /** Contexts the event went to that have not closed their channel yet. */
  remaining: number
  resolve(result: WorldMessageResult): void
  timer: ReturnType<typeof setTimeout>
}

/** A `runtime.connect` port a world opened, between the page frame and the extension's contexts. */
interface HostPort {
  /** The host's id: what the extension's contexts see. */
  id: string
  extensionId: string
  wc: WebContents
  frame: WebFrameMain
  frameKey: string
  /** The preload's id (unique per document): what the page side sees. */
  preloadPortId: string
  /** Contexts that built a `Port` for `runtime.onUserScriptConnect` (`accept`). */
  accepted: Set<Context>
  /** What the world posted before any context accepted. */
  buffered: unknown[]
  /** Nobody accepted within this: the world hears that no receiver exists. */
  acceptTimer: ReturnType<typeof setTimeout> | null
}

/** A page frame that got a plan or an execution: it may hold worlds of these extensions. */
interface FrameWorlds {
  frame: WebFrameMain
  extensions: Set<string>
}

const PERMISSION = 'userScripts'
/** A world's `sendMessage` whose listeners keep the channel open this long counts as closed. */
export const MESSAGE_ANSWER_TIMEOUT_MS = 5 * 60_000
/** A world's `connect` no context built a `Port` for within this is refused (the shim's own TTL). */
export const CONNECT_ACCEPT_TIMEOUT_MS = 10_000
const MAX_BUFFERED_PORT_MESSAGES = 100

/**
 * `chrome.userScripts` for the browser layer. Electron has none of it; both MV3 userscript
 * managers on the compatibility list (Tampermonkey, Violentmonkey) inject through it alone.
 *
 * The registrations and world configurations live here per extension, validated by the core
 * model and persisted per extension. The page preload of every tab frame asks at document start
 * what to inject (`plan`: the worlds of every loaded extension holding the permission, with the
 * user's "Allow user scripts" toggle on, loaded into the frame's session, with host access to
 * the frame's URL, whose registrations match), and gets the scripts' code (a `file` source read
 * from the extension's directory). The worlds' `runtime.sendMessage` / `runtime.connect` arrive
 * here and go on to the extension's contexts as `runtime.onUserScriptMessage` /
 * `onUserScriptConnect`; the extension's `tabs.sendMessage` and `userScripts.execute` go the
 * other way to the frames known to hold its worlds, each answered under a token.
 *
 * Chrome gates the namespace behind the per-extension toggle: with it off `chrome.userScripts`
 * throws on access (the shim's part, told through `__zen.toggles`), nothing is injected into
 * pages loaded from then on, and a call that still reaches the host is refused with Chrome's
 * "'userScripts.<method>' is not available."; the registrations stay for when it comes back.
 */
export class UserScriptsApi {
  private readonly states = new Map<string, UserScriptsState>()
  /** `ExtensionInfo.allowUserScripts` of every loaded extension. */
  private readonly allowed = new Map<string, boolean>()
  /** `file` sources read from disk, per extension (dropped when it unloads). */
  private readonly codeCache = new Map<string, Map<string, string>>()
  /** Frames that may hold worlds, by page then frame key. */
  private readonly frameWorlds = new Map<WebContents, Map<string, FrameWorlds>>()
  private readonly watchedPages = new WeakSet<WebContents>()
  private readonly pending = new Map<number, PendingAnswer>()
  private readonly messages = new Map<number, PendingMessage>()
  private readonly ports = new Map<string, HostPort>()
  /** Ports by `frameKey|preloadPortId`. */
  private readonly portsByPage = new Map<string, HostPort>()
  private tokens = 0
  private portIds = 0

  constructor(
    private readonly host: ApiHost,
    private readonly documents: DocumentIds
  ) {}

  readonly handlers: NamespaceHandlers = {
    register: (ctx, scripts) => this.register(ctx, scripts),
    getScripts: (ctx, filter) => this.getScripts(ctx, filter),
    unregister: (ctx, filter) => this.unregister(ctx, filter),
    update: (ctx, scripts) => this.update(ctx, scripts),
    configureWorld: (ctx, properties) => this.configureWorld(ctx, properties),
    getWorldConfigurations: (ctx) => this.getWorldConfigurations(ctx),
    resetWorldConfiguration: (ctx, worldId) => this.resetWorldConfiguration(ctx, worldId),
    execute: (ctx, injection) => this.execute(ctx, injection),
    sendMessage: (ctx, tabId, message, options) => this.sendMessage(ctx, tabId, message, options)
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** The extension loaded: its persisted registrations come back, with the toggle's state. */
  load(extension: LoadedExtension, allowUserScripts: boolean): void {
    this.allowed.set(extension.id, allowUserScripts)
    if (!this.hasPermission(extension.id)) return
    this.states.set(extension.id, userScriptsStateFrom(this.host.store.userScripts(extension.id)))
  }

  unload(extensionId: string): void {
    this.states.delete(extensionId)
    this.allowed.delete(extensionId)
    this.codeCache.delete(extensionId)
    for (const frames of this.frameWorlds.values()) {
      for (const [key, record] of frames) {
        record.extensions.delete(extensionId)
        if (record.extensions.size === 0) frames.delete(key)
      }
    }
    for (const [token, pending] of this.pending) {
      if (pending.extensionId !== extensionId) continue
      this.pending.delete(token)
      pending.resolve(null)
    }
    for (const [token, message] of this.messages) {
      if (message.extensionId !== extensionId) continue
      clearTimeout(message.timer)
      this.messages.delete(token)
      message.resolve({ error: PORT_CLOSED_ERROR })
    }
    for (const port of [...this.ports.values()]) {
      if (port.extensionId === extensionId) this.closePort(port, undefined, null)
    }
  }

  /** The extension is gone for good: its registrations go with it. */
  uninstalled(extensionId: string): void {
    this.unload(extensionId)
    this.host.store.setUserScripts(extensionId, null)
  }

  /** `ExtensionInfo.allowUserScripts` flipped: the extension's contexts learn it at once. */
  setAllowed(extensionId: string, allowed: boolean): void {
    if (!this.host.loaded(extensionId)) return
    this.allowed.set(extensionId, allowed)
    const toggles = { userScripts: allowed }
    const registry = this.host.registry
    for (const context of [...registry.framesOf(extensionId), ...registry.workersOf(extensionId)]) {
      registry.sendTo(context, '__zen', 'toggles', [toggles])
    }
  }

  /** The toggles an extension's contexts install their shim with (`ShimOptions.toggles`). */
  togglesFor(extensionId: string): Record<string, boolean> {
    return { userScripts: this.isAllowed(extensionId) }
  }

  isAllowed(extensionId: string): boolean {
    return this.allowed.get(extensionId) === true
  }

  /** Follow a tab page: a frame's answers die with its document, everything with the page. */
  pageCreated(wc: WebContents): void {
    if (this.watchedPages.has(wc) || wc.isDestroyed()) return
    this.watchedPages.add(wc)
    wc.on('did-frame-navigate', (_event, _url, _code, _text, isMainFrame, processId, routingId) => {
      this.frameNavigated(wc, `${processId}:${routingId}`, isMainFrame)
    })
    wc.once('destroyed', () => this.pageGone(wc))
  }

  /** A frame of the page shows a new document: what the old one owed or held is gone. */
  frameNavigated(wc: WebContents, frameKey: string, isMainFrame: boolean): void {
    const frames = this.frameWorlds.get(wc)
    const gone = (frame: WebFrameMain, key: string): boolean =>
      key === frameKey || frame.isDestroyed() || (isMainFrame && frame.parent === null)
    if (frames) {
      for (const [key, record] of frames) if (gone(record.frame, key)) frames.delete(key)
      if (frames.size === 0) this.frameWorlds.delete(wc)
    }
    for (const [token, pending] of this.pending) {
      if (pending.wc !== wc || !gone(pending.frame, pending.frameKey)) continue
      this.pending.delete(token)
      pending.resolve(null)
    }
    for (const port of [...this.ports.values()]) {
      if (port.wc === wc && gone(port.frame, port.frameKey)) this.closePort(port, undefined, null)
    }
  }

  private pageGone(wc: WebContents): void {
    this.frameWorlds.delete(wc)
    for (const [token, pending] of this.pending) {
      if (pending.wc !== wc) continue
      this.pending.delete(token)
      pending.resolve(null)
    }
    for (const port of [...this.ports.values()]) {
      if (port.wc === wc) this.closePort(port, undefined, null)
    }
  }

  /** Registered scripts of an extension, for tests and diagnostics. */
  scriptsOf(extensionId: string): RegisteredUserScript[] {
    return [...(this.states.get(extensionId)?.scripts ?? [])]
  }

  /** Frames known to hold worlds of an extension, for tests. */
  worldFrameCount(extensionId: string): number {
    let count = 0
    for (const frames of this.frameWorlds.values())
      for (const record of frames.values()) if (record.extensions.has(extensionId)) count += 1
    return count
  }

  get pendingAnswers(): number {
    return this.pending.size
  }

  get openPorts(): number {
    return this.ports.size
  }

  // ---------------------------------------------------------------------------
  // The API
  // ---------------------------------------------------------------------------

  private hasPermission(extensionId: string): boolean {
    return this.host.grants(extensionId).permissions.includes(PERMISSION)
  }

  /** Loaded, holding the permission, toggle on: the extension's scripts run and it may be messaged. */
  private enabled(extensionId: string): boolean {
    return (
      this.host.loaded(extensionId) !== undefined &&
      this.hasPermission(extensionId) &&
      this.isAllowed(extensionId)
    )
  }

  private stateOf(extensionId: string): UserScriptsState {
    let state = this.states.get(extensionId)
    if (!state) {
      state = emptyUserScriptsState()
      this.states.set(extensionId, state)
    }
    return state
  }

  private requireApi(ctx: ApiContext, method: string): UserScriptsState {
    if (!this.hasPermission(ctx.extensionId)) {
      throw new ApiError(`The '${PERMISSION}' permission is required.`)
    }
    if (!this.isAllowed(ctx.extensionId)) throw new ApiError(userScriptsMethodUnavailable(method))
    return this.stateOf(ctx.extensionId)
  }

  private persist(extensionId: string, state: UserScriptsState): void {
    this.states.set(extensionId, state)
    this.host.store.setUserScripts(extensionId, persistedUserScripts(state))
  }

  private register(ctx: ApiContext, raw: unknown): void {
    const state = this.requireApi(ctx, 'register')
    const scripts = validated(() =>
      normalizeRegistrations(raw, new Set(state.scripts.map((script) => script.id)))
    )
    for (const script of scripts) this.checkSources(ctx.extension, script.js)
    this.persist(ctx.extensionId, { ...state, scripts: [...state.scripts, ...scripts] })
  }

  private getScripts(ctx: ApiContext, filter: unknown): RegisteredUserScript[] {
    const state = this.requireApi(ctx, 'getScripts')
    return validated(() => selectScripts(state.scripts, filter)).map((script) => ({ ...script }))
  }

  private unregister(ctx: ApiContext, filter: unknown): void {
    const state = this.requireApi(ctx, 'unregister')
    const selected = new Set(validated(() => selectScripts(state.scripts, filter)))
    if (isRecord(filter) && Array.isArray(filter.ids)) {
      const known = new Set(state.scripts.map((script) => script.id))
      for (const id of filter.ids) {
        if (!known.has(id as string)) throw new ApiError(`Nonexistent script ID '${String(id)}'`)
      }
    }
    this.persist(ctx.extensionId, {
      ...state,
      scripts: state.scripts.filter((script) => !selected.has(script))
    })
  }

  private update(ctx: ApiContext, raw: unknown): void {
    const state = this.requireApi(ctx, 'update')
    const scripts = validated(() => applyUpdates(state.scripts, raw))
    for (const script of scripts) this.checkSources(ctx.extension, script.js)
    this.persist(ctx.extensionId, { ...state, scripts })
  }

  private configureWorld(ctx: ApiContext, properties: unknown): void {
    const state = this.requireApi(ctx, 'configureWorld')
    const config = validated(() => normalizeWorldConfig(properties))
    this.persist(ctx.extensionId, { ...state, worlds: setWorldConfig(state.worlds, config) })
  }

  private getWorldConfigurations(ctx: ApiContext): unknown[] {
    const state = this.requireApi(ctx, 'getWorldConfigurations')
    return state.worlds.map((world) => ({ ...world }))
  }

  private resetWorldConfiguration(ctx: ApiContext, worldId: unknown): void {
    const state = this.requireApi(ctx, 'resetWorldConfiguration')
    this.persist(ctx.extensionId, {
      ...state,
      worlds: validated(() => resetWorldConfig(state.worlds, worldId))
    })
  }

  /** Chrome checks a `file` source exists when it is registered. */
  private checkSources(extension: LoadedExtension, sources: UserScriptSource[]): void {
    for (const source of sources) {
      if ('file' in source && this.readSource(extension, source.file) === null) {
        throw new ApiError(`Could not load javascript '${source.file}' for script.`)
      }
    }
  }

  /** A `file` source's code, from the extension's directory (never outside it), or null. */
  private readSource(extension: LoadedExtension, file: string): string | null {
    let cache = this.codeCache.get(extension.id)
    if (!cache) {
      cache = new Map()
      this.codeCache.set(extension.id, cache)
    }
    const cached = cache.get(file)
    if (cached !== undefined) return cached
    const root = resolve(extension.path)
    const path = resolve(join(root, decodeURIComponent(file)))
    if (path !== root && !path.startsWith(root + sep)) return null
    try {
      const code = `${readFileSync(path, 'utf8')}\n//# sourceURL=chrome-extension://${extension.id}/${file}`
      cache.set(file, code)
      return code
    } catch {
      return null
    }
  }

  private resolveSources(extension: LoadedExtension, sources: UserScriptSource[]): string[] {
    const code: string[] = []
    for (const source of sources) {
      if ('code' in source) {
        code.push(source.code)
        continue
      }
      const read = this.readSource(extension, source.file)
      if (read === null) {
        console.warn(`[zen] userScripts ${extension.id}: cannot read '${source.file}'`)
        continue
      }
      code.push(read)
    }
    return code
  }

  private allowsFileAccess(extensionId: string): boolean {
    return (
      this.host.browser.extensions.list().find((info) => info.id === extensionId)
        ?.allowFileAccess ?? false
    )
  }

  // ---------------------------------------------------------------------------
  // The plan: what a page frame injects, asked synchronously at document start
  // ---------------------------------------------------------------------------

  /** `USER_SCRIPTS_CHANNELS.plan`: the worlds of every extension in this frame, code resolved. */
  plan(
    wc: WebContents,
    frame: WebFrameMain | null | undefined,
    request: unknown
  ): WireExtensionPlan[] {
    if (!frame || frame.isDestroyed() || wc.isDestroyed()) return []
    const tab = this.host.model.zenTab(wc.id)
    if (!tab) return []
    // Chromium's word on the document's URL, the preload's only when the frame has none yet.
    const url =
      frame.url || (isRecord(request) && typeof request.url === 'string' ? request.url : '')
    if (!url) return []
    const key = frameKey(frame)
    // A new document in the frame: whatever the previous one held is gone.
    this.frameWorlds.get(wc)?.delete(key)
    const isTopFrame = frame.parent === null
    const incognito = tab.containerId === PRIVATE_CONTAINER_ID
    const plans: WireExtensionPlan[] = []
    for (const extension of this.host.allLoaded()) {
      if (!this.enabled(extension.id)) continue
      if (!this.host.partitionsOf(extension.id).includes(tab.containerId)) continue
      const worlds = planUserScripts(
        this.stateOf(extension.id),
        true,
        { url, isTopFrame },
        {
          hostAccess: (candidate) => this.host.hostAccess(extension.id, candidate),
          allowFileAccess: this.allowsFileAccess(extension.id)
        }
      )
      if (worlds.length === 0) continue
      plans.push({
        extensionId: extension.id,
        incognito,
        worlds: worlds.map((world) => this.wireWorld(extension, world))
      })
      this.trackWorld(wc, frame, extension.id)
    }
    return plans
  }

  private wireWorld(extension: LoadedExtension, world: WorldPlan): WireWorldPlan {
    const scripts: WirePlannedScript[] = []
    for (const script of world.scripts) {
      const code = this.resolveSources(extension, script.js)
      if (code.length > 0) scripts.push({ id: script.id, runAt: script.runAt, code })
    }
    return {
      world: world.world,
      worldId: world.worldId,
      csp: world.csp,
      messaging: world.messaging,
      scripts
    }
  }

  private trackWorld(wc: WebContents, frame: WebFrameMain, extensionId: string): void {
    let frames = this.frameWorlds.get(wc)
    if (!frames) {
      frames = new Map()
      this.frameWorlds.set(wc, frames)
      this.pageCreated(wc)
    }
    const key = frameKey(frame)
    let record = frames.get(key)
    if (!record || record.frame !== frame) {
      record = { frame, extensions: new Set() }
      frames.set(key, record)
    }
    record.extensions.add(extensionId)
  }

  /** Frames of a page known to hold worlds of the extension (a stale one answers "not handled"). */
  private worldFrames(wc: WebContents, extensionId: string): WebFrameMain[] {
    const frames = this.frameWorlds.get(wc)
    if (!frames) return []
    const out: WebFrameMain[] = []
    for (const [key, record] of frames) {
      if (record.frame.isDestroyed()) {
        frames.delete(key)
        continue
      }
      if (record.extensions.has(extensionId)) out.push(record.frame)
    }
    return out
  }

  private holdsWorld(wc: WebContents, frame: WebFrameMain, extensionId: string): boolean {
    const record = this.frameWorlds.get(wc)?.get(frameKey(frame))
    return record !== undefined && record.frame === frame && record.extensions.has(extensionId)
  }

  // ---------------------------------------------------------------------------
  // World → extension: runtime.sendMessage / runtime.connect from a user-script world
  // ---------------------------------------------------------------------------

  /** Why a world of the extension in this frame may not reach the extension, or null. */
  private worldAccess(
    wc: WebContents,
    frame: WebFrameMain,
    extensionId: string,
    worldId: string | null
  ): string | null {
    if (!this.enabled(extensionId)) return NO_RECEIVER_ERROR
    if (!this.holdsWorld(wc, frame, extensionId)) return NO_RECEIVER_ERROR
    if (!this.host.hostAccess(extensionId, frame.url)) return NO_RECEIVER_ERROR
    const config = worldConfigFor(this.stateOf(extensionId).worlds, worldId ?? undefined)
    if (!config.messaging) return NO_RECEIVER_ERROR
    return null
  }

  /** Chrome's `MessageSender` of a user-script world: the page's tab, frame and document. */
  private worldSender(wc: WebContents, frame: WebFrameMain, extension: LoadedExtension): unknown {
    const sender: Record<string, unknown> = {
      id: extension.id,
      url: frame.url,
      origin: frame.origin,
      frameId: frameIdOf(frame),
      documentId: this.documents.documentIdOf(wc, frame),
      documentLifecycle: 'active'
    }
    const tab = this.host.model.zenTab(wc.id)
    if (tab) sender.tab = this.host.model.chromeTab(tab, this.host.canSeeTab(extension, tab.url))
    return sender
  }

  /** `USER_SCRIPTS_CHANNELS.message`: a world's `runtime.sendMessage`, answered when a context does. */
  worldMessage(
    wc: WebContents,
    frame: WebFrameMain | null | undefined,
    raw: unknown
  ): Promise<WorldMessageResult> {
    if (!frame || !isRecord(raw) || typeof raw.extensionId !== 'string') {
      return Promise.resolve({ error: NO_RECEIVER_ERROR })
    }
    const message = raw as unknown as WorldMessage
    const worldId = typeof message.worldId === 'string' ? message.worldId : null
    const refusal = this.worldAccess(wc, frame, message.extensionId, worldId)
    const extension = this.host.loaded(message.extensionId)
    if (refusal || !extension) return Promise.resolve({ error: refusal ?? NO_RECEIVER_ERROR })
    const registry = this.host.registry
    if (!registry.hasListener(extension.id, 'runtime', 'onUserScriptMessage')) {
      return Promise.resolve({ error: NO_RECEIVER_ERROR })
    }
    const sender = this.worldSender(wc, frame, extension)
    const token = ++this.tokens
    return new Promise<WorldMessageResult>((resolve) => {
      const reached = registry.dispatch(extension.id, 'runtime', 'onUserScriptMessage', [
        message.message,
        sender,
        token
      ])
      if (reached === 0) {
        resolve({ error: NO_RECEIVER_ERROR })
        return
      }
      const timer = setTimeout(() => {
        this.messages.delete(token)
        resolve({ error: PORT_CLOSED_ERROR })
      }, MESSAGE_ANSWER_TIMEOUT_MS)
      this.messages.set(token, { extensionId: extension.id, remaining: reached, resolve, timer })
    })
  }

  /** The shim's answer to a `runtime.onUserScriptMessage` delivery (`USER_SCRIPTS_SHIM.answer`). */
  answerMessage(ctx: ApiContext, raw: unknown): void {
    if (!isRecord(raw) || !isInteger(raw.token)) return
    const answer = raw as unknown as ShimMessageAnswer
    const pending = this.messages.get(answer.token)
    if (!pending || pending.extensionId !== ctx.extensionId) return
    if (answer.responded === true) {
      clearTimeout(pending.timer)
      this.messages.delete(answer.token)
      pending.resolve({ result: answer.result })
      return
    }
    pending.remaining -= 1
    if (pending.remaining > 0) return
    clearTimeout(pending.timer)
    this.messages.delete(answer.token)
    pending.resolve({ error: PORT_CLOSED_ERROR })
  }

  /** `USER_SCRIPTS_CHANNELS.port` from a page: the world's side of a port. */
  worldPort(wc: WebContents, frame: WebFrameMain | null | undefined, raw: unknown): void {
    if (!frame || !isRecord(raw) || typeof raw.portId !== 'string') return
    const wire = raw as unknown as PortWire
    const pageKey = `${frameKey(frame)}|${wire.portId}`
    if (wire.kind === 'connect') {
      if (typeof wire.extensionId !== 'string') return
      const worldId = typeof wire.worldId === 'string' ? wire.worldId : null
      const refusal = this.worldAccess(wc, frame, wire.extensionId, worldId)
      const extension = this.host.loaded(wire.extensionId)
      const registry = this.host.registry
      if (
        refusal ||
        !extension ||
        !registry.hasListener(extension.id, 'runtime', 'onUserScriptConnect')
      ) {
        sendToPage(frame, USER_SCRIPTS_CHANNELS.port, {
          kind: 'disconnect',
          portId: wire.portId,
          error: refusal ?? NO_RECEIVER_ERROR
        } satisfies PortWire)
        return
      }
      // The same page id again means a new document in the frame reused it: the old port is gone.
      const stale = this.portsByPage.get(pageKey)
      if (stale) this.closePort(stale, undefined, null, { tellPage: false })
      this.portIds += 1
      const port: HostPort = {
        id: `us-port:${this.portIds}`,
        extensionId: extension.id,
        wc,
        frame,
        frameKey: frameKey(frame),
        preloadPortId: wire.portId,
        accepted: new Set(),
        buffered: [],
        acceptTimer: null
      }
      const info: WorldPortInfo = {
        portId: port.id,
        name: typeof wire.name === 'string' ? wire.name : '',
        sender: this.worldSender(wc, frame, extension)
      }
      const reached = registry.dispatch(extension.id, 'runtime', 'onUserScriptConnect', [info])
      if (reached === 0) {
        sendToPage(frame, USER_SCRIPTS_CHANNELS.port, {
          kind: 'disconnect',
          portId: wire.portId,
          error: NO_RECEIVER_ERROR
        } satisfies PortWire)
        return
      }
      this.ports.set(port.id, port)
      this.portsByPage.set(pageKey, port)
      port.acceptTimer = setTimeout(() => {
        port.acceptTimer = null
        if (port.accepted.size === 0) this.closePort(port, NO_RECEIVER_ERROR, null)
      }, CONNECT_ACCEPT_TIMEOUT_MS)
      return
    }
    const port = this.portsByPage.get(pageKey)
    if (!port || port.frame !== frame) return
    if (wire.kind === 'message') {
      const live = this.liveAccepted(port)
      if (live.length === 0) {
        if (port.acceptTimer === null) {
          // Every context that held the port is gone.
          this.closePort(port, undefined, null)
          return
        }
        if (port.buffered.length < MAX_BUFFERED_PORT_MESSAGES) port.buffered.push(wire.message)
        return
      }
      const payload: ShimPortWire = { kind: 'message', portId: port.id, message: wire.message }
      for (const context of live) this.host.registry.sendTo(context, '__zen', 'us-port', [payload])
      return
    }
    if (wire.kind === 'disconnect') this.closePort(port, undefined, null, { tellPage: false })
  }

  /** The extension side of a world's port (`USER_SCRIPTS_SHIM.port`). */
  shimPort(ctx: ApiContext, raw: unknown): void {
    if (!isRecord(raw) || typeof raw.portId !== 'string') return
    const wire = raw as unknown as ShimPortWire
    const port = this.ports.get(wire.portId)
    if (!port || port.extensionId !== ctx.extensionId) return
    const context = this.contextOf(ctx)
    if (!context) return
    switch (wire.kind) {
      case 'accept': {
        port.accepted.add(context)
        if (port.acceptTimer !== null) {
          clearTimeout(port.acceptTimer)
          port.acceptTimer = null
        }
        for (const message of port.buffered.splice(0)) {
          const payload: ShimPortWire = { kind: 'message', portId: port.id, message }
          this.host.registry.sendTo(context, '__zen', 'us-port', [payload])
        }
        return
      }
      case 'message':
        if (!port.accepted.has(context)) return
        sendToPage(port.frame, USER_SCRIPTS_CHANNELS.port, {
          kind: 'message',
          portId: port.preloadPortId,
          message: wire.message
        } satisfies PortWire)
        return
      case 'disconnect':
        if (!port.accepted.has(context)) return
        // Chrome closes the whole channel when any receiving context disconnects.
        this.closePort(port, undefined, context)
        return
    }
  }

  private liveAccepted(port: HostPort): Context[] {
    const live: Context[] = []
    for (const context of port.accepted) {
      if (this.host.registry.isLive(context)) live.push(context)
      else port.accepted.delete(context)
    }
    return live
  }

  /**
   * Close a port on both sides: the world hears `onDisconnect` (with `error` as its
   * `runtime.lastError` when given), every accepted context but `except` too.
   */
  private closePort(
    port: HostPort,
    error: string | undefined,
    except: Context | null,
    options: { tellPage?: boolean } = {}
  ): void {
    if (!this.ports.delete(port.id)) return
    this.portsByPage.delete(`${port.frameKey}|${port.preloadPortId}`)
    if (port.acceptTimer !== null) clearTimeout(port.acceptTimer)
    if (options.tellPage !== false) {
      const wire: PortWire = { kind: 'disconnect', portId: port.preloadPortId }
      if (error !== undefined) wire.error = error
      sendToPage(port.frame, USER_SCRIPTS_CHANNELS.port, wire)
    }
    const payload: ShimPortWire = { kind: 'disconnect', portId: port.id }
    for (const context of port.accepted) {
      if (context === except || !this.host.registry.isLive(context)) continue
      this.host.registry.sendTo(context, '__zen', 'us-port', [payload])
    }
  }

  private contextOf(ctx: ApiContext): Context | undefined {
    return ctx.sender.kind === 'frame'
      ? this.host.registry.frameFor(ctx.sender.frame)
      : this.host.registry.workerFor(ctx.sender.worker, ctx.sender.session)
  }

  // ---------------------------------------------------------------------------
  // Extension → world: tabs.sendMessage deliveries and userScripts.execute
  // ---------------------------------------------------------------------------

  /** Chrome's `MessageSender` of the extension context that called `tabs.sendMessage`. */
  private extensionSender(ctx: ApiContext): unknown {
    const url = ctx.sender.kind === 'frame' ? ctx.sender.frame.url : `${ctx.sender.worker.scope}`
    return { id: ctx.extensionId, url, origin: `chrome-extension://${ctx.extensionId}` }
  }

  /**
   * The hosted half of `tabs.sendMessage`: `runtime.onMessage` in the extension's user-script
   * worlds of the tab (the frame or document `options` name, else all); the first response wins.
   */
  private async sendMessage(
    ctx: ApiContext,
    rawTabId: unknown,
    message: unknown,
    rawOptions: unknown
  ): Promise<HostedTabMessage> {
    const none: HostedTabMessage = { handled: false, responded: false }
    if (!isInteger(rawTabId) || !this.enabled(ctx.extensionId)) return none
    const tab = this.host.model.zenTab(rawTabId)
    const wc = tab ? this.host.model.webContentsOf(tab) : undefined
    if (!wc) return none
    let frames = this.worldFrames(wc, ctx.extensionId)
    const options = isRecord(rawOptions) ? rawOptions : {}
    if (isInteger(options.frameId)) {
      frames = frames.filter((frame) => frameIdOf(frame) === options.frameId)
    }
    if (typeof options.documentId === 'string') {
      frames = frames.filter(
        (frame) => this.documents.documentIdOf(wc, frame) === options.documentId
      )
    }
    if (frames.length === 0) return none
    const sender = this.extensionSender(ctx)
    return firstResponse(
      frames.map((frame) =>
        this.ask(wc, frame, ctx.extensionId, USER_SCRIPTS_CHANNELS.deliver, (token) => {
          const delivery: WorldDelivery = { token, extensionId: ctx.extensionId, message, sender }
          return delivery
        }).then((answer): HostedTabMessage =>
          answer
            ? {
                handled: answer.handled === true,
                responded: answer.responded === true,
                result: answer.result
              }
            : none
        )
      )
    )
  }

  /** `userScripts.execute(injection)`: the code in the target frames, a result per frame. */
  private async execute(ctx: ApiContext, raw: unknown): Promise<InjectionResult[]> {
    this.requireApi(ctx, 'execute')
    const injection = validated(() => normalizeInjection(raw))
    const tab = this.host.model.zenTab(injection.target.tabId)
    const wc = tab ? this.host.model.webContentsOf(tab) : undefined
    if (!tab || !wc) throw new ApiError(`No tab with id: ${injection.target.tabId}.`)
    const frames = this.injectionFrames(wc, injection)
    for (const frame of frames) {
      if (!this.host.hostAccess(ctx.extensionId, frame.url)) {
        throw new ApiError(
          `Cannot access contents of url "${frame.url}". Extension manifest must request permission to access this host.`
        )
      }
    }
    const code = this.resolveSources(ctx.extension, injection.js)
    const config =
      injection.world === 'MAIN'
        ? null
        : worldConfigFor(this.stateOf(ctx.extensionId).worlds, injection.worldId)
    const incognito = tab.containerId === PRIVATE_CONTAINER_ID
    return Promise.all(
      frames.map(async (frame): Promise<InjectionResult> => {
        if (injection.world === 'USER_SCRIPT') this.trackWorld(wc, frame, ctx.extensionId)
        const documentId = this.documents.documentIdOf(wc, frame)
        const answer = await this.ask(
          wc,
          frame,
          ctx.extensionId,
          USER_SCRIPTS_CHANNELS.execute,
          (token) => {
            const execution: WorldExecution = {
              token,
              extensionId: ctx.extensionId,
              world: injection.world,
              worldId: injection.worldId ?? null,
              csp: config ? (config.csp ?? DEFAULT_USER_SCRIPT_CSP) : null,
              messaging: config?.messaging ?? false,
              incognito,
              code,
              injectImmediately: injection.injectImmediately
            }
            return execution
          }
        )
        const result: InjectionResult = { frameId: frameIdOf(frame), documentId }
        if (!answer) result.error = `Frame with ID ${frameIdOf(frame)} was removed.`
        else if (typeof answer.error === 'string') result.error = answer.error
        else result.result = answer.result
        return result
      })
    )
  }

  /** Chrome's target resolution: the outermost frame, `allFrames`, `frameIds` or `documentIds`. */
  private injectionFrames(wc: WebContents, injection: UserScriptInjection): WebFrameMain[] {
    const { target } = injection
    if (target.allFrames) return [...wc.mainFrame.framesInSubtree]
    if (target.frameIds) {
      return target.frameIds.map((frameId) => {
        const frame = frameById(wc, frameId)
        if (!frame)
          throw new ApiError(`No frame with id ${frameId} in tab with id ${target.tabId}.`)
        return frame
      })
    }
    if (target.documentIds) {
      return target.documentIds.map((documentId) => {
        const frame = this.documents.frameByDocumentId(wc, documentId)
        if (!frame)
          throw new ApiError(`No document with id ${documentId} in tab with id ${target.tabId}.`)
        return frame
      })
    }
    return [wc.mainFrame]
  }

  /** Send a token-bearing request to a page frame and wait for its `answer` (null: frame gone). */
  private ask(
    wc: WebContents,
    frame: WebFrameMain,
    extensionId: string,
    channel: string,
    payload: (token: number) => unknown
  ): Promise<WireAnswer | null> {
    const token = ++this.tokens
    return new Promise<WireAnswer | null>((resolve) => {
      this.pending.set(token, { extensionId, wc, frame, frameKey: frameKey(frame), resolve })
      if (!sendToPage(frame, channel, payload(token))) {
        this.pending.delete(token)
        resolve(null)
      }
    })
  }

  /** `USER_SCRIPTS_CHANNELS.answer` from a page frame: a delivery's or an execution's outcome. */
  answer(wc: WebContents, frame: WebFrameMain | null | undefined, raw: unknown): void {
    if (!frame || !isRecord(raw) || !isInteger(raw.token)) return
    const pending = this.pending.get(raw.token)
    if (!pending || pending.wc !== wc || pending.frameKey !== frameKey(frame)) return
    this.pending.delete(raw.token)
    pending.resolve(raw as unknown as WireAnswer)
  }
}

function frameKey(frame: WebFrameMain): string {
  return `${frame.processId}:${frame.routingId}`
}

/** Send to a page frame; false when it is gone. */
function sendToPage(frame: WebFrameMain, channel: string, payload: unknown): boolean {
  try {
    if (frame.isDestroyed()) return false
    frame.send(channel, payload)
    return true
  } catch {
    return false
  }
}

/**
 * Chrome's rule for a message to several receivers: the first response wins; with none, whether
 * anyone listened at all decides between the two errors the caller reports.
 */
function firstResponse(outcomes: Promise<HostedTabMessage>[]): Promise<HostedTabMessage> {
  return new Promise((resolve) => {
    let settled = false
    let handled = false
    let remaining = outcomes.length
    for (const outcome of outcomes) {
      outcome.then((answer) => {
        if (settled) return
        if (answer.handled) handled = true
        if (answer.responded) {
          settled = true
          resolve(answer)
          return
        }
        remaining -= 1
        if (remaining === 0) {
          settled = true
          resolve({ handled, responded: false })
        }
      })
    }
  })
}
