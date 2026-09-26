import { describe, expect, it } from 'vitest'
import { StdioRelay, type RelayEndpoint } from '../shim'

/**
 * The `zenium --mcp` relay against a stand-in of the browser's Streamable HTTP server: sessions
 * by id, a 404 for one it does not know (the browser restarted, the session expired), an
 * endpoint that can move, a connection that can be refused.
 */

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: { id?: unknown; method?: string; params?: unknown } | null
}

class FakeServer {
  sessions = new Set<string>()
  calls: Call[] = []
  url = 'http://127.0.0.1:41000/mcp'
  token = 'tok'
  /** Refuse connections (the browser is down). */
  down = false
  private n = 0

  endpoint(): RelayEndpoint | null {
    return this.down ? null : { url: this.url, token: this.token }
  }

  restart(): void {
    this.sessions.clear()
  }

  fetch: typeof fetch = async (input, init) => {
    const url = String(input)
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v
      ])
    )
    if (this.down || url !== this.url) throw new TypeError('fetch failed: ECONNREFUSED')
    const method = init?.method ?? 'GET'
    const body = (init?.body ? JSON.parse(String(init.body)) : null) as Call['body']
    this.calls.push({ url, method, headers, body })
    if (headers.authorization !== `Bearer ${this.token}`)
      return json(403, {
        jsonrpc: '2.0',
        id: body?.id ?? null,
        error: { code: -32001, message: 'Forbidden' }
      })
    if (method === 'DELETE') {
      this.sessions.delete(headers['mcp-session-id'])
      return new Response(null, { status: 204 })
    }
    if (!body)
      return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'no body' } })
    if (body.method === 'initialize') {
      const id = `s${++this.n}`
      this.sessions.add(id)
      return json(
        200,
        {
          jsonrpc: '2.0',
          id: body.id,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'zen' } }
        },
        { 'mcp-session-id': id }
      )
    }
    const sid = headers['mcp-session-id']
    if (!sid || !this.sessions.has(sid))
      return json(404, {
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: { code: -32600, message: 'Unknown session – initialize again' }
      })
    if (body.method?.startsWith('notifications/')) return new Response(null, { status: 202 })
    if (body.method === 'slow') {
      await new Promise((r) => setTimeout(r, 30))
      return json(200, { jsonrpc: '2.0', id: body.id, result: { slow: true, session: sid } })
    }
    return json(200, { jsonrpc: '2.0', id: body.id, result: { echo: body.method, session: sid } })
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

function relayOver(
  server: FakeServer,
  extra: Partial<ConstructorParameters<typeof StdioRelay>[0]> = {}
): { relay: StdioRelay; out: Array<Record<string, unknown>>; log: string[] } {
  const out: Array<Record<string, unknown>> = []
  const log: string[] = []
  const relay = new StdioRelay({
    readEndpoint: () => server.endpoint(),
    write: (m) => out.push(m as Record<string, unknown>),
    log: (l) => log.push(l),
    fetch: server.fetch,
    sleep: async () => undefined,
    startupWaitMs: 1000,
    ...extra
  })
  return { relay, out, log }
}

const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', clientInfo: { name: 'cursor', version: '1' } }
})
const INITIALIZED = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
const call = (id: number, method = 'tools/call'): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params: {} })

