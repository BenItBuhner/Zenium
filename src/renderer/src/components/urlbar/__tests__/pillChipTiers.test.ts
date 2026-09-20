import { describe, expect, it } from 'vitest'
import {
  CHIP_GAP,
  CHIP_PRIORITY,
  CHIP_WIDTH,
  MIN_ADDRESS_WIDTH,
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
  it('orders the tiers: site, state, star, zoom, shield, informational (§9.29)', () => {
    expect(CHIP_PRIORITY).toEqual(['site', 'state', 'star', 'zoom', 'shield', 'info'])
  })

  it('hides nothing before the pill has been measured', () => {
    expect(ids(fittingChips(0, five))).toEqual(ids(new Set(five.map((c) => c.id))))
  })

  it('the 240 px sidebar with five chips: the state chips stay, star / zoom / translate hide, the address keeps its minimum', () => {
    // 240 − 16 padding − five 28 px buttons − six 2 px gaps − the pill's 4 px margins ≈ 96.
    const visible = fittingChips(inner(96), five)
    expect(ids(visible)).toEqual(['popups', 'site'])
    expect(addressWidth(inner(96), five, visible)).toBeGreaterThanOrEqual(0)
    // Nothing that stays runs past the pill: the two never-hidden chips take 52 of the 76.
    expect(addressWidth(inner(96), five, visible)).toBe(76 - 2 * CHIP_GAP - 20 - 28)
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
    // The default 240 px sidebar's single-row toolbar leaves the pill 100 px: the site icon and
    // the address only (the #226 pill held site, shield, pop-ups, translate, zoom and star).
    const everyday: PillChipSpec[] = [
      { id: 'site', tier: 'site', width: CHIP_WIDTH.site },
      { id: 'shield', tier: 'shield', width: CHIP_WIDTH.iconButton },
      { id: 'star', tier: 'star', width: CHIP_WIDTH.star }
    ]
    const at = (pill: number): string[] => ids(fittingChips(inner(pill), everyday))
    expect(at(100)).toEqual(['site'])
    // The star returns at 130 (§9.29), the shield once it fits beside the star: 26 + 26 + 34 + 56 = 142 → pill 162.
    expect(at(130)).toEqual(['site', 'star'])
    expect(at(161)).toEqual(['site', 'star'])
    expect(at(162)).toEqual(['shield', 'site', 'star'])
    // With a blocked pop-up the pill keeps that chip and the address takes what is left.
    const withPopup: PillChipSpec[] = [
      ...everyday,
      { id: 'popups', tier: 'state', width: CHIP_WIDTH.iconButton }
    ]
    const visible = fittingChips(inner(100), withPopup)
    expect(ids(visible)).toEqual(['popups', 'site'])
    expect(addressWidth(inner(100), withPopup, visible)).toBe(80 - 26 - 34)
  })

  it('collapses from the lowest priority up: translate first, then zoom, then the star', () => {
    const at = (pill: number): string[] => ids(fittingChips(inner(pill), five))
    // Wide enough for everything.
    expect(at(260)).toEqual(['popups', 'site', 'star', 'translate', 'zoom'])
    // site 26 + popups 34 + star 26 + zoom 26 + translate 26 = 138; + 56 = 194 → pill 214.
    expect(at(214)).toEqual(['popups', 'site', 'star', 'translate', 'zoom'])
    expect(at(213)).toEqual(['popups', 'site', 'star', 'zoom'])
    // Without translate: 112 + 56 = 168 → pill 188.
    expect(at(188)).toEqual(['popups', 'site', 'star', 'zoom'])
    expect(at(187)).toEqual(['popups', 'site', 'star'])
    // Without zoom: 86 + 56 = 142 → pill 162.
    expect(at(162)).toEqual(['popups', 'site', 'star'])
    expect(at(161)).toEqual(['popups', 'site'])
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

  it('§9.29: with the site icon alone beside it, the star returns at a 130 px pill', () => {
    const chips: PillChipSpec[] = [
      { id: 'site', tier: 'site', width: CHIP_WIDTH.site },
      { id: 'star', tier: 'star', width: CHIP_WIDTH.star }
    ]
    // inner 110 − 26 − 26 = 58 ≥ 56 for the address.
    expect(ids(fittingChips(inner(130), chips))).toEqual(['site', 'star'])
    expect(ids(fittingChips(inner(126), chips))).toEqual(['site'])
    expect(addressWidth(inner(130), chips, fittingChips(inner(130), chips))).toBeGreaterThanOrEqual(
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
