import { extensionOrigin } from '@core/extensions/runtime/plan'

/**
 * Extension-origin scripts under the page's Content-Security-Policy.
 *
 * A content script may insert `<script src="chrome.runtime.getURL('x.js')">` into any page: in
 * Chrome an extension's resources are beyond the page's policy (`chrome-extension:` bypasses
 * CSP). The emulated origin, `https://<id>.ext.zenium.invalid`, is an https origin a page's
 * `script-src` refuses like any other, and then the element fires `error` and never runs.
 *
 * The bootstrap listens for that `error` (capture, on the window: `error` does not bubble) in
 * every world that runs an extension's scripts. An element under an attached extension's
 * origin is reported to the host, which runs the file in the main world itself
 * (`evaluateJavascript` is under no page policy) and answers; the element then gets the `load`
 * it expected, or, when the host could not (not web-accessible, a subframe, no such file), the
 * `error` it was already firing. The refusal never reaches the extension's own handlers.
 */

/** What the bootstrap lends the recovery: the attached extensions and the bridge. */
export interface ScriptRecoveryHost {
  /** Ids of the extensions attached to this world at call time. */
  attachedIds(): string[]
  /** Ask the host to run `url` in the main world; it answers through `done(id, error)`. */
  request(id: string, extId: string, url: string): void
  error(...args: unknown[]): void
}

/** The little of a `<script>` element and its `error` event the recovery reads. */
export interface ScriptLike {
  tagName?: unknown
  src?: unknown
  dispatchEvent(event: Event): boolean
}

export interface ErrorEventLike {
  target: unknown
  stopImmediatePropagation(): void
}

export interface ScriptRecovery {
  /** The window's capturing `error` listener. */
  onError(event: ErrorEventLike): void
  /** The host's answer to `request`: `error` null when the file ran in the main world. */
  done(id: string, error: string | null): void
  /** Requests still waiting for the host (tests, diagnostics). */
  pending(): number
}

const RECOVERED = new WeakSet<object>()

export function createScriptRecovery(host: ScriptRecoveryHost): ScriptRecovery {
  const waiting = new Map<string, { script: ScriptLike; url: string }>()
  let seq = 0

  const extensionFor = (src: string): string | null => {
    for (const id of host.attachedIds()) if (src.startsWith(extensionOrigin(id) + '/')) return id
    return null
  }

  return {
    onError(event) {
      const target = event.target as ScriptLike | null
      if (!target || typeof target !== 'object' || typeof target.dispatchEvent !== 'function')
        return
      if (String(target.tagName).toUpperCase() !== 'SCRIPT') return
      // Our own `error`, re-dispatched after the host gave up: let it through this time.
      if (RECOVERED.has(target)) return
      const src = typeof target.src === 'string' ? target.src : ''
      const extId = extensionFor(src)
      if (extId === null) return
      RECOVERED.add(target)
      event.stopImmediatePropagation()
      const id = `s${(seq += 1)}`
      waiting.set(id, { script: target, url: src })
      host.request(id, extId, src)
    },
    done(id, error) {
      const entry = waiting.get(id)
      if (!entry) return
      waiting.delete(id)
      if (error === null) {
        entry.script.dispatchEvent(new Event('load'))
        return
      }
      host.error(`[Zenium] ${entry.url} could not run in the main world: ${error}`)
      entry.script.dispatchEvent(new Event('error'))
    },
    pending: () => waiting.size
  }
}
