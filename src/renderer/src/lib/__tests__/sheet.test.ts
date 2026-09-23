import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BACK_PEEK, SHEET_CLOSED, SheetMotion, type SheetState } from '../motion/sheet'
import {
  SHEET_FIELD_MARGIN,
  SHEET_LIST_MAX_SHARE,
  SHEET_MIN_DETENT_GAP,
  SHEET_OVERDRAG,
  SHEET_PEEK_FRACTION,
  computeDetents,
  detentForField,
  fieldOverflow,
  settleDetent,
  sheetBackPosition,
  sheetDragPosition,
  sheetFrame,
  sheetMaxHeight
} from '../motion/sheet'

/**
 * A hand-cranked animation frame: `frames(n)` advances the clock 16 ms at a time and runs the
 * callbacks the motion scheduled, so a spring can be followed to rest without a real browser.
 */
class Frames {
  now = 0
  private queue = new Map<number, (now: number) => void>()
  private seq = 0

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
      const id = ++this.seq
      this.queue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      this.queue.delete(id)
    })
    vi.stubGlobal('performance', { now: () => this.now })
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
      innerHeight: 800
    })
  }

  run(n: number): void {
    for (let i = 0; i < n; i++) {
      this.now += 16
      const pending = [...this.queue.values()]
      this.queue.clear()
      for (const cb of pending) cb(this.now)
    }
  }

  get scheduled(): boolean {
    return this.queue.size > 0
  }
}

