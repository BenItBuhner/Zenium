/*
 * Hidden chrome comes out when the cursor touches the window edge it hides behind: the sidebar
 * at its side (compact mode, fullscreen), the top toolbar at the top edge (compact mode with the
 * toolbar hidden, fullscreen). The page view takes the pointer over most of the window, so the
 * Electron window samples the real cursor and sends each transition to the chrome once. The
 * geometry and the once-per-transition rule live here, away from Electron, for the tests.
 */

export interface Point {
  x: number
  y: number
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** The edge a hidden piece of chrome comes out from. */
export type RevealEdge = 'left' | 'right' | 'top'

export interface EdgeZone {
  edge: RevealEdge
  /** How far in from the edge (px) the cursor counts as touching it. */
  reveal: number
  /** How far in (px) the cursor may roam before a revealed piece is asked to go. */
  keep: number
}

/**
 * The cursor may sit a little outside the window – on a frameless window's resize border, or
 * past a screen edge on another monitor – and still count as touching the edge (`reveal`) or
 * still hovering the revealed piece (`keep`).
 */
const OUTSIDE_REVEAL = 6
const OUTSIDE_KEEP = 48

export type EdgeState = 'reveal' | 'keep' | 'outside'

/** Where the cursor stands relative to a zone: on its edge, over the revealed piece, or away. */
export function edgeState(cursor: Point, bounds: Box, zone: EdgeZone): EdgeState {
  let distance: number
  let along: boolean
  if (zone.edge === 'top') {
    distance = cursor.y - bounds.y
    along = cursor.x >= bounds.x && cursor.x <= bounds.x + bounds.width
  } else {
    distance = zone.edge === 'left' ? cursor.x - bounds.x : bounds.x + bounds.width - cursor.x
    along = cursor.y >= bounds.y && cursor.y <= bounds.y + bounds.height
  }
  if (along && distance >= -OUTSIDE_REVEAL && distance <= zone.reveal) return 'reveal'
  if (!along || distance > zone.keep || distance < -OUTSIDE_KEEP) return 'outside'
  return 'keep'
}

/**
 * Turns cursor samples into the transitions worth sending: "reveal" once when the cursor
 * reaches the edge, "hide" once when it has gone – and only while the piece is out, since
 * re-sending "hide" would keep resetting the chrome's hide delay.
 */
export class EdgeTracker {
  private lastSent: boolean | null = null
  /** Whether the chrome confirmed the piece out after the last reveal sent. */
  private confirmed = false

  /** Whether the last transition sent was a reveal (the piece is out as far as main knows). */
  get revealed(): boolean {
    return this.lastSent === true
  }

  /**
   * The transition for this sample – true to reveal, false to hide – or null for none. `out`
   * says whether the piece is showing right now (the chrome's word where it has one). A piece
   * the chrome put away by itself after showing it – its own hover left, still inside the keep
   * band, and the page took the edge back – spends main's reveal: the next touch sends another.
   */
  sample(state: EdgeState, out: boolean = this.revealed): boolean | null {
    if (this.lastSent === true) {
      if (out) this.confirmed = true
      else if (this.confirmed) this.lastSent = false
    }
    if (state === 'reveal') {
      if (this.lastSent === true) return null
      this.lastSent = true
      this.confirmed = false
      return true
    }
    if (state === 'outside') {
      if (this.lastSent === false) return null
      this.lastSent = false
      return out ? false : null
    }
    return null
  }

  /** The piece is no longer hidden (or the window cannot be hovered): start afresh. */
  reset(): void {
    this.lastSent = null
    this.confirmed = false
  }
}
