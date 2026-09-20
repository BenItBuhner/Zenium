import { currentTextScale, TWO_LINE_TITLE_ZOOM } from '@renderer/lib/textScale'

/**
 * Height of a card's title row at the default text size: the row holds the card's close, a §9.3
 * phone icon button of 44, and a phone row holding a 44 icon button is 44 (§9.21, as the list
 * rows are) – the title's 20 line plus 24. The stylesheet draws it as `--zen-overview-card-header`
 * (`main.css`), which grows from the line box with the system font size like every row (A11Y-05).
 */
export const CARD_HEADER = 44
/** The title's line box at the default size (`--v2-line-small`: 13 px text on the 20 line, §4). */
const TITLE_LINE = 20

/**
 * The title row's height at the text scale in force, what `--zen-overview-card-header` computes
 * to: `CARD_HEADER` at the default size, the line box zoomed above it, and a second line from
 * `TWO_LINE_TITLE_ZOOM` (§4 / §9.2: one line to 1.3, two from 1.5). For the hero's morph
 * (`TabOverview`), which draws the row in JS.
 */
export function cardHeaderHeight(zoom: number = currentTextScale().zoom): number {
  const lines = zoom >= TWO_LINE_TITLE_ZOOM ? 2 : 1
  return CARD_HEADER - TITLE_LINE + lines * TITLE_LINE * zoom
}
