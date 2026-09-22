import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackgroundTask } from '../tasks'
import { serveBackgroundTasks } from '../worker'
import {
  BackgroundWork,
  HOLD_RECHECK_MS,
  WORKER_IDLE_MS,
  type BackgroundWorkerHandle
} from '../work'

/**
 * A worker in this process: the worker runtime (`serveBackgroundTasks`) on one side of a pair of
 * message channels, the queue's handle on the other, every message passed through `structuredClone`
 * so what crosses is what a real worker boundary lets cross (no functions, no class instances) and
 * the transferables are moved (the sender's buffer is detached, as `postMessage` detaches it).
 */
function fakeWorker(
  tasks: ReadonlyArray<BackgroundTask<unknown, unknown>>,
  options: { crashOn?: string } = {}
): { handle: BackgroundWorkerHandle; posted: string[]; terminated: () => boolean } {
  const posted: string[] = []
  let terminated = false
  let toMain: ((message: unknown) => void) | null = null
  let toWorker: ((message: unknown) => void) | null = null
  let onError: ((message: string) => void) | null = null
  serveBackgroundTasks(
    {
      postMessage: (message, transfer) =>
        queueMicrotask(() => toMain?.(structuredClone(message, { transfer }))),
      onMessage: (listener) => {
        toWorker = listener
      }
    },
    tasks
  )
  const handle: BackgroundWorkerHandle = {
    postMessage: (message, transfer) => {
      posted.push(message.name)
      if (options.crashOn === message.name) {
        queueMicrotask(() => onError?.('the worker crashed'))
        return
      }
      const cloned = structuredClone(message, { transfer })
      queueMicrotask(() => toWorker?.(cloned))
    },
    onMessage: (listener) => {
      toMain = listener
    },
    onError: (listener) => {
      onError = listener
    },
    terminate: () => {
      terminated = true
    }
  }
  return { handle, posted, terminated: () => terminated }
}

const DOUBLE: BackgroundTask<number, number> = { name: 'test.double', run: (n) => n * 2 }
const THROWS: BackgroundTask<void, never> = {
  name: 'test.throws',
  run: () => {
    throw new Error('boom')
  }
}
/** Distinguishes where it ran: the worker adds nothing, the inline path adds a thousand. */
const WHERE: BackgroundTask<number, number> = {
  name: 'test.where',
  run: (n) => n,
  runInline: async (n) => n + 1000
}
/** Moves a buffer out: the output's bytes are the input's, doubled in place. */
const BYTES: BackgroundTask<Uint8Array, { bytes: Uint8Array }> = {
  name: 'test.bytes',
  run: (input) => ({ bytes: input.map((b) => b * 2) }),
  transferables: (output) => [output.bytes.buffer as ArrayBuffer]
}
const TASKS = [DOUBLE, THROWS, WHERE, BYTES] as unknown as ReadonlyArray<
  BackgroundTask<unknown, unknown>
>

afterEach(() => {
  vi.useRealTimers()
})

