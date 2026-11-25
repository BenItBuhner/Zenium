/**
 * A small MCP client for the built-in agent: JSON-RPC over Streamable HTTP, through any
 * transport that answers one request at a time. In the browser it is `inProcess` – the agent
 * service's own HTTP handler, with the connection token, so the built-in agent is an MCP client
 * like any other and gets exactly the same tools, sessions and rules. Elsewhere (the hosted
 * relay, another of the user's browsers) it is `overHttp`.
 */
import type { AgentHttpRequest, AgentHttpResponse } from '../agent/http'

export interface McpTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface McpToolResult {
  content: { type: string; text?: string; data?: string; mimeType?: string }[]
  isError?: boolean
}

/** One HTTP exchange: headers lower-cased, as the agent service takes them. */
export type McpExchange = (req: {
  headers: Record<string, string>
  body: string
}) => Promise<{ status: number; headers: Record<string, string>; body: string }>

export function inProcess(
  handle: (req: AgentHttpRequest) => Promise<AgentHttpResponse>,
  token: () => string
): McpExchange {
  return (req) =>
    handle({
      method: 'POST',
      url: '/mcp',
      headers: { ...req.headers, authorization: `Bearer ${token()}`, host: '127.0.0.1' },
      body: req.body,
      remoteAddress: '127.0.0.1'
    })
}

export function overHttp(url: string, token: string, fetcher: typeof fetch = fetch): McpExchange {
  return async (req) => {
    const res = await fetcher(url, {
      method: 'POST',
      headers: { ...req.headers, authorization: `Bearer ${token}` },
      body: req.body
    })
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v))
    return { status: res.status, headers, body: await res.text() }
  }
}

/** The JSON-RPC message in a response body, plain JSON or one SSE `data:` event. */
export function parseRpcBody(body: string): unknown {
  const t = body.trim()
  if (!t) return null
  if (t.startsWith('{')) return JSON.parse(t)
  const data = t
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
  for (let i = data.length - 1; i >= 0; i--) {
    const msg = JSON.parse(data[i]) as { id?: unknown }
    if (msg && msg.id !== undefined) return msg
  }
  return null
}

export class McpClient {
  private sessionId: string | null = null
  private nextId = 1
  private ready: Promise<void> | null = null

  constructor(
    private readonly exchange: McpExchange,
    private readonly clientName = 'Zenium agent'
  ) {}

  private async send(method: string, params: unknown, notify = false): Promise<unknown> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18'
    }
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    const message: Record<string, unknown> = { jsonrpc: '2.0', method, params }
    if (!notify) message.id = this.nextId++
    const res = await this.exchange({ headers, body: JSON.stringify(message) })
    const sid = res.headers['mcp-session-id']
    if (sid) this.sessionId = sid
    if (notify) return null
    if (res.status === 404) {
      // The browser restarted: start a new connection once and let the caller retry.
      this.sessionId = null
      this.ready = null
      throw new Error('session lost')
    }
    const reply = parseRpcBody(res.body) as {
      result?: unknown
      error?: { message?: string }
    } | null
    if (!reply) throw new Error(`empty MCP response (HTTP ${res.status})`)
    if (reply.error) throw new Error(reply.error.message ?? 'MCP error')
    return reply.result
  }

  private connect(): Promise<void> {
    this.ready ??= (async () => {
      await this.send('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: this.clientName, version: '1' }
      })
      await this.send('notifications/initialized', {}, true)
    })()
    return this.ready
  }

  async listTools(): Promise<McpTool[]> {
    await this.connect()
    const result = (await this.send('tools/list', {})) as { tools?: McpTool[] }
    return result.tools ?? []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    for (let attempt = 0; ; attempt++) {
      await this.connect()
      try {
        return (await this.send('tools/call', { name, arguments: args })) as McpToolResult
      } catch (error) {
        if (attempt === 0 && error instanceof Error && error.message === 'session lost') continue
        throw error
      }
    }
  }
}
