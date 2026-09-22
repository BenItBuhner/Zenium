import { rubberBand, type SwipeThresholds } from '../gestures/swipe'

/**
 * Release thresholds of a sheet (design language v1 §7.6): a fling towards a detent at 600 px/s
 * commits regardless of distance; a slower release commits once the projected position is past
 * half way. Tab swipes keep their own, looser numbers in `gestures/swipe.ts`.
 */
export const SHEET_THRESHOLDS: SwipeThresholds = {
  flingVelocity: 600,
  commitFraction: 0.5,
  projectionSeconds: 0.12
}
import { SPRING_GENTLE, SPRING_SNAPPY, SpringAnimation } from './spring'

export type SheetPhase = 'closed' | 'settling' | 'open' | 'dragging'

export interface SheetState {
  phase: SheetPhase
  /**
   * Where the sheet is on its dismissal track: 0 = resting at its detent, 1 = fully out of view.
   * Negative while the sheet stands taller than its peek – a finger overshooting upwards
   * rubber-bands a little, and a sheet with two detents sits above its peek when expanded.
   */
  progress: number
}

export const SHEET_CLOSED: SheetState = { phase: 'closed', progress: 1 }

/**
 * How far along its track the system back gesture pulls the sheet at full progress: it peeks
 * down to show it is about to go, then commits with the spring (or springs back when cancelled).
 */
export const BACK_PEEK = 0.3

/**
 * Under reduced motion a sheet's appearance or departure is an opacity fade in place of this
 * length, the spring having jumped it there (v2 draft §11.3); main.css transitions the opacity
 * of the sheet chassis' elements for as long.
 */
export const REDUCED_MOTION_FADE_MS = 120

// ---------------------------------------------------------------------------
// Geometry: detents, frames, drags and where a release settles
// ---------------------------------------------------------------------------

/**
 * The heights a sheet rests at. The track is measured in px of visible height: 0 = off the
 * bottom of the screen, `collapsed` = the peek detent, `expanded` = as tall as the content (or
 * the screen) allows. A sheet with one detent has both at the same height.
 */
export interface SheetDetents {
  collapsed: number
  expanded: number
}

export type SheetDetent = 'collapsed' | 'expanded'

/** Share of the layer height the peek detent shows. */
export const SHEET_PEEK_FRACTION = 0.52
/** Room (px) kept between the top inset and an expanded sheet, so the page still shows above it. */
export const SHEET_TOP_MARGIN = 40
/** Detents closer than this (px) fold into one: a second stop a couple of rows away is noise. */
export const SHEET_MIN_DETENT_GAP = 96
/** How far (px) the sheet can be stretched past its expanded detent, with diminishing returns. */
export const SHEET_OVERDRAG = 96

/** The tallest a sheet may be on a layer `layerHeight` px tall under `insetTop` px of status bar. */
export function sheetMaxHeight(layerHeight: number, insetTop: number): number {
  return Math.max(0, Math.round(layerHeight - insetTop - SHEET_TOP_MARGIN))
}

/**
 * Detents for content `intrinsic` px tall (grip, body and bottom inset together). Content that
 * fits within the peek height gets a single detent; a taller sheet peeks at about half the
 * room and expands up to the top margin.
 *
 * Every detent is measured above the bottom inset – the gesture bar, or the keyboard when it is
 * up (`insetBottom` is the larger of the two, as the host reports it): the peek shows
 * `SHEET_PEEK_FRACTION` of the room between the inset and the top of the layer, plus the inset
 * itself, which the sheet pads for underneath. So a keyboard coming up lifts the peek with it
 * instead of eating it, and a sheet with a form keeps the same share of the room above the keys
 * that it had above the bar.
 */
