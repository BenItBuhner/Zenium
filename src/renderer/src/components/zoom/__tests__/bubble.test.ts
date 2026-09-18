import { describe, expect, it } from 'vitest'
import type { PageControlsSettings, PageEnvironment, Tab } from '@shared/types'
import { DEFAULT_PAGE_CONTROLS, DEFAULT_PAGE_ENVIRONMENT } from '@shared/pageControls'
import {
  BUBBLE_AFTER_CLICK_MS,
  BUBBLE_AUTO_CLOSE_MS,
  WheelZoom,
  bubbleTimeout,
  defaultZoomFor,
  isZoomed
} from '../bubble'

const settings: PageControlsSettings = DEFAULT_PAGE_CONTROLS
const env: PageEnvironment = DEFAULT_PAGE_ENVIRONMENT

function tab(url: string, zoom: number): Tab {
  return { url, zoom } as Tab
}

describe('the zoom bubble clock', () => {
  it("stays 1.5 s after a zoom step, Chrome's time", () => {
    expect(bubbleTimeout({ source: 'auto', hovered: false, clicked: false })).toBe(
      BUBBLE_AUTO_CLOSE_MS
    )
    expect(BUBBLE_AUTO_CLOSE_MS).toBe(1500)
  })

  it('waits 5 s once one of its buttons was pressed', () => {
    expect(bubbleTimeout({ source: 'auto', hovered: false, clicked: true })).toBe(
      BUBBLE_AFTER_CLICK_MS
    )
    expect(BUBBLE_AFTER_CLICK_MS).toBe(5000)
  })

  it('pauses while the pointer is over it', () => {
    expect(bubbleTimeout({ source: 'auto', hovered: true, clicked: false })).toBeNull()
    expect(bubbleTimeout({ source: 'auto', hovered: true, clicked: true })).toBeNull()
  })

  it('stays until dismissed when the chip opened it', () => {
    expect(bubbleTimeout({ source: 'chip', hovered: false, clicked: false })).toBeNull()
    expect(bubbleTimeout({ source: 'chip', hovered: false, clicked: true })).toBeNull()
  })
})

describe('the zoom chip', () => {
  it('shows for a web page away from the default zoom', () => {
    expect(isZoomed(tab('https://example.com/', 1), settings, env)).toBe(false)
    expect(isZoomed(tab('https://example.com/', 1.1), settings, env)).toBe(true)
    expect(isZoomed(tab('https://example.com/', 0.9), settings, env)).toBe(true)
  })

  it('counts the default zoom of the settings as not zoomed', () => {
    const at125 = { ...settings, zoom: 1.25 }
    expect(defaultZoomFor('https://example.com/', at125, env)).toBe(1.25)
    expect(isZoomed(tab('https://example.com/', 1.25), at125, env)).toBe(false)
    expect(isZoomed(tab('https://example.com/', 1), at125, env)).toBe(true)
  })

  it('ignores a site exception when working out the default', () => {
    const remembered = { ...settings, siteZooms: { 'example.com': 1.5 } }
    expect(defaultZoomFor('https://example.com/', remembered, env)).toBe(1)
    expect(isZoomed(tab('https://example.com/', 1.5), remembered, env)).toBe(true)
  })

  it('folds the system font size into the default where the settings say so', () => {
    const scaled = { ...env, fontScale: 1.3 }
    expect(defaultZoomFor('https://example.com/', settings, scaled)).toBe(1.3)
    expect(isZoomed(tab('https://example.com/', 1.3), settings, scaled)).toBe(false)
    const plain = { ...settings, zoomIncludesOsFontSize: false }
    expect(defaultZoomFor('https://example.com/', plain, scaled)).toBe(1)
  })

  it('measures internal pages and files against 100 percent', () => {
    const at125 = { ...settings, zoom: 1.25 }
    expect(defaultZoomFor('zen://settings', at125, env)).toBe(1)
    expect(isZoomed(tab('zen://settings', 1), at125, env)).toBe(false)
    expect(isZoomed(tab('file:///tmp/a.html', 1.1), at125, env)).toBe(true)
  })
})

describe('Ctrl+wheel', () => {
  it('turns one wheel notch into one step, up zooming in', () => {
    const wheel = new WheelZoom()
    expect(wheel.step(-53)).toBe(1)
    expect(wheel.step(53)).toBe(-1)
    expect(wheel.step(-100)).toBe(1)
    expect(wheel.step(120)).toBe(-1)
  })

  it('gathers the small deltas of a trackpad pinch into one step', () => {
    const wheel = new WheelZoom()
    expect(wheel.step(-10)).toBe(0)
    expect(wheel.step(-15)).toBe(0)
    expect(wheel.step(-20)).toBe(0)
    expect(wheel.step(-10)).toBe(1)
    // The notch is spent: the next one gathers afresh.
    expect(wheel.step(-10)).toBe(0)
  })

  it('starts over when the wheel turns the other way', () => {
    const wheel = new WheelZoom()
    expect(wheel.step(-40)).toBe(0)
    expect(wheel.step(30)).toBe(0)
    expect(wheel.step(25)).toBe(-1)
  })

  it('does nothing for a delta of zero', () => {
    const wheel = new WheelZoom()
    expect(wheel.step(0)).toBe(0)
    expect(wheel.step(-40)).toBe(0)
    expect(wheel.step(0)).toBe(0)
    expect(wheel.step(-10)).toBe(1)
  })
})
