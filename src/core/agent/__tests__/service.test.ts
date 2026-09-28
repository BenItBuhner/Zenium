import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { DEFAULT_AGENT_SETTINGS } from '../../../shared/defaults'
import type { AgentSettings, AgentSkillStatus } from '../../../shared/types'
import { Bridge, type NativeBridge, type NativeCall } from '../../../android/bridge'
import { AndroidStoreIO } from '../../../android/storeIo'
import type { Browser } from '../../browser'
import { emptyModel } from '../../model'
import type { AgentSkillsHost, AgentTransport, StoreIO } from '../../platform'
import { AgentService, type EndpointError } from '../service'

const AGENT_FILE = 'agent.json'
const PORT = 41739

interface Stored {
  token: string
  running: boolean
  port?: number
  url?: string | null
  error?: EndpointError
}

/**
 * What the two hosts have in common for this test: writes land on the "disk" some time after
 * they were issued, and – the point – not in the order they were issued. `settle` completes the
 * pending writes newest first, so two writes in flight at once always land reversed, and keeps
 * going until nothing is pending any more (a write queued behind another only starts once that
 * one has landed).
 */
interface Host {
  io: StoreIO
  /** The document as the host would have it on disk (what the `zen --mcp` shim reads). */
  disk: () => string | null
  /** Texts in the order they were handed to the host. */
  issued: string[]
  /** Texts in the order they landed. */
  landed: string[]
  settle: () => Promise<void>
}

async function drain(pending: Array<() => void>): Promise<void> {
  for (let round = 0; round < 20; round++) {
    await new Promise((r) => setTimeout(r, 0))
    while (pending.length > 0) pending.pop()!()
  }
}

/** A `FileStoreIO`-shaped host: the temp file is renamed into place when the promise settles. */
function desktopHost(initial: Record<string, string> = {}): Host {
  const files = new Map(Object.entries(initial))
  const pending: Array<() => void> = []
  const issued: string[] = []
  const landed: string[] = []
  const io: StoreIO = {
    readSync: (name) => files.get(name) ?? null,
    write: (name, text) => {
      issued.push(text)
      return new Promise<void>((resolve) => {
        pending.push(() => {
          files.set(name, text)
          landed.push(text)
          resolve()
        })
      })
    },
    writeSync: (name, text) => {
      files.set(name, text)
    }
  }
  return {
    io,
    disk: () => files.get(AGENT_FILE) ?? null,
    issued,
    landed,
    settle: () => drain(pending)
  }
}

/**
 * The Android host: `AndroidStoreIO` over the JS half of the Kotlin bridge, with a native side
 * whose `storage.write` answers land newest first.
 */
function androidHost(initial: Record<string, string> = {}): Host {
  const disk = new Map(Object.entries(initial))
  const pending: Array<() => void> = []
  const issued: string[] = []
  const landed: string[] = []
  let bridge: Bridge | null = null
  const native: NativeBridge = {
    call: (json) => {
      const { id, method, args } = JSON.parse(json) as NativeCall
      const { name, text } = args as { name: string; text: string }
      if (method !== 'storage.write') throw new Error(`unexpected native call ${method}`)
      issued.push(text)
      pending.push(() => {
        disk.set(name, text)
        landed.push(text)
        bridge?.resolve(id, null)
      })
    },
    callSync: () => {
      throw new Error('no synchronous native call expected')
    }
  }
  bridge = new Bridge(native)
  const io = new AndroidStoreIO(bridge, { ...initial })
  return {
    io,
    disk: () => disk.get(AGENT_FILE) ?? null,
    issued,
    landed,
    settle: () => drain(pending)
  }
}

/** A transport that binds whatever it is asked (the fixture's default). */
const bindingTransport: AgentTransport = {
  start: async (options) => ({ port: options.port, lanAddresses: [] }),
  stop: async () => undefined
}

