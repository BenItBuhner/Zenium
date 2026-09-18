import { describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Platform } from '../../shared/types'
import type { StoreIO, StoreWriteOptions } from '../platform'
import { BrowserState } from '../state'
import { JsonStore } from '../store/JsonStore'

interface Recorded {
  name: string
  text: string
  options: StoreWriteOptions | undefined
}

/** An in-memory profile that keeps the last write of every document and its options. */
function memoryIo(initial: Record<string, string> = {}): StoreIO & { writes: Recorded[] } {
  const files: Record<string, string> = { ...initial }
  const io = {
    writes: [] as Recorded[],
    readSync: (name: string) => files[name] ?? null,
    write: async (name: string, text: string, options?: StoreWriteOptions) => {
      files[name] = text
      io.writes.push({ name, text, options })
    },
    writeSync: (name: string, text: string, options?: StoreWriteOptions) => {
      files[name] = text
      io.writes.push({ name, text, options })
    }
  }
  return io
}

function state(io: StoreIO): BrowserState {
  const s = new BrowserState(io, 'linux' as Platform, {} as HostCapabilities, '0.0')
  s.load()
  return s
}

function lastState(io: { writes: Recorded[] }): { cleanExit?: boolean } {
  const write = io.writes.filter((w) => w.name === 'state.json').at(-1)
  if (!write) throw new Error('state.json was not written')
  return JSON.parse(write.text) as { cleanExit?: boolean }
}

describe('the clean-exit marker', () => {
  it('is written false while the browser runs and true once it shuts down gracefully', async () => {
    const io = memoryIo()
    const s = state(io)
    await s.flush()
    expect(lastState(io).cleanExit).toBe(false)
    // The profile's core document keeps a backup on every write.
    expect(io.writes.at(-1)?.options).toEqual({ backup: true })

    s.markExiting()
    await s.flush()
    expect(lastState(io).cleanExit).toBe(true)
  })

  it('reads a profile that lacks the marker as cleanly exited, and an explicit false as a crash', async () => {
    const io = memoryIo()
    const s = state(io)
    await s.flush()
    const running = io.readSync('state.json')
    if (!running) throw new Error('nothing written')

    expect(state(memoryIo({ 'state.json': running })).uncleanExit).toBe(true)

    s.markExiting()
    await s.flush()
    const quit = io.readSync('state.json')
    if (!quit) throw new Error('nothing written')
    expect(state(memoryIo({ 'state.json': quit })).uncleanExit).toBe(false)

    const legacy = JSON.stringify({ ...JSON.parse(quit), cleanExit: undefined })
    expect(state(memoryIo({ 'state.json': legacy })).uncleanExit).toBe(false)
    expect(state(memoryIo()).uncleanExit).toBe(false)
  })
})

describe('JsonStore with a backup', () => {
  it('reads the backup when the document is missing or corrupt, and only then', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const good = JSON.stringify({ v: 1 })
      const older = JSON.stringify({ v: 0 })

      const both = new JsonStore<{ v: number }>(
        memoryIo({ 'state.json': good, 'state.json.bak': older }),
        'state.json',
        { backup: true }
      )
      expect(both.readSync()).toEqual({ v: 1 })
      expect(both.readFromBackup).toBe(false)

      const corrupt = new JsonStore<{ v: number }>(
        memoryIo({ 'state.json': '{"v":', 'state.json.bak': older }),
        'state.json',
        { backup: true }
      )
      expect(corrupt.readSync()).toEqual({ v: 0 })
      expect(corrupt.readFromBackup).toBe(true)

      const missing = new JsonStore<{ v: number }>(
        memoryIo({ 'state.json.bak': older }),
        'state.json',
        { backup: true }
      )
      expect(missing.readSync()).toEqual({ v: 0 })

      // Without the option the backup is never consulted.
      const plain = new JsonStore<{ v: number }>(
        memoryIo({ 'state.json.bak': older }),
        'state.json'
      )
      expect(plain.readSync()).toBeNull()
      expect(new JsonStore(memoryIo(), 'state.json', { backup: true }).readSync()).toBeNull()
    } finally {
      warn.mockRestore()
    }
  })

  it('passes the backup option to every write', async () => {
    const io = memoryIo()
    const store = new JsonStore<{ v: number }>(io, 'state.json', { backup: true, debounceMs: 0 })
    store.write({ v: 1 })
    await store.flush()
    store.write({ v: 2 })
    store.flushSync()
    expect(io.writes.map((w) => w.options)).toEqual([{ backup: true }, { backup: true }])

    const plain = memoryIo()
    const other = new JsonStore<{ v: number }>(plain, 'other.json', 0)
    other.write({ v: 1 })
    other.flushSync()
    expect(plain.writes.map((w) => w.options)).toEqual([undefined])
  })
})
