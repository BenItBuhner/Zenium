/**
 * The new tab page's search field becoming the omnibox (NTP-02 / MOT-08, Chrome's fakebox; design
 * language v2 §11.8): the field's rectangle lerps from its resting place on the page to the bar –
 * the pill's slot as the page scrolls at a top dock (at a bottom dock it rides up with the page
 * and hands over to the slot by a fade), the omnibox's field on a tap – and back again when the
 * omnibox is dismissed. This module is the pure part: the poses, the interpolation between them
 * and the state machine that decides which pose the field is in and what draws it. Nothing in
 * here touches the DOM, a spring or a store; `lib/fakeboxMorph.ts` drives it and
 * `FakeboxMorphLayer` paints it.
 *
 * The rectangle interpolation is the app's own: every edge on its own straight line, the corner
 * radius with them (`growFrame` in lib/newtab.ts for MOT-03's grow, `lerpRect` for the overview's
 * hero card). The pose carries two more scalars on the same line – how far the surface has taken
 * the pill's look, and how far the page has given way to the omnibox – so that everything the
 * morph moves rides one value (design language v2 §11: one spring, no second clock).
 */
import type { Rect } from '@shared/types'

/** The field's corner radius at rest (§9.29: radius 12, `--v2-radius-sheet`). */
export const FAKEBOX_REST_RADIUS = 12
/** The pill's and the omnibox field's: a 44 px pill. */
export const FAKEBOX_DOCK_RADIUS = 22

/**
 * The scrub's last stretch, over which the field hands over to the bar's pill: the field's
 * surface fades out as it arrives over the slot while the pill's own look and words fill the
 * slot in under it, so that at the landing the pill is complete and nothing swaps.
 */
export const FAKEBOX_PILL_LOOK_FROM = 0.7

/**
 * How fast the page's tiles and heading go under the arriving omnibox: gone at this fraction of
 * the morph, so the sheet never fades in over a page still fully drawn. The same line runs back.
 */
export const FAKEBOX_PAGE_GONE_AT = 0.6

/**
 * Where the omnibox's sheet (its suggestions) starts to arrive: the page is nearly gone by then,
 * so the first part of the way is the field alone over a receding page and the rest the
 * suggestions rising in under it, complete at the landing. The same line runs back.
 */
export const FAKEBOX_SHEET_FROM = 0.4

export interface FakeboxPose {
  rect: Rect
  radius: number
  /**
   * How far the field has handed over to the bar's pill: 0, the field's own surface, whole;
   * 1, the pill's slot filled in with the pill's look and words, the field's surface gone.
   */
  pill: number
  /**
   * 0: the page's field; 1: the omnibox's – the sheet's opacity, the bar's fade and the tiles'
   * absence all read this one value.
   */
  open: number
}

export interface FakeboxGeometry {
  /** The field's natural rectangle with the page unscrolled, in window coordinates. */
  rest: Rect
  /** The address pill's slot in the bar: where the scroll carries the field. */
  slot: Rect
  /** The omnibox's field in the bar band: where a tap carries it. */
  omnibox: Rect
  /** The page frame's top edge in window coordinates: above it the field has left the viewport. */
  frameTop: number
}

/**
 * `rest`: the field is the page's, scrubbed by the page's scroll. `opening`: on the spring to
 * the omnibox (which is opening under it). `open`: landed; the omnibox's own field draws.
 * `closing`: on the spring back to the page's pose (the omnibox closes as it lands).
 */
export type FakeboxPhase = 'rest' | 'opening' | 'open' | 'closing'

export interface FakeboxState {
  phase: FakeboxPhase
  /** How far the page's scroll has carried the field toward the pill's slot, 0…1. */
  scrub: number
  /** The pose the running segment set out from, frozen at its start; null at rest and open. */
  from: FakeboxPose | null
  /** Progress along the running segment, 0…1. */
  t: number
  /**
   * While open, how far the predictive back gesture has pulled the field back toward the page
   * (the finger's own value, 0…1); a commit turns it into a `closing` segment, a cancel runs it
   * back to 0.
   */
  back: number
}

export const FAKEBOX_REST: FakeboxState = { phase: 'rest', scrub: 0, from: null, t: 0, back: 0 }

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

export function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    width: lerp(a.width, b.width, t),
    height: lerp(a.height, b.height, t)
  }
}

