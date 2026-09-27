import { describe, expect, it } from 'vitest'
import {
  CHIP_GAP,
  CHIP_PRIORITY,
  CHIP_WIDTH,
  MIN_ADDRESS_WIDTH,
  PILL_BLEED,
  PILL_LABEL_TIER,
  PILL_PADDING,
  addressWidth,
  fittingChips,
  fittingUtilities,
  labelFits,
  type PillChipSpec
} from '../pillChipTiers'

/*
 * The pill chip overflow rule (design language v2 §9.29's tier; the #226 finding): in a 240 px
 * sidebar, five chips at once – site info, blocked pop-ups, translate, star, zoom – ran past the
 * pill and the zoom chip landed under the Menu button. Chips have a priority, the address
 * truncates first, the low-priority chips hide when the pill cannot hold them.
 */

const five: PillChipSpec[] = [
  { id: 'site', tier: 'site', width: CHIP_WIDTH.site },
  { id: 'popups', tier: 'state', width: CHIP_WIDTH.iconButton },
  { id: 'translate', tier: 'info', width: CHIP_WIDTH.small },
  { id: 'zoom', tier: 'zoom', width: CHIP_WIDTH.small },
  { id: 'star', tier: 'star', width: CHIP_WIDTH.star }
]
const inner = (pillWidth: number): number => pillWidth - PILL_PADDING
const ids = (s: ReadonlySet<string>): string[] => [...s].sort()

