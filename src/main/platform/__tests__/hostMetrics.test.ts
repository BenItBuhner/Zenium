import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))

const { HostMetricsSampler } = await import('../resources/hostMetrics')

/** The engine's rows: `percentCPUUsage` is the share since the previous call, by anyone. */
function rows(cpu: Record<number, number>): Electron.ProcessMetric[] {
  return Object.entries(cpu).map(([pid, percent]) => ({
    pid: Number(pid),
    type: 'Tab',
    cpu: { percentCPUUsage: percent, idleWakeupsPerSecond: 0 },
    memory: { workingSetSize: 1024, peakWorkingSetSize: 2048 },
    creationTime: 0,
    sandboxed: true
  })) as Electron.ProcessMetric[]
}

function harness(): {
  sampler: InstanceType<typeof HostMetricsSampler>
  engine: { next: Record<number, number>; calls: number }
  tick: (ms: number) => void
} {
  let now = 1_000_000
  const engine = { next: {} as Record<number, number>, calls: 0 }
  const sampler = new HostMetricsSampler(
    () => {
      engine.calls += 1
      return rows(engine.next)
    },
    () => now
  )
  return { sampler, engine, tick: (ms) => (now += ms) }
}

const cpuOf = (metrics: Electron.ProcessMetric[], pid: number): number | undefined =>
  metrics.find((m) => m.pid === pid)?.cpu.percentCPUUsage

describe('HostMetricsSampler – one engine reader, a CPU window per consumer', () => {
  it('reads the engine once per sample and hands a first-time consumer the engine’s own figure', () => {
    const h = harness()
    h.engine.next = { 10: 0 }
    expect(cpuOf(h.sampler.sample('governor'), 10)).toBe(0)
    h.tick(5_000)
    h.engine.next = { 10: 40 }
    // A new consumer: the engine's interval is all there is to say.
    expect(cpuOf(h.sampler.sample('tasks'), 10)).toBe(40)
    expect(h.engine.calls).toBe(2)
  })

  it('the task page polling every second does not shrink the governor’s window: its share is the time-weighted average over its own 5 s', () => {
    const h = harness()
    h.engine.next = { 10: 0 }
    h.sampler.sample('governor')
    // Four task-page reads a second apart: 100 % for one second, idle for three.
    const seen: number[] = []
    for (const percent of [100, 0, 0, 0]) {
      h.tick(1_000)
      h.engine.next = { 10: percent }
      seen.push(cpuOf(h.sampler.sample('tasks'), 10) ?? -1)
    }
    // The last engine interval (1 s) reads idle; the governor's 5 s window holds the 1 s spike.
    h.tick(1_000)
    h.engine.next = { 10: 0 }
    expect(cpuOf(h.sampler.sample('governor'), 10)).toBeCloseTo(20, 5)
    // The task page saw each of its own one-second windows as the engine measured them.
    expect(seen).toEqual([100, 0, 0, 0])
  })

  it('a consumer’s window is its own: two readers of different cadence see the same load differently and both correctly', () => {
    const h = harness()
    h.engine.next = { 10: 0 }
    h.sampler.sample('governor')
    h.sampler.sample('tasks')
    // 2 s at 50 %, then 2 s at 150 % (more than a core), read by the task page each 2 s.
    h.tick(2_000)
    h.engine.next = { 10: 50 }
    expect(cpuOf(h.sampler.sample('tasks'), 10)).toBeCloseTo(50, 5)
    h.tick(2_000)
    h.engine.next = { 10: 150 }
    expect(cpuOf(h.sampler.sample('tasks'), 10)).toBeCloseTo(150, 5)
    // The governor over the whole 4 s: (50×2 + 150×2) / 4.
    expect(cpuOf(h.sampler.sample('governor'), 10)).toBeCloseTo(100, 5)
  })

  it('a process born or gone mid-window: a newcomer’s share counts from the first interval it is reported in, a departed pid is dropped, and its pid reused starts clean', () => {
    const h = harness()
    h.engine.next = { 10: 0 }
    h.sampler.sample('governor')
    h.tick(2_000)
    h.engine.next = { 10: 100, 11: 100 }
    h.sampler.sample('tasks')
    h.tick(2_000)
    h.engine.next = { 11: 50 }
    h.sampler.sample('tasks')
    h.tick(1_000)
    // 10 is gone; 11 read 100 % over its first 2 s, 50 % over the next 2 s and 100 % over the last
    // second of the governor's 5 s: (2 + 1 + 1) / 5.
    h.engine.next = { 11: 100 }
    const g = h.sampler.sample('governor')
    expect(g.map((m) => m.pid)).toEqual([11])
    expect(cpuOf(g, 11)).toBeCloseTo(80, 5)
    // The pid comes round again for another process, idle: nothing of the old one clings to it.
    h.tick(5_000)
    h.engine.next = { 10: 0, 11: 0 }
    expect(cpuOf(h.sampler.sample('governor'), 10)).toBe(0)
  })

  it('memory and the rest are the engine’s latest rows, only the CPU share is re-derived', () => {
    const h = harness()
    h.engine.next = { 10: 0 }
    h.sampler.sample('governor')
    h.tick(1_000)
    h.engine.next = { 10: 30 }
    const [row] = h.sampler.sample('governor')
    expect(row.memory.workingSetSize).toBe(1024)
    expect(row.type).toBe('Tab')
    expect(row.cpu.idleWakeupsPerSecond).toBe(0)
    expect(row.cpu.percentCPUUsage).toBeCloseTo(30, 5)
  })

  it('a forgotten consumer starts over: the next sample is the engine’s own figure, not an average over the gap', () => {
    const h = harness()
    h.engine.next = { 10: 0 }
    h.sampler.sample('tasks')
    h.tick(600_000)
    h.engine.next = { 10: 100 }
    h.sampler.sample('governor')
    h.sampler.forget('tasks')
    h.tick(1_000)
    h.engine.next = { 10: 5 }
    expect(cpuOf(h.sampler.sample('tasks'), 10)).toBe(5)
  })

  it('a non-finite share from the engine counts as nothing', () => {
    const h = harness()
    h.engine.next = { 10: 0 }
    h.sampler.sample('governor')
    h.tick(1_000)
    h.engine.next = { 10: Number.NaN }
    h.sampler.sample('tasks')
    h.tick(1_000)
    h.engine.next = { 10: 100 }
    expect(cpuOf(h.sampler.sample('governor'), 10)).toBeCloseTo(50, 5)
  })
})
