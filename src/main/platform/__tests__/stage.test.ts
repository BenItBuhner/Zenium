import { describe, expect, it } from 'vitest'
import {
  belongsOnStage,
  frameFits,
  grownBox,
  regionCrop,
  retryStagedCapture,
  scrollRestoreScript,
  stageBox,
  stageWindowOptions,
  STAGE_FALLBACK,
  STAGED_CAPTURE_DEADLINE_MS,
  STAGED_CAPTURE_RETRY_MS
} from '../stage'

describe('belongsOnStage', () => {
  const driven = { agentDriven: true, visible: false, parked: false, hosted: true }

  it('is the agent-driven, hidden, unparked view of a live window', () => {
    expect(belongsOnStage(driven)).toBe(true)
  })

  it('is no view an agent does not drive, none the layout shows, none parked, none without a window', () => {
    expect(belongsOnStage({ ...driven, agentDriven: false })).toBe(false)
    expect(belongsOnStage({ ...driven, visible: true })).toBe(false)
    expect(belongsOnStage({ ...driven, parked: true })).toBe(false)
    expect(belongsOnStage({ ...driven, hosted: false })).toBe(false)
  })
})

describe('stageBox', () => {
  it('is the window’s page area at the stage’s origin', () => {
    expect(stageBox({ width: 1032, height: 772 }, { width: 1288, height: 824 })).toEqual({
      x: 0,
      y: 0,
      width: 1032,
      height: 772
    })
  })

  it('is the window’s content size before the first layout, and the fallback when neither has a size', () => {
    expect(stageBox(null, { width: 1288, height: 824 })).toEqual({
      x: 0,
      y: 0,
      width: 1288,
      height: 824
    })
    expect(stageBox({ width: 0, height: 0 }, { width: 0, height: 0 })).toEqual({
      x: 0,
      y: 0,
      ...STAGE_FALLBACK
    })
    expect(stageBox(null, null)).toEqual({ x: 0, y: 0, ...STAGE_FALLBACK })
  })

  it('takes each side from the first source that has it, whole and at least a pixel', () => {
    expect(stageBox({ width: 1032.4, height: 0 }, { width: 1288, height: 824.6 })).toEqual({
      x: 0,
      y: 0,
      width: 1032,
      height: 825
    })
    expect(stageBox({ width: Number.NaN, height: -5 }, null)).toEqual({
      x: 0,
      y: 0,
      ...STAGE_FALLBACK
    })
  })
})

describe('grownBox', () => {
  const box = { x: 0, y: 0, width: 1032, height: 772 }

  it('grows the box to the document in DIP – CSS pixels times the zoom – never smaller than the box', () => {
    expect(grownBox(box, { documentWidth: 1032, documentHeight: 2043, zoom: 1 }, 12_000)).toEqual({
      x: 0,
      y: 0,
      width: 1032,
      height: 2043
    })
    expect(grownBox(box, { documentWidth: 800, documentHeight: 500, zoom: 1 }, 12_000)).toEqual(box)
    expect(grownBox(box, { documentWidth: 1000, documentHeight: 1000, zoom: 1.5 }, 12_000)).toEqual(
      { x: 0, y: 0, width: 1500, height: 1500 }
    )
  })

  it('cuts a very long document at the height limit, in CSS pixels before the zoom', () => {
    expect(grownBox(box, { documentWidth: 1032, documentHeight: 50_000, zoom: 1 }, 12_000)).toEqual(
      { x: 0, y: 0, width: 1032, height: 12_000 }
    )
    // At 200 % the 1032 DIP box is 516 CSS pixels wide; the cut is in CSS pixels, the box in DIP.
    expect(grownBox(box, { documentWidth: 516, documentHeight: 50_000, zoom: 2 }, 8000)).toEqual({
      x: 0,
      y: 0,
      width: 1032,
      height: 16_000
    })
  })

  it('reads a zoom or a limit that is no number as 1 and a document of no size as nothing to grow to', () => {
    expect(
      grownBox(box, { documentWidth: Number.NaN, documentHeight: 0, zoom: Number.NaN }, Number.NaN)
    ).toEqual(box)
  })
})

