import { describe, expect, it } from 'vitest'
import {
  CAPTURE_MAX_HEIGHT,
  CAPTURE_MAX_PIXELS,
  CAPTURE_TOO_LARGE,
  CaptureTooLargeError,
  captureArea,
  captureBudget,
  captureErrorMessage,
  captureExtension,
  imageDimensions,
  isCaptureTooLarge,
  parseImageDataUrl,
  parsePageViewport,
  regionFromChrome,
  screenshotFileName,
  type PageViewport
} from '../capture'

/** A 1280 × 720 viewport over a 1280 × 4000 document, scrolled 600 down, at 100 % on a plain display. */
const plain: PageViewport = {
  scrollX: 0,
  scrollY: 600,
  width: 1280,
  height: 720,
  zoom: 1,
  devicePixelRatio: 1,
  documentWidth: 1280,
  documentHeight: 4000
}

/** The same page at 125 % on a 2x display: `devicePixelRatio` carries both. */
const zoomed: PageViewport = { ...plain, zoom: 1.25, devicePixelRatio: 2.5 }

describe('captureArea', () => {
  it('takes the viewport as the visible area of the document', () => {
    expect(captureArea({ mode: 'viewport' }, plain)).toEqual({
      x: 0,
      y: 600,
      width: 1280,
      height: 720
    })
  })

  it('takes the full page as the document cut at the hosts’ height limit', () => {
    expect(captureArea({ mode: 'fullPage' }, plain)).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 4000
    })
    expect(captureArea({ mode: 'fullPage' }, { ...plain, documentHeight: 50_000 })).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: CAPTURE_MAX_HEIGHT
    })
  })

  it('clamps a region to the document and refuses one outside it', () => {
    expect(captureArea({ mode: 'region', region: { x: 100, y: 700, width: 300, height: 200 } }, plain)).toEqual({
      x: 100,
      y: 700,
      width: 300,
      height: 200
    })
    expect(captureArea({ mode: 'region', region: { x: 1200, y: 3900, width: 300, height: 300 } }, plain)).toEqual({
      x: 1200,
      y: 3900,
      width: 80,
      height: 100
    })
    expect(captureArea({ mode: 'region', region: { x: 2000, y: 0, width: 10, height: 10 } }, plain)).toBeNull()
    expect(captureArea({ mode: 'region', region: { x: 0, y: 0, width: 0, height: 10 } }, plain)).toBeNull()
    expect(captureArea({ mode: 'region' }, plain)).toBeNull()
  })

  it('without the geometry takes a region as given and leaves the rest to the host', () => {
    expect(captureArea({ mode: 'region', region: { x: 5, y: 5, width: 10, height: 10 } }, null)).toEqual({
      x: 5,
      y: 5,
      width: 10,
      height: 10
    })
    expect(captureArea({ mode: 'viewport' }, null)).toBeNull()
    expect(captureArea({ mode: 'fullPage' }, null)).toBeNull()
  })
})

describe('captureBudget', () => {
  it('measures the picture in device pixels', () => {
    expect(captureBudget({ x: 0, y: 0, width: 1280, height: 720 }, 1)).toEqual({
      width: 1280,
      height: 720,
      pixels: 921_600,
      withinBudget: true
    })
    expect(captureBudget({ x: 0, y: 0, width: 1280, height: 720 }, 2.5)).toEqual({
      width: 3200,
      height: 1800,
      pixels: 5_760_000,
      withinBudget: true
    })
  })

  it('refuses past the budget – a full page at the height cut on a wide display at 150 percent', () => {
    // 2560 CSS px wide at the cut on a plain display fits: 30.7 Mpx.
    expect(captureBudget({ x: 0, y: 0, width: 2560, height: CAPTURE_MAX_HEIGHT }, 1).withinBudget).toBe(true)
    // At 1.5 it is 69 Mpx: refused.
    const over = captureBudget({ x: 0, y: 0, width: 2560, height: CAPTURE_MAX_HEIGHT }, 1.5)
    expect(over.withinBudget).toBe(false)
    expect(over.pixels).toBeGreaterThan(CAPTURE_MAX_PIXELS)
    // The budget itself, to the pixel, counts as within it.
    expect(captureBudget({ x: 0, y: 0, width: 6000, height: 6000 }, 1).withinBudget).toBe(true)
    expect(captureBudget({ x: 0, y: 0, width: 6001, height: 6000 }, 1).withinBudget).toBe(false)
  })

  it('takes a ratio the host could not say as 1', () => {
    expect(captureBudget({ x: 0, y: 0, width: 10, height: 10 }, 0)).toMatchObject({ width: 10, height: 10 })
    expect(captureBudget({ x: 0, y: 0, width: 10, height: 10 }, Number.NaN)).toMatchObject({ width: 10, height: 10 })
  })
})

