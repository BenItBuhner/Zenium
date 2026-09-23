/**
 * Web capture (CT-21, CT-28, CT-29): what the chrome's capture UI, the core and the hosts'
 * capture engines agree on. The engines are the agents' (`TabView.capture`: the DevTools
 * protocol's `captureBeyondViewport` on Electron, `PageCapture`'s strip stitching on Android);
 * `page.capture` hands their picture to the chrome as a data URL, `capture.copy` and
 * `capture.save` take it from there, and `page.viewport` tells the chrome where the page is
 * scrolled to and how it is zoomed, which the drag rectangle needs (`regionFromChrome`).
 *
 * Units: a request's region is in CSS pixels relative to the document (the viewport position
 * plus the scroll offset), as the host contract takes it; a result's `width` and `height` are
 * the picture's own pixels – device pixels, the CSS pixels times the page's `devicePixelRatio`
 * (the display's scale times the page zoom), or fewer where a host scales a large picture down
 * (Android's full page). `devicePixelRatio` in the result is that ratio, picture pixels per CSS
 * pixel of the area captured.
 */
import type { Rect } from './types'

export type PageCaptureMode = 'viewport' | 'fullPage' | 'region'
export type PageCaptureFormat = 'png' | 'jpeg'

/** What the chrome asks `page.capture` for. */
export interface PageCaptureRequest {
  mode: PageCaptureMode
  /** With `mode: 'region'`: CSS pixels relative to the document. */
  region?: Rect
  /** PNG unless asked otherwise (Copy and Save want the lossless picture). */
  format?: PageCaptureFormat
}

/** What `page.capture` answers: the picture and its size. */
export interface PageCaptureResult {
  /** `data:image/png;base64,…` (or JPEG). */
  dataUrl: string
  /** The picture's pixels. */
  width: number
  height: number
  /** Picture pixels per CSS pixel of the area captured (`width / cssWidth`). */
  devicePixelRatio: number
  /**
   * The full page or region asked for could not be painted and the visible area (minus the
   * scrollbar gutters, as a viewport capture is; cropped to the region where one was given)
   * came back instead: the debugger is another's (DevTools open, an extension's
   * `chrome.debugger` session), the paint failed, or the host cannot read the page's geometry.
   * The UI says so rather than pass the crop off as the whole.
   */
  fallback?: 'viewport'
}

/**
 * The page's geometry as the chrome needs it to map its own coordinates to the page's
 * (`page.viewport`). CSS pixels of the page throughout, except `zoom` and `devicePixelRatio`.
 */
export interface PageViewport {
  /**
   * Where the page pixel under the content frame's top-left corner is in the document: the
   * layout viewport's scroll offset (`window.scrollX/Y`) on desktop; on Android the visual
   * viewport's (`visualViewport.pageLeft/pageTop`), which a pinch-pan moves too.
   */
  scrollX: number
  scrollY: number
  /**
   * The visible area's size in page CSS pixels: `innerWidth` × `innerHeight` on desktop (the
   * scrollbar included), the visual viewport's on Android.
   */
  width: number
  height: number
  /**
   * The visible area minus the scrollbar gutters, in page CSS pixels – the layout viewport as
   * `documentElement.clientWidth` × `clientHeight` report it on desktop, where a classic
   * scrollbar (Linux, Windows) takes a column or row of the frame that is not page content;
   * this is what a visible-area capture paints (§5 of the contract), as Chrome's does, and what
   * the chrome's drag overlay should size itself to (the gutter is not capturable). Equal to
   * `width` × `height` where scrollbars overlay the page (macOS, Android's WebView) and for a
   * host that does not say.
   */
  clientWidth: number
  clientHeight: number
  /**
   * The document runs right-to-left (`direction: rtl` on the root). For the chrome's
   * information only – a UI may mirror its own affordances by it. It does not move the gutter:
   * Chromium draws the main frame's vertical scrollbar in the right-hand columns of the frame
   * whatever the document's direction (Blink's `placeRTLScrollbarsOnLeftSideInMainFrame`
   * setting, off in Chrome and Electron, is the only thing that would put it on the left;
   * measured on the packaged build), so the capturable area always starts at the frame's
   * top-left corner.
   */
  rtl: boolean
  /**
   * How many of the chrome's CSS pixels (the window's DIPs) one page CSS pixel takes: the page
   * zoom on Electron; on Android the visual viewport's scale (a desktop-layout page squeezed
   * into the screen is below 1, a pinch zoom above).
   */
  zoom: number
  /** Device pixels per page CSS pixel: the display's scale times `zoom` (`window.devicePixelRatio`). */
  devicePixelRatio: number
  /** The document's scrollable size. */
  documentWidth: number
  documentHeight: number
}

