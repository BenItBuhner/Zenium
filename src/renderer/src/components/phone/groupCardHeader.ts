import { currentTextScale } from '@renderer/lib/textScale'

/**
 * Height of a group card's title row at the default text size – all a collapsed group shows. The
 * row is itself the button that folds the group, so it is the phone row's 44 (v2 §9.2, §9.21;
 * A11Y-01's 44 target): the 13 px name's 20 line plus 24. Like every row it grows from its line
 * box with the system font size (§4, A11Y-05): the stylesheet draws the row as
 * `--zen-overview-group-header` (`main.css`), and the height math in `GroupCard` reads
 * [groupHeaderHeight], the same number.
 */
export const GROUP_HEADER = 44
/** The name's line box at the default size (`--v2-line-small`: 13 px text on the 20 line, §4). */
const NAME_LINE = 20

/**
 * The title row's height at the text scale in force, what `--zen-overview-group-header` computes
 * to: 44 at the default size, 50 at 1.3, 60 at 1.8, 64 at 2.0 – one line, a group's name never
 * wraps. For the collapse heights the card runs on its spring.
 */
export function groupHeaderHeight(zoom: number = currentTextScale().zoom): number {
  return GROUP_HEADER - NAME_LINE + NAME_LINE * zoom
}
