/**
 * Which of the address pill's chips fit, and which hide when the pill cannot hold them all
 * (design language v2 §9.29's tier; Chrome's LocationBarView lays its decorations out the same
 * way). The chips have a priority: the site icon always; then the chips that report a state the
 * user cannot otherwise see (blocked pop-ups, a save prompt's key) – never hidden; then the
 * star; then the zoom chip (a per-page deviation the user has to undo); then the blocking
 * shield (its count is not a state, §9.29: the site information the site icon opens carries
 * it, and it marks the same state on every page); the informational chips (translate, Reader
 * View) lowest of the resident chips; under them the hover-only utilities (Copy URL, Share,
 * Boost, the translate offer), which mount with the pointer over the pill into the room the
 * address has to spare and never take the address under its floor. Hiding order, first to
 * last: the hover-only utilities, translate and Reader View, the Install-app chip, shield,
 * zoom, star (design lead's ruling on #267, §9.29; the W8-6 lead's rule on #578's first line for
 * the utilities). The address truncates first – down to `MIN_ADDRESS_WIDTH` – and only then do
 * the chips hide, from the lowest priority up; once one does not fit, none below it shows. A
 * hidden chip's action stays reachable from the app menu and the tab's menu (Bookmark, Zoom,
 * Translate Page, Reader View, Copy URL, Share…) and from the site information (the blocking
 * state). The tiers fold ONE WAY as the pill narrows: nothing that hid comes back at a narrower
 * width – the utilities included, which are read against the resident chips at their labelled
 * widths (`fittingUtilities`), so the folds that free room (a word's) never let a utility back
 * in under a drag (the design lead's ruling on #589).
 *
 * The pill's two words – "Not secure" (or "Dangerous") before the address and the Install
 * chip's "Install" – are §4's 13 px, the floor of the scale, set once on `.zen-pill-label` in
 * the stylesheet for both; their nominal widths below (`CHIP_WIDTH.indicatorLabel`,
 * `CHIP_WIDTH.label`) follow that size. Both fold by one rule (`labelFits`): a word stands
 * while every resident chip fits beside it over the address's floor, and goes first – before
 * any chip hides, one way – when they would not; the stylesheet's label tier drops both under
 * `PILL_LABEL_TIER` whatever the room. Counted at its width while it stands, the indicator's
 * word is a state chip the tier never hides (the W8-6 round on #589: uncounted, the utilities
 * mounting into its room on an http page left the address 2 px).
 *
 * The other axis of §9.29 is the row's: a toolbar BUTTON the width tiers (the media hub's, Home
 * since #572, the Energy Saver leaf since #584) folds where the pill it would leave the row
 * drops under `PILL_TOOLS_TIER` – `lib/toolbarPins.ts`'s `foldingButtonFits`, the one helper for
 * every such button (the hub's `mediaHubButtonFits` and the leaf's `energySaverLeafFits` are
 * its names), which reads its floor from here (`PILL_PADDING + PILL_TOOLS_TIER`). Buttons fold
 * by that rule outside the pill; chips fold by this one inside it, and the two meet at the
 * tools tier: a row that keeps a button keeps the pill at least 110 wide inside, where this
 * rule still holds the site icon and the address's floor beside whatever chips fit.
 *
 * Pure, so the rule is unit-tested without a DOM; the pill measures itself and asks.
 */

export type ChipTier = 'site' | 'state' | 'star' | 'shield' | 'zoom' | 'install' | 'info' | 'extra'

/**
 * Highest priority first: what hides when the pill runs out of room hides from the end. The
 * Install-app chip (Chrome's `kActionInstallPwa`, W8-6) sits above the informational chips – an
 * offer the page cannot make any other way once the chip is gone but the app menu – and below
 * the shield: translate and Reader View hide first, then Install, then the shield. Under them
 * all the hover-only utilities (`extra`): they are let in last, into the room the resident
 * chips left the address over its floor, so a pointer over the pill mounts only what the floor
 * allows (at a 320 sidebar with an installable page: none of them, the address at its 56).
 */
