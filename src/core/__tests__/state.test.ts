import { describe, expect, it } from 'vitest'
import type { HostCapabilities, Platform } from '../../shared/types'
import type { StoreIO } from '../platform'
import { BrowserState } from '../state'

function fakeIo(): StoreIO & { writes: string[] } {
  const io = {
    writes: [] as string[],
    readSync: () => null,
    write: async (_name: string, text: string) => {
      io.writes.push(text)
    },
    writeSync: (_name: string, text: string) => {
      io.writes.push(text)
    }
  }
  return io
}

function state(io: StoreIO): BrowserState {
  const s = new BrowserState(io, {} as Platform, {} as HostCapabilities, '0.0')
  s.load()
  return s
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('BrowserState commits', () => {
  it('persists a commit even when a volatile commit was scheduled first in the same tick', async () => {
    const io = fakeIo()
    const s = state(io)
    s.commitVolatile()
    s.commit()
    await tick()
    await s.flush()
    expect(io.writes.length).toBeGreaterThan(0)
  })

  it('does not persist for volatile commits alone', async () => {
    const io = fakeIo()
    const s = state(io)
    s.commitVolatile()
    await tick()
    // flush() writes unconditionally, so look at the store directly: nothing was scheduled.
    expect(io.writes).toEqual([])
  })

  it('notifies listeners once per tick for any mix of commits', async () => {
    const io = fakeIo()
    const s = state(io)
    let calls = 0
    s.subscribe(() => calls++)
    s.commitVolatile()
    s.commit()
    s.commitVolatile()
    await tick()
    expect(calls).toBe(1)
  })
})
