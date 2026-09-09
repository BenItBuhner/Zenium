import type {
  AgentInfo,
  AgentMode,
  AgentServerStatus,
  AgentSettings,
  Tab
} from '../../shared/types'
import { emptyAgentServerStatus } from '../../shared/defaults'
import type { Browser } from '../browser'
import type { AgentTransport, TabView } from '../platform'
import type { ZenWindow } from '../window'
import {
  StreamableHttp,
  type AgentHttpRequest,
  type AgentHttpResponse,
  type SessionInit,
  type SessionStore
} from './http'
import { RpcError, UNAUTHORIZED } from './jsonrpc'
import { pageCall, type PageCursorOptions } from './page'
import {
  McpProtocol,
  newSession,
  type ClientInfo,
  type McpHandlers,
  type McpSession,
  type ResourceContents,
  type ResourceDefinition,
  type ToolDefinition,
  type ToolResult
} from './protocol'
import { AGENT_TOOLS, agentInstructions, type ToolContext } from './tools'
import { randomToken, sleep, textError } from './util'

/** Distinct, saturated colours that stay legible under white text (cursor tags, tab dots). */
export const AGENT_COLORS = [
  '#e0457b',
  '#3d8bff',
  '#2fb344',
  '#ff8c1a',
  '#9b5cff',
  '#00a8a8',
  '#d4a000',
  '#ff4d4d'
]

const SESSION_IDLE_MS = 30 * 60 * 1000
const SESSIONLESS_IDLE_MS = 10 * 60 * 1000
const SERVER_NAME = 'zen-browser'

/** One connected agent: its MCP session plus everything Zen knows about it. */
export interface AgentSession extends McpSession {
  name: string
  version: string
  color: string
  mode: AgentMode
  transport: 'http' | 'stdio'
  connectedAt: number
  lastActiveAt: number
  calls: number
  approved: boolean
  pending: boolean
  token: string | null
  remoteAddress: string
  userAgent: string
  currentTabId: string | null
  readonly tabIds: Set<string>
  /** Last cursor position per tab, so the cursor reappears where it was after a navigation. */
  readonly cursors: Map<string, { x: number; y: number }>
}

interface StoredEndpoint {
  token: string
  port?: number
  url?: string | null
  running?: boolean
}

/**
 * The browser side of the MCP server: sessions (one per agent), who drives which tab, foreground
 * vs background behaviour, the visible cursor, approval of new agents, and the server lifecycle.
 * The wire protocol lives in `protocol.ts` / `http.ts`, the tools in `tools.ts`.
 */
export class AgentService implements SessionStore, McpHandlers {
  readonly protocol: McpProtocol
  private readonly http: StreamableHttp
  private readonly transport: AgentTransport | null
  private readonly sessions = new Map<string, AgentSession>()
  private readonly sessionlessIds = new Map<string, string>()
  private readonly pendingApprovals = new Map<string, Promise<boolean>>()
  private status: AgentServerStatus = emptyAgentServerStatus()
  private token = ''
  private applying: Promise<void> = Promise.resolve()
  private sweeper: ReturnType<typeof setInterval> | null = null
  private started = false

  constructor(readonly browser: Browser) {
    this.transport = browser.platform.createAgentTransport?.(browser) ?? null
    this.protocol = new McpProtocol(this, {
      name: SERVER_NAME,
      title: 'Zen Browser',
      version: browser.platform.info.version
    })
    this.http = new StreamableHttp(this)
    this.token = this.loadToken()
    this.status.token = this.token
  }

  get settings(): AgentSettings {
    return this.browser.state.settings.agents
  }

  get available(): boolean {
    return this.transport !== null
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    this.started = true
    this.sweeper = setInterval(() => this.sweep(), 60_000)
    this.onSettingsChanged()
  }

  /** Bring the server in line with Settings → AI Agents (start / stop / rebind). */
  onSettingsChanged(): void {
    if (!this.started) return
    this.applying = this.applying.then(() => this.apply()).catch(() => undefined)
  }

  async stop(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
    for (const id of [...this.sessions.keys()]) this.close(id)
    await this.applying
    await this.stopServer()
  }

