interface Sample {
  t: number
  x: number
  y: number
}

/**
 * Finger velocity from the recent pointer samples, the way Android's `VelocityTracker` does it:
 * a least-squares line through the last ~100 ms rather than the last two events, so one jittery
 * sample cannot turn a slow drag into a fling. Timestamps in ms, results in px/s.
 */
export class VelocityTracker {
  private samples: Sample[] = []

  constructor(
    private readonly windowMs = 100,
    private readonly maxSamples = 24
  ) {}

  reset(): void {
    this.samples = []
  }

  add(t: number, x: number, y: number): void {
    const last = this.samples[this.samples.length - 1]
    // Duplicate timestamps (coalesced events) would collapse the regression.
    if (last && t <= last.t) {
      this.samples[this.samples.length - 1] = { t: last.t, x, y }
      return
    }
    this.samples.push({ t, x, y })
    if (this.samples.length > this.maxSamples) this.samples.shift()
  }

  /** Velocity at time `now` (defaults to the last sample); a finger that paused reads as 0. */
  velocity(now?: number): { vx: number; vy: number } {
    const end = now ?? this.samples[this.samples.length - 1]?.t ?? 0
    const recent = this.samples.filter((s) => end - s.t <= this.windowMs)
    if (recent.length < 2) return { vx: 0, vy: 0 }
    const n = recent.length
    let meanT = 0
    let meanX = 0
    let meanY = 0
    for (const s of recent) {
      meanT += s.t
      meanX += s.x
      meanY += s.y
    }
    meanT /= n
    meanX /= n
    meanY /= n
    let covTX = 0
    let covTY = 0
    let varT = 0
    for (const s of recent) {
      const dt = s.t - meanT
      covTX += dt * (s.x - meanX)
      covTY += dt * (s.y - meanY)
      varT += dt * dt
    }
    if (varT === 0) return { vx: 0, vy: 0 }
    return { vx: (covTX / varT) * 1000, vy: (covTY / varT) * 1000 }
  }
}
