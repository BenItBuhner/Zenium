import { describe, expect, it } from 'vitest'
import type { Rect } from '../../../shared/types'
import { centredOver, planFramedWindow, type DisplayArea } from '../windowPlacement'

/**
 * The task manager's window is framed by the OS (`WindowChrome` `page`), so its sizes come in
 * two kinds: the page's (content) and the frame's (outer: the page plus a title bar and
 * borders). `planFramedWindow` keeps them apart – the window is BUILT from content sizes
 * (`useContentSize`), so the default and the 480×320 minimum are of the page on every OS (the
 * page's default is `window.ts`'s 736×518; the plan is size-agnostic and this file feeds it a
 * 760×520 stand-in, the frames below sized round that); its
 * REMEMBERED bounds are outer (`getNormalBounds`) and go back as outer (`setBounds`), never as
 * a content size, which would grow the window by a frame on every open; and a first open
 * centres the FRAME over the window it was asked from. The harness cannot measure a Windows or
 * macOS frame, so the semantics live here, with the frames Windows 11, macOS and X11 add.
 */

const primary: DisplayArea = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1050 } }
const right: DisplayArea = { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 720 } }
const base = { minWidth: 480, minHeight: 320, defaultSize: { width: 760, height: 520 } }
const CONTENT = { width: 760, height: 520 }
/** Windows 11: 8-px borders and a 31-px caption round the 760×520 page. */
const WINDOWS_FRAME = { width: 776, height: 559 }
/** macOS: the 28-px title bar. */
const MAC_FRAME = { width: 760, height: 548 }
/** X11: the client rectangle alone – the window manager's frame comes later, unmeasured. */
const X11_FRAME = { width: 760, height: 520 }
const FRAMES = [WINDOWS_FRAME, MAC_FRAME, X11_FRAME]

