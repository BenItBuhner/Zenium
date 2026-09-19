import { JsonStore } from '@core/store/JsonStore'
import { describe, expect, it, vi } from 'vitest'
import type { Bridge } from '../bridge'
import { AndroidStoreIO, CHUNK_CHARS, readDocument } from '../storeIo'

interface Call {
  method: string
  args: Record<string, unknown>
}

/**
 * A bridge that records every call and answers `storage.*` from `disk`, the way the Kotlin host
 * does: `storage.write` lands the bytes (or rejects, for a name in `failing`), `storage.writeSync`
 * answers `true` once landed and nothing when it could not.
 */
function fakeBridge(
  disk: Record<string, string> = {},
  failing: ReadonlySet<string> = new Set()
): { bridge: Bridge; calls: Call[]; disk: Record<string, string> } {
  const calls: Call[] = []
  const answer = (method: string, args: Record<string, unknown>): unknown => {
    calls.push({ method, args })
    const name = args.name as string
    switch (method) {
      case 'storage.read':
        return disk[name] ?? null
      case 'storage.exists':
        return name in disk
      case 'storage.write':
        if (failing.has(name)) throw new Error(`could not write ${name}`)
        disk[name] = args.text as string
        return null
      case 'storage.writeSync':
        if (failing.has(name)) return undefined
        disk[name] = args.text as string
        return true
      case 'storage.remove':
        delete disk[name]
        return null
      default:
        return null
    }
  }
  const bridge = {
    call: async (method: string, args: Record<string, unknown>) => answer(method, args),
    callSync: (method: string, args: Record<string, unknown>) => answer(method, args),
    send: (method: string, args: Record<string, unknown>) => {
      answer(method, args)
    }
  } as unknown as Bridge
  return { bridge, calls, disk }
}

const INDEX = '{"version":1,"sets":[{"id":"zen-default","priority":10,"enabled":true}]}'
const FEED = '{"version":1,"id":"phishing-database","prefixes":"' + 'A'.repeat(1024) + '"}'
/** A session too big for the payload's inline limit: the manifest names it instead. */
const BIG_STATE = JSON.stringify({
  version: 9,
  tabs: Array.from({ length: 400 }, (_, i) => ({ url: `https://example.com/${i}` }))
})

const manifest = (...names: string[]): Array<{ name: string; bytes: number; etag: string }> =>
  names.map((name) => ({ name, bytes: 100_000, etag: `186a0-1a0b95b9f5f` }))

