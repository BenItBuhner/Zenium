import { describe, expect, it, beforeEach } from 'vitest'
import {
  StreamableHttp,
  bearerToken,
  isAddressLiteralHost,
  isLoopbackOrigin,
  type AgentHttpRequest,
  type SessionInit,
  type SessionStore
} from '../http'
import { McpProtocol, newSession, type McpHandlers, type McpSession } from '../protocol'

function makeStore(): SessionStore & { sessions: Map<string, McpSession> } {
  const sessions = new Map<string, McpSession>()
  const sessionlessByKey = new Map<string, string>()
  let n = 0
  const handlers: McpHandlers = {
    onInitialize: async () => undefined,
    listTools: () => [],
    callTool: async () => ({ content: [] }),
    listResources: () => [],
    readResource: async () => [],
    instructions: () => ''
  }
  const protocol = new McpProtocol(handlers, { name: 'zen', version: '1' })
  return {
    protocol,
    sessions,
    create(_init: SessionInit): McpSession {
      void _init
      const s = newSession(`s${++n}`)
      sessions.set(s.id, s)
      return s
    },
    get: (id) => sessions.get(id),
    sessionless(key, init) {
      const existing = sessionlessByKey.get(key)
      if (existing && sessions.has(existing)) return sessions.get(existing)!
      const s = this.create(init)
      sessionlessByKey.set(key, s.id)
      return s
    },
    touch: () => undefined,
    close: (id) => sessions.delete(id)
  }
}

function req(overrides: Partial<AgentHttpRequest> = {}): AgentHttpRequest {
  return {
    method: 'POST',
    url: '/mcp',
    headers: { 'content-type': 'application/json' },
    body: '',
    remoteAddress: '127.0.0.1',
    ...overrides
  }
}

const initBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'T', version: '1' }
  }
})

describe('StreamableHttp security', () => {
  let http: StreamableHttp
  beforeEach(() => {
    http = new StreamableHttp(makeStore())
  })

  it('403s a foreign Origin', async () => {
    const res = await http.handle(req({ headers: { origin: 'https://evil.example' }, body: '{}' }))
    expect(res.status).toBe(403)
  })

  it('allows a loopback Origin', async () => {
    const res = await http.handle(
      req({ headers: { origin: 'http://localhost:41735' }, body: initBody })
    )
    expect(res.status).toBe(200)
  })

  it('403s a DNS-rebinding Host but allows address literals', async () => {
    expect(
      (await http.handle(req({ headers: { host: 'attacker.example' }, body: '{}' }))).status
    ).toBe(403)
    expect(
      (await http.handle(req({ headers: { host: '127.0.0.1:41735' }, body: initBody }))).status
    ).toBe(200)
    expect(
      (await http.handle(req({ headers: { host: 'localhost:41735' }, body: initBody }))).status
    ).toBe(200)
  })

  it('405s GET (no server-initiated stream)', async () => {
    const res = await http.handle(req({ method: 'GET', body: '' }))
    expect(res.status).toBe(405)
  })

  it('204s a CORS preflight', async () => {
    const res = await http.handle(req({ method: 'OPTIONS', body: '' }))
    expect(res.status).toBe(204)
  })

  it('400s an unparseable body', async () => {
    const res = await http.handle(req({ body: 'not json' }))
    expect(res.status).toBe(400)
  })
})

describe('StreamableHttp sessions', () => {
  it('assigns a session id on initialize and reuses it', async () => {
    const store = makeStore()
    const http = new StreamableHttp(store)
    const first = await http.handle(req({ body: initBody }))
    expect(first.status).toBe(200)
    const sid = first.headers['mcp-session-id']
    expect(sid).toBeTruthy()
    // A follow-up with the session id is accepted; ping needs no init state.
    const ping = await http.handle(
      req({
        headers: { 'content-type': 'application/json', 'mcp-session-id': sid },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })
      })
    )
    expect(ping.status).toBe(200)
    expect(JSON.parse(ping.body).result).toEqual({})
  })

  it('404s an unknown session id', async () => {
    const http = new StreamableHttp(makeStore())
    const res = await http.handle(
      req({
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'ghost' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
      })
    )
    expect(res.status).toBe(404)
  })

  it('202s a notification (no id)', async () => {
    const store = makeStore()
    const http = new StreamableHttp(store)
    const init = await http.handle(req({ body: initBody }))
    const sid = init.headers['mcp-session-id']
    const res = await http.handle(
      req({
        headers: { 'content-type': 'application/json', 'mcp-session-id': sid },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
      })
    )
    expect(res.status).toBe(202)
    expect(res.body).toBe('')
  })

  it('serves sessionless clients (2026-07-28 shape) without a session header', async () => {
    const http = new StreamableHttp(makeStore())
    const init = await http.handle(
      req({
        headers: { 'content-type': 'application/json', 'user-agent': 'codex' },
        body: initBody
      })
    )
    expect(init.status).toBe(200)
    const ping = await http.handle(
      req({
        headers: { 'content-type': 'application/json', 'user-agent': 'codex' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })
      })
    )
    expect(ping.status).toBe(200)
  })

  it('DELETE closes the session', async () => {
    const store = makeStore()
    const http = new StreamableHttp(store)
    const init = await http.handle(req({ body: initBody }))
    const sid = init.headers['mcp-session-id']!
    expect(store.sessions.has(sid)).toBe(true)
    const res = await http.handle(
      req({ method: 'DELETE', headers: { 'mcp-session-id': sid }, body: '' })
    )
    expect(res.status).toBe(204)
    expect(store.sessions.has(sid)).toBe(false)
  })
})

describe('header helpers', () => {
  it('parses bearer tokens', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123')
    expect(bearerToken('bearer  spaced ')).toBe('spaced')
    expect(bearerToken('Basic x')).toBeNull()
    expect(bearerToken(undefined)).toBeNull()
  })

  it('classifies loopback origins', () => {
    expect(isLoopbackOrigin('http://localhost')).toBe(true)
    expect(isLoopbackOrigin('http://127.0.0.1:41735')).toBe(true)
    expect(isLoopbackOrigin('http://[::1]:3000')).toBe(true)
    expect(isLoopbackOrigin('https://example.com')).toBe(false)
    expect(isLoopbackOrigin('null')).toBe(false)
  })

  it('classifies address-literal hosts', () => {
    expect(isAddressLiteralHost('127.0.0.1:41735')).toBe(true)
    expect(isAddressLiteralHost('localhost:41735')).toBe(true)
    expect(isAddressLiteralHost('192.168.1.5:41735')).toBe(true)
    expect(isAddressLiteralHost('[::1]:41735')).toBe(true)
    expect(isAddressLiteralHost('attacker.example')).toBe(false)
    expect(isAddressLiteralHost('my-router')).toBe(false)
  })
})