export function lerpPose(a: FakeboxPose, b: FakeboxPose, t: number): FakeboxPose {
  const k = clamp01(t)
  return {
    rect: lerpRect(a.rect, b.rect, k),
    radius: lerp(a.radius, b.radius, k),
    pill: lerp(a.pill, b.pill, k),
    open: lerp(a.open, b.open, k)
  }
}

/**
 * The scroll offset at which the field has left the viewport – its bottom edge past the frame's
 * top – and so is docked: the scrub runs over exactly this distance, one to one with the page
 * at a top dock (the band and the field are both 56 tall, so the field arrives in the slot as
 * its natural place clears the frame).
 */
export function scrubTravel(g: FakeboxGeometry): number {
  return Math.max(1, g.rest.y + g.rest.height - g.frameTop)
}

/** Where the page's scroll offset puts the scrub. */
export function scrubOf(offset: number, g: FakeboxGeometry): number {
  return clamp01(offset / scrubTravel(g))
}

/** How far the field has handed over to the pill at `scrub`: not at all until the last stretch. */
export function pillLook(scrub: number): number {
  return clamp01((scrub - FAKEBOX_PILL_LOOK_FROM) / (1 - FAKEBOX_PILL_LOOK_FROM))
}

/**
 * Whether the bar – and so the pill's slot the scroll hands the field to – is below the page
 * (a bottom dock) rather than above it (a top dock): the slot's middle is under the frame's
 * top edge.
 */
export function dockBelow(g: FakeboxGeometry): boolean {
  return g.slot.y + g.slot.height / 2 > g.frameTop
}

/**
 * The page's pose at `scrub` (v2 §11.8). At a top dock the resting field is carried toward the
 * pill's slot with the page's scroll, its corners rounding to the pill's, and hands over to the
 * pill over the last stretch: at 0 it is the field itself, at 1 the pill. At a bottom dock the
 * field is content: it rides up with the page exactly as far as the finger, unchanged in size
 * and corners, and fades out at the frame's top edge over the same last stretch as the well's
 * contents fade in – it never travels against the hand; only the tap's spring goes toward the
 * dock.
 */
export function restPose(g: FakeboxGeometry, scrub: number): FakeboxPose {
  const s = clamp01(scrub)
  if (dockBelow(g)) {
    return {
      rect: { ...g.rest, y: g.rest.y - s * scrubTravel(g) },
      radius: FAKEBOX_REST_RADIUS,
      pill: pillLook(s),
      open: 0
    }
  }
  return {
    rect: lerpRect(g.rest, g.slot, s),
    radius: lerp(FAKEBOX_REST_RADIUS, FAKEBOX_DOCK_RADIUS, s),
    pill: pillLook(s),
    open: 0
  }
}

/** The omnibox's pose: its field in the bar band, the page given way. */
export function openPose(g: FakeboxGeometry): FakeboxPose {
  return { rect: g.omnibox, radius: FAKEBOX_DOCK_RADIUS, pill: 0, open: 1 }
}

/** The pose the field is in now. */
export function poseOf(state: FakeboxState, g: FakeboxGeometry): FakeboxPose {
  switch (state.phase) {
    case 'rest':
      return restPose(g, state.scrub)
    case 'open':
      return state.back > 0
        ? lerpPose(openPose(g), restPose(g, state.scrub), state.back)
        : openPose(g)
    case 'opening':
      return lerpPose(state.from ?? restPose(g, state.scrub), openPose(g), state.t)
    case 'closing':
      return lerpPose(state.from ?? openPose(g), restPose(g, state.scrub), state.t)
  }
}

/** The pose a running segment is heading for (the pose itself when nothing runs). */
export function targetPose(state: FakeboxState, g: FakeboxGeometry): FakeboxPose {
  switch (state.phase) {
    case 'opening':
      return openPose(g)
    case 'closing':
      return restPose(g, state.scrub)
    default:
      return poseOf(state, g)
  }
}

/**
 * The widest the field is in any of its poses: the double's words are laid out once at this
 * width and clipped by the moving box (v2 §11.8), so a long placeholder never re-wraps or
 * re-truncates as the width passes through on the way.
 */
export function widestPoseWidth(g: FakeboxGeometry): number {
  return Math.max(g.rest.width, g.slot.width, g.omnibox.width)
}

