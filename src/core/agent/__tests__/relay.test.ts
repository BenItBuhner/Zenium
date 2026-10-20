import { afterEach, describe, expect, it, vi } from 'vitest'
import { RELAY_BEARER_PREFIX, RELAY_SUBPROTOCOL, type RelayRpc } from '../../../shared/agentRelay'
import type { AgentRemoteStatus } from '../../../shared/types'
import { RelayConnector, relayConnectUrl, relayMcpUrl, type RelaySocket } from '../relay'
import { fakeBrowser, type FakeBrowser } from './fakeBrowser'

/**
 * The browser's side of the hosted relay: an agent of the Zenium account reaches the same MCP
 * core a local agent does, is always asked about (and remembered by its OAuth client, not its
 * name), and keeps its durable session across a browser restart because the relay's session id
 * names the transport session.
 */

const INIT = {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'Remote Claude', version: '1.0' }
}

function rpc(
  session: string,
  message: unknown,
  clientId = 'https://claude.ai/oauth/mcp'
): RelayRpc {
  return {
    t: 'rpc',
    rid: Math.random().toString(36).slice(2),
    session,
    client: { id: clientId, name: 'Remote Claude', version: '1.0' },
    init: INIT,
    message
  }
}

let nextId = 1
const call = (name: string, args: Record<string, unknown> = {}): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id: nextId++,
  method: 'tools/call',
  params: { name, arguments: args }
})

const browsers: FakeBrowser[] = []
afterEach(async () => {
  for (const b of browsers.splice(0)) await b.stop()
})

function setup(confirm: boolean): { fake: FakeBrowser; asked: string[] } {
  const fake = fakeBrowser()
  browsers.push(fake)
  // The fixture spreads the defaults shallowly: a list of its own, so tests do not share one.
  fake.browser.state.settings.agents.remoteApprovedClients = []
  const asked: string[] = []
  ;(fake.browser.platform as unknown as { dialogs: unknown }).dialogs = {
    confirm: async (opts: { message: string; detail: string }) => {
      asked.push(`${opts.message} ${opts.detail}`)
      return confirm
    }
  }
  return { fake, asked }
}

