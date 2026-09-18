import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_SETTINGS } from '../../../shared/defaults'
import type { AgentSettings } from '../../../shared/types'
import { Bridge, type NativeBridge, type NativeCall } from '../../../android/bridge'
import { AndroidStoreIO } from '../../../android/storeIo'
import type { Browser } from '../../browser'
import type { AgentTransport, StoreIO } from '../../platform'
import { AgentService } from '../service'

const AGENT_FILE = 'agent.json'
const PORT = 41739

interface Stored {
  token: string
  running: boolean
  port?: number
  url?: string | null
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

function fakeBrowser(io: StoreIO, settings: Partial<AgentSettings> = {}): Browser {
  const transport: AgentTransport = {
    start: async (options) => ({ port: options.port, lanAddresses: [] }),
    stop: async () => undefined
  }
  const browser = {
    platform: {
      io,
      info: { version: '0.0.0-test' },
      createAgentTransport: () => transport,
      dialogs: { confirm: async () => false }
    },
    state: {
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
function create(host: Host, settings: Partial<AgentSettings> = {}): AgentService {
  const service = new AgentService(fakeBrowser(host.io, settings))
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
