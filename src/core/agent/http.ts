import { INVALID_REQUEST, PARSE_ERROR, UNAUTHORIZED, failure, isObject, isRequest } from './jsonrpc'
import type { McpProtocol, McpSession } from './protocol'

/**
 * The Streamable HTTP transport (MCP 2025-03-26 … 2025-11-25, plus the sessionless 2026-07-28
 * shape) as pure request → response functions. Hosts only parse HTTP and hand the pieces over:
 * Electron with `node:http`, Android with a small socket server in Kotlin.
 *
 * Every request gets a single JSON response – no SSE – so the transport never has to keep a
 * connection open. Security follows the spec's rules for local servers: bind to loopback, reject
 * foreign `Origin` headers (DNS rebinding) and `Host` headers that are not an address literal.
 */

export interface AgentHttpRequest {
  method: string
  /** Path with query string, e.g. `/mcp?token=…`. */
  url: string
  /** Header names lower-cased. */
  headers: Record<string, string>
  body: string
  remoteAddress: string
}

export interface AgentHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export interface SessionInit {
  transport: 'http' | 'stdio'
  /** Bearer token presented by the client (null when none). */
  token: string | null
  remoteAddress: string
  userAgent: string
}

/** What the transport needs from the browser's agent service. */
export interface SessionStore {
  readonly protocol: McpProtocol
  create(init: SessionInit): McpSession
  get(id: string): McpSession | undefined
  /** Session for clients that send no `Mcp-Session-Id` (keyed by whatever identifies them). */
  sessionless(key: string, init: SessionInit): McpSession
  touch(session: McpSession): void
  close(id: string): void
}

export const MCP_PATHS = new Set(['/mcp', '/mcp/', '/'])

export class StreamableHttp {
  constructor(private readonly sessions: SessionStore) {}

  async handle(req: AgentHttpRequest): Promise<AgentHttpResponse> {
    const [path, query] = splitUrl(req.url)
    if (!MCP_PATHS.has(path)) return text(404, 'Not found')

    const origin = req.headers['origin']
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      return json(403, failure(null, UNAUTHORIZED, 'Forbidden origin'))
    }
    const host = req.headers['host']
    if (host !== undefined && !isAddressLiteralHost(host)) {
      return json(403, failure(null, UNAUTHORIZED, 'Forbidden host'))
    }

    const method = req.method.toUpperCase()
    if (method === 'OPTIONS') return { status: 204, headers: { allow: 'POST, DELETE' }, body: '' }
    if (method === 'GET') {
      // No server-initiated messages: nothing to stream.
      return { status: 405, headers: { allow: 'POST, DELETE' }, body: 'Method Not Allowed' }
    }
    const sessionId = req.headers['mcp-session-id']
    if (method === 'DELETE') {
      if (sessionId) this.sessions.close(sessionId)
      return { status: 204, headers: {}, body: '' }
    }
    if (method !== 'POST')
      return { status: 405, headers: { allow: 'POST, DELETE' }, body: 'Method Not Allowed' }

    let message: unknown
    try {
      message = JSON.parse(req.body)
    } catch {
      return json(400, failure(null, PARSE_ERROR, 'Body is not valid JSON'))
    }
    if (!isObject(message) && !Array.isArray(message)) {
      return json(400, failure(null, INVALID_REQUEST, 'Body must be a JSON-RPC message'))
    }

    const init: SessionInit = {
      transport: 'http',
      token: bearerToken(req.headers['authorization']) ?? query.get('token'),
      remoteAddress: req.remoteAddress,
      userAgent: req.headers['user-agent'] ?? ''
    }

    let session: McpSession | undefined
    let fresh = false
    if (isInitialize(message)) {
      session = this.sessions.create(init)
      fresh = true
    } else if (sessionId) {
      session = this.sessions.get(sessionId)
      if (!session)
        return json(
          404,
          failure(idOf(message), INVALID_REQUEST, 'Unknown session – initialize again')
        )
    } else {
      // 2026-07-28 clients carry no session; older clients forgot the header. Either way: serve
      // them from a session keyed by who they appear to be, once they have initialised.
      session = this.sessions.sessionless(sessionlessKey(init), init)
    }
    this.sessions.touch(session)

    const result = await this.sessions.protocol.handle(session, message)
    const headers: Record<string, string> = {}
    if (fresh) {
      if (!session.protocolVersion) {
        // initialize was refused (denied by the user, bad token): drop the half-made session.
        this.sessions.close(session.id)
        return json(
          403,
          result ?? failure(idOf(message), UNAUTHORIZED, 'Connection refused'),
          headers
        )
      }
      headers['mcp-session-id'] = session.id
    }
    if (result === null) return { status: 202, headers, body: '' }
    return json(200, result, headers)
  }
}

// ---------------------------------------------------------------------------

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): AgentHttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
    body: JSON.stringify(body)
  }
}

function text(status: number, body: string): AgentHttpResponse {
  return { status, headers: { 'content-type': 'text/plain' }, body }
}

function splitUrl(url: string): [string, URLSearchParams] {
  const q = url.indexOf('?')
  if (q === -1) return [url, new URLSearchParams()]
  return [url.slice(0, q), new URLSearchParams(url.slice(q + 1))]
}

export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  return m ? m[1].trim() : null
}

function isInitialize(message: unknown): boolean {
  return isRequest(message) && message.method === 'initialize'
}

function idOf(message: unknown): string | number | null {
  return isRequest(message) ? message.id : null
}

function sessionlessKey(init: SessionInit): string {
  return `${init.token ?? ''}|${init.userAgent}|${init.remoteAddress}`
}

/**
 * Browsers send `Origin` on cross-site requests; MCP clients do not. Only a page served from the
 * loopback address itself could legitimately carry one, and this server serves no pages.
 */
export function isLoopbackOrigin(origin: string): boolean {
  if (origin === 'null') return false
  try {
    const u = new URL(origin)
    return isLoopbackHostname(u.hostname)
  } catch {
    return false
  }
}

/**
 * DNS rebinding makes `attacker.example` resolve to 127.0.0.1; the request then arrives with that
 * name in `Host`. A client that addresses the server directly always uses an address literal (or
 * `localhost`), so anything else is refused.
 */
export function isAddressLiteralHost(host: string): boolean {
  const hostname = hostnameOf(host)
  if (!hostname) return false
  if (isLoopbackHostname(hostname)) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true
  if (/^\[[0-9a-f:.]+\]$/i.test(hostname) || /^[0-9a-f:]+$/i.test(hostname)) return true
  return false
}

function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase()
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end === -1 ? '' : h.slice(0, end + 1)
  }
  const colon = h.indexOf(':')
  return colon === -1 ? h : h.slice(0, colon)
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '[::1]' ||
    h === '::1' ||
    h.endsWith('.localhost')
  )
}
