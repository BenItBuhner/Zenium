import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOOLBAR_PINS,
  isToolbarControl,
  sanitizeToolbarPins,
  TOOLBAR_CONTROLS,
  toolbarCustomized,
  toolbarDefaultPinned,
  toolbarPinned,
  withToolbarPin
} from '../toolbarPins'

/**
 * The desktop toolbar's pins (Settings › Look and Feel › Customise toolbar, settings-36): the
 * record of departures the core sanitises on read (`state.ts`, `browser.ts`), the chrome reads
 * (`NavRow`) and the dialog writes (`CustomizeToolbarForm`). Home (settings-32; W8-3) is the
 * one control folded by default – Chrome's `browser.show_home_button` is false until asked.
 */
describe('toolbarPins (settings-36)', () => {
  it('lists the optional controls in the bar’s order – Forward, Home, the pill’s chips left to right (the Install-app chip before the star, Chrome’s page-action order; W8-6), the Energy Saver leaf, the hub', () => {
    // Home ahead of the pill (W8-3): Chrome's toolbar is Back, Forward, Reload, Home, then the
    // location bar. The leaf ahead of the hub (W8-2): Chrome's toolbar puts its battery saver
    // button before its media button (`ToolbarView::Init`).
    expect(TOOLBAR_CONTROLS).toEqual([
      'forward',
      'home',
      'reader',
      'translate',
      'install',
      'star',
      'energy-saver',
      'media'
    ])
    expect(isToolbarControl('install')).toBe(true)
    // The Share chip is a hover-only utility with Copy URL and Boost, not a pin.
    expect(isToolbarControl('share')).toBe(false)
    expect(isToolbarControl('forward')).toBe(true)
    expect(isToolbarControl('home')).toBe(true)
    expect(isToolbarControl('energy-saver')).toBe(true)
    // Back, Reload, the pill and the menu are the bar, not its options; downloads is the
    // downloads block's own key.
    for (const never of ['back', 'reload', 'menu', 'pill', 'downloads', 'extensions'])
      expect(isToolbarControl(never)).toBe(false)
  })

  it('reads the default bar from an empty record, an absent one and the default: every control pinned but Home', () => {
    for (const control of TOOLBAR_CONTROLS) {
      const expected = control !== 'home'
      expect(toolbarDefaultPinned(control)).toBe(expected)
      expect(toolbarPinned(undefined, control)).toBe(expected)
      expect(toolbarPinned({}, control)).toBe(expected)
      expect(toolbarPinned(DEFAULT_TOOLBAR_PINS, control)).toBe(expected)
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

  it('Home departs the other way: showing it writes true (Chrome’s show_home_button on), hiding it removes the key', () => {
    const shown = withToolbarPin(undefined, 'home', true)
    expect(shown).toEqual({ home: true })
    expect(toolbarPinned(shown, 'home')).toBe(true)
    expect(toolbarCustomized(shown)).toBe(true)
    expect(withToolbarPin(shown, 'home', false)).toEqual({})
    // Its default written out is no departure.
    expect(withToolbarPin(undefined, 'home', false)).toEqual({})
    // A record from before Home was a control keeps its folds and shows no Home button.
    expect(toolbarPinned({ forward: false }, 'home')).toBe(false)
  })

  it('sanitises a stored record to the known controls’ departures and nothing else', () => {
    expect(sanitizeToolbarPins(undefined)).toEqual({})
    expect(sanitizeToolbarPins(null)).toEqual({})
    expect(sanitizeToolbarPins('forward')).toEqual({})
    expect(sanitizeToolbarPins(['forward'])).toEqual({})
    expect(sanitizeToolbarPins({ forward: false, star: false, home: true })).toEqual({
      forward: false,
      star: false,
      home: true
    })
    // A default written out is not kept; a non-boolean or an unknown key reads as no departure.
    expect(
      sanitizeToolbarPins({
        forward: true,
        star: 'no',
        media: 0,
        home: false,
        extensions: false
      })
    ).toEqual({})
    expect(sanitizeToolbarPins({ home: 'yes' })).toEqual({})
    // The sanitised record is a copy.
    const raw = { forward: false }
    expect(sanitizeToolbarPins(raw)).not.toBe(raw)
  })
})
