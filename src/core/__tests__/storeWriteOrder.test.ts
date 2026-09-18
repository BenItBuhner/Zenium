import { describe, expect, it, vi } from 'vitest'
import type { HostCapabilities, Platform } from '../../shared/types'
import type { StoreIO } from '../platform'
import { BrowserState } from '../state'
import { JsonStore } from '../store/JsonStore'

interface GatedIo extends StoreIO {
  /** What is on disk. */
  files: Record<string, string>
  /** Every document text in the order it reached the disk. */
  landed: string[]
  /** Let the asynchronous writes that have started land. */
  release(): void
}

/**
 * A host whose asynchronous writes take as long as the test wants: they start at once (the temp
 * file is being written) and land – reach the document – only once released. Synchronous writes
 * land at once, like `FileStoreIO.writeSync`.
 */
function gatedIo(): GatedIo {
  const files: Record<string, string> = {}
  const landed: string[] = []
  const gates: Array<() => void> = []
  return {
    files,
    landed,
    readSync: (name) => files[name] ?? null,
    write: async (name, text) => {
      await new Promise<void>((resolve) => gates.push(resolve))
      files[name] = text
      landed.push(text)
    },
    writeSync: (name, text) => {
      files[name] = text
      landed.push(text)
    },
    release: () => {
      for (const open of gates.splice(0)) open()
    }
  }
}

/** Past the next macrotask: a zero-debounce timer has fired and its write has started. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1))

const text = (v: number): string => JSON.stringify({ v })

describe('the order of a store\u2019s writes', () => {
  it('a synchronous flush lands last even when a debounced write had already started', async () => {
    const io = gatedIo()
    const store = new JsonStore<{ v: number }>(io, 'doc.json', { backup: true, debounceMs: 0 })
    store.write({ v: 1 })
    await tick()
    expect(JsonStore.busy).toBe(true)
    expect(io.landed).toEqual([])

    // The shutdown's write: it must be what ends up on disk.
    store.write({ v: 2 })
    store.flushSync()
    expect(io.landed).toEqual([text(2)])
    expect(JsonStore.busy).toBe(true)

    io.release()
    await JsonStore.idle()
    // The older write landed after the final one and was answered with a repeat of the final.
    expect(io.landed).toEqual([text(2), text(1), text(2)])
    expect(io.files['doc.json']).toBe(text(2))
    expect(JsonStore.busy).toBe(false)
  })

  it('drops the writes still queued behind one in flight when a synchronous flush supersedes them', async () => {
    const io = gatedIo()
    const store = new JsonStore<{ v: number }>(io, 'doc.json', { debounceMs: 0 })
    store.write({ v: 1 })
    await tick()
    store.write({ v: 2 })
    await tick()
    store.write({ v: 3 })
    store.flushSync()
    expect(io.landed).toEqual([text(3)])

    io.release()
    await JsonStore.idle()
    expect(io.landed).toEqual([text(3), text(1), text(3)])
    expect(io.files['doc.json']).toBe(text(3))
  })

  it('needs no repeat when nothing is in flight, and none when the flush has nothing new', async () => {
    const io = gatedIo()
    const store = new JsonStore<{ v: number }>(io, 'doc.json', { debounceMs: 0 })
    store.write({ v: 1 })
    store.flushSync()
    expect(io.landed).toEqual([text(1)])
    expect(JsonStore.busy).toBe(false)

    store.write({ v: 2 })
    await tick()
    // The in-flight write is the newest document there is: a flush without a newer one lets it be.
    store.flushSync()
    io.release()
    await JsonStore.idle()
    expect(io.landed).toEqual([text(1), text(2)])
  })

  it('keeps later asynchronous writes in order after the repeat', async () => {
    const io = gatedIo()
    const store = new JsonStore<{ v: number }>(io, 'doc.json', { debounceMs: 0 })
    store.write({ v: 1 })
    await tick()
    store.write({ v: 2 })
    store.flushSync()
    store.write({ v: 3 })
    await tick()
    // The first write lands, the repeat follows, and only then does the third start.
    io.release()
    await tick()
    expect(io.landed).toEqual([text(2), text(1), text(2)])
    io.release()
    await JsonStore.idle()
    expect(io.landed).toEqual([text(2), text(1), text(2), text(3)])
    expect(io.files['doc.json']).toBe(text(3))
  })

  it('the clean-exit marker of a graceful shutdown outlives a debounced write in flight', async () => {
    vi.useFakeTimers()
    try {
      const io = gatedIo()
      const s = new BrowserState(io, 'linux' as Platform, {} as HostCapabilities, '0.0')
      s.load()
      // A commit of the running browser (a page finished loading); its debounced write fires and
      // is being written by the host when the quit arrives.
      s.commit()
      await vi.advanceTimersByTimeAsync(400)
      expect(JsonStore.busy).toBe(true)
      expect(io.landed).toEqual([])

      s.markExiting()
      s.flushSync()
      s.freeze()
      const marks = (): Array<boolean | undefined> =>
        io.landed.map((t) => (JSON.parse(t) as { cleanExit?: boolean }).cleanExit)
      expect(marks()).toEqual([true])

      io.release()
      await JsonStore.idle()
      expect(marks()).toEqual([true, false, true])
      const state = io.files['state.json']
      if (!state) throw new Error('state.json was not written')
      expect((JSON.parse(state) as { cleanExit?: boolean }).cleanExit).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
