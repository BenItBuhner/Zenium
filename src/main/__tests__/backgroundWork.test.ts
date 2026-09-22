import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { BackgroundWork } from '../../core/background/work'
import {
  HOLD_BACKGROUND_WORK_FLAG,
  electronPerformanceHost,
  holdBackgroundWorkRequested,
  nodeWorkerHandle,
  type NodeWorkerLike
} from '../platform/backgroundWork'

/** A `worker_threads` worker as the adapter sees one: an emitter with the three methods. */
function fakeNodeWorker(): NodeWorkerLike &
  EventEmitter & { posted: unknown[]; terminated: number } {
  const emitter = new EventEmitter() as EventEmitter & {
    posted: unknown[]
    terminated: number
    postMessage(message: unknown, transfer?: unknown): void
    terminate(): Promise<number>
  }
  emitter.posted = []
  emitter.terminated = 0
  emitter.postMessage = (message, transfer) => {
    emitter.posted.push({ message, transfer })
  }
  emitter.terminate = async () => {
    emitter.terminated++
    return 0
  }
  return emitter as unknown as NodeWorkerLike &
    EventEmitter & { posted: unknown[]; terminated: number }
}

describe('the desktop hold flag (--hold-background-work)', () => {
  it('is read off the command line and off by default', () => {
    expect(HOLD_BACKGROUND_WORK_FLAG).toBe('--hold-background-work')
    expect(holdBackgroundWorkRequested(['/usr/bin/zenium'])).toBe(false)
    expect(holdBackgroundWorkRequested(['/usr/bin/zenium', 'https://example.com/'])).toBe(false)
    expect(holdBackgroundWorkRequested(['/usr/bin/zenium', '--hold-background-work'])).toBe(true)
    // The flag is a whole word: nothing that merely starts with it.
    expect(holdBackgroundWorkRequested(['zenium', '--hold-background-work=1'])).toBe(false)
  })

  it('reaches the core through the platform’s PerformanceHost', () => {
    expect(electronPerformanceHost({ holdBackgroundWork: true }).holdBackgroundWork?.()).toBe(true)
    expect(electronPerformanceHost({ holdBackgroundWork: false }).holdBackgroundWork?.()).toBe(
      false
    )
  })
})

describe('the worker_threads adapter', () => {
  it('posts with the transfer list, relays messages, and reads a crash or a bad exit as a loss', () => {
    const worker = fakeNodeWorker()
    const handle = nodeWorkerHandle(worker)
    const buffer = new ArrayBuffer(8)
    handle.postMessage({ id: 1, name: 't', input: buffer }, [buffer])
    expect(worker.posted).toEqual([
      { message: { id: 1, name: 't', input: buffer }, transfer: [buffer] }
    ])

    const messages: unknown[] = []
    const errors: string[] = []
    handle.onMessage((message) => messages.push(message))
    handle.onError((message) => errors.push(message))
    worker.emit('message', { id: 1, ok: true, output: 'x' })
    expect(messages).toEqual([{ id: 1, ok: true, output: 'x' }])

    worker.emit('error', new Error('boom'))
    worker.emit('exit', 0)
    worker.emit('exit', 1)
    expect(errors).toEqual(['boom', 'the worker exited with code 1'])

    handle.terminate()
    expect(worker.terminated).toBe(1)
  })

  it('is what the platform spawns for the core’s queue, and null without a spawn', async () => {
    const worker = fakeNodeWorker()
    const spawnWorker = vi.fn(() => worker)
    const host = electronPerformanceHost({ holdBackgroundWork: false, spawnWorker })
    const work = new BackgroundWork({
      worker: host.createBackgroundWorker,
      hold: host.holdBackgroundWork
    })
    const task = {
      name: 'echo',
      run: (input: string) => `worker:${input}`,
      runInline: async (input: string) => `inline:${input}`
    }
    const result = work.run(task, 'a')
    // The queue starts a task a turn later; the worker is spawned with the first one.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(spawnWorker).toHaveBeenCalledTimes(1)
    const posted = worker.posted[0] as { message: { id: number } }
    worker.emit('message', { id: posted.message.id, ok: true, output: 'worker:a' })
    expect(await result).toBe('worker:a')
    expect(work.runs).toEqual({ worker: 1, inline: 0 })
    work.stop()
    expect(worker.terminated).toBe(1)

    const bare = electronPerformanceHost({ holdBackgroundWork: false })
    expect(bare.createBackgroundWorker?.()).toBeNull()
    const inline = new BackgroundWork({ worker: bare.createBackgroundWorker })
    expect(await inline.run(task, 'b')).toBe('inline:b')
    expect(inline.runs).toEqual({ worker: 0, inline: 1 })
  })
})
