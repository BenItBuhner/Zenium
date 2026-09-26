import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/**
 * `zenium --mcp` (the .deb also keeps `zen-chromium --mcp` for one release): the stdio face of the
 * MCP server, for agent clients that launch a command rather than connect to a URL. The running
 * browser owns the server; this process relays each newline-delimited JSON-RPC message from
 * stdin to `http://127.0.0.1:<port>/mcp` (found in the profile's `zen/agent.json`, together with
 * the token that skips the approval prompt) and writes the responses to stdout. When stdin closes
 * the session is deleted and the process exits.
 *
 * The relay keeps the connection alive through what used to kill it (`StdioRelay`):
 * - A 404 `Unknown session` – the browser restarted, the session was deleted or expired – makes
 *   it start a new session as the Streamable HTTP spec asks of a client: it replays the client's
 *   own `initialize` and `notifications/initialized`, then retries the request once under the new
 *   session id. The client never learns; it keeps its tools and its ids.
 * - A connection failure makes it re-read `agent.json`: a browser restarted on another port or
 *   with a regenerated token is found again, and the browser not yet started is waited for a
 *   moment at `initialize` instead of failing the client for good.
 * - Requests run concurrently once the session exists, so a long tool call (a navigation's load
 *   wait) never holds back a ping or a tools/list behind it. Until the `initialize` response is
 *   out everything queues behind it, as a client must never see a second response first.
 * - Writes to a closed stdout (the client went away) end the relay instead of the process.
 * What happened is said on stderr, one line per event, which the harnesses show in their logs.
 */

/** How long `initialize` waits for the browser's endpoint to appear before giving up. */
const STARTUP_WAIT_MS = 15_000
const STARTUP_POLL_MS = 250
/** A tool call that has not answered by then is reported failed to the client (the server has no such limit). */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000

export interface RelayEndpoint {
  url: string
  token: string
}

export interface RelayOptions {
  /** The endpoint as `zen/agent.json` has it right now; null while the browser's server is not up. */
  readEndpoint: () => RelayEndpoint | null
  /** A response (or error) for the client, written to stdout. */
  write: (message: unknown) => void
  /** One line about an event, for stderr. */
  log?: (line: string) => void
  fetch?: typeof fetch
  /** Sleep, for the startup wait; tests replace it. */
  sleep?: (ms: number) => Promise<void>
  startupWaitMs?: number
}

interface RpcMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

export class StdioRelay {
  private endpoint: RelayEndpoint | null
  private sessionId: string | null = null
  private protocolVersion: string | null = null
  /** The client's own `initialize` (and `notifications/initialized`), replayed when the session is lost. */
  private initRequest: RpcMessage | null = null
  private initializedNote: RpcMessage | null = null
  /** Settles once the `initialize` response is out; every later message waits for it. */
  private ready: Promise<void> = Promise.resolve()
  /** A re-initialize in flight, shared by every request that hit the loss at once. */
  private reinit: Promise<boolean> | null = null
  private pending = new Set<Promise<void>>()
  private closed = false
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly startupWaitMs: number
  /** Sessions started (the first, and every renewal), for the tests and the log. */
  renewals = 0

  constructor(private readonly opts: RelayOptions) {
    this.endpoint = opts.readEndpoint()
    this.fetchImpl = opts.fetch ?? fetch
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.startupWaitMs = opts.startupWaitMs ?? STARTUP_WAIT_MS
  }

  /** The session the relay holds with the browser right now (null before initialize, or after a loss). */
  get session(): string | null {
    return this.sessionId
  }