describe('SheetMotion', () => {
  const frames = new Frames()
  let states: SheetState[]
  let closed: number
  let motion: SheetMotion

  beforeEach(() => {
    frames.install()
    states = []
    closed = 0
    motion = new SheetMotion({
      travel: () => 500,
      onChange: (s) => states.push(s),
      onClosed: () => closed++
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  const last = (): SheetState => states[states.length - 1]

  it('presents from off screen and settles open', () => {
    expect(motion.current).toEqual(SHEET_CLOSED)
    motion.present()
    expect(last()).toEqual({ phase: 'settling', progress: 1 })
    frames.run(3)
    expect(last().phase).toBe('settling')
    expect(last().progress).toBeLessThan(1)
    expect(last().progress).toBeGreaterThan(0)
    frames.run(120)
    expect(last()).toEqual({ phase: 'open', progress: 0 })
    expect(closed).toBe(0)
    expect(frames.scheduled).toBe(false)
  })

  it('dismisses with a spring and reports once it is gone', () => {
    motion.present()
    frames.run(120)
    motion.dismiss()
    expect(last().phase).toBe('settling')
    frames.run(120)
    expect(motion.current).toEqual(SHEET_CLOSED)
    expect(closed).toBe(1)
  })

  it('follows a finger and springs back after a short drag', () => {
    motion.present()
    frames.run(120)
    expect(motion.beginDrag()).toBe(true)
    motion.drag(100)
    expect(last()).toEqual({ phase: 'dragging', progress: 0.2 })
    // Upward overshoot rubber-bands: a little, and never far.
    motion.drag(-200)
    expect(last().progress).toBeLessThan(0)
    expect(last().progress).toBeGreaterThan(-0.2)
    motion.drag(100)
    motion.release(0)
    frames.run(120)
    expect(motion.current).toEqual({ phase: 'open', progress: 0 })
    expect(closed).toBe(0)
  })

  it('a long drag or a fling dismisses', () => {
    motion.present()
    frames.run(120)
    motion.beginDrag()
    motion.drag(300)
    motion.release(0)
    frames.run(120)
    expect(motion.current).toEqual(SHEET_CLOSED)
    expect(closed).toBe(1)

    motion.present()
    frames.run(120)
    motion.beginDrag()
    motion.drag(40)
    motion.release(1800)
    frames.run(120)
    expect(closed).toBe(2)
  })

  it('a finger catches the spring in flight and continues from there', () => {
    motion.present()
    frames.run(4)
    const caught = motion.current.progress
    expect(caught).toBeGreaterThan(0)
    expect(caught).toBeLessThan(1)
    expect(motion.beginDrag()).toBe(true)
    expect(motion.current).toEqual({ phase: 'dragging', progress: caught })
    expect(frames.scheduled).toBe(false)
    motion.drag(-caught * 500)
    expect(motion.current.progress).toBeCloseTo(0, 5)
    motion.release(0)
    frames.run(120)
    expect(motion.current).toEqual({ phase: 'open', progress: 0 })
  })

  it('is driven by the system back gesture: peek, then commit or cancel', () => {
    motion.present()
    frames.run(120)
    motion.backProgress(0.5)
    expect(last()).toEqual({ phase: 'dragging', progress: 0.5 * BACK_PEEK })
    motion.backProgress(2)
    expect(last().progress).toBe(BACK_PEEK)
    motion.backCancel()
    frames.run(120)
    expect(motion.current).toEqual({ phase: 'open', progress: 0 })
    expect(closed).toBe(0)

    motion.backProgress(1)
    motion.backCommit()
    expect(last().phase).toBe('settling')
    frames.run(120)
    expect(motion.current).toEqual(SHEET_CLOSED)
    expect(closed).toBe(1)
  })

  describe('with two detents', () => {
    const detents = { collapsed: 400, expanded: 800 }
    let two: SheetMotion

    beforeEach(() => {
      states = []
      two = new SheetMotion({
        detents: () => detents,
        onChange: (s) => states.push(s),
        onClosed: () => closed++
      })
    })

    it('presents to the peek and lays itself out at that height', () => {
      two.present()
      frames.run(120)
      expect(two.current).toEqual({ phase: 'open', progress: 0 })
      expect(two.frame()).toEqual({ height: 400, translateY: 0, scrim: 1 })
      expect(two.restingDetent).toBe('collapsed')
      expect(two.restingExpanded).toBe(false)
    })

    it('a drag up past the commit point expands; the body grows instead of moving', () => {
      two.present()
      frames.run(120)
      two.beginDrag()
      two.drag(-250)
      expect(two.frame()).toEqual({ height: 650, translateY: 0, scrim: 1 })
      expect(two.current.progress).toBeLessThan(0)
      two.release(0)
      frames.run(120)
      expect(two.restingDetent).toBe('expanded')
      expect(two.restingExpanded).toBe(true)
      expect(two.frame().height).toBe(800)
    })

    it('a short drag up from the peek comes back; a fling down from expanded stops at the peek', () => {
      two.present()
      frames.run(120)
      two.beginDrag()
      two.drag(-100)
      two.release(0)
      frames.run(120)
      expect(two.restingDetent).toBe('collapsed')
      two.settleTo('expanded')
      frames.run(120)
      expect(two.frame().height).toBe(800)
      two.beginDrag()
      two.drag(30)
      two.release(1500)
      frames.run(120)
      expect(two.current).toEqual({ phase: 'open', progress: 0 })
      expect(two.frame().height).toBe(400)
      expect(closed).toBe(0)
    })

    it('below the peek the sheet slides down whole and the scrim thins', () => {
      two.present()
      frames.run(120)
      two.beginDrag()
      two.drag(100)
      expect(two.frame()).toEqual({ height: 400, translateY: 100, scrim: 0.75 })
      expect(two.current.progress).toBe(0.25)
    })

    it('follows re-measured detents unless a finger holds it', () => {
      const live = { collapsed: 400, expanded: 800 }
      const sheet = new SheetMotion({
        detents: () => live,
        onChange: (s) => states.push(s),
        onClosed: () => closed++
      })
      sheet.present()
      frames.run(120)
      live.collapsed = 300
      live.expanded = 300
      sheet.refresh()
      expect(sheet.current.phase).toBe('settling')
      frames.run(120)
      expect(sheet.frame().height).toBe(300)
      sheet.beginDrag()
      live.collapsed = 500
      live.expanded = 900
      sheet.refresh()
      expect(sheet.current.phase).toBe('dragging')
    })
  })

  /*
   * The sheet's presence `p` (`frame().scrim`, the page's recede) under a detent that moves
   * while the sheet rests – the keyboard coming up measures the peek above the keys, going
   * lowers it again (design language v2 draft §11.1, ruled 23:50): `p` is clamped at 1 once at
   * rest, the sheet follows on its own value and the recede never breathes with the keyboard;
   * a dismissal from the raised pose runs `p` 1 → 0 over the travel the sheet actually has
   * there, not over the detent it rested at before.
   */
  describe('p under a detent that moves at rest (the keyboard)', () => {
    const live = { collapsed: 300, expanded: 300 }
    let sheet: SheetMotion
    /** Every frame of the spring's remaining run, the scrim share after it. */
    const eachFrame = (fn: (scrim: number) => void): number => {
      let n = 0
      for (; n < 200 && frames.scheduled; n++) {
        frames.run(1)
        fn(sheet.frame().scrim)
      }
      return n
    }

    beforeEach(() => {
      live.collapsed = 300
      live.expanded = 300
      states = []
      sheet = new SheetMotion({
        detents: () => live,
        onChange: (s) => states.push(s),
        onClosed: () => closed++
      })
      sheet.present()
      frames.run(120)
      expect(sheet.frame()).toEqual({ height: 300, translateY: 0, scrim: 1 })
    })
    // A spring left running would be cranked by the next test's frames.
    afterEach(() => frames.run(300))

    it('the detent raised under a resting sheet moves the sheet on its own value while p holds at 1', () => {
      live.collapsed = 650
      live.expanded = 650
      sheet.refresh()
      expect(sheet.current.phase).toBe('settling')
      // The sheet grows up from the edge, laid out at the new height and pushed down the
      // difference; the page under it does not move by a hair.
      expect(sheet.frame()).toEqual({ height: 650, translateY: 350, scrim: 1 })
      const judged = eachFrame((scrim) => expect(scrim).toBe(1))
      expect(judged).toBeGreaterThan(5)
      expect(sheet.frame()).toEqual({ height: 650, translateY: 0, scrim: 1 })
      expect(sheet.current).toEqual({ phase: 'open', progress: 0 })
    })

    it('the detent lowered again (the keyboard going) is followed with p at 1 as well', () => {
      live.collapsed = 650
      live.expanded = 650
      sheet.refresh()
      frames.run(120)
      live.collapsed = 300
      live.expanded = 300
      sheet.refresh()
      expect(sheet.current.phase).toBe('settling')
      eachFrame((scrim) => expect(scrim).toBe(1))
      expect(sheet.frame()).toEqual({ height: 300, translateY: 0, scrim: 1 })
    })

    it('a dismissal from the raised pose runs p 1 → 0 over the travel the sheet actually has, not the detent it rested at before', () => {
      live.collapsed = 650
      live.expanded = 650
      sheet.refresh()
      frames.run(120)
      sheet.dismiss()
      let last = 1
      let below = 0
      eachFrame((scrim) => {
        const { translateY } = sheet.frame()
        // Measured over the 650 px the sheet stands at: with 300 it would sit at 1 until the
        // sheet had slid 350 px and then fall over the rest.
        if (translateY < 650) expect(scrim).toBeCloseTo(1 - translateY / 650, 6)
        expect(scrim).toBeLessThanOrEqual(last + 1e-9)
        expect(last - scrim).toBeLessThan(0.25)
        if (translateY > 300 && scrim > 0) below++
        last = scrim
      })
      expect(below).toBeGreaterThan(0)
      expect(closed).toBe(1)
      expect(sheet.current).toEqual(SHEET_CLOSED)
    })

    it('a dismissal that catches the follow in flight runs p from 1 over the travel from where the sheet is', () => {
      live.collapsed = 650
      live.expanded = 650
      sheet.refresh()
      frames.run(6)
      const caught = sheet.frame()
      expect(caught.scrim).toBe(1)
      const where = 650 - caught.translateY
      expect(where).toBeGreaterThan(300)
      expect(where).toBeLessThan(650)
      sheet.dismiss()
      // Nothing jumps: the first frames are a hair under 1, and every frame is the sheet's
      // height over the height it was caught at.
      let last = 1
      eachFrame((scrim) => {
        const visible = 650 - sheet.frame().translateY
        expect(scrim).toBeCloseTo(Math.min(1, Math.max(0, visible / where)), 6)
        expect(scrim).toBeLessThanOrEqual(last + 1e-9)
        expect(last - scrim).toBeLessThan(0.25)
        last = scrim
      })
      expect(closed).toBe(1)
    })

    it('a finger that catches the follow holds p where it is and drags it down over the travel from there', () => {
      live.collapsed = 650
      live.expanded = 650
      sheet.refresh()
      frames.run(6)
      const where = 650 - sheet.frame().translateY
      sheet.beginDrag()
      expect(sheet.frame().scrim).toBe(1)
      sheet.drag(where / 2)
      expect(sheet.frame().scrim).toBeCloseTo(0.5, 6)
      // Dragged back up past where it was caught: present in full, and no further.
      sheet.drag(-100)
      expect(sheet.frame().scrim).toBe(1)
    })

    it('a sheet still on its way in when the detent rises keeps running p over the travel it set out on, and clamps at 1', () => {
      const fresh = new SheetMotion({
        detents: () => live,
        onChange: (s) => states.push(s),
        onClosed: () => closed++
      })
      fresh.present()
      frames.run(4)
      const midway = fresh.frame().scrim
      expect(midway).toBeGreaterThan(0)
      expect(midway).toBeLessThan(1)
      live.collapsed = 650
      live.expanded = 650
      fresh.refresh()
      // No jump on the retarget…
      expect(fresh.frame().scrim).toBeCloseTo(midway, 6)
      let last = midway
      for (let i = 0; i < 200 && frames.scheduled; i++) {
        frames.run(1)
        const { scrim } = fresh.frame()
        // …p keeps rising to 1 and holds there while the sheet grows on to 650.
        expect(scrim).toBeGreaterThanOrEqual(last - 1e-9)
        last = scrim
      }
      expect(fresh.frame()).toEqual({ height: 650, translateY: 0, scrim: 1 })
      // At rest the travel is the height it stands at: a dismissal runs over all of it.
      fresh.dismiss()
      frames.run(3)
      const f = fresh.frame()
      expect(f.scrim).toBeCloseTo(1 - f.translateY / 650, 6)
    })
  })

  it('ignores gestures while closed and closes at once on demand', () => {
    expect(motion.beginDrag()).toBe(false)
    motion.drag(50)
    motion.release(0)
    motion.backProgress(0.5)
    motion.backCommit()
    motion.dismiss()
    expect(states).toEqual([])
    expect(closed).toBe(0)

    motion.present()
    frames.run(2)
    motion.close()
    expect(motion.current).toEqual(SHEET_CLOSED)
    expect(closed).toBe(1)
    expect(frames.scheduled).toBe(false)
    motion.close()
    expect(closed).toBe(1)
  })
})

// A phone: 914 CSS px tall layer, 24 px of status bar.
const layer = 914
const insetTop = 24
const two = computeDetents(1000, layer, insetTop)

describe('computeDetents', () => {
  it('a tall sheet peeks at about half the screen and expands to the top margin', () => {
    expect(two.collapsed).toBe(Math.round(layer * 0.52))
    expect(two.expanded).toBe(sheetMaxHeight(layer, insetTop))
    expect(two.expanded).toBeLessThan(layer - insetTop)
  })

  it('content that fits gets a single detent at its own height', () => {
    const one = computeDetents(320, layer, insetTop)
    expect(one).toEqual({ collapsed: 320, expanded: 320 })
  })

  it('content barely taller than the peek is not worth a second stop', () => {
    const peek = Math.round(layer * 0.52)
    const one = computeDetents(peek + 40, layer, insetTop)
    expect(one.collapsed).toBe(one.expanded)
    expect(one.expanded).toBe(peek + 40)
  })

  it('never asks for more than the layer minus the inset and margin', () => {
    expect(computeDetents(5000, layer, insetTop).expanded).toBe(sheetMaxHeight(layer, insetTop))
    expect(sheetMaxHeight(100, 200)).toBe(0)
  })
})

describe('computeDetents for a list body (§9.20)', () => {
  it('a sheet whose body is a list stands at most 80 % of the layer, under the top margin', () => {
    expect(SHEET_LIST_MAX_SHARE).toBe(0.8)
    const list = computeDetents(5000, layer, insetTop, 0, 'list')
    expect(list.expanded).toBe(Math.round(layer * 0.8))
    expect(list.expanded).toBeLessThan(sheetMaxHeight(layer, insetTop))
    expect(sheetMaxHeight(layer, insetTop, 'list')).toBe(Math.round(layer * 0.8))
    // The peek is the same peek: the cap is on the expanded detent alone.
    expect(list.collapsed).toBe(two.collapsed)
  })

  it('a list that fits under the cap stands at its own height, and a content body keeps the top margin', () => {
    expect(computeDetents(600, layer, insetTop, 0, 'list')).toEqual(
      computeDetents(600, layer, insetTop)
    )
    expect(computeDetents(5000, layer, insetTop, 0, 'content').expanded).toBe(
      sheetMaxHeight(layer, insetTop)
    )
  })

  it('on a short layer the top margin is the tighter bound and still holds', () => {
    // 300 tall under 24 of status bar: the margin leaves 236; 80 % would be 240.
    expect(sheetMaxHeight(300, insetTop, 'list')).toBe(236)
    expect(sheetMaxHeight(300, insetTop)).toBe(236)
  })
})

// The keyboard: 340 CSS px of it, reported as the bottom inset, over a 24 px gesture bar.
const keyboard = 340
const bar = 24

describe('computeDetents above the bottom inset', () => {
  it('the peek shows its share of the room above the inset, and pads for the inset underneath', () => {
    const withBar = computeDetents(1000, layer, insetTop, bar)
    expect(withBar.collapsed).toBe(bar + Math.round((layer - bar) * SHEET_PEEK_FRACTION))
    const withKeys = computeDetents(1000, layer, insetTop, keyboard)
    expect(withKeys.collapsed).toBe(keyboard + Math.round((layer - keyboard) * SHEET_PEEK_FRACTION))
    // The room above the keys is the same share of what is left, not what is left of the old peek.
    expect(withKeys.collapsed - keyboard).toBe(Math.round((layer - keyboard) * SHEET_PEEK_FRACTION))
    expect(withKeys.collapsed - keyboard).toBeGreaterThan(withBar.collapsed - keyboard)
    // Without an inset nothing changes.
    expect(computeDetents(1000, layer, insetTop, 0)).toEqual(two)
    expect(computeDetents(1000, layer, insetTop)).toEqual(two)
  })

  it('the expanded detent is the content or the top margin, whatever the inset', () => {
    expect(computeDetents(1000, layer, insetTop, keyboard).expanded).toBe(two.expanded)
    expect(computeDetents(600, layer, insetTop, keyboard).expanded).toBe(600)
  })

  it('a form the keyboard leaves only a little taller than the peek stands at one detent, all of it in view', () => {
    const peek = keyboard + Math.round((layer - keyboard) * SHEET_PEEK_FRACTION)
    const one = computeDetents(peek + SHEET_MIN_DETENT_GAP - 1, layer, insetTop, keyboard)
    expect(one.collapsed).toBe(one.expanded)
    expect(one.expanded).toBe(peek + SHEET_MIN_DETENT_GAP - 1)
    // Content taller than that keeps its two stops.
    const still = computeDetents(peek + SHEET_MIN_DETENT_GAP, layer, insetTop, keyboard)
    expect(still.collapsed).toBe(peek)
    expect(still.expanded).toBe(peek + SHEET_MIN_DETENT_GAP)
  })

  it('an inset taller than the layer is clamped, never a negative room', () => {
    const d = computeDetents(1000, layer, insetTop, layer + 100)
    expect(d.collapsed).toBe(d.expanded)
    expect(d.expanded).toBe(two.expanded)
  })
})

describe('a focused field above the keyboard', () => {
  const detents = computeDetents(1000, layer, insetTop, keyboard)
  const room = (detent: number): number => detent - keyboard - SHEET_FIELD_MARGIN

  it('fieldOverflow is how far the field reaches under the keys at a detent, 0 when it is in view', () => {
    expect(fieldOverflow(room(detents.collapsed), detents.collapsed, keyboard)).toBe(0)
    expect(fieldOverflow(room(detents.collapsed) + 10, detents.collapsed, keyboard)).toBe(10)
    expect(fieldOverflow(room(detents.collapsed) + 10, detents.expanded, keyboard)).toBe(0)
    expect(fieldOverflow(room(detents.expanded) + 32, detents.expanded, keyboard)).toBe(32)
    // No keyboard: the whole detent is room, less the margin.
    expect(fieldOverflow(detents.collapsed - SHEET_FIELD_MARGIN, detents.collapsed, 0)).toBe(0)
  })

  it('the sheet expands for a field under the keys at its peek, and stays for one in view', () => {
    const under = room(detents.collapsed) + 1
    expect(detentForField(under, detents, keyboard, 'collapsed')).toBe('expanded')
    expect(detentForField(room(detents.collapsed), detents, keyboard, 'collapsed')).toBe(
      'collapsed'
    )
    // Already expanded: nothing taller to go to; the body scrolls the field into view instead.
    expect(detentForField(room(detents.expanded) + 40, detents, keyboard, 'expanded')).toBe(
      'expanded'
    )
  })

  it('a sheet with one detent has nowhere to expand to', () => {
    const one = computeDetents(600, layer, insetTop, keyboard)
    expect(one.collapsed).toBe(one.expanded)
    expect(detentForField(room(one.collapsed) + 50, one, keyboard, 'collapsed')).toBe('collapsed')
  })
})

describe('sheetFrame', () => {
  it('between the detents the sheet grows in place and the scrim is fully on', () => {
    const at = sheetFrame(600, two)
    expect(at).toEqual({ height: 600, translateY: 0, scrim: 1 })
    expect(sheetFrame(two.expanded, two).height).toBe(two.expanded)
  })

  it('below the peek detent the sheet slides down whole and the scrim thins with it', () => {
    const half = sheetFrame(two.collapsed / 2, two)
    expect(half.height).toBe(two.collapsed)
    expect(half.translateY).toBe(two.collapsed / 2)
    expect(half.scrim).toBeCloseTo(0.5)
    const gone = sheetFrame(0, two)
    expect(gone.translateY).toBe(two.collapsed)
    expect(gone.scrim).toBe(0)
  })

  it('an overshooting spring below zero reads as fully off screen', () => {
    expect(sheetFrame(-12, two)).toEqual(sheetFrame(0, two))
  })
})

describe('sheetDragPosition', () => {
  it('follows the finger one to one between the detents', () => {
    expect(sheetDragPosition(two.collapsed, 100, two)).toBe(two.collapsed + 100)
    expect(sheetDragPosition(two.collapsed, -100, two)).toBe(two.collapsed - 100)
  })

  it('cannot be pushed below the screen edge', () => {
    expect(sheetDragPosition(two.collapsed, -two.collapsed - 300, two)).toBe(0)
  })

  it('resists past the expanded detent and never stretches more than the overdrag', () => {
    const a = sheetDragPosition(two.expanded, 60, two)
    const b = sheetDragPosition(two.expanded, 400, two)
    expect(a).toBeGreaterThan(two.expanded)
    expect(a).toBeLessThan(two.expanded + 60)
    expect(b).toBeGreaterThan(a)
    expect(b).toBeLessThan(two.expanded + SHEET_OVERDRAG)
  })
})

describe('settleDetent', () => {
  it('a slow release goes to the nearest detent', () => {
    expect(settleDetent(two.collapsed + 40, 0, two)).toBe(two.collapsed)
    expect(settleDetent(two.expanded - 40, 0, two)).toBe(two.expanded)
    expect(settleDetent(two.collapsed * 0.7, 0, two)).toBe(two.collapsed)
    expect(settleDetent(two.collapsed * 0.3, 0, two)).toBe(0)
  })

  it('a fling goes to the next detent in its own direction', () => {
    expect(settleDetent(two.collapsed + 20, 900, two)).toBe(two.expanded)
    expect(settleDetent(two.collapsed, 900, two)).toBe(two.expanded)
    expect(settleDetent(two.expanded - 20, -900, two)).toBe(two.collapsed)
    expect(settleDetent(two.expanded, -900, two)).toBe(two.collapsed)
    expect(settleDetent(two.collapsed, -900, two)).toBe(0)
  })

  it('a mid-drag reversal lands where the finger was heading, not where it started', () => {
    // Dragged most of the way up from the peek, then flicked back down: peek again.
    expect(settleDetent(two.expanded - 60, -700, two)).toBe(two.collapsed)
    // Pulled far down from the peek, then flicked back up: peek, not dismissed.
    expect(settleDetent(two.collapsed * 0.4, 700, two)).toBe(two.collapsed)
  })

  it('projects a slow velocity into the decision', () => {
    const mid = two.collapsed / 2
    expect(settleDetent(mid + 10, -300, two)).toBe(0)
    expect(settleDetent(mid - 10, 300, two)).toBe(two.collapsed)
  })

  it('a single-detent sheet only knows open and dismissed', () => {
    const one = computeDetents(320, layer, insetTop)
    expect(settleDetent(320, 900, one)).toBe(320)
    expect(settleDetent(320, -900, one)).toBe(0)
    expect(settleDetent(200, 0, one)).toBe(320)
    expect(settleDetent(100, 0, one)).toBe(0)
  })

  it('never settles above the expanded detent after an overdrag', () => {
    expect(settleDetent(two.expanded + 40, 1500, two)).toBe(two.expanded)
    expect(settleDetent(two.expanded + 40, 0, two)).toBe(two.expanded)
  })
})

describe('sheetBackPosition', () => {
  it('pulls the sheet down with the gesture but keeps it on screen', () => {
    expect(sheetBackPosition(500, 0)).toBe(500)
    expect(sheetBackPosition(500, 0.5)).toBe(500 * (1 - BACK_PEEK / 2))
    expect(sheetBackPosition(500, 1)).toBe(500 * (1 - BACK_PEEK))
    expect(sheetBackPosition(500, 1)).toBeGreaterThan(250)
  })

  it('clamps progress to the unit range', () => {
    expect(sheetBackPosition(500, -1)).toBe(500)
    expect(sheetBackPosition(500, 3)).toBe(sheetBackPosition(500, 1))
  })
})
