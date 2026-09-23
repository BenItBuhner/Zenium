/**
 * Which of the address pill's chips fit, and which hide when the pill cannot hold them all
 * (design language v2 §9.29's tier; Chrome's LocationBarView lays its decorations out the same
 * way). The chips have a priority: the site icon always; then the chips that report a state the
 * user cannot otherwise see (blocked pop-ups, a save prompt's key, the camera / microphone /
 * screen the page is using right now – Chrome keeps its in-use icon in the narrowest omnibox) –
 * never hidden; then the star; then the zoom chip (a per-page deviation the user has to undo);
 * then the blocking shield (its count is not a state, §9.29: the site information the site icon
 * opens carries it, and it marks the same state on every page); the informational chips
 * (translate, Reader View) next; and lowest the blocked-permission icons (a camera, microphone,
 * location or notifications the user blocked on the site, Chrome's crossed-out glyphs): a
 * standing decision rather than a live state, restated in the site information, so they are the
 * first to go. Hiding order, first to last: the blocked-permission icons, translate and Reader
 * View, shield, zoom, star (design lead's ruling on #267, §9.29; the blocked icons under them
 * by omnibox-38). The address truncates first – down to `MIN_ADDRESS_WIDTH` – and only then do
 * the chips hide, from the lowest priority up; once one does not fit, none below it shows. A
 * hidden chip's action stays reachable from the app menu and the tab's menu (Bookmark, Zoom,
 * Translate Page, Reader View) and from the site information (the blocking state, the blocked
 * permissions).
 *
 * Pure, so the rule is unit-tested without a DOM; the pill measures itself and asks.
 */

export type ChipTier = 'site' | 'state' | 'star' | 'shield' | 'zoom' | 'info' | 'blocked'

/** Highest priority first: what hides when the pill runs out of room hides from the end. */
export const CHIP_PRIORITY: readonly ChipTier[] = [
  'site',
  'state',
  'star',
  'zoom',
  'shield',
  'info',
  'blocked'
]

/** The tiers no width ever hides: the address's own icon and the state the page cannot show. */
const NEVER_HIDDEN: ReadonlySet<ChipTier> = new Set<ChipTier>(['site', 'state'])

/**
 * What the address keeps before a chip is let in: a host's first letters and the ellipsis.
 * With the site icon and the star alone this puts the star's return at a 110 px content box –
 * §9.29's "130 px pill", the 270 px sidebar's (126 wide at `PILL_PADDING` 16).
 */
export const MIN_ADDRESS_WIDTH = 56

/** The pill's gap between its items (`gap-1.5`). */
export const CHIP_GAP = 6

/**
 * The pill's horizontal padding, both sides together (`px-2`). With the row's buttons 4 apart
 * (§5, `TOOLBAR_GAP`) the 240 sidebar's pill is 96 wide and its content box 80 – the box the
 * tier and the stylesheet's container queries read, unchanged from the 100 px pill of §9.29's
 * arithmetic – and the 270 sidebar's is 126 / 110, where the star returns.
 */
export const PILL_PADDING = 16

/**
 * The content box at which the star and the tools return (§9.29's "130 px pill", the 270
 * sidebar's 126 / 110): the stylesheet's `@container (width < 110px)` on `.zen-pill` drops every
 * `zen-pill-chip` under it. The hub's toolbar button folds by the same tier (`lib/mediaHub.ts`):
 * it returns where the pill, with the button's own slot back in the row, still holds this box.
 */
export const PILL_TOOLS_TIER = 110

/**
 * Nominal boxes, the chips' negative margins folded in (§9.3): the site icon's 24 less its 4 px
 * lead-in, the star's 28 less its 8 px trail, the 20 px chips (zoom, translate, Reader View),
 * the 28 px icon buttons (blocked pop-ups, the shield, the autofill key, the in-use chip, each
 * blocked-permission icon) and what a count badge adds to one of them (the 4 px gap and a 20 px
 * two-digit pill).
 */
export const CHIP_WIDTH = {
  site: 20,
  star: 20,
  small: 20,
  iconButton: 28,
  badge: 28
} as const

export interface PillChipSpec {
  /** What the pill calls the chip (`star`, `zoom`, `translate`…). */
  id: string
  tier: ChipTier
  /** The chip's box, its own margins folded in, without the gap before it. */
  width: number
}

/**
 * The ids of the chips that fit inside a pill whose content box is `innerWidth` wide (the pill's
 * width less `PILL_PADDING`). Unmeasured (0) shows everything: nothing hides before the pill has
 * a width. The never-hidden tiers are laid out first; the rest take their turn in priority
 * order, each let in only while the address would keep `MIN_ADDRESS_WIDTH`, and the first that
 * does not fit closes the door for those below it – a lower chip never shows over a hidden
 * higher one.
 */
export function fittingChips(
  innerWidth: number,
  chips: readonly PillChipSpec[]
): ReadonlySet<string> {
  const visible = new Set<string>()
  if (innerWidth <= 0) {
    for (const c of chips) visible.add(c.id)
    return visible
  }
  let used = 0
  for (const c of chips) {
    if (!NEVER_HIDDEN.has(c.tier)) continue
    visible.add(c.id)
    used += c.width + CHIP_GAP
  }
  const byPriority = CHIP_PRIORITY.filter((t) => !NEVER_HIDDEN.has(t))
  for (const tier of byPriority) {
    for (const c of chips) {
      if (c.tier !== tier) continue
      if (innerWidth - used - (c.width + CHIP_GAP) < MIN_ADDRESS_WIDTH) return visible
      visible.add(c.id)
      used += c.width + CHIP_GAP
    }
  }
  return visible
}

/** The address's width once the visible chips have taken theirs; what the text truncates into. */
export function addressWidth(
  innerWidth: number,
  chips: readonly PillChipSpec[],
  visible: ReadonlySet<string>
): number {
  let used = 0
  for (const c of chips) if (visible.has(c.id)) used += c.width + CHIP_GAP
  return Math.max(0, innerWidth - used)
}