describe('agents through the relay', () => {
  it('the first call asks the user, then runs through the same tools a local agent has', async () => {
    const { fake, asked } = setup(true)
    const list = (await fake.service.handleRelay(
      rpc('s1', { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    )) as { result: { tools: { name: string }[] } }
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('Allow "Remote Claude" to control this browser?')
    expect(asked[0]).toContain('through your Zenium account')
    expect(list.result.tools.map((t) => t.name)).toContain('browser_navigate')

    const opened = (await fake.service.handleRelay(
      rpc('s1', call('browser_tabs', { action: 'new', url: 'https://a.example/' }))
    )) as { result: { content: { text: string }[]; isError?: boolean } }
    expect(opened.result.isError).toBeFalsy()
    const session = fake.service.get('relay-s1')!
    expect(session.transport).toBe('relay')
    expect(session.groupIds.size).toBe(1)
    expect(fake.service.list().find((a) => a.id === 'relay-s1')?.transport).toBe('relay')
    // Remembered by the OAuth client the relay verified.
    expect(fake.browser.state.settings.agents.remoteApprovedClients).toEqual([
      'https://claude.ai/oauth/mcp'
    ])
  })

  it('an allowed client is not asked again, even under another name; another client is', async () => {
    const { fake, asked } = setup(true)
    await fake.service.handleRelay(rpc('a', { jsonrpc: '2.0', id: 1, method: 'ping' }))
    await fake.service.handleRelay(rpc('b', { jsonrpc: '2.0', id: 2, method: 'ping' }))
    expect(asked).toHaveLength(1)
    await fake.service.handleRelay(
      rpc('c', { jsonrpc: '2.0', id: 3, method: 'ping' }, 'https://other.example/client')
    )
    expect(asked).toHaveLength(2)
  })

  it('"Ask before a new agent connects" off does not wave relay agents through', async () => {
    const { fake, asked } = setup(false)
    fake.browser.state.settings.agents.approveNewAgents = false
    fake.browser.state.settings.agents.approvedNames = ['Remote Claude']
    const reply = (await fake.service.handleRelay(rpc('d', call('zen_status')))) as {
      error?: { message: string }
    }
    expect(asked).toHaveLength(1)
    expect(reply.error?.message).toContain('did not allow')
    // Denied once: the session's later calls are refused without a second prompt.
    await fake.service.handleRelay(rpc('d', call('zen_status')))
    expect(asked).toHaveLength(1)
    expect(fake.service.get('relay-d')).toBeUndefined()
  })

  it('a durable session comes back after the browser restarts, groups and all', async () => {
    const { fake } = setup(true)
    await fake.service.handleRelay(
      rpc('keep', call('zen_session', { action: 'start', name: 'Researcher' }))
    )
    await fake.service.handleRelay(
      rpc('keep', call('browser_tabs', { action: 'new', url: 'https://a.example/' }))
    )
    const groups = [...fake.service.get('relay-keep')!.groupIds]
    expect(groups).toHaveLength(1)

    const again = fake.restart()
    browsers.push(again)
    ;(again.browser.platform as unknown as { dialogs: unknown }).dialogs = {
      confirm: async () => true
    }
    const status = (await again.service.handleRelay(rpc('keep', call('zen_status')))) as {
      result: { content: { text: string }[] }
    }
    const s = again.service.get('relay-keep')!
    expect(s.claimId).not.toBeNull()
    expect([...s.groupIds]).toEqual(groups)
    expect(status.result.content[0].text).toContain('is back with its groups and tabs')
  })

  it('the relay ending a session closes it here', async () => {
    const { fake } = setup(true)
    await fake.service.handleRelay(rpc('gone', { jsonrpc: '2.0', id: 1, method: 'ping' }))
    expect(fake.service.get('relay-gone')).toBeDefined()
    fake.service.endRelay('gone')
    expect(fake.service.get('relay-gone')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------

class FakeSocket implements RelaySocket {
  readyState = 0
  sent: string[] = []
  closed: { code?: number; reason?: string } | null = null
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor(
    readonly url: string,
    readonly protocols: string[]
  ) {}
  send(data: string): void {
    this.sent.push(data)
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
    this.readyState = 3
  }
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) })
  }
  drop(code = 1006): void {
    this.readyState = 3
    this.onclose?.({ code, reason: '' })
  }
  frames(): Record<string, unknown>[] {
    return this.sent
      .filter((s) => s.startsWith('{'))
      .map((s) => JSON.parse(s) as Record<string, unknown>)
  }
}

interface Harness {
  c: RelayConnector
  sockets: FakeSocket[]
  statuses: AgentRemoteStatus[]
  handled: RelayRpc[]
  ended: string[]
}

function connector(opts: { token?: string | null; url?: string | null } = {}): Harness {
  const sockets: FakeSocket[] = []
  const statuses: AgentRemoteStatus[] = []
  const handled: RelayRpc[] = []
  const ended: string[] = []
  const c = new RelayConnector({
    relayUrl: () => (opts.url === undefined ? 'https://relay.example' : opts.url),
    accessToken: async () => (opts.token === undefined ? 'header.payload.sig' : opts.token),
    device: () => ({ name: 'Laptop', kind: 'laptop', version: '1.2.3' }),
    onRpc: async (frame) => {
      handled.push(frame)
      return { jsonrpc: '2.0', id: (frame.message as { id: number }).id, result: { ok: true } }
    },
    onEnd: (s) => ended.push(s),
    onStatus: (s) => statuses.push(s),
    openSocket: (url, protocols) => {
      const s = new FakeSocket(url, protocols)
      sockets.push(s)
      return s
    }
  })
  return { c, sockets, statuses, handled, ended }
}

const flush = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0))

describe('RelayConnector', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('derives the two URLs from the relay address', () => {
    expect(relayConnectUrl('https://relay.example/')).toBe('wss://relay.example/connect')
    expect(relayConnectUrl('http://localhost:8787')).toBe('ws://localhost:8787/connect')
    expect(relayMcpUrl('https://relay.example/')).toBe('https://relay.example/mcp')
  })

  it('connects with the token as a subprotocol, says hello, answers calls', async () => {
    const { c, sockets, statuses, handled } = connector()
    c.start()
    await flush()
    const ws = sockets[0]
    expect(ws.url).toBe('wss://relay.example/connect')
    expect(ws.protocols).toEqual([RELAY_SUBPROTOCOL, `${RELAY_BEARER_PREFIX}header.payload.sig`])
    ws.open()
    expect(ws.frames()[0]).toEqual({ t: 'hello', name: 'Laptop', kind: 'laptop', version: '1.2.3' })
    ws.receive({ t: 'welcome', deviceId: 'dev1' })
    expect(statuses.at(-1)).toEqual({
      state: 'connected',
      mcpUrl: 'https://relay.example/mcp',
      error: null
    })
    ws.receive(rpc('s', { jsonrpc: '2.0', id: 7, method: 'ping' }))
    await flush()
    expect(handled).toHaveLength(1)
    expect(ws.frames().at(-1)).toMatchObject({
      t: 'reply',
      message: { id: 7, result: { ok: true } }
    })
    c.stop()
    expect(ws.closed?.code).toBe(1000)
    expect(statuses.at(-1)?.state).toBe('off')
  })

  it('passes end frames on', async () => {
    const { c, sockets, ended } = connector()
    c.start()
    await flush()
    sockets[0].open()
    sockets[0].receive({ t: 'end', session: 'abc' })
    expect(ended).toEqual(['abc'])
    c.stop()
  })

  it('reports signed-out and no-relay without opening a socket', async () => {
    const a = connector({ token: null })
    a.c.start()
    await flush()
    expect(a.sockets).toHaveLength(0)
    expect(a.statuses.at(-1)?.state).toBe('signed-out')
    a.c.stop()
    const b = connector({ url: null })
    b.c.start()
    await flush()
    expect(b.sockets).toHaveLength(0)
    expect(b.statuses.at(-1)?.state).toBe('no-relay')
    b.c.stop()
  })

  it('reconnects with backoff after the connection drops', async () => {
    vi.useFakeTimers()
    const { c, sockets, statuses } = connector()
    c.start()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].open()
    sockets[0].receive({ t: 'welcome', deviceId: 'd' })
    sockets[0].drop()
    expect(statuses.at(-1)).toMatchObject({
      state: 'connecting',
      error: 'The connection to the relay was lost'
    })
    await vi.advanceTimersByTimeAsync(1300)
    expect(sockets).toHaveLength(2)
    sockets[1].open()
    sockets[1].receive({ t: 'welcome', deviceId: 'd' })
    expect(statuses.at(-1)?.state).toBe('connected')
    c.stop()
  })

  it('finds a dead connection by its missing pongs', async () => {
    vi.useFakeTimers()
    const { c, sockets } = connector()
    c.start()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].open()
    sockets[0].receive({ t: 'welcome', deviceId: 'd' })
    await vi.advanceTimersByTimeAsync(25_000)
    expect(sockets[0].sent).toContain('ping')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sockets[0].closed?.code).toBe(4000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(sockets.length).toBeGreaterThan(1)
    c.stop()
  })
})