/**
 * A `PageViewport` out of a host's answer (Android's bridge, a test's fixture): every field a
 * finite number, a visible area of some size, the ratios above zero (else 1), the document
 * never smaller than the visible area, and the area minus the gutters (`clientWidth` /
 * `clientHeight`) within the visible area – the visible area itself for a host that does not
 * say (an older host's answer), whose scrollbars are then taken as overlaying the page. Null
 * for anything else.
 */
export function parsePageViewport(raw: unknown): PageViewport | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const num = (key: string): number | null => {
    const v = r[key]
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }
  const scrollX = num('scrollX')
  const scrollY = num('scrollY')
  const width = num('width')
  const height = num('height')
  if (scrollX === null || scrollY === null || width === null || height === null) return null
  if (!(width > 0) || !(height > 0)) return null
  const zoom = num('zoom')
  const dpr = num('devicePixelRatio')
  return {
    scrollX: Math.max(0, scrollX),
    scrollY: Math.max(0, scrollY),
    width,
    height,
    clientWidth: clientSide(num('clientWidth'), width),
    clientHeight: clientSide(num('clientHeight'), height),
    rtl: r.rtl === true,
    zoom: zoom !== null && zoom > 0 ? zoom : 1,
    devicePixelRatio: dpr !== null && dpr > 0 ? dpr : 1,
    documentWidth: Math.max(num('documentWidth') ?? 0, width),
    documentHeight: Math.max(num('documentHeight') ?? 0, height)
  }
}

/**
 * A side of the visible area minus its scrollbar gutter, as a host reports it: a size within
 * the visible area's side; the side itself (no gutter) for nothing usable – a host that does
 * not say, a page with no layout yet (0), a value past the visible area.
 */
export function clientSide(reported: number | null | undefined, visible: number): number {
  return typeof reported === 'number' &&
    Number.isFinite(reported) &&
    reported > 0 &&
    reported <= visible
    ? reported
    : visible
}

/**
 * The most a `page.capture` picture may hold, in device pixels: 36 megapixels – a 6000 × 6000
 * picture, 144 MB decoded – admits a 2560-wide page at the height cut on a plain display and
 * a 1280-wide one at 150 %, and keeps what travels to the chrome as one data URL under what
 * the renderer can decode and hold. Past it the command refuses with `CaptureTooLargeError`
 * (named, so the UI can say so) rather than answer with nothing or with a cut picture.
 */
export const CAPTURE_MAX_PIXELS = 36_000_000

/**
 * Where both hosts cut a full page, in CSS pixels (Electron's `MAX_CAPTURE_HEIGHT`, Android's
 * `CapturePlan.MAX_PAGE_HEIGHT`): a taller document comes back cut here, not refused. The
 * budget is measured against the cut height.
 */
export const CAPTURE_MAX_HEIGHT = 12_000

/**
 * `error.name` of the budget refusal. It crosses Electron's IPC bridge: `ipcMain.handle`'s
 * rejection reaches the chrome as `Error invoking remote method 'zen:cmd': ` + `String(error)`,
 * which is `name: message` – so the desktop's renderer reads `CaptureTooLarge: The capture
 * would be …` (measured on the packaged build), and Android's chrome, in the core's own realm,
 * gets the error itself with its name.
 */