function centre(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

describe('planFramedWindow', () => {
  it('builds a first open from CONTENT sizes: the default of page (the fixture’s 760×520), no smaller than 480×320 of page, on every OS', () => {
    const opener = { x: 100, y: 60, width: 1400, height: 900 }
    const plan = planFramedWindow({ ...base, saved: null, displayId: 1, anchor: opener }, [
      primary,
      right
    ])
    expect(plan.options).toEqual({
      x: 420,
      y: 250,
      width: 760,
      height: 520,
      minWidth: 480,
      minHeight: 320,
      useContentSize: true
    })
  })

  it('centres the FRAME over the opener once the OS has drawn it – Windows, macOS and X11 frames alike', () => {
    const opener = { x: 100, y: 60, width: 1400, height: 900 }
    const plan = planFramedWindow({ ...base, saved: null, displayId: 1, anchor: opener }, [
      primary,
      right
    ])
    expect(plan.outerBounds(WINDOWS_FRAME)).toEqual({ x: 412, y: 231, width: 776, height: 559 })
    expect(plan.outerBounds(MAC_FRAME)).toEqual({ x: 420, y: 236, width: 760, height: 548 })
    expect(plan.outerBounds(X11_FRAME)).toEqual({ x: 420, y: 250, width: 760, height: 520 })
    // The frame's centre is the opener's (to the half pixel), whatever the frame; the guess the
    // window was built with is the X11 one, where nothing is known of the frame at build time.
    for (const frame of FRAMES) {
      const outer = plan.outerBounds(frame)
      expect(outer.width).toBe(frame.width)
      expect(outer.height).toBe(frame.height)
      expect(Math.abs(centre(outer).x - centre(opener).x)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(centre(outer).y - centre(opener).y)).toBeLessThanOrEqual(0.5)
    }
    expect(plan.outerBounds(X11_FRAME)).toMatchObject({ x: plan.options.x, y: plan.options.y })
  })

  it('keeps the centred frame inside the opener’s display, and no larger than its work area with the page no smaller than its minimum', () => {
    // An opener at the bottom right: the frame centred over it would hang over both edges.
    const opener = { x: 1500, y: 700, width: 800, height: 600 }
    const plan = planFramedWindow({ ...base, saved: null, displayId: 1, anchor: opener }, [
      primary,
      right
    ])
    expect(plan.outerBounds(WINDOWS_FRAME)).toEqual({ x: 1144, y: 491, width: 776, height: 559 })
    // A display smaller than the frame: the frame is the work area, the page inside it (700×500
    // here, still above the 480×320 minimum).
    const small: DisplayArea = { id: 3, workArea: { x: 0, y: 0, width: 700, height: 500 } }
    const cramped = planFramedWindow({ ...base, saved: null, displayId: null, anchor: null }, [
      small
    ])
    expect(cramped.options).toMatchObject({ x: 0, y: 0, width: 700, height: 500 })
    expect(cramped.outerBounds(WINDOWS_FRAME)).toEqual({ x: 0, y: 0, width: 700, height: 500 })
  })

  it('brings REMEMBERED bounds back as the outer rectangle they were saved as – exactly, whatever the frame, open after open', () => {
    const saved = { x: 2000, y: 40, width: 900, height: 640 }
    const plan = planFramedWindow({ ...base, saved, displayId: 2, anchor: null }, [primary, right])
    // Built from the content default and the content minimum at the saved place: the sizes are
    // never the saved (outer) ones read as content, which is where a frame's growth would come from.
    expect(plan.options).toEqual({
      x: 2000,
      y: 40,
      width: 760,
      height: 520,
      minWidth: 480,
      minHeight: 320,
      useContentSize: true
    })
    for (const frame of FRAMES) expect(plan.outerBounds(frame)).toEqual(saved)
    // Saved outer → set outer → saved outer …: three opens on Windows land on the same rectangle.
    let bounds = saved
    for (let i = 0; i < 3; i++) {
      bounds = planFramedWindow({ ...base, saved: bounds, displayId: 2, anchor: null }, [
        primary,
        right
      ]).outerBounds(WINDOWS_FRAME)
      expect(bounds).toEqual(saved)
    }
  })

  it('fits remembered bounds into their display as any window’s: nudged back in, or centred on the primary when their screen is gone', () => {
    const hanging = planFramedWindow(
      { ...base, saved: { x: 2800, y: 500, width: 1000, height: 600 }, displayId: 2, anchor: null },
      [primary, right]
    )
    expect(hanging.outerBounds(MAC_FRAME)).toEqual({ x: 2200, y: 120, width: 1000, height: 600 })
    const unplugged = planFramedWindow(
      { ...base, saved: { x: 4000, y: 100, width: 800, height: 500 }, displayId: 9, anchor: null },
      [primary, right]
    )
    expect(unplugged.outerBounds(MAC_FRAME)).toEqual({ x: 560, y: 275, width: 800, height: 500 })
    // Where the frame lands is fixed by the saved rectangle alone: the options only carry it.
    expect(unplugged.options).toMatchObject({ x: 560, y: 275, width: 760, height: 520 })
  })

  it('centres on the primary display without an opener, and sits at the origin with no display known', () => {
    const plan = planFramedWindow({ ...base, saved: null, displayId: null, anchor: null }, [
      primary,
      right
    ])
    expect(plan.options).toMatchObject({ x: 580, y: 265, ...CONTENT, useContentSize: true })
    expect(plan.outerBounds(WINDOWS_FRAME)).toEqual({ x: 572, y: 246, width: 776, height: 559 })
    const bare = planFramedWindow({ ...base, saved: null, displayId: null, anchor: null }, [])
    expect(bare.options).toMatchObject({ x: 0, y: 0, ...CONTENT, useContentSize: true })
    expect(bare.outerBounds(WINDOWS_FRAME)).toEqual({ x: 0, y: 0, width: 776, height: 559 })
  })
})

describe('centredOver', () => {
  it('puts a size’s centre on the anchor’s, keeping the size whole however small the anchor', () => {
    expect(centredOver({ x: 100, y: 60, width: 1400, height: 900 }, CONTENT)).toEqual({
      x: 420,
      y: 250,
      width: 760,
      height: 520
    })
    // An opener smaller than the task manager: the window is not shrunk to it.
    expect(centredOver({ x: 500, y: 300, width: 400, height: 300 }, CONTENT)).toEqual({
      x: 320,
      y: 190,
      width: 760,
      height: 520
    })
  })
})