export function computeDetents(
  intrinsic: number,
  layerHeight: number,
  insetTop: number,
  insetBottom = 0
): SheetDetents {
  const expanded = Math.max(
    0,
    Math.min(Math.round(intrinsic), sheetMaxHeight(layerHeight, insetTop))
  )
  const bottom = Math.max(0, Math.min(Math.round(insetBottom), layerHeight))
  const peek = bottom + Math.round((layerHeight - bottom) * SHEET_PEEK_FRACTION)
  const collapsed = expanded - peek >= SHEET_MIN_DETENT_GAP ? peek : expanded
  return { collapsed, expanded }
}

/** Room (px) kept between a focused field's bottom edge and the keyboard's top edge. */
export const SHEET_FIELD_MARGIN = 8

/**
 * How far (px) a field reaches below the room a sheet has above its bottom inset when the
 * sheet stands `detent` px tall: `fieldBottom` is the field's bottom edge measured from the
 * sheet's top edge (content is anchored there, so the number does not depend on where the
 * sheet is on its track). 0 when the field is in view above the keyboard, with the margin.
 */
export function fieldOverflow(fieldBottom: number, detent: number, insetBottom: number): number {
  return Math.max(0, Math.round(fieldBottom - (detent - insetBottom - SHEET_FIELD_MARGIN)))
}

/**
 * The detent a sheet with a focused field should stand at: it expands when the field would sit
 * under the keyboard at the detent it rests at (`resting`) and the sheet has an expanded detent
 * to go to; a sheet that is already as tall as it gets scrolls the field into view instead.
 */
export function detentForField(
  fieldBottom: number,
  detents: SheetDetents,
  insetBottom: number,
  resting: SheetDetent
): SheetDetent {
  if (fieldOverflow(fieldBottom, detents[resting], insetBottom) === 0) return resting
  return detents.expanded > detents[resting] ? 'expanded' : resting
}

export interface SheetFrame {
  /** Height (px) the sheet element is laid out at. */
  height: number
  /** How far (px) the sheet is pushed down off its resting place. */
  translateY: number
  /**
   * 0…1 share of the scrim's full opacity – the sheet's presence `p` (v2 draft §11.1), which is
   * also the page's recede: the sheet's progress from closed to its rest over its own travel,
   * clamped at 1.
   */
  scrim: number
}

/**
 * Geometry for a sheet whose visible height is `position`. Between the detents the sheet
 * changes height – content stays anchored to the top edge and the bottom edge, with its fading
 * scroll edge, stays on screen; below the peek detent the whole sheet slides down instead, and
 * the scrim thins out with it. The scrim's share here is measured over the peek detent; the
 * motion measures it over the sheet's actual travel (`SheetMotion.frame`).
 */
export function sheetFrame(position: number, detents: SheetDetents): SheetFrame {
  const visible = Math.max(0, position)
  const { collapsed } = detents
  if (visible >= collapsed) return { height: visible, translateY: 0, scrim: 1 }
  return {
    height: collapsed,
    translateY: collapsed - visible,
    scrim: collapsed > 0 ? visible / collapsed : 0
  }
}

/**
 * Where a finger that grabbed the sheet at `start` px and has since travelled `delta` px
 * upwards puts it: it cannot be pushed below the screen edge and resists past the expanded
 * detent.
 */
export function sheetDragPosition(start: number, delta: number, detents: SheetDetents): number {
  const raw = start + delta
  if (raw <= 0) return 0
  if (raw > detents.expanded)
    return detents.expanded + rubberBand(raw - detents.expanded, SHEET_OVERDRAG)
  return raw
}

/**
 * Which detent a released sheet settles on: 0 (dismissed), `collapsed` or `expanded`. A fling
 * (px/s, positive = upwards) goes to the next detent in its own direction, so flinging back the
 * way you came cancels a drag. A slow release commits to the neighbouring detent once the
 * velocity-projected position has crossed `commitFraction` of the way there from the detent
 * the drag set out from (`origin`); otherwise it returns.
 */