export const CHIP_PRIORITY: readonly ChipTier[] = [
  'site',
  'state',
  'star',
  'zoom',
  'shield',
  'install',
  'info',
  'extra'
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
 * The content box under which the pill's text labels go before the address does (the
 * stylesheet's `@container (width < 220px)` on `.zen-pill` drops every `zen-pill-label`): the
 * "Not secure" word, and the Install-app chip's "Install" – Chrome's suggestion-chip text
 * (`IDS_OMNIBOX_PWA_INSTALL_ICON_LABEL`), which the pill shows while it has this room and folds
 * to the glyph alone below it. The chip's tier width follows (`CHIP_WIDTH.label`). Re-derived
 * for the labels at 13 px (the design lead's ruling on #589): the widest run an http page keeps
 * beside its word – the site icon 26, "Not secure" 69 + 6, the shield 34, the star 26 – and the
 * address's 56 come to 217 ≤ 220, and the labelled Install chip beside the site icon, the star
 * and the floor to 26 + 70 + 26 + 56 = 178; so at the tier either word still stands over a
 * 56 px address, and either word folds by the room (`labelFits`) before any chip hides – 220
 * holds. (The two words all but never share a pill: an Install offer needs a secure context,
 * `isInstallable`, and the loopback http that installs carries no indicator word; where they
 * would – a certificate error bypassed on a page with a manifest – the offer's word folds before
 * the state's.)
 */
export const PILL_LABEL_TIER = 220

/**
 * Nominal boxes, the chips' negative margins folded in (§9.3): the site icon's 24 less its 4 px
 * lead-in, the star's 28 less its 8 px trail, the 20 px chips (zoom, translate, Reader View,
 * the Install-app glyph), the 28 px icon buttons (blocked pop-ups, the shield, the autofill
 * key), what a count badge adds to one of them (the 4 px gap and a 20 px two-digit pill), and
 * the two text labels at §4's 13 px: what the Install chip's "Install" adds to its 20 while the
 * label tier shows it – the word at 13 px medium is 37.4 wide, its gap before it 4 and the chip's
 * padding 4 either side, a 63.4 px chip, so the tier reserves 64, 44 over the glyph's 20 – and
 * the indicator's word before the address, "Not secure" 68.4 at 13 px ("Dangerous" 68.0),
 * reserved at 69. The W8-6 probe read the words on the packaged build's font stack (system-ui);
 * the constants are their ceilings, so the address's floor holds to the pixel under them.
 */
export const CHIP_WIDTH = {
  site: 20,
  star: 20,
  small: 20,
  iconButton: 28,
  badge: 28,
  label: 44,
  indicatorLabel: 69
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

/**
 * Whether a word of the pill – the Install chip's "Install", the indicator's "Not secure" –
 * keeps its place: only while the pill's content box is at the label tier and every chip in
 * `chips` (the word listed at its labelled width) fits beside it with the address at its floor.
 * A word is the first thing the pill gives up – before any chip hides, as Chrome's location
 * label is its omnibox's one auto-collapsing decoration – and it goes one way: a chip that would
 * return only because the word left would take the word's room back, so the fold is read on the
 * labelled set alone. Unmeasured (0) keeps the word, like `fittingChips` keeps every chip.
 */
export function labelFits(innerWidth: number, chips: readonly PillChipSpec[]): boolean {
  if (innerWidth <= 0) return true
  if (innerWidth < PILL_LABEL_TIER) return false
  return fittingChips(innerWidth, chips).size === chips.length
}

/**
 * The ids of the hover-only utilities (`extra`) the pointer may mount beside the resident chips
 * `labelled` – every resident at its LABELLED width (the Install chip with its word), whatever
 * the word's state on screen. Read that way, the utilities' room only shrinks as the pill
 * narrows: the word's fold, which frees 44 where a chip's frees 26, never hands a utility room
 * back, so the mounted set is monotone under a drag – a chip re-appearing as the sidebar narrows
 * is jitter (§9.29's tiers fold one way; the design lead's ruling on #589). The price is
 * hover-only and small: on an installable page no utility mounts across the band where the
 * word has folded but would have fitted beside them.
 */
export function fittingUtilities(
  innerWidth: number,
  labelled: readonly PillChipSpec[],
  utilities: readonly PillChipSpec[]
): ReadonlySet<string> {
  const fits = fittingChips(innerWidth, [...labelled, ...utilities])
  return new Set(utilities.filter((u) => fits.has(u.id)).map((u) => u.id))
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
