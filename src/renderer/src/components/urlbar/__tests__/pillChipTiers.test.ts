import { describe, expect, it } from 'vitest'
import {
  CHIP_GAP,
  CHIP_PRIORITY,
  CHIP_WIDTH,
  MIN_ADDRESS_WIDTH,
  PILL_LABEL_TIER,
  PILL_PADDING,
  addressWidth,
  fittingChips,
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
  it('orders the tiers: site, state, star, zoom, shield, the Install-app chip, informational (§9.29; W8-6)', () => {
    expect(CHIP_PRIORITY).toEqual(['site', 'state', 'star', 'zoom', 'shield', 'install', 'info'])
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
    // The label's width is what the chip adds to its 20 px glyph box.
    expect(CHIP_WIDTH.label).toBeGreaterThan(0)
    const labelled: PillChipSpec[] = [
      { id: 'site', tier: 'site', width: CHIP_WIDTH.site },
      { id: 'install', tier: 'install', width: CHIP_WIDTH.small + CHIP_WIDTH.label }
    ]
    // At the label tier's own content box the labelled chip fits beside the address floor:
    // 26 + (20 + 48 + 6) + 56 = 156 ≤ 220.
    expect(ids(fittingChips(PILL_LABEL_TIER, labelled))).toEqual(['install', 'site'])
    expect(addressWidth(PILL_LABEL_TIER, labelled, fittingChips(PILL_LABEL_TIER, labelled))).toBe(
      PILL_LABEL_TIER - 26 - (CHIP_WIDTH.small + CHIP_WIDTH.label + CHIP_GAP)
    )
  })

  it('hides nothing before the pill has been measured', () => {
    expect(ids(fittingChips(0, five))).toEqual(ids(new Set(five.map((c) => c.id))))
  })

  it('the 240 px sidebar with five chips: the state chips stay, star / zoom / translate hide, the address keeps its minimum', () => {
    // 240 − 16 gutters − four 28 px buttons − four 4 px gaps (§5) = 96; its content box is 80.
    const visible = fittingChips(inner(96), five)
    expect(inner(96)).toBe(80)
    expect(ids(visible)).toEqual(['popups', 'site'])
    expect(addressWidth(inner(96), five, visible)).toBeGreaterThanOrEqual(0)
    // Nothing that stays runs past the pill: the two never-hidden chips take 60 of the 80.
    expect(addressWidth(inner(96), five, visible)).toBe(80 - 2 * CHIP_GAP - 20 - 28)
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
    // The default 240 px sidebar's single-row toolbar leaves the pill 96 px (content box 80): the
    // site icon and the address only (the #226 pill held site, shield, pop-ups, translate, zoom
    // and star).
    const everyday: PillChipSpec[] = [
      { id: 'site', tier: 'site', width: CHIP_WIDTH.site },
      { id: 'shield', tier: 'shield', width: CHIP_WIDTH.iconButton },
      { id: 'star', tier: 'star', width: CHIP_WIDTH.star }
    ]
    const at = (pill: number): string[] => ids(fittingChips(inner(pill), everyday))
    expect(at(96)).toEqual(['site'])
    // The star returns at the 270 sidebar's 126 px pill (§9.29's "130": content box 110), the
    // shield once it fits beside the star: 26 + 26 + 34 + 56 = 142 → pill 158.
    expect(at(126)).toEqual(['site', 'star'])
    expect(at(157)).toEqual(['site', 'star'])
    expect(at(158)).toEqual(['shield', 'site', 'star'])
    // With a blocked pop-up the pill keeps that chip and the address takes what is left.
    const withPopup: PillChipSpec[] = [
      ...everyday,
      { id: 'popups', tier: 'state', width: CHIP_WIDTH.iconButton }
    ]
    const visible = fittingChips(inner(96), withPopup)
    expect(ids(visible)).toEqual(['popups', 'site'])
    expect(addressWidth(inner(96), withPopup, visible)).toBe(80 - 26 - 34)
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
