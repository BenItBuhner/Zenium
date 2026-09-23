import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOOLBAR_PINS,
  isToolbarControl,
  sanitizeToolbarPins,
  TOOLBAR_CONTROLS,
  toolbarCustomized,
  toolbarPinned,
  withToolbarPin
} from '../toolbarPins'

/**
 * The desktop toolbar's pins (Settings › Look and Feel › Customize toolbar, settings-36): the
 * record of departures the core sanitises on read (`state.ts`, `browser.ts`), the chrome reads
 * (`NavRow`) and the dialog writes (`CustomizeToolbarForm`).
 */
describe('toolbarPins (settings-36)', () => {
  it('lists the optional controls in the bar’s order – Forward, the pill’s chips left to right, the hub', () => {
    expect(TOOLBAR_CONTROLS).toEqual(['forward', 'reader', 'translate', 'star', 'media'])
    expect(isToolbarControl('forward')).toBe(true)
    // Back, Reload, the pill and the menu are the bar, not its options; downloads is the
    // downloads block's own key.
    for (const never of ['back', 'reload', 'menu', 'pill', 'downloads', 'extensions', 'home'])
      expect(isToolbarControl(never)).toBe(false)
  })

  it('reads every control pinned from an empty record, an absent one and the default', () => {
    for (const control of TOOLBAR_CONTROLS) {
      expect(toolbarPinned(undefined, control)).toBe(true)
      expect(toolbarPinned({}, control)).toBe(true)
      expect(toolbarPinned(DEFAULT_TOOLBAR_PINS, control)).toBe(true)
    }
    expect(toolbarCustomized(undefined)).toBe(false)
    expect(toolbarCustomized({})).toBe(false)
  })

  it('keeps the departures alone: a fold writes false, a pin removes the key rather than writing true', () => {
    const folded = withToolbarPin(undefined, 'forward', false)
    expect(folded).toEqual({ forward: false })
    expect(toolbarPinned(folded, 'forward')).toBe(false)
    expect(toolbarPinned(folded, 'star')).toBe(true)
    expect(toolbarCustomized(folded)).toBe(true)
    const both = withToolbarPin(folded, 'media', false)
    expect(both).toEqual({ forward: false, media: false })
    // The input record is never mutated (a settings snapshot is the renderer's to read only).
    expect(folded).toEqual({ forward: false })
    expect(withToolbarPin(both, 'forward', true)).toEqual({ media: false })
    expect(withToolbarPin(withToolbarPin(both, 'forward', true), 'media', true)).toEqual({})
  })

  it('sanitises a stored record to the known controls’ folds and nothing else', () => {
    expect(sanitizeToolbarPins(undefined)).toEqual({})
    expect(sanitizeToolbarPins(null)).toEqual({})
    expect(sanitizeToolbarPins('forward')).toEqual({})
    expect(sanitizeToolbarPins(['forward'])).toEqual({})
    expect(sanitizeToolbarPins({ forward: false, star: false })).toEqual({
      forward: false,
      star: false
    })
    // A `true` is the default and is not kept; a non-boolean or an unknown key reads pinned.
    expect(
      sanitizeToolbarPins({ forward: true, star: 'no', media: 0, home: false, extensions: false })
    ).toEqual({})
    // The sanitised record is a copy.
    const raw = { forward: false }
    expect(sanitizeToolbarPins(raw)).not.toBe(raw)
  })
})