export function settleDetent(
  position: number,
  velocity: number,
  detents: SheetDetents,
  origin: number = detents.collapsed,
  thresholds: SwipeThresholds = SHEET_THRESHOLDS
): number {
  const stops = [...new Set([0, detents.collapsed, detents.expanded])].sort((a, b) => a - b)
  if (Math.abs(velocity) >= thresholds.flingVelocity) {
    if (velocity > 0) return stops.find((s) => s > position + 1) ?? stops[stops.length - 1]
    return [...stops].reverse().find((s) => s < position - 1) ?? 0
  }
  const projected = position + velocity * thresholds.projectionSeconds
  const nearest = (to: number): number =>
    stops.reduce((a, b) => (Math.abs(b - to) < Math.abs(a - to) ? b : a))
  const from = nearest(origin)
  const towards = projected > from ? stops.filter((s) => s > from) : stops.filter((s) => s < from)
  if (towards.length === 0) return from
  const next = projected > from ? towards[0] : towards[towards.length - 1]
  if (Math.abs(projected - from) < thresholds.commitFraction * Math.abs(next - from)) return from
  // Past the commit point: the neighbour – or, when the drag went further still, the nearest stop.
  return (projected - from) * (projected - next) <= 0 ? next : nearest(projected)
}

/**
 * Visible height of a sheet that rested `origin` px tall while a predictive back gesture is
 * `progress` (0…1) of the way: a preview that leaves the sheet on screen; committing finishes
 * the slide with the spring.
 */
export function sheetBackPosition(origin: number, progress: number): number {
  const p = Math.min(1, Math.max(0, progress))
  return origin * (1 - BACK_PEEK * p)
}

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

export interface SheetMotionOptions {
  /**
   * Distance (px) between resting open and fully dismissed – the sheet's height. A sheet with
   * one detent needs nothing else.
   */
  travel?: () => number
  /** A sheet with a peek and an expanded detent: their heights, measured by the component. */
  detents?: () => SheetDetents
  /**
   * The detent the sheet comes in to (the peek unless said otherwise): an editor whose body is
   * the document – the long-screenshot crop – opens expanded, as a frame dialog fills its frame.
   */
  openAt?: SheetDetent
  onChange: (state: SheetState) => void
  /** The dismissal finished: the sheet may be unmounted. */
  onClosed: () => void
}

/**
 * The motion of a dismissible sheet, with the stage's rules: presented with a spring, dragged by
 * a finger (which can catch the spring in flight), flung or dropped back on release, and driven
 * by the system back gesture through `backProgress` / `backCommit` / `backCancel` so a
 * predictive back peeks it away before it goes. Position lives on one track of visible height;
 * `progress` reports the dismissal share of it, `frame()` the height and offset to lay out. A
 * sheet with two detents also expands and collapses along the same track (`settleTo`), and
 * follows its detents when they are measured again (`refresh`).
 *
 * The sheet's presence `p` (`frame().scrim`: the scrim's share and the page's recede, v2 draft
 * §11.1) is its progress from closed to its rest over its own travel, clamped at 1 – a sheet
 * expanded past its first detent pushes the page no further. That travel is the detent the
 * sheet came in to; when the detents move under a resting sheet (the keyboard came up or went
 * and the peek is measured above it) the sheet follows them on its own value while `p` holds at
 * 1 – the recede never breathes with the keyboard – and from where the follow ends, at rest or
 * caught by a finger or a dismissal, `p` is measured over the travel the sheet actually has
 * there, so a dismissal from a raised pose runs 1 → 0 across all of it and nothing jumps.
 */
export class SheetMotion {
  private state: SheetState = SHEET_CLOSED
  /** Visible height (px); 0 while closed. */
  private position = 0
  private dragStart = 0
  /** Detent the sheet rests at, or is heading for. */
  private resting: SheetDetent = 'collapsed'
  /** Where the sheet stood when a predictive back gesture took hold of it. */
  private backOrigin: number | null = null
  /** Where the spring is heading (px); 0 = away. */
  private target = 0
  /** The travel (px) `p` is measured over: the height the sheet came in to, or last rested at. */
  private presenceTravel = 0
  /** Following detents that moved under it at rest: `p` holds at 1 until the follow ends. */
  private following = false
  private readonly spring: SpringAnimation

