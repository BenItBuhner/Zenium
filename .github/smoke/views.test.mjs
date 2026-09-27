import { describe, expect, it } from 'vitest'
import { isPopupSurfaceUrl, isWindowChromeUrl, parkedInCorner, viewInBox } from './views.mjs'

const content = { width: 1280, height: 820 }
const box = { x: 240, y: 48, width: 1032, height: 764 }

describe('parkedInCorner', () => {
  it('reads a box moved so one corner pixel of it is inside the window, in any of its corners', () => {
    // `ElectronTabView.parkedBox`: bottom-right, bottom-left, top-right, top-left.
    expect(parkedInCorner({ ...box, x: 1279, y: 819 }, content)).toBe(true)
    expect(parkedInCorner({ ...box, x: -(box.width - 1), y: 819 }, content)).toBe(true)
    expect(parkedInCorner({ ...box, x: 1279, y: -(box.height - 1) }, content)).toBe(true)
    expect(parkedInCorner({ ...box, x: -(box.width - 1), y: -(box.height - 1) }, content)).toBe(
      true
    )
  })
  it('refuses a box in place, one only partly out, and one wholly out of the window', () => {
    expect(parkedInCorner(box, content)).toBe(false)
    expect(parkedInCorner({ ...box, x: 1000 }, content)).toBe(false)
    expect(parkedInCorner({ ...box, x: 1280, y: 820 }, content)).toBe(false)
    expect(parkedInCorner({ ...box, x: 1278, y: 819 }, content)).toBe(false)
  })
  it('is false with no box or no window to measure against', () => {
    expect(parkedInCorner(null, content)).toBe(false)
    expect(parkedInCorner(box, null)).toBe(false)
  })
})

describe('viewInBox', () => {
  it('is true for a shown view in its box only', () => {
    expect(viewInBox({ visible: true, bounds: box }, content)).toBe(true)
  })
  it('is false for a hidden view and for a parked one alike: the page is behind its picture', () => {
    expect(viewInBox({ visible: false, bounds: box }, content)).toBe(false)
    expect(viewInBox({ visible: true, bounds: { ...box, x: 1279, y: 819 } }, content)).toBe(false)
  })
  it('is null with no view', () => {
    expect(viewInBox(undefined, content)).toBeNull()
  })
})

// The build's chrome document as the Linux job, a Windows install and a dev tree load it.
const CHROME_URL =
  'file:///home/runner/work/Zenium/dist/linux-unpacked/resources/app.asar/out/renderer/index.html'
const WIN_CHROME_URL =
  'file:///C:/Program%20Files/Zenium/resources/app.asar/out/renderer/index.html'
const POPUP_SURFACE_URL = `${CHROME_URL}?surface=popup`

describe('isPopupSurfaceUrl', () => {
  it('reads the popup surface’s document – index.html with a surface query – and nothing else', () => {
    expect(isPopupSurfaceUrl(POPUP_SURFACE_URL)).toBe(true)
    expect(isPopupSurfaceUrl(`${WIN_CHROME_URL}?surface=popup`)).toBe(true)
    expect(isPopupSurfaceUrl(`${CHROME_URL}?chrome=popup&surface=popup`)).toBe(true)
    expect(isPopupSurfaceUrl(CHROME_URL)).toBe(false)
    expect(isPopupSurfaceUrl(`${CHROME_URL}?chrome=popup`)).toBe(false)
    expect(isPopupSurfaceUrl(`${CHROME_URL}#surface=popup`)).toBe(false)
    expect(isPopupSurfaceUrl('http://127.0.0.1:4000/index.html?surface=popup')).toBe(false)
    expect(isPopupSurfaceUrl('zen://newtab/')).toBe(false)
    expect(isPopupSurfaceUrl(undefined)).toBe(false)
  })
})

describe('isWindowChromeUrl', () => {
  it('reads a window’s chrome page from the build, with or without a query', () => {
    expect(isWindowChromeUrl(CHROME_URL)).toBe(true)
    expect(isWindowChromeUrl(WIN_CHROME_URL)).toBe(true)
    expect(isWindowChromeUrl(`${CHROME_URL}?chrome=popup`)).toBe(true)
  })
  it('refuses the popup surface’s document, the pages and devtools', () => {
    expect(isWindowChromeUrl(POPUP_SURFACE_URL)).toBe(false)
    expect(isWindowChromeUrl('http://127.0.0.1:4000/first.html')).toBe(false)
    expect(isWindowChromeUrl('zen://newtab/')).toBe(false)
    expect(isWindowChromeUrl('devtools://devtools/bundled/devtools_app.html')).toBe(false)
    expect(isWindowChromeUrl('')).toBe(false)
    expect(isWindowChromeUrl(null)).toBe(false)
  })
})