describe('AndroidStoreIO', () => {
  it('serves the payload documents from memory and reads the rest through the bridge', () => {
    const { bridge, calls } = fakeBridge({ 'blocking/list-1.json': '{"filterText":"||ads^"}' })
    const io = new AndroidStoreIO(bridge, { 'state.json': '{"tabs":[]}' })
    expect(io.readSync('state.json')).toBe('{"tabs":[]}')
    expect(calls).toEqual([])
    expect(io.readSync('blocking/list-1.json')).toBe('{"filterText":"||ads^"}')
    expect(calls).toEqual([{ method: 'storage.read', args: { name: 'blocking/list-1.json' } }])
  })

  it('asks the host about a root document the payload did not carry: absent only when the host says so', () => {
    const { bridge, calls, disk } = fakeBridge({ 'state.json.bak': '{"tabs":[1]}' })
    const io = new AndroidStoreIO(bridge, { 'state.json': '{"tabs":[]}' })
    expect(io.readSync('missing.json')).toBeNull()
    // The backup the host keeps for the session store is readable, as it is on the desktop.
    expect(io.readSync('state.json.bak')).toBe('{"tabs":[1]}')
    expect(calls.map((c) => c.args.name)).toEqual(['missing.json', 'state.json.bak'])
    // A backup is never mirrored: the host rotates it under a write of the document, and a
    // read after that must see the rotation, not the copy of before.
    disk['state.json.bak'] = '{"tabs":[1,2]}'
    expect(io.readSync('state.json.bak')).toBe('{"tabs":[1,2]}')
    expect(io.exists('state.json.bak')).toBe(true)
    expect(calls.map((c) => c.method)).toEqual([
      'storage.read',
      'storage.read',
      'storage.read',
      'storage.exists'
    ])
  })

  describe('one transfer per boot document', () => {
    it('hands a deferred folder document to the core once, then lets go of it', () => {
      const { bridge, calls } = fakeBridge({ 'safebrowsing/phishing-database.json': FEED })
      const io = new AndroidStoreIO(bridge, {}, manifest('safebrowsing/phishing-database.json'))
      io.adopt({ 'safebrowsing/phishing-database.json': FEED })
      expect(io.exists('safebrowsing/phishing-database.json')).toBe(true)
      expect(io.readSync('safebrowsing/phishing-database.json')).toBe(FEED)
      // The core keeps what it parsed; the chrome holds no second copy of the megabytes.
      expect(calls).toEqual([])
      expect(io.readSync('safebrowsing/phishing-database.json')).toBe(FEED)
      expect(calls).toEqual([
        { method: 'storage.read', args: { name: 'safebrowsing/phishing-database.json' } }
      ])
    })

    it('never mirrors a Safe Browsing document, not even one the payload inlined while it was small', async () => {
      const { bridge, calls } = fakeBridge({ 'safebrowsing/urlhaus.json': '{"prefixes":""}' })
      const files = { 'state.json': '{}', 'safebrowsing/urlhaus.json': '{"prefixes":""}' }
      const io = new AndroidStoreIO(bridge, files)
      expect(files).toEqual({ 'state.json': '{}' })
      expect(io.readSync('safebrowsing/urlhaus.json')).toBe('{"prefixes":""}')
      expect(calls).toEqual([])
      // The refreshed feed, megabytes now, is written and not kept here: the next read asks the host.
      await io.write('safebrowsing/urlhaus.json', FEED)
      await io.write('safebrowsing/urlhaus.json', FEED)
      expect(calls.map((c) => c.method)).toEqual(['storage.write', 'storage.write'])
      expect(io.readSync('safebrowsing/urlhaus.json')).toBe(FEED)
      expect(calls).toHaveLength(3)
      expect(files).toEqual({ 'state.json': '{}' })
    })

    it('mirrors a deferred root document or rule index like one the payload carried inline', () => {
      const { bridge, calls } = fakeBridge()
      const io = new AndroidStoreIO(
        bridge,
        { 'state.json': '{}' },
        manifest('blocking/index.json', 'history.json')
      )
      io.adopt({ 'blocking/index.json': INDEX, 'history.json': '{"items":[]}' })
      expect(io.readSync('blocking/index.json')).toBe(INDEX)
      expect(io.readSync('blocking/index.json')).toBe(INDEX)
      expect(io.readSync('history.json')).toBe('{"items":[]}')
      expect(calls).toEqual([])
    })

    it('does not send the engine its own index back when it writes the bytes it was booted with', async () => {
      const { bridge, calls } = fakeBridge()
      const io = new AndroidStoreIO(bridge, { 'blocking/index.json': INDEX, 'state.json': '{}' })
      await io.write('blocking/index.json', INDEX)
      io.writeSync('blocking/index.json', INDEX)
      io.writeSync('state.json', '{}')
      expect(calls).toEqual([])
    })

    it('still writes a change, and remembers it so the next identical write is skipped', async () => {
      const { bridge, calls } = fakeBridge()
      const io = new AndroidStoreIO(bridge, { 'blocking/index.json': INDEX })
      const changed = INDEX.replace('"enabled":true', '"enabled":false')
      await io.write('blocking/index.json', changed)
      expect(calls).toEqual([
        {
          method: 'storage.write',
          args: { name: 'blocking/index.json', text: changed, backup: false }
        }
      ])
      await io.write('blocking/index.json', changed)
      expect(calls).toHaveLength(1)
      expect(io.readSync('blocking/index.json')).toBe(changed)
      io.writeSync('blocking/index.json', INDEX)
      expect(calls).toHaveLength(2)
      expect(calls[1]).toEqual({
        method: 'storage.writeSync',
        args: { name: 'blocking/index.json', text: INDEX, backup: false }
      })
    })

    it('never dedups a folder document it does not mirror', async () => {
      const { bridge, calls } = fakeBridge()
      const io = new AndroidStoreIO(bridge, {})
      await io.write('blocking/list-1.json', '{"filterText":"||ads^"}')
      await io.write('blocking/list-1.json', '{"filterText":"||ads^"}')
      expect(calls.map((c) => c.method)).toEqual(['storage.write', 'storage.write'])
    })
  })

  describe('a deferred document read before its file arrives', () => {
    it('comes through the bridge once, and the later adopt keeps what the core read', () => {
      const { bridge, calls } = fakeBridge({ 'state.json': BIG_STATE })
      const io = new AndroidStoreIO(bridge, { 'history.json': '{}' }, manifest('state.json'))
      expect(io.exists('state.json')).toBe(true)
      expect(io.readSync('state.json')).toBe(BIG_STATE)
      expect(io.readSync('state.json')).toBe(BIG_STATE)
      expect(calls).toEqual([
        { method: 'storage.exists', args: { name: 'state.json' } },
        { method: 'storage.read', args: { name: 'state.json' } }
      ])
      // The fetch answers late, with the copy it opened before the core moved on.
      io.adopt({ 'state.json': '{"version":9,"tabs":[]}' })
      expect(io.readSync('state.json')).toBe(BIG_STATE)
      expect(calls).toHaveLength(2)
    })

    it('does not hand a folder document the core already read a second time', () => {
      const { bridge, calls } = fakeBridge({ 'safebrowsing/phishing-database.json': FEED })
      const io = new AndroidStoreIO(bridge, {}, manifest('safebrowsing/phishing-database.json'))
      expect(io.readSync('safebrowsing/phishing-database.json')).toBe(FEED)
      io.adopt({ 'safebrowsing/phishing-database.json': FEED })
      expect(io.readSync('safebrowsing/phishing-database.json')).toBe(FEED)
      expect(calls.map((c) => c.method)).toEqual(['storage.read', 'storage.read'])
    })

    it('keeps what the core wrote in the meantime over the fetched copy', async () => {
      const { bridge } = fakeBridge({ 'state.json': BIG_STATE })
      const io = new AndroidStoreIO(bridge, {}, manifest('state.json'))
      expect(io.readSync('state.json')).toBe(BIG_STATE)
      await io.write('state.json', '{"version":9,"tabs":[{"url":"https://zen.example/"}]}')
      io.adopt({ 'state.json': BIG_STATE })
      expect(io.readSync('state.json')).toBe(
        '{"version":9,"tabs":[{"url":"https://zen.example/"}]}'
      )
    })

    it('keeps what the core wrote to a folder document too, and does not hand the fetched copy out later', async () => {
      const refreshed = FEED.replace('"A', '"B')
      const { bridge, calls } = fakeBridge({ 'safebrowsing/phishing-database.json': FEED })
      const io = new AndroidStoreIO(bridge, {}, manifest('safebrowsing/phishing-database.json'))
      // The service refreshed the feed before the boot fetch of the old file landed.
      await io.write('safebrowsing/phishing-database.json', refreshed)
      io.adopt({ 'safebrowsing/phishing-database.json': FEED })
      expect(io.readSync('safebrowsing/phishing-database.json')).toBe(refreshed)
      // The same for a synchronous write.
      io.writeSync('safebrowsing/phishing-database.json', FEED)
      io.adopt({ 'safebrowsing/phishing-database.json': refreshed })
      expect(io.readSync('safebrowsing/phishing-database.json')).toBe(FEED)
      expect(calls.map((c) => c.method)).toEqual([
        'storage.write',
        'storage.read',
        'storage.writeSync',
        'storage.read'
      ])
    })

    it('boots the session store from the profile, not from first-run defaults, when the core is built before the fetch lands', () => {
      const { bridge, calls } = fakeBridge({ 'state.json': BIG_STATE, 'history.json': '{}' })
      const io = new AndroidStoreIO(bridge, { 'history.json': '{}' }, manifest('state.json'))
      // The order B1 broke: the platform exists, the fetch is in flight, the core reads now.
      const store = new JsonStore<{ version: number; tabs: unknown[] }>(io, 'state.json', {
        backup: true
      })
      const loaded = store.readSync()
      expect(loaded?.version).toBe(9)
      expect(loaded?.tabs).toHaveLength(400)
      expect(store.readFromBackup).toBe(false)
      expect(calls).toEqual([{ method: 'storage.read', args: { name: 'state.json' } }])
      io.adopt({ 'state.json': BIG_STATE })
      expect(store.readSync()?.tabs).toHaveLength(400)
      expect(calls).toHaveLength(1)
    })
  })

  describe('a write the host could not make', () => {
    it('rejects, and is not remembered: the same bytes are sent again next time', async () => {
      const { bridge, calls } = fakeBridge({}, new Set(['state.json']))
      const io = new AndroidStoreIO(bridge, { 'state.json': '{}' })
      await expect(io.write('state.json', '{"tabs":[1]}')).rejects.toThrow('could not write')
      expect(io.readSync('state.json')).toBe('{}')
      await expect(io.write('state.json', '{"tabs":[1]}')).rejects.toThrow('could not write')
      expect(calls.filter((c) => c.method === 'storage.write')).toHaveLength(2)
    })

    it('leaves the mirror alone after a synchronous write the host did not confirm', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const { bridge, calls } = fakeBridge({}, new Set(['state.json']))
      const io = new AndroidStoreIO(bridge, { 'state.json': '{}' })
      io.writeSync('state.json', '{"tabs":[1]}')
      expect(io.readSync('state.json')).toBe('{}')
      io.writeSync('state.json', '{"tabs":[1]}')
      expect(calls.filter((c) => c.method === 'storage.writeSync')).toHaveLength(2)
      expect(warn).toHaveBeenCalledTimes(2)
      warn.mockRestore()
    })
  })

  it('asks the host to keep a backup for the stores that want one', async () => {
    const { bridge, calls } = fakeBridge()
    const io = new AndroidStoreIO(bridge, { 'state.json': '{}' })
    await io.write('state.json', '{"tabs":[1]}', { backup: true })
    io.writeSync('state.json', '{"tabs":[2]}', { backup: true })
    await io.write('history.json', '[]')
    expect(calls).toEqual([
      { method: 'storage.write', args: { name: 'state.json', text: '{"tabs":[1]}', backup: true } },
      {
        method: 'storage.writeSync',
        args: { name: 'state.json', text: '{"tabs":[2]}', backup: true }
      },
      { method: 'storage.write', args: { name: 'history.json', text: '[]', backup: false } }
    ])
  })

  it('forgets a removed document, handed or mirrored, and tells the host', async () => {
    const { bridge, calls } = fakeBridge()
    const io = new AndroidStoreIO(
      bridge,
      { 'state.json': '{}' },
      manifest('safebrowsing/urlhaus.json')
    )
    io.adopt({ 'safebrowsing/urlhaus.json': FEED })
    await io.remove('safebrowsing/urlhaus.json')
    await io.remove('state.json')
    expect(calls.map((c) => c.method)).toEqual(['storage.remove', 'storage.remove'])
    expect(io.exists('safebrowsing/urlhaus.json')).toBe(false)
    expect(io.readSync('state.json')).toBeNull()
  })

  interface PieceCall {
    method: string
    args: Record<string, unknown>
    sync: boolean
  }

  /**
   * A bridge that keeps the documents itself, the way Kotlin's Storage does: pieces of a write
   * gather under a token until writeEnd; `storage.read` answers a document up to CHUNK_CHARS
   * whole and a bigger one as `{ token }`, handed out in pieces until null.
   */
  class PieceBridge {
    readonly calls: PieceCall[] = []
    readonly docs = new Map<string, string>()
    /** Asynchronous calls waiting for `settle` (the test releases them one by one to watch ordering). */
    readonly waiting: Array<() => void> = []
    /** Methods that reject (asynchronous) or answer nothing (synchronous). */
    failing = new Set<string>()
    private seq = 0
    private readonly writes = new Map<number, { name: string; parts: string[]; backup: boolean }>()
    private readonly reads = new Map<number, { text: string; at: number }>()

    private run(method: string, args: Record<string, unknown>): unknown {
      switch (method) {
        case 'storage.write':
          this.docs.set(String(args.name), String(args.text))
          return null
        case 'storage.writeSync':
          this.docs.set(String(args.name), String(args.text))
          return true
        case 'storage.remove':
          this.docs.delete(String(args.name))
          return null
        case 'storage.exists':
          return this.docs.has(String(args.name))
        case 'storage.writeBegin': {
          const token = ++this.seq
          this.writes.set(token, {
            name: String(args.name),
            parts: [],
            backup: args.backup === true
          })
          return token
        }
        case 'storage.writeChunk': {
          const write = this.writes.get(Number(args.token))
          if (!write) throw new Error('no write')
          write.parts.push(String(args.text))
          return true
        }
        case 'storage.writeEnd': {
          const write = this.writes.get(Number(args.token))
          if (!write) throw new Error('no write')
          this.writes.delete(Number(args.token))
          if (write.backup) {
            const old = this.docs.get(write.name)
            if (old !== undefined) this.docs.set(`${write.name}.bak`, old)
          }
          this.docs.set(write.name, write.parts.join(''))
          return true
        }
        case 'storage.writeAbort':
          this.writes.delete(Number(args.token))
          return null
        case 'storage.read': {
          const text = this.docs.get(String(args.name))
          if (text === undefined) return null
          if (text.length <= CHUNK_CHARS) return text
          const token = ++this.seq
          this.reads.set(token, { text, at: 0 })
          return { token }
        }
        case 'storage.readChunk': {
          const read = this.reads.get(Number(args.token))
          if (!read || read.at >= read.text.length) {
            this.reads.delete(Number(args.token))
            return null
          }
          const chunk = read.text.slice(read.at, read.at + Number(args.maxChars))
          read.at += chunk.length
          return chunk
        }
        case 'storage.readEnd':
          this.reads.delete(Number(args.token))
          return null
        default:
          throw new Error(`unexpected ${method}`)
      }
    }

    get openWrites(): number {
      return this.writes.size
    }

    get openReads(): number {
      return this.reads.size
    }

    call<T = void>(method: string, args: unknown = {}): Promise<T> {
      const a = args as Record<string, unknown>
      this.calls.push({ method, args: a, sync: false })
      return new Promise<T>((resolve, reject) => {
        this.waiting.push(() => {
          if (this.failing.has(method)) {
            reject(new Error(`${method} refused`))
            return
          }
          try {
            resolve(this.run(method, a) as T)
          } catch (error) {
            reject(error as Error)
          }
        })
      })
    }

    send(method: string, args: unknown = {}): void {
      void this.call(method, args).catch(() => undefined)
    }

    callSync<T>(method: string, args: unknown = {}): T {
      const a = args as Record<string, unknown>
      this.calls.push({ method, args: a, sync: true })
      if (this.failing.has(method)) return undefined as T
      try {
        return this.run(method, a) as T
      } catch {
        return undefined as T
      }
    }

    /** Let every asynchronous call queued so far settle, and the ones they queue in turn. */
    async settleAll(): Promise<void> {
      while (this.waiting.length > 0) {
        this.waiting.shift()!()
        await Promise.resolve()
        await Promise.resolve()
      }
    }
  }

  const pieces = (bridge: PieceBridge, files: Record<string, string> = {}): AndroidStoreIO =>
    new AndroidStoreIO(bridge as unknown as Bridge, files)

  const big = (chars: number, fill = 'x'): string => fill.repeat(chars)

  describe("documents in pieces (a filter-list extension's chrome.storage, tens of megabytes)", () => {
    it('writes a document that fits one piece with one call, as ever', async () => {
      const bridge = new PieceBridge()
      const files: Record<string, string> = {}
      const store = pieces(bridge, files)
      const done = store.write('state.json', '{"a":1}')
      await bridge.settleAll()
      await done
      expect(bridge.calls.map((c) => c.method)).toEqual(['storage.write'])
      expect(bridge.docs.get('state.json')).toBe('{"a":1}')
      expect(files['state.json']).toBe('{"a":1}')
      expect(store.readSync('state.json')).toBe('{"a":1}')
    })

    it('writes a large document in pieces, each sent once the one before it has landed', async () => {
      const bridge = new PieceBridge()
      const files: Record<string, string> = {}
      const store = pieces(bridge, files)
      const text = big(CHUNK_CHARS * 2 + 5, 'a') + '🙂' + big(7, 'b')
      const done = store.write('ext-storage/abc.json', text)
      // Backpressure: nothing beyond writeBegin is on the bridge until it has answered.
      await Promise.resolve()
      expect(bridge.calls.map((c) => c.method)).toEqual(['storage.writeBegin'])
      expect(bridge.calls[0].args).toEqual({ name: 'ext-storage/abc.json', backup: false })
      bridge.waiting.shift()!()
      await Promise.resolve()
      await Promise.resolve()
      expect(bridge.calls.map((c) => c.method)).toEqual([
        'storage.writeBegin',
        'storage.writeChunk'
      ])
      await bridge.settleAll()
      await done
      expect(bridge.calls.map((c) => c.method)).toEqual([
        'storage.writeBegin',
        'storage.writeChunk',
        'storage.writeChunk',
        'storage.writeChunk',
        'storage.writeEnd'
      ])
      const chunks = bridge.calls.filter((c) => c.method === 'storage.writeChunk')
      expect(chunks.map((c) => String(c.args.text).length)).toEqual([
        CHUNK_CHARS,
        CHUNK_CHARS,
        5 + 2 + 7
      ])
      expect(chunks.every((c) => c.args.token === 1)).toBe(true)
      expect(bridge.docs.get('ext-storage/abc.json')).toBe(text)
      expect(bridge.openWrites).toBe(0)
      // A folder document is not mirrored: the megabytes stay out of the boot mirror.
      expect('ext-storage/abc.json' in files).toBe(false)
    })

    it('carries the backup request through a write in pieces, and remembers what landed', async () => {
      const bridge = new PieceBridge()
      const files: Record<string, string> = { 'state.json': '{}' }
      const store = pieces(bridge, files)
      bridge.docs.set('state.json', '{}')
      const text = big(CHUNK_CHARS + 1, 't')
      const done = store.write('state.json', text, { backup: true })
      await bridge.settleAll()
      await done
      expect(bridge.calls[0]).toEqual({
        method: 'storage.writeBegin',
        args: { name: 'state.json', backup: true },
        sync: false
      })
      expect(bridge.docs.get('state.json.bak')).toBe('{}')
      expect(files['state.json']).toBe(text)
      // The same bytes again go nowhere.
      bridge.calls.length = 0
      await store.write('state.json', text)
      expect(bridge.calls).toEqual([])
    })

    it('aborts a write in pieces when one refuses to land, rejects, and is not remembered', async () => {
      const bridge = new PieceBridge()
      const files: Record<string, string> = {}
      const store = pieces(bridge, files)
      bridge.docs.set('ext-storage/abc.json', 'old')
      const done = store.write('ext-storage/abc.json', big(CHUNK_CHARS + 1))
      bridge.failing.add('storage.writeChunk')
      const settled = done.then(
        () => 'resolved',
        (e: Error) => e.message
      )
      await bridge.settleAll()
      expect(await settled).toBe('storage.writeChunk refused')
      expect(bridge.calls.map((c) => c.method)).toEqual([
        'storage.writeBegin',
        'storage.writeChunk',
        'storage.writeAbort'
      ])
      expect(bridge.docs.get('ext-storage/abc.json')).toBe('old')
      expect(bridge.openWrites).toBe(0)
    })

    it('writes a large document synchronously in pieces too, and leaves the mirror alone when a piece fails', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const bridge = new PieceBridge()
      const files: Record<string, string> = { 'state.json': '{}' }
      const store = pieces(bridge, files)
      const text = big(CHUNK_CHARS * 3)
      store.writeSync('ext-storage/abc.json', text)
      expect(bridge.calls.every((c) => c.sync)).toBe(true)
      expect(bridge.calls.map((c) => c.method)).toEqual([
        'storage.writeBegin',
        'storage.writeChunk',
        'storage.writeChunk',
        'storage.writeChunk',
        'storage.writeEnd'
      ])
      expect(bridge.docs.get('ext-storage/abc.json')).toBe(text)

      bridge.calls.length = 0
      bridge.failing.add('storage.writeEnd')
      const bigState = big(CHUNK_CHARS + 1, 's')
      store.writeSync('state.json', bigState)
      expect(bridge.calls.at(-1)?.method).toBe('storage.writeAbort')
      expect(bridge.docs.get('state.json')).toBeUndefined()
      expect(files['state.json']).toBe('{}')
      expect(store.readSync('state.json')).toBe('{}')
      expect(warn).toHaveBeenCalledWith('[zen] the host could not write state.json')
      expect(bridge.openWrites).toBe(0)

      bridge.calls.length = 0
      store.writeSync('state.json', '{"tabs":[]}')
      expect(bridge.calls.map((c) => c.method)).toEqual(['storage.writeSync'])
      warn.mockRestore()
    })

    it('reads a big folder document in pieces after the host answers a token, a small one whole, a missing one as null', () => {
      const bridge = new PieceBridge()
      const store = pieces(bridge, { 'state.json': '{"s":1}' })
      const text = big(CHUNK_CHARS * 2 + 3, 'r')
      bridge.docs.set('ext-storage/abc.json', text)
      bridge.docs.set('blocking/small.json', '{"filterText":"||ads^"}')
      expect(store.readSync('ext-storage/abc.json')).toBe(text)
      expect(bridge.calls.map((c) => c.method)).toEqual([
        'storage.read',
        'storage.readChunk',
        'storage.readChunk',
        'storage.readChunk',
        'storage.readChunk'
      ])
      expect(bridge.calls.slice(1).every((c) => c.args.maxChars === CHUNK_CHARS)).toBe(true)
      expect(bridge.openReads).toBe(0)

      bridge.calls.length = 0
      expect(store.readSync('blocking/small.json')).toBe('{"filterText":"||ads^"}')
      expect(store.readSync('ext-storage/missing.json')).toBeNull()
      expect(bridge.calls.map((c) => c.method)).toEqual(['storage.read', 'storage.read'])

      bridge.calls.length = 0
      expect(store.readSync('state.json')).toBe('{"s":1}')
      expect(bridge.calls).toEqual([])
      // The boot's fallback reader (`handoff.ts`) reads the same way.
      expect(readDocument(bridge as unknown as Bridge, 'ext-storage/abc.json')).toBe(text)
      expect(readDocument(bridge as unknown as Bridge, 'nothing.json')).toBeNull()
    })

    it('closes a read the bridge fails midway and reports the document unreadable', () => {
      const bridge = new PieceBridge()
      const store = pieces(bridge)
      bridge.docs.set('blocking/easylist.json', big(CHUNK_CHARS + 1))
      const original = bridge.callSync.bind(bridge)
      let served = 0
      bridge.callSync = <T>(method: string, args: unknown = {}): T => {
        if (method === 'storage.readChunk' && ++served === 2) {
          bridge.calls.push({ method, args: args as Record<string, unknown>, sync: true })
          return undefined as T
        }
        return original(method, args) as T
      }
      expect(store.readSync('blocking/easylist.json')).toBeNull()
      expect(bridge.calls.map((c) => c.method)).toEqual([
        'storage.read',
        'storage.readChunk',
        'storage.readChunk',
        'storage.readEnd'
      ])
      expect(bridge.openReads).toBe(0)
    })
  })
})
