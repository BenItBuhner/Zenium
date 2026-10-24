import {
  RELAY_BEARER_PREFIX,
  RELAY_CLOSE,
  RELAY_CONNECT_PATH,
  RELAY_MCP_PATH,
  RELAY_PING,
  RELAY_PONG,
  RELAY_SUBPROTOCOL,
  parseRelayFrame,
  type BrowserToRelay,
  type RelayHello,
  type RelayRpc
} from '../../shared/agentRelay'
import type { AgentRemoteStatus } from '../../shared/types'
import { INTERNAL_ERROR, failure, isObject } from './jsonrpc'

/**
 * The browser's side of the hosted agent relay (`relay/` in this repository; wire format in
 * `shared/agentRelay.ts`): one outbound WebSocket to the relay, opened with the Zenium account's
 * device access token, over which agents signed in to the same account send their MCP calls.
 * Every call is handed to the browser's own MCP core (`AgentService.handleRelay`) – the same
 * code a local agent's call runs through – and its answer goes back on the socket.
 *
 * An outbound connection needs no open port, so it works behind any router, on desktop and in
 * the Android WebView alike. The connector keeps it up by itself: a dropped socket comes back
 * with backoff, a dead one is found by its missing pongs, and the token is renewed on the open
 * socket before the one it was opened with runs out.
 */

export interface RelaySocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export interface RelayConnectorHost {
  /** The relay's base address (`https://…`), or null when none is configured. */
  relayUrl(): string | null
  /** A current device access token, or null when the browser is not signed in. */
  accessToken(): Promise<string | null>
  device(): Omit<RelayHello, 't'>
  /** One agent message: resolves to the JSON-RPC response, or null for a notification. */
  onRpc(frame: RelayRpc): Promise<unknown>
  /** The agent ended its session at the relay. */
  onEnd(session: string): void
  onStatus(status: AgentRemoteStatus): void
  /** Open a WebSocket; the default is the platform's `WebSocket`. */
  openSocket?(url: string, protocols: string[]): RelaySocket
  log?(line: string): void
}

const OPEN = 1
const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 60_000
/** While signed out, how often the connector looks for a sign-in (one also restarts it). */
const SIGNED_OUT_RETRY_MS = 60_000
const PING_EVERY_MS = 25_000
/** Two pings without a pong: the connection is dead even if the socket has not noticed. */
const PONG_TIMEOUT_MS = 2 * PING_EVERY_MS + 5_000
/** Device tokens live an hour; a fresh one goes up well before. */
const TOKEN_RENEW_MS = 30 * 60 * 1000

export function relayMcpUrl(base: string): string {
  return `${base.replace(/\/+$/, '')}${RELAY_MCP_PATH}`
}

export function relayConnectUrl(base: string): string {
  return `${base.replace(/\/+$/, '').replace(/^http/i, 'ws')}${RELAY_CONNECT_PATH}`
}

export class RelayConnector {
  private socket: RelaySocket | null = null
  private running = false
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private renewTimer: ReturnType<typeof setInterval> | null = null
  private lastPongAt = 0
  /** Bumped by every start and stop, so a connect that was waiting on a token stands down. */
  private generation = 0
  private status: AgentRemoteStatus = { state: 'off', mcpUrl: null, error: null }

  constructor(private readonly host: RelayConnectorHost) {}

  get state(): AgentRemoteStatus {
    return this.status
  }

  get active(): boolean {
    return this.running
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.generation++
    this.attempt = 0
    void this.connect()
  }

  stop(): void {
    this.running = false
    this.generation++
    this.clearTimers()
    const socket = this.socket
    this.socket = null
    if (socket) {
      try {
        socket.close(1000, 'turned off')
      } catch {
        /* already closed */
      }
    }
    this.setStatus({ state: 'off', mcpUrl: null, error: null })
  }

