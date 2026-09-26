/**
 * Counters and timings the MCP server keeps about itself, for `zen_status`, the
 * `zenium://diagnostics` resource and the soak harness: how sessions came and went (created,
 * ended by the agent, parked idle, resumed without an initialize, expired, refused as unknown),
 * how many calls ran and failed, and per tool the latency percentiles over the last
 * `SAMPLE_WINDOW` calls. Instrumentation first, then fixes: a lag or a death shows up here as a
 * number, not as a guess.
 */

const SAMPLE_WINDOW = 200
const RECENT_ERRORS = 20

export interface ToolTiming {
  calls: number
  errors: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}

export interface SessionCounters {
  /** Sessions with a record right now, parked ones included. */
  live: number
  parked: number
  created: number
  /** `zen_session end`: the agent let go of its groups and kept its connection. */
  ended: number
  /** Idle past the limit: groups orphaned, record kept for the client's next call. */
  parkedTotal: number
  /** Parked sessions whose client came back. */
  resumed: number
  /** Known `Mcp-Session-Id`s that no record answered any more, re-made under the same id. */
  resurrected: number
  /** Records deleted for good: DELETE, Settings → Disconnect, the parked limit, shutdown. */
  closed: number
  /** Requests with a session id nothing could be made of (no valid token): the 404s. */
  unknown: number
}

export interface DiagnosticsSnapshot {
  startedAt: number
  uptimeMs: number
  sessions: SessionCounters
  calls: { total: number; errors: number; inFlight: number }
  tools: Record<string, ToolTiming>
  recentErrors: { at: number; tool: string; message: string }[]
}

class Samples {
  private readonly values: number[] = []
  private at = 0
  calls = 0
  errors = 0
  maxMs = 0

  add(ms: number): void {
    this.calls++
    if (ms > this.maxMs) this.maxMs = ms
    if (this.values.length < SAMPLE_WINDOW) this.values.push(ms)
    else {
      this.values[this.at] = ms
      this.at = (this.at + 1) % SAMPLE_WINDOW
    }
  }

  percentile(p: number): number {
    if (!this.values.length) return 0
    const sorted = [...this.values].sort((a, b) => a - b)
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
    return sorted[index]
  }
}

export class Diagnostics {
  readonly startedAt: number
  readonly sessions: Omit<SessionCounters, 'live' | 'parked'> = {
    created: 0,
    ended: 0,
    parkedTotal: 0,
    resumed: 0,
    resurrected: 0,
    closed: 0,
    unknown: 0
  }
  private total = 0
  private failed = 0
  private inFlight = 0
  private readonly tools = new Map<string, Samples>()
  private readonly errors: { at: number; tool: string; message: string }[] = []

  constructor(private readonly clock: () => number = () => Date.now()) {
    this.startedAt = clock()
  }

  /** A tool call started; the returned function records its end (and error, if any). */
  begin(tool: string): (error?: string | null) => void {
    const started = this.clock()
    this.inFlight++
    this.total++
    let done = false
    return (error) => {
      if (done) return
      done = true
      this.inFlight--
      const samples = this.samplesFor(tool)
      samples.add(Math.max(0, this.clock() - started))
      if (error) {
        this.failed++
        samples.errors++
        this.errors.push({ at: this.clock(), tool, message: error.slice(0, 300) })
        if (this.errors.length > RECENT_ERRORS) this.errors.shift()
      }
    }
  }

  snapshot(live: { live: number; parked: number }): DiagnosticsSnapshot {
    const tools: Record<string, ToolTiming> = {}
    for (const [name, s] of [...this.tools].sort(([a], [b]) => a.localeCompare(b))) {
      tools[name] = {
        calls: s.calls,
        errors: s.errors,
        p50Ms: s.percentile(50),
        p95Ms: s.percentile(95),
        maxMs: s.maxMs
      }
    }
    return {
      startedAt: this.startedAt,
      uptimeMs: Math.max(0, this.clock() - this.startedAt),
      sessions: { ...live, ...this.sessions },
      calls: { total: this.total, errors: this.failed, inFlight: this.inFlight },
      tools,
      recentErrors: [...this.errors]
    }
  }

  private samplesFor(tool: string): Samples {
    let s = this.tools.get(tool)
    if (!s) {
      s = new Samples()
      this.tools.set(tool, s)
    }
    return s
  }
}

/** The one-line summary `zen_status` carries: enough to see a sick server without the JSON. */
export function summarize(d: DiagnosticsSnapshot): string {
  const s = d.sessions
  const slowest = Object.entries(d.tools)
    .sort(([, a], [, b]) => b.p95Ms - a.p95Ms)
    .slice(0, 3)
    .map(([name, t]) => `${name} p95 ${t.p95Ms} ms`)
  return (
    `up ${formatDuration(d.uptimeMs)}; sessions ${s.live} live (${s.parked} parked), ` +
    `${s.created} created, ${s.ended} ended, ${s.resurrected} resumed after loss, ${s.unknown} unknown; ` +
    `calls ${d.calls.total} (${d.calls.errors} errors, ${d.calls.inFlight} running)` +
    (slowest.length ? `; slowest: ${slowest.join(', ')}` : '')
  )
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h} h ${m % 60} min`
}
