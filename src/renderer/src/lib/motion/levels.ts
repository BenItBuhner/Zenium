import { SPRING_GENTLE, SpringAnimation } from './spring'

export type LevelPhase = 'rest' | 'moving' | 'back'

export interface LevelState {
  /** Level ids from the root to the current one; never empty. */
  stack: string[]
  /** The level being left and the one arriving. Equal at rest. */
  from: string
  to: string
  /** 0 = wholly `from`, 1 = wholly `to`. 1 at rest. */
  t: number
  phase: LevelPhase
}

/** How far a level slides away at full system-back progress before the gesture commits. */
export const LEVEL_BACK_PEEK = 0.35

/** The spring runs in px so its rest thresholds keep their meaning; a level is this long. */
const TRACK = 1000

/**
 * A stack of levels inside one surface (a sheet or panel) that push in and pop back on a
 * spring: `push` slides the next level in over the current one, `pop` returns, and the system
 * back gesture drives the same motion through `backProgress` / `backCommit` / `backCancel`, so a
 * predictive back peeks the level away before it goes. Interruptible: a pop during a push starts
 * from wherever the push was.
 */
export class LevelMotion {
  private state: LevelState
  private readonly spring: SpringAnimation

  constructor(
    root: string,
    private readonly onChange: (state: LevelState) => void
  ) {
    this.state = { stack: [root], from: root, to: root, t: 1, phase: 'rest' }
    this.spring = new SpringAnimation(
      SPRING_GENTLE,
      (x) => this.frame(x / TRACK),
      (x) => this.rest(x / TRACK)
    )
  }

  get current(): LevelState {
    return this.state
  }

  /** Levels above the root, counting one that is on its way in and one on its way out. */
  get depth(): number {
    return this.state.stack.length - 1
  }

  /** The level the stack rests on (or is heading to, during a push). */
  get level(): string {
    return this.state.stack[this.state.stack.length - 1]
  }

  /** Is `to` deeper in the stack than `from` – a push rather than a pop? */
  get pushing(): boolean {
    return this.state.stack.indexOf(this.state.to) > this.state.stack.indexOf(this.state.from)
  }

  push(id: string): void {
    if (this.level === id) return
    // A pop in flight has not popped yet: its level is still the one we leave from.
    const from = this.state.from === this.state.to ? this.level : this.state.to
    const stack = this.state.stack.slice(0, this.state.stack.indexOf(from) + 1)
    this.spring.stop()
    this.set({ stack: [...stack, id], from, to: id, t: 0, phase: 'moving' })
    this.spring.start(0, 0, TRACK)
  }

  /** Return to the level below; false at the root. */
  pop(): boolean {
    const { stack, from, to, phase } = this.state
    if (stack.length < 2) return false
    if (phase !== 'rest' && stack.indexOf(to) < stack.indexOf(from)) {
      // Already on the way down (a back preview, or a pop): carry on from here.
      const { x, v } = this.spring.stop()
      this.set({ ...this.state, phase: 'moving' })
      this.spring.start(x, v, TRACK)
      return true
    }
    const current = phase === 'rest' ? this.level : to
    const parent = stack[stack.indexOf(current) - 1]
    // Leaving a push mid-flight: the incoming level is at `t`; reversed, that is `1 - t` gone.
    const start = phase === 'rest' ? 0 : 1 - this.state.t
    this.spring.stop()
    this.set({ stack, from: current, to: parent, t: start, phase: 'moving' })
    this.spring.start(start * TRACK, 0, TRACK)
    return true
  }

  /** System back gesture in flight: `p` is its 0…1 progress. No-op at the root. */
  backProgress(p: number): void {
    if (this.depth === 0) return
    if (this.state.phase === 'moving') this.spring.stop()
    const current = this.state.phase === 'back' ? this.state.from : this.level
    const parent = this.state.stack[this.state.stack.indexOf(current) - 1]
    const t = Math.min(1, Math.max(0, p)) * LEVEL_BACK_PEEK
    this.set({ ...this.state, from: current, to: parent, t, phase: 'back' })
  }

