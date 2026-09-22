import { barHideStore, resetBarHide } from './barHide'
import { cssPx, phoneBandHeight } from './gestures/dock'
import { SPRING_SNAPPY, SpringAnimation } from './motion/spring'
import { createStore } from './store'

/**
 * The phone bar's way off and back around a page's fullscreen (MOT-32; design language v2
 * draft §11 and §11.5). The chrome stays mounted through the fullscreen, its state with it:
 * the bar – the row of controls with the pill, and the group strip inside it – translates off
 * its edge as the system bars slide away, on one spring (`SPRING_SNAPPY`, the bar hide's), and
 * back on the same spring as the chrome returns, in step with its 120 ms return fade
 * (`useFullscreenReturn`). The value is `--zen-fullscreen-hide`, 0 in place … 1 off, written
 * per frame on the bound elements alone (`bindFullscreenHide`: the bar element), where the
 * stylesheet registers it as a property of that one element (`inherits: false`) and adds its
 * travel to the bar's transform – the performance program's rule: a frame's write recalculates
 * the bar's own style and moves its promoted layer, nothing is laid out or painted. The host
 * runs the same spring on the fullscreen layer's clip (`Host.enterFullscreen`), from the page's
 * card out to the screen's edges, so the page is seen to grow over the frame the bar leaves; it
 * starts on this spring's word (`FullscreenHideHost.hiding`), so the two set out together.
 *
 * The bar that had hidden on scroll keeps its place at the enter: the hide is reset without
 * motion the frame the fullscreen begins (its gate closes anyway) and this spring sets out from
 * the same offset, so the bar continues off its edge rather than snapping home first.
 *
 * Under reduced motion the spring snaps (`SpringAnimation`, §11.3: no transition); the return's
 * 120 ms fade is the one motion left, as §11.3 keeps it.
 */

export type FullscreenHidePhase = 'shown' | 'hiding' | 'hidden' | 'showing'

export interface FullscreenHideState {
  /** 0 in place … 1 off its edge, per frame. */
  progress: number
  phase: FullscreenHidePhase
}

export const fullscreenHideStore = createStore<FullscreenHideState>(
  { progress: 0, phase: 'shown' },
  'fullscreen-hide'
)

/** The host's side of the enter (Android: `boot.ts` binds it; the tests their own). */
export interface FullscreenHideHost {
  /** The bar sets out: the host starts its reveal of the fullscreen layer on the same spring. */
  hiding(): void
}

let host: FullscreenHideHost | null = null

export function setFullscreenHideHost(next: FullscreenHideHost | null): void {
  host = next
}

/**
 * The elements that carry `--zen-fullscreen-hide` (the bar). Bound from mount to unmount, as the
 * bar hide's are; the property is theirs alone (main.css `@property … inherits: false`).
 */
const bound = new Set<HTMLElement>()

function writeProgress(el: HTMLElement, progress: number): void {
  if (progress > 0) el.style.setProperty('--zen-fullscreen-hide', progress.toFixed(4))
  else el.style.removeProperty('--zen-fullscreen-hide')
}

/** Register an element that moves with the bar around a fullscreen; returns the unbind. */
export function bindFullscreenHide(el: HTMLElement): () => void {
  bound.add(el)
  writeProgress(el, progress)
  return () => {
    bound.delete(el)
    el.style.removeProperty('--zen-fullscreen-hide')
  }
}

/**
 * How far the bar goes (CSS px): the whole bar band – the row and the group strip – so the bar,
 * whose inset padding hangs past the clip line already, is cut wholly at that line; and the
 * content gutter more, for the spring's overshoot. One number with the stylesheet's
 * `--zen-fullscreen-hide-travel` (main.css), read off the same root properties.
 */
export function fullscreenHideTravel(): number {
  return phoneBandHeight() + cssPx('--zen-padding', 8)
}

/**
 * Where this spring sets out from when the bar had hidden on scroll: the bar hide's offset,
 * `progress` of its `travel`, as a share of this travel – the same place on screen.
 */
export function carriedProgress(
  barHideProgress: number,
  barHideTravel: number,
  travel: number
): number {
  if (!(travel > 0)) return 0
  return Math.min(1, Math.max(0, (barHideProgress * barHideTravel) / travel))
}

let phase: FullscreenHidePhase = 'shown'
let progress = 0
/** The travel the running spring was started for (CSS px; the spring runs in px, its rest thresholds are px). */
let travel = 1

function publish(offsetPx: number): void {
  const next = travel > 0 ? Math.min(1, Math.max(0, offsetPx / travel)) : 0
  if (next === progress) return
  progress = next
  for (const el of bound) writeProgress(el, next)
  fullscreenHideStore.set({ progress: next })
}

function setPhase(next: FullscreenHidePhase): void {
  if (phase === next) return
  phase = next
  fullscreenHideStore.set({ phase: next })
}

const spring = new SpringAnimation(
  SPRING_SNAPPY,
  (x) => publish(x),
  (x) => {
    publish(x)
    setPhase(progress >= 1 ? 'hidden' : 'shown')
  }
)

/** A page went fullscreen: the bar leaves. A bar hidden on scroll sets out from where it is. */
export function hideForFullscreen(): void {
  if (phase === 'hiding' || phase === 'hidden') return
  spring.stop()
  travel = Math.max(1, fullscreenHideTravel())
  const hide = barHideStore.get()
  const from = Math.max(progress, carriedProgress(hide.progress, hide.travel, travel))
  // The hide's motion is over the moment the fullscreen begins (its gate closes with the
  // shell's context; this is the frame before, without the spring the gate would run).
  if (hide.progress > 0 || hide.phase !== 'rest') resetBarHide()
  setPhase('hiding')
  publish(from * travel)
  host?.hiding()
  spring.start(from * travel, 0, travel)
}

/** The chrome is back from the fullscreen and its return begins: the bar comes back. */
export function showAfterFullscreen(): void {
  if (phase === 'showing' || phase === 'shown') return
  spring.stop()
  setPhase('showing')
  spring.start(progress * travel, 0, 0)
}

/** The bar off or home at once, without motion (a shell that finds it where another left it). */
export function snapFullscreenHide(hidden: boolean): void {
  spring.stop()
  publish(hidden ? travel : 0)
  setPhase(hidden ? 'hidden' : 'shown')
}

/** Where the bar stands, for the tests. */
export function fullscreenHideProgress(): number {
  return progress
}
