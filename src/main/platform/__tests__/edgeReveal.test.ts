import { describe, expect, it } from 'vitest'
import { EdgeTracker, edgeState, type EdgeZone } from '../edgeReveal'

const bounds = { x: 100, y: 50, width: 1000, height: 600 }
const left: EdgeZone = { edge: 'left', reveal: 14, keep: 288 }
const right: EdgeZone = { edge: 'right', reveal: 14, keep: 288 }
const top: EdgeZone = { edge: 'top', reveal: 4, keep: 120 }

describe('edgeState', () => {
  it('sees the cursor on the sidebar edge inside the zone, a little outside the window too', () => {
    expect(edgeState({ x: 100, y: 300 }, bounds, left)).toBe('reveal')
    expect(edgeState({ x: 114, y: 300 }, bounds, left)).toBe('reveal')
    expect(edgeState({ x: 94, y: 300 }, bounds, left)).toBe('reveal')
    expect(edgeState({ x: 115, y: 300 }, bounds, left)).toBe('keep')
    expect(edgeState({ x: 93, y: 300 }, bounds, left)).toBe('keep')
    expect(edgeState({ x: 1100, y: 300 }, bounds, right)).toBe('reveal')
    expect(edgeState({ x: 1086, y: 300 }, bounds, right)).toBe('reveal')
    expect(edgeState({ x: 1085, y: 300 }, bounds, right)).toBe('keep')
  })

  it('keeps a revealed sidebar while the cursor is over it and lets it go beyond', () => {
    expect(edgeState({ x: 388, y: 300 }, bounds, left)).toBe('keep')
    expect(edgeState({ x: 389, y: 300 }, bounds, left)).toBe('outside')
    expect(edgeState({ x: 52, y: 300 }, bounds, left)).toBe('keep')
    expect(edgeState({ x: 51, y: 300 }, bounds, left)).toBe('outside')
  })

  it('needs the cursor alongside the window for either edge', () => {
    expect(edgeState({ x: 100, y: 49 }, bounds, left)).toBe('outside')
    expect(edgeState({ x: 100, y: 651 }, bounds, left)).toBe('outside')
    expect(edgeState({ x: 99, y: 50 }, bounds, top)).toBe('outside')
    expect(edgeState({ x: 1101, y: 50 }, bounds, top)).toBe('outside')
  })

  it('sees the cursor on the top edge in a narrow zone and keeps the toolbar for its height', () => {
    expect(edgeState({ x: 600, y: 50 }, bounds, top)).toBe('reveal')
    expect(edgeState({ x: 600, y: 54 }, bounds, top)).toBe('reveal')
    expect(edgeState({ x: 600, y: 44 }, bounds, top)).toBe('reveal')
    expect(edgeState({ x: 600, y: 55 }, bounds, top)).toBe('keep')
    expect(edgeState({ x: 600, y: 170 }, bounds, top)).toBe('keep')
    expect(edgeState({ x: 600, y: 171 }, bounds, top)).toBe('outside')
    expect(edgeState({ x: 600, y: 1 }, bounds, top)).toBe('outside')
  })

  it('takes a fullscreen window from the screen origin, where the cursor parks on the edge', () => {
    const screen = { x: 0, y: 0, width: 1280, height: 720 }
    expect(edgeState({ x: 640, y: 0 }, screen, top)).toBe('reveal')
    expect(edgeState({ x: 0, y: 360 }, screen, left)).toBe('reveal')
    expect(edgeState({ x: 1279, y: 360 }, screen, right)).toBe('reveal')
  })
})

describe('EdgeTracker', () => {
  it('sends a reveal once for a run of edge samples', () => {
    const t = new EdgeTracker()
    expect(t.sample('reveal')).toBe(true)
    expect(t.sample('reveal')).toBeNull()
    expect(t.sample('keep')).toBeNull()
    expect(t.revealed).toBe(true)
  })

  it('sends a hide once when the cursor has gone, and only while the piece is out', () => {
    const t = new EdgeTracker()
    expect(t.sample('outside')).toBeNull()
    expect(t.sample('reveal')).toBe(true)
    expect(t.sample('outside')).toBe(false)
    expect(t.sample('outside')).toBeNull()
    expect(t.revealed).toBe(false)
    // The chrome's word beats main's: a sidebar the chrome already put away needs no hide.
    expect(t.sample('reveal')).toBe(true)
    expect(t.sample('outside', false)).toBeNull()
    // And a sidebar the chrome shows for its own reasons is asked to go.
    t.reset()
    expect(t.sample('outside', true)).toBe(false)
  })

  it('starts afresh after a reset, so a piece hidden again reveals on the next touch', () => {
    const t = new EdgeTracker()
    expect(t.sample('reveal')).toBe(true)
    t.reset()
    expect(t.revealed).toBe(false)
    expect(t.sample('reveal')).toBe(true)
  })
})
