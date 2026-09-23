/**
 * `action.setIcon` pixels on a text bridge (the emulated engines: Zenium for Android).
 *
 * The shim hands `setIcon` an `imageData` of `{width, height, data}` (`serializeIconDetails`,
 * shim.ts), `data` the `ImageData`'s `Uint8ClampedArray`. On the desktop that crosses by
 * structured clone, 36 KB for a 96 px icon. On a text bridge `JSON.stringify` writes a typed
 * array member by member (`{"0":255,"1":128,…}`), about 0.3 M chars for the same icon, and an
 * extension animating its icon every frame (Clear Cache's clearing spinner: compat round 11b)
 * puts sixty of those a second on the host's Java heap as strings before the host has read one
 * of them – the host cannot shrink what arrives. So the engine compacts the pixels before the
 * call is posted: scaled to the slot the chrome draws ([ICON_SLOT]) through an `OffscreenCanvas`
 * where the context has one (a worker, a page), the RGBA bytes as base64 either way – about
 * 5.5 K chars for a 96 px icon, 49 K without a canvas. The host reads the base64 form alongside
 * the two JSON forms (`ActionCalls.kt`) and still scales and rewrites, so a bootstrap that does
 * not compact is handled the same, only later and at a cost.
 *
 * Pure: the drawing surfaces come from [IconWireEnv], captured from the realm's globals once
 * ([captureIconWireEnv]) so a page that patches them later cannot break the bridge, and the
 * tests hand in their own.
 */

/** The slot the chrome draws action icons in: Chrome's "32" (a 16 dp icon at 2x); `ActionCalls.ICON_SLOT`. */
export const ICON_SLOT = 32

/** The corner of the 2D context the compaction draws with. */
export interface IconWireContext2d {
  imageSmoothingEnabled: boolean
  imageSmoothingQuality?: string
  putImageData(image: unknown, dx: number, dy: number): void
  drawImage(
    source: unknown,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number
  ): void
  getImageData(sx: number, sy: number, sw: number, sh: number): { data: Uint8ClampedArray }
}

export interface IconWireCanvas {
  getContext(kind: '2d'): IconWireContext2d | null
}

export interface IconWireEnv {
  /** A drawing surface of the size, or null where the realm has none (then the bytes go unscaled). */
  canvas(width: number, height: number): IconWireCanvas | null
  /** An `ImageData` over the bytes (the constructor), or null where the realm has none. */
  imageData(data: Uint8ClampedArray, width: number, height: number): unknown | null
  /** `btoa`. */
  btoa(binary: string): string
}