  constructor(private readonly options: SheetMotionOptions) {
    this.spring = new SpringAnimation(
      SPRING_GENTLE,
      (x) => {
        if (this.state.phase !== 'settling') return
        this.moveTo(x, 'settling')
      },
      (x) => this.settled(x)
    )
  }

  get current(): SheetState {
    return this.state
  }

  get isOpen(): boolean {
    return this.state.phase !== 'closed'
  }

  /** The detent the sheet rests at or heads for. */
  get restingDetent(): SheetDetent {
    return this.resting
  }

  /** At rest on the expanded detent – the one state in which a body may scroll on its own. */
  get restingExpanded(): boolean {
    return this.state.phase === 'open' && this.position >= this.detents().expanded - 1
  }

  /** On its way out. */
  get dismissing(): boolean {
    return this.state.phase === 'settling' && this.target === 0
  }

  /** Height and offset for the current position, and the sheet's presence `p` as the scrim's share. */
  frame(): SheetFrame {
    return { ...sheetFrame(this.position, this.detents()), scrim: this.presence() }
  }

  /** Bring the sheet in (from wherever it is – closed, or half dismissed). */
  present(): void {
    if (this.state.phase === 'closed') {
      this.position = 0
      this.resting = this.options.openAt ?? 'collapsed'
      // `p` runs 0 → 1 over the way in to the detent.
      this.presenceTravel = this.detents()[this.resting]
    } else {
      this.hold()
    }
    this.go(this.detents()[this.resting])
  }

  /** Send the sheet away with the spring, carrying `velocity` (px/s, positive = away). */
  dismiss(velocity = 0): void {
    if (this.state.phase === 'closed') return
    // Already on its way out: let it carry its momentum.
    if (this.dismissing && velocity === 0) return
    this.hold()
    this.go(0, -velocity, SPRING_SNAPPY)
  }

  /** Move to `detent` with the spring (the handle tapped). */
  settleTo(detent: SheetDetent): void {
    if (this.state.phase === 'closed') return
    this.hold()
    this.resting = detent
    this.go(this.detents()[detent])
  }

  /**
   * The detents were measured again: follow them, unless a finger or a dismissal is in charge.
   * A sheet at rest follows on its own value with `p` held at 1 (the keyboard raising or
   * lowering its detent never moves the page); a sheet still on its way in keeps running `p`
   * over the travel it set out on and clamps at 1 from there.
   */
  refresh(): void {
    if (this.state.phase === 'closed' || this.state.phase === 'dragging' || this.dismissing) return
    const to = this.detents()[this.resting]
    if (this.state.phase === 'settling') {
      this.target = to
      this.spring.retarget(to)
    } else if (this.position !== to) {
      // A sheet that rested at nothing (measured before it had a layout) comes in as presented.
      if (this.position > 0) this.following = true
      else this.presenceTravel = to
      this.go(to)
    } else {
      this.set(this.state)
    }
  }

  /** A finger took hold of the sheet (catching a spring in flight). False when closed. */
  beginDrag(): boolean {
    if (this.state.phase === 'closed') return false
    this.hold()
    this.backOrigin = null
    this.dragStart = this.position
    this.moveTo(this.position, 'dragging')
    return true
  }

  /** The finger moved `deltaPx` along the track since it took hold (positive = towards dismissal). */
  drag(deltaPx: number): void {
    if (this.state.phase !== 'dragging') return
    const position = sheetDragPosition(this.dragStart, -deltaPx, this.detents())
    if (position !== this.position) this.moveTo(position, 'dragging')
  }