export const CAPTURE_TOO_LARGE = 'CaptureTooLarge'

/**
 * A request past the budget. The message is the UI's to show as it is: sentence-cased and
 * complete, with what was asked for and what to do; the name travels beside it
 * (`isCaptureTooLarge` reads either form, `captureErrorMessage` leaves the sentence alone).
 */
export class CaptureTooLargeError extends Error {
  readonly pixels: number

  constructor(pixels: number, size: { width: number; height: number }) {
    super(
      `The capture would be ${formatInt(size.width)} × ${formatInt(size.height)} pixels, more than the ${Math.round(CAPTURE_MAX_PIXELS / 1_000_000)} megapixels a capture can hold. Zoom out or select a smaller area.`
    )
    this.name = CAPTURE_TOO_LARGE
    this.pixels = pixels
  }
}

/** Whether an error – the core's own, or the desktop bridge's rejection carrying `name: message` – is the budget refusal. */
export function isCaptureTooLarge(error: unknown): boolean {
  if (error instanceof Error)
    return error.name === CAPTURE_TOO_LARGE || error.message.includes(`${CAPTURE_TOO_LARGE}:`)
  return typeof error === 'string' && error.includes(`${CAPTURE_TOO_LARGE}:`)
}

/** The message of a `page.capture` rejection as the UI shows it: Electron's IPC prefix and the error's name gone. */
export function captureErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/^Error invoking remote method '[^']*': /, '')
    .replace(new RegExp(`^(?:Error|${CAPTURE_TOO_LARGE}): `), '')
}

function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/**
 * The area a request captures, in CSS pixels of the page, given the page's geometry: the
 * region clamped to the document, the visible area minus the scrollbar gutters (`clientWidth`
 * × `clientHeight`, what a visible-area capture paints), or the document cut at
 * `CAPTURE_MAX_HEIGHT`. Null for a region that lies outside the document (nothing to capture).
 * Without the geometry (`viewport` null: the host cannot read the page) a region is taken as
 * given and the rest is unknown (null): the host decides.
 */
export function captureArea(
  request: PageCaptureRequest,
  viewport: PageViewport | null
): Rect | null {
  if (request.mode === 'region') {
    const r = request.region
    if (!r || !(r.width > 0) || !(r.height > 0)) return null
    if (!viewport) return { ...r }
    return intersect(r, {
      x: 0,
      y: 0,
      width: Math.max(viewport.documentWidth, viewport.width),
      height: Math.max(viewport.documentHeight, viewport.height)
    })
  }
  if (!viewport) return null
  if (request.mode === 'viewport')
    return {
      x: viewport.scrollX,
      y: viewport.scrollY,
      width: clientSide(viewport.clientWidth, viewport.width),
      height: clientSide(viewport.clientHeight, viewport.height)
    }
  return {
    x: 0,
    y: 0,
    width: Math.max(viewport.documentWidth, viewport.width),
    height: Math.min(Math.max(viewport.documentHeight, viewport.height), CAPTURE_MAX_HEIGHT)
  }
}

/**
 * The picture a request would produce, in device pixels, and whether it is within the budget:
 * `area` at the page's `devicePixelRatio` (1 when the host cannot say). The check runs before
 * the host paints anything, so a refused request costs nothing.
 */
export function captureBudget(
  area: Rect,
  devicePixelRatio: number
): { width: number; height: number; pixels: number; withinBudget: boolean } {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
  const width = Math.max(1, Math.round(area.width * dpr))
  const height = Math.max(1, Math.round(area.height * dpr))
  const pixels = width * height
  return { width, height, pixels, withinBudget: pixels <= CAPTURE_MAX_PIXELS }
}