/** The page field's left padding (`pl-4`) and the room its mic and camera take (44 each, gap 2, `pr-1.5`; `pr-4` with neither). */
const FAKEBOX_CONTENT_LEFT = 16
const FAKEBOX_TRAILING_GLYPH = 44
const FAKEBOX_TRAILING_GAP = 2
const FAKEBOX_TRAILING_RIGHT = 6
const FAKEBOX_PLAIN_RIGHT = 16

/**
 * The width the double's words are laid out at: the widest pose less the padding and the room
 * `glyphs` trailing controls (the mic, the camera) take on the page's field, so that at rest the
 * words truncate exactly where the page's do and the layout never changes on the way.
 */
export function fakeboxContentWidth(widest: number, glyphs: number): number {
  const trailing =
    glyphs > 0
      ? glyphs * FAKEBOX_TRAILING_GLYPH +
        (glyphs - 1) * FAKEBOX_TRAILING_GAP +
        FAKEBOX_TRAILING_RIGHT
      : FAKEBOX_PLAIN_RIGHT
  return Math.max(0, widest - FAKEBOX_CONTENT_LEFT - trailing)
}

/** The omnibox field's left padding (`pl-2`), its gap (`gap-2.5`) and its 44 px trailing controls, flush with its end. */
const OMNIBOX_CONTENT_LEFT = 8
const OMNIBOX_GAP = 10
const OMNIBOX_GLYPH = 44

/**
 * The width the double lays the omnibox field's content out at – the engine's chip, then the
 * words – so that the words truncate where the omnibox's own do once its `glyphs` trailing
 * controls (each 44 wide after a gap) have taken their room; laid out once, at the widest pose,
 * like the page field's.
 */
export function omniboxContentWidth(widest: number, glyphs: number): number {
  return Math.max(0, widest - OMNIBOX_CONTENT_LEFT - glyphs * (OMNIBOX_GAP + OMNIBOX_GLYPH))
}

/**
 * How far the surface would travel between two poses (px): the centres' distance plus half the
 * change of size.
 */
export function segmentDistance(from: FakeboxPose, to: FakeboxPose): number {
  const dx = to.rect.x + to.rect.width / 2 - (from.rect.x + from.rect.width / 2)
  const dy = to.rect.y + to.rect.height / 2 - (from.rect.y + from.rect.height / 2)
  const size =
    Math.abs(to.rect.width - from.rect.width) / 2 + Math.abs(to.rect.height - from.rect.height) / 2
  return Math.hypot(dx, dy) + size
}

/**
 * The distance the spring runs on for a segment, so its pace is the poses' distance's: never
 * under 120 so a short hop still takes the spring's time to settle.
 */
export function segmentTravel(from: FakeboxPose, to: FakeboxPose): number {
  return Math.max(120, segmentDistance(from, to))
}

/**
 * Whether two poses are the same place to the eye (within a pixel): a segment between them has
 * nothing to run and lands at once – the back gesture's commit after its pull has already put
 * the field at the page's pose, and a dismissal before the bar has come up leaves it there.
 */
export function posesCoincide(a: FakeboxPose, b: FakeboxPose): boolean {
  return segmentDistance(a, b) < 1 && Math.abs(a.open - b.open) < 0.01
}

/** The page's tiles and heading at `open`: gone by `FAKEBOX_PAGE_GONE_AT`, back on the same line. */
export function pageOpacity(open: number): number {
  return Math.round(clamp01(1 - clamp01(open) / FAKEBOX_PAGE_GONE_AT) * 1000) / 1000
}