  /** The finger lifted, moving at `velocity` px/s along the track (positive = away). */
  release(velocity: number): void {
    if (this.state.phase !== 'dragging') return
    const detents = this.detents()
    const target = settleDetent(this.position, -velocity, detents, this.dragStart)
    if (target === 0) {
      this.go(0, -velocity, SPRING_SNAPPY)
      return
    }
    // A sheet with one detent keeps the intent it had; only a real choice changes it.
    if (detents.collapsed !== detents.expanded)
      this.resting = target >= detents.expanded ? 'expanded' : 'collapsed'
    this.go(target, -velocity)
  }

  /** System back gesture in flight: `p` is its 0…1 progress. */
  backProgress(p: number): void {
    if (this.state.phase === 'closed' || this.dismissing) return
    if (this.backOrigin === null) this.backOrigin = this.hold()
    this.moveTo(sheetBackPosition(this.backOrigin, p), 'dragging')
  }

  /** The back gesture completed: finish the dismissal from where the peek left the sheet. */
  backCommit(): void {
    if (this.state.phase === 'closed') return
    this.dismiss()
  }

  /** The back gesture was abandoned: the sheet springs back to rest. */
  backCancel(): void {
    if (this.state.phase === 'closed') return
    this.present()
  }

  /** Take the sheet down at once, without animation (the layout changed, another surface opened). */
  close(): void {
    this.spring.stop()
    this.following = false
    if (this.state.phase === 'closed') return
    this.position = 0
    this.backOrigin = null
    this.set(SHEET_CLOSED)
    this.options.onClosed()
  }

  private detents(): SheetDetents {
    if (this.options.detents) return this.options.detents()
    const travel = Math.max(1, this.options.travel?.() ?? 1)
    return { collapsed: travel, expanded: travel }
  }

  /**
   * The sheet's presence: 1 while it follows detents that moved under it, else its position over
   * the travel it is measured on, clamped – a sheet above its first detent is fully present.
   */
  private presence(): number {
    if (this.following) return 1
    if (this.presenceTravel <= 0) return 0
    return Math.min(1, Math.max(0, this.position / this.presenceTravel))
  }

  /**
   * A follow of the detents ends where the sheet is – at rest, or caught by a finger, a back
   * gesture or a dismissal: from here `p` runs over the travel the sheet actually has, the
   * shorter of its height and its first detent (above the detent it is present in full).
   */
  private land(): void {
    if (!this.following) return
    this.following = false
    this.presenceTravel = Math.min(this.position, this.detents().collapsed)
  }

  /** Freeze whatever motion is running and report where the sheet is. */
  private hold(): number {
    if (this.state.phase === 'settling') this.position = this.spring.stop().x
    this.land()
    return this.position
  }

  /** Head for `target` px with the spring, carrying `velocity` px/s (positive = upwards). */
  private go(target: number, velocity = 0, config = SPRING_GENTLE): void {
    this.target = target
    this.backOrigin = null
    this.moveTo(this.position, 'settling')
    this.spring.start(this.position, velocity, target, config)
  }

  private moveTo(position: number, phase: SheetPhase): void {
    this.position = position
    const { collapsed } = this.detents()
    const progress = collapsed > 0 ? (collapsed - position) / collapsed : 1
    this.set({ phase, progress })
  }

  private settled(position: number): void {
    if (this.state.phase !== 'settling') return
    if (this.target === 0) {
      this.position = 0
      this.following = false
      this.set(SHEET_CLOSED)
      this.options.onClosed()
    } else {
      // At rest: from here a dismissal runs `p` over the travel the sheet stands at (its
      // height up to its first detent), wherever it came in from.
      this.following = false
      this.presenceTravel = Math.min(position, this.detents().collapsed)
      this.moveTo(position, 'open')
    }
  }

  private set(state: SheetState): void {
    this.state = state
    this.options.onChange(state)
  }
}