describe('BackgroundWork: where the tasks run', () => {
  it('runs on the main thread, through runInline, when the host has no worker', async () => {
    const work = new BackgroundWork()
    expect(await work.run(WHERE, 1)).toBe(1001)
    expect(await work.run(DOUBLE, 4)).toBe(8)
    expect(work.runs).toEqual({ worker: 0, inline: 2 })
    const none = new BackgroundWork({ worker: () => null })
    expect(await none.run(WHERE, 2)).toBe(1002)
  })

  it('runs in the worker when the host has one, moving the output buffers instead of copying', async () => {
    const worker = fakeWorker(TASKS)
    const work = new BackgroundWork({ worker: () => worker.handle })
    expect(await work.run(WHERE, 1)).toBe(1)
    const input = new Uint8Array([1, 2, 3])
    const { bytes } = await work.run(BYTES, input, [input.buffer])
    expect([...bytes]).toEqual([2, 4, 6])
    // The input's buffer went to the worker (detached here), the output's came back.
    expect(input.byteLength).toBe(0)
    expect(work.runs).toEqual({ worker: 2, inline: 0 })
    expect(worker.posted).toEqual(['test.where', 'test.bytes'])
  })

  it('rejects a task that throws, wherever it ran, and goes on with the next', async () => {
    const worker = fakeWorker(TASKS)
    const inWorker = new BackgroundWork({ worker: () => worker.handle })
    await expect(inWorker.run(THROWS, undefined)).rejects.toThrow('boom')
    expect(await inWorker.run(DOUBLE, 2)).toBe(4)
    const inline = new BackgroundWork()
    await expect(inline.run(THROWS, undefined)).rejects.toThrow('boom')
    expect(await inline.run(DOUBLE, 3)).toBe(6)
  })

  it('answers an unknown task with a failure instead of hanging', async () => {
    const worker = fakeWorker([DOUBLE] as unknown as ReadonlyArray<
      BackgroundTask<unknown, unknown>
    >)
    const work = new BackgroundWork({ worker: () => worker.handle })
    await expect(work.run(WHERE, 1)).rejects.toThrow('unknown task test.where')
  })

  it('runs one task at a time, in order', async () => {
    const order: string[] = []
    const slow: BackgroundTask<string, string> = {
      name: 'test.slow',
      run: (s) => s,
      runInline: async (s) => {
        order.push(`start ${s}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push(`end ${s}`)
        return s
      }
    }
    const work = new BackgroundWork()
    const results = await Promise.all([
      work.run(slow, 'a'),
      work.run(slow, 'b'),
      work.run(slow, 'c')
    ])
    expect(results).toEqual(['a', 'b', 'c'])
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
  })
})

describe('BackgroundWork: a worker that cannot be had', () => {
  it('falls back to the main thread for the session when the spawn throws or yields nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let spawns = 0
    const throwing = new BackgroundWork({
      worker: () => {
        spawns++
        throw new Error('no worker here')
      }
    })
    expect(await throwing.run(WHERE, 1)).toBe(1001)
    expect(await throwing.run(WHERE, 2)).toBe(1002)
    expect(spawns).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no worker here'))
    warn.mockRestore()
  })

  it('runs the job the worker died under on the main thread, once, and never posts again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let spawns = 0
    const work = new BackgroundWork({
      worker: () => {
        spawns++
        return fakeWorker(TASKS, { crashOn: 'test.where' }).handle
      }
    })
    expect(await work.run(DOUBLE, 1)).toBe(2)
    expect(await work.run(WHERE, 1)).toBe(1001)
    expect(await work.run(WHERE, 2)).toBe(1002)
    expect(await work.run(DOUBLE, 5)).toBe(10)
    expect(spawns).toBe(1)
    expect(work.runs).toEqual({ worker: 1, inline: 3 })
    warn.mockRestore()
  })

  it('lets an idle worker go and spawns one again for the next task', async () => {
    vi.useFakeTimers()
    const workers: ReturnType<typeof fakeWorker>[] = []
    const work = new BackgroundWork({
      worker: () => {
        const worker = fakeWorker(TASKS)
        workers.push(worker)
        return worker.handle
      }
    })
    expect(await work.run(DOUBLE, 1)).toBe(2)
    expect(workers).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(WORKER_IDLE_MS - 1)
    expect(workers[0].terminated()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(workers[0].terminated()).toBe(true)
    expect(await work.run(DOUBLE, 2)).toBe(4)
    expect(workers).toHaveLength(2)
    work.stop()
    expect(workers[1].terminated()).toBe(true)
    await expect(work.run(DOUBLE, 3)).rejects.toThrow('stopped')
  })
})

describe('BackgroundWork: the startup arm and the hold', () => {
  it('fires once at its time when nothing is held', async () => {
    vi.useFakeTimers()
    const work = new BackgroundWork()
    const fn = vi.fn()
    work.armStartup(20_000, fn)
    await vi.advanceTimersByTimeAsync(19_999)
    expect(fn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('re-arms every HOLD_RECHECK_MS while the host holds, and runs when the hold drops', async () => {
    vi.useFakeTimers()
    let held = true
    const work = new BackgroundWork({ hold: () => held })
    const fn = vi.fn()
    work.armStartup(20_000, fn)
    await vi.advanceTimersByTimeAsync(20_000 + HOLD_RECHECK_MS * 3)
    expect(fn).not.toHaveBeenCalled()
    expect(work.held()).toBe(true)
    held = false
    await vi.advanceTimersByTimeAsync(HOLD_RECHECK_MS - 1)
    expect(fn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('runs a held sweep at once on release, and only once', async () => {
    vi.useFakeTimers()
    const work = new BackgroundWork({ hold: () => true })
    const fn = vi.fn()
    work.armStartup(20_000, fn)
    await vi.advanceTimersByTimeAsync(20_000 + 1_000)
    expect(fn).not.toHaveBeenCalled()
    work.release()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(work.held()).toBe(false)
    work.release()
    await vi.advanceTimersByTimeAsync(HOLD_RECHECK_MS * 2)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('leaves a sweep whose time has not come to its own time when released early', async () => {
    vi.useFakeTimers()
    const work = new BackgroundWork({ hold: () => true })
    const fn = vi.fn()
    work.armStartup(20_000, fn)
    await vi.advanceTimersByTimeAsync(5_000)
    work.release()
    expect(fn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(fn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('staggers two sweeps armed at different delays and holds both under one hold', async () => {
    vi.useFakeTimers()
    let held = true
    const work = new BackgroundWork({ hold: () => held })
    const blocking = vi.fn()
    const safeBrowsing = vi.fn()
    work.armStartup(20_000, blocking)
    work.armStartup(35_000, safeBrowsing)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(blocking).not.toHaveBeenCalled()
    expect(safeBrowsing).not.toHaveBeenCalled()
    work.release()
    expect(blocking).toHaveBeenCalledTimes(1)
    expect(safeBrowsing).toHaveBeenCalledTimes(1)
    // Without a hold: 20 s and 35 s, never the same window.
    held = false
    const free = new BackgroundWork({ hold: () => held })
    const first = vi.fn()
    const second = vi.fn()
    free.armStartup(20_000, first)
    free.armStartup(35_000, second)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('cancels an armed sweep, and stop() cancels them all', async () => {
    vi.useFakeTimers()
    const work = new BackgroundWork({ hold: () => true })
    const cancelled = vi.fn()
    const stopped = vi.fn()
    const cancel = work.armStartup(1_000, cancelled)
    work.armStartup(2_000, stopped)
    cancel()
    await vi.advanceTimersByTimeAsync(3_000)
    work.stop()
    work.release()
    await vi.advanceTimersByTimeAsync(HOLD_RECHECK_MS * 2)
    expect(cancelled).not.toHaveBeenCalled()
    expect(stopped).not.toHaveBeenCalled()
  })

  it('treats a hold that throws as no hold', () => {
    const work = new BackgroundWork({
      hold: () => {
        throw new Error('gone')
      }
    })
    expect(work.held()).toBe(false)
  })
})
