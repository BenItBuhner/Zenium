/**
 * The pointer captures the chrome holds, so that none can outlive the touch it belongs to.
 *
 * A gesture captures its pointer and ends with that pointer's `pointerup` or `pointercancel`.
 * A window that loses the foreground mid-touch – another activity in front, the screen off – has
 * no promise of either, and a gesture that never ended leaves its surface deaf: the sheet ignores
 * every next `pointerdown` while it still has a touch, the pill keeps waiting for a finger that
 * lifted long ago. `capturePointer` is `setPointerCapture` with a record of the capture, kept
 * until the browser reports it lost; `cancelPointerCaptures` ends every gesture still on record
 * the way an interrupted touch would, with a `pointercancel` to its element. The document coming
 * back on screen does that on its own, and so does the Android host's `zen-resume` (raised on the
 * window whenever its activity resumes, also from a dialog that never hid the document).
 */
const captures = new Map<Element, Set<number>>()

export function capturePointer(el: Element, pointerId: number): void {
  el.setPointerCapture(pointerId)
  let ids = captures.get(el)
  if (!ids) {
    ids = new Set()
    captures.set(el, ids)
  }
  if (ids.has(pointerId)) return
  ids.add(pointerId)
  const lost = (e: Event): void => {
    if ((e as PointerEvent).pointerId !== pointerId) return
    el.removeEventListener('lostpointercapture', lost)
    forget(el, pointerId)
  }
  el.addEventListener('lostpointercapture', lost)
}

function forget(el: Element, pointerId: number): void {
  const ids = captures.get(el)
  if (!ids) return
  ids.delete(pointerId)
  if (ids.size === 0) captures.delete(el)
}

/** Captures on record right now (for tests and diagnostics). */
export function heldPointerCaptures(): number {
  let n = 0
  for (const ids of captures.values()) n += ids.size
  return n
}

/**
 * End every gesture whose capture is still on record with a `pointercancel`, releasing the
 * capture first; returns how many were ended.
 */
export function cancelPointerCaptures(): number {
  const held = [...captures].flatMap(([el, ids]) => [...ids].map((id) => [el, id] as const))
  captures.clear()
  for (const [el, id] of held) {
    if (el.hasPointerCapture(id)) el.releasePointerCapture(id)
    el.dispatchEvent(new PointerEvent('pointercancel', { pointerId: id, bubbles: true }))
  }
  return held.length
}

/**
 * Whether a visibility change is the document coming back on screen: the moment to end gestures
 * a foreground handoff may have cut short.
 */
export function returnsToScreen(
  previous: DocumentVisibilityState,
  next: DocumentVisibilityState
): boolean {
  return previous === 'hidden' && next === 'visible'
}

/** The event the Android host raises on the window when its activity resumes. */
export const HOST_RESUME_EVENT = 'zen-resume'

/**
 * Watch `doc` and end stale captures each time it comes back on screen or its host resumes;
 * returns the stop.
 */
export function watchForegroundReturn(doc: Document): () => void {
  let previous = doc.visibilityState
  const onChange = (): void => {
    const next = doc.visibilityState
    if (returnsToScreen(previous, next)) cancelPointerCaptures()
    previous = next
  }
  const onResume = (): void => {
    cancelPointerCaptures()
  }
  const win = doc.defaultView
  doc.addEventListener('visibilitychange', onChange)
  win?.addEventListener(HOST_RESUME_EVENT, onResume)
  return () => {
    doc.removeEventListener('visibilitychange', onChange)
    win?.removeEventListener(HOST_RESUME_EVENT, onResume)
  }
}

const flags = globalThis as unknown as { __zenPointerCapturesWatched?: boolean }
if (typeof document !== 'undefined' && !flags.__zenPointerCapturesWatched) {
  flags.__zenPointerCapturesWatched = true
  watchForegroundReturn(document)
}
