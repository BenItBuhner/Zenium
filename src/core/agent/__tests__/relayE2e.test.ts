// The test plays the account service's JWKS endpoint, which needs a socket server.
// eslint-disable-next-line no-restricted-imports
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fakeBrowser, type FakeBrowser } from './fakeBrowser'

/**
 * The whole path against a relay run locally (`cd relay && npm run dev`), skipped unless
 * `RELAY_E2E_URL` names it: an MCP client signs in with the development token, the relay routes
 * its calls down the WebSocket of a browser that signed in with a device token, and the
 * browser's real MCP core answers. This test plays the account service too: it serves the JWKS
 * the relay checks device tokens against, on the port `relay/.dev.vars` names
 * (`DEVICE_JWT_ISSUER=http://127.0.0.1:9911`, `DEV_AGENT_TOKEN=local-e2e-token-0123456789`).
 */

const RELAY = process.env.RELAY_E2E_URL
const AGENT_TOKEN = process.env.RELAY_E2E_AGENT_TOKEN ?? 'local-e2e-token-0123456789'
const ISSUER = 'http://127.0.0.1:9911'

const enc = (v: unknown): string =>
  Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')

async function deviceToken(key: CryptoKey, sid: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const head = enc({ alg: 'ES256', kid: 'e2e', typ: 'JWT' })
  const body = enc({
    iss: ISSUER,
    sub: 'user_e2e',
    aud: 'zenium-device',
    sid,
    iat: now,
    exp: now + 3600
  })
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(`${head}.${body}`)
  )
  return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`
}

let jwks: Server
let key: CryptoKeyPair
const browsers: FakeBrowser[] = []

async function browser(sid: string, name: string): Promise<FakeBrowser> {
  const fake = fakeBrowser()
  browsers.push(fake)
  const token = await deviceToken(key.privateKey, sid)
  Object.assign(fake.browser as object, {
    sync: {
      accountAccessToken: async () => token,
      accountDevice: () => ({ name, kind: 'laptop' })
    }
  })
  ;(fake.browser.platform as unknown as { dialogs: unknown }).dialogs = {
    confirm: async () => true
  }
  const agents = fake.browser.state.settings.agents
  agents.remote = true
  agents.relayUrl = RELAY!
  agents.remoteApprovedClients = []
  fake.service.start()
  for (let i = 0; i < 100 && fake.service.relay.state.state !== 'connected'; i++)
    await new Promise((r) => setTimeout(r, 50))
  expect(fake.service.relay.state.state).toBe('connected')
  return fake
}

let sessionId: string | null = null
let nextId = 1
// The replies are read loosely: each test names the fields it checks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

async function mcp(method: string, params: Record<string, unknown> = {}): Promise<Json> {
  const res = await fetch(`${RELAY}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${AGENT_TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params })
  })
  sessionId = res.headers.get('mcp-session-id') ?? sessionId
  expect(res.status).toBe(200)
  return res.json()
}

const text = (reply: Json): string =>
  (reply.result.content as { text?: string }[]).map((c) => c.text ?? '').join('\n')

describe.skipIf(!RELAY)('hosted relay end to end', () => {
  beforeAll(async () => {
    key = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify'
    ])) as CryptoKeyPair
    const pub = await crypto.subtle.exportKey('jwk', key.publicKey)
    jwks = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ keys: [{ ...pub, kid: 'e2e', alg: 'ES256' }] }))
    })
    await new Promise<void>((r) => jwks.listen(9911, '127.0.0.1', r))
  })

  afterAll(async () => {
    for (const b of browsers.splice(0)) await b.stop()
    await new Promise((r) => jwks.close(r))
  })

  it('an agent signs in, finds the browser, and drives it', async () => {
    await browser('laptop-session', 'E2E Laptop')
    const init = await mcp('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'E2E Agent', version: '1' }
    })
    expect(init.result.serverInfo.name).toBe('zenium')
    expect(sessionId).toBeTruthy()

    const tools = await mcp('tools/list')
    const names = (tools.result.tools as { name: string }[]).map((t) => t.name)
    expect(names[0]).toBe('zen_devices')
    expect(names).toContain('browser_navigate')
    const nav = (tools.result.tools as Json[]).find((t) => t.name === 'browser_navigate')
    expect(nav.inputSchema.properties.device).toBeDefined()

    const devices = await mcp('tools/call', { name: 'zen_devices', arguments: {} })
    expect(text(devices)).toContain('"E2E Laptop", laptop, online')

    const opened = await mcp('tools/call', {
      name: 'browser_tabs',
      arguments: { action: 'new', url: 'https://example.com/', device: 'e2e laptop' }
    })
    expect(opened.result.isError).toBeFalsy()
    expect(text(opened)).toContain('Pass tabId')
  })

  it('with two browsers online, calls go where the agent says', async () => {
    const desk = await browser('desk-session', 'E2E Desktop')
    const before = desk.service.list().length
    const status = await mcp('tools/call', {
      name: 'zen_status',
      arguments: { device: 'E2E Desktop' }
    })
    expect(status.result.isError).toBeFalsy()
    expect(desk.service.list().length).toBe(before + 1)
    // Without a device the session stays on the browser it used last.
    const again = await mcp('tools/call', { name: 'zen_status', arguments: {} })
    expect(text(again)).toContain('(on "E2E Desktop"')
  })

  it('a browser going offline is reported, not waited for', async () => {
    const desk = browsers[1]
    desk.service.relay.stop()
    await new Promise((r) => setTimeout(r, 300))
    const reply = await mcp('tools/call', {
      name: 'zen_status',
      arguments: { device: 'E2E Desktop' }
    })
    expect(reply.result.isError).toBe(true)
    expect(text(reply)).toContain('is offline')
  })

  it('ending the session closes it in the browser', async () => {
    const laptop = browsers[0]
    expect(laptop.service.list().some((a) => a.transport === 'relay')).toBe(true)
    const res = await fetch(`${RELAY}/mcp`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${AGENT_TOKEN}`, 'mcp-session-id': sessionId! }
    })
    expect(res.status).toBe(204)
    for (let i = 0; i < 40 && laptop.service.list().some((a) => a.transport === 'relay'); i++)
      await new Promise((r) => setTimeout(r, 50))
    expect(laptop.service.list().some((a) => a.transport === 'relay')).toBe(false)
  })
})
