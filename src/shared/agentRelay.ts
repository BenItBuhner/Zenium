/**
 * The wire protocol between a browser and the hosted agent relay (`relay/` in this repository):
 * the browser keeps one WebSocket open to the relay while Settings → AI Agents → "Agents from
 * your Zenium account" is on, and the relay sends it the MCP calls of the agents that signed in
 * to the same account. The browser runs every call through its own MCP server core, exactly as
 * it runs a local agent's, and sends the response back on the same socket.
 *
 * Shared by the browser (`src/core/agent/relay.ts`) and the relay (`relay/src`), so the two never
 * disagree on a field name. JSON text frames only; one message per frame.
 */

/** The WebSocket subprotocol a browser offers, and the relay picks. */
export const RELAY_SUBPROTOCOL = 'zenium-relay.v1'
/**
 * The second subprotocol a browser offers: `bearer.<device access token>`. A browser WebSocket
 * cannot set an Authorization header, and a token in the URL ends up in access logs.
 */
export const RELAY_BEARER_PREFIX = 'bearer.'
/** The relay's path browsers connect to. */
export const RELAY_CONNECT_PATH = '/connect'
/** The relay's MCP endpoint agents connect to. */
export const RELAY_MCP_PATH = '/mcp'

/** Close codes the relay uses; the browser reconnects after any of them except `REPLACED`. */
export const RELAY_CLOSE = {
  /** The device token was refused or ran out without a renewal. */
  UNAUTHORIZED: 4401,
  /** The same device connected again; this socket is the stale one. */
  REPLACED: 4409,
  /** A frame the relay could not read. */
  BAD_MESSAGE: 4400
} as const

/** Who an agent is, as the relay verified it from the agent's OAuth token. */
export interface RelayClient {
  /** The OAuth client id (a URL for CIMD clients): what the browser's approval is remembered by. */
  id: string
  /** The name the agent gave in `initialize` (`clientInfo.name`), for prompts and badges. */
  name: string
  version: string
}

/** What the agent said in its `initialize`, replayed when a browser first sees its session. */
export interface RelayInit {
  protocolVersion: string
  capabilities: Record<string, unknown>
  clientInfo: { name: string; version: string }
}

// --- browser → relay -----------------------------------------------------------------------

/** First frame after the socket opens: what the account's device list and `zen_devices` show. */
export interface RelayHello {
  t: 'hello'
  name: string
  kind: 'desktop' | 'laptop' | 'phone' | 'tablet'
  /** The browser's version (`2026.10.1`), for the relay's logs and the device list. */
  version: string
}

/** A fresh device access token, sent before the one the socket was opened with runs out. */
export interface RelayToken {
  t: 'token'
  token: string
}

/** The answer to one `rpc` frame: the JSON-RPC response, or null for a notification. */
export interface RelayReply {
  t: 'reply'
  rid: string
  message: unknown
}

export type BrowserToRelay = RelayHello | RelayToken | RelayReply

// --- relay → browser -----------------------------------------------------------------------

/** The relay took the hello: the id this browser goes by in `zen_devices`. */
export interface RelayWelcome {
  t: 'welcome'
  deviceId: string
}

/**
 * One JSON-RPC message from an agent, for `session` (the relay's id for the agent's MCP
 * session; stable for as long as the agent keeps it). `init` lets the browser initialise a
 * session it has not seen yet – after its own restart, or the first call routed to it.
 */
export interface RelayRpc {
  t: 'rpc'
  rid: string
  session: string
  client: RelayClient
  init: RelayInit
  message: unknown
}

/** The agent ended its session (DELETE), or the relay forgot it: the browser closes its side. */
export interface RelayEnd {
  t: 'end'
  session: string
}

export type RelayToBrowser = RelayWelcome | RelayRpc | RelayEnd

/** Text frames both ends answer without waking anything (the relay's auto-response). */
export const RELAY_PING = 'ping'
export const RELAY_PONG = 'pong'

export function parseRelayFrame(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
