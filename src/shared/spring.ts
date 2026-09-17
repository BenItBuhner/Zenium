/**
 * The damped spring every gesture surface runs on (design language §7). Positions are in px,
 * velocities in px/s, time in seconds. The step is the closed-form solution of the oscillator,
 * so it is exact for any frame length and stays stable when the browser stalls; the state is
 * just `{ x, v }`, which is what lets a finger "catch" a spring mid-flight and carry on from the
 * very same motion. Pure maths: the chrome's `SpringAnimation` and the new tab page's drag both
 * build on it.
 */
export interface SpringConfig {
  stiffness: number
  damping: number
  mass: number
  /** Displacement (px) and speed (px/s) under which the spring counts as at rest. */
  restDelta: number
  restSpeed: number
}

export interface SpringState {
  x: number
  v: number
}

/** Tab switching: fast, ends without visible overshoot (ζ ≈ 0.98). */
export const SPRING_SNAPPY: SpringConfig = {
  stiffness: 420,
  damping: 40,
  mass: 1,
  restDelta: 0.4,
  restSpeed: 8
}

/** Overview open/close: a touch softer, a hair of overshoot (ζ ≈ 0.9). */
export const SPRING_GENTLE: SpringConfig = {
  stiffness: 300,
  damping: 31,
  mass: 1,
  restDelta: 0.4,
  restSpeed: 8
}

/** Advance the spring towards `target` by `dt` seconds. */
export function stepSpring(
  state: SpringState,
  target: number,
  dt: number,
  config: SpringConfig
): SpringState {
  const { stiffness: k, damping: c, mass: m } = config
  const x0 = state.x - target
  const v0 = state.v
  const w0 = Math.sqrt(k / m)
  const zeta = c / (2 * Math.sqrt(k * m))
  let x: number
  let v: number
  if (Math.abs(zeta - 1) < 1e-4) {
    // Critically damped: x = e^{-w0 t} (A + B t)
    const a = x0
    const b = v0 + w0 * x0
    const decay = Math.exp(-w0 * dt)
    x = decay * (a + b * dt)
    v = decay * (b - w0 * (a + b * dt))
  } else if (zeta < 1) {
    // Underdamped: x = e^{-ζ w0 t} (A cos wd t + B sin wd t)
    const wd = w0 * Math.sqrt(1 - zeta * zeta)
    const a = x0
    const b = (v0 + zeta * w0 * x0) / wd
    const decay = Math.exp(-zeta * w0 * dt)
    const cos = Math.cos(wd * dt)
    const sin = Math.sin(wd * dt)
    x = decay * (a * cos + b * sin)
    v = decay * ((b * wd - zeta * w0 * a) * cos - (a * wd + zeta * w0 * b) * sin)
  } else {
    // Overdamped: x = C1 e^{r1 t} + C2 e^{r2 t}
    const root = w0 * Math.sqrt(zeta * zeta - 1)
    const r1 = -zeta * w0 + root
    const r2 = -zeta * w0 - root
    const c2 = (v0 - r1 * x0) / (r2 - r1)
    const c1 = x0 - c2
    const e1 = Math.exp(r1 * dt)
    const e2 = Math.exp(r2 * dt)
    x = c1 * e1 + c2 * e2
    v = c1 * r1 * e1 + c2 * r2 * e2
  }
  if (Math.abs(x) < config.restDelta && Math.abs(v) < config.restSpeed) return { x: target, v: 0 }
  return { x: x + target, v }
}

export function isAtRest(state: SpringState, target: number): boolean {
  return state.x === target && state.v === 0
}
