import { describe, expect, it } from 'vitest'
import { AndroidStoreIO, CHUNK_CHARS } from '../storeIo'
import type { Bridge } from '../bridge'

interface Call {
  method: string
  args: Record<string, unknown>
  sync: boolean
}

/**
 * A bridge that keeps the documents itself, the way Kotlin's Storage does: pieces of a write
 * gather under a token until writeEnd; a read hands the text out in pieces until null.
 */
class FakeBridge {
  readonly calls: Call[] = []
  readonly docs = new Map<string, string>()
  /** Asynchronous calls waiting for `settle` (the test releases them one by one to watch ordering). */
  readonly waiting: Array<() => void> = []
  /** Methods that reject (asynchronous) or answer nothing (synchronous). */
  failing = new Set<string>()
  private seq = 0
  private readonly writes = new Map<number, { name: string; parts: string[] }>()
  private readonly reads = new Map<number, { text: string; at: number }>()

  private run(method: string, args: Record<string, unknown>): unknown {
    switch (method) {
      case 'storage.write':
      case 'storage.writeSync':
        this.docs.set(String(args.name), String(args.text))
        return null
      case 'storage.remove':
        this.docs.delete(String(args.name))
        return null
      case 'storage.exists':
        return this.docs.has(String(args.name))
      case 'storage.writeBegin': {
        const token = ++this.seq
        this.writes.set(token, { name: String(args.name), parts: [] })
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
        this.docs.set(write.name, write.parts.join(''))
        return true
      }
      case 'storage.writeAbort':
        this.writes.delete(Number(args.token))
        return null
      case 'storage.readBegin': {
        const text = this.docs.get(String(args.name))
        if (text === undefined) return null
        const token = ++this.seq
        this.reads.set(token, { text, at: 0 })
        return token
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

const io = (bridge: FakeBridge, files: Record<string, string> = {}): AndroidStoreIO =>
  new AndroidStoreIO(bridge as unknown as Bridge, files)

const big = (chars: number, fill = 'x'): string => fill.repeat(chars)

describe('AndroidStoreIO', () => {
  it('writes a document that fits one piece with one call and mirrors root documents', async () => {
    const bridge = new FakeBridge()
    const files: Record<string, string> = {}
    const store = io(bridge, files)
    const done = store.write('state.json', '{"a":1}')
    await bridge.settleAll()
    await done
    expect(bridge.calls.map((c) => c.method)).toEqual(['storage.write'])
    expect(bridge.docs.get('state.json')).toBe('{"a":1}')
    expect(files['state.json']).toBe('{"a":1}')
    expect(store.readSync('state.json')).toBe('{"a":1}')
  })

  it('writes a large document in pieces, each sent once the one before it has landed', async () => {
    const bridge = new FakeBridge()
    const files: Record<string, string> = {}
    const store = io(bridge, files)
    const text = big(CHUNK_CHARS * 2 + 5, 'a') + '🙂' + big(7, 'b')
    const done = store.write('ext-storage/abc.json', text)
    // Backpressure: nothing beyond writeBegin is on the bridge until it has answered.
    await Promise.resolve()
    expect(bridge.calls.map((c) => c.method)).toEqual(['storage.writeBegin'])
    bridge.waiting.shift()!()
    await Promise.resolve()
    await Promise.resolve()
    expect(bridge.calls.map((c) => c.method)).toEqual(['storage.writeBegin', 'storage.writeChunk'])
    await bridge.settleAll()
    await done
    const methods = bridge.calls.map((c) => c.method)
    expect(methods).toEqual([
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

  it('aborts a write in pieces when one refuses to land, and rejects', async () => {
    const bridge = new FakeBridge()
    const store = io(bridge)
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

  it('writes a large document synchronously in pieces too, and throws when a piece fails', () => {
    const bridge = new FakeBridge()
    const store = io(bridge)
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
    expect(() => store.writeSync('ext-storage/abc.json', big(CHUNK_CHARS + 1))).toThrow(
      'writing ext-storage/abc.json failed'
    )
    expect(bridge.calls.at(-1)?.method).toBe('storage.writeAbort')
    expect(bridge.docs.get('ext-storage/abc.json')).toBe(text)
    expect(bridge.openWrites).toBe(0)

    bridge.calls.length = 0
    store.writeSync('state.json', '{}')
    expect(bridge.calls.map((c) => c.method)).toEqual(['storage.writeSync'])
  })

  it('reads a folder document in pieces and a missing one as null; root documents come from the boot mirror only', () => {
    const bridge = new FakeBridge()
    const store = io(bridge, { 'state.json': '{"s":1}' })
    const text = big(CHUNK_CHARS * 2 + 3, 'r')
    bridge.docs.set('ext-storage/abc.json', text)
    expect(store.readSync('ext-storage/abc.json')).toBe(text)
    expect(bridge.calls.map((c) => c.method)).toEqual([
      'storage.readBegin',
      'storage.readChunk',
      'storage.readChunk',
      'storage.readChunk',
      'storage.readChunk'
    ])
    expect(bridge.calls.slice(1).every((c) => c.args.maxChars === CHUNK_CHARS)).toBe(true)
    expect(bridge.openReads).toBe(0)

    bridge.calls.length = 0
    expect(store.readSync('ext-storage/missing.json')).toBeNull()
    expect(bridge.calls.map((c) => c.method)).toEqual(['storage.readBegin'])

    bridge.calls.length = 0
    expect(store.readSync('state.json')).toBe('{"s":1}')
    expect(store.readSync('other.json')).toBeNull()
    expect(bridge.calls).toEqual([])
  })

  it('closes a read the bridge fails midway and reports the document unreadable', () => {
    const bridge = new FakeBridge()
    const store = io(bridge)
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
      'storage.readBegin',
      'storage.readChunk',
      'storage.readChunk',
      'storage.readEnd'
    ])
    expect(bridge.openReads).toBe(0)
  })

  it('removes a document from the mirror and the disk', async () => {
    const bridge = new FakeBridge()
    const files: Record<string, string> = { 'state.json': '{}' }
    const store = io(bridge, files)
    bridge.docs.set('state.json', '{}')
    const done = store.remove('state.json')
    await bridge.settleAll()
    await done
    expect(files).toEqual({})
    expect(bridge.docs.has('state.json')).toBe(false)
    expect(store.exists('state.json')).toBe(false)
  })
})