describe('CaptureTooLargeError', () => {
  it('is named, says the size and what to do, and survives the IPC bridge as its message', () => {
    const error = new CaptureTooLargeError(69_120_000, { width: 3840, height: 18_000 })
    expect(error.name).toBe(CAPTURE_TOO_LARGE)
    expect(error.pixels).toBe(69_120_000)
    expect(error.message).toBe(
      'CaptureTooLarge: The capture would be 3,840 × 18,000 pixels, more than the 36 megapixels a capture can hold. Zoom out or select a smaller area.'
    )
    expect(isCaptureTooLarge(error)).toBe(true)
    // What the renderer gets from `ipcRenderer.invoke`: a plain Error with the prefixed message.
    const overIpc = new Error(`Error invoking remote method 'zen:cmd': Error: ${error.message}`)
    expect(isCaptureTooLarge(overIpc)).toBe(true)
    expect(isCaptureTooLarge(new Error('Tab not found'))).toBe(false)
    expect(isCaptureTooLarge('CaptureTooLarge: …')).toBe(true)
    expect(isCaptureTooLarge(null)).toBe(false)
  })

  it('reads as one sentence for the UI, the prefix and the name gone', () => {
    const error = new CaptureTooLargeError(1, { width: 7000, height: 7000 })
    expect(captureErrorMessage(new Error(`Error invoking remote method 'zen:cmd': Error: ${error.message}`))).toBe(
      'The capture would be 7,000 × 7,000 pixels, more than the 36 megapixels a capture can hold. Zoom out or select a smaller area.'
    )
    expect(captureErrorMessage(new Error('Tab not found'))).toBe('Tab not found')
    expect(captureErrorMessage('plain')).toBe('plain')
  })
})

describe('regionFromChrome', () => {
  /** The page's view sits 80 px below and 240 px right of the window's corner (toolbar, sidebar). */
  const frame = { x: 240, y: 80, width: 1280, height: 720 }

  it('maps a drag in the chrome’s pixels to the document at 100 percent', () => {
    expect(regionFromChrome({ x: 340, y: 180, width: 200, height: 100 }, frame, plain)).toEqual({
      x: 100,
      y: 700,
      width: 200,
      height: 100
    })
  })

  it('divides by the zoom before adding the scroll offset', () => {
    // 125 %: 250 chrome px span 200 page px; the frame's corner is still the scroll offset.
    expect(regionFromChrome({ x: 490, y: 330, width: 250, height: 125 }, frame, zoomed)).toEqual({
      x: 200,
      y: 800,
      width: 200,
      height: 100
    })
  })

  it('clamps a drag that left the frame to what was under the frame, and refuses one outside it', () => {
    expect(regionFromChrome({ x: 0, y: 0, width: 340, height: 180 }, frame, plain)).toEqual({
      x: 0,
      y: 600,
      width: 100,
      height: 100
    })
    expect(regionFromChrome({ x: 1400, y: 700, width: 500, height: 500 }, frame, plain)).toEqual({
      x: 1160,
      y: 1220,
      width: 120,
      height: 100
    })
    expect(regionFromChrome({ x: 0, y: 0, width: 100, height: 50 }, frame, plain)).toBeNull()
    expect(regionFromChrome({ x: 300, y: 100, width: 0, height: 0 }, frame, plain)).toBeNull()
  })

  it('rounds to whole page pixels', () => {
    expect(regionFromChrome({ x: 240.4, y: 80.4, width: 10.3, height: 10.3 }, frame, plain)).toEqual({
      x: 0,
      y: 600,
      width: 11,
      height: 11
    })
  })
})

