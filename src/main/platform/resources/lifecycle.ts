import type { WebContents } from 'electron'
import { setDebuggerRecycler } from '../pageDebugger'

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
 *
 * The session is shared with the page's other holders (`pageDebugger.ts`); a holder that needs a
 * fresh agent asks for a `recycle`, which puts the governor's own overrides back on the new one.
 */
export class TabLifecycle {
  private readonly sessions = new Map<number, SessionState>()
  /** Pages whose session this lifecycle attached itself (a shared one another holder opened is not ours to drop). */
  private readonly attachedBy = new Set<number>()
  /** Pages whose debugger `detach` is followed (once per page; the state goes with the session). */
  private readonly watched = new Set<number>()
  /**
   * The governor's word when a page's session went with overrides on it – another holder let
   * the shared session go, DevTools or an extension took the page: what was applied is gone and
   * the caller decides again (the CPU clamp on a background page).
   */
  onSessionLost: ((wc: WebContents) => void) | null = null

  constructor() {
    setDebuggerRecycler((wc) => this.recycle(wc))
  }

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
  async thaw(wc: WebContents, quiet = false): Promise<boolean> {
    const ok = await this.send(wc, 'Page.setWebLifecycleState', { state: 'active' }, quiet)
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
    if ((s?.hardwareConcurrency ?? null) === cores) {
      // A session of ours with nothing on it yet – the override still on its way to a renderer
      // that does not answer (a hung page) – goes with a clear: the page is in front now, and
      // Chromium reports a hang only for a page with no DevTools client on it.
      if (cores === null && !s && this.attachedBy.has(wc.id)) this.detachIfIdle(wc)
      return true
    }
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
   * notification, which also flushes compiled code and shrinks the heap.
   *
   * `Memory.forciblyPurgeJavaScriptMemory` is deliberately not used – it simulates Chromium's
   * OOM intervention, which can leave the page paused.
   */
  async purge(wc: WebContents): Promise<boolean> {
    const ok = await this.send(wc, 'HeapProfiler.collectGarbage')
    this.detachIfIdle(wc)
    return ok
  }

  /**
   * Raise a memory-pressure notification in the browser process (one call covers the whole
   * browser: discardable memory, font and GPU caches, and anything Chromium forwards to its
   * child processes). Best effort.
   */
  async notifyMemoryPressure(wc: WebContents, level: 'moderate' | 'critical'): Promise<boolean> {
    const ok = await this.send(wc, 'Memory.simulatePressureNotification', { level }, true)
    this.detachIfIdle(wc)
    return ok
  }

  isFrozen(wc: WebContents): boolean {
    return this.sessions.get(wc.id)?.frozen ?? false
  }

  cpuThrottle(wc: WebContents): number {
    return this.sessions.get(wc.id)?.cpuThrottle ?? 1
  }

  /** The cores the page is told it has, null with no override on it. */
  hardwareConcurrency(wc: WebContents): number | null {
    return this.sessions.get(wc.id)?.hardwareConcurrency ?? null
  }

  /**
   * The WebContents is gone – nothing to detach from any more. Takes the id: after a page closes
   * itself the view's accessor is already dead by the time the host reports it.
   */
  forget(webContentsId: number): void {
    this.sessions.delete(webContentsId)
    this.attachedBy.delete(webContentsId)
    this.watched.delete(webContentsId)
  }

  /**
   * A fresh agent for the page: the session is dropped – every emulation override goes with it –
   * and the governor's own overrides are put back on a new one, so a holder that spent a command
   * the agent takes once (`Page.setFontFamilies`) can send it again. Without overrides of the
   * governor's the page is left detached for the caller to attach.
   */
  async recycle(wc: WebContents): Promise<void> {
    if (wc.isDestroyed()) return
    // The state goes first: the `detach` that follows is ours, not a session lost.
    const s = this.sessions.get(wc.id)
    this.sessions.delete(wc.id)
    this.attachedBy.delete(wc.id)
    try {
      if (wc.debugger.isAttached()) wc.debugger.detach()
    } catch {
      // Already detached.
    }
    if (!s) return
    const { frozen, cpuThrottle, hardwareConcurrency } = s
    if (cpuThrottle !== 1) await this.setCpuThrottle(wc, cpuThrottle)
    if (hardwareConcurrency !== null) await this.setHardwareConcurrency(wc, hardwareConcurrency)
    if (frozen) await this.freeze(wc)
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
    this.watch(wc)
    // Another holder's session (the dark theme for sites' hold, an action in flight) is shared:
    // an override sent on it is theirs to lose when their hold ends – `watch` hears of that.
    if (wc.debugger.isAttached()) return true
    try {
      wc.debugger.attach('1.3')
    } catch (error) {
      console.warn('[zen] resource governor could not attach to a page:', error)
      return false
    }
    this.attachedBy.add(wc.id)
    return true
  }

  /**
   * The session's end is the overrides' end, whoever ended it – the target closed, another
   * client took the page, a holder the session was shared with let it go, or this lifecycle
   * itself (which clears its state first, so nothing is reported lost then).
   */
  private watch(wc: WebContents): void {
    if (this.watched.has(wc.id)) return
    this.watched.add(wc.id)
    wc.debugger.on('detach', () => {
      this.attachedBy.delete(wc.id)
      const lost = this.sessions.delete(wc.id)
      if (lost && !wc.isDestroyed()) this.onSessionLost?.(wc)
    })
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

  /**
   * Detach when no override is active any more. Returns true when nothing of ours is left on the
   * page. A session another holder opened, which only carried an override of ours (or nothing –
   * a purge sent on it), is left to that holder.
   */
  private detachIfIdle(wc: WebContents): boolean {
    const s = this.sessions.get(wc.id)
    if (s && (s.frozen || s.cpuThrottle !== 1 || s.hardwareConcurrency !== null)) return false
    const ours = this.sessions.delete(wc.id) || this.attachedBy.delete(wc.id)
    this.attachedBy.delete(wc.id)
    if (ours && !wc.isDestroyed() && wc.debugger.isAttached()) {
      try {
        wc.debugger.detach()
      } catch {
        // Already detached.
      }
    }
    return true
  }

  private async reattach(wc: WebContents): Promise<void> {
    if (!this.sessions.has(wc.id)) return
    await this.recycle(wc)
  }
}
