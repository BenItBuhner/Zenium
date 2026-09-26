import type { LucideIcon } from 'lucide-react'
import { Cookie, ShieldCheck, ShieldHalf, SlidersHorizontal, Trash2 } from 'lucide-react'
import type { SiteDataDefault } from '@shared/siteData'
import type { ThirdPartyCookieMode } from '@shared/privacy'

/**
 * The Privacy and security hub (settings-12; the card list at the top of Chrome's Privacy and
 * security page): one card per program of the section, in Chrome's order, each a §10.4 action
 * row – the leading glyph, the title, one line under it, the trailing chevron – that brings the
 * program's first group on screen (`SectionContext.reveal`, the section's `?group=` landing) or
 * opens its dialog. The groups themselves stay where they are under the cards, so the section
 * still reads whole and the search still finds every row; the cards are the desktop and tablet
 * shells' (the phone's Privacy page keeps its plain list, W7-6).
 *
 * Chrome's list is Delete browsing data, Privacy Guide, Third-party cookies, Ad privacy,
 * Security, Site settings, Safety check. Privacy Guide (PS-40) has no page here yet and Ad
 * privacy no engine (no ad topics, no Privacy Sandbox), so neither has a card – an absent
 * feature is not a disabled card.
 */
export interface PrivacyHubCard {
  /** The row id, `hub-` prefixed so it stays unique beside the section's other programs. */
  id: string
  label: string
  glyph: LucideIcon
  /**
   * The group of the section the card lands on (`RowGroup.id`); null for the card whose press
   * opens a dialog instead (Delete browsing data, the PS-13 sheet).
   */
  group: string | null
}

export const PRIVACY_HUB_CARDS: readonly PrivacyHubCard[] = [
  { id: 'hub-clear-data', label: 'Delete browsing data', glyph: Trash2, group: null },
  { id: 'hub-cookies', label: 'Third-party cookies', glyph: Cookie, group: 'site-data' },
  { id: 'hub-security', label: 'Security', glyph: ShieldHalf, group: 'safe-browsing' },
  {
    id: 'hub-site-settings',
    label: 'Site settings',
    glyph: SlidersHorizontal,
    group: 'sites-permissions'
  },
  { id: 'hub-safety-check', label: 'Safety check', glyph: ShieldCheck, group: 'safety-check' }
]

/** The one line under each card's title: Chrome's, in the house's words. */
export const PRIVACY_HUB_LINES = {
  clearData: 'Delete history, cookies, cache and more',
  security: 'Safe Browsing (protection from dangerous sites) and other security settings',
  siteSettings: 'What sites may use and show (location, camera, pop-ups and more)',
  safetyCheck: 'Zenium can help keep you safe from data breaches, bad extensions and more'
} as const

/**
 * The Third-party cookies card's line states the setting, as Chrome's does ("Third-party
 * cookies are blocked in Incognito mode"): the site-data default, and – under the middle
 * choice – where the block applies, the private contexts alone or everywhere. The words follow
 * the host's private windows or private tabs.
 */
export function thirdPartyCookiesLine(
  siteDataDefault: SiteDataDefault,
  mode: ThirdPartyCookieMode,
  windows: boolean
): string {
  switch (siteDataDefault) {
    case 'allow':
      return 'Third-party cookies are allowed'
    case 'block-all':
      return 'All cookies are blocked'
    case 'block-third-party':
      return mode === 'block-private'
        ? `Third-party cookies are blocked in private ${windows ? 'windows' : 'tabs'}`
        : 'Third-party cookies are blocked'
  }
}
