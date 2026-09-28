import { SPRING_SNAPPY, stepSpring } from '@renderer/lib/motion/spring'

/**
 * The frame of a card's exit from the overview grid (v2 §11.4): the exit spring
 * (`SPRING_SNAPPY`) runs its position from {@link EXIT_TRAVEL} to 0, and the card draws
 * `scale(1 − .1·t)` at opacity `1 − t` for the progress `t = 1 − x / EXIT_TRAVEL`. Shared by the
 * exits `Departures` runs and by the frame Quick Delete's held still asks for (`quickDelete.ts`).
 */

/** Travel (px) of the exit spring: its progress is 1 − position / this. */
export const EXIT_TRAVEL = 120
/** How far a card shrinks on its way out. */
export const EXIT_SCALE = 0.1

/** The exit's frame: `scale(1 − .1·t)`, opacity `1 − t` for the spring's progress `t` (v2 §11.4). */
export function exitFrame(el: HTMLElement | null): (x: number) => void {
  return (x) => {
    if (!el) return
    const t = 1 - x / EXIT_TRAVEL
    el.style.transform = `scale(${1 - EXIT_SCALE * t})`
    el.style.opacity = String(Math.min(1, Math.max(0, 1 - t)))
  }
}

/**
 * The exit spring's progress `t` (0 at the card, 1 at rest) `ms` into its run – the oscillator's
 * closed form (`stepSpring`), so the frame is the same wherever it is asked for: the preview
 * host's mid-wipe still (`holdQuickDeleteWipe`) freezes each exit at the frame the wipe's
 * schedule would have it on. Before the run (`ms` ≤ 0) the card stands whole.
 */
export function exitProgressAt(ms: number): number {
  if (ms <= 0) return 0
  const { x } = stepSpring({ x: EXIT_TRAVEL, v: 0 }, 0, ms / 1000, SPRING_SNAPPY)
  return Math.min(1, Math.max(0, 1 - x / EXIT_TRAVEL))
}
