/**
 * The reduced-motion fade (design language v2 §11.3): with `prefers-reduced-motion: reduce` an
 * appearance or departure is a 120 ms opacity fade in place, nothing travels. Written per frame,
 * because the reduced-motion stylesheet cuts every CSS transition to nothing, so a transition
 * could not carry it. `SpringAnimation` jumps under the same preference; a surface whose spring
 * carried its arrival runs this instead.
 */

/** How long the fade takes. */
export const REDUCED_FADE_MS = 120

/**
 * Fade `el` from its present inline opacity (or the far end when it has none) to `to`, then run
 * `done`. Returns a cancel: a cancelled fade leaves the element where it was and never calls
 * `done`.
 */
export function fadeOpacity(el: HTMLElement, to: 0 | 1, done?: () => void): () => void {
  const present = Number.parseFloat(el.style.opacity)
  const from = Number.isFinite(present) ? present : 1 - to
  let frame: number | null = null
  const startedAt = performance.now()
  el.style.opacity = from.toFixed(3)
  const step = (now: number): void => {
    const t = Math.min(1, (now - startedAt) / REDUCED_FADE_MS)
    el.style.opacity = (from + (to - from) * t).toFixed(3)
    if (t < 1) {
      frame = requestAnimationFrame(step)
      return
    }
    frame = null
    done?.()
  }
  frame = requestAnimationFrame(step)
  return () => {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
  }
}