describe('the pill chip overflow rule (M8)', () => {
  it('orders the tiers: site, state, star, zoom, shield, the Install-app chip, informational, the hover-only utilities (§9.29; W8-6)', () => {
    expect(CHIP_PRIORITY).toEqual([
      'site',
      'state',
      'star',
      'zoom',
      'shield',
      'install',
      'info',
      'extra'
    ])
  })

  /*
   * W8-6: the Install-app chip (Chrome's `kActionInstallPwa`) folds after Translate and Reader
   * View and before the shield – an offer the pill cannot make any other way, but not a state –
   * and is measured with its "Install" label while the pill has the label tier's room
   * (`PILL_LABEL_TIER`, the "Not secure" rule), as the glyph alone below it.
   */
  it('folds the Install chip after the informational chips and before the shield, zoom and the star', () => {
    const chips: PillChipSpec[] = [
      { id: 'site', tier: 'site', width: CHIP_WIDTH.site },
      { id: 'shield', tier: 'shield', width: CHIP_WIDTH.iconButton },
      { id: 'translate', tier: 'info', width: CHIP_WIDTH.small },
      { id: 'install', tier: 'install', width: CHIP_WIDTH.small },
      { id: 'zoom', tier: 'zoom', width: CHIP_WIDTH.small },
      { id: 'star', tier: 'star', width: CHIP_WIDTH.star }
    ]
    const at = (pill: number): string[] => ids(fittingChips(inner(pill), chips))
    // site 26 + star 26 + zoom 26 + shield 34 + install 26 + translate 26 = 164; + 56 = 220 → pill 236.
    expect(at(236)).toEqual(['install', 'shield', 'site', 'star', 'translate', 'zoom'])
    // Translate goes first, at a 235 pill; the Install chip stays down to 138 + 56 = 194 → pill 210.
    expect(at(235)).toEqual(['install', 'shield', 'site', 'star', 'zoom'])
    expect(at(210)).toEqual(['install', 'shield', 'site', 'star', 'zoom'])
    // Then the Install chip: without it 112 + 56 = 168 → pill 184.
    expect(at(184)).toEqual(['shield', 'site', 'star', 'zoom'])
    expect(at(183)).toEqual(['site', 'star', 'zoom'])
  })

  it('measures the Install chip with its label while the pill has the label tier’s room', () => {
    expect(PILL_LABEL_TIER).toBe(220)
    // The label's width is what the chip adds to its 20 px glyph box, at §4's 13 px (the design
    // lead's ruling on #589): the word 37.4 at 13 px medium on the packaged build's font stack,
    // its gap 4, padding 4 + 4 – a 63.4 px chip, reserved at 64: 44 over the glyph.
    expect(CHIP_WIDTH.label).toBe(44)
    const labelled: PillChipSpec[] = [
      { id: 'site', tier: 'site', width: CHIP_WIDTH.site },
      { id: 'install', tier: 'install', width: CHIP_WIDTH.small + CHIP_WIDTH.label }
    ]
    // At the label tier's own content box the labelled chip fits beside the address floor:
    // 26 + (20 + 44 + 6) + 56 = 152 ≤ 220.
    expect(ids(fittingChips(PILL_LABEL_TIER, labelled))).toEqual(['install', 'site'])
    expect(addressWidth(PILL_LABEL_TIER, labelled, fittingChips(PILL_LABEL_TIER, labelled))).toBe(
      PILL_LABEL_TIER - 26 - (CHIP_WIDTH.small + CHIP_WIDTH.label + CHIP_GAP)
    )
  })

  /*
   * The pill's other word, "Not secure" (or "Dangerous") before an http page's address, is a
   * state chip of the tier since the W8-6 round on #589: at 13 px the build draws it 66.1 wide
   * ("Dangerous" 67.4), reserved at the wider word's next integer, 68, so the chips – the
   * utilities first – fold before the word takes the address under its floor. Both words read
   * their 13 px from one stylesheet line.
   */
  it('counts the "Not secure" word as a never-hidden state chip at its 13 px width', () => {
    expect(CHIP_WIDTH.indicatorLabel).toBe(68)
    const http: PillChipSpec[] = [
      { id: 'site', tier: 'site', width: CHIP_WIDTH.site },
      { id: 'indicator', tier: 'state', width: CHIP_WIDTH.indicatorLabel },
      { id: 'shield', tier: 'shield', width: CHIP_WIDTH.iconButton },
      { id: 'star', tier: 'star', width: CHIP_WIDTH.star },
      { id: 'copy', tier: 'extra', width: CHIP_WIDTH.small },
      { id: 'share', tier: 'extra', width: CHIP_WIDTH.small },
      { id: 'boost', tier: 'extra', width: CHIP_WIDTH.small }
    ]
    const at = (innerWidth: number): string[] => ids(fittingChips(innerWidth, http))
    // Uncounted, the 240 inner of a 396 sidebar read 154 free over the residents and let three
    // utilities in – the address at 2 px. Counted: site 26 + word 74 + shield 34 + star 26 = 160;
    // 240 − 160 = 80 over the floor's 56 – room for none of the 26 px utilities.
    expect(at(240)).toEqual(['indicator', 'shield', 'site', 'star'])
    expect(addressWidth(240, http, fittingChips(240, http))).toBe(80)
    // Copy URL at 160 + 26 + 56 = 242, Share at 268, Boost at 294.
    expect(at(241)).toEqual(['indicator', 'shield', 'site', 'star'])
    expect(at(242)).toEqual(['copy', 'indicator', 'shield', 'site', 'star'])
    expect(at(268)).toEqual(['copy', 'indicator', 'share', 'shield', 'site', 'star'])
    expect(at(294)).toEqual(['boost', 'copy', 'indicator', 'share', 'shield', 'site', 'star'])
    // Never hidden by the tier while it stands: it is the page's state. The pill lists it only
    // while it stands (`labelFits`, below), and the stylesheet drops it under the label tier.
    expect(ids(fittingChips(PILL_LABEL_TIER, http))).toEqual([
      'indicator',
      'shield',
      'site',
      'star'
    ])
    expect(ids(fittingChips(120, http))).toEqual(['indicator', 'site'])
    // The word folds as the Install word does – first, by the room, before any chip hides, one
    // way: a zoomed http page with a translate chip keeps every chip beside the word down to
    // 26 + 74 + 34 + 26 + 26 + 26 = 212, + 56 = 268; one pixel under, the word goes and the six
    // chips stand over the room it left (138 + 56 = 194), where hiding zoom and translate at
    // 220–267 to return them at 219 would have been the jitter §9.29's one-way tiers rule out.
    const crowded: PillChipSpec[] = [
      ...http.slice(0, 4),
      { id: 'zoom', tier: 'zoom', width: CHIP_WIDTH.small },
      { id: 'translate', tier: 'info', width: CHIP_WIDTH.small }
    ]
    expect(labelFits(268, crowded)).toBe(true)
    expect(labelFits(267, crowded)).toBe(false)
    const bare = crowded.filter((c) => c.id !== 'indicator')
    expect(fittingChips(267, bare).size).toBe(bare.length)
    expect(fittingChips(194, bare).size).toBe(bare.length)
    // The utilities keep reading the word's room as spent: none until 212 + 26 + 56 = 294.
    const utilities = http.slice(4)
    expect(ids(fittingUtilities(293, crowded, utilities))).toEqual([])
    expect(ids(fittingUtilities(294, crowded, utilities))).toEqual(['copy'])
  })

  it('220 holds as the label tier for both words at 13 px', () => {
    // The widest run an http page keeps beside its word – the site icon, "Not secure", the
    // shield, the star – stands over a 56 px address at the tier: 26 + 74 + 34 + 26 + 56 = 216.
    const http: PillChipSpec[] = [
      { id: 'site', tier: 'site', width: CHIP_WIDTH.site },
      { id: 'indicator', tier: 'state', width: CHIP_WIDTH.indicatorLabel },
      { id: 'shield', tier: 'shield', width: CHIP_WIDTH.iconButton },
      { id: 'star', tier: 'star', width: CHIP_WIDTH.star }
    ]
    expect(26 + (CHIP_WIDTH.indicatorLabel + CHIP_GAP) + 34 + 26 + MIN_ADDRESS_WIDTH).toBe(216)
    expect(fittingChips(PILL_LABEL_TIER, http).size).toBe(http.length)
    expect(addressWidth(PILL_LABEL_TIER, http, fittingChips(PILL_LABEL_TIER, http))).toBe(60)
    // The labelled Install chip beside the site icon and the star: 26 + 70 + 26 + 56 = 178. (The
    // two words all but never share a pill – an Install offer needs a secure context, and the
    // loopback http that installs carries no indicator word.)
    const installable: PillChipSpec[] = [
      { id: 'site', tier: 'site', width: CHIP_WIDTH.site },
      { id: 'install', tier: 'install', width: CHIP_WIDTH.small + CHIP_WIDTH.label },
      { id: 'star', tier: 'star', width: CHIP_WIDTH.star }
    ]
    expect(26 + (CHIP_WIDTH.small + CHIP_WIDTH.label + CHIP_GAP) + 26 + MIN_ADDRESS_WIDTH).toBe(178)
    expect(labelFits(PILL_LABEL_TIER, installable)).toBe(true)
    expect(labelFits(PILL_LABEL_TIER - 1, installable)).toBe(false)
    // Where they would share one (a certificate error bypassed on a page with a manifest), the
    // Install word folds first, by the room: 26 + 74 + 70 + 26 + 56 = 252 > 220, and the glyph
    // alone stands with the rest at 26 + 74 + 26 + 26 + 56 = 208.
    const both: PillChipSpec[] = [installable[0]!, http[1]!, installable[1]!, installable[2]!]
    expect(labelFits(PILL_LABEL_TIER, both)).toBe(false)
    const bare = both.map((c) => (c.id === 'install' ? { ...c, width: CHIP_WIDTH.small } : c))
    expect(fittingChips(PILL_LABEL_TIER, bare).size).toBe(bare.length)
  })

  it('keeps the "Install" label only while every chip fits beside it, and never under the label tier', () => {
    const chips: PillChipSpec[] = [
      { id: 'site', tier: 'site', width: CHIP_WIDTH.site },
      { id: 'shield', tier: 'shield', width: CHIP_WIDTH.iconButton },
      { id: 'install', tier: 'install', width: CHIP_WIDTH.small + CHIP_WIDTH.label },
      { id: 'translate', tier: 'info', width: CHIP_WIDTH.small },
      { id: 'star', tier: 'star', width: CHIP_WIDTH.star }
    ]
    // Unmeasured keeps the word, as the tier keeps every chip.
    expect(labelFits(0, chips)).toBe(true)
    // site 26 + star 26 + shield 34 + install 70 + translate 26 = 182; + 56 = 238.
    expect(labelFits(238, chips)).toBe(true)
    // One pixel under, translate would hide: the word goes first instead.
    expect(labelFits(237, chips)).toBe(false)
    // Never under the label tier, however few the chips: 26 + 70 + 56 = 152 would fit at 219.
    const two: PillChipSpec[] = [
      { id: 'site', tier: 'site', width: CHIP_WIDTH.site },
      { id: 'install', tier: 'install', width: CHIP_WIDTH.small + CHIP_WIDTH.label }
    ]
    expect(labelFits(PILL_LABEL_TIER, two)).toBe(true)
    expect(labelFits(PILL_LABEL_TIER - 1, two)).toBe(false)
    // The word folded, the chip is its glyph: the freed room keeps translate for a while.
    const bare = chips.map((c) => (c.id === 'install' ? { ...c, width: CHIP_WIDTH.small } : c))
    expect(ids(fittingChips(237, bare))).toEqual(['install', 'shield', 'site', 'star', 'translate'])
    // 26 + 26 + 34 + 26 + 26 = 138; + 56 = 194: at 193 translate goes, the glyph stays.
    expect(ids(fittingChips(193, bare))).toEqual(['install', 'shield', 'site', 'star'])
  })

  /*
   * The design lead's ruling on #589 (3b): the tiers fold ONE WAY. As the sidebar narrows, a
   * utility that hid must not come back – not even for the step or two where the Install word's
   * fold (44) frees more than the chip (26) that would take the room. The utilities are read
   * against the residents at their labelled widths (`fittingUtilities`), whatever the word does.
   */
  it('reads the hover-only utilities against the labelled residents, so the word’s fold never lets one back in', () => {
    const labelled: PillChipSpec[] = [
      { id: 'site', tier: 'site', width: CHIP_WIDTH.site },
      { id: 'shield', tier: 'shield', width: CHIP_WIDTH.iconButton },
      { id: 'translate', tier: 'info', width: CHIP_WIDTH.small },
      { id: 'install', tier: 'install', width: CHIP_WIDTH.small + CHIP_WIDTH.label },
      { id: 'star', tier: 'star', width: CHIP_WIDTH.star }
    ]
    const utilities: PillChipSpec[] = [
      { id: 'copy', tier: 'extra', width: CHIP_WIDTH.small },
      { id: 'share', tier: 'extra', width: CHIP_WIDTH.small },
      { id: 'boost', tier: 'extra', width: CHIP_WIDTH.small }
    ]
    const at = (innerWidth: number): string[] =>
      ids(fittingUtilities(innerWidth, labelled, utilities))
    // The labelled residents take 182; Copy URL needs 182 + 26 + 56 = 264 of inner width (the
    // 424 sidebar), Share 290 (456 at the drive's 8 px steps), Boost 316 (480).
    expect(at(316)).toEqual(['boost', 'copy', 'share'])
    expect(at(315)).toEqual(['copy', 'share'])
    expect(at(290)).toEqual(['copy', 'share'])
    expect(at(289)).toEqual(['copy'])
    expect(at(264)).toEqual(['copy'])
    expect(at(263)).toEqual([])
    // At the word's fold (238 → 237) the bare residents take 138 and Copy URL would fit the
    // pill's real room down to 138 + 26 + 56 = 220 – re-entering for the drag from 237 to 220.
    // Read against the labelled set it stays out: the word's room is spent.
    expect(labelFits(238, labelled)).toBe(true)
    expect(labelFits(237, labelled)).toBe(false)
    const bare = labelled.map((c) => (c.id === 'install' ? { ...c, width: CHIP_WIDTH.small } : c))
    expect(ids(fittingChips(237, [...bare, ...utilities]))).toContain('copy')
    expect(at(237)).toEqual([])
    expect(at(220)).toEqual([])
    // Unmeasured, every utility – as the tier keeps every chip before the pill has a width.
    expect(at(0)).toEqual(['boost', 'copy', 'share'])
    // The sweep the drive runs, 520 → 240 hovered, one pixel at a time: the mounted set is
    // monotone non-increasing, and no utility re-enters below the width it last showed at.
    let previous = new Set(at(inner(520 - 144)))
    const lastSeen = new Map<string, number>()
    for (let sidebar = 520; sidebar >= 240; sidebar -= 1) {
      const now = new Set(at(inner(sidebar - 144)))
      for (const id of now) {
        expect(previous.has(id)).toBe(true)
        lastSeen.set(id, sidebar)
      }
      previous = now
    }
    expect(lastSeen.get('boost')).toBe(316 + 16 + 144)
    expect(lastSeen.get('share')).toBe(290 + 16 + 144)
    expect(lastSeen.get('copy')).toBe(264 + 16 + 144)
    for (const [id, sidebar] of lastSeen) {
      for (let below = sidebar - 1; below >= 240; below -= 1) {
        expect(at(inner(below - 144))).not.toContain(id)
      }
    }
    // A resident that does not fit closes the door on every utility, as before.
    const heavy: PillChipSpec[] = [...labelled, { id: 'zoom', tier: 'zoom', width: 200 }]
    expect(ids(fittingUtilities(400, heavy, utilities))).toEqual([])
  })

  /*
   * The W8-6 lead's rule (#578's first line): the hover-only utilities – Copy URL, Share, Boost,
   * the translate offer – mount into the room the resident chips left the address over its
   * floor, and never under it. They are the tier's lowest rank, let in last and hidden first.
   */
  it('lets the hover-only utilities in last, into the room over the address floor, and hides them first', () => {
    const chips: PillChipSpec[] = [
      { id: 'site', tier: 'site', width: CHIP_WIDTH.site },
      { id: 'shield', tier: 'shield', width: CHIP_WIDTH.iconButton },
      { id: 'star', tier: 'star', width: CHIP_WIDTH.star },
      { id: 'copy', tier: 'extra', width: CHIP_WIDTH.small },
      { id: 'share', tier: 'extra', width: CHIP_WIDTH.small },
      { id: 'boost', tier: 'extra', width: CHIP_WIDTH.small }
    ]
    const at = (innerWidth: number): string[] => ids(fittingChips(innerWidth, chips))
    // site 26 + star 26 + shield 34 = 86; + 56 = 142 for the residents; each utility 26 more.
    expect(at(220)).toEqual(['boost', 'copy', 'share', 'shield', 'site', 'star'])
    expect(at(219)).toEqual(['copy', 'share', 'shield', 'site', 'star'])
    expect(at(194)).toEqual(['copy', 'share', 'shield', 'site', 'star'])
    expect(at(193)).toEqual(['copy', 'shield', 'site', 'star'])
    expect(at(168)).toEqual(['copy', 'shield', 'site', 'star'])
    // The 320 sidebar's 160: the residents alone, the address at 74 – no utility takes it under 56.
    expect(at(167)).toEqual(['shield', 'site', 'star'])
    expect(at(160)).toEqual(['shield', 'site', 'star'])
    expect(addressWidth(160, chips, fittingChips(160, chips))).toBe(74)
    // Whatever is let in, the address keeps its floor.
    for (let innerWidth = 60; innerWidth <= 320; innerWidth += 1) {
      const visible = fittingChips(innerWidth, chips)
      const extraShown = [...visible].some(
        (id) => id === 'copy' || id === 'share' || id === 'boost'
      )
      if (extraShown) {
        expect(addressWidth(innerWidth, chips, visible)).toBeGreaterThanOrEqual(MIN_ADDRESS_WIDTH)
      }
    }
    // A resident chip that does not fit closes the door on every utility.
    const starless = chips.filter((c) => c.id !== 'star')
    expect(ids(fittingChips(141, starless))).toEqual(['shield', 'site'])
    expect(ids(fittingChips(115, starless))).toEqual(['site'])
  })

  it('hides nothing before the pill has been measured', () => {
    expect(ids(fittingChips(0, five))).toEqual(ids(new Set(five.map((c) => c.id))))
  })

  it('the 240 px sidebar with five chips: the state chips stay, star / zoom / translate hide, the address keeps its minimum', () => {
    // 240 − 16 gutters − four 28 px buttons − four 4 px gaps (§5) = 96, plus the 4 the pill takes
    // of its neighbours' slots (`PILL_BLEED`, W8-F7) = §9.29's 100; its content box is 84.
    expect(PILL_BLEED).toBe(4)
    const visible = fittingChips(inner(100), five)
    expect(inner(100)).toBe(84)
    expect(ids(visible)).toEqual(['popups', 'site'])
    expect(addressWidth(inner(100), five, visible)).toBeGreaterThanOrEqual(0)
    // Nothing that stays runs past the pill: the two never-hidden chips take 60 of the 84.
    expect(addressWidth(inner(100), five, visible)).toBe(84 - 2 * CHIP_GAP - 20 - 28)
    // With the site icon alone the address at 240 is 58, over its floor (the lead's 54 → 58).
    const bare: PillChipSpec[] = [{ id: 'site', tier: 'site', width: CHIP_WIDTH.site }]
    expect(addressWidth(inner(100), bare, fittingChips(inner(100), bare))).toBe(58)
    expect(58).toBeGreaterThanOrEqual(MIN_ADDRESS_WIDTH)
  })

  it('the site icon and the state chips are never hidden, however narrow the pill', () => {
    const chips: PillChipSpec[] = [
      { id: 'site', tier: 'site', width: CHIP_WIDTH.site },
      { id: 'shield', tier: 'shield', width: CHIP_WIDTH.iconButton + CHIP_WIDTH.badge },
      { id: 'popups', tier: 'state', width: CHIP_WIDTH.iconButton },
      { id: 'key', tier: 'state', width: CHIP_WIDTH.iconButton },
      { id: 'star', tier: 'star', width: CHIP_WIDTH.star }
    ]
    expect(ids(fittingChips(40, chips))).toEqual(['key', 'popups', 'site'])
  })

  it('§9.29: the shield is not a state chip – its count lives in the site information – so it hides after the star', () => {
    // The default 240 px sidebar's single-row toolbar leaves the pill 100 px (content box 84):
    // the site icon and the address only (the #226 pill held site, shield, pop-ups, translate,
    // zoom and star).
    const everyday: PillChipSpec[] = [
      { id: 'site', tier: 'site', width: CHIP_WIDTH.site },
      { id: 'shield', tier: 'shield', width: CHIP_WIDTH.iconButton },
      { id: 'star', tier: 'star', width: CHIP_WIDTH.star }
    ]
    const at = (pill: number): string[] => ids(fittingChips(inner(pill), everyday))
    expect(at(100)).toEqual(['site'])
    // The star returns at the 266 sidebar's 126 px pill (§9.29's "130": content box 110), the
    // shield once it fits beside the star: 26 + 26 + 34 + 56 = 142 → pill 158.
    expect(at(126)).toEqual(['site', 'star'])
    expect(at(157)).toEqual(['site', 'star'])
    expect(at(158)).toEqual(['shield', 'site', 'star'])
    // With a blocked pop-up the pill keeps that chip and the address takes what is left.
    const withPopup: PillChipSpec[] = [
      ...everyday,
      { id: 'popups', tier: 'state', width: CHIP_WIDTH.iconButton }
    ]
    const visible = fittingChips(inner(100), withPopup)
    expect(ids(visible)).toEqual(['popups', 'site'])
    expect(addressWidth(inner(100), withPopup, visible)).toBe(84 - 26 - 34)
  })

  it('collapses from the lowest priority up: translate first, then zoom, then the star', () => {
    const at = (pill: number): string[] => ids(fittingChips(inner(pill), five))
    // Wide enough for everything.
    expect(at(260)).toEqual(['popups', 'site', 'star', 'translate', 'zoom'])
    // site 26 + popups 34 + star 26 + zoom 26 + translate 26 = 138; + 56 = 194 → pill 210.
    expect(at(210)).toEqual(['popups', 'site', 'star', 'translate', 'zoom'])
    expect(at(209)).toEqual(['popups', 'site', 'star', 'zoom'])
    // Without translate: 112 + 56 = 168 → pill 184.
    expect(at(184)).toEqual(['popups', 'site', 'star', 'zoom'])
    expect(at(183)).toEqual(['popups', 'site', 'star'])
    // Without zoom: 86 + 56 = 142 → pill 158.
    expect(at(158)).toEqual(['popups', 'site', 'star'])
    expect(at(157)).toEqual(['popups', 'site'])
  })

  it('a lower chip never shows over a hidden higher one', () => {
    // A wide star that does not fit closes the door for the narrower zoom chip too.
    const chips: PillChipSpec[] = [
      { id: 'site', tier: 'site', width: CHIP_WIDTH.site },
      { id: 'star', tier: 'star', width: 60 },
      { id: 'zoom', tier: 'zoom', width: 8 }
    ]
    // 26 (site) + 66 (star) + 56 = 148 of inner width for the star; give 140.
    expect(ids(fittingChips(140, chips))).toEqual(['site'])
  })

  it('§9.29: with the site icon alone beside it, the star returns at the 270 sidebar (a 126 px pill, content 110)', () => {
    const chips: PillChipSpec[] = [
      { id: 'site', tier: 'site', width: CHIP_WIDTH.site },
      { id: 'star', tier: 'star', width: CHIP_WIDTH.star }
    ]
    // inner 110 − 26 − 26 = 58 ≥ 56 for the address.
    expect(inner(126)).toBe(110)
    expect(ids(fittingChips(inner(126), chips))).toEqual(['site', 'star'])
    expect(ids(fittingChips(inner(122), chips))).toEqual(['site'])
    expect(addressWidth(inner(126), chips, fittingChips(inner(126), chips))).toBeGreaterThanOrEqual(
      MIN_ADDRESS_WIDTH
    )
  })

  it('the address keeps its minimum whenever an optional chip is shown', () => {
    for (let pill = 60; pill <= 320; pill += 1) {
      const visible = fittingChips(inner(pill), five)
      const optionalShown = [...visible].some((id) => id !== 'site' && id !== 'popups')
      if (optionalShown) {
        expect(addressWidth(inner(pill), five, visible)).toBeGreaterThanOrEqual(MIN_ADDRESS_WIDTH)
      }
    }
  })
})
