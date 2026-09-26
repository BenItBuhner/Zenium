import { describe, expect, it } from 'vitest'
import {
  flipVerdict,
  fullCoverBounds,
  loggedPage,
  occlusionJudged,
  occlusionTracked,
  partialCoverBounds,
  steadyVerdict,
  tableRow
} from './visibility-scenario.mjs'

const reading = (state, changes) => ({ state, hidden: state === 'hidden', changes, log: [] })

describe('flipVerdict', () => {
  it('accepts exactly one visibilitychange to the state Chrome reports for the move', () => {
    expect(flipVerdict(reading('visible', 2), reading('hidden', 3), 'hidden')).toBeNull()
    expect(flipVerdict(reading('hidden', 3), reading('visible', 4), 'visible')).toBeNull()
  })
  it('names the state when the page did not follow the window', () => {
    expect(flipVerdict(reading('visible', 2), reading('visible', 2), 'hidden')).toMatch(
      /reads visible, not hidden/
    )
  })
  it('names a flicker: two events where Chrome has one, and a state reached with none', () => {
    expect(flipVerdict(reading('visible', 2), reading('hidden', 4), 'hidden')).toMatch(
      /2 visibilitychange event\(s\) for one transition to hidden \(2 → 4\)/
    )
    expect(flipVerdict(reading('visible', 2), reading('hidden', 2), 'hidden')).toMatch(
      /0 visibilitychange event\(s\)/
    )
  })
  it('says so when the page gave no reading', () => {
    expect(flipVerdict(reading('visible', 2), null, 'hidden')).toBe('no reading from the page')
  })
})

describe('steadyVerdict', () => {
  it('accepts the same state and no event for a move that is none to a page (a blur)', () => {
    expect(steadyVerdict(reading('visible', 2), reading('visible', 2), 'visible')).toBeNull()
  })
  it('names a state change, and a flicker that came back to the same state', () => {
    expect(steadyVerdict(reading('visible', 2), reading('hidden', 3), 'visible')).toMatch(
      /reads hidden, not visible/
    )
    expect(steadyVerdict(reading('visible', 2), reading('visible', 4), 'visible')).toMatch(
      /2 visibilitychange event\(s\) for a move that is none to a page \(2 → 4\)/
    )
  })
})

describe('cover boxes', () => {
  const bounds = { x: 100, y: 50, width: 1200, height: 800 }
  it('covers the whole window and a margin beyond it', () => {
    expect(fullCoverBounds(bounds)).toEqual({ x: 92, y: 42, width: 1216, height: 816 })
    expect(fullCoverBounds(bounds, 0)).toEqual(bounds)
  })
  it('covers the top-left quarter for the blur that leaves the page on screen', () => {
    expect(partialCoverBounds(bounds)).toEqual({ x: 100, y: 50, width: 600, height: 400 })
    // Never smaller than a window the OS would refuse.
    expect(partialCoverBounds({ x: 0, y: 0, width: 100, height: 100 })).toEqual({
      x: 0,
      y: 0,
      width: 120,
      height: 120
    })
  })
})

describe('occlusionTracked', () => {
  it('is Chromium’s native occlusion tracking: Windows and macOS, not X11', () => {
    expect(occlusionTracked('win32')).toBe(true)
    expect(occlusionTracked('darwin')).toBe(true)
    expect(occlusionTracked('linux')).toBe(false)
  })
})

describe('occlusionJudged', () => {
  it('judges the full cover where the OS tracks occlusion and the bare window read hidden', () => {
    expect(occlusionJudged('win32', 'hidden')).toBe(true)
    expect(occlusionJudged('darwin', 'hidden')).toBe(true)
  })
  it('records, not judges, a display that reported no occlusion to the bare window either', () => {
    expect(occlusionJudged('darwin', 'visible')).toBe(false)
    expect(occlusionJudged('win32', 'visible')).toBe(false)
  })
  it('leaves the OS’s rule to stand when the native reading is unknown', () => {
    expect(occlusionJudged('win32', null)).toBe(true)
    expect(occlusionJudged('darwin', null)).toBe(true)
  })
  it('never judges X11, whatever Xvfb told the bare window', () => {
    expect(occlusionJudged('linux', 'hidden')).toBe(false)
    expect(occlusionJudged('linux', null)).toBe(false)
  })
})

describe('tableRow', () => {
  it('reads the move’s before and after with the events it cost', () => {
    expect(tableRow('hide', reading('visible', 1), reading('hidden', 2))).toEqual({
      move: 'hide',
      before: 'visible',
      after: 'hidden',
      events: 1
    })
    expect(tableRow('shown', null, reading('visible', 0))).toEqual({
      move: 'shown',
      before: null,
      after: 'visible',
      events: null
    })
  })
})

describe('loggedPage', () => {
  it('is a data: URL carrying the logger so the first visibilitychange is counted', () => {
    const url = loggedPage('native tab', '#fff')
    expect(url.startsWith('data:text/html,')).toBe(true)
    const html = decodeURIComponent(url.slice('data:text/html,'.length))
    expect(html).toContain('<title>native tab</title>')
    expect(html).toContain("addEventListener('visibilitychange'")
    expect(html).toContain('window.__zenVis')
  })
})
