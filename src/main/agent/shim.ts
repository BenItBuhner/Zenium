import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/**
 * `zen --mcp`: the stdio face of the MCP server, for agent clients that launch a command rather
 * than connect to a URL. The running browser owns the server; this process only relays each
 * newline-delimited JSON-RPC message from stdin to `http://127.0.0.1:<port>/mcp` (found in the
 * profile's `zen/agent.json`, together with the token that skips the approval prompt) and writes
 * the responses to stdout. When stdin closes the session is deleted and the process exits.
 */
export async function runStdioShim(userDataDir: string): Promise<number> {
  const endpoint = readEndpoint(userDataDir)
  if (!endpoint) {
    process.stderr.write(
      'zen --mcp: the Zen browser is not running with its MCP server enabled. Start Zen and turn on Settings → AI Agents.\n'
    )
    return 2
  }
  let sessionId: string | null = null
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const write = (message: unknown): void => {
    process.stdout.write(JSON.stringify(message) + '\n')
  }
  // Messages are relayed in order: a client must never see the response to its second request
  // before the first (initialize) has assigned the session.
  let chain: Promise<void> = Promise.resolve()
  rl.on('line', (line) => {
    const text = line.trim()
    if (!text) return
    chain = chain.then(async () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
        return
      }
      try {
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${endpoint.token}`,
          'user-agent': 'zen-mcp-stdio'
        }
        if (sessionId) headers['mcp-session-id'] = sessionId
        const res = await fetch(endpoint.url, { method: 'POST', headers, body: text })
        const sid = res.headers.get('mcp-session-id')
        if (sid) sessionId = sid
        if (res.status === 202) return
        const body = await res.text()
        if (!body) return
        const message = JSON.parse(body)
        if (Array.isArray(message)) for (const m of message) write(m)
        else write(message)
      } catch (error) {
        const id = isObjectWithId(parsed) ? parsed.id : null
        if (id === null || id === undefined) return
        write({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: `Zen is not reachable: ${(error as Error).message}` }
        })
      }
    })
  })
  await new Promise<void>((resolve) => {
    rl.once('close', () => resolve())
  })
  await chain
  if (sessionId) {
    await fetch(endpoint.url, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId, authorization: `Bearer ${endpoint.token}` }
    }).catch(() => undefined)
  }
  return 0
}

function readEndpoint(userDataDir: string): { url: string; token: string } | null {
  try {
    const raw = JSON.parse(readFileSync(join(userDataDir, 'zen', 'agent.json'), 'utf8')) as {
      url?: string | null
      token?: string
      running?: boolean
    }
    if (!raw.running || !raw.url || !raw.token) return null
    return { url: raw.url, token: raw.token }
  } catch {
    return null
  }
}

function isObjectWithId(v: unknown): v is { id: string | number | null } {
  return typeof v === 'object' && v !== null && 'id' in v
}