/** The omnibox's sheet at `open`: nothing until `FAKEBOX_SHEET_FROM`, whole at the landing. */
export function sheetOpacity(open: number): number {
  const k = (clamp01(open) - FAKEBOX_SHEET_FROM) / (1 - FAKEBOX_SHEET_FROM)
  return Math.round(clamp01(k) * 1000) / 1000
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** The page scrolled to `offset`: the scrub follows, whatever else is going on. */
export function scrolled(state: FakeboxState, offset: number, g: FakeboxGeometry): FakeboxState {
  const scrub = scrubOf(offset, g)
  return scrub === state.scrub ? state : { ...state, scrub }
}

/**
 * The field was tapped: from rest (at any scrub) or from a closing run, the surface sets out
 * for the omnibox from exactly where it is. Already opening or open: nothing to do.
 */
export function tapped(state: FakeboxState, g: FakeboxGeometry): FakeboxState {
  if (state.phase === 'opening' || state.phase === 'open') return state
  return { ...state, phase: 'opening', from: poseOf(state, g), t: 0, back: 0 }
}

/** The spring reports where along the segment it is. */
export function progressed(state: FakeboxState, t: number): FakeboxState {
  if (state.phase !== 'opening' && state.phase !== 'closing') return state
  const k = clamp01(t)
  return k === state.t ? state : { ...state, t: k }
}

/** The spring came to rest: opening has opened, closing is back at the page's pose. */
export function landed(state: FakeboxState): FakeboxState {
  if (state.phase === 'opening') return { ...state, phase: 'open', from: null, t: 0, back: 0 }
  if (state.phase === 'closing') return { ...state, phase: 'rest', from: null, t: 0, back: 0 }
  return state
}

/**
 * The omnibox is being dismissed – the scrim, the back gesture's commit, Escape – while the
 * field is on its way up or has arrived: it runs back to the page's pose from where it is (a
 * back gesture's pull included). At rest or already closing: nothing to do.
 */
export function dismissed(state: FakeboxState, g: FakeboxGeometry): FakeboxState {
  if (state.phase !== 'opening' && state.phase !== 'open') return state
  return { ...state, phase: 'closing', from: poseOf(state, g), t: 0, back: 0 }
}

/**
 * The predictive back gesture pulls the open omnibox: the field follows the finger back toward
 * the page (its value 0…1), and a cancelled gesture runs it back to 0. Only an open field
 * follows; one still on its spring keeps flying, and the gesture's commit is `dismissed`.
 */
export function backPulled(state: FakeboxState, value: number): FakeboxState {
  if (state.phase !== 'open') return state
  const back = clamp01(value)
  return back === state.back ? state : { ...state, back }
}

/**
 * Whether the page's own field is what the scroll moves at `scrub`: with the page unscrolled
 * anywhere, and at a bottom dock all the way until it has left the frame (there it is content,
 * riding and fading in place, and the double has nothing to add). At a top dock the double
 * carries it to the slot instead.
 */
export function pageFieldAtRest(scrub: number, g: FakeboxGeometry): boolean {
  return scrub <= 0 || (dockBelow(g) && scrub < 1)
}

/**
 * Whether the morph paints its own surface (the field's double) rather than leaving the page's
 * field, the pill or the omnibox's field to draw: while a segment runs, while the finger holds
 * an open field pulled back, and while the scroll holds the field between its two rests at a
 * top dock.
 */
export function drawsSurface(state: FakeboxState, g: FakeboxGeometry): boolean {
  switch (state.phase) {
    case 'opening':
    case 'closing':
      return true
    case 'open':
      return state.back > 0
    case 'rest':
      return state.scrub > 0 && state.scrub < 1 && !pageFieldAtRest(state.scrub, g)
  }
}

/** Whether the page's own field is painted: at rest, where the scroll leaves it the page's. */
export function showsPageField(state: FakeboxState, g: FakeboxGeometry): boolean {
  return state.phase === 'rest' && pageFieldAtRest(state.scrub, g)
}

/**
 * Under reduced motion (v2 §11.3) the spring's part is a 120 ms fade in place, and the double is
 * drawn only where it is what fades: a segment setting out from, or returning to, a field the
 * scroll holds between its rests (a top dock, part way). At the other ends the page's own field
 * or the omnibox's fades itself.
 */
export function drawsSurfaceReduced(state: FakeboxState, g: FakeboxGeometry): boolean {
  if (state.phase !== 'opening' && state.phase !== 'closing') return false
  return state.scrub > 0 && state.scrub < 1 && !pageFieldAtRest(state.scrub, g)
}

/**
 * The pose the double holds while it fades under reduced motion: the scrubbed field's, where the
 * segment set out from (opening) or is heading back to (closing) – never a pose mid-way, since
 * nothing travels.
 */
export function reducedPose(state: FakeboxState, g: FakeboxGeometry): FakeboxPose {
  return state.phase === 'opening' || state.phase === 'closing'
    ? restPose(g, state.scrub)
    : poseOf(state, g)
}

/** Whether the omnibox's own field is painted: only once the surface has landed in it, unpulled. */
export function showsOmniboxField(state: FakeboxState): boolean {
  return state.phase === 'open' && state.back === 0
}

/** Whether the omnibox is (or is becoming) the frame's surface: it is mounted through all of these. */
export function omniboxUp(state: FakeboxState): boolean {
  return state.phase !== 'rest'
}