/** An image as the shim passes it on: `ImageData`'s shape, the bytes RGBA. */
export interface IconImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** A wire image: the bytes as base64 (`ActionCalls.readBytes`'s string form). */
export interface WireImage {
  width: number
  height: number
  data: string
}

/** The realm's own surfaces, taken now. */
export function captureIconWireEnv(): IconWireEnv {
  const g = globalThis as Record<string, unknown>
  const OffscreenCanvasCtor = g.OffscreenCanvas as
    (new (width: number, height: number) => IconWireCanvas) | undefined
  const ImageDataCtor = g.ImageData as
    (new (data: Uint8ClampedArray, width: number, height: number) => unknown) | undefined
  const btoaFn = typeof g.btoa === 'function' ? (g.btoa as (s: string) => string) : null
  return {
    canvas: (width, height) => {
      if (!OffscreenCanvasCtor) return null
      try {
        return new OffscreenCanvasCtor(width, height)
      } catch {
        return null
      }
    },
    imageData: (data, width, height) => {
      if (!ImageDataCtor) return null
      try {
        return new ImageDataCtor(data, width, height)
      } catch {
        return null
      }
    },
    btoa: (binary) => {
      if (btoaFn) return btoaFn(binary)
      return base64Of(binary)
    }
  }
}

/** Base64 of a binary string without `btoa` (a realm that lacks it; the tests). */
function base64Of(binary: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < binary.length; i += 3) {
    const a = binary.charCodeAt(i)
    const b = i + 1 < binary.length ? binary.charCodeAt(i + 1) : 0
    const c = i + 2 < binary.length ? binary.charCodeAt(i + 2) : 0
    const triple = (a << 16) | (b << 8) | c
    out += alphabet[(triple >> 18) & 63] + alphabet[(triple >> 12) & 63]
    out += i + 1 < binary.length ? alphabet[(triple >> 6) & 63] : '='
    out += i + 2 < binary.length ? alphabet[triple & 63] : '='
  }
  return out
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** The RGBA bytes of an image's `data` in any of the forms the shim passes on, or null. */
function bytesOf(data: unknown, count: number): Uint8ClampedArray | null {
  let view: Uint8ClampedArray | null = null
  if (data instanceof Uint8ClampedArray) view = data
  else if (ArrayBuffer.isView(data)) {
    view = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
  } else if (data instanceof ArrayBuffer) view = new Uint8ClampedArray(data)
  else if (Array.isArray(data)) view = new Uint8ClampedArray(data as number[])
  if (!view || view.length < count) return null
  return view.length === count ? view : view.subarray(0, count)
}

function imageOf(raw: unknown): IconImage | null {
  if (!isObject(raw)) return null
  const { width, height, data } = raw
  if (!isSize(width) || !isSize(height)) return null
  const bytes = bytesOf(data, width * height * 4)
  return bytes ? { width, height, data: bytes } : null
}

/**
 * Of a dictionary of images by size, the one the host would scale: the smallest at least the
 * slot, else the largest. Null when none of the members is an image.
 */
function pick(sizes: Record<string, unknown>): IconImage | null {
  let best: { size: number; image: IconImage } | null = null
  for (const key of Object.keys(sizes)) {
    const image = imageOf(sizes[key])
    if (!image) continue
    const size = Number(key)
    const candidate = {
      size: Number.isFinite(size) ? size : Math.max(image.width, image.height),
      image
    }
    if (!best) {
      best = candidate
      continue
    }
    const bestFits = best.size >= ICON_SLOT
    const fits = candidate.size >= ICON_SLOT
    if (fits && (!bestFits || candidate.size < best.size)) best = candidate
    else if (!fits && !bestFits && candidate.size > best.size) best = candidate
  }
  return best?.image ?? null
}

/** [image] scaled so its longer side is [ICON_SLOT], or itself when it already fits or the realm cannot draw. */
function scaled(image: IconImage, env: IconWireEnv): IconImage {
  const longest = Math.max(image.width, image.height)
  if (longest <= ICON_SLOT) return image
  try {
    const source = env.canvas(image.width, image.height)
    const pixels = env.imageData(image.data, image.width, image.height)
    const sourceContext = source?.getContext('2d')
    if (!source || !pixels || !sourceContext) return image
    sourceContext.putImageData(pixels, 0, 0)
    const width = Math.max(1, Math.round((image.width * ICON_SLOT) / longest))
    const height = Math.max(1, Math.round((image.height * ICON_SLOT) / longest))
    const target = env.canvas(width, height)
    const targetContext = target?.getContext('2d')
    if (!target || !targetContext) return image
    targetContext.imageSmoothingEnabled = true
    targetContext.imageSmoothingQuality = 'high'
    targetContext.drawImage(source, 0, 0, image.width, image.height, 0, 0, width, height)
    const out = targetContext.getImageData(0, 0, width, height)
    const data = bytesOf(out.data, width * height * 4)
    return data ? { width, height, data } : image
  } catch {
    return image
  }
}

function base64(bytes: Uint8ClampedArray, env: IconWireEnv): string {
  let binary = ''
  const chunk = 4096
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return env.btoa(binary)
}

/** One image on the wire: scaled to the slot where the realm can draw, its bytes as base64. */
export function compactImage(image: IconImage, env: IconWireEnv): WireImage {
  const fitted = scaled(image, env)
  return { width: fitted.width, height: fitted.height, data: base64(fitted.data, env) }
}

/**
 * `setIcon`'s details for the wire: `imageData` (one image, or a dictionary by size) becomes
 * one [WireImage] of the slot's size; anything else in the details (`path`, `tabId`) crosses as
 * it was. Details without usable pixels (no `imageData`, or nothing shaped like an image in it)
 * come back as they were, for the host and the core to answer as they do today.
 */
export function compactIconDetails(details: unknown, env: IconWireEnv): unknown {
  if (!isObject(details) || !isObject(details.imageData)) return details
  const raw = details.imageData
  const image = 'data' in raw && 'width' in raw ? imageOf(raw) : pick(raw)
  if (!image) return details
  return { ...details, imageData: compactImage(image, env) }
}