  private async apply(): Promise<void> {
    const s = this.settings
    const want = s.enabled && this.transport !== null
    const running = this.status.running
    const rebind =
      running &&
      (this.status.url !== endpointUrl('127.0.0.1', s.port) ||
        (s.lan ? this.status.lanUrls.length === 0 : this.status.lanUrls.length > 0))
    if (!want || rebind) await this.stopServer()
    if (want && !this.status.running) await this.startServer()
  }

  private async startServer(): Promise<void> {
    if (!this.transport) return
    const s = this.settings
    try {
      const bound = await this.transport.start({
        port: s.port,
        lan: s.lan,
        onRequest: (req) => this.handleHttp(req)
      })
      this.status = {
        running: true,
        url: endpointUrl('127.0.0.1', bound.port),
        lanUrls: s.lan ? bound.lanAddresses.map((a) => endpointUrl(a, bound.port)) : [],
        token: this.token,
        error: null
      }
      this.storeEndpoint(bound.port)
    } catch (error) {
      this.status = {
        ...emptyAgentServerStatus(),
        token: this.token,
        error: (error as Error).message || 'Could not start the MCP server'
      }
      this.storeEndpoint(null)
    }
    this.browser.state.commitVolatile()
  }

  private async stopServer(): Promise<void> {
    if (!this.status.running) return
    try {
      await this.transport?.stop()
    } catch {
      /* already down */
    }
    this.status = { ...emptyAgentServerStatus(), token: this.token }
    this.storeEndpoint(null)
    this.browser.state.commitVolatile()
  }

  handleHttp(req: AgentHttpRequest): Promise<AgentHttpResponse> {
    return this.http.handle(req)
  }

  // ---------------------------------------------------------------------------
  // Token & endpoint discovery (the `zen --mcp` stdio shim reads `zen/agent.json`)
  // ---------------------------------------------------------------------------

  private loadToken(): string {
    try {
      const raw = this.browser.platform.io.readSync('agent')
      const stored = raw ? (JSON.parse(raw) as StoredEndpoint) : null
      if (stored && typeof stored.token === 'string' && stored.token.length >= 32)
        return stored.token
    } catch {
      /* corrupt file: mint a new token */
    }
    const token = randomToken()
    void this.browser.platform.io.write('agent', JSON.stringify({ token, running: false }))
    return token
  }

  private storeEndpoint(port: number | null): void {
    const data: StoredEndpoint = {
      token: this.token,
      running: port !== null,
      port: port ?? undefined,
      url: port ? endpointUrl('127.0.0.1', port) : null
    }
    void this.browser.platform.io.write('agent', JSON.stringify(data, null, 2))
  }

  regenerateToken(): string {
    this.token = randomToken()
    this.status = { ...this.status, token: this.token }
    this.storeEndpoint(this.status.running ? portOf(this.status.url) : null)
    this.browser.state.commitVolatile()
    return this.token
  }

  isValidToken(token: string | null): boolean {
    return Boolean(token) && token === this.token
  }

  // ---------------------------------------------------------------------------
  // State for the UI
  // ---------------------------------------------------------------------------

  serverStatus(): AgentServerStatus {
    return this.status
  }

  list(): AgentInfo[] {
    return [...this.sessions.values()]
      .filter((s) => s.approved || s.pending)
      .map((s) => this.info(s))
      .sort((a, b) => a.connectedAt - b.connectedAt)
  }

  private info(s: AgentSession): AgentInfo {
    return {
      id: s.id,
      name: s.name,
      version: s.version,
      color: s.color,
      mode: s.mode,
      transport: s.transport,
      connectedAt: s.connectedAt,
      lastActiveAt: s.lastActiveAt,
      tabIds: [...s.tabIds],
      currentTabId: s.currentTabId,
      pending: s.pending,
      calls: s.calls
    }
  }

  /** The agent driving `tabId`, if any. */
  driver(tabId: string): AgentSession | undefined {
    for (const s of this.sessions.values()) if (s.tabIds.has(tabId)) return s
    return undefined
  }

