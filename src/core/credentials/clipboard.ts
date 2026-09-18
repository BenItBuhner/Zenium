import type { ClipboardHost } from '../platform'

/**
 * Secrets on the clipboard: every copy of a password or card number is marked sensitive for the
 * host (Android hides it from the clipboard preview) and, when the setting asks for it and the
 * host can, taken off the clipboard again after the timeout, provided the user has not copied
 * something else meanwhile. One timer: a second copy replaces the first.
 */
export class SensitiveClipboard {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: string | null = null

  constructor(private readonly clipboard: Pick<ClipboardHost, 'writeText' | 'clearText'>) {}

  /** Whether this host can clear its clipboard (the toast says so when it cannot). */
  canClear(): boolean {
    return typeof this.clipboard.clearText === 'function'
  }

  /** Copy `text`; resolves to the number of seconds after which it is cleared, or 0 when it stays. */
  copy(text: string, clearAfterSeconds: number): number {
    this.cancel()
    this.clipboard.writeText(text, true)
    if (clearAfterSeconds <= 0 || !this.clipboard.clearText) return 0
    this.pending = text
    this.timer = setTimeout(() => {
      this.timer = null
      this.pending = null
      void this.clipboard.clearText?.(text).catch(() => undefined)
    }, clearAfterSeconds * 1000)
    return clearAfterSeconds
  }

  /** Forget the scheduled clearing (a new copy replaces it). */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
  }

  /** Shutdown: a secret still waiting for its timer is cleared now. */
  async flush(): Promise<void> {
    const text = this.pending
    this.cancel()
    if (text && this.clipboard.clearText)
      await this.clipboard.clearText(text).catch(() => undefined)
  }
}
