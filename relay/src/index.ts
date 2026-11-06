import {
  RELAY_BEARER_PREFIX,
  RELAY_CONNECT_PATH,
  RELAY_MCP_PATH,
  RELAY_SUBPROTOCOL
} from '../../src/shared/agentRelay'
import { H } from './account'
import { trimSlash, verifyAgentToken, verifyDeviceToken, type RelayEnv } from './auth'

export { AccountRelay } from './account'

/**
 * The Worker in front of the account relays: the public MCP endpoint agents add
 * (`https://<host>/mcp`), the WebSocket endpoint browsers hold open (`/connect`), and the OAuth
 * protected-resource metadata (RFC 9728) that sends an agent to the Zenium account's Clerk
 * instance to sign in. Every request is authenticated here and handed to the account's
 * Durable Object; nothing else is stored or logged about it.
 */

const DEV_ACCOUNT = '__dev__'
const DEFAULT_SCOPES = ['openid', 'profile', 'email']

export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    if (path.startsWith('/.well-known/oauth-protected-resource')) return resourceMetadata(url, env)
    if (path === RELAY_CONNECT_PATH) return connect(request, env)
    if (path === RELAY_MCP_PATH) return mcp(request, url, env)
    if (path === '/')
      return new Response(
        `Zenium MCP endpoint. Add ${url.origin}${RELAY_MCP_PATH} to your agent and sign in with your Zenium account.\n`,
        { headers: { 'content-type': 'text/plain; charset=utf-8' } }
      )
    return new Response('Not found', { status: 404 })
  }
} satisfies ExportedHandler<RelayEnv>

function resourceMetadata(url: URL, env: RelayEnv): Response {
  const scopes =
    env.AGENT_SCOPES?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? DEFAULT_SCOPES
  return new Response(
    JSON.stringify({
      resource: `${url.origin}${RELAY_MCP_PATH}`,
      authorization_servers: env.AGENT_JWT_ISSUER ? [trimSlash(env.AGENT_JWT_ISSUER)] : [],
      scopes_supported: scopes,
      bearer_methods_supported: ['header'],
      resource_name: 'Zenium'
    }),
    {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=300',
        'access-control-allow-origin': '*'
      }
    }
  )
}

function unauthorized(url: URL, message: string): Response {
  return new Response(JSON.stringify({ error: 'invalid_token', error_description: message }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource${RELAY_MCP_PATH}"`
    }
  })
}

function bearer(request: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization')?.trim() ?? '')
  return m ? m[1].trim() : null
}

/** A copy of the request for the Durable Object, with only the headers this Worker vouches for. */
function forwardable(request: Request, url: URL, set: Record<string, string>): Request {
  const headers = new Headers(request.headers)
  for (const name of Object.values(H)) headers.delete(name)
  headers.delete('authorization')
  for (const [name, value] of Object.entries(set)) headers.set(name, value)
  return new Request(url.toString(), { method: request.method, headers, body: request.body })
}

async function mcp(request: Request, url: URL, env: RelayEnv): Promise<Response> {
  // Browsers send Origin on cross-site requests and MCP clients do not; nothing legitimate
  // calls this endpoint from a web page (the spec's DNS-rebinding / CSRF rule).
  if (request.headers.get('origin')) return new Response('Forbidden origin', { status: 403 })
  const token = bearer(request)
  if (!token) return unauthorized(url, 'Sign in with your Zenium account')
  const agent = await verifyAgentToken(token, env)
  if (!agent) return unauthorized(url, 'The access token was refused')
  let userId = agent.userId
  if (userId === 'dev') {
    const res = await stub(env, DEV_ACCOUNT).fetch('https://relay/dev/user')
    userId = await res.text()
    if (!userId)
      return new Response('DEV_AGENT_TOKEN: no browser has connected to this relay yet', {
        status: 503
      })
  }
  return stub(env, userId).fetch(
    forwardable(request, new URL(`https://relay${RELAY_MCP_PATH}`), {
      [H.user]: userId,
      [H.client]: agent.clientId,
      [H.scopes]: agent.scopes.join(' ')
    })
  )
}

async function connect(request: Request, env: RelayEnv): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
    return new Response('Expected a WebSocket upgrade', { status: 426 })
  const offered = (request.headers.get('sec-websocket-protocol') ?? '')
    .split(',')
    .map((s) => s.trim())
  if (!offered.includes(RELAY_SUBPROTOCOL)) return new Response('Unknown protocol', { status: 400 })
  const token = offered
    .find((p) => p.startsWith(RELAY_BEARER_PREFIX))
    ?.slice(RELAY_BEARER_PREFIX.length)
  const device = token ? await verifyDeviceToken(token, env) : null
  if (!device) return new Response('Device token refused', { status: 401 })
  if (env.DEV_AGENT_TOKEN)
    await stub(env, DEV_ACCOUNT).fetch('https://relay/dev/user', {
      method: 'PUT',
      body: device.userId
    })
  return stub(env, device.userId).fetch(
    forwardable(request, new URL(`https://relay${RELAY_CONNECT_PATH}`), {
      [H.user]: device.userId,
      [H.device]: device.deviceId,
      [H.exp]: String(device.exp)
    })
  )
}

function stub(env: RelayEnv, account: string): DurableObjectStub {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(account))
}