  isDriving(tabId: string): boolean {
    return this.driver(tabId) !== undefined
  }

  session(id: string): AgentSession | undefined {
    return this.sessions.get(id)
  }

  // ---------------------------------------------------------------------------
  // User actions (Settings → AI Agents, tab indicator)
  // ---------------------------------------------------------------------------

  disconnect(id: string): void {
    this.close(id)
  }

  setMode(id: string, mode: AgentMode): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.mode = mode
    this.browser.state.commitVolatile()
  }

  releaseTab(tabId: string): void {
    const s = this.driver(tabId)
    if (s) this.release(s, tabId)
  }

  forget(name: string): void {
    const s = this.settings
    s.approvedNames = s.approvedNames.filter((n) => n !== name)
    this.browser.state.commit()
  }

  onTabRemoved(tabId: string): void {
    for (const s of this.sessions.values()) {
      if (!s.tabIds.has(tabId)) continue
      s.tabIds.delete(tabId)
      s.cursors.delete(tabId)
      if (s.currentTabId === tabId) s.currentTabId = firstOf(s.tabIds)
    }
    this.browser.state.commitVolatile()
  }

  // ---------------------------------------------------------------------------
  // SessionStore (used by the HTTP transport)
  // ---------------------------------------------------------------------------

  create(init: SessionInit): AgentSession {
    const id = randomToken().slice(0, 24)
    const base = newSession(id)
    const now = Date.now()
    const session: AgentSession = {
      ...base,
      name: 'Agent',
      version: '',
      color: this.pickColor(),
      mode: this.settings.defaultMode,
      transport: init.transport,
      connectedAt: now,
      lastActiveAt: now,
      calls: 0,
      approved: false,
      pending: false,
      token: init.token,
      remoteAddress: init.remoteAddress,
      userAgent: init.userAgent,
      currentTabId: null,
      tabIds: new Set(),
      cursors: new Map()
    }
    this.sessions.set(id, session)
    return session
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id)
  }

  sessionless(key: string, init: SessionInit): AgentSession {
    const existing = this.sessionlessIds.get(key)
    const found = existing ? this.sessions.get(existing) : undefined
    if (found) return found
    const session = this.create(init)
    this.sessionlessIds.set(key, session.id)
    return session
  }

  touch(session: McpSession): void {
    const s = this.sessions.get(session.id)
    if (s) s.lastActiveAt = Date.now()
  }

  close(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    for (const tabId of [...s.tabIds]) this.release(s, tabId, false)
    this.sessions.delete(id)
    for (const [key, sid] of this.sessionlessIds) if (sid === id) this.sessionlessIds.delete(key)
    this.browser.state.commitVolatile()
  }

  private sweep(): void {
    const now = Date.now()
    for (const s of [...this.sessions.values()]) {
      const sessionless = [...this.sessionlessIds.values()].includes(s.id)
      const idle = now - s.lastActiveAt
      if (idle > (sessionless ? SESSIONLESS_IDLE_MS : SESSION_IDLE_MS)) this.close(s.id)
      else if (!s.approved && !s.pending && idle > 60_000) this.close(s.id)
    }
  }

  private pickColor(): string {
    const used = new Map<string, number>()
    for (const s of this.sessions.values()) used.set(s.color, (used.get(s.color) ?? 0) + 1)
    let best = AGENT_COLORS[0]
    let bestCount = Infinity
    for (const c of AGENT_COLORS) {
      const n = used.get(c) ?? 0
      if (n < bestCount) {
        best = c
        bestCount = n
      }
    }
    return best
  }

  // ---------------------------------------------------------------------------
  // McpHandlers
  // ---------------------------------------------------------------------------

  async onInitialize(session: McpSession, client: ClientInfo): Promise<void> {
    const s = this.sessions.get(session.id)
    if (!s) throw new RpcError(UNAUTHORIZED, 'Unknown session')
    s.name = client.name
    s.version = client.version
    if (s.approved) return
    const settings = this.settings
    if (
      this.isValidToken(s.token) ||
      !settings.approveNewAgents ||
      settings.approvedNames.includes(s.name)
    ) {
      s.approved = true
      this.browser.state.commitVolatile()
      this.announce(s)
      return
    }
    s.pending = true
    this.browser.state.commitVolatile()
    const allowed = await this.askApproval(s)
    s.pending = false
    if (!allowed) {
      this.browser.state.commitVolatile()
      throw new RpcError(UNAUTHORIZED, `The user did not allow "${s.name}" to control this browser`)
    }
    s.approved = true
    if (!settings.approvedNames.includes(s.name)) {
      settings.approvedNames.push(s.name)
      this.browser.state.commit()
    }
    this.browser.state.commitVolatile()
    this.announce(s)
  }

  /** One prompt per agent name, however many times the client retries while it is showing. */
  private askApproval(s: AgentSession): Promise<boolean> {
    const pending = this.pendingApprovals.get(s.name)
    if (pending) return pending
    const win = this.agentWindow()
    const where =
      s.transport === 'stdio' ? 'on this computer' : `from ${describeRemote(s.remoteAddress)}`
    const p = this.browser.platform.dialogs
      .confirm(
        {
          message: `Allow "${s.name}" to control this browser?`,
          detail: `An AI agent (${s.name}${s.version ? ' ' + s.version : ''}) is connecting ${where} through Zen's MCP server. Once allowed it can open tabs, read pages and click and type in them. You can disconnect it at any time in Settings → AI Agents.`,
          okLabel: 'Allow',
          cancelLabel: 'Deny'
        },
        win
      )
      .finally(() => this.pendingApprovals.delete(s.name))
    this.pendingApprovals.set(s.name, p)
    return p
  }

  private announce(s: AgentSession): void {
    this.browser.toast(
      `AI agent "${s.name}" connected (${s.mode} mode)`,
      'info',
      this.agentWindow()
    )
  }

  listTools(session: McpSession): ToolDefinition[] {
    void session
    const allow = this.settings.allowScripts
    return AGENT_TOOLS.filter((t) => allow || !t.scripting).map((t) => t.definition)
  }

  async callTool(
    session: McpSession,
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    const s = this.requireApproved(session)
    const tool = AGENT_TOOLS.find((t) => t.definition.name === name)
    if (!tool) return textError(`Unknown tool ${name}`)
    if (tool.scripting && !this.settings.allowScripts)
      return textError('Scripts are disabled in Settings → AI Agents')
    s.calls++
    s.lastActiveAt = Date.now()
    const ctx: ToolContext = { browser: this.browser, agents: this, session: s }
    try {
      const result = await tool.run(ctx, args)
      this.browser.state.commitVolatile()
      return result
    } catch (error) {
      this.browser.state.commitVolatile()
      if (error instanceof RpcError) return textError(error.message)
      return textError((error as Error).message || String(error))
    }
  }

  listResources(session: McpSession): ResourceDefinition[] {
    void session
    return [
      {
        uri: 'zenium://status',
        name: 'status',
        title: 'Browser status',
        description: 'Connected agents, spaces and tabs as JSON',
        mimeType: 'application/json'
      },
      {
        uri: 'zenium://tabs',
        name: 'tabs',
        title: 'Open tabs',
        description: 'Every tab this agent may see, as JSON',
        mimeType: 'application/json'
      }
    ]
  }

  async readResource(session: McpSession, uri: string): Promise<ResourceContents[]> {
    const s = this.requireApproved(session)
    if (uri === 'zenium://status') {
      return [
        { uri, mimeType: 'application/json', text: JSON.stringify(this.statusJson(s), null, 2) }
      ]
    }
    if (uri === 'zenium://tabs') {
      return [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(
            this.visibleTabs(s).map((t) => this.tabJson(t)),
            null,
            2
          )
        }
      ]
    }
    const m = /^zenium:\/\/tab\/([^/]+)\/text$/.exec(uri)
    if (m) {
      const tab = this.browser.tabs.tab(m[1])
      if (!tab || this.browser.tabs.isPrivate(tab))
        throw new RpcError(-32002, `Unknown tab ${m[1]}`)
      const view = await this.prepare(s, tab.id, { activate: false })
      const result = (await this.evalPage(view, pageCall('text', 100_000))) as {
        title: string
        text: string
      }
      return [{ uri, mimeType: 'text/plain', text: `${result.title}\n\n${result.text}` }]
    }
    throw new RpcError(-32002, `Unknown resource ${uri}`)
  }

  instructions(session: McpSession): string {
    const s = this.sessions.get(session.id)
    return agentInstructions(s?.mode ?? this.settings.defaultMode, this.settings.allowScripts)
  }

  private requireApproved(session: McpSession): AgentSession {
    const s = this.sessions.get(session.id)
    if (!s || !s.approved)
      throw new RpcError(UNAUTHORIZED, 'This agent has not been allowed to control the browser')
    return s
  }

  // ---------------------------------------------------------------------------
  // Tabs: ownership, modes, page access (used by the tools)
  // ---------------------------------------------------------------------------

  /** The synced window agents work in (never a private or blank window). */
  agentWindow(): ZenWindow {
    const focused = this.browser.focusedWindow()
    if (focused.kind === 'synced') return focused
    const synced = this.browser.allWindows().find((w) => w.kind === 'synced')
    return synced ?? this.browser.createWindow({ kind: 'synced' })
  }

  /** Tabs an agent may see: everything except private windows' tabs. */
  visibleTabs(s: AgentSession): Tab[] {
    void s
    const m = this.browser.state.model
    return Object.values(m.tabs).filter((t) => !this.browser.tabs.isPrivate(t))
  }

  tabJson(t: Tab): Record<string, unknown> {
    const driver = this.driver(t.id)
    const space = t.spaceId
      ? this.browser.state.model.spaces.find((sp) => sp.id === t.spaceId)
      : null
    return {
      id: t.id,
      title: t.customTitle ?? t.title,
      url: t.url,
      space: space ? { id: space.id, name: space.name } : null,
      essential: t.essential,
      pinned: t.pinned,
      loaded: !t.discarded,
      loading: t.loading,
      agent: driver ? { id: driver.id, name: driver.name } : null
    }
  }

  statusJson(s: AgentSession): Record<string, unknown> {
    const m = this.browser.state.model
    return {
      you: this.info(s),
      agents: this.list(),
      server: { url: this.status.url, running: this.status.running },
      spaces: m.spaces.map((sp) => ({
        id: sp.id,
        name: sp.name,
        icon: sp.icon,
        tabs: sp.tabIds.length,
        active: sp.id === this.agentWindow().activeSpaceId
      })),
      tabs: this.visibleTabs(s).map((t) => this.tabJson(t))
    }
  }

  /**
   * Make `tabId` this agent's tab (fails when another agent drives it) and remember it as the
   * current one.
   */
  claim(s: AgentSession, tabId: string): Tab {
    const tab = this.browser.tabs.tab(tabId)
    if (!tab || this.browser.tabs.isPrivate(tab)) throw new RpcError(-32002, `Unknown tab ${tabId}`)
    const other = this.driver(tabId)
    if (other && other.id !== s.id) {
      throw new RpcError(
        UNAUTHORIZED,
        `Tab ${tabId} is being driven by agent "${other.name}" – use a different tab or ask the user to release it`
      )
    }
    if (!s.tabIds.has(tabId)) {
      s.tabIds.add(tabId)
      this.browser.tabs.view(tabId)?.setBackgroundThrottling?.(false)
    }
    s.currentTabId = tabId
    this.browser.state.commitVolatile()
    return tab
  }

  release(s: AgentSession, tabId: string, commit = true): void {
    if (!s.tabIds.delete(tabId)) return
    s.cursors.delete(tabId)
    if (s.currentTabId === tabId) s.currentTabId = firstOf(s.tabIds)
    const view = this.browser.tabs.view(tabId)
    if (view) {
      view.setBackgroundThrottling?.(true)
      void this.evalPage(
        view,
        pageCall('cursor', { id: s.id, name: s.name, color: s.color, x: 0, y: 0, action: 'hide' })
      ).catch(() => undefined)
    }
    if (commit) this.browser.state.commitVolatile()
  }

  /** The tab a page tool acts on: an explicit `tabId` (claimed on the way) or the current one. */
  resolveTab(s: AgentSession, tabId: unknown): Tab {
    if (typeof tabId === 'string' && tabId) return this.claim(s, tabId)
    if (s.currentTabId) {
      const tab = this.browser.tabs.tab(s.currentTabId)
      if (tab) return tab
      s.currentTabId = firstOf(s.tabIds)
    }
    throw new RpcError(
      -32002,
      'No current tab – open one with browser_tabs {"action":"new","url":…} or pick one with {"action":"select","tabId":…}'
    )
  }

  /**
   * Get the tab's live page ready for an action: load it if it was unloaded, wake it if the
   * governor froze it and, in foreground mode, bring it in front of the user.
   */
  async prepare(
    s: AgentSession,
    tabId: string,
    opts: { activate?: boolean } = {}
  ): Promise<TabView> {
    const tabs = this.browser.tabs
    const tab = tabs.tab(tabId)
    if (!tab) throw new RpcError(-32002, `Tab ${tabId} is gone`)
    const win = tabs.windowFor(tabId)
    const activate = opts.activate ?? s.mode === 'foreground'
    if (activate) {
      const space = win.activeSpace()
      const shown =
        win.activeSpaceId === (tab.spaceId ?? win.activeSpaceId) &&
        win.selectedTabIn(space) === tabId
      if (!shown) tabs.activateTab(tabId, win)
    }
    let view = tabs.view(tabId)
    if (!view) {
      view = tabs.ensureLoaded(tabId, win)
      if (!view) throw new RpcError(-32002, `Tab ${tabId} could not be loaded`)
      await this.waitForLoad(tabId, 15_000)
    }
    if (tab.frozen) await this.browser.governor.thaw(tabId, true)
    view.setBackgroundThrottling?.(false)
    return view
  }

  /** Wait until the tab's main frame finished loading (or the timeout passed). */
  async waitForLoad(tabId: string, timeoutMs: number): Promise<boolean> {
    const started = Date.now()
    // Navigation starts asynchronously: give `loading` a moment to flip on before we look at it.
    await sleep(120)
    for (;;) {
      const tab = this.browser.tabs.tab(tabId)
      const view = this.browser.tabs.view(tabId)
      if (!tab || !view || view.isDestroyed()) return false
      if (!tab.loading) {
        const ready = await this.evalPage(view, 'document.readyState').catch(() => 'complete')
        if (ready !== 'loading') {
          await sleep(150)
          return true
        }
      }
      if (Date.now() - started > timeoutMs) return false
      await sleep(100)
    }
  }

  evalPage(view: TabView, code: string): Promise<unknown> {
    return view.executeIsolatedJavaScript
      ? view.executeIsolatedJavaScript(code)
      : view.executeJavaScript(code)
  }

  /** Move (or click with) the agent's cursor in the page and remember where it is. */
  async cursor(
    s: AgentSession,
    tabId: string,
    view: TabView,
    x: number,
    y: number,
    action: PageCursorOptions['action']
  ): Promise<void> {
    s.cursors.set(tabId, { x, y })
    if (!this.settings.showCursor) return
    await this.evalPage(
      view,
      pageCall('cursor', { id: s.id, name: s.name, color: s.color, x, y, action })
    ).catch(() => undefined)
  }

  cursorPosition(s: AgentSession, tabId: string): { x: number; y: number } | null {
    return s.cursors.get(tabId) ?? null
  }
}

// ---------------------------------------------------------------------------

function endpointUrl(host: string, port: number): string {
  const h = host.includes(':') ? `[${host}]` : host
  return `http://${h}:${port}/mcp`
}

function portOf(url: string | null): number | null {
  if (!url) return null
  try {
    return Number(new URL(url).port) || null
  } catch {
    return null
  }
}

function firstOf(set: Set<string>): string | null {
  for (const v of set) return v
  return null
}

function describeRemote(address: string): string {
  if (!address || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1')
    return 'this computer'
  return address.replace(/^::ffff:/, '')
}
