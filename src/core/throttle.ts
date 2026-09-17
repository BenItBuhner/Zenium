/**
 * Push values at most `ratePerSec` times a second; the latest pending value is delivered when
 * the window opens. Used for native window titles (10/s).
 */
export class ThrottledValue<T> {
  private lastAt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: T | undefined
  private hasPending = false

  constructor(
    private readonly minIntervalMs: number,
    private readonly emit: (value: T) => void
  ) {}

  push(value: T): void {
    const now = Date.now()
    const wait = this.minIntervalMs - (now - this.lastAt)
    if (wait <= 0) {
      this.clearTimer()
      this.hasPending = false
      this.lastAt = now
      this.emit(value)
      return
    }
    this.pending = value
    this.hasPending = true
    if (!this.timer) this.timer = setTimeout(() => this.flush(), wait)
  }

  flush(): void {
    this.clearTimer()
    if (!this.hasPending) return
    this.hasPending = false
    const value = this.pending as T
    this.lastAt = Date.now()
    this.emit(value)
  }

  dispose(): void {
    this.clearTimer()
    this.hasPending = false
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
