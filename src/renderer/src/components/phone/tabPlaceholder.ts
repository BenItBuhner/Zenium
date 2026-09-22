/**
 * The placeholder page's typography at `scale` (`TabPreview`: 1 a full-size page, .8 a card), in
 * whole pixels: the favicon, the title, the host. What a scale draws – two scales with the same
 * three draw the same placeholder, which is what a card morphing between two sizes renders it
 * by (the overview's hero).
 */
export function placeholderPx(scale: number): [number, number, number] {
  return [Math.round(36 * scale), Math.round(15 * scale), Math.round(12 * scale)]
}
