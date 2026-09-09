import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import type { AgentHttpRequest, AgentHttpResponse } from '../../core/agent/http'
import type { AgentTransport } from '../../core/platform'

/** Requests larger than this are refused before the body is read (a tool call is a few KB). */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * The MCP server's socket on Electron: a plain `node:http` server bound to the loopback address
 * (and, when the user opts in, to every interface). Everything protocol-shaped – sessions,
 * Origin/Host checks, JSON-RPC – happens in the core; this class only moves bytes.
 */
export class ElectronAgentTransport implements AgentTransport {
  private server: Server | null = null

  async start(options: {
    port: number
    lan: boolean
    onRequest: (request: AgentHttpRequest) => Promise<AgentHttpResponse>
  }): Promise<{ port: number; lanAddresses: string[] }> {
    await this.stop()
    const server = createServer((req, res) => {
      void this.handle(req, res, options.onRequest)
    })
    server.keepAliveTimeout = 65_000
    server.headersTimeout = 70_000
    const host = options.lan ? '0.0.0.0' : '127.0.0.1'
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.off('listening', onListening)
        reject(
          new Error(
            error.code === 'EADDRINUSE'
              ? `Port ${options.port} is already in use – pick another port in Settings → AI Agents`
              : error.message
          )
        )
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(options.port, host)
    })
    server.on('error', (error) => console.warn('[zen] agent server error:', error.message))
    this.server = server
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : options.port
    return { port, lanAddresses: options.lan ? lanAddresses() : [] }
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Idle keep-alive connections would otherwise hold `close` open.
      server.closeAllConnections?.()
    })
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
    onRequest: (request: AgentHttpRequest) => Promise<AgentHttpResponse>
  ): Promise<void> {
    let body: string
    try {
      body = await readBody(req)
    } catch (error) {
      res.writeHead((error as Error).message === 'too large' ? 413 : 400).end()
      return
    }
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[name] = value
      else if (Array.isArray(value)) headers[name] = value.join(', ')
    }
    let response: AgentHttpResponse
    try {
      response = await onRequest({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers,
        body,
        remoteAddress: req.socket.remoteAddress ?? ''
      })
    } catch (error) {
      console.warn('[zen] agent request failed:', error)
      response = {
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: (error as Error).message ?? 'Internal error' }
        })
      }
    }
    const outHeaders: Record<string, string> = { ...response.headers }
    if (response.body) outHeaders['content-length'] = String(Buffer.byteLength(response.body))
    res.writeHead(response.status, outHeaders)
    res.end(response.body)
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** IPv4 addresses other devices on the local network can reach this machine at. */
export function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.internal) continue
      if (info.family !== 'IPv4' && info.family !== (4 as unknown as string)) continue
      out.push(info.address)
    }
  }
  return out
}
