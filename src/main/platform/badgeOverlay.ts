import { deflateSync } from 'node:zlib'
import { APP_BADGE_FLAG_GLYPH, appBadgeLabel, type AppBadge } from '../../shared/appBadge'

/**
 * The image an installed app's badge puts on its window's taskbar button on Windows (MW-51;
 * `BrowserWindow.setOverlayIcon`, an overlay the shell shows over the button's icon at 16 × 16
 * logical pixels). Drawn here, pixel by pixel, without a font or a renderer: Chrome's badge
 * (chrome/browser/win/taskbar_decorator_win.cc) is a filled circle in the colour of Windows 10's
 * own badge API, `#26252D`, with the label in white fitted inside a margin – the count, "99+"
 * once it saturates, "•" for a flag. The glyphs are a 3 × 5 pixel face scaled to the largest
 * whole factor that fits, bold enough to read at the size the shell shows them; a flag is a
 * white disc, as Chrome's "•" comes out. Rendered at 32 pixels (the overlay's size at 200 %;
 * the shell scales it down for lower densities, which reads better than scaling a 16 up), as
 * a PNG for `nativeImage.createFromBuffer`.
 */

/** Windows 10's badge colour (Chrome's `kBackgroundColor`): R, G, B. */
export const BADGE_BACKGROUND: readonly [number, number, number] = [0x26, 0x25, 0x2d]
/** The label's colour (Chrome's `kForegroundColor`): white. */
export const BADGE_FOREGROUND: readonly [number, number, number] = [0xff, 0xff, 0xff]
/** The overlay's pixel size: 16 logical pixels at 200 %. */
export const BADGE_OVERLAY_SIZE = 32

/** A 3-wide, 5-tall face for the digits and "+": each row a string of `#` (lit) and `.`. */
const GLYPHS: Record<string, readonly string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '###', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '..#', '..#', '..#'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
  '+': ['...', '.#.', '###', '.#.', '...']
}
const GLYPH_WIDTH = 3
const GLYPH_HEIGHT = 5
/** Space between glyphs, in glyph units. */
const GLYPH_GAP = 1
/** The circle's margin the label keeps to, as Chrome's `kMinMargin` of 3 in 16. */
const MARGIN_RATIO = 3 / 16
/** The flag's disc, as a fraction of the badge's size. */
const FLAG_DISC_RATIO = 0.19
/** Sub-samples per axis for the discs' edges. */
const AA = 4

/** A square RGBA bitmap, rows top to bottom, straight (not premultiplied) alpha. */
export interface BadgeBitmap {
  size: number
  rgba: Uint8Array
}

/** The label's box – where the glyphs land – as `renderBadgeBitmap` lays it out (tested). */
export interface LabelLayout {
  /** The scale each glyph unit is drawn at, in pixels. */
  scale: number
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where a label's glyphs go in a badge of `size`: the largest whole scale at which the label
 * fits the margin's width (with a pixel of slack each side – Chrome lets "99+" run past its
 * margin sooner than shrink it below legibility) and height, at least two pixels a unit at 32,
 * centred. Null for a label with no glyph to draw.
 */
export function labelLayout(label: string, size: number): LabelLayout | null {
  const glyphs = [...label].filter((ch) => GLYPHS[ch])
  if (glyphs.length === 0) return null
  const units = glyphs.length * GLYPH_WIDTH + (glyphs.length - 1) * GLYPH_GAP
  const margin = Math.round(size * MARGIN_RATIO)
  const inner = size - 2 * margin
  const minScale = Math.max(1, Math.floor(size / 16))
  const scale = Math.max(minScale, Math.floor(Math.min((inner + 2) / units, inner / GLYPH_HEIGHT)))
  const width = units * scale
  const height = GLYPH_HEIGHT * scale
  return {
    scale,
    x: Math.floor((size - width) / 2),
    y: Math.floor((size - height) / 2),
    width,
    height
  }
}

