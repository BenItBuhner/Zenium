import { describe, expect, it } from 'vitest'
import {
  WORKER_PRELOAD_GRACE_MS,
  WorkerHandshakes,
  type WorkerProcess
} from '../extensionApi/workerHandshake'

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'
const KEY = '/profile/Default#7'
const KEY_2 = '/profile/Default#8'
const KEY_OTHER = '/profile/Default#9'

/** Timers the test fires by hand, so the grace period is a call, not a wait. */
class Timers {
  private next = 1
  readonly pending = new Map<number, { fn: () => void; ms: number }>()
  cleared: number[] = []

  set = (fn: () => void, ms: number): unknown => {
    const handle = this.next++
    this.pending.set(handle, { fn, ms })
    return handle
  }

  clear = (handle: unknown): void => {
    this.cleared.push(handle as number)
    this.pending.delete(handle as number)
  }

  /** The grace of every pending check runs out. */
  fire(): void {
    const due = [...this.pending.values()]
    this.pending.clear()
    for (const { fn } of due) fn()
  }
}

function harness(): { timers: Timers; warned: string[]; handshakes: WorkerHandshakes } {
  const timers = new Timers()
  const warned: string[] = []
  const handshakes = new WorkerHandshakes({
    onPreloadMissing: (extensionId) => warned.push(extensionId),
    setTimer: timers.set,
    clearTimer: timers.clear
  })
  return { timers, warned, handshakes }
}

describe('the worker preload self-check', () => {
  it('warns once, after the grace, when a worker runs and its preload never speaks', () => {
    const { timers, warned, handshakes } = harness()
    handshakes.status(KEY, EXT, 'starting')
    // Starting is not running: the script has not been evaluated, nothing is owed yet.
    expect(timers.pending.size).toBe(0)
    handshakes.status(KEY, EXT, 'running')
    expect(timers.pending.size).toBe(1)
    expect([...timers.pending.values()][0]?.ms).toBe(WORKER_PRELOAD_GRACE_MS)
    expect(warned).toEqual([])
    timers.fire()
    expect(warned).toEqual([EXT])
    // The cause is the process's, not one worker's: another extension's worker starting the
    // same way is not a second warning.
    handshakes.status(KEY_OTHER, OTHER, 'running')
    expect(timers.pending.size).toBe(0)
    timers.fire()
    expect(warned).toEqual([EXT])
  })

  it('stays silent when the preload’s first message arrives, before or after the engine says running', () => {
    const { timers, warned, handshakes } = harness()
    // The usual order: the preload's synchronous request comes before the script runs.
    handshakes.hello(KEY, EXT, { pid: 4242 })
    handshakes.status(KEY, EXT, 'running')
    expect(timers.pending.size).toBe(0)
    // The other order, should the engine's event win the race: the check is dropped.
    handshakes.status(KEY_2, EXT, 'running')
    expect(timers.pending.size).toBe(1)
    handshakes.hello(KEY_2, EXT, { pid: 4243 })
    expect(timers.pending.size).toBe(0)
    expect(timers.cleared).toHaveLength(1)
    timers.fire()
    expect(warned).toEqual([])
  })

  it('takes any later message from the preload as its word', () => {
    const { timers, warned, handshakes } = harness()
    handshakes.status(KEY, EXT, 'running')
    handshakes.heardFrom(KEY)
    expect(timers.pending.size).toBe(0)
    timers.fire()
    expect(warned).toEqual([])
  })

  it('drops the check of a worker that stops before the grace ends', () => {
    const { timers, warned, handshakes } = harness()
    handshakes.status(KEY, EXT, 'running')
    handshakes.status(KEY, EXT, 'stopping')
    expect(timers.pending.size).toBe(0)
    handshakes.status(KEY_2, EXT, 'running')
    handshakes.status(KEY_2, EXT, 'stopped')
    expect(timers.pending.size).toBe(0)
    timers.fire()
    expect(warned).toEqual([])
  })

  it('asks again on the worker’s next run', () => {
    const { timers, warned, handshakes } = harness()
    handshakes.hello(KEY, EXT, { pid: 4242 })
    handshakes.status(KEY, EXT, 'running')
    handshakes.status(KEY, EXT, 'stopped')
    // The engine restarts the worker; this time its preload says nothing.
    handshakes.status(KEY, EXT, 'running')
    expect(timers.pending.size).toBe(1)
    timers.fire()
    expect(warned).toEqual([EXT])
  })

  it('does not double a running worker’s check', () => {
    const { timers, handshakes } = harness()
    handshakes.status(KEY, EXT, 'running')
    handshakes.status(KEY, EXT, 'running')
    expect(timers.pending.size).toBe(1)
  })
})

describe('the worker renderers', () => {
  const processes = (handshakes: WorkerHandshakes): WorkerProcess[] =>
    handshakes.processes().sort((a, b) => a.osPid - b.osPid)

  it('joins the pid a preload reports to its extension while the worker runs', () => {
    const { handshakes } = harness()
    handshakes.hello(KEY, EXT, { pid: 4242 })
    handshakes.status(KEY, EXT, 'running')
    expect(processes(handshakes)).toEqual([{ osPid: 4242, extensionId: EXT }])
    handshakes.hello(KEY_OTHER, OTHER, { pid: 5150 })
    expect(processes(handshakes)).toEqual([
      { osPid: 4242, extensionId: EXT },
      { osPid: 5150, extensionId: OTHER }
    ])
    // Released as the worker stops, whichever word of the engine's comes.
    handshakes.status(KEY, EXT, 'stopping')
    expect(processes(handshakes)).toEqual([{ osPid: 5150, extensionId: OTHER }])
    handshakes.status(KEY_OTHER, OTHER, 'stopped')
    expect(processes(handshakes)).toEqual([])
  })

  it('keeps the latest pid of a worker whose preload speaks again', () => {
    const { handshakes } = harness()
    handshakes.hello(KEY, EXT, { pid: 4242 })
    // The worker was restarted in a fresh renderer before the engine said the old one stopped.
    handshakes.hello(KEY, EXT, { pid: 4300 })
    expect(processes(handshakes)).toEqual([{ osPid: 4300, extensionId: EXT }])
  })

  it('takes a first message without a usable pid as the preload’s word, and no renderer', () => {
    const { timers, warned, handshakes } = harness()
    const payloads: unknown[] = [
      undefined,
      null,
      'pid',
      { pid: '4242' },
      { pid: 0 },
      { pid: -3 },
      { pid: 1.5 }
    ]
    payloads.forEach((payload, i) => handshakes.hello(`${KEY}-${i}`, EXT, payload))
    expect(processes(handshakes)).toEqual([])
    payloads.forEach((_, i) => handshakes.status(`${KEY}-${i}`, EXT, 'running'))
    timers.fire()
    expect(warned).toEqual([])
  })

  it('forgets every worker of an unloaded extension, checks included', () => {
    const { timers, warned, handshakes } = harness()
    handshakes.hello(KEY, EXT, { pid: 4242 })
    handshakes.status(KEY_2, EXT, 'running')
    handshakes.hello(KEY_OTHER, OTHER, { pid: 5150 })
    expect(timers.pending.size).toBe(1)
    handshakes.forget(EXT)
    expect(processes(handshakes)).toEqual([{ osPid: 5150, extensionId: OTHER }])
    expect(timers.pending.size).toBe(0)
    timers.fire()
    expect(warned).toEqual([])
  })
})
