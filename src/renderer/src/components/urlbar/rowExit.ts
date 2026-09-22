import type { Suggestion } from '@shared/types'
import { REDUCED_FADE_MS } from '@renderer/lib/motion/flip'
import { reducedMotion, SPRING_SNAPPY, SpringAnimation } from '@renderer/lib/motion/spring'

/**
 * A suggestion row's way out of the phone card (OMN-17, v2 §11.4): the row departs in place –
 * `scale(1 − .1 · t)`, opacity `1 − t` on the exit spring, as the overview's `Departures` – while
 * the rows past it glide into its gap on the same frame. The list is laid out once, at the
 * start: the row (and its heading, when it was its group's last) leaves the flow as a ghost drawn
 * where it stood, the rows below take their final slots, and the glide is the FLIP of that one
 * re-layout – transform and opacity per frame, no layout (the perf program's rule). At rest the
 * ghosts are spliced out of the list, which changes nothing on screen.
 */

/** Travel (px) of the exit spring: its progress is 1 − position / this. */
export const EXIT_TRAVEL = 120
/** How far the row shrinks on its way out. */
export const EXIT_SCALE = 0.1
/** `--zen-ease`, for the Web Animations API (which cannot read a custom property). */
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

/** Where a ghost stands: offsets from the list's padding edge, as `position: absolute` draws it. */
export interface GhostBox {
  top: number
  left: number
  width: number
  height: number
}

/** A row on its way out, and the heading that goes with it. */
export interface RowExit {
  /** The leaving row's id. */
  id: string
  /** Its group's label when the heading leaves too (the row was the group's last); null otherwise. */
  heading: string | null
  /** The ghosts' boxes by element key: the row's id, `group-<label>` for the heading. */
  ghosts: Record<string, GhostBox>
}

/** The element key a group's heading is drawn under (and keyed by in the list). */
export const headingKey = (group: string): string => `group-${group}`

/** The heading leaves with the row when no other row shares its group. */
export function headingLeavesWith(rows: readonly Suggestion[], row: Suggestion): boolean {
  return Boolean(row.group) && !rows.some((r) => r.id !== row.id && r.group === row.group)
}

/** The rows that stay once `exit`'s has gone (all of them when nothing is leaving). */
export function withoutExit(rows: readonly Suggestion[], exit: RowExit | null): Suggestion[] {
  return exit ? rows.filter((row) => row.id !== exit.id) : [...rows]
}

/** The box a list item occupies, read before it leaves the flow. */
export function ghostBox(el: HTMLElement): GhostBox {
  return { top: el.offsetTop, left: el.offsetLeft, width: el.offsetWidth, height: el.offsetHeight }
}

/** Each list item's offset from the list's top edge. */
export function listOffsets(list: HTMLElement): Map<HTMLElement, number> {
  const offsets = new Map<HTMLElement, number>()
  for (const el of list.children) if (el instanceof HTMLElement) offsets.set(el, el.offsetTop)
  return offsets
}

/**
 * The FLIP deltas: how far each item that stayed in the flow has moved, from where it stood
 * (`before`) to where it stands now – the distance it glides back over. Items that did not move
 * (those before the gap, the ghosts) are left out.
 */
export function moverDeltas(
  before: Map<HTMLElement, number>,
  list: HTMLElement,
  ghosts: ReadonlySet<HTMLElement>
): Map<HTMLElement, number> {
  const movers = new Map<HTMLElement, number>()
  for (const el of list.children) {
    if (!(el instanceof HTMLElement) || ghosts.has(el)) continue
    const was = before.get(el)
    if (was === undefined) continue
    const delta = was - el.offsetTop
    if (Math.abs(delta) >= 0.5) movers.set(el, delta)
  }
  return movers
}

/**
 * Run the exit: the ghosts fade (the row shrinking) as the movers glide from `delta` to 0, on
 * one spring; `onDone` at rest. The first frame is painted at once, so the movers stand where
 * they were when the browser next paints. Under reduced motion the ghosts fade in place over
 * 120 ms and the movers cut to their slots (v2 §11.3). Returns the way to stop it.
 */
export function runRowExit(
  ghosts: { row: HTMLElement | null; heading: HTMLElement | null },
  movers: ReadonlyMap<HTMLElement, number>,
  onDone: () => void
): () => void {
  const fading = [ghosts.row, ghosts.heading].filter((el): el is HTMLElement => el !== null)
  if (reducedMotion()) {
    const fades = fading.map(
      (el) =>
        el.animate?.([{ opacity: 1 }, { opacity: 0 }], {
          duration: REDUCED_FADE_MS,
          easing: EASE,
          fill: 'forwards'
        }) ?? null
    )
    const timer = setTimeout(onDone, REDUCED_FADE_MS)
    return () => {
      clearTimeout(timer)
      for (const fade of fades) fade?.cancel()
    }
  }
  const paint = (t: number): void => {
    const opacity = String(Math.max(0, Math.min(1, 1 - t)))
    for (const el of fading) el.style.opacity = opacity
    if (ghosts.row) ghosts.row.style.transform = `scale(${(1 - EXIT_SCALE * t).toFixed(4)})`
    for (const [el, delta] of movers)
      el.style.transform = `translate3d(0, ${(delta * (1 - t)).toFixed(2)}px, 0)`
  }
  paint(0)
  const spring = new SpringAnimation(
    SPRING_SNAPPY,
    (x) => paint(1 - x / EXIT_TRAVEL),
    () => {
      for (const el of movers.keys()) el.style.transform = ''
      onDone()
    }
  )
  spring.start(EXIT_TRAVEL, 0, 0)
  return () => spring.stop()
}
