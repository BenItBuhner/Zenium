import { DurableObject } from 'cloudflare:workers'
import {
  RELAY_CLOSE,
  RELAY_PING,
  RELAY_PONG,
  RELAY_SUBPROTOCOL,
  parseRelayFrame,
  type RelayInit,
  type RelayRpc,
  type RelayToBrowser
} from '../../src/shared/agentRelay'
import { verifyDeviceToken, type RelayEnv } from './auth'
import {
  DEVICE_ARG,
  DEVICES_TOOL,
  augmentTools,
  describeDevices,
  initializeResult,
  negotiateVersion,
  pickDevice,
  type DeviceRecord,
  type DeviceView
} from './mcp'

/**
 * One account's relay: every browser of the account that allows agents holds a WebSocket here,
 * and every agent session of the account is answered here. The Worker (`index.ts`) checks the
 * tokens and routes each request to the account's object by the Clerk user id, so nothing in
 * this class ever sees another account.
 *
 * Sockets use the hibernation API: an idle browser costs no running object, and the ping/pong
 * keepalive is answered by the runtime without waking it.
 */

/** Headers the Worker sets on what it forwards here (stripped from anything a caller sent). */
export const H = {
  user: 'x-relay-user',
  device: 'x-relay-device',
  exp: 'x-relay-exp',
  client: 'x-relay-client',
  scopes: 'x-relay-scopes'
} as const

/** A call no browser answered by then fails; above the browser's own 45 s per-call deadline. */
const CALL_TIMEOUT_MS = 60_000
/** How long after its token's expiry a socket is still trusted, waiting for the renewal. */
const TOKEN_GRACE_S = 10 * 60
/** A browser must say hello this soon after connecting. */
const HELLO_TIMEOUT_MS = 15_000
/** Agent sessions unused this long are forgotten (the alarm sweeps them). */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000
const MAX_BODY_BYTES = 8 * 1024 * 1024

interface SocketState {
  deviceId: string
  /** Device token expiry, seconds since the epoch. */
  exp: number
  hello: boolean
  connectedAt: number
}

interface SessionRecord {
  id: string
  clientId: string
  init: RelayInit
  /** The browser this session used last (the default for its next call). */
  lastDevice: string | null
  /** Every browser that saw this session, so ending it reaches them all. */
  devices: string[]
  createdAt: number
  lastSeenAt: number
}

interface Pending {
  deviceId: string
  resolve: (message: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type JsonRpcId = string | number | null

const ok = (id: JsonRpcId, result: unknown) => ({ jsonrpc: '2.0', id, result })
const fail = (id: JsonRpcId, code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message }
})

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }
  })
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toolText(text: string, isError = true): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError }
}

