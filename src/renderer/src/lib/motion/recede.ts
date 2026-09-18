/**
 * The recede under a sheet, as chassis behaviour (design language v2 draft §11.1, §11.2, §9.24).
 *
 * A phone sheet coming up pushes the page back: the content frame scales to .97 and its corner
 * grows by 6 px, the bottom bar fades, all from the sheet's own progress – the same 0…1 that
 * moves the sheet and fades its scrim – written once per frame into `--zen-recede` on the root
 * (main.css reads it). Interruptible and reversible: the value is whatever the sheet's spring or
 * the finger says, and the frame comes back along the path it went.
 *
 * Every sheet registers a layer here for as long as it is mounted and reports its presence per
 * frame; the registry composes the stack:
 *
 *  - The page recedes by the presence of the sheet that is most present, clamped at 1: a
 *    second sheet does not push the page further (§11.2).
 *  - A lower sheet recedes exactly as the page does, by the presence of the sheets above it
 *    (`recede`, about its bottom centre – main.css), its content inert from the moment a sheet
 *    is registered above it, and its own scrim hands over to the upper one's as that comes in,
 *    so the stack has one scrim and the page never darkens past the token (§9.24). The handover
 *    is exact, not linear: two scrims one over the other multiply, so a lower share of `1 − q`
 *    under an upper of `q` would let the page breathe lighter half-way (by a quarter of the
 *    token's alpha squared) as a sheet stacks, or as one sheet leaves while the next arrives.
 *    Given the token's alpha `a` (`--zen-scrim-alpha`, read from the root when a layer
 *    registers), the lower share is what keeps the compound dim at the token times the stack's
 *    summed presence, capped at one: `(min(1, dim + p) − dim) / (1 − a · dim)` for a layer of
 *    presence `p` under sheets that dim to `dim` already. With no alpha to go by it is the plain
 *    difference, which is the linear rule for a lower sheet at its detent.
 *
 * The root carries `data-receding` while any layer is registered (the frame is promoted only
 * then). Under `prefers-reduced-motion` main.css zeroes `--zen-recede-gain`: the value is still
 * written, the frame does not move (§11.3).
 */

/** Scale the page and a lower sheet give up at full recede: `scale(1 − RECEDE_SCALE · p)`. */
export const RECEDE_SCALE = 0.03
/** Corner radius (px) the page and a lower sheet gain at full recede. */
export const RECEDE_RADIUS_PX = 6

export interface RecedeLayerFrame {
  /** How far this sheet itself recedes (0…1): the presence of the sheets above it. */
  recede: number
  /** The share of this sheet's own scrim to show: its presence, fading as a sheet above comes in. */
  scrim: number
  /** A sheet stands above: the content takes no input. */
  inert: boolean
}

