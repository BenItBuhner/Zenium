/**
 * The recede under a sheet, as chassis behaviour (design language v2 draft §11.1, §11.2, §9.24).
 *
 * A phone sheet coming up pushes the page back: the content frame scales to .97 and its corner
 * grows by 6 px, the bottom bar fades, all from the sheet's own progress – the same 0…1 that
 * moves the sheet and fades its scrim – written once per frame into `--zen-recede` (main.css
 * reads it). Interruptible and reversible: the value is whatever the sheet's spring or the
 * finger says, and the frame comes back along the path it went.
 *
 * Where the value goes. The root carries it as the one number anything may read
 * (`getComputedStyle(document.documentElement)`, the drivers, the tests), registered
 * non-inheriting in main.css (`@property --zen-recede`) so the write costs the root's own style
 * and nothing under it: as an inherited custom property changing on the root every frame it had
 * the whole chrome document recalculated every frame – 5 ms of `Document::recalcStyle` per frame
 * of the menu's open and 9 to 11 ms of its close on the emulator, 1 ms with that write muted
 * (PERF-2's profile, PR #269). The surfaces that move on it – the content frame, the load bar
 * and message layers on its edges, the bottom bar, a passwords page – take the same value on
 * their own inline style instead: a component registers its element (`registerRecedeSurface`,
 * `useRecedeSurface`), and anything carrying `data-recede-surface` (a driver's swatch) is found
 * when a sheet registers. Reading `var(--zen-recede)` anywhere else yields the property's
 * initial 0.
 *
 * Every sheet registers a layer here for as long as it is mounted and reports its presence per
 * frame; the registry composes the stack:
 *
 *  - The page recedes by the stack's summed presence, capped at 1: one sheet recedes it by its
 *    own progress, a second sheet does not push the page further (§11.2), and as one sheet
 *    leaves while the next arrives (a menu's row opening a picker, a menu popping over an open
 *    one) the page holds receded for as long as the two together stand at a sheet's worth –
 *    the same rule the scrim's compound dim keeps, below, so the page and its dim never part.
 *  - A lower sheet recedes exactly as the page does, by the summed presence of the sheets above
 *    it (`recede`, about its bottom centre – main.css), its content inert from the moment a
 *    sheet above it shows anything of itself (q > 0, §11.2; a sheet registered above but still
 *    held for the page's cover leaves it live), and its own scrim hands over to the upper one's
 *    as that comes in, so the stack has one scrim and the page never darkens past the token
 *    (§9.24). The handover is exact, not linear: two scrims one over the other multiply, so a
 *    lower share of `1 − q` under an upper of `q` would let the page breathe lighter half-way
 *    (by a quarter of the token's alpha squared) as a sheet stacks, or as one sheet leaves
 *    while the next arrives.
 *    Given the token's alpha `a` (`--zen-scrim-alpha`, read from the root when a layer
 *    registers), the lower share is what keeps the compound dim at the token times the stack's
 *    summed presence, capped at one: `(min(1, dim + p) − dim) / (1 − a · dim)` for a layer of
 *    presence `p` under sheets that dim to `dim` already. With no alpha to go by it is the plain
 *    difference, which is the linear rule for a lower sheet at its detent.
 *
 * A layer is released when its sheet has landed, never when its request goes: the sheet stays
 * mounted for its leave (`SheetPresence`, lib/motion/presence.tsx, and the frame dialog host's
 * slot on the phone) and runs its own p 1 → 0 here, so a lower sheet closed by the host under
 * an upper at rest runs its way down while the upper's q, and with it the page's recede and
 * the compound dim, hold (§11.2); the shorter stack is composed only once it has landed.
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
  /** How far this sheet itself recedes (0…1): the summed presence of the sheets above it, capped. */
  recede: number
  /** The share of this sheet's own scrim to show: its presence, fading as a sheet above comes in. */
  scrim: number
  /** A sheet above shows something of itself (its presence > 0): the content takes no input. */
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
  /**
   * The summed presence of the sheets above the layer at hand, capped: what they recede it by,
   * and what their scrims compound to as a share of the token (one and the same number, so the
   * page's recede and its dim hold together as one sheet leaves while the next arrives).
   */
  let above = 0
  for (let i = presences.length - 1; i >= 0; i--) {
    const p = clamp01(presences[i])
    const total = Math.min(1, above + p)
    // (1 − a·s)(1 − a·above) = 1 − a·total: this layer's share s takes the compound dim to `total`.
    const scrim = a * above < 1 ? (total - above) / (1 - a * above) : 0
    layers[i] = { recede: above, scrim, inert: above > 0 }
    above = total
  }
  return { page: above, layers }
}