  /** Connect again now: the sign-in or the address changed. */
  restart(): void {
    if (!this.running) return
    this.stop()
    this.start()
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.renewTimer) clearInterval(this.renewTimer)
    this.retryTimer = this.pingTimer = this.renewTimer = null
  }

  private setStatus(status: AgentRemoteStatus): void {
    const same =
      status.state === this.status.state &&
      status.mcpUrl === this.status.mcpUrl &&
      status.error === this.status.error
    this.status = status
    if (!same) this.host.onStatus(status)
  }

  private async connect(): Promise<void> {
    const generation = this.generation
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const base = this.host.relayUrl()
    if (!base) {
      this.setStatus({ state: 'no-relay', mcpUrl: null, error: null })
      return
    }
    const mcpUrl = relayMcpUrl(base)
    let token: string | null = null
    try {
      token = await this.host.accessToken()
    } catch {
      token = null
    }
    if (generation !== this.generation) return
    if (!token) {
      this.setStatus({ state: 'signed-out', mcpUrl, error: null })
      this.retryTimer = setTimeout(() => void this.connect(), SIGNED_OUT_RETRY_MS)
      return
    }
    this.setStatus({ state: 'connecting', mcpUrl, error: this.status.error })
    let socket: RelaySocket
    try {
      socket = this.open(relayConnectUrl(base), [
        RELAY_SUBPROTOCOL,
        `${RELAY_BEARER_PREFIX}${token}`
      ])
    } catch (error) {
      this.retry(mcpUrl, error instanceof Error ? error.message : String(error))
      return
    }
    this.socket = socket
    socket.onopen = () => {
      if (this.socket !== socket) return
      this.lastPongAt = Date.now()
      this.send({ t: 'hello', ...this.host.device() })
    }
    socket.onmessage = (event) => {
      if (this.socket !== socket) return
      this.onFrame(socket, mcpUrl, event.data)
    }
    socket.onerror = () => {
      /* the close that follows says what happened */
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.socket = null
      this.clearTimers()
      if (!this.running) return
      this.host.log?.(
        `relay connection closed (${event.code}${event.reason ? ` ${event.reason}` : ''})`
      )
      this.retry(mcpUrl, closeReason(event.code, event.reason))
    }
  }

  private open(url: string, protocols: string[]): RelaySocket {
    if (this.host.openSocket) return this.host.openSocket(url, protocols)
    const Ctor = (
      globalThis as { WebSocket?: new (url: string, protocols: string[]) => RelaySocket }
    ).WebSocket
    if (!Ctor) throw new Error('This platform has no WebSocket')
    return new Ctor(url, protocols)
  }

  private retry(mcpUrl: string, error: string): void {
    if (!this.running) return
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt)
    this.attempt = Math.min(this.attempt + 1, 10)
    const jitter = Math.round(delay * 0.2 * Math.random())
    this.setStatus({ state: this.attempt > 3 ? 'error' : 'connecting', mcpUrl, error })
    this.retryTimer = setTimeout(() => void this.connect(), delay + jitter)
  }

  private onFrame(socket: RelaySocket, mcpUrl: string, data: unknown): void {
    if (data === RELAY_PONG) {
      this.lastPongAt = Date.now()
      return
    }
    const frame = typeof data === 'string' ? parseRelayFrame(data) : null
    if (!frame) return
    switch (frame.t) {
      case 'welcome':
        this.attempt = 0
        this.lastPongAt = Date.now()
        this.setStatus({ state: 'connected', mcpUrl, error: null })
        this.host.log?.(`relay connected as device ${String(frame.deviceId)}`)
        this.startKeepalive(socket)
        return
      case 'rpc':
        void this.answer(frame as unknown as RelayRpc)
        return
      case 'end':
        if (typeof frame.session === 'string') this.host.onEnd(frame.session)
        return
    }
  }

  private async answer(frame: RelayRpc): Promise<void> {
    let message: unknown
    try {
      message = await this.host.onRpc(frame)
    } catch (error) {
      const id = isObject(frame.message) && 'id' in frame.message ? frame.message.id : null
      message = failure(
        (id ?? null) as string | number | null,
        INTERNAL_ERROR,
        error instanceof Error ? error.message : String(error)
      )
    }
    this.send({ t: 'reply', rid: frame.rid, message: message ?? null })
  }

  private startKeepalive(socket: RelaySocket): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.renewTimer) clearInterval(this.renewTimer)
    this.pingTimer = setInterval(() => {
      if (this.socket !== socket) return
      if (Date.now() - this.lastPongAt > PONG_TIMEOUT_MS) {
        this.host.log?.('relay connection stopped answering; reconnecting')
        try {
          socket.close(4000, 'no pong')
        } catch {
          /* gone */
        }
        // Some sockets never fire close after a silent network loss: act as if it had.
        socket.onclose?.({ code: 4000, reason: 'no pong' })
        return
      }
      this.sendText(RELAY_PING)
    }, PING_EVERY_MS)
    this.renewTimer = setInterval(() => {
      void this.host.accessToken().then((token) => {
        if (token && this.socket === socket) this.send({ t: 'token', token })
      })
    }, TOKEN_RENEW_MS)
  }

  private send(frame: BrowserToRelay): void {
    this.sendText(JSON.stringify(frame))
  }

  private sendText(text: string): void {
    const socket = this.socket
    if (!socket || socket.readyState !== OPEN) return
    try {
      socket.send(text)
    } catch {
      /* the close handler reconnects */
    }
  }
}

function closeReason(code: number, reason: string): string {
  if (code === RELAY_CLOSE.UNAUTHORIZED) return 'The relay refused this browser’s sign-in'
  if (code === RELAY_CLOSE.REPLACED) return 'Another connection from this browser took over'
  if (code === 1006 || code === 4000) return 'The connection to the relay was lost'
  return reason || `The relay closed the connection (${code})`
}
