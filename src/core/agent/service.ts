import type {
  AgentInfo,
  AgentMode,
  AgentServerStatus,
  AgentSettings,
  Folder,
  Space,
  Tab
} from '../../shared/types'
import { emptyAgentServerStatus } from '../../shared/defaults'
import type { Browser } from '../browser'
import {
  createFolder,
  createSpace,
  folderTabs,
  nextFolderColor,
  regularTabs,
  sectionIndexOf
} from '../model'
import type { AgentTransport, TabView } from '../platform'
import type { ZenWindow } from '../window'
import {
  StreamableHttp,
  type AgentHttpRequest,
  type AgentHttpResponse,
  type SessionInit,
  type SessionStore
} from './http'
import { TabFrames } from './frames'
import { RpcError, UNAUTHORIZED } from './jsonrpc'
import { pageCall, pageDispose, type PageCursorOptions } from './page'
import {
  McpProtocol,
  cleanName,
  newSession,
  type ClientInfo,
  type McpHandlers,
  type McpSession,
  type ResourceContents,
  type ResourceDefinition,
  type ToolDefinition,
  type ToolResult
} from './protocol'
import {
  AGENT_TOOLS,
  SCRIPTING_DISABLED,
  acceptedArgs,
  agentInstructions,
  type ToolContext
} from './tools'
import { FOREGROUND_LEASE_MS, randomToken, sleep, textError, titleOf } from './util'

export { FOREGROUND_LEASE_MS, titleOf }

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
/** How long a requested navigation may take to report that it has started (see `waitForLoad`). */
const NAVIGATION_START_GRACE_MS = 1500
const SERVER_NAME = 'zenium'
/** Endpoint + token, read by the `zenium --mcp` shim (see main/agent/shim.ts). */
const AGENT_FILE = 'agent.json'
/** The shared space agents' home groups live in, made once on demand. */
export const AGENTS_SPACE_NAME = 'Agents'
const AGENTS_SPACE_ICON = '🤖'
const GROUP_ICON = '🤖'

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
  /** Tab groups (folders) the session owns; a tab is the session's when it sits in one of them. */
  readonly groupIds: Set<string>
  /** The group `browser_tabs new` uses without a groupId; made on first use, re-made when gone. */
  homeGroupId: string | null
  /** One-line notices about things done to the session's tabs, prepended to its next result. */
  readonly notices: string[]
  /** Serial queue: one tool call at a time per session (other sessions run concurrently). */
  queue: Promise<void>
  /** Last cursor position per tab, so the cursor reappears where it was after a navigation. */
  readonly cursors: Map<string, { x: number; y: number }>
  /** Per tab: which frame each ref came from and the frame tree of the last snapshot. */
  readonly frames: Map<string, TabFrames>
}

interface StoredEndpoint {
  token: string
  port?: number
  url?: string | null
  running?: boolean
}

/** What a session last saw of its own tabs and groups: the baseline notices are computed from. */
interface Memo {
  tabs: Map<string, { groupId: string; title: string }>
  groups: Map<string, string>
}

/** Per tool call, reset when the call starts (calls of one session never overlap). */
interface CallState {
  /** Lines the result carries above the tool's own text (the foreground degrade, for one). */
  notes: string[]
  /** Foreground mode was asked for but another agent holds the screen: acted in background. */
  degraded: boolean
}

/** A group whose owner session is gone: kept for another session to adopt, never auto-closed. */
interface Orphan {
  ownerName: string
  endedAt: number
}

interface Lease {
  sessionId: string
  at: number
}

/** Who a tab belongs to, as listings and errors describe it. */
export type Owner =
  | { kind: 'you' }
  | { kind: 'agent'; session: AgentSession }
  | { kind: 'orphaned'; groupId: string; was: string | null }
  | { kind: 'user' }

/**
 * The browser side of the MCP server: sessions (one per agent), which groups and tabs each one
 * owns, foreground vs background behaviour and the screen lease, notices, the visible cursor,
 * approval of new agents, and the server lifecycle. The wire protocol lives in `protocol.ts` /
 * `http.ts`, the tools in `tools.ts`.
 *
 * Ownership is structural: a session owns the tab groups (Zen folders) it created or adopted,
 * and a tab belongs to the session whose group holds it. There is no per-session current tab –
 * every page tool names its tab – and nothing an agent does can touch a tab another live agent
 * owns.
 */
export class AgentService implements SessionStore, McpHandlers {
  readonly protocol: McpProtocol
  private readonly http: StreamableHttp
  private readonly transport: AgentTransport | null
  private readonly sessions = new Map<string, AgentSession>()
  private readonly sessionlessIds = new Map<string, string>()
  private readonly pendingApprovals = new Map<string, Promise<boolean>>()
  private readonly memos = new Map<string, Memo>()
  private readonly callStates = new Map<string, CallState>()
  private readonly orphans = new Map<string, Orphan>()
  private readonly leases = new Map<string, Lease>()
  /** Spaces agents made for themselves (`zen_groups create {space: "own"}`, `zen_spaces create`). */
  private readonly agentSpaceIds = new Set<string>()
  private status: AgentServerStatus = emptyAgentServerStatus()
  private token = ''
  private applying: Promise<void> = Promise.resolve()
  /**
   * Every write of `agent.json` is chained here, one after the other. The hosts' writes are
   * atomic (a temp file renamed into place; Kotlin's storage thread) but not ordered against
   * each other, and a first run issues two in a row: the mint's `{ token, running: false }` and,
   * once the server is bound, `storeEndpoint`'s full document. Landing the mint's last left the
   * file at `running: false` while the server was up, and the `zen --mcp` shim, which reads it,
   * refused to connect until the next start.
   */
  private writing: Promise<void> = Promise.resolve()
  private sweeper: ReturnType<typeof setInterval> | null = null
  private started = false
  /** The lease's clock; tests replace it to age a lease without waiting. */
  clock: () => number = () => Date.now()

