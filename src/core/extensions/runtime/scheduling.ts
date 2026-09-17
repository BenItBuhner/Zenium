import type { RunAt } from './manifest'

/**
 * When a content script declared with a given `run_at` executes, relative to the document
 * lifecycle, mirroring Chromium's ScriptInjectionManager:
 *  - document_start: right away (the bootstrap itself runs before the page's first script);
 *  - document_end: once the DOM is complete (DOMContentLoaded), or at once when it already is;
 *  - document_idle: at the load event or 200 ms after DOMContentLoaded, whichever comes first.
 */
export const IDLE_DELAY_MS = 200

export type ReadyState = 'loading' | 'interactive' | 'complete'

export interface LifecycleHooks {
  readyState(): ReadyState
  onDomContentLoaded(callback: () => void): void
  onLoad(callback: () => void): void
  setTimeout(callback: () => void, ms: number): void
}

/** Runs `run` exactly once at the moment `runAt` prescribes. */
export function scheduleRunAt(runAt: RunAt, hooks: LifecycleHooks, run: () => void): void {
  let done = false
  const once = (): void => {
    if (done) return
    done = true
    run()
  }
  const state = hooks.readyState()
  switch (runAt) {
    case 'document_start':
      once()
      return
    case 'document_end':
      if (state !== 'loading') once()
      else hooks.onDomContentLoaded(once)
      return
    case 'document_idle':
      if (state === 'complete') {
        once()
        return
      }
      hooks.onLoad(once)
      if (state === 'interactive') hooks.setTimeout(once, IDLE_DELAY_MS)
      else hooks.onDomContentLoaded(() => hooks.setTimeout(once, IDLE_DELAY_MS))
      return
  }
}

/** Sort key so groups execute in Chrome's order when several are due at the same moment. */
export function runAtOrder(runAt: RunAt): number {
  switch (runAt) {
    case 'document_start':
      return 0
    case 'document_end':
      return 1
    case 'document_idle':
      return 2
  }
}
