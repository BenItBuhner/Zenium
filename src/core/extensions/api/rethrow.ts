/**
 * A throw inside an extension API callback surfaces as the page's own uncaught error on the next
 * tick, as it does in Chrome: the API's own call returns, and the error reaches the console and
 * `window.onerror` by itself. The emulated engine's rethrow sites go through [rethrowLater], and
 * the shim's – a self-contained function the desktop stringifies, which cannot import this
 * module – through its `onUncaught` option, which the engine points at [noteRethrow]; so one
 * hook sees them all.
 *
 * The hook is the debug bootstrap's ([onRethrow]): an uncaught error of a document-start script
 * is dispatched to the page's `error` event sanitized – `"Script error."`, line 0, column 0, no
 * error object – while the console line keeps the text, so the event names neither the throw's
 * site nor its caller; the error's own stack, captured where it was constructed, does, and the
 * hook records it into the page's debug stats for the compat sweep (Save Page WE's worker and
 * its `TypeError: Cannot read properties of undefined (reading '1')` at the bootstrap's own
 * line, compat round 27).
 */
let hook: ((error: unknown) => void) | null = null

/** Sets (or clears, with null) the one hook that sees every rethrown error before its tick. */
export function onRethrow(fn: ((error: unknown) => void) | null): void {
  hook = fn
}

/** Hands `error` to the hook, when one is set; a hook that throws is swallowed (a debug aid). */
export function noteRethrow(error: unknown): void {
  if (!hook) return
  try {
    hook(error)
  } catch {
    /* the record is a debug aid; the rethrow is the contract */
  }
}

/**
 * Throws `error` on the next tick (`schedule`: the realm's `setTimeout(…, 0)` unless the
 * caller's primordials say otherwise), after the hook saw it.
 */
export function rethrowLater(
  error: unknown,
  schedule: (fn: () => void) => void = (fn) => {
    setTimeout(fn, 0)
  }
): void {
  noteRethrow(error)
  schedule(() => {
    throw error
  })
}