  constructor(readonly browser: Browser) {
    this.transport = browser.platform.createAgentTransport?.(browser) ?? null
    this.protocol = new McpProtocol(this, {
      name: SERVER_NAME,
      title: 'Zenium',
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
    await this.writing
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
      const raw = this.browser.platform.io.readSync(AGENT_FILE)
      const stored = raw ? (JSON.parse(raw) as StoredEndpoint) : null
      if (stored && typeof stored.token === 'string' && stored.token.length >= 32)
        return stored.token
    } catch {
      /* corrupt file: mint a new token */
    }
    const token = randomToken()
    this.writeEndpointFile(JSON.stringify({ token, running: false }))
    return token
  }

  private storeEndpoint(port: number | null): void {
    const data: StoredEndpoint = {
      token: this.token,
      running: port !== null,
      port: port ?? undefined,
      url: port ? endpointUrl('127.0.0.1', port) : null
    }
    this.writeEndpointFile(JSON.stringify(data, null, 2))
  }

  /** Queue a write of `agent.json` behind the ones before it (see {@link writing}). */
  private writeEndpointFile(text: string): void {
    this.writing = this.writing
      .then(() => this.browser.platform.io.write(AGENT_FILE, text))
      .catch((error: unknown) => {
        console.warn(`[zenium] ${AGENT_FILE} not written:`, error)
      })
  }

  regenerateToken(): string {
    this.token = randomToken()
    this.status = { ...this.status, token: this.token }
    this.storeEndpoint(this.status.running ? portOf(this.status.url) : null)
    this.browser.state.commitVolatile()
    return this.token
  }

  /** The one place a presented token is checked (per-agent tokens will hang off it later). */
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
      tabIds: this.ownedTabs(s).map((t) => t.id),
      groupIds: [...s.groupIds],
      pending: s.pending,
      calls: s.calls
    }
  }

  /** The live agent whose group holds `tabId`, if any. */
  driver(tabId: string): AgentSession | undefined {
    const tab = this.browser.tabs.tab(tabId)
    return tab ? this.ownerOf(tab) : undefined
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

  /** The user took a tab back (the badge, Settings): it leaves the agent's group and is theirs. */
  releaseTab(tabId: string): void {
    const tab = this.browser.tabs.tab(tabId)
    const s = tab ? this.ownerOf(tab) : undefined
    if (!tab || !s) return
    const group = tab.folderId ? this.browser.state.model.folders[tab.folderId] : undefined
    s.notices.push(
      `Notice: tab ${tab.id} ${JSON.stringify(titleOf(tab))} was released by the user – it left your group ${JSON.stringify(group?.name ?? '')} and is theirs now; pass allowForeign: true if they ask you to work on it again.`
    )
    this.memo(s).tabs.delete(tab.id)
    this.browser.tabs.moveToFolder(tab.id, null)
    this.detach(s, tab.id)
    this.browser.state.commitVolatile()
  }

  forget(name: string): void {
    const s = this.settings
    s.approvedNames = s.approvedNames.filter((n) => n !== name)
    this.browser.state.commit()
  }

  /** A tab is gone (closed by anyone): drop what every session kept about its page. */
  onTabRemoved(tabId: string): void {
    for (const s of this.sessions.values()) {
      s.cursors.delete(tabId)
      s.frames.delete(tabId)
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
      groupIds: new Set(),
      homeGroupId: null,
      notices: [],
      queue: Promise.resolve(),
      cursors: new Map(),
      frames: new Map()
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

  /**
   * The session ends (DELETE, idle sweep, Settings → Disconnect): its groups stay with their
   * tabs – results are never destroyed under the user – and become orphaned, for another
   * session to adopt.
   */
  close(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    for (const t of this.ownedTabs(s)) this.detach(s, t.id)
    const now = Date.now()
    for (const groupId of s.groupIds)
      if (this.browser.state.model.folders[groupId])
        this.orphans.set(groupId, { ownerName: s.name, endedAt: now })
    this.sessions.delete(id)
    this.memos.delete(id)
    this.callStates.delete(id)
    for (const [win, lease] of this.leases) if (lease.sessionId === id) this.leases.delete(win)
    for (const [key, sid] of this.sessionlessIds) if (sid === id) this.sessionlessIds.delete(key)
    this.browser.state.commitVolatile()
  }

  /** `zen_session end`: the session's own way out, optionally taking its groups with it. */
  endSession(s: AgentSession, closeTabs: boolean): { groups: number; tabs: number } {
    const groups = this.groupsOf(s)
    const tabs = this.ownedTabs(s).length
    if (closeTabs) for (const g of groups) this.browser.deleteFolder(g.id, false)
    this.close(s.id)
    return { groups: groups.length, tabs }
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
          detail: `An AI agent (${s.name}${s.version ? ' ' + s.version : ''}) is connecting ${where} through Zenium's MCP server. Once allowed it can open tabs, read pages and click and type in them. You can disconnect it at any time in Settings → AI Agents.`,
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

  callTool(session: McpSession, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const s = this.requireApproved(session)
    const tool = AGENT_TOOLS.find((t) => t.definition.name === name)
    if (!tool) return Promise.resolve(textError(`Unknown tool ${name}`))
    if (tool.scripting && !this.settings.allowScripts)
      return Promise.resolve(textError(SCRIPTING_DISABLED))
    s.calls++
    s.lastActiveAt = Date.now()
    return this.enqueue(s, async () => {
      this.reconcile(s)
      const state = this.beginCall(s)
      const ctx: ToolContext = { browser: this.browser, agents: this, session: s }
      let result: ToolResult
      try {
        result = withUnknownArgsNote(tool.definition, args, await tool.run(ctx, args))
      } catch (error) {
        result =
          error instanceof RpcError
            ? textError(error.message)
            : textError((error as Error).message || String(error))
      } finally {
        // A background agent (or a foreground one that had to act in the background) may have
        // focused one of its hidden pages; hand keyboard focus back to what the user looks at.
        if (s.mode === 'background' || state.degraded) this.restoreUserFocus()
        this.remember(s)
        this.browser.state.commitVolatile()
      }
      return this.decorate(s, state, result)
    })
  }

  /**
   * One tool call at a time per session: a pipelining client's second call waits for the first
   * (they share the session's frame bookkeeping and cursor), while other sessions' calls run
   * alongside – there is no global lock.
   */
  private enqueue<T>(s: AgentSession, fn: () => Promise<T>): Promise<T> {
    const run = s.queue.then(fn)
    s.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private beginCall(s: AgentSession): CallState {
    const state: CallState = { notes: [], degraded: false }
    this.callStates.set(s.id, state)
    return state
  }

  private callState(s: AgentSession): CallState {
    return this.callStates.get(s.id) ?? this.beginCall(s)
  }

  /** Whether the running call had to act in the background although the agent is in foreground mode. */
  degraded(s: AgentSession): boolean {
    return this.callStates.get(s.id)?.degraded ?? false
  }

  /** Queued notices and the call's notes go above the tool's own text, then the queue drains. */
  private decorate(s: AgentSession, state: CallState, result: ToolResult): ToolResult {
    const lines = [...s.notices.splice(0), ...state.notes]
    if (!lines.length) return result
    const content = [...result.content]
    const i = content.findIndex((c) => c.type === 'text')
    const head = lines.join('\n')
    if (i === -1) content.unshift({ type: 'text', text: head })
    else content[i] = { type: 'text', text: `${head}\n\n${(content[i] as { text: string }).text}` }
    return { ...result, content }
  }

  private restoreUserFocus(): void {
    const win = this.browser.focusedWindow()
    const active = this.browser.tabs.activeTabFor(win)
    const view = active ? this.browser.tabs.view(active.id) : undefined
    if (view && view.isVisible()) view.focus()
  }

  listResources(session: McpSession): ResourceDefinition[] {
    void session
    return [
      {
        uri: 'zenium://status',
        name: 'status',
        title: 'Browser status',
        description:
          'You, your groups and tabs, the other agents, the spaces and the server, as JSON',
        mimeType: 'application/json'
      },
      {
        uri: 'zenium://tabs',
        name: 'tabs',
        title: 'Your tabs',
        description:
          'The tabs in your groups, as JSON. zenium://tabs?scope=all lists every tab agents may see, with its owner.',
        mimeType: 'application/json'
      }
    ]
  }

  readResource(session: McpSession, uri: string): Promise<ResourceContents[]> {
    const s = this.requireApproved(session)
    return this.enqueue(s, async () => {
      this.reconcile(s)
      this.beginCall(s)
      try {
        return await this.readResourceNow(s, uri)
      } finally {
        this.remember(s)
      }
    })
  }

  private async readResourceNow(s: AgentSession, uri: string): Promise<ResourceContents[]> {
    const [path, query] = splitQuery(uri)
    if (path === 'zenium://status') {
      return [
        { uri, mimeType: 'application/json', text: JSON.stringify(this.statusJson(s), null, 2) }
      ]
    }
    if (path === 'zenium://tabs') {
      const all = query.get('scope') === 'all'
      const tabs = all ? this.sidebarOrder(this.visibleTabs()) : this.ownedTabs(s)
      return [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(
            tabs.map((t) => this.tabJson(s, t)),
            null,
            2
          )
        }
      ]
    }
    const m = /^zenium:\/\/tab\/([^/]+)\/text$/.exec(path)
    if (m) {
      const tab = this.resolveTab(s, m[1], isTruthy(query.get('allowForeign')))
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
    const others = [...this.sessions.values()].filter((o) => o.approved && o.id !== session.id)
    return agentInstructions(
      s?.mode ?? this.settings.defaultMode,
      this.settings.allowScripts,
      others.length
    )
  }

  private requireApproved(session: McpSession): AgentSession {
    const s = this.sessions.get(session.id)
    if (!s || !s.approved)
      throw new RpcError(UNAUTHORIZED, 'This agent has not been allowed to control the browser')
    return s
  }

  // ---------------------------------------------------------------------------
  // Groups and ownership
  // ---------------------------------------------------------------------------

  /** The synced window agents work in (never a private or blank window). */
  agentWindow(): ZenWindow {
    const focused = this.browser.focusedWindow()
    if (focused.kind === 'synced') return focused
    const synced = this.browser.allWindows().find((w) => w.kind === 'synced')
    return synced ?? this.browser.createWindow({ kind: 'synced' })
  }

  /** The shared "Agents" space, made once on demand; never shown to the user by making it. */
  agentsSpace(): Space {
    const m = this.browser.state.model
    const found = this.findAgentsSpace()
    if (found) return found
    const win = this.agentWindow()
    const space = createSpace(AGENTS_SPACE_NAME, AGENTS_SPACE_ICON, win.activeSpace().containerId)
    m.spaces.push(space)
    this.browser.state.commit()
    return space
  }

  private findAgentsSpace(): Space | undefined {
    return this.browser.state.model.spaces.find((sp) => sp.name === AGENTS_SPACE_NAME)
  }

  /** The session's home group, made (or re-made after the user removed it) on first use. */
  homeGroup(s: AgentSession): Folder {
    const m = this.browser.state.model
    const existing = s.homeGroupId ? m.folders[s.homeGroupId] : undefined
    if (existing && s.groupIds.has(existing.id)) return existing
    const folder = this.createGroup(s, homeGroupName(s), this.agentsSpace().id)
    s.homeGroupId = folder.id
    return folder
  }

  /** A new group of the session's in `spaceId`; owned from the same tick it exists in. */
  createGroup(s: AgentSession, name: string, spaceId: string): Folder {
    const m = this.browser.state.model
    const folder = createFolder(m, spaceId, name, GROUP_ICON, nextFolderColor(m, spaceId))
    s.groupIds.add(folder.id)
    this.memo(s).groups.set(folder.id, folder.name)
    this.browser.state.commit()
    return folder
  }

  /**
   * A space of the agent's own (`zen_groups create {space: "own"}`, `zen_spaces create`), named
   * after the agent unless told otherwise; the user's window is not switched to it.
   */
  createOwnSpace(s: AgentSession, opts: { name?: string; icon?: string } = {}): Space {
    const m = this.browser.state.model
    const taken = new Set(m.spaces.map((sp) => sp.name))
    let name = opts.name?.trim() || s.name
    if (taken.has(name)) name = `${name} · ${s.id.slice(-4)}`
    const space = createSpace(
      name,
      opts.icon?.trim() || AGENTS_SPACE_ICON,
      this.agentWindow().activeSpace().containerId
    )
    m.spaces.push(space)
    this.agentSpaceIds.add(space.id)
    this.browser.state.commit()
    return space
  }

  /** Whether the space is agents' territory: the shared Agents space or one an agent made. */
  isAgentSpace(spaceId: string): boolean {
    return this.agentSpaceIds.has(spaceId) || this.findAgentsSpace()?.id === spaceId
  }

  /** The session's first group in the space, made when it has none there. */
  groupIn(s: AgentSession, spaceId: string): Folder {
    const agents = this.findAgentsSpace()
    if (agents && spaceId === agents.id) return this.homeGroup(s)
    const existing = this.groupsOf(s).find((g) => g.spaceId === spaceId)
    return existing ?? this.createGroup(s, homeGroupName(s), spaceId)
  }

  renameGroup(s: AgentSession, folder: Folder, name: string): void {
    void s
    this.browser.updateFolder(folder.id, { name: name.trim() || folder.name })
  }

  /** Close a group of the session's: its tabs go, then the folder. */
  closeGroup(s: AgentSession, folder: Folder): number {
    const tabs = folderTabs(this.browser.state.model, folder.id)
    for (const t of tabs) this.detach(s, t.id)
    this.browser.deleteFolder(folder.id, false)
    s.groupIds.delete(folder.id)
    if (s.homeGroupId === folder.id) s.homeGroupId = null
    this.memo(s).groups.delete(folder.id)
    return tabs.length
  }

  /** Take over an orphaned group (its owner session is gone) with every tab in it. */
  adopt(s: AgentSession, folder: Folder): Orphan | null {
    const was = this.orphans.get(folder.id) ?? null
    this.orphans.delete(folder.id)
    s.groupIds.add(folder.id)
    this.memo(s).groups.set(folder.id, folder.name)
    if (!s.homeGroupId) s.homeGroupId = folder.id
    this.browser.state.commitVolatile()
    return was
  }

  /** Rename the agent (`zen_session rename`): the label of its cursor, badges and home group. */
  rename(s: AgentSession, name: string): void {
    const before = s.name
    s.name = cleanName(name)
    const home = s.homeGroupId ? this.browser.state.model.folders[s.homeGroupId] : undefined
    if (home && home.name === homeGroupName({ name: before, id: s.id }))
      this.browser.updateFolder(home.id, { name: homeGroupName(s) })
    this.browser.state.commitVolatile()
  }

  /** The session's groups, in the order of their spaces; the home group first. */
  groupsOf(s: AgentSession): Folder[] {
    const m = this.browser.state.model
    const out: Folder[] = []
    for (const sp of m.spaces)
      for (const f of Object.values(m.folders))
        if (f.spaceId === sp.id && s.groupIds.has(f.id)) out.push(f)
    for (const id of s.groupIds) {
      const f = m.folders[id]
      if (f && !out.includes(f)) out.push(f)
    }
    return out.sort((a, b) => Number(b.id === s.homeGroupId) - Number(a.id === s.homeGroupId))
  }

  /** The tabs in the session's groups, in sidebar order. */
  ownedTabs(s: AgentSession): Tab[] {
    if (!s.groupIds.size) return []
    return this.sidebarOrder(
      Object.values(this.browser.state.model.tabs).filter(
        (t) => t.folderId !== null && s.groupIds.has(t.folderId) && !this.browser.tabs.isPrivate(t)
      )
    )
  }

  /** Tabs agents may see at all: everything except private windows' tabs. */
  visibleTabs(): Tab[] {
    return Object.values(this.browser.state.model.tabs).filter(
      (t) => !this.browser.tabs.isPrivate(t)
    )
  }

  /**
   * Tabs the session may address with `allowForeign: true`: its own, the user's, and the tabs of
   * orphaned groups – never another live agent's.
   */
  foreignScope(s: AgentSession): Tab[] {
    return this.sidebarOrder(
      this.visibleTabs().filter((t) => {
        const owner = this.ownerOf(t)
        return !owner || owner.id === s.id
      })
    )
  }

  /** Sidebar order: Essentials first, then each space's tabs (pinned before regular). */
  sidebarOrder(tabs: Tab[]): Tab[] {
    const m = this.browser.state.model
    const byId = new Map(tabs.map((t) => [t.id, t]))
    const out: Tab[] = []
    const take = (id: string): void => {
      const t = byId.get(id)
      if (t) {
        out.push(t)
        byId.delete(id)
      }
    }
    for (const id of m.essentialTabIds) take(id)
    for (const sp of m.spaces) for (const id of sp.tabIds) take(id)
    for (const t of byId.values()) out.push(t)
    return out
  }

  /** The live session whose group holds the tab. */
  ownerOf(tab: Tab): AgentSession | undefined {
    if (!tab.folderId) return undefined
    return this.groupOwner(tab.folderId)
  }

  groupOwner(folderId: string): AgentSession | undefined {
    for (const s of this.sessions.values()) if (s.groupIds.has(folderId)) return s
    return undefined
  }

  /**
   * An agent group without a live owner: made by a session that is gone, or sitting in the
   * Agents space (every folder there is an agent's by construction, so groups outlive restarts).
   */
  isOrphan(folderId: string): boolean {
    const folder = this.browser.state.model.folders[folderId]
    if (!folder) {
      this.orphans.delete(folderId)
      return false
    }
    if (this.groupOwner(folderId)) return false
    if (this.orphans.has(folderId)) return true
    const agents = this.findAgentsSpace()
    return agents !== undefined && folder.spaceId === agents.id
  }

  /** The former owner's name of an orphaned group, when known. */
  orphanWas(folderId: string): string | null {
    return this.orphans.get(folderId)?.ownerName ?? null
  }

  /** Every group that is an agent's: owned, or orphaned. */
  agentGroups(): Folder[] {
    const m = this.browser.state.model
    return Object.values(m.folders).filter(
      (f) => this.groupOwner(f.id) !== undefined || this.isOrphan(f.id)
    )
  }

  /** Who the tab belongs to, from the session's point of view. */
  owner(s: AgentSession, tab: Tab): Owner {
    const live = this.ownerOf(tab)
    if (live) return live.id === s.id ? { kind: 'you' } : { kind: 'agent', session: live }
    if (tab.folderId && this.isOrphan(tab.folderId))
      return { kind: 'orphaned', groupId: tab.folderId, was: this.orphanWas(tab.folderId) }
    return { kind: 'user' }
  }

  /** Short owner description for listings: `yours`, `owned by "B"`, `orphaned, was "B"`, null for the user's. */
  describeOwner(s: AgentSession, tab: Tab): string | null {
    const o = this.owner(s, tab)
    switch (o.kind) {
      case 'you':
        return 'yours'
      case 'agent':
        return `owned by ${JSON.stringify(o.session.name)}`
      case 'orphaned':
        return o.was ? `orphaned, was ${JSON.stringify(o.was)}` : 'orphaned'
      default:
        return null
    }
  }

  /**
   * Turn what an agent passed as `tabId` into a tab it may act on: the id or a unique prefix of
   * one, among its own tabs – or, with `allowForeign`, among every tab no other live agent owns.
   * List positions are refused: they shift whenever anyone opens or closes a tab.
   */
  resolveTab(s: AgentSession, ref: unknown, allowForeign = false): Tab {
    const own = this.ownedTabs(s)
    const yours = (): string =>
      own.length
        ? `Your tabs: ${own.map((t) => `${t.id} ${JSON.stringify(titleOf(t).slice(0, 40))}`).join(', ')}.`
        : 'You have no tabs yet – browser_tabs {"action":"new","url":"…"} opens one in your group and returns its id.'
    if (typeof ref === 'number' || (typeof ref === 'string' && /^\d+$/.test(ref.trim()))) {
      throw new RpcError(
        -32602,
        `tabId must be a tab id, not a list position (${String(ref).trim()}): positions shift whenever another agent or the user opens or closes a tab, so copy the id from browser_tabs list (a unique prefix is enough). ${yours()}`
      )
    }
    if (typeof ref !== 'string' || !ref.trim())
      throw new RpcError(
        -32602,
        `tabId must be a tab id such as "tab_3f9a…" (a unique prefix is enough). ${yours()}`
      )
    const wanted = ref.trim()
    const scope = allowForeign ? this.foreignScope(s) : own
    const exact = scope.find((t) => t.id === wanted)
    if (exact) return exact
    const prefixed = scope.filter((t) => t.id.startsWith(wanted))
    if (prefixed.length === 1) return prefixed[0]
    if (prefixed.length > 1)
      throw new RpcError(
        -32602,
        `"${wanted}" matches ${prefixed.length} of your tabs (${prefixed.map((t) => t.id).join(', ')}) – give more of the id`
      )
    // Not addressable: say why, precisely.
    const all = this.visibleTabs()
    const candidates = all.filter((t) => t.id === wanted || t.id.startsWith(wanted))
    if (candidates.length === 1) {
      const tab = candidates[0]
      const o = this.owner(s, tab)
      if (o.kind === 'agent')
        throw new RpcError(
          UNAUTHORIZED,
          `Tab ${tab.id} is owned by agent ${JSON.stringify(o.session.name)} – another live agent's tabs cannot be addressed, not even with allowForeign; browser_tabs {"action":"list","scope":"all"} only shows them. ${yours()}`
        )
      const whose =
        o.kind === 'orphaned'
          ? `it is in an orphaned agent group${o.was ? ` (was ${JSON.stringify(o.was)}'s)` : ''} – zen_groups {"action":"adopt","groupId":"${o.groupId}"} takes the group over`
          : "it is the user's"
      throw new RpcError(
        UNAUTHORIZED,
        `Tab ${tab.id} is not one of yours (${whose}). Work in your own groups; if the user asked you to act on their tab, pass allowForeign: true. ${yours()}`
      )
    }
    if (candidates.length > 1)
      throw new RpcError(
        -32602,
        `"${wanted}" matches ${candidates.length} tabs (${candidates.map((t) => t.id).join(', ')}) – give more of the id`
      )
    if (this.browser.tabs.tab(wanted))
      throw new RpcError(-32002, `Tab ${wanted} is not available to agents`)
    throw new RpcError(
      -32002,
      `Unknown tab "${wanted}" – it may have been closed. ${yours()} (browser_tabs {"action":"list"} shows your tabs, {"action":"list","scope":"all"} every tab.)`
    )
  }

  /**
   * A group the agent names: by id, unique id prefix or (case-insensitive) name among its own
   * groups, or "home". With `allowForeign` orphaned groups and the user's folders count too;
   * another live agent's groups never do.
   */
  resolveGroup(s: AgentSession, ref: unknown, allowForeign = false): Folder {
    const own = this.groupsOf(s)
    const yours = (): string =>
      own.length
        ? `Your groups: ${own.map((g) => `${g.id} ${JSON.stringify(g.name)}`).join(', ')}.`
        : 'You have no groups yet – browser_tabs {"action":"new"} makes your home group, zen_groups {"action":"create"} another.'
    if (typeof ref !== 'string' || !ref.trim())
      throw new RpcError(-32602, `groupId must be a group id from zen_groups list. ${yours()}`)
    const wanted = ref.trim()
    if (wanted.toLowerCase() === 'home') return this.homeGroup(s)
    const m = this.browser.state.model
    const scope = allowForeign
      ? Object.values(m.folders).filter((f) => {
          const o = this.groupOwner(f.id)
          return !o || o.id === s.id
        })
      : own
    const exact = scope.find((f) => f.id === wanted)
    if (exact) return exact
    const prefixed = scope.filter((f) => f.id.startsWith(wanted))
    if (prefixed.length === 1) return prefixed[0]
    if (prefixed.length > 1)
      throw new RpcError(
        -32602,
        `"${wanted}" matches ${prefixed.length} groups (${prefixed.map((f) => f.id).join(', ')}) – give more of the id`
      )
    const named = scope.filter((f) => f.name.toLowerCase() === wanted.toLowerCase())
    if (named.length === 1) return named[0]
    if (named.length > 1)
      throw new RpcError(
        -32602,
        `${named.length} groups are called ${JSON.stringify(wanted)} (${named.map((f) => f.id).join(', ')}) – use the id`
      )
    const folder =
      m.folders[wanted] ?? Object.values(m.folders).find((f) => f.id.startsWith(wanted))
    if (folder) {
      const o = this.groupOwner(folder.id)
      if (o && o.id !== s.id)
        throw new RpcError(
          UNAUTHORIZED,
          `Group ${folder.id} ${JSON.stringify(folder.name)} belongs to agent ${JSON.stringify(o.name)} – another live agent's groups cannot be used. ${yours()}`
        )
      if (this.isOrphan(folder.id))
        throw new RpcError(
          UNAUTHORIZED,
          `Group ${folder.id} ${JSON.stringify(folder.name)} is orphaned (its agent${this.orphanWas(folder.id) ? ` ${JSON.stringify(this.orphanWas(folder.id))}` : ''} is gone) – zen_groups {"action":"adopt","groupId":"${folder.id}"} takes it over. ${yours()}`
        )
      throw new RpcError(
        UNAUTHORIZED,
        `Group ${folder.id} ${JSON.stringify(folder.name)} is the user's folder, not one of your groups. ${yours()}`
      )
    }
    throw new RpcError(-32002, `Unknown group "${wanted}" – it may have been removed. ${yours()}`)
  }

  /**
   * The orphaned group an agent wants to adopt: by id, unique id prefix or name among the groups
   * without a live owner. Every other kind of group is refused with the reason.
   */
  resolveOrphan(s: AgentSession, ref: unknown): Folder {
    const m = this.browser.state.model
    const orphans = this.agentGroups().filter((g) => this.isOrphan(g.id))
    const list = (): string =>
      orphans.length
        ? `Orphaned groups: ${orphans.map((g) => `${g.id} ${JSON.stringify(g.name)}${this.orphanWas(g.id) ? ` (was ${JSON.stringify(this.orphanWas(g.id))}'s)` : ''}`).join(', ')}.`
        : 'There are no orphaned groups right now (zen_groups {"action":"list","scope":"all"} shows every agent group).'
    if (typeof ref !== 'string' || !ref.trim())
      throw new RpcError(-32602, `adopt needs groupId: the orphaned group to take over. ${list()}`)
    const wanted = ref.trim()
    const matches = (f: Folder): boolean =>
      f.id === wanted || f.id.startsWith(wanted) || f.name.toLowerCase() === wanted.toLowerCase()
    const found = orphans.filter(matches)
    if (found.length === 1) return found[0]
    if (found.length > 1)
      throw new RpcError(
        -32602,
        `"${wanted}" matches ${found.length} orphaned groups (${found.map((f) => f.id).join(', ')}) – give the id`
      )
    const folder = Object.values(m.folders).find(matches)
    if (!folder) throw new RpcError(-32002, `Unknown group "${wanted}". ${list()}`)
    const o = this.groupOwner(folder.id)
    if (o && o.id === s.id)
      throw new RpcError(
        -32602,
        `Group ${folder.id} ${JSON.stringify(folder.name)} is already yours.`
      )
    if (o)
      throw new RpcError(
        UNAUTHORIZED,
        `Group ${folder.id} ${JSON.stringify(folder.name)} belongs to agent ${JSON.stringify(o.name)}, which is still connected – only orphaned groups can be adopted. ${list()}`
      )
    throw new RpcError(
      UNAUTHORIZED,
      `Group ${folder.id} ${JSON.stringify(folder.name)} is the user's folder, not an orphaned agent group – only groups whose agent is gone can be adopted. ${list()}`
    )
  }

  /**
   * Open a tab in one of the session's groups: at the end of the group, in its space, owned from
   * the tick it exists in. `active` brings it in front of the user (the caller decided that
   * with the foreground lease).
   */
  openTab(
    s: AgentSession,
    group: Folder,
    opts: { url?: string; active: boolean },
    win: ZenWindow = this.agentWindow()
  ): Tab {
    const m = this.browser.state.model
    const members = folderTabs(m, group.id)
    const last = members[members.length - 1]
    const tab = this.browser.tabs.createTab(
      {
        url: opts.url,
        spaceId: group.spaceId,
        folderId: group.id,
        afterTabId: last?.id,
        active: opts.active,
        load: false
      },
      win
    )
    // Known to the session from this tick on: a notice never reports its own new tab.
    this.memo(s).tabs.set(tab.id, { groupId: group.id, title: titleOf(tab) })
    return tab
  }

  /** Move a tab of the session's into one of its groups (across spaces when needed), optionally at a 1-based slot. */
  moveToGroup(s: AgentSession, tab: Tab, group: Folder, index?: number): void {
    void s
    const m = this.browser.state.model
    const tabs = this.browser.tabs
    const win = this.agentWindow()
    // Joining a group whose tabs the user closed must not resurrect the pages it kept.
    if (group.savedTabs) group.savedTabs = null
    if (tab.spaceId !== group.spaceId)
      tabs.moveTab(
        tab.id,
        { spaceId: group.spaceId, section: 'regular', index: Number.MAX_SAFE_INTEGER },
        win
      )
    if (tab.folderId !== group.id) tabs.moveToFolder(tab.id, group.id)
    if (index !== undefined) {
      const others = folderTabs(m, group.id).filter((t) => t.id !== tab.id)
      const slot = Math.max(1, Math.round(index))
      const space = m.spaces.find((sp) => sp.id === group.spaceId)
      if (!space) return
      const regular = regularTabs(m, space).filter((t) => t.id !== tab.id)
      const at =
        slot <= others.length
          ? regular.indexOf(others[slot - 1])
          : others.length
            ? regular.indexOf(others[others.length - 1]) + 1
            : sectionIndexOf(m, tab)
      tabs.moveTab(tab.id, { section: 'regular', index: Math.max(0, at) }, win)
    }
    this.browser.state.commit()
  }

  // ---------------------------------------------------------------------------
  // Notices: what happened to the session's tabs and groups since its last call
  // ---------------------------------------------------------------------------

  private memo(s: AgentSession): Memo {
    let memo = this.memos.get(s.id)
    if (!memo) {
      memo = { tabs: new Map(), groups: new Map() }
      this.memos.set(s.id, memo)
    }
    return memo
  }

  /**
   * Compare what the session last saw with the model: tabs gone were closed, tabs elsewhere were
   * moved out, groups gone were removed – by the user, since no other agent can touch a live
   * session's tabs. One notice each, queued for the next result.
   */
  private reconcile(s: AgentSession): void {
    const m = this.browser.state.model
    const memo = this.memo(s)
    const closedPerGroup = new Map<string, string[]>()
    for (const [id, known] of memo.tabs) {
      const tab = m.tabs[id]
      if (!tab) {
        const list = closedPerGroup.get(known.groupId) ?? []
        list.push(`${id} ${JSON.stringify(known.title)}`)
        closedPerGroup.set(known.groupId, list)
        memo.tabs.delete(id)
        continue
      }
      if (tab.folderId === null || !s.groupIds.has(tab.folderId)) {
        const group = memo.groups.get(known.groupId) ?? known.groupId
        const now = tab.folderId ? m.folders[tab.folderId] : undefined
        s.notices.push(
          `Notice: tab ${id} ${JSON.stringify(titleOf(tab))} was moved out of your group ${JSON.stringify(group)} by the user${now ? ` (it is in folder ${JSON.stringify(now.name)} now)` : ''} – it is not yours any more.`
        )
        memo.tabs.delete(id)
        this.detach(s, id)
      }
    }
    for (const [groupId, closed] of closedPerGroup) {
      const groupName = memo.groups.get(groupId) ?? groupId
      const left = m.folders[groupId] ? folderTabs(m, groupId).length : 0
      if (closed.length > 1 && left === 0 && m.folders[groupId])
        s.notices.push(
          `Notice: all ${closed.length} tabs of your group ${JSON.stringify(groupName)} were closed by the user (${closed.join(', ')}); the group is kept, empty.`
        )
      else for (const c of closed) s.notices.push(`Notice: tab ${c} was closed by the user.`)
    }
    for (const groupId of [...s.groupIds]) {
      if (m.folders[groupId]) continue
      const name = memo.groups.get(groupId) ?? groupId
      s.notices.push(
        `Notice: your group ${JSON.stringify(name)} (${groupId}) was removed by the user${s.homeGroupId === groupId ? ' – your next browser_tabs new makes a new home group' : ''}.`
      )
      s.groupIds.delete(groupId)
      memo.groups.delete(groupId)
      if (s.homeGroupId === groupId) s.homeGroupId = null
    }
  }

  /** Record the session's tabs and groups as they are now (after its own call changed them). */
  private remember(s: AgentSession): void {
    if (!this.sessions.has(s.id)) return
    const m = this.browser.state.model
    const memo = this.memo(s)
    memo.tabs.clear()
    for (const t of this.ownedTabs(s))
      if (t.folderId) memo.tabs.set(t.id, { groupId: t.folderId, title: titleOf(t) })
    memo.groups.clear()
    for (const id of s.groupIds) {
      const f = m.folders[id]
      if (f) memo.groups.set(id, f.name)
    }
  }

  // ---------------------------------------------------------------------------
  // Foreground lease
  // ---------------------------------------------------------------------------

  /** The session holding the window's screen, while its lease is warm. */
  leaseHolder(win: ZenWindow = this.agentWindow()): AgentSession | null {
    const lease = this.leases.get(win.id)
    if (!lease) return null
    const holder = this.sessions.get(lease.sessionId)
    if (!holder || holder.mode !== 'foreground') return null
    return this.clock() - lease.at <= FOREGROUND_LEASE_MS ? holder : null
  }

  /**
   * Whether the session may act in the foreground now: in foreground mode it takes (or renews)
   * the window's lease unless another agent holds it and acted within `FOREGROUND_LEASE_MS`; then
   * this call runs in the background and the result says so.
   */
  foreground(s: AgentSession, win: ZenWindow = this.agentWindow()): boolean {
    if (s.mode !== 'foreground') return false
    const holder = this.leaseHolder(win)
    if (holder && holder.id !== s.id) {
      const state = this.callState(s)
      const note = `foreground: another agent, ${JSON.stringify(holder.name)}, holds the screen – acted in background`
      if (!state.notes.includes(note)) state.notes.push(note)
      state.degraded = true
      return false
    }
    this.leases.set(win.id, { sessionId: s.id, at: this.clock() })
    return true
  }

  // ---------------------------------------------------------------------------
  // Page access (used by the tools)
  // ---------------------------------------------------------------------------

  tabJson(s: AgentSession, t: Tab): Record<string, unknown> {
    const m = this.browser.state.model
    const space = t.spaceId ? m.spaces.find((sp) => sp.id === t.spaceId) : null
    const folder = t.folderId ? m.folders[t.folderId] : null
    const o = this.owner(s, t)
    const win = this.agentWindow()
    return {
      id: t.id,
      title: titleOf(t),
      url: t.url,
      space: space ? { id: space.id, name: space.name } : null,
      group: folder ? { id: folder.id, name: folder.name } : null,
      essential: t.essential,
      pinned: t.pinned,
      loaded: !t.discarded,
      loading: t.loading,
      owner:
        o.kind === 'you'
          ? { kind: 'you' }
          : o.kind === 'agent'
            ? { kind: 'agent', name: o.session.name }
            : o.kind === 'orphaned'
              ? { kind: 'orphaned', was: o.was }
              : { kind: 'user' },
      usersActiveTab: this.browser.tabs.activeTabFor(win)?.id === t.id
    }
  }

  statusJson(s: AgentSession): Record<string, unknown> {
    const m = this.browser.state.model
    const win = this.agentWindow()
    const holder = this.leaseHolder(win)
    return {
      you: {
        ...this.info(s),
        holdsScreen: holder?.id === s.id,
        screenHeldBy: holder && holder.id !== s.id ? holder.name : null
      },
      groups: this.groupsOf(s).map((g) => ({
        id: g.id,
        name: g.name,
        home: g.id === s.homeGroupId,
        space: m.spaces.find((sp) => sp.id === g.spaceId)?.name ?? null,
        tabs: folderTabs(m, g.id).map((t) => ({ id: t.id, title: titleOf(t), url: t.url }))
      })),
      agents: [...this.sessions.values()]
        .filter((o) => o.id !== s.id && (o.approved || o.pending))
        .map((o) => ({ name: o.name, mode: o.mode, groups: o.groupIds.size, pending: o.pending })),
      server: { url: this.status.url, running: this.status.running },
      spaces: m.spaces.map((sp) => ({
        id: sp.id,
        name: sp.name,
        icon: sp.icon,
        tabs: sp.tabIds.length,
        active: sp.id === win.activeSpaceId
      }))
    }
  }

  /** The session is done with a page: its cursor goes, and so does the runtime it put into frames. */
  private detach(s: AgentSession, tabId: string): void {
    s.cursors.delete(tabId)
    const frames = s.frames.get(tabId)
    s.frames.delete(tabId)
    const view = this.browser.tabs.view(tabId)
    if (!view) return
    view.setBackgroundThrottling?.(true)
    void this.evalPage(view, pageDispose(s.id)).catch(() => undefined)
    for (const node of frames?.nodes ?? []) {
      if (node.id === 0) continue
      void view.executeJavaScript(pageDispose(s.id), node.id).catch(() => undefined)
    }
  }

  /**
   * Get the tab's live page ready for an action: load it if it was unloaded, wake it if the
   * governor froze it and, in foreground mode with the screen lease, bring it in front of the
   * user.
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
    const activate = opts.activate === false ? false : this.foreground(s, win)
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
      await this.waitForLoad(tabId, 15_000, { expectNavigation: true })
    }
    if (tab.frozen) await this.browser.governor.thaw(tabId, true)
    view.setBackgroundThrottling?.(false)
    return view
  }

  /**
   * Wait until the tab's main frame finished loading (or the timeout passed). With
   * `expectNavigation` a navigation was just requested: hosts report its start asynchronously –
   * Android's WebView on a slow device well after the 120 ms below – so an idle tab whose URL has
   * not changed yet is given a moment to begin before it counts as loaded, or the caller would
   * snapshot the previous page.
   */
  async waitForLoad(
    tabId: string,
    timeoutMs: number,
    opts: { expectNavigation?: boolean } = {}
  ): Promise<boolean> {
    const started = Date.now()
    const before = this.browser.tabs.tab(tabId)?.url
    const graceUntil = opts.expectNavigation ? started + NAVIGATION_START_GRACE_MS : started
    // Navigation starts asynchronously: give `loading` a moment to flip on before we look at it.
    await sleep(120)
    for (;;) {
      const tab = this.browser.tabs.tab(tabId)
      const view = this.browser.tabs.view(tabId)
      if (!tab || !view || view.isDestroyed()) return false
      if (!tab.loading) {
        if (Date.now() < graceUntil && tab.url === before) {
          await sleep(50)
          continue
        }
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

  /** What the agent knows about the frames of a tab (see `TabFrames`), created on first use. */
  frameState(s: AgentSession, tabId: string): TabFrames {
    let state = s.frames.get(tabId)
    if (!state) {
      state = new TabFrames()
      s.frames.set(tabId, state)
    }
    return state
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

/**
 * Arguments a tool does not know are ignored rather than refused (clients that validate strictly
 * would otherwise turn every synonym into a failure), but the agent is told, so a typo like
 * `selctor` does not silently do the wrong thing.
 */
export function withUnknownArgsNote(
  def: ToolDefinition,
  args: Record<string, unknown>,
  result: ToolResult
): ToolResult {
  const known = acceptedArgs(def)
  const unknown = Object.keys(args).filter((k) => !known.has(k))
  if (!unknown.length) return result
  const accepted = Object.keys(def.inputSchema.properties)
  const note = `(Ignored unknown argument${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => JSON.stringify(k)).join(', ')} – ${def.name} accepts: ${accepted.join(', ')}.)`
  const content = [...result.content]
  const i = content.findIndex((c) => c.type === 'text')
  if (i === -1) content.unshift({ type: 'text', text: note })
  else content[i] = { type: 'text', text: `${(content[i] as { text: string }).text}\n\n${note}` }
  return { ...result, content }
}

/** `<agent name> · <last 4 of the session id>`: the default name of a session's home group. */
export function homeGroupName(s: { name: string; id: string }): string {
  return `${s.name} · ${s.id.slice(-4)}`
}

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

function splitQuery(uri: string): [string, URLSearchParams] {
  const q = uri.indexOf('?')
  if (q === -1) return [uri, new URLSearchParams()]
  return [uri.slice(0, q), new URLSearchParams(uri.slice(q + 1))]
}

function isTruthy(v: string | null): boolean {
  return v !== null && /^(1|true|yes|on)$/i.test(v)
}

function describeRemote(address: string): string {
  if (!address || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1')
    return 'this computer'
  return address.replace(/^::ffff:/, '')
}
