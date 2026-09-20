/**
 * `beforeinstallprompt` / `appinstalled` for pages whose engine has no install manager of its
 * own – Electron's Chromium never fires them (MW-22 on the desktop). The page must be able to
 * call `prompt()` on the event and read `userChoice`, so the event has to be born in the page's
 * own world: `installInstallPromptShim` runs there (through `contextBridge.executeInMainWorld`)
 * and talks to the isolated world's page script over two DOM events, JSON in `detail`. Android
 * runs the page script in the main world already and keeps its inline version
 * (`shared/pageScript.ts`).
 */

export interface InstallPromptShimEvents {
  /** Main world → isolated world: `{ kind: 'prompt' | 'deferred' }`. */
  request: string
  /** Isolated world → main world: `{ action: 'installable' | 'result' | 'installed', outcome? }`. */
  result: string
}

export const INSTALL_PROMPT_EVENTS: InstallPromptShimEvents = {
  request: 'zen-install-prompt-request',
  result: 'zen-install-prompt-result'
}

/**
 * Runs in the page's main world: the function is serialised, so it is self-contained and takes
 * everything it needs as arguments. Never throws into the page.
 */
export function installInstallPromptShim(events: InstallPromptShimEvents): void {
  type Outcome = 'accepted' | 'dismissed'
  interface Choice {
    outcome: Outcome
    platform: string
  }
  const win = window
  const doc = document
  const post = (kind: 'prompt' | 'deferred'): void => {
    doc.dispatchEvent(new CustomEvent(events.request, { detail: JSON.stringify({ kind }) }))
  }

  let pendingPrompt: ZenBeforeInstallPromptEvent | null = null
  let lastEvent: ZenBeforeInstallPromptEvent | null = null
  let fired = false
  /** The event whose `prompt()` is waiting for the sheet's outcome. */
  const awaitOutcome = (event: ZenBeforeInstallPromptEvent): void => {
    pendingPrompt = event
  }

  // Constructor-assigned members only: the function is serialised into the page's world, where
  // no compiler helper for class fields exists.
  class ZenBeforeInstallPromptEvent extends Event {
    readonly platforms: string[]
    private settled: boolean
    private prompted: boolean
    private resolveChoice: (choice: Choice) => void
    readonly userChoice: Promise<Choice>

    constructor() {
      super('beforeinstallprompt', { cancelable: true })
      this.platforms = ['web']
      this.settled = false
      this.prompted = false
      this.resolveChoice = () => undefined
      this.userChoice = new Promise<Choice>((resolve) => {
        this.resolveChoice = resolve
      })
    }

    prompt(): Promise<Choice> {
      if (this.prompted) {
        return Promise.reject(
          new DOMException('The prompt() method may only be called once.', 'InvalidStateError')
        )
      }
      const activation = (navigator as { userActivation?: { isActive: boolean } }).userActivation
      if (activation && !activation.isActive) {
        return Promise.reject(
          new DOMException('prompt() requires a user gesture.', 'NotAllowedError')
        )
      }
      this.prompted = true
      awaitOutcome(this)
      post('prompt')
      return this.userChoice
    }

    settle(outcome: Outcome): void {
      if (this.settled) return
      this.settled = true
      this.resolveChoice({ outcome, platform: 'web' })
    }
  }

  // `window.onbeforeinstallprompt = fn` works like the native handler attribute would (Chromium
  // defines the attribute itself; this covers an engine that does not).
  const defineHandlerAttribute = (type: string): void => {
    const name = `on${type}`
    if (name in win) return
    let handler: EventListener | null = null
    try {
      Object.defineProperty(win, name, {
        configurable: true,
        enumerable: true,
        get: () => handler,
        set: (value: unknown) => {
          if (handler) win.removeEventListener(type, handler)
          handler = typeof value === 'function' ? (value as EventListener) : null
          if (handler) win.addEventListener(type, handler)
        }
      })
    } catch {
      /* a frozen window keeps the standard listener path */
    }
  }
  defineHandlerAttribute('beforeinstallprompt')
  defineHandlerAttribute('appinstalled')

  const fire = (): void => {
    if (fired) return
    fired = true
    try {
      const event = new ZenBeforeInstallPromptEvent()
      lastEvent = event
      const proceed = win.dispatchEvent(event)
      if (!proceed) post('deferred')
    } catch {
      /* a listener threw; the browser's own prompt still applies */
    }
  }

  doc.addEventListener(events.result, (e) => {
    try {
      const detail = (e as CustomEvent<unknown>).detail
      const message = (typeof detail === 'string' ? JSON.parse(detail) : detail) as {
        action?: string
        outcome?: string
      } | null
      switch (message?.action) {
        case 'installable':
          if (doc.readyState === 'loading')
            doc.addEventListener('DOMContentLoaded', fire, { once: true })
          else fire()
          return
        case 'result': {
          const outcome: Outcome = message.outcome === 'accepted' ? 'accepted' : 'dismissed'
          const target = pendingPrompt ?? lastEvent
          pendingPrompt = null
          target?.settle(outcome)
          return
        }
        case 'installed':
          pendingPrompt?.settle('accepted')
          lastEvent?.settle('accepted')
          pendingPrompt = null
          win.dispatchEvent(new Event('appinstalled'))
          return
      }
    } catch {
      /* never let the polyfill throw into the page */
    }
  })
}