export interface RecedeFrame {
  /** The page's recede (0…1). */
  page: number
  /** One per registered sheet, bottom first. */
  layers: RecedeLayerFrame[]
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

/**
 * The recede of the page and of each sheet in a stack whose sheets stand at `presences`
 * (bottom first; 0 = away, 1 = at its first detent, larger values are clamped: a sheet expanded
 * to a taller detent pushes nothing further). `scrimAlpha` is the scrim token's alpha, for the
 * exact handover of the scrim between stacked sheets (see the header); 0 for the linear one.
 */
export function recedeFrame(presences: readonly number[], scrimAlpha = 0): RecedeFrame {
  const layers: RecedeLayerFrame[] = new Array(presences.length)
  const a = clamp01(scrimAlpha)
  let above = 0
  /** What the scrims above compound to, as a share of the token: the summed presence, capped. */
  let dim = 0
  for (let i = presences.length - 1; i >= 0; i--) {
    const p = clamp01(presences[i])
    const total = Math.min(1, dim + p)
    // (1 − a·s)(1 − a·dim) = 1 − a·total: this layer's share s takes the compound dim to `total`.
    const scrim = a * dim < 1 ? (total - dim) / (1 - a * dim) : 0
    layers[i] = { recede: above, scrim, inert: i < presences.length - 1 }
    above = Math.max(above, p)
    dim = total
  }
  return { page: above, layers }
}

/** The scale a recede of `p` puts a surface at. */
export function recedeScale(p: number): number {
  return 1 - RECEDE_SCALE * clamp01(p)
}

export interface RecedeHandle {
  /** The sheet's presence this frame: 0 away … 1 at its first detent. */
  progress(presence: number): void
  /** No sheet registered above this one: it holds the focus and answers the keyboard (§9.24). */
  onTop(): boolean
  /** The sheet is gone (unmounting): take the layer off the stack. */
  release(): void
}

interface Entry {
  presence: number
  onFrame: ((frame: RecedeLayerFrame) => void) | undefined
  /** The last frame this layer was told of, so it hears only of changes to its own. */
  last: RecedeLayerFrame | null
}

const stack: Entry[] = []

/** The scrim token's alpha, as the root's `--zen-scrim-alpha` said when a layer last registered. */
let scrimAlpha = 0

/** What the registry writes to: the document root, or nothing outside a document (tests, SSR). */
function root(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement
}

/**
 * Read the scrim token's alpha off the root: once per registering, not per frame (a computed
 * style is a style flush), and the theme does not change under an open sheet often enough to
 * matter. 0 – the linear handover – where the token is missing or unreadable.
 */
function readScrimAlpha(): number {
  const el = root()
  if (!el || typeof getComputedStyle !== 'function') return 0
  const raw = Number.parseFloat(getComputedStyle(el).getPropertyValue('--zen-scrim-alpha'))
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0
}

function sameFrame(a: RecedeLayerFrame | null, b: RecedeLayerFrame): boolean {
  return a !== null && a.recede === b.recede && a.scrim === b.scrim && a.inert === b.inert
}

function publish(): void {
  const entries = stack.slice()
  const frame = recedeFrame(
    entries.map((e) => e.presence),
    scrimAlpha
  )
  const el = root()
  if (el) {
    if (stack.length > 0) {
      el.dataset.receding = 'true'
      el.style.setProperty('--zen-recede', frame.page.toFixed(4))
    } else {
      delete el.dataset.receding
      el.style.removeProperty('--zen-recede')
    }
  }
  // Told in stack order, each only of a change to its own frame: a sheet's presence moves its
  // own scrim share and the recede of the sheets under it, never a sheet above it.
  entries.forEach((entry, i) => {
    const next = frame.layers[i]
    if (sameFrame(entry.last, next)) return
    entry.last = next
    entry.onFrame?.(next)
  })
}

/**
 * Put a sheet on the stack, above every sheet registered before it. Call `progress` from the
 * sheet's frame callback and `release` when the sheet unmounts; `onFrame` receives the sheet's
 * own recede, scrim share and inertness whenever they change (at once on registering).
 */
export function registerRecedeLayer(onFrame?: (frame: RecedeLayerFrame) => void): RecedeHandle {
  const entry: Entry = { presence: 0, onFrame, last: null }
  scrimAlpha = readScrimAlpha()
  stack.push(entry)
  publish()
  let released = false
  return {
    progress(presence) {
      if (released) return
      const next = clamp01(presence)
      if (next === entry.presence) return
      entry.presence = next
      publish()
    },
    onTop() {
      return !released && stack.at(-1) === entry
    },
    release() {
      if (released) return
      released = true
      const index = stack.indexOf(entry)
      if (index >= 0) stack.splice(index, 1)
      publish()
    }
  }
}

/** Sheets on the stack right now (the page recedes while it is not empty). */
export function recedeDepth(): number {
  return stack.length
}

/** The page's recede right now: what `--zen-recede` says. */
export function pageRecede(): number {
  return recedeFrame(stack.map((e) => e.presence)).page
}
