import { describe, expect, it } from 'vitest'
import {
  DEVTOOLS_DOCK_ROWS,
  DEVTOOLS_DOCKS,
  isDockedInFrame,
  sanitizeDevtoolsDock
} from '../devtoolsDock'
import { DEFAULT_SETTINGS } from '../defaults'

describe('devtools dock (v2 §9.29)', () => {
  it('defaults to the bottom, the menu offering the toolbox’s four – bottom, right, left, undocked – in that order', () => {
    expect(DEFAULT_SETTINGS.devtoolsDock).toBe('bottom')
    expect(DEVTOOLS_DOCK_ROWS.map((r) => r.dock)).toEqual(['bottom', 'right', 'left', 'undocked'])
    expect(DEVTOOLS_DOCK_ROWS.map((r) => r.label)).toEqual([
      'Dock to Bottom',
      'Dock to Right',
      'Dock to Left',
      'Undock'
    ])
    // Every dock the toolbox can stand in has its row (the lead's ruling 4 on #414): the rows
    // and the docks are the same four.
    expect(DEVTOOLS_DOCKS).toEqual(['bottom', 'right', 'left', 'undocked'])
    expect(DEVTOOLS_DOCK_ROWS.map((r) => r.dock)).toEqual([...DEVTOOLS_DOCKS])
  })

  it('keeps the four docks and falls anything else back to the default', () => {
    for (const dock of DEVTOOLS_DOCKS) expect(sanitizeDevtoolsDock(dock, 'bottom')).toBe(dock)
    expect(sanitizeDevtoolsDock('detach', 'bottom')).toBe('bottom')
    expect(sanitizeDevtoolsDock('top', 'right')).toBe('right')
    expect(sanitizeDevtoolsDock(undefined, 'bottom')).toBe('bottom')
    expect(sanitizeDevtoolsDock(null, 'bottom')).toBe('bottom')
    expect(sanitizeDevtoolsDock(1, 'bottom')).toBe('bottom')
  })

  it('tells the docks that share the frame from the separate window', () => {
    expect(isDockedInFrame('bottom')).toBe(true)
    expect(isDockedInFrame('right')).toBe(true)
    expect(isDockedInFrame('left')).toBe(true)
    expect(isDockedInFrame('undocked')).toBe(false)
  })
})