/**
 * The drag-to-region formula (the desktop's capture overlay): a rectangle drawn in the chrome's
 * CSS pixels (the window's DIPs) over the content frame – `frame` is where the page's view sits
 * in the same coordinates (`ZenWindow.contentRect`) – as CSS pixels relative to the page's
 * document, what the host's `capture` takes:
 *
 *     region.x      = (drag.x - frame.x) / zoom + scrollX
 *     region.y      = (drag.y - frame.y) / zoom + scrollY
 *     region.width  = drag.width  / zoom
 *     region.height = drag.height / zoom
 *
 * The page zoom scales page CSS pixels to the chrome's (a page at 125 % shows 100 page pixels
 * as 125 chrome pixels), so the drag is divided by it; the scroll offset then moves the result
 * from the viewport to the document. Clamped to the viewport's own bounds (a drag that left the
 * frame captures what was under the frame) and rounded to whole page pixels; null for a drag
 * that covers no page pixel.
 */
export function regionFromChrome(drag: Rect, frame: Rect, viewport: PageViewport): Rect | null {
  const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1
  const inFrame = intersect(drag, frame)
  if (!inFrame) return null
  const x = (inFrame.x - frame.x) / zoom + viewport.scrollX
  const y = (inFrame.y - frame.y) / zoom + viewport.scrollY
  const right = Math.round(x + inFrame.width / zoom)
  const bottom = Math.round(y + inFrame.height / zoom)
  const left = Math.round(x)
  const top = Math.round(y)
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function intersect(a: Rect, b: Rect): Rect | null {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * The one name rule for a saved screenshot, Chrome's on desktop: `Screenshot 2026-09-23 at
 * 14.05.09.png`, local time (the dots because a colon is no file name character). Take
 * Screenshot, Capture Full Page and the capture UI's Save all name their files this way; the
 * host keeps the name unique in the folder the way it does a download's (`Screenshot …(1).png`).
 */
export function screenshotFileName(now: Date, extension = 'png'): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
  const time = `${two(now.getHours())}.${two(now.getMinutes())}.${two(now.getSeconds())}`
  return `Screenshot ${date} at ${time}.${extension.replace(/^\./, '')}`
}

/** The MIME type and base64 body of an image data URL; null for anything else (the chrome is not trusted with URLs). */
export function parseImageDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl)
  if (!m) return null
  return { mimeType: m[1], data: m[2].replace(/\s+/g, '') }
}

/** The file extension for a capture's MIME type. */
export function captureExtension(mimeType: string): 'png' | 'jpg' {
  return mimeType === 'image/jpeg' ? 'jpg' : 'png'
}

/**
 * The pixel size a PNG or JPEG declares, read from its header: PNG's IHDR (the first chunk,
 * fixed at bytes 16–23), a JPEG's first frame header (SOF0–SOF15, skipping the segments before
 * it). Null when the bytes are neither or are cut short. Cheap – no decode – so the core can
 * report the picture's own size whatever a host says.
 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    // 'IHDR' at 12..15, then width and height, big-endian.
    if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52)
      return null
    const width = readU32(bytes, 16)
    const height = readU32(bytes, 20)
    return width > 0 && height > 0 ? { width, height } : null
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2
    while (at + 9 <= bytes.length) {
      if (bytes[at] !== 0xff) return null
      const marker = bytes[at + 1]
      // Padding bytes between segments.
      if (marker === 0xff) {
        at++
        continue
      }
      // Stand-alone markers carry no length.
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        at += 2
        continue
      }
      const length = (bytes[at + 2] << 8) | bytes[at + 3]
      if (length < 2) return null
      const isFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isFrame) {
        // SOF: length(2) precision(1) height(2) width(2).
        const height = (bytes[at + 5] << 8) | bytes[at + 6]
        const width = (bytes[at + 7] << 8) | bytes[at + 8]
        return width > 0 && height > 0 ? { width, height } : null
      }
      if (marker === 0xd9 || marker === 0xda) return null
      at += 2 + length
    }
  }
  return null
}

function readU32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]
}
