/**
 * The folded group card's face (`docs/tab-overview-cleanup-spec.md` §2): a group stands in the
 * overview grid as ONE CARD in its place – its name and colour in the header row, its count the
 * aside, and under them a 2×2 MOSAIC of its members' captures – and opens in place on a tap.
 * The pure parts of that card: which members the four tiles show, and how tall the folded card
 * is while its height is on the spring.
 */

/** The mosaic's tiles: two by two. */
export const MOSAIC_TILES = 4

export interface Mosaic<T> {
  /** The members drawn, in the group's order: all of them up to four, else the first three. */
  tiles: T[]
  /**
   * Members past the tiles, named by the fourth tile as "+N" (Chrome's group card): with five
   * members the tiles are three captures and "+2"; with four, four captures.
   */
  more: number
}

export function mosaicOf<T>(members: readonly T[]): Mosaic<T> {
  if (members.length <= MOSAIC_TILES) return { tiles: [...members], more: 0 }
  const shown = MOSAIC_TILES - 1
  return { tiles: members.slice(0, shown), more: members.length - shown }
}

/**
 * The width-over-height ratio a card's `aspect-ratio` names – "3 / 4", the tablet's "1280 /
 * 800" (`--zen-overview-card-aspect`), or a bare number – or null for anything else.
 */
export function parseAspect(aspect: string | null | undefined): number | null {
  if (!aspect) return null
  const parts = aspect.split('/').map((p) => Number(p.trim()))
  if (parts.length < 1 || parts.length > 2 || parts.some((n) => !Number.isFinite(n) || n <= 0))
    return null
  return parts.length === 1 ? parts[0] : parts[0] / parts[1]
}

/**
 * How tall the folded card is at `width`: a cell at the grid's card aspect, as the tab cards
 * beside it are – never shorter than its header (`floor`), which is also what a card with no
 * width yet (a mount before layout) answers.
 */
export function foldedCardHeight(
  width: number,
  aspect: string | null | undefined,
  floor: number
): number {
  const ratio = parseAspect(aspect)
  if (ratio === null || width <= 0) return floor
  return Math.max(floor, Math.round(width / ratio))
}