describe('regionCrop', () => {
  const visible = { width: 1032, height: 2043 }

  it('is the region less the scroll offset at the ratio, cut at the visible area’s edge', () => {
    expect(
      regionCrop({ x: 20, y: 100, width: 112, height: 38 }, { scrollX: 0, scrollY: 0 }, 1, visible)
    ).toEqual({ x: 20, y: 100, width: 112, height: 38 })
    expect(
      regionCrop(
        { x: 20, y: 700, width: 112, height: 38 },
        { scrollX: 0, scrollY: 600 },
        2,
        visible
      )
    ).toEqual({ x: 40, y: 200, width: 224, height: 76 })
    expect(
      regionCrop(
        { x: 1000, y: 2000, width: 300, height: 300 },
        { scrollX: 0, scrollY: 0 },
        1,
        visible
      )
    ).toEqual({ x: 1000, y: 2000, width: 32, height: 43 })
  })

  it('is nothing for a region past the paint (the cut of a very long page), and reads a bad ratio as 1', () => {
    expect(
      regionCrop({ x: 0, y: 3000, width: 100, height: 100 }, { scrollX: 0, scrollY: 0 }, 1, visible)
    ).toBeNull()
    expect(
      regionCrop({ x: 0, y: 0, width: 100, height: 100 }, { scrollX: 0, scrollY: 0 }, 0, visible)
    ).toEqual({ x: 0, y: 0, width: 100, height: 100 })
  })
})

describe('frameFits', () => {
  it('takes any paint when nothing was wanted, and one at least the wanted size less a pixel of rounding', () => {
    expect(frameFits({ width: 1032, height: 772 }, null)).toBe(true)
    expect(frameFits({ width: 1032, height: 2043 }, { width: 1032, height: 2043 })).toBe(true)
    expect(frameFits({ width: 1031, height: 2042 }, { width: 1032, height: 2043 })).toBe(true)
    expect(frameFits({ width: 1032, height: 772 }, { width: 1032, height: 2043 })).toBe(false)
  })
})

describe('retryStagedCapture', () => {
  it('tries again while another try fits within the deadline', () => {
    expect(retryStagedCapture(0)).toBe(true)
    expect(retryStagedCapture(STAGED_CAPTURE_DEADLINE_MS - STAGED_CAPTURE_RETRY_MS)).toBe(true)
    expect(retryStagedCapture(STAGED_CAPTURE_DEADLINE_MS - STAGED_CAPTURE_RETRY_MS + 1)).toBe(false)
    expect(retryStagedCapture(STAGED_CAPTURE_DEADLINE_MS)).toBe(false)
  })

  it('keeps every staged capture well under the five seconds a tool call may take', () => {
    expect(STAGED_CAPTURE_DEADLINE_MS + STAGED_CAPTURE_RETRY_MS).toBeLessThan(5000)
  })
})

describe('scrollRestoreScript', () => {
  it('scrolls to the offset once the viewport reads its old height, whole numbers only', () => {
    const script = scrollRestoreScript({ scrollX: 0.4, scrollY: 500, height: 772 })
    expect(script).toContain('window.innerHeight === 772')
    expect(script).toContain('window.scrollTo(0, 500)')
    expect(script).toContain('n++ > 20')
  })

  it('never scrolls to a negative offset', () => {
    expect(scrollRestoreScript({ scrollX: -3, scrollY: -1, height: -1 })).toContain(
      'window.scrollTo(0, 0)'
    )
  })
})

describe('stageWindowOptions', () => {
  it('is a window nobody sees, focuses or finds, at the user window’s place, of its content size', () => {
    expect(stageWindowOptions({ x: 156.4, y: 90 }, { width: 1288, height: 824 })).toEqual({
      show: false,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      hiddenInMissionControl: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      useContentSize: true,
      x: 156,
      y: 90,
      width: 1288,
      height: 824,
      title: 'Zenium agent stage'
    })
  })

  it('falls back to a size when the window has none yet', () => {
    expect(stageWindowOptions({ x: 0, y: 0 }, { width: 0, height: 0 })).toMatchObject(
      STAGE_FALLBACK
    )
  })
})