describe('StdioRelay', () => {
  it('relays initialize, keeps the session id and answers calls under it', async () => {
    const server = new FakeServer()
    const { relay, out } = relayOver(server)
    await relay.handleLine(INIT)
    await relay.handleLine(INITIALIZED)
    await relay.handleLine(call(2))
    expect(relay.session).toBe('s1')
    expect(out.map((m) => m.id)).toEqual([1, 2])
    expect((out[1].result as { session: string }).session).toBe('s1')
    const last = server.calls[server.calls.length - 1]
    expect(last.headers['mcp-session-id']).toBe('s1')
    expect(last.headers['mcp-protocol-version']).toBe('2025-06-18')
    await relay.close()
    expect(server.calls[server.calls.length - 1].method).toBe('DELETE')
    expect(server.sessions.size).toBe(0)
  })

  it("renews the session after a 404 by replaying the client's initialize, and retries the call once", async () => {
    const server = new FakeServer()
    const { relay, out, log } = relayOver(server)
    await relay.handleLine(INIT)
    await relay.handleLine(INITIALIZED)
    server.restart() // the browser restarted: s1 is gone
    await relay.handleLine(call(2))
    expect(out).toHaveLength(2)
    expect(out[1].error).toBeUndefined()
    expect((out[1].result as { session: string }).session).toBe('s2')
    expect(relay.session).toBe('s2')
    // The renewal replayed the client's own initialize (its name) and notifications/initialized.
    const replay = server.calls.find((c) => c.body?.method === 'initialize' && c.body.id !== 1)!
    expect(replay).toBeDefined()
    expect(replay.headers['mcp-session-id']).toBeUndefined()
    expect(
      (replay.body as { params: { clientInfo: { name: string } } }).params.clientInfo.name
    ).toBe('cursor')
    const note = server.calls.filter((c) => c.body?.method === 'notifications/initialized')
    expect(note).toHaveLength(2)
    expect(note[1].headers['mcp-session-id']).toBe('s2')
    expect(log.some((l) => l.includes('renewed as s2'))).toBe(true)
    // Later calls carry the new session and need no second renewal.
    await relay.handleLine(call(3))
    expect((out[2].result as { session: string }).session).toBe('s2')
    expect(relay.renewals).toBe(1)
  })

  it('concurrent calls that all hit the loss share one renewal', async () => {
    const server = new FakeServer()
    const { relay, out } = relayOver(server)
    await relay.handleLine(INIT)
    server.restart()
    await Promise.all([
      relay.handleLine(call(2)),
      relay.handleLine(call(3)),
      relay.handleLine(call(4))
    ])
    expect(out.filter((m) => m.error)).toHaveLength(0)
    expect(new Set(out.slice(1).map((m) => (m.result as { session: string }).session))).toEqual(
      new Set(['s2'])
    )
    expect(relay.renewals).toBe(1)
  })

  it('runs calls concurrently once the session exists: a slow call does not hold a ping back', async () => {
    const server = new FakeServer()
    const { relay, out } = relayOver(server)
    await relay.handleLine(INIT)
    const slow = relay.handleLine(call(2, 'slow'))
    const ping = relay.handleLine(call(3, 'ping'))
    await ping
    expect(out.map((m) => m.id)).toEqual([1, 3])
    await slow
    expect(out.map((m) => m.id)).toEqual([1, 3, 2])
  })

  it('queues everything behind the initialize response, so the client never sees a second answer first', async () => {
    const server = new FakeServer()
    const { relay, out } = relayOver(server)
    const init = relay.handleLine(INIT)
    const first = relay.handleLine(call(2))
    await Promise.all([init, first])
    expect(out.map((m) => m.id)).toEqual([1, 2])
    expect(server.calls[1].headers['mcp-session-id']).toBe('s1')
  })

  it('follows the endpoint when the browser comes back on another port or with a new token', async () => {
    const server = new FakeServer()
    const { relay, out, log } = relayOver(server)
    await relay.handleLine(INIT)
    server.url = 'http://127.0.0.1:41001/mcp'
    server.token = 'tok2'
    server.restart()
    await relay.handleLine(call(2))
    expect(out[1].error).toBeUndefined()
    expect((out[1].result as { session: string }).session).toBe('s2')
    expect(server.calls[server.calls.length - 1].url).toBe(server.url)
    expect(log.some((l) => l.includes('endpoint changed'))).toBe(true)
  })

  it('reports an unreachable browser to the client and recovers when it is back', async () => {
    const server = new FakeServer()
    const { relay, out } = relayOver(server)
    await relay.handleLine(INIT)
    server.down = true
    await relay.handleLine(call(2))
    expect(String((out[1].error as { message: string }).message)).toContain('not reachable')
    server.down = false
    server.restart()
    await relay.handleLine(call(3))
    expect(out[2].error).toBeUndefined()
  })

  it('waits at initialize for a browser that is still starting', async () => {
    const server = new FakeServer()
    server.down = true
    let polls = 0
    const { relay, out } = relayOver(server, {
      sleep: async () => {
        if (++polls === 3) server.down = false
      }
    })
    await relay.handleLine(INIT)
    expect(out[0].error).toBeUndefined()
    expect(relay.session).toBe('s1')
  })

  it('answers a parse error itself and never dies on a closed stdout', async () => {
    const server = new FakeServer()
    const { relay, out } = relayOver(server)
    await relay.handleLine('{not json')
    expect((out[0].error as { code: number }).code).toBe(-32700)
    const broken = new StdioRelay({
      readEndpoint: () => server.endpoint(),
      write: () => {
        throw new Error('EPIPE')
      },
      fetch: server.fetch
    })
    await expect(broken.handleLine(INIT)).resolves.toBeUndefined()
    await expect(broken.handleLine(call(2))).resolves.toBeUndefined()
  })
})
