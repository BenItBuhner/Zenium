import { SPRING_SNAPPY, SpringAnimation } from './motion/spring'
import { createStore } from './store'

/**
 * The phone chrome around a page's fullscreen (MOT-32; design language v2 §11.5, the bars
 * that slide with the system's). The chrome stays mounted, with its state, for the whole of a
 * fullscreen; what moves is the bar – the row of controls with the pill and, while the active
 * tab is grouped, the group strip inside it – which translates off its edge as the system bars
 * slide away and back onto it as they return, on one spring (`SPRING_SNAPPY`, the bar hide's
 * snap), by `--zen-fullscreen-away`: 0 with the bar in place, 1 with it fully off (its own
 * height, past the inset line its clip box cuts it at). The value is written per frame on the
 * bar element itself (`bindFullscreenAway`), where main.css registers it as a property of that
 * one element (`inherits: false`) and composes it into the bar's transform next to the bar
 * hide's – so a frame's write recalculates the bar's own style and no other (the bar hide
 * profile's H4, PERF-2's H3: a per-frame property on the root recalculated the whole chrome),
 * and the frame's change is the promoted layer's transform alone.
 *
 * The host reveals the fullscreen layer over the chrome at the same pace (`FullscreenReveal.kt`:
 * the layer's clip grows from the page's frame to the window on the same spring), so the page
 * is seen to take the bar's band as the bar leaves it. On the way back the bar's return runs
 * with the chrome's return fade (`useFullscreenReturn`), from the page's landing – not over the
 * bars' settle, whose layouts the fade holds through (#277).
 *
 * Under reduced motion the spring jumps (`SpringAnimation`): the bar is off, or back, at once,
 * and the return keeps §11.3's 120 ms fade (#311's rule).
 */

export type FullscreenAwayPhase = 'home' | 'leaving' | 'away' | 'returning'

export interface FullscreenAwayState {
  /** 0 with the bar in place … 1 with it off its edge, per frame (`--zen-fullscreen-away` on the bound elements). */
  progress: number
  phase: FullscreenAwayPhase
}

export const fullscreenAwayStore = createStore<FullscreenAwayState>(
  { progress: 0, phase: 'home' },
  'fullscreen-away'
)

/**
 * The spring runs over this many px and the progress is its share of them: the spring's rest
 * thresholds are px-sized (`restDelta`, `restSpeed`), and the curve of a linear spring from
 * rest is the same whatever the distance – the host's reveal, in its own device px on the same
 * stiffness and damping, keeps pace with it.
 */
export const FULLSCREEN_AWAY_TRAVEL = 100

const bound = new Set<HTMLElement>()

function writeAway(el: HTMLElement, progress: number): void {
  if (progress > 0) el.style.setProperty('--zen-fullscreen-away', progress.toFixed(4))
  else el.style.removeProperty('--zen-fullscreen-away')
}

/**
 * Register an element that leaves with the bar; it carries the current value at once and every
 * frame after, until the returned unbind. Its rule in main.css reads `--zen-fullscreen-away`
 * off the element itself.
 */
export function bindFullscreenAway(el: HTMLElement): () => void {
  bound.add(el)
  writeAway(el, fullscreenAwayStore.get().progress)
  return () => {
    bound.delete(el)
    el.style.removeProperty('--zen-fullscreen-away')
  }
}

function paint(progress: number): void {
  const next = Math.min(1, Math.max(0, progress))
  for (const el of bound) writeAway(el, next)
  fullscreenAwayStore.set({ progress: next })
}

function rested(progress: number): void {
  paint(progress)
  fullscreenAwayStore.set({ phase: progress >= 1 ? 'away' : 'home' })
}

const spring = new SpringAnimation(
  SPRING_SNAPPY,
  (x) => paint(x / FULLSCREEN_AWAY_TRAVEL),
  (x) => rested(x / FULLSCREEN_AWAY_TRAVEL)
)

/** Head for `to` (0 home, 1 away) from wherever the bar is, keeping the motion it has. */
function head(to: 0 | 1, phase: FullscreenAwayPhase): void {
  const { progress } = fullscreenAwayStore.get()
  const velocity = spring.running ? spring.current.v : 0
  spring.stop()
  fullscreenAwayStore.set({ phase })
  spring.start(progress * FULLSCREEN_AWAY_TRAVEL, velocity, to * FULLSCREEN_AWAY_TRAVEL)
}

/** A page's fullscreen began: the bar slides off its edge as the system bars go. */
export function slideChromeAway(): void {
  const { phase } = fullscreenAwayStore.get()
  if (phase === 'away' || phase === 'leaving') return
  head(1, 'leaving')
}

/** The chrome is back from a page's fullscreen and the page has landed: the bar slides back on. */
export function bringChromeBack(): void {
  const { phase } = fullscreenAwayStore.get()
  if (phase === 'home' || phase === 'returning') return
  head(0, 'returning')
}

/** Put the bar where `away` says at once, without motion (the shell leaving, tests). */
export function settleChromeAway(away: boolean): void {
  spring.stop()
  rested(away ? 1 : 0)
}
