import { describe, expect, it } from 'vitest'
import {
  LATEST_PROTOCOL_VERSION,
  McpProtocol,
  cleanName,
  newSession,
  type McpHandlers,
  type McpSession,
  type ResourceContents,
  type ResourceDefinition,
  type ToolDefinition,
  type ToolResult
} from '../protocol'
import {
  METHOD_NOT_FOUND,
  NOT_INITIALIZED,
  UNAUTHORIZED,
  RpcError,
  type JsonRpcResponse
} from '../jsonrpc'

function handlers(overrides: Partial<McpHandlers> = {}): McpHandlers {
  return {
    onInitialize: async () => undefined,
    listTools: (): ToolDefinition[] => [
      {
        name: 'browser_navigate',
        description: 'go',
        inputSchema: { type: 'object', properties: {} }
      }
    ],
    callTool: async (_s, name): Promise<ToolResult> => ({
      content: [{ type: 'text', text: `ran ${name}` }]
    }),
    listResources: (): ResourceDefinition[] => [{ uri: 'zenium://status', name: 'status' }],
    readResource: async (_s, uri): Promise<ResourceContents[]> => [{ uri, text: 'ok' }],
    instructions: () => 'be nice',
    ...overrides
  }
}

function server(overrides?: Partial<McpHandlers>): { protocol: McpProtocol; session: McpSession } {
  const protocol = new McpProtocol(handlers(overrides), { name: 'zen', version: '1' })
  return { protocol, session: newSession('s1') }
}

async function call(
  protocol: McpProtocol,
  session: McpSession,
  message: unknown
): Promise<JsonRpcResponse | null> {
  const r = await protocol.handle(session, message)
  return Array.isArray(r) ? r[0] : r
}

const initMsg = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'Tester', version: '2' }
  }
}

describe('McpProtocol handshake', () => {
  it('answers initialize with version, capabilities and instructions', async () => {
    const { protocol, session } = server()
    const res = await call(protocol, session, initMsg)
    expect(res?.error).toBeUndefined()
    const result = res?.result as Record<string, unknown>
    expect(result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION)
    expect(result.serverInfo).toMatchObject({ name: 'zen' })
    expect(result.instructions).toBe('be nice')
    expect((result.capabilities as { tools: unknown }).tools).toBeDefined()
    expect(session.initialized).toBe(false) // only true after the notification
    expect(session.protocolVersion).toBe(LATEST_PROTOCOL_VERSION)
  })

  it('echoes an older protocol version the client asks for', async () => {
    const { protocol, session } = server()
    const res = await call(protocol, session, {
      ...initMsg,
      params: { ...initMsg.params, protocolVersion: '2024-11-05' }
    })
    expect((res?.result as { protocolVersion: string }).protocolVersion).toBe('2024-11-05')
  })

  it('falls back to the latest version for an unknown one', async () => {
    const { protocol, session } = server()
    const res = await call(protocol, session, {
      ...initMsg,
      params: { ...initMsg.params, protocolVersion: '1999-01-01' }
    })
    expect((res?.result as { protocolVersion: string }).protocolVersion).toBe(
      LATEST_PROTOCOL_VERSION
    )
  })

  it('refuses tools/call before initialize', async () => {
    const { protocol, session } = server()
    const res = await call(protocol, session, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(res?.error?.code).toBe(NOT_INITIALIZED)
  })

  it('lets initialize refusal become the response error', async () => {
    const { protocol, session } = server({
      onInitialize: async () => {
        throw new RpcError(UNAUTHORIZED, 'denied')
      }
    })
    const res = await call(protocol, session, initMsg)
    expect(res?.error?.code).toBe(UNAUTHORIZED)
    expect(session.protocolVersion).toBeNull()
  })
})

describe('McpProtocol requests', () => {
  it('lists tools and calls one after initialize', async () => {
    const { protocol, session } = server()
    await call(protocol, session, initMsg)
    const list = await call(protocol, session, { jsonrpc: '2.0', id: 3, method: 'tools/list' })
    expect((list?.result as { tools: ToolDefinition[] }).tools[0].name).toBe('browser_navigate')
    const called = await call(protocol, session, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'browser_navigate', arguments: { url: 'x' } }
    })
    expect((called?.result as ToolResult).content[0]).toMatchObject({
      type: 'text',
      text: 'ran browser_navigate'
    })
  })

  it('rejects an unknown tool with invalid params', async () => {
    const { protocol, session } = server()
    await call(protocol, session, initMsg)
    const res = await call(protocol, session, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'nope' }
    })
    expect(res?.error?.code).toBe(-32602)
  })

  it('answers ping without initialize', async () => {
    const { protocol, session } = server()
    const res = await call(protocol, session, { jsonrpc: '2.0', id: 6, method: 'ping' })
    expect(res?.result).toEqual({})
  })

  it('reads resources', async () => {
    const { protocol, session } = server()
    await call(protocol, session, initMsg)
    const res = await call(protocol, session, {
      jsonrpc: '2.0',
      id: 7,
      method: 'resources/read',
      params: { uri: 'zenium://status' }
    })
    expect((res?.result as { contents: ResourceContents[] }).contents[0].text).toBe('ok')
  })

  it('returns method-not-found for unknown methods', async () => {
    const { protocol, session } = server()
    await call(protocol, session, initMsg)
    const res = await call(protocol, session, { jsonrpc: '2.0', id: 8, method: 'does/not/exist' })
    expect(res?.error?.code).toBe(METHOD_NOT_FOUND)
  })

  it('treats notifications/initialized as a notification (no response)', async () => {
    const { protocol, session } = server()
    await call(protocol, session, initMsg)
    const res = await protocol.handle(session, {
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    })
    expect(res).toBeNull()
    expect(session.initialized).toBe(true)
  })

  it('never answers a JSON-RPC response message', async () => {
    const { protocol, session } = server()
    const res = await protocol.handle(session, { jsonrpc: '2.0', id: 1, result: {} })
    expect(res).toBeNull()
  })

  it('surfaces a thrown tool error as a JSON-RPC error', async () => {
    const { protocol, session } = server({
      callTool: async () => {
        throw new RpcError(-32000, 'boom')
      }
    })
    await call(protocol, session, initMsg)
    const res = await call(protocol, session, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'browser_navigate' }
    })
    expect(res?.error).toMatchObject({ code: -32000, message: 'boom' })
  })
})

describe('cleanName', () => {
  it('keeps readable names and strips control characters', () => {
    expect(cleanName('Claude Code')).toBe('Claude Code')
    expect(cleanName('  bad\u0000name\n')).toBe('badname')
    expect(cleanName('')).toBe('Agent')
    expect(cleanName('x'.repeat(80)).length).toBe(40)
  })
})
