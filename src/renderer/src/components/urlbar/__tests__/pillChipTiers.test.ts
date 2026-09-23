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
  it('orders the tiers: site, state, star, zoom, shield, informational, blocked permissions (§9.29, omnibox-38)', () => {
    expect(CHIP_PRIORITY).toEqual(['site', 'state', 'star', 'zoom', 'shield', 'info', 'blocked'])
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

  // omnibox-38: the pill's word on the page using the camera, the microphone or the screen is a
  // state chip – Chrome keeps its in-use icon in the narrowest omnibox – and the icons of the
  // permissions the user blocked on the site are the lowest tier, the first to go.
  describe('the in-use chip and the blocked-permission icons (omnibox-38)', () => {
    const inUse: PillChipSpec = { id: 'in-use', tier: 'state', width: CHIP_WIDTH.iconButton }
    const blockedCamera: PillChipSpec = {
      id: 'blocked-camera',
      tier: 'blocked',
      width: CHIP_WIDTH.iconButton
    }
    const blockedMic: PillChipSpec = {
      id: 'blocked-microphone',
      tier: 'blocked',
      width: CHIP_WIDTH.iconButton
    }
    const chips: PillChipSpec[] = [...five, inUse, blockedCamera, blockedMic]

    it('the in-use chip is never hidden, however narrow the pill', () => {
      // The 240 sidebar's 96 px pill: site, the blocked pop-ups chip and the in-use chip stay.
      expect(ids(fittingChips(inner(96), chips))).toEqual(['in-use', 'popups', 'site'])
      expect(ids(fittingChips(40, chips))).toEqual(['in-use', 'popups', 'site'])
    })

    it('the blocked-permission icons return last, after translate, and drop first', () => {
      const at = (pill: number): string[] => ids(fittingChips(inner(pill), chips))
      // Everything: site 26 + popups 34 + in-use 34 + star 26 + zoom 26 + translate 26 +
      // two blocked icons 68 = 240; + 56 = 296 → pill 312.
      expect(at(312)).toEqual([
        'blocked-camera',
        'blocked-microphone',
        'in-use',
        'popups',
        'site',
        'star',
        'translate',
        'zoom'
      ])
      // One pixel short: the last blocked icon is the first chip to go; the first stays.
      expect(at(311)).toEqual([
        'blocked-camera',
        'in-use',
        'popups',
        'site',
        'star',
        'translate',
        'zoom'
      ])
      // Without either blocked icon: 172 + 56 = 228 → pill 244; under it translate is next.
      expect(at(278)).toEqual([
        'blocked-camera',
        'in-use',
        'popups',
        'site',
        'star',
        'translate',
        'zoom'
      ])
      expect(at(277)).toEqual(['in-use', 'popups', 'site', 'star', 'translate', 'zoom'])
      expect(at(244)).toEqual(['in-use', 'popups', 'site', 'star', 'translate', 'zoom'])
      expect(at(243)).toEqual(['in-use', 'popups', 'site', 'star', 'zoom'])
    })

    it('a blocked icon never shows over a hidden informational chip', () => {
      // Room for a blocked icon's width but translate, above it, does not fit: the door is shut.
      const narrowTranslate: PillChipSpec[] = [
        { id: 'site', tier: 'site', width: CHIP_WIDTH.site },
        { id: 'translate', tier: 'info', width: 60 },
        { id: 'blocked-camera', tier: 'blocked', width: 8 }
      ]
      // 26 (site) + 66 (translate) + 56 = 148 for translate; give 140.
      expect(ids(fittingChips(140, narrowTranslate))).toEqual(['site'])
    })
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
