import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ElectronAgentTransport } from '../server'
import { readEndpoint } from '../shim'

/*
 * The desktop half of a bind failure. The transport used to reject with a fresh Error carrying
 * the Settings message alone, so the core could not name the code or the address in
 * `agent.json`'s `error` or its log line; now they ride on the error, the message untouched.
 * The shim reads `running`, `url` and `token` and nothing else: the field is invisible to it.
 */
describe('a bind failure on the desktop transport', () => {
  const open: Array<Server | ElectronAgentTransport> = []
  afterEach(async () => {
    for (const s of open.splice(0)) {
      if (s instanceof ElectronAgentTransport) await s.stop()
      else await new Promise<void>((resolve) => s.close(() => resolve()))
    }
  })

  const noRequests = async (): Promise<{
    status: number
    headers: Record<string, string>
    body: string
  }> => ({ status: 204, headers: {}, body: '' })

  it('rejects with the Settings message and the code, address and port tried on the error', async () => {
    const blocker = createServer()
    open.push(blocker)
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const port = (blocker.address() as AddressInfo).port

    const transport = new ElectronAgentTransport()
    open.push(transport)
    const rejection: unknown = await transport
      .start({ port, lan: false, onRequest: noRequests })
      .then(() => null)
      .catch((e: unknown) => e)
    expect(rejection).toBeInstanceOf(Error)
    expect(rejection).toMatchObject({
      message: `Port ${port} is already in use – pick another port in Settings → AI Agents`,
      code: 'EADDRINUSE',
      address: '127.0.0.1',
      port
    })
  })

  it('binds an ephemeral port as before when nothing is in the way', async () => {
    const transport = new ElectronAgentTransport()
    open.push(transport)
    const bound = await transport.start({ port: 0, lan: false, onRequest: noRequests })
    expect(bound.port).toBeGreaterThan(0)
    expect(bound.lanAddresses).toEqual([])
  })
})

describe("the shim's reader of agent.json", () => {
  const token = 'a'.repeat(40)
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function profileWith(document: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'zen-agent-bind-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'zen'))
    writeFileSync(join(dir, 'zen', 'agent.json'), JSON.stringify(document, null, 2))
    return dir
  }

  it('answers null while running is false, whatever error says beside it', () => {
    const dir = profileWith({
      token,
      running: false,
      url: null,
      error: {
        code: 'EADDRINUSE',
        message: 'Port 41735 is already in use – pick another port in Settings → AI Agents',
        address: '127.0.0.1',
        port: 41735
      }
    })
    expect(readEndpoint(dir)).toBeNull()
  })

  it('finds the bound endpoint as before', () => {
    const dir = profileWith({
      token,
      running: true,
      port: 41735,
      url: 'http://127.0.0.1:41735/mcp'
    })
    expect(readEndpoint(dir)).toEqual({ url: 'http://127.0.0.1:41735/mcp', token })
  })
})