function fakeBrowser(
  io: StoreIO,
  settings: Partial<AgentSettings> = {},
  agentSkills?: AgentSkillsHost,
  transport: AgentTransport = bindingTransport
): Browser {
  const browser = {
    platform: {
      io,
      info: { version: '0.0.0-test' },
      createAgentTransport: () => transport,
      dialogs: { confirm: async () => false },
      agentSkills
    },
    state: {
      // `start()` reads the model for the one-time upgrade of the agents' marks.
      model: emptyModel([{ id: 'default', name: 'Default', color: '#888' } as never]),
      settings: {
        agents: { ...DEFAULT_AGENT_SETTINGS, enabled: true, port: PORT, ...settings }
      },
      commit: () => undefined,
      commitVolatile: () => undefined
    }
  }
  return browser as unknown as Browser
}

const parse = (text: string | null): Stored => JSON.parse(text ?? 'null') as Stored

/** Services under test with their hosts: the stop's own write needs the host to land it. */
const running: Array<{ service: AgentService; host: Host }> = []
function create(
  host: Host,
  settings: Partial<AgentSettings> = {},
  agentSkills?: AgentSkillsHost,
  transport?: AgentTransport
): AgentService {
  const service = new AgentService(fakeBrowser(host.io, settings, agentSkills, transport))
  running.push({ service, host })
  return service
}
afterEach(async () => {
  for (const { service, host } of running.splice(0)) {
    const stopping = service.stop()
    await host.settle()
    await stopping
  }
})

const hosts: Array<[string, (initial?: Record<string, string>) => Host]> = [
  ['desktop (FileStoreIO-shaped)', desktopHost],
  ['Android (AndroidStoreIO over the bridge)', androidHost]
]

describe.each(hosts)('agent.json on %s', (_name, makeHost) => {
  it('ends at the last state on a first run although writes land out of order', async () => {
    const host = makeHost()
    const service = create(host)
    const token = service.serverStatus().token
    expect(token.length).toBeGreaterThanOrEqual(32)
    expect(host.disk()).toBeNull()

    service.start()
    await host.settle()
    expect(service.serverStatus()).toMatchObject({
      running: true,
      url: `http://127.0.0.1:${PORT}/mcp`,
      token
    })
    // Both writes were issued in order and – the mint's awaited before the endpoint's started –
    // landed in that order too, so the shim finds the server it should connect to.
    expect(host.issued.map(parse)).toEqual([
      { token, running: false },
      { token, running: true, port: PORT, url: `http://127.0.0.1:${PORT}/mcp` }
    ])
    expect(host.landed).toEqual(host.issued)
    expect(parse(host.disk())).toEqual({
      token,
      running: true,
      port: PORT,
      url: `http://127.0.0.1:${PORT}/mcp`
    })
  })

  it('keeps later writes ordered too: regenerated tokens and the stop', async () => {
    const host = makeHost()
    const service = create(host)
    service.start()
    await host.settle()
    const first = service.regenerateToken()
    const second = service.regenerateToken()
    expect(second).not.toBe(first)
    const stopping = service.stop()
    await host.settle()
    await stopping
    expect(host.landed).toEqual(host.issued)
    expect(host.issued.map(parse).slice(-3)).toEqual([
      { token: first, running: true, port: PORT, url: `http://127.0.0.1:${PORT}/mcp` },
      { token: second, running: true, port: PORT, url: `http://127.0.0.1:${PORT}/mcp` },
      { token: second, running: false, url: null }
    ])
    expect(parse(host.disk())).toEqual({ token: second, running: false, url: null })
  })

  it('reuses a stored token without writing, and re-mints over a corrupt file', async () => {
    const stored = 'a'.repeat(40)
    const kept = makeHost({ [AGENT_FILE]: JSON.stringify({ token: stored, running: false }) })
    const service = create(kept)
    expect(service.serverStatus().token).toBe(stored)
    expect(kept.issued).toEqual([])
    service.start()
    await kept.settle()
    expect(parse(kept.disk())).toMatchObject({ token: stored, running: true, port: PORT })

    for (const corrupt of ['{not json', JSON.stringify({ token: 'short' }), '']) {
      const host = makeHost({ [AGENT_FILE]: corrupt })
      const minted = create(host)
      const token = minted.serverStatus().token
      expect(token).not.toBe('short')
      expect(token.length).toBeGreaterThanOrEqual(32)
      minted.start()
      await host.settle()
      expect(host.landed).toEqual(host.issued)
      expect(parse(host.disk())).toEqual({
        token,
        running: true,
        port: PORT,
        url: `http://127.0.0.1:${PORT}/mcp`
      })
    }
  })

  it('leaves the file at running: false when the server is off', async () => {
    const host = makeHost()
    const service = create(host, { enabled: false })
    service.start()
    await host.settle()
    expect(service.serverStatus().running).toBe(false)
    expect(parse(host.disk())).toEqual({ token: service.serverStatus().token, running: false })
  })
})

