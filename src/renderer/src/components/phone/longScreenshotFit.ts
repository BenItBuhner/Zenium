import type { LongCapture } from '@shared/types'
import type { SheetRest } from '@renderer/lib/motion/sheetRest'

/** The handle's band, half of it past the frame's edge when the handle sits on it (§9.9's 44). */
export const HANDLE_BAND_PX = 44
/** The frame's gutter: the body's side padding (`.zen-longshot-body` in main.css). */
export const FRAME_GUTTER_PX = 16

/**
 * The long-screenshot editor's frame scale (`LongScreenshotSheet`) for the picture in a body
 * `rest` wide and tall at the sheet's rest: the body's width between the gutters, or less, so
 * the first screen of the page – what the viewport screenshot showed – fits the body's height
 * with both handles' bands in view. Fitted against the rest, never the body's live height: the
 * chassis animates the sheet's height per frame between its detents, and the picture is laid
 * out once for where the sheet is going (§11.1, content anchored to the top edge as the sheet
 * rises; the perf rule: no layout per frame).
 */
export function fitScale(
  capture: Pick<LongCapture, 'width' | 'viewportHeight'>,
  rest: SheetRest
): number {
  const width = rest.bodyWidth - FRAME_GUTTER_PX * 2
  const height = rest.bodyHeight - HANDLE_BAND_PX * 2
  const byWidth = width / capture.width
  const byHeight = height > 0 ? height / capture.viewportHeight : byWidth
  return Math.max(0.05, Math.min(byWidth, byHeight))
}