export class AccountRelay extends DurableObject<RelayEnv> {
  private readonly pending = new Map<string, Pending>()

  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(RELAY_PING, RELAY_PONG))
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/connect') return this.acceptBrowser(request)
    if (url.pathname === '/mcp') return this.mcp(request)
    if (url.pathname === '/dev/user') return this.devUser(request)
    return new Response('Not found', { status: 404 })
  }

  // --- browsers ----------------------------------------------------------------------------

  private acceptBrowser(request: Request): Response {
    const deviceId = request.headers.get(H.device) ?? ''
    const exp = Number(request.headers.get(H.exp))
    if (!deviceId || !Number.isFinite(exp)) return new Response('Bad request', { status: 400 })
    // The same browser again (a reconnect racing the old socket's close): the old one goes.
    for (const old of this.ctx.getWebSockets(deviceId)) {
      this.dropDevice(deviceId, 'The browser reconnected; the call was lost. Try it again.')
      try {
        old.close(RELAY_CLOSE.REPLACED, 'replaced by a newer connection')
      } catch {
        /* already closing */
      }
    }
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server, [deviceId])
    const state: SocketState = { deviceId, exp, hello: false, connectedAt: Date.now() }
    server.serializeAttachment(state)
    void this.ensureAlarm()
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'sec-websocket-protocol': RELAY_SUBPROTOCOL }
    })
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const state = ws.deserializeAttachment() as SocketState | null
    if (!state) return
    const frame = typeof raw === 'string' ? parseRelayFrame(raw) : null
    if (!frame) {
      ws.close(RELAY_CLOSE.BAD_MESSAGE, 'unreadable frame')
      return
    }
    switch (frame.t) {
      case 'hello': {
        const kinds = ['desktop', 'laptop', 'phone', 'tablet'] as const
        const kind = kinds.find((k) => k === frame.kind) ?? 'desktop'
        const record: DeviceRecord = {
          id: state.deviceId,
          name: (typeof frame.name === 'string' && frame.name.trim().slice(0, 100)) || 'Zenium',
          kind,
          version: typeof frame.version === 'string' ? frame.version.slice(0, 40) : '',
          lastSeenAt: Date.now()
        }
        await this.ctx.storage.put(`d:${state.deviceId}`, record)
        ws.serializeAttachment({ ...state, hello: true } satisfies SocketState)
        this.send(ws, { t: 'welcome', deviceId: state.deviceId })
        return
      }
      case 'token': {
        const identity =
          typeof frame.token === 'string' ? await verifyDeviceToken(frame.token, this.env) : null
        const current = ws.deserializeAttachment() as SocketState
        if (!identity || identity.deviceId !== current.deviceId) {
          ws.close(RELAY_CLOSE.UNAUTHORIZED, 'token refused')
          return
        }
        ws.serializeAttachment({ ...current, exp: identity.exp } satisfies SocketState)
        return
      }
      case 'reply': {
        const rid = typeof frame.rid === 'string' ? frame.rid : ''
        const call = this.pending.get(rid)
        if (!call || call.deviceId !== state.deviceId) return
        this.pending.delete(rid)
        clearTimeout(call.timer)
        call.resolve(frame.message ?? null)
        return
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const state = ws.deserializeAttachment() as SocketState | null
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed')
    } catch {
      /* already closed */
    }
    if (!state) return
    await this.forget(ws, state)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    const state = ws.deserializeAttachment() as SocketState | null
    if (state) await this.forget(ws, state)
  }

  private async forget(ws: WebSocket, state: SocketState): Promise<void> {
    // A newer socket of the same device is not this one's to report.
    if (
      this.ctx
        .getWebSockets(state.deviceId)
        .some((s) => s !== ws && s.readyState === WebSocket.OPEN)
    )
      return
    this.dropDevice(state.deviceId, 'The browser went offline before it answered.')
    const record = await this.ctx.storage.get<DeviceRecord>(`d:${state.deviceId}`)
    if (record)
      await this.ctx.storage.put(`d:${state.deviceId}`, { ...record, lastSeenAt: Date.now() })
  }

  /** Fail every call waiting on a browser that is gone. */
  private dropDevice(deviceId: string, why: string): void {
    for (const [rid, call] of this.pending) {
      if (call.deviceId !== deviceId) continue
      this.pending.delete(rid)
      clearTimeout(call.timer)
      call.reject(new Error(why))
    }
  }

  private send(ws: WebSocket, frame: RelayToBrowser): void {
    ws.send(JSON.stringify(frame))
  }

  /** The device's live socket: open, said hello, and its token not past the grace. */
  private socketOf(deviceId: string, now = Date.now()): WebSocket | null {
    for (const ws of this.ctx.getWebSockets(deviceId)) {
      if (ws.readyState !== WebSocket.OPEN) continue
      const state = ws.deserializeAttachment() as SocketState | null
      if (!state?.hello) {
        if (state && now - state.connectedAt > HELLO_TIMEOUT_MS)
          ws.close(RELAY_CLOSE.BAD_MESSAGE, 'no hello')
        continue
      }
      if ((state.exp + TOKEN_GRACE_S) * 1000 < now) {
        ws.close(RELAY_CLOSE.UNAUTHORIZED, 'token expired')
        continue
      }
      return ws
    }
    return null
  }

  private async devices(now = Date.now()): Promise<DeviceView[]> {
    const records = await this.ctx.storage.list<DeviceRecord>({ prefix: 'd:', limit: 100 })
    const sessions = await this.ctx.storage.list<SessionRecord>({ prefix: 's:', limit: 500 })
    const agents = new Map<string, number>()
    for (const s of sessions.values())
      if (s.lastDevice) agents.set(s.lastDevice, (agents.get(s.lastDevice) ?? 0) + 1)
    return [...records.values()].map((d) => ({
      ...d,
      online: this.socketOf(d.id, now) !== null,
      agents: agents.get(d.id) ?? 0
    }))
  }

  // --- agents ------------------------------------------------------------------------------

  private async mcp(request: Request): Promise<Response> {
    const clientId = request.headers.get(H.client) ?? ''
    const method = request.method.toUpperCase()
    if (method === 'OPTIONS')
      return new Response(null, { status: 204, headers: { allow: 'POST, DELETE' } })
    if (method === 'GET')
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST, DELETE' } })
    const sessionId = request.headers.get('mcp-session-id')
    if (method === 'DELETE') {
      if (sessionId) await this.endSession(sessionId, clientId)
      return new Response(null, { status: 204 })
    }
    if (method !== 'POST')
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST, DELETE' } })
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) return new Response('Payload Too Large', { status: 413 })
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return json(fail(null, -32700, 'Body is not valid JSON'), 400)
    }
    const messages = Array.isArray(body) ? body : [body]
    const init = messages.find((m) => isObject(m) && m.method === 'initialize')
    const now = Date.now()
    let session: SessionRecord
    const headers: Record<string, string> = {}
    if (init && isObject(init)) {
      session = this.newSession(
        crypto.randomUUID(),
        clientId,
        isObject(init.params) ? init.params : {},
        now
      )
      headers['mcp-session-id'] = session.id
    } else {
      const id = sessionId?.trim() || `sl-${await shortHash(clientId)}`
      const stored = await this.ctx.storage.get<SessionRecord>(`s:${id}`)
      if (stored && stored.clientId !== clientId)
        return json(fail(null, -32600, 'Unknown session – initialize again'), 404)
      // An id this account does not know (forgotten after a week idle): the token already
      // proved who is asking, so the session is made again rather than 404ed.
      session = stored ?? this.newSession(id, clientId, metaInit(messages), now)
    }
    session.lastSeenAt = now
    const replies: unknown[] = []
    for (const message of messages) {
      const reply = await this.handle(session, message)
      if (reply) replies.push(reply)
    }
    await this.ctx.storage.put(`s:${session.id}`, session)
    void this.ensureAlarm()
    if (!replies.length) return new Response(null, { status: 202, headers })
    return json(Array.isArray(body) ? replies : replies[0], 200, headers)
  }

  private newSession(
    id: string,
    clientId: string,
    params: Record<string, unknown>,
    now: number
  ): SessionRecord {
    const info = isObject(params.clientInfo) ? params.clientInfo : {}
    return {
      id,
      clientId,
      init: {
        protocolVersion: negotiateVersion(params.protocolVersion),
        capabilities: isObject(params.capabilities) ? params.capabilities : {},
        clientInfo: {
          name: typeof info.name === 'string' ? info.name.slice(0, 80) : 'Agent',
          version: typeof info.version === 'string' ? info.version.slice(0, 40) : ''
        }
      },
      lastDevice: null,
      devices: [],
      createdAt: now,
      lastSeenAt: now
    }
  }

  private async handle(session: SessionRecord, message: unknown): Promise<unknown> {
    if (!isObject(message) || message.jsonrpc !== '2.0')
      return fail(null, -32600, 'Not a JSON-RPC 2.0 message')
    if (typeof message.method !== 'string') return null // a response: we never ask the agent anything
    if (!('id' in message)) return null // notifications/initialized and friends: nothing to forward
    const id = message.id as JsonRpcId
    const params = isObject(message.params) ? message.params : {}
    switch (message.method) {
      case 'initialize':
        return ok(id, initializeResult(params))
      case 'ping':
        return ok(id, {})
      case 'tools/list':
        return this.listTools(session, id)
      case 'tools/call':
        return this.callTool(session, id, message, params)
      case 'resources/list':
      case 'resources/templates/list':
      case 'prompts/list': {
        const empty =
          message.method === 'resources/list'
            ? { resources: [] }
            : message.method === 'prompts/list'
              ? { prompts: [] }
              : { resourceTemplates: [] }
        const pick = pickDevice(await this.devices(), undefined, session.lastDevice, Date.now())
        if (!pick.ok) return ok(id, empty)
        return this.forwardOrFail(session, pick.device.id, message, id)
      }
      default: {
        const pick = pickDevice(
          await this.devices(),
          params[DEVICE_ARG],
          session.lastDevice,
          Date.now()
        )
        if (!pick.ok) return fail(id, -32001, pick.message)
        return this.forwardOrFail(session, pick.device.id, message, id)
      }
    }
  }

  private async listTools(session: SessionRecord, id: JsonRpcId): Promise<unknown> {
    const devices = await this.devices()
    const online = devices.filter((d) => d.online)
    const target =
      online.find((d) => d.id === session.lastDevice) ??
      [...online].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0]
    if (target) {
      try {
        const reply = await this.forward(session, target.id, {
          jsonrpc: '2.0',
          id,
          method: 'tools/list',
          params: {}
        })
        const tools =
          isObject(reply) && isObject(reply.result) && Array.isArray(reply.result.tools)
            ? reply.result.tools
            : null
        if (tools) {
          await this.ctx.storage.put('tools', tools)
          return ok(id, { tools: augmentTools(tools) })
        }
        if (isObject(reply) && reply.error) return reply
      } catch {
        /* fall back to the last list a browser gave */
      }
    }
    const cached = (await this.ctx.storage.get<unknown[]>('tools')) ?? []
    return ok(id, { tools: augmentTools(cached) })
  }

  private async callTool(
    session: SessionRecord,
    id: JsonRpcId,
    message: Record<string, unknown>,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const name = params.name
    const args = isObject(params.arguments) ? { ...params.arguments } : {}
    const devices = await this.devices()
    const now = Date.now()
    if (name === DEVICES_TOOL)
      return ok(id, toolText(describeDevices(devices, session.lastDevice, now), false))
    const requested = args[DEVICE_ARG]
    delete args[DEVICE_ARG]
    const pick = pickDevice(devices, requested, session.lastDevice, now)
    if (!pick.ok) return ok(id, toolText(pick.message))
    const forwarded = { ...message, params: { ...params, arguments: args } }
    const reply = await this.forwardOrFail(session, pick.device.id, forwarded, id)
    // Say which browser answered when the agent did not choose and has more than one.
    const online = devices.filter((d) => d.online).length
    if (
      !requested &&
      online > 1 &&
      isObject(reply) &&
      isObject(reply.result) &&
      Array.isArray(reply.result.content)
    )
      reply.result.content = [
        { type: 'text', text: `(on ${JSON.stringify(pick.device.name)}, ${pick.device.id})` },
        ...reply.result.content
      ]
    return reply
  }

  private async forwardOrFail(
    session: SessionRecord,
    deviceId: string,
    message: Record<string, unknown>,
    id: JsonRpcId
  ): Promise<Record<string, unknown>> {
    try {
      const reply = await this.forward(session, deviceId, message)
      return isObject(reply) ? reply : fail(id, -32603, 'The browser sent no answer')
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      if (message.method === 'tools/call') return ok(id, toolText(why))
      return fail(id, -32603, why)
    }
  }

  /** Send one message to a browser and wait for its answer. */
  private forward(session: SessionRecord, deviceId: string, message: unknown): Promise<unknown> {
    const ws = this.socketOf(deviceId)
    if (!ws)
      return Promise.reject(
        new Error('That browser is offline. Call zen_devices to see which are online.')
      )
    if (session.lastDevice !== deviceId) session.lastDevice = deviceId
    if (!session.devices.includes(deviceId)) session.devices.push(deviceId)
    const rid = crypto.randomUUID()
    const frame: RelayRpc = {
      t: 'rpc',
      rid,
      session: session.id,
      client: {
        id: session.clientId,
        name: session.init.clientInfo.name,
        version: session.init.clientInfo.version
      },
      init: session.init,
      message
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid)
        reject(new Error(`The browser did not answer within ${CALL_TIMEOUT_MS / 1000} s.`))
      }, CALL_TIMEOUT_MS)
      this.pending.set(rid, { deviceId, resolve, reject, timer })
      try {
        this.send(ws, frame)
      } catch {
        clearTimeout(timer)
        this.pending.delete(rid)
        reject(new Error('The browser went offline.'))
      }
    })
  }

  private async endSession(id: string, clientId: string): Promise<void> {
    const session = await this.ctx.storage.get<SessionRecord>(`s:${id}`)
    if (!session || session.clientId !== clientId) return
    for (const deviceId of session.devices) {
      const ws = this.socketOf(deviceId)
      if (ws) this.send(ws, { t: 'end', session: id })
    }
    await this.ctx.storage.delete(`s:${id}`)
  }

  // --- housekeeping ------------------------------------------------------------------------

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_EVERY_MS)
  }

  override async alarm(): Promise<void> {
    const cutoff = Date.now() - SESSION_TTL_MS
    const sessions = await this.ctx.storage.list<SessionRecord>({ prefix: 's:', limit: 1000 })
    const stale = [...sessions].filter(([, s]) => s.lastSeenAt < cutoff).map(([k]) => k)
    if (stale.length) await this.ctx.storage.delete(stale.slice(0, 128))
    if (sessions.size || this.ctx.getWebSockets().length)
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_EVERY_MS)
  }

  /** Local testing (`DEV_AGENT_TOKEN`): which account the dev token stands for. */
  private async devUser(request: Request): Promise<Response> {
    if (request.method === 'PUT') {
      await this.ctx.storage.put('dev-user', await request.text())
      return new Response(null, { status: 204 })
    }
    return new Response((await this.ctx.storage.get<string>('dev-user')) ?? '', { status: 200 })
  }
}

/** A 2026-07-28 client sends no initialize: what it says about itself rides in `_meta`. */
function metaInit(messages: unknown[]): Record<string, unknown> {
  for (const m of messages) {
    if (!isObject(m) || !isObject(m.params) || !isObject(m.params._meta)) continue
    const meta = m.params._meta
    const pick = (key: string): unknown => meta[key] ?? meta[`io.modelcontextprotocol/${key}`]
    return {
      protocolVersion: pick('protocolVersion'),
      clientInfo: pick('clientInfo'),
      capabilities: pick('clientCapabilities') ?? pick('capabilities')
    }
  }
  return {}
}

async function shortHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest).slice(0, 12)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