  /** The back gesture completed: finish the pop from where the peek left it. */
  backCommit(): void {
    if (this.state.phase !== 'back') return
    this.set({ ...this.state, phase: 'moving' })
    this.spring.start(this.state.t * TRACK, 0, TRACK)
  }

  /** The back gesture was abandoned: the level springs back into place. */
  backCancel(): void {
    if (this.state.phase !== 'back') return
    this.set({ ...this.state, phase: 'moving' })
    this.spring.start(this.state.t * TRACK, 0, 0)
  }

  /** Stop whatever is moving (the surface is going away). */
  dispose(): void {
    this.spring.stop()
  }

  private frame(t: number): void {
    if (this.state.phase !== 'moving') return
    this.set({ ...this.state, t })
  }

  private rest(t: number): void {
    if (this.state.phase !== 'moving') return
    const { stack, from, to } = this.state
    if (t <= 0.001) {
      // Went back to where it came from: a cancelled back, or a pop reversed by a push.
      this.set({ stack, from, to: from, t: 1, phase: 'rest' })
      return
    }
    const popped = stack.indexOf(to) < stack.indexOf(from)
    this.set({
      stack: popped ? stack.slice(0, stack.indexOf(to) + 1) : stack,
      from: to,
      to,
      t: 1,
      phase: 'rest'
    })
  }

  private set(state: LevelState): void {
    this.state = state
    this.onChange(state)
  }
}

/** How far the pane under the one on top shifts, as a share of the track's width. */
const LEVEL_UNDER_SHIFT = 0.3
/** How far the pane under the one on top dims once it is wholly covered. */
const LEVEL_UNDER_DIM = 0.5

/**
 * Paints one frame of a `LevelMotion` onto its panes (one element per level id). The pane
 * arriving stays in flow and sizes the track; the pane leaving is laid over it (`data-leaving`)
 * and slides out. The deeper of the two is the pane on top: it travels the full width from the
 * trailing edge and stays opaque, so whatever it holds is on screen from its first frame; the
 * pane under it shifts by a third and dims while it is being covered, never to nothing – a pop
 * reveals it with its content, not a blank. Panes taking no part are hidden and inert, and a
 * pane that is mostly gone is `aria-hidden` and inert, so neither the reader nor the keyboard
 * reaches into a level that is not the one shown.
 */
export function paintLevels(
  motion: LevelMotion,
  panes: Map<string, HTMLElement>,
  width: number
): void {
  const { from, to, t } = motion.current
  const moving = from !== to
  for (const [id, el] of panes) {
    const arriving = id === to
    const leaving = id === from && moving
    if (!arriving && !leaving) {
      el.style.display = 'none'
      el.removeAttribute('data-leaving')
      setPaneHidden(el, true)
      continue
    }
    el.style.display = ''
    if (leaving) el.setAttribute('data-leaving', '')
    else el.removeAttribute('data-leaving')
    const shown = arriving ? t : 1 - t
    const deeper = motion.pushing ? arriving : leaving
    const x = !moving
      ? 0
      : deeper
        ? (1 - shown) * width
        : -LEVEL_UNDER_SHIFT * (1 - shown) * width
    el.style.transform = x ? `translate3d(${x.toFixed(2)}px, 0, 0)` : ''
    el.style.opacity =
      !moving || deeper ? '' : (1 - LEVEL_UNDER_DIM * (1 - shown)).toFixed(3)
    el.style.willChange = moving ? 'transform, opacity' : ''
    setPaneHidden(el, shown < 0.5)
  }
}

function setPaneHidden(el: HTMLElement, hidden: boolean): void {
  if (el.getAttribute('aria-hidden') !== String(hidden))
    el.setAttribute('aria-hidden', String(hidden))
  if (el.hasAttribute('inert') !== hidden) el.toggleAttribute('inert', hidden)
}