/*
 * A bind that fails – the port taken, no permission – used to leave `agent.json` at
 * `{ token, running: false, url: null }` and say nothing anywhere else: the Settings row alone
 * knew (`status.error`), and a harness that waited for `running: true` timed out with nothing to
 * read (main's boot smoke at e64f09dcc). Now the same write carries the reason under `error`
 * and one `console.error` line names it; the bound document is byte for byte what it was.
 */
const IN_USE = `Port ${PORT} is already in use – pick another port in Settings → AI Agents`
const URL_OF = (port: number): string => `http://127.0.0.1:${port}/mcp`
/** The desktop transport's rejection: the Settings message, the code and the address tried on it. */
const taken = (): Error =>
  Object.assign(new Error(IN_USE), { code: 'EADDRINUSE', address: '127.0.0.1', port: PORT })

/** A transport that refuses every start with `error`, counting the attempts. */
function refusing(error: unknown): AgentTransport & { starts: number } {
  const t = {
    starts: 0,
    start: async (): Promise<{ port: number; lanAddresses: string[] }> => {
      t.starts++
      throw error
    },
    stop: async (): Promise<void> => undefined
  }
  return t
}

describe.each(hosts)('a bind failure on %s', (_name, makeHost) => {
  let errors: MockInstance
  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    errors.mockRestore()
  })

  it('writes why beside running: false and says it once on stderr, without a retry', async () => {
    const host = makeHost()
    const transport = refusing(taken())
    const service = create(host, {}, undefined, transport)
    const token = service.serverStatus().token
    service.start()
    await host.settle()
    expect(transport.starts).toBe(1)
    expect(service.serverStatus()).toEqual({
      running: false,
      url: null,
      lanUrls: [],
      token,
      error: IN_USE
    })
    const error: EndpointError = {
      code: 'EADDRINUSE',
      message: IN_USE,
      address: '127.0.0.1',
      port: PORT
    }
    // The mint's write, then the one that used to say `running: false` and no more.
    expect(host.issued.map(parse)).toEqual([
      { token, running: false },
      { token, running: false, url: null, error }
    ])
    expect(host.landed).toEqual(host.issued)
    expect(host.disk()).toBe(JSON.stringify({ token, running: false, url: null, error }, null, 2))
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors).toHaveBeenCalledWith(
      `[zen mcp] the server could not bind 127.0.0.1:${PORT} (EADDRINUSE): ${IN_USE}`
    )
  })

  it('carries a message-only rejection with what the service asked for (the phone names no code)', async () => {
    const host = makeHost()
    const message = 'bind failed: EADDRINUSE (Address already in use)'
    const service = create(host, { lan: true, port: 0 }, undefined, refusing(new Error(message)))
    const token = service.serverStatus().token
    service.start()
    await host.settle()
    expect(service.serverStatus().error).toBe(message)
    expect(parse(host.disk())).toEqual({
      token,
      running: false,
      url: null,
      error: { code: null, message, address: '0.0.0.0', port: 0 }
    })
    expect(errors).toHaveBeenCalledWith(`[zen mcp] the server could not bind 0.0.0.0:0: ${message}`)
  })

  it('falls back to the fixed sentence when the rejection has no message, in both places', async () => {
    const host = makeHost()
    const service = create(host, {}, undefined, refusing('boom'))
    const token = service.serverStatus().token
    service.start()
    await host.settle()
    const message = 'Could not start the MCP server'
    expect(service.serverStatus().error).toBe(message)
    expect(parse(host.disk())).toEqual({
      token,
      running: false,
      url: null,
      error: { code: null, message, address: '127.0.0.1', port: PORT }
    })
    expect(errors).toHaveBeenCalledWith(
      `[zen mcp] the server could not bind 127.0.0.1:${PORT}: ${message}`
    )
  })

  it('keeps the reason through a token regeneration while down', async () => {
    const host = makeHost()
    const service = create(host, {}, undefined, refusing(taken()))
    service.start()
    await host.settle()
    const fresh = service.regenerateToken()
    await host.settle()
    expect(parse(host.disk())).toEqual({
      token: fresh,
      running: false,
      url: null,
      error: { code: 'EADDRINUSE', message: IN_USE, address: '127.0.0.1', port: PORT }
    })
  })

  it('drops the field the moment a start succeeds: the bound document is byte-identical to before', async () => {
    const host = makeHost()
    let refuse = true
    const transport: AgentTransport = {
      start: async (options) => {
        if (refuse) throw taken()
        return { port: options.port, lanAddresses: [] }
      },
      stop: async () => undefined
    }
    const service = create(host, {}, undefined, transport)
    const token = service.serverStatus().token
    service.start()
    await host.settle()
    expect(parse(host.disk()).error).toBeDefined()

    refuse = false
    service.onSettingsChanged()
    await host.settle()
    expect(service.serverStatus()).toMatchObject({ running: true, url: URL_OF(PORT), error: null })
    expect(host.disk()).toBe(
      JSON.stringify({ token, running: true, port: PORT, url: URL_OF(PORT) }, null, 2)
    )

    // And the stop after it says no more than it did: `running: false`, no reason.
    const stopping = service.stop()
    await host.settle()
    await stopping
    expect(host.disk()).toBe(JSON.stringify({ token, running: false, url: null }, null, 2))
    expect(errors).toHaveBeenCalledTimes(1)
  })

  it('pins the documents of a run without a failure to the byte', async () => {
    const host = makeHost()
    const service = create(host)
    const token = service.serverStatus().token
    service.start()
    await host.settle()
    expect(host.issued).toEqual([
      JSON.stringify({ token, running: false }),
      JSON.stringify({ token, running: true, port: PORT, url: URL_OF(PORT) }, null, 2)
    ])
    expect(errors).not.toHaveBeenCalled()
  })
})

