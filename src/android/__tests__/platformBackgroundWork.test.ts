import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Browser } from '@core/browser'
import { BackgroundWork, HOLD_RECHECK_MS } from '@core/background/work'
import type { Bridge } from '../bridge'
import { AndroidPlatform, type BootInfo } from '../platform'

const BOOT: BootInfo = {
  version: '0.0.0-test',
  sdkInt: 34,
  signer: null,
  packageName: null,
  files: {},
  downloadsDir: '/sdcard/Download',
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
  fullscreen: false
}

const bridge = {
  call: async () => null,
  send: () => undefined,
  callSync: () => undefined
} as unknown as Bridge

/** The chrome document's `Worker`, as the platform spawns it: records the script and the options. */
class FakeWorker {
  static spawned: FakeWorker[] = []
  readonly listeners = new Map<string, Array<(event: unknown) => void>>()
  readonly posted: Array<{ message: unknown; transfer: ArrayBuffer[] }> = []
  terminated = 0
  constructor(
    readonly url: URL | string,
    readonly options?: { type?: string }
  ) {
    FakeWorker.spawned.push(this)
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }
  postMessage(message: unknown, transfer: ArrayBuffer[]): void {
    this.posted.push({ message, transfer })
  }
  terminate(): void {
    this.terminated++
  }
  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  FakeWorker.spawned = []
})

describe('the boot payload’s holdBackgroundWork (the demo harness’s hold on the startup sweeps)', () => {
  it('is never held unless the host says so: absent and false read as free, true as held', () => {
    expect(new AndroidPlatform(bridge, BOOT).performance.holdBackgroundWork?.()).toBe(false)
    expect(
      new AndroidPlatform(bridge, {
        ...BOOT,
        holdBackgroundWork: false
      }).performance.holdBackgroundWork?.()
    ).toBe(false)
    expect(
      new AndroidPlatform(bridge, {
        ...BOOT,
        holdBackgroundWork: true
      }).performance.holdBackgroundWork?.()
    ).toBe(true)
  })

  it('holds a startup sweep on the core’s queue until the background.release host event', () => {
    vi.useFakeTimers()
    const platform = new AndroidPlatform(bridge, { ...BOOT, holdBackgroundWork: true })
    const background = new BackgroundWork({
      worker: platform.performance.createBackgroundWorker,
      hold: platform.performance.holdBackgroundWork
    })
    platform.bind({ background } as unknown as Browser)

    const sweep = vi.fn()
    background.armStartup(20_000, sweep)
    vi.advanceTimersByTime(20_000)
    expect(sweep).not.toHaveBeenCalled()
    // Held: the sweep looks again every 5 s instead of running.
    vi.advanceTimersByTime(HOLD_RECHECK_MS * 3)
    expect(sweep).not.toHaveBeenCalled()

    // `Host.releaseBackgroundWork()` (the harness after its scenes): the sweep runs at once.
    platform.hostEvent('background.release', undefined)
    expect(sweep).toHaveBeenCalledTimes(1)
    // Idempotent, and nothing re-runs.
    platform.hostEvent('background.release', undefined)
    vi.advanceTimersByTime(HOLD_RECHECK_MS * 3)
    expect(sweep).toHaveBeenCalledTimes(1)
    background.stop()
  })
})

describe('the chrome’s background worker', () => {
  it('is not spawned where the document has no Worker: the work stays on the main thread', () => {
    vi.stubGlobal('Worker', undefined)
    const platform = new AndroidPlatform(bridge, BOOT)
    expect(platform.performance.createBackgroundWorker?.()).toBeNull()
  })

  it('is a module worker of the chrome’s own assets, driven as the core’s queue expects', () => {
    vi.stubGlobal('Worker', FakeWorker)
    const platform = new AndroidPlatform(bridge, BOOT)
    const handle = platform.performance.createBackgroundWorker?.()
    expect(handle).not.toBeNull()
    expect(FakeWorker.spawned).toHaveLength(1)
    const worker = FakeWorker.spawned[0]!
    expect(String(worker.url)).toMatch(/backgroundWorker/)
    expect(worker.options).toEqual({ type: 'module' })

    const buffer = new ArrayBuffer(16)
    handle!.postMessage({ id: 1, name: 'safebrowsing.table', input: buffer }, [buffer])
    expect(worker.posted).toEqual([
      { message: { id: 1, name: 'safebrowsing.table', input: buffer }, transfer: [buffer] }
    ])

    const messages: unknown[] = []
    const errors: string[] = []
    handle!.onMessage((message) => messages.push(message))
    handle!.onError((message) => errors.push(message))
    worker.emit('message', { data: { id: 1, ok: true, output: 'table' } })
    worker.emit('error', { message: 'script failed to load' })
    worker.emit('error', {})
    expect(messages).toEqual([{ id: 1, ok: true, output: 'table' }])
    expect(errors).toEqual(['script failed to load', 'the background worker failed'])

    handle!.terminate()
    expect(worker.terminated).toBe(1)
  })
})