  /** One line from stdin. Resolves once its response (if any) has been written. */
  handleLine(line: string): Promise<void> {
    const text = line.trim()
    if (!text || this.closed) return Promise.resolve()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this.write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return Promise.resolve()
    }
    const message = isMessage(parsed) ? parsed : null
    let run: Promise<void>
    if (message && message.method === 'initialize' && hasId(message)) {
      this.initRequest = message
      // Everything after the client's initialize waits for its response; the initialize itself
      // waits for whatever was in flight before it (a second initialize after a client-side reset).
      run = this.ready.then(() => this.relay(parsed, text, message))
      this.ready = run
    } else {
      if (message?.method === 'notifications/initialized') this.initializedNote = message
      run = this.ready.then(() => this.relay(parsed, text, message))
    }
    const tracked = run.catch(() => undefined)
    this.pending.add(tracked)
    void tracked.finally(() => this.pending.delete(tracked))
    return tracked
  }

  /** Stdin closed: let the requests in flight finish, then delete the session. */
  async close(): Promise<void> {
    this.closed = true
    await Promise.all([...this.pending])
    if (this.sessionId && this.endpoint) {
      await this.fetchImpl(this.endpoint.url, {
        method: 'DELETE',
        headers: {
          'mcp-session-id': this.sessionId,
          authorization: `Bearer ${this.endpoint.token}`
        }
      }).catch(() => undefined)
      this.sessionId = null
    }
  }

  // ---------------------------------------------------------------------------

  private async relay(parsed: unknown, text: string, message: RpcMessage | null): Promise<void> {
    const id = message && hasId(message) ? message.id : null
    const isInit = message?.method === 'initialize'
    try {
      if (isInit) await this.waitForEndpoint()
      const response = await this.post(text, { isInit })
      if (!response) return
      if (isInit) this.noteInitialized(response)
      if (Array.isArray(response)) for (const m of response) this.write(m)
      else this.write(response)
    } catch (error) {
      if (id === null || id === undefined) return
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: (error as Error).message || String(error) }
      })
    }
    void parsed
  }

  /**
   * POST one message under the current session. A 404 for a session we hold means the browser
   * lost it: the session is renewed (the client's own initialize replayed) and the message sent
   * once more. A connection failure has `agent.json` read again for a moved endpoint first.
   */
  private async post(
    body: string,
    opts: { isInit: boolean; renewed?: boolean; moved?: boolean }
  ): Promise<unknown> {
    const endpoint = this.requireEndpoint()
    // The client's own initialize opens a session of its own: no session header on it.
    const sent = opts.isInit ? null : this.sessionId
    let res: Response
    try {
      res = await this.fetchImpl(endpoint.url, {
        method: 'POST',
        headers: this.headers(endpoint, { session: !opts.isInit }),
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch (error) {
      if (!opts.moved && this.refreshEndpoint()) {
        this.log(`Zenium's endpoint changed (${this.endpoint?.url ?? 'gone'}); trying it`)
        return this.post(body, { ...opts, moved: true })
      }
      throw new Error(
        `Zenium is not reachable at ${endpoint.url}: ${(error as Error).message}. Is Zenium running with Settings → AI Agents on?`
      )
    }
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    if (res.status === 404 && sent && !opts.renewed) {
      if (await this.recoverFrom(sent)) return this.post(body, { ...opts, renewed: true })
      this.log(`session ${sent} was unknown to Zenium and could not be renewed`)
    }
    if (res.status === 202) return null
    const raw = await res.text()
    if (!raw) {
      if (res.ok) return null
      throw new Error(`Zenium answered HTTP ${res.status}`)
    }
    try {
      return JSON.parse(raw)
    } catch {
      throw new Error(`Zenium answered HTTP ${res.status} with a body that is not JSON`)
    }
  }

  /**
   * The session `lost` was refused: renew it – once, however many requests hit the loss at the
   * same time – or ride the renewal another request already started. True when there is a
   * session to retry under.
   */
  private async recoverFrom(lost: string): Promise<boolean> {
    if (this.sessionId === lost) {
      this.sessionId = null
      const renewed = await this.renewSession()
      if (renewed)
        this.log(
          `session ${lost} was unknown to Zenium (restarted or expired) – renewed as ${this.sessionId}`
        )
      return renewed
    }
    if (this.reinit) return this.reinit
    return this.sessionId !== null
  }

  /** Start a new session with the client's own introduction; one at a time. */
  private renewSession(): Promise<boolean> {
    if (this.reinit) return this.reinit
    const run = this.renewSessionNow().finally(() => {
      this.reinit = null
    })
    this.reinit = run
    return run
  }

  private async renewSessionNow(): Promise<boolean> {
    const init = this.initRequest
    if (!init) return false
    const endpoint = this.requireEndpoint()
    // The client's initialize as it sent it, under an id of ours: its response is not the client's
    // to see (it has its own), so it is read here and dropped.
    const replay = JSON.stringify({ ...init, id: `zenium-relay-renew-${++this.renewals}` })
    let res: Response
    try {
      res = await this.fetchImpl(endpoint.url, {
        method: 'POST',
        headers: this.headers(endpoint, { session: false }),
        body: replay,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch {
      return false
    }
    if (!res.ok) return false
    const sid = res.headers.get('mcp-session-id')
    let body: unknown = null
    try {
      body = JSON.parse(await res.text())
    } catch {
      /* the header is what matters */
    }
    if (!sid || (isMessage(body) && body.error)) return false
    this.sessionId = sid
    this.noteInitialized(body)
    const note = this.initializedNote ?? { jsonrpc: '2.0', method: 'notifications/initialized' }
    await this.fetchImpl(endpoint.url, {
      method: 'POST',
      headers: this.headers(endpoint),
      body: JSON.stringify(note),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    }).catch(() => undefined)
    return true
  }

  /** Remember the protocol version the browser answered `initialize` with, for the header. */
  private noteInitialized(response: unknown): void {
    if (!isMessage(response)) return
    const result = response.result as { protocolVersion?: unknown } | undefined
    if (result && typeof result.protocolVersion === 'string')
      this.protocolVersion = result.protocolVersion
  }

  private headers(
    endpoint: RelayEndpoint,
    opts: { session?: boolean } = {}
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${endpoint.token}`,
      'user-agent': 'zenium-mcp-stdio'
    }
    if (opts.session !== false && this.sessionId) headers['mcp-session-id'] = this.sessionId
    if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion
    return headers
  }

  /** The endpoint, read afresh when none is held. */
  private requireEndpoint(): RelayEndpoint {
    if (!this.endpoint) this.refreshEndpoint()
    if (!this.endpoint)
      throw new Error(
        'Zenium is not running with its MCP server enabled. Start Zenium and turn on Settings → AI Agents.'
      )
    return this.endpoint
  }

  /** Re-read `agent.json`; true when it names another endpoint than the one held. */
  private refreshEndpoint(): boolean {
    const fresh = this.opts.readEndpoint()
    const changed =
      (fresh?.url ?? null) !== (this.endpoint?.url ?? null) ||
      (fresh?.token ?? null) !== (this.endpoint?.token ?? null)
    if (fresh) this.endpoint = fresh
    return changed && fresh !== null
  }

  /** At `initialize`, give a browser that is still starting a moment to publish its endpoint. */
  private async waitForEndpoint(): Promise<void> {
    if (this.endpoint) return
    const until = Date.now() + this.startupWaitMs
    for (;;) {
      if (this.refreshEndpoint()) return
      if (Date.now() >= until) return
      await this.sleep(STARTUP_POLL_MS)
    }
  }

  private write(message: unknown): void {
    if (this.closed) return
    try {
      this.opts.write(message)
    } catch (error) {
      // The client's end of stdout is gone: nothing more can be said to it.
      this.closed = true
      this.log(`stdout closed (${(error as Error).message}); relay ends`)
    }
  }

  private log(line: string): void {
    this.opts.log?.(line)
  }
}

export async function runStdioShim(userDataDir: string): Promise<number> {
  const log = (line: string): void => {
    try {
      process.stderr.write(`zenium --mcp: ${line}\n`)
    } catch {
      /* stderr gone too */
    }
  }
  const relay = new StdioRelay({
    readEndpoint: () => readEndpoint(userDataDir),
    write: (message) => {
      process.stdout.write(JSON.stringify(message) + '\n')
    },
    log
  })
  if (!relay.session && !readEndpoint(userDataDir))
    log(
      'Zenium is not running with its MCP server enabled (or is still starting) – waiting for it at initialize. Start Zenium and turn on Settings → AI Agents.'
    )
  // A client that went away mid-write: end quietly rather than crash on EPIPE.
  process.stdout.on('error', () => {
    void relay.close()
  })
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    void relay.handleLine(line)
  })
  await new Promise<void>((resolve) => {
    rl.once('close', () => resolve())
  })
  await relay.close()
  return 0
}

export function readEndpoint(userDataDir: string): RelayEndpoint | null {
  try {
    const raw = JSON.parse(readFileSync(join(userDataDir, 'zen', 'agent.json'), 'utf8')) as {
      url?: string | null
      token?: string
      running?: boolean
    }
    if (!raw.running || !raw.url || !raw.token) return null
    return { url: raw.url, token: raw.token }
  } catch {
    return null
  }
}

function isMessage(v: unknown): v is RpcMessage {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function hasId(m: RpcMessage): m is RpcMessage & { id: string | number } {
  return typeof m.id === 'string' || typeof m.id === 'number'
}