/** The bitmap of a badge showing `label` (`appBadgeLabel`'s text: a count, "99+" or "•"). */
export function renderBadgeBitmap(label: string, size = BADGE_OVERLAY_SIZE): BadgeBitmap {
  const rgba = new Uint8Array(size * size * 4)
  const centre = size / 2
  paintDisc(rgba, size, centre, centre, size / 2, BADGE_BACKGROUND)
  if (label === APP_BADGE_FLAG_GLYPH) {
    paintDisc(rgba, size, centre, centre, size * FLAG_DISC_RATIO, BADGE_FOREGROUND)
    return { size, rgba }
  }
  const layout = labelLayout(label, size)
  if (!layout) return { size, rgba }
  let x = layout.x
  for (const ch of label) {
    const rows = GLYPHS[ch]
    if (!rows) continue
    rows.forEach((row, gy) => {
      for (let gx = 0; gx < GLYPH_WIDTH; gx++) {
        if (row[gx] !== '#') continue
        fillRect(
          rgba,
          size,
          x + gx * layout.scale,
          layout.y + gy * layout.scale,
          layout.scale,
          layout.scale,
          BADGE_FOREGROUND
        )
      }
    })
    x += (GLYPH_WIDTH + GLYPH_GAP) * layout.scale
  }
  return { size, rgba }
}

/** The overlay image for a badge, as a PNG. */
export function badgeOverlayPng(badge: AppBadge, size = BADGE_OVERLAY_SIZE): Buffer {
  return encodePng(renderBadgeBitmap(appBadgeLabel(badge), size))
}

/** An anti-aliased filled disc, composited over what is there (source-over, straight alpha). */
function paintDisc(
  rgba: Uint8Array,
  size: number,
  cx: number,
  cy: number,
  radius: number,
  colour: readonly [number, number, number]
): void {
  const r2 = radius * radius
  const x0 = Math.max(0, Math.floor(cx - radius))
  const x1 = Math.min(size - 1, Math.ceil(cx + radius))
  const y0 = Math.max(0, Math.floor(cy - radius))
  const y1 = Math.min(size - 1, Math.ceil(cy + radius))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let inside = 0
      for (let sy = 0; sy < AA; sy++) {
        const py = y + (sy + 0.5) / AA - cy
        for (let sx = 0; sx < AA; sx++) {
          const px = x + (sx + 0.5) / AA - cx
          if (px * px + py * py <= r2) inside++
        }
      }
      if (inside === 0) continue
      blend(rgba, (y * size + x) * 4, colour, inside / (AA * AA))
    }
  }
}

function fillRect(
  rgba: Uint8Array,
  size: number,
  x: number,
  y: number,
  width: number,
  height: number,
  colour: readonly [number, number, number]
): void {
  for (let py = Math.max(0, y); py < Math.min(size, y + height); py++)
    for (let px = Math.max(0, x); px < Math.min(size, x + width); px++)
      blend(rgba, (py * size + px) * 4, colour, 1)
}

/** Source-over of `colour` at `alpha` onto the pixel at `offset`, straight alpha in and out. */
function blend(
  rgba: Uint8Array,
  offset: number,
  colour: readonly [number, number, number],
  alpha: number
): void {
  const dstA = rgba[offset + 3] / 255
  const outA = alpha + dstA * (1 - alpha)
  if (outA <= 0) return
  for (let i = 0; i < 3; i++) {
    const src = colour[i] * alpha
    const dst = rgba[offset + i] * dstA * (1 - alpha)
    rgba[offset + i] = Math.round((src + dst) / outA)
  }
  rgba[offset + 3] = Math.round(outA * 255)
}

// --- PNG -----------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A truecolour-with-alpha PNG (8 bits a channel, no interlace, filter type 0 on every row). */
export function encodePng(bitmap: BadgeBitmap): Buffer {
  const { size, rgba } = bitmap
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  header[10] = 0 // compression
  header[11] = 0 // filter method
  header[12] = 0 // no interlace
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0))
  ])
}
