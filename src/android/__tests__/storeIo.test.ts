import { describe, expect, it } from 'vitest'
import type { Bridge } from '../bridge'
import { AndroidStoreIO } from '../storeIo'

/** A bridge that records every call and answers `storage.read` / `storage.exists` from `disk`. */
function fakeBridge(disk: Record<string, string> = {}): {
  bridge: Bridge
  calls: Array<{ method: string; args: Record<string, unknown> }>
} {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = []
  const answer = (method: string, args: Record<string, unknown>): unknown => {
    calls.push({ method, args })
    if (method === 'storage.read') return disk[args.name as string] ?? null
    if (method === 'storage.exists') return (args.name as string) in disk
    return null
  }
  const bridge = {
    call: async (method: string, args: Record<string, unknown>) => answer(method, args),
    callSync: (method: string, args: Record<string, unknown>) => answer(method, args),
    send: (method: string, args: Record<string, unknown>) => {
      answer(method, args)
    }
  } as unknown as Bridge
  return { bridge, calls }
}

const INDEX = '{"version":1,"sets":[{"id":"zen-default","priority":10,"enabled":true}]}'
const FEED = '{"version":1,"id":"phishing-database","prefixes":"' + 'A'.repeat(1024) + '"}'

describe('AndroidStoreIO', () => {
  it('serves the payload documents from memory and reads folder documents through the bridge', () => {
    const { bridge, calls } = fakeBridge({ 'blocking/list-1.json': '{"filterText":"||ads^"}' })
    const io = new AndroidStoreIO(bridge, { 'state.json': '{"tabs":[]}' })
    expect(io.readSync('state.json')).toBe('{"tabs":[]}')
    expect(io.readSync('missing.json')).toBeNull()
    expect(calls).toEqual([])
    expect(io.readSync('blocking/list-1.json')).toBe('{"filterText":"||ads^"}')
    expect(calls).toEqual([{ method: 'storage.read', args: { name: 'blocking/list-1.json' } }])
  })

  describe('one transfer per boot document', () => {
    it('hands a deferred folder document to the core once, then lets go of it', () => {
      const { bridge, calls } = fakeBridge({ 'safebrowsing/phishing-database.json': FEED })
      const io = new AndroidStoreIO(bridge, {})
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

    it('mirrors a deferred root document or rule index like one the payload carried inline', () => {
      const { bridge, calls } = fakeBridge()
      const io = new AndroidStoreIO(bridge, { 'state.json': '{}' })
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
        { method: 'storage.write', args: { name: 'blocking/index.json', text: changed } }
      ])
      await io.write('blocking/index.json', changed)
      expect(calls).toHaveLength(1)
      expect(io.readSync('blocking/index.json')).toBe(changed)
      io.writeSync('blocking/index.json', INDEX)
      expect(calls).toHaveLength(2)
      expect(calls[1]).toEqual({
        method: 'storage.writeSync',
        args: { name: 'blocking/index.json', text: INDEX }
      })
    })

    it('never dedups a folder document it does not mirror', async () => {
      const { bridge, calls } = fakeBridge()
      const io = new AndroidStoreIO(bridge, {})
      await io.write('safebrowsing/phishing-database.json', FEED)
      await io.write('safebrowsing/phishing-database.json', FEED)
      expect(calls.map((c) => c.method)).toEqual(['storage.write', 'storage.write'])
    })
  })

  it('forgets a removed document, handed or mirrored, and tells the host', async () => {
    const { bridge, calls } = fakeBridge()
    const io = new AndroidStoreIO(bridge, { 'state.json': '{}' })
    io.adopt({ 'safebrowsing/urlhaus.json': FEED })
    await io.remove('safebrowsing/urlhaus.json')
    await io.remove('state.json')
    expect(calls.map((c) => c.method)).toEqual(['storage.remove', 'storage.remove'])
    expect(io.exists('safebrowsing/urlhaus.json')).toBe(false)
    expect(io.readSync('state.json')).toBeNull()
  })
})
