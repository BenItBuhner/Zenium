import type { WebContents } from 'electron'

interface SessionState {
  frozen: boolean
  cpuThrottle: number
  hardwareConcurrency: number | null
}

/**
 * Chromium's page-lifecycle machinery, driven through the DevTools protocol: freezing (the same
 * mechanism Chrome's tab freezing uses), CPU throttling, `navigator.hardwareConcurrency`
 * overrides and forced memory purges.
 *
 * The debugger stays attached only while an override is in effect – detaching is the only way to
 * clear Emulation overrides – so tabs that need nothing carry no DevTools session at all.
 */
export class TabLifecycle {
  private readonly sessions = new Map<number, SessionState>()

  /** Chromium tab freezing: no timers, no script, no rendering until thawed. */
  async freeze(wc: WebContents): Promise<boolean> {
    const ok = await this.send(wc, 'Page.setWebLifecycleState', { state: 'frozen' })
    if (ok) this.state(wc).frozen = true
    return ok
  }

  /**
   * Always sends the command: the frozen flag lives on the WebContents, so it survives another
   * DevTools client detaching this session and wiping the local bookkeeping.
   */
  async thaw(wc: WebContents): Promise<boolean> {
    const ok = await this.send(wc, 'Page.setWebLifecycleState', { state: 'active' })
    if (ok) {
      const s = this.sessions.get(wc.id)
      if (s) s.frozen = false
      this.detachIfIdle(wc)
    }
    return ok
  }

  /** DevTools-style CPU throttling of the tab's renderer main thread (1 = off). */
  async setCpuThrottle(wc: WebContents, rate: number): Promise<boolean> {
    const clamped = Math.max(1, Math.round(rate))
    const s = this.sessions.get(wc.id)
    if ((s?.cpuThrottle ?? 1) === clamped) return true
    if (clamped === 1 && !s) return true
    const ok = await this.send(wc, 'Emulation.setCPUThrottlingRate', { rate: clamped })
    if (ok) {
      this.state(wc).cpuThrottle = clamped
      this.detachIfIdle(wc)
    }
    return ok
  }

  /**
   * Cap the number of cores pages believe they have, so worker pools and WASM threads size
   * themselves to the CPU budget. `null` removes the override.
   */
  async setHardwareConcurrency(wc: WebContents, cores: number | null): Promise<boolean> {
    const s = this.sessions.get(wc.id)
    if ((s?.hardwareConcurrency ?? null) === cores) return true
    if (cores === null) {
      // The protocol has no "clear" – dropping the session clears every emulation override.
      if (!s) return true
      s.hardwareConcurrency = null
      if (!this.detachIfIdle(wc)) {
        // Something else still needs the session; re-apply the remaining overrides afterwards.
        await this.reattach(wc)
      }
      return true
    }
    const ok = await this.send(wc, 'Emulation.setHardwareConcurrencyOverride', {
      hardwareConcurrency: Math.max(1, Math.round(cores))
    })
    if (ok) this.state(wc).hardwareConcurrency = cores
    return ok
  }

  /**
   * Make the renderer give memory back: a full V8 garbage collection with a low-memory
   * notification (drops compiled code and shrinks the heap), plus Chromium's memory-pressure
   * purge of image, font and resource caches where the protocol supports it.
   */
  async purge(wc: WebContents): Promise<boolean> {
    const ok = await this.send(wc, 'HeapProfiler.collectGarbage')
    if (ok) {
      await this.send(wc, 'Memory.forciblyPurgeJavaScriptMemory', undefined, true)
      await this.send(wc, 'Memory.simulatePressureNotification', { level: 'critical' }, true)
    }
    this.detachIfIdle(wc)
    return ok
  }

  isFrozen(wc: WebContents): boolean {
    return this.sessions.get(wc.id)?.frozen ?? false
  }

  cpuThrottle(wc: WebContents): number {
    return this.sessions.get(wc.id)?.cpuThrottle ?? 1
  }

  /** The WebContents is gone – nothing to detach from any more. */
  forget(wc: WebContents): void {
    this.sessions.delete(wc.id)
  }

  // ---------------------------------------------------------------------------

  private state(wc: WebContents): SessionState {
    let s = this.sessions.get(wc.id)
    if (!s) {
      s = { frozen: false, cpuThrottle: 1, hardwareConcurrency: null }
      this.sessions.set(wc.id, s)
    }
    return s
  }

  private attach(wc: WebContents): boolean {
    if (wc.isDestroyed()) return false
    if (wc.debugger.isAttached()) return true
    try {
      wc.debugger.attach('1.3')
    } catch (error) {
      console.warn('[zen] resource governor could not attach to a page:', error)
      return false
    }
    wc.debugger.once('detach', () => {
      // Target closed or another client kicked us out: overrides are gone either way.
      this.sessions.delete(wc.id)
    })
    return true
  }

  private async send(
    wc: WebContents,
    method: string,
    params?: Record<string, unknown>,
    optional = false
  ): Promise<boolean> {
    if (!this.attach(wc)) return false
    try {
      await wc.debugger.sendCommand(method, params)
      return true
    } catch (error) {
      if (!optional) console.warn(`[zen] ${method} failed:`, (error as Error).message)
      return false
    }
  }

  /** Detach when no override is active any more. Returns true when detached. */
  private detachIfIdle(wc: WebContents): boolean {
    const s = this.sessions.get(wc.id)
    if (s && (s.frozen || s.cpuThrottle !== 1 || s.hardwareConcurrency !== null)) return false
    this.sessions.delete(wc.id)
    if (!wc.isDestroyed() && wc.debugger.isAttached()) {
      try {
        wc.debugger.detach()
      } catch {
        // Already detached.
      }
    }
    return true
  }

  private async reattach(wc: WebContents): Promise<void> {
    const s = this.sessions.get(wc.id)
    if (!s || wc.isDestroyed()) return
    try {
      if (wc.debugger.isAttached()) wc.debugger.detach()
    } catch {
      // Already detached.
    }
    const { frozen, cpuThrottle, hardwareConcurrency } = s
    this.sessions.delete(wc.id)
    if (cpuThrottle !== 1) await this.setCpuThrottle(wc, cpuThrottle)
    if (hardwareConcurrency !== null) await this.setHardwareConcurrency(wc, hardwareConcurrency)
    if (frozen) await this.freeze(wc)
  }
}
