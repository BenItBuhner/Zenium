import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  NOT_INITIALIZED,
  RpcError,
  failure,
  isNotification,
  isObject,
  isRequest,
  isResponse,
  paramsOf,
  success,
  type JsonRpcRequest,
  type JsonRpcResponse
} from './jsonrpc'

/**
 * A transport-agnostic Model Context Protocol server core: JSON-RPC messages in, JSON-RPC
 * responses out. Hosts wrap it in Streamable HTTP (see `http.ts`) or stdio; the browser-specific
 * behaviour (tools, resources, who may connect) is supplied through `McpHandlers`.
 *
 * Every request is answered with a single response – no server-initiated requests, no streams –
 * which keeps the transport trivial on both hosts and matches what the protocol allows.
 */

/** Newest revision this server speaks; older clients get their own version echoed back. */
export const LATEST_PROTOCOL_VERSION = '2025-11-25'
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
  '2026-07-28'
]

export interface JsonSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface ToolDefinition {
  name: string
  title?: string
  description: string
  inputSchema: JsonSchema
  annotations?: ToolAnnotations
}

export type ToolContent =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface ToolResult {
  content: ToolContent[]
  isError?: boolean
}

export interface ResourceDefinition {
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
}

export interface ResourceContents {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

export interface ClientInfo {
  name: string
  version: string
}

/** Per-connection protocol state; the host keeps one per transport session. */
export interface McpSession {
  id: string
  initialized: boolean
  protocolVersion: string | null
  client: ClientInfo | null
}

export interface McpHandlers {
  /**
   * The client introduced itself. Throw an `RpcError` to refuse the connection (the error becomes
   * the response to `initialize`).
   */
  onInitialize(session: McpSession, client: ClientInfo): Promise<void>
  listTools(session: McpSession): ToolDefinition[]
  callTool(session: McpSession, name: string, args: Record<string, unknown>): Promise<ToolResult>
  listResources(session: McpSession): ResourceDefinition[]
  readResource(session: McpSession, uri: string): Promise<ResourceContents[]>
  /** `instructions` for the `initialize` result: how to work in this browser. */
  instructions(session: McpSession): string
}

export interface ServerInfo {
  name: string
  title?: string
  version: string
}

export function newSession(id: string): McpSession {
  return { id, initialized: false, protocolVersion: null, client: null }
}

export class McpProtocol {
  constructor(
    private readonly handlers: McpHandlers,
    private readonly serverInfo: ServerInfo
  ) {}

  /**
   * Handle one message (or a batch – older protocol revisions allow arrays). Notifications and
   * responses produce `null`; requests produce a response.
   */
  async handle(
    session: McpSession,
    message: unknown
  ): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (Array.isArray(message)) {
      if (message.length === 0) return failure(null, INVALID_REQUEST, 'Empty batch')
      const out: JsonRpcResponse[] = []
      for (const m of message) {
        const r = await this.handleOne(session, m)
        if (r) out.push(r)
      }
      return out.length ? out : null
    }
    return this.handleOne(session, message)
  }

  private async handleOne(session: McpSession, message: unknown): Promise<JsonRpcResponse | null> {
    if (isResponse(message)) return null // We never send requests, so nothing awaits this.
    if (isNotification(message)) {
      if (message.method === 'notifications/initialized') session.initialized = true
      return null
    }
    if (!isRequest(message)) {
      const id = isObject(message) && 'id' in message ? (message.id as JsonRpcRequest['id']) : null
      return failure(id, INVALID_REQUEST, 'Not a JSON-RPC 2.0 request')
    }
    try {
      return success(message.id, await this.dispatch(session, message))
    } catch (error) {
      if (error instanceof RpcError)
        return failure(message.id, error.code, error.message, error.data)
      const msg = error instanceof Error ? error.message : String(error)
      return failure(message.id, INTERNAL_ERROR, msg)
    }
  }

  private async dispatch(session: McpSession, req: JsonRpcRequest): Promise<unknown> {
    const params = paramsOf(req)
    switch (req.method) {
      case 'initialize':
        return this.initialize(session, params)
      case 'ping':
        return {}
    }
    // Everything else needs a session that has completed `initialize`. Clients are allowed to
    // skip `notifications/initialized`, so a successful initialize is enough.
    if (!session.protocolVersion) {
      throw new RpcError(NOT_INITIALIZED, 'Session not initialized: send initialize first')
    }
    switch (req.method) {
      case 'tools/list':
        return { tools: this.handlers.listTools(session) }
      case 'tools/call': {
        const name = params.name
        if (typeof name !== 'string' || !name)
          throw new RpcError(INVALID_PARAMS, 'tools/call needs a tool name')
        const args = isObject(params.arguments) ? params.arguments : {}
        const known = this.handlers.listTools(session).some((t) => t.name === name)
        if (!known) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${name}`)
        return this.handlers.callTool(session, name, args)
      }
      case 'resources/list':
        return { resources: this.handlers.listResources(session) }
      case 'resources/templates/list':
        return { resourceTemplates: [] }
      case 'resources/read': {
        const uri = params.uri
        if (typeof uri !== 'string')
          throw new RpcError(INVALID_PARAMS, 'resources/read needs a uri')
        return { contents: await this.handlers.readResource(session, uri) }
      }
      case 'prompts/list':
        return { prompts: [] }
      case 'completion/complete':
        return { completion: { values: [], hasMore: false } }
      case 'logging/setLevel':
        return {}
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${req.method}`)
    }
  }

  private async initialize(session: McpSession, params: Record<string, unknown>): Promise<unknown> {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
    const version = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION
    const rawClient = isObject(params.clientInfo) ? params.clientInfo : {}
    const client: ClientInfo = {
      name: cleanName(typeof rawClient.name === 'string' ? rawClient.name : ''),
      version: typeof rawClient.version === 'string' ? rawClient.version.slice(0, 40) : ''
    }
    await this.handlers.onInitialize(session, client)
    session.client = client
    session.protocolVersion = version
    return {
      protocolVersion: version,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false }
      },
      serverInfo: this.serverInfo,
      instructions: this.handlers.instructions(session)
    }
  }
}

/** Client names show up in the UI and in tab indicators: keep them short and printable. */
export function cleanName(name: string): string {
  const cleaned = name
    .replace(/[^\p{L}\p{N} _.:/@+()-]/gu, '')
    .trim()
    .slice(0, 40)
  return cleaned || 'Agent'
}
