import { app } from 'electron'

/**
 * One reader of `app.getAppMetrics()` for the whole browser, with a CPU window per consumer.
 *
 * Electron measures each process's `cpu.percentCPUUsage` since the PREVIOUS `getAppMetrics()`
 * call – by any caller. The resource governor samples every 5 s (2 s under pressure) and the
 * task manager page every second or two while it is open, so with both reading the engine
 * directly the governor's window shrank to the task page's cadence and its CPU gauge (and the
 * planner's over-budget streaks behind it) read one-second spikes as sustained load.
 *
 * Here every call to the engine is one interval, and its CPU-seconds per process
 * (`percent / 100 × seconds`) are added to every consumer's account; a consumer's own read
 * hands back the engine's rows with `percentCPUUsage` re-derived over ITS window – the
 * CPU-seconds since its previous read, over that span – whoever else read in between. Memory
 * and the rest are the engine's latest, as before.
 */
export class HostMetricsSampler {
  private lastAt: number | null = null
  private readonly consumers = new Map<string, Consumer>()

  constructor(
    private readonly read: () => Electron.ProcessMetric[] = () => app.getAppMetrics(),
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Every process, `cpu.percentCPUUsage` over the window since this consumer's previous sample.
   * A consumer's first sample carries the engine's own figure (its interval since anybody's
   * previous call; zero on the very first call of the process), as `getAppMetrics()` would.
   */
  sample(consumer: string): Electron.ProcessMetric[] {
    const now = this.now()
    const metrics = this.read()
    const seconds = this.lastAt === null ? 0 : Math.max(0, now - this.lastAt) / 1000
    this.lastAt = now
    const live = new Set<number>()
    for (const m of metrics) live.add(m.pid)
    for (const c of this.consumers.values()) {
      for (const m of metrics) {
        c.cpuSeconds.set(
          m.pid,
          (c.cpuSeconds.get(m.pid) ?? 0) + (finite(m.cpu.percentCPUUsage) / 100) * seconds
        )
      }
      // A process that is gone leaves the account (a pid may come round again for another).
      for (const pid of [...c.cpuSeconds.keys()]) if (!live.has(pid)) c.cpuSeconds.delete(pid)
    }
    const mine = this.consumers.get(consumer)
    const window = mine ? (now - mine.readAt) / 1000 : 0
    const rows =
      mine && window > 0
        ? metrics.map((m) => ({
            ...m,
            cpu: {
              ...m.cpu,
              percentCPUUsage: ((mine.cpuSeconds.get(m.pid) ?? 0) / window) * 100
            }
          }))
        : metrics
    this.consumers.set(consumer, { readAt: now, cpuSeconds: new Map() })
    return rows
  }

  /** The consumer is done (a closed task page, a stopped governor): its account goes. */
  forget(consumer: string): void {
    this.consumers.delete(consumer)
  }
}

interface Consumer {
  /** When it last sampled. */
  readAt: number
  /** CPU-seconds per pid accrued over the engine's intervals since then. */
  cpuSeconds: Map<number, number>
}

function finite(n: number): number {
  return Number.isFinite(n) ? n : 0
}

/** The browser's one sampler: the governor (`collect`) and the task host read through it. */
export const hostMetrics = new HostMetricsSampler()
