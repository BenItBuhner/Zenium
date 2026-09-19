import { JsonStore } from '@core/store/JsonStore'
import { describe, expect, it, vi } from 'vitest'
import type { Bridge } from '../bridge'
import { AndroidStoreIO } from '../storeIo'

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
  names.map((name) => ({ name, bytes: 100_000, etag: `186a0-1-0` }))

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
    const { bridge, calls } = fakeBridge({ 'state.json.bak': '{"tabs":[1]}' })
    const io = new AndroidStoreIO(bridge, { 'state.json': '{"tabs":[]}' })
    expect(io.readSync('missing.json')).toBeNull()
    // The backup the host keeps for the session store is readable, as it is on the desktop.
    expect(io.readSync('state.json.bak')).toBe('{"tabs":[1]}')
    expect(calls.map((c) => c.args.name)).toEqual(['missing.json', 'state.json.bak'])
    // Once read, a root document is in the mirror.
    expect(io.readSync('state.json.bak')).toBe('{"tabs":[1]}')
    expect(calls).toHaveLength(2)
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
})