/*
 * The Agent Skill host (`Platform.agentSkills`): the contract has it report failures inside the
 * status, so what it returns is the state as it is; anything it throws all the same is the last
 * resort – logged whole, shown as a plain sentence with the code and never a message carrying
 * paths.
 */
describe('the Agent Skill host', () => {
  it('keeps what the host reports and turns what it throws into a sentence without paths', async () => {
    const reported: AgentSkillStatus = {
      version: '0.0.0-test',
      targets: [],
      error: 'Could not install: no permission to write ~/.codex/skills/zenium-browser'
    }
    let throwing: unknown = null
    const skills: AgentSkillsHost = {
      status: async () => reported,
      install: async () => {
        if (throwing) throw throwing
        return reported
      },
      uninstall: async () => reported
    }
    const service = create(desktopHost(), { enabled: false }, skills)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await service.installSkill(['codex'])
      expect(service.skillStatus()).toBe(reported)
      expect(errors).not.toHaveBeenCalled()

      const thrown: NodeJS.ErrnoException = new Error(
        "EACCES: permission denied, open '/home/someone/.config/zenium/zen/skills.json.1.tmp'"
      )
      thrown.code = 'EACCES'
      throwing = thrown
      await service.installSkill()
      expect(service.skillStatus()).toEqual({
        ...reported,
        error: 'The agent skill could not be updated (EACCES)'
      })
      expect(errors).toHaveBeenCalledWith('[zenium] agent skill host threw:', thrown)

      throwing = new Error('no code on this one')
      await service.installSkill()
      expect(service.skillStatus().error).toBe('The agent skill could not be updated')
    } finally {
      errors.mockRestore()
    }
  })

  it('does nothing without a host, as on a phone', async () => {
    const service = create(desktopHost(), { enabled: false })
    await service.refreshSkill()
    await service.installSkill()
    expect(service.skillStatus()).toEqual({ version: '0.0.0-test', targets: [], error: null })
  })
})