describe('screenshotFileName', () => {
  it('is Chrome’s: the date and the local time with dots', () => {
    expect(screenshotFileName(new Date(2026, 8, 23, 14, 5, 9))).toBe('Screenshot 2026-09-23 at 14.05.09.png')
    expect(screenshotFileName(new Date(2026, 0, 1, 0, 0, 0), 'jpg')).toBe('Screenshot 2026-01-01 at 00.00.00.jpg')
    expect(screenshotFileName(new Date(2026, 0, 1), '.png')).toMatch(/\.png$/)
  })
})

describe('parseImageDataUrl', () => {
  it('takes a PNG or JPEG data URL and nothing else', () => {
    expect(parseImageDataUrl('data:image/png;base64,iVBORw0KGgo=')).toEqual({
      mimeType: 'image/png',
      data: 'iVBORw0KGgo='
    })
    expect(parseImageDataUrl('data:image/jpeg;base64,/9j/4AAQ')).toEqual({
      mimeType: 'image/jpeg',
      data: '/9j/4AAQ'
    })
    expect(parseImageDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull()
    expect(parseImageDataUrl('data:text/html;base64,PGh0bWw+')).toBeNull()
    expect(parseImageDataUrl('https://example.test/a.png')).toBeNull()
    expect(parseImageDataUrl('file:///etc/passwd')).toBeNull()
    expect(parseImageDataUrl('data:image/png;base64,not base64!')).toBeNull()
  })

  it('names the extension after the type', () => {
    expect(captureExtension('image/png')).toBe('png')
    expect(captureExtension('image/jpeg')).toBe('jpg')
  })
})

describe('imageDimensions', () => {
  const pngHeader = (width: number, height: number): Uint8Array => {
    const bytes = new Uint8Array(33)
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
    new DataView(bytes.buffer).setUint32(16, width)
    new DataView(bytes.buffer).setUint32(20, height)
    return bytes
  }
  const jpegHeader = (width: number, height: number): Uint8Array => {
    // SOI, an APP0 segment of 16 bytes, then SOF0 with the frame's size.
    const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]
    const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3]
    return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  }

  it('reads a PNG’s IHDR', () => {
    expect(imageDimensions(pngHeader(640, 480))).toEqual({ width: 640, height: 480 })
    expect(imageDimensions(pngHeader(70_000, 3))).toEqual({ width: 70_000, height: 3 })
    expect(imageDimensions(pngHeader(0, 3))).toBeNull()
    expect(imageDimensions(pngHeader(640, 480).slice(0, 20))).toBeNull()
  })

  it('reads a JPEG’s first frame header past the segments before it', () => {
    expect(imageDimensions(jpegHeader(1024, 768))).toEqual({ width: 1024, height: 768 })
    // Cut before the frame: unknown.
    expect(imageDimensions(jpegHeader(1024, 768).slice(0, 12))).toBeNull()
  })

  it('knows neither anything else nor nothing', () => {
    expect(imageDimensions(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]))).toBeNull()
    expect(imageDimensions(new Uint8Array(0))).toBeNull()
  })
})

describe('parsePageViewport', () => {
  it('takes a host’s full answer and puts the ratios and the document right', () => {
    expect(parsePageViewport({ ...plain })).toEqual(plain)
    expect(
      parsePageViewport({
        scrollX: -3,
        scrollY: 10,
        width: 411,
        height: 700,
        zoom: 0,
        devicePixelRatio: Number.NaN,
        documentWidth: 100,
        documentHeight: 100
      })
    ).toEqual({
      scrollX: 0,
      scrollY: 10,
      width: 411,
      height: 700,
      zoom: 1,
      devicePixelRatio: 1,
      documentWidth: 411,
      documentHeight: 700
    })
  })

  it('refuses anything short of one', () => {
    expect(parsePageViewport(null)).toBeNull()
    expect(parsePageViewport('viewport')).toBeNull()
    expect(parsePageViewport({ scrollX: 0, scrollY: 0, width: 0, height: 700 })).toBeNull()
    expect(parsePageViewport({ scrollX: 0, scrollY: 0, width: 411 })).toBeNull()
    expect(parsePageViewport({ scrollX: '0', scrollY: 0, width: 411, height: 700 })).toBeNull()
  })
})
