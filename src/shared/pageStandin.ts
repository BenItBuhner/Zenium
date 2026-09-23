/**
 * The page stand-in's size (design language v2 draft §9.5): the picture the chrome shows in
 * place of the live page under an undimmed popover, a menu or a dialog is the frame's capture
 * at device pixels, 1:1 up to a TRIGGER area and never clamped by a CSS-pixel width. Under a
 * popover the page must read as the page, and a resample softens every text edge where a lower
 * JPEG quality only costs the gradients – so a frame at or under the trigger is encoded as
 * captured, and only a frame past it is scaled down, both sides alike. A frame past the trigger
 * does not scale to the trigger but drops to a smaller TARGET area: a resize costs main-process
 * time of its own and pays for itself only when it removes a good share of the pixels, so a
 * single scale-to-the-ceiling rule would hand the frames just past the ceiling a scale near 1
 * that loses on every axis (time, bytes and edges) – hence two numbers, not one. Both
 * (`SNAPSHOT_MAX_PIXELS` and `SNAPSHOT_TARGET_PIXELS` in the Electron host's `views.ts`) are
 * fixed by measurement; the numbers behind them are there. The Android host's cover is its own
 * copy and encode (`TabWebView.snapshot`) and does not read this.
 */

/** What a capture is scaled to before its encode: its new size, in the capture's own unit. */
export interface StandinSize {
  width: number
  height: number
  /**
   * The factor both sides were scaled by before rounding down: 1 for a capture at or under the
   * trigger (encoded as it is), below 1 for one past it. Never above 1 – a capture is not
   * enlarged to fill a ceiling.
   */
  scale: number
}

/** The stand-in's two areas, in device pixels (§9.5): where a resize starts and where it lands. */
export interface StandinCeiling {
  /** A capture whose device-pixel area is at or under this is encoded 1:1. */
  trigger: number
  /**
   * The area a capture past the trigger is scaled down to. Capped at the trigger (an encoded
   * area never crosses it); one that is not a positive number takes the trigger's value.
   */
  target: number
}

/**
 * The size a capture of `width` × `height` is encoded at under `ceiling`. `dpr` is the device
 * pixels per unit of `width` and `height` – the capture's representation scale: 1 for Electron's
 * `capturePage`, which hands the device pixels over as a 1x bitmap (so its `getSize()` is
 * already device pixels), the display's factor for a picture measured in CSS pixels. The result
 * is in the same unit as the input, what a resize takes.
 *
 * A capture whose device-pixel area (`width · dpr × height · dpr`) is at or under the trigger
 * comes back as it is, scale 1 – the trigger itself counts as under. One past it is scaled by
 * `sqrt(target / area)` on both sides (the aspect kept) and rounded down, so the encoded area
 * never crosses the target (a side is kept at a pixel at least); with the target below the
 * trigger the scale is always under 1, never an enlargement. A trigger that is not a positive
 * number lifts the cap; a size that is not positive is returned untouched (the caller's
 * empty-capture check speaks for it).
 */
export function standinScale(
  width: number,
  height: number,
  dpr: number,
  ceiling: StandinCeiling
): StandinSize {
  const asIs = { width, height, scale: 1 }
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height))
    return asIs
  const perUnit = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  const area = width * perUnit * (height * perUnit)
  const { trigger } = ceiling
  if (!(trigger > 0) || area <= trigger) return asIs
  const target = ceiling.target > 0 ? Math.min(ceiling.target, trigger) : trigger
  const scale = Math.min(1, Math.sqrt(target / area))
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale
  }
}
