/**
 * The chrome's one animation clock (motion spec §6). Every surface that writes per frame – the
 * springs (`SpringAnimation`), the reduced-motion fades, the page-edge band's travel – asks this
 * clock for its next frame, and the clock asks the host for one `requestAnimationFrame` for all
 * of them: one frame, one `now`, every callback. The band, the toast seat and the hint bubble
 * share one layer and one clock; no surface runs a `requestAnimationFrame` loop of its own.
 *
 * The shape is `requestAnimationFrame`'s: `requestFrame(cb)` runs `cb(now)` once, on the next
 * frame, and hands back a handle `cancelFrame` takes. A callback that wants the frame after asks
 * again from inside its run; a callback cancelled by an earlier one in the same frame does not
 * run (as the host's own map of callbacks behaves). A throw in one callback does not rob the
 * others of their frame: the batch runs to its end, the clock re-arms for whatever asked again,
 * and the first error is thrown out of the frame afterwards.
 */

export type FrameCallback = (now: number) => void

type Host = typeof requestAnimationFrame

interface Armed {
  /** The `requestAnimationFrame` the frame was asked of. */
  via: Host
  /** The handle it gave. */
  id: number
  /** The function it will call – a frame from an earlier arming is not this clock's tick. */
  run: FrameRequestCallback
}

const pending = new Map<number, FrameCallback>()
let nextId = 0
let armed: Armed | null = null
let ticking = false
/** Handles cancelled while a batch runs, so the batch skips them. */
let dropped: Set<number> | null = null

function host(): Host {
  return globalThis.requestAnimationFrame
}

/** Ask the host for the one frame, unless one is already on its way (or a batch is running). */
function arm(): void {
  if (ticking || pending.size === 0) return
  const via = host()
  if (armed !== null && armed.via === via) return
  const run: FrameRequestCallback = (now) => {
    // A frame of an arming since replaced (a `cancelAnimationFrame` that did not cancel, a test
    // harness firing every frame it was ever handed): not this clock's tick.
    if (armed === null || armed.run !== run) return
    tick(now)
  }
  const id = via(run)
  armed = { via, id, run }
}

function disarm(): void {
  if (armed === null) return
  if (armed.via === host()) globalThis.cancelAnimationFrame(armed.id)
  armed = null
}

function tick(now: number): void {
  armed = null
  const batch = [...pending]
  pending.clear()
  dropped = new Set()
  ticking = true
  let failed = false
  let failure: unknown
  try {
    for (const [id, cb] of batch) {
      if (dropped.has(id)) continue
      try {
        cb(now)
      } catch (error) {
        if (!failed) {
          failed = true
          failure = error
        }
      }
    }
  } finally {
    ticking = false
    dropped = null
    arm()
  }
  if (failed) throw failure
}

/** Run `cb(now)` on the next frame; the handle cancels it. */
export function requestFrame(cb: FrameCallback): number {
  if (armed !== null && armed.via !== host()) {
    // The host's `requestAnimationFrame` was swapped out from under the clock (a test's stub,
    // fake timers): the frame asked of the old one is never coming, and the callbacks that
    // waited on it belong to the world that was swapped away. A fresh clock for the new one.
    pending.clear()
    armed = null
  }
  const id = ++nextId
  pending.set(id, cb)
  arm()
  return id
}

/** Take a callback off the clock; a handle not on it (already run, already cancelled) is nothing. */
export function cancelFrame(id: number): void {
  pending.delete(id)
  if (ticking) dropped?.add(id)
  else if (pending.size === 0) disarm()
}

/** How many callbacks wait for the next frame – the clock is idle at 0 (for tests). */
export function framesPending(): number {
  return pending.size
}