/** The scale a recede of `p` puts a surface at. */
export function recedeScale(p: number): number {
  return 1 - RECEDE_SCALE * clamp01(p)
}

/**
 * The CSS opacity of chrome that fades with the recede – the phone bar docked at the bottom
 * edge, where the sheet arrives (§11.1: `1 − p`, gone at the first detent) – times `share`, a
 * fade of the element's own (the bar's while its pill is carried to the other edge). Reads the
 * root's `--zen-recede` live, the same value main.css scales the page by, so the fade is the
 * sheet's progress frame for frame and reverses with it; `--zen-recede-gain` is 0 under reduced
 * motion (§11.3). A component that writes the bar's opacity inline writes this, never a number
 * of its own: a plain `opacity: 1` would beat the stylesheet's rule and hold the bar at full
 * while the page stands receded.
 */
export function recedeFade(share = 1): string {
  return `calc((1 - var(--zen-recede, 0) * var(--zen-recede-gain, 1)) * ${clamp01(share).toFixed(4)})`
}

/**
 * The inline opacity of the phone bar docked at `edge` while a fade of its own runs (`share`,
 * the pill carry): at the bottom edge composed with the recede (`recedeFade`), so a sheet
 * coming up mid-carry fades the bar all the same; at the top edge the share alone – a
 * top-docked bar is not in the sheet's path and does not fade with it, it stands inert under
 * the scrim, dimmed like the page (§11.1, ruled 23:50). At rest nothing is written: main.css
 * fades the bottom-docked bar by the root value and leaves the top-docked one at 1.
 */
export function barFade(edge: 'top' | 'bottom', share: number): string {
  return edge === 'bottom' ? recedeFade(share) : clamp01(share).toFixed(4)
}

export interface RecedeHandle {
  /** The sheet's presence this frame: 0 away … 1 at its first detent. */
  progress(presence: number): void
  /** No sheet registered above this one: it holds the focus and answers the keyboard (§9.24). */
  onTop(): boolean
  /**
   * The sheet is gone (unmounting, once its leave has landed – never at the store write that
   * cleared its request): take the layer off the stack.
   */
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

/** The surfaces registered by their components (`registerRecedeSurface`). */
const surfaces = new Set<HTMLElement>()
/** The `[data-recede-surface]` elements found when a sheet last registered. */
let tagged: HTMLElement[] = []

/** The page's recede as the root carries it, or null with no sheet on the stack. */
function pageValue(): string | null {
  return stack.length > 0 ? recedeFrame(stack.map((e) => e.presence)).page.toFixed(4) : null
}

function writeSurface(el: HTMLElement, value: string | null): void {
  if (value === null) el.style.removeProperty('--zen-recede')
  else el.style.setProperty('--zen-recede', value)
}

/** Look for the tagged surfaces: once per sheet registering, never per frame (a tree walk). */
function findTagged(): void {
  tagged =
    typeof document === 'undefined'
      ? []
      : Array.from(document.querySelectorAll<HTMLElement>('[data-recede-surface]'))
}

function publish(): void {
  const entries = stack.slice()
  const frame = recedeFrame(
    entries.map((e) => e.presence),
    scrimAlpha
  )
  const value = stack.length > 0 ? frame.page.toFixed(4) : null
  const el = root()
  if (el) {
    // The attribute only when it changes: setting it to what it is already is still an attribute
    // change to the style invalidator and the accessibility tree, every frame.
    if (value !== null) {
      if (el.getAttribute('data-receding') !== 'true') el.setAttribute('data-receding', 'true')
      el.style.setProperty('--zen-recede', value)
    } else {
      if (el.hasAttribute('data-receding')) el.removeAttribute('data-receding')
      el.style.removeProperty('--zen-recede')
    }
  }
  for (const surface of surfaces) writeSurface(surface, value)
  for (const surface of tagged) if (!surfaces.has(surface)) writeSurface(surface, value)
  if (value === null) tagged = []
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
  findTagged()
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

/**
 * A surface that moves on the page's recede – main.css reads `--zen-recede` on it – takes the
 * value on its own inline style from now until the returned release runs (its unmount): the
 * current value at once, then every frame a sheet moves. Nothing is written to an element that
 * is not registered (see the header: the root's value does not inherit).
 */
export function registerRecedeSurface(el: HTMLElement): () => void {
  surfaces.add(el)
  writeSurface(el, pageValue())
  return () => {
    if (surfaces.delete(el)) writeSurface(el, null)
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
