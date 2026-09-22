/**
 * The page stand-in's size (design language v2 draft §9.5): the picture the chrome shows in
 * place of the live page under an undimmed popover, a menu or a dialog is the frame's capture
 * at device pixels, capped by a device-pixel AREA and never by a CSS-pixel width. Under a
 * popover the page must read as the page, and a resample softens every text edge where a lower
 * JPEG quality only costs the gradients – so a frame under the ceiling is encoded as captured,
 * 1:1, and only a frame past it (a 2560 × 1440 monitor, a DPR-2 laptop) is scaled down, both
 * sides alike, to the ceiling. The ceiling itself (`SNAPSHOT_MAX_PIXELS` in the Electron host's
 * `views.ts`) is set where the native encode stays inside a frame, by measurement. The Android
 * host's cover is its own copy and encode (`TabWebView.snapshot`) and does not read this.
 */

/** What a capture is scaled to before its encode: its new size, in the capture's own unit. */
export interface StandinSize {
  width: number
  height: number
  /**
   * The factor both sides were scaled by before rounding down: 1 for a capture under the
   * ceiling (encoded as it is), below 1 for one past it. Never above 1 – a capture is not
   * enlarged to fill a ceiling.
   */
  scale: number
}

/**
 * The size a capture of `width` × `height` is encoded at under a ceiling of `maxPixels` device
 * pixels. `dpr` is the device pixels per unit of `width` and `height` – the capture's
 * representation scale: 1 for Electron's `capturePage`, which hands the device pixels over as a
 * 1x bitmap (so its `getSize()` is already device pixels), the display's factor for a picture
 * measured in CSS pixels. The result is in the same unit as the input, what a resize takes.
 *
 * A capture whose device-pixel area (`width · dpr × height · dpr`) is at or under the ceiling
 * comes back as it is, scale 1. One past it is scaled by `sqrt(maxPixels / area)` on both sides
 * (the aspect kept) and rounded down, so the encoded area never crosses the ceiling (a side is
 * kept at a pixel at least). A ceiling that is not a positive number lifts the cap; a size that
 * is not positive is returned untouched (the caller's empty-capture check speaks for it).
 */
export function standinScale(
  width: number,
  height: number,
  dpr: number,
  maxPixels: number
): StandinSize {
  const asIs = { width, height, scale: 1 }
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height))
    return asIs
  const perUnit = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  const area = width * perUnit * (height * perUnit)
  if (!(maxPixels > 0) || area <= maxPixels) return asIs
  const scale = Math.sqrt(maxPixels / area)
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale
  }
}
