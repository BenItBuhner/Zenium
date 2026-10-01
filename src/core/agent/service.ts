import type {
  AgentInfo,
  AgentPromptKind,
  AwayAgentInfo,
  AgentMode,
  AgentServerStatus,
  AgentSettings,
  AgentSkillStatus,
  Folder,
  PageDialog,
  PageDialogResponse,
  Space,
  Tab
} from '../../shared/types'
import { emptyAgentServerStatus, emptyAgentSkillStatus } from '../../shared/defaults'
import { isBlankTabUrl } from '../../shared/url'
import type { Browser } from '../browser'
import {
  createFolder,
  createSpace,
  folderTabs,
  nextFolderColor,
  regularTabs,
  sectionIndexOf
} from '../model'
import { describeDialog } from '../pageDialogs'
import type {
  AgentSkillsHost,
  AgentTransport,
  FileChooserAnswer,
  FileChooserRequest,
  PagePromptRequest,
  TabView
} from '../platform'
import type { AgentPermissionPrompts } from '../permissions'
import type { ZenWindow } from '../window'
import {
  StreamableHttp,
  type AgentHttpRequest,
  type AgentHttpResponse,
  type SessionInit,
  type SessionStore
} from './http'
import { ClaimStore, type AgentClaim } from './claims'
import { Diagnostics, type DiagnosticsSnapshot } from './diagnostics'
import { checkAgentName, NAME_YOURSELF } from './naming'
import { TabFrames } from './frames'
import { RpcError, UNAUTHORIZED } from './jsonrpc'
import { pageCall, pageDispose, type PageCursorOptions } from './page'
import {
  ANSWER_FROM_THIS_COMPUTER,
  downloadSpec,
  fileChooserSpec,
  permissionSpec,
  type DownloadDestination
} from './nativePrompts'
import {
  AgentPromptQueue,
  describePrompt,
  type AgentPrompt,
  type AgentPromptAnswer,
  type AgentPromptHandle,
  type AgentPromptSpec
} from './prompts'
import {
  LATEST_PROTOCOL_VERSION,
  McpProtocol,
  SUPPORTED_PROTOCOL_VERSIONS,
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
import {
  describeIdle,
  FOREGROUND_LEASE_MS,
  GHOST_IDLE_MS,
  randomToken,
  sleep,
  textError,
  titleOf
} from './util'

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

/**
 * Idle this long, a session is PARKED, not closed: its groups become orphaned and its page state
 * goes, but the record stays, so the client's next call – an hour later, after the user's lunch –
 * is answered instead of met with a 404 it may never recover from (a client that does not
 * re-initialize on 404 is dead until the user toggles the server by hand).
 */
const SESSION_IDLE_MS = 30 * 60 * 1000
const SESSIONLESS_IDLE_MS = 10 * 60 * 1000
/** A parked session nobody came back for is deleted after this long. */
const PARKED_TTL_MS = 24 * 60 * 60 * 1000
/** What a foreground call that had to stay in the background for want of the screen is told. */
const TAKE_SCREEN_HINT =
  'zen_mode {"mode":"foreground","takeScreen":true} lets your actions bring your tabs in front (only if the user wants that); zen_mode {"mode":"background"} works off screen without this note.'
/** Client identities remembered for resumed sessions (name and version by token, agent and address). */
const KNOWN_CLIENTS_MAX = 50
/** `Mcp-Session-Id` as the spec has it: visible ASCII, and a length nothing legitimate exceeds. */
const SESSION_ID_SHAPE = /^[\x21-\x7e]{1,128}$/
/** How long a requested navigation may take to report that it has started (see `waitForLoad`). */
const NAVIGATION_START_GRACE_MS = 1500
/**
 * No tool call runs longer: past this it is answered with an error and the session's queue
 * moves on, whatever the page is doing. Below the 60 s most MCP clients give a call, so the
 * agent hears why instead of a client-side timeout – and the next call is never stuck behind a
 * page that will not answer (a hung renderer, a page frozen mid-call), which used to wedge the
 * session until the browser restarted.
 */
export const CALL_DEADLINE_MS = 45_000
/** A tab whose last call ran into the deadline is probed this long before the next one acts. */
const PAGE_PROBE_MS = 3000
/** An agent's page dialog nobody answered is dismissed after this, so the page does not stay blocked. */
export const AGENT_DIALOG_TTL_MS = 2 * 60 * 1000
/**
 * How long a native prompt of an agent's tab (`AgentPromptQueue`) waits for its agent before its
 * default answer applies – the refusal for everything but a download, which is saved where
 * Downloads puts it.
 */
export const AGENT_PROMPT_TTL_MS = 2 * 60 * 1000
/** A claim with no groups left and no client for this long is forgotten. */
const EMPTY_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** What an agent may call before it has named itself (`zen_session start`). */
const UNCLAIMED_TOOLS = new Set(['zen_status', 'zen_session'])
/** The resources an agent may read before it has named itself. */
const UNCLAIMED_RESOURCES = new Set(['zenium://status', 'zenium://diagnostics'])
/** The prompt every other call gets until the agent has named itself. */
const SERVER_NAME = 'zenium'
/** Endpoint + token, read by the `zenium --mcp` shim (see main/agent/shim.ts). */
const AGENT_FILE = 'agent.json'
/**
 * How long after start the Agent Skill's once-per-update refresh waits: off the boot path (the
 * first window's paint, the session restore), yet early enough that a harness started right
 * after an update reads the new copy.
 */
const SKILL_REFRESH_DELAY_MS = 2000
/**
 * The shared space agents' home groups live in, made once on demand. Its name and icon are what
 * the user sees; the service knows the space by its mark (`Space.agent`), never by the name, so
 * a space the user calls "Agents" is theirs.
 */
export const AGENTS_SPACE_NAME = 'Agents'
export const AGENTS_SPACE_ICON = '🤖'
const GROUP_ICON = '🤖'

/**
 * Why a session let go of what it held (`AgentService.onSessionReleased`): `end` – the agent's
 * `zen_session end`; `park` – idle past the limit, the record kept for a resume; `close` – the
 * record goes (DELETE, Disconnect, the parked limit, shutdown).
 */
export type SessionReleaseReason = 'end' | 'park' | 'close'

/** One connected agent: its MCP session plus everything Zen knows about it. */
export interface AgentSession extends McpSession {
  name: string
  version: string
  color: string
  mode: AgentMode
  /**
   * The agent asked for the screen (`zen_mode {mode: "foreground", takeScreen: true}`): its
   * foreground actions may bring its tab in front of the user – switching the user's space and
   * active tab. Without it (and without the user's foreground default, see `mayTakeScreen`), a
   * foreground action runs in front only on a tab the user is already looking at.
   */
  takeScreen: boolean
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
  /**
   * Idle past `SESSION_IDLE_MS`: the groups were orphaned and the page state dropped, the record
   * kept for the client's return (`park`, `unpark`). Not listed in the UI while parked.
   */
  parked: boolean
  /** The groups parking orphaned, taken back on the client's return while still orphaned. */
  readonly releasedGroupIds: Set<string>
  /**
   * The durable session this transport session carries (`zen_session start` / `resume`), or
   * null before the agent named itself. Its groups are held for the agent across reconnects.
   */
  claimId: string | null
  /** The transport session a renewing client says it replaces (the stdio relay's renewal). */
  resumeFrom: string | null
}

/** What a client last said about itself, by who it appears to be (`clientKey`). */
interface KnownClient {
  name: string
  version: string
}

interface StoredEndpoint {
  token: string
  port?: number
  url?: string | null
  running?: boolean
  /** Why the last start failed; only beside `running: false`, gone once a start succeeds. */
  error?: EndpointError
}

/**
 * The bind failure as `agent.json` carries it (`error`, beside `running: false`), so a reader
 * that came for the port – the `zen --mcp` shim, a harness waiting for `server-up` – finds the
 * reason where it looked. `code` is the host's (`EADDRINUSE`, `EACCES`; null where the host
 * names none: the phone's bind exception carries a message only); `address` and `port` are what
 * the bind was asked for – the transport's word when its error carries one, else the service's
 * request (loopback, or every interface with LAN on; the settings' port, 0 for an ephemeral one).
 */
export interface EndpointError {
  code: string | null
  message: string
  address: string
  port: number
}

/** What a session last saw of its own tabs and groups: the baseline notices are computed from. */
interface Memo {
  tabs: Map<string, { groupId: string; title: string }>
  groups: Map<string, string>
}

/**
 * Why a foreground call ran in the background: another agent holds the screen lease, or the tab
 * is not what the user is looking at and the session has not taken the screen.
 */
export type DegradeCause = 'lease' | 'screen'

/** Per tool call, reset when the call starts (calls of one session never overlap). */
interface CallState {
  /** Lines the result carries above the tool's own text (the foreground degrade, for one). */
  notes: string[]
  /** Foreground mode was asked for but the call acted in the background, and why. */
  degraded: DegradeCause | null
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
  /** A durable session's group whose agent is not connected right now: kept for it, untouchable. */
  | { kind: 'held'; name: string }
  | { kind: 'user' }

/** A page dialog of an agent's tab, waiting for the agent (`browser_handle_dialog`). */
interface AgentDialog {
  dialog: PageDialog
  resolve: (response: PageDialogResponse) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * The browser side of the MCP server: sessions (one per agent), which groups and tabs each one
 * owns, foreground vs background behaviour and the screen lease, notices, the visible cursor,
 * approval of new agents, and the server lifecycle. The wire protocol lives in `protocol.ts` /
 * `http.ts`, the tools in `tools.ts`.
 *
 * Ownership is structural: a session owns the tab groups (Zen folders) it created or adopted,
 * and a tab belongs to the session whose group holds it. There is no per-session current tab –
 * every page tool names its tab – and nothing an agent does can touch a tab another live agent
 * owns. What an agent makes carries a persisted mark (`Folder.agent`, `Space.agent`, stamped in
 * the same tick), so the shared Agents space is found by its mark rather than its name, and a
 * group whose session is gone stays an agent's – orphaned, adoptable, listed with its maker's
 * name – across restarts, wherever it sits.
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
  /** Names of the clients that initialised, for a session resumed without an initialize. */
  private readonly knownClients = new Map<string, KnownClient>()
  /** Counters and timings about the server itself (`zenium://diagnostics`). */
  readonly diagnostics = new Diagnostics()
  /** Spaces agents made for themselves (`zen_groups create {space: "own"}`, `zen_spaces create`). */
  private readonly agentSpaceIds = new Set<string>()
  /** Durable sessions (`zen_session start`), persisted in the profile. */
  readonly claims: ClaimStore
  /** Page dialogs of agents' tabs waiting for their agent, by tab id. */
  private readonly agentDialogs = new Map<string, AgentDialog>()
  /** Per session, the running call's way out when a dialog opens on one of its tabs. */
  private readonly dialogWaiters = new Map<string, (tabId: string) => void>()
  /** Native prompts of agents' tabs (file choosers, permissions, sign-ins…) waiting for their agent. */
  readonly prompts: AgentPromptQueue
  /** Per session, the running call's way out when a prompt the page waits on opens on its tab. */
  private readonly promptWaiters = new Map<string, (prompt: AgentPrompt) => void>()
  /** Tabs whose last call ran into the deadline: probed before the next call acts on them. */
  private readonly suspectTabs = new Set<string>()
  /** The window agents open tabs in, chosen once – never whatever window the user focused last. */
  private agentWinId: string | null = null
  /** The longest a tool call may run (`CALL_DEADLINE_MS`); tests shorten it. */
  callDeadlineMs = CALL_DEADLINE_MS
  /** How long a suspect page has to answer a trivial script (`PAGE_PROBE_MS`); tests shorten it. */
  pageProbeMs = PAGE_PROBE_MS
  /** How long an agent's page dialog waits for its answer (`AGENT_DIALOG_TTL_MS`); tests shorten it. */
  dialogTtlMs = AGENT_DIALOG_TTL_MS
  /** How long a native prompt of an agent's tab waits (`AGENT_PROMPT_TTL_MS`); tests shorten it. */
  promptTtlMs = AGENT_PROMPT_TTL_MS
  /**
   * Whether an agent must name itself (`zen_session start`) before it may act. Not a user
   * setting: a nameless agent cannot own anything durably, so the host never turns this off.
   */
  requireName = true
  private status: AgentServerStatus = emptyAgentServerStatus()
  /** Why the last start failed, for `agent.json` (`storeEndpoint`); null while nothing failed. */
  private failure: EndpointError | null = null
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
  /** The Agent Skill's install state, as the host last reported it (`Platform.agentSkills`). */
  private skills: AgentSkillStatus
  private skillRefresh: ReturnType<typeof setTimeout> | null = null
  /** The lease's clock; tests replace it to age a lease without waiting. */
  clock: () => number = () => Date.now()
  /**
   * Called once a session has let go of everything it held in the browser (`release`), after
   * its tabs are closed or orphaned, with why: `end` – the agent's `zen_session end`; `park` –
   * the idle sweep parked the record, which stays and may resume (`unpark`); `close` – the
   * record goes (DELETE, Disconnect, the parked limit, shutdown). The browser's hook to hand the
   * user's window back when a session's END left it on an empty agents' space
   * (`Browser.leaveEmptyAgentSpace`; a park is not an end and moves nothing); null in a harness
   * that has no browser rule to run.
   */
  onSessionReleased: ((session: AgentSession, reason: SessionReleaseReason) => void) | null = null

  constructor(readonly browser: Browser) {
    this.transport = browser.platform.createAgentTransport?.(browser) ?? null
    this.protocol = new McpProtocol(this, {
      name: SERVER_NAME,
      title: 'Zenium',
      version: browser.platform.info.version
    })
    this.http = new StreamableHttp(this)
    this.claims = new ClaimStore(browser.platform.io)
    this.token = this.loadToken()
    this.status.token = this.token
    this.prompts = new AgentPromptQueue({
      now: () => Date.now(),
      opened: (p) => this.onPromptOpened(p),
      ended: (p, how, action) => {
        if (how !== 'answered')
          this.log(`prompt ${p.id} (${p.kind}) on tab ${p.tabId} ${how}: ${action}`)
        if (how === 'expired') {
          const owner = this.driver(p.tabId)
          owner?.notices.push(
            `Notice: ${p.kind} prompt ${p.id} on tab ${p.tabId} went unanswered and got its default, "${action}".`
          )
        }
        this.browser.state.commitVolatile()
      }
    })
    this.skills = emptyAgentSkillStatus(browser.platform.info.version)
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
    this.upgradeMarks()
    this.sweeper = setInterval(() => this.sweep(), 60_000)
    this.onSettingsChanged()
    // The skill's once-per-update refresh, off the boot path; the rows show the result.
    if (this.browser.platform.agentSkills)
      this.skillRefresh = setTimeout(() => {
        this.skillRefresh = null
        void this.runSkills((host) => host.status({ sync: true }))
      }, SKILL_REFRESH_DELAY_MS)
  }

  /** Bring the server in line with Settings → AI Agents (start / stop / rebind). */
  onSettingsChanged(): void {
    if (!this.started) return
    // `apply` reports a bind failure itself (`startServer`); anything else it throws would
    // otherwise vanish into the chain with the server left as it was and nothing said.
    this.applying = this.applying
      .then(() => this.apply())
      .catch((error: unknown) => {
        console.error('[zen mcp] the server settings could not be applied:', error)
      })
  }

  async stop(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
    if (this.skillRefresh) clearTimeout(this.skillRefresh)
    this.skillRefresh = null
    for (const id of [...this.sessions.keys()]) this.close(id)
    for (const tabId of [...this.agentDialogs.keys()]) this.dismissAgentDialog(tabId)
    this.prompts.dismissAll()
    await this.applying
    await this.stopServer()
    await this.writing
    await this.claims.flush()
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

  /**
   * Bind through the host's transport. A failure – the port taken, no permission, whatever the
   * host's `listen` refused – ends here and nowhere else: the Settings row gets the message
   * (`status.error`), and, so that a failure nobody was watching still explains itself, one
   * `console.error` line names it and `agent.json` carries it (`EndpointError`) in the same
   * write that used to say `running: false` and no more. Reporting only: no retry, and the
   * server stays down until the settings change.
   */
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
      this.failure = null
      this.storeEndpoint(bound.port)
    } catch (error) {
      const failure = endpointError(error, s)
      console.error(
        `[zen mcp] the server could not bind ${hostPort(failure.address, failure.port)}${failure.code ? ` (${failure.code})` : ''}: ${failure.message}`
      )
      this.status = { ...emptyAgentServerStatus(), token: this.token, error: failure.message }
      this.failure = failure
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

  /**
   * The document the shim and the harnesses read. Bound: `{ token, running: true, port, url }`,
   * byte for byte as before. Down: `{ token, running: false, url: null }` – plus `error` when
   * the last start failed (`failure`), so the file that says "not running" says why.
   */
  private storeEndpoint(port: number | null): void {
    const data: StoredEndpoint = {
      token: this.token,
      running: port !== null,
      port: port ?? undefined,
      url: port ? endpointUrl('127.0.0.1', port) : null
    }
    if (port === null && this.failure) data.error = this.failure
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
  // The Agent Skill (Settings → AI Agents → Agent skill; desktop hosts only)
  // ---------------------------------------------------------------------------

  skillStatus(): AgentSkillStatus {
    return this.skills
  }

  /** Install into `targets` (`AgentSkillTarget.id`s), or into every detected harness. */
  installSkill(targets?: string[]): Promise<void> {
    return this.runSkills((host) => host.install(targets))
  }

  uninstallSkill(targets?: string[]): Promise<void> {
    return this.runSkills((host) => host.uninstall(targets))
  }

  /** Detect the harnesses again and re-read the installed copies. */
  refreshSkill(): Promise<void> {
    return this.runSkills((host) => host.status())
  }

  /**
   * One host operation, its outcome into the state: the host reports failures inside the status
   * (`AgentSkillsHost`), so anything it throws all the same is the last resort – logged whole,
   * and in `error` as a plain sentence with the code, never a message carrying paths – rather
   * than the caller's (the startup refresh has none).
   */
  private async runSkills(
    operation: (host: AgentSkillsHost) => Promise<AgentSkillStatus>
  ): Promise<void> {
    const host = this.browser.platform.agentSkills
    if (!host) return
    try {
      this.skills = await operation(host)
    } catch (error) {
      console.error('[zenium] agent skill host threw:', error)
      const code = (error as { code?: unknown } | null)?.code
      this.skills = {
        ...this.skills,
        error:
          typeof code === 'string' && code
            ? `The agent skill could not be updated (${code})`
            : 'The agent skill could not be updated'
      }
    }
    this.browser.state.commitVolatile()
  }

  // ---------------------------------------------------------------------------
  // State for the UI
  // ---------------------------------------------------------------------------

  serverStatus(): AgentServerStatus {
    return this.status
  }

  list(): AgentInfo[] {
    return [...this.sessions.values()]
      .filter((s) => (s.approved || s.pending) && !s.parked)
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

  /**
   * Whether an agent's work holds the tab: a live session's group, or a durable session's while
   * its agent is away – either way the governor leaves the page loaded and awake.
   */
  isDriving(tabId: string): boolean {
    if (this.driver(tabId) !== undefined) return true
    const tab = this.browser.tabs.tab(tabId)
    return Boolean(tab?.folderId && this.heldBy(tab.folderId))
  }

  /**
   * Whether a page dialog of the tab is its agent's to answer (`PageDialogService.ask`, and its
   * "Leave site?"): the tab sits in a live agent's group, or in one held for an away agent while
   * the user cannot see it. A held tab in front of the user is the user's to answer: nobody would
   * hear of the dialog, and the page would sit blocked until it timed out.
   */
  takesDialog(tabId: string): boolean {
    if (this.driver(tabId) !== undefined) return true
    const tab = this.browser.tabs.tab(tabId)
    if (!tab?.folderId || !this.heldBy(tab.folderId)) return false
    return !this.isShown(tab, this.browser.tabs.windowFor(tabId))
  }

  session(id: string): AgentSession | undefined {
    return this.sessions.get(id)
  }

  // ---------------------------------------------------------------------------
  // User actions (Settings → AI Agents, tab indicator)
  // ---------------------------------------------------------------------------

  /**
   * Settings → AI Agents → Disconnect: the user's word ends the agent's durable session too –
   * its groups are left orphaned, as an end without closeTabs leaves them.
   */
  disconnect(id: string): void {
    const s = this.sessions.get(id)
    if (s?.claimId) {
      this.claims.delete(s.claimId)
      s.claimId = null
    }
    this.close(id)
  }

  /**
   * The user releases a durable session whose agent is not connected (or is): its groups are
   * left orphaned and the claim is forgotten. The one way besides the agent's own end.
   */
  releaseClaim(claimId: string): void {
    const claim = this.claims.get(claimId)
    if (!claim) return
    const bound = this.boundSession(claim)
    if (bound) {
      this.disconnect(bound.id)
      return
    }
    const now = Date.now()
    for (const g of claim.groupIds)
      if (this.browser.state.model.folders[g])
        this.orphans.set(g, { ownerName: claim.name, endedAt: now })
    this.claims.delete(claimId)
    this.log(`claim ${claimId} (${claim.name}) released by the user`)
    this.browser.state.commitVolatile()
  }

  /**
   * The folder menu's and Settings' Release: the same release, but only while the agent is away –
   * a request made from a stale menu or row never cuts off an agent that has come back meanwhile.
   */
  releaseAway(claimId: string): void {
    const claim = this.claims.get(claimId)
    if (!claim || this.boundSession(claim)) return
    this.releaseClaim(claimId)
  }

  /** Named agents that are not connected but hold groups that still exist, oldest first. */
  away(): AwayAgentInfo[] {
    const { folders, tabs } = this.browser.state.model
    const out: AwayAgentInfo[] = []
    for (const c of this.claims.all()) {
      if (this.boundSession(c)) continue
      const groupIds = c.groupIds.filter((g) => folders[g])
      if (!groupIds.length) continue
      const held = new Set(groupIds)
      out.push({
        claimId: c.id,
        name: c.name,
        color: c.color,
        groupIds,
        tabIds: Object.values(tabs)
          .filter((t) => t.folderId !== null && t.folderId !== undefined && held.has(t.folderId))
          .map((t) => t.id),
        lastSeenAt: c.lastSeenAt
      })
    }
    return out.sort((a, b) => a.lastSeenAt - b.lastSeenAt)
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
    this.prompts.dismissTab(tab.id)
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
    this.dismissAgentDialog(tabId)
    this.prompts.dismissTab(tabId)
    this.suspectTabs.delete(tabId)
    this.browser.state.commitVolatile()
  }

  // ---------------------------------------------------------------------------
  // SessionStore (used by the HTTP transport)
  // ---------------------------------------------------------------------------

  create(init: SessionInit, id: string = randomToken().slice(0, 24)): AgentSession {
    const base = newSession(id)
    const now = Date.now()
    const session: AgentSession = {
      ...base,
      name: 'Agent',
      version: '',
      color: this.pickColor(),
      mode: this.settings.defaultMode,
      takeScreen: false,
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
      frames: new Map(),
      parked: false,
      releasedGroupIds: new Set(),
      claimId: null,
      resumeFrom: init.resumeFrom ?? null
    }
    this.sessions.set(id, session)
    this.diagnostics.sessions.created++
    return session
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id)
  }

  /**
   * A request named a session no record answers – the browser restarted, or the record was
   * deleted – from a client that proves itself with the token: the session is re-made under the
   * same id, initialised, approved, named as that client last introduced itself, and told what
   * happened. The MCP spec has the client start over on a 404; the clients in the field that do
   * not would otherwise stay dead until the user toggled the server. Without the token there is
   * nothing to trust and the 404 stands (the client's initialize brings the approval prompt).
   */
  resurrect(
    id: string,
    init: SessionInit,
    protocolVersion: string | null
  ): AgentSession | undefined {
    if (!this.isValidToken(init.token) || !SESSION_ID_SHAPE.test(id)) {
      this.diagnostics.sessions.unknown++
      this.log(`unknown session ${id.slice(0, 12)}… refused (no valid token)`)
      return undefined
    }
    const s = this.create(init, id)
    s.protocolVersion =
      protocolVersion && SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)
        ? protocolVersion
        : LATEST_PROTOCOL_VERSION
    s.initialized = true
    s.approved = true
    const known = this.knownClients.get(clientKey(init))
    if (known) {
      s.name = known.name
      s.version = known.version
    }
    const claim = this.claims.bySession(id)
    if (claim && !this.boundSession(claim)) {
      this.bindClaim(s, claim)
      s.notices.push(
        `Notice: your connection was resumed without an initialize – the browser restarted or your connection was lost. Your session ${JSON.stringify(claim.name)} is back with its groups and tabs; refs from before are stale: browser_snapshot before acting.`
      )
    } else
      s.notices.push(
        'Notice: your connection was resumed without an initialize – the browser restarted or your session had expired. If you started a session before, resume it: zen_session {"action":"resume","key":"…"} with the key zen_session start gave you – your groups and tabs were kept for you. Do not open their pages again.'
      )
    this.diagnostics.sessions.resurrected++
    this.log(`session ${s.id} resumed without initialize (${s.name}, ${s.transport})`)
    this.browser.state.commitVolatile()
    return s
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
    if (!s) return
    s.lastActiveAt = Date.now()
    if (s.parked) this.unpark(s)
  }

  /**
   * The session's record goes (DELETE, Settings → Disconnect, the parked limit, shutdown): its
   * groups stay with their tabs – results are never destroyed under the user – and become
   * orphaned, for another session to adopt. A request naming the id afterwards is a 404, or a
   * resumed session when the client carries the token (`resurrect`).
   */
  close(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    this.release(s, 'close')
    this.sessions.delete(id)
    this.memos.delete(id)
    this.callStates.delete(id)
    for (const [key, sid] of this.sessionlessIds) if (sid === id) this.sessionlessIds.delete(key)
    this.diagnostics.sessions.closed++
    this.log(`session ${id} closed (${s.name}, ${s.transport})`)
    this.browser.state.commitVolatile()
  }

  /**
   * Let go of everything the session holds in the browser – its tabs' cursors and page runtime,
   * its groups (orphaned, with its name on them), its screen lease – and leave the record as a
   * fresh agent's: no home group, no notices, no frames. The connection is not touched. `reason`
   * goes to `onSessionReleased`, which fires last.
   */
  private release(s: AgentSession, reason: SessionReleaseReason): void {
    const owned = this.ownedTabs(s)
    for (const t of owned) this.detach(s, t.id)
    const claim = reason === 'end' ? undefined : this.claims.get(s.claimId)
    if (claim) {
      // A durable session outlives its transport: the groups stay the agent's, held by the
      // claim while no client carries it, and nothing is orphaned.
      this.saveClaim(s)
      if (reason === 'close') {
        s.groupIds.clear()
        s.homeGroupId = null
      }
    } else {
      for (const t of owned) {
        this.dismissAgentDialog(t.id)
        this.prompts.dismissTab(t.id)
      }
      const now = Date.now()
      for (const groupId of s.groupIds)
        if (this.browser.state.model.folders[groupId])
          this.orphans.set(groupId, { ownerName: s.name, endedAt: now })
      s.groupIds.clear()
      s.homeGroupId = null
      s.notices.length = 0
    }
    s.cursors.clear()
    s.frames.clear()
    this.memos.delete(s.id)
    this.callStates.delete(s.id)
    for (const [win, lease] of this.leases) if (lease.sessionId === s.id) this.leases.delete(win)
    this.onSessionReleased?.(s, reason)
  }

  /**
   * `zen_session end`: the agent is done – its groups are closed or left orphaned – but its
   * CONNECTION stays. The MCP session the client holds is the transport's, not the agent's to
   * destroy: ending used to delete the record, and every later call of a client that tidied up
   * properly was a 404 until the user toggled the server by hand. The next call starts over as
   * a fresh agent under the same session id (a new home group on first use).
   */
  endSession(s: AgentSession, closeTabs: boolean): { groups: number; tabs: number } {
    const groups = this.groupsOf(s)
    const tabs = this.ownedTabs(s).length
    if (closeTabs) for (const g of groups) this.closeGroup(s, g)
    this.release(s, 'end')
    s.releasedGroupIds.clear()
    if (s.claimId) {
      this.claims.delete(s.claimId)
      s.claimId = null
    }
    this.diagnostics.sessions.ended++
    this.log(
      `session ${s.id} ended by the agent (${s.name}; ${groups.length} groups, ${tabs} tabs${closeTabs ? ' closed' : ' orphaned'})`
    )
    this.browser.state.commitVolatile()
    return { groups: groups.length, tabs }
  }

  /**
   * Idle past the limit: the session's groups are orphaned and its page state dropped, as a
   * closed session's would be – but the record stays, parked, so the client's next call is
   * answered. The groups are remembered: if they are still orphaned when the client returns,
   * they are its again (`unpark`).
   */
  private park(s: AgentSession): void {
    const groups = [...s.groupIds].filter((id) => this.browser.state.model.folders[id])
    this.release(s, 'park')
    s.releasedGroupIds.clear()
    if (!s.claimId) for (const id of groups) s.releasedGroupIds.add(id)
    s.parked = true
    this.diagnostics.sessions.parkedTotal++
    this.log(
      `session ${s.id} parked after idling (${s.name}; ${groups.length} groups ${s.claimId ? 'kept' : 'orphaned'})`
    )
    this.browser.state.commitVolatile()
  }

  private unpark(s: AgentSession): void {
    s.parked = false
    const back: string[] = []
    for (const id of s.releasedGroupIds) {
      const folder = this.browser.state.model.folders[id]
      if (folder && this.isOrphan(id)) {
        this.adopt(s, folder)
        back.push(id)
      }
    }
    s.releasedGroupIds.clear()
    this.diagnostics.sessions.resumed++
    s.notices.push(
      s.claimId
        ? 'Notice: your session was idle for a while; it is back, and your groups and tabs stayed yours. Refs from before are stale: browser_snapshot again before acting.'
        : back.length
          ? `Notice: your session was idle for a while and parked; it is back, and your ${back.length} group${back.length === 1 ? '' : 's'} (${back.join(', ')}) ${back.length === 1 ? 'is' : 'are'} yours again. Refs from before are stale: browser_snapshot again before acting.`
          : 'Notice: your session was idle for a while and parked; it is back. Any groups you had were taken by another agent or closed meanwhile – zen_groups {"action":"list","scope":"all"} shows what is there.'
    )
    this.log(`session ${s.id} resumed from parking (${s.name}; ${back.length} groups back)`)
    this.browser.state.commitVolatile()
  }

  private sweep(): void {
    const now = Date.now()
    for (const s of [...this.sessions.values()]) {
      const sessionless = [...this.sessionlessIds.values()].includes(s.id)
      const idle = now - s.lastActiveAt
      if (s.parked) {
        if (idle > PARKED_TTL_MS) this.close(s.id)
      } else if (!s.approved && !s.pending && idle > 60_000) this.close(s.id)
      else if (idle > (sessionless ? SESSIONLESS_IDLE_MS : SESSION_IDLE_MS)) this.park(s)
    }
    this.pruneClaims(now)
  }

  /**
   * A claim whose groups are all gone (the user closed them) and whose agent has not been back
   * for `EMPTY_CLAIM_TTL_MS` is forgotten; a claim with groups is kept until its agent ends it
   * or the user releases it.
   */
  private pruneClaims(now: number): void {
    const folders = this.browser.state.model.folders
    for (const claim of this.claims.all()) {
      if (this.boundSession(claim)) continue
      const live = claim.groupIds.filter((g) => folders[g])
      if (live.length !== claim.groupIds.length) {
        claim.groupIds = live
        if (claim.homeGroupId && !folders[claim.homeGroupId]) claim.homeGroupId = null
        this.claims.save()
      }
      if (!live.length && now - claim.lastSeenAt > EMPTY_CLAIM_TTL_MS) {
        this.claims.delete(claim.id)
        this.log(`claim ${claim.id} (${claim.name}) forgotten: no groups, no client for a week`)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Durable sessions (claims)
  // ---------------------------------------------------------------------------

  /** The live session carrying `claim` right now, if any. */
  boundSession(claim: AgentClaim): AgentSession | undefined {
    for (const s of this.sessions.values()) if (s.claimId === claim.id) return s
    return undefined
  }

  /** The durable session the session carries, if it started one. */
  claimOf(s: AgentSession): AgentClaim | undefined {
    return this.claims.get(s.claimId)
  }

  /** The claim holding `folderId` while no live session carries it. */
  heldBy(folderId: string): AgentClaim | undefined {
    const claim = this.claims.byGroup(folderId)
    if (!claim || this.boundSession(claim)) return undefined
    return this.browser.state.model.folders[folderId] ? claim : undefined
  }

  /** Whether the agent must still name itself before acting (`zen_session start`). */
  needsName(s: AgentSession): boolean {
    return !s.claimId && this.requireName
  }

  /**
   * `zen_session start`: the agent names itself and gets a durable session – its groups held
   * for it across reconnects until it ends the session. Throws with the reason when the name
   * says nothing (`checkAgentName`) or the session already has one.
   */
  startClaim(s: AgentSession, rawName: unknown): AgentClaim {
    const current = this.claims.get(s.claimId)
    if (current)
      throw new RpcError(
        -32602,
        `You already started your session as ${JSON.stringify(current.name)}. zen_session {"action":"rename","name":"…"} changes the name; zen_session {"action":"end"} ends it.`
      )
    const verdict = checkAgentName(rawName, {
      clientName: s.client?.name ?? s.name,
      taken: this.takenNames(s)
    })
    if (!verdict.ok) throw new RpcError(-32602, `Refused: ${verdict.reason}.`)
    const claim = this.claims.create(
      { name: verdict.name, color: s.color, mode: s.mode, takeScreen: s.takeScreen },
      Date.now()
    )
    // Groups the session made before naming itself (a host that does not require the name).
    for (const g of s.groupIds) if (this.browser.state.model.folders[g]) claim.groupIds.push(g)
    claim.homeGroupId = s.homeGroupId
    this.bindClaim(s, claim)
    this.diagnostics.sessions.claimed++
    this.log(`session ${s.id} started durable session ${claim.id} (${claim.name})`)
    return claim
  }

  /**
   * `zen_session resume {key}`: carry the durable session the key opens on this transport
   * session. A client still holding it elsewhere (the stale end of a dropped connection) loses
   * it and is told.
   */
  resumeClaim(s: AgentSession, key: unknown): AgentClaim {
    const claim = typeof key === 'string' ? this.claims.byKey(key) : undefined
    if (!claim)
      throw new RpcError(
        -32602,
        'No session has that key: it was ended (zen_session end, or the user released it), or the key is mistyped. zen_session {"action":"start","name":"…"} starts a new one.'
      )
    if (s.claimId === claim.id) return claim
    if (s.claimId)
      throw new RpcError(
        -32602,
        `This connection already carries your session ${JSON.stringify(this.claims.get(s.claimId)?.name ?? '')}; end it first to resume another.`
      )
    const holder = this.boundSession(claim)
    if (holder) this.unbindClaim(holder, 'resumed on another connection with its key')
    this.bindClaim(s, claim)
    return claim
  }

  /** Put the claim on the session: its name, colour, mode and groups, from this tick on. */
  private bindClaim(s: AgentSession, claim: AgentClaim): void {
    const folders = this.browser.state.model.folders
    s.claimId = claim.id
    s.name = claim.name
    s.color = claim.color
    s.mode = claim.mode
    s.takeScreen = claim.takeScreen
    for (const g of claim.groupIds) {
      if (!folders[g]) continue
      // A group another live session took meanwhile (the user handed it over) stays with it.
      const other = this.groupOwner(g)
      if (other && other.id !== s.id) continue
      s.groupIds.add(g)
      this.orphans.delete(g)
    }
    s.homeGroupId =
      claim.homeGroupId && s.groupIds.has(claim.homeGroupId) ? claim.homeGroupId : s.homeGroupId
    claim.lastSessionId = s.id
    claim.lastSeenAt = Date.now()
    this.saveClaim(s)
    this.remember(s)
    this.diagnostics.sessions.rebound++
    this.browser.state.commitVolatile()
  }

  /** The session no longer carries its claim; the groups stay held by the claim. */
  private unbindClaim(s: AgentSession, why: string): void {
    const claim = this.claims.get(s.claimId)
    if (claim) this.saveClaim(s)
    for (const t of this.ownedTabs(s)) this.detach(s, t.id)
    s.claimId = null
    s.groupIds.clear()
    s.homeGroupId = null
    this.memos.delete(s.id)
    s.notices.push(
      `Notice: your session ${JSON.stringify(claim?.name ?? '')} was ${why}; this connection no longer carries it or its tabs.`
    )
    this.log(`session ${s.id} let go of claim ${claim?.id ?? '?'} (${why})`)
  }

  /** Write the session's groups, name and mode into its claim. */
  private saveClaim(s: AgentSession): void {
    const claim = this.claims.get(s.claimId)
    if (!claim) return
    const folders = this.browser.state.model.folders
    claim.name = s.name
    claim.color = s.color
    claim.mode = s.mode
    claim.takeScreen = s.takeScreen
    claim.groupIds = [...s.groupIds].filter((g) => folders[g])
    claim.homeGroupId = s.homeGroupId && folders[s.homeGroupId] ? s.homeGroupId : null
    claim.lastSessionId = s.id
    // Only the week-long prune reads it: a minute's precision spares a write per call.
    if (s.lastActiveAt - claim.lastSeenAt > 60_000) claim.lastSeenAt = s.lastActiveAt
    this.claims.save()
  }

  /** Wait for the claims written so far to reach the disk. */
  flushClaims(): Promise<void> {
    return this.claims.flush()
  }

  /** Names other agents go by now: live sessions' and durable sessions'. */
  private takenNames(s: AgentSession): string[] {
    const out: string[] = []
    for (const c of this.claims.all()) if (c.id !== s.claimId) out.push(c.name)
    for (const o of this.sessions.values())
      if (o.id !== s.id && o.claimId && !o.parked) out.push(o.name)
    return out
  }

  /** A snapshot of the server's own counters and timings (`zenium://diagnostics`, `zen_status`). */
  diagnosticsSnapshot(): DiagnosticsSnapshot {
    let parked = 0
    for (const s of this.sessions.values()) if (s.parked) parked++
    return this.diagnostics.snapshot({ live: this.sessions.size - parked, parked })
  }

  /** One terse line per lifecycle event, for the host's log (Cursor shows a stdio server's stderr). */
  private log(line: string): void {
    console.info(`[zen mcp] ${line}`)
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
    if (!s.claimId) s.name = client.name
    s.version = client.version
    this.rememberClient(s, client)
    this.log(`session ${s.id} initialize (${client.name} ${client.version}, ${s.transport})`)
    if (s.approved) return
    const settings = this.settings
    if (
      this.isValidToken(s.token) ||
      !settings.approveNewAgents ||
      settings.approvedNames.includes(s.name)
    ) {
      s.approved = true
      this.resumeRenewed(s)
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

  /**
   * A client renewing a lost transport session names the one it replaces (the stdio relay's
   * `Mcp-Resume-Session` header): with the token, the durable session that id carried moves to
   * the new one, so a browser restart or an expired id costs the agent nothing.
   */
  private resumeRenewed(s: AgentSession): void {
    const from = s.resumeFrom
    s.resumeFrom = null
    if (!from || s.claimId || !this.isValidToken(s.token)) return
    const claim = this.claims.bySession(from)
    if (!claim) return
    const holder = this.boundSession(claim)
    if (holder && holder.id !== from) return
    if (holder) this.unbindClaim(holder, 'renewed on a new connection')
    this.bindClaim(s, claim)
    s.notices.push(
      `Notice: your connection was renewed (the browser restarted or the connection was lost); your session ${JSON.stringify(claim.name)} carried over with its groups and tabs. Refs from before are stale: browser_snapshot before acting.`
    )
    this.log(`session ${s.id} renewed from ${from} with claim ${claim.id} (${claim.name})`)
  }

  /** Who introduced itself from where, so a session resumed without an initialize keeps its name. */
  private rememberClient(s: AgentSession, client: ClientInfo): void {
    const key = clientKey(s)
    this.knownClients.delete(key)
    this.knownClients.set(key, { name: client.name, version: client.version })
    if (this.knownClients.size > KNOWN_CLIENTS_MAX) {
      const oldest = this.knownClients.keys().next().value
      if (oldest !== undefined) this.knownClients.delete(oldest)
    }
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
    return AGENT_TOOLS.filter((t) => (allow || !t.scripting) && this.hostHas(t)).map(
      (t) => t.definition
    )
  }

  private hostHas(tool: (typeof AGENT_TOOLS)[number]): boolean {
    switch (tool.needs) {
      case undefined:
        return true
      case 'agentDialogs':
        return this.browser.platform.capabilities.agentDialogs
      case 'agentPrompts':
        return this.promptKinds().length > 0
      case 'fileUpload':
        return this.promptKinds().includes('file-chooser')
    }
  }

  callTool(session: McpSession, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const s = this.requireApproved(session)
    const tool = AGENT_TOOLS.find((t) => t.definition.name === name)
    if (!tool || !this.hostHas(tool)) return Promise.resolve(textError(`Unknown tool ${name}`))
    if (tool.scripting && !this.settings.allowScripts)
      return Promise.resolve(textError(SCRIPTING_DISABLED))
    if (this.needsName(s) && !UNCLAIMED_TOOLS.has(name))
      return Promise.resolve(textError(NAME_YOURSELF))
    s.calls++
    s.lastActiveAt = Date.now()
    return this.enqueue(s, () => this.runBounded(s, name, tool, args))
  }

  /**
   * One tool call, bounded: it ends with the tool's result, or – whichever comes first – when a
   * page dialog opens on one of the session's tabs (the page blocks until it is answered, so the
   * call would otherwise never return), or at the deadline. Either way the session's queue moves
   * on; work the call left running finishes (or not) on its own and its result is dropped.
   */
  private async runBounded(
    s: AgentSession,
    name: string,
    tool: (typeof AGENT_TOOLS)[number],
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    this.reconcile(s)
    const state = this.beginCall(s)
    const ctx: ToolContext = { browser: this.browser, agents: this, session: s }
    const end = this.diagnostics.begin(name)
    const work = (async (): Promise<ToolResult> => {
      try {
        return withUnknownArgsNote(tool.definition, args, await tool.run(ctx, args))
      } catch (error) {
        return error instanceof RpcError
          ? textError(error.message)
          : textError((error as Error).message || String(error))
      }
    })()
    let timer: ReturnType<typeof setTimeout> | null = null
    const deadline = new Promise<ToolResult>((resolve) => {
      timer = setTimeout(() => resolve(this.deadlineResult(s, name, args)), this.callDeadlineMs)
    })
    const dialog = new Promise<ToolResult>((resolve) => {
      this.dialogWaiters.set(s.id, (tabId) => resolve(this.dialogResult(name, tabId)))
    })
    const prompt = new Promise<ToolResult>((resolve) => {
      this.promptWaiters.set(s.id, (p) => resolve(this.promptResult(name, p)))
    })
    let result: ToolResult
    try {
      result = await Promise.race([work, deadline, dialog, prompt])
    } finally {
      if (timer) clearTimeout(timer)
      this.dialogWaiters.delete(s.id)
      this.promptWaiters.delete(s.id)
      // A background agent (or a foreground one that had to act in the background) may have
      // focused one of its hidden pages; hand keyboard focus back to what the user looks at.
      if (s.mode === 'background' || state.degraded) this.restoreUserFocus(s)
      this.remember(s)
      this.saveClaim(s)
      this.browser.state.commitVolatile()
    }
    end(result.isError ? firstText(result) : null)
    return this.decorate(s, state, result)
  }

  /** What a call that ran into the deadline answers; the tabs it named are probed next time. */
  private deadlineResult(s: AgentSession, name: string, args: Record<string, unknown>): ToolResult {
    this.diagnostics.noteTimeout()
    const tabId = typeof args.tabId === 'string' ? args.tabId.trim() : ''
    const tab = tabId ? this.ownedTabs(s).find((t) => t.id.startsWith(tabId)) : undefined
    if (tab) this.suspectTabs.add(tab.id)
    this.log(`session ${s.id} (${s.name}): ${name} hit the ${this.callDeadlineMs} ms deadline`)
    return textError(
      `${name} did not finish within ${this.callDeadlineMs < 1000 ? `${this.callDeadlineMs} ms` : `${Math.round(this.callDeadlineMs / 1000)} s`}${tab ? ` – the page in tab ${tab.id} stopped answering` : ''} and was abandoned. Your session is fine and your next call runs normally. It may still have taken effect: browser_snapshot${tab ? ` {"tabId":"${tab.id}"}` : ''} shows the page as it is now; if the page stays unresponsive, browser_reload restarts it.`
    )
  }

  /** What a call interrupted by a page dialog on one of the session's tabs answers. */
  private dialogResult(name: string, tabId: string): ToolResult {
    const d = this.agentDialogs.get(tabId)?.dialog
    return {
      content: [
        {
          type: 'text',
          text: `${d ? describeDialog(d) : `The page in tab ${tabId} opened a dialog`} while ${name} ran; the page waits for your answer. browser_handle_dialog {"tabId":"${tabId}","accept":true} (or false${d?.kind === 'prompt' ? ', with promptText' : ''}) answers it, then take a snapshot: ${name} may not have finished.`
        }
      ]
    }
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
    const state: CallState = { notes: [], degraded: null }
    this.callStates.set(s.id, state)
    return state
  }

  private callState(s: AgentSession): CallState {
    return this.callStates.get(s.id) ?? this.beginCall(s)
  }

  /** Whether the running call had to act in the background although the agent is in foreground mode. */
  degraded(s: AgentSession): boolean {
    return this.degradedBecause(s) !== null
  }

  /** Why the running call acted in the background in foreground mode, or null when it did not. */
  degradedBecause(s: AgentSession): DegradeCause | null {
    return this.callStates.get(s.id)?.degraded ?? null
  }

  /** The call runs in the background although the agent is in foreground mode; the result says why. */
  private degrade(s: AgentSession, cause: DegradeCause, note: string): void {
    const state = this.callState(s)
    if (!state.notes.includes(note)) state.notes.push(note)
    state.degraded = cause
  }

  /**
   * Queued notices, the call's notes and the prompts still waiting on the session's tabs go above
   * the tool's own text, then the notice queue drains. The prompts stay until they are answered:
   * whatever the agent calls, it hears of them.
   */
  private decorate(s: AgentSession, state: CallState, result: ToolResult): ToolResult {
    const said = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
    const lines = [...s.notices.splice(0), ...state.notes, ...this.pendingPromptLines(s, said)]
    if (!lines.length) return result
    const content = [...result.content]
    const i = content.findIndex((c) => c.type === 'text')
    const head = lines.join('\n')
    if (i === -1) content.unshift({ type: 'text', text: head })
    else content[i] = { type: 'text', text: `${head}\n\n${(content[i] as { text: string }).text}` }
    return { ...result, content }
  }

  /**
   * Give the keyboard back to the page the user looks at – only when one of the session's own
   * pages took it during the call. Where the user's focus is anywhere else (the address bar, the
   * sidebar, another app), it stays there: an agent at work never moves the user's caret.
   */
  private restoreUserFocus(s: AgentSession): void {
    const views = this.ownedTabs(s)
      .map((t) => this.browser.tabs.view(t.id))
      .filter((v): v is TabView => v !== undefined && !v.isDestroyed())
    const canTell = views.every((v) => typeof v.isFocused === 'function')
    if (canTell && !views.some((v) => v.isFocused?.())) return
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
      },
      {
        uri: 'zenium://diagnostics',
        name: 'diagnostics',
        title: 'Server diagnostics',
        description:
          'How the MCP server is doing, as JSON: sessions created, ended, parked, resumed and refused; calls and errors; per-tool latency percentiles; the last errors. For debugging a slow or dying connection.',
        mimeType: 'application/json'
      }
    ]
  }

  readResource(session: McpSession, uri: string): Promise<ResourceContents[]> {
    const s = this.requireApproved(session)
    if (this.needsName(s) && !UNCLAIMED_RESOURCES.has(splitQuery(uri)[0]))
      return Promise.reject(new RpcError(-32002, NAME_YOURSELF))
    return this.enqueue(s, async () => {
      this.reconcile(s)
      this.beginCall(s)
      let timer: ReturnType<typeof setTimeout> | null = null
      try {
        return await Promise.race([
          this.readResourceNow(s, uri),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new RpcError(
                    -32603,
                    `${uri} did not answer within ${Math.round(this.callDeadlineMs / 1000)} s and was abandoned; your session is fine`
                  )
                ),
              this.callDeadlineMs
            )
          })
        ])
      } finally {
        if (timer) clearTimeout(timer)
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
    if (path === 'zenium://diagnostics') {
      return [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(this.diagnosticsSnapshot(), null, 2)
        }
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
    const others = [...this.sessions.values()].filter(
      (o) => o.approved && !o.parked && o.id !== session.id
    )
    return agentInstructions(
      s?.mode ?? this.settings.defaultMode,
      this.settings.allowScripts,
      others.length,
      this.browser.platform.capabilities.agentDialogs,
      this.promptKinds()
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

  /**
   * The synced window agents work in (never a private or blank window): chosen once and kept
   * while it lives – never the window the user happened to focus last, so the user moving
   * between windows moves nothing of the agents' (where their tabs open, whose screen the lease
   * is for, what counts as on screen).
   */
  agentWindow(): ZenWindow {
    const all = this.browser.allWindows()
    const pinned = this.agentWinId
      ? all.find((w) => w.id === this.agentWinId && w.kind === 'synced')
      : undefined
    if (pinned) return pinned
    const agents = this.findAgentsSpace()
    const synced =
      (agents && all.find((w) => w.kind === 'synced' && w.activeSpaceId === agents.id)) ??
      all.find((w) => w.kind === 'synced') ??
      this.browser.createWindow({ kind: 'synced' })
    this.agentWinId = synced.id
    return synced
  }

  /** The window a group's tabs live in: its first member's, else the agents' window. */
  groupWindow(group: Folder): ZenWindow {
    const first = folderTabs(this.browser.state.model, group.id)[0]
    return first ? this.browser.tabs.windowFor(first.id) : this.agentWindow()
  }

  /**
   * The shared "Agents" space, made once on demand and marked `shared` in the tick it exists
   * in; never shown to the user by making it.
   */
  agentsSpace(): Space {
    const m = this.browser.state.model
    const found = this.findAgentsSpace()
    if (found) return found
    const win = this.agentWindow()
    const space = createSpace(AGENTS_SPACE_NAME, AGENTS_SPACE_ICON, win.activeSpace().containerId)
    space.agent = { kind: 'shared' }
    m.spaces.push(space)
    this.browser.state.commit()
    return space
  }

  /** The shared Agents space, by its mark – a space the user named "Agents" is not it. */
  findAgentsSpace(): Space | undefined {
    return this.browser.state.model.spaces.find((sp) => sp.agent?.kind === 'shared')
  }

  /**
   * State written before the marks existed (S1 of the MCP program kept the agents' spaces and
   * groups in memory): the one space that was the shared Agents space by construction – named
   * `Agents`, wearing the robot icon, unmarked – is stamped `shared` once, and every unmarked
   * folder in it, an agent's group by the same construction, is stamped with the agent's name
   * read off S1's `<agent> · <id4>` group names (an empty name where the folder was named
   * otherwise: maker unknown) and the upgrade's time. Nothing else is touched – a space the
   * user calls Agents under another icon is theirs, so are the folders in it – and once a
   * shared space is marked there is nothing left to upgrade, so a second run changes nothing.
   */
  private upgradeMarks(): void {
    const m = this.browser.state.model
    if (this.findAgentsSpace()) return
    const legacy = m.spaces.find(
      (sp) =>
        !sp.agent && !sp.windowId && sp.name === AGENTS_SPACE_NAME && sp.icon === AGENTS_SPACE_ICON
    )
    if (!legacy) return
    const now = Date.now()
    legacy.agent = { kind: 'shared' }
    for (const f of Object.values(m.folders))
      if (f.spaceId === legacy.id && !f.agent)
        f.agent = { name: legacyGroupOwner(f.name), createdAt: now }
    this.browser.state.commit()
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

  /**
   * A new group of the session's in `spaceId`: owned, and marked as the agent's with its name,
   * from the same tick it exists in.
   */
  createGroup(s: AgentSession, name: string, spaceId: string): Folder {
    const m = this.browser.state.model
    const folder = createFolder(m, spaceId, name, GROUP_ICON, nextFolderColor(m, spaceId))
    folder.agent = { name: s.name, createdAt: Date.now() }
    s.groupIds.add(folder.id)
    this.memo(s).groups.set(folder.id, folder.name)
    this.browser.state.commit()
    return folder
  }

  /**
   * A space of the agent's own (`zen_groups create {space: "own"}`, `zen_spaces create`), named
   * after the agent unless told otherwise and marked `own` with the agent's name; the user's
   * window is not switched to it.
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
    space.agent = { kind: 'own', name: s.name, createdAt: Date.now() }
    m.spaces.push(space)
    this.agentSpaceIds.add(space.id)
    this.browser.state.commit()
    return space
  }

  /**
   * Whether the space is agents' territory: marked – the shared Agents space or one an agent
   * made, this run or before – or made by an agent this run (the in-memory set, kept as the
   * belt to the mark's braces).
   */
  isAgentSpace(spaceId: string): boolean {
    if (this.agentSpaceIds.has(spaceId)) return true
    return Boolean(this.browser.state.model.spaces.find((sp) => sp.id === spaceId)?.agent)
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

  /**
   * Take over an orphaned group (its owner session is gone) with every tab in it: the mark is
   * re-stamped with the adopter's name (the group's own `createdAt` stays), and the former
   * owner's name, when known, is returned for the result to say.
   */
  adopt(s: AgentSession, folder: Folder): string | null {
    const was = this.orphanWas(folder.id)
    this.orphans.delete(folder.id)
    s.groupIds.add(folder.id)
    folder.agent = { name: s.name, createdAt: folder.agent?.createdAt ?? Date.now() }
    this.memo(s).groups.set(folder.id, folder.name)
    if (!s.homeGroupId) s.homeGroupId = folder.id
    this.browser.state.commit()
    return was
  }

  /**
   * Rename the agent (`zen_session rename`): the label of its cursor, badges and home group, and
   * the name its live groups' marks carry.
   */
  rename(s: AgentSession, name: string): void {
    const before = s.name
    if (s.claimId || this.requireName) {
      const verdict = checkAgentName(name, {
        clientName: s.client?.name,
        taken: this.takenNames(s)
      })
      if (!verdict.ok) throw new RpcError(-32602, `Refused: ${verdict.reason}.`)
      s.name = verdict.name
    } else s.name = cleanName(name)
    this.saveClaim(s)
    const m = this.browser.state.model
    for (const id of s.groupIds) {
      const f = m.folders[id]
      if (f) f.agent = { name: s.name, createdAt: f.agent?.createdAt ?? Date.now() }
    }
    const home = s.homeGroupId ? m.folders[s.homeGroupId] : undefined
    if (home && home.name === homeGroupName({ name: before, id: s.id }))
      this.browser.updateFolder(home.id, { name: homeGroupName(s) })
    this.browser.state.commit()
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
        if (owner) return owner.id === s.id
        return !(t.folderId && this.heldBy(t.folderId))
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
   * An agent group without a live owner: a marked folder whose session is gone – this run or
   * before a restart, wherever the folder sits – or one a session of this run left (the
   * in-memory record, which also knows when). Where a folder sits says nothing: the user's
   * folder in the Agents space stays the user's.
   */
  isOrphan(folderId: string): boolean {
    const folder = this.browser.state.model.folders[folderId]
    if (!folder) {
      this.orphans.delete(folderId)
      return false
    }
    if (this.groupOwner(folderId) || this.heldBy(folderId)) return false
    return Boolean(folder.agent) || this.orphans.has(folderId)
  }

  /**
   * The former owner's name of an orphaned group, when known: the session that left it this
   * run, else the name its mark carries (null when the mark's maker is unknown, and for a group
   * that is not orphaned at all).
   */
  orphanWas(folderId: string): string | null {
    if (this.groupOwner(folderId)) return null
    const known = this.orphans.get(folderId)?.ownerName
    if (known) return known
    return this.browser.state.model.folders[folderId]?.agent?.name || null
  }

  /** Every group that is an agent's: owned by a live session, or orphaned (marked, no owner). */
  agentGroups(): Folder[] {
    const m = this.browser.state.model
    return Object.values(m.folders).filter(
      (f) =>
        this.groupOwner(f.id) !== undefined ||
        this.heldBy(f.id) !== undefined ||
        this.isOrphan(f.id)
    )
  }

  /** Who the tab belongs to, from the session's point of view. */
  owner(s: AgentSession, tab: Tab): Owner {
    const live = this.ownerOf(tab)
    if (live) return live.id === s.id ? { kind: 'you' } : { kind: 'agent', session: live }
    const held = tab.folderId ? this.heldBy(tab.folderId) : undefined
    if (held) return { kind: 'held', name: held.name }
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
        return `owned by ${JSON.stringify(o.session.name)}${this.ghostLabel(o.session)}`
      case 'orphaned':
        return o.was ? `orphaned, was ${JSON.stringify(o.was)}` : 'orphaned'
      case 'held':
        return `owned by ${JSON.stringify(o.name)}, away – kept for it`
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
      if (o.kind === 'held')
        throw new RpcError(
          UNAUTHORIZED,
          `Tab ${tab.id} belongs to agent ${JSON.stringify(o.name)}, which is away and keeps its groups until it ends its session – it cannot be addressed, not even with allowForeign. ${yours()}`
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
          return o ? o.id === s.id : !this.heldBy(f.id)
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
      const held = this.heldBy(folder.id)
      if (held)
        throw new RpcError(
          UNAUTHORIZED,
          `Group ${folder.id} ${JSON.stringify(folder.name)} belongs to agent ${JSON.stringify(held.name)}, which is away and keeps it until it ends its session. ${yours()}`
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

  /** ", quiet 5 min – adoptable" after a ghost's name in listings; empty for a working agent. */
  ghostLabel(o: AgentSession): string {
    return this.isGhost(o) ? `, quiet ${describeIdle(this.idleFor(o))} – adoptable` : ''
  }

  /** How long the session has been quiet, in ms. */
  idleFor(s: AgentSession): number {
    return Math.max(0, Date.now() - s.lastActiveAt)
  }

  /**
   * A connected session quiet past `GHOST_IDLE_MS`: to the other agents as good as gone – its
   * client most likely dropped without a DELETE – so its groups may be adopted.
   */
  isGhost(s: AgentSession): boolean {
    return !s.claimId && !s.parked && this.idleFor(s) >= GHOST_IDLE_MS
  }

  /**
   * The orphaned groups a session of the same client name left behind (`zen_session end`
   * without closeTabs, a restart, an expired session) – what `adopt` without a groupId takes
   * back. The name is the best identity a client has across sessions; an agent that renamed
   * itself finds its groups under the new name.
   */
  ownOrphans(s: AgentSession): Folder[] {
    return this.agentGroups().filter(
      (g) => this.isOrphan(g.id) && this.orphanWas(g.id)?.toLowerCase() === s.name.toLowerCase()
    )
  }

  /**
   * The group an agent wants to adopt: by id, unique id prefix or name. An orphaned group (no
   * live owner) is anyone's to take. A connected session's group is refused – unless that
   * session is a ghost (`isGhost`), or the adopter passes `force: true`, asserting the user
   * asked for the takeover; then the former owner is named in the answer, for `takeOver` to
   * tell it. Every other kind of group is refused with the reason.
   */
  resolveOrphan(
    s: AgentSession,
    ref: unknown,
    opts: { force?: boolean } = {}
  ): { folder: Folder; from: AgentSession | null } {
    const m = this.browser.state.model
    const orphans = this.agentGroups().filter((g) => this.isOrphan(g.id))
    const ghosts = this.agentGroups().filter((g) => {
      const o = this.groupOwner(g.id)
      return o && o.id !== s.id && this.isGhost(o)
    })
    const list = (): string => {
      const parts: string[] = []
      if (orphans.length)
        parts.push(
          `Orphaned groups: ${orphans.map((g) => `${g.id} ${JSON.stringify(g.name)}${this.orphanWas(g.id) ? ` (was ${JSON.stringify(this.orphanWas(g.id))}'s)` : ''}`).join(', ')}.`
        )
      if (ghosts.length)
        parts.push(
          `Groups of agents quiet for over ${Math.round(GHOST_IDLE_MS / 60_000)} min (adoptable too): ${ghosts.map((g) => `${g.id} ${JSON.stringify(g.name)} (${JSON.stringify(this.groupOwner(g.id)!.name)}, idle ${describeIdle(this.idleFor(this.groupOwner(g.id)!))})`).join(', ')}.`
        )
      if (!parts.length)
        parts.push(
          'There are no orphaned groups right now (zen_groups {"action":"list","scope":"all"} shows every agent group).'
        )
      return parts.join(' ')
    }
    if (typeof ref !== 'string' || !ref.trim())
      throw new RpcError(
        -32602,
        `adopt needs groupId: the group to take over${this.ownOrphans(s).length ? '' : ' (no orphaned group was left by a session named like yours, so there is nothing to take back without one)'}. ${list()}`
      )
    const wanted = ref.trim()
    const matches = (f: Folder): boolean =>
      f.id === wanted || f.id.startsWith(wanted) || f.name.toLowerCase() === wanted.toLowerCase()
    const found = orphans.filter(matches)
    if (found.length === 1) return { folder: found[0], from: null }
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
    if (o?.claimId)
      throw new RpcError(
        UNAUTHORIZED,
        `Group ${folder.id} ${JSON.stringify(folder.name)} belongs to agent ${JSON.stringify(o.name)}, a named session that owns its groups until it ends its session – no other agent can adopt or force it; only the user can close it. ${list()}`
      )
    const held = this.heldBy(folder.id)
    if (held)
      throw new RpcError(
        UNAUTHORIZED,
        `Group ${folder.id} ${JSON.stringify(folder.name)} belongs to agent ${JSON.stringify(held.name)}, which is away and keeps it until it ends its session – no other agent can adopt or force it; only the user can close it. ${list()}`
      )
    if (o) {
      if (opts.force || this.isGhost(o)) return { folder, from: o }
      throw new RpcError(
        UNAUTHORIZED,
        `Group ${folder.id} ${JSON.stringify(folder.name)} belongs to agent ${JSON.stringify(o.name)}, which is still connected and was active ${describeIdle(this.idleFor(o))} ago – only orphaned groups, and groups of agents quiet for over ${Math.round(GHOST_IDLE_MS / 60_000)} min, can be adopted. If the user asked you to take it over anyway, pass force: true (the other agent is told). ${list()}`
      )
    }
    throw new RpcError(
      UNAUTHORIZED,
      `Group ${folder.id} ${JSON.stringify(folder.name)} is the user's folder, not an orphaned agent group – only groups whose agent is gone can be adopted. ${list()}`
    )
  }

  /**
   * Take a group from a connected session – a ghost's, or with the user's permission (`force`):
   * the former owner loses the group and its tabs' page state, is told in its next result, and
   * the adopter's mark goes on the group (`adopt`). Returns the former owner's name.
   */
  takeOver(s: AgentSession, from: AgentSession, folder: Folder, forced: boolean): string {
    if (from.claimId)
      throw new RpcError(UNAUTHORIZED, `Group ${folder.id} belongs to a named agent session`)
    for (const t of folderTabs(this.browser.state.model, folder.id)) this.detach(from, t.id)
    from.groupIds.delete(folder.id)
    if (from.homeGroupId === folder.id) from.homeGroupId = null
    this.memos.get(from.id)?.groups.delete(folder.id)
    const n = folderTabs(this.browser.state.model, folder.id).length
    from.notices.push(
      `Notice: agent ${JSON.stringify(s.name)} took over your group ${folder.id} ${JSON.stringify(folder.name)} with its ${n} tab${n === 1 ? '' : 's'} (${forced ? 'the user asked for it' : `you had been quiet for ${describeIdle(this.idleFor(from))}`}). It is not yours any more: do not act on its tabs.`
    )
    this.log(
      `group ${folder.id} taken over by ${s.id} (${s.name}) from ${from.id} (${from.name}, ${forced ? 'forced' : 'ghost'})`
    )
    this.adopt(s, folder)
    return from.name
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
    win: ZenWindow = this.groupWindow(group)
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
      this.degrade(
        s,
        'lease',
        `foreground: another agent, ${JSON.stringify(holder.name)}, holds the screen – acted in background`
      )
      return false
    }
    this.leases.set(win.id, { sessionId: s.id, at: this.clock() })
    return true
  }

  /**
   * Whether the session may bring a tab in front of the user – change the user's space and
   * active tab: it asked for the screen (`zen_mode` with `takeScreen: true`), or the user set
   * foreground as the default in Settings, which hands agents the screen by default.
   */
  mayTakeScreen(s: AgentSession): boolean {
    return s.takeScreen || this.settings.defaultMode === 'foreground'
  }

  /** Whether the tab is what the user sees in the window: its space shown, it selected there. */
  isShown(tab: Tab, win: ZenWindow): boolean {
    const space = win.activeSpace()
    return (
      win.activeSpaceId === (tab.spaceId ?? win.activeSpaceId) &&
      win.selectedTabIn(space) === tab.id
    )
  }

  /**
   * Foreground mode's promise – the tab in front of the user before the action – kept only
   * when the session may use the screen: the user is already looking at the tab, or the agent
   * took the screen (`mayTakeScreen`). Foreground used to bring the tab in front by itself,
   * switching the user from the space they were in to the Agents space and making the agent's
   * tab the active one, with no word from the user; now that takes the explicit opt-in, and
   * without it the call runs in the background and the result says so (`degraded`, cause
   * `screen`) – as it does while another agent holds the screen lease (cause `lease`). Returns
   * whether the tab is in front now.
   */
  private bringInFront(s: AgentSession, tab: Tab, win: ZenWindow): boolean {
    if (s.mode !== 'foreground') return false
    const shown = this.isShown(tab, win)
    if (!shown && !this.mayTakeScreen(s)) {
      this.degrade(
        s,
        'screen',
        `foreground: tab ${tab.id} is not what the user is looking at and you have not taken the screen – acted in background. ${TAKE_SCREEN_HINT}`
      )
      return false
    }
    if (!this.foreground(s, win)) return false
    if (!shown) this.browser.tabs.activateTab(tab.id, win)
    return true
  }

  /**
   * Whether a tab the session is about to open goes in front of the user: foreground mode with
   * the screen (`mayTakeScreen`) and the lease. Otherwise it opens in the background and the
   * result says so.
   */
  openInFront(s: AgentSession, win: ZenWindow = this.agentWindow()): boolean {
    if (s.mode !== 'foreground') return false
    if (!this.mayTakeScreen(s)) {
      this.degrade(
        s,
        'screen',
        `foreground: your new tab opened in the background – you have not taken the screen. ${TAKE_SCREEN_HINT}`
      )
      return false
    }
    return this.foreground(s, win)
  }

  // ---------------------------------------------------------------------------
  // Page access (used by the tools)
  // ---------------------------------------------------------------------------

  tabJson(s: AgentSession, t: Tab): Record<string, unknown> {
    const m = this.browser.state.model
    const space = t.spaceId ? m.spaces.find((sp) => sp.id === t.spaceId) : null
    const folder = t.folderId ? m.folders[t.folderId] : null
    const o = this.owner(s, t)
    const win = this.browser.tabs.windowFor(t.id)
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
              : o.kind === 'held'
                ? { kind: 'agent', name: o.name, away: true }
                : { kind: 'user' },
      usersActiveTab: this.browser.tabs.activeTabFor(win)?.id === t.id
    }
  }

  /** The agent's durable session as it sees it: named or not, and the key that resumes it. */
  sessionJson(s: AgentSession): Record<string, unknown> {
    const claim = this.claims.get(s.claimId)
    if (!claim) return { named: false, required: this.requireName }
    return { named: true, name: claim.name, key: claim.key, since: claim.createdAt }
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
      session: this.sessionJson(s),
      groups: this.groupsOf(s).map((g) => ({
        id: g.id,
        name: g.name,
        home: g.id === s.homeGroupId,
        space: m.spaces.find((sp) => sp.id === g.spaceId)?.name ?? null,
        tabs: folderTabs(m, g.id).map((t) => ({ id: t.id, title: titleOf(t), url: t.url }))
      })),
      agents: [...this.sessions.values()]
        .filter((o) => o.id !== s.id && (o.approved || o.pending) && !o.parked)
        .map((o) => ({ name: o.name, mode: o.mode, groups: o.groupIds.size, pending: o.pending })),
      prompts: {
        routed: this.promptKinds(),
        waiting: this.promptsOf(s)
      },
      server: {
        url: this.status.url,
        running: this.status.running,
        diagnostics: this.diagnosticsSnapshot()
      },
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
    view.setAgentDriven?.(false)
    view.interceptAgentPrompts?.(false)
    void this.evalPage(view, pageDispose(s.id)).catch(() => undefined)
    for (const node of frames?.nodes ?? []) {
      if (node.id === 0) continue
      void view.executeJavaScript(pageDispose(s.id), node.id).catch(() => undefined)
    }
  }

  /**
   * Get the tab's live page ready for an action: load it if it was unloaded, wake it if the
   * governor froze it and, in foreground mode with the screen (`bringInFront`), bring it in
   * front of the user.
   */
  async prepare(
    s: AgentSession,
    tabId: string,
    opts: { activate?: boolean } = {}
  ): Promise<TabView> {
    const tabs = this.browser.tabs
    const tab = tabs.tab(tabId)
    if (!tab) throw new RpcError(-32002, `Tab ${tabId} is gone`)
    const pending = this.agentDialogs.get(tabId)
    if (pending)
      throw new RpcError(
        -32002,
        `${describeDialog(pending.dialog)}; the page is blocked until it is answered. browser_handle_dialog {"tabId":"${tabId}","accept":true} (or false) answers it.`
      )
    const win = tabs.windowFor(tabId)
    if (opts.activate !== false) this.bringInFront(s, tab, win)
    if (this.suspectTabs.has(tabId)) await this.revive(s, tabId)
    let view = tabs.view(tabId)
    if (!view) {
      view = tabs.ensureLoaded(tabId, win)
      if (!view) throw new RpcError(-32002, `Tab ${tabId} could not be loaded`)
      // A blank tab has nothing to navigate to: waiting for a navigation to start would only cost the grace.
      await this.waitForLoad(tabId, 15_000, { expectNavigation: hasPageToLoad(tab.url) })
    }
    if (tab.frozen) await this.browser.governor.thaw(tabId, true)
    view.setBackgroundThrottling?.(false)
    // Off screen, the page is the agent's to drive hidden: a host whose hidden pages have no
    // layout viewport and paint nothing lays it out and paints it where the user cannot see it
    // (`TabView.setAgentDriven`). A tab in front of the user is the layout's as before.
    view.setAgentDriven?.(!this.isShown(tab, win))
    // The page's file choosers and print come to the agent (`AgentService.takesPrompt`) instead
    // of opening the system's dialog; the host asks per request, so a tab shown to the user later
    // still gets its native UI.
    if (this.promptKinds().length) view.interceptAgentPrompts?.(true)
    return view
  }

  /**
   * Wait until the tab's main frame finished loading (or the timeout passed). With
   * `expectNavigation` a navigation was just requested: hosts report its start asynchronously –
   * Android's WebView on a slow device well after the 120 ms below – so an idle tab that shows no
   * sign of it yet is given a moment to begin before it counts as loaded, or the caller would
   * snapshot the previous page. The grace ends at the first sign: `loading` seen on, the tab's
   * URL moved, or the view committed another document (a tab created with its URL never changes
   * it, so the view's own URL is what tells a fresh view's load from an idle tab).
   */
  async waitForLoad(
    tabId: string,
    timeoutMs: number,
    opts: { expectNavigation?: boolean } = {}
  ): Promise<boolean> {
    const started = Date.now()
    const before = this.browser.tabs.tab(tabId)?.url
    const viewBefore = this.browser.tabs.view(tabId)?.getURL() ?? ''
    let graceUntil = opts.expectNavigation ? started + NAVIGATION_START_GRACE_MS : started
    // Navigation starts asynchronously: give `loading` a moment to flip on before we look at it.
    await sleep(120)
    for (;;) {
      const tab = this.browser.tabs.tab(tabId)
      const view = this.browser.tabs.view(tabId)
      if (!tab || !view || view.isDestroyed()) return false
      if (tab.loading || tab.url !== before || view.getURL() !== viewBefore) graceUntil = started
      if (!tab.loading) {
        if (Date.now() < graceUntil) {
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

  /**
   * A tab whose last call ran into the deadline: check that its page answers within
   * `PAGE_PROBE_MS`; one that does not has its load stopped, then is reloaded – a hung page is
   * worth less to the agent than a fresh one, and the result says so.
   */
  private async revive(s: AgentSession, tabId: string): Promise<void> {
    this.suspectTabs.delete(tabId)
    const view = this.browser.tabs.view(tabId)
    if (!view || view.isDestroyed()) return
    if (await this.answers(view)) return
    view.stop()
    if (await this.answers(view)) return
    view.reload(false)
    await this.waitForLoad(tabId, 15_000, { expectNavigation: true })
    const note = `Note: the page in tab ${tabId} had stopped responding and was reloaded; refs from before are stale.`
    const state = this.callState(s)
    if (!state.notes.includes(note)) state.notes.push(note)
    this.log(`session ${s.id}: tab ${tabId} unresponsive, reloaded`)
  }

  /** Whether the page runs a trivial script within `PAGE_PROBE_MS`. */
  private async answers(view: TabView): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | null = null
    const late = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.pageProbeMs)
    })
    try {
      return await Promise.race([
        this.evalPage(view, '1').then(
          () => true,
          () => false
        ),
        late
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // ---------------------------------------------------------------------------
  // Agent page dialogs
  // ---------------------------------------------------------------------------

  /**
   * A page dialog on an agent's tab (`PageDialogService.ask` routes it here): held for the
   * agent to answer with `browser_handle_dialog`, never shown to the user. A running call of the
   * owner returns at once with the dialog; unanswered for `AGENT_DIALOG_TTL_MS` it is dismissed,
   * so the page is never blocked for good.
   */
  onPageDialog(dialog: PageDialog): Promise<PageDialogResponse> {
    this.dismissAgentDialog(dialog.tabId)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.agentDialogs.get(dialog.tabId)?.dialog.id !== dialog.id) return
        this.agentDialogs.delete(dialog.tabId)
        this.log(`dialog on tab ${dialog.tabId} dismissed unanswered`)
        resolve({ accepted: false, value: null })
      }, this.dialogTtlMs)
      this.agentDialogs.set(dialog.tabId, { dialog, resolve, timer })
      const tab = this.browser.tabs.tab(dialog.tabId)
      const owner = tab ? this.ownerOf(tab) : undefined
      if (!owner) return
      const waiter = this.dialogWaiters.get(owner.id)
      if (waiter) waiter(dialog.tabId)
      else
        owner.notices.push(
          `Notice: ${describeDialog(dialog)}. browser_handle_dialog {"tabId":"${dialog.tabId}","accept":true} (or false) answers it; unanswered it is dismissed after ${Math.round(this.dialogTtlMs / 1000)} s.`
        )
    })
  }

  /** Answer the pending dialog of an agent's tab as cancelled (its tab went away, the session ended). */
  dismissAgentDialog(tabId: string): void {
    const d = this.agentDialogs.get(tabId)
    if (!d) return
    this.agentDialogs.delete(tabId)
    clearTimeout(d.timer)
    d.resolve({ accepted: false, value: null })
  }

  /** The dialog waiting on one of the agent's tabs, if any. */
  pendingDialog(tabId: string): PageDialog | null {
    return this.agentDialogs.get(tabId)?.dialog ?? null
  }

  /** `browser_handle_dialog`: answer the dialog on the tab. Returns the dialog answered. */
  answerDialog(tabId: string, accept: boolean, text?: string): PageDialog {
    const d = this.agentDialogs.get(tabId)
    if (!d) throw new RpcError(-32002, `No dialog is open on tab ${tabId}`)
    this.agentDialogs.delete(tabId)
    clearTimeout(d.timer)
    d.resolve({ accepted: accept, value: accept ? (text ?? d.dialog.defaultValue) : null })
    return d.dialog
  }

  // ---------------------------------------------------------------------------
  // Agent prompts (file choosers, permissions, sign-ins… – `AgentPromptQueue`)
  // ---------------------------------------------------------------------------

  /** The prompt kinds this host hands to agents (`HostCapabilities.agentPrompts`). */
  promptKinds(): readonly AgentPromptKind[] {
    const kinds = this.browser.platform.capabilities.agentPrompts
    return Array.isArray(kinds) ? kinds : []
  }

  /**
   * Whether a native prompt of `kind` the tab raised is its agent's to answer: the host routes
   * that kind, and the tab is an agent's the way its page dialogs are (`takesDialog`). Anything
   * else – a user's tab, a held tab in front of the user – keeps the native UI it always had.
   */
  takesPrompt(tabId: string | null | undefined, kind: AgentPromptKind): boolean {
    if (!tabId || !this.promptKinds().includes(kind)) return false
    return this.takesDialog(tabId)
  }

  /**
   * Hand a native prompt to the tab's agent instead of showing it: the handle's `result` is the
   * answer (the agent's, the default once it waited `promptTtlMs`, or the dismissal). Null when
   * the prompt is not the agent's (`takesPrompt`): the caller shows its UI as before.
   */
  routePrompt<T>(
    spec: Omit<AgentPromptSpec<T>, 'ttlMs'> & { ttlMs?: number }
  ): AgentPromptHandle<T> | null {
    if (!this.takesPrompt(spec.tabId, spec.kind)) return null
    return this.prompts.open({ ...spec, ttlMs: spec.ttlMs ?? this.promptTtlMs })
  }

  /** The prompts waiting on the session's tabs, oldest first. */
  promptsOf(s: AgentSession, tabId?: string): AgentPrompt[] {
    const owned = new Set(this.ownedTabs(s).map((t) => t.id))
    return this.prompts.list(tabId).filter((p) => owned.has(p.tabId))
  }

  /** `browser_respond_prompt`: the agent's answer to a prompt on one of its tabs. */
  answerPrompt(s: AgentSession, id: string, answer: AgentPromptAnswer): AgentPrompt {
    const p = this.prompts.get(id)
    if (!p || this.driver(p.tabId)?.id !== s.id)
      throw new RpcError(
        -32002,
        `No prompt ${id} is waiting on your tabs (it was answered, timed out or withdrawn)`
      )
    return this.prompts.answer(id, { ...answer, [ANSWER_FROM_THIS_COMPUTER]: this.isLocal(s) })
  }

  /** The tabs of the agent that holds `tabId` (the tab itself when its agent is away). */
  agentTabsOf(tabId: string): string[] {
    const owner = this.driver(tabId)
    return owner ? this.ownedTabs(owner).map((t) => t.id) : [tabId]
  }

  /** Whether the agent runs on this computer, so the paths it names are this computer's files. */
  isLocal(s: AgentSession): boolean {
    return s.transport === 'stdio' || isLoopbackAddress(s.remoteAddress)
  }

  /** `PermissionService.agentPrompts`: permission requests (and desktop app launches) of agents' tabs. */
  permissionPrompts(): AgentPermissionPrompts {
    return {
      takes: (tabId) =>
        this.takesPrompt(tabId, 'permission') || this.takesPrompt(tabId, 'external-protocol'),
      ask: (request, details) => {
        const tabId = request.tabId
        if (!tabId) return null
        const external = details.externalUrl !== undefined
        const handle = this.routePrompt(
          permissionSpec(
            { ...request, tabId },
            external ? { externalUrl: details.externalUrl } : {}
          )
        )
        return handle?.result ?? null
      }
    }
  }

  /**
   * A file chooser the page of an agent's tab opened (`TabViewEvents.onFileChooser`): the agent
   * answers it with `browser_respond_prompt` or `browser_file_upload`. A tab that is not an
   * agent's gets the system's chooser from its host.
   */
  /**
   * "Ask where to save each file" (the setting, the caller's `saveAs`, a "Save As…") for a download
   * an agent's tab started: the agent names the file, which stays in the Downloads folder. Null
   * when the tab is not an agent's: the host shows its save dialog.
   */
  downloadDestination(
    tabId: string | null,
    download: { url: string; filename: string; mimeType: string; totalBytes: number }
  ): Promise<DownloadDestination> | null {
    if (!tabId) return null
    return this.routePrompt(downloadSpec(tabId, download))?.result ?? null
  }

  onFileChooser(tabId: string, request: FileChooserRequest): Promise<FileChooserAnswer> {
    const handle = this.routePrompt(fileChooserSpec(tabId, request))
    return handle ? handle.result : Promise.resolve({ kind: 'user' })
  }

  /**
   * `window.print()` or a File System Access picker on an agent's tab: nothing is shown, the agent
   * hears of it. `showOpenFilePicker` becomes the page's file chooser (`onFileChooser`); a save
   * or directory picker is refused, as a cancelled one would be.
   */
  onPagePrompt(tabId: string, prompt: PagePromptRequest): 'agent' | 'user' {
    const kind: AgentPromptKind = prompt.kind === 'print' ? 'print' : 'file-chooser'
    if (!this.takesPrompt(tabId, kind)) return 'user'
    if (prompt.kind === 'file-system-access' && prompt.picker === 'open') return 'agent'
    const owner = this.driver(tabId)
    owner?.notices.push(
      prompt.kind === 'print'
        ? `Notice: the page in tab ${tabId} called window.print(); nothing was printed and no dialog shown. browser_take_screenshot shows the page if that is what you need.`
        : `Notice: the page in tab ${tabId} asked for a ${prompt.picker === 'save' ? 'save-file' : 'folder'} picker (File System Access), which agents cannot answer; the page heard it was cancelled. Look for another way to get the file (a download link, an upload field).`
    )
    this.log(
      `tab ${tabId}: ${prompt.kind === 'print' ? 'print' : `${prompt.picker} picker`} kept from the user`
    )
    return 'agent'
  }

  private onPromptOpened(p: AgentPrompt): void {
    this.log(`prompt ${p.id} (${p.kind}) on tab ${p.tabId}: ${p.summary}`)
    this.browser.state.commitVolatile()
    const owner = this.driver(p.tabId)
    if (owner && p.blocking) this.promptWaiters.get(owner.id)?.(p)
  }

  /** What a call interrupted by a prompt the page waits on answers. */
  private promptResult(name: string, p: AgentPrompt): ToolResult {
    return {
      content: [
        {
          type: 'text',
          text: `${describePrompt(p, Date.now())}\nIt opened while ${name} ran; the page waits for your answer, so ${name} may not have finished – take a snapshot once you answered.`
        }
      ]
    }
  }

  /** The footer every result carries while prompts wait on the session's tabs (those the result does not already name). */
  private pendingPromptLines(s: AgentSession, already: string): string[] {
    const waiting = this.promptsOf(s).filter((p) => !already.includes(p.id))
    if (!waiting.length) return []
    const now = Date.now()
    return [
      `Waiting for your answer (${waiting.length} prompt${waiting.length === 1 ? '' : 's'}; browser_prompts lists them):`,
      ...waiting.map((p) => `- ${describePrompt(p, now)}`)
    ]
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

/**
 * The agent's name in a group name of S1's shapes – `<agent> · <id4>` (a home group) or
 * `<agent> · <id4> · <n>` (`zen_groups create` without a name), the id4 being four hex digits of
 * the session id – for the upgrade of groups made before the mark; empty when the name has
 * another shape (the agent named the group itself, and nothing says who it was).
 */
export function legacyGroupOwner(groupName: string): string {
  return /^(.+?) · [0-9a-f]{4}(?: · \d+)?$/.exec(groupName)?.[1] ?? ''
}

/** Who a client appears to be, for remembering its name: token, agent string and address. */
function clientKey(init: {
  token: string | null
  userAgent: string
  remoteAddress: string
}): string {
  return `${init.token ?? ''}|${init.userAgent}|${init.remoteAddress}`
}

/** The first text of a result, for the diagnostics' error log. */
function firstText(result: ToolResult): string {
  const c = result.content.find((c) => c.type === 'text') as { text: string } | undefined
  return c?.text ?? 'error'
}

function endpointUrl(host: string, port: number): string {
  return `http://${hostPort(host, port)}/mcp`
}

/** `host:port`, the host bracketed when it is an IPv6 address. */
function hostPort(host: string, port: number): string {
  const h = host.includes(':') ? `[${host}]` : host
  return `${h}:${port}`
}

/**
 * What a rejected `AgentTransport.start` said, as `agent.json` and the log carry it: the
 * host's error code and message, and the address and port it was asked to bind – off the error
 * where the host put them there (Node's `listen` errors carry `code`, `address` and `port`;
 * the desktop transport forwards them), else what the service asked for.
 */
function endpointError(error: unknown, settings: { port: number; lan: boolean }): EndpointError {
  const e = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown
    message?: unknown
    address?: unknown
    port?: unknown
  }
  return {
    code: typeof e.code === 'string' && e.code ? e.code : null,
    message:
      typeof e.message === 'string' && e.message ? e.message : 'Could not start the MCP server',
    address:
      typeof e.address === 'string' && e.address
        ? e.address
        : settings.lan
          ? '0.0.0.0'
          : '127.0.0.1',
    port: typeof e.port === 'number' && Number.isInteger(e.port) ? e.port : settings.port
  }
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

/** A page a fresh view has to load, as opposed to a blank tab (`zen://blank`, `about:blank`, no URL). */
function hasPageToLoad(url: string | undefined): boolean {
  return Boolean(url) && !isBlankTabUrl(url) && url !== 'about:blank'
}

function isTruthy(v: string | null): boolean {
  return v !== null && /^(1|true|yes|on)$/i.test(v)
}

function describeRemote(address: string): string {
  if (!address || isLoopbackAddress(address)) return 'this computer'
  return address.replace(/^::ffff:/, '')
}

/** A peer address on this computer: 127.0.0.0/8, ::1, or either mapped. */
function isLoopbackAddress(address: string): boolean {
  const bare = address.replace(/^::ffff:/i, '')
  return bare === '::1' || /^127(\.\d{1,3}){3}$/.test(bare)
}
